import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NodeHello } from '@tierwyn/shared';
import { openAgentSqliteReadonly } from '../adapters/agentSqlite.js';

type ProbeContents = 'codex' | 'claude' | 'grok';

type ProbeEntry = {
  files?: string[];
  env?: string[];
  platforms?: NodeJS.Platform[];
  contents?: ProbeContents;
  check?: (home: string, env: NodeJS.ProcessEnv) => boolean;
};

// ponytail: file contents, not CLI authStatus(). Expired-but-present tokens still
//           read as logged in. Upgrade path: per-adapter `authStatus()` spawn.
const PROBES: Record<string, ProbeEntry> = {
  'claude-code': { files: ['.claude/.credentials.json'], env: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], platforms: ['linux'], contents: 'claude' },
  codex: { files: ['.codex/auth.json'], env: ['OPENAI_API_KEY'], contents: 'codex' },
  'grok-build': { files: ['.grok/auth.json'], env: ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'], contents: 'grok' },
  copilot: { env: ['COPILOT_GITHUB_TOKEN'], check: copilotLoggedIn },
  cursor: { env: ['CURSOR_API_KEY'], check: cursorLoggedIn },
  kimi: { env: ['KIMI_API_KEY'], check: kimiLoggedIn },
  kiro: { env: ['KIRO_API_KEY'], check: kiroLoggedIn },
};

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function envDir(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function xdgConfigHome(home: string, env: NodeJS.ProcessEnv): string {
  return envDir(env, 'XDG_CONFIG_HOME') ?? join(home, '.config');
}

function xdgDataHome(home: string, env: NodeJS.ProcessEnv): string {
  return envDir(env, 'XDG_DATA_HOME') ?? join(home, '.local', 'share');
}

function readJson(path: string, stripComments = false): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return undefined; }
  if (stripComments) raw = raw.replace(/^\s*\/\/.*$/gm, '');
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return undefined; }
  return obj(json);
}

function grokHasTokens(root: Record<string, unknown>): boolean {
  if (nonEmpty(root.key) || nonEmpty(root.refresh_token)) return true;
  for (const v of Object.values(root)) {
    const o = obj(v);
    if (o && (nonEmpty(o.key) || nonEmpty(o.refresh_token))) return true;
  }
  return false;
}

/** Logged-in only when token material is actually present. Read/parse failure → false. */
function fileHasTokens(path: string, kind: ProbeContents | undefined): boolean {
  if (!existsSync(path)) return false;
  if (!kind) return true;
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return false; }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return false; }
  const root = obj(json);
  if (!root) return false;
  if (kind === 'codex') {
    if (nonEmpty(root.OPENAI_API_KEY) || nonEmpty(root.openai_api_key)) return true;
    const tokens = obj(root.tokens);
    return !!tokens && (nonEmpty(tokens.access_token) || nonEmpty(tokens.refresh_token));
  }
  if (kind === 'grok') return grokHasTokens(root);
  // claudeAiOauth only — leftover mcpOAuth metadata after logout is not a login.
  const oauth = obj(root.claudeAiOauth);
  return !!oauth && (nonEmpty(oauth.accessToken) || nonEmpty(oauth.refreshToken));
}

function copilotLoggedIn(home: string, env: NodeJS.ProcessEnv): boolean {
  const root = envDir(env, 'COPILOT_HOME') ?? join(home, '.copilot');
  const data = readJson(join(root, 'config.json'), true);
  if (!data) return false;
  if (nonEmpty(data.token) || nonEmpty(data.access_token) || nonEmpty(data.oauthToken) || nonEmpty(data.github_token)) {
    return true;
  }
  return Array.isArray(data.loggedInUsers) && data.loggedInUsers.length > 0;
}

function cursorAuthTokens(path: string): boolean {
  const data = readJson(path);
  return !!data && (nonEmpty(data.accessToken) || nonEmpty(data.refreshToken));
}

function cursorLoggedIn(home: string, env: NodeJS.ProcessEnv): boolean {
  if (cursorAuthTokens(join(xdgConfigHome(home, env), 'cursor', 'auth.json'))) return true;
  if (cursorAuthTokens(join(home, '.cursor', 'auth.json'))) return true;
  return cursorAuthTokens(join(home, 'Library', 'Application Support', 'Cursor', 'auth.json'));
}

function kimiTomlHasApiKey(raw: string): boolean {
  let inProviders = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inProviders = /^\[providers\.[^\]]+\]$/.test(t);
      continue;
    }
    if (!inProviders) continue;
    const m = t.match(/^api_key\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[1].replace(/\s+[;#].*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v.length > 0) return true;
  }
  return false;
}

function kimiLoggedIn(home: string, env: NodeJS.ProcessEnv): boolean {
  const root = envDir(env, 'KIMI_CODE_HOME') ?? join(home, '.kimi-code');
  const credDir = join(root, 'credentials');
  let names: string[] = [];
  try { names = readdirSync(credDir); } catch { /* missing dir */ }
  for (const name of names) {
    const data = readJson(join(credDir, name));
    if (data && nonEmpty(data.refreshToken)) return true;
  }
  const tomlPath = join(root, 'config.toml');
  if (!existsSync(tomlPath)) return false;
  let raw: string;
  try { raw = readFileSync(tomlPath, 'utf8'); } catch { return false; }
  return kimiTomlHasApiKey(raw);
}

const KIRO_AUTH_KEYS = [
  'kirocli:social:token',
  'kirocli:odic:token',
  'kirocli:external-idp:token',
  'codewhisperer:odic:token',
];

function kiroKvHasToken(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = JSON.parse(value);
    const o = obj(parsed);
    if (o) {
      return nonEmpty(o.access_token) || nonEmpty(o.refresh_token)
        || nonEmpty(o.accessToken) || nonEmpty(o.refreshToken);
    }
    return typeof parsed === 'string' && parsed.length > 0;
  } catch {
    return false;
  }
}

function kiroLoggedIn(home: string, env: NodeJS.ProcessEnv): boolean {
  const path = join(xdgDataHome(home, env), 'kiro-cli', 'data.sqlite3');
  let db: ReturnType<typeof openAgentSqliteReadonly>;
  try {
    db = openAgentSqliteReadonly(path, { busyMs: 250 });
  } catch {
    return false;
  }
  try {
    const placeholders = KIRO_AUTH_KEYS.map(() => '?').join(',');
    const rows = db.prepare(`SELECT key, value FROM auth_kv WHERE key IN (${placeholders})`)
      .all(...KIRO_AUTH_KEYS) as Array<{ key: string; value: unknown }>;
    return rows.some((row) => kiroKvHasToken(row.value));
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * Credential probe for the hello payload. Env-var presence still wins.
 * File probes that declare `contents` read JSON; existence-only otherwise.
 * `undefined` means "unknown" (no probe entry, or the platform stores
 * credentials somewhere we cannot check, e.g. the macOS keychain).
 */
export function probeLogin(
  type: string,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean | undefined {
  const probe = PROBES[type];
  if (!probe) return undefined;
  if (probe.platforms && !probe.platforms.includes(platform)) return undefined;
  for (const name of probe.env ?? []) {
    const v = env[name];
    if (typeof v === 'string' && v.length > 0) return true;
  }
  if (probe.check?.(home, env)) return true;
  for (const f of probe.files ?? []) {
    if (fileHasTokens(join(home, f), probe.contents)) return true;
  }
  return false;
}

export function probeAllLogins(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, boolean | undefined> {
  const loggedIn: Record<string, boolean | undefined> = {};
  for (const type of Object.keys(PROBES)) {
    loggedIn[type] = probeLogin(type, home, env, platform);
  }
  return loggedIn;
}

/**
 * Badge hello agents as logged in when the hub has actually delivered a vault
 * secret whose name matches one of that agent's env probes. Only fires when
 * the node advertised `agent_env` and the agent is installed; agents without
 * a probe entry stay `undefined`. Returns a new hello — the input is not
 * mutated. Hub-side only: the node's own file probe already ran in its hello.
 */
export function withDeliveredLogin(
  hello: Partial<NodeHello>,
  vars: ReadonlyArray<{ agentType: string; name: string }>,
): Partial<NodeHello> {
  if (vars.length === 0 || !hello.agents || !hello.features?.includes('agent_env')) return hello;
  const delivered = new Map<string, Set<string>>();
  for (const v of vars) {
    let names = delivered.get(v.agentType);
    if (!names) delivered.set(v.agentType, (names = new Set()));
    names.add(v.name);
  }
  let next: NodeHello['agents'] | undefined;
  for (const [type, info] of Object.entries(hello.agents)) {
    const probe = PROBES[type];
    if (!info.installed || !probe?.env?.length) continue;
    if (!probe.env.some((n) => delivered.get(type)?.has(n))) continue;
    next ??= { ...hello.agents };
    next[type] = { ...info, loggedIn: true };
  }
  return next ? { ...hello, agents: next } : hello;
}
