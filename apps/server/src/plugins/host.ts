/**
 * PluginHost — capability registry, invoke() enforcement, boot env-capture,
 * rate limits (per-caller + global per-plugin + global outbound), timeout,
 * redaction, journald `[plugins]` audit.
 */
import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type {
  PluginCaller,
  PluginContext,
  PluginEnvelope,
  PluginErrorCode,
  PluginManifest,
  PluginRouteHandler,
  PluginSummary,
} from '@tierwyn/shared';
import { vaultGet, vaultStatus, vaultAllValues, vaultVerify, vaultWriteSeq } from './vault.js';
import { recordInvocation } from './invocations.js';

const HANDLER_TIMEOUT_MS = 15_000; // default; a capability may override via manifest `timeoutMs`
const DEFAULT_PER_CALLER_PER_MIN = 30;
const GLOBAL_PER_PLUGIN_PER_MIN = 120;
const GLOBAL_OUTBOUND_PER_MIN = 60;
export const MIN_SECRET_LEN = 8;

const RETRYABLE: Record<PluginErrorCode, boolean> = {
  unknown_plugin: false,
  unknown_capability: false,
  not_agent_callable: false,
  not_in_profile: false,
  rate_limited: true,
  credential_missing: false,
  upstream_error: true,
  timeout: true,
  bad_input: false,
};

export const PLUGIN_ERROR_HTTP_STATUS: Record<PluginErrorCode, number> = {
  unknown_plugin: 404,
  unknown_capability: 404,
  not_agent_callable: 403,
  not_in_profile: 403,
  rate_limited: 429,
  credential_missing: 503,
  upstream_error: 502,
  timeout: 504,
  bad_input: 400,
};

type Handler = (input: unknown, caller: PluginCaller) => Promise<unknown>;

interface OperatorRoute {
  pluginId: string;
  method: 'get' | 'post';
  path: string;
  handler: PluginRouteHandler;
}

interface PluginRecord {
  manifest: PluginManifest;
  dir?: string;
  /** Agent-facing HELP.md text read at scan time (optional). */
  help?: string;
  /** Operator-disabled OR failed to activate this boot. */
  enabled: boolean;
  /** activate() completed without throw. */
  activated: boolean;
  handlers: Map<string, Handler>;
  deactivateFns: Array<() => void>;
}

export class MinuteBucket {
  private hits: number[] = [];
  constructor(private readonly limit: number, private readonly now: () => number) {}
  /** `limit` is read at try-time so Settings cap changes apply without restart. */
  try(limit: number = this.limit): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    const windowStart = now - 60_000;
    this.hits = this.hits.filter((t) => t > windowStart);
    if (this.hits.length >= limit) {
      const oldest = this.hits[0] ?? now;
      const retryAfter = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
      return { ok: false, retryAfter };
    }
    this.hits.push(now);
    return { ok: true };
  }
}

export class PluginHost {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly captured = new Map<string, string>();
  private readonly operatorRouteList: OperatorRoute[] = [];
  private readonly perCaller = new Map<string, MinuteBucket>();
  private readonly perPlugin = new Map<string, MinuteBucket>();
  private readonly outbound: MinuteBucket;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly getDb: () => Database;
  /** Memoised until the next vault write (`vaultWriteSeq`) or invoke(). */
  private redactVaultCache: string[] | undefined;
  private redactVaultSeq = -1;

  constructor(opts: {
    getDb: () => Database;
    timeoutMs?: number;
    now?: () => number;
  }) {
    this.getDb = opts.getDb;
    this.timeoutMs = opts.timeoutMs ?? HANDLER_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.outbound = new MinuteBucket(GLOBAL_OUTBOUND_PER_MIN, this.now);
  }

  captureCredentials(keys: string[]): void {
    for (const key of keys) {
      const value = process.env[key];
      if (typeof value === 'string' && value.length > 0) {
        this.captured.set(key, value);
      }
      delete process.env[key];
    }
  }

  /**
   * Vault-first, then boot-captured env. Vault reads are `(pluginId, key)`-scoped
   * — callers must pass the declaring plugin id (F14 probe: `'zai-usage'`).
   * Vault errors (unavailable / key mismatch / decrypt) fall back to env.
   */
  getCredential(key: string, pluginId: string): string | undefined {
    try {
      const hit = vaultGet(this.getDb(), pluginId, key);
      if (hit) return hit.value;
    } catch {
      // fail-closed / mismatch → env
    }
    return this.captured.get(key);
  }

  declaredCredentialKeys(): string[] {
    const keys = new Set<string>();
    for (const rec of this.plugins.values()) {
      for (const c of rec.manifest.credentials ?? []) keys.add(c.key);
    }
    for (const k of this.captured.keys()) keys.add(k);
    return [...keys];
  }

  addManifest(manifest: PluginManifest, opts: { enabled: boolean; dir?: string; help?: string }): PluginContext {
    const rec: PluginRecord = {
      manifest,
      dir: opts.dir,
      help: opts.help,
      enabled: opts.enabled,
      activated: false,
      handlers: new Map(),
      deactivateFns: [],
    };
    this.plugins.set(manifest.id, rec);
    return this.buildContext(manifest.id, manifest);
  }

  markActivated(pluginId: string): void {
    const rec = this.plugins.get(pluginId);
    if (rec) rec.activated = true;
  }

  markDisabled(pluginId: string): void {
    const rec = this.plugins.get(pluginId);
    if (rec) {
      rec.enabled = false;
      rec.activated = false;
    }
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  dirOf(id: string): string | undefined {
    return this.plugins.get(id)?.dir;
  }

  /**
   * Unload plugin immediately.
   * Runs deactivate fns, removes plugin record, removes operator routes in place,
   * clears rate-limit buckets (per-plugin and per-caller).
   * Note: an invoke() already holding the handler closure completes (D7 residual).
   */
  removePlugin(id: string): boolean {
    const rec = this.plugins.get(id);
    if (!rec) return false;
    for (const fn of rec.deactivateFns) {
      try { fn(); } catch (err) {
        console.warn(`[plugins] deactivate ${rec.manifest.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.plugins.delete(id);
    for (let i = this.operatorRouteList.length - 1; i >= 0; i--) {
      if (this.operatorRouteList[i]?.pluginId === id) {
        this.operatorRouteList.splice(i, 1);
      }
    }
    this.perPlugin.delete(id);
    const suffix = `::${id}`;
    for (const key of [...this.perCaller.keys()]) {
      if (key.endsWith(suffix)) {
        this.perCaller.delete(key);
      }
    }
    return true;
  }

  setEnabled(pluginId: string, enabled: boolean): boolean {
    const rec = this.plugins.get(pluginId);
    if (!rec) return false;
    rec.enabled = enabled;
    return true;
  }

  operatorRoutes(): OperatorRoute[] {
    return this.operatorRouteList.slice();
  }

  /**
   * Active plugins whose capabilities declare `usageProvider` contribute a
   * Providers-section entry. Disabled / failed-to-activate plugins are omitted
   * (no muted stub). `configured` is derived from captured required credentials
   * — never secret values.
   */
  listUsageProviders(): Array<{
    id: string;
    kind: 'provider';
    label: string;
    source: 'plugin';
    configured: boolean;
    capability: string;
    section: string;
  }> {
    const out: Array<{
      id: string;
      kind: 'provider';
      label: string;
      source: 'plugin';
      configured: boolean;
      capability: string;
      section: string;
    }> = [];
    for (const rec of this.sorted()) {
      if (!rec.enabled || !rec.activated) continue;
      for (const cap of rec.manifest.capabilities) {
        if (!cap.usageProvider) continue;
        const required = (rec.manifest.credentials ?? []).filter((c) => c.required);
        const configured = required.length === 0
          ? true
          : required.every((c) => this.credentialConfigured(rec.manifest.id, c.key));
        out.push({
          id: rec.manifest.id,
          kind: 'provider',
          label: cap.usageProvider.label,
          source: 'plugin',
          configured,
          capability: cap.name,
          section: cap.usageProvider.section ?? 'providers',
        });
      }
    }
    return out;
  }

  /**
   * Find an active usage provider matching the agent type and/or model name.
   * Matches against custom plugin settings (`matchAgent`, `matchModel`) or manifest defaults.
   */
  findUsageProviderForAgent(agentType?: string, modelName?: string): {
    pluginId: string;
    capability: string;
    label: string;
  } | undefined {
    if (!agentType) return undefined;
    for (const rec of this.sorted()) {
      if (!rec.enabled || !rec.activated) continue;
      for (const cap of rec.manifest.capabilities) {
        if (!cap.usageProvider) continue;
        const row = this.getDb().prepare('SELECT value FROM settings WHERE key = ?').get(`plugin:${rec.manifest.id}`) as
          | { value: string }
          | undefined;
        let settings: Record<string, unknown> = {};
        if (row) {
          try { settings = JSON.parse(row.value) as Record<string, unknown>; } catch { /* ignore */ }
        }
        const matchAgent = typeof settings.matchAgent === 'string' && settings.matchAgent.trim()
          ? settings.matchAgent.trim()
          : cap.usageProvider.matchAgent;
        const matchModel = typeof settings.matchModel === 'string' && settings.matchModel.trim()
          ? settings.matchModel.trim()
          : cap.usageProvider.matchModel;

        let agentMatches = false;
        if (matchAgent) {
          try {
            agentMatches = new RegExp(matchAgent, 'i').test(agentType);
          } catch {
            agentMatches = false;
          }
        }
        if (!agentMatches) continue;

        let modelMatches = true;
        if (matchModel && modelName) {
          try {
            modelMatches = new RegExp(matchModel, 'i').test(modelName);
          } catch {
            modelMatches = true;
          }
        }
        if (agentMatches && modelMatches) {
          return {
            pluginId: rec.manifest.id,
            capability: cap.name,
            label: cap.usageProvider.label,
          };
        }
      }
    }
    return undefined;
  }

  pluginSetHash(): string {
    const parts: string[] = [];
    const ids = [...this.plugins.keys()].sort();
    for (const id of ids) {
      const rec = this.plugins.get(id)!;
      if (!rec.enabled) continue;
      // Hash name + summary so rewording a capability summary forces a fresh
      // preamble (the roster prints the summary verbatim).
      const caps = rec.manifest.capabilities
        .filter((c) => c.agentCallable)
        .map((c) => `${c.name}:${c.summary}`)
        .sort();
      for (const cap of caps) parts.push(`${id}:${cap}`);
    }
    return createHash('sha256').update(parts.join(',')).digest('hex').slice(0, 12);
  }

  /** Agent-visible = enabled plus at least one agent-callable capability. */
  private agentVisible(rec: PluginRecord): boolean {
    return rec.enabled && rec.manifest.capabilities.some((c) => c.agentCallable);
  }

  listForAgent(): Array<{
    id: string;
    name: string;
    capabilities: Array<{ name: string; summary: string; usageProvider?: true }>;
    help?: string;
  }> {
    const out: Array<{
      id: string;
      name: string;
      capabilities: Array<{ name: string; summary: string; usageProvider?: true }>;
      help?: string;
    }> = [];
    for (const rec of this.sorted()) {
      if (!this.agentVisible(rec)) continue;
      const caps = rec.manifest.capabilities
        .filter((c) => c.agentCallable)
        .map((c) => ({
          name: c.name,
          summary: c.summary,
          ...(c.usageProvider ? { usageProvider: true as const } : {}),
        }));
      if (caps.length === 0) continue;
      out.push({
        id: rec.manifest.id,
        name: rec.manifest.name,
        capabilities: caps,
        ...(rec.help ? { help: `/agent/plugins/${rec.manifest.id}/help` } : {}),
      });
    }
    return out;
  }

  helpFor(id: string): { kind: 'ok'; text: string } | { kind: 'unknown' } | { kind: 'none' } {
    const rec = this.plugins.get(id);
    if (!rec || !this.agentVisible(rec)) return { kind: 'unknown' };
    if (!rec.help) return { kind: 'none' };
    return { kind: 'ok', text: rec.help };
  }

  listForOperator(): PluginSummary[] {
    return this.sorted().map((rec) => ({
      id: rec.manifest.id,
      name: rec.manifest.name,
      version: rec.manifest.version,
      enabled: rec.enabled,
      capabilities: rec.manifest.capabilities.map((c) => ({
        name: c.name,
        summary: c.summary,
        agentCallable: c.agentCallable,
      })),
      credentials: (rec.manifest.credentials ?? []).map((c) => this.credentialStatus(rec.manifest.id, c.key)),
    }));
  }

  deactivateAll(): void {
    for (const rec of this.plugins.values()) {
      for (const fn of rec.deactivateFns) {
        try { fn(); } catch (err) {
          console.warn(`[plugins] deactivate ${rec.manifest.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  async invoke(
    pluginId: string,
    capability: string,
    input: unknown,
    caller: PluginCaller,
  ): Promise<PluginEnvelope<unknown>> {
    const started = this.now();
    this.redactVaultCache = undefined;
    this.redactVaultSeq = -1;
    let envelope: PluginEnvelope<unknown> = this.fail('upstream_error', 'invoke did not settle');
    try {
      const rec = this.plugins.get(pluginId);
      if (!rec || !rec.enabled) {
        envelope = this.fail('unknown_plugin', 'unknown or disabled plugin');
        return envelope;
      }
      const decl = rec.manifest.capabilities.find((c) => c.name === capability);
      if (!decl) {
        envelope = this.fail('unknown_capability', `unknown capability ${capability}`);
        return envelope;
      }
      if (caller.kind === 'agent' && !decl.agentCallable) {
        envelope = this.fail('not_agent_callable', 'capability is not agent-callable');
        return envelope;
      }
      const handler = rec.handlers.get(capability);
      if (!handler) {
        envelope = this.fail('unknown_capability', `capability ${capability} has no handler`);
        return envelope;
      }

      const callerKey = caller.conversationId ?? 'operator';
      const perCaller = this.bucket(
        this.perCaller,
        `${callerKey}::${pluginId}`,
        decl.rateLimitPerMin ?? DEFAULT_PER_CALLER_PER_MIN,
      );
      const callerHit = perCaller.try();
      if (!callerHit.ok) {
        envelope = this.fail('rate_limited', 'per-caller rate limit exceeded', callerHit.retryAfter);
        return envelope;
      }
      const perPlugin = this.bucket(this.perPlugin, pluginId, GLOBAL_PER_PLUGIN_PER_MIN);
      const pluginHit = perPlugin.try();
      if (!pluginHit.ok) {
        envelope = this.fail('rate_limited', 'per-plugin rate limit exceeded', pluginHit.retryAfter);
        return envelope;
      }

      const result = await this.raceHandler(handler, input, caller, decl.timeoutMs ?? this.timeoutMs);
      envelope = { ok: true, data: this.redactValue(result) };
      return envelope;
    } catch (err) {
      envelope = this.mapThrown(err);
      return envelope;
    } finally {
      const durationMs = this.now() - started;
      const ok = envelope.ok;
      const code = envelope.ok ? undefined : envelope.code;
      const errorMsg = envelope.ok ? '' : envelope.error;
      const retryAfter = envelope.ok ? undefined : envelope.retryAfter;
      const safe = errorMsg ? this.redactSecrets(errorMsg) : '';
      console.log(
        `[plugins] plugin=${pluginId} capability=${capability} caller=${caller.kind}`
        + ` conversationId=${caller.conversationId ?? '-'} ok=${ok}`
        + ` durationMs=${durationMs}${code ? ` code=${code}` : ''}${safe ? ` error=${safe}` : ''}`
        + `${retryAfter !== undefined ? ` retryAfter=${retryAfter}` : ''}`,
      );
      try {
        recordInvocation(this.getDb(), {
          ts: started,
          pluginId,
          capability,
          callerKind: caller.kind,
          conversationId: caller.conversationId ?? null,
          ok,
          durationMs,
          error: envelope.ok ? null : (safe || null),
        });
      } catch (err) {
        console.warn(`[plugins] audit write failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private fail(code: PluginErrorCode, error: string, retryAfter?: number): PluginEnvelope<unknown> {
    return {
      ok: false,
      error: this.redactSecrets(error),
      code,
      retryable: RETRYABLE[code],
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }

  private async raceHandler(
    handler: Handler,
    input: unknown,
    caller: PluginCaller,
    timeoutMs: number,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('capability timed out'), { code: 'timeout' as const }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => handler(input, caller)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private mapThrown(err: unknown): PluginEnvelope<unknown> {
    const code = (err && typeof err === 'object' && 'code' in err)
      ? (err as { code?: unknown }).code
      : undefined;
    const retryAfter = (err && typeof err === 'object' && 'retryAfter' in err
      && typeof (err as { retryAfter?: unknown }).retryAfter === 'number')
      ? (err as { retryAfter: number }).retryAfter
      : undefined;
    const message = err instanceof Error ? err.message : String(err);
    let mapped: PluginErrorCode = 'upstream_error';
    if (code === 'credential_missing') mapped = 'credential_missing';
    else if (code === 'timeout') mapped = 'timeout';
    else if (code === 'rate_limited') mapped = 'rate_limited';
    else if (code === 'bad_input') mapped = 'bad_input';
    return {
      ok: false,
      error: this.redactSecrets(message),
      code: mapped,
      retryable: RETRYABLE[mapped],
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }

  private bucket(map: Map<string, MinuteBucket>, key: string, limit: number): MinuteBucket {
    let b = map.get(key);
    if (!b) {
      b = new MinuteBucket(limit, this.now);
      map.set(key, b);
    }
    return b;
  }

  redactSecrets(text: string): string {
    let out = text;
    let vaultValues: string[] = [];
    try {
      vaultValues = this.vaultValuesForRedact();
    } catch {
      vaultValues = [];
    }
    for (const value of [...this.captured.values(), ...vaultValues]) {
      if (!value || value.length < MIN_SECRET_LEN) continue;
      out = out.split(value).join('[REDACTED]');
    }
    return out;
  }

  private vaultValuesForRedact(): string[] {
    const seq = vaultWriteSeq();
    if (this.redactVaultCache !== undefined && this.redactVaultSeq === seq) return this.redactVaultCache;
    try {
      this.redactVaultCache = vaultAllValues(this.getDb());
    } catch {
      this.redactVaultCache = [];
    }
    this.redactVaultSeq = seq;
    return this.redactVaultCache;
  }

  private credentialConfigured(pluginId: string, key: string): boolean {
    try {
      if (vaultVerify(this.getDb(), pluginId, key) === 'ok') return true;
    } catch {
      // table missing / vault error → env only
    }
    return this.captured.has(key);
  }

  private credentialStatus(pluginId: string, key: string): PluginSummary['credentials'][number] {
    let verify: ReturnType<typeof vaultVerify> = 'missing';
    try {
      verify = vaultVerify(this.getDb(), pluginId, key);
    } catch {
      verify = 'missing';
    }
    const row = (() => {
      try { return vaultStatus(this.getDb(), pluginId, key); } catch { return undefined; }
    })();
    if (verify === 'ok') {
      return { key, configured: true, source: 'vault', updatedAt: row?.updatedAt ?? null, needsReentry: false };
    }
    if (verify === 'mismatch' || verify === 'undecryptable' || verify === 'unavailable') {
      return {
        key,
        configured: false,
        source: 'vault',
        updatedAt: row?.updatedAt ?? null,
        needsReentry: true,
      };
    }
    if (this.captured.has(key)) {
      return { key, configured: true, source: 'env', updatedAt: null, needsReentry: false };
    }
    return { key, configured: false, source: undefined, updatedAt: null, needsReentry: false };
  }

  private redactValue(data: unknown): unknown {
    if (data === undefined) return data;
    let raw: string;
    try {
      raw = JSON.stringify(data);
    } catch {
      return data;
    }
    if (raw === undefined) return data;
    const red = this.redactSecrets(raw);
    if (red === raw) return data;
    try { return JSON.parse(red) as unknown; } catch { return red; }
  }

  private buildContext(pluginId: string, manifest: PluginManifest): PluginContext {
    const declaredKeys = new Set((manifest.credentials ?? []).map((c) => c.key));
    const settingsKey = `plugin:${pluginId}`;
    const allowedOrigins = (manifest.permissions ?? [])
      .filter((p) => p.startsWith('outbound:'))
      .flatMap((p) => {
        try { return [new URL(p.slice('outbound:'.length)).origin]; } catch { return []; }
      });

    const fetchAllowed = async (url: string | URL, init?: RequestInit, followsLeft = 1): Promise<Response> => {
      let parsed: URL;
      try {
        parsed = url instanceof URL ? url : new URL(String(url));
      } catch {
        throw Object.assign(new Error(`invalid url: ${String(url)}`), { code: 'upstream_error' as const });
      }
      if (!allowedOrigins.includes(parsed.origin)) {
        throw Object.assign(new Error(`origin not allowed: ${parsed.origin}`), { code: 'upstream_error' as const });
      }
      const hit = this.outbound.try();
      if (!hit.ok) {
        throw Object.assign(new Error('outbound rate limit exceeded'), {
          code: 'rate_limited' as const,
          retryAfter: hit.retryAfter,
        });
      }
      const res = await fetch(parsed, { ...init, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc || followsLeft <= 0) {
          throw Object.assign(new Error(`redirect not followed (HTTP ${res.status})`), { code: 'upstream_error' as const });
        }
        let next: URL;
        try { next = new URL(loc, parsed); } catch {
          throw Object.assign(new Error('redirect Location is not a valid URL'), { code: 'upstream_error' as const });
        }
        if (!allowedOrigins.includes(next.origin)) {
          throw Object.assign(new Error(`redirect origin not allowed: ${next.origin}`), { code: 'upstream_error' as const });
        }
        return fetchAllowed(next, init, 0);
      }
      return res;
    };

    return {
      manifest,
      log: {
        info: (msg) => console.log(`[plugins:${pluginId}] ${msg}`),
        warn: (msg) => console.warn(`[plugins:${pluginId}] ${msg}`),
        error: (msg) => console.error(`[plugins:${pluginId}] ${msg}`),
      },
      settings: {
        get: <T = Record<string, unknown>>(): T => {
          const row = this.getDb().prepare('SELECT value FROM settings WHERE key = ?').get(settingsKey) as
            | { value: string }
            | undefined;
          if (!row) return {} as T;
          try { return JSON.parse(row.value) as T; } catch { return {} as T; }
        },
        set: <T>(value: T): void => {
          this.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
            settingsKey,
            JSON.stringify(value),
          );
        },
      },
      credentials: {
        get: (key: string): string | undefined => {
          if (!declaredKeys.has(key)) return undefined;
          return this.getCredential(key, pluginId);
        },
        source: (key: string): 'vault' | 'env' | undefined => {
          if (!declaredKeys.has(key)) return undefined;
          try {
            if (vaultVerify(this.getDb(), pluginId, key) === 'ok') return 'vault';
          } catch {
            // unavailable / mismatch → env if captured
          }
          return this.captured.has(key) ? 'env' : undefined;
        },
      },
      http: { fetch: (url, init) => fetchAllowed(url, init) },
      capability: (name, handler) => {
        const rec = this.plugins.get(pluginId);
        if (!rec) return;
        rec.handlers.set(name, handler);
      },
      operatorRoute: (method, path, handler) => {
        if (!this.plugins.has(pluginId)) return;
        this.operatorRouteList.push({ pluginId, method, path, handler });
      },
      onDeactivate: (fn) => {
        const rec = this.plugins.get(pluginId);
        if (rec) rec.deactivateFns.push(fn);
      },
    };
  }

  private sorted(): PluginRecord[] {
    return [...this.plugins.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }
}

export { RETRYABLE as PLUGIN_ERROR_RETRYABLE };
