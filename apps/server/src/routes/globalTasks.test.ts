import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { updateGlobalTasksSettings } from '../repositories/settings.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import {
  createGlobalTask, getGlobalTask, agentUpdateGlobalTask, operatorUpdateGlobalTask,
} from '../repositories/globalTasks.js';
import type { ServerFrame } from '@tierwyn/shared';
import { registerGlobalTaskRoutes } from './globalTasks.js';

const NOW = 1_800_000_000_000;

let db: Database.Database;
let app: express.Express;
let projectId: string;
let otherProjectId: string;
let convA: string;
let frames: ServerFrame[];

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  const project = createProject(db, { name: 'Alpha', rootPath: '/tmp/a' });
  const other = createProject(db, { name: 'Beta', rootPath: '/tmp/b' });
  projectId = project.id;
  otherProjectId = other.id;
  convA = createConversation(db, { projectId, title: 'A' }).id;
  frames = [];
  app = express();
  app.use(express.json());
  registerGlobalTaskRoutes(app, {
    getDb: () => db,
    now: () => NOW,
    isLive: () => false,
    broadcastAll: (f) => { frames.push(f); },
  });
});

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

function task(title: string, now = NOW) {
  return createGlobalTask(db, {
    projectId, conversationId: convA, sessionId: 's', conversationTitle: 'A',
    title, description: '', testing: '', progress: '', now,
  });
}

describe('operator global task routes', () => {
  it('GET /tasks defaults to in_progress; bogus view 400; projectId filters; counts global; now is a number', async () => {
    task('open');
    const done = task('done', NOW + 1);
    agentUpdateGlobalTask(db, done.id, { status: 'completed' }, { sessionId: 's', conversationTitle: 'A', now: NOW + 2 });
    const otherConv = createConversation(db, { projectId: otherProjectId, title: 'B' }).id;
    createGlobalTask(db, {
      projectId: otherProjectId, conversationId: otherConv, sessionId: 's', conversationTitle: 'B',
      title: 'other-open', description: '', testing: '', progress: '', now: NOW + 3,
    });

    const def = await call('GET', '/tasks');
    expect(def.status).toBe(200);
    expect(def.body.tasks.map((t: { title: string }) => t.title)).toEqual(['other-open', 'open']);
    expect(def.body.counts).toEqual({ inProgress: 2, completedVisible: 1, hidden: 0 });
    expect(typeof def.body.now).toBe('number');
    expect(def.body.truncated).toBe(false);

    expect((await call('GET', '/tasks?view=bogus')).status).toBe(400);

    const filtered = await call('GET', `/tasks?projectId=${encodeURIComponent(otherProjectId)}`);
    expect(filtered.body.tasks.map((t: { title: string }) => t.title)).toEqual(['other-open']);
    expect(filtered.body.counts).toEqual({ inProgress: 2, completedVisible: 1, hidden: 0 });
  });

  it('GET /tasks/count returns counts', async () => {
    task('open');
    const res = await call('GET', '/tasks/count');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inProgress: 1, completedVisible: 0, hidden: 0 });
  });

  it('PATCH status completed is operator; hidden; bad bodies 400; unknown 404', async () => {
    const t = task('x');
    const done = await call('PATCH', `/tasks/${t.id}`, { status: 'completed' });
    expect(done.status).toBe(200);
    expect(done.body.task.completedBy).toBe('operator');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'global_task_updated', op: 'upsert' });

    frames.length = 0;
    const hid = await call('PATCH', `/tasks/${t.id}`, { hidden: true });
    expect(hid.status).toBe(200);
    expect(hid.body.task.hiddenAt).toBe(NOW);

    expect((await call('PATCH', `/tasks/${t.id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/tasks/${t.id}`, { title: 'x' })).status).toBe(400);
    expect((await call('PATCH', `/tasks/${t.id}`, { hidden: 'yes' })).status).toBe(400);
    expect((await call('PATCH', '/tasks/missing', { hidden: true })).status).toBe(404);
  });

  it('operator Reopen is allowed even when 3 are already open', async () => {
    const a = task('1');
    task('2', NOW + 1);
    task('3', NOW + 2);
    agentUpdateGlobalTask(db, a.id, { status: 'completed' }, { sessionId: 's', conversationTitle: 'A', now: NOW + 3 });
    task('4', NOW + 4);
    const res = await call('PATCH', `/tasks/${a.id}`, { status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('in_progress');
  });

  it('POST /tasks/hide-completed returns n and n upsert frames ending at completedVisible 0', async () => {
    const d1 = task('d1');
    const d2 = task('d2', NOW + 1);
    agentUpdateGlobalTask(db, d1.id, { status: 'completed' }, { sessionId: 's', conversationTitle: 'A', now: NOW + 2 });
    agentUpdateGlobalTask(db, d2.id, { status: 'completed' }, { sessionId: 's', conversationTitle: 'A', now: NOW + 3 });
    frames.length = 0;
    const res = await call('POST', '/tasks/hide-completed', {});
    expect(res.status).toBe(200);
    expect(res.body.hidden).toBe(2);
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.type === 'global_task_updated' && f.op === 'upsert')).toBe(true);
    expect(frames.at(-1)).toMatchObject({ counts: { completedVisible: 0 } });
  });

  it('DELETE /tasks/:id ok then 404; DELETE ?view=hidden bulk; DELETE without view 400', async () => {
    const t = task('gone');
    const del = await call('DELETE', `/tasks/${t.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    expect(frames.at(-1)).toMatchObject({ type: 'global_task_updated', op: 'delete', taskId: t.id });
    expect((await call('DELETE', `/tasks/${t.id}`)).status).toBe(404);

    const h1 = task('h1', NOW + 1);
    const h2 = task('h2', NOW + 2);
    operatorUpdateGlobalTask(db, h1.id, { hidden: true }, NOW + 3);
    operatorUpdateGlobalTask(db, h2.id, { hidden: true }, NOW + 4);
    frames.length = 0;
    const bulk = await call('DELETE', '/tasks?view=hidden');
    expect(bulk.status).toBe(200);
    expect(bulk.body.deleted).toBe(2);
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.type === 'global_task_updated' && f.op === 'delete')).toBe(true);

    expect((await call('DELETE', '/tasks')).status).toBe(400);
  });

  it('GET/POST /settings/global-tasks defaults, merge, reject non-object', async () => {
    const get = await call('GET', '/settings/global-tasks');
    expect(get.status).toBe(200);
    expect(get.body).toEqual({
      enabled: true, scope: 'roots', staleAfterHours: 48, autoDeleteHiddenAfterDays: 30,
    });
    const post = await call('POST', '/settings/global-tasks', { scope: 'all' });
    expect(post.status).toBe(200);
    expect(post.body.scope).toBe('all');
    expect(post.body.enabled).toBe(true);

    const bad = await call('POST', '/settings/global-tasks', 'x');
    expect(bad.status).toBe(400);
  });

  it('every /tasks* route 403 global_tasks_off when disabled; settings routes stay open', async () => {
    const t = task('open');
    updateGlobalTasksSettings(db, { enabled: false });

    for (const r of [
      await call('GET', '/tasks'),
      await call('GET', '/tasks/count'),
      await call('GET', '/tasks?view=hidden'),
      await call('POST', '/tasks/hide-completed', {}),
      await call('PATCH', `/tasks/${t.id}`, { status: 'completed' }),
      await call('DELETE', `/tasks/${t.id}`),
      await call('DELETE', '/tasks?view=hidden'),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.decision).toBe('global_tasks_off');
    }
    expect(frames).toHaveLength(0);
    // The row is untouched and the settings routes still answer.
    expect(getGlobalTask(db, t.id)?.status).toBe('in_progress');
    const get = await call('GET', '/settings/global-tasks');
    expect(get.status).toBe(200);
    expect(get.body.enabled).toBe(false);
    expect((await call('POST', '/settings/global-tasks', { enabled: true })).body.enabled).toBe(true);
    expect((await call('GET', '/tasks/count')).status).toBe(200);
  });
});
