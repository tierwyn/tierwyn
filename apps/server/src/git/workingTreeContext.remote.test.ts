import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { NodeRuntime } from '../node/runtime.js';
import { memoryPair, RpcPeer } from '../node/rpc.js';
import type { SessionRecord } from '../sessionManager.js';
import { localGitOps, RemoteGitOps, type GitNodeHub } from './remoteOps.js';
import {
  collectLiveAgents, collectRemoteLiveAgents, commitDraftKey,
  resolveGitRequest, resolveWorkingTreeRequest,
} from './workingTreeContext.js';

function initRepo(dir: string) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

describe('resolveGitRequest remote', () => {
  let db: Database.Database;
  let jail: string;
  let nodeRoot: string;
  let wtPath: string;
  let otherRepo: string;
  let hostId: string;
  let projectId: string;
  let hub: GitNodeHub;
  let extra: string[];

  beforeEach(() => {
    extra = [];
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);

    jail = mkdtempSync(join(tmpdir(), 'tierwyn-wt-remote-jail-'));
    extra.push(jail);
    nodeRoot = join(jail, 'repo');
    mkdirSync(nodeRoot);
    initRepo(nodeRoot);

    wtPath = join(nodeRoot, 'wt');
    execFileSync('git', ['worktree', 'add', '-b', 'feat', wtPath], { cwd: nodeRoot });

    const nested = join(nodeRoot, 'sub', 'inner');
    mkdirSync(nested, { recursive: true });
    initRepo(nested);

    otherRepo = join(jail, 'other');
    mkdirSync(otherRepo);
    initRepo(otherRepo);

    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters'); },
      has: () => false,
      policy: { roots: [jail], allowedAgents: [], maxSessions: 4 },
    });
    const [hubT, nodeT] = memoryPair();
    const nodePeer = new RpcPeer(nodeT, runtime.handlers());
    const hubPeer = new RpcPeer(hubT, {});
    void nodePeer;
    hub = { link: () => ({ request: (m, p, t) => hubPeer.request(m, p, t) }) };

    hostId = createPendingHost(db, 'box', 'b', Date.now() + 60_000).id;
    projectId = createProject(db, { name: 'remote', rootPath: nodeRoot, remoteHostId: hostId }).id;
  });

  afterEach(() => {
    for (const d of extra.splice(0).reverse()) rmSync(d, { recursive: true, force: true });
    db.close();
  });

  it('local project returns localGitOps and unchanged cwd', async () => {
    const localRoot = join(jail, 'local');
    mkdirSync(localRoot);
    initRepo(localRoot);
    const localProj = createProject(db, { name: 'local', rootPath: localRoot });
    const r = await resolveGitRequest(db, { projectId: localProj.id });
    expect(r.ops).toBe(localGitOps);
    expect(r.remoteHostId).toBe(null);
    expect(r.cwd).toBe(localRoot);
  });

  it('remote: trees = root + worktree + nested; default cwd = root', async () => {
    const r = await resolveGitRequest(db, { projectId }, hub);
    expect(r.remoteHostId).toBe(hostId); expect(r.cwd).toBe(realpathSync(nodeRoot));
    expect(r.trees!.map((t) => t.source).sort()).toEqual(['nested', 'project', 'worktree']);
  });

  it('remote: explicit worktree cwd resolves; foreign dir → 403', async () => {
    expect((await resolveGitRequest(db, { projectId, cwd: wtPath }, hub)).cwd).toBe(realpathSync(wtPath));
    await expect(resolveGitRequest(db, { projectId, cwd: otherRepo }, hub)).rejects.toMatchObject({ status: 403 });
  });

  it('remote: ghost cwd falls back to root', async () => {
    expect((await resolveGitRequest(db, { projectId, cwd: join(nodeRoot, 'gone') }, hub)).cwd).toBe(realpathSync(nodeRoot));
  });

  it('Review Focus 1: conv workdir present on hub disk but statPath says missing → excluded, default = root', async () => {
    const convWorkdir = join(nodeRoot, 'hub-only-wd');
    mkdirSync(convWorkdir);
    const conv = createConversation(db, { projectId, title: 'c', workdirPath: convWorkdir });
    const hubStatMissing: GitNodeHub = {
      link: () => ({
        request: async <T,>(m: string, p?: unknown, t?: number): Promise<T> => {
          if (m === 'fs.statPath' && (p as { path?: string }).path === convWorkdir) {
            return { exists: false, isDir: false, isGitRepo: false, underRoots: false } as T;
          }
          return hub.link(hostId).request<T>(m, p, t);
        },
      }),
    };
    const r = await resolveGitRequest(db, { conversationId: conv.id }, hubStatMissing);
    expect(r.cwd).toBe(realpathSync(nodeRoot));
    expect(r.trees!.some((t) => t.source === 'conversation')).toBe(false);
  });

  it('Review Focus 4: symlinked rootPath → single root entry and cwd=rootPath resolves', async () => {
    const linkPath = join(jail, 'link');
    symlinkSync(nodeRoot, linkPath);
    const linkedProj = createProject(db, { name: 'linked', rootPath: linkPath, remoteHostId: hostId }).id;
    const r = await resolveGitRequest(db, { projectId: linkedProj, cwd: linkPath }, hub);
    expect(r.trees!.filter((t) => t.source === 'project' || t.cwd === realpathSync(nodeRoot))).toHaveLength(1);
    expect(r.cwd).toBe(realpathSync(nodeRoot));
  });

  it('remote without nodeHub → 503', async () => {
    await expect(resolveGitRequest(db, { projectId })).rejects.toMatchObject({ status: 503 });
  });

  it('sync resolveWorkingTreeRequest still 409s remote (mutation boundary)', () => {
    expect(() => resolveWorkingTreeRequest(db, { projectId })).toThrow(/remote-host/);
  });

  function sessAt(conversationId: string, cwd: string, lastStatus: 'running' | 'idle' = 'running') {
    return {
      conversationId,
      lastStatus,
      steerQueue: [],
      steerOrigin: { cwd },
    } as unknown as SessionRecord;
  }

  it('remote session at a symlinked root / subdir matches the real toplevel', async () => {
    const realRepo = realpathSync(nodeRoot);
    const link = join(jail, 'agent-link');
    symlinkSync(nodeRoot, link);
    mkdirSync(join(realRepo, 'agent-sub'), { recursive: true });
    const remoteConv = createConversation(db, { projectId, title: 'remote-agent' });
    const ops = new RemoteGitOps(hub, hostId);
    expect(await collectRemoteLiveAgents(db, hostId, realRepo, ops, [sessAt(remoteConv.id, link)])).toHaveLength(1);
    expect(await collectRemoteLiveAgents(db, hostId, realRepo, ops, [sessAt(remoteConv.id, join(realRepo, 'agent-sub'))])).toHaveLength(1);
  });

  it('ignores sessions on another host and local sessions at the same path', async () => {
    const realRepo = realpathSync(nodeRoot);
    const localProj = createProject(db, { name: 'local-same', rootPath: nodeRoot });
    const localConv = createConversation(db, { projectId: localProj.id, title: 'local' });
    const otherHostId = createPendingHost(db, 'box2', 'b2', Date.now() + 60_000).id;
    const otherProj = createProject(db, { name: 'other-host', rootPath: nodeRoot, remoteHostId: otherHostId });
    const otherHostConv = createConversation(db, { projectId: otherProj.id, title: 'other' });
    const ops = new RemoteGitOps(hub, hostId);
    expect(await collectRemoteLiveAgents(db, hostId, realRepo, ops, [
      sessAt(localConv.id, realRepo),
      sessAt(otherHostConv.id, realRepo),
    ])).toEqual([]);
  });

  it('local collectLiveAgents ignores a remote session at an identical path', () => {
    const realRepo = realpathSync(nodeRoot);
    const remoteConv = createConversation(db, { projectId, title: 'remote-on-path' });
    expect(collectLiveAgents(db, realRepo, [sessAt(remoteConv.id, realRepo)])).toEqual([]);
  });

  it('parked sessions are skipped', async () => {
    const realRepo = realpathSync(nodeRoot);
    const remoteConv = createConversation(db, { projectId, title: 'parked' });
    const ops = new RemoteGitOps(hub, hostId);
    expect(await collectRemoteLiveAgents(db, hostId, realRepo, ops, [
      sessAt(remoteConv.id, realRepo, 'idle'),
    ])).toEqual([]);
  });

  it('I1: broken session with missing or outside-roots cwd does not 403 collectRemoteLiveAgents', async () => {
    const realRepo = realpathSync(nodeRoot);
    const brokenConv = createConversation(db, { projectId, title: 'broken' });
    const validConv = createConversation(db, { projectId, title: 'valid' });
    const ops = new RemoteGitOps(hub, hostId);

    const outsidePath = join(jail, '..', 'gone');
    const missingInsidePath = join(nodeRoot, 'nonexistent');

    const agents = await collectRemoteLiveAgents(db, hostId, realRepo, ops, [
      sessAt(brokenConv.id, outsidePath),
      sessAt(brokenConv.id, missingInsidePath),
      sessAt(validConv.id, realRepo),
    ]);

    expect(agents).toHaveLength(1);
    expect(agents[0].conversationId).toBe(validConv.id);
  });

  it('commitDraftKey separates local and remote', () => {
    expect(commitDraftKey({ cwd: '/p', remoteHostId: null })).toBe('/p');
    expect(commitDraftKey({ cwd: '/p', remoteHostId: 'h1' })).toBe('remote:h1:/p');
  });
});
