import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, getProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost, setRemoteHostStatus, type RemoteHostRow } from '../repositories/remoteHosts.js';
import { registerProjectMutationRoutes } from './projects.js';
import { disconnectedHostView } from './remoteHosts.js';
import { beginProjectMove, endProjectMove } from '../projectMove.js';
import { RpcError } from '../node/rpc.js';
import type { AgentStatus, NodeHello } from '@tierwyn/shared';

const dbs: Db[] = [];
const homes: string[] = [];

function tmp(prefix = 'tierwyn-proj-move-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  homes.push(d);
  return d;
}

afterAll(() => {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
  for (const h of homes) {
    try { chmodSync(h, 0o700); } catch { /* ignore */ }
    try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

interface RecordedCall { method: string; p: unknown }

function fakeHub(opts: {
  connected?: boolean;
  throwOnLink?: unknown;
  hello?: Partial<NodeHello>;
  statExists?: (path: string) => boolean;
} = {}) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    view: (row: RemoteHostRow) => ({
      ...disconnectedHostView(row),
      state: (opts.connected ?? true) ? ('connected' as const) : ('disconnected' as const),
      hello: opts.hello ?? { roots: ['/srv/work'], features: ['fs.mkdir', 'fs.move'] },
    }),
    disconnect() {},
    async refresh() { throw new Error('not connected'); },
    isConnected: () => opts.connected ?? true,
    link() {
      return {
        request: async (m: string, p?: unknown) => {
          calls.push({ method: m, p });
          if (opts.throwOnLink !== undefined) throw opts.throwOnLink;
          if (m === 'fs.statPath') {
            const path = (p as { path: string }).path;
            const exists = opts.statExists ? opts.statExists(path) : true;
            return { path, exists, isDir: true, underRoots: true };
          }
          if (m === 'fs.move') {
            const { to, dryRun } = p as { from: string; to: string; dryRun?: boolean };
            return { path: to, moved: !dryRun };
          }
          return { path: (p as { path: string })?.path, created: true };
        },
      };
    },
  };
}

interface FakeSession {
  id: string;
  conversationId: string;
  lastStatus?: AgentStatus;
  steerQueue: unknown[];
}

function boot(opts?: {
  hub?: ReturnType<typeof fakeHub>;
  sessions?: FakeSession[] | (() => FakeSession[]);
  reaped?: string[];
  localMove?: any;
  moveRoot?: any;
  hubRoots?: () => string[];
}) {
  const db = new Database(':memory:');
  dbs.push(db);
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());

  const hub = opts?.hub ?? fakeHub();
  const reaped: string[] = opts?.reaped ?? [];
  const fakeSessionManager = {
    activeSessions: () => (typeof opts?.sessions === 'function' ? opts.sessions() : (opts?.sessions ?? [])),
    reapParkedSessions: async (cid: string) => { reaped.push(cid); },
  };

  registerProjectMutationRoutes(app, () => db, hub as never, {
    sessions: fakeSessionManager,
    localMove: opts?.localMove,
    moveRoot: opts?.moveRoot,
    hubRoots: opts?.hubRoots,
  });

  const row = createPendingHost(db, 'box-a', 'hash', Date.now() + 60_000);
  setRemoteHostStatus(db, row.id, 'trusted');

  return { db, app, hub, hostId: row.id, reaped };
}

function call(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
      if (body !== undefined) init.body = JSON.stringify(body);
      fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (r) => {
          const text = await r.text();
          let json: Record<string, any> = {};
          try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
          return { status: r.status, json };
        })
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('POST /projects/:id/move', () => {
  it('local happy: folder moved, GET /projects shows new rootPath, 200 moved:true', async () => {
    const root = tmp();
    const from = join(root, 'old-proj');
    mkdirSync(from);
    writeFileSync(join(from, 'file.txt'), 'hello');
    const to = join(root, 'new-proj');

    const { db, app } = boot({ hubRoots: () => [root] });
    const p = createProject(db, { name: 'MyProj', rootPath: from });

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: to });
    expect(res.status).toBe(200);
    expect(res.json.moved).toBe(true);
    expect(res.json.from).toBe(from);
    expect(res.json.to).toBe(to);
    expect(res.json.project.rootPath).toBe(to);

    expect(existsSync(join(to, 'file.txt'))).toBe(true);
    expect(existsSync(from)).toBe(false);
    expect(getProject(db, p.id)?.rootPath).toBe(to);
  });

  it('dryRun: 200 moved:false, folder untouched, reapParkedSessions not called', async () => {
    const root = tmp();
    const from = join(root, 'dry-proj');
    mkdirSync(from);
    const to = join(root, 'dry-target');

    const reaped: string[] = [];
    const { db, app } = boot({ hubRoots: () => [root], reaped });
    const p = createProject(db, { name: 'Dry', rootPath: from });

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: to, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.json.moved).toBe(false);
    expect(res.json.to).toBe(to);
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
    expect(reaped).toHaveLength(0);
  });

  it('live session (running) in project conversation → 409 agents_active', async () => {
    const root = tmp();
    const from = join(root, 'live-proj');
    mkdirSync(from);
    const to = join(root, 'live-target');

    let convId = '';
    const { db, app } = boot({
      hubRoots: () => [root],
      sessions: () => [
        { id: 's1', conversationId: convId, lastStatus: 'running', steerQueue: [] },
      ],
    });
    const p = createProject(db, { name: 'Live', rootPath: from });
    const c1 = createConversation(db, { projectId: p.id, title: 'My Active Chat' });
    convId = c1.id;

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: to });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('agents_active');
    expect(res.json.conversations).toBeDefined();
    expect(res.json.conversations[0].conversationId).toBe(c1.id);
    expect(res.json.conversations[0].title).toBe('My Active Chat');
    expect(existsSync(from)).toBe(true);
  });

  it('parked session (idle, empty queue) → reapParkedSessions called, then 200', async () => {
    const root = tmp();
    const from = join(root, 'parked-proj');
    mkdirSync(from);
    const to = join(root, 'parked-target');

    const reaped: string[] = [];
    let convId = '';
    const { db, app } = boot({
      hubRoots: () => [root],
      reaped,
      sessions: () => [
        { id: 's1', conversationId: convId, lastStatus: 'idle', steerQueue: [] },
      ],
    });
    const p = createProject(db, { name: 'Parked', rootPath: from });
    const c1 = createConversation(db, { projectId: p.id, title: 'Idle Chat' });
    convId = c1.id;

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: to });
    expect(res.status).toBe(200);
    expect(res.json.moved).toBe(true);
    expect(reaped).toContain(c1.id);
  });

  it('session in a different project is ignored, 200', async () => {
    const root = tmp();
    const from = join(root, 'diff-proj');
    mkdirSync(from);
    const to = join(root, 'diff-target');

    let otherConvId = '';
    const { db, app } = boot({
      hubRoots: () => [root],
      sessions: () => [
        { id: 's2', conversationId: otherConvId, lastStatus: 'running', steerQueue: [] },
      ],
    });
    const otherProj = createProject(db, { name: 'Other', rootPath: join(root, 'other') });
    const c2 = createConversation(db, { projectId: otherProj.id, title: 'Other Chat' });
    otherConvId = c2.id;

    const p = createProject(db, { name: 'Diff', rootPath: from });
    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: to });
    expect(res.status).toBe(200);
    expect(res.json.moved).toBe(true);
  });

  it('concurrent move: beginProjectMove pre-held → 409 move_in_progress', async () => {
    const root = tmp();
    const from = join(root, 'conc-proj');
    mkdirSync(from);
    const to = join(root, 'conc-target');

    const { db, app } = boot({ hubRoots: () => [root] });
    const p = createProject(db, { name: 'Conc', rootPath: from });

    beginProjectMove(p.id);
    try {
      const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: to });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('move_in_progress');
    } finally {
      endProjectMove(p.id);
    }
  });

  it('moveRoot stub throws → 500 move_failed, folder back at from, DB unchanged', async () => {
    const root = tmp();
    const from = join(root, 'fail-db-src');
    mkdirSync(from);
    writeFileSync(join(from, 'doc.txt'), 'data');
    const to = join(root, 'fail-db-dst');

    const { db, app } = boot({
      hubRoots: () => [root],
      moveRoot: () => { throw new Error('DB crashed'); },
    });
    const p = createProject(db, { name: 'FailDb', rootPath: from });

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: to });
    expect(res.status).toBe(500);
    expect(res.json.code).toBe('move_failed');
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
    expect(getProject(db, p.id)?.rootPath).toBe(from);
  });

  it('moveRoot throws and rollback throws → 500 rollback_failed, message contains both paths', async () => {
    const root = tmp();
    const from = join(root, 'rb-src');
    mkdirSync(from);
    const to = join(root, 'rb-dst');

    let moveCount = 0;
    const { db, app } = boot({
      hubRoots: () => [root],
      localMove: (_roots: string[], params: any) => {
        moveCount++;
        if (moveCount === 1) {
          mkdirSync(params.to);
          rmSync(params.from, { recursive: true });
          return { path: params.to, moved: true };
        }
        throw new Error('Rollback failed catastrophically');
      },
      moveRoot: () => { throw new Error('DB fail'); },
    });
    const p = createProject(db, { name: 'RbFail', rootPath: from });

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: to });
    expect(res.status).toBe(500);
    expect(res.json.code).toBe('rollback_failed');
    expect(res.json.error).toContain(to);
    expect(res.json.error).toContain(from);
  });

  it('nested project under from → 400 contains_other_project', async () => {
    const root = tmp();
    const from = join(root, 'parent-proj');
    mkdirSync(from);
    const nested = join(from, 'child-proj');
    mkdirSync(nested);
    const to = join(root, 'moved-parent');

    const { db, app } = boot({ hubRoots: () => [root] });
    const p1 = createProject(db, { name: 'Parent', rootPath: from });
    createProject(db, { name: 'Child', rootPath: nested });

    const res = await call(app, 'POST', `/projects/${p1.id}/move`, { rootPath: to });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('contains_other_project');
  });

  it('~/x → 400 bad_path; trailing slash …/new/ → stored without trailing slash', async () => {
    const root = tmp();
    const from = join(root, 'norm-src');
    mkdirSync(from);

    const { db, app } = boot({ hubRoots: () => [root] });
    const p = createProject(db, { name: 'Norm', rootPath: from });

    const resTilde = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: '~/somewhere' });
    expect(resTilde.status).toBe(400);
    expect(resTilde.json.code).toBe('bad_path');

    const toWithSlash = join(root, 'norm-dst') + '/';
    const resSlash = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: toWithSlash });
    expect(resSlash.status).toBe(200);
    expect(resSlash.json.to).toBe(join(root, 'norm-dst'));
    expect(resSlash.json.to.endsWith('/')).toBe(false);
  });

  it('system project → 409 system_project; unknown id → 404 not_found', async () => {
    const root = tmp();
    const from = join(root, 'sys-proj');
    mkdirSync(from);
    const to = join(root, 'sys-dst');

    const { db, app } = boot({ hubRoots: () => [root] });
    const sys = createProject(db, { name: 'System', rootPath: from });
    db.prepare('UPDATE projects SET system = 1 WHERE id = ?').run(sys.id);

    const resSys = await call(app, 'POST', `/projects/${sys.id}/move`, { rootPath: to });
    expect(resSys.status).toBe(409);
    expect(resSys.json.code).toBe('system_project');

    const resMissing = await call(app, 'POST', '/projects/nonexistent-id/move', { rootPath: to });
    expect(resMissing.status).toBe(404);
  });

  it('remote, hello without fs.move → 501 node_update_required', async () => {
    const hub = fakeHub({
      hello: { roots: ['/srv/work'], features: ['fs.mkdir'] }, // missing fs.move
    });
    const { db, app, hostId } = boot({ hub });
    const p = createProject(db, { name: 'RemoteOld', rootPath: '/srv/work/proj', remoteHostId: hostId });

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: '/srv/work/new-proj' });
    expect(res.status).toBe(501);
    expect(res.json.code).toBe('node_update_required');
  });

  it('remote happy: fake hub link records (fs.move, {from, to}), DB updated', async () => {
    const hub = fakeHub();
    const { db, app, hostId } = boot({ hub });
    const p = createProject(db, { name: 'RemoteHappy', rootPath: '/srv/work/proj', remoteHostId: hostId });

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: '/srv/work/target' });
    expect(res.status).toBe(200);
    expect(res.json.moved).toBe(true);
    expect(res.json.to).toBe('/srv/work/target');
    expect(getProject(db, p.id)?.rootPath).toBe('/srv/work/target');

    expect(hub.calls.some((c) => c.method === 'fs.move' && (c.p as any).to === '/srv/work/target')).toBe(true);
  });

  it('remote RPC rejects timeout, statPath says to exists and from does not → 200 moved:true', async () => {
    let moveCalled = false;
    const hub = {
      calls: [] as RecordedCall[],
      view: (row: RemoteHostRow) => ({
        ...disconnectedHostView(row),
        state: 'connected' as const,
        hello: { roots: ['/srv/work'], features: ['fs.move'] },
      }),
      disconnect() {},
      async refresh() { throw new Error('not connected'); },
      isConnected: () => true,
      link() {
        return {
          request: async (m: string, p?: unknown) => {
            hub.calls.push({ method: m, p });
            if (m === 'fs.move' && !moveCalled) {
              moveCalled = true;
              throw new RpcError('timeout', 'request timed out');
            }
            if (m === 'fs.statPath') {
              const path = (p as { path: string }).path;
              if (path === '/srv/work/target') return { path, exists: true, isDir: true, underRoots: true };
              if (path === '/srv/work/proj') return { path, exists: false, isDir: false, underRoots: true };
            }
            return { path: (p as any)?.path, moved: true };
          },
        };
      },
    };

    const { db, app, hostId } = boot({ hub: hub as any });
    const p = createProject(db, { name: 'RemoteTimeout', rootPath: '/srv/work/proj', remoteHostId: hostId });

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: '/srv/work/target' });
    expect(res.status).toBe(200);
    expect(res.json.moved).toBe(true);
    expect(getProject(db, p.id)?.rootPath).toBe('/srv/work/target');
  });

  it('remote host disconnected → 409 host_disconnected', async () => {
    const hub = fakeHub({ connected: false });
    const { db, app, hostId } = boot({ hub });
    const p = createProject(db, { name: 'RemoteDisc', rootPath: '/srv/work/proj', remoteHostId: hostId });

    const res = await call(app, 'POST', `/projects/${p.id}/move`, { rootPath: '/srv/work/target' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('host_disconnected');
  });
});
