import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Project, RulePreset } from '@tierwyn/shared';
import { api } from '../api.js';
import {
  RULES_MAX_BYTES,
  RULE_PRESETS_MAX_PER_LAYER,
  rulesByteLength,
  notifyRulePresetsChanged,
  RULE_PRESETS_CHANGED_EVENT,
} from '../operatorRules.js';
import {
  assignedProjectIds,
  planProjectAssignments,
  projectHasPreset,
} from '../rulePresetAssignment.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Modal } from './Modal.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

interface Props {
  projects?: Project[];
}

export type PresetSaveMeta = {
  updatedProjects: Project[];
};

function usableProjects(list: Project[] | undefined): Project[] {
  return (list ?? []).filter((p) => !p.system);
}

export function RulePresetEditorModal({
  projects: initialProjects,
  existing,
  defaultProjectId,
  onClose,
  onSaved,
}: {
  projects?: Project[];
  existing: RulePreset | null;
  defaultProjectId?: string | null;
  onClose: () => void;
  onSaved: (preset: RulePreset, meta?: PresetSaveMeta) => void;
}) {
  const seed = usableProjects(initialProjects);
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [content, setContent] = useState(existing?.content ?? '');
  const [scope, setScope] = useState<'global' | 'project'>(existing?.projectId ? 'project' : 'global');
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    existing?.projectId ?? defaultProjectId ?? seed[0]?.id ?? '',
  );
  const [projects, setProjects] = useState<Project[]>(seed);
  const [applyToProjectIds, setApplyToProjectIds] = useState<string[]>(
    existing && !existing.projectId ? assignedProjectIds(seed, existing.id) : [],
  );
  const [applyAtProjectLevel, setApplyAtProjectLevel] = useState(() => {
    if (!existing?.projectId) return true;
    const target = seed.find((p) => p.id === existing.projectId);
    return target ? projectHasPreset(target, existing.id) : false;
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const createdRef = useRef<RulePreset | null>(null);
  const [created, setCreated] = useState<RulePreset | null>(null);
  const locked = existing ?? created;

  useEffect(() => {
    let cancelled = false;
    void api.listProjects().then((list) => {
      if (cancelled) return;
      const nonSystem = usableProjects(list);
      setProjects(nonSystem);
      setSelectedProjectId((current) => current || nonSystem[0]?.id || '');
      if (existing) {
        if (existing.projectId) {
          const target = nonSystem.find((p) => p.id === existing.projectId);
          setApplyAtProjectLevel(target ? projectHasPreset(target, existing.id) : false);
        } else {
          setApplyToProjectIds(assignedProjectIds(nonSystem, existing.id));
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [existing]);

  const bytes = rulesByteLength(content.trim());
  const over = bytes > RULES_MAX_BYTES;
  const isProjectScope = locked ? !!locked.projectId : scope === 'project';
  const targetProjectId = locked?.projectId ?? selectedProjectId;
  const targetProject = projects.find((p) => p.id === targetProjectId);
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const projectOptions: SelectDropdownOption[] = useMemo(() => projects.map((p) => {
    const count = p.rulePresetIds?.length ?? 0;
    const already = locked ? projectHasPreset(p, locked.id) : false;
    const atCap = !already && count >= RULE_PRESETS_MAX_PER_LAYER;
    return {
      value: p.id,
      label: p.name,
      description: atCap
        ? `Already has ${RULE_PRESETS_MAX_PER_LAYER} presets`
        : (count ? `${count} preset${count === 1 ? '' : 's'} attached` : undefined),
    };
  }), [projects, locked]);

  const folderCapBlocked = !!targetProject
    && !(locked && projectHasPreset(targetProject, locked.id))
    && (targetProject.rulePresetIds?.length ?? 0) >= RULE_PRESETS_MAX_PER_LAYER;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (over || !name.trim() || !content.trim()) return;
    if (isProjectScope && !targetProjectId) {
      setError('Please select a project');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let preset: RulePreset;
      const already = existing ?? createdRef.current;
      if (already) {
        preset = await api.updateRulePreset(already.id, {
          name: name.trim(),
          description: description.trim() || null,
          content: content.trim(),
        });
      } else {
        preset = await api.createRulePreset({
          name: name.trim(),
          description: description.trim() || undefined,
          content: content.trim(),
          projectId: isProjectScope ? targetProjectId : undefined,
        });
        createdRef.current = preset;
        setCreated(preset);
      }

      const wantFolder = applyAtProjectLevel && !folderCapBlocked;
      const plan = isProjectScope
        ? planProjectAssignments(
            targetProject ? [targetProject] : [],
            preset.id,
            wantFolder ? [targetProjectId] : [],
          )
        : planProjectAssignments(projects, preset.id, applyToProjectIds);
      if (!plan.ok) {
        setError(plan.error);
        return;
      }

      const updatedProjects: Project[] = [];
      for (const patch of plan.patches) {
        updatedProjects.push(await api.updateProject(patch.projectId, { rulePresetIds: patch.rulePresetIds }));
      }
      onSaved(preset, { updatedProjects });
      notifyRulePresetsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={existing ? `Edit preset — ${existing.name}` : 'New preset'}
      onClose={onClose}
      overlayClassName="modal-overlay--stack-2"
      footer={
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            form="preset-form"
            className="modal-btn primary"
            disabled={saving || over || !name.trim() || !content.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <form id="preset-form" onSubmit={submit}>
        <div className="modal-field">
          <label className="modal-label" htmlFor="preset-name">Name</label>
          <input
            id="preset-name"
            className="modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
          />
        </div>
        <div className="modal-field">
          <label className="modal-label" htmlFor="preset-desc">Description (not injected)</label>
          <input
            id="preset-desc"
            className="modal-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
          />
        </div>
        {locked ? (
          <div className="modal-field">
            <span className="modal-label">Scope</span>
            <div className="modal-static-value">
              {locked.projectId
                ? `Project-specific — ${projectsById.get(locked.projectId)?.name ?? 'Unknown project'}`
                : 'Global (available to all projects)'}
            </div>
          </div>
        ) : (
          <div className="modal-field">
            <label className="modal-label">Scope</label>
            <SelectDropdown<'global' | 'project'>
              options={[
                { value: 'global', label: 'Global (available to all projects)', description: 'Can be added to any project or conversation' },
                { value: 'project', label: 'Project-specific', description: 'Available only within the chosen project' },
              ]}
              value={scope}
              onChange={(val) => setScope(val)}
            />
          </div>
        )}
        {!isProjectScope && (
          <div className="modal-field">
            <label className="modal-label">Apply to projects</label>
            <SelectDropdown
              multiple
              options={projectOptions}
              value={applyToProjectIds}
              searchable={projects.length > 5}
              placeholder="None — catalogue only"
              onChange={setApplyToProjectIds}
            />
            <div className="modal-hint">
              Optional. Selected projects get this preset at the folder level (all conversations). Leave empty to keep it catalogue-only.
            </div>
          </div>
        )}
        {!locked && isProjectScope && (
          <div className="modal-field">
            <label className="modal-label">Target project</label>
            <SelectDropdown
              options={projectOptions}
              value={selectedProjectId}
              searchable={projects.length > 5}
              onChange={(val) => setSelectedProjectId(val)}
            />
          </div>
        )}
        {isProjectScope && (
          <div className="modal-field">
            <label className="toggle-setting-label" style={{ marginRight: 0, alignSelf: 'flex-start' }}>
              <input
                type="checkbox"
                checked={applyAtProjectLevel && !folderCapBlocked}
                disabled={folderCapBlocked && !applyAtProjectLevel}
                onChange={(e) => setApplyAtProjectLevel(e.target.checked)}
              />
              Apply to all conversations in this project
            </label>
            <div className="modal-hint">
              {folderCapBlocked
                ? `This project already has ${RULE_PRESETS_MAX_PER_LAYER} presets at the folder layer — keep this catalogue-only and attach it to specific conversations as needed.`
                : 'Attaches this preset to the project folder. Uncheck to keep it catalogue-only and assign it to specific conversations as needed.'}
            </div>
          </div>
        )}
        <div className="modal-field">
          <label className="modal-label" htmlFor="preset-content">Content</label>
          <textarea
            id="preset-content"
            className="modal-input rules-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            spellCheck={false}
          />
          <div className={`modal-hint${over ? ' rules-over' : ''}`}>
            {bytes} / {RULES_MAX_BYTES} bytes
          </div>
        </div>
        {error && <div className="error">{error}</div>}
      </form>
    </Modal>
  );
}

export function RulePresetsSettings({ projects: passedProjects }: Props) {
  const [presets, setPresets] = useState<RulePreset[]>([]);
  const [projects, setProjects] = useState<Project[]>(passedProjects ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: 'new' } | { mode: 'edit'; preset: RulePreset } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RulePreset | null>(null);
  const [filterScope, setFilterScope] = useState<string>('all');

  const loadData = () => {
    setLoading(true);
    Promise.all([
      api.listRulePresets(),
      passedProjects && passedProjects.length > 0 ? Promise.resolve(passedProjects) : api.listProjects(),
    ])
      .then(([presetList, projectList]) => {
        setPresets(presetList.sort((a, b) => a.name.localeCompare(b.name)));
        setProjects(projectList.filter((p) => !p.system));
        setError(null);
      })
      .catch((err) => {
        setError(`Failed to load presets: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    loadData();
    const handlePresetsChanged = () => {
      loadData();
    };
    window.addEventListener(RULE_PRESETS_CHANGED_EVENT, handlePresetsChanged);
    return () => window.removeEventListener(RULE_PRESETS_CHANGED_EVENT, handlePresetsChanged);
  }, []);

  const projectsById = new Map(projects.map((p) => [p.id, p]));

  const filteredPresets = presets.filter((p) => {
    if (filterScope === 'all') return true;
    if (filterScope === 'global') return !p.projectId;
    return p.projectId === filterScope;
  });

  return (
    <div className="settings-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div className="modal-hint" style={{ margin: 0, maxWidth: 480 }}>
          Shared, reusable operator instructions that can be stacked onto projects and conversations.
        </div>
        <button
          type="button"
          className="modal-btn primary"
          onClick={() => setEditor({ mode: 'new' })}
        >
          New Preset
        </button>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span className="modal-label" style={{ margin: 0, flexShrink: 0 }}>Filter by scope:</span>
        <div style={{ minWidth: 240 }}>
          <SelectDropdown
            options={[
              { value: 'all', label: `All scopes (${presets.length})` },
              { value: 'global', label: `Global only (${presets.filter((p) => !p.projectId).length})` },
              ...projects.map((proj) => ({
                value: proj.id,
                label: `${proj.name} (${presets.filter((p) => p.projectId === proj.id).length})`,
              })),
            ]}
            value={filterScope}
            searchable={projects.length > 5}
            onChange={(val) => setFilterScope(val)}
          />
        </div>
      </div>

      {loading ? (
        <div className="modal-hint">Loading rule presets…</div>
      ) : filteredPresets.length === 0 ? (
        <div className="settings-card active">
          <div className="settings-card-body" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <div className="modal-hint">
              {presets.length === 0
                ? 'No rule presets created yet. Click "New Preset" above to create your first reusable instruction set.'
                : 'No rule presets match the selected filter.'}
            </div>
          </div>
        </div>
      ) : (
        <div className="settings-card active">
          <ul className="rules-preset-manage" style={{ margin: 0, padding: 0 }}>
            {filteredPresets.map((p) => {
              const proj = p.projectId ? projectsById.get(p.projectId) : null;
              const scopeLabel = p.projectId
                ? `Project: ${proj ? proj.name : 'Unknown project'}`
                : 'Global (all projects)';

              return (
                <li key={p.id} className="rules-preset-manage-row" style={{ padding: '12px 16px' }}>
                  <div style={{ flex: 1, minWidth: 0, marginRight: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: '14px' }}>{p.name}</strong>
                      <span
                        className="modal-hint"
                        style={{
                          fontSize: '11px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: p.projectId ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                          border: `1px solid ${p.projectId ? 'rgba(59, 130, 246, 0.25)' : 'rgba(16, 185, 129, 0.25)'}`,
                        }}
                      >
                        {scopeLabel}
                      </span>
                    </div>
                    {p.description && (
                      <div className="modal-hint" style={{ marginTop: 4 }}>
                        {p.description}
                      </div>
                    )}
                    <div className="modal-hint" style={{ marginTop: 4, fontSize: '11px' }}>
                      {rulesByteLength(p.content)} bytes
                      {p.usage ? ` · Attached to ${p.usage.projects} project(s), ${p.usage.conversations} conversation(s)` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => setEditor({ mode: 'edit', preset: p })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => setPendingDelete(p)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {editor && (
        <RulePresetEditorModal
          projects={projects}
          existing={editor.mode === 'edit' ? editor.preset : null}
          defaultProjectId={filterScope !== 'all' && filterScope !== 'global' ? filterScope : undefined}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            setPresets((list) => {
              const i = list.findIndex((x) => x.id === saved.id);
              if (i === -1) return [...list, saved].sort((a, b) => a.name.localeCompare(b.name));
              const next = [...list];
              next[i] = saved;
              return next;
            });
            setEditor(null);
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete preset"
          danger
          body={`Delete preset "${pendingDelete.name}"? It is currently attached to ${pendingDelete.usage?.projects ?? 0} project(s) and ${pendingDelete.usage?.conversations ?? 0} conversation(s) — they will lose this preset.`}
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          overlayClassName="modal-overlay--stack-2"
          onConfirm={() => {
            const id = pendingDelete.id;
            void api.deleteRulePreset(id).then(() => {
              setPresets((list) => list.filter((p) => p.id !== id));
              setPendingDelete(null);
              notifyRulePresetsChanged();
            }).catch((err) => {
              setError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
              setPendingDelete(null);
            });
          }}
        />
      )}
    </div>
  );
}
