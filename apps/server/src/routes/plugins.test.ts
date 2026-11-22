import { execFileSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { PluginHost, PLUGIN_ERROR_HTTP_STATUS, MIN_SECRET_LEN } from '../plugins/host.js';
import { registerPluginAgentRoutes, registerPluginOperatorRoutes, resolvePluginCaller, MAX_CREDENTIAL_LEN } from './plugins.js';
import { AGENT_USAGE_ERROR_MAX, buildAgentUsageForAgent, buildUnifiedUsage, buildUsageTarget, _resetUsageProviderCache, type AgentUsageDeps } from './agentUsage.js';
import { issueSpawnToken, CONVERSATION_CAPABILITIES, type TokenCapability } from '../spawn/tokens.js';
import { requireAuth } from '../auth/middleware.js';
import { initVaultKey, vaultSet, vaultAvailable, vaultGet } from '../plugins/vault.js';
import { listInvocations } from '../plugins/invocations.js';
import { buildChildEnv, setPluginScrubKeys } from '../childEnv.js';
import { getPluginState } from '../repositories/settings.js';
import type { PluginErrorCode, PluginManifest, PluginsResponse, ResolvedCapabilityProfile } from '@tierwyn/shared';

const VAULT_SECRET = 'abcdefghijklmnopqrstuvwxyz012345';
const UNIQUE_CRED = 'UNIQUE-CRED-VALUE-NEVER-ECHO-xyz';

let server: Server;
let base: string;
let host: PluginHost;
let db: Database.Database;
let isAuthed = false;
let clock = 1_700_000_000_000;
let usageDeps: { agentDeps?: AgentUsageDeps };

const ALL_CODES: PluginErrorCode[] = [
  'unknown_plugin',
  'unknown_capability',
  'not_agent_callable',
  'rate_limited',
  'credential_missing',
  'upstream_error',
  'timeout',
  'bad_input',
  'not_in_profile',
];

function plugin(over: Partial<PluginManifest> & { id: string }): PluginManifest {
  return {
    name: over.id,
    version: '1.0.0',
    apiVersion: 1,
    capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true }],
    ...over,
  };
}

async function listen(app: express.Express): Promise<void> {
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
}

beforeEach(async () => {
  isAuthed = false;
  db = new Database(':memory:');
  runMigrations(db, migrations);
  host = new PluginHost({ getDb: () => db, timeoutMs: 40 });
  const ctx = host.addManifest(plugin({
    id: 'demo',
    capabilities: [
      { name: 'echo', summary: 'echo', agentCallable: true },
      { name: 'op.only', summary: 'op', agentCallable: false },
    ],
  }), { enabled: true });
  ctx.capability('echo', async (input, caller) => {
    const mode = (input as { mode?: string }).mode;
    if (mode === 'missing') {
      throw Object.assign(new Error('no key'), { code: 'credential_missing' });
    }
    if (mode === 'upstream') throw new Error('boom');
    if (mode === 'timeout') await new Promise((r) => setTimeout(r, 200));
    if (mode === 'bad') throw Object.assign(new Error('nope'), { code: 'bad_input' });
    return { caller: caller.kind, conversationId: caller.conversationId ?? null, input };
  });
  ctx.capability('op.only', async () => ({ secret: true }));
  host.markActivated('demo');

  const app = express();
  app.use(express.json());
  clock = 1_700_000_000_000;
  _resetUsageProviderCache();
  usageDeps = { agentDeps: stubBuiltinDeps() };
  registerPluginAgentRoutes(app, {
    host,
    isAuthed: () => isAuthed,
    // Indirection so tests can re-point usageDeps.agentDeps per case.
    getUsage: (caller) => buildUnifiedUsage(usageDeps.agentDeps!, host, caller),
    getUsageTarget: (target, caller) => buildUsageTarget(target, usageDeps.agentDeps!, host, caller),
    now: () => clock,
  });
  registerPluginOperatorRoutes(app, { host, getDb: () => db });
  await listen(app);
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('plugin agent auth', () => {
  it('rejects a schedule-scoped token', async () => {
    const tok = issueSpawnToken('conv-s', 'sess-s', 'schedule');
    const res = await fetch(`${base}/agent/plugins/demo/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a spawn+schedule set that does not include plugin', async () => {
    const tok = issueSpawnToken('conv-np', 'sess-np', new Set<TokenCapability>(['spawn', 'schedule']));
    const res = await fetch(`${base}/agent/plugins/demo/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts a spawn-scoped token', async () => {
    const tok = issueSpawnToken('conv-p', 'sess-p', 'spawn');
    const res = await fetch(`${base}/agent/plugins/demo/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; data: { caller: string; conversationId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.caller).toBe('agent');
    expect(body.data.conversationId).toBe('conv-p');
  });

  it('accepts a plain conversation token ({schedule, plugin} — CONVERSATION_CAPABILITIES)', async () => {
    const tok = issueSpawnToken('conv-c', 'sess-c', CONVERSATION_CAPABILITIES);
    const res = await fetch(`${base}/agent/plugins/demo/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; data: { caller: string; conversationId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.caller).toBe('agent');
    expect(body.data.conversationId).toBe('conv-c');
  });

  it('bearer + cookie ⇒ kind:agent (spawn-scoped bearer wins)', async () => {
    isAuthed = true;
    const tok = issueSpawnToken('conv-b', 'sess-b', 'spawn');
    const res = await fetch(`${base}/agent/plugins/demo/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Cookie: 'tierwyn=fake' },
      body: '{}',
    });
    const body = await res.json() as { ok: true; data: { caller: string; conversationId: string } };
    expect(body.data.caller).toBe('agent');
    expect(body.data.conversationId).toBe('conv-b');
  });
});

describe('plugin error HTTP mapping', () => {
  it('maps every PluginErrorCode to its documented status', async () => {
    expect(Object.keys(PLUGIN_ERROR_HTTP_STATUS).sort()).toEqual([...ALL_CODES].sort());
    expect(PLUGIN_ERROR_HTTP_STATUS).toEqual({
      unknown_plugin: 404,
      unknown_capability: 404,
      not_agent_callable: 403,
      rate_limited: 429,
      credential_missing: 503,
      upstream_error: 502,
      timeout: 504,
      bad_input: 400,
      not_in_profile: 403,
    });

    const tok = issueSpawnToken('conv-e', 'sess-e', 'spawn');
    async function post(name: string, body: unknown): Promise<{ status: number; code?: string }> {
      const res = await fetch(`${base}/agent/plugins/demo/capabilities/${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as { code?: string };
      return { status: res.status, code: json.code };
    }

    expect(await post('nope', {})).toMatchObject({ status: 404, code: 'unknown_capability' });
    const missingPlugin = await fetch(`${base}/agent/plugins/no-such/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(missingPlugin.status).toBe(404);
    expect((await missingPlugin.json() as { code: string }).code).toBe('unknown_plugin');

    expect(await post('op.only', {})).toMatchObject({ status: 403, code: 'not_agent_callable' });
    expect(await post('echo', { mode: 'missing' })).toMatchObject({ status: 503, code: 'credential_missing' });
    expect(await post('echo', { mode: 'upstream' })).toMatchObject({ status: 502, code: 'upstream_error' });
    expect(await post('echo', { mode: 'timeout' })).toMatchObject({ status: 504, code: 'timeout' });
    expect(await post('echo', { mode: 'bad' })).toMatchObject({ status: 400, code: 'bad_input' });

    const tight = host.addManifest(plugin({
      id: 'tight',
      capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true, rateLimitPerMin: 1 }],
    }), { enabled: true });
    tight.capability('echo', async () => 1);
    host.markActivated('tight');
    await fetch(`${base}/agent/plugins/tight/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const rl = await fetch(`${base}/agent/plugins/tight/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(rl.status).toBe(429);
    expect((await rl.json() as { code: string }).code).toBe('rate_limited');
    expect(rl.headers.get('retry-after')).toBeTruthy();
  });
});

describe('resolvePluginCaller', () => {
  it('ignores a schedule token even when a cookie is present... wait, cookie still authenticates as operator', () => {
    // Documented: schedule tokens fall through; cookie ⇒ operator.
    const req = {
      headers: { authorization: `Bearer ${issueSpawnToken('c', 's', 'schedule')}` },
    } as never;
    expect(resolvePluginCaller(req, () => true)).toEqual({ kind: 'operator' });
    expect(resolvePluginCaller(req, () => false)).toBeNull();
  });
});

describe('operatorRoute request-time dispatch (R1)', () => {
  it('serves a handler registered via ctx.operatorRoute() after mount/activation', async () => {
    // beforeEach already called registerPluginOperatorRoutes. Activate a
    // late plugin afterwards — mount-time snapshots would miss this route.
    const ctx = host.addManifest(plugin({
      id: 'late-op',
      capabilities: [{ name: 'noop', summary: 'noop', agentCallable: false }],
    }), { enabled: true });
    ctx.operatorRoute('get', '/ping', (_req, res) => {
      (res as import('express').Response).json({ pong: true });
    });
    host.markActivated('late-op');

    const res = await fetch(`${base}/plugins/late-op/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it('does not steal GET /plugins catalogue', async () => {
    const res = await fetch(`${base}/plugins`);
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: Array<{ id: string }> };
    expect(Array.isArray(body.plugins)).toBe(true);
    expect(body.plugins.some((p) => p.id === 'demo')).toBe(true);
  });
});

describe('operator credential write + invocations', () => {
  function assertNoCred(body: unknown): void {
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(UNIQUE_CRED);
  }

  beforeEach(() => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const ctx = host.addManifest(plugin({
      id: 'cred',
      credentials: [{ key: 'DEMO_KEY' }, { key: 'OPENAI_API_KEY' }],
    }), { enabled: true });
    ctx.capability('echo', async () => 1);
    host.markActivated('cred');
  });

  afterEach(() => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
  });

  it('PUT without cookie ⇒ 401', async () => {
    const app = express();
    app.use(express.json());
    app.use(requireAuth({
      disabled: false,
      configured: true,
      sessionSecret: 'unit-test-session-secret-value-32bytes',
      passwordHash: 'not-used',
      cookieSecure: false,
    }));
    registerPluginOperatorRoutes(app, { host, getDb: () => db });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/plugins/cred/credentials/DEMO_KEY`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: UNIQUE_CRED }),
      });
      expect(r.status).toBe(401);
      assertNoCred(await r.json());
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });

  it('unknown plugin ⇒ 404; undeclared key ⇒ 400; blocklisted key ⇒ 400; vault unavailable ⇒ 503', async () => {
    const missing = await fetch(`${base}/plugins/no-such/credentials/DEMO_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: UNIQUE_CRED }),
    });
    expect(missing.status).toBe(404);
    assertNoCred(await missing.json());

    const undeclared = await fetch(`${base}/plugins/cred/credentials/OTHER_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: UNIQUE_CRED }),
    });
    expect(undeclared.status).toBe(400);
    assertNoCred(await undeclared.json());

    const blocked = await fetch(`${base}/plugins/cred/credentials/OPENAI_API_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: UNIQUE_CRED }),
    });
    expect(blocked.status).toBe(400);
    assertNoCred(await blocked.json());

    initVaultKey({ sessionSecret: '' });
    expect(vaultAvailable()).toBe(false);
    const down = await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: UNIQUE_CRED }),
    });
    expect(down.status).toBe(503);
    const downBody = await down.json() as { error: string };
    expect(downBody.error).toMatch(/no derivation secret ≥32 bytes/);
    assertNoCred(downBody);
    initVaultKey({ sessionSecret: VAULT_SECRET });
  });

  it('PUT stores; GET /plugins never echoes the value; DELETE clears (or reveals env)', async () => {
    const put = await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: UNIQUE_CRED }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as PluginsResponse;
    assertNoCred(putBody);
    const cred = putBody.plugins.find((p) => p.id === 'cred')!.credentials.find((c) => c.key === 'DEMO_KEY')!;
    expect(cred).toMatchObject({ configured: true, source: 'vault' });
    expect(cred.updatedAt).toBeTypeOf('number');

    const listed = await fetch(`${base}/plugins`);
    const listBody = await listed.json() as PluginsResponse;
    expect(listBody.vault.available).toBe(true);
    assertNoCred(listBody);
    expect(listBody.plugins.find((p) => p.id === 'cred')!.credentials.find((c) => c.key === 'DEMO_KEY')!.source).toBe('vault');

    const del = await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const delBody = await del.json() as PluginsResponse;
    assertNoCred(delBody);
    const after = delBody.plugins.find((p) => p.id === 'cred')!.credentials.find((c) => c.key === 'DEMO_KEY')!;
    expect(after.configured).toBe(false);
    expect(after.source).toBeUndefined();

    const delAgain = await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, { method: 'DELETE' });
    expect(delAgain.status).toBe(404);
    assertNoCred(await delAgain.json());
  });

  it('deep-search PUT/GET/DELETE/invocations bodies never contain the credential value', async () => {
    await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: UNIQUE_CRED }),
    });
    const tok = issueSpawnToken('conv-c', 'sess-c', 'spawn');
    // Make the capability throw the secret so the invocation error is recorded.
    const thrower = host.addManifest(plugin({
      id: 'leaky',
      credentials: [{ key: 'DEMO_KEY' }],
    }), { enabled: true });
    thrower.capability('echo', async () => {
      throw new Error(`leaked ${UNIQUE_CRED}`);
    });
    host.markActivated('leaky');
    vaultSet(db, 'leaky', 'DEMO_KEY', UNIQUE_CRED);
    const inv = await fetch(`${base}/agent/plugins/leaky/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const invBody = await inv.json();
    assertNoCred(invBody);

    for (const url of [
      `${base}/plugins`,
      `${base}/plugins/leaky/invocations?limit=10`,
      `${base}/plugins/cred/invocations`,
    ]) {
      const r = await fetch(url);
      assertNoCred(await r.json());
    }
    const del = await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, { method: 'DELETE' });
    assertNoCred(await del.json());
  });

  it('invocations route returns safe error text only and respects limit clamp', async () => {
    const tok = issueSpawnToken('conv-i', 'sess-i', 'spawn');
    await fetch(`${base}/agent/plugins/demo/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'upstream' }),
    });
    await fetch(`${base}/agent/plugins/demo/capabilities/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{}',
    });

    const missing = await fetch(`${base}/plugins/no-such/invocations`);
    expect(missing.status).toBe(404);

    const all = await fetch(`${base}/plugins/demo/invocations`);
    expect(all.status).toBe(200);
    const body = await all.json() as { invocations: Array<{ ok: boolean; error: string | null; capability: string }> };
    expect(body.invocations.length).toBeGreaterThanOrEqual(2);
    expect(body.invocations[0]!.capability).toBe('echo');
    for (const row of body.invocations) {
      if (row.error) {
        expect(row.error).not.toContain(UNIQUE_CRED);
        expect(typeof row.error).toBe('string');
      }
    }

    const clamped = await fetch(`${base}/plugins/demo/invocations?limit=1`);
    const one = await clamped.json() as { invocations: unknown[] };
    expect(one.invocations).toHaveLength(1);

    const over = await fetch(`${base}/plugins/demo/invocations?limit=999`);
    const overBody = await over.json() as { invocations: unknown[] };
    expect(overBody.invocations.length).toBeLessThanOrEqual(200);
  });

  it('PUT rejects values shorter than the redaction floor and longer than the cap', async () => {
    const short = 'a'.repeat(MIN_SECRET_LEN - 1);
    const shortRes = await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: short }),
    });
    expect(shortRes.status).toBe(400);
    const shortBody = await shortRes.json() as { error: string };
    expect(shortBody.error).toMatch(/at least 8/);
    expect(JSON.stringify(shortBody)).not.toContain(short);

    const long = 'b'.repeat(MAX_CREDENTIAL_LEN + 1);
    const longRes = await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: long }),
    });
    expect(longRes.status).toBe(400);
    const longBody = await longRes.json() as { error: string };
    expect(longBody.error).toMatch(/at most 4096/);
    expect(JSON.stringify(longBody)).not.toContain(long.slice(0, 32));

    const ok = 'c'.repeat(MIN_SECRET_LEN);
    const okRes = await fetch(`${base}/plugins/cred/credentials/DEMO_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: ok }),
    });
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json() as PluginsResponse;
    expect(JSON.stringify(okBody)).not.toContain(ok);
    expect(okBody.plugins.find((p) => p.id === 'cred')!.credentials.find((c) => c.key === 'DEMO_KEY')!.configured).toBe(true);
  });
});

function stubBuiltinDeps(over: Partial<AgentUsageDeps> = {}): AgentUsageDeps {
  return {
    isInstalled: () => true,
    probeClaude: vi.fn(async () => ({ fiveHourPct: 12 })),
    probeCodex: vi.fn(async () => ({ fiveHourPct: 8, subscriptionType: 'plus' })),
    probeGrok: vi.fn(async () => ({ sevenDayPct: 55 })),
    probeAgyGroups: vi.fn(async () => [{ id: 'gemini', label: 'Gemini', limits: { fiveHourPct: 21 } }]),
    probeKiro: vi.fn(async () => ({ monthlyPct: 2.8 })),
    probeClaudeInsights: vi.fn(async () => ({}) as never),
    probeCodexInsights: vi.fn(async () => ({}) as never),
    probeAntigravityInsights: vi.fn(async () => ({}) as never),
    listUsageProviders: () => [{ id: 'zai-usage', label: 'Z.AI', capability: 'usage.get', configured: true }],
    ...over,
  };
}

function agentUsageUrl(): string {
  return `${base}/agent/usage`;
}

describe('GET /agent/usage (builtin quota projection)', () => {
  it('401s without any credentials', async () => {
    const res = await fetch(agentUsageUrl());
    expect(res.status).toBe(401);
  });

  it('401s with a schedule-scoped token', async () => {
    const tok = issueSpawnToken('conv-su', 'sess-su', 'schedule');
    const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(401);
  });

  it('401s with a {spawn,schedule} token lacking plugin', async () => {
    const tok = issueSpawnToken('conv-np', 'sess-np', new Set<TokenCapability>(['spawn', 'schedule']));
    const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(401);
  });

  it('200s with a spawn-scoped token and returns 5 builtin agents in order', async () => {
    const tok = issueSpawnToken('conv-u', 'sess-u', 'spawn');
    const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      builtins: Array<{ agentType: string }>;
      agents: Array<{ agentType: string }>;
      providers: unknown[];
      updatedAt: number;
    };
    expect(body.builtins.map((a) => a.agentType)).toEqual(['claude-code', 'codex', 'antigravity', 'grok-build', 'kiro', 'copilot']);
    // Deprecated alias kept for older consumers.
    expect(body.agents).toEqual(body.builtins);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.updatedAt).toEqual(expect.any(Number));
  });

  it('stamps profiles onto builtin cards for catalogue rows of that agentType', async () => {
    const tok = issueSpawnToken('conv-prof', 'sess-prof', 'spawn');
    const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builtins: Array<{ agentType: string; profiles?: Array<{ profileId: string; agentType: string }> }> };
    const cc = body.builtins.find((a) => a.agentType === 'claude-code');
    expect(cc?.profiles).toBeDefined();
    expect(Array.isArray(cc?.profiles)).toBe(true);
    // Seeded catalogue has enabled claude-code rows; every stamped ref must match the card.
    for (const p of cc!.profiles!) expect(p.agentType).toBe('claude-code');
  });

  it('200s for the operator cookie', async () => {
    isAuthed = true;
    const res = await fetch(agentUsageUrl(), { headers: { Cookie: 'tierwyn=fake' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builtins: unknown[] };
    expect(body.builtins).toHaveLength(6);
  });

  it('body is agent-safe: allowlisted keys only, no provider card, insights never called', async () => {
    const deps = stubBuiltinDeps();
    usageDeps.agentDeps = deps;
    const tok = issueSpawnToken('conv-safe', 'sess-safe', 'spawn');
    const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builtins: Array<Record<string, unknown>> };
    const allow = ['agentType', 'label', 'installed', 'subscriptionType', 'updatedAt', 'groups', 'error', 'profiles'];
    for (const entry of body.builtins) {
      expect(Object.keys(entry).every((k) => allow.includes(k))).toBe(true);
    }
    expect(body.builtins.map((a) => a.agentType)).toEqual(['claude-code', 'codex', 'antigravity', 'grok-build', 'kiro', 'copilot']);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('pluginId');
    expect(raw).not.toContain('installHint');
    expect(raw).not.toContain('builtinAvailable');
    expect(deps.probeClaudeInsights).not.toHaveBeenCalled();
    expect(deps.probeCodexInsights).not.toHaveBeenCalled();
    expect(deps.probeAntigravityInsights).not.toHaveBeenCalled();
  });

  it('never forces a probe (?fresh ignored)', async () => {
    const deps = stubBuiltinDeps();
    usageDeps.agentDeps = deps;
    const tok = issueSpawnToken('conv-fresh', 'sess-fresh', 'spawn');
    const res = await fetch(`${agentUsageUrl()}?fresh=1`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    expect(deps.probeClaude).toHaveBeenCalledWith({ force: false });
    expect(deps.probeCodex).toHaveBeenCalledWith({ force: false });
    expect(deps.probeGrok).toHaveBeenCalledWith({ force: false });
    expect(deps.probeAgyGroups).toHaveBeenCalledWith({ force: false });
    expect(deps.probeKiro).toHaveBeenCalledWith({ force: false });
  });

  it('truncates probe errors to AGENT_USAGE_ERROR_MAX', async () => {
    const deps = stubBuiltinDeps({
      probeKiro: vi.fn(async () => {
        throw new Error('e'.repeat(500));
      }),
    });
    usageDeps.agentDeps = deps;
    const tok = issueSpawnToken('conv-err', 'sess-err', 'spawn');
    const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builtins: Array<{ agentType: string; error?: string }> };
    const kiro = body.builtins.find((a) => a.agentType === 'kiro');
    expect(kiro?.error).toBeDefined();
    expect(kiro?.error?.length).toBe(AGENT_USAGE_ERROR_MAX);
  });

  it('rate limits per conversation at 6/min', async () => {
    const tokA = issueSpawnToken('conv:A', 'sess:A', 'spawn');
    for (let i = 0; i < 6; i++) {
      const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tokA}` } });
      expect(res.status).toBe(200);
    }
    const limited = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tokA}` } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    const limitedBody = (await limited.json()) as { retryAfter: number };
    expect(limitedBody.retryAfter).toBeGreaterThan(0);

    const tokB = issueSpawnToken('conv:B', 'sess:B', 'spawn');
    const other = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tokB}` } });
    expect(other.status).toBe(200);

    clock += 60_001;
    const recovered = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tokA}` } });
    expect(recovered.status).toBe(200);
  });

  it('401s do not consume the per-conversation rate-limit bucket', async () => {
    const blocked = issueSpawnToken('conv-noburn', 'sess-noburn', 'schedule');
    for (let i = 0; i < 6; i++) {
      const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${blocked}` } });
      expect(res.status).toBe(401);
    }
    const allowed = issueSpawnToken('conv-noburn', 'sess-noburn-ok', 'spawn');
    for (let i = 0; i < 6; i++) {
      const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${allowed}` } });
      expect(res.status).toBe(200);
    }
    const limited = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${allowed}` } });
    expect(limited.status).toBe(429);
  });

  it('operator bucket is separate from agent buckets', async () => {
    const tok = issueSpawnToken('conv:op', 'sess:op', 'spawn');
    for (let i = 0; i < 6; i++) {
      const res = await fetch(agentUsageUrl(), { headers: { Authorization: `Bearer ${tok}` } });
      expect(res.status).toBe(200);
    }
    isAuthed = true;
    const op = await fetch(agentUsageUrl(), { headers: { Cookie: 'tierwyn=fake' } });
    expect(op.status).toBe(200);
  });
});

describe('agent usage wiring', () => {
  it('404s when getUsage / getUsageTarget are not wired', async () => {
    const app2 = express();
    app2.use(express.json());
    registerPluginAgentRoutes(app2, { host, isAuthed: () => true });
    const srv = await new Promise<Server>((resolve) => {
      const s = app2.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = srv.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/agent/usage`, { headers: { Cookie: 'tierwyn=fake' } });
      expect(res.status).toBe(404);
      const res2 = await fetch(`http://127.0.0.1:${addr.port}/agent/usage/claude-code`, { headers: { Cookie: 'tierwyn=fake' } });
      expect(res2.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('GET /agent/usage/:target', () => {
  function addZai(onInvoke: () => Promise<unknown> = async () => ({ groups: [{ id: 'default', label: 'Z.AI', fiveHourPct: 42 }] })): void {
    const ctx = host.addManifest(plugin({
      id: 'zai-usage',
      capabilities: [{ name: 'usage.get', summary: 'usage', agentCallable: true, usageProvider: { label: 'Z.AI' } }],
    }), { enabled: true });
    ctx.capability('usage.get', onInvoke);
    host.markActivated('zai-usage');
  }

  it('200s for one builtin and probes only that agent', async () => {
    const deps = stubBuiltinDeps();
    usageDeps.agentDeps = deps;
    const tok = issueSpawnToken('conv-t1', 'sess-t1', 'spawn');
    const res = await fetch(`${agentUsageUrl()}/claude-code`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builtin: { agentType: string; groups: unknown[] }; updatedAt: number };
    expect(body.builtin.agentType).toBe('claude-code');
    expect(body.updatedAt).toEqual(expect.any(Number));
    expect(deps.probeClaude).toHaveBeenCalledTimes(1);
    expect(deps.probeCodex).not.toHaveBeenCalled();
    expect(deps.probeGrok).not.toHaveBeenCalled();
    expect(deps.probeAgyGroups).not.toHaveBeenCalled();
    expect(deps.probeKiro).not.toHaveBeenCalled();
  });

  it('200s for a provider target and invokes it', async () => {
    addZai();
    const tok = issueSpawnToken('conv-t2', 'sess-t2', 'spawn');
    const res = await fetch(`${agentUsageUrl()}/zai-usage`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: { id: string; ok: boolean; configured: boolean }; updatedAt: number };
    expect(body.provider.id).toBe('zai-usage');
    expect(body.provider.ok).toBe(true);
    expect(body.provider.configured).toBe(true);
    expect(body.updatedAt).toEqual(expect.any(Number));
  });

  it('503s for an unconfigured provider without invoking it', async () => {
    const spy = vi.fn(async () => ({ groups: [] }));
    const ctx = host.addManifest(plugin({
      id: 'kilo-usage',
      credentials: [{ key: 'KILO_KEY', required: true, description: 'kilo key' }],
      capabilities: [{ name: 'usage.get', summary: 'usage', agentCallable: true, usageProvider: { label: 'Kilo' } }],
    }), { enabled: true });
    ctx.capability('usage.get', spy);
    host.markActivated('kilo-usage');
    const tok = issueSpawnToken('conv-t3', 'sess-t3', 'spawn');
    const res = await fetch(`${agentUsageUrl()}/kilo-usage`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { provider: { code?: string }; updatedAt: number };
    expect(body.provider.code).toBe('not_configured');
    expect(body.updatedAt).toEqual(expect.any(Number));
    expect(spy).not.toHaveBeenCalled();
  });

  it('404s with the valid-targets list for an unknown target', async () => {
    addZai();
    const tok = issueSpawnToken('conv-t4', 'sess-t4', 'spawn');
    const res = await fetch(`${agentUsageUrl()}/nope`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; targets: string[] };
    expect(body.error).toBe('unknown usage target');
    expect(body.targets[0]).toBe('claude-code');
    expect(body.targets).toContain('zai-usage');
  });

  it('stamps profiles on a single builtin target', async () => {
    const tok = issueSpawnToken('conv-tgt', 'sess-tgt', 'spawn');
    const res = await fetch(`${agentUsageUrl()}/claude-code`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builtin: { profiles?: unknown[] } };
    expect(Array.isArray(body.builtin.profiles)).toBe(true);
  });
});

describe('GET /agent/plugins/:id/help', () => {
  beforeEach(() => {
    host.addManifest(plugin({ id: 'helped' }), { enabled: true, help: '# helped\n\ndocs here\n' });
  });

  it('401 with no auth', async () => {
    const res = await fetch(`${base}/agent/plugins/helped/help`);
    expect(res.status).toBe(401);
  });

  it('401 with a schedule-only token', async () => {
    const tok = issueSpawnToken('conv-h1', 'sess-h1', 'schedule');
    const res = await fetch(`${base}/agent/plugins/helped/help`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(401);
  });

  it('200 text/markdown with a plugin-scope token; body equals the help text', async () => {
    const tok = issueSpawnToken('conv-h2', 'sess-h2', 'spawn');
    const res = await fetch(`${base}/agent/plugins/helped/help`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toBe('# helped\n\ndocs here\n');
  });

  it('200 with the operator cookie', async () => {
    isAuthed = true;
    const res = await fetch(`${base}/agent/plugins/helped/help`, {
      headers: { Cookie: 'tierwyn=fake' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# helped\n\ndocs here\n');
  });

  it('404 unknown plugin for an unknown id and for a disabled plugin', async () => {
    const tok = issueSpawnToken('conv-h3', 'sess-h3', 'spawn');
    const missing = await fetch(`${base}/agent/plugins/no-such/help`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'unknown plugin' });

    host.addManifest(plugin({ id: 'offed' }), { enabled: false, help: '# off' });
    const disabled = await fetch(`${base}/agent/plugins/offed/help`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: 'unknown plugin' });
  });

  it('404 no help (with hint) for a visible plugin without help', async () => {
    const tok = issueSpawnToken('conv-h4', 'sess-h4', 'spawn');
    const res = await fetch(`${base}/agent/plugins/demo/help`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'no help for this plugin',
      hint: 'capability summaries are in GET /agent/plugins; protocol in GET /agent/plugins/help',
    });
  });

  it('/agent/plugins/help protocol doc mentions the per-plugin endpoint', async () => {
    const res = await fetch(`${base}/agent/plugins/help`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();
    expect(text).toContain('/agent/plugins/:id/help');
    expect(text).toContain('claude-code');
    expect(text).not.toMatch(/`claude` = Claude Code/);
  });
});

describe('capability profile enforcement', () => {
  const mediaProfile: ResolvedCapabilityProfile = { id: 'media', plugins: ['gemini-image'], usage: false };
  const usageProfile: ResolvedCapabilityProfile = { id: 'usage', plugins: [], usage: true };

  function addGemini(): void {
    const ctx = host.addManifest(plugin({
      id: 'gemini-image',
      capabilities: [{ name: 'image.generate', summary: 'img', agentCallable: true }],
    }), { enabled: true });
    ctx.capability('image.generate', async () => ({ image: true }));
    host.markActivated('gemini-image');
  }

  function addZai(): void {
    const ctx = host.addManifest(plugin({
      id: 'zai-usage',
      capabilities: [{ name: 'usage.get', summary: 'quota', agentCallable: true, usageProvider: { label: 'Z.AI' } }],
    }), { enabled: true });
    ctx.capability('usage.get', async () => ({ fiveHourPct: 42 }));
    host.markActivated('zai-usage');
  }

  function bearer(profile: ResolvedCapabilityProfile, conversationId: string): string {
    return issueSpawnToken(conversationId, `sess-${conversationId}`, 'spawn', profile);
  }

  function post(path: string, tok: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: '{}',
    });
  }

  it('media token: ungranted capability invoke answers 403 not_in_profile, retryable:false', async () => {
    addGemini();
    const tok = bearer(mediaProfile, 'conv-m');
    const res = await post('/agent/plugins/demo/capabilities/echo', tok);
    expect(res.status).toBe(403);
    const body = await res.json() as { ok: boolean; code: string; retryable: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('not_in_profile');
    expect(body.retryable).toBe(false);
    expect(body.error).toContain('capability profile');
  });

  it('media token: usage endpoints 403 without consuming the rate bucket', async () => {
    const tok = bearer(mediaProfile, 'conv-bucket');
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${base}/agent/usage`, { headers: { authorization: `Bearer ${tok}` } });
      expect(res.status).toBe(403);
    }
    // Same conversation, a usage-granting profile: the bucket is untouched
    // (403s ran before it), so this serves instead of 429.
    const usageTok = bearer(usageProfile, 'conv-bucket');
    const ok = await fetch(`${base}/agent/usage`, { headers: { authorization: `Bearer ${usageTok}` } });
    expect(ok.status).toBe(200);
  });

  it('media token: roster filters to the grant; /help 403s for the rest', async () => {
    addGemini();
    const tok = bearer(mediaProfile, 'conv-m');
    const list = await fetch(`${base}/agent/plugins`, { headers: { authorization: `Bearer ${tok}` } });
    expect(list.status).toBe(200);
    const body = await list.json() as { plugins: Array<{ id: string }> };
    expect(body.plugins.map((p) => p.id)).toEqual(['gemini-image']);

    const help = await fetch(`${base}/agent/plugins/demo/help`, { headers: { authorization: `Bearer ${tok}` } });
    expect(help.status).toBe(403);
    expect(((await help.json()) as { code: string }).code).toBe('not_in_profile');
  });

  it('unknown plugin under a narrow profile answers 403, never 404 (no existence oracle)', async () => {
    const tok = bearer(mediaProfile, 'conv-m');
    const res = await post('/agent/plugins/nope/capabilities/echo', tok);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('not_in_profile');
  });

  it('usage token: usageProvider capability callable, everything else denied', async () => {
    addZai();
    const tok = bearer(usageProfile, 'conv-u');
    const ok = await post('/agent/plugins/zai-usage/capabilities/usage.get', tok);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);

    const denied = await post('/agent/plugins/demo/capabilities/echo', tok);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe('not_in_profile');
  });

  it('GET /agent/plugins keeps usageProvider caps for an all token', async () => {
    addZai();
    addGemini();
    const tok = bearer({ id: 'all', plugins: '*', usage: true }, 'conv-list');
    const list = await fetch(`${base}/agent/plugins`, { headers: { authorization: `Bearer ${tok}` } });
    expect(list.status).toBe(200);
    const body = await list.json() as { plugins: Array<{ id: string; capabilities: Array<{ name: string; usageProvider?: true }> }> };
    const zai = body.plugins.find((p) => p.id === 'zai-usage');
    expect(zai).toBeDefined();
    expect(zai!.capabilities.some((c) => c.name === 'usage.get' && c.usageProvider === true)).toBe(true);
  });

  it('plugins:"*" grants usage endpoints even when usage is false', async () => {
    const tok = bearer({ id: 'star', plugins: '*', usage: false }, 'conv-star');
    const res = await fetch(`${base}/agent/usage`, { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });

  it('default all token keeps every agent-callable surface', async () => {
    const tok = bearer({ id: 'all', plugins: '*', usage: true }, 'conv-all');
    const invoke = await post('/agent/plugins/demo/capabilities/echo', tok);
    expect(invoke.status).toBe(200);
    const usage = await fetch(`${base}/agent/usage`, { headers: { authorization: `Bearer ${tok}` } });
    expect(usage.status).toBe(200);
  });

  it('operator cookie is never profile-restricted; a bearer still wins over the cookie', async () => {
    addGemini();
    isAuthed = true;

    const cookieOnly = await fetch(`${base}/agent/plugins`);
    expect(cookieOnly.status).toBe(200);
    const wide = await cookieOnly.json() as { plugins: Array<{ id: string }> };
    expect(wide.plugins.map((p) => p.id)).toEqual(expect.arrayContaining(['demo', 'gemini-image']));

    const tok = bearer(mediaProfile, 'conv-m');
    const both = await fetch(`${base}/agent/plugins`, {
      headers: { authorization: `Bearer ${tok}`, cookie: 'tierwyn_session=irrelevant' },
    });
    expect(both.status).toBe(200);
    const filtered = await both.json() as { plugins: Array<{ id: string }> };
    expect(filtered.plugins.map((p) => p.id)).toEqual(['gemini-image']);
  });
});

describe('plugin import/delete', () => {
  let pluginsTestDir: string;
  let savedPluginsDirEnv: string | undefined;
  let savedPluginsPrefEnv: string | undefined;

  beforeEach(() => {
    savedPluginsDirEnv = process.env.TIERWYN_PLUGINS_DIR;
    savedPluginsPrefEnv = process.env.TIERWYN_PLUGINS;
    pluginsTestDir = mkdtempSync(join(process.cwd(), '.plugins-test-'));
    process.env.TIERWYN_PLUGINS_DIR = pluginsTestDir;
    initVaultKey({ sessionSecret: VAULT_SECRET });
  });

  afterEach(() => {
    if (savedPluginsDirEnv === undefined) delete process.env.TIERWYN_PLUGINS_DIR;
    else process.env.TIERWYN_PLUGINS_DIR = savedPluginsDirEnv;
    if (savedPluginsPrefEnv === undefined) delete process.env.TIERWYN_PLUGINS;
    else process.env.TIERWYN_PLUGINS = savedPluginsPrefEnv;
    if (pluginsTestDir && existsSync(pluginsTestDir)) {
      rmSync(pluginsTestDir, { recursive: true, force: true });
    }
  });

  function createArchive(opts: {
    id: string;
    inSubdir?: boolean;
    manifest?: Record<string, unknown>;
    indexJs?: string;
    symlink?: { target: string; link: string };
    dotDotMember?: boolean;
    invalidGzip?: boolean;
  }): Buffer {
    const staging = mkdtempSync(join(tmpdir(), 'archive-src-'));
    try {
      const pluginRoot = opts.inSubdir ? join(staging, opts.id) : staging;
      if (opts.inSubdir) mkdirSync(pluginRoot, { recursive: true });

      const m = opts.manifest ?? {
        id: opts.id,
        name: opts.id,
        version: '1.0.0',
        apiVersion: 1,
        capabilities: [{ name: 'test.cap', summary: 'test', agentCallable: true }],
      };
      writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify(m));
      writeFileSync(
        join(pluginRoot, 'index.js'),
        opts.indexJs ?? 'export default { activate(ctx) { ctx.capability("test.cap", async () => ({ hello: "world" })); } };\n',
      );

      if (opts.symlink) {
        symlinkSync(opts.symlink.target, join(pluginRoot, opts.symlink.link));
      }

      const outDir = mkdtempSync(join(tmpdir(), 'archive-out-'));
      const outFile = join(outDir, 'out.tar.gz');
      try {
        if (opts.inSubdir) {
          execFileSync('tar', ['-czf', outFile, '-C', staging, opts.id]);
        } else {
          execFileSync('tar', ['-czf', outFile, '-C', staging, '.']);
        }

        let buf = Buffer.from(execFileSync('cat', [outFile]));

        if (opts.invalidGzip) {
          buf = Buffer.from('not a gzip file at all');
        }

        return buf;
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  function createDotDotArchive(): Buffer {
    const staging = mkdtempSync(join(tmpdir(), 'dotdot-src-'));
    try {
      mkdirSync(join(staging, 'safe'), { recursive: true });
      writeFileSync(join(staging, 'safe', 'plugin.json'), JSON.stringify({ id: 'safe' }));
      writeFileSync(join(staging, 'safe', 'index.js'), 'export default {};');
      const outFile = join(staging, 'out.tar.gz');
      // Create archive with --transform to inject ..
      execFileSync('tar', ['--transform', 's,^safe,../safe,', '-czf', outFile, '-C', staging, 'safe']);
      return Buffer.from(execFileSync('cat', [outFile]));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  it('POST /plugins imports a valid archive and the capability is invocable immediately', async () => {
    isAuthed = true;
    const archive = createArchive({ id: 'importable' });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'importable.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    if (res.status !== 200) {
      console.log('IMPORT ERROR STATUS:', res.status, await res.json());
    }
    expect(res.status).toBe(200);
    const body = await res.json() as PluginsResponse;
    expect(body.plugins.some((p) => p.id === 'importable')).toBe(true);

    // Capability is invocable immediately
    const inv = await host.invoke('importable', 'test.cap', {}, { kind: 'operator' });
    expect(inv).toEqual({ ok: true, data: { hello: 'world' } });
  });

  it('POST /plugins accepts plugin files inside one top-level directory', async () => {
    isAuthed = true;
    const archive = createArchive({ id: 'nested', inSubdir: true });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'nested.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as PluginsResponse;
    expect(body.plugins.some((p) => p.id === 'nested')).toBe(true);
  });

  it('POST /plugins rejects a Bearer caller with 403', async () => {
    const tok = issueSpawnToken('conv-b', 'sess-b', 'spawn');
    const archive = createArchive({ id: 'bearer-test' });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'bearer.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
      body: fd,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'operator only' });
  });

  it('POST /plugins with TIERWYN_PLUGINS=off answers 409', async () => {
    isAuthed = true;
    process.env.TIERWYN_PLUGINS = 'off';
    const archive = createArchive({ id: 'off-test' });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'off.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'plugin loading is disabled (TIERWYN_PLUGINS=off)' });
  });

  it('POST /plugins without a file answers 400', async () => {
    isAuthed = true;
    const fd = new FormData();
    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'archive (tar.gz) is required' });
  });

  it('POST /plugins rejects a non-gzip upload with 400', async () => {
    isAuthed = true;
    const archive = createArchive({ id: 'bad-gzip', invalidGzip: true });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'bad.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/not a valid tar\.gz archive/);
  });

  it('POST /plugins rejects an archive containing a symlink', async () => {
    isAuthed = true;
    const archive = createArchive({
      id: 'symlink-test',
      symlink: { target: '/etc/passwd', link: 'evil-link' },
    });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'symlink.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/regular files and directories/);
  });

  it('POST /plugins rejects an archive with a .. member', async () => {
    isAuthed = true;
    const archive = createDotDotArchive();
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'dotdot.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/unsafe path in archive/);
  });

  it('POST /plugins rejects an oversized archive with 413', async () => {
    isAuthed = true;
    // 10 MiB + 1 KiB
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024);
    const fd = new FormData();
    fd.append('archive', new Blob([oversized], { type: 'application/gzip' }), 'huge.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'archive too large (max 10 MiB)' });
  });

  it('POST /plugins with invalid manifest answers 400 and leaves no files', async () => {
    isAuthed = true;
    const archive = createArchive({
      id: 'bad-manifest',
      manifest: { id: 'BAD_ID_INVALID' },
    });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'badman.tar.gz');

    const res = await fetch(`${base}/plugins`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/invalid manifest/);

    // Leaves no files in plugins dir
    const files = readdirSync(pluginsTestDir);
    expect(files).toEqual([]);
  });

  it('POST /plugins with an existing id answers 409 and leaves the installed plugin untouched', async () => {
    isAuthed = true;
    // First import
    const archive1 = createArchive({ id: 'conflict-test', inSubdir: true });
    const fd1 = new FormData();
    fd1.append('archive', new Blob([archive1], { type: 'application/gzip' }), 'conflict.tar.gz');
    const res1 = await fetch(`${base}/plugins`, { method: 'POST', body: fd1 });
    expect(res1.status).toBe(200);

    // Second import with same id
    const archive2 = createArchive({ id: 'conflict-test', inSubdir: true });
    const fd2 = new FormData();
    fd2.append('archive', new Blob([archive2], { type: 'application/gzip' }), 'conflict.tar.gz');
    const res2 = await fetch(`${base}/plugins`, { method: 'POST', body: fd2 });
    expect(res2.status).toBe(409);
    expect(await res2.json()).toEqual({ error: 'plugin already installed', id: 'conflict-test' });

    // Still installed and callable
    expect(host.has('conflict-test')).toBe(true);
  });

  it('POST /plugins where activate throws answers 422, leaves no files, no host record, no stale scrub key', async () => {
    isAuthed = true;
    const archive = createArchive({
      id: 'crashing-plugin',
      manifest: {
        id: 'crashing-plugin',
        name: 'Crash',
        version: '1.0.0',
        apiVersion: 1,
        capabilities: [{ name: 'boom', summary: 'boom', agentCallable: true }],
        credentials: [{ key: 'CRASHING_PLUGIN_SECRET' }],
      },
      indexJs: 'export default { activate() { throw new Error("activate explosion"); } };\n',
    });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'crash.tar.gz');

    const res = await fetch(`${base}/plugins`, { method: 'POST', body: fd });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; id: string };
    expect(body.error).toContain('activate explosion');
    expect(body.id).toBe('crashing-plugin');

    // Leaves no files, no host record
    expect(host.has('crashing-plugin')).toBe(false);
    expect(existsSync(join(pluginsTestDir, 'crashing-plugin'))).toBe(false);
    expect(host.operatorRoutes().some((r) => r.pluginId === 'crashing-plugin')).toBe(false);
    // Scrub key rolled back
    const env = buildChildEnv({ CRASHING_PLUGIN_SECRET: 'test' });
    expect(env.CRASHING_PLUGIN_SECRET).toBe('test');
  });

  it('POST /plugins adds the new credential key to the child-env scrub set', async () => {
    isAuthed = true;
    process.env.NEW_PLUGIN_KEY = 'secret-env-val';
    const archive = createArchive({
      id: 'scrub-test',
      manifest: {
        id: 'scrub-test',
        name: 'Scrub Test',
        version: '1.0.0',
        apiVersion: 1,
        capabilities: [{ name: 'ping', summary: 'p', agentCallable: true }],
        credentials: [{ key: 'NEW_PLUGIN_KEY' }],
      },
    });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'scrub.tar.gz');

    const res = await fetch(`${base}/plugins`, { method: 'POST', body: fd });
    expect(res.status).toBe(200);

    const childEnv = buildChildEnv();
    expect(childEnv.NEW_PLUGIN_KEY).toBeUndefined();
    delete process.env.NEW_PLUGIN_KEY;
  });

  it('DELETE /plugins/:id unloads, removes files and purges vault, invocations, plugin:<id> and the disabled entry', async () => {
    isAuthed = true;
    // Import first
    const archive = createArchive({ id: 'to-delete', inSubdir: true });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'del.tar.gz');
    await fetch(`${base}/plugins`, { method: 'POST', body: fd });

    // Seed state: vault secret, invocation, settings plugin:to-delete
    vaultSet(db, 'to-delete', 'SOME_KEY', 'some-vault-secret');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('plugin:to-delete', JSON.stringify({ custom: 123 }));
    await host.invoke('to-delete', 'test.cap', {}, { kind: 'operator' });

    expect(vaultGet(db, 'to-delete', 'SOME_KEY')).toBeDefined();
    expect(listInvocations(db, 'to-delete')).toHaveLength(1);
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('plugin:to-delete')).toBeDefined();

    const delRes = await fetch(`${base}/plugins/to-delete`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    // Unloaded
    expect(host.has('to-delete')).toBe(false);
    // Files removed
    expect(existsSync(join(pluginsTestDir, 'to-delete'))).toBe(false);
    // State purged
    expect(vaultGet(db, 'to-delete', 'SOME_KEY')).toBeUndefined();
    expect(listInvocations(db, 'to-delete')).toEqual([]);
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('plugin:to-delete')).toBeUndefined();
    expect(getPluginState(db).disabled).not.toContain('to-delete');
  });

  it('DELETE /plugins/:id on a disabled plugin succeeds', async () => {
    isAuthed = true;
    const archive = createArchive({ id: 'disabled-del', inSubdir: true });
    const fd = new FormData();
    fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'dis.tar.gz');
    await fetch(`${base}/plugins`, { method: 'POST', body: fd });

    // Disable it
    await fetch(`${base}/plugins/disabled-del`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    const delRes = await fetch(`${base}/plugins/disabled-del`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(host.has('disabled-del')).toBe(false);
  });

  it('DELETE /plugins/:id rejects a Bearer caller with 403', async () => {
    const tok = issueSpawnToken('conv-del', 'sess-del', 'spawn');
    const res = await fetch(`${base}/plugins/any-id`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'operator only' });
  });

  it('DELETE /plugins/:id unknown id answers 404', async () => {
    isAuthed = true;
    const res = await fetch(`${base}/plugins/nonexistent`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown plugin' });
  });

  it('DELETE /plugins/:id on a symlinked plugin dir removes only the link', async () => {
    isAuthed = true;
    // Create an outside directory
    const outsideDir = mkdtempSync(join(process.cwd(), '.outside-target-'));
    try {
      const symlinkPath = join(pluginsTestDir, 'symlinked-plugin');
      symlinkSync(outsideDir, symlinkPath);

      // Register in host
      const m = plugin({ id: 'symlinked-plugin' });
      host.addManifest(m, { enabled: true, dir: symlinkPath });

      // Run DELETE logic directly or via fetch
      const res = await fetch(`${base}/plugins/symlinked-plugin`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      // Link removed
      expect(existsSync(symlinkPath)).toBe(false);
      // Outside directory still exists!
      expect(existsSync(outsideDir)).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('DELETE /plugins/:id refuses a record dir outside the plugins root with 400 and keeps it loaded', async () => {
    isAuthed = true;
    const rogueDir = mkdtempSync(join(tmpdir(), 'rogue-'));
    try {
      const m = plugin({ id: 'rogue-plugin' });
      host.addManifest(m, { enabled: true, dir: rogueDir });

      const res = await fetch(`${base}/plugins/rogue-plugin`, { method: 'DELETE' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'plugin directory is outside the plugins root' });
      // Keeps it loaded
      expect(host.has('rogue-plugin')).toBe(true);
      expect(existsSync(rogueDir)).toBe(true);
    } finally {
      rmSync(rogueDir, { recursive: true, force: true });
    }
  });

  it('DELETE /plugins/:id/credentials/:key still works', async () => {
    isAuthed = true;
    const m = plugin({
      id: 'cred-del-test',
      credentials: [{ key: 'TEST_KEY' }],
    });
    host.addManifest(m, { enabled: true });
    vaultSet(db, 'cred-del-test', 'TEST_KEY', 'secret-val-here');

    const res = await fetch(`${base}/plugins/cred-del-test/credentials/TEST_KEY`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(vaultGet(db, 'cred-del-test', 'TEST_KEY')).toBeUndefined();
  });

  it('POST /plugins where activate hangs times out, rolls back files/host and answers 422', async () => {
    // Re-register operator routes with short activateTimeoutMs for this test
    const customApp = express();
    customApp.use(express.json());
    registerPluginOperatorRoutes(customApp, {
      host,
      getDb: () => db,
      activateTimeoutMs: 50,
    });
    let customServer: Server;
    await new Promise<void>((r) => { customServer = customApp.listen(0, '127.0.0.1', () => r()); });
    const customBase = `http://127.0.0.1:${(customServer.address() as { port: number }).port}`;

    try {
      isAuthed = true;
      const archive = createArchive({
        id: 'hanging-plugin',
        manifest: {
          id: 'hanging-plugin',
          name: 'Hanging',
          version: '1.0.0',
          apiVersion: 1,
          capabilities: [{ name: 'slow', summary: 'slow', agentCallable: true }],
        },
        indexJs: 'export default { activate() { return new Promise(() => {}); } };\n',
      });
      const fd = new FormData();
      fd.append('archive', new Blob([archive], { type: 'application/gzip' }), 'hanging.tar.gz');

      const res = await fetch(`${customBase}/plugins`, { method: 'POST', body: fd });
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; id: string };
      expect(body.error).toMatch(/activate timed out/);
      expect(body.id).toBe('hanging-plugin');

      expect(host.has('hanging-plugin')).toBe(false);
      expect(existsSync(join(pluginsTestDir, 'hanging-plugin'))).toBe(false);
    } finally {
      await new Promise<void>((r) => customServer.close(() => r()));
    }
  });

  it('concurrent import/delete mutations receive 409 busy response', async () => {
    // We can simulate an in-flight mutation by creating a hanging import
    const customApp = express();
    customApp.use(express.json());
    registerPluginOperatorRoutes(customApp, {
      host,
      getDb: () => db,
      activateTimeoutMs: 300,
    });
    let customServer: Server;
    await new Promise<void>((r) => { customServer = customApp.listen(0, '127.0.0.1', () => r()); });
    const customBase = `http://127.0.0.1:${(customServer.address() as { port: number }).port}`;

    try {
      isAuthed = true;
      const archive1 = createArchive({
        id: 'busy-1',
        indexJs: 'export default { activate() { return new Promise((r) => setTimeout(r, 150)); } };\n',
      });
      const fd1 = new FormData();
      fd1.append('archive', new Blob([archive1], { type: 'application/gzip' }), 'b1.tar.gz');

      // Start mutation 1
      const p1 = fetch(`${customBase}/plugins`, { method: 'POST', body: fd1 });

      // Immediate concurrent mutation 2
      const fd2 = new FormData();
      const archive2 = createArchive({ id: 'busy-2' });
      fd2.append('archive', new Blob([archive2], { type: 'application/gzip' }), 'b2.tar.gz');
      // Give tiny tick for multer/staging to acquire lock
      await new Promise((r) => setTimeout(r, 10));
      const res2 = await fetch(`${customBase}/plugins`, { method: 'POST', body: fd2 });

      expect(res2.status).toBe(409);
      expect(await res2.json()).toEqual({ error: 'another plugin import or delete is in progress' });

      await p1;
    } finally {
      await new Promise<void>((r) => customServer.close(() => r()));
    }
  });
});
