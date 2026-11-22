import { randomUUID } from '../uuid';
import type { SidecarPrompt } from '@tierwyn/shared';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

interface Props {
  builtins: SidecarPrompt[];
  prompts: SidecarPrompt[];
  selectedPromptId: string;
  label: string;
  onChange: (patch: { prompts?: SidecarPrompt[]; selectedPromptId?: string }) => void;
  collapsible?: boolean;
  disabled?: boolean;
}

export function SidecarPromptManager({
  builtins,
  prompts,
  selectedPromptId,
  label,
  onChange,
  collapsible,
  disabled,
}: Props) {
  const custom = prompts ?? [];
  const allForSelect = [...builtins, ...custom];
  const promptOptions: SelectDropdownOption[] = allForSelect.map((p) => ({
    value: p.id,
    label: p.name,
  }));
  const fallbackId = builtins[0]?.id ?? '';
  const effectiveSelectedId = selectedPromptId || fallbackId;

  const saveCustom = (next: SidecarPrompt[], nextSelectedId?: string) =>
    onChange(nextSelectedId ? { prompts: next, selectedPromptId: nextSelectedId } : { prompts: next });

  const addPrompt = () => {
    const p: SidecarPrompt = { id: randomUUID(), name: 'New prompt', text: '' };
    saveCustom([...custom, p], p.id);
  };
  const duplicatePrompt = (source: SidecarPrompt) => {
    const p: SidecarPrompt = {
      id: randomUUID(),
      name: `${source.name} (copy)`,
      text: source.text,
    };
    saveCustom([...custom, p], p.id);
  };
  const updatePrompt = (id: string, patch: Partial<SidecarPrompt>) =>
    saveCustom(custom.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const deletePrompt = (id: string) => {
    const next = custom.filter((p) => p.id !== id);
    saveCustom(next, selectedPromptId === id ? fallbackId : undefined);
  };

  const editSections = (
    <>
      <div className="modal-field" style={{ marginTop: 12 }}>
        <span className="modal-label">Builtin prompts (read-only)</span>
        {builtins.map((p) => {
          const isSelected = p.id === effectiveSelectedId;
          return (
            <details key={p.id} className="sidecar-prompt-builtin">
              <summary className="sidecar-prompt-builtin-summary">
                <span className="sidecar-prompt-builtin-title">{p.name}</span>
                <div className="sidecar-prompt-actions">
                  {isSelected ? (
                    <span className="voice-warning-chip ok" style={{ fontSize: 10, padding: '1px 6px' }}>Active</span>
                  ) : (
                    <button
                      type="button"
                      className="modal-btn"
                      style={{ fontSize: 11, padding: '1px 7px' }}
                      disabled={disabled}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onChange({ selectedPromptId: p.id });
                      }}
                    >
                      Use
                    </button>
                  )}
                  <button
                    type="button"
                    className="modal-btn"
                    style={{ fontSize: 11, padding: '1px 7px' }}
                    disabled={disabled}
                    title="Create an editable custom copy of this builtin prompt"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      duplicatePrompt(p);
                    }}
                  >
                    Duplicate
                  </button>
                </div>
              </summary>
              <div className="sidecar-prompt-builtin-text">{p.text}</div>
            </details>
          );
        })}
      </div>

      <div className="modal-field" style={{ marginTop: 12 }}>
        <span className="modal-label">Your custom prompts</span>
        {custom.length === 0 && <div className="sidecar-prompt-empty">No custom prompts yet.</div>}
        {custom.map((p) => {
          const isSelected = p.id === effectiveSelectedId;
          return (
            <div key={p.id} className={`sidecar-prompt-row${isSelected ? ' is-active' : ''}`}>
              <div className="sidecar-prompt-row-head">
                <input
                  className="modal-input"
                  value={p.name}
                  disabled={disabled}
                  onChange={(e) => updatePrompt(p.id, { name: e.target.value })}
                />
                <div className="sidecar-prompt-actions">
                  {isSelected ? (
                    <span className="voice-warning-chip ok" style={{ fontSize: 10, padding: '2px 6px' }}>Active</span>
                  ) : (
                    <button
                      type="button"
                      className="modal-btn"
                      disabled={disabled}
                      onClick={() => onChange({ selectedPromptId: p.id })}
                    >
                      Use
                    </button>
                  )}
                  <button
                    type="button"
                    className="modal-btn"
                    disabled={disabled}
                    title="Duplicate prompt"
                    onClick={() => duplicatePrompt(p)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => deletePrompt(p.id)}
                    aria-label={`Delete ${p.name}`}
                    disabled={disabled}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <textarea
                className="modal-input sidecar-prompt-textarea"
                rows={3}
                defaultValue={p.text}
                disabled={disabled}
                placeholder="Enter prompt instructions..."
                onBlur={(e) => updatePrompt(p.id, { text: e.target.value })}
              />
            </div>
          );
        })}
        <button type="button" className="modal-btn" style={{ marginTop: 8 }} onClick={addPrompt} disabled={disabled}>+ Add prompt</button>
      </div>
    </>
  );

  return (
    <div className="sidecar-prompt-manager">
      <div className="modal-field">
        <span className="modal-label">{label}</span>
        <SelectDropdown
          options={promptOptions}
          value={selectedPromptId}
          onChange={(val) => onChange({ selectedPromptId: val })}
          placement="bottom"
          searchable
          disabled={disabled}
        />
      </div>
      {collapsible ? (
        <details className="sidecar-prompt-details">
          <summary className="sidecar-prompt-summary">
            <span className="sidecar-prompt-summary-label">Edit prompts</span>
            {custom.length > 0 && (
              <span className="voice-warning-chip" style={{ fontSize: 10, padding: '1px 6px' }}>
                {custom.length} custom
              </span>
            )}
          </summary>
          <div className="sidecar-prompt-expanded">
            {editSections}
          </div>
        </details>
      ) : editSections}
    </div>
  );
}
