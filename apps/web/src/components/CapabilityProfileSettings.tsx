import { useEffect, useRef, useState } from 'react';
import type { CapabilityProfile, PluginSummary } from '@tierwyn/shared';
import {
  BUILTIN_CAPABILITY_PROFILES,
  CAPABILITY_PROFILE_ID_RE,
  CAPABILITY_PROFILE_LABEL_MAX,
} from '@tierwyn/shared';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface Draft {
  id: string;
  label: string;
  plugins: string[] | '*';
  usage: boolean;
  memory: boolean;
  isEditing: boolean;
}

function formatGrantSummary(p: CapabilityProfile): string {
  const parts: string[] = [];
  if (p.plugins === '*') {
    parts.push('All plugins (*)');
  } else if (p.plugins.length === 0) {
    parts.push('No plugins');
  } else {
    parts.push(`Plugins: ${p.plugins.join(', ')}`);
  }
  if (p.usage) {
    parts.push('Usage & telemetry');
  } else {
    parts.push('No telemetry');
  }
  if (p.memory === false) {
    parts.push('No memories');
  }
  return parts.join(' · ');
}

export function CapabilityProfileSettings() {
  const [profiles, setProfiles] = useState<CapabilityProfile[]>([...BUILTIN_CAPABILITY_PROFILES]);
  const [defaultProfileId, setDefaultProfileId] = useState<string>('all');
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CapabilityProfile | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (draft && editorRef.current) {
      editorRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [draft?.id, draft?.isEditing]);

  useEffect(() => {
    let cancelled = false;
    api.getCapabilityProfilesSettings()
      .then((res) => {
        if (!cancelled) {
          setProfiles(res.profiles);
          if (res.defaultProfileId) setDefaultProfileId(res.defaultProfileId);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    api.listPlugins()
      .then((r) => { if (!cancelled) setPlugins(r.plugins); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function openNew() {
    setError(null);
    setDraft({
      id: '',
      label: '',
      plugins: [],
      usage: false,
      memory: true,
      isEditing: false,
    });
  }

  function openEdit(p: CapabilityProfile) {
    setError(null);
    setDraft({
      id: p.id,
      label: p.label,
      plugins: p.plugins === '*' ? '*' : [...p.plugins],
      usage: p.usage,
      memory: p.memory !== false,
      isEditing: true,
    });
  }

  function cancel() {
    setDraft(null);
    setError(null);
  }

  async function save() {
    if (!draft) return;
    setError(null);

    const id = draft.id.trim().toLowerCase();
    if (!draft.isEditing) {
      if (!id) {
        setError('ID is required.');
        return;
      }
      if (!CAPABILITY_PROFILE_ID_RE.test(id)) {
        setError(`ID must match ${CAPABILITY_PROFILE_ID_RE.source} (lowercase letters, digits, and hyphens, up to 40 characters).`);
        return;
      }
      if (BUILTIN_CAPABILITY_PROFILES.some((b) => b.id === id)) {
        setError(`'${id}' is a reserved built-in profile ID.`);
        return;
      }
    }

    const label = draft.label.trim();
    if (!label) {
      setError('Label is required.');
      return;
    }
    if (label.length > CAPABILITY_PROFILE_LABEL_MAX) {
      setError(`Label must be at most ${CAPABILITY_PROFILE_LABEL_MAX} characters.`);
      return;
    }

    const payloadPlugins = draft.plugins === '*'
      ? '*'
      : [...new Set(draft.plugins)];

    const payload: CapabilityProfile = {
      id: draft.isEditing ? draft.id : id,
      label,
      plugins: payloadPlugins,
      usage: draft.usage,
      memory: draft.memory,
    };

    setBusy(true);
    try {
      const res = await api.saveCapabilityProfile(payload);
      setProfiles(res.profiles);
      if (res.defaultProfileId) setDefaultProfileId(res.defaultProfileId);
      setDraft(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteCapabilityProfile(id);
      setProfiles(res.profiles);
      if (res.defaultProfileId) setDefaultProfileId(res.defaultProfileId);
      setDeleteTarget(null);
      if (draft?.id === id) {
        setDraft(null);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetDefault(id: string) {
    if (busy || id === defaultProfileId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.setDefaultCapabilityProfile(id);
      setDefaultProfileId(res.defaultProfileId);
      setProfiles(res.profiles);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canSave = !!draft
    && !!draft.label.trim()
    && (draft.isEditing || !!draft.id.trim())
    && !busy;

  return (
    <div className="template-settings capability-profile-settings">
      <div className="template-settings-head">
        <div className="template-roles-header">
          <span className="modal-label">Capability profiles</span>
          <button
            type="button"
            className="modal-btn primary"
            onClick={openNew}
            disabled={busy || !!draft}
          >
            ＋ New profile
          </button>
        </div>
        <div className="modal-hint template-settings-head-hint">
          Capability profiles scope plugin capabilities and usage telemetry for conversations and scheduled jobs.
          Built-in profiles are read-only; custom profiles grant specific plugins and telemetry access.
        </div>

        {draft && (
          <div className="role-when-preset-editor capability-profile-editor" ref={editorRef}>
            <div className="modal-field">
              <span className="modal-label">Profile ID</span>
              <input
                className="modal-input"
                value={draft.id}
                onChange={(e) => setDraft((d) => (d ? { ...d, id: e.target.value.toLowerCase() } : d))}
                placeholder="e.g. data-science"
                disabled={draft.isEditing}
                maxLength={40}
                autoFocus={!draft.isEditing}
              />
              <div className="modal-hint">
                {draft.isEditing
                  ? 'Identifier is immutable on edit.'
                  : 'Lowercase letters, digits, and hyphens (max 40 chars).'}
              </div>
              {!draft.isEditing && draft.id.trim() && profiles.some((p) => p.id === draft.id.trim().toLowerCase() && !p.builtin) && (
                <div className="modal-hint" style={{ color: '#f59e0b' }}>
                  A profile with this ID already exists — saving will overwrite it.
                </div>
              )}
            </div>

            <div className="modal-field">
              <span className="modal-label">Label</span>
              <input
                className="modal-input"
                value={draft.label}
                onChange={(e) => setDraft((d) => (d ? { ...d, label: e.target.value } : d))}
                placeholder="e.g. Data Science Suite"
                maxLength={CAPABILITY_PROFILE_LABEL_MAX}
                autoFocus={draft.isEditing}
              />
              <div className="modal-hint">
                Human-readable name displayed in pickers (max {CAPABILITY_PROFILE_LABEL_MAX} characters).
              </div>
            </div>

            <div className="modal-field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span className="modal-label" style={{ marginBottom: 0 }}>Plugin grants</span>
                {plugins.length > 0 && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="modal-btn"
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                      disabled={draft.plugins === '*'}
                      onClick={() => setDraft((d) => (d ? { ...d, plugins: plugins.map((p) => p.id) } : d))}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="modal-btn"
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                      disabled={draft.plugins === '*'}
                      onClick={() => setDraft((d) => (d ? { ...d, plugins: [] } : d))}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer', fontSize: '12px', color: 'var(--text-1)' }}>
                <input
                  type="checkbox"
                  checked={draft.plugins === '*'}
                  onChange={(e) => setDraft((d) => (d ? { ...d, plugins: e.target.checked ? '*' : [] } : d))}
                />
                <span style={{ fontWeight: 500 }}>All plugins (wildcard *)</span>
              </label>
              {draft.plugins === '*' && (
                <div className="modal-hint" style={{ marginBottom: 6 }}>
                  Grants every installed plugin — including plugins added after this profile is saved.
                </div>
              )}
              {plugins.length === 0 ? (
                <div className="modal-hint">No plugins installed or discovered.</div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                    gap: '8px',
                    maxHeight: '160px',
                    overflowY: 'auto',
                    padding: '8px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                  }}
                >
                  {plugins.map((p) => {
                    const isChecked = draft.plugins === '*' || draft.plugins.includes(p.id);
                    const isWildcard = draft.plugins === '*';
                    return (
                      <label
                        key={p.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          cursor: isWildcard ? 'default' : 'pointer',
                          fontSize: '12px',
                          color: 'var(--text-1)',
                          opacity: isWildcard ? 0.55 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={isWildcard}
                          onChange={(e) => {
                            const current = draft.plugins === '*'
                              ? plugins.map((plug) => plug.id)
                              : draft.plugins;
                            const next = e.target.checked
                              ? [...current, p.id]
                              : current.filter((id) => id !== p.id);
                            setDraft((d) => (d ? { ...d, plugins: next } : d));
                          }}
                        />
                        <span style={{ fontWeight: 500 }}>{p.name || p.id}</span>
                        <span style={{ color: 'var(--text-3)', fontSize: '11px' }}>({p.id})</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div
              className="modal-field modal-field-row"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}
            >
              <div>
                <span className="modal-label" style={{ marginBottom: 2 }}>Usage &amp; telemetry</span>
                <div className="modal-hint">
                  Grants access to telemetry endpoints and usage providers (e.g. <code>GET /agent/usage</code>).
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={draft.usage}
                className={`toggle-switch${draft.usage ? ' on' : ''}`}
                onClick={() => setDraft((d) => (d ? { ...d, usage: !d.usage } : d))}
                aria-label="Toggle usage telemetry"
              >
                <span className="toggle-knob" />
              </button>
            </div>

            <div
              className="modal-field toggle-field"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}
            >
              <div>
                <span className="modal-label" style={{ marginBottom: 2 }}>Project memories</span>
                <div className="modal-hint">
                  Grants access to memory endpoints (e.g. <code>GET /agent/memory</code>, <code>POST /agent/memory</code>).
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={draft.memory}
                className={`toggle-switch${draft.memory ? ' on' : ''}`}
                onClick={() => setDraft((d) => (d ? { ...d, memory: !d.memory } : d))}
                aria-label="Toggle project memories"
              >
                <span className="toggle-knob" />
              </button>
            </div>

            {error && (
              <div className="template-error" role="alert">
                {error}
              </div>
            )}

            <div className="template-row-actions capability-profile-editor-actions" style={{ marginTop: 8 }}>
              <button type="button" className="modal-btn" onClick={cancel} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn primary"
                onClick={() => void save()}
                disabled={!canSave}
              >
                {busy ? 'Saving…' : draft.isEditing ? 'Save profile' : 'Create profile'}
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

      <div className="template-list">
        {profiles.map((p) => (
          <div key={p.id} className="template-row">
              <div className="template-row-info">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span className="template-row-name">{p.label}</span>
                  <code style={{ fontSize: '11px', color: 'var(--text-3)' }}>{p.id}</code>
                  {p.id === defaultProfileId && (
                    <span
                      className="template-badge"
                      style={{
                        margin: 0,
                        backgroundColor: 'rgba(59, 130, 246, 0.15)',
                        color: 'var(--accent, #60a5fa)',
                        borderColor: 'rgba(59, 130, 246, 0.4)',
                        fontWeight: 600,
                      }}
                    >
                      default
                    </span>
                  )}
                  {p.builtin && <span className="template-badge" style={{ margin: 0 }}>built-in</span>}
                </div>
                <span className="template-row-roles" title={formatGrantSummary(p)}>
                  {formatGrantSummary(p)}
                </span>
              </div>
              <div className="template-row-actions">
                {p.id !== defaultProfileId && (
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => void handleSetDefault(p.id)}
                    disabled={busy || !!draft}
                    title="Make this the default profile for conversations without an explicit profile"
                  >
                    Set as default
                  </button>
                )}
                {p.builtin ? (
                  <span style={{ fontSize: '12px', color: 'var(--text-3)', padding: '4px 8px' }}>
                    Read-only
                  </span>
                ) : (
                  <>
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
                      onClick={() => setDeleteTarget(p)}
                      disabled={busy || !!draft || p.id === defaultProfileId}
                      title={p.id === defaultProfileId ? 'Cannot delete the active default profile' : undefined}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete capability profile"
          body={
            <>
              Are you sure you want to delete custom profile <strong>{deleteTarget.label}</strong> (<code>{deleteTarget.id}</code>)?
              This cannot be undone.
            </>
          }
          danger
          busy={busy}
          confirmLabel="Delete"
          onConfirm={() => void remove(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
