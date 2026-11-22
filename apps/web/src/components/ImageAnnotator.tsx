import { useEffect, useRef, useState, useCallback } from 'react';
import {
  type Shape, type Crop, type Pt, type AnnotateState,
  normalizeCrop, fitScale, screenToImage,
} from '@tierwyn/shared';

export type Tool = 'pen' | 'arrow' | 'rectangle' | 'oval' | 'rect' | 'ellipse' | 'highlight' | 'text' | 'crop';

const TOOLS: Tool[] = ['pen', 'arrow', 'rectangle', 'oval', 'highlight', 'text', 'crop'];

const TOOL_TITLES: Partial<Record<Tool, string>> = {
  rectangle: 'Rectangle (hold Shift for square)',
  oval: 'Oval / Ellipse (hold Shift for circle)',
};

const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#111827'];
const WIDTHS: Record<'S' | 'M' | 'L', number> = { S: 3, M: 6, L: 12 };

export interface ImageAnnotatorProps {
  src: string;
  mediaType: string;
  name?: string;
  onSave: (att: { base64: string; mediaType: string; name?: string }, idx: number) => void;
  onClose: () => void;
  /** When provided, enables prev/next navigation. idx passed to onSave is into this array. */
  images?: Array<{ src: string; mediaType: string; name?: string }>;
  initialIndex?: number;
}

/** Draw every shape onto ctx. ctx is pre-translated so image-space (0,0) maps
 *  to the crop origin — callers translate by -crop.x,-crop.y before calling. */
export function renderShapes(ctx: CanvasRenderingContext2D, shapes: Shape[]) {
  for (const s of shapes) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.kind === 'pen' || s.kind === 'highlight') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.globalAlpha = s.kind === 'highlight' ? 0.35 : 1;
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (s.kind === 'arrow') {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      const [x1, y1] = s.from;
      const [x2, y2] = s.to;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.hypot(dx, dy);
      if (dist > 0) {
        const ang = Math.atan2(dy, dx);
        const head = Math.max(10, s.width * 3);
        const baseDist = head * Math.cos(Math.PI / 6);
        const shaftDist = Math.max(0, dist - baseDist);
        if (shaftDist > 0) {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 + shaftDist * Math.cos(ang), y1 + shaftDist * Math.sin(ang));
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      }
    } else if (s.kind === 'rect' || s.kind === 'rectangle') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      const [x1, y1] = s.from;
      const [x2, y2] = s.to;
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      ctx.strokeRect(x, y, w, h);
    } else if (s.kind === 'ellipse' || s.kind === 'oval') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      const [x1, y1] = s.from;
      const [x2, y2] = s.to;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.kind === 'text') {
      ctx.fillStyle = s.color;
      ctx.font = `${s.size}px sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(s.value, s.at[0], s.at[1]);
    }
  }
}

/** Returns index of topmost text shape at image-space point p, or -1.
 *  Uses measureText so the hit-box matches the actual rendered glyph width. */
function hitTestText(shapes: Shape[], p: Pt, ctx: CanvasRenderingContext2D): number {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.kind !== 'text') continue;
    ctx.font = `${s.size}px sans-serif`;
    const w = ctx.measureText(s.value).width;
    const pad = 6; // generous pad so it's easy to grab
    if (p[0] >= s.at[0] - pad && p[0] <= s.at[0] + w + pad &&
        p[1] >= s.at[1] - pad && p[1] <= s.at[1] + s.size + pad) return i;
  }
  return -1;
}

export function ImageAnnotator({ src, mediaType, name, onSave, onClose, images, initialIndex }: ImageAnnotatorProps) {
  const allImages = images ?? [{ src, mediaType, name }];
  const [activeIdx, setActiveIdx] = useState(Math.min(initialIndex ?? 0, allImages.length - 1));
  const current = allImages[activeIdx];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [widthKey, setWidthKey] = useState<'S' | 'M' | 'L'>('M');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [history, setHistory] = useState<AnnotateState[]>([]);
  // ponytail: zoom multiplier on top of fit-scale; wheel adjusts, 0.2–8 ceiling
  const [zoom, setZoom] = useState(1);

  // In-progress gesture (image-space).
  const draftRef = useRef<Shape | null>(null);
  const [, force] = useState(0);
  const redraw = useCallback(() => force((n) => n + 1), []);

  // Pending crop rect being dragged, plus an "applied but unconfirmed" crop.
  const cropDraftRef = useRef<Crop | null>(null);
  // ponytail: original crop-drag anchor; without it the rect drifts after the first move
  const cropAnchorRef = useRef<Pt | null>(null);
  // Active text drag: which shape, the click-to-anchor offset, and current live position.
  const textDragRef = useRef<{ index: number; offset: Pt; currentAt: Pt } | null>(null);
  // Text input overlay position (screen px) when placing text.
  const [textPos, setTextPos] = useState<{ sx: number; sy: number; at: Pt } | null>(null);
  const [textValue, setTextValue] = useState('');

  // Load the image through a blob URL so canvas.toBlob() is never tainted.
  // Re-runs when current.src changes (i.e. on navigation).
  useEffect(() => {
    let revoked = '';
    let cancelled = false;
    setError(null);
    setLoaded(false);
    fetch(current.src, { credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error(`fetch -> ${r.status}`); return r.blob(); })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        revoked = url;
        const img = new Image();
        img.onload = () => { if (!cancelled) { imgRef.current = img; setLoaded(true); } };
        img.onerror = () => { if (!cancelled) setError('Could not load image'); };
        img.src = url;
      })
      .catch((e) => { if (!cancelled) setError(String(e instanceof Error ? e.message : e)); });
    return () => { cancelled = true; if (revoked) URL.revokeObjectURL(revoked); };
  }, [current.src]);

  // Close on Escape — Ctrl+Z / Ctrl+S shortcuts added after undo/handleSave are defined below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const img = imgRef.current;
  const view = img
    ? (() => {
        const nc = normalizeCrop(crop, img.naturalWidth, img.naturalHeight);
        // Use actual viewport so the initial fit fills the (now full-screen) stage.
        // 80px horizontal gutter: modal border + padding. 140px vertical: toolbar + modal border + padding.
        const fitW = Math.max(400, window.innerWidth - 80);
        const fitH = Math.max(300, window.innerHeight - 140);
        const scale = fitScale(nc.w, nc.h, fitW, fitH) * zoom;
        return { nc, scale };
      })()
    : null;

  // Redraw the on-screen canvas whenever state changes.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !img || !view) return;
    const { nc, scale } = view;
    cv.width = Math.round(nc.w * scale);
    cv.height = Math.round(nc.h * scale);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-nc.x, -nc.y);
    ctx.drawImage(img, 0, 0);
    // During a text drag, render that shape at its live position.
    const textDrag = textDragRef.current;
    const shapesToRender = textDrag
      ? shapes.map((s, i) => i === textDrag.index ? { ...s, at: textDrag.currentAt } : s) as Shape[]
      : shapes;
    const draft = draftRef.current;
    renderShapes(ctx, draft ? [...shapesToRender, draft] : shapesToRender);
    // Anchor dots: show draggable handles on text shapes when text tool is active.
    if (tool === 'text') {
      shapesToRender.forEach(s => {
        if (s.kind !== 'text') return;
        const px = (s.at[0] - nc.x) * scale;
        const py = (s.at[1] - nc.y) * scale;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }
    ctx.restore();
    // crop preview rectangle (screen-space dashed box)
    const cd = cropDraftRef.current;
    if (cd) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect((cd.x - nc.x) * scale, (cd.y - nc.y) * scale, cd.w * scale, cd.h * scale);
      ctx.restore();
    }
  }); // run every render — cheap for a single image

  const pushHistory = useCallback(() => {
    setHistory((h) => [...h.slice(-49), { shapes, crop }]);
  }, [shapes, crop]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setShapes(prev.shapes);
      setCrop(prev.crop);
      return h.slice(0, -1);
    });
  }, []);

  const eventToImage = useCallback((e: React.PointerEvent): Pt => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    // ponytail: cv.width is buffer px; rect.width is CSS px (differs under max-width shrink)
    const k = cv.width / rect.width;
    const sx = (e.clientX - rect.left) * k;
    const sy = (e.clientY - rect.top) * k;
    return screenToImage([sx, sy], view!.scale, view!.nc);
  }, [view]);

  // ponytail: ctrl/cmd+wheel zooms; bare wheel scroll stays native. 0.2–8 range.
  // Attached as native non-passive so preventDefault works (React onWheel is passive).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(z => Math.min(8, Math.max(0.2, z * Math.exp(-e.deltaY * 0.0015))));
    };
    cv.addEventListener('wheel', handler, { passive: false });
    return () => cv.removeEventListener('wheel', handler);
  }, [loaded]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!view || textPos) return;
    const p = eventToImage(e);
    const width = WIDTHS[widthKey];
    if (tool === 'text') {
      e.preventDefault(); // prevents mousedown moving focus to body (would blur autoFocus input)
      const cv = canvasRef.current!;
      const ctx = cv.getContext('2d');
      // Hit-test existing text shapes — drag if hit, create if miss.
      if (ctx) {
        const hitIdx = hitTestText(shapes, p, ctx);
        if (hitIdx >= 0) {
          (e.target as Element).setPointerCapture(e.pointerId);
          const origAt = (shapes[hitIdx] as Extract<Shape, { kind: 'text' }>).at;
          textDragRef.current = { index: hitIdx, offset: [p[0] - origAt[0], p[1] - origAt[1]], currentAt: origAt };
          redraw();
          return;
        }
      }
      // No hit → open text input at click position.
      const rect = cv.getBoundingClientRect();
      // ponytail: stage is offsetParent; canvas offsetLeft/Top is relative to stage
      const sx = cv.offsetLeft + (e.clientX - rect.left);
      const sy = cv.offsetTop + (e.clientY - rect.top);
      setTextPos({ sx, sy, at: p });
      setTextValue('');
      return;
    }
    // Pointer capture keeps move/up events arriving even when cursor leaves
    // the canvas — only needed for drag-based tools, not text.
    (e.target as Element).setPointerCapture(e.pointerId);
    if (tool === 'crop') {
      cropAnchorRef.current = p;
      cropDraftRef.current = { x: p[0], y: p[1], w: 0, h: 0 };
      redraw();
      return;
    }
    if (tool === 'pen' || tool === 'highlight') {
      draftRef.current = { kind: tool, points: [p], color, width };
    } else if (tool === 'arrow') {
      draftRef.current = { kind: 'arrow', from: p, to: p, color, width };
    } else if (tool === 'rectangle' || tool === 'rect') {
      draftRef.current = { kind: 'rectangle', from: p, to: p, color, width };
    } else if (tool === 'oval' || tool === 'ellipse') {
      draftRef.current = { kind: 'oval', from: p, to: p, color, width };
    }
    redraw();
  }, [view, tool, color, widthKey, eventToImage, textPos, shapes, redraw]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!view) return;
    // Text drag in progress — update live position.
    if (textDragRef.current) {
      const p = eventToImage(e);
      const { offset } = textDragRef.current;
      textDragRef.current = { ...textDragRef.current, currentAt: [p[0] - offset[0], p[1] - offset[1]] };
      redraw();
      return;
    }
    // Cursor hint: show 'move' when hovering over a draggable text shape.
    if (tool === 'text') {
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (cv && ctx) {
        const p = eventToImage(e);
        cv.style.cursor = hitTestText(shapes, p, ctx) >= 0 ? 'move' : 'crosshair';
      }
    }
    if (tool === 'crop' && cropAnchorRef.current) {
      const p = eventToImage(e);
      const a = cropAnchorRef.current;
      cropDraftRef.current = {
        x: Math.min(a[0], p[0]), y: Math.min(a[1], p[1]),
        w: Math.abs(p[0] - a[0]), h: Math.abs(p[1] - a[1]),
      };
      redraw();
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    const p = eventToImage(e);
    if (d.kind === 'pen' || d.kind === 'highlight') {
      d.points.push(p);
    } else if (d.kind === 'arrow') {
      d.to = p;
    } else if (d.kind === 'rectangle' || d.kind === 'rect' || d.kind === 'oval' || d.kind === 'ellipse') {
      if (e.shiftKey) {
        const dx = p[0] - d.from[0];
        const dy = p[1] - d.from[1];
        const size = Math.max(Math.abs(dx), Math.abs(dy));
        const signX = dx < 0 ? -1 : 1;
        const signY = dy < 0 ? -1 : 1;
        d.to = [d.from[0] + signX * size, d.from[1] + signY * size];
      } else {
        d.to = p;
      }
    }
    redraw();
  }, [view, tool, shapes, eventToImage, redraw]);

  const onPointerUp = useCallback(() => {
    // Commit a text drag.
    if (textDragRef.current) {
      const { index, currentAt } = textDragRef.current;
      textDragRef.current = null;
      pushHistory();
      setShapes(s => s.map((sh, i) => i === index ? { ...sh, at: currentAt } : sh) as Shape[]);
      redraw();
      return;
    }
    if (tool === 'crop' && cropDraftRef.current) {
      const cd = cropDraftRef.current;
      cropDraftRef.current = null;
      cropAnchorRef.current = null;
      if (cd.w > 4 && cd.h > 4) { pushHistory(); setCrop(cd); }
      redraw();
      return;
    }
    const d = draftRef.current;
    draftRef.current = null;
    if (d) {
      const isTiny = (d.kind === 'arrow' || d.kind === 'rectangle' || d.kind === 'rect' || d.kind === 'oval' || d.kind === 'ellipse')
        && Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) < 2;
      if (!isTiny) {
        pushHistory();
        setShapes((s) => [...s, d]);
      }
    }
    redraw();
  }, [tool, pushHistory, redraw]);

  const commitText = useCallback(() => {
    if (textPos && textValue.trim()) {
      pushHistory();
      setShapes((s) => [...s, { kind: 'text', at: textPos.at, value: textValue, color, size: Math.max(14, WIDTHS[widthKey] * 3) }]);
    }
    setTextPos(null);
    setTextValue('');
  }, [textPos, textValue, color, widthKey, pushHistory]);

  const handleSave = useCallback(() => {
    if (!img || !view) return;
    const { nc } = view;
    const off = document.createElement('canvas');
    off.width = Math.round(nc.w);
    off.height = Math.round(nc.h);
    const ctx = off.getContext('2d');
    if (!ctx) return;
    ctx.translate(-nc.x, -nc.y);
    ctx.drawImage(img, 0, 0);
    renderShapes(ctx, shapes);
    off.toBlob((blob) => {
      if (!blob) return;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] ?? '';
        const base = (current.name ?? 'image').replace(/\.[a-z0-9]+$/i, '');
        onSave({ base64, mediaType: 'image/png', name: `${base}-annotated.png` }, activeIdx);
      };
      reader.readAsDataURL(blob);
    }, 'image/png');
  }, [img, view, shapes, current.name, onSave, activeIdx]);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+S = save — placed after undo/handleSave are defined.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept while the text input overlay is focused.
      if (document.activeElement?.classList.contains('annotator-text-input')) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, handleSave]);

  /** Navigate to another image, resetting all annotation state. */
  const navigate = useCallback((newIdx: number) => {
    setActiveIdx(newIdx);
    setShapes([]);
    setCrop(null);
    setHistory([]);
    setZoom(1);
    setTextPos(null);
    setTextValue('');
    draftRef.current = null;
    textDragRef.current = null;
    cropDraftRef.current = null;
    cropAnchorRef.current = null;
  }, []);

  return (
    <div className="modal-overlay image-annotator-overlay" onClick={onClose}>
      <div className="image-annotator" onClick={(e) => e.stopPropagation()}>
        <div className="annotator-toolbar">
          {TOOLS.map((t) => (
            <button
              key={t}
              type="button"
              className={`annotator-tool${tool === t ? ' active' : ''}`}
              title={TOOL_TITLES[t]}
              onClick={() => { setTool(t); setTextPos(null); }}
            >{t}</button>
          ))}
          <span className="annotator-sep" />
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`annotator-swatch${color === c ? ' active' : ''}`}
              style={{ background: c }}
              aria-label={`color ${c}`}
              onClick={() => setColor(c)}
            />
          ))}
          <span className="annotator-sep" />
          {(['S', 'M', 'L'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`annotator-width${widthKey === k ? ' active' : ''}`}
              onClick={() => setWidthKey(k)}
            >{k}</button>
          ))}
          <span className="annotator-sep" />
          {crop && <button type="button" className="annotator-tool" onClick={() => { pushHistory(); setCrop(null); }}>uncrop</button>}
          <button type="button" className="annotator-tool" onClick={undo} disabled={history.length === 0}>undo</button>
          <span className="annotator-sep" />
          <button type="button" className="annotator-tool" onClick={() => setZoom(z => Math.max(0.2, z * 0.8))}>−</button>
          <span className="annotator-zoom">{Math.round(zoom * 100)}%</span>
          <button type="button" className="annotator-tool" onClick={() => setZoom(z => Math.min(8, z * 1.25))}>+</button>
          <button type="button" className="annotator-tool" onClick={() => setZoom(1)} title="reset zoom">1:1 fit</button>
          <div style={{ flex: 1 }} />
          {allImages.length > 1 && (
            <>
              <button type="button" className="annotator-tool" onClick={() => navigate(activeIdx - 1)} disabled={activeIdx === 0} title="Previous image">‹</button>
              <span className="annotator-zoom">{activeIdx + 1} / {allImages.length}</span>
              <button type="button" className="annotator-tool" onClick={() => navigate(activeIdx + 1)} disabled={activeIdx === allImages.length - 1} title="Next image">›</button>
              <span className="annotator-sep" />
            </>
          )}
          <button type="button" className="annotator-tool" onClick={onClose}>cancel</button>
          <button type="button" className="annotator-save" onClick={handleSave} disabled={!loaded}>save</button>
        </div>
        <div className="annotator-stage">
          {error && <div className="annotator-error">{error}</div>}
          {!error && !loaded && <div className="annotator-loading">Loading…</div>}
          {!error && loaded && (
            <canvas
              ref={canvasRef}
              className="annotator-canvas"
              style={{ touchAction: 'none', cursor: 'crosshair' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          )}
          {textPos && view && (
            <input
              className="annotator-text-input"
              autoFocus
              style={{
                position: 'absolute',
                left: textPos.sx,
                top: textPos.sy,
                color,
                // Match canvas render: size is in image-px, multiply by scale for CSS px.
                fontSize: Math.max(14, WIDTHS[widthKey] * 3) * view.scale,
                lineHeight: 1,
                padding: 0,
                fontFamily: 'sans-serif',
              }}
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(); } }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default ImageAnnotator;
