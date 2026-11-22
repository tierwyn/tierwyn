import { useEffect, useRef, useState } from 'react';
import type { WaveStyle } from '../voiceSettings.js';
import { VOICE_PALETTES, isDarkTheme, readAccent, rotatedPaletteColors, voiceColorAt, withAlpha } from '../voicePalettes.js';

/**
 * Stiff silk cousin with bright packets travelling along the thread. Reactive
 * when `getMicLevel` is set; otherwise runs a slow synthetic decode shimmer.
 */
export function VoiceMercuryThread({
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

    const packets = [0.12, 0.38, 0.62, 0.86];
    let amp = 0;
    let rafId = 0;
    const start = performance.now();
    const PI = Math.PI;

    const waveY = (x: number, t: number, A: number, midY: number) => {
      const env = Math.pow(Math.sin((x / W) * PI), 1.4);
      const w = Math.sin((x / W) * PI * 2 * 1.3 + t * 0.55)
        + 0.25 * Math.sin((x / W) * PI * 4 + t * 0.35);
      return midY + w * A * 0.55 * env;
    };

    const draw = (now: number) => {
      const t = Math.max(0, (now - start) / 1000);
      const ws = styleRef.current;
      const target = getterRef.current
        ? getterRef.current()
        : 0.2 + 0.12 * Math.sin(t * 1.2);
      amp += (target - amp) * (target > amp ? 0.35 : 0.05);

      if (W < 2) { rafId = requestAnimationFrame(draw); return; }
      ctx.clearRect(0, 0, W, H);
      const midY = H / 2;
      const A = Math.max(1, 1.5 + amp * (midY - 3));

      let stroke: string | CanvasGradient = accent;
      if (ws === 'accent') {
        stroke = accent;
      } else {
        const pal = rotatedPaletteColors(ws, t, isDark) ?? VOICE_PALETTES[ws][isDark ? 'dark' : 'light'];
        const grad = ctx.createLinearGradient(0, 0, W, 0);
        for (let i = 0; i < pal.length; i++) grad.addColorStop(i / (pal.length - 1), pal[i]!);
        stroke = grad;
      }

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1.1;
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const y = waveY(x, t, A, midY);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      const travel = getterRef.current
        ? 0.12 + amp * 0.22
        : 0.07 + 0.03 * Math.sin(t * 0.8);
      for (let i = 0; i < packets.length; i++) {
        const phase = (packets[i]! + t * travel) % 1;
        const x = phase * W;
        const y = waveY(x, t, A, midY);
        const flicker = 0.6 + 0.4 * Math.sin(t * 5 + i * 1.7);
        const packetColor = voiceColorAt(ws, t, accent, isDark, i / packets.length);
        const r = 1.4 + amp * 1.8 * flicker;
        ctx.fillStyle = withAlpha(packetColor, 0.55 + amp * 0.4);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, PI * 2);
        ctx.fill();
        ctx.fillStyle = withAlpha(packetColor, 0.2);
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, PI * 2);
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
      className="voice-visual voice-mercury"
      role="status"
      aria-label={ariaLabel}
    />
  );
}
