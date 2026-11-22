import type { InteractionMode } from '@tierwyn/shared';
import { Modal } from './Modal.js';

export interface PermissionModeModalProps {
  value: InteractionMode | null;
  defaultMode: InteractionMode;
  permissionCapable: boolean;
  onClose: () => void;
  onChange: (mode: InteractionMode | null) => void;
}

export function PermissionModeModal({
  value,
  defaultMode,
  permissionCapable,
  onClose,
  onChange,
}: PermissionModeModalProps) {
  const options: Array<{
    id: 'default' | InteractionMode;
    val: InteractionMode | null;
    title: string;
    description: string;
    disabled?: boolean;
    disabledReason?: string;
  }> = [
    {
      id: 'default',
      val: null,
      title: `Default (inherit global: ${defaultMode})`,
      description: 'Use the global default interaction mode configured in Settings.',
    },
    {
      id: 'bypass',
      val: 'bypass',
      title: 'Bypass',
      description: 'Auto-approve all tool calls and commands without asking.',
    },
    {
      id: 'questions',
      val: 'questions',
      title: 'Questions only',
      description: 'Auto-approve tool calls, but surface plans and questions to the operator.',
    },
    {
      id: 'prompt',
      val: 'prompt',
      title: 'Prompt',
      description: 'Prompt operator for confirmation on tool executions and file changes.',
      disabled: !permissionCapable,
      disabledReason: !permissionCapable
        ? 'This agent cannot surface tool permission prompts — prompt mode is unavailable'
        : undefined,
    },
  ];

  return (
    <Modal
      title="Permission Mode"
      onClose={onClose}
      className="permission-mode-modal"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
        {options.map((opt) => {
          const isSelected = opt.val === value;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={opt.disabled}
              title={opt.disabledReason}
              onClick={() => {
                if (!opt.disabled) {
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
                cursor: opt.disabled ? 'not-allowed' : 'pointer',
                opacity: opt.disabled ? 0.45 : 1,
                textAlign: 'left',
                width: '100%',
                color: 'var(--text-1)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
                  {opt.title}
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
