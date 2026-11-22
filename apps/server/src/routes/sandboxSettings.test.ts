import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { getSandboxSettings, putSandboxSettings, pruneSandboxHost } from '../repositories/sandboxSettings.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { registerSandboxSettingsRoutes } from './sandboxSettings.js';
import { requireAuth } from '../auth/middleware.js';

let server: Server;
let base: string;
const mockReap = vi.fn();
const mockActive = vi.fn((): Array<{ conversationId: string; agentType: string }> => []);

beforeEach(async () => {
  mockReap.mockReset();
  mockActive.mockReset();
  mockActive.mockReturnValue([]);
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  seedCatalogue(db);
  setDb(db);

  const app = express();
  app.use(express.json());
  registerSandboxSettingsRoutes(app, {
    getDb,
    sessionManager: {
      activeSessions: () => mockActive(),
      reapParkedSessions: mockReap,
    },
  });

  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('GET/POST /settings/sandbox', () => {
  it('returns the default document', async () => {
    const res = await fetch(`${base}/settings/sandbox`);
    expect(res.status).toBe(200);
    const body = await res.json() as { settings: { global: boolean; defaults: unknown[]; hostPaths: object } };
    expect(body.settings).toEqual({ global: false, defaults: [], hostPaths: {} });
  });

  it('persists global and defaults', async () => {
    const res = await fetch(`${base}/settings/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        global: true,
        defaults: [{ hostId: '*', agentType: 'opencode', setting: 'on' }],
        hostPaths: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { settings: { global: boolean } };
    expect(body.settings.global).toBe(true);
    expect(getSandboxSettings(getDb()).defaults).toEqual([
      { hostId: '*', agentType: 'opencode', setting: 'on' },
    ]);
  });

  it('400s the fleet-wide (* × *) default because that cell is the global toggle', async () => {
    const res = await fetch(`${base}/settings/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        global: true,
        defaults: [{ hostId: '*', agentType: '*', setting: 'on' }],
        hostPaths: {},
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/\* × \*|global default/i);
    expect(getSandboxSettings(getDb()).defaults).toEqual([]);
  });

  it('400s unknown hostId and unknown agentType', async () => {
    const badHost = await fetch(`${base}/settings/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        global: false,
        defaults: [{ hostId: 'no-such-host', agentType: '*', setting: 'on' }],
        hostPaths: {},
      }),
    });
    expect(badHost.status).toBe(400);
    expect((await badHost.json() as { error: string }).error).toMatch(/unknown hostId/);

    const badAgent = await fetch(`${base}/settings/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        global: false,
        defaults: [{ hostId: 'hub', agentType: 'not-an-agent', setting: 'off' }],
        hostPaths: {},
      }),
    });
    expect(badAgent.status).toBe(400);
    expect((await badAgent.json() as { error: string }).error).toMatch(/unknown agentType/);
  });

  it('401 without a cookie when requireAuth is configured', async () => {
    const app = express();
    app.use(express.json());
    app.use(requireAuth({
      disabled: false,
      configured: true,
      sessionSecret: 'unit-test-session-secret-value-32bytes',
      passwordHash: 'not-used',
      cookieSecure: false,
    }));
    registerSandboxSettingsRoutes(app, { getDb });
    const authed = app.listen(0);
    const port = (authed.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/settings/sandbox`);
      expect(r.status).toBe(401);
    } finally {
      await new Promise<void>((r) => authed.close(() => r()));
    }
  });

  it('reaps parked sessions on a settings flip and does not stop live turns', async () => {
    const db = getDb();
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });
    mockActive.mockReturnValue([{ conversationId: conv.id, agentType: 'claude-code' }]);

    const res = await fetch(`${base}/settings/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ global: true, defaults: [], hostPaths: {} }),
    });
    expect(res.status).toBe(200);
    expect(mockReap).toHaveBeenCalledWith(conv.id, { all: true });
  });

  it('index.ts mounts sandbox settings after requireAuth', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), '../index.ts');
    const src = readFileSync(indexPath, 'utf8');
    const authIdx = src.indexOf('app.use(requireAuth(authConfig))');
    const routeIdx = src.indexOf('registerSandboxSettingsRoutes(app');
    expect(authIdx).toBeGreaterThan(-1);
    expect(routeIdx).toBeGreaterThan(authIdx);
  });
});

describe('pruneSandboxHost', () => {
  it('drops defaults and hostPaths for a deleted host', () => {
    const db = getDb();
    const host = createPendingHost(db, 'vm', 'hash', Date.now() + 60_000);
    putSandboxSettings(db, {
      global: true,
      defaults: [
        { hostId: host.id, agentType: '*', setting: 'off' },
        { hostId: '*', agentType: 'opencode', setting: 'on' },
      ],
      hostPaths: { [host.id]: [{ path: '/opt/models', mode: 'ro' }], hub: [{ path: '/srv/x', mode: 'ro' }] },
    });
    pruneSandboxHost(db, host.id);
    const s = getSandboxSettings(db);
    expect(s.defaults).toEqual([{ hostId: '*', agentType: 'opencode', setting: 'on' }]);
    expect(s.hostPaths[host.id]).toBeUndefined();
    expect(s.hostPaths.hub).toEqual([{ path: '/srv/x', mode: 'ro' }]);
  });
});

describe('POST /sandbox/validate-paths', () => {
  it('returns ok, missing, and denied for hub paths', async () => {
    const res = await fetch(`${base}/sandbox/validate-paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostId: 'hub',
        paths: [
          { path: '/usr', mode: 'ro' },
          { path: '/no-such-tierwyn-sandbox-e3', mode: 'ro' },
          { path: '/', mode: 'ro' },
          { path: '/etc/shadow', mode: 'ro' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { paths: Array<{ path: string; status: string; reason?: string }> };
    const byPath = Object.fromEntries(body.paths.map((p) => [p.path, p]));
    expect(byPath['/usr']?.status).toBe('ok');
    expect(byPath['/no-such-tierwyn-sandbox-e3']?.status).toBe('missing');
    expect(byPath['/']?.status).toBe('denied');
    expect(byPath['/etc/shadow']?.status).toBe('denied');
  });

  it('400s unknown hostId and invalid paths', async () => {
    const badHost = await fetch(`${base}/sandbox/validate-paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: 'nope', paths: [] }),
    });
    expect(badHost.status).toBe(400);

    const badPaths = await fetch(`${base}/sandbox/validate-paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: 'hub', paths: [{ path: 'relative', mode: 'ro' }] }),
    });
    expect(badPaths.status).toBe(400);
  });

  it('401 without a cookie when requireAuth is configured', async () => {
    const app = express();
    app.use(express.json());
    app.use(requireAuth({
      disabled: false,
      configured: true,
      sessionSecret: 'unit-test-session-secret-value-32bytes',
      passwordHash: 'not-used',
      cookieSecure: false,
    }));
    registerSandboxSettingsRoutes(app, { getDb });
    const authed = app.listen(0);
    const port = (authed.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/sandbox/validate-paths`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId: 'hub', paths: [] }),
      });
      expect(r.status).toBe(401);
    } finally {
      await new Promise<void>((r) => authed.close(() => r()));
    }
  });

  it('index.ts mounts sandbox settings after requireAuth and the validate-paths route exists', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const indexSrc = readFileSync(join(dir, '../index.ts'), 'utf8');
    const routeSrc = readFileSync(join(dir, './sandboxSettings.ts'), 'utf8');
    const authIdx = indexSrc.indexOf('app.use(requireAuth(authConfig))');
    const routeIdx = indexSrc.indexOf('registerSandboxSettingsRoutes(app');
    expect(authIdx).toBeGreaterThan(-1);
    expect(routeIdx).toBeGreaterThan(authIdx);
    expect(routeSrc).toContain('/sandbox/validate-paths');
    expect(indexSrc).toMatch(/sandboxPaths:\s*o\.sandboxPaths/);
    expect(indexSrc).toMatch(/request<\{ exists\?: boolean \}>\('fs\.statPath'/);
  });

  it('remote host uses lexical deny and injected existence', async () => {
    const db = getDb();
    const host = createPendingHost(db, 'vm', 'hash', Date.now() + 60_000);
    db.prepare("UPDATE remote_hosts SET status = 'trusted', hello = ? WHERE id = ?").run(
      JSON.stringify({ homedir: '/home/n', roots: ['/work'] }),
      host.id,
    );
    const remoteStat = vi.fn(async (_id: string, p: string) => (
      p === '/work/models' ? { exists: true } : { exists: false }
    ));
    const app = express();
    app.use(express.json());
    registerSandboxSettingsRoutes(app, { getDb, remoteStat });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sandbox/validate-paths`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostId: host.id,
          paths: [
            { path: '/work/models', mode: 'ro' },
            { path: '/work/missing', mode: 'ro' },
            { path: '/home/n/.ssh', mode: 'ro' },
            { path: '/srv/outside', mode: 'rw' },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { paths: Array<{ path: string; status: string }> };
      const byPath = Object.fromEntries(body.paths.map((p) => [p.path, p.status]));
      expect(byPath['/work/models']).toBe('ok');
      expect(byPath['/work/missing']).toBe('missing');
      expect(byPath['/home/n/.ssh']).toBe('denied');
      expect(byPath['/srv/outside']).toBe('denied');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('GET /conversations/:id/sandbox', () => {
  it('returns resolved + chain for a fresh conversation', async () => {
    const { registerConversationMutationRoutes } = await import('./conversations.js');
    const db = getDb();
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });
    const app = express();
    app.use(express.json());
    registerConversationMutationRoutes(app, { getDb });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/conversations/${conv.id}/sandbox`);
      expect(res.status).toBe(200);
      const body = await res.json() as { resolved: { on: boolean; source: string }; chain: unknown[]; paths: unknown[] };
      expect(body.resolved).toMatchObject({ on: false, source: 'global' });
      expect(Array.isArray(body.chain)).toBe(true);
      expect(body.paths).toEqual([]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

