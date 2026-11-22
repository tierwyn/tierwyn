import { useEffect, useRef, useState } from 'react';
import { MAX_CUSTOM_CATALOGUE_TAGS, MAX_TAG_HINT_LENGTH, MAX_TAG_LENGTH, type TagCatalogueSettings } from '@tierwyn/shared';
import { api, type TagCatalogueResponse } from '../api.js';
import { SelectDropdown } from './SelectDropdown.js';

export function enabledBuiltins(
  builtins: readonly { tag: string }[],
  disabled: readonly string[],
): string[] {
  const off = new Set(disabled);
  return builtins.filter((b) => !off.has(b.tag)).map((b) => b.tag);
}

export function disabledFromEnabled(
  builtins: readonly { tag: string }[],
  enabled: readonly string[],
): string[] {
  const on = new Set(enabled);
  return builtins.filter((b) => !on.has(b.tag)).map((b) => b.tag);
}

/** Jev auto-tag catalogue: enable/disable built-ins, add/delete customs. Each change posts the whole document. */
export function TagCatalogueSettingsPanel() {
  const [data, setData] = useState<TagCatalogueResponse | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [hintDraft, setHintDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ponytail: latest-wins seq, a per-request queue if ordering ever matters
  const saveSeq = useRef(0);

  useEffect(() => {
    api.getTagCatalogue().then(setData).catch(() => { /* offline */ });
  }, []);

  if (!data) return null;
  const { builtins, catalogue } = data;
  const atCap = catalogue.custom.length >= MAX_CUSTOM_CATALOGUE_TAGS;

  const save = async (next: TagCatalogueSettings): Promise<boolean> => {
    const seq = ++saveSeq.current;
    setBusy(true);
    setError(null);
    setData((d) => d && { ...d, catalogue: next });
    try {
      const updated = await api.updateTagCatalogue(next);
      if (seq === saveSeq.current) setData(updated);
      return true;
    } catch (e) {
      if (seq === saveSeq.current) {
        setError(e instanceof Error ? e.message : String(e));
        api.getTagCatalogue().then((d) => { if (seq === saveSeq.current) setData(d); }).catch(() => { /* offline */ });
      }
      return false;
    } finally {
      if (seq === saveSeq.current) setBusy(false);
    }
  };

  const add = async () => {
    const ok = await save({ ...catalogue, custom: [...catalogue.custom, { tag: tagDraft, hint: hintDraft }] });
    if (ok) { setTagDraft(''); setHintDraft(''); }
  };

  return (
    <div className="modal-field">
      <span className="modal-label">Tag catalogue</span>
      <div className="modal-hint">
        Jev may only apply tags from this list. The hint tells it when a tag fits
        ({catalogue.custom.length}/{MAX_CUSTOM_CATALOGUE_TAGS} custom).
      </div>
      <div className="modal-hint">Built-in tags (search by tag or hint)</div>
      <SelectDropdown
        multiple
        searchable
        options={builtins.map((b) => ({ value: b.tag, label: b.tag, description: b.hint }))}
        value={enabledBuiltins(builtins, catalogue.disabledBuiltins)}
        onChange={(enabled) => { void save({ ...catalogue, disabledBuiltins: disabledFromEnabled(builtins, enabled) }); }}
        placeholder="No built-in tags enabled"
      />
      {catalogue.custom.length > 0 && (
        <div className="template-list">
          {catalogue.custom.map((c) => (
            <div key={c.tag} className="template-row">
              <div className="template-row-info">
                <span className="template-row-name">{c.tag}</span>
                <span className="template-row-roles">{c.hint}</span>
              </div>
              <div className="template-row-actions">
                <button
                  type="button"
                  className="modal-btn danger"
                  disabled={busy}
                  onClick={() => { void save({ ...catalogue, custom: catalogue.custom.filter((x) => x.tag !== c.tag) }); }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="template-role-row" style={{ marginTop: 8 }}>
        <input
          className="modal-input"
          value={tagDraft}
          maxLength={MAX_TAG_LENGTH}
          placeholder={atCap ? 'Custom limit reached' : 'Tag'}
          disabled={busy || atCap}
          onChange={(e) => { setTagDraft(e.target.value); setError(null); }}
        />
        <input
          className="modal-input"
          value={hintDraft}
          maxLength={MAX_TAG_HINT_LENGTH}
          placeholder="When does it apply?"
          disabled={busy || atCap}
          onChange={(e) => { setHintDraft(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
        />
        <button
          type="button"
          className="modal-btn primary"
          disabled={busy || atCap || !tagDraft.trim() || !hintDraft.trim()}
          onClick={() => { void add(); }}
        >
          Add
        </button>
      </div>
      {error && <div className="template-error" role="alert">{error}</div>}
    </div>
  );
}
