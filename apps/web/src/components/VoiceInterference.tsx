import { useEffect, useRef, useState } from 'react';
import type { WaveStyle } from '../voiceSettings.js';
import { isDarkTheme, readAccent, voiceColorAt, withAlpha } from '../voicePalettes.js';

/**
 * Expanding elliptical rings interfere at the centre — signal-processing moiré.
 * Processing-only; predetermined motion.
 */
export function VoiceInterference({
  height = 32,
  waveStyle = 'accent',
  ariaLabel = 'Transcribing speech',
}: {
  height?: number;
  waveStyle?: WaveStyle;
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const styleRef = useRef(waveStyle);
  styleRef.current = waveStyle;
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

    const rings = [
      { speed: 0.55, phase: 0, rx: 1.0, ry: 0.38 },
      { speed: 0.42, phase: 1.3, rx: 0.92, ry: 0.34 },
      { speed: 0.48, phase: 2.6, rx: 1.05, ry: 0.4 },
      { speed: 0.38, phase: 4.0, rx: 0.88, ry: 0.32 },
    ];

    let rafId = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const t = Math.max(0, (now - start) / 1000);
      const ws = styleRef.current;
      if (W < 2) { rafId = requestAnimationFrame(draw); return; }

      ctx.clearRect(0, 0, W, H);
      const cx = W / 2;
      const cy = H / 2;
      const maxRx = W * 0.46;
      const maxRy = H * 0.42;

      for (let i = 0; i < rings.length; i++) {
        const r = rings[i]!;
        const pulse = (t * r.speed + r.phase) % 1;
        const rx = (0.12 + pulse * 0.88) * maxRx * r.rx;
        const ry = (0.12 + pulse * 0.88) * maxRy * r.ry;
        const fade = 1 - pulse;
        const color = voiceColorAt(ws, t, accent, isDark, i / rings.length);

        ctx.strokeStyle = withAlpha(color, 0.08 + fade * 0.38);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      const coreColor = voiceColorAt(ws, t, accent, isDark, 0.5);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(maxRx, maxRy) * 0.35);
      glow.addColorStop(0, withAlpha(coreColor, 0.2));
      glow.addColorStop(1, withAlpha(coreColor, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(cx, cy, maxRx * 0.25, maxRy * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();

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
    <canvas ref={canvasRef} className="voice-visual voice-interference" role="status" aria-label={ariaLabel} />
  );
}
