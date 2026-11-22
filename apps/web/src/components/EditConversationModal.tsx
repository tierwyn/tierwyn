import { useEffect, useState, type FormEvent } from 'react';
import type { CapabilityProfile, Conversation, ConversationMcpView, McpServerDef, Project, SpawnTemplate, Workdir } from '@tierwyn/shared';
import { MAX_TAGS, MAX_TAG_LENGTH, collectKnownTags, normaliseTags, suggestTags, REMOTE_AGENTS_PROJECT_ID, BUILTIN_DESIGNATIONS, BUILTIN_CAPABILITY_PROFILES, canonicalCapabilityProfileId } from '@tierwyn/shared';
import { api } from '../api.js';
import { describeSkipReason, getMcpSelectionMode, resolveSelectedIds, type McpSelectionMode } from '../mcpView.js';
import { SelectDropdown } from './SelectDropdown.js';
import { TemplatePreviewModal } from './TemplatePreviewModal.js';

interface Props {
  conversation: Conversation;
  profileLabels: Record<string, string>;
  /** Previously saved tags from the sidebar's loaded conversations. */
  knownTags?: string[];
  onClose: () => void;
  onSaved: (updated: Conversation) => void;
}

export function EditConversationModal({ conversation, profileLabels, knownTags: knownTagsProp, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(conversation.title);
  const [description, setDescription] = useState(conversation.description ?? '');
  const [tags, setTags] = useState<string[]>(conversation.tags ?? []);
  const [designation, setDesignation] = useState(conversation.designation ?? '');
  const [designationCatalogue, setDesignationCatalogue] = useState<string[]>([...BUILTIN_DESIGNATIONS]);
  const [tagDraft, setTagDraft] = useState('');
  const [tagSuggestOpen, setTagSuggestOpen] = useState(false);
  const [tagSuggestIdx, setTagSuggestIdx] = useState(-1);
  const [fetchedKnown, setFetchedKnown] = useState<string[]>([]);
  const [template, setTemplate] = useState(conversation.templateName ?? '');
  const [workdir, setWorkdir] = useState<'' | Workdir>(conversation.spawnWorkdir ?? '');
  const [defaultProfileId, setDefaultProfileId] = useState<string>('all');
  const [capabilityProfile, setCapabilityProfile] = useState(
    conversation.capabilityProfile ?? '',
  );
  const [capabilityProfiles, setCapabilityProfiles] = useState<CapabilityProfile[]>([...BUILTIN_CAPABILITY_PROFILES]);
  const [mcpMode, setMcpMode] = useState<McpSelectionMode>(() => getMcpSelectionMode(conversation.mcpServers));
  const [customMcpServers, setCustomMcpServers] = useState<string[]>(() =>
    Array.isArray(conversation.mcpServers) ? conversation.mcpServers : [],
  );
  const [availableMcpServers, setAvailableMcpServers] = useState<McpServerDef[]>([]);
  const [mcpView, setMcpView] = useState<ConversationMcpView | null>(null);
  const [templates, setTemplates] = useState<SpawnTemplate[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(conversation.projectId);
  const [error, setError] = useState<string | null>(null);

  const isRemoteAgent = conversation.projectId === REMOTE_AGENTS_PROJECT_ID;

  // Mirrors the PATCH route's guards: schedule homes are structural, move
  // applies to root conversations only, and Remote Agents conversations cannot
  // leave (or enter) the container.
  const canMove = !isRemoteAgent && conversation.kind !== 'schedule_home' && !conversation.parentConversationId;

  useEffect(() => {
    if (isRemoteAgent) return;
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [isRemoteAgent]);

  useEffect(() => {
    let cancelled = false;
    api.listDesignations()
      .then((r) => { if (!cancelled) setDesignationCatalogue(r.catalogue); })
      .catch(() => {});
    api.getCapabilityProfilesSettings()
      .then((res) => {
        if (!cancelled) {
          setCapabilityProfiles(res.profiles);
          if (res.defaultProfileId) setDefaultProfileId(res.defaultProfileId);
        }
      })
      .catch(() => {});
    api.listMcpServers()
      .then((r) => { if (!cancelled) setAvailableMcpServers(r.servers); })
      .catch(() => {});
    api.getConversationMcp(conversation.id)
      .then((v) => { if (!cancelled) setMcpView(v); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [conversation.id]);

  useEffect(() => {
    if (knownTagsProp && knownTagsProp.length > 0) return;
    let cancelled = false;
    api.listProjects()
      .then((ps) => Promise.all(ps.map((p) => api.listConversations(p.id).catch(() => [] as Conversation[]))))
      .then((lists) => { if (!cancelled) setFetchedKnown(collectKnownTags(lists.flat())); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [knownTagsProp]);

  const knownTags = (knownTagsProp && knownTagsProp.length > 0) ? knownTagsProp : fetchedKnown;
  const tagSuggestions = suggestTags(knownTags, tagDraft, tags, 12);

  // FW-10: only fetched for movable conversations — the picker is hidden for
  // schedule homes and spawn children, so there is nothing to populate.
  useEffect(() => {
    if (!canMove) return;
    api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, [canMove]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (tagSuggestOpen) { setTagSuggestOpen(false); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, tagSuggestOpen]);

  const regenerate = async () => {
    setRegenerating(true);
    setError(null);
    try {
      const updated = await api.regenerateConversationDescription(conversation.id);
      setDescription(updated.description ?? '');
      onSaved(updated);
    } catch (err) {
      setError(`Regenerate failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRegenerating(false);
    }
  };

  // Commits whatever is in the chip input. normaliseTags is the same function
  // the server runs, so a tag the UI accepts can never 400 — and a tag the UI
  // rejects never leaves the browser. The server still re-validates.
  const commitTagDraft = (raw: string = tagDraft) => {
    setError(null);
    const candidate = normaliseTags([...tags, raw]);
    if (!candidate.ok) { setError(candidate.error); return; }
    setTags(candidate.tags);
    setTagDraft('');
    setTagSuggestOpen(false);
    setTagSuggestIdx(-1);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    try {
      const nextDescription = description.trim() || null;
      const origDescription = conversation.description?.trim() || null;
      const patch: {
        title: string;
        templateName?: string | null;
        spawnWorkdir?: Workdir | null;
        description?: string | null;
        projectId?: string;
        tags?: string[];
        designation?: string | null;
        capabilityProfile?: string | null;
        mcpServers?: string[] | null;
      } = {
        title: title.trim(),
      };
      if (!isRemoteAgent) {
        patch.templateName = template || null;
        patch.spawnWorkdir = workdir || null;
      }
      if (origDescription !== nextDescription) {
        patch.description = nextDescription;
      }
      // Fold an uncommitted chip input into the save so typing a tag and
      // hitting Save (without Enter) does not silently discard it.
      const pending = normaliseTags([...tags, tagDraft]);
      if (!pending.ok) { setError(pending.error); return; }
      const nextTags = pending.tags;
      const origTags = conversation.tags ?? [];
      if (nextTags.length !== origTags.length || nextTags.some((t, i) => t !== origTags[i])) {
        patch.tags = nextTags;
      }
      const nextDesignation = designation || null;
      const origDesignation = conversation.designation || null;
      if (nextDesignation !== origDesignation) {
        patch.designation = nextDesignation;
      }
      const nextCapabilityProfile = capabilityProfile || null;
      const origCapabilityProfile = canonicalCapabilityProfileId(conversation.capabilityProfile, defaultProfileId);
      if (nextCapabilityProfile !== origCapabilityProfile) {
        patch.capabilityProfile = nextCapabilityProfile;
      }
      const nextMcpServers = resolveSelectedIds(mcpMode, customMcpServers);
      const origMcpServers = conversation.mcpServers ?? null;
      const mcpChanged =
        (nextMcpServers === null && origMcpServers !== null) ||
        (nextMcpServers !== null && origMcpServers === null) ||
        (nextMcpServers !== null &&
          origMcpServers !== null &&
          (nextMcpServers.length !== origMcpServers.length ||
            nextMcpServers.some((s, i) => s !== origMcpServers[i])));
      if (mcpChanged) {
        patch.mcpServers = nextMcpServers;
      }
      if (canMove && projectId && projectId !== conversation.projectId) {
        patch.projectId = projectId;
      }
      const updated = await api.updateConversation(conversation.id, patch);
      onSaved({
        ...updated,
        description: (patch.description !== undefined ? nextDescription : origDescription) ?? undefined,
        capabilityProfile: (patch.capabilityProfile !== undefined ? (nextCapabilityProfile ?? undefined) : conversation.capabilityProfile),
        mcpServers: (patch.mcpServers !== undefined ? nextMcpServers : conversation.mcpServers),
      });
      onClose();
    } catch (err) {
      setError(`Edit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <form
          className="modal-content modal-content--roomy"
          onSubmit={submit}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">Edit Conversation</div>
          <div className="modal-body">
            <div className="modal-field">
              <label className="modal-label">Title</label>
              <input
                type="text"
                className="modal-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="modal-field">
              <label className="modal-label">Description</label>
              <div className="template-dropdown-row">
                <input
                  type="text"
                  className="modal-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={120}
                  placeholder="One-line summary (auto-generated on the first message)"
                  disabled={regenerating}
                />
                <button
                  type="button"
                  className="modal-btn"
                  onClick={() => { void regenerate(); }}
                  disabled={regenerating}
                >
                  {regenerating ? 'Regenerating…' : 'Regenerate'}
                </button>
              </div>
            </div>
            <div className="modal-field">
              <label className="modal-label">Designation</label>
              <SelectDropdown
                options={[
                  { value: '', label: 'None' },
                  ...[...new Set([...designationCatalogue, designation].filter(Boolean))].map((d) => ({
                    value: d, label: d,
                  })),
                ]}
                value={designation}
                onChange={setDesignation}
                placement="bottom"
              />
            </div>
            <div className="modal-field">
              <label className="modal-label">Tags</label>
              <div className="modal-tag-chips">
                {tags.map((t) => (
                  <span key={t} className="modal-tag-chip">
                    {t}
                    <button
                      type="button"
                      className="modal-tag-remove"
                      aria-label={`Remove tag ${t}`}
                      onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="modal-tag-input-wrap">
              <input
                type="text"
                className="modal-input"
                value={tagDraft}
                onChange={(e) => { setTagDraft(e.target.value); setTagSuggestOpen(true); setTagSuggestIdx(-1); }}
                maxLength={MAX_TAG_LENGTH}
                disabled={tags.length >= MAX_TAGS}
                placeholder={
                  tags.length >= MAX_TAGS
                    ? `Tag limit reached (${MAX_TAGS})`
                    : (knownTags.length > 0 ? 'Type or pick a tag' : 'Add a tag, then press Enter')
                }
                autoComplete="off"
                onFocus={() => setTagSuggestOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && tagSuggestions.length > 0) {
                    e.preventDefault();
                    setTagSuggestOpen(true);
                    setTagSuggestIdx((i) => (i + 1) % tagSuggestions.length);
                    return;
                  }
                  if (e.key === 'ArrowUp' && tagSuggestions.length > 0) {
                    e.preventDefault();
                    setTagSuggestIdx((i) => (i <= 0 ? tagSuggestions.length - 1 : i - 1));
                    return;
                  }
                  // Enter must not submit the form — pick a suggestion or commit the draft.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (tagSuggestIdx >= 0 && tagSuggestions[tagSuggestIdx]) {
                      commitTagDraft(tagSuggestions[tagSuggestIdx]);
                    } else {
                      commitTagDraft();
                    }
                    return;
                  }
                  if (e.key === 'Backspace' && !tagDraft && tags.length > 0) {
                    setTags((prev) => prev.slice(0, -1));
                  }
                }}
                onBlur={() => { window.setTimeout(() => { setTagSuggestOpen(false); if (tagDraft.trim()) commitTagDraft(); }, 120); }}
              />
              {tagSuggestOpen && tagSuggestions.length > 0 && tags.length < MAX_TAGS && (
                <ul className="tag-suggest tag-suggest--modal" role="listbox">
                  {tagSuggestions.map((t, i) => (
                    <li
                      key={t}
                      role="option"
                      aria-selected={i === tagSuggestIdx}
                      className={`tag-suggest-item${i === tagSuggestIdx ? ' tag-suggest-item--active' : ''}`}
                      onMouseDown={(e) => { e.preventDefault(); commitTagDraft(t); }}
                    >
                      {t}
                    </li>
                  ))}
                </ul>
              )}
              </div>
              <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                Up to {MAX_TAGS} tags, {MAX_TAG_LENGTH} characters each. Previously used tags appear in the dropdown.
              </div>
            </div>
            {!isRemoteAgent && templates.length > 0 && (
              <div className="modal-field">
                <label className="modal-label">Delegation template</label>
                <div className="template-dropdown-row">
                  <SelectDropdown
                    options={[
                      { value: '', label: 'None (no autonomous delegation)' },
                      ...templates.map((t) => ({ value: t.name, label: t.name })),
                    ]}
                    value={template}
                    onChange={setTemplate}
                    placement="bottom"
                    searchable
                  />
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => setPreviewOpen(true)}
                  >
                    View details
                  </button>
                </div>
              </div>
            )}
            {!isRemoteAgent && (
            <div className="modal-field">
              <label className="modal-label">Delegate workdir</label>
              <SelectDropdown
                options={[
                  { value: '', label: 'Per-role (roster defaults)' },
                  { value: 'shared', label: 'Pinned shared' },
                  { value: 'worktree', label: 'Pinned worktree' },
                ]}
                value={workdir}
                onChange={(val) => setWorkdir(val as '' | Workdir)}
                placement="bottom"
              />
              <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                Pin overrides per-role defaults for every spawn from this conversation.
              </div>
            </div>
            )}
            <div className="modal-field">
              <label className="modal-label">Capability profile</label>
              {(() => {
                const defProfile = capabilityProfiles.find((p) => p.id === defaultProfileId);
                const defLabel = defProfile ? `Default (${defProfile.label})` : 'Default (All)';
                const defDesc = defProfile
                  ? (defProfile.plugins === '*'
                      ? 'All plugins (*)' + (defProfile.usage ? ' · usage & telemetry' : '')
                      : (defProfile.plugins.length ? `plugins: ${defProfile.plugins.join(', ')}` : 'no plugins') + (defProfile.usage ? ' · usage & telemetry' : ' · no telemetry'))
                  : 'All plugins (*), usage & telemetry';
                return (
                  <SelectDropdown
                    options={[
                      { value: '', label: defLabel, description: defDesc },
                      ...capabilityProfiles
                        .filter((p) => p.id !== defaultProfileId)
                        .map((p) => ({
                          value: p.id,
                          label: `${p.label} (${p.id})`,
                        description: p.plugins === '*'
                          ? 'All plugins (*)' + (p.usage ? ' · usage & telemetry' : '')
                          : (p.plugins.length ? `plugins: ${p.plugins.join(', ')}` : 'no plugins') + (p.usage ? ' · usage & telemetry' : ' · no telemetry'),
                      })),
                    ]}
                    value={capabilityProfile}
                    onChange={setCapabilityProfile}
                    placement="bottom"
                    searchable
                  />
                );
              })()}
              <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                Restricts plugin capabilities and usage telemetry for this conversation and its delegates.
              </div>
            </div>
            <div className="modal-field">
              <label className="modal-label">MCP servers</label>
              <SelectDropdown<McpSelectionMode>
                options={[
                  {
                    value: 'inherit',
                    label: 'Default (inherit from template)',
                    description: mcpView?.inherited && mcpView.inherited.length > 0
                      ? `Template default: ${mcpView.inherited.join(', ')}`
                      : 'No servers configured on template',
                  },
                  {
                    value: 'custom',
                    label: 'Custom selection',
                    description: 'Explicit list of MCP servers for this conversation',
                  },
                  {
                    value: 'none',
                    label: 'None (disable all)',
                    description: 'Do not inject any MCP servers into this conversation',
                  },
                ]}
                value={mcpMode}
                onChange={setMcpMode}
                placement="bottom"
              />

              {mcpMode === 'custom' && (
                <div style={{ marginTop: 8 }}>
                  <SelectDropdown
                    options={availableMcpServers.map((s) => ({
                      value: s.id,
                      label: s.id,
                      description: s.description || `${s.transport} server`,
                    }))}
                    multiple
                    value={customMcpServers}
                    onChange={setCustomMcpServers}
                    placeholder="Select MCP servers"
                    placement="bottom"
                    searchable
                  />
                </div>
              )}

              {/* Effective set preview */}
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border)',
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>
                  Effective MCP servers preview
                </div>
                {mcpView && mcpView.effective.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {mcpView.effective.map((eff) => (
                      <div key={eff.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 500, color: 'var(--text-1)' }}>{eff.id}</span>
                        {eff.injected ? (
                          <span
                            style={{
                              fontSize: 10,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: 'rgba(16, 185, 129, 0.15)',
                              color: 'var(--green, #10b981)',
                            }}
                          >
                            injected
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 10,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: 'rgba(239, 68, 68, 0.15)',
                              color: 'var(--red, #ef4444)',
                            }}
                          >
                            skipped
                          </span>
                        )}
                        {eff.reason && (
                          <span style={{ color: 'var(--text-3)', fontStyle: 'italic', fontSize: 11 }}>
                            {describeSkipReason(eff.reason)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>
                    {mcpView ? 'No MCP servers selected or effective.' : 'Loading effective servers…'}
                  </div>
                )}
                {mcpView?.delegating && (
                  <div style={{ marginTop: 6, color: 'var(--amber, #f59e0b)', fontSize: 11 }}>
                    Chat can delegate: servers without &ldquo;Allow in delegating chats&rdquo; will be skipped.
                  </div>
                )}
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>
                  Selection changes apply from the next turn.
                </div>
              </div>
            </div>
            {canMove && projects.length > 1 && (
              <div className="modal-field">
                <label className="modal-label">Project</label>
                <SelectDropdown
                  options={projects.map((p) => ({ value: p.id, label: p.name }))}
                  value={projectId}
                  onChange={setProjectId}
                  placement="bottom"
                  searchable
                />
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Moves this conversation and all its delegates. Future turns run in
                  the new project's root; existing code checkpoints stay in the old repo.
                </div>
              </div>
            )}
            {error && <div className="error">{error}</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="modal-btn primary">Save</button>
          </div>
        </form>
      </div>

      {previewOpen && templates.length > 0 && (
        <TemplatePreviewModal
          templates={templates}
          profileLabels={profileLabels}
          selectedTemplateName={template}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}
