import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  fileName: string;
  isTracked: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  container?: HTMLElement | null;
}

/** Confirm before undoing changes or deleting untracked file. Cancel is default-focus. */
export function DiscardConfirmModal({ fileName, isTracked, busy, onConfirm, onCancel, container }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);

  const target =
    container ??
    (typeof document !== 'undefined' ? (document.fullscreenElement as HTMLElement | null) : null) ??
    (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;

  return createPortal(
    <div
      className="modal-overlay"
      style={{ zIndex: 1300 }}
      onClick={busy ? undefined : onCancel}
      role="presentation"
    >
      <div
        className="modal-content"
        style={{ maxWidth: 440 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="discard-confirm-title"
      >
        <div className="modal-header" id="discard-confirm-title">
          {isTracked ? `Discard changes in ${fileName}?` : `Delete untracked ${fileName}?`}
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {isTracked ? (
            <p style={{ margin: 0 }}>
              This will revert <strong>{fileName}</strong> to its last committed state in git (HEAD). Any uncommitted modifications on disk will be lost.
            </p>
          ) : (
            <p style={{ margin: 0, color: 'var(--accent-danger, #ef4444)' }}>
              This file has not been committed to git. Discarding will <strong>permanently delete</strong> the file from disk.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} type="button" className="modal-btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn"
            disabled={busy}
            onClick={onConfirm}
            style={{ background: 'var(--accent-danger, #ef4444)', color: '#fff', borderColor: 'transparent' }}
          >
            {busy
              ? (isTracked ? 'Discarding…' : 'Deleting…')
              : (isTracked ? 'Discard changes' : 'Delete file')}
          </button>
        </div>
      </div>
    </div>,
    target,
  );
}
