import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { createPendingHost, saveHello } from './repositories/remoteHosts.js';
import { appendEvent } from './repositories/events.js';
import { listCheckpoints, createCheckpoint } from './repositories/checkpoints.js';
import { recordAutoCheckpoint, recordPreRestoreCheckpoint } from './checkpointService.js';
import { setCheckpointNodeHub } from './git/checkpointOps.js';
import { NodeRuntime } from './node/runtime.js';
import { memoryPair, RpcPeer } from './node/rpc.js';

function stubNodeHub(root: string) {
  const runtime = new NodeRuntime({
    create: () => { throw new Error('no adapters'); },
    has: () => false,
    policy: { roots: [root], allowedAgents: [], maxSessions: 4 },
  });
  const [hubT, nodeT] = memoryPair();
  new RpcPeer(nodeT, runtime.handlers());
  const hubPeer = new RpcPeer(hubT, {});
  return { link: () => ({ request: (m: string, p?: unknown, t?: number) => hubPeer.request(m, p, t) }) };
}

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'readme.txt'), 'initial');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

function insertSession(db: Db, conversationId: string, id: string) {
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, conversationId, null, null, Date.now(), Date.now());
}

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tierwyn-cs-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('remote-host checkpoints', () => {
  it('records a conversation checkpoint without a hub code snapshot (old node)', async () => {
    const db = freshDb();
    initRepo(root);
    writeFileSync(join(root, 'dirty.txt'), 'uncommitted change');

    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    const project = createProject(db, { name: 'P', rootPath: root, remoteHostId: host.id });
    const conv = createConversation(db, { projectId: project.id, title: 'C' });
    insertSession(db, conv.id, 's1');
    const ev = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'hi' }, sender: 'user', ts: 100, seq: 0 });

    await recordAutoCheckpoint(db, { conversationId: conv.id, sessionId: 's1', eventId: ev.id });
    const auto = listCheckpoints(db, conv.id);
    expect(auto).toHaveLength(1);
    expect(auto[0].codeRef).toBeFalsy();
  });

  it('records a codeRef on a remote host that advertises git.shadow', async () => {
    const db = freshDb();
    initRepo(root);
    writeFileSync(join(root, 'dirty.txt'), 'uncommitted change');

    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    saveHello(db, host.id, {
      protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
      homedir: root, roots: [root], listenPort: 0, agents: {},
      features: ['tunnel.stream', 'git.shadow'],
    }, Date.now());
    const project = createProject(db, { name: 'P', rootPath: root, remoteHostId: host.id });
    const conv = createConversation(db, { projectId: project.id, title: 'C' });
    insertSession(db, conv.id, 's1');
    const ev = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'hi' }, sender: 'user', ts: 100, seq: 0 });

    setCheckpointNodeHub(stubNodeHub(root));
    try {
      await recordAutoCheckpoint(db, { conversationId: conv.id, sessionId: 's1', eventId: ev.id });
    } finally {
      setCheckpointNodeHub(undefined);
    }
    const auto = listCheckpoints(db, conv.id);
    expect(auto).toHaveLength(1);
    expect(auto[0].codeRef).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('recordPreRestoreCheckpoint', () => {
  it('creates a pinned checkpoint with a code_ref when the tree is dirty (code-only restore guard)', async () => {
    const db = freshDb();
    initRepo(root);

    const project = createProject(db, { name: 'P', rootPath: root });
    const conv = createConversation(db, { projectId: project.id, title: 'C' });
    insertSession(db, conv.id, 's1');
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'hi' }, sender: 'user', ts: 100, seq: 0 });

    // Dirty the working tree
    writeFileSync(join(root, 'dirty.txt'), 'uncommitted change');

    const cp = await recordPreRestoreCheckpoint(db, conv.id);
    expect(cp).not.toBeNull();
    expect(cp?.pinned).toBe(true);
    expect(cp?.label).toBe('Before restore');
    expect(cp?.codeRef).toBeTruthy();

    const all = listCheckpoints(db, conv.id);
    expect(all.some((c) => c.id === cp?.id && c.pinned && c.codeRef)).toBe(true);
  });

  it('returns null and creates no checkpoint when the tree is clean', async () => {
    const db = freshDb();
    initRepo(root);

    const project = createProject(db, { name: 'P', rootPath: root });
    const conv = createConversation(db, { projectId: project.id, title: 'C' });
    insertSession(db, conv.id, 's1');
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'hi' }, sender: 'user', ts: 100, seq: 0 });

    // Tree is clean — snapshotCode returns null → checkpoint is deleted
    const cp = await recordPreRestoreCheckpoint(db, conv.id);
    expect(cp).toBeNull();

    const all = listCheckpoints(db, conv.id);
    expect(all.filter((c) => c.label === 'Before restore')).toHaveLength(0);
  });

  it('returns null when there are no events to anchor to', async () => {
    const db = freshDb();
    initRepo(root);

    const project = createProject(db, { name: 'P', rootPath: root });
    const conv = createConversation(db, { projectId: project.id, title: 'C' });
    // No events → latestEventForConversation returns null
    writeFileSync(join(root, 'dirty.txt'), 'change');
    const cp = await recordPreRestoreCheckpoint(db, conv.id);
    expect(cp).toBeNull();
  });

  it('returns null without throwing when the latest event already has a checkpoint (UNIQUE guard)', async () => {
    // Regression: recordAutoCheckpoint fires at every completed turn, so the latest
    // event usually already has a checkpoint. checkpoints.event_id is UNIQUE; without
    // the guard the createCheckpoint INSERT throws and the whole rewind 500s — which
    // on a dirty shared root is the primary restore path.
    const db = freshDb();
    initRepo(root);

    const project = createProject(db, { name: 'P', rootPath: root });
    const conv = createConversation(db, { projectId: project.id, title: 'C' });
    insertSession(db, conv.id, 's1');
    const ev = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'hi' }, sender: 'user', ts: 100, seq: 0 });

    // Pre-existing auto-checkpoint anchored at the latest event (as recordAutoCheckpoint would leave)
    createCheckpoint(db, {
      conversationId: conv.id,
      eventId: ev.id,
      sessionId: 's1',
      kind: 'auto',
      pinned: false,
    });

    writeFileSync(join(root, 'dirty.txt'), 'uncommitted change');

    // Must not throw; returns null. The pre-existing checkpoint is left intact.
    const cp = await recordPreRestoreCheckpoint(db, conv.id);
    expect(cp).toBeNull();

    const all = listCheckpoints(db, conv.id);
    expect(all.filter((c) => c.label === 'Before restore')).toHaveLength(0);
    expect(all).toHaveLength(1); // only the pre-existing auto-checkpoint
  });
});

describe('listCheckpoints turnIndex', () => {
  it('correctly numbers turns across multi-session prompts in a conversation', () => {
    const db = freshDb();
    const project = createProject(db, { name: 'P', rootPath: '/tmp/proj' });
    const conv = createConversation(db, { projectId: project.id, title: 'C' });

    // Turn 1 in session s1
    insertSession(db, conv.id, 's1');
    const p1 = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'first prompt' }, sender: 'user', ts: 100, seq: 0 });
    const cp1 = createCheckpoint(db, {
      conversationId: conv.id,
      eventId: p1.id,
      sessionId: 's1',
      kind: 'auto',
    });

    // Turn 2 in session s2
    insertSession(db, conv.id, 's2');
    const p2 = appendEvent(db, { sessionId: 's2', type: 'prompt', payload: { text: 'second prompt' }, sender: 'user', ts: 200, seq: 0 });
    const cp2 = createCheckpoint(db, {
      conversationId: conv.id,
      eventId: p2.id,
      sessionId: 's2',
      kind: 'auto',
    });

    // Turn 3 in session s3
    insertSession(db, conv.id, 's3');
    const p3 = appendEvent(db, { sessionId: 's3', type: 'prompt', payload: { text: 'third prompt' }, sender: 'user', ts: 300, seq: 0 });
    const cp3 = createCheckpoint(db, {
      conversationId: conv.id,
      eventId: p3.id,
      sessionId: 's3',
      kind: 'auto',
    });

    const list = listCheckpoints(db, conv.id);
    expect(list).toHaveLength(3);
    expect(list[0].turnIndex).toBe(1);
    expect(list[0].promptPreview).toBe('first prompt');
    expect(list[1].turnIndex).toBe(2);
    expect(list[1].promptPreview).toBe('second prompt');
    expect(list[2].turnIndex).toBe(3);
    expect(list[2].promptPreview).toBe('third prompt');
  });
});
