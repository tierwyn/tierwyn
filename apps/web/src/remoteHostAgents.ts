import { AGENT_LOGIN_HINTS, hostHasFeature, isRemoteCapableAgentType, isRemoteLoginAgent, REMOTE_LOGIN_AGENTS, type RemoteHostLoginState, type RemoteHostView } from '@tierwyn/shared';

export interface RemoteHostAgentRow {
  type: string;
  state: 'ready' | 'not_logged_in' | 'missing' | 'installing' | 'queued';
  installable: boolean;
  /** Node-reported installed CLI version (needs the agents.version feature). */
  version?: string;
  /** Hub's cached latest published version. */
  latestVersion?: string;
  /** `true` behind, `false` known current, absent unknown (can't compare). */
  behind?: boolean;
  lastError?: string;
  /** Raw output of the latest failed install (for the details view). */
  tail?: string;
  /** Timestamp of the latest settled successful install run (success feedback). */
  lastOkAt?: number;
}

/** Chip model for Settings → Remote Hosts. Old nodes don't send `allowed`
 *  — fall back to `installed` so they keep showing their agents. */
export function remoteHostAgentRows(host: RemoteHostView): RemoteHostAgentRow[] {
  const agents = host.hello.agents ?? {};
  const installs = host.installs ?? [];
  const queued = new Set(host.installBatch?.remaining ?? []);
  return Object.entries(agents)
    .filter(([type, info]) => isRemoteCapableAgentType(type) && (info.allowed === true || info.installed))
    .map(([type, info]) => {
      const mine = installs.filter((i) => i.agentType === type);
      const failed = [...mine].reverse().find((i) => i.ok === false);
      const okRun = [...mine].reverse().find((i) => i.ok === true && !i.running);
      const tail = failed?.tail;
      const lines = tail?.split('\n').filter((l) => l.trim() !== '') ?? [];
      const lastError = lines.length ? lines[lines.length - 1].slice(-300) : undefined;
      const state: RemoteHostAgentRow['state'] =
        mine.some((i) => i.running) ? 'installing'
        : queued.has(type) ? 'queued'
        : info.installed && info.loggedIn === false ? 'not_logged_in'
        : info.installed ? 'ready'
        : 'missing';
      return {
        type,
        state,
        installable: info.installable === true,
        ...(info.version !== undefined ? { version: info.version } : {}),
        ...(info.latestVersion !== undefined ? { latestVersion: info.latestVersion } : {}),
        ...(info.behind !== undefined ? { behind: info.behind } : {}),
        ...(lastError !== undefined ? { lastError } : {}),
        ...(tail !== undefined ? { tail } : {}),
        ...(okRun !== undefined ? { lastOkAt: okRun.at } : {}),
      };
    });
}

/** Login state for one agent on a host. Never fall back to another agent's slot. */
export function loginFor(host: RemoteHostView, agentType: string) {
  return host.logins?.find((l) => l.agentType === agentType);
}

export function loginResumeKey(hostId: string, agentType: string): string {
  return `${hostId}:${agentType}`;
}

export function loginAgentLabel(agentType: string): string {
  return isRemoteLoginAgent(agentType) ? REMOTE_LOGIN_AGENTS[agentType].label : agentType;
}

export interface LoginActions {
  cancel(): Promise<unknown>;
  retry(): Promise<unknown>;
  submitCode?(code: string): Promise<unknown>;
}

export function notLoggedInTitle(type: string, where = 'on the host'): string {
  if (type === 'claude-code') return `run "claude auth login" ${where}, then Refresh`;
  const hint = AGENT_LOGIN_HINTS[type];
  const cmd = hint?.cmd ?? `${type} login`;
  const envBit = hint?.env ? `, or set \`${hint.env}\` in Settings → Agents` : '';
  return `run "${cmd}" ${where}${envBit}, then Refresh`;
}

export function loginResumeMessage(login: RemoteHostLoginState, where = 'this host'): string {
  const label = loginAgentLabel(login.agentType);
  return login.running
    ? `A ${label} login is still in progress on ${where}.`
    : `The last ${label} login on ${where} failed: ${login.error ?? 'unknown error'}`;
}

/** In-flight or error-leftover logins the hub still holds after a page refresh. */
export function inFlightLogins(hosts: RemoteHostView[]) {
  return hosts.flatMap((h) => (h.logins ?? [])
    .filter((l) => l.running || Boolean(l.error))
    .map((login) => ({ hostId: h.id, hostName: h.name, agentType: login.agentType, login })));
}

export function shouldShowLoginModal(opts: {
  hostId: string;
  agentType: string;
  primed: boolean;
  loadKeys: ReadonlySet<string>;
  opened: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
}): boolean {
  const k = loginResumeKey(opts.hostId, opts.agentType);
  if (opts.opened.has(k)) return true;
  if (!opts.primed || opts.dismissed.has(k) || opts.loadKeys.has(k)) return false;
  return true;
}

export function shouldShowLoginResume(opts: {
  hostId: string;
  agentType: string;
  primed: boolean;
  loadKeys: ReadonlySet<string>;
  opened: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
}): boolean {
  const k = loginResumeKey(opts.hostId, opts.agentType);
  if (!opts.primed || opts.opened.has(k) || opts.dismissed.has(k)) return false;
  return opts.loadKeys.has(k);
}

/** Remote agent login is offered only when the node is connected, advertises the matching feature, and the agent is installed. */
export function agentLoginAvailable(host: RemoteHostView, agentType: string): boolean {
  if (!isRemoteLoginAgent(agentType)) return false;
  return host.state === 'connected'
    && hostHasFeature(host.hello, REMOTE_LOGIN_AGENTS[agentType].feature)
    && host.hello.agents?.[agentType]?.installed === true;
}

/** Button for an installed+installable row: hidden when known current. */
export function remoteUpdateAction(row: RemoteHostAgentRow): 'update' | 'reinstall' | null {
  return row.behind === true ? 'update' : row.behind === false ? null : 'reinstall';
}

/**
 * Returns undefined when the draft is the same as current (no-op),
 * null to clear, or the trimmed string to set.
 */
export function hostDeleteConfirm(host: Pick<RemoteHostView, 'name' | 'boundProjects'>): {
  title: string;
  body: string;
  confirmLabel: string;
  unbind: boolean;
} {
  const names = (host.boundProjects ?? []).map((p) => p.name);
  if (names.length === 0) {
    return {
      title: `Delete ${host.name}?`,
      body: 'Removes this host from the hub. The node software on that machine is not uninstalled.',
      confirmLabel: 'Delete',
      unbind: false,
    };
  }
  const listed = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const those = names.length === 1 ? 'that project' : 'those projects';
  const stay = names.length === 1 ? 'it stays' : 'they stay';
  return {
    title: `Delete ${host.name}?`,
    body: `Used by ${listed}. Deleting the host unbinds ${those} — ${stay} in the sidebar, but chats will no longer run on this machine.`,
    confirmLabel: 'Delete and unbind',
    unbind: true,
  };
}

export function descriptionPatch(
  current: string | undefined,
  draft: string,
): string | null | undefined {
  const trimmed = draft.trim();
  const existing = current?.trim() ?? '';
  if (trimmed === existing) return undefined;
  return trimmed === '' ? null : trimmed;
}
