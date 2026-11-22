import type { ReactNode } from 'react';
import { Modal } from './Modal.js';

interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  /** Omit for alert-mode: single OK button, Esc/overlay dismisses via onConfirm. */
  onCancel?: () => void;
  /** Optional extra overlay class for modal stacking. */
  overlayClassName?: string;
}

/** Thin primitive composing Modal. Two-button confirm/cancel or one-button alert/info mode.
 *  ponytail: reusable confirm primitive — add onCancel for two-button, omit for alert/info. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  overlayClassName,
}: ConfirmDialogProps) {
  return (
    <Modal title={title} onClose={onCancel ?? onConfirm} overlayClassName={overlayClassName}>
      <div style={{ fontSize: '14px', color: 'var(--text-2)', lineHeight: 1.6 }}>
        {body}
      </div>
      <div className="modal-footer">
        {onCancel && (
          <button type="button" className="modal-btn" disabled={busy} onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
        )}
        <button
          type="button"
          className={`modal-btn ${danger ? 'danger' : 'primary'}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
