import { createPortal } from 'react-dom';

export type SpeakScope = 'this' | 'to-end';

interface Props {
  onChoose: (scope: SpeakScope) => void;
  onClose: () => void;
  container?: HTMLElement | null;
}

/** Step 1 of message TTS: this message vs from here to end. Cancel leaves speech running. */
export function SpeakScopeModal({ onChoose, onClose, container }: Props) {
  const target =
    container ??
    (typeof document !== 'undefined' ? (document.fullscreenElement as HTMLElement | null) : null) ??
    (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;

  // Match SpeakChoiceModal: portal to body (or fullscreen element) so nested overflow:hidden parents cannot trap the overlay.
  // Must stack above host Modals (modal-overlay--top z-index: 1200).
  return createPortal(
    <div
      className="modal-overlay"
      style={{ zIndex: 1300 }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal-content"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="speak-scope-title"
      >
        <div className="modal-header" id="speak-scope-title">Read aloud</div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => onChoose('this')}
            style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px' }}
          >
            <span style={{ fontWeight: 600 }}>This message</span>
            <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
              Current message only
            </span>
          </button>
          <button
            type="button"
            className="modal-btn"
            onClick={() => onChoose('to-end')}
            style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px' }}
          >
            <span style={{ fontWeight: 600 }}>From here to end</span>
            <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
              This card and all following user prompts, agent messages, and subagent results (no tools)
            </span>
          </button>
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    target,
  );
}
