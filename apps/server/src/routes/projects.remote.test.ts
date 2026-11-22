/**
 * P2c T6: hub routes for live path stat + clone-from-URL.
 * - GET /remote-hosts/:id/stat-path proxies fs.statPath for path + parent.
 * - POST /projects with cloneUrl clones on the host before creating.
 * Fake hub/link pattern per files.remote.test.ts — nothing touches a real node.
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createPendingHost, setRemoteHostStatus, type RemoteHostRow } from '../repositories/remoteHosts.js';
import { registerProjectMutationRoutes } from './projects.js';
import { registerRemoteHostRoutes, disconnectedHostView } from './remoteHosts.js';
import { RpcError } from '../node/rpc.js';

import type { NodeHello } from '@tierwyn/shared';

const dbs: Db[] = [];
afterAll(() => {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
});

interface RecordedCall { method: string; p: unknown }

function fakeHub(opts: {
  connected?: boolean;
  throwOnLink?: unknown;
  hello?: Partial<NodeHello>;
  statExists?: boolean | ((path: string, callCount: number) => boolean);
} = {}) {
  const calls: RecordedCall[] = [];
  let statCount = 0;
  return {
    calls,
    view: (row: RemoteHostRow) => ({
      ...disconnectedHostView(row),
      state: 'connected' as const,
      hello: opts.hello ?? { roots: ['/srv/work'], features: ['fs.mkdir'] },
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
            statCount++;
            const exists = typeof opts.statExists === 'function'
              ? opts.statExists((p as { path: string }).path, statCount)
              : (opts.statExists ?? true);
            return { path: (p as { path: string }).path, exists, isDir: true, underRoots: true };
          }
          return { path: (p as { path: string })?.path, created: true };
        },
      };
    },
  };
}

function boot(hub = fakeHub()) {
  const db = new Database(':memory:');
  dbs.push(db);
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  registerProjectMutationRoutes(app, () => db, hub as never);
  registerRemoteHostRoutes(app, { db: () => db, hub: hub as never });
  const row = createPendingHost(db, 'box-a', 'hash', Date.now() + 60_000);
  setRemoteHostStatus(db, row.id, 'trusted');
  return { db, app, hub, hostId: row.id };
}

function call(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
      if (body !== undefined) init.body = JSON.stringify(body);
      fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (r) => {
          const text = await r.text();
          let json: Record<string, unknown> = {};
          try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
          return { status: r.status, json };
        })
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const CLONE_URL = 'https://example.com/x.git';

describe('GET /remote-hosts/:id/stat-path', () => {
  it('400 on a relative path without RPC', async () => {
    const { app, hub, hostId } = boot();
    const r = await call(app, 'GET', `/remote-hosts/${hostId}/stat-path?path=rel/path`);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('absolute path required');
    expect(hub.calls).toEqual([]);
  });

  it('404 on an unknown host', async () => {
    const { app } = boot();
    const r = await call(app, 'GET', '/remote-hosts/nope/stat-path?path=/srv/work');
    expect(r.status).toBe(404);
  });

  it('409 when the host is not connected', async () => {
    const { app, hostId } = boot(fakeHub({ connected: false }));
    const r = await call(app, 'GET', `/remote-hosts/${hostId}/stat-path?path=/srv/work`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('host is not connected');
  });

  it('200 with { path, parent } and both statPath calls', async () => {
    const { app, hub, hostId } = boot();
    const r = await call(app, 'GET', `/remote-hosts/${hostId}/stat-path?path=/srv/work/app`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ path: { path: '/srv/work/app' }, parent: { path: '/srv/work' } });
    expect(hub.calls.map((c) => c.method)).toEqual(['fs.statPath', 'fs.statPath']);
    expect(hub.calls[0].p).toMatchObject({ path: '/srv/work/app' });
    expect(hub.calls[1].p).toMatchObject({ path: '/srv/work' });
  });

  it('409 when the link request fails', async () => {
    const { app, hostId } = boot(fakeHub({ throwOnLink: new RpcError('host_disconnected', 'gone') }));
    const r = await call(app, 'GET', `/remote-hosts/${hostId}/stat-path?path=/srv/work`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('host is not connected');
  });
});

describe('POST /projects cloneUrl', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: 'p', rootPath: '/srv/work/app', remoteHostId: 'pending', cloneUrl: CLONE_URL, ...over,
  });

  it('400 on a disallowed url without RPC', async () => {
    const { app, hub, hostId } = boot();
    const r = await call(app, 'POST', '/projects', body({ remoteHostId: hostId, cloneUrl: 'file:///etc/passwd' }));
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain('clone URL not allowed');
    expect(hub.calls).toEqual([]);
  });

  it.each([
    ['bad_url', 'clone url not allowed', 400, 'clone url not allowed'],
    ['bad_path', 'invalid clone root', 400, 'invalid clone root'],
    ['path_outside_roots', 'outside', 400, "rootPath's parent is outside the host's allowed roots"],
    ['exists', 'already there', 400, 'rootPath already exists on host — if a previous clone finished, create the project without Clone from URL'],
    ['busy', 'in flight', 409, 'a clone into that path is already running'],
    ['clone_failed', 'fatal: boom', 400, 'git clone failed: fatal: boom'],
    ['no_method', 'no_method', 400, 'update tierwyn node on the host to clone'],
    ['host_disconnected', 'gone', 400, 'host not connected'],
  ])('maps fs.clone %s → %s', async (code, message, wantStatus, wantError) => {
    const { app, hub, hostId } = boot(fakeHub({ throwOnLink: new RpcError(code as never, message) }));
    // throwOnLink fires for fs.clone AND fs.statPath — after a failed clone the
    // route must not fall through to statPath, so calls stay at 1.
    const r = await call(app, 'POST', '/projects', body({ remoteHostId: hostId }));
    expect(r.status).toBe(wantStatus);
    expect(r.json.error).toBe(wantError);
    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0].method).toBe('fs.clone');
    expect(hub.calls[0].p).toEqual({ url: CLONE_URL, root: '/srv/work/app' });
  });

  it('clones then stats, and creates the project bound to the host', async () => {
    const { app, hub, db, hostId } = boot();
    const r = await call(app, 'POST', '/projects', body({ remoteHostId: hostId }));
    expect(r.status).toBe(200);
    expect(hub.calls.map((c) => c.method)).toEqual(['fs.clone', 'fs.statPath']);
    expect(hub.calls[0].p).toEqual({ url: CLONE_URL, root: '/srv/work/app' });
    const list = await call(app, 'GET', '/projects');
    const projects = list.json.projects as Array<{ remoteHostId?: string; rootPath: string }>;
    expect(projects).toHaveLength(1);
    expect(projects[0].remoteHostId).toBe(hostId);
    expect(projects[0].rootPath).toBe('/srv/work/app');
  });
});

describe('POST /projects createIfMissing (remote)', () => {
  it('remote createIfMissing + missing path → fs.statPath, fs.mkdir, fs.statPath are called in order', async () => {
    const hub = fakeHub({
      statExists: (_path, count) => count > 1,
    });
    const { app, hostId } = boot(hub);
    const r = await call(app, 'POST', '/projects', {
      name: 'remote-proj',
      rootPath: '/srv/work/new-dir',
      remoteHostId: hostId,
      createIfMissing: true,
    });
    expect(r.status).toBe(200);
    expect(hub.calls.map((c) => c.method)).toEqual(['fs.statPath', 'fs.mkdir', 'fs.statPath']);
    expect(hub.calls[0].p).toEqual({ path: '/srv/work/new-dir' });
    expect(hub.calls[1].p).toEqual({ path: '/srv/work/new-dir' });
    expect(hub.calls[2].p).toEqual({ path: '/srv/work/new-dir' });
  });

  it('A hello without the fs.mkdir feature on a missing path → 501 node_update_required, no fs.mkdir RPC', async () => {
    const hub = fakeHub({
      hello: { roots: ['/srv/work'], features: [] },
      statExists: false,
    });
    const { app, hostId } = boot(hub);
    const r = await call(app, 'POST', '/projects', {
      name: 'remote-proj',
      rootPath: '/srv/work/new-dir',
      remoteHostId: hostId,
      createIfMissing: true,
    });
    expect(r.status).toBe(501);
    expect(r.json).toMatchObject({ code: 'node_update_required' });
    expect(hub.calls.map((c) => c.method)).toEqual(['fs.statPath']);
  });

  it('existing folder on old node succeeds without 501 and does not invoke fs.mkdir', async () => {
    const hub = fakeHub({
      hello: { roots: ['/srv/work'], features: [] },
      statExists: true,
    });
    const { app, hostId } = boot(hub);
    const r = await call(app, 'POST', '/projects', {
      name: 'remote-proj',
      rootPath: '/srv/work/existing-app',
      remoteHostId: hostId,
      createIfMissing: true,
    });
    expect(r.status).toBe(200);
    expect(hub.calls.map((c) => c.method)).toEqual(['fs.statPath']);
  });

  it('rootPath == root with createIfMissing:true succeeds without invoking fs.mkdir', async () => {
    const hub = fakeHub({
      statExists: true,
    });
    const { app, hostId } = boot(hub);
    const r = await call(app, 'POST', '/projects', {
      name: 'remote-proj',
      rootPath: '/srv/work',
      remoteHostId: hostId,
      createIfMissing: true,
    });
    expect(r.status).toBe(200);
    expect(hub.calls.map((c) => c.method)).toEqual(['fs.statPath']);
  });
});
