import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { registerConversationMutationRoutes } from './conversations.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, () => db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  return { db, app, conversationId: c.id };
}

function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (r) => {
          const text = await r.text();
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
          return { status: r.status, body: parsed };
        })
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

type ConversationBody = {
  conversation: {
    title: string;
    description?: string;
    descriptionSource?: 'auto' | 'user';
  };
};

describe('PATCH /conversations/:id description', () => {
  it('sets description and marks source user', async () => {
    const { app, conversationId } = boot();
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { description: 'hello' });
    expect(res.status).toBe(200);
    const conv = (res.body as ConversationBody).conversation;
    expect(conv.description).toBe('hello');
    expect(conv.descriptionSource).toBe('user');
  });

  it('PATCH description null on a never-described row does not mark source user', async () => {
    const { app, conversationId } = boot();
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { description: null });
    expect(res.status).toBe(200);
    const conv = (res.body as ConversationBody).conversation;
    expect(conv.description).toBeUndefined();
    expect(conv.descriptionSource).toBeUndefined();
  });

  it('clears description on null but keeps source user', async () => {
    const { app, conversationId } = boot();
    await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { description: 'hello' });
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { description: null });
    expect(res.status).toBe(200);
    const conv = (res.body as ConversationBody).conversation;
    expect(conv.description).toBeUndefined();
    expect(conv.descriptionSource).toBe('user');
  });

  it('rejects an empty body with 400', async () => {
    const { app, conversationId } = boot();
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, {});
    expect(res.status).toBe(400);
  });

  it('applies title and description in one call', async () => {
    const { app, conversationId } = boot();
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { title: 'T', description: 'D' });
    expect(res.status).toBe(200);
    const conv = (res.body as ConversationBody).conversation;
    expect(conv.title).toBe('T');
    expect(conv.description).toBe('D');
    expect(conv.descriptionSource).toBe('user');
  });

  it('returns 404 for an unknown id', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'PATCH', '/conversations/nope', { description: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('POST /conversations/:id/describe', () => {
  it('returns 200 { conversation } with an auto description', async () => {
    const { db, app, conversationId } = boot();
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id,conversation_id,created_at,updated_at) VALUES (?,?,?,?)')
      .run('s-d', conversationId, now, now);
    db.prepare('INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)')
      .run('e-d', 's-d', 'prompt', '{"text":"ship the regenerate button"}', 'user', 1, now);

    const res = await fetchJson(app, 'POST', `/conversations/${conversationId}/describe`);
    expect(res.status).toBe(200);
    const conv = (res.body as ConversationBody).conversation;
    expect(conv.description).toBe('ship the regenerate button');
    expect(conv.descriptionSource).toBe('auto');
  });

  it('returns 404 for an unknown id', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/conversations/nope/describe');
    expect(res.status).toBe(404);
  });
});

describe('GET /conversations/:id', () => {
  it('returns { conversation } for a known id', async () => {
    const { app, conversationId } = boot();
    const res = await fetchJson(app, 'GET', `/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    expect((res.body as ConversationBody).conversation).toEqual(expect.objectContaining({ id: conversationId, title: 'C' }));
  });

  it('returns 404 { error: no such conversation } for an unknown id', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'GET', '/conversations/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'no such conversation' });
  });
});
