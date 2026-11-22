import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import {
  createConversation, createScheduleHomeConversation, getConversation,
} from '../repositories/conversations.js';
import { appendEvent, listEventsForConversation } from '../repositories/events.js';
import { registerConversationMutationRoutes } from './conversations.js';
import { ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, () => db);

  const projectA = createProject(db, { name: 'A', rootPath: '/a' });
  const projectB = createProject(db, { name: 'B', rootPath: '/b' });
  const source = createConversation(db, { projectId: projectA.id, title: 'Source chat' });

  const sessionId = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, agent_id, agent_model_id, native_session_id, created_at, updated_at)
     VALUES (?,?,NULL,NULL,'native-abc',?,?)`,
  ).run(sessionId, source.id, now, now);

  let seq = 0;
  const add = (type: string, payload: unknown, sender: 'user' | 'agent' | 'system' = 'agent') => {
    seq += 1;
    appendEvent(db, { sessionId, type, payload, sender, seq, ts: now + seq });
  };
  add('prompt', { text: 'hello there' }, 'user');
  add('tool_call', { name: 'Read', toolUseId: 't1' });
  add('message', { chunk: 'general kenobi', final: 1 });

  return { db, app, projectA: projectA.id, projectB: projectB.id, sourceId: source.id };
}

/** POST JSON against an ephemeral listener; returns status + parsed body. */
function post(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('POST /conversations/:id/duplicate', () => {
  it('returns the new conversation with the Copy of title and the copied transcript', async () => {
    const { db, app, sourceId, projectA } = boot();
    const res = await post(app, `/conversations/${sourceId}/duplicate`, {});
    expect(res.status).toBe(200);
    expect(res.json.conversation.id).not.toBe(sourceId);
    expect(res.json.conversation.title).toBe('Copy of Source chat');
    expect(res.json.conversation.projectId).toBe(projectA);
    expect(listEventsForConversation(db, res.json.conversation.id).map((e) => e.type))
      .toEqual(['prompt', 'message']);
  });

  it('omits tool events by default and includes them with includeTools', async () => {
    const { db, app, sourceId } = boot();
    const plain = await post(app, `/conversations/${sourceId}/duplicate`, {});
    expect(listEventsForConversation(db, plain.json.conversation.id).map((e) => e.type))
      .not.toContain('tool_call');

    const withTools = await post(app, `/conversations/${sourceId}/duplicate`, { includeTools: true });
    expect(listEventsForConversation(db, withTools.json.conversation.id).map((e) => e.type))
      .toEqual(['prompt', 'tool_call', 'message']);
  });

  it('honours an explicit title', async () => {
    const { app, sourceId } = boot();
    const res = await post(app, `/conversations/${sourceId}/duplicate`, { title: 'Retry on Opus' });
    expect(res.json.conversation.title).toBe('Retry on Opus');
  });

  it('lands the copy in the requested project', async () => {
    const { db, app, sourceId, projectA, projectB } = boot();
    const res = await post(app, `/conversations/${sourceId}/duplicate`, { projectId: projectB });
    expect(res.status).toBe(200);
    expect(res.json.conversation.projectId).toBe(projectB);
    expect(getConversation(db, sourceId)?.projectId).toBe(projectA);
  });

  it('404s an unknown source conversation', async () => {
    const { app } = boot();
    const res = await post(app, '/conversations/does-not-exist/duplicate', {});
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('no such conversation');
  });

  it('404s an unknown target project', async () => {
    const { app, sourceId } = boot();
    const res = await post(app, `/conversations/${sourceId}/duplicate`, { projectId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('no such project');
  });

  it('409s a schedule home conversation', async () => {
    const { db, app, projectA } = boot();
    const home = createScheduleHomeConversation(db, { projectId: projectA, jobName: 'nightly' });
    const res = await post(app, `/conversations/${home.id}/duplicate`, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('cannot duplicate schedule home conversation');
  });

  it('allows duplicating a schedule RUN chat', async () => {
    const { db, app, projectA } = boot();
    const home = createScheduleHomeConversation(db, { projectId: projectA, jobName: 'nightly' });
    const run = createConversation(db, {
      projectId: projectA, title: 'run 1', parentConversationId: home.id,
    });
    const res = await post(app, `/conversations/${run.id}/duplicate`, {});
    expect(res.status).toBe(200);
    expect(res.json.conversation.parentConversationId).toBeUndefined();
  });

  it('400s a non-boolean includeTools', async () => {
    const { app, sourceId } = boot();
    const res = await post(app, `/conversations/${sourceId}/duplicate`, { includeTools: 'yes' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('includeTools must be a boolean');
  });

  it('400s a non-string title', async () => {
    const { app, sourceId } = boot();
    const res = await post(app, `/conversations/${sourceId}/duplicate`, { title: 42 });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('title must be a string');
  });

  it('400s a non-string projectId', async () => {
    const { app, sourceId } = boot();
    const res = await post(app, `/conversations/${sourceId}/duplicate`, { projectId: 7 });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('projectId must be a string');
  });

  it('leaves the source conversation and its native session id intact', async () => {
    const { db, app, sourceId } = boot();
    const before = listEventsForConversation(db, sourceId).map((e) => e.id);
    await post(app, `/conversations/${sourceId}/duplicate`, { includeTools: true });
    expect(listEventsForConversation(db, sourceId).map((e) => e.id)).toEqual(before);
    const native = db.prepare('SELECT native_session_id AS n FROM sessions WHERE conversation_id = ?')
      .get(sourceId) as { n: string | null };
    expect(native.n).toBe('native-abc');
  });

  it('409s a Remote Agents conversation and still 200s a normal one', async () => {
    const { db, app, sourceId } = boot();
    ensureRemoteAgentsProject(db);
    const bot = createConversation(db, {
      projectId: REMOTE_AGENTS_PROJECT_ID, title: 'Bot chat',
    });
    const denied = await post(app, `/conversations/${bot.id}/duplicate`, {});
    expect(denied.status).toBe(409);
    expect(denied.json.error).toBe('cannot duplicate a Remote Agents conversation');
    expect(getConversation(db, bot.id)?.id).toBe(bot.id);

    const ok = await post(app, `/conversations/${sourceId}/duplicate`, {});
    expect(ok.status).toBe(200);
    expect(ok.json.conversation.id).not.toBe(sourceId);
  });
});
