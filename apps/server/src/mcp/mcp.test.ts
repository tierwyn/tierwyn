import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { McpPlacement, McpServerNormalised, McpTransport, ResolvedMcpServer, SpawnTemplate } from '@tierwyn/shared';
import { effectiveMcpPlacement, validateMcpServerInput } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { initVaultKey, vaultStatus } from '../plugins/vault.js';
import {
  MCP_VAULT_ID, deleteMcpServer, listMcpServers, mcpSecretStatus, readMcpSecret, setMcpSecret, toPublicDef, upsertMcpServer,
} from './registry.js';
import { resolveSessionMcp, recordAcpMcpCaps, _resetAcpMcpCaps } from './resolve.js';
import { toAcpMcpServers, toClaudeSdkMcp, toCodexArgs } from './inject.js';
import { captureMcpEnv, _resetCapturedMcpEnv } from './envFallback.js';
import { redactMcpSecrets, refreshMcpRedactSet, _setMcpRedactNeedles } from '../secrets/mcpRedact.js';
import { buildChildEnv } from '../childEnv.js';
import { appendEvent } from '../repositories/events.js';

const SECRET = 'tierwyn-probe-1234567890';

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d, migrations);
  return d;
}

function input(over: Partial<McpServerNormalised> & { id: string }): McpServerNormalised {
  const v = validateMcpServerInput({ transport: 'stdio', command: 'npx', args: ['-y', 'srv'], ...over });
  if (!v.ok) throw new Error(v.error);
  return v.value;
}

beforeEach(() => {
  initVaultKey({ sessionSecret: 'abcdefghijklmnopqrstuvwxyz012345' });
  _resetCapturedMcpEnv();
  _resetAcpMcpCaps();
  _setMcpRedactNeedles([]);
});
afterEach(() => { _resetCapturedMcpEnv(); _setMcpRedactNeedles([]); });

describe('validateMcpServerInput', () => {
  it('rejects bad ids, values on secret vars and incoherent transports', () => {
    expect(validateMcpServerInput({ id: 'Bad!', transport: 'stdio', command: 'x' }).ok).toBe(false);
    expect(validateMcpServerInput({ id: 'a', transport: 'stdio', command: 'x', env: [{ key: 'K', secret: true, value: 'v' }] }).ok).toBe(false);
    expect(validateMcpServerInput({ id: 'a', transport: 'http', command: 'x', url: 'http://h' }).ok).toBe(false);
    expect(validateMcpServerInput({ id: 'a', transport: 'sse' }).ok).toBe(false);
    expect(validateMcpServerInput({ id: 'a', transport: 'stdio', command: 'x', args: Array(33).fill('a') }).ok).toBe(false);
    expect(validateMcpServerInput({ id: 'a', transport: 'stdio', command: 'x', agentTypes: ['cursor'] }).ok).toBe(false);
    expect(validateMcpServerInput({ id: 'a', transport: 'stdio', command: 'x', env: [{ key: 'K', secret: true, envFallback: 'NOPE' }] }).ok).toBe(false);
    expect(validateMcpServerInput({ id: 'a', transport: 'http', url: 'https://h/mcp', headers: [{ key: 'Authorization', secret: true }] }).ok).toBe(true);
  });

  it('placement: omitted normalises to auto; unknown values fail', () => {
    expect(validateMcpServerInput({ id: 'a', transport: 'stdio', command: 'x' })).toMatchObject({ ok: true, value: { placement: 'auto' } });
    expect(validateMcpServerInput({ id: 'a', transport: 'stdio', command: 'x', placement: 'hub' })).toMatchObject({ ok: true, value: { placement: 'hub' } });
    expect(validateMcpServerInput({ id: 'a', transport: 'stdio', command: 'x', placement: 'cloud' }).ok).toBe(false);
  });
});

describe('registry', () => {
  it('CRUD + masking: public def never carries a secret value; delete clears vault rows', () => {
    const d = db();
    upsertMcpServer(d, input({ id: 'everything', env: [{ key: 'PROBE_SECRET', secret: true }, { key: 'MODE', secret: false, value: 'x' }] }));
    setMcpSecret(d, 'everything', 'env', 'PROBE_SECRET', SECRET);
    const pub = toPublicDef(d, listMcpServers(d)[0]);
    expect(JSON.stringify(pub)).not.toContain(SECRET);
    expect(pub.env).toEqual([
      { key: 'PROBE_SECRET', secret: true, configured: true, source: 'vault' },
      { key: 'MODE', secret: false, value: 'x' },
    ]);
    expect(deleteMcpServer(d, 'everything')).toBe(true);
    expect(vaultStatus(d, MCP_VAULT_ID, 'everything/env/PROBE_SECRET')).toBeUndefined();
    expect(listMcpServers(d)).toEqual([]);
  });

  it('upsert that drops a secret var clears its vault value; status vault/env/missing', () => {
    const d = db();
    upsertMcpServer(d, input({ id: 's', env: [{ key: 'A', secret: true }, { key: 'B', secret: true, envFallback: 'TIERWYN_MCP_B' }] }));
    setMcpSecret(d, 's', 'env', 'A', SECRET);
    const env = { TIERWYN_MCP_B: 'from-env-12345678', OTHER: '1' };
    captureMcpEnv(env);
    expect(env).toEqual({ OTHER: '1' });
    const row = listMcpServers(d)[0];
    expect(mcpSecretStatus(d, 's', 'env', row.env[0])).toBe('vault');
    expect(mcpSecretStatus(d, 's', 'env', row.env[1])).toBe('env');
    upsertMcpServer(d, input({ id: 's', env: [{ key: 'A', secret: false, value: 'plain' }] }));
    expect(vaultStatus(d, MCP_VAULT_ID, 's/env/A')).toBeUndefined();
  });

  it('env-fallback secret shorter than MIN_SECRET_LEN (8) fails closed as missing', () => {
    const d = db();
    upsertMcpServer(d, input({ id: 's', env: [{ key: 'B', secret: true, envFallback: 'TIERWYN_MCP_B' }] }));
    captureMcpEnv({ TIERWYN_MCP_B: 'short' }); // length 5 < 8
    const row = listMcpServers(d)[0];
    expect(mcpSecretStatus(d, 's', 'env', row.env[0])).toBeNull();
    expect(readMcpSecret(d, 's', 'env', row.env[0])).toBeUndefined();
    const pub = toPublicDef(d, row);
    expect(pub.env[0]).toMatchObject({ configured: false, source: null });
  });

  it('masks URL credentials in public def', () => {
    const d = db();
    const v = validateMcpServerInput({ id: 'web', transport: 'http', url: 'https://user:secret@host/mcp?token=xyz' });
    if (!v.ok) throw new Error(v.error);
    upsertMcpServer(d, v.value);
    const pub = toPublicDef(d, listMcpServers(d)[0]);
    expect(pub.url).toBe('https://user:••••@host/mcp?token=••••');
  });

  it('placement round-trips: default auto, explicit hub survives upsert + public def', () => {
    const d = db();
    upsertMcpServer(d, input({ id: 'auto-one' }));
    const v = validateMcpServerInput({ id: 'hub-one', transport: 'http', url: 'http://127.0.0.1:1/mcp', placement: 'hub' });
    if (!v.ok) throw new Error(v.error);
    upsertMcpServer(d, v.value);
    expect(listMcpServers(d).map((r) => [r.id, r.placement]))
      .toEqual([['auto-one', 'auto'], ['hub-one', 'hub']]);
    expect(toPublicDef(d, listMcpServers(d)[1]).placement).toBe('hub');
  });
});

describe('effectiveMcpPlacement', () => {
  const cases: Array<[McpTransport, string | undefined, McpPlacement, 'agent' | 'hub']> = [
    ['stdio', undefined, 'auto', 'agent'],
    ['http', 'http://127.0.0.1:5678', 'auto', 'hub'],
    ['http', 'http://localhost/x', 'auto', 'hub'],
    ['http', 'http://LOCALHOST/x', 'auto', 'hub'],
    ['http', 'http://[::1]:1/mcp', 'auto', 'hub'],
    ['http', 'http://10.1.2.3/mcp', 'auto', 'hub'],
    ['http', 'http://172.20.0.1/mcp', 'auto', 'hub'],
    ['http', 'http://172.32.0.1/mcp', 'auto', 'agent'],
    ['http', 'http://192.168.1.5/mcp', 'auto', 'hub'],
    ['http', 'http://nas.local/mcp', 'auto', 'hub'],
    ['https', 'https://mcp.example.com/mcp', 'auto', 'agent'],
    ['sse', 'http://127.0.0.1/sse', 'auto', 'hub'],
    // WHATWG rewrites the bracketed mapped form to `::ffff:7f00:1`; strip and re-test.
    ['http', 'http://[::ffff:127.0.0.1]/mcp', 'auto', 'hub'],
    ['http', 'http://localhost./mcp', 'auto', 'hub'],
    // Link-local / IMDS must NOT auto-place on the hub (LOW-1).
    ['http', 'http://169.254.169.254/mcp', 'auto', 'agent'],
    ['http', 'http://[fe80::1]/mcp', 'auto', 'agent'],
    ['http', 'http://[2001:db8::1]/mcp', 'auto', 'agent'],
    ['http', 'not a url', 'auto', 'agent'],
    ['http', 'http://127.0.0.1/mcp', 'agent', 'agent'],
    ['https', 'https://mcp.example.com/mcp', 'hub', 'hub'],
  ];
  it.each(cases)('%s %s (%s) -> %s', (transport, url, placement, want) => {
    expect(effectiveMcpPlacement({ transport, url, placement })).toBe(want);
  });
});

describe('resolveSessionMcp', () => {
  const tpl = (ids: string[]): SpawnTemplate => ({ name: 't', roles: [], mcpServers: ids });

  it('precedence: conversation > template > none; [] beats template; children ignore the template', () => {
    const d = db();
    upsertMcpServer(d, input({ id: 'a' }));
    upsertMcpServer(d, input({ id: 'b' }));
    const r = (conv: Parameters<typeof resolveSessionMcp>[0]['conv'], template?: SpawnTemplate) =>
      resolveSessionMcp({ db: d, conv, template, agentType: 'claude-code', delegating: false }).inject.map((s) => s.id);
    expect(r({ mcpServers: ['b'] }, tpl(['a']))).toEqual(['b']);
    expect(r({}, tpl(['a']))).toEqual(['a']);
    expect(r({ mcpServers: [] }, tpl(['a']))).toEqual([]);
    expect(r(undefined)).toEqual([]);
    expect(r({ parentConversationId: 'p' }, tpl(['a']))).toEqual([]);
  });

  it('every skip reason, in order', () => {
    const d = db();
    upsertMcpServer(d, input({ id: 'off', enabled: false }));
    upsertMcpServer(d, input({ id: 'only-codex', agentTypes: ['codex'], allowInDelegating: true }));
    upsertMcpServer(d, input({ id: 'plain' }));
    upsertMcpServer(d, input({ id: 'deleg', allowInDelegating: true }));
    upsertMcpServer(d, input({ id: 'sec', allowInDelegating: true, env: [{ key: 'K', secret: true }] }));
    const v = validateMcpServerInput({ id: 'web', transport: 'sse', url: 'https://h/sse', allowInDelegating: true });
    if (v.ok) upsertMcpServer(d, v.value);
    const conv = { mcpServers: ['ghost', 'off', 'only-codex', 'plain', 'web', 'sec', 'deleg'] };
    const codex = resolveSessionMcp({ db: d, conv, template: undefined, agentType: 'codex', delegating: true });
    expect(codex.skipped).toEqual([
      { id: 'ghost', reason: 'unknown' },
      { id: 'off', reason: 'disabled' },
      { id: 'plain', reason: 'delegating_blocked' },
      { id: 'web', reason: 'transport_unsupported' },
      { id: 'sec', reason: 'secret_missing' },
    ]);
    expect(codex.inject.map((s) => s.id)).toEqual(['only-codex', 'deleg']);
    const claude = resolveSessionMcp({ db: d, conv: { mcpServers: ['only-codex'] }, template: undefined, agentType: 'claude-code', delegating: false });
    expect(claude.skipped).toEqual([{ id: 'only-codex', reason: 'agent_filtered' }]);
    const cursor = resolveSessionMcp({ db: d, conv: { mcpServers: ['plain'] }, template: undefined, agentType: 'cursor', delegating: false });
    expect(cursor.skipped).toEqual([{ id: 'plain', reason: 'agent_not_injectable' }]);
  });

  it('ACP http/sse gated by cached caps; unknown caps are optimistic', () => {
    const d = db();
    const v = validateMcpServerInput({ id: 'web', transport: 'sse', url: 'https://h/sse' });
    if (v.ok) upsertMcpServer(d, v.value);
    const r = () => resolveSessionMcp({ db: d, conv: { mcpServers: ['web'] }, template: undefined, agentType: 'kiro', delegating: false });
    expect(r().inject).toHaveLength(1);
    recordAcpMcpCaps('kiro', { http: true, sse: false });
    expect(r().skipped).toEqual([{ id: 'web', reason: 'transport_unsupported' }]);
  });

  it('hermes ACP http/sse gated by cached caps (I2); stdio unaffected', () => {
    const d = db();
    const vHttp = validateMcpServerInput({ id: 'web-http', transport: 'http', url: 'https://h/mcp' });
    const vStdio = validateMcpServerInput({ id: 'local-stdio', transport: 'stdio', command: 'node', args: ['srv.js'] });
    if (vHttp.ok) upsertMcpServer(d, vHttp.value);
    if (vStdio.ok) upsertMcpServer(d, vStdio.value);

    // With hermes reporting no http/sse caps (hermes 0.22 behaviour)
    recordAcpMcpCaps('hermes', { http: false, sse: false });
    const r = resolveSessionMcp({ db: d, conv: { mcpServers: ['web-http', 'local-stdio'] }, template: undefined, agentType: 'hermes', delegating: false });
    expect(r.inject.map((s) => s.id)).toEqual(['local-stdio']);
    expect(r.skipped).toEqual([{ id: 'web-http', reason: 'transport_unsupported' }]);
  });

  it('codex: colliding secret env names across servers → secret_env_unsupported', () => {
    const d = db();
    upsertMcpServer(d, input({ id: 'x', env: [{ key: 'TOKEN', secret: true }] }));
    upsertMcpServer(d, input({ id: 'y', env: [{ key: 'TOKEN', secret: true }] }));
    setMcpSecret(d, 'x', 'env', 'TOKEN', 'value-one-123456');
    setMcpSecret(d, 'y', 'env', 'TOKEN', 'value-two-123456');
    const r = resolveSessionMcp({ db: d, conv: { mcpServers: ['x', 'y'] }, template: undefined, agentType: 'codex', delegating: false });
    expect(r.skipped).toEqual([{ id: 'y', reason: 'secret_env_unsupported' }]);
  });

  it('hash changes when a secret is rotated', async () => {
    const d = db();
    upsertMcpServer(d, input({ id: 's', env: [{ key: 'K', secret: true }] }));
    setMcpSecret(d, 's', 'env', 'K', SECRET);
    const h = () => resolveSessionMcp({ db: d, conv: { mcpServers: ['s'] }, template: undefined, agentType: 'claude-code', delegating: false }).hash;
    const h1 = h();
    expect(h1).not.toBe('');
    await new Promise((r) => setTimeout(r, 5));
    setMcpSecret(d, 's', 'env', 'K', `${SECRET}-rotated`);
    expect(h()).not.toBe(h1);
  });
});

describe('resolveSessionMcp remote placement', () => {
  it('remote: auto loopback http → hub placement with the real url; local leaves placement unset', () => {
    const d = db();
    const v = validateMcpServerInput({ id: 'hub-http', transport: 'http', url: 'http://127.0.0.1:5678/mcp' });
    if (!v.ok) throw new Error(v.error);
    upsertMcpServer(d, v.value);
    const base = { db: d, conv: { mcpServers: ['hub-http'] }, template: undefined, agentType: 'claude-code', delegating: false };
    expect(resolveSessionMcp(base).inject[0]).not.toHaveProperty('placement');
    const remote = resolveSessionMcp({ ...base, remoteHostId: 'rh-1' });
    expect(remote.skipped).toEqual([]);
    expect(remote.inject[0]).toMatchObject({ id: 'hub-http', url: 'http://127.0.0.1:5678/mcp', placement: 'hub' });
  });

  it('remote: loopback sse would sit on the hub but sse is not bridgeable', () => {
    const d = db();
    const v = validateMcpServerInput({ id: 'hub-sse', transport: 'sse', url: 'http://127.0.0.1:9/sse' });
    if (!v.ok) throw new Error(v.error);
    upsertMcpServer(d, v.value);
    const r = resolveSessionMcp({ db: d, conv: { mcpServers: ['hub-sse'] }, template: undefined, agentType: 'claude-code', delegating: false, remoteHostId: 'rh-1' });
    expect(r.skipped).toEqual([{ id: 'hub-sse', reason: 'hub_placement_unsupported' }]);
    expect(r.inject).toEqual([]);
  });

  it('remote: explicit hub http still clears the transport gate first (ACP caps)', () => {
    const d = db();
    const v = validateMcpServerInput({ id: 'hub-explicit', transport: 'http', url: 'https://mcp.example.com/mcp', placement: 'hub' });
    if (!v.ok) throw new Error(v.error);
    upsertMcpServer(d, v.value);
    recordAcpMcpCaps('qwen', { http: false, sse: false });
    const r = resolveSessionMcp({ db: d, conv: { mcpServers: ['hub-explicit'] }, template: undefined, agentType: 'qwen', delegating: false, remoteHostId: 'rh-1' });
    expect(r.skipped).toEqual([{ id: 'hub-explicit', reason: 'transport_unsupported' }]);
  });

  it('remote: stdio stays on the agent with no placement key', () => {
    const d = db();
    upsertMcpServer(d, input({ id: 'local-only' }));
    const r = resolveSessionMcp({ db: d, conv: { mcpServers: ['local-only'] }, template: undefined, agentType: 'claude-code', delegating: false, remoteHostId: 'rh-1' });
    expect(r.skipped).toEqual([]);
    expect(r.inject[0]).not.toHaveProperty('placement');
  });
});

describe('inject builders', () => {
  const stdio: ResolvedMcpServer = {
    id: 'everything', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], cwd: '/w',
    env: { PROBE_SECRET: SECRET, MODE: 'x' }, headers: {}, secretEnvKeys: ['PROBE_SECRET'], secretHeaderKeys: [],
  };
  const http: ResolvedMcpServer = {
    id: 'web', transport: 'http', url: 'https://h/mcp', args: [],
    env: {}, headers: { Authorization: `Bearer ${SECRET}`, 'X-A': 'b' }, secretEnvKeys: [], secretHeaderKeys: ['Authorization'],
  };

  it('claude: placeholders in config, values only in env, never on argv', () => {
    const c = toClaudeSdkMcp([stdio, http]);
    expect(c.mcpServers).toEqual({
      everything: { type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { PROBE_SECRET: '${TIERWYN_MCPV_0}', MODE: 'x' } },
      web: { type: 'http', url: 'https://h/mcp', headers: { Authorization: '${TIERWYN_MCPV_1}', 'X-A': 'b' } },
    });
    expect(c.env).toEqual({ TIERWYN_MCPV_0: SECRET, TIERWYN_MCPV_1: `Bearer ${SECRET}` });
  });

  it('codex: -c overrides, env_vars / env_http_headers indirection, no secret on argv', () => {
    const c = toCodexArgs([stdio, http]);
    expect(c.args.join(' ')).not.toContain(SECRET);
    expect(c.args).toEqual([
      '-c', 'mcp_servers.everything.command="npx"',
      '-c', 'mcp_servers.everything.args=["-y","srv"]',
      '-c', 'mcp_servers.everything.cwd="/w"',
      '-c', 'mcp_servers.everything.env={"MODE"="x"}',
      '-c', 'mcp_servers.everything.env_vars=["PROBE_SECRET"]',
      '-c', 'mcp_servers.web.url="https://h/mcp"',
      '-c', 'mcp_servers.web.http_headers={"X-A"="b"}',
      '-c', 'mcp_servers.web.env_http_headers={"Authorization"="TIERWYN_MCPV_0"}',
    ]);
    expect(c.env).toEqual({ PROBE_SECRET: SECRET, TIERWYN_MCPV_0: `Bearer ${SECRET}` });
  });

  it('ACP: literal values; http/sse dropped unless advertised', () => {
    expect(toAcpMcpServers([stdio, http], { http: false })).toEqual([
      { name: 'everything', command: 'npx', args: ['-y', 'srv'], env: [{ name: 'PROBE_SECRET', value: SECRET }, { name: 'MODE', value: 'x' }] },
    ]);
    expect(toAcpMcpServers([http], { http: true })).toEqual([
      { type: 'http', name: 'web', url: 'https://h/mcp', headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }, { name: 'X-A', value: 'b' }] },
    ]);
    expect(toAcpMcpServers(undefined, undefined)).toEqual([]);
  });
});

describe('redaction + child env', () => {
  it('appendEvent scrubs vault and env-fallback values (raw and JSON-escaped)', () => {
    const d = db();
    d.exec("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p','p','/tmp',0)");
    d.exec("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c','p','t',0,0)");
    d.exec("INSERT INTO sessions (id, conversation_id, created_at, updated_at) VALUES ('s','c',0,0)");
    upsertMcpServer(d, input({ id: 's', env: [{ key: 'K', secret: true }, { key: 'Q', secret: true, envFallback: 'TIERWYN_MCP_Q' }] }));
    setMcpSecret(d, 's', 'env', 'K', 'quote"secret-value');
    captureMcpEnv({ TIERWYN_MCP_Q: 'env-fallback-secret' });
    refreshMcpRedactSet(d);
    const ev = appendEvent(d, { sessionId: 's', type: 'message', sender: 'agent', payload: { text: 'a quote"secret-value b env-fallback-secret' } });
    expect(JSON.stringify(ev.payload)).not.toContain('secret-value');
    expect(JSON.stringify(ev.payload)).not.toContain('env-fallback-secret');
    expect(redactMcpSecrets('x env-fallback-secret y')).toBe('x [REDACTED] y');
  });

  it('buildChildEnv drops TIERWYN_MCP_* but keeps per-child TIERWYN_MCPV_* extras', () => {
    process.env.TIERWYN_MCP_LEAK = 'leak-value-123456';
    try {
      const env = buildChildEnv({ TIERWYN_MCPV_0: 'v' });
      expect(env.TIERWYN_MCP_LEAK).toBeUndefined();
      expect(env.TIERWYN_MCPV_0).toBe('v');
    } finally { delete process.env.TIERWYN_MCP_LEAK; }
  });
});
