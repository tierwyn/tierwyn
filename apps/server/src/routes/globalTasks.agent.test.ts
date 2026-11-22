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
import { updateGlobalTasksSettings } from '../repositories/settings.js';
import { operatorUpdateGlobalTask } from '../repositories/globalTasks.js';
import { issueSpawnToken, CONVERSATION_CAPABILITIES } from '../spawn/tokens.js';
import type { ServerFrame } from '@tierwyn/shared';
import { registerAgentGlobalTaskRoutes } from './globalTasks.js';

const PROFILE_ID = 'claude-code:test-model';
const NOW = 1_800_000_000_000;
const TASKS = new Set([...CONVERSATION_CAPABILITIES, 'tasks'] as const);

let db: Database.Database;
let app: express.Express;
let convA: string;
let convB: string;
let convChild: string;
let frames: ServerFrame[];

function seedProfile(): void {
  db.prepare(
    `INSERT INTO agents (id, type, label, created_at) VALUES ('claude-code', 'claude-code', 'Claude Code', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, 'claude-code', 'test-model', 'Test', 1, ?)`,
  ).run(PROFILE_ID, NOW);
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
    projectId: project.id, title: 'Child', parentConversationId: convA,
  }).id;

  createSession(db, { id: 'sess-a', conversationId: convA, agentId: 'claude-code', agentModelId: PROFILE_ID });
  createSession(db, { id: 'sess-b', conversationId: convB, agentId: 'claude-code', agentModelId: PROFILE_ID });
  createSession(db, { id: 'sess-child', conversationId: convChild, agentId: 'claude-code', agentModelId: PROFILE_ID });

  frames = [];
  app = express();
  app.use(express.json());
  registerAgentGlobalTaskRoutes(app, {
    getDb: () => db,
    now: () => NOW,
    isLive: () => false,
    broadcastAll: (f) => { frames.push(f); },
  });
});

const url = (id: string) => `/conversations/${id}/tasks/agent`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function call(
  method: 'GET' | 'POST' | 'PATCH',
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

describe('agent global task routes', () => {
  it('401 without a bearer', async () => {
    const res = await call('POST', url(convA), { title: 't' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('a live session bearer token is required');
  });

  it('403 no_tasks_capability without tasks on the token', async () => {
    const t = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    const res = await call('POST', url(convA), { title: 't' }, auth(t));
    expect(res.status).toBe(403);
    expect(res.body.decision).toBe('no_tasks_capability');
  });

  it('403 cross_conversation when A token hits B', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    const res = await call('POST', url(convB), { title: 't' }, auth(t));
    expect(res.status).toBe(403);
    expect(res.body.decision).toBe('cross_conversation');
  });

  it('403 global_tasks_off after minting when the operator turns the feature off', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    updateGlobalTasksSettings(db, { enabled: false });
    const res = await call('POST', url(convA), { title: 't' }, auth(t));
    expect(res.status).toBe(403);
    expect(res.body.decision).toBe('global_tasks_off');
  });

  it('403 global_tasks_root_only for a child under roots; 201 when scope is all', async () => {
    const t = issueSpawnToken(convChild, 'sess-child', TASKS);
    const blocked = await call('POST', url(convChild), { title: 'child' }, auth(t));
    expect(blocked.status).toBe(403);
    expect(blocked.body.decision).toBe('global_tasks_root_only');

    updateGlobalTasksSettings(db, { scope: 'all' });
    const ok = await call('POST', url(convChild), { title: 'child' }, auth(t));
    expect(ok.status).toBe(201);
  });

  it('allows schedule run (policy root) under scope roots, but blocks its spawned subagent', async () => {
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

    const tRun = issueSpawnToken(run.id, 'sess-run', TASKS);
    const tSub = issueSpawnToken(sub.id, 'sess-sub', TASKS);

    // Schedule run itself succeeds under scope roots
    const resRun = await call('POST', url(run.id), { title: 'Run task' }, auth(tRun));
    expect(resRun.status).toBe(201);
    expect(resRun.body.task.title).toBe('Run task');

    // Subagent spawned by schedule run is blocked under scope roots
    const resSub = await call('POST', url(sub.id), { title: 'Sub task' }, auth(tSub));
    expect(resSub.status).toBe(403);
    expect(resSub.body.decision).toBe('global_tasks_root_only');
  });

  it('POST happy path 201 with derived ids and one upsert frame', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    const res = await call('POST', url(convA), { title: 'Smoke' }, auth(t));
    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({
      conversationId: convA,
      sessionId: 'sess-a',
      conversationTitle: 'A',
      title: 'Smoke',
      status: 'in_progress',
    });
    expect(res.body.task.projectId).toBeTruthy();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'global_task_updated',
      op: 'upsert',
      counts: { inProgress: 1 },
    });
  });

  it('POST unknown keys are 400', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    for (const key of ['projectId', 'conversationId', 'sessionId', 'foo']) {
      const res = await call('POST', url(convA), { title: 't', [key]: 'x' }, auth(t));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`field '${key}' is not accepted`);
    }
  });

  it('normalises title whitespace; rejects overlong title/description, missing title, non-string description', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    const ok = await call('POST', url(convA), { title: 'a\n  b' }, auth(t));
    expect(ok.status).toBe(201);
    expect(ok.body.task.title).toBe('a b');

    expect((await call('POST', url(convA), { title: 'x'.repeat(201) }, auth(t))).status).toBe(400);
    expect((await call('POST', url(convA), { title: 'ok', description: 'd'.repeat(4001) }, auth(t))).status).toBe(400);
    expect((await call('POST', url(convA), {}, auth(t))).status).toBe(400);
    expect((await call('POST', url(convA), { title: 'ok', description: 5 }, auth(t))).status).toBe(400);
  });

  it('fourth POST with 3 open is 409 with openTaskIds length 3', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    for (const title of ['1', '2', '3']) {
      expect((await call('POST', url(convA), { title }, auth(t))).status).toBe(201);
    }
    const res = await call('POST', url(convA), { title: '4' }, auth(t));
    expect(res.status).toBe(409);
    expect(res.body.openTaskIds).toHaveLength(3);
  });

  it('reopen of a completed task 409s when 3 are already open', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    const ids: string[] = [];
    for (const title of ['1', '2', '3']) {
      ids.push((await call('POST', url(convA), { title }, auth(t))).body.task.id);
    }
    expect((await call('PATCH', `${url(convA)}/${ids[0]}`, { status: 'completed' }, auth(t))).status).toBe(200);
    expect((await call('POST', url(convA), { title: 'new' }, auth(t))).status).toBe(201);
    const reopen = await call('PATCH', `${url(convA)}/${ids[0]}`, { status: 'in_progress' }, auth(t));
    expect(reopen.status).toBe(409);
    expect(reopen.body.openTaskIds).toHaveLength(3);
  });

  it('PATCH of B task id through A route is 404', async () => {
    const tA = issueSpawnToken(convA, 'sess-a', TASKS);
    const tB = issueSpawnToken(convB, 'sess-b', TASKS);
    const created = await call('POST', url(convB), { title: 'B task' }, auth(tB));
    const res = await call('PATCH', `${url(convA)}/${created.body.task.id}`, { progress: 'x' }, auth(tA));
    expect(res.status).toBe(404);
  });

  it('PATCH of a hidden task is 409 task_hidden', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    const created = await call('POST', url(convA), { title: 'h' }, auth(t));
    operatorUpdateGlobalTask(db, created.body.task.id, { hidden: true }, NOW);
    const res = await call('PATCH', `${url(convA)}/${created.body.task.id}`, { progress: 'x' }, auth(t));
    expect(res.status).toBe(409);
    expect(res.body.decision).toBe('task_hidden');
  });

  it('PATCH completed sets completedBy agent; empty and invalid status are 400', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    const created = await call('POST', url(convA), { title: 'c' }, auth(t));
    const done = await call('PATCH', `${url(convA)}/${created.body.task.id}`, { status: 'completed' }, auth(t));
    expect(done.status).toBe(200);
    expect(done.body.task.completedBy).toBe('agent');
    expect((await call('PATCH', `${url(convA)}/${created.body.task.id}`, {}, auth(t))).status).toBe(400);
    expect((await call('PATCH', `${url(convA)}/${created.body.task.id}`, { status: 'done' }, auth(t))).status).toBe(400);
  });

  it('GET returns only this conversation non-hidden tasks', async () => {
    const tA = issueSpawnToken(convA, 'sess-a', TASKS);
    const tB = issueSpawnToken(convB, 'sess-b', TASKS);
    await call('POST', url(convA), { title: 'A1' }, auth(tA));
    const hid = await call('POST', url(convA), { title: 'A-hid' }, auth(tA));
    operatorUpdateGlobalTask(db, hid.body.task.id, { hidden: true }, NOW);
    await call('POST', url(convB), { title: 'B1' }, auth(tB));
    const res = await call('GET', url(convA), undefined, auth(tA));
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((x: { title: string }) => x.title)).toEqual(['A1']);
  });

  it('redacts a live spawn token from title and progress', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    const res = await call('POST', url(convA), { title: `leak ${t}`, progress: t }, auth(t));
    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe('leak [REDACTED]');
    expect(res.body.task.progress).toBe('[REDACTED]');
  });

  it('refreshes conversationTitle from the current row on PATCH', async () => {
    const t = issueSpawnToken(convA, 'sess-a', TASKS);
    const created = await call('POST', url(convA), { title: 'r' }, auth(t));
    db.prepare("UPDATE conversations SET title='A2' WHERE id = ?").run(convA);
    const patched = await call('PATCH', `${url(convA)}/${created.body.task.id}`, { progress: 'p' }, auth(t));
    expect(patched.body.task.conversationTitle).toBe('A2');
  });

  describe('direct /tasks/agent routes', () => {
    it('supports POST, GET, and PATCH on direct /tasks/agent routes', async () => {
      const tA = issueSpawnToken(convA, 'sess-a', TASKS);
      const postRes = await call('POST', '/tasks/agent', { title: 'Direct Task', progress: 'init' }, auth(tA));
      expect(postRes.status).toBe(201);
      expect(postRes.body.task).toMatchObject({
        conversationId: convA,
        title: 'Direct Task',
        progress: 'init',
        status: 'in_progress',
      });
      const taskId = postRes.body.task.id;

      const getRes = await call('GET', '/tasks/agent', undefined, auth(tA));
      expect(getRes.status).toBe(200);
      expect(getRes.body.tasks).toHaveLength(1);
      expect(getRes.body.tasks[0].id).toBe(taskId);

      const patchRes = await call('PATCH', `/tasks/agent/${taskId}`, { status: 'completed', progress: 'done' }, auth(tA));
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.task.status).toBe('completed');
      expect(patchRes.body.task.progress).toBe('done');
    });

    it('PATCH /tasks/agent/:taskId rejects foreign task with 404', async () => {
      const tA = issueSpawnToken(convA, 'sess-a', TASKS);
      const tB = issueSpawnToken(convB, 'sess-b', TASKS);
      const createdB = await call('POST', '/tasks/agent', { title: 'B Task' }, auth(tB));
      expect(createdB.status).toBe(201);

      const res = await call('PATCH', `/tasks/agent/${createdB.body.task.id}`, { progress: 'hacked' }, auth(tA));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('task not found');
    });
  });
});
