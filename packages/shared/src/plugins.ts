/**
 * Plugin system contract (phase 2). Shared between the server host and
 * (type-only) plugin authors. `credentials.source()` is `'vault' | 'env'`.
 */

export interface PluginUsageProviderDecl {
  /** Display label on the Settings → Agent Usage Providers section. */
  label: string;
  /** UI section key; defaults to `'providers'`. */
  section?: string;
  /** Regex pattern to match agent types (e.g. '^cursor$', '^(hermes|deepseek)$'). */
  matchAgent?: string;
  /** Regex pattern to match model names (e.g. '.*glm.*', '.*'). */
  matchModel?: string;
}

export interface PluginCapabilityDecl {
  name: string;
  summary: string;
  agentCallable: boolean;
  rateLimitPerMin?: number;
  /**
   * Handler timeout for this capability in ms (integer, 1..300000). Absent ⇒ host default
   * (15 s). Upper bound = Node's default http `requestTimeout` (300 s), past which the HTTP
   * request would be torn down anyway.
   */
  timeoutMs?: number;
  /**
   * When set, an active plugin contributes a Providers-section usage card.
   * The host surfaces `{ id, kind:'provider', label, source:'plugin', configured }`
   * with no credential values. Disabled / failed-to-activate plugins contribute nothing.
   */
  usageProvider?: PluginUsageProviderDecl;
}

export interface PluginCredentialDecl {
  key: string;
  required?: boolean;
  description?: string;
}

export interface PluginSettingDecl {
  key: string;
  type?: string;
  default?: unknown;
  description?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  capabilities: PluginCapabilityDecl[];
  credentials?: PluginCredentialDecl[];
  permissions?: string[];
  settings?: PluginSettingDecl[];
}

export interface PluginCaller {
  kind: 'agent' | 'operator';
  conversationId?: string;
  sessionId?: string;
}

export type PluginRouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

export interface PluginContext {
  manifest: PluginManifest;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /** Namespaced JSON settings (settings table, key = `plugin:<id>`). */
  settings: {
    get<T = Record<string, unknown>>(): T;
    set<T>(value: T): void;
  };
  /** Secret accessor — vault first, else boot-captured env fallback. */
  credentials: {
    get(key: string): string | undefined;
    source(key: string): 'vault' | 'env' | undefined;
  };
  /** fetch restricted to manifest `permissions` outbound hosts. */
  http: { fetch(url: string | URL, init?: RequestInit): Promise<Response> };
  capability(name: string, handler: (input: unknown, caller: PluginCaller) => Promise<unknown>): void;
  operatorRoute(method: 'get' | 'post', path: string, handler: PluginRouteHandler): void;
  onDeactivate(fn: () => void): void;
}

export type PluginErrorCode =
  | 'unknown_plugin'
  | 'unknown_capability'
  | 'not_agent_callable'
  | 'not_in_profile'
  | 'rate_limited'
  | 'credential_missing'
  | 'upstream_error'
  | 'timeout'
  | 'bad_input';

export type PluginEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: PluginErrorCode; retryable: boolean; retryAfter?: number };

export interface PluginCredentialStatus {
  key: string;
  configured: boolean;
  source: 'vault' | 'env' | undefined;
  /** Epoch ms when the vault row was last written; null for env-only. */
  updatedAt: number | null;
  /**
   * A vault row exists but cannot be opened with the current key
   * (key_id mismatch, GCM failure, or vault unavailable). Additive; omit/false
   * means the row is healthy or there is no row.
   */
  needsReentry?: boolean;
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  capabilities: Array<{ name: string; summary: string; agentCallable: boolean }>;
  credentials: PluginCredentialStatus[];
}

export interface PluginInvocationRow {
  id: number;
  ts: number;
  pluginId: string;
  capability: string;
  callerKind: string;
  conversationId: string | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
}

export interface PluginVaultStatus {
  available: boolean;
  reason?: string;
}

export interface PluginsResponse {
  plugins: PluginSummary[];
  vault: PluginVaultStatus;
}

/** Exact names that a manifest must not declare as credential keys. */
export const CREDENTIAL_KEY_BLOCKLIST = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TMPDIR',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
] as const;

/** Prefixes that a manifest must not declare as credential keys. */
export const CREDENTIAL_KEY_PREFIX_BLOCKLIST = ['LC_', 'XDG_', 'TIERWYN_'] as const;

const KEY_RE = /^[A-Z][A-Z0-9_]+$/;

/** True iff `key` is a legal dedicated credential name (not a child-CLI-needed var). */
export function isCredentialKeyAllowed(key: string): boolean {
  if (!KEY_RE.test(key)) return false;
  if ((CREDENTIAL_KEY_BLOCKLIST as readonly string[]).includes(key)) return false;
  for (const prefix of CREDENTIAL_KEY_PREFIX_BLOCKLIST) {
    if (key.startsWith(prefix)) return false;
  }
  return true;
}
