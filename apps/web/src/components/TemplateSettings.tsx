import { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { AgentProfile, EffortLevel, McpServerDef, RoleWhenPreset, SpawnTemplate, SpawnTemplateRole, Workdir } from '@tierwyn/shared';
import { matchWhenPreset, mcpAgentCapability, validateMcpIdList } from '@tierwyn/shared';
import { api, type AaModelListItem, type AaStatus, type AaSuggestResponse } from '../api.js';
import { pickerEffortLevels } from '../effortLevels.js';
import { ModelSelector } from './ModelSelector.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

const emptyRole = (): SpawnTemplateRole => ({ role: '', profileId: '', when: '' });
const emptyDraft = (): SpawnTemplate => ({
  name: '',
  roles: [emptyRole()],
  delegationInstructions: '',
  spawnApprovalRequired: false,
});

function normalizeRole(r: SpawnTemplateRole): SpawnTemplateRole {
  const workdir = r.defaultWorkdir === 'worktree' ? 'worktree' : undefined;
  const designation = r.defaultDesignation?.trim();
  const mcpServers = r.mcpServers && r.mcpServers.length > 0 ? r.mcpServers : undefined;
  return {
    role: r.role.trim(),
    profileId: r.profileId,
    when: r.when.trim(),
    ...(workdir ? { defaultWorkdir: workdir } : {}),
    ...(designation ? { defaultDesignation: designation } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(r.effort ? { effort: r.effort } : {}),
  };
}

export function stripUninjectableMcp(r: SpawnTemplateRole, agentType: string | undefined): SpawnTemplateRole {
  return agentType && mcpAgentCapability(agentType).registryInjection === 'unsupported'
    ? { ...r, mcpServers: undefined } : r;
}

export function sanitizeRoleForProfile(r: SpawnTemplateRole, profile: AgentProfile | undefined): SpawnTemplateRole {
  const next = stripUninjectableMcp(r, profile?.agentType);
  const levels = pickerEffortLevels(profile);
  if (next.effort && levels.includes(next.effort)) return next;
  if (!next.effort) return next;
  const { effort: _drop, ...rest } = next;
  return rest;
}

export function validateTemplateDraft(draft: SpawnTemplate | null): string | null {
  if (!draft) return 'No template to save.';
  const name = draft.name.trim();
  if (!name) return 'Template name is required.';
  if (draft.roles.length === 0) return 'At least one role is required.';
  if (draft.mcpServers) {
    const err = validateMcpIdList(draft.mcpServers, 'Template default MCP servers');
    if (err) return err;
  }
  for (let i = 0; i < draft.roles.length; i++) {
    const r = draft.roles[i]!;
    const roleName = r.role.trim();
    const profileId = r.profileId?.trim();
    if (!roleName && !profileId) {
      return `Role ${i + 1} needs a name and a model. Fill in the empty role row before saving.`;
    }
    if (!profileId) {
      return `Role "${roleName}" is missing a model — pick one before saving.`;
    }
    if (!roleName) {
      return `Role ${i + 1} is missing a role name — enter one before saving.`;
    }
    if (r.mcpServers) {
      const err = validateMcpIdList(r.mcpServers, `Role "${roleName || i + 1}" MCP servers`);
      if (err) return err;
    }
  }
  return null;
}

export function matchesRoleSearch(
  role: SpawnTemplateRole,
  query: string,
  profileMap: Map<string, AgentProfile>,
  presets: RoleWhenPreset[] = [],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  if (role.role.toLowerCase().includes(q)) return true;
  if (role.profileId.toLowerCase().includes(q)) return true;

  const profile = profileMap.get(role.profileId);
  if (profile) {
    if (profile.label?.toLowerCase().includes(q)) return true;
    if (profile.agentType?.toLowerCase().includes(q)) return true;
    if (profile.model?.toLowerCase().includes(q)) return true;
  }

  if (role.when.toLowerCase().includes(q)) return true;

  const preset = matchWhenPreset(presets, role.when);
  if (preset && preset.name.toLowerCase().includes(q)) return true;

  const workdir = role.defaultWorkdir ?? 'shared';
  if (workdir.toLowerCase().includes(q)) return true;

  if (role.defaultDesignation && role.defaultDesignation.toLowerCase().includes(q)) return true;

  return false;
}

function draftFromTemplate(t: SpawnTemplate, enabledIds: Set<string>): SpawnTemplate {
  return {
    name: t.name,
    roles: (t.roles.length ? t.roles : [emptyRole()]).map((r) => ({
      ...r,
      // Drop profileIds that are no longer enabled/known so the server's
      // invalidTemplateProfile check doesn't reject Save. With allowEmpty on
      // ModelSelector, a cleared profileId renders as "Select model".
      profileId: r.profileId && enabledIds.has(r.profileId) ? r.profileId : '',
      mcpServers: r.mcpServers ? [...r.mcpServers] : undefined,
    })),
    delegationInstructions: t.delegationInstructions ?? '',
    spawnApprovalRequired: t.spawnApprovalRequired ?? false,
    mcpServers: t.mcpServers ? [...t.mcpServers] : undefined,
  };
}

function truncateWhen(s: string, max = 72): string {
  const t = s.trim();
  if (!t) return '(empty)';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

type SuggestState = {
  busy?: boolean;
  result?: AaSuggestResponse;
  error?: string;
  previousWhen?: string;
  picker?: boolean;
};

function aaMetricsBits(r: AaSuggestResponse): string {
  const bits: string[] = [];
  if (r.aaModel) bits.push(`AA: ${r.aaModel.name}`);
  const m = r.metrics;
  if (m?.intel != null) bits.push(`intel ${Math.round(m.intel)}`);
  if (m?.priceIn != null && m?.priceOut != null) bits.push(`$${m.priceIn}/$${m.priceOut}`);
  if (m?.tps != null) bits.push(`${Math.round(m.tps)} tok/s`);
  return bits.join(' · ');
}

export function TemplateSettings({
  profiles,
  profilesLoaded = true,
  presets = [],
  designations = [],
}: {
  profiles: AgentProfile[];
  profilesLoaded?: boolean;
  /** Lifted "used when" library so the role dropdown stays live after library edits. */
  presets?: RoleWhenPreset[];
  /** Combined designation catalogue (builtins + customs). */
  designations?: string[];
}) {
  const enabledIds = new Set(profiles.map((p) => p.id));
  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const [templates, setTemplates] = useState<SpawnTemplate[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<McpServerDef[]>([]);
  /** null = list only; draft open in nested modal (new or edit). */
  const [draft, setDraft] = useState<SpawnTemplate | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleSearch, setRoleSearch] = useState('');
  const [aa, setAa] = useState<AaStatus | null>(null);
  const [aaKeyOpen, setAaKeyOpen] = useState(false);
  const [aaKeyDraft, setAaKeyDraft] = useState('');
  const [aaKeyBusy, setAaKeyBusy] = useState(false);
  const [aaKeyError, setAaKeyError] = useState<string | null>(null);
  const [suggestByRole, setSuggestByRole] = useState<Record<number, SuggestState>>({});
  const [aaModels, setAaModels] = useState<AaModelListItem[] | null>(null);
  const whenRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const editorOpen = draft !== null;

  useEffect(() => {
    api.listTemplates().then(setTemplates);
    api.listMcpServers().then((r) => setAvailableMcpServers(r.servers)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!editorOpen) return;
    let cancelled = false;
    api.aaStatus().then((s) => { if (!cancelled) setAa(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [editorOpen]);

  const presetOptions: SelectDropdownOption[] = [
    { value: '__custom__', label: 'Custom' },
    ...presets.map((p) => ({
      value: p.id,
      label: p.name,
      description: truncateWhen(p.when),
    })),
  ];

  const filteredRoles = useMemo(() => {
    if (!draft) return [];
    return draft.roles
      .map((role, originalIndex) => ({ role, originalIndex }))
      .filter(({ role }) => matchesRoleSearch(role, roleSearch, profileMap, presets));
  }, [draft, roleSearch, profileMap, presets]);

  const setRole = (i: number, patch: Partial<SpawnTemplateRole>) =>
    setDraft((d) => (d ? { ...d, roles: d.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : d));
  const addRole = () => {
    setRoleSearch('');
    setDraft((d) => (d ? { ...d, roles: [...d.roles, emptyRole()] } : d));
  };
  // ponytail: drop per-role suggest map on reorder/remove — indices would shift.
  const removeRole = (i: number) => {
    setSuggestByRole({});
    setDraft((d) => (d ? { ...d, roles: d.roles.filter((_, j) => j !== i) } : d));
  };
  /** Reorder for roster display / curl example only — spawn still keys by role name. */
  const moveRole = (i: number, delta: -1 | 1) => {
    setSuggestByRole({});
    setDraft((d) => {
      if (!d) return d;
      const j = i + delta;
      if (j < 0 || j >= d.roles.length) return d;
      const roles = d.roles.slice();
      const tmp = roles[i]!;
      roles[i] = roles[j]!;
      roles[j] = tmp;
      return { ...d, roles };
    });
  };
  const setAllWorkdir = (workdir: Workdir) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            roles: d.roles.map((r) => ({
              ...r,
              defaultWorkdir: workdir === 'worktree' ? 'worktree' : undefined,
            })),
          }
        : d,
    );

  function resetAaEditorState() {
    setSuggestByRole({});
    setAaKeyOpen(false);
    setAaKeyDraft('');
    setAaKeyError(null);
  }

  function openNew() {
    setError(null);
    setRoleSearch('');
    setEditingExisting(false);
    resetAaEditorState();
    setDraft(emptyDraft());
  }

  function openEdit(t: SpawnTemplate) {
    setError(null);
    setRoleSearch('');
    setEditingExisting(true);
    resetAaEditorState();
    setDraft(draftFromTemplate(t, enabledIds));
  }

  function closeEditor() {
    setDraft(null);
    setRoleSearch('');
    setEditingExisting(false);
    setError(null);
    resetAaEditorState();
  }

  /** Persist and close. Backdrop/Escape do not dismiss — use Save or Cancel. */
  async function save() {
    if (!draft) return;
    const validationError = validateTemplateDraft(draft);
    if (validationError) {
      setError(validationError);
      if (roleSearch.trim()) setRoleSearch('');
      return;
    }
    const name = draft.name.trim();
    setBusy(true);
    setError(null);
    try {
      const normalized = draft.roles.map((role) =>
        normalizeRole(sanitizeRoleForProfile(role, profileMap.get(role.profileId))),
      );
      const instructions = draft.delegationInstructions?.trim() || undefined;
      setTemplates(
        await api.saveTemplate({
          name,
          roles: normalized,
          delegationInstructions: instructions,
          spawnApprovalRequired: draft.spawnApprovalRequired ?? false,
          mcpServers: draft.mcpServers && draft.mcpServers.length > 0 ? draft.mcpServers : undefined,
        }),
      );
      closeEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setBusy(true);
    try {
      await api.deleteTemplate(name);
      setTemplates(await api.listTemplates());
    } finally {
      setBusy(false);
    }
  }

  async function saveAaKey() {
    const value = aaKeyDraft.trim();
    setAaKeyBusy(true);
    setAaKeyError(null);
    try {
      await api.aaSetKey(value);
      setAaKeyDraft('');
      setAaKeyOpen(false);
      setAa(await api.aaStatus());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAaKeyError(`${msg}${!aa?.vaultAvailable ? ' — or set TIERWYN_AA_API_KEY in the server env' : ''}`);
    } finally {
      setAaKeyBusy(false);
    }
  }

  async function clearAaKey() {
    setAaKeyBusy(true);
    setAaKeyError(null);
    try {
      await api.aaClearKey();
      setAa(await api.aaStatus());
    } catch (e) {
      setAaKeyError(e instanceof Error ? e.message : String(e));
    } finally {
      setAaKeyBusy(false);
    }
  }

  async function loadAaModels(): Promise<AaModelListItem[]> {
    if (aaModels) return aaModels;
    const r = await api.aaModels();
    setAaModels(r.models);
    return r.models;
  }

  async function suggestWhen(i: number, aaSlug?: string) {
    if (!draft) return;
    const r = draft.roles[i];
    if (!r?.profileId) return;
    const previousWhen = r.when;
    setSuggestByRole((s) => ({ ...s, [i]: { ...s[i], busy: true, error: undefined } }));
    try {
      const siblingWhens = draft.roles
        .filter((_, j) => j !== i)
        .map((x) => x.when.trim())
        .filter(Boolean);
      const result = await api.aaSuggest({
        profileId: r.profileId,
        role: r.role.trim() || undefined,
        siblingWhens,
        ...(aaSlug ? { aaSlug } : {}),
      });
      const overwritten = result.draft != null
        && previousWhen.trim() !== ''
        && previousWhen !== result.draft;
      if (result.draft != null) setRole(i, { when: result.draft });
      const openPicker = result.match === 'none' || result.draft === null;
      if (openPicker) void loadAaModels().catch(() => {});
      setSuggestByRole((s) => ({
        ...s,
        [i]: {
          busy: false,
          result,
          previousWhen: overwritten ? previousWhen : s[i]?.previousWhen,
          picker: openPicker || s[i]?.picker,
        },
      }));
      if (result.draft != null) {
        requestAnimationFrame(() => {
          const el = whenRefs.current[i];
          el?.focus();
          el?.select();
        });
      }
    } catch (e) {
      setSuggestByRole((s) => ({
        ...s,
        [i]: { busy: false, error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  return (
    <div className="template-settings template-settings--panel">
      <div className="template-settings-head">
        <div className="template-roles-header">
          <span className="modal-label">Roster</span>
          <button type="button" className="modal-btn primary" onClick={openNew} disabled={busy}>
            + New template
          </button>
        </div>
      </div>
      <div className="template-settings-body">
        {templates.length === 0 ? (
          <div className="template-list-empty">
            No delegate templates yet. Create one to give parent agents a spawn roster.
          </div>
        ) : (
          <div className="template-list">
            {templates.map((t) => (
              <div key={t.name} className="template-row">
                <div className="template-row-info">
                  <span className="template-row-name">{t.name}</span>
                  <span className="template-row-roles">
                    {t.roles.map((r) => r.role).join(', ') || '(no roles)'}
                    {t.spawnApprovalRequired && (
                      <span className="template-badge">approval required</span>
                    )}
                  </span>
                </div>
                <div className="template-row-actions">
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => openEdit(t)}
                    disabled={busy}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="modal-btn danger"
                    onClick={() => void remove(t.name)}
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

      {draft && createPortal(
        // Portal to body: Settings' .settings-modal has backdrop-filter + overflow:hidden,
        // so a nested position:fixed overlay is clipped to the templates pane on desktop.
        <div
          className="modal-overlay template-edit-overlay"
          /* No onClick close — save is the only way out. */
          role="dialog"
          aria-modal="true"
          aria-labelledby="template-edit-title"
        >
          <div
            className="modal-content template-edit-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header template-edit-header">
              <span id="template-edit-title">
                {editingExisting ? 'Edit template' : 'New template'}
              </span>
              <div className="template-edit-header-actions">
                <button
                  type="button"
                  className="modal-btn"
                  onClick={closeEditor}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="modal-btn primary"
                  onClick={() => void save()}
                  disabled={busy}
                >
                  {busy ? 'Saving…' : 'Save template'}
                </button>
              </div>
            </div>

            {error && (
              <div className="template-edit-error-banner" role="alert">
                <span className="template-edit-error-text">{error}</span>
                <button
                  type="button"
                  className="template-edit-error-dismiss"
                  onClick={() => setError(null)}
                  aria-label="Dismiss error"
                  title="Dismiss error"
                >
                  ✕
                </button>
              </div>
            )}

            <div className="modal-body template-edit-body">
              <div className="template-aa-key-row">
                {aa?.configured ? (
                  <>
                    <span>
                      Artificial Analysis key: ✓ configured ({aa.source ?? 'vault'})
                    </span>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => { setAaKeyOpen(true); setAaKeyError(null); }}
                      disabled={aaKeyBusy}
                    >
                      Replace
                    </button>
                    {aa.source !== 'env' && (
                      <button
                        type="button"
                        className="modal-btn"
                        onClick={() => void clearAaKey()}
                        disabled={aaKeyBusy}
                      >
                        Clear
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <span>Artificial Analysis key: not set</span>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => { setAaKeyOpen(true); setAaKeyError(null); }}
                      disabled={aaKeyBusy}
                    >
                      Set key
                    </button>
                  </>
                )}
                {aa?.tier && aa.tier !== 'free' && (
                  <span className="modal-hint">AA tier: {aa.tier}</span>
                )}
                <a
                  className="modal-hint"
                  href="https://artificialanalysis.ai"
                  target="_blank"
                  rel="noreferrer"
                >
                  Metrics: Artificial Analysis
                </a>
                <span className="modal-hint template-aa-sidecar-note">
                  ✨ Suggest writes the hint with the Dictation Enhance sidecar (Settings → Sidecar job routing → Enhance),
                  always tools-off with no project files. If Enhance is off, you get a metrics-only draft.
                </span>
                {aaKeyOpen && (
                  <>
                    <input
                      className="modal-input"
                      type="password"
                      value={aaKeyDraft}
                      onChange={(e) => setAaKeyDraft(e.target.value)}
                      placeholder="AA API key"
                      autoComplete="off"
                      disabled={aaKeyBusy}
                    />
                    <button
                      type="button"
                      className="modal-btn primary"
                      onClick={() => void saveAaKey()}
                      disabled={aaKeyBusy || !aaKeyDraft.trim()}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => { setAaKeyOpen(false); setAaKeyDraft(''); }}
                      disabled={aaKeyBusy}
                    >
                      Cancel
                    </button>
                  </>
                )}
                {aaKeyError && (
                  <span className="template-aa-annote template-aa-annote--error">{aaKeyError}</span>
                )}
              </div>

              <div className="modal-field">
                <span className="modal-label">Template name</span>
                <input
                  className="modal-input"
                  value={draft.name}
                  onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                  placeholder="e.g. review-team"
                  autoFocus
                />
              </div>

              <div className="modal-field">
                <div className="template-roles-header">
                  <span className="modal-label">Roles ({draft.roles.length})</span>
                  <div className="template-workdir-bulk">
                    <button type="button" className="modal-btn" onClick={() => setAllWorkdir('shared')}>
                      All shared
                    </button>
                    <button type="button" className="modal-btn" onClick={() => setAllWorkdir('worktree')}>
                      All worktree
                    </button>
                  </div>
                </div>

                <div className="template-role-search-row">
                  <div className="template-role-search-wrap">
                    <input
                      className="modal-input template-role-search-input"
                      value={roleSearch}
                      onChange={(e) => setRoleSearch(e.target.value)}
                      placeholder="Search roles by name, model, when, workdir, designation…"
                      aria-label="Search roles in this roster"
                    />
                    {roleSearch && (
                      <button
                        type="button"
                        className="template-role-search-clear"
                        onClick={() => setRoleSearch('')}
                        aria-label="Clear search"
                        title="Clear search"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {roleSearch.trim() && (
                    <span className="template-role-search-count">
                      Showing {filteredRoles.length} of {draft.roles.length}
                    </span>
                  )}
                </div>

                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic' }}>
                  Order is visual only (roster list + sample curl). Spawn still matches by role name.
                  Conversation-level workdir pin overrides per-role defaults.
                </div>
                <div className="template-roles">
                  {filteredRoles.length === 0 ? (
                    <div className="template-roles-empty-search">
                      <span>No roles match &ldquo;{roleSearch}&rdquo;</span>
                      <button type="button" className="modal-btn" onClick={() => setRoleSearch('')}>
                        Clear search
                      </button>
                    </div>
                  ) : (
                    filteredRoles.map(({ role: r, originalIndex: i }) => {
                      const roleProfile = profileMap.get(r.profileId);
                      const roleAgent = roleProfile?.agentType;
                      const mcpOff = !!roleAgent && mcpAgentCapability(roleAgent).registryInjection === 'unsupported';
                      const effortLevels = pickerEffortLevels(roleProfile);
                      return (
                      <div key={i} className="template-role-block">
                        <div className="template-role-block-head">
                          <span className="template-role-index">Role {i + 1}</span>
                          <div className="template-role-block-actions">
                            <button
                              type="button"
                              className="modal-btn template-role-reorder"
                              onClick={() => moveRole(i, -1)}
                              disabled={i === 0 || !!roleSearch.trim()}
                              aria-label={`Move role ${i + 1} up`}
                              title={roleSearch.trim() ? 'Clear search to reorder roles' : 'Move up'}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="modal-btn template-role-reorder"
                              onClick={() => moveRole(i, 1)}
                              disabled={i === draft.roles.length - 1 || !!roleSearch.trim()}
                              aria-label={`Move role ${i + 1} down`}
                              title={roleSearch.trim() ? 'Clear search to reorder roles' : 'Move down'}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="modal-btn template-role-remove"
                              onClick={() => removeRole(i)}
                              disabled={draft.roles.length <= 1}
                              aria-label={`Remove role ${i + 1}`}
                              title="Remove role"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <div className="template-role-row">
                          <input
                            className="modal-input"
                            value={r.role}
                            onChange={(e) => setRole(i, { role: e.target.value })}
                            placeholder="role"
                          />
                          <ModelSelector
                            profiles={profiles}
                            profilesLoaded={profilesLoaded}
                            selectedProfileId={r.profileId}
                            onChange={(val) => setRole(i, { profileId: val })}
                            placement="bottom"
                            allowEmpty
                          />
                        </div>
                        <div className="template-role-row template-role-row--secondary">
                          {/* ponytail: dropdown value is derived from when text — no transient selection state. */}
                          <SelectDropdown
                            options={presetOptions}
                            value={matchWhenPreset(presets, r.when)?.id ?? '__custom__'}
                            onChange={(id) => {
                              if (id === '__custom__') return; // leave when text for free editing
                              const preset = presets.find((p) => p.id === id);
                              if (preset) setRole(i, { when: preset.when });
                            }}
                            placement="bottom"
                          />
                          <SelectDropdown<Workdir>
                            options={[
                              { value: 'shared', label: 'shared' },
                              { value: 'worktree', label: 'worktree' },
                            ]}
                            value={r.defaultWorkdir ?? 'shared'}
                            onChange={(defaultWorkdir) => setRole(i, { defaultWorkdir })}
                            placement="bottom"
                          />
                          <SelectDropdown
                            options={[
                              { value: '', label: 'no chip' },
                              ...[...new Set([
                                ...designations,
                                ...(r.defaultDesignation ? [r.defaultDesignation] : []),
                              ])].map((d) => ({ value: d, label: d })),
                            ]}
                            value={r.defaultDesignation ?? ''}
                            onChange={(defaultDesignation) => setRole(i, {
                              defaultDesignation: defaultDesignation || undefined,
                            })}
                            placement="bottom"
                          />
                          {effortLevels.length > 0 && (
                            <SelectDropdown
                              options={[
                                { value: '', label: 'default effort' },
                                ...effortLevels.map((l) => ({ value: l, label: l })),
                              ]}
                              value={r.effort && effortLevels.includes(r.effort) ? r.effort : ''}
                              onChange={(v) => setRole(i, { effort: (v || undefined) as EffortLevel | undefined })}
                              placement="bottom"
                            />
                          )}
                        </div>
                        {/* ponytail: role-row when stays a single-line input; textarea only in the library editor. */}
                        <div className="template-role-row template-role-row--when">
                          <input
                            className="modal-input"
                            ref={(el) => { whenRefs.current[i] = el; }}
                            value={r.when}
                            onChange={(e) => setRole(i, { when: e.target.value })}
                            placeholder="use when…"
                          />
                          <button
                            type="button"
                            className="modal-btn"
                            aria-label="Suggest use-when from Artificial Analysis"
                            disabled={!r.profileId || !aa?.configured || !!suggestByRole[i]?.busy}
                            title={
                              !aa?.configured
                                ? 'Set an Artificial Analysis key first'
                                : !r.profileId
                                  ? 'Pick a model first'
                                  : undefined
                            }
                            onClick={() => void suggestWhen(i)}
                          >
                            {suggestByRole[i]?.busy ? '…' : '✨ Suggest'}
                          </button>
                        </div>
                        {(suggestByRole[i]?.result || suggestByRole[i]?.error) && (
                          <div
                            className={`template-aa-annote${suggestByRole[i]?.error ? ' template-aa-annote--error' : ''}`}
                          >
                            {suggestByRole[i]?.error ? (
                              <span>{suggestByRole[i]?.error}</span>
                            ) : suggestByRole[i]?.result?.match === 'none' || suggestByRole[i]?.result?.draft === null ? (
                              <span>No AA equivalent found — pick one or write the hint by hand.</span>
                            ) : (
                              <span>
                                {aaMetricsBits(suggestByRole[i]!.result!)}
                                {' · '}
                                <a href="https://artificialanalysis.ai" target="_blank" rel="noreferrer">
                                  Metrics: Artificial Analysis
                                </a>
                                {suggestByRole[i]?.result?.match === 'base' && ' · check effort tier'}
                                {suggestByRole[i]?.result?.source === 'template' && (
                                  <> · drafted without LLM ({suggestByRole[i]?.result?.llmError})</>
                                )}
                                {suggestByRole[i]?.result?.stale && ' · stale data'}
                              </span>
                            )}
                            {suggestByRole[i]?.previousWhen != null && (
                              <button
                                type="button"
                                className="modal-btn"
                                onClick={() => {
                                  setRole(i, { when: suggestByRole[i]!.previousWhen ?? '' });
                                  setSuggestByRole((s) => {
                                    const next = { ...s[i], previousWhen: undefined };
                                    return { ...s, [i]: next };
                                  });
                                }}
                              >
                                Undo
                              </button>
                            )}
                            <button
                              type="button"
                              className="modal-btn"
                              onClick={() => {
                                setSuggestByRole((s) => ({ ...s, [i]: { ...s[i], picker: true } }));
                                void loadAaModels().catch(() => {});
                              }}
                            >
                              Change model
                            </button>
                          </div>
                        )}
                        {suggestByRole[i]?.picker && (
                          <SelectDropdown
                            searchable
                            placement="bottom"
                            options={[
                              { value: '', label: 'Pick an AA model' },
                              ...(() => {
                                const seen = new Set<string>();
                                const opts: SelectDropdownOption[] = [];
                                const push = (m: AaModelListItem) => {
                                  if (seen.has(m.slug)) return;
                                  seen.add(m.slug);
                                  opts.push({
                                    value: m.slug,
                                    label: m.name,
                                    description: m.intel != null ? `intel ${Math.round(m.intel)}` : 'no intel score',
                                  });
                                };
                                for (const c of suggestByRole[i]?.result?.candidates ?? []) push(c);
                                for (const m of aaModels ?? []) push(m);
                                return opts;
                              })(),
                            ]}
                            value={suggestByRole[i]?.result?.aaModel?.slug ?? ''}
                            onChange={(slug) => {
                              if (slug) void suggestWhen(i, slug);
                            }}
                          />
                        )}
                        <div className="template-role-row" style={{ marginTop: 6 }}>
                          <SelectDropdown
                            options={availableMcpServers.map((s) => ({
                              value: s.id,
                              label: s.id,
                              description: s.description || `${s.transport} server`,
                            }))}
                            multiple
                            disabled={mcpOff}
                            value={mcpOff ? [] : (r.mcpServers ?? [])}
                            onChange={(mcpServers) => setRole(i, { mcpServers })}
                            placeholder={mcpOff
                              ? `MCP not injected for ${roleAgent} — it uses its own MCP config`
                              : 'Role MCP servers (child delegates inherit these)'}
                            placement="bottom"
                            searchable
                          />
                          {mcpOff && mcpAgentCapability(roleAgent!).notes && (
                            <div className="modal-hint">{mcpAgentCapability(roleAgent!).notes}</div>
                          )}
                        </div>
                      </div>
                    );
                    })
                  )}
                  <button type="button" className="modal-btn" onClick={addRole}>
                    + Add role
                  </button>
                </div>
              </div>

              <div className="modal-field">
                <span className="modal-label">Default MCP servers</span>
                <SelectDropdown
                  options={availableMcpServers.map((s) => ({
                    value: s.id,
                    label: s.id,
                    description: s.description || `${s.transport} server`,
                  }))}
                  multiple
                  value={draft.mcpServers ?? []}
                  onChange={(mcpServers) =>
                    setDraft((d) => (d ? { ...d, mcpServers } : d))
                  }
                  placeholder="Template default MCP servers (conversations inherit these)"
                  placement="top"
                  searchable
                />
                <div className="modal-hint">
                  Conversations using this template inject these MCP servers by default.
                </div>
              </div>

              <div className="modal-field">
                <span className="modal-label">Delegation instructions</span>
                <textarea
                  className="modal-input"
                  rows={6}
                  value={draft.delegationInstructions ?? ''}
                  onChange={(e) =>
                    setDraft((d) => (d ? { ...d, delegationInstructions: e.target.value } : d))
                  }
                  placeholder="Leave blank to use the built-in Result/file-path guidance. Override here to give this template's parent agent different instructions for how to brief and debrief its children."
                />
              </div>

              <div className="modal-field modal-field-row">
                <span className="modal-label">Require spawn approval</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.spawnApprovalRequired ?? false}
                  className={`toggle-switch${draft.spawnApprovalRequired ? ' on' : ''}`}
                  onClick={() =>
                    setDraft((d) =>
                      d ? { ...d, spawnApprovalRequired: !d.spawnApprovalRequired } : d,
                    )
                  }
                  aria-label="Require spawn approval for this template"
                >
                  <span className="toggle-knob" />
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
