import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  resolvePromptVariables,
  type PromptCollectionEntry,
} from '@tierwyn/shared';
import {
  initialPromptVarValues,
  loadPromptVarMemory,
  promptVarFieldKind,
  promptVarsRosterBlocked,
  savePromptVarMemory,
} from '../promptVarMemory.js';
import { Modal } from './Modal.js';

interface Props {
  entry: PromptCollectionEntry;
  actionLabel: string;
  onSubmit: (values: Record<string, string>) => void;
  onRawInsert?: () => void;
  onClose: () => void;
  /** Spawn-template role names for `source: 'roster'` fields. Empty/absent ⇒ blocked with a warning. */
  roles?: string[];
}

export function PromptVariablesModal({
  entry,
  actionLabel,
  onSubmit,
  onRawInsert,
  onClose,
  roles,
}: Props) {
  const variables = useMemo(() => resolvePromptVariables(entry), [entry]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialPromptVarValues(variables, {
      roles,
      remembered: loadPromptVarMemory(entry.id),
    }),
  );

  const roster = roles && roles.length > 0 ? roles : undefined;
  const rosterBlocked = promptVarsRosterBlocked(variables, roles);

  function submit() {
    if (rosterBlocked) return;
    const trimmed: Record<string, string> = {};
    const toSave: Record<string, string> = {};
    for (const v of variables) {
      const val = (values[v.name] ?? '').trim();
      trimmed[v.name] = val;
      if (v.source === 'roster') {
        toSave[v.name] = val;
      }
    }
    savePromptVarMemory(entry.id, toSave);
    onSubmit(trimmed);
  }

  function onFormKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <Modal title={`Fill variables: ${entry.name}`} onClose={onClose} className="prompt-collection-modal">
      <div onKeyDown={onFormKeyDown}>
        {rosterBlocked && (
          <div className="prompt-variables-roster-missing" role="alert">
            This conversation has no spawn roster. Edit the conversation and attach a spawn template — role fields stay blocked until then. Typing a name cannot spawn.
          </div>
        )}
        <div className="prompt-variables-fields">
          {variables.map((v, i) => {
            const current = values[v.name] ?? '';
            const kind = promptVarFieldKind(v.source, roles);
            const useRoster = kind === 'select';
            // A value outside this roster is appended at the END and labelled,
            // never presented at position zero as the recommended row.
            const stale = useRoster && current !== '' && roster !== undefined && !roster.includes(current);
            const options = (kind === 'select' && roster)
              ? (stale ? [...roster, current] : roster)
              : [];
            return (
              <label key={v.name} className="prompt-variables-row prompt-variables-row--collect">
                <span className="prompt-variable-head">
                  <span className="modal-label">{v.label ?? v.name}</span>
                  <span className="prompt-variable-token">{`{{${v.name}}}`}</span>
                </span>
                {kind === 'blocked' ? (
                  <div className="prompt-variable-blocked">Needs a spawn roster</div>
                ) : useRoster ? (
                  <select
                    className="modal-input"
                    value={current}
                    onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
                    autoFocus={i === 0}
                    aria-label={v.label ?? v.name}
                  >
                    <option value="">None</option>
                    {options.map((role) => (
                      <option key={role} value={role}>
                        {stale && role === current ? `${role} (not in this roster)` : role}
                      </option>
                    ))}
                  </select>
                ) : (
                  <textarea
                    className="modal-input"
                    rows={2}
                    value={current}
                    onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
                    autoFocus={i === 0}
                  />
                )}
              </label>
            );
          })}
        </div>
        <div className="modal-footer" style={{ marginTop: 12 }}>
          <button type="button" className="modal-btn" onClick={onClose}>
            Cancel
          </button>
          {onRawInsert && (
            <button type="button" className="modal-btn" onClick={onRawInsert}>
              Insert raw template
            </button>
          )}
          <button
            type="button"
            className="modal-btn primary"
            onClick={submit}
            disabled={rosterBlocked}
            title={rosterBlocked ? 'Attach a spawn template on this conversation first' : undefined}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
