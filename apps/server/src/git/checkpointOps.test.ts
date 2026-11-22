import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createPendingHost, saveHello } from '../repositories/remoteHosts.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { NodeRuntime } from '../node/runtime.js';
import { memoryPair, RpcPeer } from '../node/rpc.js';
import { checkpointOpsFor, setCheckpointNodeHub, RemoteShadowOps } from './checkpointOps.js';
import { localShadowOpsFor, type ShadowOps } from './shadowOps.js';

function freshDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('checkpointOpsFor', () => {
  let root: string;
  let repo: string;
  let extra: string[];

  beforeEach(() => {
    extra = [];
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cpops-root-'));
    extra.push(root);
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'orig\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    setCheckpointNodeHub(undefined);
    for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function nodeHubFor(dir: string) {
    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters'); },
      has: () => false,
      policy: { roots: [dir], allowedAgents: [], maxSessions: 4 },
    });
    const [hubT, nodeT] = memoryPair();
    new RpcPeer(nodeT, runtime.handlers());
    const hubPeer = new RpcPeer(hubT, {});
    return { link: () => ({ request: (m: string, p?: unknown, t?: number) => hubPeer.request(m, p, t) }) };
  }

  function seedRemoteProject(opts: { features: string[] }) {
    const db = freshDb();
    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    saveHello(db, host.id, {
      protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
      homedir: root, roots: [root], listenPort: 0, agents: {},
      features: opts.features,
    }, Date.now());
    const project = createProject(db, { name: 'P', rootPath: repo, remoteHostId: host.id });
    const conv = createConversation(db, { projectId: project.id, title: 'C' });
    return { db, hostId: host.id, conversationId: conv.id };
  }

  it('binds remote ops for a host advertising git.shadow', async () => {
    const { db, hostId, conversationId } = seedRemoteProject({ features: ['git.shadow'] });
    setCheckpointNodeHub(nodeHubFor(root));
    const binding = await checkpointOpsFor(db, conversationId);
    expect(binding).not.toBeNull();
    expect(binding!.cwd).toBe(repo);
    expect(binding!.ops).toBeInstanceOf(RemoteShadowOps);

    // End-to-end: snapshot over git.call lands a ref in the node's repo.
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    const sha = await binding!.ops.snapshotCode(conversationId, 'cp-1');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const resolved = execFileSync('git', ['rev-parse', `refs/tierwyn/checkpoints/${conversationId}/cp-1`], { cwd: repo, encoding: 'utf8' }).trim();
    expect(resolved).toBe(sha);
  });

  it('returns null when the host does not advertise git.shadow (old node)', async () => {
    const { db, conversationId } = seedRemoteProject({ features: ['tunnel.stream'] });
    setCheckpointNodeHub(nodeHubFor(root));
    expect(await checkpointOpsFor(db, conversationId)).toBeNull();
  });

  it('returns null when the hub binding is unset', async () => {
    const { db, conversationId } = seedRemoteProject({ features: ['git.shadow'] });
    expect(await checkpointOpsFor(db, conversationId)).toBeNull();
  });

  it('returns null when the host is disconnected (link throws)', async () => {
    const { db, conversationId } = seedRemoteProject({ features: ['git.shadow'] });
    setCheckpointNodeHub({ link: () => { throw new Error('host_disconnected'); } });
    expect(await checkpointOpsFor(db, conversationId)).toBeNull();
  });
});

describe('local vs remote parity', () => {
  let root: string;
  let repo: string;
  let extra: string[];
  let initHead: string;

  beforeEach(() => {
    extra = [];
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cpparity-root-'));
    extra.push(root);
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'orig\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    initHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  });

  afterEach(() => {
    for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('snapshot → diff → restore yields the same tree locally and over git.call', async () => {
    const run = async (ops: ShadowOps) => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      const sha = await ops.snapshotCode('conv-p', 'cp-p');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      writeFileSync(join(repo, 'a.txt'), 'drifted\n');
      const diff = await ops.codeDiff(sha!);
      expect(diff).toContain('drifted');
      await ops.restoreCode(sha!, 'worktree');
      const content = readFileSync(join(repo, 'a.txt'), 'utf8');
      expect(content).toBe('changed\n');
      expect(await ops.resolveShadowRef('conv-p', 'cp-p')).toBe(sha);
      await ops.deleteShadowRef('conv-p', 'cp-p');
      expect(await ops.resolveShadowRef('conv-p', 'cp-p')).toBeNull();
    };

    // Local binding
    await run(localShadowOpsFor(repo));

    // Remote binding over git.call — reset repo state between runs (the local
    // worktree restore moved HEAD to the snapshot commit, which would make the
    // second snapshot a no-op)
    execFileSync('git', ['reset', '--hard', initHead], { cwd: repo });
    const runtime = new NodeRuntime({
      create: () => { throw new Error('no adapters'); },
      has: () => false,
      policy: { roots: [root], allowedAgents: [], maxSessions: 4 },
    });
    const [hubT, nodeT] = memoryPair();
    new RpcPeer(nodeT, runtime.handlers());
    const hubPeer = new RpcPeer(hubT, {});
    const remote = new RemoteShadowOps(
      { link: () => ({ request: (m: string, p?: unknown, t?: number) => hubPeer.request(m, p, t) }) },
      'h',
      repo,
    );
    await run(remote);
  });
});
