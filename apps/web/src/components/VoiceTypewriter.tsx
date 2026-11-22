import { useEffect, useRef, useState } from 'react';
import type { WaveStyle } from '../voiceSettings.js';
import { isDarkTheme, readAccent, voiceColorAt, withAlpha } from '../voicePalettes.js';

/**
 * Dots drift in from scattered positions and snap onto a baseline — phonemes
 * resolving into text. Processing-only; predetermined motion.
 */
export function VoiceTypewriter({
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

    const DOTS = 14;
    const seeds = Array.from({ length: DOTS }, (_, i) => ({
      spawnX: 0.08 + (i * 0.067 + Math.sin(i * 2.1) * 0.04) % 1,
      spawnY: -0.3 - (i % 5) * 0.12,
      targetX: (i + 0.5) / DOTS,
      phase: i * 0.07,
    }));

    const CYCLE = 2.6;
    let rafId = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const t = Math.max(0, (now - start) / 1000);
      const ws = styleRef.current;
      if (W < 2) { rafId = requestAnimationFrame(draw); return; }

      ctx.clearRect(0, 0, W, H);
      const midY = H * 0.52;
      const margin = W * 0.08;

      // Faint baseline.
      ctx.strokeStyle = withAlpha(voiceColorAt(ws, t, accent, isDark, 0), 0.12);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(margin, midY);
      ctx.lineTo(W - margin, midY);
      ctx.stroke();

      const cycle = ((t + 0.2) % CYCLE) / CYCLE;

      for (let i = 0; i < DOTS; i++) {
        const s = seeds[i]!;
        const local = (cycle + s.phase) % 1;
        const targetPx = margin + s.targetX * (W - margin * 2);
        const spawnPx = margin + (s.spawnX % 1) * (W - margin * 2);

        let x: number;
        let y: number;
        let alpha: number;

        if (local < 0.28) {
          const p = local / 0.28;
          const ease = 1 - (1 - p) ** 2;
          x = spawnPx + (targetPx - spawnPx) * ease * 0.15;
          y = midY + s.spawnY * H * (1 - ease * 0.4);
          alpha = 0.35 + ease * 0.45;
        } else if (local < 0.62) {
          const p = (local - 0.28) / 0.34;
          const ease = 1 - (1 - p) ** 3;
          x = spawnPx + (targetPx - spawnPx) * (0.15 + ease * 0.85);
          y = midY + s.spawnY * H * 0.6 * (1 - ease);
          alpha = 0.55 + ease * 0.35;
        } else {
          const p = (local - 0.62) / 0.38;
          x = targetPx;
          y = midY;
          alpha = 0.9 * (1 - p);
        }

        const color = voiceColorAt(ws, t, accent, isDark, i / DOTS);
        ctx.fillStyle = withAlpha(color, alpha);
        ctx.beginPath();
        ctx.arc(x, y, 1.3 + alpha * 0.5, 0, Math.PI * 2);
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
    <canvas ref={canvasRef} className="voice-visual voice-typewriter" role="status" aria-label={ariaLabel} />
  );
}
