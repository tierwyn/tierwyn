import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { insertHandoff } from '../repositories/handoffs.js';
import { registerHandoffRoutes } from './handoffs.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  const app = express();
  registerHandoffRoutes(app, () => db);
  return { db, app, conversationId: c.id };
}

describe('GET /conversations/:id/handoffs', () => {
  it('returns [] when there are none', async () => {
    const { app, conversationId } = boot();
    const res = await fetch_(app, `/conversations/${conversationId}/handoffs`);
    expect(res.handoffs).toEqual([]);
  });

  it('returns stored handoffs in creation order', async () => {
    const { db, app, conversationId } = boot();
    insertHandoff(db, {
      conversation_id: conversationId,
      from_profile_id: 'claude-code:claude-sonnet-4-5',
      to_profile_id: 'opencode:gpt-4o',
      requested_mode: 'summary',
      resolved_mode: 'compacted',
      anchor_event_id: 'evt-1',
      summary_id: null,
      priming_context: null,
    });
    insertHandoff(db, {
      conversation_id: conversationId,
      from_profile_id: 'opencode:gpt-4o',
      to_profile_id: 'claude-code:claude-sonnet-4-5',
      requested_mode: 'transcript',
      resolved_mode: 'transcript',
      anchor_event_id: 'evt-2',
      summary_id: null,
      priming_context: 'Resuming a prior conversation.\n\nUSER: hi',
    });
    const res = await fetch_(app, `/conversations/${conversationId}/handoffs`);
    expect(res.handoffs).toHaveLength(2);
    expect(res.handoffs[0].from_profile_id).toBe('claude-code:claude-sonnet-4-5');
    expect(res.handoffs[0].resolved_mode).toBe('compacted');
    expect(res.handoffs[1].from_profile_id).toBe('opencode:gpt-4o');
    expect(res.handoffs[1].resolved_mode).toBe('transcript');
    expect(res.handoffs[1].priming_context).toContain('USER: hi');
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
