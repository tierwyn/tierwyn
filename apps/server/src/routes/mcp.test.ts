import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AgentAdapter } from '@tierwyn/shared';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createPendingHost, saveHello, setRemoteHostStatus, updateRemoteHost } from '../repositories/remoteHosts.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { requireAuth } from '../auth/middleware.js';
import { createSessionToken, SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { initVaultKey } from '../plugins/vault.js';
import { recordHostMcpSkips } from '../mcp/bridge.js';
import { registerMcpRoutes } from './mcp.js';
import { registerConversationMutationRoutes } from './conversations.js';

const SESSION_SECRET = 'abcdefghijklmnopqrstuvwxyz012345';
const SECRET = 'tierwyn-probe-1234567890';
let server: Server;
let base: string;
let convId: string;
let fakeHome: string;
let activeSessions: any[] = [];
const reap = vi.fn(async () => {});
const applyMcp = vi.fn(async () => 'none' as const);
let live: { agentType: string; adapter: AgentAdapter } | undefined;
type RecordedRpc = { hostId: string; m: string; p: any };
let rpcCalls: RecordedRpc[] = [];
let nodeHubLink: ((hostId: string) => { request: (m: string, p?: unknown) => Promise<unknown> }) | undefined;

beforeEach(async () => {
  initVaultKey({ sessionSecret: SESSION_SECRET });
  reap.mockClear();
  applyMcp.mockClear();
  live = undefined;
  rpcCalls = [];
  nodeHubLink = undefined;
  fakeHome = mkdtempSync(join(tmpdir(), 'mcp-route-home-'));
  activeSessions = [];
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  setDb(db);
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  convId = createConversation(db, { projectId: project.id, title: 'root' }).id;
  const app = express();
  app.use(express.json());
  app.use(requireAuth({ disabled: false, configured: true, sessionSecret: SESSION_SECRET, passwordHash: 'x', cookieSecure: false }));
  registerMcpRoutes(app, {
    getDb,
    sessionManager: { activeSessionForConversation: () => live },
    getActiveSessions: () => activeSessions,
    getHome: () => fakeHome,
    // Lazy: fakeLink() runs inside the test, after registration.
    nodeHub: {
      link: (hostId) => {
        if (!nodeHubLink) throw new Error('no node link configured');
        return nodeHubLink(hostId);
      },
    },
  });
  registerConversationMutationRoutes(app, { getDb, sessionManager: { reapParkedSessions: reap, applyConversationMcpServers: applyMcp } as any });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const cookie = () => `${SESSION_COOKIE_NAME}=${createSessionToken(SESSION_SECRET, Date.now())}`;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie: cookie() }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

const server1 = { id: 'everything', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: [{ key: 'PROBE_SECRET', secret: true }] };

/** Enrolls a trusted remote host and a project bound to it. */
function enrollHost(opts: { features?: string[]; allowMcpSecrets?: boolean } = {}) {
  const host = createPendingHost(getDb(), 'box', 'tok', Date.now() + 60_000);
  setRemoteHostStatus(getDb(), host.id, 'trusted');
  saveHello(getDb(), host.id, { features: opts.features ?? [] } as any, Date.now());
  updateRemoteHost(getDb(), host.id, { allowMcpSecrets: opts.allowMcpSecrets === true });
  const project = createProject(getDb(), { name: 'rp', rootPath: '/tmp/rp', remoteHostId: host.id });
  return { host, project };
}

/** Fake node link: records every RPC, answers with canned per-method results. */
function fakeLink(canned: Partial<Record<string, (p: any) => unknown>> = {}) {
  rpcCalls = [];
  nodeHubLink = (hostId) => ({
    request: async (m, p) => {
      rpcCalls.push({ hostId, m, p });
      const hit = canned[m];
      if (hit) return hit(p as any);
      throw Object.assign(new Error(`unexpected rpc ${m}`), { code: 'unexpected' });
    },
  });
}

describe('MCP routes', () => {
  it('Bearer (no cookie) → 401 on every route', async () => {
    const bearer = { authorization: 'Bearer some-spawn-token' };
    for (const [m, p] of [
      ['GET', '/mcp/servers'],
      ['POST', '/mcp/servers'],
      ['GET', `/conversations/${convId}/mcp`],
      ['PUT', '/mcp/servers/everything/secrets/env/PROBE_SECRET'],
      ['GET', '/mcp/native?agentType=cursor'],
      ['POST', '/mcp/native/cursor'],
      ['DELETE', '/mcp/native/cursor/entry/x'],
    ] as const) {
      expect((await call(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, bearer)).status).toBe(401);
    }
  });

  it('CRUD + write-only secret; responses never carry the value', async () => {
    expect((await call('GET', '/mcp/servers')).body).toEqual({ servers: [], vaultAvailable: true });
    expect((await call('POST', '/mcp/servers', { ...server1, id: 'BAD' })).status).toBe(400);
    expect((await call('POST', '/mcp/servers', server1)).status).toBe(200);
    expect((await call('PUT', '/mcp/servers/everything/secrets/env/NOPE', { value: SECRET })).status).toBe(404);
    expect((await call('PUT', '/mcp/servers/everything/secrets/env/PROBE_SECRET', { value: 'short' })).status).toBe(400);
    const put = await call('PUT', '/mcp/servers/everything/secrets/env/PROBE_SECRET', { value: SECRET });
    expect(put.status).toBe(200);
    expect(put.body.server.env[0]).toMatchObject({ configured: true, source: 'vault' });
    const list = await call('GET', '/mcp/servers');
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect((await call('DELETE', '/mcp/servers/everything/secrets/env/PROBE_SECRET')).body.server.env[0].configured).toBe(false);
    expect((await call('DELETE', '/mcp/servers/everything')).body).toEqual({ ok: true });
    expect((await call('DELETE', '/mcp/servers/everything')).status).toBe(404);
  });

  it('vault unavailable → 503 on secret write', async () => {
    await call('POST', '/mcp/servers', server1);
    initVaultKey({ sessionSecret: 'short' });
    expect((await call('PUT', '/mcp/servers/everything/secrets/env/PROBE_SECRET', { value: SECRET })).status).toBe(503);
  });

  it('host preflight skips surface in the conversation view', async () => {
    await call('POST', '/mcp/servers', { id: 'fs', transport: 'stdio', command: 'npx', args: ['srv'] });
    expect((await call('PATCH', `/conversations/${convId}`, { mcpServers: ['fs'] })).status).toBe(200);
    recordHostMcpSkips(convId, [{ id: 'fs', reason: 'command_not_found_on_host' }]);
    const view = await call('GET', `/conversations/${convId}/mcp?agentType=claude-code`);
    expect(view.body.effective).toContainEqual({ id: 'fs', injected: false, reason: 'command_not_found_on_host' });
  });

  it('PATCH mcpServers persists, validates, reaps; GET view explains skips', async () => {
    await call('POST', '/mcp/servers', server1);
    expect((await call('PATCH', `/conversations/${convId}`, { mcpServers: ['Bad!'] })).status).toBe(400);
    const ok = await call('PATCH', `/conversations/${convId}`, { mcpServers: ['everything', 'ghost'] });
    expect(ok.status).toBe(200);
    expect(getConversation(getDb(), convId)?.mcpServers).toEqual(['everything', 'ghost']);
    expect(applyMcp).toHaveBeenCalledWith(convId);
    const view = await call('GET', `/conversations/${convId}/mcp?agentType=claude-code`);
    expect(view.body).toEqual({
      selected: ['everything', 'ghost'], inherited: [], agentType: 'claude-code', delegating: false,
      effective: [{ id: 'everything', injected: false, reason: 'secret_missing' }, { id: 'ghost', injected: false, reason: 'unknown' }],
      disableNative: false,
      disabledNative: [],
      modified: true,
    });
    await call('PATCH', `/conversations/${convId}`, { mcpServers: null });
    expect(getConversation(getDb(), convId)?.mcpServers).toBeUndefined();

    // Test disabling native MCP
    const nativePatch = await call('PATCH', `/conversations/${convId}`, { disableNativeMcp: true, disabledNativeMcp: ['fetch'] });
    expect(nativePatch.status).toBe(200);
    const convWithNative = getConversation(getDb(), convId);
    expect(convWithNative?.disableNativeMcp).toBe(true);
    expect(convWithNative?.disabledNativeMcp).toEqual(['fetch']);
    const viewNative = await call('GET', `/conversations/${convId}/mcp?agentType=claude-code`);
    expect(viewNative.body.disableNative).toBe(true);
    expect(viewNative.body.disabledNative).toEqual(['fetch']);
    expect(viewNative.body.modified).toBe(true);
    // Agents that ignore native overrides don't report them as "modified" (no silent no-op badge).
    const viewAg = await call('GET', `/conversations/${convId}/mcp?agentType=antigravity`);
    expect(viewAg.body.disableNative).toBe(true);
    expect(viewAg.body.modified).toBe(false);
    expect((await call('GET', `/conversations/${convId}/mcp?agentType=codex`)).body.modified).toBe(false);
  });

  it('live status: 409 without a session / unsupported agent; maps adapter output', async () => {
    expect((await call('GET', `/conversations/${convId}/mcp/status`)).body).toEqual({ error: 'no_live_session' });
    live = { agentType: 'codex', adapter: {} as AgentAdapter };
    expect((await call('GET', `/conversations/${convId}/mcp/status`)).body).toEqual({ error: 'unsupported_agent' });
    const mcpControl = vi.fn(async () => {});
    live = { agentType: 'claude-code', adapter: { mcpStatus: async () => [{ name: 'x', status: 'connected', source: 'tierwyn' }], mcpControl } as unknown as AgentAdapter };
    expect((await call('GET', `/conversations/${convId}/mcp/status`)).body).toEqual({ statuses: [{ name: 'x', status: 'connected', source: 'tierwyn' }] });
    expect((await call('POST', `/conversations/${convId}/mcp/x/explode`)).status).toBe(400);
    expect((await call('POST', `/conversations/${convId}/mcp/x/disable`)).body).toEqual({ ok: true });
    expect(mcpControl).toHaveBeenCalledWith('x', 'disable');
  });

  it('native view: 400 unknown agent, note for kimi', async () => {
    expect((await call('GET', '/mcp/native?agentType=nope')).status).toBe(400);
    expect((await call('GET', '/mcp/native?agentType=kimi')).body).toEqual({ entries: [], note: 'not readable (ACP injection only)' });
  });

  it('happy path install (claude-code, user scope): 200, masked entry, secret value nowhere in responses', async () => {
    await call('POST', '/mcp/servers', server1);
    await call('PUT', '/mcp/servers/everything/secrets/env/PROBE_SECRET', { value: SECRET });

    const installRes = await call('POST', '/mcp/native/claude-code', {
      serverId: 'everything',
      scope: 'user',
    });
    expect(installRes.status).toBe(200);
    expect(installRes.body.ok).toBe(true);
    expect(installRes.body.file).toBe(join(fakeHome, '.claude.json'));
    expect(installRes.body.entry.name).toBe('everything');
    expect(installRes.body.secrets).toBe('placeholders');
    expect(installRes.body.placeholderVars).toEqual(['PROBE_SECRET']);
    expect(JSON.stringify(installRes.body)).not.toContain(SECRET);

    const nativeView = await call('GET', '/mcp/native?agentType=claude-code');
    expect(nativeView.status).toBe(200);
    expect(nativeView.body.entries.some((e: any) => e.name === 'everything')).toBe(true);
    expect(JSON.stringify(nativeView.body)).not.toContain(SECRET);
  });

  it('native install 400s: non-writable, bad scope, missing projectId, http into qwen, secrets without copySecrets, disabled server, unknown server', async () => {
    await call('POST', '/mcp/servers', server1);

    // Non-writable agent (codex)
    expect((await call('POST', '/mcp/native/codex', { serverId: 'everything', scope: 'user' })).status).toBe(400);

    // Bad scope
    expect((await call('POST', '/mcp/native/claude-code', { serverId: 'everything', scope: 'invalid' })).status).toBe(400);

    // Project scope without projectId
    expect((await call('POST', '/mcp/native/claude-code', { serverId: 'everything', scope: 'project' })).status).toBe(400);

    // Disabled registry server
    await call('POST', '/mcp/servers', { id: 'disabled-srv', transport: 'stdio', command: 'node', enabled: false });
    const dis = await call('POST', '/mcp/native/claude-code', { serverId: 'disabled-srv', scope: 'user' });
    expect(dis.status).toBe(400);
    expect(dis.body.error).toContain('enable the server in the registry first');

    // Unknown serverId -> 404
    expect((await call('POST', '/mcp/native/claude-code', { serverId: 'nonexistent-srv', scope: 'user' })).status).toBe(404);

    // HTTP into qwen -> 400
    await call('POST', '/mcp/servers', { id: 'http-srv', transport: 'http', url: 'https://example.com' });
    const qwenRes = await call('POST', '/mcp/native/qwen', { serverId: 'http-srv', scope: 'user' });
    expect(qwenRes.status).toBe(400);
    expect(qwenRes.body.error).toContain('transport http not supported for qwen');

    // Secrets without copySecrets (cursor)
    const cursorRes = await call('POST', '/mcp/native/cursor', { serverId: 'everything', scope: 'user' });
    expect(cursorRes.status).toBe(400);
    expect(cursorRes.body.error).toContain('copySecrets');
  });

  it('native routes refuse remote projects (config lives on the host)', async () => {
    await call('POST', '/mcp/servers', { id: 'hub-one', transport: 'http', url: 'http://127.0.0.1:1/x' });
    const host = createPendingHost(getDb(), 'box', 'tok', Date.now() + 60_000);
    const rp = createProject(getDb(), { name: 'rp', rootPath: '/tmp/rp', remoteHostId: host.id });

    const post = await call('POST', '/mcp/native/claude-code', { serverId: 'hub-one', scope: 'project', projectId: rp.id });
    expect(post.status).toBe(409);
    expect(post.body.code).toBe('remote_project');
    expect(post.body.error).toContain('box');
    expect((await call('GET', `/mcp/native?agentType=claude-code&projectId=${rp.id}`)).status).toBe(409);
    expect((await call('DELETE', `/mcp/native/claude-code/entry/foo?scope=project&projectId=${rp.id}`)).status).toBe(409);
  });

  it('GET /mcp/native on a remote project proxies to the node; hub files untouched', async () => {
    const { host, project } = enrollHost({ features: ['mcp.native'] });
    fakeLink({ 'mcp.native.read': () => ({ entries: [{ name: 'on-node', scope: 'user', transport: 'stdio' }] }) });
    const res = await call('GET', `/mcp/native?agentType=claude-code&projectId=${project.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [{ name: 'on-node', scope: 'user', transport: 'stdio' }] });
    expect(rpcCalls).toEqual([
      { hostId: host.id, m: 'mcp.native.read', p: { agentType: 'claude-code', root: '/tmp/rp' } },
    ]);
    expect(existsSync(join(fakeHome, '.claude.json'))).toBe(false);
  });

  it('POST remote install (placeholder agent) sends empty secretValues and no values on the wire', async () => {
    const { host, project } = enrollHost({ features: ['mcp.native'] });
    await call('POST', '/mcp/servers', { id: 'hub-one', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: [{ key: 'TOK', secret: true }] });
    fakeLink({
      'mcp.native.write': (p) => ({ ok: true, agentType: p.agentType, file: '/node/.mcp.json', overwrote: false, entry: { name: p.row.id, scope: p.scope }, secrets: 'placeholders' }),
    });
    const res = await call('POST', '/mcp/native/claude-code', { serverId: 'hub-one', scope: 'project', projectId: project.id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].hostId).toBe(host.id);
    expect(rpcCalls[0].m).toBe('mcp.native.write');
    expect(rpcCalls[0].p).toMatchObject({ op: 'install', agentType: 'claude-code', scope: 'project', root: '/tmp/rp', copySecrets: false });
    expect(rpcCalls[0].p.secretValues).toEqual({ env: {}, headers: {} });
    expect(rpcCalls[0].p.row).toMatchObject({ id: 'hub-one', command: 'npx', args: ['-y', 'srv'] });
    expect(rpcCalls[0].p.row.env[0].secret).toBe(true);
    expect(rpcCalls[0].p.row.env[0].value).toBeUndefined();
  });

  it('POST remote install with copySecrets sends resolved vault values; response hides them', async () => {
    const { host, project } = enrollHost({ features: ['mcp.native'], allowMcpSecrets: true });
    await call('POST', '/mcp/servers', server1);
    expect((await call('PUT', '/mcp/servers/everything/secrets/env/PROBE_SECRET', { value: SECRET })).status).toBe(200);
    fakeLink({ 'mcp.native.write': () => ({ ok: true, entry: { name: 'everything', scope: 'project' }, secrets: 'copied' }) });
    const res = await call('POST', '/mcp/native/claude-code', { serverId: 'everything', scope: 'project', projectId: project.id, copySecrets: true });
    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].hostId).toBe(host.id);
    expect(rpcCalls[0].p.copySecrets).toBe(true);
    expect(rpcCalls[0].p.secretValues.env.PROBE_SECRET).toBe(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('copySecrets on a host without the MCP secrets toggle → 403, no RPC', async () => {
    const { project } = enrollHost({ features: ['mcp.native'] });
    await call('POST', '/mcp/servers', server1);
    fakeLink();
    const res = await call('POST', '/mcp/native/claude-code', { serverId: 'everything', scope: 'project', projectId: project.id, copySecrets: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('secrets_not_allowed_on_host');
    expect(rpcCalls).toHaveLength(0);
  });

  it('old node without the mcp.native feature → legacy 409 remote_project, no RPC', async () => {
    const { project } = enrollHost();
    fakeLink();
    expect((await call('GET', `/mcp/native?agentType=claude-code&projectId=${project.id}`)).status).toBe(409);
    expect((await call('POST', '/mcp/native/claude-code', { serverId: 'everything', scope: 'project', projectId: project.id })).status).toBe(409);
    expect((await call('DELETE', `/mcp/native/claude-code/entry/x?scope=project&projectId=${project.id}`)).status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('node without the handler (no_method) → 501 node_update_required', async () => {
    const { project } = enrollHost({ features: ['mcp.native'] });
    rpcCalls = [];
    nodeHubLink = (hostId) => ({
      request: async (m) => {
        rpcCalls.push({ hostId, m, p: undefined });
        throw Object.assign(new Error('no handler for mcp.native.read'), { code: 'no_method' });
      },
    });
    const res = await call('GET', `/mcp/native?agentType=claude-code&projectId=${project.id}`);
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('node_update_required');
  });

  it('node-side NativeWriteError status maps back to HTTP (404 on remove)', async () => {
    const { project } = enrollHost({ features: ['mcp.native'] });
    rpcCalls = [];
    nodeHubLink = (hostId) => ({
      request: async (m, p) => {
        rpcCalls.push({ hostId, m, p });
        throw Object.assign(new Error('entry "nope" not found in native config'), { code: 'native_404' });
      },
    });
    const res = await call('DELETE', `/mcp/native/claude-code/entry/nope?scope=project&projectId=${project.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
    expect(rpcCalls[0].p).toEqual({ op: 'remove', agentType: 'claude-code', scope: 'project', root: '/tmp/rp', name: 'nope' });
  });

  it('remote project-scope install 409s when agents are live on the remote checkout', async () => {
    const { project } = enrollHost({ features: ['mcp.native'] });
    await call('POST', '/mcp/servers', { id: 'hub-one', transport: 'stdio', command: 'true' });
    const conv = createConversation(getDb(), { projectId: project.id, title: 'r' });
    activeSessions = [
      { conversationId: conv.id, lastStatus: 'running', steerQueue: [], steerOrigin: { cwd: '/tmp/rp' } },
    ];
    fakeLink({
      'git.call': (p) => ({ ok: true, r: { branch: 'main', detached: false, headSha: 's', toplevel: p.cwd } }),
    });
    const res = await call('POST', '/mcp/native/claude-code', { serverId: 'hub-one', scope: 'project', projectId: project.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Cannot install: 1 agent\(s\) active on this checkout/);
  });

  it('project scope: normalises trailing slash in rootPath, writes file; 409 when live agents active', async () => {
    await call('POST', '/mcp/servers', { id: 'simple', transport: 'stdio', command: 'true' });
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-project-root-'));
    const proj = createProject(getDb(), { name: 'proj-with-slash', rootPath: `${tempRoot}/` });

    // Without live agents -> 200, writes <root>/.mcp.json
    const okRes = await call('POST', '/mcp/native/claude-code', {
      serverId: 'simple',
      scope: 'project',
      projectId: proj.id,
    });
    expect(okRes.status).toBe(200);
    expect(okRes.body.file).toBe(join(tempRoot, '.mcp.json'));
    const written = JSON.parse(readFileSync(join(tempRoot, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.simple).toBeDefined();

    // With active session on that root -> 409
    activeSessions = [
      {
        conversationId: convId,
        lastStatus: 'running',
        steerQueue: [],
        steerOrigin: { cwd: tempRoot },
      },
    ];

    const conflictRes = await call('POST', '/mcp/native/claude-code', {
      serverId: 'simple',
      scope: 'project',
      projectId: proj.id,
    });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error).toMatch(/Cannot install: 1 agent\(s\) active on this checkout/);

    // Remove also fails 409 when live agents active
    const removeConflict = await call('DELETE', `/mcp/native/claude-code/entry/simple?scope=project&projectId=${proj.id}`);
    expect(removeConflict.status).toBe(409);
    expect(removeConflict.body.error).toMatch(/Cannot remove: 1 agent\(s\) active on this checkout/);
  });

  it('index.ts wires nodeHub into registerMcpRoutes', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(
      /registerMcpRoutes\(app,\s*\{[\s\S]*?nodeHub:\s*\{\s*link:\s*\(id\)\s*=>\s*nodeHub\.link\(id\)/,
    );
  });

  it('user-scope install/delete with remote projectId hits node RPC and leaves hub files untouched', async () => {
    const { host, project } = enrollHost({ features: ['mcp.native'] });
    await call('POST', '/mcp/servers', { id: 'hub-one', transport: 'stdio', command: 'true' });
    fakeLink({
      'mcp.native.write': (p) => ({ ok: true, entry: { name: p.row?.id ?? p.name, scope: p.scope } }),
    });
    const install = await call('POST', '/mcp/native/claude-code', {
      serverId: 'hub-one',
      scope: 'user',
      projectId: project.id,
    });
    expect(install.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      hostId: host.id,
      m: 'mcp.native.write',
      p: { op: 'install', agentType: 'claude-code', scope: 'user' },
    });
    expect(existsSync(join(fakeHome, '.claude.json'))).toBe(false);

    rpcCalls = [];
    fakeLink({
      'mcp.native.write': (p) => ({ ok: true, entry: { name: p.name, scope: p.scope } }),
    });
    const del = await call('DELETE', `/mcp/native/claude-code/entry/hub-one?scope=user&projectId=${project.id}`);
    expect(del.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      hostId: host.id,
      m: 'mcp.native.write',
      p: { op: 'remove', agentType: 'claude-code', scope: 'user', name: 'hub-one' },
    });
    expect(existsSync(join(fakeHome, '.claude.json'))).toBe(false);
  });

  it('path_outside_roots from the node maps to 403', async () => {
    const { project } = enrollHost({ features: ['mcp.native'] });
    nodeHubLink = () => ({
      request: async () => {
        throw Object.assign(new Error('/evil is outside roots'), { code: 'path_outside_roots' });
      },
    });
    const res = await call('GET', `/mcp/native?agentType=claude-code&projectId=${project.id}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('path_outside_roots');
  });

  it('remove round-trip: install then DELETE -> 200, GET native no longer lists it', async () => {
    await call('POST', '/mcp/servers', { id: 'roundtrip', transport: 'stdio', command: 'node', args: ['x.js'] });

    const installRes = await call('POST', '/mcp/native/claude-code', {
      serverId: 'roundtrip',
      scope: 'user',
    });
    expect(installRes.status).toBe(200);

    const viewBefore = await call('GET', '/mcp/native?agentType=claude-code');
    expect(viewBefore.body.entries.some((e: any) => e.name === 'roundtrip')).toBe(true);

    const delRes = await call('DELETE', '/mcp/native/claude-code/entry/roundtrip?scope=user');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const viewAfter = await call('GET', '/mcp/native?agentType=claude-code');
    expect(viewAfter.body.entries.some((e: any) => e.name === 'roundtrip')).toBe(false);
  });
});
