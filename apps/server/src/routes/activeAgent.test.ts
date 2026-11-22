import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { getCompactionSettings, updateCompactionSettings } from '../repositories/settings.js';
import { lastSessionForConversation } from '../repositories/sessions.js';

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

  app.get('/conversations/:id/active-agent', async (req, res) => {
    const agentId = typeof req.query.agentId === 'string'
      ? req.query.agentId
      : (typeof req.query.agent === 'string' ? req.query.agent : undefined);
    const last = lastSessionForConversation(db, req.params.id, agentId ? { agentId } : {});
    const nativeAvailable = false;
    const lastGlobal = lastSessionForConversation(db, req.params.id);
    const compactionSettings = getCompactionSettings(db);
    const contextResumable = Boolean(
      lastGlobal && (compactionSettings.compactionEnabled || compactionSettings.handoffMode === 'transcript')
    );
    res.json({ lastSession: last, nativeAvailable, contextResumable });
  });

  return { db, app, projectId: p.id, conversationId: c.id };
}

async function call(app: express.Express, path: string) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, json: await r.json() };
  } finally { server.close(); }
}

describe('GET /conversations/:id/active-agent', () => {
  it('returns contextResumable: false on a fresh conversation without sessions', async () => {
    const { app, conversationId } = boot();
    const res = await call(app, `/conversations/${conversationId}/active-agent`);
    expect(res.status).toBe(200);
    expect(res.json.contextResumable).toBe(false);
    expect(res.json.nativeAvailable).toBe(false);
  });

  it('returns contextResumable: true when a prior session exists and compaction is enabled', async () => {
    const { app, db, conversationId } = boot();
    createSession(db, {
      id: 'sess-1',
      conversationId,
      agentId: 'claude-code',
      agentModelId: 'claude-code:opus-4.8',
    });
    const res = await call(app, `/conversations/${conversationId}/active-agent`);
    expect(res.status).toBe(200);
    expect(res.json.contextResumable).toBe(true);
    expect(res.json.lastSession).toMatchObject({ id: 'sess-1', agentId: 'claude-code' });
  });

  it('returns contextResumable: false when compaction is disabled and handoffMode is not transcript', async () => {
    const { app, db, conversationId } = boot();
    createSession(db, {
      id: 'sess-1',
      conversationId,
      agentId: 'claude-code',
      agentModelId: 'claude-code:opus-4.8',
    });
    updateCompactionSettings(db, { compactionEnabled: false, handoffMode: 'summary' });
    const res = await call(app, `/conversations/${conversationId}/active-agent`);
    expect(res.status).toBe(200);
    expect(res.json.contextResumable).toBe(false);
  });

  it('scopes lastSession lookup when agentId query param is provided', async () => {
    const { app, db, conversationId } = boot();
    createSession(db, {
      id: 'sess-1',
      conversationId,
      agentId: 'claude-code',
      agentModelId: 'claude-code:opus-4.8',
    });
    const res = await call(app, `/conversations/${conversationId}/active-agent?agentId=pi`);
    expect(res.status).toBe(200);
    expect(res.json.lastSession).toBeUndefined();
    expect(res.json.contextResumable).toBe(true);
  });
});
