import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, createScheduleHomeConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { createTimer, listPendingTimers } from '../repositories/conversationTimers.js';
import { updateCompactionSettings } from '../repositories/settings.js';
import { issueSpawnToken, CONVERSATION_CAPABILITIES } from '../spawn/tokens.js';
import type { AgentSelfTimersMode } from '@tierwyn/shared';
import { registerAgentSelfTimerRoutes } from './conversationTimers.js';

const PROFILE_ID = 'claude-code:test-model';
const PI_PROFILE_ID = 'pi:test-model';
const NOW = 1_800_000_000_000;

let db: Database.Database;
let app: express.Express;
let convA: string;
let convB: string;
let convChild: string;
let mode: AgentSelfTimersMode;

function seedProfile(): void {
  db.prepare(
    `INSERT INTO agents (id, type, label, created_at)
     VALUES ('claude-code', 'claude-code', 'Claude Code', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, 'claude-code', 'test-model', 'Test', 1, ?)`,
  ).run(PROFILE_ID, NOW);
  db.prepare(
    `INSERT INTO agents (id, type, label, created_at)
     VALUES ('pi', 'pi', 'Pi', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, 'pi', 'test-model', 'Pi Test', 1, ?)`,
  ).run(PI_PROFILE_ID, NOW);
  catalogue.load(db);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedProfile();
  seedDefaultSettings(db);

  const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
  convA = createConversation(db, { projectId: project.id, title: 'A' }).id;
  convB = createConversation(db, { projectId: project.id, title: 'B' }).id;
  convChild = createConversation(db, {
    projectId: project.id,
    title: 'Child',
    parentConversationId: convA,
  }).id;

  createSession(db, { id: 'sess-a', conversationId: convA, agentId: 'claude-code', agentModelId: PROFILE_ID });
  createSession(db, { id: 'sess-b', conversationId: convB, agentId: 'claude-code', agentModelId: PROFILE_ID });
  createSession(db, { id: 'sess-child', conversationId: convChild, agentId: 'claude-code', agentModelId: PROFILE_ID });

  mode = 'level0';
  app = express();
  app.use(express.json());
  registerAgentSelfTimerRoutes(app, {
    getDb: () => db,
    now: () => NOW,
    selfTimersMode: () => mode,
  });
});

const url = (id: string) => `/conversations/${id}/timers/agent`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function call(
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

function countTimers(): number {
  const row = db.prepare('SELECT count(*) n FROM conversation_timers').get() as { n: number };
  return row.n;
}

describe('POST /conversations/:id/timers/agent', () => {
  it('creates an agent-self timer on the caller\'s own root conversation', async () => {
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry build', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(201);
    expect(res.body.timer).toMatchObject({
      conversationId: convA,
      origin: 'agent-self',
      profileId: PROFILE_ID,
      fireAtMs: NOW + 30 * 60_000,
      effort: null,
      options: null,
      attachmentNames: [],
      handoffOverride: null,
    });
    expect(res.body.timer.prompt).toMatch(/^⏰ Self-timer you set at .+:\n\nretry build$/);
    expect(countTimers()).toBe(1);
  });

  it('redacts a live spawn token out of the stored self-timer prompt', async () => {
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: `retry ${t} please`, fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(201);
    expect(res.body.timer.prompt).not.toContain(t);
    expect(res.body.timer.prompt).toContain('[REDACTED]');
  });

  it('401 without / with dead bearer', async () => {
    const resNoAuth = await call('POST', url(convA), { text: 'retry build', fireInMs: 30 * 60_000 });
    expect(resNoAuth.status).toBe(401);
    expect(countTimers()).toBe(0);

    const resDead = await call('POST', url(convA), { text: 'retry build', fireInMs: 30 * 60_000 }, auth('not-a-token'));
    expect(resDead.status).toBe(401);
    expect(countTimers()).toBe(0);
  });

  it('403 cross_conversation when the token belongs to another conversation', async () => {
    const tB = issueSpawnToken(convB, 'sess-b', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry build', fireInMs: 30 * 60_000 }, auth(tB));
    expect(res.status).toBe(403);
    expect(res.body.decision).toBe('cross_conversation');
    expect(countTimers()).toBe(0);
  });

  it('403 for a token without schedule scope', async () => {
    const tNoSched = issueSpawnToken(convA, 'sess-a', new Set(['mesh'] as any));
    const res = await call('POST', url(convA), { text: 'retry build', fireInMs: 30 * 60_000 }, auth(tNoSched));
    expect(res.status).toBe(403);
    expect(countTimers()).toBe(0);
  });

  it('403 self_timers_off when mode=off, even for a root', async () => {
    mode = 'off';
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry build', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(403);
    expect(res.body.decision).toBe('self_timers_off');
    expect(countTimers()).toBe(0);
  });

  it('403 self_timers_root_only for a child under level0', async () => {
    mode = 'level0';
    const t = issueSpawnToken(convChild, 'sess-child', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convChild), { text: 'retry build', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(403);
    expect(res.body.decision).toBe('self_timers_root_only');
    expect(countTimers()).toBe(0);
  });

  it('allows schedule run (policy root) under level0, but blocks its spawned subagent', async () => {
    mode = 'level0';
    const project = createProject(db, { name: 'p2', rootPath: '/tmp/p2' });
    const home = createScheduleHomeConversation(db, { projectId: project.id, jobName: 'SchedJob' });
    const run = createConversation(db, {
      projectId: project.id,
      title: '⏱ SchedJob @ 08:00',
      parentConversationId: home.id,
    });
    const sub = createConversation(db, {
      projectId: project.id,
      title: '↳ Subagent',
      parentConversationId: run.id,
    });
    createSession(db, { id: 'sess-run', conversationId: run.id, agentId: 'claude-code', agentModelId: PROFILE_ID });
    createSession(db, { id: 'sess-sub', conversationId: sub.id, agentId: 'claude-code', agentModelId: PROFILE_ID });

    const tRun = issueSpawnToken(run.id, 'sess-run', CONVERSATION_CAPABILITIES);
    const tSub = issueSpawnToken(sub.id, 'sess-sub', CONVERSATION_CAPABILITIES);

    // Schedule run itself succeeds under level0
    const resRun = await call('POST', url(run.id), { text: 'check status', fireInMs: 30 * 60_000 }, auth(tRun));
    expect(resRun.status).toBe(201);
    expect(resRun.body.timer.conversationId).toBe(run.id);

    // Subagent spawned by schedule run is blocked under level0
    const resSub = await call('POST', url(sub.id), { text: 'sub check', fireInMs: 30 * 60_000 }, auth(tSub));
    expect(resSub.status).toBe(403);
    expect(resSub.body.decision).toBe('self_timers_root_only');
  });

  it('201 for a child under all', async () => {
    mode = 'all';
    const t = issueSpawnToken(convChild, 'sess-child', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convChild), { text: 'retry build', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(201);
    expect(res.body.timer.conversationId).toBe(convChild);
    expect(countTimers()).toBe(1);
  });

  it.each(['profileId', 'role', 'prompt', 'effort', 'options', 'attachments', 'notifyParent', 'origin'])(
    '400 when body carries %s',
    async (badField) => {
      const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
      const res = await call(
        'POST',
        url(convA),
        { text: 'retry build', fireInMs: 30 * 60_000, [badField]: 'bad' },
        auth(t),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(badField);
      expect(countTimers()).toBe(0);
    },
  );

  it('400 on empty text / non-string text', async () => {
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const r1 = await call('POST', url(convA), { text: '   ', fireInMs: 30 * 60_000 }, auth(t));
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('text is required');

    const r2 = await call('POST', url(convA), { text: 123, fireInMs: 30 * 60_000 }, auth(t));
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe('text is required');
    expect(countTimers()).toBe(0);
  });

  it('400 on fireInMs below 1 min and on both fireInMs+fireAtMs', async () => {
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const r1 = await call('POST', url(convA), { text: 'retry', fireInMs: 30_000 }, auth(t));
    expect(r1.status).toBe(400);

    const r2 = await call('POST', url(convA), { text: 'retry', fireInMs: 30 * 60_000, fireAtMs: NOW + 30 * 60_000 }, auth(t));
    expect(r2.status).toBe(400);
    expect(countTimers()).toBe(0);
  });

  it('400 past the 8h agent cap, with maxDeferMs', async () => {
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry', fireInMs: 9 * 60 * 60_000 }, auth(t));
    expect(res.status).toBe(400);
    expect(res.body.maxDeferMs).toBe(8 * 60 * 60_000);
    expect(countTimers()).toBe(0);
  });

  it('400 when usageAutoResumeMaxDeferMs is 0', async () => {
    updateCompactionSettings(db, { usageAutoResumeMaxDeferMs: 0 });
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('agent deferral is disabled');
    expect(countTimers()).toBe(0);
  });

  it('409 when an agent-resume timer is already pending', async () => {
    createTimer(db, {
      conversationId: convA,
      prompt: 'resume',
      profileId: PROFILE_ID,
      fireAtMs: NOW + 10 * 60_000,
      origin: 'agent-resume',
    });
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(409);
    expect(res.body.origin).toBe('agent-resume');
    expect(countTimers()).toBe(1);
  });

  it('409 when a second self-timer is requested', async () => {
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const r1 = await call('POST', url(convA), { text: 'retry 1', fireInMs: 30 * 60_000 }, auth(t));
    expect(r1.status).toBe(201);
    const r2 = await call('POST', url(convA), { text: 'retry 2', fireInMs: 40 * 60_000 }, auth(t));
    expect(r2.status).toBe(409);
    expect(r2.body.origin).toBe('agent-self');
    expect(countTimers()).toBe(1);
  });

  it('201 even when operator timers are pending, and leaves them untouched', async () => {
    createTimer(db, {
      conversationId: convA,
      prompt: 'op',
      profileId: PROFILE_ID,
      fireAtMs: NOW + 120_000,
    });
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(201);
    const pending = listPendingTimers(db, convA);
    expect(pending).toHaveLength(2);
    const op = pending.find((p) => p.origin === 'operator');
    expect(op?.cancelledAt).toBeNull();
  });

  it('snapshots the token session profile, not a later session', async () => {
    createSession(db, { id: 'sess-a2', conversationId: convA, agentId: 'pi', agentModelId: PI_PROFILE_ID });
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(201);
    expect(res.body.timer.profileId).toBe(PROFILE_ID);
  });

  it('400 when the snapshot profile is disabled', async () => {
    db.prepare('UPDATE agent_models SET enabled_flag = 0 WHERE id = ?').run(PROFILE_ID);
    catalogue.load(db);
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { text: 'retry', fireInMs: 30 * 60_000 }, auth(t));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no current profile to schedule onto');
    expect(countTimers()).toBe(0);
  });
});
