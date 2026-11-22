export type SandboxSetting = 'on' | 'off';

export type NodeSandboxPolicy = 'off' | 'allow' | 'require';

/** Cap on hub-requested custom sandbox binds; advertised in node hello. */
export type NodeSandboxPathsAllow = 'none' | 'ro' | 'rw';

export type SandboxSource =
  | 'conversation'
  | 'project'
  | 'host-agent'
  | 'agent'
  | 'host'
  | 'global'
  | 'node'
  | 'unavailable';

export interface SandboxPath {
  path: string;
  mode: 'ro' | 'rw';
  optional?: boolean;
}

export interface EffectivePath extends SandboxPath {
  from: 'host' | 'project' | 'global' | 'conversation' | `preset:${string}`;
  status: 'ok' | 'missing' | 'denied';
  reason?: string;
}

export interface SandboxDefaultRow {
  hostId: string;
  agentType: string;
  setting: SandboxSetting;
}

export interface SandboxSettings {
  global: boolean;
  defaults: SandboxDefaultRow[];
  hostPaths: Record<string, SandboxPath[]>;
}

export const SANDBOX_SETTINGS_DEFAULTS: SandboxSettings = {
  global: false,
  defaults: [],
  hostPaths: {},
};

export interface SandboxHostCaps {
  hasProfile: boolean;
  available?: boolean | null;
  features?: readonly string[] | null;
  policy?: NodeSandboxPolicy | null;
  remote?: boolean;
}

export interface SandboxResolveInput {
  conv?: SandboxSetting | null;
  project?: SandboxSetting | null;
  hostId: string;
  agentType: string;
  settings: Pick<SandboxSettings, 'global' | 'defaults'>;
  /** Host capability, null = unknown (don't soft-fallback on unknown). */
  capable?: { ok: boolean; forced?: boolean; reason?: string } | null;
}

export interface ResolvedSandbox {
  on: boolean;
  source: SandboxSource;
  reason?: string;
  wanted: boolean;
}

export interface SandboxChainEntry {
  tier: 'conversation' | 'project' | 'host-agent' | 'agent' | 'host' | 'global';
  value: SandboxSetting | boolean | null;
}

export function isSandboxSetting(v: unknown): v is SandboxSetting {
  return v === 'on' || v === 'off';
}

export function isSandboxPath(v: unknown): v is SandboxPath {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return false;
  const p = o.path;
  if (!p.startsWith('/') || p.length > 512) return false;
  if (p.split('/').includes('..')) return false;
  if (p.includes('\0') || p.includes('\n') || p.includes('\r')) return false;
  if (o.mode !== 'ro' && o.mode !== 'rw') return false;
  if (o.optional !== undefined && typeof o.optional !== 'boolean') return false;
  return true;
}

export function parseSandboxPathList(
  v: unknown,
): { ok: true; paths: SandboxPath[] | null } | { ok: false; error: string; entries?: { index: number; reason: string }[] } {
  if (v === null) return { ok: true, paths: null };
  if (!Array.isArray(v)) return { ok: false, error: 'must be an array or null' };
  if (v.length > 32) return { ok: false, error: 'max 32 entries' };
  const entries: { index: number; reason: string }[] = [];
  const paths: SandboxPath[] = [];
  for (let i = 0; i < v.length; i++) {
    if (!isSandboxPath(v[i])) {
      entries.push({ index: i, reason: 'invalid path entry (absolute path, mode ro|rw)' });
      continue;
    }
    const p = v[i] as SandboxPath;
    paths.push({ path: p.path, mode: p.mode, ...(p.optional !== undefined ? { optional: p.optional } : {}) });
  }
  if (entries.length) return { ok: false, error: 'invalid sandbox paths', entries };
  return { ok: true, paths };
}

export function isSandboxDefaultRow(v: unknown): v is SandboxDefaultRow {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.hostId === 'string' && o.hostId.length > 0
    && typeof o.agentType === 'string' && o.agentType.length > 0
    && isSandboxSetting(o.setting);
}

export function lookupSandboxDefault(
  rows: readonly SandboxDefaultRow[],
  hostId: string,
  agentType: string,
): { setting: SandboxSetting; source: 'host-agent' | 'agent' | 'host' } | null {
  const exact = rows.find((r) => r.hostId === hostId && r.agentType === agentType);
  if (exact) return { setting: exact.setting, source: 'host-agent' };
  const agent = rows.find((r) => r.hostId === '*' && r.agentType === agentType);
  if (agent) return { setting: agent.setting, source: 'agent' };
  const host = rows.find((r) => r.hostId === hostId && r.agentType === '*');
  if (host) return { setting: host.setting, source: 'host' };
  return null;
}

export function resolveSandbox(i: SandboxResolveInput): ResolvedSandbox {
  if (i.agentType === 'grok-bot') {
    return { on: false, source: 'unavailable', reason: 'never sandboxed', wanted: false };
  }

  let on: boolean;
  let source: SandboxSource;
  let explicit = false;
  if (i.conv === 'on' || i.conv === 'off') {
    on = i.conv === 'on';
    source = 'conversation';
    explicit = true;
  } else if (i.project === 'on' || i.project === 'off') {
    on = i.project === 'on';
    source = 'project';
    explicit = true;
  } else {
    const hit = lookupSandboxDefault(i.settings.defaults ?? [], i.hostId, i.agentType);
    if (hit) {
      on = hit.setting === 'on';
      source = hit.source;
    } else {
      on = i.settings.global === true;
      source = 'global';
    }
  }

  const wanted = on;
  const cap = i.capable;
  if (cap?.forced) return { on: true, source: 'node', wanted };
  if (wanted && cap && cap.ok === false) {
    if (explicit) return { on: true, source, wanted, reason: cap.reason };
    return { on: false, source: 'unavailable', reason: cap.reason, wanted: true };
  }
  return { on, source, wanted };
}

export function sandboxChain(i: SandboxResolveInput): SandboxChainEntry[] {
  const defaults = i.settings.defaults ?? [];
  const exact = defaults.find((r) => r.hostId === i.hostId && r.agentType === i.agentType);
  const agent = defaults.find((r) => r.hostId === '*' && r.agentType === i.agentType);
  const host = defaults.find((r) => r.hostId === i.hostId && r.agentType === '*');
  return [
    { tier: 'conversation', value: i.conv === 'on' || i.conv === 'off' ? i.conv : null },
    { tier: 'project', value: i.project === 'on' || i.project === 'off' ? i.project : null },
    { tier: 'host-agent', value: exact?.setting ?? null },
    { tier: 'agent', value: agent?.setting ?? null },
    { tier: 'host', value: host?.setting ?? null },
    { tier: 'global', value: i.settings.global === true },
  ];
}

export function isAgentSandboxCapable(
  agentType: string,
  hostCaps: SandboxHostCaps,
): { ok: boolean; forced?: boolean; reason?: string } | null {
  if (agentType === 'grok-bot') {
    return { ok: false, reason: 'never sandboxed' };
  }
  if (!hostCaps.hasProfile) {
    return { ok: false, reason: 'no sandbox profile' };
  }
  if (hostCaps.policy === 'require') {
    return { ok: true, forced: true };
  }
  if (hostCaps.policy === 'off') {
    return { ok: false, reason: 'sandbox disabled on host' };
  }
  if (hostCaps.remote) {
    if (hostCaps.features == null) return null;
    if (!hostCaps.features.includes('sandbox')) {
      return { ok: false, reason: 'host has not advertised sandbox support' };
    }
    if (hostCaps.available === false) {
      return { ok: false, reason: 'bubblewrap unavailable on host' };
    }
    if (hostCaps.available == null) return null;
  } else {
    if (hostCaps.available === false) {
      return { ok: false, reason: 'bubblewrap unavailable on hub' };
    }
    if (hostCaps.available == null) return null;
  }
  return { ok: true };
}

export function monotonicChildSandbox(parent: Pick<ResolvedSandbox, 'on'>): SandboxSetting | null {
  return parent.on ? 'on' : null;
}

export function unionSandboxPaths(host: readonly SandboxPath[], project: readonly SandboxPath[]): EffectivePath[] {
  const byPath = new Map<string, EffectivePath>();
  const add = (p: SandboxPath, from: 'host' | 'project') => {
    const existing = byPath.get(p.path);
    if (!existing) {
      byPath.set(p.path, { path: p.path, mode: p.mode, optional: p.optional, from, status: 'ok' });
      return;
    }
    const mode: 'ro' | 'rw' = existing.mode === 'rw' && p.mode === 'rw' ? 'rw' : 'ro';
    byPath.set(p.path, { ...existing, mode, from: 'project' });
  };
  for (const p of host) add(p, 'host');
  for (const p of project) add(p, 'project');
  return [...byPath.values()];
}
