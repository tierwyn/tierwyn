import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { insertSummary } from '../repositories/summaries.js';
import { registerSummaryRoutes } from './summaries.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  const app = express();
  registerSummaryRoutes(app, () => db);
  return { db, app, conversationId: c.id };
}

describe('GET /conversations/:id/summaries', () => {
  it('returns [] when there are none', async () => {
    const { app, conversationId } = boot();
    const res = await fetch_(app, `/conversations/${conversationId}/summaries`);
    expect(res.summaries).toEqual([]);
  });

  it('returns stored summaries in creation order', async () => {
    const { db, app, conversationId } = boot();
    insertSummary(db, { conversation_id: conversationId, last_event_id: 'e1', summary_text: 'first' });
    const res = await fetch_(app, `/conversations/${conversationId}/summaries`);
    expect(res.summaries).toHaveLength(1);
    expect(res.summaries[0].summary_text).toBe('first');
    expect(res.summaries[0].last_event_id).toBe('e1');
  });
});

// Minimal in-process request helper (no supertest dependency).
function fetch_(app: express.Express, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`)
        .then((r) => r.json())
        .then((j) => { server.close(); resolve(j); })
        .catch((e) => { server.close(); reject(e); });
    });
  });
}
