import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { GIT_MUTATION_METHODS } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost, saveHello } from '../repositories/remoteHosts.js';
import { seedDefaultSettings } from '../db/seed.js';
import { updateSidecarLlmSettings } from '../repositories/settings.js';
import { sidecarDeps } from '../sidecar.js';
import { commitMessageDeps } from '../commitMessage.js';
import { registerGitWorkingTreeRoutes } from './gitWorkingTree.js';
import { NodeRuntime } from '../node/runtime.js';
import { memoryPair, RpcError, RpcPeer } from '../node/rpc.js';
import type { GitNodeHub } from '../git/remoteOps.js';
import type { SessionRecord } from '../sessionManager.js';

describe('remote git working-tree routes (P2b-2/3)', () => {
  let db: Db;
  let nodeRoot: string;
  let extraDirs: string[];
  let hubPeer: RpcPeer;
  let hostId: string;
  let projectId: string;
  let app: express.Express;
  let mainSha: string;
  let featSha: string;

  function tmpDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    extraDirs.push(d);
    return d;
  }

  interface Resp {
    status: number;
    json: () => unknown;
  }

  async function req(path: string, init: { method?: string; body?: unknown } = {}): Promise<Resp> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: init.method ?? 'GET',
        headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const text = await r.text();
      return {
        status: r.status,
        json: () => JSON.parse(text) as unknown,
      };
    } finally {
      server.close();
    }
  }

  type LinkCalls = Array<{ m: string; p: Record<string, unknown> }>;

  function makeApp(
    impl?: (m: string, p: unknown) => Promise<unknown> | undefined,
    sessions: SessionRecord[] = [],
  ): LinkCalls {
    const calls: LinkCalls = [];
    const nodeHub: GitNodeHub = {
      link: () => ({
        request: async <T,>(m: string, p?: unknown): Promise<T> => {
          calls.push({ m, p: (p ?? {}) as Record<string, unknown> });
          if (impl) {
            const over = impl(m, p);
            if (over !== undefined) {
              const v = await over;
              if (v !== undefined) return v as T;
            }
          }
          return hubPeer.request<T>(m, p);
        },
      }),
    };
    app = express();
    app.use(express.json());
    registerGitWorkingTreeRoutes(app, {
      getDb: () => db,
      getActiveSessions: () => sessions,
      nodeHub,
    });
    return calls;
  }

  beforeEach(() => {
    extraDirs = [];
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    nodeRoot = tmpDir('tierwyn-gwt-rem-');
    execFileSync('git', ['init', '-b', 'main'], { cwd: nodeRoot });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: nodeRoot });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: nodeRoot });
    writeFileSync(join(nodeRoot, 'a.txt'), 'orig\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: nodeRoot });
    execFileSync('git', ['commit', '-m', 'one'], { cwd: nodeRoot });
    writeFileSync(join(nodeRoot, 'a.txt'), 'two\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: nodeRoot });
    execFileSync('git', ['commit', '-m', 'two'], { cwd: nodeRoot });
    mainSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: nodeRoot, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-b', 'feat'], { cwd: nodeRoot });
    writeFileSync(join(nodeRoot, 'b.txt'), 'feat\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: nodeRoot });
    execFileSync('git', ['commit', '-m', 'feat'], { cwd: nodeRoot });
    featSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: nodeRoot, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', 'main'], { cwd: nodeRoot });
    writeFileSync(join(nodeRoot, 'a.txt'), 'changed\n');

    const [hubT, nodeT] = memoryPair();
    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters'); },
      has: () => false,
      policy: { roots: [nodeRoot], allowedAgents: [], maxSessions: 4 },
    });
    const nodePeer = new RpcPeer(nodeT, runtime.handlers());
    hubPeer = new RpcPeer(hubT, {});
    void nodePeer;

    hostId = createPendingHost(db, 'box', 'b', Date.now() + 60_000).id;
    projectId = createProject(db, { name: 'remote', rootPath: nodeRoot, remoteHostId: hostId }).id;
  });

  afterEach(() => {
    for (const d of extraDirs.splice(0).reverse()) rmSync(d, { recursive: true, force: true });
    db.close();
  });

  const readPaths = () => [
    `/files/working-tree?projectId=${projectId}`,
    `/files/git-history?projectId=${projectId}`,
    `/files/git-branches?projectId=${projectId}`,
    `/files/git-branch-diff?projectId=${projectId}&base=main&target=feat`,
    `/files/git-branch-diff/file?projectId=${projectId}&from=${mainSha}&to=${featSha}&path=b.txt`,
    `/files/git-history/commit?projectId=${projectId}&sha=${mainSha}`,
    `/files/git-history/diff?projectId=${projectId}&sha=${mainSha}&path=a.txt`,
    `/files/git-history/file?projectId=${projectId}&sha=${mainSha}&path=a.txt`,
  ];

  it('GET /files/working-tree returns remote status + trees', async () => {
    makeApp();
    const r = await req(`/files/working-tree?projectId=${projectId}`);
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ isRepo: true, branch: 'main', unstaged: [expect.objectContaining({ path: 'a.txt' })] });
  });

  it('git-branches, git-history, commit, diff, file, branch-diff, branch-diff/file all 200 for remote', async () => {
    makeApp();
    const branches = await req(`/files/git-branches?projectId=${projectId}`);
    expect(branches.status).toBe(200);
    const b = branches.json() as { branches: Array<{ name: string }> };
    expect(b.branches.map((x) => x.name)).toContain('feat');

    const history = await req(`/files/git-history?projectId=${projectId}`);
    expect(history.status).toBe(200);
    const h = history.json() as { commits: Array<{ sha: string }> };
    expect(h.commits.length).toBe(2);

    const commit = await req(`/files/git-history/commit?projectId=${projectId}&sha=${mainSha}`);
    expect(commit.status).toBe(200);

    const diff = await req(`/files/git-history/diff?projectId=${projectId}&sha=${mainSha}&path=${encodeURIComponent('a.txt')}`);
    expect(diff.status).toBe(200);
    expect((diff.json() as { diff: string }).diff).toContain('+');

    const file = await req(`/files/git-history/file?projectId=${projectId}&sha=${mainSha}&path=${encodeURIComponent('a.txt')}`);
    expect(file.status).toBe(200);
    expect((file.json() as { content: string }).content).toBe('two\n');

    const bd = await req(`/files/git-branch-diff?projectId=${projectId}&base=main&target=feat`);
    expect(bd.status).toBe(200);
    expect(((bd.json() as { files: unknown[] }).files.length)).toBeGreaterThan(0);

    const bdf = await req(`/files/git-branch-diff/file?projectId=${projectId}&from=${mainSha}&to=${featSha}&path=${encodeURIComponent('b.txt')}`);
    expect(bdf.status).toBe(200);
  });

  it('git-history ?ref=unknown → 404; ?ref=--x → 400', async () => {
    makeApp();
    const unknown = await req(`/files/git-history?projectId=${projectId}&ref=unknown`);
    expect(unknown.status).toBe(404);
    const bad = await req(`/files/git-history?projectId=${projectId}&ref=${encodeURIComponent('--x')}`);
    expect(bad.status).toBe(400);
  });

  it('git-history/file path=../x → 403', async () => {
    makeApp();
    const r = await req(`/files/git-history/file?projectId=${projectId}&sha=${mainSha}&path=${encodeURIComponent('../x')}`);
    expect(r.status).toBe(403);
  });

  it('stage → commit over git.call; node repo changes; draft cleared under remote key', async () => {
    makeApp();
    expect((await req('/files/working-tree/stage', { method: 'POST', body: { projectId, cwd: nodeRoot, path: 'a.txt' } })).status).toBe(200);
    await req('/files/working-tree/commit-message', { method: 'PUT', body: { projectId, cwd: nodeRoot, message: 'draft' } });
    const realNodeRoot = realpathSync(nodeRoot);
    expect(db.prepare('SELECT cwd FROM git_commit_drafts').all()).toEqual([{ cwd: `remote:${hostId}:${realNodeRoot}` }]);
    const r = await req('/files/working-tree/commit', { method: 'POST', body: { projectId, cwd: nodeRoot, message: 'm' } });
    expect(r.status).toBe(200);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: nodeRoot, encoding: 'utf8' }).trim()).toBe('m');
    expect(db.prepare('SELECT count(*) n FROM git_commit_drafts').get()).toEqual({ n: 0 });
  });

  it('discard, create-branch, switch-branch, stash, stash-pop, unstage, delete all 200 on the node', async () => {
    makeApp();
    expect((await req('/files/working-tree/discard', { method: 'POST', body: { projectId, cwd: nodeRoot, path: 'a.txt' } })).status).toBe(200);
    expect(readFileSync(join(nodeRoot, 'a.txt'), 'utf8')).toBe('two\n');
    expect((await req('/files/working-tree/create-branch', { method: 'POST', body: { projectId, cwd: nodeRoot, name: 'p2b3' } })).status).toBe(200);
    expect((await req('/files/working-tree/switch-branch', { method: 'POST', body: { projectId, cwd: nodeRoot, branch: 'main' } })).status).toBe(200);
    writeFileSync(join(nodeRoot, 'a.txt'), 'stash-me\n');
    expect((await req('/files/working-tree/stash', { method: 'POST', body: { projectId, cwd: nodeRoot, message: 'm' } })).status).toBe(200);
    expect(readFileSync(join(nodeRoot, 'a.txt'), 'utf8')).toBe('two\n');
    expect((await req('/files/working-tree/stash-pop', { method: 'POST', body: { projectId, cwd: nodeRoot } })).status).toBe(200);
    expect(readFileSync(join(nodeRoot, 'a.txt'), 'utf8')).toBe('stash-me\n');
    writeFileSync(join(nodeRoot, 'a.txt'), 'staged\n');
    expect((await req('/files/working-tree/stage', { method: 'POST', body: { projectId, cwd: nodeRoot, path: 'a.txt' } })).status).toBe(200);
    expect((await req('/files/working-tree/unstage', { method: 'POST', body: { projectId, cwd: nodeRoot, path: 'a.txt' } })).status).toBe(200);
    writeFileSync(join(nodeRoot, 'gone.txt'), 'x');
    expect((await req('/files/working-tree/delete', { method: 'POST', body: { projectId, cwd: nodeRoot, path: 'gone.txt' } })).status).toBe(200);
    expect(existsSync(join(nodeRoot, 'gone.txt'))).toBe(false);
  });

  it('Review Focus 1: live remote agent at symlinked root → 409 on every guarded route, zero mutating git.call', async () => {
    const link = join(nodeRoot, '..', `${projectId}-link`);
    extraDirs.push(link);
    symlinkSync(nodeRoot, link);
    const conv = createConversation(db, { projectId, title: 'live' });
    const sessions = [{
      conversationId: conv.id,
      lastStatus: 'running' as const,
      steerQueue: [],
      steerOrigin: { cwd: link },
    } as unknown as SessionRecord];
    const calls = makeApp(undefined, sessions);
    const guarded = ['stage', 'unstage', 'commit', 'discard', 'delete', 'switch-branch', 'create-branch', 'pull', 'stash', 'stash-pop'];
    for (const p of guarded) {
      const r = await req(`/files/working-tree/${p}`, {
        method: 'POST',
        body: { projectId, cwd: nodeRoot, path: 'a.txt', message: 'm', branch: 'feat', name: 'x' },
      });
      expect(r.status, p).toBe(409);
      expect((r.json() as { error: string }).error).toMatch(/agent\(s\) active/);
    }
    expect(calls.filter((c) => c.m === 'git.call' && GIT_MUTATION_METHODS.includes((c.p as { method?: string }).method as typeof GIT_MUTATION_METHODS[number]))).toHaveLength(0);
  });

  it('Review Focus 2: local session at the same path does not block remote stage', async () => {
    const localProj = createProject(db, { name: 'local-same', rootPath: nodeRoot });
    const localConv = createConversation(db, { projectId: localProj.id, title: 'local' });
    const sessions = [{
      conversationId: localConv.id,
      lastStatus: 'running' as const,
      steerQueue: [],
      steerOrigin: { cwd: nodeRoot },
    } as unknown as SessionRecord];
    makeApp(undefined, sessions);
    expect((await req('/files/working-tree/stage', { method: 'POST', body: { projectId, cwd: nodeRoot, path: 'a.txt' } })).status).toBe(200);
  });

  it('Review Focus 3: mutation with cwd gone on node → 404, root untouched', async () => {
    makeApp();
    const r = await req('/files/working-tree/stage', { method: 'POST', body: { projectId, cwd: join(nodeRoot, '..', 'gone-wt'), path: 'a.txt' } });
    expect(r.status).toBe(404);
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: nodeRoot, encoding: 'utf8' })).toBe('');
  });

  it('Review Focus 4: push host_disconnected → 503; auth stderr → 502 with creds stripped', async () => {
    makeApp(async (m, p) => {
      if (m === 'git.call' && (p as { method?: string }).method === 'pushRemote') {
        throw new RpcError('host_disconnected', 'x');
      }
      return undefined;
    });
    const r = await req('/files/working-tree/push', { method: 'POST', body: { projectId, cwd: nodeRoot } });
    expect(r.status).toBe(503);

    makeApp(async (m, p) => {
      if (m === 'git.call' && (p as { method?: string }).method === 'pushRemote') {
        return { ok: false, kind: 'git', stderr: 'fatal: https://u:p@h/r: auth failed', stdout: '', exitCode: 128 };
      }
      return undefined;
    });
    const r2 = await req('/files/working-tree/push', { method: 'POST', body: { projectId, cwd: nodeRoot } });
    expect(r2.status).toBe(502);
    expect(JSON.stringify(r2.json())).not.toContain('u:p@');
  });

  it('POST commit-message for remote feeds node stagedDiff to the generator', async () => {
    makeApp();
    expect((await req('/files/working-tree/stage', { method: 'POST', body: { projectId, cwd: nodeRoot, path: 'a.txt' } })).status).toBe(200);
    const r = await req('/files/working-tree/commit-message', { method: 'POST', body: { projectId, cwd: nodeRoot } });
    expect(r.status).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/not configured/);
  });

  it('POST commit-message for remote passes remoteHostId to sidecarComplete', async () => {
    makeApp();
    seedDefaultSettings(db);
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent', adapter: 'pi', model: 'm' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    sidecarDeps.createAdapter = (() => ({ oneShot: async () => ({ text: 'x' }) })) as never;
    const orig = commitMessageDeps.sidecarComplete;
    commitMessageDeps.sidecarComplete = vi.fn(async () => 'feat: remote');
    try {
      expect((await req('/files/working-tree/stage', { method: 'POST', body: { projectId, cwd: nodeRoot, path: 'a.txt' } })).status).toBe(200);
      const r = await req('/files/working-tree/commit-message', { method: 'POST', body: { projectId, cwd: nodeRoot } });
      expect(r.status).toBe(200);
      await vi.waitFor(() => expect(commitMessageDeps.sidecarComplete).toHaveBeenCalled());
      expect(vi.mocked(commitMessageDeps.sidecarComplete).mock.calls[0]![3]).toMatchObject({
        cwd: nodeRoot,
        remoteHostId: hostId,
      });
    } finally {
      commitMessageDeps.sidecarComplete = orig;
    }
  });

  it('create-worktree on old node (without git.worktree) → 501 with zero git.call', async () => {
    const calls = makeApp();
    const r = await req('/files/working-tree/create-worktree', {
      method: 'POST',
      body: { projectId, branch: 'feat' },
    });
    expect(r.status).toBe(501);
    expect(calls.filter((c) => c.m === 'git.call')).toHaveLength(0);
  });

  it('create-worktree on git.worktree node → 201 with node cwd when parent is in roots; 400 when outside roots', async () => {
    const parentRoot = tmpDir('tierwyn-gwt-wt-parent-');
    const repoDir = join(parentRoot, 'repo');
    execFileSync('git', ['clone', nodeRoot, repoDir]);
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repoDir });

    const [hubT, nodeT] = memoryPair();
    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters'); },
      has: () => false,
      policy: { roots: [parentRoot], allowedAgents: [], maxSessions: 4 },
    });
    const nodePeer = new RpcPeer(nodeT, runtime.handlers());
    hubPeer = new RpcPeer(hubT, {});
    void nodePeer;

    saveHello(db, hostId, {
      protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
      homedir: parentRoot, roots: [parentRoot], listenPort: 0, agents: {}, models: {}, sessions: [],
      features: ['git.worktree'],
    }, Date.now());
    const wtProj = createProject(db, { name: 'wt-proj', rootPath: repoDir, remoteHostId: hostId });
    makeApp();

    const r = await req('/files/working-tree/create-worktree', {
      method: 'POST',
      body: { projectId: wtProj.id, branch: 'new-wt', newBranch: true },
    });
    expect(r.status).toBe(201);
    expect(r.json()).toEqual({
      ok: true,
      cwd: realpathSync(join(parentRoot, 'repo-new-wt')),
      branch: 'new-wt',
    });

    // When only nodeRoot itself is in roots (from beforeEach), parent is outside roots → 400
    const [hubT2, nodeT2] = memoryPair();
    const runtime2 = new NodeRuntime({
      create: () => { throw new Error('no adapters'); },
      has: () => false,
      policy: { roots: [nodeRoot], allowedAgents: [], maxSessions: 4 },
    });
    const nodePeer2 = new RpcPeer(nodeT2, runtime2.handlers());
    hubPeer = new RpcPeer(hubT2, {});
    void nodePeer2;
    makeApp();
    const r2 = await req('/files/working-tree/create-worktree', {
      method: 'POST',
      body: { projectId, branch: 'esc-wt', newBranch: true },
    });
    expect(r2.status).toBe(400);
    expect((r2.json() as { error: string }).error).toMatch(/outside the host's roots/);
  });

  it('Review Focus 2: host_disconnected on any read → 503', async () => {
    makeApp(async () => { throw new RpcError('host_disconnected', 'x'); });
    for (const path of readPaths()) {
      expect((await req(path)).status, path).toBe(503);
    }
  });

  it('Review Focus 3: node without git.call → 501', async () => {
    makeApp((m) => {
      if (m === 'git.call') return Promise.reject(new RpcError('no_method', 'git.call'));
      return undefined;
    });
    expect((await req(`/files/git-branches?projectId=${projectId}`)).status).toBe(501);
  });

  it('no nodeHub wired → 503 not 500', async () => {
    app = express();
    app.use(express.json());
    registerGitWorkingTreeRoutes(app, { getDb: () => db, getActiveSessions: () => [] });
    const r = await req(`/files/git-branches?projectId=${projectId}`);
    expect(r.status).toBe(503);
  });
});
