import { useEffect, useMemo, useState } from 'react';
import {
  SANDBOX_SETTINGS_DEFAULTS,
  agentDisplayName,
  type RemoteHostView,
  type SandboxSettings as SandboxSettingsDoc,
} from '@tierwyn/shared';
import { api } from '../api.js';
import {
  SANDBOX_ALWAYS_BLOCKED,
  SANDBOX_FLEET_WIDE_CELL_LABEL,
  cellSetting,
  isFleetWideCell,
  sandboxCellDisableReason,
  setCell,
  type SandboxTriState,
} from '../sandboxControl.js';
import { SandboxPathList } from './SandboxPathList.js';

interface Props {
  remoteHosts: RemoteHostView[];
  onSaved?: (s: SandboxSettingsDoc) => void;
}

function cloneDoc(s: SandboxSettingsDoc): SandboxSettingsDoc {
  return {
    global: s.global,
    defaults: s.defaults
      .filter((r) => !isFleetWideCell(r.hostId, r.agentType))
      .map((r) => ({ ...r })),
    hostPaths: Object.fromEntries(
      Object.entries(s.hostPaths).map(([k, v]) => [k, v.map((p) => ({ ...p }))]),
    ),
  };
}

export function SandboxFleetWideCell() {
  return (
    <a
      className="sandbox-global-cell"
      href="#sandbox-global-default"
      title="This intersection is the Global default toggle above. A fleet-wide override is not stored."
    >
      {SANDBOX_FLEET_WIDE_CELL_LABEL}
    </a>
  );
}

function TriPills({
  value,
  onChange,
  disabledOn,
  title,
}: {
  value: SandboxTriState;
  onChange: (v: SandboxTriState) => void;
  disabledOn?: boolean;
  title?: string;
}) {
  const opts: { id: SandboxTriState; label: string }[] = [
    { id: 'inherit', label: 'Inherit' },
    { id: 'on', label: 'On' },
    { id: 'off', label: 'Off' },
  ];
  return (
    <div className={`sandbox-tri${title ? ' sandbox-tri-tipped' : ''}`} title={title}>
      {opts.map((o) => {
        const disable = o.id === 'on' && disabledOn;
        return (
          <button
            key={o.id}
            type="button"
            className={value === o.id ? 'selected' : ''}
            disabled={disable}
            aria-pressed={value === o.id}
            onClick={() => { if (!disable) onChange(o.id); }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SandboxSettings({ remoteHosts, onSaved }: Props) {
  const [settings, setSettings] = useState<SandboxSettingsDoc>(SANDBOX_SETTINGS_DEFAULTS);
  const [supportedAgents, setSupportedAgents] = useState<string[]>([]);
  const [hubAvailable, setHubAvailable] = useState<boolean | undefined>(undefined);
  const [showMatrix, setShowMatrix] = useState(false);
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [pathHostId, setPathHostId] = useState('hub');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.getSandboxSettings(), api.getSandboxSupport()])
      .then(([s, support]) => {
        if (cancelled) return;
        setSettings(cloneDoc(s));
        setSupportedAgents(support.supportedAgents);
        setHubAvailable(support.hubAvailable);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const hostRows = useMemo(
    () => [
      { id: '*', label: 'Any host' },
      { id: 'hub', label: 'Hub (local)' },
      ...remoteHosts.map((h) => ({ id: h.id, label: h.name || h.id })),
    ],
    [remoteHosts],
  );
  const agentCols = useMemo(
    () => [
      { id: '*', label: 'Any agent' },
      ...supportedAgents.map((t) => ({ id: t, label: agentDisplayName(t) })),
    ],
    [supportedAgents],
  );
  const cellCaps = {
    supportedAgents,
    hubAvailable,
    hosts: remoteHosts,
  };

  const persist = async (next: SandboxSettingsDoc) => {
    setError(null);
    try {
      const saved = await api.updateSandboxSettings(next);
      setSettings(cloneDoc(saved));
      onSaved?.(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setDefault = (hostId: string, agentType: string, value: SandboxTriState) => {
    void persist({ ...settings, defaults: setCell(settings.defaults, hostId, agentType, value) });
  };

  if (loading) {
    return <div className="settings-section"><div className="modal-hint">Loading sandbox settings…</div></div>;
  }

  return (
    <div className="settings-section sandbox-settings">
      <div className="settings-section-title">Sandbox</div>

      <div className={`settings-card${settings.global ? ' active' : ''}`}>
        <div className="settings-card-header">
          <div className="settings-card-title-group">
            <span className="settings-card-title">Global default</span>
          </div>
          <button
            type="button"
            id="sandbox-global-default"
            role="switch"
            aria-checked={settings.global}
            className={`toggle-switch${settings.global ? ' on' : ''}`}
            onClick={() => { void persist({ ...settings, global: !settings.global }); }}
            aria-label="Toggle global sandbox default"
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <div className="settings-card-body">
          <div className="modal-hint">
            Default sandbox state when not overridden by an agent, host, project, or conversation.
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-card-title-group">
            <span className="settings-card-title">Defaults</span>
          </div>
        </div>
        <div className="settings-card-body">
          <div className="sandbox-simple-block">
            <div className="sandbox-simple-label">Per Agent</div>
            <div className="modal-hint">Applies on every host unless a more specific cell is set.</div>
            {supportedAgents.map((agentType) => {
              const reason = sandboxCellDisableReason({ ...cellCaps, hostId: '*', agentType });
              return (
                <div key={agentType} className={`sandbox-simple-row${reason ? ' sandbox-cell-disabled' : ''}`}>
                  <span>{agentDisplayName(agentType)}</span>
                  <TriPills
                    value={cellSetting(settings.defaults, '*', agentType)}
                    onChange={(v) => setDefault('*', agentType, v)}
                    disabledOn={!!reason}
                    title={reason ?? undefined}
                  />
                </div>
              );
            })}
            {supportedAgents.length === 0 && (
              <div className="modal-hint">No sandbox-capable agents discovered yet.</div>
            )}
          </div>

          <div className="sandbox-simple-block">
            <div className="sandbox-simple-label">Per Host</div>
            <div className="modal-hint">Applies to every agent on that host unless a more specific cell is set.</div>
            {[{ id: 'hub', label: 'Hub (local)' }, ...remoteHosts.map((h) => ({ id: h.id, label: h.name || h.id }))].map((h) => {
              const reason = sandboxCellDisableReason({ ...cellCaps, hostId: h.id, agentType: '*' });
              return (
                <div key={h.id} className={`sandbox-simple-row${reason ? ' sandbox-cell-disabled' : ''}`}>
                  <span>{h.label}</span>
                  <TriPills
                    value={cellSetting(settings.defaults, h.id, '*')}
                    onChange={(v) => setDefault(h.id, '*', v)}
                    disabledOn={!!reason}
                    title={reason ?? undefined}
                  />
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className="modal-btn"
            onClick={() => setShowMatrix((v) => !v)}
          >
            {showMatrix ? 'Hide full host × agent matrix' : 'Show full host × agent matrix'}
          </button>

          {showMatrix && (
            <div className="sandbox-matrix-wrap">
              <table className="sandbox-matrix">
                <thead>
                  <tr>
                    <th>Host</th>
                    {agentCols.map((c) => <th key={c.id}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {hostRows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">{row.label}</th>
                      {agentCols.map((col) => {
                        if (isFleetWideCell(row.id, col.id)) {
                          return (
                            <td key={col.id}>
                              <SandboxFleetWideCell />
                            </td>
                          );
                        }
                        const reason = sandboxCellDisableReason({
                          ...cellCaps,
                          hostId: row.id,
                          agentType: col.id,
                        });
                        return (
                          <td
                            key={col.id}
                            className={reason ? 'sandbox-cell-disabled' : undefined}
                            title={reason ?? undefined}
                          >
                            <TriPills
                              value={cellSetting(settings.defaults, row.id, col.id)}
                              onChange={(v) => setDefault(row.id, col.id, v)}
                              disabledOn={!!reason}
                              title={reason ?? undefined}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-card-title-group">
            <span className="settings-card-title">Host custom paths</span>
          </div>
        </div>
        <div className="settings-card-body">
          <div className="modal-field">
            <label className="modal-label" htmlFor="sandbox-path-host">Host</label>
            <select
              id="sandbox-path-host"
              className="modal-input"
              value={pathHostId}
              onChange={(e) => setPathHostId(e.target.value)}
            >
              <option value="hub">Hub (local)</option>
              {remoteHosts.map((h) => (
                <option key={h.id} value={h.id}>{h.name || h.id}</option>
              ))}
            </select>
          </div>
          <SandboxPathList
            paths={settings.hostPaths[pathHostId] ?? []}
            onChange={(next) => {
              const hostPaths = { ...settings.hostPaths };
              if (next.length) hostPaths[pathHostId] = next;
              else delete hostPaths[pathHostId];
              void persist({ ...settings, hostPaths });
            }}
            note="Machine-wide extra binds for every sandboxed agent on this host. Merged with project custom paths."
          />
        </div>
      </div>

      <div className="modal-hint" style={{ margin: '12px 0' }}>
        Copilot token → Settings → Agents → Copilot → Environment (<code>COPILOT_GITHUB_TOKEN</code>).
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <button
            type="button"
            className="sandbox-disclosure"
            aria-expanded={blockedOpen}
            onClick={() => setBlockedOpen((v) => !v)}
          >
            <span className="settings-card-title">Always-blocked paths</span>
            <span aria-hidden>{blockedOpen ? '▾' : '▸'}</span>
          </button>
        </div>
        {blockedOpen && (
          <div className="settings-card-body">
            <div className="modal-hint">These paths can never be mounted as custom sandbox binds.</div>
            <ul className="sandbox-blocked-list">
              {SANDBOX_ALWAYS_BLOCKED.map((p) => <li key={p}><code>{p}</code></li>)}
            </ul>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
    </div>
  );
}
