import { copyText } from '../clipboard';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { hostHasFeature, type RemoteHostState, type RemoteHostView } from '@tierwyn/shared';
import { api } from '../api.js';
import { pickOneLiner, remoteSelectableTypes, withAgentFlags } from '../remoteHostsOneLiner.js';
import {
  agentLoginAvailable, descriptionPatch, hostDeleteConfirm, inFlightLogins, loginAgentLabel, loginFor, loginResumeKey, loginResumeMessage,
  notLoggedInTitle, remoteHostAgentRows, remoteUpdateAction, shouldShowLoginModal, shouldShowLoginResume,
  type RemoteHostAgentRow,
} from '../remoteHostAgents.js';
import { AgentLoginModalFor } from './AgentLoginModalFor.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SelectDropdown } from './SelectDropdown.js';
import { sidecarAdvisoryText, type SidecarHostAdvisory } from '../sidecarAdvisoryText.js';
import { installSourceLabel } from '../remoteHostInstallLabel.js';

function hostAdvisories(host: RemoteHostView): SidecarHostAdvisory[] {
  return (host as RemoteHostView & { sidecarAdvisories?: SidecarHostAdvisory[] }).sidecarAdvisories ?? [];
}

const INSTALL_COPY =
  'Pick agents for the enrollment one-liner, or later run tierwyn node allow <agent>… on the host. Then use Install ▸ here. When an install finishes, log in on the box (claude login, codex login, …) and hit Refresh.';

export function upsertHost(list: RemoteHostView[], host: RemoteHostView): RemoteHostView[] {
  const i = list.findIndex((h) => h.id === host.id);
  if (i < 0) return [...list, host];
  const next = list.slice();
  next[i] = host;
  return next;
}

function dotClass(state: RemoteHostState): string {
  if (state === 'connected') return 'status-dot done';
  if (state === 'untrusted') return 'status-dot waiting';
  if (state === 'disabled') return 'status-dot disabled';
  return 'status-dot grey';
}

function AgentCell({ host, busy, onInstall, onLogin }: {
  host: RemoteHostView;
  busy: boolean;
  onInstall: (hostId: string, agentType: string) => void;
  onLogin: (hostId: string, agentType: string) => void;
}): ReactNode {
  const rows = remoteHostAgentRows(host);
  if (!rows.length) return <span className="rh-chip muted">—</span>;
  const loginChip = (row: RemoteHostAgentRow) => (
    <button
      type="button"
      className="rh-chip install"
      disabled={busy}
      title={row.type === 'claude-code' ? 'Log in to Claude on this host'
        : row.type === 'codex' ? 'Log in to ChatGPT for Codex on this host'
        : `Log in to ${loginAgentLabel(row.type)} on this host`}
      onClick={() => onLogin(host.id, row.type)}
    >
      {row.type} · Log in ▸
    </button>
  );
  return (
    <div className="rh-agents">
      {rows.map((row) => {
        if (loginFor(host, row.type)?.running) {
          return (
            <span key={row.type} className="rh-chip installing" title={row.type === 'claude-code' ? 'Waiting for Claude authorization' : row.type === 'codex' ? 'Waiting for ChatGPT authorization' : `Waiting for ${loginAgentLabel(row.type)} authorization`}>
              {row.type} · logging in…
            </span>
          );
        }
        if (row.state === 'installing') {
          return (
            <span key={row.type} className="rh-chip installing" title="Install running on the host">
              {row.type} · installing…
            </span>
          );
        }
        if (row.state === 'queued') {
          return (
            <span key={row.type} className="rh-chip installing" title="Waiting in the install-all queue">
              {row.type} · queued
            </span>
          );
        }
        if (row.state === 'ready' || row.state === 'not_logged_in') {
          const versionTitle = [
            row.version ? `installed v${row.version}` : undefined,
            row.latestVersion ? `latest ${row.latestVersion}` : undefined,
            row.behind ? 'update available' : undefined,
          ].filter(Boolean).join(' · ') || undefined;
          // Recent settled install → success feedback for a short window.
          const justInstalled = row.lastOkAt !== undefined && Date.now() - row.lastOkAt < 120_000;
          if (justInstalled) {
            return (
              <span key={row.type} className="rh-chip ready" title={versionTitle ?? 'last install ok'}>
                {row.type} · updated ✓
              </span>
            );
          }
          const action = remoteUpdateAction(row);
          if (!row.installable || action === null) {
            // Known current (behind === false) renders the same plain chip as
            // non-installable agents — no Update button for a current version.
            if (row.state === 'ready') {
              return <span key={row.type} className="rh-chip ready" title={versionTitle}>{row.type}{row.version ? ` · v${row.version}` : ''}</span>;
            }
            if (agentLoginAvailable(host, row.type)) {
              return <span key={row.type}>{loginChip(row)}</span>;
            }
            return (
              <span key={row.type} className="rh-chip warn" title={notLoggedInTitle(row.type)}>
                {row.type} · not logged in
              </span>
            );
          }
          const actionLabel = action === 'update' ? 'Update ▸' : 'Reinstall ▸';
          const actionTitle = action === 'update'
            ? `Update ${row.type} on the host${versionTitle ? ` — ${versionTitle}` : ''}`
            : `Re-run the ${row.type} installer on the host (pulls latest) — ${row.latestVersion ? 'host did not report a comparable version' : 'no published version to compare'}`;
          if (row.state === 'not_logged_in') {
            // Keep the login warning visible next to the Update affordance —
            // the chip alone would hide that the agent is currently unusable.
            return (
              <span key={row.type} className="rh-chip-row">
                <button
                  type="button"
                  className="rh-chip install"
                  disabled={busy}
                  title={`not logged in — ${notLoggedInTitle(row.type)}; click to ${action}`}
                  onClick={() => onInstall(host.id, row.type)}
                >
                  {row.type}{row.version ? ` · v${row.version}` : ''} · {actionLabel}
                </button>
                {agentLoginAvailable(host, row.type)
                  ? loginChip(row)
                  : (
                    <span className="rh-chip warn" title={notLoggedInTitle(row.type)}>
                      not logged in
                    </span>
                  )}
              </span>
            );
          }
          return (
            <button
              key={row.type}
              type="button"
              className="rh-chip install"
              disabled={busy}
              title={actionTitle}
              onClick={() => onInstall(host.id, row.type)}
            >
              {row.type}{row.version ? ` · v${row.version}` : ''} · {actionLabel}
            </button>
          );
        }
        if (!row.installable) {
          return (
            <span key={row.type} className="rh-chip muted" title="No install command on the node — install it manually">
              {row.type} · not installed (manual)
            </span>
          );
        }
        return (
          <button
            key={row.type}
            type="button"
            className="rh-chip install"
            disabled={busy}
            title={`Install ${row.type} on the host`}
            onClick={() => onInstall(host.id, row.type)}
          >
            {row.type} · Install ▸
          </button>
        );
      })}
    </div>
  );
}

function updateStatus(host: RemoteHostView): ReactNode {
  const u = host.update;
  if (!u) return null;
  if (u.running) return <div className="rh-update-status">Node update running…</div>;
  if (u.ok) {
    const { id } = installSourceLabel({
      ...host.hello,
      gitSha: host.hello.gitSha || u.fromSha || '',
    });
    return <div className="rh-update-status">Node updated to {id === '—' ? 'unknown' : id}</div>;
  }
  if (u.tail) return <div className="rh-update-status">{u.tail}</div>;
  return null;
}

function installFailures(host: RemoteHostView): ReactNode {
  const failed = remoteHostAgentRows(host).filter((r) => r.lastError !== undefined);
  if (!failed.length) return null;
  return (
    <>
      {failed.map((r) => (
        <div key={r.type} className="rh-install-error">
          <strong>{r.type}</strong> install failed: {r.lastError}
          {r.tail ? <details><summary>output</summary><pre className="rh-install-tail">{r.tail}</pre></details> : null}
        </div>
      ))}
    </>
  );
}

function hostMeta(host: RemoteHostView): string {
  return [host.hello.hostname, host.hello.os, host.hello.arch].filter(Boolean).join(' · ') || '—';
}

interface Props {
  hosts: RemoteHostView[];
  onHostsChange: React.Dispatch<React.SetStateAction<RemoteHostView[]>>;
}

export function RemoteHostsSettings({ hosts, onHostsChange }: Props) {
  const [name, setName] = useState('');
  const [autoTrust, setAutoTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [descEdit, setDescEdit] = useState<{ id: string; value: string } | null>(null);
  const descDoneRef = useRef(false);
  const [enroll, setEnroll] = useState<{
    hostId: string;
    oneLiner: string;
    oneLinerGithub: string;
    packageAvailable: boolean;
    insecureOrigin: boolean;
    expiresAt: number;
  } | null>(null);
  const [fromGithub, setFromGithub] = useState(false);
  const [upToDateIds, setUpToDateIds] = useState<Record<string, boolean>>({});
  const [trustTarget, setTrustTarget] = useState<RemoteHostView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RemoteHostView | null>(null);
  const [copied, setCopied] = useState(false);
  const [agentMode, setAgentMode] = useState<'later' | 'all' | 'selected'>('later');
  const [picked, setPicked] = useState<string[]>([]);
  const [agentTypes, setAgentTypes] = useState<Array<{ type: string; enabled: boolean }>>([]);
  const [loginPrimed, setLoginPrimed] = useState(false);
  const [loginLoadKeys, setLoginLoadKeys] = useState<Set<string>>(() => new Set());
  const [loginOpened, setLoginOpened] = useState<Set<string>>(() => new Set());
  const [loginDismissed, setLoginDismissed] = useState<Set<string>>(() => new Set());

  const anyInstalling = hosts.some((h) =>
    h.installs?.some((i) => i.running) || h.update?.running || h.installBatch?.running === true || h.logins?.some((l) => l.running) === true);

  // Initial fetch on mount: heals the gaps that push doesn't cover — enroll,
  // trust, delete from another tab, and latestVersion/behind/sidecarAdvisories
  // after background probes. The push mechanism keeps the tab live after mount.
  useEffect(() => {
    let cancelled = false;
    api.listRemoteHosts().then((res) => {
      if (cancelled) return;
      setLoginLoadKeys(new Set(inFlightLogins(res).map((x) => loginResumeKey(x.hostId, x.agentType))));
      setLoginPrimed(true);
      onHostsChange(res);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setLoginPrimed(true);
      setError(err instanceof Error ? err.message : 'failed to load hosts');
    });
    return () => {
      cancelled = true;
    };
  }, [onHostsChange]);

  // Poll while an agent install is in flight, or the enroll card is open
  // (pending → untrusted/connected without leaving Settings).
  useEffect(() => {
    if (!anyInstalling && !enroll) return;
    let cancelled = false;
    const t = setInterval(() => {
      api.listRemoteHosts().then((res) => {
        if (!cancelled) onHostsChange(res);
      }).catch(() => { /* transient — next tick retries */ });
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [anyInstalling, enroll, onHostsChange]);

  const updateHost = useCallback((hostId: string) => {
    setError(null);
    api.updateRemoteHost(hostId)
      .then((r) => {
        if (r.upToDate) setUpToDateIds((s) => ({ ...s, [hostId]: true }));
        else setUpToDateIds((s) => { const n = { ...s }; delete n[hostId]; return n; });
        return api.listRemoteHosts();
      })
      .then(onHostsChange)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [onHostsChange]);

  const installAgent = useCallback((hostId: string, agentType: string) => {
    setError(null);
    api.installRemoteAgent(hostId, agentType)
      .then(() => api.listRemoteHosts())
      .then(onHostsChange)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [onHostsChange]);

  const loginAgent = useCallback((hostId: string, agentType: string) => {
    setError(null);
    setLoginOpened((s) => new Set(s).add(loginResumeKey(hostId, agentType)));
    api.loginRemoteAgent(hostId, agentType)
      .then(() => api.listRemoteHosts())
      .then(onHostsChange)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [onHostsChange]);

  const loginGate = (hostId: string, agentType: string) => ({
    hostId, agentType, primed: loginPrimed, loadKeys: loginLoadKeys, opened: loginOpened, dismissed: loginDismissed,
  });

  const reopenLogin = (hostId: string, agentType: string) => {
    setLoginOpened((s) => new Set(s).add(loginResumeKey(hostId, agentType)));
  };
  const restartLogin = (hostId: string, agentType: string) => {
    setLoginOpened((s) => new Set(s).add(loginResumeKey(hostId, agentType)));
    // The node re-attaches a same-agent start, so end the running child first.
    api.cancelRemoteAgentLogin(hostId, agentType).catch(() => {}).then(() => loginAgent(hostId, agentType));
  };
  const dismissLogin = (hostId: string, agentType: string, running: boolean) => {
    setLoginDismissed((s) => new Set(s).add(loginResumeKey(hostId, agentType)));
    // A running login keeps going; a failed leftover would re-prompt on every load.
    if (!running) api.cancelRemoteAgentLogin(hostId, agentType).catch(() => {});
  };

  const installAllAgents = useCallback((hostId: string) => {
    setError(null);
    api.installAllRemoteAgents(hostId, 'missing+behind')
      .then(() => api.listRemoteHosts())
      .then(onHostsChange)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [onHostsChange]);

  /** allowed+installable agents that are absent or the hub knows are behind. */
  const installAllTargets = (host: RemoteHostView): string[] =>
    Object.entries(host.hello.agents ?? {})
      .filter(([, i]) => i.allowed && i.installable && (!i.installed || i.behind === true))
      .map(([type]) => type);

  const run = useCallback(async (id: string, fn: () => Promise<RemoteHostView | void>) => {
    setBusyId(id);
    setError(null);
    try {
      const host = await fn();
      if (host) onHostsChange((cur) => upsertHost(cur, host));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [onHostsChange]);

  const addHost = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const created = await api.createRemoteHost(trimmed, autoTrust);
      onHostsChange((cur) => upsertHost(cur, created.host));
      setEnroll({
        hostId: created.host.id,
        oneLiner: created.oneLiner,
        oneLinerGithub: created.oneLinerGithub,
        packageAvailable: created.packageAvailable,
        insecureOrigin: created.insecureOrigin,
        expiresAt: created.expiresAt,
      });
      setFromGithub(!created.packageAvailable);
      setAgentMode('later');
      setPicked([]);
      api.listAgents().then(setAgentTypes).catch(() => { /* control falls back to Later/All */ });
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const trustAdvisory = trustTarget ? sidecarAdvisoryText(hostAdvisories(trustTarget)) : '';

  const shown = enroll
    ? withAgentFlags(
        pickOneLiner({ oneLiner: enroll.oneLiner, oneLinerGithub: enroll.oneLinerGithub }, fromGithub),
        agentMode === 'selected' ? picked : agentMode,
      )
    : '';
  const enrollHost = enroll ? hosts.find((h) => h.id === enroll.hostId) : undefined;
  const selectable = remoteSelectableTypes(agentTypes);
  const deleteConfirm = deleteTarget ? hostDeleteConfirm(deleteTarget) : null;

  const copyOneLiner = async () => {
    if (!enroll) return;
    await copyText(shown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">Remote Hosts</div>
      <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>{INSTALL_COPY}</p>
      {error && <div className="error rh-install-error">{error}</div>}

      <form className="rh-add" onSubmit={(e) => { void addHost(e); }}>
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Host name"
          aria-label="Host name"
        />
        <button type="submit" className="modal-btn primary" disabled={!name.trim()}>Add host</button>
      </form>
      <div className="modal-field modal-field-row">
        <span className="modal-label">Auto-trust when enrolled</span>
        <button
          type="button"
          role="switch"
          aria-checked={autoTrust}
          className={`toggle-switch${autoTrust ? ' on' : ''}`}
          onClick={() => setAutoTrust(!autoTrust)}
        >
          <span className="toggle-knob" />
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 12px', lineHeight: 1.4 }}>
        Auto-trust lets whoever redeems this token first run agents immediately. Leave off to approve the host&apos;s key fingerprint manually.
      </p>

      {enroll && (
        <div className="rh-enroll">
          <div className="settings-card-title">Enrollment one-liner (shown once)</div>
          <pre className="rh-oneliner">{shown}</pre>
          {enroll.packageAvailable ? (
            <div className="modal-field modal-field-row" style={{ margin: '6px 0' }}>
              <span className="modal-label">Install from GitHub instead</span>
              <button
                type="button"
                role="switch"
                aria-checked={fromGithub}
                className={`toggle-switch${fromGithub ? ' on' : ''}`}
                onClick={() => setFromGithub(!fromGithub)}
              >
                <span className="toggle-knob" />
              </button>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '6px 0' }}>
              This hub has no package (typically a dev run without a server build). Using the GitHub installer.
            </p>
          )}
          {enroll.insecureOrigin && !fromGithub ? (
            <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '6px 0' }}>
              This page is on http://. The hub-package installer refuses a plain-HTTP hub unless you add --allow-http
              (a mistake-guard, not authenticity — a MITM can edit the check when install.sh itself came
              over HTTP). The flag is not added automatically. Git hosts converting later need
              {' '}tierwyn node update --from-hub --allow-http.
            </p>
          ) : null}
          <div style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', margin: '6px 0' }}>
            <span>Agents on this host:</span>
            <button
              type="button"
              className={`modal-btn${agentMode === 'later' ? ' primary' : ''}`}
              onClick={() => { setAgentMode('later'); setPicked([]); }}
            >
              Choose later
            </button>
            <button
              type="button"
              className={`modal-btn${agentMode === 'all' ? ' primary' : ''}`}
              onClick={() => { setAgentMode('all'); setPicked([]); }}
            >
              All agents
            </button>
            {selectable.length > 0 && (
              <SelectDropdown
                multiple
                searchable
                options={selectable.map((t) => ({ value: t, label: t }))}
                value={agentMode === 'selected' ? picked : []}
                placeholder="Choose agents…"
                onChange={(v) => { setPicked(v as string[]); setAgentMode((v as string[]).length ? 'selected' : 'later'); }}
              />
            )}
          </div>
          {agentMode === 'selected' && picked.length > 0 && (
            <div style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 8, margin: '4px 0' }}>
              {picked.map((t) => (
                <span key={t} className="rh-chip">
                  {t}
                  <button
                    type="button"
                    className="rh-chip-remove"
                    aria-label={`Remove ${t}`}
                    onClick={() => {
                      const next = picked.filter((x) => x !== t);
                      setPicked(next);
                      if (!next.length) setAgentMode('later');
                    }}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          {agentMode === 'all' && (
            <div style={{ fontSize: 13, margin: '4px 0' }}>
              <span className="rh-chip ready">All agents</span>
            </div>
          )}
          <div className="rh-enroll-actions">
            <button type="button" className="modal-btn" onClick={() => { void copyOneLiner(); }}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="modal-btn"
              onClick={() => {
                api.listRemoteHosts().then(onHostsChange).catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err));
                });
              }}
            >
              Refresh
            </button>
            <span className="rh-expiry">Expires {new Date(enroll.expiresAt).toLocaleString()}</span>
          </div>
          {enrollHost ? <div className="rh-enroll-status">{enrollHost.name}: {enrollHost.state}</div> : null}
        </div>
      )}

      {hosts.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>No remote hosts yet.</div>
      ) : (
        <div className="rh-hosts-list">
          {hosts.map((host) => {
            const advisory = sidecarAdvisoryText(hostAdvisories(host));
            const failures = installFailures(host);
            const updated = updateStatus(host);
            const behind = remoteHostAgentRows(host).filter((r) => r.behind === true).length;
            const targets = installAllTargets(host);
            const batchRunning = host.installBatch?.running === true;
            const { source, id: sourceId } = installSourceLabel(host.hello);
            const supported = hostHasFeature(host.hello, 'agent_env');
            return (
              <div
                key={host.id}
                className={`rh-host-card settings-card${host.state === 'disabled' ? ' disabled' : ' active'}`}
              >
                <div className="rh-card-header">
                  <div className="rh-card-title-group">
                    <span className="rh-card-title">{host.name}</span>
                    <span className="rh-status-badge">
                      <span className={dotClass(host.state)} title={host.state} />
                      <span className="rh-status-label">{host.state}</span>
                    </span>
                  </div>
                  {descEdit?.id === host.id ? (
                    <input
                      className="modal-input rh-desc-input"
                      value={descEdit.value}
                      maxLength={500}
                      autoFocus
                      onChange={(e) => setDescEdit({ id: host.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          descDoneRef.current = true;
                          const patch = descriptionPatch(host.description, descEdit.value);
                          setDescEdit(null);
                          if (patch !== undefined) void run(host.id, () => api.patchRemoteHost(host.id, { description: patch }));
                        }
                        if (e.key === 'Escape') {
                          descDoneRef.current = true;
                          setDescEdit(null);
                          e.stopPropagation();
                          e.nativeEvent.stopImmediatePropagation();
                        }
                      }}
                      onBlur={() => {
                        if (descDoneRef.current) return;
                        descDoneRef.current = true;
                        const patch = descriptionPatch(host.description, descEdit.value);
                        setDescEdit(null);
                        if (patch !== undefined) void run(host.id, () => api.patchRemoteHost(host.id, { description: patch }));
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="rh-card-description"
                      onClick={() => { descDoneRef.current = false; setDescEdit({ id: host.id, value: host.description ?? '' }); }}
                      title={host.description ? 'Edit description' : 'Add description'}
                    >
                      {host.description || <span className="rh-desc-placeholder">Add description…</span>}
                    </button>
                  )}
                  <div className="rh-card-meta">
                    <span className="rh-card-meta-item">{hostMeta(host)}</span>
                    <span className="rh-card-meta-item">
                      {source} <span className="rh-sha">{sourceId}</span>
                    </span>
                    <span className="rh-card-meta-item">
                      {host.lastSeenAt ? `Last seen ${new Date(host.lastSeenAt).toLocaleString()}` : 'Never seen'}
                    </span>
                    {behind > 0 ? (
                      <span className="rh-card-meta-item" title="Agents the hub knows are behind latest">
                        {behind} behind
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="rh-card-body">
                  <div className="rh-section">
                    <div className="rh-section-label">Agents</div>
                    <AgentCell host={host} busy={busyId === host.id} onInstall={installAgent} onLogin={loginAgent} />
                  </div>

                  <div className="rh-section">
                    <div className="rh-toggle-row">
                      <span className="rh-check-text">
                        <span className="rh-check-title">Allow MCP secrets</span>
                        <span className="rh-check-desc">Allow node to access forwarded MCP server credentials</span>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={host.allowMcpSecrets}
                        aria-label="Allow MCP secrets"
                        className={`toggle-switch${host.allowMcpSecrets ? ' on' : ''}`}
                        disabled={busyId === host.id}
                        onClick={() => { void run(host.id, () => api.patchRemoteHost(host.id, { allowMcpSecrets: !host.allowMcpSecrets })); }}
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>
                    <div className="rh-toggle-row">
                      <span className="rh-check-text">
                        <span className="rh-check-title">Allow agent env secrets</span>
                        <span className="rh-check-desc">
                          Send API keys from Settings → Agents to this host, held in memory. Only enable on hosts you trust.
                          {!supported ? ' Update this node to use it.' : ''}
                        </span>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={host.allowAgentEnvSecrets}
                        aria-label="Allow agent env secrets"
                        className={`toggle-switch${host.allowAgentEnvSecrets ? ' on' : ''}`}
                        disabled={busyId === host.id || (!supported && !host.allowAgentEnvSecrets)}
                        onClick={() => { void run(host.id, () => api.patchRemoteHost(host.id, { allowAgentEnvSecrets: !host.allowAgentEnvSecrets })); }}
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>
                  </div>

                  {upToDateIds[host.id] ? (
                    <div className="rh-update-banner"><div className="rh-update-status">Already up to date</div></div>
                  ) : updated ? (
                    <div className="rh-update-banner">{updated}</div>
                  ) : null}

                  {failures ? (
                    <div className="rh-failures-container">{failures}</div>
                  ) : null}

                  {advisory ? (
                    <div className="rh-advisory">{advisory}</div>
                  ) : null}

                  {(host.logins ?? []).filter((login) => shouldShowLoginResume(loginGate(host.id, login.agentType))).map((login) => (
                    <div key={login.agentType} className="rh-login-resume">
                      <div>{loginResumeMessage(login)}</div>
                      <div className="rh-login-resume-actions">
                        <button type="button" className="modal-btn primary" onClick={() => reopenLogin(host.id, login.agentType)}>Re-open</button>
                        <button type="button" className="modal-btn" onClick={() => restartLogin(host.id, login.agentType)}>Restart</button>
                        <button type="button" className="modal-btn" onClick={() => dismissLogin(host.id, login.agentType, login.running)}>Dismiss</button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="rh-card-actions">
                  {host.state === 'untrusted' && (
                    <button
                      type="button"
                      className="modal-btn primary"
                      disabled={busyId === host.id}
                      onClick={() => setTrustTarget(host)}
                    >
                      Trust
                    </button>
                  )}
                  {host.state === 'connected' && (
                    <button
                      type="button"
                      className="modal-btn"
                      disabled={busyId === host.id || Boolean(host.update?.running)}
                      onClick={() => updateHost(host.id)}
                    >
                      Update node
                    </button>
                  )}
                  {host.state === 'connected' && (
                    <button
                      type="button"
                      className="modal-btn"
                      disabled={busyId === host.id || batchRunning || targets.length === 0}
                      title="Install missing agents and re-run installs for ones behind latest"
                      onClick={() => installAllAgents(host.id)}
                    >
                      {batchRunning ? 'Installing…' : `Install & update all (${targets.length})`}
                    </button>
                  )}
                  <button
                    type="button"
                    className="modal-btn"
                    disabled={busyId === host.id}
                    onClick={() => { void run(host.id, () => api.refreshRemoteHost(host.id)); }}
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    className="modal-btn"
                    disabled={busyId === host.id}
                    onClick={() => {
                      void run(host.id, () => api.patchRemoteHost(host.id, { disabled: host.state !== 'disabled' }));
                    }}
                  >
                    {host.state === 'disabled' ? 'Enable' : 'Disable'}
                  </button>
                  <button
                    type="button"
                    className="modal-btn danger"
                    disabled={busyId === host.id}
                    onClick={() => setDeleteTarget(host)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hosts.flatMap((h) => (h.logins ?? []).filter((login) => shouldShowLoginModal(loginGate(h.id, login.agentType))).map((login) => {
        const onClosed = () => {
          api.listRemoteHosts().then(onHostsChange).catch(() => { /* next poll / push */ });
        };
        const remoteActions = {
          cancel: () => api.cancelRemoteAgentLogin(h.id, login.agentType),
          retry: () => api.loginRemoteAgent(h.id, login.agentType),
          submitCode: (c: string) => api.submitRemoteAgentLoginCode(h.id, 'claude-code', c),
        };
        return (
          <AgentLoginModalFor
            key={`${h.id}:${login.agentType}`}
            targetName={h.name}
            login={login}
            onClosed={onClosed}
            actions={remoteActions}
          />
        );
      }))}

      {trustTarget && (
        <ConfirmDialog
          title="Trust this host?"
          confirmLabel="Trust"
          body={
            <div>
              <p>Fingerprint: <code>{trustTarget.fingerprint ?? 'unknown'}</code></p>
              <p>Hostname: <code>{trustTarget.hello.hostname ?? 'unknown'}</code></p>
              {trustTarget.enrollIp ? <p>Enroll IP: <code>{trustTarget.enrollIp}</code></p> : null}
              {trustAdvisory ? <p className="rh-advisory">{trustAdvisory}</p> : null}
            </div>
          }
          onCancel={() => setTrustTarget(null)}
          onConfirm={() => {
            const id = trustTarget.id;
            setTrustTarget(null);
            void run(id, () => api.trustRemoteHost(id));
          }}
        />
      )}

      {deleteTarget && deleteConfirm && (
        <ConfirmDialog
          title={deleteConfirm.title}
          confirmLabel={deleteConfirm.confirmLabel}
          danger
          body={<p>{deleteConfirm.body}</p>}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.id;
            const unbind = deleteConfirm.unbind;
            setDeleteTarget(null);
            void run(id, async () => {
              await api.deleteRemoteHost(id, unbind ? { unbind: true } : undefined);
              onHostsChange((cur) => cur.filter((h) => h.id !== id));
            });
          }}
        />
      )}
    </div>
  );
}
