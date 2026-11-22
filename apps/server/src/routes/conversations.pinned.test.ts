import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { registerConversationMutationRoutes } from './conversations.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });

  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, { getDb: () => db });
  return { db, app, projectId: p.id, conversationId: c.id };
}

function fetchPatch(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (r) => ({ status: r.status, body: await r.json() }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('PATCH /conversations/:id pinned', () => {
  it('sets pinned:true and returns conversation.pinned === true', async () => {
    const { app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { pinned: true });
    expect(res.status).toBe(200);
    expect((res.body as { conversation: { pinned?: boolean } }).conversation.pinned).toBe(true);
  });

  it('rejects pinned:"yes" with 400', async () => {
    const { app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { pinned: 'yes' });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/boolean/);
  });

  it('rejects pinning a spawn child with 400', async () => {
    const { db, app, projectId, conversationId } = boot();
    const child = createConversation(db, {
      projectId,
      title: 'child',
      parentConversationId: conversationId,
    });
    const res = await fetchPatch(app, `/conversations/${child.id}`, { pinned: true });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/root/i);
    expect(getConversation(db, child.id)?.pinned).toBeUndefined();
  });
});
