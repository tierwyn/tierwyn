import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  fileName: string;
  agentRunning?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  container?: HTMLElement | null;
}

/** Confirm before switching FileModal into edit mode. Cancel is default-focus. */
export function EditConfirmModal({ fileName, agentRunning, onConfirm, onCancel, container }: Props) {
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
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="modal-content"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="edit-confirm-title"
      >
        <div className="modal-header" id="edit-confirm-title">Edit {fileName}?</div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0 }}>Saving overwrites the file on disk.</p>
          {agentRunning && (
            <p className="voice-warning-chip" style={{ margin: 0, fontSize: 12 }} role="status">
              An agent is currently running in this conversation and may overwrite your changes.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} type="button" className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="modal-btn primary" onClick={onConfirm}>
            Edit file
          </button>
        </div>
      </div>
    </div>,
    target,
  );
}
