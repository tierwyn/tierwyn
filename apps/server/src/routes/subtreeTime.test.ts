import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent } from '../repositories/events.js';
import { computeSubtreeTime, _resetSubtreeTimeCache } from '../subtreeTime.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const root = createConversation(db, { projectId: p.id, title: 'Root' });
  const child = createConversation(db, { projectId: p.id, title: 'Child', parentConversationId: root.id });

  const app = express();
  app.use(express.json());

  app.get('/conversations/:id/subtree-time', async (req, res) => {
    if (!getConversation(db, req.params.id)) return res.status(404).json({ error: 'not_found' });
    try {
      res.json(await computeSubtreeTime(db, req.params.id));
    } catch (err) {
      console.error('[subtreeTime] failed to compute subtree time for', req.params.id, err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return { db, app, projectId: p.id, rootId: root.id, childId: child.id };
}

async function call(app: express.Express, path: string) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, json: await r.json() };
  } finally {
    server.close();
  }
}

describe('GET /conversations/:id/subtree-time', () => {
  beforeEach(() => {
    _resetSubtreeTimeCache();
  });

  it('returns 404 for an unknown conversation id', async () => {
    const { app } = boot();
    const res = await call(app, '/conversations/unknown-id-12345/subtree-time');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not_found' });
  });

  it('returns 200 with the summary shape for a root with one child', async () => {
    const { app, db, rootId, childId } = boot();

    createSession(db, { id: 's-root', conversationId: rootId });
    createSession(db, { id: 's-child', conversationId: childId });

    appendEvent(db, { sessionId: 's-root', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's-root', type: 'message', payload: {}, sender: 'agent', ts: 3000, seq: 2 });

    appendEvent(db, { sessionId: 's-child', type: 'prompt', payload: {}, sender: 'user', ts: 2000, seq: 1 });
    appendEvent(db, { sessionId: 's-child', type: 'message', payload: {}, sender: 'agent', ts: 6000, seq: 2 });

    const res = await call(app, `/conversations/${rootId}/subtree-time`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      rootConversationId: rootId,
      selfMs: 2000,
      descendantsMs: 4000,
      totalMs: 6000,
      descendantCount: 1,
      truncated: false,
      omittedCount: 0,
    });
    expect(res.json.nodes).toHaveLength(2);
    expect(res.json.nodes[0]).toMatchObject({
      conversationId: rootId,
      parentConversationId: null,
      depth: 0,
      workedMs: 2000,
      turns: 1,
    });
    expect(res.json.nodes[1]).toMatchObject({
      conversationId: childId,
      parentConversationId: rootId,
      depth: 1,
      workedMs: 4000,
      turns: 1,
    });
  });
});
