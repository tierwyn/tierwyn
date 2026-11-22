import { useEffect, useRef, useState } from 'react';

interface Props {
  open: boolean;
  onQueue: () => void;
  onForce: () => void;
  onCancel: () => void;
}

/** Running-turn send choice for deferred-steer + soft-cancel adapters.
 *  ArrowUp/ArrowDown selects option. Enter activates. Esc / backdrop → cancel.
 *  Enter is armed only after a short open delay so Ctrl/Cmd+Enter that opened
 *  the modal cannot immediately confirm the default Queue action. */
export function SteerChoiceModal({ open, onQueue, onForce, onCancel }: Props) {
  const [selected, setSelected] = useState<0 | 1>(0);
  const [enterArmed, setEnterArmed] = useState(false);
  const queueRef = useRef<HTMLButtonElement>(null);
  const forceRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setEnterArmed(false);
      return;
    }
    setSelected(0);
    setEnterArmed(false);
    queueRef.current?.focus();
    const t = window.setTimeout(() => setEnterArmed(true), 100);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (selected === 0) {
      queueRef.current?.focus();
    } else {
      forceRef.current?.focus();
    }
  }, [open, selected]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((prev) => (prev === 0 ? 1 : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!enterArmed) return;
        if (selected === 0) {
          onQueue();
        } else {
          onForce();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, selected, enterArmed, onQueue, onForce, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div
        className="modal-content steer-choice-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="steer-choice-title"
      >
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span id="steer-choice-title">Agent is busy — how should this message be delivered?</span>
          <button type="button" className="usage-close" onClick={onCancel} aria-label="Cancel" style={{ fontSize: '18px' }}>×</button>
        </div>
        <p className="handoff-choice-intro">
          Queue waits for the current turn to finish. Interrupt &amp; Send stops it now and delivers your message next.
        </p>
        <div className="steer-choice-actions">
          <button
            ref={queueRef}
            type="button"
            className={`modal-btn${selected === 0 ? ' primary selected' : ''} steer-choice-queue`}
            onClick={onQueue}
            onMouseEnter={() => setSelected(0)}
          >
            <span className="steer-choice-btn-title">Queue</span>
            <span className="steer-choice-btn-body">Wait for the current turn to finish, then send.</span>
          </button>
          <button
            ref={forceRef}
            type="button"
            className={`modal-btn${selected === 1 ? ' selected' : ''} steer-choice-force`}
            onClick={onForce}
            onMouseEnter={() => setSelected(1)}
          >
            <span className="steer-choice-btn-title">Interrupt &amp; Send</span>
            <span className="steer-choice-btn-body">Stop the current turn now and send immediately.</span>
          </button>
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
