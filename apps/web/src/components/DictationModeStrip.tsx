import { useRef, useState } from 'react';
import type { DictationMode } from '../voiceSettings.js';

interface Props {
  /** Called once when the thumb is deliberately dragged and snapped to a side.
   *  Parent persists the mode and auto-starts dictation. */
  onCommit: (m: DictationMode) => void;
}

/** Chunky Fast/Slow drag slider living in the voice-feedback strip. The thumb
 *  rests centre; a deliberate drag past ~65% toward either end snaps and
 *  commits. Releasing mid-track springs back without starting — no tap-to-flick.
 *  ponytail: pointer capture + one position fraction — no gesture library. */
export function DictationModeStrip({ onCommit }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0.5); // 0 = fast (left), 1 = slow (right)
  const [dragging, setDragging] = useState(false);
  const [committed, setCommitted] = useState(false);

  const posFromEvent = (e: React.PointerEvent): number => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0.5;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const commit = (m: DictationMode) => {
    setPos(m === 'fast' ? 0 : 1);
    setCommitted(true);
    onCommit(m);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (committed) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || committed) return;
    setPos(posFromEvent(e));
  };
  const onPointerUp = () => {
    if (!dragging || committed) return;
    setDragging(false);
    if (pos <= 0.35) commit('fast');
    else if (pos >= 0.65) commit('slow');
    else setPos(0.5); // not deliberate enough — spring back, no start
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (committed) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); commit('fast'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); commit('slow'); }
  };

  return (
    <div className={`dictation-strip${committed ? ' committing' : ''}`}>
      <div className="dictation-strip-track" ref={trackRef}>
        <span className={`dictation-strip-label left${pos <= 0.35 ? ' active' : ''}`}>
          ⚡ Fast
          <small>whisper only</small>
        </span>
        <span className={`dictation-strip-label right${pos >= 0.65 ? ' active' : ''}`}>
          ✨ Slow
          <small>whisper + LLM cleanup</small>
        </span>
        <div
          className={`dictation-strip-thumb${dragging ? ' dragging' : ''}`}
          style={{ left: `clamp(30px, ${pos * 100}%, calc(100% - 30px))` }}
          role="slider"
          tabIndex={0}
          aria-label="Dictation mode: drag left for fast, right for slow"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={pos < 0.5 ? 0 : 1}
          aria-valuetext={pos <= 0.35 ? 'fast' : pos >= 0.65 ? 'slow' : 'centre'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <span className="dictation-strip-grip" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
