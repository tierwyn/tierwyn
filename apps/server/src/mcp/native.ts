/**
 * Read-only view of each agent's own MCP config (plan §7). Fixed per-agent paths
 * only — never a client-supplied path. Every env/header value and credential-looking
 * arg is masked. Missing files → empty list; parse errors → errors[].
 */
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from 'fs/promises';
import { constants as FS } from 'fs';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import type {
  McpNativeEntry,
  McpNativeInstallResult,
  McpNativeRemoveResult,
  McpNativeView,
  McpNativeWriteScope,
} from '@tierwyn/shared';
import { MCP_NATIVE_WRITABLE_AGENTS, nativeWriteSupports } from '@tierwyn/shared';
import { buildChildEnv } from '../childEnv.js';
import type { McpServerRow } from './registry.js';

const MASK = '••••';
type Scope = McpNativeEntry['scope'];

/** agentType → how to read. `cli` = spawn `<bin> ...args` and parse its output. */
type Source =
  | {
      kind: 'files';
      files: (home: string, root?: string) => Array<{
        path: string;
        scope: Scope;
        pick?: (j: any, root?: string) => unknown;
        pickEntries?: (j: any, filePath: string) => McpNativeEntry[];
        jsonc?: boolean;
      }>;
    }
  | { kind: 'cli'; bin: string; args: string[]; raw?: boolean }
  | { kind: 'note'; note: string };

const mcpKey = (j: any) => j?.mcpServers;

function pickAllLocalProjects(j: any, filePath: string): McpNativeEntry[] {
  const projs = j?.projects;
  if (!projs || typeof projs !== 'object') return [];
  const out: McpNativeEntry[] = [];
  for (const [projPath, projCfg] of Object.entries(projs as Record<string, any>)) {
    const servers = projCfg?.mcpServers;
    if (servers && typeof servers === 'object') {
      for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
        out.push(toEntry(name, cfg, 'local', `${filePath} (${projPath})`));
      }
    }
  }
  return out;
}

const SOURCES: Record<string, Source> = {
  'claude-code': { kind: 'files', files: (h, root) => [
    { path: join(h, '.claude.json'), scope: 'user', pick: mcpKey },
    ...(root ? [
      { path: join(h, '.claude.json'), scope: 'local' as Scope, pick: (j: any) => j?.projects?.[root]?.mcpServers },
      { path: join(root, '.mcp.json'), scope: 'project' as Scope, pick: mcpKey },
    ] : [
      { path: join(h, '.claude.json'), scope: 'local' as Scope, pickEntries: pickAllLocalProjects },
    ]),
  ] },
  antigravity: { kind: 'files', files: (h, root) => [
    { path: join(h, '.gemini', 'config', 'mcp_config.json'), scope: 'user', pick: mcpKey },
    ...(root ? [{ path: join(root, '.agents', 'mcp_config.json'), scope: 'project' as Scope, pick: mcpKey }] : []),
  ] },
  qwen: { kind: 'files', files: (h, root) => [
    { path: join(h, '.qwen', 'settings.json'), scope: 'user', pick: mcpKey },
    ...(root ? [{ path: join(root, '.qwen', 'settings.json'), scope: 'project' as Scope, pick: mcpKey }] : []),
  ] },
  kiro: { kind: 'files', files: (h, root) => [
    { path: join(h, '.kiro', 'settings', 'mcp.json'), scope: 'user', pick: mcpKey },
    ...(root ? [{ path: join(root, '.kiro', 'settings', 'mcp.json'), scope: 'project' as Scope, pick: mcpKey }] : []),
  ] },
  cursor: { kind: 'files', files: (h, root) => [
    { path: join(h, '.cursor', 'mcp.json'), scope: 'user', pick: mcpKey },
    ...(root ? [{ path: join(root, '.cursor', 'mcp.json'), scope: 'project' as Scope, pick: mcpKey }] : []),
  ] },
  opencode: { kind: 'files', files: (h, root) => [
    { path: join(h, '.config', 'opencode', 'opencode.json'), scope: 'user', pick: (j: any) => j?.mcp, jsonc: true },
    ...(root ? [{ path: join(root, 'opencode.json'), scope: 'project' as Scope, pick: (j: any) => j?.mcp, jsonc: true }] : []),
  ] },
  kilocode: { kind: 'files', files: (h, root) => [
    { path: join(h, '.config', 'kilo', 'kilo.json'), scope: 'user', pick: (j: any) => j?.mcp, jsonc: true },
    { path: join(h, '.config', 'kilo', 'opencode.json'), scope: 'user', pick: (j: any) => j?.mcp, jsonc: true },
    ...(root ? [{ path: join(root, 'kilo.json'), scope: 'project' as Scope, pick: (j: any) => j?.mcp, jsonc: true }] : []),
  ] },
  codex: { kind: 'cli', bin: 'codex', args: ['mcp', 'list', '--json'] },
  copilot: { kind: 'cli', bin: 'copilot', args: ['mcp', 'list', '--json'] },
  'grok-build': { kind: 'cli', bin: 'grok', args: ['mcp', 'list', '--json'] },
  pi: { kind: 'cli', bin: 'pi', args: ['mcp', 'list', '--json'] },
  openclaw: { kind: 'cli', bin: 'openclaw', args: ['mcp', 'show'] },
  // ponytail: no yaml dependency — show hermes' own listing as masked raw text.
  hermes: { kind: 'cli', bin: 'hermes', args: ['mcp', 'list'], raw: true },
  // V8: kimi-code 0.39 has no MCP config file or `mcp` subcommand.
  kimi: { kind: 'note', note: 'not readable (ACP injection only)' },
  deepseek: { kind: 'note', note: 'not applicable' },
  'grok-bot': { kind: 'note', note: 'not applicable' },
};

export const NATIVE_MCP_AGENTS: ReadonlySet<string> = new Set(Object.keys(SOURCES));

const SECRET_FLAG = /^(--header|-H|--token|--api-key|--apikey|--auth|--password|--secret)$/i;

export function maskArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const out: string[] = [];
  let maskNext = false;
  for (const a of args.map(String)) {
    if (maskNext) { out.push(MASK); maskNext = false; continue; }
    const eq = a.indexOf('=');
    if (SECRET_FLAG.test(a)) { out.push(a); maskNext = true; continue; }
    if (/^--?(header|token|api-?key|auth|password|secret)=/i.test(a)) { out.push(`${a.slice(0, eq)}=${MASK}`); continue; }
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a.slice(0, eq))) { out.push(`${a.slice(0, eq)}=${MASK}`); continue; }
    out.push(a);
  }
  return out;
}

function maskMap(m: unknown): Record<string, string> | undefined {
  if (Array.isArray(m)) {
    // ACP-style [{name,value}] or ["K=V"]
    const o: Record<string, string> = {};
    for (const x of m) {
      if (typeof x === 'string') o[x.split('=')[0]] = MASK;
      else if (x && typeof x === 'object' && 'name' in x) o[String((x as any).name)] = MASK;
    }
    return Object.keys(o).length ? o : undefined;
  }
  if (!m || typeof m !== 'object') return undefined;
  const keys = Object.keys(m);
  return keys.length ? Object.fromEntries(keys.map((k) => [k, MASK])) : undefined;
}

export function maskRaw(text: string): string {
  return text
    .replace(/(bearer\s+)\S+/gi, `$1${MASK}`)
    .replace(/((?:token|key|secret|password|authorization)[\w-]*["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, `$1${MASK}`);
}

/** One config entry → McpNativeEntry. Handles claude/cursor/qwen/agy/kiro, opencode
 *  (`command: string[]`, `environment`), codex (`transport: {...}`) and pi (`transport: "cmd"`). */
export function toEntry(name: string, cfg: any, scope: Scope, file: string): McpNativeEntry {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const t = c.transport && typeof c.transport === 'object' ? { ...c, ...c.transport } : c;
  let command: string | undefined;
  let args: string[] | undefined;
  if (Array.isArray(t.command)) { command = String(t.command[0] ?? ''); args = maskArgs(t.command.slice(1)); }
  else if (typeof t.command === 'string') { command = t.command; args = maskArgs(t.args); }
  else if (typeof c.transport === 'string') { const [cmd, ...rest] = c.transport.split(/\s+/); command = cmd; args = maskArgs(rest); }
  const url = t.url ?? t.serverUrl ?? t.httpUrl;
  const transport = String(t.type ?? (url ? 'http' : command ? 'stdio' : 'unknown'));
  const enabled = typeof t.enabled === 'boolean' ? t.enabled : typeof t.disabled === 'boolean' ? !t.disabled : undefined;
  const env = maskMap(t.env ?? t.environment);
  const headers = maskMap(t.headers ?? t.http_headers);
  return {
    name, scope, transport, file,
    ...(command !== undefined ? { command } : {}),
    ...(args && args.length ? { args } : {}),
    ...(typeof url === 'string' ? { url: maskUrl(url) } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
  };
}

export function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.password) url.password = MASK;
    for (const k of [...url.searchParams.keys()]) {
      if (/token|key|secret|auth|password/i.test(k)) url.searchParams.set(k, MASK);
    }
    return decodeURI(url.toString());
  } catch { return 'invalid-url'; }
}

export function entriesFrom(parsed: unknown, scope: Scope, file: string): McpNativeEntry[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((x) => x && typeof x === 'object' && typeof x.name === 'string')
      .map((x) => toEntry(x.name, x, (x.scope as Scope) ?? scope, x.source ?? file));
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const p = parsed as any;
  if (Array.isArray(p.servers)) return entriesFrom(p.servers, scope, file);
  const map = p.mcpServers && typeof p.mcpServers === 'object' ? p.mcpServers : p;
  return Object.entries(map).map(([name, cfg]) => toEntry(name, cfg, scope, file));
}

/** Strip // and /* *\/ comments outside strings, and trailing commas. */
export function stripJsonc(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1); i = j; continue;
    }
    if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

type Run = (bin: string, args: string[], cwd: string) => Promise<string>;

const defaultRun: Run = (bin, args, cwd) => new Promise((resolve, reject) => {
  execFile(bin, args, { cwd, env: buildChildEnv(), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err && !stdout) reject(err); else resolve(String(stdout));
  });
});

export async function readNativeMcp(
  agentType: string,
  root: string | undefined,
  opts: { home?: string; run?: Run } = {},
): Promise<McpNativeView> {
  const src = SOURCES[agentType];
  if (!src) return { entries: [], errors: [`unknown agentType: ${agentType}`] };
  if (src.kind === 'note') return { entries: [], note: src.note };
  const home = opts.home ?? homedir();
  const entries: McpNativeEntry[] = [];
  const errors: string[] = [];
  if (src.kind === 'files') {
    const cache = new Map<string, unknown>();
    for (const f of src.files(home, root)) {
      let json = cache.get(f.path);
      if (json === undefined) {
        let text: string;
        try { text = await readFile(f.path, 'utf8'); } catch { cache.set(f.path, null); continue; }
        try { json = JSON.parse(f.jsonc ? stripJsonc(text) : text); } catch (err) {
          errors.push(`${f.path}: ${(err as Error).message}`); cache.set(f.path, null); continue;
        }
        cache.set(f.path, json);
      }
      if (json === null) continue;
      if (f.pickEntries) {
        entries.push(...f.pickEntries(json, f.path));
        continue;
      }
      const picked = f.pick ? f.pick(json, root) : json;
      if (picked && typeof picked === 'object') {
        entries.push(...Object.entries(picked as object).map(([n, cfg]) => toEntry(n, cfg, f.scope, f.path)));
      }
    }
    return { entries, ...(errors.length ? { errors } : {}) };
  }
  const label = `${src.bin} ${src.args.join(' ')}`;
  let out: string;
  try {
    out = await (opts.run ?? defaultRun)(src.bin, src.args, root ?? home);
  } catch (err) {
    return { entries: [], errors: [`${label}: ${((err as Error).message ?? '').split('\n')[0].slice(0, 200)}`] };
  }
  if (src.raw) return { entries: [], raw: maskRaw(out.trim()) };
  // openclaw prints a warning preamble before the JSON — start at the first line opening JSON.
  const start = out.search(/^[[{]/m);
  try {
    return { entries: entriesFrom(JSON.parse(start >= 0 ? out.slice(start) : out), 'user', label) };
  } catch {
    return { entries: [], raw: maskRaw(out.trim()), errors: [`${label}: output is not JSON`] };
  }
}

export class NativeWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'NativeWriteError';
  }
}

export const PLACEHOLDER_AGENTS: ReadonlySet<string> = new Set(['claude-code']);

export function placeholderName(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

export function hasJsoncComments(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      return true;
    }
  }
  return false;
}

export function buildNativeEntryCfg(
  agentType: string,
  row: McpServerRow,
  secretValues: { env: Record<string, string | undefined>; headers: Record<string, string | undefined> },
  opts: { copySecrets?: boolean } = {},
): { cfg: unknown; placeholderVars: string[]; secrets: 'none' | 'placeholders' | 'copied' } {
  if (!MCP_NATIVE_WRITABLE_AGENTS.has(agentType)) {
    throw new NativeWriteError(400, `agent ${agentType} not writable`);
  }
  if (!nativeWriteSupports(agentType, row.transport)) {
    throw new NativeWriteError(400, `transport ${row.transport} not supported for ${agentType}`);
  }

  const hasSecretEnv = row.env.some((v) => v.secret);
  const hasSecretHeaders = row.headers.some((h) => h.secret);
  const hasSecrets = hasSecretEnv || hasSecretHeaders;

  if (PLACEHOLDER_AGENTS.has(agentType)) {
    const placeholderVars: string[] = [];
    let cfg: unknown;
    if (row.transport === 'stdio') {
      const env: Record<string, string> = {};
      for (const v of row.env) {
        if (v.secret) {
          const pName = placeholderName(v.key);
          env[v.key] = `\${${pName}}`;
          if (!placeholderVars.includes(pName)) placeholderVars.push(pName);
        } else {
          env[v.key] = v.value ?? '';
        }
      }
      const entry: Record<string, unknown> = {
        type: 'stdio',
        command: row.command ?? '',
        args: row.args ?? [],
      };
      if (Object.keys(env).length > 0) entry.env = env;
      cfg = entry;
    } else {
      const headers: Record<string, string> = {};
      for (const h of row.headers) {
        if (h.secret) {
          const pName = placeholderName(h.key);
          headers[h.key] = `\${${pName}}`;
          if (!placeholderVars.includes(pName)) placeholderVars.push(pName);
        } else {
          headers[h.key] = h.value ?? '';
        }
      }
      const entry: Record<string, unknown> = {
        type: row.transport,
        url: row.url ?? '',
      };
      if (Object.keys(headers).length > 0) entry.headers = headers;
      cfg = entry;
    }
    return {
      cfg,
      placeholderVars,
      secrets: hasSecrets ? 'placeholders' : 'none',
    };
  }

  // All other writable agents:
  if (hasSecrets) {
    if (!opts.copySecrets) {
      throw new NativeWriteError(
        400,
        'server declares secret variable(s); set copySecrets: true to write literal secrets',
      );
    }
    const missing: string[] = [];
    for (const v of row.env.filter((e) => e.secret)) {
      if (secretValues.env[v.key] === undefined) missing.push(`env/${v.key}`);
    }
    for (const h of row.headers.filter((e) => e.secret)) {
      if (secretValues.headers[h.key] === undefined) missing.push(`header/${h.key}`);
    }
    if (missing.length > 0) {
      throw new NativeWriteError(400, `missing secret value(s): ${missing.join(', ')}`);
    }
  }

  const env: Record<string, string> = {};
  for (const v of row.env) {
    env[v.key] = v.secret ? (secretValues.env[v.key] ?? '') : (v.value ?? '');
  }
  const headers: Record<string, string> = {};
  for (const h of row.headers) {
    headers[h.key] = h.secret ? (secretValues.headers[h.key] ?? '') : (h.value ?? '');
  }

  let cfg: unknown;
  if (agentType === 'opencode' || agentType === 'kilocode') {
    if (row.transport === 'stdio') {
      const entry: Record<string, unknown> = {
        type: 'local',
        command: [row.command ?? '', ...(row.args ?? [])],
        enabled: true,
      };
      if (Object.keys(env).length > 0) entry.environment = env;
      cfg = entry;
    } else {
      const entry: Record<string, unknown> = {
        type: 'remote',
        url: row.url ?? '',
        enabled: true,
      };
      if (Object.keys(headers).length > 0) entry.headers = headers;
      cfg = entry;
    }
  } else {
    // antigravity, qwen, kiro, cursor (stdio only)
    const entry: Record<string, unknown> = {
      command: row.command ?? '',
      args: row.args ?? [],
    };
    if (Object.keys(env).length > 0) entry.env = env;
    cfg = entry;
  }

  return {
    cfg,
    placeholderVars: [],
    secrets: hasSecrets ? 'copied' : 'none',
  };
}

interface WriteTargetConfig {
  path: string;
  jsonc?: boolean;
  get: (root: any) => any;
  set: (root: any, map: any) => void;
}

function makeMcpServersTarget(path: string): WriteTargetConfig {
  return {
    path,
    get: (root: any) => {
      if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
      if (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers)) {
        root.mcpServers = {};
      }
      return root.mcpServers;
    },
    set: (root: any, map: any) => {
      if (!root || typeof root !== 'object' || Array.isArray(root)) return;
      root.mcpServers = map;
    },
  };
}

function makeMcpTarget(path: string): WriteTargetConfig {
  return {
    path,
    jsonc: true,
    get: (root: any) => {
      if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
      if (!root.mcp || typeof root.mcp !== 'object' || Array.isArray(root.mcp)) {
        root.mcp = {};
      }
      return root.mcp;
    },
    set: (root: any, map: any) => {
      if (!root || typeof root !== 'object' || Array.isArray(root)) return;
      root.mcp = map;
    },
  };
}

export const WRITES: Record<
  string,
  {
    user: (home: string) => WriteTargetConfig;
    project: (root: string) => WriteTargetConfig;
  }
> = {
  'claude-code': {
    user: (h) => makeMcpServersTarget(join(h, '.claude.json')),
    project: (r) => makeMcpServersTarget(join(r, '.mcp.json')),
  },
  antigravity: {
    user: (h) => makeMcpServersTarget(join(h, '.gemini', 'config', 'mcp_config.json')),
    project: (r) => makeMcpServersTarget(join(r, '.agents', 'mcp_config.json')),
  },
  qwen: {
    user: (h) => makeMcpServersTarget(join(h, '.qwen', 'settings.json')),
    project: (r) => makeMcpServersTarget(join(r, '.qwen', 'settings.json')),
  },
  kiro: {
    user: (h) => makeMcpServersTarget(join(h, '.kiro', 'settings', 'mcp.json')),
    project: (r) => makeMcpServersTarget(join(r, '.kiro', 'settings', 'mcp.json')),
  },
  cursor: {
    user: (h) => makeMcpServersTarget(join(h, '.cursor', 'mcp.json')),
    project: (r) => makeMcpServersTarget(join(r, '.cursor', 'mcp.json')),
  },
  opencode: {
    user: (h) => makeMcpTarget(join(h, '.config', 'opencode', 'opencode.json')),
    project: (r) => makeMcpTarget(join(r, 'opencode.json')),
  },
  kilocode: {
    user: (h) => makeMcpTarget(join(h, '.config', 'kilo', 'kilo.json')),
    project: (r) => makeMcpTarget(join(r, 'kilo.json')),
  },
};

const fileLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const absPath = resolve(filePath);
  const prev = fileLocks.get(absPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((r) => {
    release = r;
  });
  const next = prev.then(
    () => current,
    () => current,
  );
  fileLocks.set(absPath, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (fileLocks.get(absPath) === next) {
      fileLocks.delete(absPath);
    }
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const fh = await open(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
}

async function pruneOldBackups(parent: string, base: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  const prefix = `${base}.bak-`;
  const hits: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const p = join(parent, name);
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      hits.push({ path: p, mtimeMs: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of hits.slice(3)) {
    await unlink(old.path).catch(() => {});
  }
}

async function realpathExisting(start: string): Promise<string> {
  let cursor = start;
  for (;;) {
    try {
      return await realpath(cursor);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const next = dirname(cursor);
      if (next === cursor) throw e;
      cursor = next;
    }
  }
}

function assertInsideRoot(real: string, realRoot: string): void {
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new NativeWriteError(400, 'refusing to write outside the scope root (symlinked directory)');
  }
}

export async function mergeNativeFile(
  target: string,
  mutate: (root: any) => boolean,
  opts: { jsonc?: boolean; root: string },
): Promise<{ file: string; backup?: string; changed: boolean }> {
  const realRoot = await realpath(opts.root);
  const parent = dirname(target);
  assertInsideRoot(await realpathExisting(parent), realRoot);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  assertInsideRoot(realParent, realRoot);
  const safeTarget = join(realParent, basename(target));

  return withFileLock(safeTarget, async () => {
    try {
      const st = await lstat(safeTarget);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new NativeWriteError(400, `${basename(target)} is a symlink or not a regular file — refusing`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    let rawText: string | null = null;
    try {
      const fh = await open(safeTarget, FS.O_RDONLY | FS.O_NOFOLLOW);
      try {
        rawText = await fh.readFile('utf8');
      } finally {
        await fh.close();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw new NativeWriteError(400, `${basename(target)} is a symlink or not a regular file — refusing`);
      }
      if (code !== 'ENOENT') throw err;
    }

    let parsed: any = {};
    if (rawText !== null) {
      if (hasJsoncComments(rawText)) {
        throw new NativeWriteError(400, 'file contains JSONC comments that would be lost — edit it manually');
      }
      try {
        parsed = JSON.parse(opts.jsonc ? stripJsonc(rawText) : rawText);
      } catch (err) {
        throw new NativeWriteError(400, `failed to parse ${safeTarget}: ${(err as Error).message}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        parsed = {};
      }
    }

    const changed = mutate(parsed);
    if (!changed) {
      return { file: safeTarget, changed: false };
    }

    let backup: string | undefined;
    if (rawText !== null) {
      backup = join(realParent, `${basename(target)}.bak-${Date.now()}-${randomBytes(4).toString('hex')}`);
      await writeExclusive(backup, rawText);
      await pruneOldBackups(realParent, basename(target));
    }

    const newContent = JSON.stringify(parsed, null, 2) + '\n';
    const tmpPath = join(realParent, `.${basename(target)}.tierwyn-tmp-${randomBytes(8).toString('hex')}`);
    try {
      await writeExclusive(tmpPath, newContent);
      await rename(tmpPath, safeTarget);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    return { file: safeTarget, backup, changed: true };
  });
}

export async function installNativeMcp(
  agentType: string,
  row: McpServerRow,
  secretValues: { env: Record<string, string | undefined>; headers: Record<string, string | undefined> },
  opts: { scope: McpNativeWriteScope; root?: string; home?: string; copySecrets?: boolean },
): Promise<McpNativeInstallResult> {
  if (!MCP_NATIVE_WRITABLE_AGENTS.has(agentType)) {
    throw new NativeWriteError(400, `agent ${agentType} not writable`);
  }
  if (opts.scope === 'project' && !opts.root) {
    throw new NativeWriteError(400, 'root path required for project scope');
  }

  const { cfg, placeholderVars, secrets } = buildNativeEntryCfg(agentType, row, secretValues, {
    copySecrets: opts.copySecrets,
  });

  const home = opts.home ?? homedir();
  const writerDef = opts.scope === 'user' ? WRITES[agentType].user(home) : WRITES[agentType].project(opts.root!);
  const scopeRoot = opts.scope === 'project' ? opts.root! : home;

  let overwrote = false;
  const { file, backup } = await mergeNativeFile(
    writerDef.path,
    (root) => {
      const container = writerDef.get(root);
      overwrote = Object.prototype.hasOwnProperty.call(container, row.id);
      container[row.id] = cfg;
      writerDef.set(root, container);
      return true;
    },
    { jsonc: writerDef.jsonc, root: scopeRoot },
  );

  const entry = toEntry(row.id, cfg, opts.scope, file);

  return {
    ok: true,
    agentType,
    file,
    ...(backup ? { backup } : {}),
    overwrote,
    entry,
    secrets,
    ...(placeholderVars.length > 0 ? { placeholderVars } : {}),
  };
}

export async function removeNativeMcp(
  agentType: string,
  name: string,
  opts: { scope: McpNativeWriteScope; root?: string; home?: string },
): Promise<McpNativeRemoveResult> {
  if (!name || typeof name !== 'string' || name.length > 128 || name.includes('/') || name.includes('\0')) {
    throw new NativeWriteError(400, 'invalid entry name');
  }
  if (!MCP_NATIVE_WRITABLE_AGENTS.has(agentType)) {
    throw new NativeWriteError(400, `agent ${agentType} not writable`);
  }
  if (opts.scope === 'project' && !opts.root) {
    throw new NativeWriteError(400, 'root path required for project scope');
  }

  const home = opts.home ?? homedir();
  const writerDef = opts.scope === 'user' ? WRITES[agentType].user(home) : WRITES[agentType].project(opts.root!);
  const scopeRoot = opts.scope === 'project' ? opts.root! : home;

  let existed = false;
  const { file, backup } = await mergeNativeFile(
    writerDef.path,
    (root) => {
      const container = writerDef.get(root);
      if (!container || !Object.prototype.hasOwnProperty.call(container, name)) {
        return false;
      }
      existed = true;
      delete container[name];
      writerDef.set(root, container);
      return true;
    },
    { jsonc: writerDef.jsonc, root: scopeRoot },
  );

  if (!existed) {
    throw new NativeWriteError(404, `entry "${name}" not found in native config`);
  }

  return {
    ok: true,
    file,
    ...(backup ? { backup } : {}),
  };
}
