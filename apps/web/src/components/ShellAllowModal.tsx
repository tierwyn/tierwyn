import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@tierwyn/shared';
import { isGrokBotProject } from '../remoteAgentsProfile.js';
import { api } from '../api.js';
import { Modal } from './Modal.js';

interface Props {
  project: Project;
  onClose: () => void;
}

/** Per-project shell allow-list editor. Base rules are read-only; project rules
 *  can be added/removed. Server enforces the no-interpreter invariant on add. */
export function ShellAllowModal({ project, onClose }: Props) {
  const isGrokBot = isGrokBotProject(project);
  const [base, setBase] = useState<string[][]>([]);
  const [projectRules, setProjectRules] = useState<{ id: string; rule: string[] }[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(isGrokBot ? 'Grok Bot does not support shell commands.' : null);
  const [loading, setLoading] = useState(!isGrokBot);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (isGrokBot) {
      setLoading(false);
      setError('Grok Bot does not support shell commands.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.getShellAllow(project.id);
      setBase(data.base);
      setProjectRules(data.project);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id, isGrokBot]);

  useEffect(() => { void load(); }, [load]);

  const addRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isGrokBot) {
      setError('Grok Bot does not support shell commands.');
      return;
    }
    const tokens = draft.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.addShellAllow(project.id, tokens);
      if (res.error || !res.rule) {
        setError(res.error ?? 'invalid rule');
        return;
      }
      setProjectRules((prev) => [...prev, res.rule!]);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (ruleId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.removeShellAllow(project.id, ruleId);
      setProjectRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Shell allow-list — ${project.name}`} onClose={onClose} className="shell-allow-modal">
      <p className="modal-help-text shell-allow-intro">
        Commands typed with <code>!</code> must match a base or project prefix rule.
        Shells and interpreters (bash, python, node, …) can never be allow-listed.
      </p>
      <p className="modal-help-text shell-allow-tip">
        Tip: a trailing <code>*</code> on the last word is a prefix wildcard —
        <code>npm run deploy*</code> matches <code>deploy</code>, <code>deploy:prod</code>,
        and <code>deploy:prod:full</code>. The <code>*</code> is only allowed at the very end.
      </p>

      {loading ? (
        <p className="shell-allow-loading">Loading…</p>
      ) : (
        <>
          <div className="modal-field">
            <span className="modal-label">Base (read-only)</span>
            <div className="shell-allow-chips">
              {base.map((rule, i) => (
                <span key={`base-${i}`} className="shell-allow-chip shell-allow-chip--base">
                  {rule.join(' ')}
                </span>
              ))}
            </div>
          </div>

          <div className="modal-field">
            <span className="modal-label">Project rules</span>
            {projectRules.length === 0 ? (
              <p className="shell-allow-empty">
                None yet — add a space-separated prefix below (e.g. <code>npm test</code>).
              </p>
            ) : (
              <div className="shell-allow-chips">
                {projectRules.map((r) => (
                  <span key={r.id} className="shell-allow-chip shell-allow-chip--project">
                    {r.rule.join(' ')}
                    <button
                      type="button"
                      className="shell-allow-chip-remove"
                      title="Remove rule"
                      disabled={busy}
                      onClick={() => { void removeRule(r.id); }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <form className="modal-field" onSubmit={(e) => { void addRule(e); }}>
            <label className="modal-label" htmlFor="shell-allow-add-rule">Add rule</label>
            <div className="shell-allow-add-row">
              <input
                id="shell-allow-add-rule"
                type="text"
                className="modal-input shell-allow-add-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. npm test"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="submit"
                className="modal-btn primary"
                disabled={busy || !draft.trim()}
              >
                Add
              </button>
            </div>
          </form>
        </>
      )}

      {error && (
        <p className="modal-field-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
