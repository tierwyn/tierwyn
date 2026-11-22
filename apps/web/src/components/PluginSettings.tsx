import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginInvocationRow, PluginSummary, PluginVaultStatus } from '@tierwyn/shared';
import { api } from '../api.js';
import { credentialRowLabel, invocationLine, deleteConfirmText, isPluginArchiveName } from '../pluginPanel.js';
import { KEY_LIST_MAX, keyListSummary, serialiseKeyList, usesKeyListEditor, validateKeyRows, type KeyRow } from '../keyListEditor.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export function PluginSettings() {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [vault, setVault] = useState<PluginVaultStatus>({ available: true });
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowDrafts, setRowDrafts] = useState<Record<string, KeyRow[]>>({});
  const rowIds = useRef({ seq: 0, bySlot: {} as Record<string, number[]> });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<{ id: string; key: string } | null>(null);
  const [pendingSet, setPendingSet] = useState<{ id: string; key: string; count: number } | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, PluginInvocationRow[]>>({});

  const apply = useCallback((next: { plugins: PluginSummary[]; vault: PluginVaultStatus }) => {
    setPlugins(next.plugins);
    setVault(next.vault);
  }, []);

  useEffect(() => {
    api.listPlugins().then(apply).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'failed to load plugins');
    });
  }, [apply]);

  const setDraft = (id: string, key: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [`${id}:${key}`]: value }));
  };
  const clearDraft = (id: string, key: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[`${id}:${key}`];
      return next;
    });
  };
  const setRows = (slot: string, rows: KeyRow[]) => {
    setRowDrafts((prev) => ({ ...prev, [slot]: rows }));
  };
  const clearRows = (slot: string) => {
    setRowDrafts((prev) => {
      const next = { ...prev };
      delete next[slot];
      return next;
    });
    delete rowIds.current.bySlot[slot];
  };
  const rid = (slot: string, n: number, i: number) => {
    const cur = (rowIds.current.bySlot[slot] ??= []);
    while (cur.length < n) cur.push(++rowIds.current.seq);
    return cur[i];
  };

  const onSet = async (id: string, key: string, confirmed = false) => {
    const slot = `${id}:${key}`;
    const rows = rowDrafts[slot];
    const value = rows ? serialiseKeyList(rows) : (drafts[slot] ?? '');
    if (!value || busyKey) return;
    if (rows && !confirmed) {
      setPendingSet({ id, key, count: value.split(',').filter(Boolean).length });
      return;
    }
    setBusyKey(slot);
    setError(null);
    try {
      const next = await api.setPluginCredential(id, key, value);
      clearDraft(id, key);
      clearRows(slot);
      apply(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to set credential');
      clearDraft(id, key);
      clearRows(slot);
    } finally {
      setBusyKey(null);
      setPendingSet(null);
    }
  };

  const onClear = async (id: string, key: string) => {
    setBusyKey(`${id}:${key}`);
    setError(null);
    try {
      const next = await api.clearPluginCredential(id, key);
      apply(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to clear credential');
    } finally {
      setBusyKey(null);
      setClearTarget(null);
    }
  };

  const onToggle = async (id: string, enabled: boolean) => {
    setError(null);
    try {
      apply(await api.setPluginEnabled(id, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to toggle plugin');
    }
  };

  const onExpandLog = async (id: string) => {
    if (openLog === id) {
      setOpenLog(null);
      return;
    }
    setOpenLog(id);
    try {
      const { invocations } = await api.pluginInvocations(id);
      setLogs((prev) => ({ ...prev, [id]: invocations }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load invocations');
    }
  };

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onImport = async () => {
    if (!importFile || importing) return;
    if (!isPluginArchiveName(importFile.name)) {
      setError('archive must be a .tar.gz or .tgz file');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      apply(await api.importPlugin(importFile));
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to import plugin');
    } finally {
      setImporting(false);
    }
  };

  const onDelete = async (p: PluginSummary) => {
    if (deletingId) return;
    if (!window.confirm(deleteConfirmText(p))) return;
    setDeletingId(p.id);
    setError(null);
    try {
      apply(await api.deletePlugin(p.id));
      if (openLog === p.id) setOpenLog(null);
      setLogs((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to delete plugin');
    } finally {
      setDeletingId(null);
    }
  };

  const writesDisabled = !vault.available;

  return (
    <div className="settings-section">
      <div className="settings-section-title">Plugins</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".tar.gz,.tgz,application/gzip"
          aria-label="Upload plugin archive"
          disabled={importing}
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setImportFile(f);
          }}
        />
        <button
          type="button"
          className="modal-btn"
          disabled={importing}
          onClick={() => fileInputRef.current?.click()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Choose archive…
        </button>
        <span
          style={{
            fontSize: 12,
            color: importFile ? 'var(--text-1)' : 'var(--text-3)',
            fontFamily: importFile ? 'var(--mono)' : 'inherit',
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={importFile ? importFile.name : undefined}
        >
          {importFile ? importFile.name : 'No archive chosen'}
        </span>
        <button
          type="button"
          className="modal-btn primary"
          disabled={!importFile || importing}
          onClick={() => { void onImport(); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {importing ? (
            'Importing…'
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Import
            </>
          )}
        </button>
      </div>
      {writesDisabled && (
        <div className="usage-error" role="status">
          Vault unavailable{vault.reason ? `: ${vault.reason}` : ''}. Set and Clear are disabled.
          Env-captured keys still work until you restart with a ≥32-byte SESSION_SECRET or TIERWYN_PLUGIN_VAULT_KEY.
        </div>
      )}
      {error && <div className="usage-error">{error}</div>}
      {plugins.length === 0 && !error && (
        <div className="modal-hint">No plugins loaded. Drop an ESM plugin under plugins/ and restart.</div>
      )}
      {plugins.map((p) => (
        <div key={p.id} className="settings-card active" style={{ marginBottom: 12 }}>
          <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="modal-field modal-field-row">
              <div>
                <div className="modal-label">{p.name}</div>
                <div className="modal-hint">{p.id} · v{p.version}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={p.enabled}
                className={`toggle-switch${p.enabled ? ' on' : ''}`}
                onClick={() => { void onToggle(p.id, !p.enabled); }}
              >
                <span className="toggle-knob" />
              </button>
            </div>

            {(p.credentials ?? []).map((c) => {
              const slot = `${p.id}:${c.key}`;
              const listEditor = usesKeyListEditor(p.id, c.key);
              const rows = rowDrafts[slot] ?? [{ name: '', key: '' }];
              const rowError = listEditor ? validateKeyRows(rows) : null;
              return (
                <div key={c.key} className="modal-field">
                  <span className="modal-label">{c.key}</span>
                  <div className={c.needsReentry ? 'usage-error' : 'modal-hint'}>{credentialRowLabel(c)}</div>
                  {listEditor ? (
                    <>
                      {rows.map((row, i) => (
                        <div key={rid(slot, rows.length, i)} style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                          <input
                            type="text"
                            className="modal-input"
                            placeholder="name (optional)"
                            aria-label={`Key ${i + 1} name`}
                            value={row.name}
                            disabled={writesDisabled || busyKey === slot}
                            onChange={(e) => {
                              const next = rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r));
                              setRows(slot, next);
                            }}
                          />
                          <input
                            type="password"
                            className="modal-input"
                            autoComplete="off"
                            placeholder={p.id === 'kilo-usage' ? 'kilo_…' : 'sk-or-v1-…'}
                            aria-label={`Key ${i + 1} API key`}
                            value={row.key}
                            disabled={writesDisabled || busyKey === slot}
                            onChange={(e) => {
                              const next = rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r));
                              setRows(slot, next);
                            }}
                          />
                          <button
                            type="button"
                            className="modal-btn danger"
                            aria-label={`Remove key ${i + 1}`}
                            disabled={writesDisabled || busyKey === slot}
                            onClick={() => {
                              const next = rows.filter((_, j) => j !== i);
                              rowIds.current.bySlot[slot]?.splice(i, 1);
                              if (next.length === 0) clearRows(slot);
                              else setRows(slot, next);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="modal-btn"
                        disabled={rows.length >= KEY_LIST_MAX || writesDisabled || busyKey === slot}
                        onClick={() => setRows(slot, [...rows, { name: '', key: '' }])}
                      >
                        + Add key
                      </button>
                      <div className="modal-hint">
                        {keyListSummary(rows)} · Set replaces the whole stored list — enter every key you want to keep.
                      </div>
                      {rowError && <div className="usage-error">{rowError}</div>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="modal-btn primary"
                          disabled={writesDisabled || busyKey === slot || !!rowError || !serialiseKeyList(rows)}
                          onClick={() => { void onSet(p.id, c.key); }}
                        >
                          Set
                        </button>
                        <button
                          type="button"
                          className="modal-btn danger"
                          disabled={writesDisabled || busyKey === slot || (!c.needsReentry && (c.source !== 'vault' || !c.configured))}
                          onClick={() => setClearTarget({ id: p.id, key: c.key })}
                        >
                          Clear
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                      <input
                        type="password"
                        className="modal-input"
                        autoComplete="off"
                        placeholder="new value"
                        value={drafts[slot] ?? ''}
                        disabled={writesDisabled || busyKey === slot}
                        onChange={(e) => setDraft(p.id, c.key, e.target.value)}
                      />
                      <button
                        type="button"
                        className="modal-btn primary"
                        disabled={writesDisabled || busyKey === slot || !(drafts[slot] ?? '')}
                        onClick={() => { void onSet(p.id, c.key); }}
                      >
                        Set
                      </button>
                      <button
                        type="button"
                        className="modal-btn danger"
                        disabled={writesDisabled || busyKey === slot || (!c.needsReentry && (c.source !== 'vault' || !c.configured))}
                        onClick={() => setClearTarget({ id: p.id, key: c.key })}
                      >
                        Clear
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="modal-btn"
                onClick={() => { void onExpandLog(p.id); }}
              >
                {openLog === p.id ? 'Hide invocations' : 'Invocations'}
              </button>
              <button
                type="button"
                className="modal-btn danger"
                disabled={deletingId === p.id}
                onClick={() => { void onDelete(p); }}
              >
                {deletingId === p.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
            {openLog === p.id && (
              <div className="modal-hint" style={{ fontFamily: 'var(--mono, monospace)', whiteSpace: 'pre-wrap' }}>
                {(logs[p.id] ?? []).length === 0
                  ? 'No invocations yet.'
                  : (logs[p.id] ?? []).map((row) => (
                    <div key={row.id}>{invocationLine(row)}</div>
                  ))}
              </div>
            )}
          </div>
        </div>
      ))}

      {pendingSet && (
        <ConfirmDialog
          title="Replace stored key list"
          body={`Replace the stored key list with ${pendingSet.count} key${pendingSet.count === 1 ? '' : 's'}? The stored value is write-only — this replaces ALL existing keys.`}
          confirmLabel="Set"
          busy={busyKey === `${pendingSet.id}:${pendingSet.key}`}
          onConfirm={() => { void onSet(pendingSet.id, pendingSet.key, true); }}
          onCancel={() => setPendingSet(null)}
        />
      )}
      {clearTarget && (
        <ConfirmDialog
          title="Clear vault credential"
          body={`Remove the stored vault value for ${clearTarget.key} on ${clearTarget.id}? An env fallback, if any, will show again.`}
          confirmLabel="Clear"
          danger
          busy={busyKey === `${clearTarget.id}:${clearTarget.key}`}
          onConfirm={() => { void onClear(clearTarget.id, clearTarget.key); }}
          onCancel={() => setClearTarget(null)}
        />
      )}
    </div>
  );
}
