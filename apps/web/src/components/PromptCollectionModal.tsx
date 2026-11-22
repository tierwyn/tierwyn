import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EnhanceMode, PromptCollectionEntry, PromptPack, PromptVariable } from '@tierwyn/shared';
import {
  PRESET_PROMPTS,
  PROMPT_NAME_MAX,
  PROMPT_DESCRIPTION_MAX,
  PROMPT_VAR_LABEL_MAX,
  PROMPT_VAR_DEFAULT_MAX,
  parsePromptVariables,
  resolvePromptVariables,
  substitutePromptVariables,
  validatePromptPack,
} from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { PromptPreviewModal } from './PromptPreviewModal.js';
import { PromptEnhanceModal } from './PromptEnhanceModal.js';
import { PromptVariablesModal } from './PromptVariablesModal.js';
import { promptVarsForSubstitute } from '../promptVarMemory.js';
import { filterPrompts, type OriginFilter, type SearchMode } from '../promptSearch.js';
import { downloadPromptPack, promptFilename } from '../promptPackFile.js';
import { api } from '../api.js';

interface Props {
  onInsert: (body: string) => void;
  onEnhance: (body: string, mode: EnhanceMode, instruction?: string) => void;
  enhanceAvailable: boolean;
  contextAvailable: boolean;
  projectAvailable: boolean;
  onClose: () => void;
  /** Spawn-template role names for `source: 'roster'` fill fields. */
  roles?: string[];
  onOpenFile?: (path: string) => void;
}

type EditingState = PromptCollectionEntry | 'new' | null;
type VarMeta = Record<string, { label: string; default: string; source?: 'roster' }>;
type FillAction = { entry: PromptCollectionEntry; action: 'insert' | 'enhance' };

interface PromptDraft {
  name: string;
  description: string;
  body: string;
  variables: VarMeta;
}

function emptyDraft(): PromptDraft {
  return { name: '', description: '', body: '', variables: {} };
}

function metaFromEntry(entry: PromptCollectionEntry): VarMeta {
  const variables: VarMeta = {};
  for (const v of entry.variables ?? []) {
    variables[v.name] = {
      label: v.label ?? '',
      default: v.default ?? '',
      ...(v.source === 'roster' ? { source: 'roster' as const } : {}),
    };
  }
  return variables;
}

function projectVariables(body: string, meta: VarMeta): PromptVariable[] | undefined {
  const out: PromptVariable[] = [];
  for (const name of parsePromptVariables(body)) {
    const row = Object.hasOwn(meta, name) ? meta[name] : undefined;
    const label = row?.label.trim() ?? '';
    const def = row?.default ?? '';
    const fromRoster = row?.source === 'roster';
    if (!label && !def && !fromRoster) continue;
    const v: PromptVariable = { name };
    if (label) v.label = label;
    if (def) v.default = def;
    if (fromRoster) v.source = 'roster';
    out.push(v);
  }
  return out.length > 0 ? out : undefined;
}

export function PromptCollectionModal({
  onInsert,
  onEnhance,
  enhanceAvailable,
  contextAvailable,
  projectAvailable,
  onClose,
  roles,
  onOpenFile,
}: Props) {
  const [custom, setCustom] = useState<PromptCollectionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PromptCollectionEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('words');
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const [preview, setPreview] = useState<PromptCollectionEntry | null>(null);
  const [enhanceFor, setEnhanceFor] = useState<PromptCollectionEntry | null>(null);
  const [enhanceBody, setEnhanceBody] = useState<string | null>(null);
  const [fillFor, setFillFor] = useState<FillAction | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<PromptPack | null>(null);
  const [importRaw, setImportRaw] = useState<unknown>(null);
  const [importOverwrite, setImportOverwrite] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const refreshCustom = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setCustom(await api.listCustomPrompts());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCustom();
  }, [refreshCustom]);

  const [hidePresets, setHidePresets] = useState(false);
  useEffect(() => {
    api.getGeneral()
      .then((s) => setHidePresets(!!s.hidePresetPrompts))
      .catch(() => { /* non-critical: presets stay listed */ });
  }, []);

  const all = useMemo(() => (hidePresets ? custom : [...PRESET_PROMPTS, ...custom]), [custom, hidePresets]);

  const { visible, regexInvalid } = useMemo(
    () => filterPrompts(all, query, searchMode, originFilter),
    [all, query, searchMode, originFilter],
  );

  const canSave =
    draft.name.trim() !== '' &&
    draft.description.trim() !== '' &&
    draft.body.trim() !== '' &&
    !busy;

  function openNew() {
    setEditing('new');
    setDraft(emptyDraft());
    setFormError(null);
  }

  function openEdit(entry: PromptCollectionEntry) {
    setEditing(entry);
    setDraft({
      name: entry.name,
      description: entry.description,
      body: entry.body,
      variables: metaFromEntry(entry),
    });
    setFormError(null);
  }

  function closeForm() {
    setEditing(null);
    setDraft(emptyDraft());
    setFormError(null);
  }

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setFormError(null);
    try {
      const variables = projectVariables(draft.body, draft.variables);
      const payload: PromptCollectionEntry = {
        id: editing !== null && editing !== 'new' ? editing.id : '',
        name: draft.name.trim(),
        description: draft.description.trim(),
        body: draft.body.trim(),
        origin: 'custom',
        ...(variables ? { variables } : {}),
        ...(editing !== null && editing !== 'new'
          ? { createdAt: editing.createdAt }
          : {}),
      };
      const next = await api.saveCustomPrompt(payload);
      setCustom(next);
      closeForm();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.deleteCustomPrompt(confirmDelete.id);
      setCustom(await api.listCustomPrompts());
      setConfirmDelete(null);
      if (editing !== null && editing !== 'new' && editing.id === confirmDelete.id) {
        closeForm();
      }
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleInsert(entry: PromptCollectionEntry) {
    if (resolvePromptVariables(entry).length === 0) {
      onInsert(entry.body);
      onClose();
      return;
    }
    setFillFor({ entry, action: 'insert' });
  }

  function handleEnhanceClick(entry: PromptCollectionEntry) {
    if (!enhanceAvailable) return;
    if (resolvePromptVariables(entry).length === 0) {
      setEnhanceBody(null);
      setEnhanceFor(entry);
      return;
    }
    setFillFor({ entry, action: 'enhance' });
  }

  function handleFillSubmit(values: Record<string, string>) {
    if (!fillFor) return;
    const substituted = substitutePromptVariables(
      fillFor.entry.body,
      promptVarsForSubstitute(values, resolvePromptVariables(fillFor.entry)),
    );
    if (fillFor.action === 'insert') {
      onInsert(substituted);
      onClose();
      return;
    }
    setEnhanceBody(substituted);
    setEnhanceFor(fillFor.entry);
    setFillFor(null);
  }

  function handleRawInsert() {
    if (!fillFor) return;
    onInsert(fillFor.entry.body);
    onClose();
  }

  function resetImport() {
    setImportOpen(false);
    setImportText('');
    setImportError(null);
    setImportPreview(null);
    setImportRaw(null);
    setImportOverwrite(false);
    setImportBusy(false);
    setImportFileName('');
    if (importFileRef.current) importFileRef.current.value = '';
  }

  function reviewImportText(text: string) {
    setImportText(text);
    setImportOverwrite(false);
    if (!text.trim()) {
      setImportPreview(null);
      setImportRaw(null);
      setImportError(null);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      setImportPreview(null);
      setImportRaw(null);
      setImportError('Not valid JSON');
      return;
    }
    const result = validatePromptPack(raw);
    if (!result.ok) {
      setImportPreview(null);
      setImportRaw(null);
      setImportError(result.error);
      return;
    }
    setImportRaw(raw);
    setImportPreview(result.pack);
    setImportError(null);
  }

  async function confirmImport() {
    if (importRaw === null || importRaw === undefined) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const out = await api.importPrompts(importRaw, importOverwrite);
      setCustom(out.prompts);
      setImportNotice(`Imported ${out.imported.length}, skipped ${out.skipped.length}.`);
      resetImport();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  }

  const importConflicts = useMemo(() => {
    if (!importPreview) return [];
    const existing = new Set(custom.map((c) => c.id));
    return importPreview.prompts.filter((p) => existing.has(p.id));
  }, [importPreview, custom]);

  /** While the delete confirm, preview, enhance picker, variables form, or the
   *  editor owns the keyboard/overlay, Esc/backdrop backs out of that layer
   *  only — not the whole modal. */
  function handleOuterClose() {
    if (confirmDelete || preview || enhanceFor || fillFor || importOpen) return;
    if (editing !== null) { closeForm(); return; }
    onClose();
  }

  return (
    <>
      <Modal title="Prompt Collection" onClose={handleOuterClose} className="prompt-collection-modal">
        {loading && <div className="summary-list-empty">Loading custom prompts…</div>}
        {!loading && loadError && (
          <div className="summary-list-empty" style={{ color: 'var(--red)' }}>
            Couldn&apos;t load custom prompts: {loadError}
          </div>
        )}

        <div className="prompt-collection-header-sticky">
          <div className="prompt-collection-search-wrap">
            <input
              type="text"
              className="modal-input prompt-collection-search"
              placeholder={searchMode === 'regex' ? 'Search… (regex)' : 'Search… (multi-word)'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              aria-label="Search prompts"
              autoFocus
            />
            <div className="prompt-collection-search-badges" role="radiogroup" aria-label="Search mode">
              <button
                type="button"
                className={`prompt-search-badge ${searchMode === 'words' ? 'active' : ''}`}
                onClick={() => setSearchMode('words')}
                title="Multi-word search (all terms must match)"
              >
                Words
              </button>
              <button
                type="button"
                className={`prompt-search-badge ${searchMode === 'regex' ? 'active' : ''}`}
                onClick={() => setSearchMode('regex')}
                title="Regular expression search"
              >
                .* Regex
              </button>
            </div>
          </div>
          {regexInvalid && (
            <div className="prompt-collection-search-hint">invalid regex — showing all</div>
          )}
          <div className="prompt-collection-filter-chips">
            <button
              type="button"
              className={`prompt-filter-chip ${originFilter === 'all' ? 'active' : ''}`}
              onClick={() => setOriginFilter('all')}
            >
              All ({all.length})
            </button>
            {!hidePresets && (
              <button
                type="button"
                className={`prompt-filter-chip ${originFilter === 'preset' ? 'active' : ''}`}
                onClick={() => setOriginFilter('preset')}
              >
                Presets ({PRESET_PROMPTS.length})
              </button>
            )}
            <button
              type="button"
              className={`prompt-filter-chip ${originFilter === 'custom' ? 'active' : ''}`}
              onClick={() => setOriginFilter('custom')}
            >
              Custom ({custom.length})
            </button>
          </div>
          <div className="prompt-collection-header-actions">
            <button
              type="button"
              className="modal-btn"
              onClick={() => { setImportNotice(null); setImportOpen(true); }}
            >
              Import
            </button>
            <button
              type="button"
              className="modal-btn"
              disabled={custom.length === 0}
              onClick={() => downloadPromptPack(custom, 'tierwyn-prompts.json')}
            >
              Export all
            </button>
          </div>
          {importNotice && <div className="prompt-import-status">{importNotice}</div>}
        </div>

        <ul className="summary-list">
          {visible.map((entry) => (
            <li key={entry.id}>
              <div className="prompt-collection-row">
                <div className="prompt-collection-row-main">
                  <div className="summary-list-row-head">
                    <span className="summary-list-route">{entry.name}</span>
                  </div>
                  <div className="summary-list-preview">{entry.description}</div>
                </div>
                <div className="prompt-collection-row-actions">
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => setPreview(entry)}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => downloadPromptPack([entry], promptFilename(entry))}
                  >
                    Export
                  </button>
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => handleInsert(entry)}
                  >
                    Insert
                  </button>
                  <button
                    type="button"
                    className="modal-btn"
                    disabled={!enhanceAvailable}
                    title={enhanceAvailable ? undefined : 'Configure Settings → Enhance (provider + model) first'}
                    onClick={() => handleEnhanceClick(entry)}
                  >
                    Enhance &amp; Insert
                  </button>
                  {entry.origin === 'custom' && (
                    <>
                      <button
                        type="button"
                        className="modal-btn"
                        onClick={() => openEdit(entry)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="modal-btn danger"
                        onClick={() => setConfirmDelete(entry)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {!loading && !loadError && originFilter === 'custom' && custom.length === 0 && !query && (
          <div className="summary-list-empty">No custom prompts yet — use New prompt to add one.</div>
        )}

        {!loading && !loadError && (query ? (!regexInvalid && visible.length === 0) : visible.length === 0) && (
          <div className="summary-list-empty">No prompts match your search or filter.</div>
        )}

        {editing === null ? (
          <div className="modal-footer" style={{ marginTop: 12 }}>
            <button type="button" className="modal-btn primary" onClick={openNew} disabled={busy}>
              New prompt
            </button>
          </div>
        ) : (
          <div className="prompt-collection-form">
            <label className="modal-field">
              <span className="modal-label">Name</span>
              <input
                type="text"
                className="modal-input"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                maxLength={PROMPT_NAME_MAX}
              />
            </label>
            <label className="modal-field">
              <span className="modal-label">Description</span>
              <input
                type="text"
                className="modal-input"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                maxLength={PROMPT_DESCRIPTION_MAX}
              />
            </label>
            <label className="modal-field">
              <span className="modal-label">Body</span>
              <textarea
                className="modal-input prompt-collection-textarea"
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              />
            </label>
            {parsePromptVariables(draft.body).length > 0 && (
              <div className="prompt-variables-editor">
                <span className="modal-label">Variables</span>
                {parsePromptVariables(draft.body).map((name) => {
                  const row = Object.hasOwn(draft.variables, name)
                    ? draft.variables[name]
                    : { label: '', default: '' };
                  const patchRow = (patch: Partial<VarMeta[string]>) =>
                    setDraft((d) => {
                      const prev = Object.hasOwn(d.variables, name)
                        ? d.variables[name]
                        : { label: '', default: '' };
                      return {
                        ...d,
                        variables: { ...d.variables, [name]: { ...prev, ...patch } },
                      };
                    });
                  return (
                    <div key={name} className="prompt-variables-row">
                      <span className="prompt-variable-token">{`{{${name}}}`}</span>
                      <input
                        type="text"
                        className="modal-input"
                        placeholder="Label"
                        value={row.label}
                        maxLength={PROMPT_VAR_LABEL_MAX}
                        onChange={(e) => patchRow({ label: e.target.value })}
                        aria-label={`Label for ${name}`}
                      />
                      <input
                        type="text"
                        className="modal-input"
                        placeholder="Default"
                        value={row.default}
                        maxLength={PROMPT_VAR_DEFAULT_MAX}
                        onChange={(e) => patchRow({ default: e.target.value })}
                        aria-label={`Default for ${name}`}
                      />
                      <label className="prompt-variable-roster">
                        <input
                          type="checkbox"
                          checked={row.source === 'roster'}
                          onChange={(e) => patchRow({
                            source: e.target.checked ? 'roster' : undefined,
                          })}
                        />
                        Pick from roster
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
            {formError && (
              <div style={{ color: 'var(--red)', fontSize: '13px' }}>{formError}</div>
            )}
            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={closeForm} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn primary"
                onClick={() => void handleSave()}
                disabled={!canSave}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete prompt"
          body={<>Delete &ldquo;{confirmDelete.name}&rdquo;? This cannot be undone.
            {deleteError && <div style={{ color: 'var(--red)', marginTop: 8 }}>{deleteError}</div>}</>}
          danger
          confirmLabel="Delete"
          busy={busy}
          onCancel={() => { setConfirmDelete(null); setDeleteError(null); }}
          onConfirm={() => void handleDelete()}
        />
      )}

      {preview && (
        <PromptPreviewModal
          entry={preview}
          onInsert={handleInsert}
          onEdit={(entry) => {
            setPreview(null);
            openEdit(entry);
          }}
          onClose={() => setPreview(null)}
          onOpenFile={onOpenFile}
        />
      )}

      {enhanceFor && (
        <PromptEnhanceModal
          entry={enhanceFor}
          contextAvailable={contextAvailable}
          projectAvailable={projectAvailable}
          onRun={(mode, instruction) => onEnhance(enhanceBody ?? enhanceFor.body, mode, instruction)}
          onClose={() => { setEnhanceFor(null); setEnhanceBody(null); }}
        />
      )}

      {fillFor && (
        <PromptVariablesModal
          entry={fillFor.entry}
          actionLabel={fillFor.action === 'insert' ? 'Insert' : 'Enhance'}
          onSubmit={handleFillSubmit}
          onRawInsert={fillFor.action === 'insert' ? handleRawInsert : undefined}
          onClose={() => setFillFor(null)}
          roles={roles}
        />
      )}

      {importOpen && (
        <Modal title="Import prompts" onClose={resetImport} className="prompt-collection-modal">
          <div className="modal-field">
            <span className="modal-label">JSON file</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                ref={importFileRef}
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setImportFileName(file.name);
                  void file.text().then(reviewImportText);
                }}
              />
              <button
                type="button"
                className="modal-btn"
                onClick={() => importFileRef.current?.click()}
              >
                Choose file…
              </button>
              <span style={{ fontSize: 12, color: importFileName ? 'var(--text-1)' : 'var(--text-2)' }}>
                {importFileName || 'No file chosen'}
              </span>
            </div>
          </div>
          <label className="modal-field">
            <span className="modal-label">Or paste JSON</span>
            <textarea
              className="modal-input"
              rows={8}
              style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 11, width: '100%' }}
              value={importText}
              onChange={(e) => reviewImportText(e.target.value)}
              placeholder='{ "kind": "tierwyn-prompt-pack", "version": 1, "prompts": [ … ] }'
              spellCheck={false}
            />
          </label>
          {importError && (
            <div style={{ color: 'var(--red)', fontSize: 13 }}>{importError}</div>
          )}
          {importPreview && (
            <>
              <div className="prompt-import-preview">
                <div>
                  {importPreview.prompts.length} prompt{importPreview.prompts.length === 1 ? '' : 's'}
                  {importPreview.title ? `: ${importPreview.title}` : ''}
                </div>
                {importPreview.prompts.map((p) => {
                  const nVars = resolvePromptVariables(p).length;
                  return (
                    <div key={p.id} className="prompt-import-preview-row">
                      <span>{p.name} — {p.description}</span>
                      {nVars > 0 && (
                        <span className="prompt-origin-chip">{nVars} var{nVars === 1 ? '' : 's'}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {importConflicts.length > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={importOverwrite}
                    onChange={(e) => setImportOverwrite(e.target.checked)}
                  />
                  Overwrite {importConflicts.length} existing prompt{importConflicts.length === 1 ? '' : 's'}
                </label>
              )}
            </>
          )}
          <div className="modal-footer" style={{ marginTop: 12 }}>
            <button type="button" className="modal-btn" onClick={resetImport} disabled={importBusy}>
              Cancel
            </button>
            <button
              type="button"
              className="modal-btn primary"
              onClick={() => void confirmImport()}
              disabled={!importPreview || importBusy}
            >
              {importBusy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
