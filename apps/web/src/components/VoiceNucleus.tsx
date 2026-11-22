import { useEffect, useRef, useState } from 'react';
import type { WaveStyle } from '../voiceSettings.js';
import {
  isDarkTheme,
  readAccent,
  rotatedPaletteColors,
  voiceRadialGradient,
  withAlpha,
} from '../voicePalettes.js';

/**
 * Full-width orbiting-particle nucleus for the transcription phase. Spans the
 * voice-feedback strip like VoiceWave so horizontal breathe is visible.
 */
export function VoiceNucleus({
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

    const particles = Array.from({ length: 8 }, (_, i) => ({
      orbit: 0.55 + (i % 3) * 0.12,
      speed: 0.9 + (i % 4) * 0.35,
      phase: (i / 8) * Math.PI * 2,
      size: 1.2 + (i % 2) * 0.6,
      colorIndex: i,
    }));

    let amp = 0;
    let rafId = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const t = Math.max(0, (now - start) / 1000);
      const ws = styleRef.current;
      const palette = rotatedPaletteColors(ws, t, isDark);
      const target = getterRef.current
        ? getterRef.current()
        : 0.25 + 0.15 * Math.sin(t * 1.5);
      amp += (target - amp) * (target > amp ? 0.35 : 0.06);
      const reactive = !!getterRef.current;
      const motion = reactive ? 0.5 + amp * 0.65 : 1;
      if (W < 2) { rafId = requestAnimationFrame(draw); return; }

      const cx = W / 2;
      const cy = H / 2;
      ctx.clearRect(0, 0, W, H);

      const breath = (0.55 + 0.45 * Math.sin(t * 2.1)) * (reactive ? 0.75 + amp * 0.5 : 1);
      const squeeze = Math.sin(t * 1.75);
      const hScale = (1 + squeeze * 0.22) * motion;
      const vScale = (1 - squeeze * 0.08) * motion;

      const maxH = (W / 2) - 4;
      const maxV = (H / 2) - 3;
      const haloRx = Math.min(maxH, 9 + breath * 2) * hScale;
      const haloRy = Math.min(maxV, 4 + breath) * vScale;

      const haloFill = voiceRadialGradient(
        ctx, ws, t, isDark, accent, cx, cy, 0, cx, cy, Math.max(haloRx, haloRy), 0.16 * breath,
      );
      if (typeof haloFill === 'string') {
        const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(haloRx, haloRy));
        halo.addColorStop(0, withAlpha(haloFill, 0.2 * breath));
        halo.addColorStop(0.55, withAlpha(haloFill, 0.07 * breath));
        halo.addColorStop(1, withAlpha(haloFill, 0));
        ctx.fillStyle = halo;
      } else {
        ctx.fillStyle = haloFill;
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, haloRx, haloRy, 0, 0, Math.PI * 2);
      ctx.fill();

      const coreRx = Math.min(maxH * 0.18, 2.4) * hScale;
      const coreRy = Math.min(maxV * 0.32, 1.8) * vScale;
      const coreFill = voiceRadialGradient(
        ctx, ws, t, isDark, accent, cx, cy, 0, cx, cy, Math.max(coreRx, coreRy), 1,
      );
      if (typeof coreFill === 'string') {
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(coreRx, coreRy));
        core.addColorStop(0, withAlpha(coreFill, 1));
        core.addColorStop(0.6, withAlpha(coreFill, 0.75));
        core.addColorStop(1, withAlpha(coreFill, 0));
        ctx.fillStyle = core;
      } else {
        ctx.fillStyle = coreFill;
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, coreRx, coreRy, 0, 0, Math.PI * 2);
      ctx.fill();

      for (const p of particles) {
        const speed = reactive ? p.speed * (0.7 + amp * 0.8) : p.speed;
        const angle = t * speed + p.phase;
        const orbitH = Math.min(maxH, W * p.orbit * 0.42) * hScale;
        const orbitV = Math.min(maxV, H * 0.38) * vScale;
        const x = cx + Math.cos(angle) * orbitH;
        const y = cy + Math.sin(angle) * orbitV;
        const flicker = 0.65 + 0.35 * Math.sin(t * 4 + p.phase);
        const particleColor = palette
          ? palette[p.colorIndex % palette.length]!
          : accent;

        ctx.fillStyle = withAlpha(particleColor, 0.85 * flicker);
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fill();
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
      className="voice-visual voice-nucleus"
      role="status"
      aria-label={ariaLabel}
    />
  );
}
