import { useEffect, useState, type FormEvent } from 'react';
import type { AgentSearchScopeSetting, Project, SandboxPath, SandboxSetting, SandboxSettings, UpdateProjectRequest } from '@tierwyn/shared';
import { api } from '../api.js';
import { MAX_PROJECT_NAME_LENGTH, splitProjectEdit, moveErrorMessage } from '../projectEdit.js';
import { projectSandboxInheritLabel } from '../sandboxControl.js';
import { SandboxPathList } from './SandboxPathList.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

interface Props {
  project: Project;
  onClose: () => void;
  onSaved: (updated: Project) => void;
  onOpenSandboxSettings?: () => void;
}

interface ConfirmMoveState {
  from: string;
  to: string;
  newRootPath: string;
  patch: UpdateProjectRequest | null;
}

interface RepointOfferState {
  newRootPath: string;
  patch: UpdateProjectRequest | null;
}

export function EditProjectModal({ project, onClose, onSaved, onOpenSandboxSettings }: Props) {
  const [name, setName] = useState(project.name);
  const [rootPath, setRootPath] = useState(project.rootPath);
  const [trustRepoConfig, setTrustRepoConfig] = useState(project.trustRepoConfig ?? false);
  const [sandbox, setSandbox] = useState<SandboxSetting | null>(project.sandbox ?? null);
  const [sandboxPaths, setSandboxPaths] = useState<SandboxPath[]>(project.sandboxPaths ?? []);
  const [sandboxSettings, setSandboxSettings] = useState<SandboxSettings | null>(null);
  const [agentSearchScope, setAgentSearchScope] = useState<AgentSearchScopeSetting | null>(project.agentSearchScope ?? null);
  const [globalSearchScope, setGlobalSearchScope] = useState<AgentSearchScopeSetting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmMove, setConfirmMove] = useState<ConfirmMoveState | null>(null);
  const [repointOffer, setRepointOffer] = useState<RepointOfferState | null>(null);
  const [repairWarning, setRepairWarning] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api.getSandboxSettings()
      .then((s) => { if (!cancelled) setSandboxSettings(s); })
      .catch(() => { /* inherit label falls back to global off */ });
    api.getGeneral()
      .then((g) => { if (!cancelled) setGlobalSearchScope(g.agentSearchScope ?? 'project'); })
      .catch(() => { /* inherit label falls back to This project */ });
    return () => { cancelled = true; };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setRepointOffer(null);
    setRepairWarning(null);

    const result = splitProjectEdit(project, { name, rootPath, trustRepoConfig, sandbox, sandboxPaths, agentSearchScope });
    if (!result.ok) { setError(result.error); return; }
    if (!result.patch && !result.newRootPath) { onClose(); return; }

    setSaving(true);
    try {
      if (!result.newRootPath) {
        // Name-only or non-path patch
        const updated = await api.updateProject(project.id, result.patch!);
        onSaved(updated);
        onClose();
        return;
      }

      // Preflight dryRun
      const pre = await api.moveProject(project.id, { rootPath: result.newRootPath, dryRun: true });
      if (pre.ok) {
        setConfirmMove({
          from: pre.body.from,
          to: pre.body.to,
          newRootPath: result.newRootPath,
          patch: result.patch,
        });
      } else {
        if (pre.code === 'exists' && !project.remoteHostId) {
          setRepointOffer({
            newRootPath: result.newRootPath,
            patch: result.patch,
          });
          setError('Something already exists at the new path.');
        } else if (pre.code === 'agents_active') {
          const list = pre.conversations?.map((c) => c.title).join(', ') ?? '';
          setError(list ? `Agents are working in this project (${list}). Stop them, then try again.` : 'Agents are working in this project. Stop them, then try again.');
        } else {
          setError(moveErrorMessage(pre.code, pre.error));
        }
      }
    } catch (err) {
      setError(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const executeMove = async () => {
    if (!confirmMove) return;
    setSaving(true);
    setError(null);
    try {
      const real = await api.moveProject(project.id, { rootPath: confirmMove.newRootPath });
      if (!real.ok) {
        setError(moveErrorMessage(real.code, real.error));
        return;
      }
      let finalProject = real.body.project;
      if (confirmMove.patch) {
        try {
          finalProject = await api.updateProject(project.id, confirmMove.patch);
        } catch (patchErr) {
          setError(`Folder moved, but name update failed: ${patchErr instanceof Error ? patchErr.message : String(patchErr)}`);
        }
      }
      onSaved(finalProject);
      if (real.body.repairWarning) {
        setRepairWarning(real.body.repairWarning);
      } else {
        onClose();
      }
    } catch (err) {
      setError(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const executeRepoint = async () => {
    if (!repointOffer) return;
    setSaving(true);
    setError(null);
    try {
      const patch: UpdateProjectRequest = {
        rootPath: repointOffer.newRootPath,
        ...(repointOffer.patch ?? {}),
      };
      const updated = await api.updateProject(project.id, patch);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(`Point project failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const pathTrimmed = rootPath.trim();
  const pathInvalid = pathTrimmed.length > 0 && !pathTrimmed.startsWith('/');

  const SANDBOX_OPTIONS: SelectDropdownOption<string>[] = [
    { value: '', label: projectSandboxInheritLabel(sandboxSettings?.global === true, sandboxSettings?.defaults.length ?? 0) },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];
  const SEARCH_LABEL: Record<AgentSearchScopeSetting, string> = {
    off: 'Off',
    project: 'This project',
    all: 'All projects',
  };
  const SEARCH_OPTIONS: SelectDropdownOption<string>[] = [
    { value: '', label: `Inherit (${SEARCH_LABEL[globalSearchScope ?? 'project']})` },
    { value: 'off', label: 'Off' },
    { value: 'project', label: 'This project' },
    { value: 'all', label: 'All projects' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form
        className="modal-content modal-content--roomy"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">Edit Project</div>
        <div className="modal-body">
          {confirmMove ? (
            <div className="modal-confirm-move" style={{ padding: '8px 0' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Move folder</div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.9em', wordBreak: 'break-all', lineHeight: 1.5 }}>
                {confirmMove.from}
                <br />
                → {confirmMove.to}
              </div>
              <div style={{ marginTop: 12, fontSize: '0.9em', opacity: 0.85, lineHeight: 1.4 }}>
                All contents move with it. Existing conversations may lose native agent resume and continue from the transcript.
              </div>
              {repairWarning && (
                <div className="warning" style={{ color: 'var(--color-warning, #f59e0b)', marginTop: 12, fontSize: '0.9em' }}>
                  {repairWarning}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="modal-field">
                <label className="modal-label">Name</label>
                <input
                  type="text"
                  className="modal-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={MAX_PROJECT_NAME_LENGTH}
                  required
                  autoFocus
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Working directory</label>
                <input
                  type="text"
                  className="modal-input"
                  value={rootPath}
                  onChange={(e) => setRootPath(e.target.value)}
                  placeholder="/absolute/path/to/project"
                  required
                />
                {pathInvalid && (
                  <div className="modal-field-error">Path must be absolute (start with /)</div>
                )}
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Changing this moves the project folder to the new path. Not allowed while agents are working in this project.
                </div>
              </div>
              <div className="modal-field modal-field-row" style={{ marginTop: 12 }}>
                <div>
                  <span className="modal-label">Trust repository configuration</span>
                  <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                    Allows agents to execute repo-level config (.claude/settings.json hooks, .mcp.json, .cursor/mcp.json, OpenCode plugins). Leave disabled for untrusted repositories. When disabled, Cursor is refused, and Claude Code ignores project CLAUDE.md, .mcp.json, and repo hooks.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={trustRepoConfig}
                  aria-label="Trust repository configuration"
                  className={`toggle-switch${trustRepoConfig ? ' on' : ''}`}
                  onClick={() => setTrustRepoConfig((v) => !v)}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
              <div className="modal-field" style={{ marginTop: 12 }}>
                <span className="modal-label">Agent sandbox</span>
                <SelectDropdown<string>
                  options={SANDBOX_OPTIONS}
                  value={sandbox ?? ''}
                  onChange={(v) => {
                    setSandbox(v === '' ? null : (v as SandboxSetting));
                  }}
                  placement="bottom"
                />
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Runs agents in a bubblewrap sandbox (own CLI config, project dir and caches only). Conversations can override. Takes effect on the next agent process.
                  {onOpenSandboxSettings && (
                    <>
                      {' '}
                      <button type="button" className="sandbox-inline-link" onClick={onOpenSandboxSettings}>
                        Open Sandbox settings
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="modal-field" style={{ marginTop: 12 }}>
                <span className="modal-label">Agent history search</span>
                <SelectDropdown<string>
                  options={SEARCH_OPTIONS}
                  value={agentSearchScope ?? ''}
                  onChange={(v) => {
                    setAgentSearchScope(v === '' ? null : (v as AgentSearchScopeSetting));
                  }}
                  placement="bottom"
                />
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Lets agents search past conversations. &quot;All projects&quot; never applies while the agent is sandboxed or on a remote host — it is capped to this project. Takes effect on the agent's next search; the preamble updates next turn.
                </div>
              </div>
              <div className="modal-field" style={{ marginTop: 12 }}>
                <label>Project custom paths</label>
                <SandboxPathList
                  paths={sandboxPaths}
                  onChange={setSandboxPaths}
                  note="Merged with host-level custom paths for the host this project runs on."
                />
              </div>
              {repointOffer && (
                <div style={{ marginTop: 8, padding: 10, background: 'var(--bg-subtle, rgba(255,255,255,0.05))', borderRadius: 4 }}>
                  <div style={{ fontSize: '0.9em' }}>
                    A folder already exists at that path. Point the project at it instead (no move)?
                  </div>
                  <button
                    type="button"
                    className="modal-btn"
                    style={{ marginTop: 8 }}
                    disabled={saving}
                    onClick={executeRepoint}
                  >
                    {saving ? 'Saving…' : 'Use existing folder'}
                  </button>
                </div>
              )}
            </>
          )}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer">
          {confirmMove ? (
            repairWarning ? (
              <button type="button" className="modal-btn primary" onClick={onClose}>
                Close
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="modal-btn"
                  disabled={saving}
                  onClick={() => { setConfirmMove(null); setRepairWarning(null); }}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="modal-btn primary"
                  disabled={saving}
                  onClick={executeMove}
                >
                  {saving ? 'Moving…' : 'Move folder'}
                </button>
              </>
            )
          ) : (
            <>
              <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
              <button
                type="submit"
                className="modal-btn primary"
                disabled={saving || !name.trim() || !pathTrimmed.startsWith('/')}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
