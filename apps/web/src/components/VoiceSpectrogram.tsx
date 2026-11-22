import { useEffect, useRef, useState } from 'react';
import type { WaveStyle } from '../voiceSettings.js';
import {
  isDarkTheme,
  readAccent,
  voiceColorAt,
  withAlpha,
} from '../voicePalettes.js';

/**
 * Spectrogram-style bars that shimmer and melt toward the centre while speech
 * is being transcribed. Replaces VoiceNucleus during the decode phase.
 */
export function VoiceSpectrogram({
  height = 32,
  waveStyle = 'accent',
  getMicLevel = null,
  ariaLabel = 'Transcribing speech',
}: {
  height?: number;
  waveStyle?: WaveStyle;
  getMicLevel?: (() => number) | null;
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const styleRef = useRef(waveStyle);
  styleRef.current = waveStyle;
  const getterRef = useRef(getMicLevel);
  getterRef.current = getMicLevel;
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

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

    // Pre-seed per-bin phases so the "spectrum" looks organic but stable.
    const seeds = Array.from({ length: 128 }, (_, i) => ({
      phaseA: i * 0.61,
      phaseB: i * 1.17 + 0.3,
      weight: 0.55 + 0.45 * Math.sin(i * 0.43) ** 2,
    }));

    let amp = 0;
    let rafId = 0;
    const start = performance.now();
    const MELT_PERIOD = 3.8;

    const draw = (now: number) => {
      const t = Math.max(0, (now - start) / 1000);
      const ws = styleRef.current;
      const target = getterRef.current
        ? getterRef.current()
        : 0.25 + 0.15 * Math.sin(t * 1.5);
      amp += (target - amp) * (target > amp ? 0.35 : 0.06);
      const reactive = !!getterRef.current;
      if (W < 2) { rafId = requestAnimationFrame(draw); return; }

      ctx.clearRect(0, 0, W, H);
      const midY = H / 2;
      const barGap = 2;
      const barW = Math.max(2, Math.floor((W + barGap) / 48) - barGap);
      const step = barW + barGap;
      const count = Math.max(8, Math.floor(W / step));
      const melt = (t % MELT_PERIOD) / MELT_PERIOD;

      for (let i = 0; i < count; i++) {
        const x = i * step + barW / 2;
        const normX = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
        const dist = Math.abs(normX);
        const seed = seeds[i % seeds.length]!;

        // End taper — spectrogram fades at strip edges.
        const edgeEnv = Math.pow(Math.sin((i / Math.max(1, count - 1)) * Math.PI), 1.2);

        // Fake frequency energy with slow shimmer.
        const shimmer = 0.45 + 0.55 * (
          0.5 * (1 + Math.sin(t * 2.4 + seed.phaseA))
          * (0.5 + 0.5 * Math.sin(t * 3.7 + seed.phaseB))
        );
        const band = Math.exp(-dist * dist * 1.6) * 0.55 + (1 - dist) * 0.25;
        let energy = edgeEnv * seed.weight * band * shimmer;
        if (reactive) energy *= 0.35 + amp * 0.95;

        const meltWave = 0.5 - 0.5 * Math.cos(melt * Math.PI * 2);
        const meltStrength = reactive ? 0.12 : 0.92;
        const collapse = 1 - meltWave * Math.pow(dist, 0.75) * meltStrength;
        const halfH = Math.max(0.6, (H * 0.46) * energy * collapse);

        const color = voiceColorAt(ws, t, accent, isDark, i / count);
        const alpha = 0.28 + energy * collapse * 0.52;
        ctx.fillStyle = withAlpha(color, alpha);

        const top = midY - halfH;
        const h = halfH * 2;
        const r = Math.min(barW / 2, 1.5);
        ctx.beginPath();
        ctx.roundRect(x - barW / 2, top, barW, h, r);
        ctx.fill();
      }

      // Soft centre glow while melting — parsed signal coalescing.
      const meltGlow = 0.5 - 0.5 * Math.cos(melt * Math.PI * 2);
      if (!reactive && meltGlow > 0.08) {
        const glow = ctx.createRadialGradient(W / 2, midY, 0, W / 2, midY, W * 0.18);
        const glowColor = voiceColorAt(ws, t, accent, isDark, 0.5);
        glow.addColorStop(0, withAlpha(glowColor, 0.12 * meltGlow));
        glow.addColorStop(1, withAlpha(glowColor, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);
      }

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      themeObserver.disconnect();
      ro.disconnect();
    };
  }, [height, reducedMotion, waveStyle]);

  if (reducedMotion) {
    return <div className="voice-dot" role="status" aria-label={ariaLabel} />;
  }

  return (
    <canvas
      ref={canvasRef}
      className="voice-visual voice-spectrogram"
      role="status"
      aria-label={ariaLabel}
    />
  );
}
