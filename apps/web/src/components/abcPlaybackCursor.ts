import type { NoteTimingEvent } from 'abcjs';

/** Legacy per-SVG line nodes (removed on update). */
export const PLAYBACK_CURSOR_CLASS = 'abcjs-playback-cursor';
export const PLAYBACK_CURSOR_OVERLAY_CLASS = 'abcjs-playback-cursor-overlay';
export const PLAYBACK_HIGHLIGHT_CLASS = 'abcjs-playback-highlight';

export interface PlaybackCursorPosition {
  left: number;
  top: number;
  height: number;
  elements?: NoteTimingEvent['elements'];
}

const pendingCursorByContainer = new WeakMap<HTMLElement, PlaybackCursorPosition>();
const rafByContainer = new WeakMap<HTMLElement, number>();

export function scoreSvgs(container: HTMLElement | null): SVGSVGElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll('svg'));
}

function ensureOverlayCursor(container: HTMLElement): HTMLDivElement {
  let overlay = container.querySelector<HTMLDivElement>(`.${PLAYBACK_CURSOR_OVERLAY_CLASS}`);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = PLAYBACK_CURSOR_OVERLAY_CLASS;
    overlay.setAttribute('aria-hidden', 'true');
    container.appendChild(overlay);
  }
  return overlay;
}

function removeLegacySvgCursors(container: HTMLElement): void {
  container.querySelectorAll(`svg .${PLAYBACK_CURSOR_CLASS}`).forEach((el) => el.remove());
}

export function clearPlaybackHighlights(svg: SVGSVGElement | null): void {
  if (!svg) return;
  svg.querySelectorAll(`.${PLAYBACK_HIGHLIGHT_CLASS}`).forEach((el) => {
    el.classList.remove(PLAYBACK_HIGHLIGHT_CLASS);
  });
}

function svgForTimingEvent(
  ev: Pick<NoteTimingEvent, 'elements'>,
): SVGSVGElement | null {
  if (ev.elements) {
    for (const group of ev.elements) {
      for (const el of group) {
        const svg = el.closest('svg');
        if (svg) return svg;
      }
    }
  }
  return null;
}

/** Pick the line SVG whose viewBox contains this Y (handles gaps between systems). */
function svgForY(svgs: SVGSVGElement[], y: number): SVGSVGElement | null {
  let best: SVGSVGElement | null = null;
  let bestTop = -Infinity;
  for (const svg of svgs) {
    const vb = svg.viewBox.baseVal;
    if (vb.height <= 0) continue;
    if (vb.y <= y && vb.y > bestTop) {
      bestTop = vb.y;
      best = svg;
    }
  }
  return best ?? svgs[0] ?? null;
}

function targetSvgForPosition(
  svgs: SVGSVGElement[],
  pos: PlaybackCursorPosition,
): SVGSVGElement | null {
  const fromElements = svgForTimingEvent(pos);
  if (fromElements) return fromElements;
  return svgForY(svgs, pos.top);
}

function userPointToContainerPx(
  svg: SVGSVGElement,
  x: number,
  y: number,
  container: HTMLElement,
): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = x;
  pt.y = y;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const screen = pt.matrixTransform(ctm);
  const cr = container.getBoundingClientRect();
  return {
    x: screen.x - cr.left + container.scrollLeft,
    y: screen.y - cr.top + container.scrollTop,
  };
}

/** One HTML overlay — no flicker when the playhead crosses oneSvgPerLine boundaries. */
function applyPlaybackCursor(
  container: HTMLElement,
  pos: PlaybackCursorPosition,
): void {
  if (pos.left == null || pos.top == null || pos.height == null) return;

  const svgs = scoreSvgs(container);
  const targetSvg = targetSvgForPosition(svgs, pos);
  if (!targetSvg) return;

  removeLegacySvgCursors(container);

  const x = pos.left - 2;
  const topPt = userPointToContainerPx(targetSvg, x, pos.top, container);
  const bottomPt = userPointToContainerPx(targetSvg, x, pos.top + pos.height, container);

  const overlay = ensureOverlayCursor(container);
  overlay.style.left = `${topPt.x}px`;
  overlay.style.top = `${topPt.y}px`;
  overlay.style.height = `${Math.max(1, bottomPt.y - topPt.y)}px`;
  overlay.style.display = 'block';
}

/** Vertical playback line — batched to animation frames to avoid jank. */
export function schedulePlaybackCursor(
  container: HTMLElement | null,
  pos: PlaybackCursorPosition,
): void {
  if (!container || pos.left == null || pos.top == null || pos.height == null) return;

  pendingCursorByContainer.set(container, pos);
  if (rafByContainer.has(container)) return;

  const id = requestAnimationFrame(() => {
    rafByContainer.delete(container);
    const latest = pendingCursorByContainer.get(container);
    pendingCursorByContainer.delete(container);
    if (latest) applyPlaybackCursor(container, latest);
  });
  rafByContainer.set(container, id);
}

/** Immediate cursor move (seek / note onset). */
export function updatePlaybackCursor(
  container: HTMLElement | null,
  pos: PlaybackCursorPosition,
): void {
  if (!container) return;
  pendingCursorByContainer.delete(container);
  const id = rafByContainer.get(container);
  if (id != null) {
    cancelAnimationFrame(id);
    rafByContainer.delete(container);
  }
  applyPlaybackCursor(container, pos);
}

export function updatePlaybackHighlights(
  container: HTMLElement | null,
  ev: Pick<NoteTimingEvent, 'elements'>,
): void {
  if (!container) return;

  const svgs = scoreSvgs(container);
  for (const svg of svgs) clearPlaybackHighlights(svg);

  if (!ev.elements) return;
  for (const group of ev.elements) {
    for (const el of group) {
      el.classList.add(PLAYBACK_HIGHLIGHT_CLASS);
    }
  }
}

/** Highlight current notes + snap cursor on note onset (abcjs CursorControl.onEvent). */
export function updatePlaybackVisuals(container: HTMLElement | null, ev: NoteTimingEvent): void {
  if (!container || (ev.measureStart && ev.left == null)) return;

  updatePlaybackHighlights(container, ev);

  if (ev.left == null || ev.top == null || ev.height == null) return;
  updatePlaybackCursor(container, {
    left: ev.left,
    top: ev.top,
    height: ev.height,
    elements: ev.elements,
  });
}

export function clearPlaybackVisuals(container: HTMLElement | null): void {
  if (!container) return;

  pendingCursorByContainer.delete(container);
  const id = rafByContainer.get(container);
  if (id != null) {
    cancelAnimationFrame(id);
    rafByContainer.delete(container);
  }

  const overlay = container.querySelector<HTMLElement>(`.${PLAYBACK_CURSOR_OVERLAY_CLASS}`);
  if (overlay) overlay.style.display = 'none';

  removeLegacySvgCursors(container);

  for (const svg of scoreSvgs(container)) {
    clearPlaybackHighlights(svg);
  }
}
