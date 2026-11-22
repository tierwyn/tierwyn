import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync as writeFs } from 'fs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { updateSidecarLlmSettings } from '../repositories/settings.js';
import type { ServerFrame } from '@tierwyn/shared';
import { commitMessageDeps } from '../commitMessage.js';
import { registerGitWorkingTreeRoutes, stripUrlCredentials } from './gitWorkingTree.js';
import type { SessionRecord } from '../sessionManager.js';
import {
  getCommitDraft, setCommitDraft, beginCommitGeneration,
} from '../repositories/gitCommitDrafts.js';
import { sidecarDeps } from '../sidecar.js';

describe('git working tree routes', () => {
  let db: Database.Database;
  let app: express.Express;
  let repo: string;
  let otherRepo: string;
  let projectId: string;
  let conversationId: string;
  let frames: ServerFrame[];
  const origSidecarComplete = commitMessageDeps.sidecarComplete;
  const origCreate = sidecarDeps.createAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    repo = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-repo-'));
    otherRepo = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-other-'));
    for (const dir of [repo, otherRepo]) {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: dir });
      writeFileSync(join(dir, 'base.txt'), 'base');
      execFileSync('git', ['add', 'base.txt'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    }
    const p = createProject(db, { name: 'Test', rootPath: repo });
    projectId = p.id;
    const c = createConversation(db, { projectId, title: 'Chat' });
    conversationId = c.id;

    frames = [];
    app = express();
    app.use(express.json());
    registerGitWorkingTreeRoutes(app, {
      getDb: () => db,
      getActiveSessions: () => [],
      broadcastAll: (frame) => { frames.push(frame); },
    });
  });

  const extraCleanupDirs: string[] = [];

  afterEach(() => {
    commitMessageDeps.sidecarComplete = origSidecarComplete;
    sidecarDeps.createAdapter = origCreate;
    rmSync(repo, { recursive: true, force: true });
    rmSync(otherRepo, { recursive: true, force: true });
    for (const d of extraCleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    extraCleanupDirs.length = 0;
    db.close();
  });

  async function get(path: string) {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      const body = await r.json();
      return { status: r.status, body };
    } finally {
      server.close();
    }
  }

  async function post(path: string, body: unknown) {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      return { status: r.status, body: json };
    } finally {
      server.close();
    }
  }

  async function put(path: string, body: unknown) {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      return { status: r.status, body: json };
    } finally {
      server.close();
    }
  }

  function settle(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  it('remote-host project working-tree GET 503 without nodeHub', async () => {
    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    const remote = createProject(db, { name: 'remote', rootPath: repo, remoteHostId: host.id });
    const res = await get(`/files/working-tree?projectId=${remote.id}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'remote host not connected' });
  });

  it('GET groups dirty files correctly', async () => {
    writeFileSync(join(repo, 'staged.txt'), 's');
    writeFileSync(join(repo, 'unstaged.txt'), 'u');
    execFileSync('git', ['add', 'staged.txt'], { cwd: repo });
    writeFileSync(join(repo, 'new.txt'), 'n');
    writeFileSync(join(repo, 'base.txt'), 'modified');

    const res = await get(`/files/working-tree?projectId=${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.isRepo).toBe(true);
    expect(res.body.staged.map((f: { path: string }) => f.path)).toContain('staged.txt');
    expect(res.body.unstaged.map((f: { path: string }) => f.path)).toContain('new.txt');
    expect(res.body.unstaged.map((f: { path: string }) => f.path)).toContain('base.txt');
    expect(res.body.unstaged.map((f: { path: string }) => f.path)).toContain('unstaged.txt');
  });

  it('stage then GET moves path to staged', async () => {
    writeFileSync(join(repo, 'addme.txt'), 'x');
    const stage = await post('/files/working-tree/stage', {
      cwd: repo, path: 'addme.txt', projectId,
    });
    expect(stage.status).toBe(200);
    const res = await get(`/files/working-tree?projectId=${projectId}`);
    expect(res.body.staged.some((f: { path: string }) => f.path === 'addme.txt')).toBe(true);
  });

  it('unstage returns path to unstaged with file on disk', async () => {
    writeFileSync(join(repo, 'tmp.txt'), 'x');
    execFileSync('git', ['add', 'tmp.txt'], { cwd: repo });
    const un = await post('/files/working-tree/unstage', {
      cwd: repo, path: 'tmp.txt', projectId,
    });
    expect(un.status).toBe(200);
    const res = await get(`/files/working-tree?projectId=${projectId}`);
    expect(res.body.unstaged.some((f: { path: string }) => f.path === 'tmp.txt')).toBe(true);
    expect(res.body.staged.some((f: { path: string }) => f.path === 'tmp.txt')).toBe(false);
  });

  it('stage untracked then unstage leaves ?? on disk', async () => {
    writeFileSync(join(repo, 'fresh.txt'), 'x');
    await post('/files/working-tree/stage', { cwd: repo, path: 'fresh.txt', projectId });
    await post('/files/working-tree/unstage', { cwd: repo, path: 'fresh.txt', projectId });
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(porcelain).toContain('?? fresh.txt');
  });

  it('rejects ../outside.txt with 403', async () => {
    const res = await post('/files/working-tree/stage', {
      cwd: repo, path: '../outside.txt', projectId,
    });
    expect(res.status).toBe(403);
  });

  it('rejects .git/config with 403', async () => {
    const res = await post('/files/working-tree/stage', {
      cwd: repo, path: '.git/config', projectId,
    });
    expect(res.status).toBe(403);
  });

  it('rejects cwd from other git repo with 403', async () => {
    const res = await get(`/files/working-tree?projectId=${projectId}&cwd=${encodeURIComponent(otherRepo)}`);
    expect(res.status).toBe(403);
  });

  it('GET heals a missing conversation workdir and falls back to project root', async () => {
    const wt = join(repo, '..', `${repo.split('/').pop()}-ghost-wt`);
    execFileSync('git', ['worktree', 'add', wt], { cwd: repo });
    const c = createConversation(db, { projectId, title: 'Ghost', workdirPath: wt });
    rmSync(wt, { recursive: true, force: true });

    const res = await get(
      `/files/working-tree?projectId=${projectId}&conversationId=${c.id}&cwd=${encodeURIComponent(wt)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.cwd).toBe(repo);
    expect((res.body.trees as { cwd: string }[]).map((t) => t.cwd)).not.toContain(wt);
    expect(getConversation(db, c.id)?.workdirPath).toBeUndefined();
    expect(getConversation(db, c.id)).toBeDefined();
  });

  it('GET non-git project root returns isRepo false', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-nongit-'));
    const p = createProject(db, { name: 'NoGit', rootPath: nonGit });
    const res = await get(`/files/working-tree?projectId=${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body.isRepo).toBe(false);
    expect(res.body.staged).toEqual([]);
    rmSync(nonGit, { recursive: true, force: true });
  });

  it('POST stage on non-repo returns 400', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-nongit2-'));
    const p = createProject(db, { name: 'NoGit2', rootPath: nonGit });
    const res = await post('/files/working-tree/stage', {
      cwd: nonGit, path: 'x.txt', projectId: p.id,
    });
    expect(res.status).toBe(400);
    rmSync(nonGit, { recursive: true, force: true });
  });

  it('commit staged-only leaves unstaged dirty', async () => {
    writeFileSync(join(repo, 'only.txt'), 's');
    writeFileSync(join(repo, 'left.txt'), 'u');
    execFileSync('git', ['add', 'only.txt'], { cwd: repo });
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const res = await post('/files/working-tree/commit', {
      cwd: repo, message: 'partial', projectId,
    });
    expect(res.status).toBe(200);
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(after).not.toBe(before);
    const show = execFileSync('git', ['show', '--stat', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    expect(show).toContain('only.txt');
    expect(show).not.toContain('left.txt');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status).toContain('left.txt');
  });

  it('commit with empty message returns 400', async () => {
    writeFileSync(join(repo, 'm.txt'), 'x');
    execFileSync('git', ['add', 'm.txt'], { cwd: repo });
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const res = await post('/files/working-tree/commit', {
      cwd: repo, message: '   ', projectId,
    });
    expect(res.status).toBe(400);
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(after).toBe(before);
  });

  it('commit with nothing staged returns 400', async () => {
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const res = await post('/files/working-tree/commit', {
      cwd: repo, message: 'noop', projectId,
    });
    expect(res.status).toBe(400);
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(after).toBe(before);
  });

  it('returns liveAgents for matching active session', async () => {
    const sessions: SessionRecord[] = [{
      id: 's1',
      conversationId,
      agentType: 'claude-code',
      model: 'm',
      profileId: 'p',
      adapter: {} as never,
      startedAt: Date.now(),
      abortController: new AbortController(),
      started: true,
      steerQueue: [],
      injectable: false,
      steerOrigin: {
        projectId, conversationId, agent: 'claude-code', model: 'm', profileId: 'p', cwd: repo,
      },
      lastStatus: 'running',
    }];
    const localApp = express();
    localApp.use(express.json());
    registerGitWorkingTreeRoutes(localApp, { getDb: () => db, getActiveSessions: () => sessions });
    const server = localApp.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files/working-tree?projectId=${projectId}`);
      const body = await r.json();
      expect(body.liveAgents).toHaveLength(1);
      expect(body.liveAgents[0].conversationId).toBe(conversationId);
    } finally {
      server.close();
    }
  });

  it('returns 400 when neither conversationId nor projectId', async () => {
    const res = await get('/files/working-tree');
    expect(res.status).toBe(400);
  });

  it('empty repo stage and commit succeeds as initial commit', async () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-empty-'));
    execFileSync('git', ['init'], { cwd: emptyRepo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: emptyRepo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: emptyRepo });
    writeFileSync(join(emptyRepo, 'first.txt'), 'hello');
    const p = createProject(db, { name: 'Empty', rootPath: emptyRepo });
    const stage = await post('/files/working-tree/stage', {
      cwd: emptyRepo, path: 'first.txt', projectId: p.id,
    });
    expect(stage.status).toBe(200);
    const commit = await post('/files/working-tree/commit', {
      cwd: emptyRepo, message: 'initial', projectId: p.id,
    });
    expect(commit.status).toBe(200);
    expect(commit.body.sha).toBeTruthy();
    const log = execFileSync('git', ['log', '--oneline'], { cwd: emptyRepo, encoding: 'utf8' });
    expect(log).toContain('initial');
    rmSync(emptyRepo, { recursive: true, force: true });
  });

  it('commit refused with unmerged paths on conflicted repo', async () => {
    writeFileSync(join(repo, 'conflict.txt'), 'base');
    execFileSync('git', ['add', 'conflict.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add conflict file'], { cwd: repo });
    const baseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-b', 'side'], { cwd: repo });
    writeFileSync(join(repo, 'conflict.txt'), 'side version');
    execFileSync('git', ['add', 'conflict.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'side change'], { cwd: repo });
    execFileSync('git', ['checkout', baseBranch], { cwd: repo });
    writeFileSync(join(repo, 'conflict.txt'), 'master version');
    execFileSync('git', ['add', 'conflict.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'master change'], { cwd: repo });
    try {
      execFileSync('git', ['merge', 'side'], { cwd: repo });
    } catch {
      // expected merge conflict
    }
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const res = await post('/files/working-tree/commit', {
      cwd: repo, message: 'try merge commit', projectId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('unmerged paths');
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(after).toBe(before);
  });

  it('rejects directory pathspec with 403', async () => {
    mkdirSync(join(repo, 'subdir'));
    const res = await post('/files/working-tree/stage', {
      cwd: repo, path: 'subdir', projectId,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('directory pathspec rejected');
  });

  it('rejects glob pathspec without staging files', async () => {
    writeFileSync(join(repo, 'extra.txt'), 'x');
    const res = await post('/files/working-tree/stage', { cwd: repo, path: '*', projectId });
    expect(res.status).toBe(400);
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(porcelain).not.toMatch(/^A  /m);
    expect(porcelain).toContain('?? extra.txt');
  });

  it('rejects magic pathspec :(top) without staging files', async () => {
    writeFileSync(join(repo, 'magic.txt'), 'x');
    const res = await post('/files/working-tree/stage', { cwd: repo, path: ':(top)', projectId });
    expect(res.status).toBe(400);
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(porcelain).toContain('?? magic.txt');
  });

  it('rejects negation pathspec :!base.txt without staging files', async () => {
    writeFileSync(join(repo, 'neg.txt'), 'x');
    const res = await post('/files/working-tree/stage', { cwd: repo, path: ':!base.txt', projectId });
    expect(res.status).toBe(400);
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(porcelain).toContain('?? neg.txt');
  });

  it('GET returns 400 with git stderr when index is corrupted', async () => {
    writeFs(join(repo, '.git', 'index'), 'GARBAGE');
    const res = await get(`/files/working-tree?projectId=${projectId}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/index/i);
    expect(res.body.error).not.toBe('internal error');
  });

  it('GET survives corrupted index on a linked worktree', async () => {
    const wt = join(repo, '..', `${repo.split('/').pop()}-broken-wt`);
    execFileSync('git', ['worktree', 'add', wt], { cwd: repo });
    createConversation(db, { projectId, title: 'Broken WT', workdirPath: wt });
    const indexPath = execFileSync('git', ['rev-parse', '--git-path', 'index'], { cwd: wt, encoding: 'utf8' }).trim();
    writeFs(isAbsolute(indexPath) ? indexPath : join(wt, indexPath), 'GARBAGE');
    const res = await get(`/files/working-tree?projectId=${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.trees.length).toBeGreaterThanOrEqual(2);
    const wtReal = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: wt, encoding: 'utf8' }).trim();
    const broken = res.body.trees.find((t: { cwd: string; source: string }) => t.cwd === wtReal && t.source === 'conversation');
    expect(broken).toBeTruthy();
    expect(res.body.isRepo).toBe(true);
    expect(res.body.cwd).toBe(repo);
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('GET includes remotes, upstream and ahead/behind counts', async () => {
    const remoteDir = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-remote-'));
    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteDir });
      execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repo });
      execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: repo });

      // Make a local commit to be ahead
      writeFileSync(join(repo, 'ahead.txt'), 'ahead');
      execFileSync('git', ['add', 'ahead.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'ahead commit'], { cwd: repo });

      const res = await get(`/files/working-tree?projectId=${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body.remotes).toHaveLength(1);
      expect(res.body.remotes[0].name).toBe('origin');
      expect(res.body.upstream).toMatch(/^origin\/(master|main)$/);
      expect(res.body.ahead).toBe(1);
      expect(res.body.behind).toBe(0);
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it('POST push successfully pushes to origin', async () => {
    const remoteDir = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-remote2-'));
    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteDir });
      execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repo });

      writeFileSync(join(repo, 'pushed.txt'), 'content');
      execFileSync('git', ['add', 'pushed.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'push test'], { cwd: repo });

      const res = await post('/files/working-tree/push', {
        cwd: repo,
        projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.remote).toBe('origin');

      // Verify remote has the commit
      const remoteCommits = execFileSync('git', ['log', '--oneline'], { cwd: remoteDir, encoding: 'utf8' });
      expect(remoteCommits).toContain('push test');
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it('POST push fails with 400 when no remote configured', async () => {
    const res = await post('/files/working-tree/push', {
      cwd: repo,
      projectId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no remotes configured/i);
  });

  it('POST push fails with 400 on detached HEAD', async () => {
    const remoteDir = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-remote3-'));
    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteDir });
      execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repo });

      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      execFileSync('git', ['checkout', sha], { cwd: repo });

      const res = await post('/files/working-tree/push', {
        cwd: repo,
        projectId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/detached HEAD/i);
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it('POST delete removes untracked file from disk', async () => {
    writeFileSync(join(repo, 'untracked-delete-me.txt'), 'hello');
    const res = await post('/files/working-tree/delete', {
      cwd: repo,
      path: 'untracked-delete-me.txt',
      projectId,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(existsSync(join(repo, 'untracked-delete-me.txt'))).toBe(false);
  });

  it('POST delete refuses to delete tracked modified file', async () => {
    writeFileSync(join(repo, 'base.txt'), 'modified content');
    const res = await post('/files/working-tree/delete', {
      cwd: repo,
      path: 'base.txt',
      projectId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot delete tracked file/i);
    expect(existsSync(join(repo, 'base.txt'))).toBe(true);
  });

  it('registerGitWorkingTreeRoutes is after requireAuth and spawn routes are before', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), '../index.ts');
    const src = readFileSync(indexPath, 'utf8');
    const spawnIdx = src.indexOf('registerSpawnRoutes(app');
    const authIdx = src.indexOf('app.use(requireAuth(authConfig))');
    const gitIdx = src.indexOf('registerGitWorkingTreeRoutes(app');
    expect(spawnIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(gitIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeLessThan(authIdx);
    expect(gitIdx).toBeGreaterThan(authIdx);
  });

  describe('POST /files/working-tree/commit-message', () => {
    function stageOne() {
      writeFileSync(join(repo, 'staged-for-msg.txt'), 'hello');
      execFileSync('git', ['add', 'staged-for-msg.txt'], { cwd: repo });
    }

    function configureCommitAgent() {
      updateSidecarLlmSettings(db, {
        commit: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
      }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
      sidecarDeps.createAdapter = (() => ({ oneShot: async () => ({ text: 'x' }) })) as never;
    }

    it('200 with stubbed sidecar returns generating and persists via broadcast', async () => {
      stageOne();
      configureCommitAgent();
      commitMessageDeps.sidecarComplete = vi.fn(async () => '"feat(x): do a thing."');
      const res = await post('/files/working-tree/commit-message', {
        cwd: repo, projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, generating: true });
      expect(commitMessageDeps.sidecarComplete).toHaveBeenCalled();
      expect(vi.mocked(commitMessageDeps.sidecarComplete).mock.calls[0]![1]).toBe('commit');
      expect(vi.mocked(commitMessageDeps.sidecarComplete).mock.calls[0]![3]).toMatchObject({ cwd: repo });

      await settle();
      expect(getCommitDraft(db, repo)).toEqual({
        message: 'feat(x): do a thing',
        generating: false,
      });
      const draftFrames = frames.filter((f) => f.type === 'git_commit_draft_updated');
      expect(draftFrames).toHaveLength(1);
      expect(draftFrames[0]).toMatchObject({
        type: 'git_commit_draft_updated',
        cwd: repo,
        message: 'feat(x): do a thing',
        generating: false,
      });
      expect('error' in (draftFrames[0] as object) && (draftFrames[0] as { error?: string }).error)
        .toBeFalsy();
    });

    it('400 nothing staged', async () => {
      configureCommitAgent();
      commitMessageDeps.sidecarComplete = vi.fn(async () => 'x');
      const res = await post('/files/working-tree/commit-message', {
        cwd: repo, projectId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/nothing staged/i);
      expect(commitMessageDeps.sidecarComplete).not.toHaveBeenCalled();
    });

    it('400 when the site is disabled', async () => {
      stageOne();
      updateSidecarLlmSettings(db, {
        commit: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3', enabled: false },
      }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
      commitMessageDeps.sidecarComplete = vi.fn(async () => 'x');
      const res = await post('/files/working-tree/commit-message', {
        cwd: repo, projectId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/disabled/i);
      expect(commitMessageDeps.sidecarComplete).not.toHaveBeenCalled();
    });

    it('400 on a non-repo project root', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-norepo-'));
      try {
        const p = createProject(db, { name: 'Bare', rootPath: bare });
        const res = await post('/files/working-tree/commit-message', {
          cwd: bare, projectId: p.id,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not a git repository/i);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('403 for a cwd from another repo', async () => {
      stageOne();
      configureCommitAgent();
      const res = await post('/files/working-tree/commit-message', {
        cwd: otherRepo, projectId,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not a worktree/i);
    });

    it('sidecar failure still returns 200 and broadcasts error on settle', async () => {
      stageOne();
      configureCommitAgent();
      setCommitDraft(db, repo, 'previous draft');
      commitMessageDeps.sidecarComplete = vi.fn(async () => {
        throw new Error('cleanup HTTP 401');
      });
      const res = await post('/files/working-tree/commit-message', {
        cwd: repo, projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, generating: true });

      await settle();
      expect(getCommitDraft(db, repo)).toEqual({
        message: 'previous draft',
        generating: false,
      });
      const draftFrames = frames.filter((f) => f.type === 'git_commit_draft_updated');
      expect(draftFrames).toHaveLength(1);
      expect(draftFrames[0]).toMatchObject({
        type: 'git_commit_draft_updated',
        cwd: repo,
        message: 'previous draft',
        generating: false,
        error: expect.stringMatching(/cleanup HTTP 401/),
      });
    });

    it('GET /files/working-tree carries commitMessageReady', async () => {
      const before = await get(`/files/working-tree?projectId=${projectId}`);
      expect(before.status).toBe(200);
      expect(before.body.commitMessageReady).toBe(false);

      configureCommitAgent();
      const after = await get(`/files/working-tree?projectId=${projectId}`);
      expect(after.status).toBe(200);
      expect(after.body.commitMessageReady).toBe(true);
    });

    it('double-start is idempotent and sidecar runs once', async () => {
      stageOne();
      configureCommitAgent();
      let release!: () => void;
      const held = new Promise<string>((resolve) => { release = () => resolve('feat: held'); });
      commitMessageDeps.sidecarComplete = vi.fn(async () => held);
      const first = await post('/files/working-tree/commit-message', { cwd: repo, projectId });
      const second = await post('/files/working-tree/commit-message', { cwd: repo, projectId });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body).toEqual({ ok: true, generating: true });
      expect(second.body).toEqual({ ok: true, generating: true });
      expect(commitMessageDeps.sidecarComplete).toHaveBeenCalledTimes(1);
      release();
      await settle();
      await settle();
    });

    it('PUT persists and GET reports commitMessage', async () => {
      const putRes = await put('/files/working-tree/commit-message', {
        cwd: repo, projectId, message: 'wip: draft text',
      });
      expect(putRes.status).toBe(200);
      expect(putRes.body).toEqual({ ok: true });
      const getRes = await get(`/files/working-tree?projectId=${projectId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.commitMessage).toBe('wip: draft text');
      expect(getRes.body.commitMessageGenerating).toBe(false);
    });

    it('PUT with empty message clears the text', async () => {
      setCommitDraft(db, repo, 'something');
      const putRes = await put('/files/working-tree/commit-message', {
        cwd: repo, projectId, message: '',
      });
      expect(putRes.status).toBe(200);
      expect(getCommitDraft(db, repo).message).toBe('');
    });

    it('PUT with >64 KiB message returns 400', async () => {
      const huge = 'x'.repeat(65537);
      const putRes = await put('/files/working-tree/commit-message', {
        cwd: repo, projectId, message: huge,
      });
      expect(putRes.status).toBe(400);
      expect(putRes.body.error).toMatch(/too long/i);
    });

    it('PUT with cross-repo cwd returns 403', async () => {
      const putRes = await put('/files/working-tree/commit-message', {
        cwd: otherRepo, projectId, message: 'nope',
      });
      expect(putRes.status).toBe(403);
      expect(putRes.body.error).toMatch(/not a worktree/i);
    });

    it('GET reports commitMessageGenerating while lock held', async () => {
      expect(beginCommitGeneration(db, repo)).toBe(true);
      const res = await get(`/files/working-tree?projectId=${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body.commitMessageGenerating).toBe(true);
    });

    it('POST commit clears the draft row and broadcasts empty', async () => {
      setCommitDraft(db, repo, 'about to commit');
      writeFileSync(join(repo, 'for-commit.txt'), 'x');
      execFileSync('git', ['add', 'for-commit.txt'], { cwd: repo });
      const res = await post('/files/working-tree/commit', {
        cwd: repo, message: 'ship it', projectId,
      });
      expect(res.status).toBe(200);
      expect(getCommitDraft(db, repo)).toEqual({ message: '', generating: false });
      const draftFrames = frames.filter((f) => f.type === 'git_commit_draft_updated');
      expect(draftFrames).toHaveLength(1);
      expect(draftFrames[0]).toMatchObject({
        type: 'git_commit_draft_updated',
        cwd: repo,
        message: '',
        generating: false,
      });
    });

    it('in-flight generate does not resurrect a draft cleared by commit', async () => {
      stageOne();
      configureCommitAgent();
      let release!: () => void;
      const held = new Promise<string>((resolve) => { release = () => resolve('feat: too late'); });
      commitMessageDeps.sidecarComplete = vi.fn(async () => held);

      const genRes = await post('/files/working-tree/commit-message', { cwd: repo, projectId });
      expect(genRes.status).toBe(200);

      // Stage another file so commit has something to ship while generate is held.
      writeFileSync(join(repo, 'for-commit-race.txt'), 'y');
      execFileSync('git', ['add', 'for-commit-race.txt'], { cwd: repo });
      const commitRes = await post('/files/working-tree/commit', {
        cwd: repo, message: 'commit wins', projectId,
      });
      expect(commitRes.status).toBe(200);
      expect(getCommitDraft(db, repo)).toEqual({ message: '', generating: false });

      release();
      await settle();
      await settle();

      expect(getCommitDraft(db, repo)).toEqual({ message: '', generating: false });
      const draftFrames = frames.filter((f) => f.type === 'git_commit_draft_updated');
      // Only the commit-empty frame — settle skipped because the row was gone.
      expect(draftFrames).toHaveLength(1);
      expect(draftFrames[0]).toMatchObject({
        type: 'git_commit_draft_updated',
        cwd: repo,
        message: '',
        generating: false,
      });
    });

    it('POST /files/working-tree/commit-message/cancel clears generating lock and in-flight generate does not overwrite', async () => {
      stageOne();
      configureCommitAgent();
      let release!: () => void;
      const held = new Promise<string>((resolve) => { release = () => resolve('feat: late message'); });
      commitMessageDeps.sidecarComplete = vi.fn(async () => held);

      const genRes = await post('/files/working-tree/commit-message', { cwd: repo, projectId });
      expect(genRes.status).toBe(200);
      expect(getCommitDraft(db, repo).generating).toBe(true);

      const cancelRes = await post('/files/working-tree/commit-message/cancel', { cwd: repo, projectId });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body).toEqual({ ok: true, cancelled: true });
      expect(getCommitDraft(db, repo).generating).toBe(false);

      const cancelFrames = frames.filter((f) => f.type === 'git_commit_draft_updated');
      expect(cancelFrames.at(-1)).toMatchObject({
        type: 'git_commit_draft_updated',
        cwd: repo,
        generating: false,
      });

      release();
      await settle();
      await settle();

      expect(getCommitDraft(db, repo).generating).toBe(false);
      expect(getCommitDraft(db, repo).message).toBe('');
    });

    it('POST /files/working-tree/commit-message/cancel validates cwd', async () => {
      const resNoCwd = await post('/files/working-tree/commit-message/cancel', { projectId });
      expect(resNoCwd.status).toBe(400);

      const resCrossRepo = await post('/files/working-tree/commit-message/cancel', { cwd: otherRepo, projectId });
      expect(resCrossRepo.status).toBe(403);
    });
  });

  describe('POST /files/working-tree/discard and GET /files/git-history*', () => {
    it('discard returns 200 and leaves the file clean', async () => {
      writeFileSync(join(repo, 'base.txt'), 'dirty');
      const res = await post('/files/working-tree/discard', {
        cwd: repo, path: 'base.txt', projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, path: 'base.txt' });
      expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('base');
      const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
      expect(porcelain).toBe('');
    });

    it('discard preserves staged hunks (restores worktree to index, not HEAD)', async () => {
      writeFileSync(join(repo, 'base.txt'), 'v1');
      execFileSync('git', ['add', 'base.txt'], { cwd: repo });
      writeFileSync(join(repo, 'base.txt'), 'v2');
      const res = await post('/files/working-tree/discard', {
        cwd: repo, path: 'base.txt', projectId,
      });
      expect(res.status).toBe(200);
      expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('v1');
      const wt = await get(`/files/working-tree?projectId=${projectId}`);
      expect(wt.body.staged.some((f: { path: string }) => f.path === 'base.txt')).toBe(true);
      expect(wt.body.unstaged.some((f: { path: string }) => f.path === 'base.txt')).toBe(false);
    });

    it('discard on an untracked file returns 400', async () => {
      writeFileSync(join(repo, 'untracked.txt'), 'nope');
      const res = await post('/files/working-tree/discard', {
        cwd: repo, path: 'untracked.txt', projectId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot discard untracked file/i);
      expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
    });

    it('discard rejects path traversal and .git with 403', async () => {
      const outside = await post('/files/working-tree/discard', {
        cwd: repo, path: '../outside.txt', projectId,
      });
      expect(outside.status).toBe(403);
      const gitDir = await post('/files/working-tree/discard', {
        cwd: repo, path: '.git/config', projectId,
      });
      expect(gitDir.status).toBe(403);
    });

    it('discard with cwd from another repo returns 403', async () => {
      writeFileSync(join(otherRepo, 'base.txt'), 'dirty');
      const res = await post('/files/working-tree/discard', {
        cwd: otherRepo, path: 'base.txt', projectId,
      });
      expect(res.status).toBe(403);
    });

    it('history returns commits newest-first and paginates with limit/skip', async () => {
      writeFileSync(join(repo, 'second.txt'), 's');
      execFileSync('git', ['add', 'second.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'second'], { cwd: repo });

      const all = await get(`/files/git-history?projectId=${projectId}`);
      expect(all.status).toBe(200);
      expect(all.body.commits.map((c: { subject: string }) => c.subject)).toEqual(['second', 'init']);
      expect(all.body.hasMore).toBe(false);

      const limited = await get(`/files/git-history?projectId=${projectId}&limit=1`);
      expect(limited.status).toBe(200);
      expect(limited.body.commits).toHaveLength(1);
      expect(limited.body.commits[0].subject).toBe('second');
      expect(limited.body.hasMore).toBe(true);

      const skipped = await get(`/files/git-history?projectId=${projectId}&skip=1&limit=50`);
      expect(skipped.status).toBe(200);
      expect(skipped.body.commits[0].subject).toBe('init');
      expect(skipped.body.hasMore).toBe(false);
    });

    it('history on a repo with no commits returns empty 200', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-empty-hist-'));
      try {
        execFileSync('git', ['init'], { cwd: empty });
        execFileSync('git', ['config', 'user.name', 'test'], { cwd: empty });
        execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: empty });
        const p = createProject(db, { name: 'EmptyHist', rootPath: empty });
        const res = await get(`/files/git-history?projectId=${p.id}`);
        expect(res.status).toBe(200);
        expect(res.body.commits).toEqual([]);
        expect(res.body.hasMore).toBe(false);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it('commit detail includes files, stats, and multi-line body', async () => {
      writeFileSync(join(repo, 'changed.txt'), 'hello\nworld\n');
      execFileSync('git', ['add', 'changed.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-F', '-'], {
        cwd: repo,
        input: 'add changed\n\nmulti-line body\nstill going\n',
      });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      const res = await get(`/files/git-history/commit?projectId=${projectId}&sha=${sha}`);
      expect(res.status).toBe(200);
      expect(res.body.subject).toBe('add changed');
      expect(res.body.body).toContain('multi-line body');
      expect(res.body.body).toContain('still going');
      const changed = res.body.files.find((f: { path: string }) => f.path === 'changed.txt');
      expect(changed).toMatchObject({ path: 'changed.txt', status: 'new' });
      expect(changed.addedLines).toBeGreaterThan(0);
      expect(res.body.stats.filesCount).toBe(res.body.files.length);
    });

    it('commit detail rejects HEAD and flag-like sha with 400', async () => {
      const head = await get(`/files/git-history/commit?projectId=${projectId}&sha=HEAD`);
      expect(head.status).toBe(400);
      expect(head.body.error).toMatch(/invalid sha/i);
      const pack = await get(
        `/files/git-history/commit?projectId=${projectId}&sha=${encodeURIComponent('--upload-pack=x')}`,
      );
      expect(pack.status).toBe(400);
      expect(pack.body.error).toMatch(/invalid sha/i);
    });

    it('diff contains a hunk header and the added line', async () => {
      writeFileSync(join(repo, 'base.txt'), 'base\nadded line\n');
      execFileSync('git', ['add', 'base.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'touch base'], { cwd: repo });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      const res = await get(
        `/files/git-history/diff?projectId=${projectId}&sha=${sha}&path=${encodeURIComponent('base.txt')}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.diff).toContain('@@');
      expect(res.body.diff).toContain('added line');
    });

    it('file returns the committed snapshot, not the dirty worktree', async () => {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      writeFileSync(join(repo, 'base.txt'), 'worktree dirty');
      const res = await get(
        `/files/git-history/file?projectId=${projectId}&sha=${sha}&path=${encodeURIComponent('base.txt')}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('base');
      expect(res.body.content).not.toBe('worktree dirty');
      expect(res.body.binary).toBe(false);
    });

    it('file for a path absent at that sha returns 404', async () => {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      const res = await get(
        `/files/git-history/file?projectId=${projectId}&sha=${sha}&path=${encodeURIComponent('no-such.txt')}`,
      );
      expect(res.status).toBe(404);
    });

    it('commit detail on a merge commit reports isMerge with empty files and zero stats', async () => {
      execFileSync('git', ['checkout', '-b', 'side'], { cwd: repo });
      writeFileSync(join(repo, 'side.txt'), 'side branch');
      execFileSync('git', ['add', 'side.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'commit on side'], { cwd: repo });
      execFileSync('git', ['checkout', 'master'], { cwd: repo });
      writeFileSync(join(repo, 'main.txt'), 'main branch');
      execFileSync('git', ['add', 'main.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'commit on main'], { cwd: repo });
      execFileSync('git', ['merge', '--no-ff', '-m', 'merge side into master', 'side'], { cwd: repo });
      const mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

      const res = await get(`/files/git-history/commit?projectId=${projectId}&sha=${mergeSha}`);
      expect(res.status).toBe(200);
      expect(res.body.isMerge).toBe(true);
      expect(res.body.files).toEqual([]);
      expect(res.body.stats).toEqual({ added: 0, deleted: 0, filesCount: 0 });
    });
  });

  describe('extended git features (T1-T23)', () => {
    function defaultBranchName(): string {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    }

    it('T1: GET /files/git-branches lists locals + origin/x remote, isCurrent on HEAD, excludes origin/HEAD', async () => {
      const defBranch = defaultBranchName();
      const bare = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-bare-t1-'));
      extraCleanupDirs.push(bare);
      execFileSync('git', ['init', '--bare'], { cwd: bare });
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
      execFileSync('git', ['push', '-u', 'origin', defBranch], { cwd: repo });

      const clone = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-clone-t1-'));
      extraCleanupDirs.push(clone);
      execFileSync('git', ['clone', bare, clone]);
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: clone });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: clone });
      execFileSync('git', ['checkout', '-b', 'feat'], { cwd: clone });
      writeFileSync(join(clone, 'feat.txt'), 'f');
      execFileSync('git', ['add', 'feat.txt'], { cwd: clone });
      execFileSync('git', ['commit', '-m', 'feat commit'], { cwd: clone });
      execFileSync('git', ['push', '-u', 'origin', 'feat'], { cwd: clone });

      execFileSync('git', ['fetch', '--all'], { cwd: repo });

      const res = await get(`/files/git-branches?projectId=${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body.current).toBe(defBranch);
      expect(res.body.detached).toBe(false);

      const branches = res.body.branches as Array<{ name: string; isRemote: boolean; isCurrent: boolean }>;
      const local = branches.find((b) => b.name === defBranch && !b.isRemote);
      expect(local).toBeDefined();
      expect(local?.isCurrent).toBe(true);

      const remoteFeat = branches.find((b) => b.name === 'origin/feat' && b.isRemote);
      expect(remoteFeat).toBeDefined();

      const originHead = branches.find((b) => b.name.endsWith('/HEAD'));
      expect(originHead).toBeUndefined();
    });

    it('T2: history ?ref=<other branch> returns that branch commits; working tree HEAD unchanged', async () => {
      const defBranch = defaultBranchName();
      execFileSync('git', ['checkout', '-b', 'side'], { cwd: repo });
      writeFileSync(join(repo, 'side.txt'), 'side content');
      execFileSync('git', ['add', 'side.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'commit on side'], { cwd: repo });
      execFileSync('git', ['checkout', defBranch], { cwd: repo });

      const res = await get(`/files/git-history?projectId=${projectId}&ref=side`);
      expect(res.status).toBe(200);
      expect(res.body.ref).toBe('side');
      expect(res.body.commits.some((c: { subject: string }) => c.subject === 'commit on side')).toBe(true);

      const currentHead = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(currentHead).toBe(defBranch);
    });

    it('T3: history ?ref=--output=/tmp/x -> 400; ?ref=nope -> 404', async () => {
      const bad = await get(`/files/git-history?projectId=${projectId}&ref=${encodeURIComponent('--output=/tmp/x')}`);
      expect(bad.status).toBe(400);

      const notFound = await get(`/files/git-history?projectId=${projectId}&ref=nope`);
      expect(notFound.status).toBe(404);
    });

    it('T4: switch dirty tree -> 409 with exact requirement message; HEAD unchanged', async () => {
      const defBranch = defaultBranchName();
      execFileSync('git', ['branch', 'other'], { cwd: repo });
      writeFileSync(join(repo, 'dirty.txt'), 'dirty');

      const res = await post('/files/working-tree/switch-branch', {
        cwd: repo, branch: 'other', projectId,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Cannot switch branch: working tree has uncommitted changes. Stash or commit first.');

      const currentHead = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(currentHead).toBe(defBranch);
    });

    it('T5: switch with live agent -> 409', async () => {
      execFileSync('git', ['branch', 'other'], { cwd: repo });
      const localApp = express();
      localApp.use(express.json());
      registerGitWorkingTreeRoutes(localApp, {
        getDb: () => db,
        getActiveSessions: () => [{
          id: 's1',
          conversationId,
          agentType: 'claude-code',
          model: 'm',
          createdAt: Date.now(),
          lastStatus: 'running',
          steerQueue: [],
          steerOrigin: { cwd: repo },
        }],
      });

      const server = localApp.listen(0);
      const port = (server.address() as { port: number }).port;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/files/working-tree/switch-branch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: repo, branch: 'other', projectId }),
        });
        expect(r.status).toBe(409);
        const data = await r.json();
        expect(data.error).toMatch(/Cannot switch branch: 1 agent\(s\) active on this checkout/);
      } finally {
        server.close();
      }
    });

    it('T6: switch clean -> 200, rev-parse --abbrev-ref HEAD = target', async () => {
      execFileSync('git', ['branch', 'target-b'], { cwd: repo });
      const res = await post('/files/working-tree/switch-branch', {
        cwd: repo, branch: 'target-b', projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.branch).toBe('target-b');

      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(head).toBe('target-b');
    });

    it('T7: switch origin/feat with no local -> creates tracking local feat', async () => {
      const defBranch = defaultBranchName();
      const bare = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-bare-t7-'));
      extraCleanupDirs.push(bare);
      execFileSync('git', ['init', '--bare'], { cwd: bare });
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
      execFileSync('git', ['push', '-u', 'origin', defBranch], { cwd: repo });

      const clone = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-clone-t7-'));
      extraCleanupDirs.push(clone);
      execFileSync('git', ['clone', bare, clone]);
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: clone });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: clone });
      execFileSync('git', ['checkout', '-b', 'remote-feat'], { cwd: clone });
      writeFileSync(join(clone, 'rf.txt'), 'rf');
      execFileSync('git', ['add', 'rf.txt'], { cwd: clone });
      execFileSync('git', ['commit', '-m', 'remote feat commit'], { cwd: clone });
      execFileSync('git', ['push', '-u', 'origin', 'remote-feat'], { cwd: clone });

      execFileSync('git', ['fetch', '--all'], { cwd: repo });

      const res = await post('/files/working-tree/switch-branch', {
        cwd: repo, branch: 'origin/remote-feat', projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body.branch).toBe('remote-feat');

      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(head).toBe('remote-feat');

      const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(upstream).toBe('origin/remote-feat');
    });

    it('T8: create-branch -> 200 + checked out; duplicate -> 409; -x / a..b -> 400', async () => {
      const res = await post('/files/working-tree/create-branch', {
        cwd: repo, name: 'brand-new', projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body.branch).toBe('brand-new');
      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(head).toBe('brand-new');

      const dup = await post('/files/working-tree/create-branch', {
        cwd: repo, name: 'brand-new', projectId,
      });
      expect(dup.status).toBe(409);

      const flag = await post('/files/working-tree/create-branch', {
        cwd: repo, name: '-x', projectId,
      });
      expect(flag.status).toBe(400);

      const dots = await post('/files/working-tree/create-branch', {
        cwd: repo, name: 'a..b', projectId,
      });
      expect(dots.status).toBe(400);
    });

    it('T9: fetch updates behind after upstream commit pushed from clone', async () => {
      const defBranch = defaultBranchName();
      const bare = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-bare-t9-'));
      extraCleanupDirs.push(bare);
      execFileSync('git', ['init', '--bare'], { cwd: bare });
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
      execFileSync('git', ['push', '-u', 'origin', defBranch], { cwd: repo });

      const clone = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-clone-t9-'));
      extraCleanupDirs.push(clone);
      execFileSync('git', ['clone', bare, clone]);
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: clone });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: clone });
      writeFileSync(join(clone, 'up.txt'), 'up');
      execFileSync('git', ['add', 'up.txt'], { cwd: clone });
      execFileSync('git', ['commit', '-m', 'upstream change'], { cwd: clone });
      execFileSync('git', ['push', 'origin', defBranch], { cwd: clone });

      const res = await post('/files/working-tree/fetch', { cwd: repo, projectId });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.behind).toBe(1);
    });

    it('T10: pull ff -> 200, behind 0', async () => {
      const defBranch = defaultBranchName();
      const bare = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-bare-t10-'));
      extraCleanupDirs.push(bare);
      execFileSync('git', ['init', '--bare'], { cwd: bare });
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
      execFileSync('git', ['push', '-u', 'origin', defBranch], { cwd: repo });

      const clone = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-clone-t10-'));
      extraCleanupDirs.push(clone);
      execFileSync('git', ['clone', bare, clone]);
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: clone });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: clone });
      writeFileSync(join(clone, 'up10.txt'), 'up10');
      execFileSync('git', ['add', 'up10.txt'], { cwd: clone });
      execFileSync('git', ['commit', '-m', 'upstream change 10'], { cwd: clone });
      execFileSync('git', ['push', 'origin', defBranch], { cwd: clone });

      execFileSync('git', ['fetch', 'origin'], { cwd: repo });

      const res = await post('/files/working-tree/pull', { cwd: repo, projectId });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.behind).toBe(0);
      expect(existsSync(join(repo, 'up10.txt'))).toBe(true);
    });

    it('T11: diverged (local commit + upstream commit) -> 409 exact FF message, HEAD unchanged', async () => {
      const defBranch = defaultBranchName();
      const bare = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-bare-t11-'));
      extraCleanupDirs.push(bare);
      execFileSync('git', ['init', '--bare'], { cwd: bare });
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
      execFileSync('git', ['push', '-u', 'origin', defBranch], { cwd: repo });

      const clone = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-clone-t11-'));
      extraCleanupDirs.push(clone);
      execFileSync('git', ['clone', bare, clone]);
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: clone });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: clone });
      writeFileSync(join(clone, 'clone.txt'), 'c');
      execFileSync('git', ['add', 'clone.txt'], { cwd: clone });
      execFileSync('git', ['commit', '-m', 'clone commit'], { cwd: clone });
      execFileSync('git', ['push', 'origin', defBranch], { cwd: clone });

      writeFileSync(join(repo, 'local.txt'), 'l');
      execFileSync('git', ['add', 'local.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'local commit'], { cwd: repo });
      const localSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

      execFileSync('git', ['fetch', 'origin'], { cwd: repo });

      const res = await post('/files/working-tree/pull', { cwd: repo, projectId });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Fast-forward pull not possible: branch has diverged. Rebase or merge via terminal or agent.');

      const afterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(afterSha).toBe(localSha);
    });

    it('T12: pull with no upstream -> 400; fetch with no remotes -> 400', async () => {
      const fetchRes = await post('/files/working-tree/fetch', { cwd: repo, projectId });
      expect(fetchRes.status).toBe(400);
      expect(fetchRes.body.error).toBe('no remotes configured');

      const pullRes = await post('/files/working-tree/pull', { cwd: repo, projectId });
      expect(pullRes.status).toBe(400);
      expect(pullRes.body.error).toBe('no upstream branch');
    });

    it('T13: stash with untracked file -> tree clean, status stashCount 1, stashTop contains message', async () => {
      writeFileSync(join(repo, 'untracked.txt'), 'secret');
      const res = await post('/files/working-tree/stash', {
        cwd: repo, message: 'my secret stash', projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(existsSync(join(repo, 'untracked.txt'))).toBe(false);

      const status = await get(`/files/working-tree?projectId=${projectId}`);
      expect(status.status).toBe(200);
      expect(status.body.stashCount).toBe(1);
      expect(status.body.stashTop).toContain('my secret stash');
    });

    it('T14: stash-pop restores the file, stashCount 0', async () => {
      writeFileSync(join(repo, 'to-pop.txt'), 'pop content');
      await post('/files/working-tree/stash', { cwd: repo, message: 'pop test', projectId });
      expect(existsSync(join(repo, 'to-pop.txt'))).toBe(false);

      const popRes = await post('/files/working-tree/stash-pop', { cwd: repo, projectId });
      expect(popRes.status).toBe(200);
      expect(existsSync(join(repo, 'to-pop.txt'))).toBe(true);

      const status = await get(`/files/working-tree?projectId=${projectId}`);
      expect(status.body.stashCount).toBe(0);
    });

    it('T15: stash on clean tree -> 400; pop with empty stash -> 400', async () => {
      const stashRes = await post('/files/working-tree/stash', { cwd: repo, projectId });
      expect(stashRes.status).toBe(400);
      expect(stashRes.body.error).toBe('nothing to stash');

      const popRes = await post('/files/working-tree/stash-pop', { cwd: repo, projectId });
      expect(popRes.status).toBe(400);
      expect(popRes.body.error).toBe('no stash entries');
    });

    it('T16: stash/pop with live agent -> 409', async () => {
      writeFileSync(join(repo, 'wip.txt'), 'wip');
      const localApp = express();
      localApp.use(express.json());
      registerGitWorkingTreeRoutes(localApp, {
        getDb: () => db,
        getActiveSessions: () => [{
          id: 's1',
          conversationId,
          agentType: 'claude-code',
          model: 'm',
          createdAt: Date.now(),
          lastStatus: 'running',
          steerQueue: [],
          steerOrigin: { cwd: repo },
        }],
      });

      const server = localApp.listen(0);
      const port = (server.address() as { port: number }).port;
      try {
        const stashRes = await fetch(`http://127.0.0.1:${port}/files/working-tree/stash`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: repo, projectId }),
        });
        expect(stashRes.status).toBe(409);

        const popRes = await fetch(`http://127.0.0.1:${port}/files/working-tree/stash-pop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: repo, projectId }),
        });
        expect(popRes.status).toBe(409);
      } finally {
        server.close();
      }
    });

    it('T17: create-worktree newBranch -> 201, dir is sibling of root, appears in GET trees and resolves', async () => {
      const res = await post('/files/working-tree/create-worktree', {
        projectId, branch: 'wt-feature', newBranch: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.branch).toBe('wt-feature');
      const createdCwd = res.body.cwd as string;
      extraCleanupDirs.push(createdCwd);

      expect(dirname(createdCwd)).toBe(dirname(repo));

      const wtStatus = await get(`/files/working-tree?projectId=${projectId}`);
      expect(wtStatus.status).toBe(200);
      expect(wtStatus.body.trees.some((t: { cwd: string }) => t.cwd === createdCwd)).toBe(true);

      const resolveRes = await get(`/files/working-tree?projectId=${projectId}&cwd=${encodeURIComponent(createdCwd)}`);
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.branch).toBe('wt-feature');
    });

    it('T18: folder ../evil / a/b -> 400; existing folder -> 409', async () => {
      const evil = await post('/files/working-tree/create-worktree', {
        projectId, branch: 'b1', newBranch: true, folder: '../evil',
      });
      expect(evil.status).toBe(400);

      const slash = await post('/files/working-tree/create-worktree', {
        projectId, branch: 'b2', newBranch: true, folder: 'a/b',
      });
      expect(slash.status).toBe(400);

      const existingFolder = join(dirname(repo), 'existing-dir');
      mkdirSync(existingFolder, { recursive: true });
      extraCleanupDirs.push(existingFolder);

      const conflict = await post('/files/working-tree/create-worktree', {
        projectId, branch: 'b3', newBranch: true, folder: 'existing-dir',
      });
      expect(conflict.status).toBe(409);
    });

    it('T19: branch already checked out (newBranch:false, current branch) -> 409', async () => {
      const defBranch = defaultBranchName();
      const res = await post('/files/working-tree/create-worktree', {
        projectId, branch: defBranch, newBranch: false,
      });
      expect(res.status).toBe(409);
    });

    it('T20: body projectRoot pointing at otherRepo is ignored (worktree created off project)', async () => {
      const otherParent = mkdtempSync(join(tmpdir(), 'tierwyn-other-parent-'));
      extraCleanupDirs.push(otherParent);
      const foreignRepo = join(otherParent, 'foreign');
      mkdirSync(foreignRepo, { recursive: true });
      execFileSync('git', ['init'], { cwd: foreignRepo });

      const res = await post('/files/working-tree/create-worktree', {
        projectId, branch: 'ignore-root-b', newBranch: true, projectRoot: foreignRepo,
      });
      expect(res.status).toBe(201);
      const createdCwd = res.body.cwd as string;
      extraCleanupDirs.push(createdCwd);

      expect(dirname(createdCwd)).toBe(dirname(repo));
      expect(dirname(createdCwd)).not.toBe(dirname(foreignRepo));

      const repoTrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' });
      expect(repoTrees).toContain(createdCwd);
    });

    it('T21: GET /files/git-branch-diff base=default target=feature lists only feature-side changes', async () => {
      const defBranch = defaultBranchName();
      execFileSync('git', ['checkout', '-b', 'feature-diff'], { cwd: repo });
      writeFileSync(join(repo, 'feat-only.txt'), 'feature change');
      execFileSync('git', ['add', 'feat-only.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'feat commit'], { cwd: repo });

      execFileSync('git', ['checkout', defBranch], { cwd: repo });
      writeFileSync(join(repo, 'base-only.txt'), 'base change after fork');
      execFileSync('git', ['add', 'base-only.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'base commit after fork'], { cwd: repo });

      const res = await get(
        `/files/git-branch-diff?projectId=${projectId}&base=${defBranch}&target=feature-diff`,
      );
      expect(res.status).toBe(200);
      expect(res.body.files.some((f: { path: string }) => f.path === 'feat-only.txt')).toBe(true);
      expect(res.body.files.some((f: { path: string }) => f.path === 'base-only.txt')).toBe(false);
      expect(res.body.mergeBaseSha).toBeDefined();
      expect(res.body.targetSha).toBeDefined();
    });

    it('T22: /git-branch-diff/file with returned shas returns unified diff; non-hex sha -> 400', async () => {
      const defBranch = defaultBranchName();
      execFileSync('git', ['checkout', '-b', 'feat-file'], { cwd: repo });
      writeFileSync(join(repo, 'sample.txt'), 'line 1\nline 2\n');
      execFileSync('git', ['add', 'sample.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'sample commit'], { cwd: repo });
      execFileSync('git', ['checkout', defBranch], { cwd: repo });

      const diffList = await get(
        `/files/git-branch-diff?projectId=${projectId}&base=${defBranch}&target=feat-file`,
      );
      expect(diffList.status).toBe(200);
      const { mergeBaseSha, targetSha } = diffList.body;

      const fileRes = await get(
        `/files/git-branch-diff/file?projectId=${projectId}&from=${mergeBaseSha}&to=${targetSha}&path=sample.txt`,
      );
      expect(fileRes.status).toBe(200);
      expect(fileRes.body.diff).toContain('line 1');

      const badSha = await get(
        `/files/git-branch-diff/file?projectId=${projectId}&from=HEAD&to=${targetSha}&path=sample.txt`,
      );
      expect(badSha.status).toBe(400);
    });

    it('T23: unrelated histories (orphan branch) -> 409 no common ancestor', async () => {
      const defBranch = defaultBranchName();
      execFileSync('git', ['checkout', '--orphan', 'orphan-branch'], { cwd: repo });
      execFileSync('git', ['rm', '-rf', '.'], { cwd: repo });
      writeFileSync(join(repo, 'orphan.txt'), 'orphan');
      execFileSync('git', ['add', 'orphan.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'orphan root'], { cwd: repo });
      execFileSync('git', ['checkout', defBranch], { cwd: repo });

      const res = await get(
        `/files/git-branch-diff?projectId=${projectId}&base=${defBranch}&target=orphan-branch`,
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/no common ancestor/i);
    });

    it('T24: stash-pop conflict returns 409', async () => {
      writeFileSync(join(repo, 'base.txt'), 'version 1');
      execFileSync('git', ['add', 'base.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'base version 1'], { cwd: repo });

      writeFileSync(join(repo, 'base.txt'), 'stash version 2');
      const stashRes = await post('/files/working-tree/stash', { cwd: repo, message: 'stash v2', projectId });
      expect(stashRes.status).toBe(200);

      writeFileSync(join(repo, 'base.txt'), 'conflicting version 3');
      execFileSync('git', ['add', 'base.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'conflicting commit'], { cwd: repo });

      const popRes = await post('/files/working-tree/stash-pop', { cwd: repo, projectId });
      expect(popRes.status).toBe(409);
      expect(popRes.body.error).toMatch(/conflict/i);
    });

    it('T25: mutation with non-existent cwd returns 404 (does not fallback to root)', async () => {
      const nonExistent = join(repo, 'non-existent-subfolder-deleted');
      const res = await post('/files/working-tree/pull', { cwd: nonExistent, projectId });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/does not exist/i);
    });

    it('T26: creating a branch shadowing a remote returns 409', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'tierwyn-gwt-bare-t26-'));
      extraCleanupDirs.push(bare);
      execFileSync('git', ['init', '--bare'], { cwd: bare });
      execFileSync('git', ['remote', 'add', 'upstream-remote', bare], { cwd: repo });

      const res = await post('/files/working-tree/create-branch', {
        cwd: repo,
        name: 'upstream-remote/my-branch',
        projectId,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/shadowing remote/i);
    });

    it('T27: unicode branch name creation works', async () => {
      const res = await post('/files/working-tree/create-branch', {
        cwd: repo,
        name: 'feat/ünicode-café',
        projectId,
      });
      expect(res.status).toBe(200);
      expect(res.body.branch).toBe('feat/ünicode-café');
      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(head).toBe('feat/ünicode-café');
    });

    it('T28: branch containing + creates worktree folder successfully without 400', async () => {
      const res = await post('/files/working-tree/create-worktree', {
        projectId,
        branch: 'feat+plus',
        newBranch: true,
      });
      expect(res.status).toBe(201);
      const createdCwd = res.body.cwd as string;
      extraCleanupDirs.push(createdCwd);
      expect(existsSync(createdCwd)).toBe(true);
      expect(basename(createdCwd)).toMatch(/feat-plus/);
    });
  });
});



describe('stripUrlCredentials', () => {
  it('removes user:token@ from remote URLs echoed by git', () => {
    expect(stripUrlCredentials("fatal: unable to access 'https://user:tok3n@example.com/r.git/': 403"))
      .toBe("fatal: unable to access 'https://example.com/r.git/': 403");
    expect(stripUrlCredentials('no creds here')).toBe('no creds here');
  });
});
