import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { createConversation, getConversation } from './repositories/conversations.js';
import { saveTemplate } from './repositories/settings.js';
import { registerConversationMutationRoutes } from './routes/conversations.js';

function appWithDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  db.prepare('INSERT INTO projects (id,name,root_path,created_at) VALUES (?,?,?,?)').run('p', 'p', '/tmp', Date.now());
  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, () => db);
  return { app, db };
}

async function call(app: express.Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  } finally { server.close(); }
}

describe('conversation mutation routes', () => {
  it('PATCH renames a conversation', async () => {
    const { app, db } = appWithDb();
    const c = createConversation(db, { projectId: 'p', title: 'old' });
    const res = await call(app, 'PATCH', `/conversations/${c.id}`, { title: 'new' });
    expect(res.status).toBe(200);
    expect(res.json.conversation.title).toBe('new');
  });

  it('DELETE removes a conversation', async () => {
    const { app, db } = appWithDb();
    const c = createConversation(db, { projectId: 'p', title: 't' });
    const res = await call(app, 'DELETE', `/conversations/${c.id}`);
    expect(res.status).toBe(200);
    expect(getConversation(db, c.id)).toBeUndefined();
  });

  it('DELETE on missing id returns 404', async () => {
    const { app } = appWithDb();
    const res = await call(app, 'DELETE', `/conversations/missing`);
    expect(res.status).toBe(404);
  });

  it('PATCH attaches a known template', async () => {
    const { app, db } = appWithDb();
    saveTemplate(db, { name: 't1', roles: [] });
    const c = createConversation(db, { projectId: 'p', title: 't' });
    const res = await call(app, 'PATCH', `/conversations/${c.id}`, { templateName: 't1' });
    expect(res.status).toBe(200);
    expect(res.json.conversation.templateName).toBe('t1');
    expect(getConversation(db, c.id)?.templateName).toBe('t1');
  });

  it('PATCH rejects an unknown template', async () => {
    const { app, db } = appWithDb();
    const c = createConversation(db, { projectId: 'p', title: 't' });
    const res = await call(app, 'PATCH', `/conversations/${c.id}`, { templateName: 'nope' });
    expect(res.status).toBe(400);
  });

  it('PATCH clears template with null', async () => {
    const { app, db } = appWithDb();
    saveTemplate(db, { name: 't1', roles: [] });
    const c = createConversation(db, { projectId: 'p', title: 't' });
    call(app, 'PATCH', `/conversations/${c.id}`, { templateName: 't1' });
    const res = await call(app, 'PATCH', `/conversations/${c.id}`, { templateName: null });
    expect(res.status).toBe(200);
    expect(res.json.conversation.templateName).toBeUndefined();
  });
});
