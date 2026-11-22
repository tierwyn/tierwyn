import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  source: string;
}

interface RenderState {
  svg: string | null;
  error: string | null;
}

/**
 * Read a custom property from <html> as it resolves right now (after
 * data-theme / data-theme-color cascade). Returns "" if unset.
 */
function cssVar(name: string): string {
  if (typeof window === 'undefined') return '';
  if (!getComputedStyle(document.documentElement).getPropertyValue(name).trim()) return '';
  // Custom properties come back unresolved (`color-mix(…, var(--x) …)`), which
  // mermaid's colour parser throws on. Let the browser resolve the colour, then
  // flatten it through a 1px canvas to plain rgba() mermaid understands.
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a! / 255) * 1000) / 1000})`;
}

/**
 * Build a mermaid config whose palette mirrors the active Tierwyn theme.
 * Drives `theme` (dark/default) from data-theme, and overrides
 * themeVariables with the live CSS accent + surface tokens so diagrams
 * recolor when the user switches light/dark or picks a different accent
 * (cyan / purple / green / ...) in the appearance dropdown.
 */
function buildMermaidConfig() {
  const isLight = document.documentElement.dataset['theme'] === 'light';

  // Resolve with fallbacks so mermaid never receives an empty string
  // (which can throw inside its theme computation).
  const accent = cssVar('--accent') || (isLight ? '#0f766e' : '#22d3ee');
  const accentDim = cssVar('--accent-dim') || accent;
  const accentBg = cssVar('--accent-bg') || 'rgba(6,182,212,0.06)';
  const text1 = cssVar('--text-1') || (isLight ? '#0f172a' : '#e0f7fa');
  const text2 = cssVar('--text-2') || (isLight ? '#334155' : '#8ab4f8');
  const surface2 = cssVar('--surface-2') || (isLight ? '#f8fafc' : '#0d1115');
  const surface3 = cssVar('--surface-3') || (isLight ? '#f1f5f9' : '#11161b');
  const borderHi = cssVar('--border-hi') || accentBg;

  return {
    startOnLoad: false,
    theme: isLight ? 'default' : 'dark',
    securityLevel: 'strict',
    // Make mermaid remove its own temp <div id="d${id}"> from
    // document.body when parsing/drawing fails. Without this, the
    // error SVG leaks to the viewport floor ("syntax error under
    // the input prompt").
    suppressErrorRendering: true,
    fontFamily: 'inherit',
    themeVariables: {
      background: 'transparent',
      // Primary nodes: subtle accent tint fill, solid accent border.
      primaryColor: accentBg,
      primaryBorderColor: accent,
      primaryTextColor: text1,
      // Secondary/tertiary: opaque surface tints so alternating rows
      // (gantt sections, pie slices, state regions) stay visible —
      // mermaid's darken/lighten on a near-transparent rgba can wash out.
      secondaryColor: surface2,
      secondaryBorderColor: borderHi,
      secondaryTextColor: text2,
      tertiaryColor: surface3,
      tertiaryBorderColor: borderHi,
      tertiaryTextColor: text2,
      // Arrows / edges pick up the accent.
      lineColor: accentDim,
      // Default label text.
      textColor: text2,
      fontSize: '14px',
      // Sequence diagrams have their own token set that does not inherit
      // primaryColor — mirror accent onto actors/notes/labels explicitly.
      actorBkg: accentBg,
      actorBorder: accent,
      actorTextColor: text1,
      actorLineColor: accentDim,
      signalColor: text2,
      signalTextColor: text1,
      labelBoxBkgColor: accentBg,
      labelBoxBorderColor: accent,
      labelTextColor: text1,
      noteBkgColor: accentBg,
      noteBorderColor: accent,
      noteTextColor: text1,
    },
  } as const;
}

/**
 * Renders a ```mermaid fenced code block as SVG via dynamic import.
 * Mermaid is ~500KB minified, so we keep it out of the initial bundle.
 *
 * One instance per block. Errors fall back to rendering the source verbatim
 * inside a styled <pre> so the user can see what went wrong.
 *
 * Theming: the palette is rebuilt whenever the active theme changes. We
 * detect changes by observing data-theme (mode + OS prefers-color-scheme
 * flips — App updates this attribute in every case) and data-theme-color
 * (accent) on <html>. The tierwyn-theme-change event is also hooked as a
 * belt-and-suspenders trigger.
 */
export function MermaidBlock({ source }: Props): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ svg: null, error: null });
  // Bumped whenever the active theme/accent changes so the render effect
  // re-runs and re-paints with the new palette.
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const bump = () => setThemeTick((n) => n + 1);
    // Observer catches: explicit mode toggle (data-theme), OS scheme flip
    // in auto mode (App writes data-theme), and accent changes
    // (data-theme-color). One observer, all three sources.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'data-theme' || m.attributeName === 'data-theme-color') {
          bump();
          break;
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-color'] });
    window.addEventListener('tierwyn-theme-change', bump);
    return () => {
      observer.disconnect();
      window.removeEventListener('tierwyn-theme-change', bump);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Generated before the try so the catch can clean up the temp node
    // mermaid leaks into document.body on render failure.
    const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;

    (async () => {
      try {
        const mod = await import('mermaid');
        const mermaid = mod.default;
        mermaid.initialize(buildMermaidConfig());
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) setState({ svg, error: null });
      } catch (err) {
        if (!cancelled) {
          // Defense-in-depth: clear any residual temp node mermaid left
          // in document.body (id prefix "d" + our render id).
          document.getElementById(`d${id}`)?.remove();
          setState({
            svg: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      // Also sweep on unmount/source-change: an in-flight render may
      // have populated the temp node before the effect was cancelled.
      document.getElementById(`d${id}`)?.remove();
    };
  }, [source, themeTick]);

  if (state.error) {
    return (
      <pre className="mermaid-error">
        <code>{source}</code>
      </pre>
    );
  }

  if (!state.svg) {
    return <div className="mermaid-loading" ref={containerRef} aria-hidden />;
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-render"
      // svg comes from mermaid with securityLevel='strict' (no foreignObject,
      // no click handlers). Safe to inject.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
