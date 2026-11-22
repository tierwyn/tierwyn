import type { Database } from 'better-sqlite3';
import {
  isSandboxDefaultRow,
  parseSandboxPathList,
  resolveSandbox,
  SANDBOX_SETTINGS_DEFAULTS,
  type SandboxDefaultRow,
  type SandboxPath,
  type SandboxResolveInput,
  type SandboxSettings,
  type SandboxSetting,
  type ResolvedSandbox,
} from '@tierwyn/shared';
import { isDedicatedHub } from '../hubMode.js';

function parseHostPaths(raw: unknown): Record<string, SandboxPath[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, SandboxPath[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || !k) continue;
    const parsed = parseSandboxPathList(v);
    if (parsed.ok && parsed.paths) out[k] = parsed.paths;
  }
  return out;
}

function parseDefaults(raw: unknown): SandboxDefaultRow[] {
  if (!Array.isArray(raw)) return [];
  const out: SandboxDefaultRow[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!isSandboxDefaultRow(row)) continue;
    const key = `${row.hostId}\0${row.agentType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hostId: row.hostId, agentType: row.agentType, setting: row.setting });
  }
  return out;
}

export function getSandboxSettings(db: Database): SandboxSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sandbox'").get() as { value: string } | undefined;
  // Dedicated hub installs start sandbox-on until the operator saves settings;
  // a dev checkout (no TIERWYN_DEDICATED_HUB) keeps the off default.
  if (!row) return { ...SANDBOX_SETTINGS_DEFAULTS, global: isDedicatedHub(), defaults: [], hostPaths: {} };
  try {
    const parsed = JSON.parse(row.value) as Partial<SandboxSettings>;
    return {
      global: parsed.global === true,
      defaults: parseDefaults(parsed.defaults),
      hostPaths: parseHostPaths(parsed.hostPaths),
    };
  } catch {
    return { ...SANDBOX_SETTINGS_DEFAULTS, defaults: [], hostPaths: {} };
  }
}

export function putSandboxSettings(db: Database, s: SandboxSettings): SandboxSettings {
  const next: SandboxSettings = {
    global: s.global === true,
    defaults: parseDefaults(s.defaults),
    hostPaths: parseHostPaths(s.hostPaths),
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sandbox', ?)").run(JSON.stringify(next));
  return next;
}

export function pruneSandboxHost(db: Database, hostId: string): void {
  const s = getSandboxSettings(db);
  const hostPaths = { ...s.hostPaths };
  delete hostPaths[hostId];
  putSandboxSettings(db, {
    global: s.global,
    defaults: s.defaults.filter((r) => r.hostId !== hostId),
    hostPaths,
  });
}

export function resolveSandboxFor(
  db: Database,
  conv: { sandbox?: SandboxSetting | null },
  project: { sandbox?: SandboxSetting | null; remoteHostId?: string },
  agentType: string,
  capable?: SandboxResolveInput['capable'],
): ResolvedSandbox {
  return resolveSandbox({
    conv: conv.sandbox,
    project: project.sandbox,
    hostId: project.remoteHostId ?? 'hub',
    agentType,
    settings: getSandboxSettings(db),
    capable,
  });
}
