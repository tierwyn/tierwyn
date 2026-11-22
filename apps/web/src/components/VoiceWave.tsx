import { useEffect, useRef } from 'react';
import type { WaveStyle } from '../voiceSettings.js';
import { VOICE_PALETTES, readAccent, isDarkTheme, rotatedPaletteColors } from '../voicePalettes.js';

/**
 * Silk-thread wave renderer. Five layered
 * sine waves with end-taper envelope, slow modulation drift, and a
 * fast-attack/slow-release amplitude envelope. Reacts to live mic level when
 * `getMicLevel` is supplied; otherwise runs a decorative synthetic shimmer.
 *
 * Stroke colour follows `waveStyle`:
 * - 'accent'    — solid `--accent` CSS variable (default, tracks theme colour)
 * - 'chromatic' — rotating rainbow gradient (blue/purple/pink/gold)
 * - 'silver'    — rotating metallic gradient
 *
 * @param getMicLevel  () => 0..1 mic amplitude, or null for synthetic mode.
 * @param waveStyle    Colour mode (default 'accent').
 * @param height       Canvas height in CSS pixels (default 32).
 */
export function VoiceWave({
  getMicLevel,
  waveStyle = 'accent',
  height = 32,
  ariaLabel,
}: {
  getMicLevel: (() => number) | null;
  waveStyle?: WaveStyle;
  height?: number;
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Latest values live in refs so the RAF loop reads fresh state without
  // re-subscribing on every render.
  const getterRef = useRef(getMicLevel);
  getterRef.current = getMicLevel;
  const styleRef = useRef(waveStyle);
  styleRef.current = waveStyle;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // --- Theme colour tracking ------------------------------------------------
    let accent = readAccent();
    let isDark = isDarkTheme();
    const themeObserver = new MutationObserver(() => {
      accent = readAccent();
      isDark = isDarkTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-color'],
    });

    // --- Sizing ---------------------------------------------------------------
    let W = 0;
    let H = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const parent = canvas.parentElement;
      const cssW = parent ? parent.clientWidth : canvas.clientWidth;
      const cssH = height;
      W = Math.max(1, Math.floor(cssW));
      H = Math.max(1, Math.floor(cssH));
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    // --- Wave parameters ----------------------------------------------------
    // f = spatial freq, s = signed time speed, p = phase, a = amp scale, o = opacity
    const layers = [
      { f: 1.4, s: 1.1, p: 0.0, a: 1.0, o: 0.90 },
      { f: 1.9, s: -0.8, p: 2.1, a: 0.8, o: 0.55 },
      { f: 2.6, s: 1.5, p: 4.2, a: 0.6, o: 0.35 },
      { f: 3.3, s: -1.9, p: 1.3, a: 0.45, o: 0.22 },
      { f: 1.1, s: 0.6, p: 5.0, a: 0.9, o: 0.45 },
    ];
    const PI = Math.PI;

    // Smoothed amplitude — fast attack, slow release (matches pill.html:111).
    let amp = 0;
    let rafId = 0;
    const start = performance.now();

    const draw = (now: number) => {
      // Clamp: the first RAF timestamp can precede `start` (frame began before
      // the effect ran). Negative t made `Math.floor(t*0.5) % pal.length`
      // negative → pal[-1] undefined → addColorStop threw → RAF loop died on
      // frame 1 for chromatic/silver.
      const t = Math.max(0, (now - start) / 1000);
      // Read live level — synthetic breathing if no getter.
      const target = getterRef.current
        ? getterRef.current()
        : 0.25 + 0.15 * Math.sin(t * 1.5);
      amp += (target - amp) * (target > amp ? 0.4 : 0.06); // ponytail: attack 0.4 (was 0.25) — snappier; release 0.06 keeps the tail

      ctx.clearRect(0, 0, W, H);
      if (W < 2) { rafId = requestAnimationFrame(draw); return; }

      const midY = H / 2;
      // Amplitude in pixels. Clamped so the wave never overflows the strip.
      const A = Math.max(1, 2 + amp * (midY - 4));

      // Stroke: solid accent or rotating gradient (chromatic/silver).
      const ws = styleRef.current;
      let stroke: string | CanvasGradient;
      if (ws === 'accent') {
        stroke = accent;
      } else {
        const pal = rotatedPaletteColors(ws, t, isDark) ?? VOICE_PALETTES[ws][isDark ? 'dark' : 'light'];
        const grad = ctx.createLinearGradient(0, 0, W, 0);
        for (let i = 0; i < pal.length; i++) {
          grad.addColorStop(i / (pal.length - 1), pal[i]!);
        }
        stroke = grad;
      }

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1.3;

      for (let li = 0; li < layers.length; li++) {
        const L = layers[li];
        ctx.globalAlpha = L.o;
        ctx.strokeStyle = stroke;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 2) {
          // End-taper envelope so amplitude fades flat at the edges.
          const env = Math.pow(Math.sin((x / W) * PI), 1.5);
          // Main sine + slow modulation drift.
          const wave = Math.sin((x / W) * PI * 2 * L.f + t * L.s + L.p);
          const mod = Math.sin((x / W) * PI * 2 * 0.5 + t * 0.7 + L.p);
          const y = midY + (wave * 0.7 + mod * 0.3) * A * L.a * env;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      themeObserver.disconnect();
      ro.disconnect();
    };
  }, [height]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden={ariaLabel ? undefined : true}
      role={ariaLabel ? 'status' : undefined}
      aria-label={ariaLabel}
    />
  );
}

