import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, getProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost, setRemoteHostStatus } from '../repositories/remoteHosts.js';
import { ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';
import { registerProjectMutationRoutes } from './projects.js';
import { RpcError } from '../node/rpc.js';
import type { fsClone } from '../node/clone.js';

type StatPath = { exists: boolean; isDir: boolean; isGitRepo: boolean; underRoots: boolean };

function stubHub(opts: {
  connected?: Iterable<string>;
  stat?: StatPath | ((path: string) => StatPath);
  throwOnRequest?: boolean;
} = {}) {
  const connected = new Set(opts.connected ?? []);
  const calls: { method: string; payload: unknown }[] = [];
  const hub = {
    isConnected: (id: string) => connected.has(id),
    view: (row: { id: string }) => ({ state: connected.has(row.id) ? 'connected' as const : 'disconnected' as const }),
    link: (_id: string) => ({
      request: async (method: string, payload?: unknown) => {
        calls.push({ method, payload });
        if (opts.throwOnRequest) throw new Error('link down');
        const stat = typeof opts.stat === 'function'
          ? opts.stat((payload as { path: string }).path)
          : (opts.stat ?? { exists: true, isDir: true, isGitRepo: true, underRoots: true });
        return stat;
      },
    }),
  };
  return { hub, calls };
}

function boot(
  hub?: ReturnType<typeof stubHub>['hub'],
  opts?: {
    localClone?: typeof fsClone;
    hubRoots?: () => string[];
    sessions?: {
      activeSessions(): Array<{ id: string; conversationId: string; lastStatus?: any; steerQueue: unknown[] }>;
      reapParkedSessions(conversationId: string, opts?: { all?: boolean }): Promise<void>;
    };
  },
) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  registerProjectMutationRoutes(app, () => db, hub, opts);
  const project = createProject(db, { name: 'Tierwyn', rootPath: '/home/x/Projects/Tierwyn' });
  return { db, app, project };
}

function trustedHost(db: Database, name = 'box') {
  const host = createPendingHost(db, name, `tok-${name}`, Date.now() + 60_000);
  setRemoteHostStatus(db, host.id, 'trusted');
  return host;
}

/** JSON against an ephemeral listener; returns status + parsed body. */
function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
        .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

function patch(app: express.Express, path: string, body: unknown) {
  return request(app, 'PATCH', path, body);
}

describe('PATCH /projects/:id', () => {
  it('renames the project and returns the updated row', async () => {
    const { db, app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { name: 'Tierwyn Prod' });
    expect(res.status).toBe(200);
    expect(res.json.project.name).toBe('Tierwyn Prod');
    expect(res.json.project.id).toBe(project.id);
    expect(getProject(db, project.id)?.name).toBe('Tierwyn Prod');
  });

  it('trims surrounding whitespace before saving', async () => {
    const { db, app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { name: '  Spaced Out  ' });
    expect(res.status).toBe(200);
    expect(res.json.project.name).toBe('Spaced Out');
    expect(getProject(db, project.id)?.name).toBe('Spaced Out');
  });

  it('400s an empty or whitespace-only name and leaves the row alone', async () => {
    const { db, app, project } = boot();
    for (const name of ['', '   ']) {
      const res = await patch(app, `/projects/${project.id}`, { name });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('name required');
    }
    expect(getProject(db, project.id)?.name).toBe('Tierwyn');
  });

  it('400s a non-string name', async () => {
    const { app, project } = boot();
    for (const body of [{ name: 42 }, { name: null }, { name: ['a'] }]) {
      const res = await patch(app, `/projects/${project.id}`, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('name required');
    }
  });

  it('400s a name longer than 200 characters after trimming', async () => {
    const { app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { name: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('name too long (max 200)');

    const ok = await patch(app, `/projects/${project.id}`, { name: 'y'.repeat(200) });
    expect(ok.status).toBe(200);
  });

  it('404s an unknown project id', async () => {
    const { app } = boot();
    const res = await patch(app, '/projects/does-not-exist', { name: 'Ghost' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('no such project');
  });

  it('validates and persists sandbox', async () => {
    const { db, app, project } = boot();
    const bad = await patch(app, `/projects/${project.id}`, { sandbox: 'bogus' });
    expect(bad.status).toBe(400);
    const ok = await patch(app, `/projects/${project.id}`, { sandbox: 'off' });
    expect(ok.status).toBe(200);
    expect(getProject(db, project.id)?.sandbox).toBe('off');
  });

  it('validates and persists sandboxPaths', async () => {
    const { db, app, project } = boot();
    const bad = await patch(app, `/projects/${project.id}`, { sandboxPaths: [{ path: '/opt/x' }] });
    expect(bad.status).toBe(400);
    const ok = await patch(app, `/projects/${project.id}`, {
      sandboxPaths: [{ path: '/opt/models', mode: 'ro' }],
    });
    expect(ok.status).toBe(200);
    expect(getProject(db, project.id)?.sandboxPaths).toEqual([{ path: '/opt/models', mode: 'ro' }]);
    const cleared = await patch(app, `/projects/${project.id}`, { sandboxPaths: null });
    expect(cleared.status).toBe(200);
    expect(getProject(db, project.id)?.sandboxPaths).toBeUndefined();
  });

  it('validates and persists agentSearchScope; null omits the key', async () => {
    const { db, app, project } = boot();
    const bad = await patch(app, `/projects/${project.id}`, { agentSearchScope: 'global' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('agentSearchScope must be "off", "project", "all" or null');

    const ok = await patch(app, `/projects/${project.id}`, { agentSearchScope: 'all' });
    expect(ok.status).toBe(200);
    expect(ok.json.project.agentSearchScope).toBe('all');
    expect(getProject(db, project.id)?.agentSearchScope).toBe('all');

    const cleared = await patch(app, `/projects/${project.id}`, { agentSearchScope: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.project).not.toHaveProperty('agentSearchScope');
    expect(getProject(db, project.id)?.agentSearchScope).toBeUndefined();
  });

  it('409s agentSearchScope on a system project', async () => {
    const { db, app } = boot();
    ensureRemoteAgentsProject(db);
    const res = await patch(app, `/projects/${REMOTE_AGENTS_PROJECT_ID}`, { agentSearchScope: 'all' });
    expect(res.status).toBe(409);
  });

  it('updates rootPath when it is an existing absolute directory', async () => {
    const { db, app, project } = boot();
    const rootPath = mkdtempSync(join(tmpdir(), 'tierwyn-proj-'));
    const res = await patch(app, `/projects/${project.id}`, { rootPath });
    expect(res.status).toBe(200);
    expect(res.json.project.rootPath).toBe(rootPath);
    expect(res.json.project.name).toBe('Tierwyn');
    expect(getProject(db, project.id)?.rootPath).toBe(rootPath);
  });

  it('updates name and rootPath together', async () => {
    const { db, app, project } = boot();
    const rootPath = mkdtempSync(join(tmpdir(), 'tierwyn-proj-'));
    const res = await patch(app, `/projects/${project.id}`, { name: 'Moved', rootPath });
    expect(res.status).toBe(200);
    expect(res.json.project.name).toBe('Moved');
    expect(res.json.project.rootPath).toBe(rootPath);
    expect(getProject(db, project.id)?.name).toBe('Moved');
    expect(getProject(db, project.id)?.rootPath).toBe(rootPath);
  });

  it('400s a relative rootPath and leaves the row alone', async () => {
    const { db, app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { rootPath: 'relative/path' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('rootPath must be an absolute path (leading /)');
    expect(getProject(db, project.id)?.rootPath).toBe('/home/x/Projects/Tierwyn');
  });

  it('400s a rootPath that does not exist on disk and leaves the row alone', async () => {
    const { db, app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { rootPath: '/tmp/tierwyn-does-not-exist-xyz' });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/does not exist on disk/);
    expect(getProject(db, project.id)?.rootPath).toBe('/home/x/Projects/Tierwyn');
  });

  it('400s when neither name nor rootPath is provided', async () => {
    const { app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { id: 'other' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('name, rootPath, rules, rulePresetIds, trustRepoConfig, sandbox, sandboxPaths, or agentSearchScope required');
  });

  it('ignores id in the body', async () => {
    const { db, app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { name: 'Renamed', id: 'other' });
    expect(res.status).toBe(200);
    expect(res.json.project.id).toBe(project.id);
    expect(getProject(db, project.id)?.id).toBe(project.id);
  });

  it('409s a system project rootPath change and leaves the row unchanged', async () => {
    const { db, app } = boot();
    ensureRemoteAgentsProject(db);
    const rootPath = mkdtempSync(join(tmpdir(), 'tierwyn-proj-'));
    const before = getProject(db, REMOTE_AGENTS_PROJECT_ID)!;
    const res = await patch(app, `/projects/${REMOTE_AGENTS_PROJECT_ID}`, { rootPath });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('system project cannot be renamed');
    expect(getProject(db, REMOTE_AGENTS_PROJECT_ID)?.rootPath).toBe(before.rootPath);
  });

  it('is idempotent when renaming to the current name', async () => {
    const { app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { name: 'Tierwyn' });
    expect(res.status).toBe(200);
    expect(res.json.project.name).toBe('Tierwyn');
    expect(res.json.project.createdAt).toBe(project.createdAt);
  });

  it('409s a system project and leaves the name unchanged', async () => {
    const { db, app } = boot();
    ensureRemoteAgentsProject(db);
    const res = await patch(app, `/projects/${REMOTE_AGENTS_PROJECT_ID}`, { name: 'nope' });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('system project cannot be renamed');
    expect(getProject(db, REMOTE_AGENTS_PROJECT_ID)?.name).toBe('Grok Bots');
  });

  it('200s a rename of a normal project next to a system project', async () => {
    const { db, app, project } = boot();
    ensureRemoteAgentsProject(db);
    const res = await patch(app, `/projects/${project.id}`, { name: 'Still Fine' });
    expect(res.status).toBe(200);
    expect(res.json.project.name).toBe('Still Fine');
  });

  it('400s when remoteHostId is present in the body, even null or empty', async () => {
    const { db, app, project } = boot();
    const host = trustedHost(db);
    for (const remoteHostId of [host.id, null, '', '   ']) {
      const res = await patch(app, `/projects/${project.id}`, { remoteHostId });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('remoteHostId is set at create only');
    }
    expect(getProject(db, project.id)?.remoteHostId).toBeUndefined();
  });

  it('400s remoteHostId even when a rename is also supplied', async () => {
    const { db, app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { name: 'Nope', remoteHostId: null });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('remoteHostId is set at create only');
    expect(getProject(db, project.id)?.name).toBe('Tierwyn');
  });

  it('409s a rootPath patch on a remote-host project before existsSync', async () => {
    const { db, app } = boot();
    const host = trustedHost(db);
    const remote = createProject(db, { name: 'OnHost', rootPath: '/remote/repo', remoteHostId: host.id });
    const res = await patch(app, `/projects/${remote.id}`, { rootPath: '/tmp/tierwyn-does-not-exist-xyz' });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('rootPath of a remote-host project cannot change in P1');
    expect(getProject(db, remote.id)?.rootPath).toBe('/remote/repo');
  });

  it('still 200s a local rootPath patch', async () => {
    const { db, app, project } = boot();
    const rootPath = mkdtempSync(join(tmpdir(), 'tierwyn-proj-'));
    const res = await patch(app, `/projects/${project.id}`, { rootPath });
    expect(res.status).toBe(200);
    expect(res.json.project.rootPath).toBe(rootPath);
  });

  it('still 200s a name patch on a remote-host project', async () => {
    const { db, app } = boot();
    const host = trustedHost(db);
    const remote = createProject(db, { name: 'OnHost', rootPath: '/remote/repo', remoteHostId: host.id });
    const res = await patch(app, `/projects/${remote.id}`, { name: 'Renamed remote' });
    expect(res.status).toBe(200);
    expect(res.json.project.name).toBe('Renamed remote');
    expect(res.json.project.remoteHostId).toBe(host.id);
  });

  it('rejects non-boolean trustRepoConfig with 400', async () => {
    const { app, project } = boot();
    const res = await patch(app, `/projects/${project.id}`, { trustRepoConfig: 'yes' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('trustRepoConfig must be a boolean');
  });

  it('toggles trustRepoConfig on a project', async () => {
    const { db, app, project } = boot();
    expect(project.trustRepoConfig).toBe(false);
    const res = await patch(app, `/projects/${project.id}`, { trustRepoConfig: true });
    expect(res.status).toBe(200);
    expect(res.json.project.trustRepoConfig).toBe(true);
    expect(getProject(db, project.id)?.trustRepoConfig).toBe(true);

    const res2 = await patch(app, `/projects/${project.id}`, { trustRepoConfig: false });
    expect(res2.status).toBe(200);
    expect(res2.json.project.trustRepoConfig).toBe(false);
    expect(getProject(db, project.id)?.trustRepoConfig).toBe(false);
  });

  it('reaps parked sessions across the project when trustRepoConfig changes', async () => {
    const reaped: string[] = [];
    let conv1Id = '';
    let conv2Id = '';
    const sessions = {
      activeSessions: () => [
        { id: 's1', conversationId: conv1Id, steerQueue: [] },
        { id: 's2', conversationId: conv2Id, steerQueue: [] },
      ],
      reapParkedSessions: async (cid: string) => { reaped.push(cid); },
    };
    const { db, app, project } = boot(undefined, { sessions });
    const otherProj = createProject(db, { name: 'Other', rootPath: '/tmp/other' });
    const c1 = createConversation(db, { projectId: project.id, title: 'In Project' });
    const c2 = createConversation(db, { projectId: otherProj.id, title: 'Other Project' });
    conv1Id = c1.id;
    conv2Id = c2.id;

    // Flip trustRepoConfig from false to true -> reaps c1
    const res = await patch(app, `/projects/${project.id}`, { trustRepoConfig: true });
    expect(res.status).toBe(200);
    expect(reaped).toEqual([conv1Id]);

    // Send trustRepoConfig: true again (no change) -> no reap
    reaped.length = 0;
    const resSame = await patch(app, `/projects/${project.id}`, { trustRepoConfig: true });
    expect(resSame.status).toBe(200);
    expect(reaped).toEqual([]);
  });
});

describe('POST /projects', () => {
  const remotePath = '/remote/does-not-exist-on-hub';

  it('creates a remote project via fs.statPath and does not hub-existsSync the path', async () => {
    const live = stubHub({
      connected: [],
      stat: { exists: true, isDir: true, isGitRepo: false, underRoots: true },
    });
    const { db, app } = boot(live.hub);
    const host = trustedHost(db);
    live.hub.isConnected = (id: string) => id === host.id;
    live.hub.view = (row: { id: string }) => ({ state: row.id === host.id ? 'connected' as const : 'disconnected' as const });

    const res = await request(app, 'POST', '/projects', {
      name: 'Remote',
      rootPath: remotePath,
      remoteHostId: host.id,
    });
    expect(res.status).toBe(200);
    expect(res.json.project.remoteHostId).toBe(host.id);
    expect(res.json.project.rootPath).toBe(remotePath);
    expect(live.calls).toEqual([{ method: 'fs.statPath', payload: { path: remotePath } }]);
    expect(getProject(db, res.json.project.id)?.remoteHostId).toBe(host.id);
  });

  it('400s when the host is disconnected, untrusted, or missing', async () => {
    const remotePath = '/remote/repo';

    const missing = stubHub({ connected: ['nope'] });
    const { app: missingApp } = boot(missing.hub);
    const missingRes = await request(missingApp, 'POST', '/projects', {
      name: 'X', rootPath: remotePath, remoteHostId: '00000000-0000-4000-8000-000000000099',
    });
    expect(missingRes.status).toBe(400);
    expect(missingRes.json.error).toBe('host not connected');

    const pendingDbBoot = stubHub({ connected: [] });
    const { db: pdb, app: papp } = boot(pendingDbBoot.hub);
    const pending = createPendingHost(pdb, 'pending', 'tok-p', Date.now() + 60_000);
    pendingDbBoot.hub.isConnected = (id: string) => id === pending.id;
    pendingDbBoot.hub.view = (row: { id: string }) => ({ state: row.id === pending.id ? 'connected' as const : 'disconnected' as const });
    const pendingRes = await request(papp, 'POST', '/projects', {
      name: 'X', rootPath: remotePath, remoteHostId: pending.id,
    });
    expect(pendingRes.status).toBe(400);
    expect(pendingRes.json.error).toBe('host not connected');

    const down = stubHub({ connected: [] });
    const { db: ddb, app: dapp } = boot(down.hub);
    const trusted = trustedHost(ddb, 'down');
    const downRes = await request(dapp, 'POST', '/projects', {
      name: 'X', rootPath: remotePath, remoteHostId: trusted.id,
    });
    expect(downRes.status).toBe(400);
    expect(downRes.json.error).toBe('host not connected');
  });

  it('400s when fs.statPath reports the path is outside the host roots', async () => {
    const live = stubHub({
      connected: [],
      stat: { exists: true, isDir: true, isGitRepo: false, underRoots: false },
    });
    const { db, app } = boot(live.hub);
    const host = trustedHost(db);
    live.hub.isConnected = (id: string) => id === host.id;
    live.hub.view = (row: { id: string }) => ({ state: row.id === host.id ? 'connected' as const : 'disconnected' as const });
    const res = await request(app, 'POST', '/projects', {
      name: 'X', rootPath: '/outside', remoteHostId: host.id,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("rootPath is outside the host's allowed roots");
  });

  it('400s when fs.statPath reports !exists or !isDir', async () => {
    for (const stat of [
      { exists: false, isDir: false, isGitRepo: false, underRoots: true },
      { exists: true, isDir: false, isGitRepo: false, underRoots: true },
    ]) {
      const live = stubHub({ connected: [], stat });
      const { db, app } = boot(live.hub);
      const host = trustedHost(db);
      live.hub.isConnected = (id: string) => id === host.id;
      live.hub.view = (row: { id: string }) => ({ state: row.id === host.id ? 'connected' as const : 'disconnected' as const });
      const res = await request(app, 'POST', '/projects', {
        name: 'X', rootPath: '/remote/file', remoteHostId: host.id,
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('rootPath does not exist on host');
    }
  });

  it('400s host not connected when fs.statPath throws', async () => {
    const live = stubHub({ connected: [], throwOnRequest: true });
    const { db, app } = boot(live.hub);
    const host = trustedHost(db);
    live.hub.isConnected = (id: string) => id === host.id;
    live.hub.view = (row: { id: string }) => ({ state: row.id === host.id ? 'connected' as const : 'disconnected' as const });
    const res = await request(app, 'POST', '/projects', {
      name: 'X', rootPath: '/remote/repo', remoteHostId: host.id,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('host not connected');
  });

  it('local create still requires existsSync and never calls fs.statPath', async () => {
    const live = stubHub({ connected: [] });
    const { app } = boot(live.hub);
    const res = await request(app, 'POST', '/projects', {
      name: 'Local',
      rootPath: '/tmp/tierwyn-does-not-exist-xyz',
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/does not exist on disk/);
    expect(live.calls).toEqual([]);
  });
});

describe('GET /projects', () => {
  it('includes remoteHostId on a created remote row', async () => {
    const live = stubHub({
      connected: [],
      stat: { exists: true, isDir: true, isGitRepo: false, underRoots: true },
    });
    const { db, app } = boot(live.hub);
    const host = trustedHost(db);
    live.hub.isConnected = (id: string) => id === host.id;
    live.hub.view = (row: { id: string }) => ({ state: row.id === host.id ? 'connected' as const : 'disconnected' as const });
    const created = await request(app, 'POST', '/projects', {
      name: 'Remote',
      rootPath: '/remote/repo',
      remoteHostId: host.id,
    });
    expect(created.status).toBe(200);
    const res = await request(app, 'GET', '/projects');
    expect(res.status).toBe(200);
    const row = (res.json.projects as Array<{ id: string; remoteHostId?: string }>)
      .find((p) => p.id === created.json.project.id);
    expect(row?.remoteHostId).toBe(host.id);
  });
});

describe('POST /projects local clone & createIfMissing', () => {
  const tmpDirs: string[] = [];
  function tmp(prefix = 'tierwyn-proj-test-'): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }
  afterAll(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('cloneUrl without host → stub localClone called with (roots, {url, root}) → project created', async () => {
    const root = tmp();
    const calls: unknown[] = [];
    const stubClone = async (roots: string[], p: { url: string; root: string }) => {
      calls.push({ roots, p });
      return { path: p.root };
    };
    const { app, db } = boot(undefined, {
      localClone: stubClone as never,
      hubRoots: () => [root],
    });
    const target = join(root, 'cloned-app');
    const res = await request(app, 'POST', '/projects', {
      name: 'Local Cloned',
      rootPath: target,
      cloneUrl: 'https://example.com/repo.git',
    });
    expect(res.status).toBe(200);
    expect(res.json.project.name).toBe('Local Cloned');
    expect(calls).toEqual([{ roots: [root], p: { url: 'https://example.com/repo.git', root: target } }]);
    expect(getProject(db, res.json.project.id)?.rootPath).toBe(target);
  });

  it('Disallowed URL → 400, stub not called', async () => {
    const root = tmp();
    const calls: unknown[] = [];
    const stubClone = async (roots: string[], p: { url: string; root: string }) => {
      calls.push({ roots, p });
      return { path: p.root };
    };
    const { app } = boot(undefined, {
      localClone: stubClone as never,
      hubRoots: () => [root],
    });
    const res = await request(app, 'POST', '/projects', {
      name: 'Bad URL',
      rootPath: join(root, 'app'),
      cloneUrl: 'file:///etc/passwd',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('clone URL not allowed');
    expect(calls).toEqual([]);
  });

  it('Empty roots → 400', async () => {
    const calls: unknown[] = [];
    const stubClone = async (roots: string[], p: { url: string; root: string }) => {
      calls.push({ roots, p });
      return { path: p.root };
    };
    const { app } = boot(undefined, {
      localClone: stubClone as never,
      hubRoots: () => [],
    });
    const res = await request(app, 'POST', '/projects', {
      name: 'No Roots',
      rootPath: '/srv/app',
      cloneUrl: 'https://example.com/repo.git',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('local clone is disabled (TIERWYN_PROJECT_ROOTS is empty)');
    expect(calls).toEqual([]);
  });

  it('Stub throws RpcError(path_outside_roots) → 400 with server wording', async () => {
    const root = tmp();
    const stubClone = async () => {
      throw new RpcError('path_outside_roots', 'parent outside roots');
    };
    const { app } = boot(undefined, {
      localClone: stubClone as never,
      hubRoots: () => [root],
    });
    const res = await request(app, 'POST', '/projects', {
      name: 'Outside',
      rootPath: join(root, 'outside'),
      cloneUrl: 'https://example.com/repo.git',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("rootPath's parent is outside the allowed project roots (TIERWYN_PROJECT_ROOTS)");
  });

  it('Stub throws RpcError(busy) → 409', async () => {
    const root = tmp();
    const stubClone = async () => {
      throw new RpcError('busy', 'busy');
    };
    const { app } = boot(undefined, {
      localClone: stubClone as never,
      hubRoots: () => [root],
    });
    const res = await request(app, 'POST', '/projects', {
      name: 'Busy',
      rootPath: join(root, 'busy'),
      cloneUrl: 'https://example.com/repo.git',
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('a clone into that path is already running');
  });

  it('Stub throws plain Error → 400 could not create folder', async () => {
    const root = tmp();
    const stubClone = async () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    const { app } = boot(undefined, {
      localClone: stubClone as never,
      hubRoots: () => [root],
    });
    const res = await request(app, 'POST', '/projects', {
      name: 'Fail',
      rootPath: join(root, 'fail'),
      cloneUrl: 'https://example.com/repo.git',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('could not create folder: EACCES');
  });

  it('createIfMissing + missing path with parent under injected roots → created on disk + project', async () => {
    const root = tmp();
    const target = join(root, 'auto-created-dir');
    const { app, db } = boot(undefined, { hubRoots: () => [root] });
    expect(existsSync(target)).toBe(false);

    const res = await request(app, 'POST', '/projects', {
      name: 'Auto Mkdir',
      rootPath: target,
      createIfMissing: true,
    });
    expect(res.status).toBe(200);
    expect(existsSync(target)).toBe(true);
    expect(getProject(db, res.json.project.id)?.rootPath).toBe(target);
  });

  it('createIfMissing + parent outside roots → 400 and nothing created', async () => {
    const root = tmp();
    const outside = tmp();
    const target = join(outside, 'auto-created-dir');
    const { app } = boot(undefined, { hubRoots: () => [root] });

    const res = await request(app, 'POST', '/projects', {
      name: 'Outside Mkdir',
      rootPath: target,
      createIfMissing: true,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('parent folder must exist inside the allowed project roots');
    expect(existsSync(target)).toBe(false);
  });

  it('missing path without createIfMissing flag → 400 does not exist (unchanged)', async () => {
    const root = tmp();
    const target = join(root, 'never-created');
    const { app } = boot(undefined, { hubRoots: () => [root] });

    const res = await request(app, 'POST', '/projects', {
      name: 'No Flag',
      rootPath: target,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(`rootPath does not exist on disk: ${target}`);
    expect(existsSync(target)).toBe(false);
  });
});
