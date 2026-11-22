import { useEffect, useRef, useState } from 'react';
import type { WaveStyle } from '../voiceSettings.js';
import { isDarkTheme, readAccent, voiceColorAt, withAlpha } from '../voicePalettes.js';

/**
 * A soft vertical prism band sweeps across the strip — analysing the signal.
 * Processing-only; predetermined motion.
 */
export function VoicePrismScan({
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

    let rafId = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const t = Math.max(0, (now - start) / 1000);
      const ws = styleRef.current;
      if (W < 2) { rafId = requestAnimationFrame(draw); return; }

      ctx.clearRect(0, 0, W, H);
      const midY = H / 2;
      const bandW = W * 0.2;
      const sweep = ((t * 0.32) % 1.35) - 0.18;
      const cx = sweep * W;

      const grad = ctx.createLinearGradient(cx - bandW, 0, cx + bandW, 0);
      const stops = 7;
      for (let i = 0; i < stops; i++) {
        const c = voiceColorAt(ws, t, accent, isDark, i / stops);
        const edge = Math.abs(i / (stops - 1) - 0.5) * 2;
        grad.addColorStop(i / (stops - 1), withAlpha(c, 0.05 + (1 - edge) * 0.35));
      }

      ctx.fillStyle = grad;
      ctx.fillRect(cx - bandW, 0, bandW * 2, H);

      // Bright core line.
      const core = voiceColorAt(ws, t + 0.2, accent, isDark, 0.5);
      ctx.strokeStyle = withAlpha(core, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, midY - H * 0.38);
      ctx.lineTo(cx, midY + H * 0.38);
      ctx.stroke();

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
    <canvas ref={canvasRef} className="voice-visual voice-prism" role="status" aria-label={ariaLabel} />
  );
}
