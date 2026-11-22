import { useState } from 'react';
import { MAX_CUSTOM_DESIGNATIONS, MAX_DESIGNATION_LENGTH, parseDesignationToken } from '@tierwyn/shared';
import { api, type DesignationCatalogue } from '../api.js';

interface Props {
  catalogue: DesignationCatalogue;
  onCatalogueChanged: (next: DesignationCatalogue) => void;
}

export function DesignationSettings({ catalogue, onCatalogueChanged }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const atCap = catalogue.custom.length >= MAX_CUSTOM_DESIGNATIONS;
  const parsed = parseDesignationToken(draft);
  const canAdd = !busy && !atCap && parsed.ok;

  async function add() {
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCatalogueChanged(await api.addDesignation(parsed.token));
      setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(token: string) {
    setBusy(true);
    setError(null);
    try {
      onCatalogueChanged(await api.deleteDesignation(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="template-settings role-when-preset-settings template-settings--panel">
      <div className="template-settings-head">
        <div className="template-roles-header">
          <span className="modal-label">Conversation designations</span>
        </div>
        <div className="modal-hint template-settings-head-hint">
          One optional chip per conversation. Built-ins stay; customs are pickable everywhere
          once added here ({catalogue.custom.length}/{MAX_CUSTOM_DESIGNATIONS}).
          Each label is one word or a hyphenated-word.
        </div>
        <div className="template-role-row" style={{ marginTop: 8 }}>
          <input
            className="modal-input"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            maxLength={MAX_DESIGNATION_LENGTH}
            placeholder={atCap ? 'Custom limit reached' : 'e.g. auditor'}
            disabled={busy || atCap}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              }
            }}
          />
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => void add()}
            disabled={!canAdd}
          >
            Add
          </button>
        </div>
        {error && (
          <div className="template-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="template-settings-body">
        <div className="template-list">
          {catalogue.builtins.map((token) => (
            <div key={token} className="template-row">
              <div className="template-row-info">
                <span className="template-row-name">{token}</span>
                <span className="template-row-roles">built-in</span>
              </div>
            </div>
          ))}
          {catalogue.custom.map((token) => (
            <div key={token} className="template-row">
              <div className="template-row-info">
                <span className="template-row-name">{token}</span>
                <span className="template-row-roles">custom</span>
              </div>
              <div className="template-row-actions">
                <button
                  type="button"
                  className="modal-btn danger"
                  onClick={() => void remove(token)}
                  disabled={busy}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
