import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { PluginHost } from './host.js';
import { initVaultKey, vaultSet, vaultClear, vaultAvailable } from './vault.js';
import type { PluginManifest, PluginCaller } from '@tierwyn/shared';

const VAULT_SECRET = 'abcdefghijklmnopqrstuvwxyz012345';

const agent: PluginCaller = { kind: 'agent', conversationId: 'conv-a', sessionId: 'sess-a' };
const operator: PluginCaller = { kind: 'operator' };

function manifest(over: Partial<PluginManifest> & { id: string }): PluginManifest {
  return {
    name: over.id,
    version: '1.0.0',
    apiVersion: 1,
    capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true }],
    ...over,
  };
}

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d, migrations);
  return d;
}

describe('PluginHost.invoke', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects agentCallable:false at the host for agents, allows operator', async () => {
    const host = new PluginHost({ getDb: () => db() });
    const m = manifest({
      id: 'secret',
      capabilities: [{ name: 'op.only', summary: 'no', agentCallable: false }],
    });
    const ctx = host.addManifest(m, { enabled: true });
    ctx.capability('op.only', async () => ({ ok: 1 }));
    host.markActivated('secret');

    const asAgent = await host.invoke('secret', 'op.only', {}, agent);
    expect(asAgent.ok).toBe(false);
    if (!asAgent.ok) expect(asAgent.code).toBe('not_agent_callable');

    const asOp = await host.invoke('secret', 'op.only', {}, operator);
    expect(asOp).toEqual({ ok: true, data: { ok: 1 } });
  });

  it('allowlist: https://api.z.ai.evil.com rejected; cross-origin redirect rejected; same-origin ok', async () => {
    const host = new PluginHost({ getDb: () => db() });
    const m = manifest({
      id: 'zai-usage',
      permissions: ['outbound:https://api.z.ai'],
    });
    const ctx = host.addManifest(m, { enabled: true });
    ctx.capability('echo', async (_input, _caller) => {
      // called per test below
      return null;
    });

    await expect(ctx.http.fetch('https://api.z.ai.evil.com/x')).rejects.toThrow(/origin not allowed/);

    vi.stubGlobal('fetch', vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href === 'https://api.z.ai/start') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.example/steal' },
        });
      }
      if (href === 'https://api.z.ai/same') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://api.z.ai/ok' },
        });
      }
      if (href === 'https://api.z.ai/ok') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('nope', { status: 404 });
    }));

    await expect(ctx.http.fetch('https://api.z.ai/start')).rejects.toThrow(/redirect origin not allowed/);
    const ok = await ctx.http.fetch('https://api.z.ai/same');
    expect(ok.ok).toBe(true);
    expect(await ok.json()).toEqual({ ok: true });
  });

  // A3: absent capability timeoutMs ⇒ host default (timeoutMs: 30 here).
  it('timeout ⇒ envelope timeout and the audit line is still written', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new PluginHost({ getDb: () => db(), timeoutMs: 30 });
    const ctx = host.addManifest(manifest({ id: 'slow' }), { enabled: true });
    ctx.capability('echo', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { late: true };
    });
    host.markActivated('slow');

    const out = await host.invoke('slow', 'echo', {}, agent);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('timeout');
    expect(log.mock.calls.some((c) => String(c[0]).includes('[plugins]') && String(c[0]).includes('timeout'))).toBe(true);
  });

  it('capability timeoutMs is honoured over a shorter host default', async () => {
    const host = new PluginHost({ getDb: () => db(), timeoutMs: 30 });
    const ctx = host.addManifest(manifest({
      id: 'slow-ok',
      capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true, timeoutMs: 300 }],
    }), { enabled: true });
    ctx.capability('echo', async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { late: true };
    });
    host.markActivated('slow-ok');

    const out = await host.invoke('slow-ok', 'echo', {}, agent);
    expect(out).toEqual({ ok: true, data: { late: true } });
  });

  it('capability timeoutMs still enforces when shorter than the host default', async () => {
    const host = new PluginHost({ getDb: () => db(), timeoutMs: 1000 });
    const ctx = host.addManifest(manifest({
      id: 'slow-cut',
      capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true, timeoutMs: 30 }],
    }), { enabled: true });
    ctx.capability('echo', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { late: true };
    });
    host.markActivated('slow-cut');

    const out = await host.invoke('slow-cut', 'echo', {}, agent);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('timeout');
  });

  it('rate limit: per-caller, global per-plugin, global outbound ⇒ 429 + retryAfter', async () => {
    const host = new PluginHost({ getDb: () => db() });
    const ctx = host.addManifest(manifest({
      id: 'rl',
      capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true, rateLimitPerMin: 2 }],
    }), { enabled: true });
    ctx.capability('echo', async () => ({ n: 1 }));
    host.markActivated('rl');

    expect((await host.invoke('rl', 'echo', {}, agent)).ok).toBe(true);
    expect((await host.invoke('rl', 'echo', {}, agent)).ok).toBe(true);
    const limited = await host.invoke('rl', 'echo', {}, agent);
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.code).toBe('rate_limited');
      expect(limited.retryAfter).toBeGreaterThan(0);
    }

    const host2 = new PluginHost({ getDb: () => db() });
    const ctx2 = host2.addManifest(manifest({
      id: 'glob',
      capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true, rateLimitPerMin: 200 }],
    }), { enabled: true });
    ctx2.capability('echo', async () => 1);
    host2.markActivated('glob');
    let last: Awaited<ReturnType<typeof host2.invoke>> | undefined;
    for (let i = 0; i < 121; i++) {
      last = await host2.invoke('glob', 'echo', {}, { kind: 'agent', conversationId: `c-${i}` });
    }
    expect(last?.ok).toBe(false);
    if (last && !last.ok) {
      expect(last.code).toBe('rate_limited');
      expect(last.retryAfter).toBeGreaterThan(0);
    }

    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const host3 = new PluginHost({ getDb: () => db() });
    const ctx3 = host3.addManifest(manifest({
      id: 'out',
      permissions: ['outbound:https://api.z.ai'],
    }), { enabled: true });
    let outboundErr: unknown;
    for (let i = 0; i < 61; i++) {
      try {
        await ctx3.http.fetch('https://api.z.ai/x');
      } catch (e) {
        outboundErr = e;
      }
    }
    expect(outboundErr).toMatchObject({ code: 'rate_limited' });
    expect((outboundErr as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  });

  it('redaction over result and error; secrets <8 chars skipped', async () => {
    const host = new PluginHost({ getDb: () => db() });
    const prevLong = process.env.LONG_SECRET;
    const prevShort = process.env.SHORT_X;
    process.env.LONG_SECRET = 'abcdefghij';
    process.env.SHORT_X = 'abcd';
    host.captureCredentials(['LONG_SECRET', 'SHORT_X']);
    if (prevLong === undefined) delete process.env.LONG_SECRET; else process.env.LONG_SECRET = prevLong;
    if (prevShort === undefined) delete process.env.SHORT_X; else process.env.SHORT_X = prevShort;
    const ctx = host.addManifest(manifest({
      id: 'red',
      credentials: [{ key: 'LONG_SECRET' }, { key: 'SHORT_X' }],
    }), { enabled: true });
    ctx.capability('echo', async (input) => {
      const mode = (input as { mode?: string }).mode;
      if (mode === 'throw') throw new Error(`leaked abcdefghij and abcd`);
      return { token: 'abcdefghij', also: 'abcd' };
    });
    host.markActivated('red');

    const result = await host.invoke('red', 'echo', { mode: 'ok' }, agent);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ token: '[REDACTED]', also: 'abcd' });
    }
    const thrown = await host.invoke('red', 'echo', { mode: 'throw' }, agent);
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) {
      expect(thrown.error).toContain('[REDACTED]');
      expect(thrown.error).not.toContain('abcdefghij');
      expect(thrown.error).toContain('abcd');
    }
  });
});

describe('PluginHost.listUsageProviders', () => {
  it('lists active plugins with usageProvider and reports configured from captured keys', () => {
    const prev = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = 'test-zai-key-value';
    const host = new PluginHost({ getDb: () => db() });
    host.captureCredentials(['ZAI_API_KEY']);
    const ctx = host.addManifest(manifest({
      id: 'zai-usage',
      capabilities: [{
        name: 'usage.get',
        summary: 'quota',
        agentCallable: true,
        usageProvider: { label: 'Z.AI' },
      }],
      credentials: [{ key: 'ZAI_API_KEY', required: true }],
    }), { enabled: true });
    ctx.capability('usage.get', async () => ({}));
    host.markActivated('zai-usage');

    expect(host.listUsageProviders()).toEqual([{
      id: 'zai-usage',
      kind: 'provider',
      label: 'Z.AI',
      source: 'plugin',
      configured: true,
      capability: 'usage.get',
      section: 'providers',
    }]);
    if (prev === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = prev;
  });

  it('omits disabled / not-activated plugins and reports configured:false without values', () => {
    const host = new PluginHost({ getDb: () => db() });
    host.addManifest(manifest({
      id: 'off',
      capabilities: [{
        name: 'usage.get',
        summary: 'quota',
        agentCallable: true,
        usageProvider: { label: 'Off' },
      }],
      credentials: [{ key: 'OFF_KEY', required: true }],
    }), { enabled: false });

    const failed = host.addManifest(manifest({
      id: 'failed',
      capabilities: [{
        name: 'usage.get',
        summary: 'quota',
        agentCallable: true,
        usageProvider: { label: 'Failed' },
      }],
      credentials: [{ key: 'FAIL_KEY', required: true }],
    }), { enabled: true });
    failed.capability('usage.get', async () => ({}));
    // never markActivated — simulates activate() throw

    const live = host.addManifest(manifest({
      id: 'live',
      capabilities: [{
        name: 'usage.get',
        summary: 'quota',
        agentCallable: true,
        usageProvider: { label: 'Live' },
      }],
      credentials: [{ key: 'LIVE_KEY', required: true }],
    }), { enabled: true });
    live.capability('usage.get', async () => ({}));
    host.markActivated('live');

    expect(host.listUsageProviders()).toEqual([{
      id: 'live',
      kind: 'provider',
      label: 'Live',
      source: 'plugin',
      configured: false,
      capability: 'usage.get',
      section: 'providers',
    }]);
  });

  it('configured is true when the required key is in the vault (no env)', () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const d = db();
    const host = new PluginHost({ getDb: () => d });
    vaultSet(d, 'zai-usage', 'ZAI_API_KEY', 'vault-only-configured-key');
    const ctx = host.addManifest(manifest({
      id: 'zai-usage',
      capabilities: [{
        name: 'usage.get',
        summary: 'quota',
        agentCallable: true,
        usageProvider: { label: 'Z.AI' },
      }],
      credentials: [{ key: 'ZAI_API_KEY', required: true }],
    }), { enabled: true });
    ctx.capability('usage.get', async () => ({}));
    host.markActivated('zai-usage');
    expect(host.listUsageProviders()[0]?.configured).toBe(true);
  });
});

describe('PluginHost credentials vault-first', () => {
  afterEach(() => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
  });

  it('credentials.get()/source() prefer vault over env; GET-shape shows vault + updatedAt', () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const d = db();
    const host = new PluginHost({ getDb: () => d });
    const prev = process.env.DEMO_KEY;
    process.env.DEMO_KEY = 'env-fallback-value-xx';
    host.captureCredentials(['DEMO_KEY']);
    if (prev === undefined) delete process.env.DEMO_KEY; else process.env.DEMO_KEY = prev;

    const ctx = host.addManifest(manifest({
      id: 'demo',
      credentials: [{ key: 'DEMO_KEY' }],
    }), { enabled: true });
    ctx.capability('echo', async () => ctx.credentials.get('DEMO_KEY'));
    host.markActivated('demo');

    expect(ctx.credentials.source('DEMO_KEY')).toBe('env');
    expect(ctx.credentials.get('DEMO_KEY')).toBe('env-fallback-value-xx');

    const before = Date.now();
    vaultSet(d, 'demo', 'DEMO_KEY', 'vault-wins-over-env-yy');
    expect(ctx.credentials.source('DEMO_KEY')).toBe('vault');
    expect(ctx.credentials.get('DEMO_KEY')).toBe('vault-wins-over-env-yy');

    const listed = host.listForOperator();
    const cred = listed[0]!.credentials[0]!;
    expect(cred).toMatchObject({ key: 'DEMO_KEY', configured: true, source: 'vault' });
    expect(cred.updatedAt).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(listed)).not.toContain('vault-wins-over-env-yy');
    expect(JSON.stringify(listed)).not.toContain('env-fallback-value-xx');
  });

  it('redaction covers a vault-set value in result, error, and the audit line', async () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const d = db();
    const host = new PluginHost({ getDb: () => d });
    vaultSet(d, 'red', 'VAULT_KEY', 'vaultsecretvalue99');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = host.addManifest(manifest({
      id: 'red',
      credentials: [{ key: 'VAULT_KEY' }],
    }), { enabled: true });
    ctx.capability('echo', async (input) => {
      const mode = (input as { mode?: string }).mode;
      if (mode === 'throw') throw new Error('leaked vaultsecretvalue99');
      return { token: 'vaultsecretvalue99' };
    });
    host.markActivated('red');

    const result = await host.invoke('red', 'echo', { mode: 'ok' }, agent);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ token: '[REDACTED]' });

    const thrown = await host.invoke('red', 'echo', { mode: 'throw' }, agent);
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) {
      expect(thrown.error).toContain('[REDACTED]');
      expect(thrown.error).not.toContain('vaultsecretvalue99');
    }
    const audit = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(audit).toContain('[plugins]');
    expect(audit).not.toContain('vaultsecretvalue99');
    expect(audit).toContain('[REDACTED]');
    log.mockRestore();
  });

  it('vault unavailable ⇒ falls back to env; vault.available is a host-external flag', () => {
    initVaultKey({ sessionSecret: '' });
    expect(vaultAvailable()).toBe(false);
    const d = db();
    const host = new PluginHost({ getDb: () => d });
    const prev = process.env.DEMO_KEY;
    process.env.DEMO_KEY = 'env-when-vault-down-zz';
    host.captureCredentials(['DEMO_KEY']);
    if (prev === undefined) delete process.env.DEMO_KEY; else process.env.DEMO_KEY = prev;
    const ctx = host.addManifest(manifest({
      id: 'demo',
      credentials: [{ key: 'DEMO_KEY' }],
    }), { enabled: true });
    expect(ctx.credentials.get('DEMO_KEY')).toBe('env-when-vault-down-zz');
    expect(ctx.credentials.source('DEMO_KEY')).toBe('env');
    const listed = host.listForOperator();
    expect(listed[0]!.credentials[0]).toMatchObject({
      key: 'DEMO_KEY', configured: true, source: 'env', updatedAt: null,
    });
  });

  it('undecryptable vault row reports needsReentry, not a healthy vault status', () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const d = db();
    const host = new PluginHost({ getDb: () => d });
    const ctx = host.addManifest(manifest({
      id: 'demo',
      credentials: [{ key: 'DEMO_KEY', required: true }],
      capabilities: [{
        name: 'usage.get',
        summary: 'quota',
        agentCallable: true,
        usageProvider: { label: 'Demo' },
      }],
    }), { enabled: true });
    ctx.capability('usage.get', async () => ({}));
    host.markActivated('demo');
    vaultSet(d, 'demo', 'DEMO_KEY', 'vault-wins-over-env-yy');
    initVaultKey({ envKey: 'env-vault-key-value-32bytes-min!!', sessionSecret: VAULT_SECRET });

    expect(ctx.credentials.get('DEMO_KEY')).toBeUndefined();
    expect(ctx.credentials.source('DEMO_KEY')).toBeUndefined();
    const cred = host.listForOperator()[0]!.credentials[0]!;
    expect(cred).toMatchObject({
      key: 'DEMO_KEY',
      configured: false,
      source: 'vault',
      needsReentry: true,
    });
    expect(cred.updatedAt).toBeTypeOf('number');
    expect(JSON.stringify(host.listForOperator())).not.toContain('vault-wins-over-env-yy');
    expect(host.listUsageProviders()[0]?.configured).toBe(false);
  });

  it('getCredential is (pluginId, key)-scoped — no cross-plugin vault bleed', () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const d = db();
    const host = new PluginHost({ getDb: () => d });
    host.addManifest(manifest({
      id: 'alpha',
      credentials: [{ key: 'SHARED_KEY' }],
    }), { enabled: true });
    host.addManifest(manifest({
      id: 'beta',
      credentials: [{ key: 'SHARED_KEY' }],
    }), { enabled: true });
    vaultSet(d, 'alpha', 'SHARED_KEY', 'alpha-only-secret-value');
    expect(host.getCredential('SHARED_KEY', 'alpha')).toBe('alpha-only-secret-value');
    expect(host.getCredential('SHARED_KEY', 'beta')).toBeUndefined();
    expect(host.getCredential('SHARED_KEY', 'zai-usage')).toBeUndefined();
  });

  it('redactSecrets picks up vault values written after the first redact', () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const d = db();
    const host = new PluginHost({ getDb: () => d });
    vaultSet(d, 'tierwyn:agents', 'env.codex.OPENAI_API_KEY', 'first-secret-aaaa');
    expect(host.redactSecrets('x first-secret-aaaa')).toBe('x [REDACTED]');
    vaultSet(d, 'tierwyn:agents', 'env.codex.OPENAI_API_KEY', 'second-secret-bbbb');
    expect(host.redactSecrets('x second-secret-bbbb')).toBe('x [REDACTED]');
    expect(host.redactSecrets('x first-secret-aaaa')).toBe('x first-secret-aaaa');
    vaultClear(d, 'tierwyn:agents', 'env.codex.OPENAI_API_KEY');
    expect(host.redactSecrets('x second-secret-bbbb')).toBe('x second-secret-bbbb');
  });

  it('findUsageProviderForAgent matches agent and model regex patterns', () => {    const d = db();
    const host = new PluginHost({ getDb: () => d });
    host.addManifest(manifest({
      id: 'cursor-usage',
      capabilities: [{
        name: 'usage.get',
        summary: 'cursor',
        agentCallable: true,
        usageProvider: {
          label: 'Cursor',
          matchAgent: '^cursor$',
          matchModel: '.*',
        },
      }],
    }), { enabled: true });
    host.addManifest(manifest({
      id: 'zai-usage',
      capabilities: [{
        name: 'usage.get',
        summary: 'zai',
        agentCallable: true,
        usageProvider: {
          label: 'Z.AI',
          matchAgent: '^(hermes|deepseek|pi)$',
          matchModel: '.*glm.*',
        },
      }],
    }), { enabled: true });
    host.markActivated('cursor-usage');
    host.markActivated('zai-usage');

    // Cursor matches agent 'cursor' with any model
    expect(host.findUsageProviderForAgent('cursor', 'claude-opus-5-medium')).toEqual({
      pluginId: 'cursor-usage',
      capability: 'usage.get',
      label: 'Cursor',
    });

    // Z.ai matches 'hermes', 'deepseek', or 'pi' with glm models
    expect(host.findUsageProviderForAgent('hermes', 'zai:glm-5.3')).toEqual({
      pluginId: 'zai-usage',
      capability: 'usage.get',
      label: 'Z.AI',
    });
    expect(host.findUsageProviderForAgent('deepseek', 'z.ai/GLM-5.3')).toEqual({
      pluginId: 'zai-usage',
      capability: 'usage.get',
      label: 'Z.AI',
    });
    expect(host.findUsageProviderForAgent('pi', 'zai/glm-5.2')).toEqual({
      pluginId: 'zai-usage',
      capability: 'usage.get',
      label: 'Z.AI',
    });

    // Unmatched agent or non-glm model returns undefined
    expect(host.findUsageProviderForAgent('claude-code', 'claude-opus-5')).toBeUndefined();
    expect(host.findUsageProviderForAgent('deepseek', 'deepseek-official/deepseek-chat')).toBeUndefined();
    expect(host.findUsageProviderForAgent('pi', 'anthropic/claude-opus-5')).toBeUndefined();
  });
});

describe('PluginHost.helpFor / listForAgent help', () => {
  it('returns help text and the listing carries the help path', () => {
    const host = new PluginHost({ getDb: () => db() });
    host.addManifest(manifest({ id: 'helped' }), { enabled: true, help: '# helped\n' });
    expect(host.helpFor('helped')).toEqual({ kind: 'ok', text: '# helped\n' });
    expect(host.listForAgent()[0]).toMatchObject({
      id: 'helped',
      help: '/agent/plugins/helped/help',
    });
  });

  it('no help ⇒ {kind:"none"} and no help key in the listing', () => {
    const host = new PluginHost({ getDb: () => db() });
    host.addManifest(manifest({ id: 'bare' }), { enabled: true });
    expect(host.helpFor('bare')).toEqual({ kind: 'none' });
    expect(host.listForAgent()[0]).not.toHaveProperty('help');
  });

  it('disabled plugin ⇒ {kind:"unknown"}', () => {
    const host = new PluginHost({ getDb: () => db() });
    host.addManifest(manifest({ id: 'offed' }), { enabled: false, help: '# off' });
    expect(host.helpFor('offed')).toEqual({ kind: 'unknown' });
  });

  it('operator-only capabilities ⇒ {kind:"unknown"}', () => {
    const host = new PluginHost({ getDb: () => db() });
    host.addManifest(manifest({
      id: 'opsonly',
      capabilities: [{ name: 'op.only', summary: 'no', agentCallable: false }],
    }), { enabled: true, help: '# ops only' });
    expect(host.helpFor('opsonly')).toEqual({ kind: 'unknown' });
  });

  it('unknown id ⇒ {kind:"unknown"}', () => {
    const host = new PluginHost({ getDb: () => db() });
    expect(host.helpFor('nope')).toEqual({ kind: 'unknown' });
  });
});

describe('PluginHost.pluginSetHash', () => {
  it('changes on enable/disable, capability add/remove, and summary reword', () => {
    const host = new PluginHost({ getDb: () => db() });
    const empty = host.pluginSetHash();

    host.addManifest(manifest({ id: 'a', capabilities: [{ name: 'cap', summary: 'v1', agentCallable: true }] }), { enabled: true });
    const withA = host.pluginSetHash();
    expect(withA).not.toBe(empty);

    // Operator-only capabilities don't affect the agent-facing hash.
    host.addManifest(manifest({ id: 'ops', capabilities: [{ name: 'op.only', summary: 'no', agentCallable: false }] }), { enabled: true });
    expect(host.pluginSetHash()).toBe(withA);

    // Disabling removes it from the hash.
    host.setEnabled('a', false);
    expect(host.pluginSetHash()).toBe(empty);
    host.setEnabled('a', true);

    // A reworded summary changes the hash (the roster prints the summary verbatim).
    host.addManifest(manifest({ id: 'a', capabilities: [{ name: 'cap', summary: 'v2 reworded', agentCallable: true }] }), { enabled: true });
    expect(host.pluginSetHash()).not.toBe(withA);
  });
});

describe('PluginHost.removePlugin', () => {
  it('removePlugin runs deactivate fns and drops the record', () => {
    const host = new PluginHost({ getDb: () => db() });
    let deactivated = false;
    const ctx = host.addManifest(manifest({ id: 'deact' }), { enabled: true, dir: '/tmp/deact' });
    ctx.onDeactivate(() => { deactivated = true; });
    expect(host.has('deact')).toBe(true);
    expect(host.dirOf('deact')).toBe('/tmp/deact');

    const res = host.removePlugin('deact');
    expect(res).toBe(true);
    expect(deactivated).toBe(true);
    expect(host.has('deact')).toBe(false);
    expect(host.dirOf('deact')).toBeUndefined();
  });

  it('removePlugin filters only that plugin\'s operator routes', () => {
    const host = new PluginHost({ getDb: () => db() });
    const ctxA = host.addManifest(manifest({ id: 'a' }), { enabled: true });
    ctxA.operatorRoute('get', '/ping', () => {});
    const ctxB = host.addManifest(manifest({ id: 'b' }), { enabled: true });
    ctxB.operatorRoute('get', '/pong', () => {});
    ctxB.operatorRoute('post', '/submit', () => {});

    expect(host.operatorRoutes()).toHaveLength(3);
    host.removePlugin('a');
    const routes = host.operatorRoutes();
    expect(routes).toHaveLength(2);
    expect(routes.every((r) => r.pluginId === 'b')).toBe(true);
  });

  it('removePlugin clears that plugin\'s rate-limit buckets', async () => {
    const host = new PluginHost({ getDb: () => db() });
    const m = manifest({
      id: 'lim',
      capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true, rateLimitPerMin: 1 }],
    });
    const ctx1 = host.addManifest(m, { enabled: true });
    ctx1.capability('echo', async () => 'ok1');
    host.markActivated('lim');

    const first = await host.invoke('lim', 'echo', {}, agent);
    expect(first.ok).toBe(true);
    const second = await host.invoke('lim', 'echo', {}, agent);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('rate_limited');

    // Remove and re-add: buckets are cleared so invoke succeeds
    host.removePlugin('lim');
    const ctx2 = host.addManifest(m, { enabled: true });
    ctx2.capability('echo', async () => 'ok2');
    host.markActivated('lim');

    const third = await host.invoke('lim', 'echo', {}, agent);
    expect(third).toEqual({ ok: true, data: 'ok2' });
  });

  it('removePlugin changes pluginSetHash', () => {
    const host = new PluginHost({ getDb: () => db() });
    host.addManifest(manifest({ id: 'hashy', capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true }] }), { enabled: true });
    const before = host.pluginSetHash();
    host.removePlugin('hashy');
    const after = host.pluginSetHash();
    expect(after).not.toBe(before);
  });

  it('removePlugin returns false for an unknown id', () => {
    const host = new PluginHost({ getDb: () => db() });
    expect(host.removePlugin('nonexistent')).toBe(false);
  });

  it('invoke after removePlugin returns unknown_plugin', async () => {
    const host = new PluginHost({ getDb: () => db() });
    const ctx = host.addManifest(manifest({ id: 'ephemeral' }), { enabled: true });
    ctx.capability('echo', async () => 'pong');
    host.markActivated('ephemeral');

    const before = await host.invoke('ephemeral', 'echo', {}, agent);
    expect(before.ok).toBe(true);

    host.removePlugin('ephemeral');
    const after = await host.invoke('ephemeral', 'echo', {}, agent);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe('unknown_plugin');
  });
});
