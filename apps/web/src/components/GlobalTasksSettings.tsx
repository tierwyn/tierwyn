import { useEffect, useState, useCallback } from 'react';
import type { GlobalTasksSettings, GlobalTaskCounts } from '@tierwyn/shared';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface Props {
  /** Lifts every loaded/saved settings row into App (header icon visibility). */
  onChanged?: (s: GlobalTasksSettings) => void;
}

export function GlobalTasksSettings({ onChanged }: Props) {
  const [settings, setSettings] = useState<GlobalTasksSettings | null>(null);
  const [counts, setCounts] = useState<GlobalTaskCounts>({
    inProgress: 0,
    completedVisible: 0,
    hidden: 0,
  });
  const [showDeleteHiddenConfirm, setShowDeleteHiddenConfirm] = useState(false);
  const [busyDelete, setBusyDelete] = useState(false);
  const [staleDraft, setStaleDraft] = useState<string>('');
  const [autoDeleteDraft, setAutoDeleteDraft] = useState<string>('');

  const loadData = useCallback(() => {
    api.globalTasksSettings().then((s) => {
      setSettings(s);
      onChanged?.(s);
      if (s) {
        setStaleDraft(String(s.staleAfterHours));
        setAutoDeleteDraft(String(s.autoDeleteHiddenAfterDays));
        if (s.enabled) {
          api.globalTaskCount().then(setCounts).catch(() => {});
        }
      }
    }).catch(() => {});
  }, [onChanged]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const updateSetting = async (patch: Partial<GlobalTasksSettings>) => {
    try {
      const updated = await api.saveGlobalTasksSettings(patch);
      setSettings(updated);
      setStaleDraft(String(updated.staleAfterHours));
      setAutoDeleteDraft(String(updated.autoDeleteHiddenAfterDays));
      onChanged?.(updated);
    } catch (err) {
      console.error('Failed to save global tasks settings:', err);
    }
  };

  const commitStaleHours = () => {
    const val = parseInt(staleDraft, 10);
    if (!isNaN(val) && val >= 0 && val <= 8760 && val !== settings?.staleAfterHours) {
      void updateSetting({ staleAfterHours: val });
    } else if (settings) {
      setStaleDraft(String(settings.staleAfterHours));
    }
  };

  const commitAutoDeleteDays = () => {
    const val = parseInt(autoDeleteDraft, 10);
    if (!isNaN(val) && val >= 0 && val <= 3650 && val !== settings?.autoDeleteHiddenAfterDays) {
      void updateSetting({ autoDeleteHiddenAfterDays: val });
    } else if (settings) {
      setAutoDeleteDraft(String(settings.autoDeleteHiddenAfterDays));
    }
  };

  const handleDeleteAllHidden = async () => {
    if (busyDelete) return;
    setBusyDelete(true);
    try {
      await api.deleteHiddenGlobalTasks();
      setShowDeleteHiddenConfirm(false);
      api.globalTaskCount().then(setCounts).catch(() => {});
    } catch (err) {
      console.error('Failed to delete hidden tasks:', err);
    } finally {
      setBusyDelete(false);
    }
  };

  if (!settings) {
    return (
      <div className="settings-pane-loading" style={{ padding: '24px 0', color: 'var(--text-3)' }}>
        Loading settings…
      </div>
    );
  }

  return (
    <div>
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-card-title-group">
            <span className="settings-card-title">Global Tasks</span>
          </div>
        </div>
        <div className="settings-card-body" style={{ gap: 14 }}>
          <div className="modal-field modal-field-row">
            <div>
              <span className="modal-label">Enable global task log</span>
              <div style={{ fontSize: '12px', color: 'var(--text-3)', marginTop: 2 }}>
                When on, agents get a short preamble block and tasks appear in the header modal. Turning it off hides the header icon, blocks the tasks API (agent and operator) immediately, and drops the preamble block from each conversation&apos;s next turn. Existing rows are kept and reappear when re-enabled.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.enabled}
              className={`toggle-switch${settings.enabled ? ' on' : ''}`}
              onClick={() => void updateSetting({ enabled: !settings.enabled })}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          <div className="modal-field">
            <span className="modal-label">Who records tasks</span>
            <select
              className="modal-select gt-ctl"
              value={settings.scope}
              onChange={(e) => void updateSetting({ scope: e.target.value as 'roots' | 'all' })}
            >
              <option value="roots">Top-level conversations and schedule runs only (recommended)</option>
              <option value="all">All conversations including sub-agents</option>
            </select>
            <div style={{ fontSize: '12px', color: 'var(--text-3)', marginTop: 2 }}>
              Schedule runs count as top-level — the schedule is a container, not a parent agent. Sub-agents normally report to their parent through ## Result, and the parent updates its own task.
            </div>
          </div>

          <div className="modal-field">
            <span className="modal-label">Mark in-progress tasks stale after (hours)</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                className="modal-input"
                min={0}
                max={8760}
                style={{ width: 100 }}
                value={staleDraft}
                onChange={(e) => setStaleDraft(e.target.value)}
                onBlur={commitStaleHours}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>hours (0 = never)</span>
            </div>
          </div>

          <div className="modal-field">
            <span className="modal-label">Auto-delete hidden tasks after (days)</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                className="modal-input"
                min={0}
                max={3650}
                style={{ width: 100 }}
                value={autoDeleteDraft}
                onChange={(e) => setAutoDeleteDraft(e.target.value)}
                onBlur={commitAutoDeleteDays}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>days (0 = keep forever)</span>
            </div>
          </div>
        </div>
      </div>

      {settings.enabled ? (
        <div className="settings-card" style={{ marginTop: 16 }}>
          <div className="settings-card-header">
            <div className="settings-card-title-group">
              <span className="settings-card-title">Task Stats &amp; Maintenance</span>
            </div>
          </div>
          <div className="settings-card-body" style={{ gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ fontSize: '13px', color: 'var(--text-2)' }}>
                In progress <b>{counts.inProgress}</b> · Completed <b>{counts.completedVisible}</b> · Hidden <b>{counts.hidden}</b>
              </div>
              <button
                type="button"
                className="gt-act gt-act--danger"
                disabled={counts.hidden === 0 || busyDelete}
                onClick={() => setShowDeleteHiddenConfirm(true)}
              >
                🗑 Delete all hidden now
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="settings-card" style={{ marginTop: 16 }}>
          <div className="settings-card-body" style={{ gap: 14 }}>
            <div style={{ fontSize: '13px', color: 'var(--text-3)' }}>
              Global tasks are disabled — the header icon is hidden and the tasks API is turned away (403). Existing rows are kept and reappear when re-enabled.
            </div>
          </div>
        </div>
      )}

      {showDeleteHiddenConfirm && (
        <ConfirmDialog
          title="Delete All Hidden Tasks"
          body="Permanently delete all hidden tasks across all projects? This cannot be undone."
          confirmLabel="Delete all"
          danger
          busy={busyDelete}
          onConfirm={handleDeleteAllHidden}
          onCancel={() => setShowDeleteHiddenConfirm(false)}
        />
      )}
    </div>
  );
}
