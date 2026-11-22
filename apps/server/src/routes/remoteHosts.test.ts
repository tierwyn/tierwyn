import { createHash, generateKeyPairSync } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { requireAuth } from '../auth/middleware.js';
import { LoginRateLimiter } from '../auth/rateLimit.js';
import type { NodeHello } from '@tierwyn/shared';
import { saveHello, type RemoteHostRow } from '../repositories/remoteHosts.js';
import { initVaultKey, vaultSet } from '../plugins/vault.js';
import { AGENT_VAULT_ID } from '../secrets/mcpRedact.js';
import { agentEnvVaultKey } from '../secrets/agentEnv.js';
import { RpcError } from '../node/rpc.js';
import {
  registerNodeEnrollRoute,
  registerRemoteHostRoutes,
  disconnectedHostView,
} from './remoteHosts.js';

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function ed25519SpkiB64(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function x25519SpkiB64(): string {
  const { publicKey } = generateKeyPairSync('x25519');
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function stubHub() {
  return {
    view: (row: RemoteHostRow) => disconnectedHostView(row),
    disconnect: vi.fn(),
    refresh: vi.fn(async () => { throw new Error('not connected'); }),
    syncAgentEnv: vi.fn(async () => {}),
  };
}

function writeManifest(dir: string, buildId = 'pkg-build-id') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    buildId,
    sha256: 'ab'.repeat(32),
    size: 1,
    file: 'tierwyn-node-test.tgz',
  }));
}

function boot(opts: { now?: () => number; hub?: ReturnType<typeof stubHub>; packageDir?: string; broadcast?: (host: any) => void; reapParkedForHost?: (hostId: string) => Promise<void> } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  const rateLimiter = new LoginRateLimiter({
    maxAttempts: 5,
    windowMs: 15 * 60_000,
    lockoutMs: 15 * 60_000,
  });
  const hub = opts.hub ?? stubHub();
  const now = opts.now;
  registerNodeEnrollRoute(app, { db: () => db, rateLimiter, now });
  const ret = registerRemoteHostRoutes(app, {
    db: () => db,
    hub,
    now,
    broadcast: opts.broadcast,
    // Missing dir: tests must not pick up a real dist/node-package from the worktree.
    packageDir: opts.packageDir ?? join(tmpdir(), 'tierwyn-no-pkg-test'),
    reapParkedForHost: opts.reapParkedForHost,
  });
  return { db, app, hub, pushHost: ret?.pushHost, applyLoginEvent: ret?.applyLoginEvent };
}

function call(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json', ...headers },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (r) => {
          const text = await r.text();
          let json: any = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = text; }
          return { status: r.status, json, text };
        })
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

async function createHost(app: express.Express, name = 'box-a') {
  return call(app, 'POST', '/remote-hosts', { name });
}

async function trustedHost(app: express.Express, agents: Record<string, unknown>, name: string): Promise<string> {
  const created = await createHost(app, name);
  const en = await call(app, 'POST', '/node/enroll', {
    token: created.json.token,
    publicKey: ed25519SpkiB64(),
    hubOrigin: 'https://hub.example',
    hello: { hostname: 'node-a', os: 'linux', arch: 'x64', agents },
  });
  await call(app, 'POST', `/remote-hosts/${en.json.hostId}/trust`);
  return en.json.hostId as string;
}

async function enroll(app: express.Express, token: string, publicKey = ed25519SpkiB64()) {
  return call(app, 'POST', '/node/enroll', {
    token,
    publicKey,
    hubOrigin: 'https://hub.example',
    hello: { hostname: 'node-a', os: 'linux', arch: 'x64' },
  });
}

describe('remote host enrollment + trust routes', () => {
  it('create returns token once; GET never contains token or hash', async () => {
    const { app } = boot();
    const created = await createHost(app, 'alpha');
    expect(created.status).toBe(200);
    expect(typeof created.json.token).toBe('string');
    expect(created.json.token.length).toBeGreaterThan(20);
    expect(created.json.host.state).toBe('pending');
    expect(created.json.oneLiner).toContain(created.json.token);
    expect(created.json.oneLiner).toContain('node enroll --hub');
    expect(typeof created.json.expiresAt).toBe('number');

    const token = created.json.token as string;
    const hash = createHash('sha256').update(token).digest('hex');
    const listed = await call(app, 'GET', '/remote-hosts');
    expect(listed.status).toBe(200);
    const dump = JSON.stringify(listed.json);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(hash);
    expect(listed.json.hosts).toHaveLength(1);
    expect(listed.json.hosts[0].state).toBe('pending');
    expect(listed.json.hosts[0].sidecarAdvisories).toEqual([]);
  });

  it('enroll with valid token defaults to untrusted (autoTrust opt-in)', async () => {
    const { app, db } = boot();
    const created = await createHost(app);
    const rowBefore = db.prepare('SELECT auto_trust FROM remote_hosts WHERE id=?')
      .get(created.json.host.id) as { auto_trust: number };
    expect(rowBefore.auto_trust).toBe(0);

    const res = await enroll(app, created.json.token);
    expect(res.status).toBe(200);
    expect(res.json.hostId).toBe(created.json.host.id);
    expect(res.json.trusted).toBe(false);

    const row = db.prepare('SELECT status, enroll_token_hash FROM remote_hosts WHERE id=?')
      .get(created.json.host.id) as { status: string; enroll_token_hash: string | null };
    expect(row.status).toBe('enrolled');
    expect(row.enroll_token_hash).toBeNull();

    const listed = await call(app, 'GET', '/remote-hosts');
    expect(listed.json.hosts[0].state).toBe('untrusted');
    expect(typeof listed.json.hosts[0].enrollIp).toBe('string');
    expect(listed.json.hosts[0].enrollIp.length).toBeGreaterThan(0);
    expect(JSON.stringify(listed.json)).not.toContain(created.json.token);
  });

  it('create autoTrust:true → enroll lands trusted', async () => {
    const { app, db } = boot();
    const created = await call(app, 'POST', '/remote-hosts', { name: 'auto', autoTrust: true });
    const res = await enroll(app, created.json.token);
    expect(res.status).toBe(200);
    expect(res.json.trusted).toBe(true);
    const row = db.prepare('SELECT status FROM remote_hosts WHERE id=?')
      .get(created.json.host.id) as { status: string };
    expect(row.status).toBe('trusted');
  });

  it('insecure Origin forces autoTrust off even when body asks true', async () => {
    const { app, db } = boot();
    const created = await call(
      app, 'POST', '/remote-hosts', { name: 'http-hub', autoTrust: true },
      { origin: 'http://127.0.0.1:4173' },
    );
    expect(created.json.insecureOrigin).toBe(true);
    const row = db.prepare('SELECT auto_trust FROM remote_hosts WHERE id=?')
      .get(created.json.host.id) as { auto_trust: number };
    expect(row.auto_trust).toBe(0);
  });

  it('two concurrent redeems of one token → exactly one 200', async () => {
    const { app } = boot();
    const created = await call(app, 'POST', '/remote-hosts', { name: 'race', autoTrust: true });
    const token = created.json.token as string;
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const post = (publicKey: string) => fetch(`http://127.0.0.1:${port}/node/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          publicKey,
          hubOrigin: 'https://hub.example',
          hello: { hostname: 'node-a', os: 'linux', arch: 'x64' },
        }),
      }).then((r) => r.status);
      const statuses = (await Promise.all([post(ed25519SpkiB64()), post(ed25519SpkiB64())])).sort();
      expect(statuses).toEqual([200, 401]);
    } finally {
      server.close();
    }
  });

  it('create autoTrust:false → enroll lands enrolled/untrusted', async () => {
    const { app, db } = boot();
    const created = await call(app, 'POST', '/remote-hosts', { name: 'manual', autoTrust: false });
    const res = await enroll(app, created.json.token);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ hostId: created.json.host.id, trusted: false });

    const row = db.prepare('SELECT status, enroll_token_hash FROM remote_hosts WHERE id=?')
      .get(created.json.host.id) as { status: string; enroll_token_hash: string | null };
    expect(row.status).toBe('enrolled');
    expect(row.enroll_token_hash).toBeNull();

    const listed = await call(app, 'GET', '/remote-hosts');
    expect(listed.json.hosts[0].state).toBe('untrusted');
  });

  it('enroll replay → 401', async () => {
    const { app } = boot();
    const created = await createHost(app);
    const token = created.json.token as string;
    expect((await enroll(app, token)).status).toBe(200);
    const replay = await enroll(app, token);
    expect(replay.status).toBe(401);
  });

  it('enroll expired → 401', async () => {
    const clock = makeClock();
    const { app } = boot({ now: clock.now });
    const created = await createHost(app);
    clock.advance(10 * 60_000 + 1);
    const res = await enroll(app, created.json.token);
    expect(res.status).toBe(401);
  });

  it('enroll rejects non-ed25519 key', async () => {
    const { app } = boot();
    const created = await createHost(app);
    const res = await enroll(app, created.json.token, x25519SpkiB64());
    expect(res.status).toBe(400);
  });

  it('6th bad enroll from same IP → 429', async () => {
    const { app } = boot();
    for (let i = 0; i < 5; i++) {
      const r = await call(app, 'POST', '/node/enroll', {
        token: 'bogus-token',
        publicKey: ed25519SpkiB64(),
        hubOrigin: 'https://hub.example',
        hello: {},
      });
      expect(r.status).toBe(401);
    }
    const locked = await call(app, 'POST', '/node/enroll', {
      token: 'bogus-token',
      publicKey: ed25519SpkiB64(),
      hubOrigin: 'https://hub.example',
      hello: {},
    });
    expect(locked.status).toBe(429);
  });

  it('trust only from enrolled', async () => {
    const { app } = boot();
    const created = await call(app, 'POST', '/remote-hosts', { name: 'trust-me', autoTrust: false });
    const id = created.json.host.id as string;
    const pending = await call(app, 'POST', `/remote-hosts/${id}/trust`);
    expect(pending.status).toBe(409);

    await enroll(app, created.json.token);
    const ok = await call(app, 'POST', `/remote-hosts/${id}/trust`);
    expect(ok.status).toBe(200);
    expect(ok.json.host.state).toBe('disconnected');

    const again = await call(app, 'POST', `/remote-hosts/${id}/trust`);
    expect(again.status).toBe(409);
  });

  it('disable calls hub.disconnect', async () => {
    const hub = stubHub();
    const { app } = boot({ hub });
    const created = await createHost(app, 'to-disable');
    const id = created.json.host.id as string;
    await enroll(app, created.json.token);
    await call(app, 'POST', `/remote-hosts/${id}/trust`);
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { disabled: true });
    expect(res.status).toBe(200);
    expect(res.json.host.state).toBe('disabled');
    expect(hub.disconnect).toHaveBeenCalledWith(id, 'host disabled');
  });

  it('delete 409 while project bound', async () => {
    const { app, db } = boot();
    const created = await createHost(app, 'bound');
    const id = created.json.host.id as string;
    createProject(db, { name: 'P', rootPath: '/tmp/p', remoteHostId: id });
    const listed = await call(app, 'GET', '/remote-hosts');
    expect(listed.json.hosts[0].boundProjects).toEqual([{ id: expect.any(String), name: 'P' }]);
    const res = await call(app, 'DELETE', `/remote-hosts/${id}`);
    expect(res.status).toBe(409);
    expect(res.json.projects).toBe(1);
    expect(res.json.projectNames).toEqual(['P']);
    expect(res.json.error).toContain('P');
  });

  it('delete ?unbind=1 unbinds bound projects then removes the host', async () => {
    const { app, db } = boot();
    const created = await createHost(app, 'bound-unbind');
    const id = created.json.host.id as string;
    const project = createProject(db, { name: 'P', rootPath: '/tmp/p', remoteHostId: id });
    const res = await call(app, 'DELETE', `/remote-hosts/${id}?unbind=1`);
    expect(res.status).toBe(200);
    const listed = await call(app, 'GET', '/remote-hosts');
    expect(listed.json.hosts).toEqual([]);
    const row = db.prepare('SELECT remote_host_id FROM projects WHERE id = ?')
      .get(project.id) as { remote_host_id: string | null };
    expect(row.remote_host_id).toBeNull();
  });

  it('/remote-hosts requires cookie', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const app = express();
    app.use(express.json());
    app.use(requireAuth({
      disabled: false,
      configured: true,
      sessionSecret: 'unit-test-session-secret-value-32bytes',
      passwordHash: 'not-used',
      cookieSecure: false,
    }));
    registerRemoteHostRoutes(app, { db: () => db, hub: stubHub() });
    const res = await call(app, 'GET', '/remote-hosts');
    expect(res.status).toBe(401);
  });

  it('registerNodeEnrollRoute is before requireAuth; registerRemoteHostRoutes after', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), '../index.ts');
    const src = readFileSync(indexPath, 'utf8');
    const enrollIdx = src.indexOf('registerNodeEnrollRoute(app');
    const authIdx = src.indexOf('app.use(requireAuth(authConfig))');
    const hostsIdx = src.indexOf('registerRemoteHostRoutes(app');
    expect(enrollIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(hostsIdx).toBeGreaterThan(-1);
    expect(enrollIdx).toBeLessThan(authIdx);
    expect(hostsIdx).toBeGreaterThan(authIdx);
  });
});

describe('POST /remote-hosts/:id/agents/:type/install', () => {
  const AGENTS_OK = { pi: { installed: false, allowed: true, installable: true, methods: [] } };

  function installHub(opts: { connected?: boolean } = {}) {
    let release!: (r: unknown) => void;
    const gate = new Promise((res) => { release = res; });
    const hub = {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({})),
      isConnected: vi.fn(() => opts.connected ?? true),
      link: vi.fn(() => ({
        request: async () => {
          await gate;
          return { code: 0, tail: 'added' };
        },
      })),
    };
    return { hub, release };
  }

  it('404 on an unknown host', async () => {
    const { app } = boot({ hub: installHub().hub as never });
    const r = await call(app, 'POST', '/remote-hosts/nope/agents/pi/install');
    expect(r.status).toBe(404);
  });

  it('409 when the host is not connected', async () => {
    const h = installHub({ connected: false });
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_OK, 'disc-a');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('host is not connected');
  });

  it('400 when the agent is not on the node allow-list', async () => {
    const h = installHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, { pi: { installed: false, allowed: false, installable: true, methods: [] } }, 'nallow-a');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('add pi to allowedAgents in node.json on the host first');
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('400 when the node has no install command for the agent', async () => {
    const h = installHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, { pi: { installed: false, allowed: true, methods: [] } }, 'ninst-a');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain('no install command');
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('409 while a run for (host, agent) is already in flight', async () => {
    const h = installHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_OK, 'busy-a');
    const first = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    expect(first.status).toBe(202);
    expect(first.json).toEqual({ ok: true, started: true });
    const second = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    expect(second.status).toBe(409);
    h.release({ code: 0, tail: 'added' });
  });

  it('202 then records ok + refreshes the host hello', async () => {
    const h = installHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_OK, 'ok-a');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    expect(r.status).toBe(202);
    h.release({ code: 0, tail: 'added' });
    await vi.waitFor(async () => {
      const list = await call(app, 'GET', '/remote-hosts');
      const host = list.json.hosts.find((x: { id: string }) => x.id === id);
      expect(host?.installs?.[0]).toMatchObject({ agentType: 'pi', running: false, ok: true, tail: 'added' });
    });
    expect(h.hub.refresh).toHaveBeenCalledWith(id, { reprobed: 'pi' });
  });

  it('stays running until the post-install hello refresh lands (no stale Install ▸ window)', async () => {
    const h = installHub();
    let releaseRefresh!: () => void;
    h.hub.refresh = vi.fn(() => new Promise<never>((res) => { releaseRefresh = () => res({} as never); }));
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_OK, 'stale-a');
    await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    h.release({ code: 0, tail: 'added' });
    await vi.waitFor(() => expect(h.hub.refresh).toHaveBeenCalled());
    const mid = await call(app, 'GET', '/remote-hosts');
    expect(mid.json.hosts.find((x: { id: string }) => x.id === id)?.installs?.[0]).toMatchObject({ running: true });
    releaseRefresh();
    await vi.waitFor(async () => {
      const list = await call(app, 'GET', '/remote-hosts');
      expect(list.json.hosts.find((x: { id: string }) => x.id === id)?.installs?.[0]).toMatchObject({ running: false, ok: true });
    });
  });

  it.each([
    ['agent_busy', 'agent has live sessions on the host'],
    ['no_method', 'update the tierwyn node on the host to install'],
  ])('records a failed run: %s → %s', async (code, wantTail) => {
    const hub = {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({})),
      isConnected: vi.fn(() => true),
      link: () => ({
        request: async () => { throw new RpcError(code as never, code); },
      }),
    };
    const { app } = boot({ hub: hub as never });
    const id = await trustedHost(app, AGENTS_OK, `fail-${code}`);
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    expect(r.status).toBe(202);
    await vi.waitFor(async () => {
      const list = await call(app, 'GET', '/remote-hosts');
      const host = list.json.hosts.find((x: { id: string }) => x.id === id);
      expect(host?.installs?.[0]).toMatchObject({ agentType: 'pi', running: false, ok: false, tail: wantTail });
    });
  });
});

describe('POST /remote-hosts/:id/agents/install-all', () => {
  const AGENTS_BATCH = {
    pi: { installed: false, allowed: true, installable: true, methods: [] },
    codex: { installed: true, allowed: true, installable: true, version: '1.0.0', methods: [] },
    'grok-bot': { installed: true, allowed: true, installable: false, methods: [] },
    hermes: { installed: true, allowed: true, installable: true, version: '2.0.0', methods: [] },
  };

  function batchHub(connected: () => boolean = () => true) {
    const calls: string[] = [];
    const pending: Array<(r: unknown) => void> = [];
    const hub = {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({})),
      isConnected: vi.fn(connected),
      link: vi.fn(() => ({
        request: async (_m: string, p: { agentType: string }) => {
          calls.push(p.agentType);
          // The settle call decides the RPC outcome (default ok) so tests can
          // exercise per-item failure isolation.
          return await new Promise<{ code: number; tail: string }>((res) => { pending.push(res); });
        },
      })),
    };
    return {
      hub,
      calls,
      settle: (r?: { code: number; tail: string }) => {
        pending.shift()?.(r ?? { code: 0, tail: `added ${calls[calls.length - 1]}` });
      },
    };
  }

  function seedVersions(db: import('better-sqlite3').Database, cache: Record<string, unknown>) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_versions', ?)")
      .run(JSON.stringify(cache));
  }

  async function getHost(app: express.Express, id: string) {
    const list = await call(app, 'GET', '/remote-hosts');
    return list.json.hosts.find((x: { id: string }) => x.id === id);
  }

  it('installs missing + behind agents strictly sequentially and clears installBatch', async () => {
    const h = batchHub();
    const { app, db } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_BATCH, 'batch-a');
    seedVersions(db, { codex: { latest: '2.0.0', checkedAt: 1 }, hermes: { latest: '2.0.0', checkedAt: 1 } });
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/install-all`);
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, started: true, targets: ['pi', 'codex'], skipped: [] });
    // grok-bot not installable, hermes not behind → excluded. The loop removes
    // 'pi' from the batch queue before its install RPC settles.
    expect(h.calls).toEqual(['pi']);
    let host = await getHost(app, id);
    expect(host.installBatch).toEqual({ running: true, remaining: ['codex'] });
    h.settle();
    await vi.waitFor(async () => {
      host = await getHost(app, id);
      expect(h.calls).toEqual(['pi', 'codex']);
      // Final-item window: the queue is empty but the batch guard holds until
      // the last install settles.
      expect(host.installBatch).toEqual({ running: true, remaining: [] });
    });
    h.settle();
    await vi.waitFor(async () => {
      host = await getHost(app, id);
      expect(host.installBatch).toBeUndefined();
      expect(host.installs).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentType: 'codex', running: false, ok: true }),
      ]));
    });
    expect(host.installs).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentType: 'pi', running: false, ok: true, tail: 'added pi' }),
      expect.objectContaining({ agentType: 'codex', running: false, ok: true, tail: 'added codex' }),
    ]));
  });

  it("mode 'missing' skips behind-but-installed agents", async () => {
    const h = batchHub();
    const { app, db } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_BATCH, 'batch-missing');
    seedVersions(db, { codex: { latest: '2.0.0', checkedAt: 1 } });
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/install-all`, { mode: 'missing' });
    expect(r.status).toBe(202);
    expect(r.json.targets).toEqual(['pi']);
    h.settle();
    await vi.waitFor(() => expect(h.calls).toEqual(['pi']));
  });

  it('reports started:false when nobody needs an install', async () => {
    const h = batchHub();
    const { app, db } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, {
      codex: { installed: true, allowed: true, installable: true, version: '1.0.0', methods: [] },
      hermes: { installed: true, allowed: true, installable: true, version: '2.0.0', methods: [] },
    }, 'batch-none');
    seedVersions(db, { codex: { latest: '1.0.0', checkedAt: 1 }, hermes: { latest: '2.0.0', checkedAt: 1 } });
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/install-all`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, started: false, targets: [], skipped: [] });
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('409 while a batch is already running for the host', async () => {
    const h = batchHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_BATCH, 'batch-409');
    const first = await call(app, 'POST', `/remote-hosts/${id}/agents/install-all`);
    expect(first.status).toBe(202);
    const second = await call(app, 'POST', `/remote-hosts/${id}/agents/install-all`);
    expect(second.status).toBe(409);
    h.settle();
    h.settle();
  });

  it('409s any single install on the host while a batch runs (C4: one installer at a time)', async () => {
    const h = batchHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_BATCH, 'batch-single');
    const first = await call(app, 'POST', `/remote-hosts/${id}/agents/install-all`);
    expect(first.status).toBe(202);
    // A batch-queued type…
    const queued = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/install`);
    expect(queued.status).toBe(409);
    expect(queued.json.error).toMatch(/batch running/);
    // …and an unrelated type both 409: npm -g must not run concurrently.
    const other = await call(app, 'POST', `/remote-hosts/${id}/agents/hermes/install`);
    expect(other.status).toBe(409);
    expect(other.json.error).toMatch(/batch running/);
    h.settle();
    h.settle();
  });

  it('failure isolation: a failed install does not stop the batch', async () => {
    const h = batchHub();
    const { app, db } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_BATCH, 'batch-fail');
    seedVersions(db, { codex: { latest: '2.0.0', checkedAt: 1 } });
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/install-all`);
    expect(r.json.targets).toEqual(['pi', 'codex']);

    // First item fails (non-zero exit); the batch still proceeds to codex.
    h.settle({ code: 1, tail: 'npm err fatal' });
    await vi.waitFor(() => expect(h.calls).toEqual(['pi', 'codex']));
    h.settle();
    let host: any;
    await vi.waitFor(async () => {
      host = await getHost(app, id);
      expect(host.installBatch).toBeUndefined();
    });
    expect(host.installs).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentType: 'pi', running: false, ok: false, tail: 'npm err fatal' }),
      expect.objectContaining({ agentType: 'codex', running: false, ok: true, tail: 'added codex' }),
    ]));
  });

  it('a host drop mid-batch marks the rest not attempted and stops', async () => {
    let up = true;
    const h = batchHub(() => up);
    const { app, db } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, AGENTS_BATCH, 'batch-drop');
    seedVersions(db, { codex: { latest: '2.0.0', checkedAt: 1 } });
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/install-all`);
    expect(r.status).toBe(202);
    up = false;
    h.settle();
    let host: any;
    await vi.waitFor(async () => {
      host = await getHost(app, id);
      expect(host.installBatch).toBeUndefined();
    });
    expect(host.installs).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentType: 'pi', running: false, ok: true }),
      expect.objectContaining({
        agentType: 'codex',
        running: false,
        ok: false,
        tail: 'not attempted — host disconnected',
      }),
    ]));
    expect(h.calls).toEqual(['pi']);
  });
});

describe('GET /remote-hosts behind decoration', () => {
  function decoHub() {
    return {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({})),
      isConnected: vi.fn(() => true),
      link: vi.fn(),
    };
  }

  it('annotates cached latest + behind; agents without a node version get latest only', async () => {
    const { app, db } = boot({ hub: decoHub().hub as never });
    const id = await trustedHost(app, {
      codex: { installed: true, allowed: true, installable: true, version: '1.0.0', methods: [] },
      hermes: { installed: true, allowed: true, installable: true, version: '2.0.0', methods: [] },
      pi: { installed: false, allowed: true, installable: true, methods: [] },
      opencode: { installed: true, allowed: true, installable: true, version: 'dev', methods: [] },
    }, 'deco-a');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_versions', ?)").run(JSON.stringify({
      codex: { latest: '2.0.0', checkedAt: 1 },
      hermes: { latest: '2.0.0', checkedAt: 1 },
      pi: { latest: '9.9.9', checkedAt: 1 },
      opencode: { latest: '2.0.0', checkedAt: 1 },
    }));
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host.hello.agents.codex).toMatchObject({ latestVersion: '2.0.0', behind: true });
    expect(host.hello.agents.hermes).toMatchObject({ latestVersion: '2.0.0', behind: false });
    expect(host.hello.agents.pi).toMatchObject({ latestVersion: '9.9.9' });
    expect(host.hello.agents.pi).not.toHaveProperty('behind');
    // Unparsable version stays unknown (absent), not collapsed to false.
    expect(host.hello.agents.opencode).toMatchObject({ latestVersion: '2.0.0' });
    expect(host.hello.agents.opencode).not.toHaveProperty('behind');
  });

  it('drops retired types from a stale node hello', async () => {
    const { app } = boot();
    const id = await trustedHost(app, {
      'claude-code': { installed: true, allowed: true, installable: true, methods: [] },
      openclaude: { installed: true, allowed: true, installable: true, methods: [] },
    }, 'stale-openclaude');
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host.hello.agents['claude-code']).toBeDefined();
    expect(host.hello.agents.openclaude).toBeUndefined();
  });
});

describe('POST /remote-hosts/:id/update', () => {
  const FROM_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const NEW_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  function updateHub(opts: { connected?: boolean } = {}) {
    const hub = {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({})),
      isConnected: vi.fn(() => opts.connected ?? true),
      link: vi.fn(() => ({
        request: async () => ({ started: true, fromSha: FROM_SHA }),
      })),
    };
    return { hub };
  }

  function hello(over: Partial<NodeHello> = {}): Partial<NodeHello> {
    return {
      hostname: 'node-a', os: 'linux', arch: 'x64',
      gitSha: FROM_SHA,
      features: ['node.selfUpdate'],
      sessions: [],
      ...over,
    };
  }

  async function trustedHost(app: express.Express, h: Partial<NodeHello>, name: string): Promise<string> {
    const created = await createHost(app, name);
    const en = await call(app, 'POST', '/node/enroll', {
      token: created.json.token,
      publicKey: ed25519SpkiB64(),
      hubOrigin: 'https://hub.example',
      hello: h,
    });
    await call(app, 'POST', `/remote-hosts/${en.json.hostId}/trust`);
    return en.json.hostId as string;
  }

  it('update 202 then reconnect with new sha → ok', async () => {
    const clock = makeClock();
    const h = updateHub();
    const { app, db } = boot({ hub: h.hub as never, now: clock.now });
    const id = await trustedHost(app, hello(), 'upd-ok');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(202);
    clock.advance(1);
    h.hub.connectedAt = vi.fn(() => clock.now());
    saveHello(db, id, {
      protocol: 1, gitSha: NEW_SHA, hostname: 'node-a', os: 'linux', arch: 'x64',
      homedir: '/h', roots: [], listenPort: 8788, agents: {}, models: {}, sessions: [],
      features: ['node.selfUpdate'],
    }, clock.now());
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host?.update).toMatchObject({ running: false, ok: true });
  });

  it('same sha → failed tail', async () => {
    const clock = makeClock();
    const h = updateHub();
    const { app, db } = boot({ hub: h.hub as never, now: clock.now });
    const id = await trustedHost(app, hello(), 'upd-same');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(202);
    clock.advance(1);
    h.hub.connectedAt = vi.fn(() => clock.now());
    saveHello(db, id, {
      protocol: 1, gitSha: FROM_SHA, hostname: 'node-a', os: 'linux', arch: 'x64',
      homedir: '/h', roots: [], listenPort: 8788, agents: {}, models: {}, sessions: [],
      features: ['node.selfUpdate'],
    }, clock.now());
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host?.update).toMatchObject({
      running: false,
      ok: false,
      tail: 'node restarted on the same commit — see ~/.config/tierwyn/node/update.log',
    });
  });

  it('no reconnect within 10 min → failed tail points at update.log', async () => {
    const clock = makeClock();
    const h = updateHub();
    const { app } = boot({ hub: h.hub as never, now: clock.now });
    const id = await trustedHost(app, hello(), 'upd-timeout');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(202);
    clock.advance(10 * 60_000);
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host?.update).toMatchObject({
      running: false,
      ok: false,
      tail: 'no reconnect within 10 min — see ~/.config/tierwyn/node/update.log',
    });
  });

  it('refresh lastSeenAt bump does not settle the update', async () => {
    const clock = makeClock();
    const h = updateHub();
    const { app, db } = boot({ hub: h.hub as never, now: clock.now });
    const id = await trustedHost(app, hello(), 'upd-refresh');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(202);
    clock.advance(1);
    saveHello(db, id, {
      protocol: 1, gitSha: NEW_SHA, hostname: 'node-a', os: 'linux', arch: 'x64',
      homedir: '/h', roots: [], listenPort: 8788, agents: {}, models: {}, sessions: [],
      features: ['node.selfUpdate'],
    }, clock.now());
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host?.update).toMatchObject({ running: true });
  });

  it('old node → 501', async () => {
    const h = updateHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, hello({ features: [] }), 'upd-old');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(501);
    expect(String(r.json.error)).toContain('this node predates self-update');
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('live session → 409', async () => {
    const h = updateHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await trustedHost(app, hello({ sessions: ['s1'] }), 'upd-live');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(409);
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('package host on manifest build → 200 upToDate, no RPC, no update state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-pkg-'));
    writeManifest(dir, FROM_SHA);
    const h = updateHub();
    const { app } = boot({ hub: h.hub as never, packageDir: dir });
    const id = await trustedHost(app, hello({ installSource: 'package', gitSha: FROM_SHA }), 'upd-pkg-current');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, upToDate: true });
    expect(h.hub.link).not.toHaveBeenCalled();
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host?.update).toBeUndefined();
  });

  it('package host on different build → 202 + RPC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-pkg-'));
    writeManifest(dir, NEW_SHA);
    const h = updateHub();
    const { app } = boot({ hub: h.hub as never, packageDir: dir });
    const id = await trustedHost(app, hello({ installSource: 'package', gitSha: FROM_SHA }), 'upd-pkg-behind');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(202);
    expect(h.hub.link).toHaveBeenCalled();
  });

  it('package host + no manifest → 503 package_unavailable, no RPC', async () => {
    const h = updateHub();
    const { app } = boot({ hub: h.hub as never, packageDir: join(tmpdir(), 'tierwyn-no-pkg-test') });
    const id = await trustedHost(app, hello({ installSource: 'package', gitSha: FROM_SHA }), 'upd-pkg-nomf');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('package_unavailable');
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('git host → RPC regardless of manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-pkg-'));
    writeManifest(dir, FROM_SHA);
    const h = updateHub();
    const { app } = boot({ hub: h.hub as never, packageDir: dir });
    const id = await trustedHost(app, hello({ gitSha: FROM_SHA }), 'upd-git-mf');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(202);
    expect(h.hub.link).toHaveBeenCalled();
  });

  it('old node without installSource treated as git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-pkg-'));
    writeManifest(dir, FROM_SHA);
    const h = updateHub();
    const { app } = boot({ hub: h.hub as never, packageDir: dir });
    const id = await trustedHost(app, hello({ gitSha: FROM_SHA, installSource: undefined }), 'upd-old-src');
    const r = await call(app, 'POST', `/remote-hosts/${id}/update`);
    expect(r.status).toBe(202);
    expect(h.hub.link).toHaveBeenCalled();
  });
});

describe('POST /remote-hosts one-liners', () => {
  it('oneLiner is hub form when a manifest exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-pkg-'));
    writeManifest(dir);
    const { app } = boot({ packageDir: dir });
    const created = await call(app, 'POST', '/remote-hosts', { name: 'hub-ol' }, { origin: 'https://hub.example' });
    const origin = 'https://hub.example';
    const token = created.json.token as string;
    expect(created.json.packageAvailable).toBe(true);
    expect(created.json.oneLiner).toBe(
      `curl -fsSL ${origin}/node/install.sh | bash -s -- node enroll --hub ${origin} --token ${token}`,
    );
    expect(created.json.oneLinerGithub).toContain('raw.githubusercontent');
    expect(created.json.oneLinerGithub).toContain(token);
    expect(created.json.insecureOrigin).toBe(false);
  });

  it('falls back to GitHub without a manifest; oneLinerGithub always uses raw.githubusercontent', async () => {
    const { app } = boot();
    const created = await call(app, 'POST', '/remote-hosts', { name: 'gh-ol' }, { origin: 'https://hub.example' });
    expect(created.json.packageAvailable).toBe(false);
    expect(created.json.oneLiner).toBe(created.json.oneLinerGithub);
    expect(created.json.oneLinerGithub).toContain('raw.githubusercontent.com/tierwyn/tierwyn/main/scripts/install.sh');
  });

  it('http origin sets insecureOrigin and does not add --allow-http', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-pkg-'));
    writeManifest(dir);
    const { app } = boot({ packageDir: dir });
    const created = await call(app, 'POST', '/remote-hosts', { name: 'http-ol' }, { origin: 'http://hub.example' });
    expect(created.json.insecureOrigin).toBe(true);
    expect(created.json.oneLiner).not.toContain('--allow-http');
    expect(created.json.oneLinerGithub).not.toContain('--allow-http');
    expect(created.json.oneLiner).toContain('http://hub.example/node/install.sh');
  });
});

describe('PATCH /remote-hosts/:id description', () => {
  it('trims a string description', async () => {
    const { app } = boot();
    const created = await createHost(app, 'desc-trim');
    const id = created.json.host.id as string;
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { description: '  rack 3  ' });
    expect(res.status).toBe(200);
    expect(res.json.host.description).toBe('rack 3');
  });

  it('whitespace-only description clears', async () => {
    const { app } = boot();
    const created = await createHost(app, 'desc-ws');
    const id = created.json.host.id as string;
    await call(app, 'PATCH', `/remote-hosts/${id}`, { description: 'kept' });
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { description: '   ' });
    expect(res.status).toBe(200);
    expect(res.json.host.description).toBeUndefined();
  });

  it('null description clears', async () => {
    const { app } = boot();
    const created = await createHost(app, 'desc-null');
    const id = created.json.host.id as string;
    await call(app, 'PATCH', `/remote-hosts/${id}`, { description: 'kept' });
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { description: null });
    expect(res.status).toBe(200);
    expect(res.json.host.description).toBeUndefined();
  });

  it('rejects descriptions over 500 characters', async () => {
    const { app } = boot();
    const created = await createHost(app, 'desc-long');
    const id = created.json.host.id as string;
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { description: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('description too long');
  });

  it('accepts a 500-character description', async () => {
    const { app } = boot();
    const created = await createHost(app, 'desc-500');
    const id = created.json.host.id as string;
    const value = 'x'.repeat(500);
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { description: value });
    expect(res.status).toBe(200);
    expect(res.json.host.description).toBe(value);
  });

  it('ignores a non-string description while applying other fields', async () => {
    const { app } = boot();
    const created = await createHost(app, 'desc-ignore');
    const id = created.json.host.id as string;
    await call(app, 'PATCH', `/remote-hosts/${id}`, { description: 'kept' });
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { description: 5, name: 'new' });
    expect(res.status).toBe(200);
    expect(res.json.host.name).toBe('new');
    expect(res.json.host.description).toBe('kept');
  });

  it('name-only PATCH keeps an existing description', async () => {
    const { app } = boot();
    const created = await createHost(app, 'desc-keep');
    const id = created.json.host.id as string;
    await call(app, 'PATCH', `/remote-hosts/${id}`, { description: 'rack 3' });
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { name: 'other' });
    expect(res.status).toBe(200);
    expect(res.json.host.name).toBe('other');
    expect(res.json.host.description).toBe('rack 3');
  });
});

describe('pushHost / broadcast', () => {
  it('POST .../refresh calls broadcast spy with host containing updated hello', async () => {
    const broadcast = vi.fn();
    const updatedHello = { hostname: 'node-updated', os: 'linux', arch: 'x64' };
    const hub = {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => updatedHello),
      isConnected: vi.fn(() => true),
    };
    const { app, db } = boot({ hub: hub as never, broadcast });
    const id = await trustedHost(app, {}, 'push-refresh');
    broadcast.mockClear();

    // Update hello in DB to simulate post-refresh hello
    saveHello(db, id, updatedHello, 123456);

    const res = await call(app, 'POST', `/remote-hosts/${id}/refresh`);
    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const pushedHost = broadcast.mock.calls[0][0];
    expect(pushedHost.id).toBe(id);
    expect(pushedHost.hello.hostname).toBe('node-updated');
  });

  it('pushHost("nonexistent-id") does not throw and does not call broadcast', () => {
    const broadcast = vi.fn();
    const { pushHost } = boot({ broadcast });
    expect(() => pushHost?.('nonexistent-id')).not.toThrow();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('broadcast function that throws does not propagate out of pushHost', async () => {
    const broadcast = vi.fn(() => {
      throw new Error('broadcast failure');
    });
    const { app, pushHost } = boot({ broadcast });
    const created = await createHost(app, 'throw-host');
    const id = created.json.host.id as string;
    expect(() => pushHost?.(id)).not.toThrow();
    expect(broadcast).toHaveBeenCalled();
  });

  it('install broadcasts running:true then running:false, both containing installs[]', async () => {
    // Pins: Review Focus item 2 — a connect frame mid-install must not erase the chip.
    const broadcasts: ReturnType<typeof disconnectedHostView>[] = [];
    const broadcast = vi.fn((h) => broadcasts.push(h));
    let resolveInstall!: () => void;
    const installDone = new Promise<void>((r) => { resolveInstall = r; });
    const hub = {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => {
        return { hostname: 'node-a', os: 'linux', arch: 'x64', agents: { pi: { installed: true, allowed: true, installable: true } } };
      }),
      isConnected: vi.fn(() => true),
      link: vi.fn(() => ({
        request: vi.fn(async () => {
          await installDone;
          return { code: 0, tail: 'ok' };
        }),
      })),
    };
    const { app } = boot({ hub: hub as never, broadcast });
    const id = await trustedHost(app, { pi: { installed: true, allowed: true, installable: true } }, 'install-broadcast');
    broadcast.mockClear();

    // Start install (async — doesn't wait for completion)
    const installPromise = call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    // Let the 202 come back
    const res = await installPromise;
    expect(res.status).toBe(202);

    // The running:true broadcast should have fired synchronously before the RPC awaits
    const runningBroadcast = broadcasts.find((h) => h.installs?.[0]?.running === true);
    expect(runningBroadcast).toBeDefined();
    expect(runningBroadcast?.installs?.[0]).toMatchObject({ agentType: 'pi', running: true });

    // Settle the install
    resolveInstall();
    // Wait for the post-install refresh + settled broadcast
    await vi.waitFor(() => {
      const settledBroadcast = broadcasts.find((h) => h.installs?.[0]?.running === false);
      expect(settledBroadcast).toBeDefined();
      expect(settledBroadcast?.installs?.[0]).toMatchObject({ agentType: 'pi', running: false, ok: true });
    });
  });

  it('pushHost during a running install still contains the installs[] array', async () => {
    // Pins: Review Focus item 2 — the decorated view seen by pushHost includes in-memory install state.
    const broadcasts: ReturnType<typeof disconnectedHostView>[] = [];
    const broadcast = vi.fn((h) => broadcasts.push(h));
    let resolveInstall!: () => void;
    const installDone = new Promise<void>((r) => { resolveInstall = r; });
    const hub = {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({ hostname: 'node-a', os: 'linux', arch: 'x64', agents: { pi: { installed: true, allowed: true, installable: true } } })),
      isConnected: vi.fn(() => true),
      link: vi.fn(() => ({
        request: vi.fn(async () => { await installDone; return { code: 0, tail: 'ok' }; }),
      })),
    };
    const { app, pushHost } = boot({ hub: hub as never, broadcast });
    const id = await trustedHost(app, { pi: { installed: true, allowed: true, installable: true } }, 'push-during-install');
    broadcast.mockClear();

    const res = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/install`);
    expect(res.status).toBe(202);

    // A reconnect would call pushHost — the view must still carry installs
    expect(pushHost).toBeDefined();
    broadcasts.length = 0;
    broadcast.mockClear();
    pushHost!(id);
    const mid = broadcasts[0];
    expect(mid?.installs?.[0]).toMatchObject({ agentType: 'pi', running: true });

    resolveInstall();
    await vi.waitFor(() => {
      const settled = broadcasts.find((h) => h.installs?.[0]?.running === false);
      expect(settled?.installs?.[0]).toMatchObject({ agentType: 'pi', running: false, ok: true });
    });
  });
});

describe('PATCH /remote-hosts/:id allowAgentEnvSecrets', () => {
  function envHub() {
    return {
      view: (row: RemoteHostRow) => disconnectedHostView(row),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({})),
      isConnected: vi.fn(() => true),
      syncAgentEnv: vi.fn(async () => {}),
    };
  }

  it('persists the toggle and surfaces false by default in views', async () => {
    const hub = envHub();
    const { app, db } = boot({ hub: hub as never });
    const id = await trustedHost(app, {}, 'env-toggle-a');
    const list0 = await call(app, 'GET', '/remote-hosts');
    expect(list0.json.hosts.find((x: { id: string }) => x.id === id).allowAgentEnvSecrets).toBe(false);

    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { allowAgentEnvSecrets: true });
    expect(res.status).toBe(200);
    expect(res.json.host.allowAgentEnvSecrets).toBe(true);
    const row = db.prepare('SELECT allow_agent_env_secrets FROM remote_hosts WHERE id = ?')
      .get(id) as { allow_agent_env_secrets: number };
    expect(row.allow_agent_env_secrets).toBe(1);
    const list = await call(app, 'GET', '/remote-hosts');
    expect(list.json.hosts.find((x: { id: string }) => x.id === id).allowAgentEnvSecrets).toBe(true);
  });

  it('flipping the toggle syncs the host then reaps parked sessions', async () => {
    const hub = envHub();
    const reap = vi.fn(async () => {});
    const { app } = boot({ hub: hub as never, reapParkedForHost: reap });
    const id = await trustedHost(app, {}, 'env-toggle-b');
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { allowAgentEnvSecrets: true });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(reap).toHaveBeenCalledWith(id));
    expect(hub.syncAgentEnv).toHaveBeenCalledWith(id);
    expect(hub.syncAgentEnv.mock.invocationCallOrder[0]).toBeLessThan(reap.mock.invocationCallOrder[0]);
  });

  it('a failed sync still reaps and does not fail the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hub = envHub();
    hub.syncAgentEnv = vi.fn(async () => { throw new Error('link down'); });
    const reap = vi.fn(async () => {});
    const { app } = boot({ hub: hub as never, reapParkedForHost: reap });
    const id = await trustedHost(app, {}, 'env-toggle-c');
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { allowAgentEnvSecrets: true });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(reap).toHaveBeenCalledWith(id));
    expect(warn.mock.calls.some((c) => c.map(String).join(' ').includes('link down'))).toBe(true);
    warn.mockRestore();
  });

  it('an unchanged value does not sync or reap', async () => {
    const hub = envHub();
    const reap = vi.fn(async () => {});
    const { app } = boot({ hub: hub as never, reapParkedForHost: reap });
    const id = await trustedHost(app, {}, 'env-toggle-d');
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { name: 'renamed' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.syncAgentEnv).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();

    // Same-value PATCH is not a flip either.
    const res2 = await call(app, 'PATCH', `/remote-hosts/${id}`, { allowAgentEnvSecrets: false });
    expect(res2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.syncAgentEnv).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();
  });

  it('a non-boolean value is ignored', async () => {
    const hub = envHub();
    const reap = vi.fn(async () => {});
    const { app } = boot({ hub: hub as never, reapParkedForHost: reap });
    const id = await trustedHost(app, {}, 'env-toggle-e');
    const res = await call(app, 'PATCH', `/remote-hosts/${id}`, { allowAgentEnvSecrets: 'yes', name: 'renamed-2' });
    expect(res.status).toBe(200);
    expect(res.json.host.allowAgentEnvSecrets).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.syncAgentEnv).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();
  });
});

describe('GET /remote-hosts delivered login badge', () => {
  const SECRET32 = '0123456789abcdef0123456789abcdef';

  function hello(over: Partial<NodeHello> = {}): Partial<NodeHello> {
    return {
      hostname: 'node-a', os: 'linux', arch: 'x64',
      features: ['agent_env'],
      agents: { 'claude-code': { installed: true, methods: [] } },
      ...over,
    };
  }

  async function trustedHelloHost(app: express.Express, h: Partial<NodeHello>, name: string): Promise<string> {
    const created = await createHost(app, name);
    const en = await call(app, 'POST', '/node/enroll', {
      token: created.json.token,
      publicKey: ed25519SpkiB64(),
      hubOrigin: 'https://hub.example',
      hello: h,
    });
    await call(app, 'POST', `/remote-hosts/${en.json.hostId}/trust`);
    return en.json.hostId as string;
  }

  function hostOf(listed: { json: any }, id: string) {
    return listed.json.hosts.find((x: { id: string }) => x.id === id);
  }

  it('GET /remote-hosts shows delivered login only when the toggle is on', async () => {
    initVaultKey({ sessionSecret: SECRET32 });
    const { app, db } = boot();
    vaultSet(db, AGENT_VAULT_ID, agentEnvVaultKey('claude-code', 'CLAUDE_CODE_OAUTH_TOKEN'), 'ghu_test');
    const id = await trustedHelloHost(app, hello(), 'login-badge-a');

    let listed = await call(app, 'GET', '/remote-hosts');
    expect(hostOf(listed, id).allowAgentEnvSecrets).toBe(false);
    expect(hostOf(listed, id).hello.agents['claude-code'].loggedIn).toBeUndefined();

    const patch = await call(app, 'PATCH', `/remote-hosts/${id}`, { allowAgentEnvSecrets: true });
    expect(patch.status).toBe(200);

    listed = await call(app, 'GET', '/remote-hosts');
    expect(hostOf(listed, id).allowAgentEnvSecrets).toBe(true);
    expect(hostOf(listed, id).hello.agents['claude-code'].loggedIn).toBe(true);
  });

  it('no delivered login while the vault is locked, even with the toggle on (A11)', async () => {
    initVaultKey({ sessionSecret: 'too-short' }); // lock the module-level vault
    const { app, db } = boot();
    // A row exists from an earlier unlock; nothing can be decrypted now, yet
    // listAgentEnvVars still lists it — viewed() must not hand it over.
    db.prepare(
      `INSERT INTO plugin_secrets (plugin_id, key, key_id, ciphertext, iv, tag, updated_at)
       VALUES (?, ?, 'sess:v1', x'00', x'000000000000000000000000', x'00000000000000000000000000000000', ?)`,
    ).run(AGENT_VAULT_ID, agentEnvVaultKey('claude-code', 'CLAUDE_CODE_OAUTH_TOKEN'), Date.now());
    const id = await trustedHelloHost(app, hello(), 'login-badge-b');
    await call(app, 'PATCH', `/remote-hosts/${id}`, { allowAgentEnvSecrets: true });

    const listed = await call(app, 'GET', '/remote-hosts');
    expect(hostOf(listed, id).hello.agents['claude-code'].loggedIn).toBeUndefined();
  });
});

describe('GET /remote-hosts login re-probe', () => {
  it('calls probeLoginStatus for a connected host', async () => {
    const probeLoginStatus = vi.fn(async () => {});
    const h = {
      view: (row: RemoteHostRow) => ({ ...disconnectedHostView(row), state: 'connected' as const }),
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({})),
      isConnected: vi.fn(() => true),
      link: vi.fn(() => ({ request: vi.fn(async () => ({})) })),
      probeLoginStatus,
    };
    const { app } = boot({ hub: h as never });
    const created = await createHost(app, 'probe-get');
    const en = await call(app, 'POST', '/node/enroll', {
      token: created.json.token,
      publicKey: ed25519SpkiB64(),
      hubOrigin: 'https://hub.example',
      hello: { hostname: 'box', features: ['agents.loginStatus'], agents: { codex: { installed: true, methods: [], loggedIn: true } } },
    });
    await call(app, 'POST', `/remote-hosts/${en.json.hostId}/trust`);
    const listed = await call(app, 'GET', '/remote-hosts');
    expect(listed.status).toBe(200);
    expect(probeLoginStatus).toHaveBeenCalledWith(en.json.hostId);
  });

  it('still lists hosts when the hub has no probeLoginStatus (old hub / tests)', async () => {
    const { app } = boot();
    const created = await createHost(app, 'probe-skip');
    const listed = await call(app, 'GET', '/remote-hosts');
    expect(listed.status).toBe(200);
    expect(listed.json.hosts.some((x: { id: string }) => x.id === created.json.host.id)).toBe(true);
  });
});

describe('POST /remote-hosts/:id/agents/:type/login', () => {
  const CODEX_OK = {
    hostname: 'node-a', os: 'linux', arch: 'x64',
    features: ['agents.login'],
    agents: { codex: { installed: true, allowed: true, methods: [] } },
  };
  const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code'
    + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=x'
    + '&code_challenge=abc&code_challenge_method=S256&state=st';
  const CLAUDE_OK = {
    hostname: 'node-a', os: 'linux', arch: 'x64',
    features: ['agents.login', 'agents.login.claude'],
    agents: { 'claude-code': { installed: true, allowed: true, loggedIn: false, methods: [] } },
  };
  const BOTH_OK = {
    hostname: 'node-a', os: 'linux', arch: 'x64',
    features: ['agents.login', 'agents.login.claude'],
    agents: {
      codex: { installed: true, allowed: true, methods: [] },
      'claude-code': { installed: true, allowed: true, loggedIn: false, methods: [] },
    },
  };
  const DEVICE = {
    agentType: 'codex' as const,
    phase: 'device' as const,
    url: 'https://auth.openai.com/codex/device',
    userCode: 'TAEF-M7I6R',
  };

  function loginHub(opts: { connected?: boolean } = {}) {
    const state = { connected: opts.connected ?? true };
    const request = vi.fn(async () => ({ started: true }));
    const hub = {
      view: (row: RemoteHostRow) => {
        const base = disconnectedHostView(row);
        return state.connected ? { ...base, state: 'connected' as const } : base;
      },
      disconnect: vi.fn(),
      refresh: vi.fn(async () => ({})),
      isConnected: vi.fn(() => state.connected),
      link: vi.fn(() => ({ request })),
    };
    return { hub, request, state };
  }

  async function enrollHello(app: express.Express, hello: Record<string, unknown>, name: string): Promise<string> {
    const created = await createHost(app, name);
    const en = await call(app, 'POST', '/node/enroll', {
      token: created.json.token,
      publicKey: ed25519SpkiB64(),
      hubOrigin: 'https://hub.example',
      hello,
    });
    await call(app, 'POST', `/remote-hosts/${en.json.hostId}/trust`);
    return en.json.hostId as string;
  }

  it('202 on connected host with feature + installed codex and view.login.running', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-ok');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, started: true });
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host?.logins).toEqual([expect.objectContaining({ agentType: 'codex', running: true })]);
  });

  it('409 without agents.login in hello', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, {
      ...CODEX_OK,
      features: ['agent_env'],
    }, 'login-old');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain('update the tierwyn node');
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('400 for type=pi', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-pi');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/pi/login`);
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain('codex');
  });

  it('409 when disconnected', async () => {
    const h = loginHub({ connected: false });
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-disc');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('host is not connected');
  });

  it('device event sets url and userCode on the view', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-device');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent(id, {
      agentType: 'codex',
      phase: 'device',
      url: 'https://auth.openai.com/codex/device',
      userCode: 'TAEF-M7I6R',
    });
    const list = await call(app, 'GET', '/remote-hosts');
    const host = list.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host?.logins).toEqual([expect.objectContaining({
      agentType: 'codex',
      running: true,
      url: 'https://auth.openai.com/codex/device',
      userCode: 'TAEF-M7I6R',
    })]);
  });

  it('done event clears login after refresh', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-done');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent(id, { agentType: 'codex', phase: 'done' });
    await vi.waitFor(async () => {
      const list = await call(app, 'GET', '/remote-hosts');
      const host = list.json.hosts.find((x: { id: string }) => x.id === id);
      expect(host?.logins).toBeUndefined();
    });
    expect(h.hub.refresh).toHaveBeenCalledWith(id);
  });

  it('done event without in-flight login still refreshes', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-done-stale');
    applyLoginEvent(id, { agentType: 'codex', phase: 'done' });
    expect(h.hub.refresh).toHaveBeenCalledWith(id);
  });

  async function hostRow(app: express.Express, id: string) {
    const list = await call(app, 'GET', '/remote-hosts');
    return list.json.hosts.find((x: { id: string }) => x.id === id);
  }

  async function hostLogin(app: express.Express, id: string, agentType?: string) {
    const host = await hostRow(app, id);
    const all: Array<{ agentType: string }> = host?.logins ?? [];
    if (agentType) return all.find((l) => l.agentType === agentType);
    return all.length <= 1 ? all[0] : all[0];
  }

  it('disconnect during login omits login from the view', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-drop');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    expect(await hostLogin(app, id)).toMatchObject({ running: true });
    h.state.connected = false;
    expect(await hostLogin(app, id)).toBeUndefined();
    h.state.connected = true;
    expect(await hostLogin(app, id)).toBeUndefined();
  });

  it('cancel on a disconnected host 409s and leaves no login after reconnect', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-cancel-disc');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    h.state.connected = false;
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login/cancel`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('host is not connected');
    h.state.connected = true;
    expect(await hostLogin(app, id)).toBeUndefined();
  });

  it('cancel on a connected host clears login', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-cancel-ok');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login/cancel`);
    expect(r.status).toBe(200);
    expect(h.request).toHaveBeenCalledWith('agents.login', { agentType: 'codex', op: 'cancel' }, 10_000);
    await vi.waitFor(async () => {
      expect(await hostLogin(app, id)).toBeUndefined();
    });
  });

  it('a start right after cancel survives the late cancel reply', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-restart-race');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    let reply!: (v: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise((r) => { reply = r as never; }) as never);
    const cancelled = call(app, 'POST', `/remote-hosts/${id}/agents/codex/login/cancel`);
    await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
    // The web chains start on the cancel response, so it must wait for the node.
    let settled = false;
    void cancelled.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    reply({ cancelled: true });
    expect((await cancelled).status).toBe(200);
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent!(id, DEVICE);
    expect(await hostLogin(app, id, 'codex')).toMatchObject({ running: true, userCode: DEVICE.userCode });
  });

  it('cancel still answers when the node RPC fails', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-cancel-rpc-fail');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    h.request.mockRejectedValueOnce(new Error('timeout'));
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login/cancel`);
    expect(r.status).toBe(200);
    expect(await hostLogin(app, id, 'codex')).toBeUndefined();
  });

  it('error event sets login.error', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-err');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent(id, { agentType: 'codex', phase: 'error', message: 'user denied' });
    expect(await hostLogin(app, id)).toMatchObject({
      agentType: 'codex',
      running: false,
      error: 'user denied',
    });
  });

  it('start RPC failure sets login.error', async () => {
    const h = loginHub();
    h.request.mockRejectedValueOnce(new RpcError('not_installed', 'codex'));
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-rpc-fail');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    expect(r.status).toBe(202);
    await vi.waitFor(async () => {
      expect(await hostLogin(app, id)).toMatchObject({ running: false, error: 'codex' });
    });
  });

  it('device event without a prior POST does not set login', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-no-post');
    applyLoginEvent(id, DEVICE);
    expect(await hostLogin(app, id)).toBeUndefined();
  });

  it('drops loginEvent with the wrong agentType', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-bad-type');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent(id, { ...DEVICE, agentType: 'pi' });
    expect(await hostLogin(app, id)).toEqual({ agentType: 'codex', running: true });
  });

  it('drops device event with a non-Codex url', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-bad-url');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent(id, { ...DEVICE, url: 'https://evil.example/codex/device' });
    expect(await hostLogin(app, id)).toEqual({ agentType: 'codex', running: true });
  });

  it('drops device event with a malformed userCode', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-bad-code');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent(id, { ...DEVICE, userCode: 'not a code' });
    expect(await hostLogin(app, id)).toEqual({ agentType: 'codex', running: true });
  });

  it('caps error message at 300 characters', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-long-err');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent(id, { agentType: 'codex', phase: 'error', message: 'x'.repeat(400) });
    expect(await hostLogin(app, id)).toMatchObject({ error: 'x'.repeat(300) });
  });

  it('error event with a non-string message falls back to a short string', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'login-arr-err');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent(id, { agentType: 'codex', phase: 'error', message: [{ a: 'xxxxx' }] } as never);
    const login = await hostLogin(app, id);
    expect(typeof login.error).toBe('string');
    expect(login.error.length).toBeLessThanOrEqual(300);
    expect(login.error).toBe('login failed');
  });

  it('202 and login is { agentType: claude-code, running: true }', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-login-ok');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    expect(r.status).toBe(202);
    expect(await hostLogin(app, id)).toEqual({ agentType: 'claude-code', running: true });
  });

  it('409 with only agents.login in features, message contains update the tierwyn node', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, { ...CLAUDE_OK, features: ['agents.login'] }, 'claude-old-node');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain('update the tierwyn node');
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('409 when loggedIn: true and when loggedIn is absent', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const ready = await enrollHello(app, {
      ...CLAUDE_OK,
      agents: { 'claude-code': { installed: true, allowed: true, loggedIn: true, methods: [] } },
    }, 'claude-already');
    const absent = await enrollHello(app, {
      ...CLAUDE_OK,
      agents: { 'claude-code': { installed: true, allowed: true, methods: [] } },
    }, 'claude-absent');
    for (const id of [ready, absent]) {
      const r = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('already logged in on this host');
    }
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('409 when a vault token was delivered', async () => {
    initVaultKey({ sessionSecret: '0123456789abcdef0123456789abcdef' });
    const h = loginHub();
    const { app, db } = boot({ hub: h.hub as never });
    vaultSet(db, AGENT_VAULT_ID, agentEnvVaultKey('claude-code', 'CLAUDE_CODE_OAUTH_TOKEN'), 'ghu_test');
    const id = await enrollHello(app, {
      ...CLAUDE_OK,
      features: ['agents.login', 'agents.login.claude', 'agent_env'],
    }, 'claude-vault');
    await call(app, 'PATCH', `/remote-hosts/${id}`, { allowAgentEnvSecrets: true });
    const listed = await call(app, 'GET', '/remote-hosts');
    const host = listed.json.hosts.find((x: { id: string }) => x.id === id);
    expect(host.hello.agents['claude-code'].loggedIn).toBe(true);
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    expect(r.status).toBe(409);
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('409 while a Codex login is running on the same host, and the reverse', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, BOTH_OK, 'login-busy');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    const busy = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    expect(busy.status).toBe(409);
    expect(busy.json.error).toBe('another login is running on this host');
    expect(await hostLogin(app, id)).toMatchObject({ agentType: 'codex', running: true });

    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login/cancel`);
    await vi.waitFor(async () => { expect(await hostLogin(app, id)).toBeUndefined(); });

    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    const reverse = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    expect(reverse.status).toBe(409);
    expect(await hostLogin(app, id)).toMatchObject({ agentType: 'claude-code', running: true });
  });

  it('login state is strictly per (host, agent): A then B does not inherit A', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, BOTH_OK, 'login-per-agent');

    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });

    const mid = await hostRow(app, id);
    expect(mid.login).toBeUndefined();
    expect(mid.logins.find((l: { agentType: string }) => l.agentType === 'claude-code')?.url).toBe(CLAUDE_URL);
    expect(mid.logins.find((l: { agentType: string }) => l.agentType === 'codex')).toBeUndefined();

    const busy = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    expect(busy.status).toBe(409);
    const still = await hostRow(app, id);
    expect(still.logins.find((l: { agentType: string }) => l.agentType === 'codex')).toBeUndefined();
    expect(still.logins.find((l: { agentType: string }) => l.agentType === 'claude-code')?.url).toBe(CLAUDE_URL);

    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/cancel`);
    await vi.waitFor(async () => {
      expect(await hostLogin(app, id, 'claude-code')).toBeUndefined();
    });

    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent!(id, DEVICE);
    const after = await hostRow(app, id);
    const codex = after.logins.find((l: { agentType: string }) => l.agentType === 'codex');
    expect(codex).toMatchObject({
      agentType: 'codex',
      running: true,
      url: DEVICE.url,
      userCode: DEVICE.userCode,
    });
    expect(after.logins.find((l: { agentType: string }) => l.agentType === 'claude-code')).toBeUndefined();
    expect(codex.url).not.toBe(CLAUDE_URL);
  });

  it('a valid authorize event sets url', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-auth-url');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    expect(await hostLogin(app, id)).toMatchObject({
      agentType: 'claude-code', running: true, url: CLAUDE_URL,
    });
  });

  it('authorize with a bad URL errors and cancels', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-bad-url');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: 'https://evil.example/oauth/authorize?x=1' });
    expect(await hostLogin(app, id)).toMatchObject({
      running: false,
      error: 'host returned an unexpected sign-in URL',
    });
    expect(h.request).toHaveBeenCalledWith('agents.login', { agentType: 'claude-code', op: 'cancel' }, 10_000);
  });

  it('the node cancelled event does not replace the bad-URL error', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-bad-url-echo');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: 'https://evil.example/oauth/authorize?x=1' });
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'error', message: 'cancelled' });
    expect(await hostLogin(app, id)).toMatchObject({
      running: false,
      error: 'host returned an unexpected sign-in URL',
    });
  });

  it('authorize with no in-flight login, or with an agent type that does not match, is dropped', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, BOTH_OK, 'claude-drop-auth');
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    expect(await hostLogin(app, id)).toBeUndefined();
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    expect(await hostLogin(app, id)).toEqual({ agentType: 'codex', running: true });
  });

  it('device for Claude and authorize for Codex are dropped', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, BOTH_OK, 'phase-mismatch');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'TAEF-M7I6R' });
    expect(await hostLogin(app, id)).toEqual({ agentType: 'claude-code', running: true });
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/cancel`);
    await vi.waitFor(async () => { expect(await hostLogin(app, id)).toBeUndefined(); });
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent!(id, { agentType: 'codex', phase: 'authorize', url: CLAUDE_URL });
    expect(await hostLogin(app, id)).toEqual({ agentType: 'codex', running: true });
  });

  it('error with a non-string message falls back and does not throw', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-arr-err');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    expect(() => applyLoginEvent!(id, { agentType: 'claude-code', phase: 'error', message: [{ a: 'xxxxx' }] } as never)).not.toThrow();
    expect(await hostLogin(app, id)).toMatchObject({ error: 'login failed', running: false });
  });

  it('done with no in-flight login still calls hub.refresh', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-done-stale');
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'done' });
    expect(h.hub.refresh).toHaveBeenCalledWith(id);
  });

  it('done for Claude while Codex is in flight refreshes and leaves the Codex state', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, BOTH_OK, 'done-other');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'done' });
    expect(h.hub.refresh).toHaveBeenCalledWith(id);
    await vi.waitFor(async () => {
      expect(h.hub.refresh).toHaveBeenCalled();
    });
    expect(await hostLogin(app, id)).toMatchObject({ agentType: 'codex', running: true });
  });

  it('POST login/code 200 submits and sets codeSubmitted without echoing the code', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-code-ok');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(h.request).toHaveBeenCalledWith('agents.login', { agentType: 'claude-code', op: 'submit', code: 'abc#st' }, 10_000);
    const login = await hostLogin(app, id);
    expect(login).toMatchObject({ codeSubmitted: true });
    const listed = await call(app, 'GET', '/remote-hosts');
    expect(JSON.stringify(listed.json)).not.toContain('abc#st');
  });

  it('surrounding whitespace is trimmed before validation', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-code-trim');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: '  abc#st  ' });
    expect(r.status).toBe(200);
    expect(h.request).toHaveBeenCalledWith('agents.login', { agentType: 'claude-code', op: 'submit', code: 'abc#st' }, 10_000);
  });

  it('400 for malformed or non-string codes, response does not echo the input, no RPC', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-code-bad');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    h.request.mockClear();
    for (const body of [{ code: 'a b#c' }, { code: 123 }, { code: 'a#b\nc#d' }]) {
      const r = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, body);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('invalid sign-in code');
      expect(JSON.stringify(r.json)).not.toContain('a b#c');
      expect(JSON.stringify(r.json)).not.toContain('a#b');
    }
    expect(h.request).not.toHaveBeenCalled();
  });

  it('400 for codex', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CODEX_OK, 'codex-no-code');
    await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login`);
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login/code`, { code: 'abc#st' });
    expect(r.status).toBe(400);
    expect(h.request).not.toHaveBeenCalledWith('agents.login', expect.objectContaining({ op: 'submit' }), expect.anything());
  });

  it('409 not connected; no login; before url; once codeSubmitted; after error', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-code-409s');
    h.state.connected = false;
    expect((await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' })).status).toBe(409);
    h.state.connected = true;
    expect((await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' })).status).toBe(409);
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    expect((await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' })).status).toBe(409);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    expect((await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' })).status).toBe(200);
    expect((await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' })).status).toBe(409);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'error', message: 'nope' });
    expect((await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' })).status).toBe(409);
  });

  it('RPC reject → 502, codeSubmitted cleared so a retry works', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CLAUDE_OK, 'claude-code-502');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    applyLoginEvent!(id, { agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    h.request.mockRejectedValueOnce(new Error('boom'));
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('could not deliver the code to the host');
    expect(await hostLogin(app, id)).toMatchObject({ codeSubmitted: false, running: true });
    const retry = await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login/code`, { code: 'abc#st' });
    expect(retry.status).toBe(200);
  });

  it('cancel naming a different agent keeps the hub state', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, BOTH_OK, 'cancel-other');
    await call(app, 'POST', `/remote-hosts/${id}/agents/claude-code/login`);
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/codex/login/cancel`);
    expect(r.status).toBe(200);
    expect(await hostLogin(app, id)).toMatchObject({ agentType: 'claude-code', running: true });
  });

  const COPILOT_OK = {
    hostname: 'node-a', os: 'linux', arch: 'x64',
    features: ['agents.login.copilot'],
    agents: { copilot: { installed: true, allowed: true, loggedIn: false, methods: [] } },
  };
  const GROK_OK = {
    hostname: 'node-a', os: 'linux', arch: 'x64',
    features: ['agents.login.grok'],
    agents: { 'grok-build': { installed: true, allowed: true, loggedIn: false, methods: [] } },
  };
  const COPILOT_DEVICE = {
    agentType: 'copilot' as const,
    phase: 'device' as const,
    url: 'https://github.com/login/device',
    userCode: 'XXXX-XXXX',
  };

  it('202 for copilot when the node advertises agents.login.copilot', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, COPILOT_OK, 'copilot-login-ok');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/copilot/login`);
    expect(r.status).toBe(202);
    expect(await hostLogin(app, id)).toEqual({ agentType: 'copilot', running: true });
  });

  it('409 for copilot on an old node without agents.login.copilot', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, { ...COPILOT_OK, features: ['agents.login'] }, 'copilot-old-node');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/copilot/login`);
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain('update the tierwyn node');
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('409 for grok-build on an old node without agents.login.grok', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, { ...GROK_OK, features: ['agents.login'] }, 'grok-old-node');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/grok-build/login`);
    expect(r.status).toBe(409);
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('copilot already logged in (true) is 409; unknown loggedIn is allowed', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const ready = await enrollHello(app, {
      ...COPILOT_OK,
      agents: { copilot: { installed: true, allowed: true, loggedIn: true, methods: [] } },
    }, 'copilot-already');
    const unknown = await enrollHello(app, {
      ...COPILOT_OK,
      agents: { copilot: { installed: true, allowed: true, methods: [] } },
    }, 'copilot-unknown');
    expect((await call(app, 'POST', `/remote-hosts/${ready}/agents/copilot/login`)).status).toBe(409);
    expect((await call(app, 'POST', `/remote-hosts/${unknown}/agents/copilot/login`)).status).toBe(202);
  });

  it('copilot device event sets url and userCode', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, COPILOT_OK, 'copilot-device');
    await call(app, 'POST', `/remote-hosts/${id}/agents/copilot/login`);
    applyLoginEvent!(id, COPILOT_DEVICE);
    expect(await hostLogin(app, id)).toMatchObject({
      agentType: 'copilot',
      running: true,
      url: COPILOT_DEVICE.url,
      userCode: COPILOT_DEVICE.userCode,
    });
  });

  it('copilot device with a wrong host errors and cancels', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, COPILOT_OK, 'copilot-bad-url');
    await call(app, 'POST', `/remote-hosts/${id}/agents/copilot/login`);
    applyLoginEvent!(id, { ...COPILOT_DEVICE, url: 'https://evil.example/login/device' });
    expect(await hostLogin(app, id)).toMatchObject({
      running: false,
      error: 'host returned an unexpected sign-in URL',
    });
    expect(h.request).toHaveBeenCalledWith('agents.login', { agentType: 'copilot', op: 'cancel' }, 10_000);
  });

  it('grok device with duplicate user_code errors and cancels', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, GROK_OK, 'grok-dup-param');
    await call(app, 'POST', `/remote-hosts/${id}/agents/grok-build/login`);
    applyLoginEvent!(id, {
      agentType: 'grok-build',
      phase: 'device',
      url: 'https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX&user_code=YYYY-YYYY',
      userCode: 'XXXX-XXXX',
    });
    expect(await hostLogin(app, id)).toMatchObject({
      running: false,
      error: 'host returned an unexpected sign-in URL',
    });
    expect(h.request).toHaveBeenCalledWith('agents.login', { agentType: 'grok-build', op: 'cancel' }, 10_000);
  });

  it('copilot device with extra query or fragment errors and cancels', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const extra = await enrollHello(app, COPILOT_OK, 'copilot-extra-key');
    await call(app, 'POST', `/remote-hosts/${extra}/agents/copilot/login`);
    applyLoginEvent!(extra, { ...COPILOT_DEVICE, url: `${COPILOT_DEVICE.url}?next=1` });
    expect(await hostLogin(app, extra)).toMatchObject({
      running: false,
      error: 'host returned an unexpected sign-in URL',
    });
    const frag = await enrollHello(app, COPILOT_OK, 'copilot-fragment');
    await call(app, 'POST', `/remote-hosts/${frag}/agents/copilot/login`);
    applyLoginEvent!(frag, { ...COPILOT_DEVICE, url: `${COPILOT_DEVICE.url}#frag` });
    expect(await hostLogin(app, frag)).toMatchObject({
      running: false,
      error: 'host returned an unexpected sign-in URL',
    });
  });

  it('copilot device with no in-flight login, or after cancel, is dropped', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, COPILOT_OK, 'copilot-drop-device');
    applyLoginEvent!(id, COPILOT_DEVICE);
    expect(await hostLogin(app, id)).toBeUndefined();
    await call(app, 'POST', `/remote-hosts/${id}/agents/copilot/login`);
    await call(app, 'POST', `/remote-hosts/${id}/agents/copilot/login/cancel`);
    await vi.waitFor(async () => { expect(await hostLogin(app, id)).toBeUndefined(); });
    applyLoginEvent!(id, COPILOT_DEVICE);
    expect(await hostLogin(app, id)).toBeUndefined();
  });

  const CURSOR_CHALLENGE = 'A'.repeat(43);
  const CURSOR_UUID = '00000000-0000-4000-8000-000000000000';
  const CURSOR_URL = `https://cursor.com/loginDeepControl?challenge=${CURSOR_CHALLENGE}&uuid=${CURSOR_UUID}&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true`;
  const CURSOR_OK = {
    hostname: 'node-a', os: 'linux', arch: 'x64',
    features: ['agents.login.cursor'],
    agents: { cursor: { installed: true, allowed: true, loggedIn: false, methods: [] } },
  };
  const CURSOR_AUTH = {
    agentType: 'cursor' as const,
    phase: 'authorize' as const,
    url: CURSOR_URL,
  };

  it('202 for cursor when the node advertises agents.login.cursor', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CURSOR_OK, 'cursor-login-ok');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/cursor/login`);
    expect(r.status).toBe(202);
    expect(await hostLogin(app, id)).toEqual({ agentType: 'cursor', running: true });
  });

  it('409 for cursor on an old node without agents.login.cursor', async () => {
    const h = loginHub();
    const { app } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, { ...CURSOR_OK, features: ['agents.login'] }, 'cursor-old-node');
    const r = await call(app, 'POST', `/remote-hosts/${id}/agents/cursor/login`);
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain('update the tierwyn node');
    expect(h.hub.link).not.toHaveBeenCalled();
  });

  it('cursor authorize event sets url and no userCode', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CURSOR_OK, 'cursor-authorize');
    await call(app, 'POST', `/remote-hosts/${id}/agents/cursor/login`);
    applyLoginEvent!(id, CURSOR_AUTH);
    const login = await hostLogin(app, id);
    expect(login).toMatchObject({
      agentType: 'cursor',
      running: true,
      url: CURSOR_URL,
    });
    expect(login).not.toHaveProperty('userCode');
  });

  it('cursor authorize with a wrong host errors and cancels', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CURSOR_OK, 'cursor-bad-url');
    await call(app, 'POST', `/remote-hosts/${id}/agents/cursor/login`);
    applyLoginEvent!(id, { ...CURSOR_AUTH, url: `https://evil.example/loginDeepControl?challenge=${CURSOR_CHALLENGE}&uuid=${CURSOR_UUID}` });
    expect(await hostLogin(app, id)).toMatchObject({
      running: false,
      error: 'host returned an unexpected sign-in URL',
    });
    expect(h.request).toHaveBeenCalledWith('agents.login', { agentType: 'cursor', op: 'cancel' }, 10_000);
  });

  it('cursor authorize with a userCode is rejected and cancels', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CURSOR_OK, 'cursor-with-code');
    await call(app, 'POST', `/remote-hosts/${id}/agents/cursor/login`);
    applyLoginEvent!(id, { ...CURSOR_AUTH, userCode: 'XXXX-XXXX' });
    expect(await hostLogin(app, id)).toMatchObject({
      running: false,
      error: 'host returned an unexpected sign-in URL',
    });
    expect(h.request).toHaveBeenCalledWith('agents.login', { agentType: 'cursor', op: 'cancel' }, 10_000);
  });

  it('late cursor authorize does not revive a settled login', async () => {
    const h = loginHub();
    const { app, applyLoginEvent } = boot({ hub: h.hub as never });
    const id = await enrollHello(app, CURSOR_OK, 'cursor-late');
    await call(app, 'POST', `/remote-hosts/${id}/agents/cursor/login`);
    applyLoginEvent!(id, { agentType: 'cursor', phase: 'error', message: 'user denied' });
    applyLoginEvent!(id, CURSOR_AUTH);
    expect(await hostLogin(app, id)).toMatchObject({
      running: false,
      error: 'user denied',
    });
  });
});
