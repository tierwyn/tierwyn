import { randomUUID } from '../uuid';
import { useState } from 'react';
import type { RoleWhenPreset } from '@tierwyn/shared';
import { api } from '../api.js';

function truncate(s: string, max = 80): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

interface Props {
  presets: RoleWhenPreset[];
  onPresetsChanged: (presets: RoleWhenPreset[]) => void;
}

type Draft = { id: string | null; name: string; when: string };

export function RoleWhenPresetSettings({ presets, onPresetsChanged }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openNew() {
    setError(null);
    setDraft({ id: null, name: '', when: '' });
  }

  function openEdit(p: RoleWhenPreset) {
    setError(null);
    setDraft({ id: p.id, name: p.name, when: p.when });
  }

  function cancel() {
    setDraft(null);
    setError(null);
  }

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: RoleWhenPreset = {
        id: draft.id ?? randomUUID(),
        name,
        when: draft.when,
      };
      onPresetsChanged(await api.saveRolePreset(payload));
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteRolePreset(id);
      onPresetsChanged(await api.listRolePresets());
      if (draft?.id === id) setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSave = !!draft && !!draft.name.trim() && !busy;

  return (
    <div className="template-settings role-when-preset-settings template-settings--panel">
      <div className="template-settings-head">
        <div className="template-roles-header">
          <span className="modal-label">Used-when presets</span>
          <button type="button" className="modal-btn primary" onClick={openNew} disabled={busy || !!draft}>
            ＋ New preset
          </button>
        </div>
        <div className="modal-hint template-settings-head-hint">
          Editing a preset only affects future selections — templates already saved keep their text
          until you re-pick a preset and save.
        </div>
        {draft && (
          <div className="role-when-preset-editor">
            <div className="modal-field">
              <span className="modal-label">Name</span>
              <input
                className="modal-input"
                value={draft.name}
                onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                placeholder="e.g. Implementer"
                autoFocus
              />
            </div>
            <div className="modal-field">
              <span className="modal-label">Used when</span>
              <textarea
                className="modal-input"
                rows={3}
                value={draft.when}
                onChange={(e) => setDraft((d) => (d ? { ...d, when: e.target.value } : d))}
                placeholder="Prose that appears as the role's “use when” text"
              />
            </div>
            {error && (
              <div className="template-error" role="alert">
                {error}
              </div>
            )}
            <div className="template-row-actions" style={{ marginTop: 8 }}>
              <button type="button" className="modal-btn" onClick={cancel} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn primary"
                onClick={() => void save()}
                disabled={!canSave}
              >
                {busy ? 'Saving…' : draft.id ? 'Save preset' : 'Create preset'}
              </button>
            </div>
          </div>
        )}
        {error && !draft && (
          <div className="template-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="template-settings-body">
        {presets.length === 0 && !draft ? (
          <div className="template-list-empty">
            No presets yet. Create one to reuse &apos;used when&apos; text across template roles.
          </div>
        ) : (
          <div className="template-list">
            {presets.map((p) => (
              <div key={p.id} className="template-row">
                <div className="template-row-info">
                  <span className="template-row-name">{p.name}</span>
                  <span className="template-row-roles" title={p.when}>
                    {truncate(p.when) || '(empty)'}
                  </span>
                </div>
                <div className="template-row-actions">
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => openEdit(p)}
                    disabled={busy || !!draft}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="modal-btn danger"
                    onClick={() => void remove(p.id)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
