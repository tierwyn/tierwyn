import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createPendingHost, setRemoteHostStatus, type RemoteHostRow } from '../repositories/remoteHosts.js';
import { hubProjectRoots, registerProjectBrowseRoutes, type ProjectBrowseNodeHub } from './projectBrowse.js';
import { RpcError } from '../node/rpc.js';
import type { NodeHello, ProjectBrowseListing, ProjectBrowseRoots, ProjectBrowseStat } from '@tierwyn/shared';

const dbs: Db[] = [];
const tmpDirs: string[] = [];

function tmp(prefix = 'tierwyn-pb-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
  for (const t of tmpDirs) { try { rmSync(t, { recursive: true, force: true }); } catch { /* ignore */ } }
});

interface RecordedCall { method: string; p: unknown }

function fakeHub(opts: {
  connected?: boolean;
  state?: string;
  hello?: Partial<NodeHello>;
  throwOnLink?: unknown;
  filesListResult?: unknown;
} = {}): ProjectBrowseNodeHub & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    isConnected: () => opts.connected ?? true,
    view: () => ({
      state: opts.state ?? 'connected',
      hello: opts.hello ?? { roots: ['/remote/root'], features: ['fs.mkdir'] },
    }),
    link() {
      return {
        request: async <T = unknown>(m: string, p?: unknown): Promise<T> => {
          calls.push({ method: m, p });
          if (opts.throwOnLink !== undefined) throw opts.throwOnLink;
          if (m === 'files.list') {
            return (opts.filesListResult ?? {
              status: 200,
              body: {
                root: (p as { root: string }).root,
                path: (p as { path?: string }).path ?? '',
                entries: [
                  { name: 'sub', kind: 'dir', mtimeMs: 123 },
                  { name: 'file.txt', kind: 'file', mtimeMs: 456 },
                ],
                truncated: false,
              },
            }) as T;
          }
          return {} as T;
        },
      };
    },
  };
}

function boot(opts: {
  hub?: ProjectBrowseNodeHub;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
} = {}) {
  const db = new Database(':memory:');
  dbs.push(db);
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  registerProjectBrowseRoutes(app, {
    getDb: () => db,
    nodeHub: opts.hub,
    dataDir: opts.dataDir,
    env: opts.env,
  });
  const row = createPendingHost(db, 'box-a', 'hash', Date.now() + 60_000);
  setRemoteHostStatus(db, row.id, 'trusted');
  return { db, app, hostId: row.id };
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

describe('hubProjectRoots', () => {
  it('unset → [homedir]', () => {
    expect(hubProjectRoots({})).toEqual([resolve(homedir())]);
  });

  it('empty string → []', () => {
    expect(hubProjectRoots({ TIERWYN_PROJECT_ROOTS: '' })).toEqual([]);
  });

  it('mixed list ignores relative paths and trims', () => {
    const roots = hubProjectRoots({ TIERWYN_PROJECT_ROOTS: ' /srv/work : rel/path : /home/user/proj ' });
    expect(roots).toEqual([resolve('/srv/work'), resolve('/home/user/proj')]);
  });
});

describe('GET /project-browse/roots', () => {
  it('hub → {roots, canCreate: true, canClone: true}', async () => {
    const dir = tmp();
    const { app } = boot({ env: { TIERWYN_PROJECT_ROOTS: dir } });
    const r = await call(app, 'GET', '/project-browse/roots');
    expect(r.status).toBe(200);
    const json = r.json as unknown as ProjectBrowseRoots;
    expect(json.roots).toEqual([dir]);
    expect(json.canCreate).toBe(true);
    expect(json.canClone).toBe(true);
    expect(json.nodeUpdateRequired).toBeUndefined();
  });

  it('empty env → all false', async () => {
    const { app } = boot({ env: { TIERWYN_PROJECT_ROOTS: '' } });
    const r = await call(app, 'GET', '/project-browse/roots');
    expect(r.status).toBe(200);
    const json = r.json as unknown as ProjectBrowseRoots;
    expect(json.roots).toEqual([]);
    expect(json.canCreate).toBe(false);
    expect(json.canClone).toBe(false);
    expect(json.nodeUpdateRequired).toBeUndefined();
  });

  it('remote → hello.roots, with canCreate following the fs.mkdir feature', async () => {
    const hubWithMkdir = fakeHub({
      hello: { roots: ['/remote/box'], features: ['fs.mkdir'] },
    });
    const { app, hostId } = boot({ hub: hubWithMkdir });
    const r = await call(app, 'GET', `/project-browse/roots?remoteHostId=${hostId}`);
    expect(r.status).toBe(200);
    const json = r.json as unknown as ProjectBrowseRoots;
    expect(json.roots).toEqual(['/remote/box']);
    expect(json.canCreate).toBe(true);
    expect(json.canClone).toBe(true);
    expect(json.nodeUpdateRequired).toBeUndefined();

    const hubWithoutMkdir = fakeHub({
      hello: { roots: ['/remote/box'], features: [] },
    });
    const { app: app2, hostId: hostId2 } = boot({ hub: hubWithoutMkdir });
    const r2 = await call(app2, 'GET', `/project-browse/roots?remoteHostId=${hostId2}`);
    expect(r2.status).toBe(200);
    const json2 = r2.json as unknown as ProjectBrowseRoots;
    expect(json2.roots).toEqual(['/remote/box']);
    expect(json2.canCreate).toBe(false);
    expect(json2.canClone).toBe(true);
    expect(json2.nodeUpdateRequired).toBe(true);
  });

  it('remote with empty roots and without fs.mkdir feature → canCreate: false, nodeUpdateRequired not set', async () => {
    const hubWithoutRoots = fakeHub({
      hello: { roots: [], features: [] },
    });
    const { app, hostId } = boot({ hub: hubWithoutRoots });
    const r = await call(app, 'GET', `/project-browse/roots?remoteHostId=${hostId}`);
    expect(r.status).toBe(200);
    const json = r.json as unknown as ProjectBrowseRoots;
    expect(json.roots).toEqual([]);
    expect(json.canCreate).toBe(false);
    expect(json.nodeUpdateRequired).toBeUndefined();
  });

  it('disconnected → 409', async () => {
    const hub = fakeHub({ connected: false });
    const { app, hostId } = boot({ hub });
    const r = await call(app, 'GET', `/project-browse/roots?remoteHostId=${hostId}`);
    expect(r.status).toBe(409);
  });

  it('unknown → 404', async () => {
    const hub = fakeHub();
    const { app } = boot({ hub });
    const r = await call(app, 'GET', '/project-browse/roots?remoteHostId=nonexistent');
    expect(r.status).toBe(404);
  });
});

describe('GET /project-browse/list (hub)', () => {
  it('returns dirs only, never files; dot dirs included; .git absent', async () => {
    const root = tmp();
    mkdirSync(join(root, 'visible-dir'));
    mkdirSync(join(root, '.hidden-dir'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'file.txt'), 'hello');
    writeFileSync(join(root, '.hidden-file'), 'secret');

    const { app } = boot({ env: { TIERWYN_PROJECT_ROOTS: root } });
    const r = await call(app, 'GET', `/project-browse/list?root=${encodeURIComponent(root)}`);
    expect(r.status).toBe(200);
    const json = r.json as unknown as ProjectBrowseListing;
    expect(json.root).toBe(root);
    expect(json.path).toBe('');
    const names = json.dirs.map((d) => d.name);
    expect(names).toContain('visible-dir');
    expect(names).toContain('.hidden-dir');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('file.txt');
    expect(names).not.toContain('.hidden-file');
  });

  it('root not in roots → 400', async () => {
    const root = tmp();
    const other = tmp();
    const { app } = boot({ env: { TIERWYN_PROJECT_ROOTS: root } });
    const r = await call(app, 'GET', `/project-browse/list?root=${encodeURIComponent(other)}`);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('root must be one of the allowed roots');
  });

  it('path=../.. → 403 or 400', async () => {
    const root = tmp();
    const { app } = boot({ env: { TIERWYN_PROJECT_ROOTS: root } });
    const r = await call(app, 'GET', `/project-browse/list?root=${encodeURIComponent(root)}&path=../..`);
    expect([400, 403]).toContain(r.status);
  });

  it('a symlink dir pointing outside the root → 403 when navigated into', async () => {
    const root = tmp();
    const outside = tmp();
    const linkDir = join(root, 'outside-link');
    symlinkSync(outside, linkDir, 'dir');

    const { app } = boot({ env: { TIERWYN_PROJECT_ROOTS: root } });
    const r = await call(app, 'GET', `/project-browse/list?root=${encodeURIComponent(root)}&path=outside-link`);
    expect(r.status).toBe(403);
  });

  it('empty roots → 403', async () => {
    const root = tmp();
    const { app } = boot({ env: { TIERWYN_PROJECT_ROOTS: '' } });
    const r = await call(app, 'GET', `/project-browse/list?root=${encodeURIComponent(root)}`);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('no project roots configured');
  });
});

describe('GET /project-browse/list (remote)', () => {
  it('calls files.list with {root, path}', async () => {
    const hub = fakeHub({
      hello: { roots: ['/remote/root'], features: ['fs.mkdir'] },
    });
    const { app, hostId } = boot({ hub });
    const r = await call(app, 'GET', `/project-browse/list?remoteHostId=${hostId}&root=/remote/root&path=sub`);
    expect(r.status).toBe(200);
    expect(hub.calls).toContainEqual({ method: 'files.list', p: { root: '/remote/root', path: 'sub' } });
    const json = r.json as unknown as ProjectBrowseListing;
    expect(json.dirs).toEqual([{ name: 'sub', mtimeMs: 123 }]);
  });

  it('root not in hello.roots → 400 without any RPC', async () => {
    const hub = fakeHub({
      hello: { roots: ['/remote/root'], features: ['fs.mkdir'] },
    });
    const { app, hostId } = boot({ hub });
    const r = await call(app, 'GET', `/project-browse/list?remoteHostId=${hostId}&root=/other/root`);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('root must be one of the allowed roots');
    expect(hub.calls).toEqual([]);
  });

  it('RpcError no_method → 501', async () => {
    const hub = fakeHub({
      hello: { roots: ['/remote/root'], features: ['fs.mkdir'] },
      throwOnLink: new RpcError('no_method', 'files.list not implemented'),
    });
    const { app, hostId } = boot({ hub });
    const r = await call(app, 'GET', `/project-browse/list?remoteHostId=${hostId}&root=/remote/root`);
    expect(r.status).toBe(501);
  });
});

describe('GET /project-browse/stat (hub)', () => {
  it('underRoots true/false and stat details', async () => {
    const root = tmp();
    const child = join(root, 'child');
    mkdirSync(child);

    const outside = tmp();

    const { app } = boot({ env: { TIERWYN_PROJECT_ROOTS: root } });
    const r1 = await call(app, 'GET', `/project-browse/stat?path=${encodeURIComponent(child)}`);
    expect(r1.status).toBe(200);
    const json1 = r1.json as unknown as ProjectBrowseStat;
    expect(json1.path.exists).toBe(true);
    expect(json1.path.isDir).toBe(true);
    expect(json1.path.underRoots).toBe(true);
    expect(json1.parent.exists).toBe(true);
    expect(json1.parent.underRoots).toBe(true);

    const r2 = await call(app, 'GET', `/project-browse/stat?path=${encodeURIComponent(outside)}`);
    expect(r2.status).toBe(200);
    const json2 = r2.json as unknown as ProjectBrowseStat;
    expect(json2.path.underRoots).toBe(false);
  });

  it('relative → 400', async () => {
    const { app } = boot();
    const r = await call(app, 'GET', '/project-browse/stat?path=rel/path');
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('absolute path required');
  });
});

describe('auth mount order wiring', () => {
  it('registerProjectBrowseRoutes is mounted after requireAuth in index.ts', () => {
    const indexSrc = readFileSync(join(__dirname, '../index.ts'), 'utf-8');
    const authIdx = indexSrc.indexOf('app.use(requireAuth(');
    const browseIdx = indexSrc.indexOf('registerProjectBrowseRoutes(');
    expect(authIdx).toBeGreaterThan(0);
    expect(browseIdx).toBeGreaterThan(authIdx);
  });
});
