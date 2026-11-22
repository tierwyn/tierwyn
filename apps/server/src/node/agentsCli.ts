import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { registerStdioAdapters } from '../adapters/registerAll.js';
import { AGENT_BINARIES, binaryOnPath } from '../discovery.js';
import { ensureAgentPath, loadNodeConfig, nodeConfigDir, writeNodeConfigFile } from './policy.js';

/** code 2 = usage/validation/not enrolled (nothing written); 1 = IO/JSON/restart failure. */
export class AgentsCliError extends Error {
  constructor(readonly code: 1 | 2, msg: string) { super(msg); }
}

/** Types a node can serve = registerStdioAdapters (factories not invoked). Excludes grok-bot. */
export const NODE_AGENT_TYPES: readonly string[] = (() => {
  const t: string[] = [];
  registerStdioAdapters({ register: (type: string) => { t.push(type); } }, () => 'bypass');
  return [...new Set(t)].sort();
})();

export function parseAgentList(args: string[]): string[] {
  const out = args.flatMap((a) => a.split(/[,\s]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(out)].sort();
}

// ponytail: plain O(n·m) Levenshtein, 15 names
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function validateAgents(names: string[], op: 'enroll' | 'allow' | 'disallow', present: string[] = []): void {
  if (names.length === 0) {
    throw new AgentsCliError(2, op === 'enroll'
      ? '--agents needs at least one agent; omit the flag to keep the current list'
      : `${op} needs at least one agent (or --all)`);
  }
  const problems: string[] = [];
  for (const n of names) {
    if (n === 'grok-bot') {
      if (op !== 'disallow') problems.push('grok-bot cannot run on a remote host (it drives the hub\'s desktop app) — refused');
      continue;
    }
    if (NODE_AGENT_TYPES.includes(n)) continue;
    if (op === 'disallow' && present.some((x) => x.toLowerCase() === n)) continue;
    let best: string | undefined;
    let bestD = 3;
    for (const k of NODE_AGENT_TYPES) {
      const d = editDistance(n, k);
      if (d < bestD) { bestD = d; best = k; }
    }
    problems.push(`unknown agent "${n}"${best ? ` — did you mean ${best}?` : ''}`);
  }
  if (problems.length) {
    const unknown = problems.some((p) => p.startsWith('unknown'));
    throw new AgentsCliError(2, problems.join('\n') + (unknown ? `\nknown: ${NODE_AGENT_TYPES.join(', ')}` : ''));
  }
}

export interface AgentChange { changed: boolean; list: string[]; added: string[]; removed: string[]; unchanged: string[] }

function readRaw(dir: string): Record<string, unknown> {
  const p = join(dir, 'node.json');
  if (!existsSync(p)) throw new AgentsCliError(2, 'not enrolled');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch {
    throw new AgentsCliError(1, 'node.json is not valid JSON — fix it by hand');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentsCliError(1, 'node.json is not valid JSON — fix it by hand');
  const o = raw as Record<string, unknown>;
  if (!o.hostId) throw new AgentsCliError(2, 'not enrolled');
  return o;
}

const existingList = (raw: Record<string, unknown>): string[] =>
  Array.isArray(raw.allowedAgents) ? raw.allowedAgents.map(String) : [];

export function applyAgentChange(o: { dir: string; op: 'allow' | 'disallow'; names: string[]; all?: boolean }): AgentChange {
  const raw = readRaw(o.dir);
  const before = [...new Set(existingList(raw))].sort();
  let names = o.names;
  if (o.all) names = o.op === 'allow' ? [...NODE_AGENT_TYPES] : [...before];
  else validateAgents(names, o.op, before);

  const set = new Set(before);
  const find = (n: string): string[] => [...set].filter((x) => x.toLowerCase() === n);
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const n of names) {
    if (o.op === 'allow') {
      if (set.has(n)) unchanged.push(n); else { set.add(n); added.push(n); }
    } else if (find(n).length) { for (const x of find(n)) set.delete(x); removed.push(n); } else unchanged.push(n);
  }
  const list = [...set].sort();
  const changed = list.length !== before.length || list.some((v, i) => v !== before[i]);
  if (!changed) return { changed, list, added, removed, unchanged };
  try {
    // ponytail: no lock — add O_EXCL lockfile if scripted concurrent edits appear.
    writeNodeConfigFile(o.dir, { ...raw, allowedAgents: list });
  } catch (err) {
    throw new AgentsCliError(1, `write failed: ${(err as Error).message}`);
  }
  // Re-read so a lost concurrent update is visible.
  return { changed, list: [...new Set(existingList(readRaw(o.dir)))].sort(), added, removed, unchanged };
}

// ---- systemd ----

export type Exec = (cmd: string, args: string[]) => { status: number; stdout: string } | 'enoent';
export const defaultExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: args.includes('restart') || args.includes('enable') ? 30_000 : 2_000,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'enoent';
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};
export const NODE_UNIT_NEW = 'tierwyn-node.service';
export const NODE_UNIT = NODE_UNIT_NEW;

export function resolveNodeUnit(_exec: Exec): string {
  return NODE_UNIT_NEW;
}

export function serviceState(exec: Exec, unit = resolveNodeUnit(exec)): 'active' | 'inactive' | 'unknown' {
  const r = exec('systemctl', ['--user', 'is-active', unit]);
  if (r === 'enoent') return 'unknown';
  const s = r.stdout.trim();
  if (s === 'active') return 'active';
  if (['inactive', 'failed', 'activating', 'deactivating'].includes(s)) return 'inactive';
  return 'unknown';
}

export function restartStep(exec: Exec, noRestart: boolean, log: (s: string) => void): 0 | 1 {
  if (noRestart) { log('change applies on next restart (tierwyn node restart)'); return 0; }
  const unit = resolveNodeUnit(exec);
  const st = serviceState(exec, unit);
  if (st === 'inactive') { log(`${unit} not running — change applies on next tierwyn node start`); return 0; }
  if (st === 'unknown') { log('could not reach systemd user session — restart the node yourself'); return 0; }
  log(`restarting ${unit} — live sessions on this host will end (use --no-restart to defer)`);
  const r = exec('systemctl', ['--user', 'restart', unit]);
  if (r === 'enoent' || r.status !== 0) {
    log('node.json was updated but restart failed — run: tierwyn node restart');
    return 1;
  }
  log(`restarted ${unit}`);
  return 0;
}

// ---- status ----

export interface NodeStatus {
  hostId: string; hubUrl: string; roots: string[]; maxSessions: number; listenPort: number;
  allowSelfUpdate: boolean; artifactsMaxAgeDays: number;
  service: 'active' | 'inactive' | 'unknown'; serviceSince?: string;
  agents: Array<{ type: string; allowed: boolean; onPath: boolean; bin?: string; install?: string }>;
  unknownAllowed: string[];
  staleConfig: boolean;
}

export function collectStatus(dir: string, exec: Exec, onPath?: (bin: string) => boolean): NodeStatus {
  readRaw(dir); // not enrolled / bad JSON -> typed errors
  const cfg = loadNodeConfig(dir);
  if (!onPath) { ensureAgentPath(process.env); onPath = binaryOnPath; }
  const allowed = new Set(cfg.allowedAgents);
  const service = serviceState(exec);
  let serviceSince: string | undefined;
  let staleConfig = false;
  if (service === 'active') {
    const r = exec('systemctl', ['--user', 'show', '-p', 'ActiveEnterTimestamp', '--value', '--timestamp=unix', resolveNodeUnit(exec)]);
    // `@<epoch seconds>` — locale/zone independent (default output has BST/CEST that Date.parse rejects)
    const m = r === 'enoent' ? null : /^@(\d+)$/.exec(r.stdout.trim());
    if (m) {
      const startSec = Number(m[1]);
      serviceSince = new Date(startSec * 1000).toLocaleString();
      // whole seconds: systemd stamps are 1 s resolution, so a same-second write is not "newer"
      staleConfig = Math.floor(statSync(join(dir, 'node.json')).mtimeMs / 1000) > startSec;
    }
  }
  return {
    hostId: cfg.hostId, hubUrl: cfg.hubUrl, roots: cfg.roots, maxSessions: cfg.maxSessions,
    listenPort: cfg.listenPort, allowSelfUpdate: cfg.allowSelfUpdate, artifactsMaxAgeDays: cfg.artifactsMaxAgeDays,
    service, ...(serviceSince ? { serviceSince } : {}),
    agents: NODE_AGENT_TYPES.map((type) => {
      const b = AGENT_BINARIES[type];
      return {
        type, allowed: allowed.has(type), onPath: b?.bin ? onPath!(b.bin) : false,
        ...(b?.bin ? { bin: b.bin } : {}), ...(b?.install ? { install: b.install } : {}),
      };
    }),
    unknownAllowed: cfg.allowedAgents.filter((a) => !NODE_AGENT_TYPES.includes(a)),
    staleConfig,
  };
}

export function renderStatus(s: NodeStatus): string {
  const L: string[] = [];
  L.push(`host        ${s.hostId}  (hub ${s.hubUrl})`);
  L.push(`service     ${s.service}${s.serviceSince ? ` since ${s.serviceSince}` : ''}`);
  L.push(`roots       ${s.roots.join(', ') || '(none)'}`);
  L.push(`maxSessions ${s.maxSessions}    listenPort ${s.listenPort}    selfUpdate ${s.allowSelfUpdate ? 'on' : 'off'}    artifacts ${s.artifactsMaxAgeDays}d`);
  L.push('');
  const w = Math.max(...s.agents.map((a) => a.type.length), 'grok-bot'.length, 5) + 2;
  L.push('agent'.padEnd(w) + 'allowed  binary');
  for (const a of s.agents) {
    const bin = a.onPath ? `found${a.bin ? ` (${a.bin})` : ''}` : `missing${a.install ? `  → ${a.install}` : ''}`;
    L.push(a.type.padEnd(w) + (a.allowed ? 'yes' : 'no').padEnd(9) + bin);
  }
  L.push('grok-bot'.padEnd(w) + 'never'.padEnd(9) + '(hub-only adapter)');
  L.push('');
  L.push('PATH from this shell + node defaults; the service uses node.env');
  L.push('hub link: see tierwyn node logs / Settings → Remote Hosts');
  const warn: string[] = [];
  for (const u of s.unknownAllowed) warn.push(`! allowedAgents contains unknown type "${u}" — ignored by the node (tierwyn node disallow ${u})`);
  if (s.staleConfig) warn.push('! service is running an older node.json — restart to apply (tierwyn node restart)');
  if (warn.length) L.push('', 'warnings', ...warn.map((w2) => `  ${w2}`));
  return L.join('\n');
}

// ---- argv + dispatch ----

export function dirValue(v: string | undefined): string {
  if (!v || v.startsWith('--')) throw new AgentsCliError(2, '--dir needs a path');
  return v;
}

export function parseChangeArgs(argv: string[]): { names: string[]; all: boolean; noRestart: boolean; dir?: string } {
  const pos: string[] = [];
  let all = false; let noRestart = false; let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--no-restart') noRestart = true;
    else if (a === '--dir') dir = dirValue(argv[++i]);
    else if (a.startsWith('--')) throw new AgentsCliError(2, `unknown option ${a}`);
    else pos.push(a);
  }
  const names = parseAgentList(pos);
  if (all && names.length) throw new AgentsCliError(2, '--all cannot be combined with agent names');
  if (!all && !names.length) throw new AgentsCliError(2, 'at least one agent (or --all) is required');
  return { names, all, noRestart, dir };
}

export function parseStatusArgs(argv: string[]): { json: boolean; dir?: string } {
  let json = false; let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--dir') dir = dirValue(argv[++i]);
    else throw new AgentsCliError(2, `unknown option ${a}`);
  }
  return { json, dir };
}

export async function runAgentsCommand(
  sub: 'allow' | 'disallow' | 'status',
  argv: string[],
  deps: { exec: Exec; log: (s: string) => void; onPath?: (bin: string) => boolean } = { exec: defaultExec, log: console.log },
): Promise<0 | 1 | 2> {
  try {
    if (sub === 'status') {
      const a = parseStatusArgs(argv);
      const s = collectStatus(a.dir ?? nodeConfigDir(), deps.exec, deps.onPath);
      deps.log(a.json ? JSON.stringify(s, null, 2) : renderStatus(s));
      return 0;
    }
    const a = parseChangeArgs(argv);
    const dir = a.dir ?? nodeConfigDir();
    const r = applyAgentChange({ dir, op: sub, names: a.names, all: a.all });
    let onPath = deps.onPath;
    if (!onPath && r.added.length) { ensureAgentPath(process.env); onPath = binaryOnPath; }
    for (const n of r.added) {
      const b = AGENT_BINARIES[n];
      const hint = b?.bin && !onPath!(b.bin)
        ? `  (binary not on PATH — install with Settings → Install ▸${b.install ? ` or: ${b.install}` : ''})` : '';
      deps.log(`+ ${n}${hint}`);
    }
    for (const n of r.removed) deps.log(`- ${n}`);
    for (const n of r.unchanged) deps.log(`= ${n}  ${sub === 'allow' ? 'already allowed' : 'not allowed (unchanged)'}`);
    if (!r.changed) { deps.log('no change'); return 0; }
    deps.log(`allowedAgents: ${r.list.join(', ') || '(none)'}`);
    return restartStep(deps.exec, a.noRestart, deps.log);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return err instanceof AgentsCliError ? err.code : 1;
  }
}
