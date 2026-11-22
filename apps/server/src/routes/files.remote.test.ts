import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, statSync, readFileSync, realpathSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { NODE_FILE_CHUNK_BYTES } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost, saveHello } from '../repositories/remoteHosts.js';
import { updateGeneralSettings } from '../repositories/settings.js';
import { registerFileRoutes, setRemoteReadChunkForTests, type FileRoutesNodeHub } from './files.js';
import { versionToken } from '../files/writePolicy.js';
import { NodeRuntime } from '../node/runtime.js';
import { memoryPair, RpcError, RpcPeer } from '../node/rpc.js';
import type { SessionRecord } from '../sessionManager.js';

/**
 * P2b-1: hub /files and /files/list proxy to a real NodeRuntime over an
 * in-memory RPC pair. nodeRoot is a mkdtemp that is NOT registered as a local
 * project, so a hub-disk fallback cannot pass by accident — the bytes these
 * tests read only exist on the "node" side of the wire (same tmp disk here,
 * but only the node's jail logic decides whether they are reachable).
 */
describe('remote-host file routes (P2b-1)', () => {
  let db: Db;
  let nodeRoot: string;
  let hubTmp: string;
  let dataDir: string;
  let hubPeer: RpcPeer;
  let hostId: string;
  let projectId: string;
  let convoId: string;
  let extraDirs: string[];
  let app: express.Express;

  function write(rel: string, content: string | Buffer): string {
    const p = join(nodeRoot, rel);
    writeFileSync(p, content);
    return p;
  }

  function tmpDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    extraDirs.push(d);
    return d;
  }

  interface Resp {
    status: number;
    body: string;
    raw: Buffer;
    headers: Record<string, string>;
    json: () => unknown;
  }

  async function req(
    path: string,
    init: { method?: 'GET' | 'HEAD'; headers?: Record<string, string> } = {},
  ): Promise<Resp> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
      const body = init.method === 'HEAD' ? '' : Buffer.from(await r.arrayBuffer());
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      return {
        status: r.status,
        body: body.toString('utf8'),
        raw: body,
        headers,
        json: () => JSON.parse(body.toString('utf8')) as unknown,
      };
    } finally {
      server.close();
    }
  }

  type LinkCalls = Array<{ m: string; p: Record<string, unknown> }>;

  /** Build a fresh app whose nodeHub link records calls, then forwards to the
   * in-memory hub peer — unless `impl` answers first. */
  function makeApp(impl?: (m: string, p: unknown) => Promise<unknown>, sessions: SessionRecord[] = []): LinkCalls {
    const calls: LinkCalls = [];
    const nodeHub: FileRoutesNodeHub = {
      link: () => ({
        request: async <T,>(m: string, p?: unknown): Promise<T> => {
          calls.push({ m, p: (p ?? {}) as Record<string, unknown> });
          const over = impl?.(m, p);
          if (over !== undefined) return (await over) as T;
          return hubPeer.request<T>(m, p);
        },
      }),
    };
    app = express();
    app.use(express.json({ limit: '25mb' }));
    registerFileRoutes(app, () => db, { dataDir, nodeHub, getActiveSessions: () => sessions });
    return calls;
  }

  beforeEach(() => {
    extraDirs = [];
    db = new Database(':memory:');
    runMigrations(db, migrations);
    nodeRoot = tmpDir('tierwyn-rem-node-');
    hubTmp = tmpDir('tierwyn-rem-hub-');
    dataDir = tmpDir('tierwyn-rem-data-');

    mkdirSync(join(nodeRoot, 'sub'));
    mkdirSync(join(nodeRoot, '.git'));
    write('a.md', 'hello');
    write('.env', 'SECRET_ENV=1');

    const [hubT, nodeT] = memoryPair();
    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters in file-route tests'); },
      has: () => false,
      policy: { roots: [nodeRoot], allowedAgents: [], maxSessions: 4 },
      artifactsRoot: join(nodeRoot, '.node-artifacts'),
    });
    const nodePeer = new RpcPeer(nodeT, runtime.handlers());
    hubPeer = new RpcPeer(hubT, {});
    void nodePeer;

    hostId = createPendingHost(db, 'box', 'b', Date.now() + 60_000).id;
    projectId = createProject(db, { name: 'remote', rootPath: nodeRoot, remoteHostId: hostId }).id;
    convoId = createConversation(db, { projectId, title: 'rc' }).id;
  });

  afterEach(() => {
    for (const d of extraDirs.splice(0).reverse()) {
      rmSync(d, { recursive: true, force: true });
    }
    db.close();
  });

  it('lists the remote root via the node and navigates into a folder', async () => {
    write('sub/inner.md', 'inner');
    makeApp();
    const root = await req(`/files/list?projectId=${projectId}`);
    expect(root.status).toBe(200);
    const body = root.json() as { path: string; entries: Array<{ name: string }> };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain('a.md');
    expect(names).toContain('sub');
    expect(names).not.toContain('.git');
    expect(body.path).toBe('');
    const sub = await req(`/files/list?projectId=${projectId}&path=sub`);
    expect(sub.status).toBe(200);
    const subBody = sub.json() as { path: string; entries: Array<{ name: string }> };
    expect(subBody.path).toBe('sub');
    expect(subBody.entries.map((e) => e.name)).toContain('inner.md');
  });

  it('list rejects traversal via the node jail', async () => {
    makeApp();
    const res = await req(`/files/list?projectId=${projectId}&path=${encodeURIComponent('../')}`);
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: 'path not allowed' });
  });

  it('reads remote text read-only with node stat headers', async () => {
    const calls = makeApp();
    const st = statSync(join(nodeRoot, 'a.md'));
    const res = await req(`/files?path=a.md&conversationId=${convoId}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello');
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['x-tierwyn-file-writable']).toBe('0');
    expect(res.headers['x-tierwyn-file-version']).toBe(`${Math.floor(st.mtimeMs)}-${st.size}`);
    expect(res.headers['x-tierwyn-file-path'])
      .toBe(encodeURIComponent(realpathSync(join(nodeRoot, 'a.md'))));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['content-disposition']).toBe('inline; filename="a.md"');
    expect(calls).toHaveLength(2); // metadata + one data chunk
    expect(calls[0]).toMatchObject({ m: 'files.read', p: { root: nodeRoot, path: 'a.md' } });
    expect(calls[0].p.length).toBeUndefined();
    expect(calls[1].p).toMatchObject({ offset: 0, length: 5 });
  });

  it('remote png previews with the right content type and bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    write('p.png', png);
    makeApp();
    const res = await req(`/files?path=p.png&projectId=${projectId}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.raw.equals(png)).toBe(true);
  });

  it('multi-chunk read reassembles the body (seam set to 4 bytes)', async () => {
    write('ten.md', '0123456789');
    const calls = makeApp();
    setRemoteReadChunkForTests(4);
    try {
      const res = await req(`/files?path=ten.md&conversationId=${convoId}`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('0123456789');
      expect(calls).toHaveLength(4); // metadata + 3 data chunks
      expect(calls.slice(1).map((c) => [c.p.offset, c.p.length])).toEqual([[0, 4], [4, 4], [8, 2]]);
    } finally {
      setRemoteReadChunkForTests(NODE_FILE_CHUNK_BYTES);
    }
  });

  it('HEAD makes only the metadata call', async () => {
    const calls = makeApp();
    const res = await req(`/files?path=a.md&conversationId=${convoId}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-length']).toBe('5');
    expect(res.headers['x-tierwyn-file-writable']).toBe('0');
    expect(calls).toHaveLength(1);
    expect(calls[0].p.length).toBeUndefined();
  });

  it('Range bytes=2-4 serves 206 with the right slice', async () => {
    const calls = makeApp();
    const res = await req(`/files?path=a.md&conversationId=${convoId}`, {
      headers: { Range: 'bytes=2-4' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-4/5');
    expect(res.headers['content-length']).toBe('3');
    expect(res.body).toBe('llo');
    expect(calls).toHaveLength(2);
    expect(calls[1].p).toMatchObject({ offset: 2, length: 3 });
  });

  // P1-1 regression: a non-ASCII path used to make setHeader throw
  // ERR_INVALID_CHAR inside this async Express 4 handler — an unhandled
  // rejection that took the hub down instead of answering the request.
  it('serves a non-ASCII remote path with an encoded header and no unhandled rejection', async () => {
    write('日本.md', 'konnichiha');
    makeApp();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const res = await req(`/files?path=${encodeURIComponent('日本.md')}&conversationId=${convoId}`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('konnichiha');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['x-tierwyn-file-path'])
        .toBe(encodeURIComponent(realpathSync(join(nodeRoot, '日本.md'))));
      // Give any stray rejection a tick to surface before asserting silence.
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  // P1-1 regression: node metadata is the wire — garbage in must 502, not
  // crash the Express handler (or poison subsequent requests).
  it('returns 502 and stays up when the node returns malformed metadata', async () => {
    makeApp(() => Promise.resolve({}));
    const bad = await req(`/files?path=a.md&conversationId=${convoId}`);
    expect(bad.status).toBe(502);
    expect(bad.json()).toEqual({ error: 'malformed node metadata' });
    makeApp();
    const ok = await req(`/files?path=a.md&conversationId=${convoId}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('hello');
  });

  it('403 for a symlink escaping the node roots', async () => {
    const outside = join(hubTmp, 'outside.md');
    writeFileSync(outside, 'hub secret outside roots');
    symlinkSync(outside, join(nodeRoot, 'leak.md'));
    makeApp();
    const res = await req(`/files?path=leak.md&conversationId=${convoId}`);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('hub secret outside roots');
    expect(res.json()).toEqual({ error: 'path not allowed' });
  });

  it('404 for a missing remote file', async () => {
    makeApp();
    const res = await req(`/files?path=missing.md&conversationId=${convoId}`);
    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'file not found' });
  });

  it('403 for a secret path on the node', async () => {
    makeApp();
    const res = await req(`/files?path=.env&conversationId=${convoId}`);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('SECRET_ENV');
    expect(res.json()).toEqual({ error: 'path not allowed' });
  });

  it('absolute hub path with a remote convo goes to the node and is jailed', async () => {
    const hubFile = join(hubTmp, 'hub-only.md');
    writeFileSync(hubFile, 'HUB_ONLY_CONTENT');
    makeApp();
    const res = await req(`/files?path=${encodeURIComponent(hubFile)}&conversationId=${convoId}`);
    expect(res.status).toBe(403);
    expect(String(res.body)).not.toContain('HUB_ONLY_CONTENT');
  });

  it('503 when the host link is disconnected, and 503 without a nodeHub', async () => {
    makeApp(() => Promise.reject(new RpcError('host_disconnected', 'x')));
    const read = await req(`/files?path=a.md&conversationId=${convoId}`);
    expect(read.status).toBe(503);
    expect(read.json()).toEqual({ error: 'remote host not connected' });
    const list = await req(`/files/list?projectId=${projectId}`);
    expect(list.status).toBe(503);
    expect(list.json()).toEqual({ error: 'remote host not connected' });

    app = express();
    app.use(express.json({ limit: '25mb' }));
    registerFileRoutes(app, () => db, { dataDir });
    const noHubRead = await req(`/files?path=a.md&conversationId=${convoId}`);
    expect(noHubRead.status).toBe(503);
    expect(noHubRead.json()).toEqual({ error: 'remote host not connected' });
    const noHubList = await req(`/files/list?projectId=${projectId}`);
    expect(noHubList.status).toBe(503);
    expect(noHubList.json()).toEqual({ error: 'remote host not connected' });
  });

  it('409 when the file changes between the metadata and data calls', async () => {
    const nodePath = join(nodeRoot, 'a.md');
    makeApp((_m, p) => {
      const q = p as { length?: number };
      if (q.length === undefined) {
        return { path: nodePath, size: 8, mtimeMs: 1, data: '' };
      }
      return { path: nodePath, size: 8, mtimeMs: 2, data: Buffer.from('12345678').toString('base64') };
    });
    const res = await req(`/files?path=a.md&conversationId=${convoId}`);
    expect(res.status).toBe(409);
    expect(res.json()).toEqual({ error: 'file changed during read' });
  });

  it('413 when the node reports too_large', async () => {
    makeApp(() => Promise.reject(new RpcError('too_large', 'big')));
    const res = await req(`/files?path=a.md&conversationId=${convoId}`);
    expect(res.status).toBe(413);
    expect(res.json()).toEqual({ error: 'file too large for remote view' });
  });

  it('zero-byte remote file serves 200 with content-length 0 and one call', async () => {
    write('empty.txt', '');
    const calls = makeApp();
    const res = await req(`/files?path=empty.txt&conversationId=${convoId}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-length']).toBe('0');
    expect(calls).toHaveLength(1);
    expect(calls[0].p.length).toBeUndefined();
  });

  it('409 when a chunk returns short bytes (no retry loop)', async () => {
    let dataCalls = 0;
    const nodePath = join(nodeRoot, 'a.md');
    makeApp((_m, p) => {
      const q = p as { length?: number };
      if (q.length === undefined) {
        return { path: nodePath, size: 5, mtimeMs: 7, data: '' };
      }
      dataCalls++;
      // Short: client asked for 5, node "returned" 2.
      return { path: nodePath, size: 5, mtimeMs: 7, data: Buffer.alloc(2, 0x61).toString('base64') };
    });
    const res = await req(`/files?path=a.md&conversationId=${convoId}`);
    expect(res.status).toBe(409);
    expect(res.json()).toEqual({ error: 'file changed during read' });
    expect(dataCalls).toBe(1);
  });

  it('remote svg is sandboxed, and download=1 keeps the sandbox', async () => {
    write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    makeApp();
    const view = await req(`/files?path=icon.svg&conversationId=${convoId}`);
    expect(view.status).toBe(200);
    expect(view.headers['content-type']).toBe('image/svg+xml');
    expect(view.headers['content-security-policy']).toBe('sandbox');
    expect(view.headers['x-content-type-options']).toBe('nosniff');
    expect(view.headers['content-disposition']).toBe('inline; filename="icon.svg"');
    const dl = await req(`/files?path=icon.svg&conversationId=${convoId}&download=1`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['content-security-policy']).toBe('sandbox');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves a hub attachment shard locally with zero link calls', async () => {
    const shardDir = join(dataDir, 'attachments', convoId);
    mkdirSync(shardDir, { recursive: true });
    const shard = join(shardDir, 'x.png');
    writeFileSync(shard, Buffer.from([1, 2, 3, 4]));
    const calls = makeApp();
    const res = await req(`/files?path=${encodeURIComponent(shard)}&conversationId=${convoId}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body, 'utf8').equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  async function postRestore(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const restore = await fetch(`http://127.0.0.1:${port}/files/git-restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await restore.text();
      let json: unknown = text;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      return { status: restore.status, json };
    } finally {
      server.close();
    }
  }

  describe('git-diff on a real node repo', () => {
    let repoRoot: string;

    beforeEach(() => {
      rmSync(join(nodeRoot, '.git'), { recursive: true, force: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: nodeRoot });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: nodeRoot });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: nodeRoot });
      writeFileSync(join(nodeRoot, 'a.md'), 'orig\n');
      execFileSync('git', ['add', 'a.md'], { cwd: nodeRoot });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: nodeRoot });
      repoRoot = nodeRoot;
    });

    it('git-diff: modified tracked file diffs on the node', async () => {
      writeFileSync(join(repoRoot, 'a.md'), 'changed\n');
      makeApp();
      const r = await req(`/files/git-diff?conversationId=${convoId}&path=a.md`);
      expect(r.status).toBe(200);
      expect(r.json()).toMatchObject({ modified: true, isTracked: true, diff: expect.stringContaining('+changed') });
    });

    it('git-diff: strips :line from editor paths', async () => {
      writeFileSync(join(repoRoot, 'a.md'), 'changed\n');
      makeApp();
      const r = await req(`/files/git-diff?conversationId=${convoId}&path=a.md:3`);
      expect(r.status).toBe(200);
      expect(r.json()).toMatchObject({ modified: true, isTracked: true, diff: expect.stringContaining('+changed') });
    });

    it('git-diff: ../ escape → 403, .env → 403, missing → 404', async () => {
      writeFileSync(join(repoRoot, '.env'), 'X=1');
      const outside = join(repoRoot, '..', 'escape.txt');
      writeFileSync(outside, 'x');
      extraDirs.push(outside);
      makeApp();
      expect((await req(`/files/git-diff?conversationId=${convoId}&path=${encodeURIComponent('../escape.txt')}`)).status).toBe(403);
      expect((await req(`/files/git-diff?conversationId=${convoId}&path=.env`)).status).toBe(403);
      expect((await req(`/files/git-diff?conversationId=${convoId}&path=missing.md`)).status).toBe(404);
    });

    it('git-diff: host_disconnected → 503', async () => {
      makeApp(async () => { throw new RpcError('host_disconnected', 'x'); });
      expect((await req(`/files/git-diff?conversationId=${convoId}&path=a.md`)).status).toBe(503);
    });

    it('git-restore restores a modified tracked file on the node', async () => {
      writeFileSync(join(nodeRoot, 'a.md'), 'changed\n');
      makeApp();
      const r = await postRestore({ projectId, path: 'a.md:3' });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ action: 'restored' });
      expect(readFileSync(join(nodeRoot, 'a.md'), 'utf8')).toBe('orig\n');
    });

    it('git-restore deletes a file absent from HEAD', async () => {
      writeFileSync(join(nodeRoot, 'new.txt'), 'x');
      makeApp();
      const r = await postRestore({ projectId, path: 'new.txt' });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ action: 'deleted' });
      expect(existsSync(join(nodeRoot, 'new.txt'))).toBe(false);
    });

    it('git-restore outside roots / .git path → 403, nothing changed', async () => {
      writeFileSync(join(nodeRoot, 'a.md'), 'changed\n');
      const sibling = tmpDir('tierwyn-restore-sib-');
      writeFileSync(join(sibling, 'f'), 'keep');
      makeApp();
      expect((await postRestore({ projectId, path: `../${sibling.split('/').pop()}/f` })).status).toBe(403);
      expect((await postRestore({ projectId, path: '.git/config' })).status).toBe(403);
      expect((await postRestore({ projectId, path: '../nope' })).status).toBe(404);
      expect(readFileSync(join(nodeRoot, 'a.md'), 'utf8')).toBe('changed\n');
    });

    it('git-restore → 409 while a remote agent is live on the checkout', async () => {
      writeFileSync(join(nodeRoot, 'a.md'), 'changed\n');
      const sessions = [{
        conversationId: convoId,
        lastStatus: 'running' as const,
        steerQueue: [],
        steerOrigin: { cwd: nodeRoot },
      } as unknown as SessionRecord];
      makeApp(undefined, sessions);
      const r = await postRestore({ conversationId: convoId, path: 'a.md' });
      expect(r.status).toBe(409);
      expect((r.json as { error: string }).error).toMatch(/agent\(s\) active/);
      expect(readFileSync(join(nodeRoot, 'a.md'), 'utf8')).toBe('changed\n');
    });

    it('git-restore host disconnected → 503', async () => {
      makeApp(async () => { throw new RpcError('host_disconnected', 'x'); });
      const r = await postRestore({ projectId, path: 'a.md' });
      expect(r.status).toBe(503);
    });
  });

  function putFile(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    return fetch(`http://127.0.0.1:${port}/files`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) as any }))
      .finally(() => server.close());
  }

  describe('remote file save (P3 files.write)', () => {
    beforeEach(() => {
      updateGeneralSettings(db, { fileEditsEnabled: true });
      saveHello(db, hostId, {
        protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
        homedir: nodeRoot, roots: [nodeRoot], listenPort: 0, agents: {},
        features: ['tunnel.stream', 'files.write'],
      }, Date.now());
    });

    it('PUT saves a remote file via files.write', async () => {
      const p = join(nodeRoot, 'a.md');
      writeFileSync(p, 'hello');
      const before = versionToken(statSync(p));
      const calls = makeApp();
      const r = await putFile({ conversationId: convoId, path: 'a.md', content: 'hello2\n', version: before });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ path: realpathSync(p), version: versionToken(statSync(p)) });
      expect(r.json.version).not.toBe(before);
      expect(readFileSync(p, 'utf8')).toBe('hello2\n');
      expect(calls.map((c) => c.m)).toEqual(['files.write']);
    });

    it('PUT stale version → 409 with currentVersion, file untouched', async () => {
      const p = join(nodeRoot, 'a.md');
      writeFileSync(p, 'v1');
      makeApp();
      const r = await putFile({ conversationId: convoId, path: 'a.md', content: 'v2', version: '1-1' });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('file has changed');
      expect(r.json.currentVersion).toBe(versionToken(statSync(p)));
      expect(readFileSync(p, 'utf8')).toBe('v1');
    });

    it('PUT → 409 while a remote agent is live on the checkout', async () => {
      rmSync(join(nodeRoot, '.git'), { recursive: true, force: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: nodeRoot });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: nodeRoot });
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: nodeRoot });
      writeFileSync(join(nodeRoot, 'a.md'), 'hello');
      execFileSync('git', ['add', 'a.md'], { cwd: nodeRoot });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: nodeRoot });
      const sessions = [{
        conversationId: convoId,
        lastStatus: 'running' as const,
        steerQueue: [],
        steerOrigin: { cwd: nodeRoot },
      } as unknown as SessionRecord];
      makeApp(undefined, sessions);
      const p = join(nodeRoot, 'a.md');
      const r = await putFile({
        conversationId: convoId, path: 'a.md', content: 'x', version: versionToken(statSync(p)),
      });
      expect(r.status).toBe(409);
      expect((r.json as { error: string }).error).toMatch(/agent\(s\) active/);
      expect(readFileSync(p, 'utf8')).toBe('hello');
    });

    it('PUT .git path → 403 not allowed', async () => {
      writeFileSync(join(nodeRoot, 'a.md'), 'v1');
      makeApp();
      const r = await putFile({ conversationId: convoId, path: '.git/config', content: 'x', version: '1-1' });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('path not allowed');
    });

    it('PUT → 403 when file edits are disabled, no RPC issued', async () => {
      updateGeneralSettings(db, { fileEditsEnabled: false });
      writeFileSync(join(nodeRoot, 'a.md'), 'v1');
      const calls = makeApp();
      const r = await putFile({ conversationId: convoId, path: 'a.md', content: 'x', version: '1-1' });
      expect(r.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(readFileSync(join(nodeRoot, 'a.md'), 'utf8')).toBe('v1');
    });

    it('PUT → 501 when the host does not advertise files.write', async () => {
      saveHello(db, hostId, {
        protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
        homedir: nodeRoot, roots: [nodeRoot], listenPort: 0, agents: {},
        features: ['tunnel.stream'],
      }, Date.now());
      writeFileSync(join(nodeRoot, 'a.md'), 'v1');
      const calls = makeApp();
      const r = await putFile({ conversationId: convoId, path: 'a.md', content: 'x', version: '1-1' });
      expect(r.status).toBe(501);
      expect(r.json.error).toBe('remote host needs update');
      expect(calls).toHaveLength(0);
      expect(readFileSync(join(nodeRoot, 'a.md'), 'utf8')).toBe('v1');
    });

    it('GET advertises X-Tierwyn-File-Writable: 1 for allowed remote paths', async () => {
      writeFileSync(join(nodeRoot, 'a.md'), 'hello');
      makeApp();
      const r = await req(`/files?conversationId=${convoId}&path=a.md`);
      expect(r.status).toBe(200);
      expect(r.headers['x-tierwyn-file-writable']).toBe('1');
    });

    it('GET advertises writable=0 for dotfiles and hosts without files.write', async () => {
      writeFileSync(join(nodeRoot, 'a.md'), 'hello');
      writeFileSync(join(nodeRoot, '.hidden.md'), 'X=1');
      makeApp();
      expect((await req(`/files?conversationId=${convoId}&path=.hidden.md`)).headers['x-tierwyn-file-writable']).toBe('0');
      saveHello(db, hostId, {
        protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
        homedir: nodeRoot, roots: [nodeRoot], listenPort: 0, agents: {},
        features: ['tunnel.stream'],
      }, Date.now());
      expect((await req(`/files?conversationId=${convoId}&path=a.md`)).headers['x-tierwyn-file-writable']).toBe('0');
    });
  });
});
