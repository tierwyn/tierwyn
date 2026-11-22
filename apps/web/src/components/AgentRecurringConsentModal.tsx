import { useState, useRef, useEffect } from 'react';
import { Modal } from './Modal.js';

export interface AgentRecurringConsentModalProps {
  onAccept: () => void;
  onCancel: () => void;
}

export function AgentRecurringConsentModal({ onAccept, onCancel }: AgentRecurringConsentModalProps) {
  const [understood, setUnderstood] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <Modal
      title="Allow recurring agent schedules"
      onClose={onCancel}
      overlayClassName="modal-overlay--stack-3"
      className="agent-recurring-consent-modal"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '14px', lineHeight: 1.5, color: 'var(--text-1)' }}>
        <p style={{ margin: 0 }}>
          Agents in any conversation holding a schedule token will be able to create <strong>recurring</strong> jobs that start firing without your approval, repeatedly, until disabled. Bounded by the roster lock and 50-job caps. Safe mode (spawn approval) overrides this.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          <span>I understand the risks of unattended recurring agent schedules</span>
        </label>
      </div>

      <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
        <button
          ref={cancelRef}
          type="button"
          className="modal-btn"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="modal-btn danger"
          disabled={!understood}
          onClick={onAccept}
        >
          I accept the risk
        </button>
      </div>
    </Modal>
  );
}
