import {
  isAgentSandboxCapable,
  isSandboxPath,
  resolveSandbox,
  type NodeHello,
  type SandboxDefaultRow,
  type SandboxPath,
  type SandboxSetting,
  type SandboxSettings,
  type SandboxSource,
} from '@tierwyn/shared';

export type SandboxTriState = 'inherit' | 'on' | 'off';

export interface SandboxControlInput {
  agentType: string | undefined;
  conv: SandboxSetting | null | undefined;
  project: SandboxSetting | null | undefined;
  settings: Pick<SandboxSettings, 'global' | 'defaults'>;
  /** 'hub' or a remote host id. */
  hostId: string;
  supportedAgents: readonly string[];
  /** Hub probe; undefined = not loaded yet (treat as unknown, don't disable). */
  hubAvailable: boolean | undefined;
  /** True when the project is bound to a remote host (project.remoteHostId set). */
  remote: boolean;
  /** The bound host's hello (from RemoteHostView), if known. */
  hostHello?: Partial<NodeHello>;
}

export interface SandboxControlState {
  /** Chip text, e.g. "Sandbox: on (project)" / "Sandbox: on (forced by host)". */
  label: string;
  /** Effective resolved value (after node require / soft fallback). */
  on: boolean;
  /** Control fully disabled (node policy 'require'). */
  locked: boolean;
  /** Non-null ⇒ the "On" option is disabled; string is the tooltip. */
  onDisabledReason: string | null;
  /** Label for the Inherit option, e.g. "Inherit (project: on)". */
  inheritLabel: string;
  /** Soft fallback: inherited on, host can't sandbox. */
  warning: boolean;
}

export const SANDBOX_ALWAYS_BLOCKED = [
  '/',
  '$HOME and ancestors',
  'cwd ancestors up to $HOME',
  '~/.ssh',
  '~/.gnupg',
  '~/.git-credentials',
  '~/.config/tierwyn',
  '/etc/tierwyn',
  'hub data/',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers*',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/var/run',
  '/run/user/<uid>',
  'docker.sock',
  'podman.sock',
  'unix.socket / containerd.sock',
  '/var/lib/docker',
  '/tmp, /var/tmp, /dev/shm',
  '/tmp/tmux-* /tmp/.X11-unix /tmp/ssh-*',
  'lxd unix.socket',
  "other agents' profile dirs",
  'Tierwyn repo root as rw',
  '.env*',
  '~/.local/bin and toolchains (rw)',
  '~/.bashrc / .profile / .zshrc / .bash_profile (rw)',
  '~/.config/systemd, autostart, git (rw)',
  '~/.gitconfig (rw)',
  '/etc /usr /opt /var/spool/cron (rw)',
  'any PATH entry (rw)',
  "$HOME's dot-dirs (rw)",
  'outside node.json roots (rw, remote)',
] as const;

/** Any host × Any agent is the global toggle, not a stored default row. */
export const SANDBOX_FLEET_WIDE_CELL_LABEL = '= Global default';

export function isFleetWideCell(hostId: string, agentType: string): boolean {
  return hostId === '*' && agentType === '*';
}

export function sandboxOriginLabel(source: SandboxSource): string {
  switch (source) {
    case 'conversation': return 'this chat';
    case 'project': return 'project';
    case 'agent': return 'agent default';
    case 'host': return 'host default';
    case 'host-agent': return 'host · agent default';
    case 'global': return 'global';
    case 'node': return 'forced by host';
    case 'unavailable': return "host can't sandbox";
  }
}

export function sandboxEffectiveLabel(on: boolean, source: SandboxSource): string {
  return `Sandbox: ${on ? 'on' : 'off'} (${sandboxOriginLabel(source)})`;
}

export function projectSandboxInheritLabel(globalOn: boolean, overrideCount: number): string {
  const g = `global: ${globalOn ? 'on' : 'off'}`;
  if (overrideCount <= 0) return `Inherit (${g})`;
  const noun = overrideCount === 1 ? 'override' : 'overrides';
  return `Inherit (${g} · ${overrideCount} agent/host ${noun})`;
}

function capableFor(i: SandboxControlInput, agentType: string) {
  return isAgentSandboxCapable(agentType, {
    hasProfile: i.supportedAgents.includes(agentType),
    available: i.remote ? i.hostHello?.sandbox?.available : i.hubAvailable,
    features: i.remote ? i.hostHello?.features : undefined,
    policy: i.remote ? i.hostHello?.sandbox?.policy : undefined,
    remote: i.remote,
  });
}

/** Returns null when no control should render (grok-bot or no agent). */
export function sandboxControlState(i: SandboxControlInput): SandboxControlState | null {
  if (i.agentType === 'grok-bot' || !i.agentType) return null;

  const capable = capableFor(i, i.agentType);
  const input = {
    conv: i.conv,
    project: i.project,
    hostId: i.hostId,
    agentType: i.agentType,
    settings: i.settings,
    capable,
  };
  const r = resolveSandbox(input);
  const inh = resolveSandbox({ ...input, conv: null });
  const inheritLabel = `Inherit (${sandboxOriginLabel(inh.source)}: ${inh.on ? 'on' : 'off'})`;

  let onDisabledReason: string | null = null;
  if (!i.supportedAgents.includes(i.agentType)) {
    onDisabledReason = 'This agent has no sandbox profile';
  } else if (i.remote && !i.hostHello?.features?.includes('sandbox')) {
    onDisabledReason = 'Remote host has not advertised sandbox support (offline, or run tierwyn node update)';
  } else if (i.remote && i.hostHello?.sandbox?.policy === 'off') {
    onDisabledReason = 'Sandbox is disabled on this host (node.json)';
  } else if (i.remote && i.hostHello?.sandbox?.available === false) {
    onDisabledReason = 'bubblewrap is unavailable on this host';
  } else if (!i.remote && i.hubAvailable === false) {
    onDisabledReason = 'bubblewrap (bwrap) is unavailable on the hub';
  }

  const locked = r.source === 'node';
  return {
    label: sandboxEffectiveLabel(r.on, r.source),
    on: r.on,
    locked,
    onDisabledReason: locked ? null : onDisabledReason,
    inheritLabel,
    warning: r.source === 'unavailable',
  };
}

export function cellSetting(
  rows: readonly SandboxDefaultRow[],
  hostId: string,
  agentType: string,
): SandboxTriState {
  const hit = rows.find((r) => r.hostId === hostId && r.agentType === agentType);
  return hit ? hit.setting : 'inherit';
}

export function setCell(
  rows: readonly SandboxDefaultRow[],
  hostId: string,
  agentType: string,
  value: SandboxTriState,
): SandboxDefaultRow[] {
  const next = rows.filter((r) => !(r.hostId === hostId && r.agentType === agentType));
  if (isFleetWideCell(hostId, agentType) || value === 'inherit') return next;
  return [...next, { hostId, agentType, setting: value }];
}

export interface SandboxCellCaps {
  hostId: string;
  agentType: string;
  supportedAgents: readonly string[];
  hubAvailable: boolean | undefined;
  hosts: ReadonlyArray<{ id: string; hello: Partial<NodeHello> }>;
}

export function sandboxCellDisableReason(c: SandboxCellCaps): string | null {
  if (c.agentType !== '*' && !c.supportedAgents.includes(c.agentType)) {
    return 'Agent lacks sandbox profile';
  }
  if (c.hostId === '*') return null;
  if (c.hostId === 'hub') {
    return c.hubAvailable === false ? 'Host lacks bwrap' : null;
  }
  const host = c.hosts.find((h) => h.id === c.hostId);
  const hello = host?.hello;
  if (!hello?.features?.includes('sandbox') || hello.sandbox?.available === false || hello.sandbox?.policy === 'off') {
    return 'Host lacks bwrap';
  }
  return null;
}

export function sandboxPathFromDraft(path: string, mode: 'ro' | 'rw'): SandboxPath | null {
  const entry = { path: path.trim(), mode };
  return isSandboxPath(entry) ? entry : null;
}
