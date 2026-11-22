import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost, saveHello } from '../repositories/remoteHosts.js';
import { appendEvent } from '../repositories/events.js';
import { createCheckpoint, getCheckpoint } from '../repositories/checkpoints.js';
import { registerConversationMutationRoutes } from './conversations.js';
import { setCheckpointNodeHub } from '../git/checkpointOps.js';
import { NodeRuntime } from '../node/runtime.js';
import { memoryPair, RpcPeer } from '../node/rpc.js';

function initRepo(dir: string): string {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'readme.txt'), 'initial');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}

function bootRemote(root: string) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
  const project = createProject(db, { name: 'P', rootPath: root, remoteHostId: host.id });
  const conv = createConversation(db, { projectId: project.id, title: 'C' });
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run('s1', conv.id, null, null, Date.now(), Date.now());
  const ev = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'hi' }, sender: 'user', ts: 100, seq: 0 });
  const later = appendEvent(db, { sessionId: 's1', type: 'message', payload: { text: 'later' }, sender: 'assistant', ts: 200, seq: 1 });

  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, {
    getDb: () => db,
    sessionManager: {
      inFlightSessionForConversation: () => undefined,
      reapParkedSessions: async () => {},
    } as never,
  });
  return { db, app, conv, ev, later, host };
}

/** In-process node answering git.call — lets the hub routes exercise git.shadow
 *  end-to-end (the node's repo IS the hub's cwd in this harness). */
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

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('remote-host leftover codeRef does not touch hub git', () => {
  it('409s code-only rewind and leaves the hub working tree alone', async () => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cp-'));
    const head = initRepo(root);
    writeFileSync(join(root, 'sentinel.txt'), 'keep-me');
    const { db, app, conv, ev } = bootRemote(root);
    const cp = createCheckpoint(db, {
      conversationId: conv.id,
      eventId: ev.id,
      sessionId: 's1',
      codeRef: head,
      kind: 'manual',
    });
    expect(cp.codeRef).toBe(head);

    const res = await request(app, 'POST', `/conversations/${conv.id}/rewind`, {
      eventId: ev.id,
      rewindConversation: false,
      rewindCode: true,
      confirmSharedCode: true,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('not available for remote-host projects (P3)');
    expect(readFileSync(join(root, 'sentinel.txt'), 'utf8')).toBe('keep-me');
    expect(existsSync(join(root, 'readme.txt'))).toBe(true);
  });

  it('skips code restore on both-mode rewind with codeSkippedReason remote_host', async () => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cp-'));
    const head = initRepo(root);
    writeFileSync(join(root, 'sentinel.txt'), 'keep-me');
    const { db, app, conv, ev } = bootRemote(root);
    createCheckpoint(db, {
      conversationId: conv.id,
      eventId: ev.id,
      sessionId: 's1',
      codeRef: head,
      kind: 'manual',
    });

    const res = await request(app, 'POST', `/conversations/${conv.id}/rewind`, {
      eventId: ev.id,
      rewindConversation: true,
      rewindCode: true,
      confirmSharedCode: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.codeApplied).toBe(false);
    expect(res.json.codeSkippedReason).toBe('remote_host');
    expect(readFileSync(join(root, 'sentinel.txt'), 'utf8')).toBe('keep-me');
  });

  it('still allows conversation-only rewind on a remote project', async () => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cp-'));
    initRepo(root);
    const { app, conv, ev } = bootRemote(root);
    const res = await request(app, 'POST', `/conversations/${conv.id}/rewind`, {
      eventId: ev.id,
      rewindConversation: true,
      rewindCode: false,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.codeApplied).toBe(false);
  });

  it('409s code-diff without running hub git', async () => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cp-'));
    const head = initRepo(root);
    writeFileSync(join(root, 'dirty.txt'), 'hub-only');
    const { db, app, conv, ev } = bootRemote(root);
    const cp = createCheckpoint(db, {
      conversationId: conv.id,
      eventId: ev.id,
      sessionId: 's1',
      codeRef: head,
      kind: 'manual',
    });
    const res = await request(app, 'GET', `/conversations/${conv.id}/checkpoints/${cp.id}/code-diff`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('not available for remote-host projects (P3)');
  });

  it('deletes the checkpoint row but skips deleteShadowRef', async () => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cp-'));
    const head = initRepo(root);
    const { db, app, conv, ev } = bootRemote(root);
    const cp = createCheckpoint(db, {
      conversationId: conv.id,
      eventId: ev.id,
      sessionId: 's1',
      codeRef: head,
      kind: 'manual',
    });
    const ref = `refs/tierwyn/checkpoints/${conv.id}/${cp.id}`;
    execFileSync('git', ['update-ref', ref, head], { cwd: root });
    expect(execFileSync('git', ['show-ref', '--verify', ref], { cwd: root }).toString()).toContain(head);

    const res = await request(app, 'DELETE', `/conversations/${conv.id}/checkpoints/${cp.id}`);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(getCheckpoint(db, cp.id)).toBeUndefined();
    expect(execFileSync('git', ['show-ref', '--verify', ref], { cwd: root }).toString()).toContain(head);
  });
});

describe('remote-host checkpoints over git.shadow (node answers git.call)', () => {
  it('code-only rewind restores through the node instead of 409', async () => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cp-'));
    const head = initRepo(root);
    const { db, app, conv, ev, host } = bootRemote(root);
    saveHello(db, host.id, {
      protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
      homedir: root, roots: [root], listenPort: 0, agents: {},
      features: ['tunnel.stream', 'git.shadow'],
    }, Date.now());
    createCheckpoint(db, {
      conversationId: conv.id,
      eventId: ev.id,
      sessionId: 's1',
      codeRef: head,
      kind: 'manual',
    });
    // Dirty the hub-side working tree after the checkpoint's snapshot point
    writeFileSync(join(root, 'readme.txt'), 'drifted');

    setCheckpointNodeHub(stubNodeHub(root));
    try {
      const res = await request(app, 'POST', `/conversations/${conv.id}/rewind`, {
        eventId: ev.id,
        rewindConversation: false,
        rewindCode: true,
        confirmSharedCode: true,
      });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.codeApplied).toBe(true);
    } finally {
      setCheckpointNodeHub(undefined);
    }
    expect(readFileSync(join(root, 'readme.txt'), 'utf8')).toBe('initial');
  });

  it('rewind when remote git.call rejects → 5xx, not an unhandled rejection', async () => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cp-'));
    const head = initRepo(root);
    const { db, app, conv, ev, host } = bootRemote(root);
    saveHello(db, host.id, {
      protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
      homedir: root, roots: [root], listenPort: 0, agents: {},
      features: ['tunnel.stream', 'git.shadow'],
    }, Date.now());
    createCheckpoint(db, {
      conversationId: conv.id,
      eventId: ev.id,
      sessionId: 's1',
      codeRef: head,
      kind: 'manual',
    });
    setCheckpointNodeHub({
      link: () => ({
        request: async () => {
          throw Object.assign(new Error('host dropped'), { code: 'host_disconnected' });
        },
      }),
    });
    try {
      const res = await request(app, 'POST', `/conversations/${conv.id}/rewind`, {
        eventId: ev.id,
        rewindConversation: false,
        rewindCode: true,
        confirmSharedCode: true,
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.status).toBeLessThan(600);
      expect(res.json.error).toBeTruthy();
    } finally {
      setCheckpointNodeHub(undefined);
    }
  });

  it('code-diff returns the diff through the node', async () => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-cp-'));
    const head = initRepo(root);
    const { db, app, conv, ev, host } = bootRemote(root);
    saveHello(db, host.id, {
      protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
      homedir: root, roots: [root], listenPort: 0, agents: {},
      features: ['tunnel.stream', 'git.shadow'],
    }, Date.now());
    const cp = createCheckpoint(db, {
      conversationId: conv.id,
      eventId: ev.id,
      sessionId: 's1',
      codeRef: head,
      kind: 'manual',
    });
    writeFileSync(join(root, 'readme.txt'), 'drifted');

    setCheckpointNodeHub(stubNodeHub(root));
    try {
      const res = await request(app, 'GET', `/conversations/${conv.id}/checkpoints/${cp.id}/code-diff`);
      expect(res.status).toBe(200);
      expect(res.json.diff).toContain('drifted');
    } finally {
      setCheckpointNodeHub(undefined);
    }
  });
});
