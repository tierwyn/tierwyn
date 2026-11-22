import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { addCustomDesignation } from '../repositories/settings.js';
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
    designation?: string;
  };
};

describe('PATCH /conversations/:id designation', () => {
  it('sets a builtin designation', async () => {
    const { app, conversationId, db } = boot();
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { designation: 'Planner' });
    expect(res.status).toBe(200);
    expect((res.body as ConversationBody).conversation.designation).toBe('planner');
    expect(getConversation(db, conversationId)?.designation).toBe('planner');
  });

  it('clears designation on null', async () => {
    const { app, conversationId } = boot();
    await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { designation: 'planner' });
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { designation: null });
    expect(res.status).toBe(200);
    expect((res.body as ConversationBody).conversation.designation).toBeUndefined();
  });

  it('rejects an unknown token', async () => {
    const { app, conversationId } = boot();
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { designation: 'auditor' });
    expect(res.status).toBe(400);
  });

  it('accepts a custom after it is added to the catalogue', async () => {
    const { app, conversationId, db } = boot();
    const added = addCustomDesignation(db, 'auditor');
    expect(added.ok).toBe(true);
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { designation: 'auditor' });
    expect(res.status).toBe(200);
    expect((res.body as ConversationBody).conversation.designation).toBe('auditor');
  });

  it('keeps a stored token after its custom is removed from settings', async () => {
    const { app, conversationId, db } = boot();
    addCustomDesignation(db, 'auditor');
    await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { designation: 'auditor' });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('conversation_designations', ?)").run('[]');
    expect(getConversation(db, conversationId)?.designation).toBe('auditor');
  });

  it('rejects spaces and free-form strings', async () => {
    const { app, conversationId } = boot();
    const res = await fetchJson(app, 'PATCH', `/conversations/${conversationId}`, { designation: 'code review' });
    expect(res.status).toBe(400);
  });
});
