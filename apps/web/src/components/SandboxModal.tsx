import type { SandboxSetting } from '@tierwyn/shared';
import type { SandboxControlState } from '../sandboxControl.js';
import { Modal } from './Modal.js';

export interface SandboxModalProps {
  state: SandboxControlState;
  value: SandboxSetting | null;
  onClose: () => void;
  onChange: (v: SandboxSetting | null) => void;
}

export function SandboxModal({
  state,
  value,
  onClose,
  onChange,
}: SandboxModalProps) {
  const options: Array<{
    val: SandboxSetting | null;
    title: string;
    description: string;
    disabled?: boolean;
    disabledReason?: string;
  }> = [
    {
      val: null,
      title: state.inheritLabel,
      description: 'Use the 4-tier chain: this chat → project → host/agent default → global.',
    },
    {
      val: 'on',
      title: 'Sandbox: On',
      description: 'Run agent CLIs inside a bubblewrap sandbox (isolated home tmpfs, only project directory and tool caches mounted).',
      disabled: state.onDisabledReason !== null,
      disabledReason: state.onDisabledReason ?? undefined,
    },
    {
      val: 'off',
      title: 'Sandbox: Off',
      description: 'Run agent CLIs directly on the host without a bubblewrap filesystem boundary.',
    },
  ];

  return (
    <Modal
      title="Agent Sandbox"
      onClose={onClose}
      className="sandbox-selector-modal"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>
          Currently: {state.label}
        </div>
        {state.locked && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid rgba(245, 158, 11, 0.25)',
              color: 'var(--amber, #f59e0b)',
              fontSize: 12,
              marginBottom: 4,
            }}
          >
            Sandbox is enforced by remote host policy and cannot be overridden for this session.
          </div>
        )}
        {state.warning && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid rgba(245, 158, 11, 0.25)',
              color: 'var(--amber, #f59e0b)',
              fontSize: 12,
              marginBottom: 4,
            }}
          >
            Host cannot sandbox — this turn ran (or will run) unsandboxed.
          </div>
        )}
        {options.map((opt) => {
          const isSelected = opt.val === value;
          const isDisabled = state.locked || opt.disabled;
          return (
            <button
              key={opt.val === null ? 'inherit' : opt.val}
              type="button"
              disabled={isDisabled}
              title={opt.disabledReason}
              onClick={() => {
                if (!isDisabled) {
                  onChange(opt.val);
                  onClose();
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                padding: '10px 12px',
                borderRadius: 6,
                border: isSelected ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: isSelected ? 'var(--surface-2)' : 'var(--surface-1)',
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                opacity: isDisabled ? 0.45 : 1,
                textAlign: 'left',
                width: '100%',
                color: 'var(--text-1)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
                  <span>{opt.title}</span>
                  {opt.val === 'on' && (
                    <span style={{
                      fontSize: 10,
                      padding: '1px 5px',
                      borderRadius: 4,
                      background: 'rgba(16, 185, 129, 0.15)',
                      color: 'var(--emerald, #10b981)',
                      fontWeight: 600,
                    }}>
                      ISOLATED
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.35 }}>
                  {opt.description}
                </div>
                {opt.disabledReason && (
                  <div style={{ fontSize: 11, color: 'var(--amber, #f59e0b)', marginTop: 4 }}>
                    {opt.disabledReason}
                  </div>
                )}
              </div>
              {isSelected && (
                <span style={{ color: 'var(--accent)', fontWeight: 'bold', marginLeft: 8 }}>
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
