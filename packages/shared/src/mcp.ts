/**
 * Tierwyn-managed MCP server registry — shared contract (phase 1).
 * Guide: docs/architecture/mcp-servers.md. Secret values never cross this boundary.
 */

export type McpTransport = 'stdio' | 'http' | 'sse';
export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];

/** Where a server's process/connection lives. `auto` decides from the transport + URL. */
export type McpPlacement = 'auto' | 'agent' | 'hub';
export const MCP_PLACEMENTS: readonly McpPlacement[] = ['auto', 'agent', 'hub'];

/** Adapters that receive registry servers per session. Hermes from 0.22 (earlier versions ignore the field — that was why it was held back). */
export const MCP_INJECTABLE_ADAPTERS: ReadonlySet<string> = new Set([
  'claude-code', 'codex', 'qwen', 'kimi', 'kiro', 'grok-build', 'hermes', 'deepseek',
]);

/** Injectable adapters that take MCP over ACP `session/new` (transports gated by runtime caps). */
export const ACP_MCP_ADAPTERS: ReadonlySet<string> = new Set(['qwen', 'kimi', 'kiro', 'grok-build', 'hermes']);

/** Adapters that enforce the conversation's `disableNativeMcp` / `disabledNativeMcp` overrides
 *  (claude-code: `--strict-mcp-config` + per-server filter). */
export const MCP_NATIVE_OVERRIDE_ADAPTERS: ReadonlySet<string> = new Set(['claude-code']);

/** What Tierwyn's MCP controls actually do for one agent — drives honest UI (no silent no-ops). */
export interface McpAgentCapability {
  /** Tierwyn registry servers are passed to the agent at spawn. */
  registryInjection: 'supported' | 'unsupported';
  /** Per-conversation native-config overrides are enforced at spawn. */
  nativeOverrides: 'enforced' | 'ignored';
  /** Short human-readable exception, if any. */
  notes?: string;
}

const MCP_CAPABILITY_NOTES: Record<string, string> = {
  codex: 'Registry injection supports stdio + http only; sse servers are skipped.',
  deepseek: 'Registry injection supports stdio + streamable-http via dsh-mcp-client; sse servers are skipped.',
  qwen: 'ACP: http/sse injection depends on the agent’s advertised capabilities.',
  kimi: 'ACP: http/sse injection depends on the agent’s advertised capabilities.',
  kiro: 'ACP: http/sse injection depends on the agent’s advertised capabilities.',
  'grok-build': 'ACP: http/sse injection depends on the agent’s advertised capabilities.',
  hermes: 'ACP (hermes ≥ 0.22): http/sse injection depends on the agent’s advertised capabilities.',
  antigravity: 'Loads ~/.gemini/config/mcp_config.json itself; Tierwyn cannot filter it.',
  cursor: 'Loads ~/.cursor/mcp.json itself; Tierwyn cannot filter it.',
  opencode: 'Loads opencode.json `mcp` itself; Tierwyn cannot filter it.',
  kilocode: 'Loads kilo.json `mcp` itself; Tierwyn cannot filter it.',
};

export function mcpAgentCapability(agentType: string): McpAgentCapability {
  const notes = MCP_CAPABILITY_NOTES[agentType];
  return {
    registryInjection: MCP_INJECTABLE_ADAPTERS.has(agentType) ? 'supported' : 'unsupported',
    nativeOverrides: MCP_NATIVE_OVERRIDE_ADAPTERS.has(agentType) ? 'enforced' : 'ignored',
    ...(notes ? { notes } : {}),
  };
}

/** Server id == name. Lowercase slug, ≤32 chars. */
export const MCP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Env / header names: env-safe for env, RFC 7230 token chars for headers. */
export const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MCP_HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** Env-fallback names must use this prefix (captured + scrubbed at boot). */
export const MCP_ENV_FALLBACK_RE = /^TIERWYN_MCP_[A-Z0-9_]{1,96}$/;
export const MCP_MAX_ARGS = 32;
export const MCP_MAX_VARS = 32;
export const MCP_MAX_SELECTED = 32;

/** Stored descriptor. `value` only when !secret; `envFallback` only when secret. */
export interface McpVar {
  key: string;
  secret: boolean;
  value?: string;
  envFallback?: string;
}

/** Public var as returned by GET /mcp/servers — secret vars carry status, never values. */
export interface McpPublicVar {
  key: string;
  secret: boolean;
  value?: string;
  envFallback?: string;
  /** Secret vars only. */
  configured?: boolean;
  /** Secret vars only: where the value would be read from right now. */
  source?: 'vault' | 'env' | null;
}

export interface McpServerDef {
  id: string;
  transport: McpTransport;
  placement: McpPlacement;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  env: McpPublicVar[];
  headers: McpPublicVar[];
  description?: string;
  enabled: boolean;
  allowInDelegating: boolean;
  /** null = every injectable adapter. */
  agentTypes: string[] | null;
  createdAt: number;
  updatedAt: number;
}

/** POST /mcp/servers body (create or replace by id). Secret vars are descriptors only. */
export interface McpServerInput {
  id: string;
  transport: McpTransport;
  placement?: McpPlacement;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: McpVar[];
  headers?: McpVar[];
  description?: string;
  enabled?: boolean;
  allowInDelegating?: boolean;
  agentTypes?: string[] | null;
}

/** validateMcpServerInput output: every optional collection defaulted. */
export type McpServerNormalised = McpServerInput & {
  args: string[]; env: McpVar[]; headers: McpVar[];
  enabled: boolean; allowInDelegating: boolean; agentTypes: string[] | null;
  placement: McpPlacement;
};

export type McpSecretKind = 'env' | 'header';

export type ResolvedMcpSkipReason =
  | 'unknown'
  | 'disabled'
  | 'agent_not_injectable'
  | 'agent_filtered'
  | 'delegating_blocked'
  | 'transport_unsupported'
  | 'secret_missing'
  | 'secret_env_unsupported'
  | 'hub_placement_unsupported'
  | 'hub_cwd_unresolvable'
  | 'command_not_found_on_host'
  | 'cwd_outside_roots';

/** Server-internal: secret values inline in memory only. Never serialise to clients or logs. */
export interface ResolvedMcpServer {
  id: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  /** Remote sessions only: this server runs on the hub and is bridged per-call. */
  placement?: 'hub';
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Keys (in env / headers) whose value is a secret. */
  secretEnvKeys: string[];
  secretHeaderKeys: string[];
}

/** GET /conversations/:id/mcp. `selected: null` = inherit template default. */
export interface ConversationMcpView {
  selected: string[] | null;
  inherited: string[];
  /** Resolved for the conversation's current agent (`agentType`, null if no session yet). */
  agentType: string | null;
  delegating: boolean;
  effective: { id: string; injected: boolean; reason?: ResolvedMcpSkipReason }[];
  /** Whether native CLI MCP configs are disabled for this conversation. */
  disableNative?: boolean;
  /** Individual native CLI MCP server names disabled for this conversation. */
  disabledNative?: string[];
  /** True when conversation has custom MCP selection or disabled native MCPs. */
  modified?: boolean;
}

/** Check if conversation has modified/pinned MCP rules (non-default registry or native overrides). */
export function isMcpModified(
  selected: string[] | null | undefined,
  disableNative?: boolean,
  disabledNative?: string[],
): boolean {
  return (
    (selected !== null && selected !== undefined) ||
    disableNative === true ||
    Boolean(disabledNative && disabledNative.length > 0)
  );
}

export interface McpLiveStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  source: 'tierwyn' | 'native';
  toolCount?: number;
}

export type McpControlAction = 'enable' | 'disable' | 'reconnect';

export interface McpNativeEntry {
  name: string;
  scope: 'user' | 'project' | 'local' | 'workspace' | 'global';
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
  /** Masked to '••••'. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Source file, or `<cli> mcp list` for CLI-sourced rows. */
  file: string;
}

export interface McpNativeView {
  entries: McpNativeEntry[];
  errors?: string[];
  /** Raw text for agents with no structured reader (hermes). Masked heuristically. */
  raw?: string;
  /** Set when the agent has no readable native config. */
  note?: string;
}

/** Validate a selection list (PATCH conversation / template / role). */
export function validateMcpIdList(v: unknown, field = 'mcpServers'): string | null {
  if (!Array.isArray(v)) return `${field} must be an array of server ids`;
  if (v.length > MCP_MAX_SELECTED) return `${field}: at most ${MCP_MAX_SELECTED} ids`;
  for (const id of v) {
    if (typeof id !== 'string' || !MCP_ID_RE.test(id)) return `${field}: invalid id ${JSON.stringify(id)}`;
  }
  if (new Set(v).size !== v.length) return `${field}: duplicate ids`;
  return null;
}

function validateVars(v: unknown, kind: McpSecretKind): string | McpVar[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return `${kind} must be an array`;
  if (v.length > MCP_MAX_VARS) return `${kind}: at most ${MCP_MAX_VARS} entries`;
  const keyRe = kind === 'env' ? MCP_ENV_KEY_RE : MCP_HEADER_KEY_RE;
  const out: McpVar[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return `${kind}: entries must be objects`;
    const { key, secret, value, envFallback } = raw as Record<string, unknown>;
    if (typeof key !== 'string' || !keyRe.test(key)) return `${kind}: invalid key ${JSON.stringify(key)}`;
    const norm = kind === 'header' ? key.toLowerCase() : key;
    if (seen.has(norm)) return `${kind}: duplicate key ${key}`;
    seen.add(norm);
    if (typeof secret !== 'boolean') return `${kind}.${key}: secret must be boolean`;
    if (secret) {
      if (value !== undefined) return `${kind}.${key}: a secret var must not carry a value (use the secrets route)`;
      if (envFallback !== undefined && (typeof envFallback !== 'string' || !MCP_ENV_FALLBACK_RE.test(envFallback))) {
        return `${kind}.${key}: envFallback must match TIERWYN_MCP_[A-Z0-9_]+`;
      }
      out.push(envFallback ? { key, secret, envFallback } : { key, secret });
    } else {
      if (typeof value !== 'string' || value.length > 4096) return `${kind}.${key}: value must be a string ≤4096 chars`;
      if (envFallback !== undefined) return `${kind}.${key}: envFallback is only valid on secret vars`;
      out.push({ key, secret, value });
    }
  }
  return out;
}

const optStr = (v: unknown, max: number): v is string | undefined =>
  v === undefined || (typeof v === 'string' && v.length <= max);

/** Pure validation of POST /mcp/servers. Returns normalised input or an error string. */
export function validateMcpServerInput(body: unknown): { ok: true; value: McpServerNormalised } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!body || typeof body !== 'object') return fail('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || !MCP_ID_RE.test(b.id)) return fail('id must match /^[a-z0-9][a-z0-9_-]{0,31}$/');
  if (typeof b.transport !== 'string' || !MCP_TRANSPORTS.includes(b.transport as McpTransport)) {
    return fail('transport must be stdio | http | sse');
  }
  const transport = b.transport as McpTransport;
  if (b.placement !== undefined && !MCP_PLACEMENTS.includes(b.placement as McpPlacement)) {
    return fail('placement must be auto | agent | hub');
  }
  if (!optStr(b.command, 1024) || !optStr(b.cwd, 1024) || !optStr(b.url, 2048) || !optStr(b.description, 500)) {
    return fail('command/cwd/url/description must be strings of bounded length');
  }
  const args = b.args ?? [];
  if (!Array.isArray(args) || args.length > MCP_MAX_ARGS || args.some((a) => typeof a !== 'string' || a.length > 4096)) {
    return fail(`args must be an array of ≤${MCP_MAX_ARGS} strings`);
  }
  const env = validateVars(b.env, 'env');
  if (typeof env === 'string') return fail(env);
  const headers = validateVars(b.headers, 'header');
  if (typeof headers === 'string') return fail(headers);
  if (transport === 'stdio') {
    if (!b.command || !(b.command as string).trim()) return fail('stdio servers need a command');
    if (b.url !== undefined) return fail('stdio servers take no url');
    if (headers.length) return fail('stdio servers take no headers');
  } else {
    if (typeof b.url !== 'string' || !/^https?:\/\/\S+$/i.test(b.url)) return fail(`${transport} servers need an http(s) url`);
    if (b.command !== undefined || (args as string[]).length || b.cwd !== undefined) {
      return fail(`${transport} servers take no command/args/cwd`);
    }
    if (env.length) return fail(`${transport} servers take no env (use headers)`);
  }
  for (const f of ['enabled', 'allowInDelegating'] as const) {
    if (b[f] !== undefined && typeof b[f] !== 'boolean') return fail(`${f} must be boolean`);
  }
  let agentTypes: string[] | null = null;
  if (b.agentTypes !== undefined && b.agentTypes !== null) {
    if (!Array.isArray(b.agentTypes) || b.agentTypes.some((t) => typeof t !== 'string' || !MCP_INJECTABLE_ADAPTERS.has(t))) {
      return fail(`agentTypes must be null or a subset of ${[...MCP_INJECTABLE_ADAPTERS].join(', ')}`);
    }
    agentTypes = [...new Set(b.agentTypes as string[])];
  }
  return {
    ok: true,
    value: {
      id: b.id,
      transport,
      placement: (b.placement as McpPlacement | undefined) ?? 'auto',
      ...(b.command !== undefined ? { command: (b.command as string).trim() } : {}),
      ...(b.cwd !== undefined && (b.cwd as string).trim() ? { cwd: (b.cwd as string).trim() } : {}),
      ...(b.url !== undefined ? { url: b.url as string } : {}),
      ...(b.description !== undefined ? { description: b.description as string } : {}),
      args: args as string[],
      env,
      headers,
      enabled: b.enabled !== false,
      allowInDelegating: b.allowInDelegating === true,
      agentTypes,
    },
  };
}

/**
 * Where this server actually runs. Explicit `agent`/`hub` wins; `auto` keeps
 * stdio on the agent and puts http/sse on the hub when the URL points at a
 * loopback / private-network / mDNS address (the hub's own neighbourhood,
 * excluding link-local / IMDS), and on the agent for anything publicly routable.
 */
export function effectiveMcpPlacement(s: { transport: McpTransport; url?: string; placement: McpPlacement }): 'agent' | 'hub' {
  if (s.placement !== 'auto') return s.placement;
  if (s.transport === 'stdio') return 'agent';
  if (!s.url) return 'agent';
  let host: string;
  try {
    host = new URL(s.url).hostname;
  } catch {
    return 'agent';
  }
  return isHubNeighbourHost(host) ? 'hub' : 'agent';
}

function isHubNeighbourHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1); // one trailing dot: 'localhost.' ≡ 'localhost'
  if (!host) return true;
  if (host.includes(':')) {
    // IPv6 literal (WHATWG hostname keeps no brackets, may be compressed).
    if (host.startsWith('::ffff:')) {
      const v4 = v4FromMappedV6(host);
      return v4 !== null && isPrivateV4(v4);
    }
    if (host === '::1' || host === '::') return true;
    const first = v6FirstGroup(host);
    if (first === null) return false;
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateV4(host);
  return false;
}

/** `::ffff:7f00:1` (WHATWG's rewrite of `::ffff:127.0.0.1`) → `127.0.0.1`. */
function v4FromMappedV6(host: string): string | null {
  const rest = host.slice('::ffff:'.length);
  if (rest.includes('.')) return /^\d{1,3}(\.\d{1,3}){3}$/.test(rest) ? rest : null;
  const parts = rest.split(':').filter((p) => p.length > 0);
  if (parts.length !== 2) return null;
  const hi = Number.parseInt(parts[0], 16);
  const lo = Number.parseInt(parts[1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function v6FirstGroup(host: string): number | null {
  const head = host.split('::')[0];
  const first = head.split(':')[0];
  if (!first) return 0; // address begins with '::'
  const n = Number.parseInt(first, 16);
  return Number.isFinite(n) ? n : null;
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  return false;
}

export type McpNativeWriteScope = 'user' | 'project';

/** Agents whose native MCP config is a JSON file Tierwyn can merge-write. */
export const MCP_NATIVE_WRITABLE_AGENTS: ReadonlySet<string> = new Set([
  'claude-code', 'antigravity', 'qwen', 'kiro', 'cursor', 'opencode', 'kilocode',
]);

/** http/sse native writes are limited to agents with a well-known remote shape. */
export function nativeWriteSupports(agentType: string, transport: McpTransport): boolean {
  if (!MCP_NATIVE_WRITABLE_AGENTS.has(agentType)) return false;
  if (transport === 'stdio') return true;
  return agentType === 'claude-code' || agentType === 'opencode' || agentType === 'kilocode';
}

export interface McpNativeInstallInput {
  serverId: string;
  scope: McpNativeWriteScope;
  projectId?: string;      // required when scope === 'project'
  copySecrets?: boolean;    // see rule 3; ignored for claude-code
}

export interface McpNativeInstallResult {
  ok: true;
  agentType: string;
  file: string;
  backup?: string;          // set when a previous file existed
  overwrote: boolean;       // a native entry with the same name existed
  entry: McpNativeEntry;    // MASKED (build with the existing toEntry())
  secrets: 'none' | 'placeholders' | 'copied';
  placeholderVars?: string[]; // vars the operator must export for the agent (placeholder agents)
}

export interface McpNativeRemoveResult {
  ok: true;
  file: string;
  backup?: string;
}
