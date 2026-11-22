import { useState, useMemo, useEffect } from 'react';
import type { PromptOptionDescriptor, PromptOptions } from '@tierwyn/shared';
import { promptOptionsFootnote } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { SelectDropdown } from './SelectDropdown.js';
import { JsonSchemaField } from './JsonSchemaField.js';

export interface PromptOptionsModalProps {
  agentLabel: string;
  agentType?: string;
  descriptors: readonly PromptOptionDescriptor[];
  stagedOptions: PromptOptions;
  stagedSticky?: boolean;
  composerText?: string;
  onClose: () => void;
  onApply: (options: PromptOptions, sticky: boolean) => void;
}

export function PromptOptionsModal({
  agentLabel,
  agentType,
  descriptors,
  stagedOptions,
  stagedSticky = false,
  composerText = '',
  onClose,
  onApply,
}: PromptOptionsModalProps) {
  const [draft, setDraft] = useState<PromptOptions>(() => ({ ...stagedOptions }));
  const [sticky, setSticky] = useState(stagedSticky);

  // Keep local draft aligned if stagedOptions change externally
  useEffect(() => {
    setDraft({ ...stagedOptions });
  }, [stagedOptions]);

  useEffect(() => {
    setSticky(stagedSticky);
  }, [stagedSticky]);

  const isSlashCommandComposer = composerText.trim().startsWith('/');

  // Validation check for jsonSchema
  const isSchemaValid = useMemo(() => {
    const rawSchema = draft['jsonSchema'];
    if (typeof rawSchema !== 'string') return true;
    const trimmed = rawSchema.trim();
    if (!trimmed) return true;
    if (trimmed.startsWith('-')) return false;
    try {
      const parsed = JSON.parse(rawSchema);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, [draft]);

  const isApplyDisabled = !isSchemaValid;

  const handleClearAll = () => {
    setDraft({});
    setSticky(false);
  };

  const handleApply = () => {
    if (isApplyDisabled) return;
    onApply(draft, sticky);
    onClose();
  };

  const footnote = promptOptionsFootnote(agentType);

  return (
    <Modal
      title={`${agentLabel} Prompt Options`}
      onClose={onClose}
      className="prompt-options-modal"
      footer={
        <div className="modal-footer prompt-options-footer">
          <button
            type="button"
            className="modal-btn"
            onClick={handleClearAll}
            title="Reset options to defaults"
          >
            Clear All
          </button>
          <div className="prompt-options-footer-right">
            <button type="button" className="modal-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="modal-btn primary"
              disabled={isApplyDisabled}
              onClick={handleApply}
            >
              Apply
            </button>
          </div>
        </div>
      }
    >
      <div className="prompt-options-scope-row" role="radiogroup" aria-label="Option persistence">
        <button
          type="button"
          role="radio"
          aria-checked={!sticky}
          className={`prompt-options-header-pill${!sticky ? ' is-active' : ''}`}
          onClick={() => setSticky(false)}
        >
          ⚡ Next message only
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={sticky}
          className={`prompt-options-header-pill${sticky ? ' is-active' : ''}`}
          onClick={() => setSticky(true)}
        >
          📌 Sticky for this agent here
        </button>
      </div>

      <div className="prompt-options-modal-intro">
        {sticky
          ? <>These options stay armed for <strong>{agentLabel}</strong> in this conversation — every message you send reuses them until you switch back to “Next message only” or clear them.</>
          : 'Configure CLI flags for the upcoming prompt. These options apply strictly to the next submission, then reset automatically.'}
      </div>

      <div className="prompt-options-sections">
        {descriptors.map((desc) => {
          // Rule §6 #10: disableSlashCommands hides itself when composer text starts with '/'
          if (desc.key === 'disableSlashCommands' && isSlashCommandComposer) {
            return null;
          }

          if (desc.kind === 'select') {
            const currentValue = (draft[desc.key] as string) ?? desc.choices[0]?.value ?? 'default';
            const dropdownOptions = desc.choices.map((c) => ({
              value: c.value,
              label: c.label,
              description: c.description,
            }));

            const isPlanWithNoSlash =
              desc.key === 'mode' &&
              currentValue === 'plan' &&
              draft['disableSlashCommands'] === true;

            return (
              <div key={desc.key} className="prompt-option-group">
                <div className="prompt-option-header">
                  <div className="prompt-option-label">{desc.label}</div>
                  {desc.description && (
                    <div className="prompt-option-desc">{desc.description}</div>
                  )}
                </div>

                {desc.caveat && (
                  <div className="prompt-option-caveat">
                    <span className="caveat-icon" aria-hidden="true">⚠</span>
                    <span>{desc.caveat}</span>
                  </div>
                )}

                {isPlanWithNoSlash && (
                  <div className="prompt-option-warning">
                    <span className="warning-icon" aria-hidden="true">⚠</span>
                    <span>
                      Notice: <code>--mode plan</code> has no effect when slash commands are disabled.
                    </span>
                  </div>
                )}

                <div className="prompt-option-control">
                  <SelectDropdown
                    options={dropdownOptions}
                    value={currentValue}
                    onChange={(val) => setDraft((prev) => ({ ...prev, [desc.key]: val }))}
                  />
                </div>
              </div>
            );
          }

          if (desc.kind === 'toggle') {
            const isChecked = Boolean(draft[desc.key]);

            return (
              <div key={desc.key} className="prompt-option-group prompt-option-group--toggle">
                <div className="prompt-option-toggle-left">
                  <div className="prompt-option-label">{desc.label}</div>
                  {desc.description && (
                    <div className="prompt-option-desc">{desc.description}</div>
                  )}
                  {desc.caveat && (
                    <div className="prompt-option-caveat">
                      <span className="caveat-icon" aria-hidden="true">⚠</span>
                      <span>{desc.caveat}</span>
                    </div>
                  )}
                </div>

                <div className="prompt-option-toggle-right">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isChecked}
                    className={`toggle-switch${isChecked ? ' on' : ''}`}
                    onClick={() => setDraft((prev) => ({ ...prev, [desc.key]: !isChecked }))}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
              </div>
            );
          }

          if (desc.kind === 'text') {
            const textVal = (draft[desc.key] as string) ?? '';

            return (
              <div key={desc.key} className="prompt-option-group">
                <div className="prompt-option-header">
                  <div className="prompt-option-label">{desc.label}</div>
                  {desc.description && (
                    <div className="prompt-option-desc">{desc.description}</div>
                  )}
                </div>

                {desc.caveat && (
                  <div className="prompt-option-caveat">
                    <span className="caveat-icon" aria-hidden="true">⚠</span>
                    <span>{desc.caveat}</span>
                  </div>
                )}

                {desc.validate === 'json' ? (
                  <JsonSchemaField
                    value={textVal}
                    onChange={(val) => setDraft((prev) => ({ ...prev, [desc.key]: val }))}
                    placeholder={desc.placeholder}
                    maxLength={desc.maxLength}
                  />
                ) : (
                  <input
                    type="text"
                    className="modal-input"
                    value={textVal}
                    placeholder={desc.placeholder}
                    maxLength={desc.maxLength}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [desc.key]: e.target.value }))}
                  />
                )}
              </div>
            );
          }

          return null;
        })}
      </div>

      {!sticky && (
        <div className="prompt-options-footnote">
          ⚡ {footnote}
        </div>
      )}
      {sticky && !/reset automatically/i.test(footnote) && (
        <div className="prompt-options-footnote">
          📌 {footnote}
        </div>
      )}
    </Modal>
  );
}
