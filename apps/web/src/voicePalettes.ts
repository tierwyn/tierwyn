import type { WaveStyle } from './voiceSettings.js';

// Voice wave color palettes.
// chromatic: blue → purple → pink → gold → blue (iridescent rainbow)
// silver:    near-monochrome metallic ramp
export const VOICE_PALETTES: Record<'chromatic' | 'silver', { dark: string[]; light: string[] }> = {
  chromatic: {
    dark:  ['#7ab8ff', '#b288ff', '#ff7ab2', '#ffd166', '#7ab8ff'],
    light: ['#2a6df4', '#7a3df4', '#d63d8f', '#e0a93d', '#2a6df4'],
  },
  silver: {
    dark:  ['#c8ccdb', '#eef0f8', '#9aa0b5', '#f5f6fb', '#c8ccdb'],
    light: ['#6a6f85', '#2a2e3d', '#9094a8', '#1a1d28', '#6a6f85'],
  },
};

/** Rotating palette slice for chromatic/silver; null when style is accent. */
export function rotatedPaletteColors(
  style: WaveStyle,
  t: number,
  isDark: boolean,
): string[] | null {
  if (style === 'accent') return null;
  const pal = VOICE_PALETTES[style][isDark ? 'dark' : 'light'];
  const rot = Math.floor(t * 0.5) % pal.length;
  return pal.map((_, i) => pal[(i + rot) % pal.length]!);
}

/** Resolve a stroke/fill colour for voice visuals at time `t` (seconds). */
export function voiceColorAt(
  style: WaveStyle,
  t: number,
  accent: string,
  isDark: boolean,
  phase = 0,
): string {
  const palette = rotatedPaletteColors(style, t, isDark);
  if (!palette) return accent;
  const idx = (Math.floor(phase * palette.length)) % palette.length;
  return palette[idx < 0 ? idx + palette.length : idx]!;
}

/** Build a canvas gradient from the current rotated palette (chromatic/silver). */
export function voiceRadialGradient(
  ctx: CanvasRenderingContext2D,
  style: WaveStyle,
  t: number,
  isDark: boolean,
  accent: string,
  x0: number,
  y0: number,
  r0: number,
  x1: number,
  y1: number,
  r1: number,
  alpha = 1,
): CanvasGradient | string {
  const palette = rotatedPaletteColors(style, t, isDark);
  if (!palette) return accent;
  const grad = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  const denom = Math.max(1, palette.length - 1);
  for (let i = 0; i < palette.length; i++) {
    grad.addColorStop(i / denom, withAlpha(palette[i]!, alpha));
  }
  return grad;
}

export function readAccent(): string {
  if (typeof window === 'undefined') return '#22d3ee';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || '#22d3ee';
}

export function isDarkTheme(): boolean {
  if (typeof window === 'undefined') return true;
  return !document.documentElement.dataset.theme?.includes('light');
}

/** Parse #rgb / #rrggbb or return fallback with alpha. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    const r = parseInt(hex[1] + hex[1], 16);
    const g = parseInt(hex[2] + hex[2], 16);
    const b = parseInt(hex[3] + hex[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return `rgba(34, 211, 238, ${alpha})`;
}
