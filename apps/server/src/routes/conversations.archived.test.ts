import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation, listConversations } from '../repositories/conversations.js';
import { listPurgeCandidates } from '../repositories/retention.js';
import { registerConversationMutationRoutes } from './conversations.js';
import { registerConversationBulkRoutes } from './conversationsBulk.js';

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
  const frames: Array<Record<string, unknown>> = [];
  registerConversationMutationRoutes(app, { getDb: () => db, broadcastAll: (f) => frames.push(f as Record<string, unknown>) });
  registerConversationBulkRoutes(app, { getDb: () => db, broadcastAll: (f) => frames.push(f as Record<string, unknown>) });
  return { db, app, frames, projectId: p.id, conversationId: c.id };
}

function fetchReq(
  app: express.Express,
  method: 'PATCH' | 'POST',
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (r) => ({ status: r.status, body: await r.json() }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('PATCH /conversations/:id archived', () => {
  it('archives + unarchives and broadcasts conversation_updated each time', async () => {
    const { app, frames, conversationId } = boot();
    const on = await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { archived: true });
    expect(on.status).toBe(200);
    expect((on.body as { conversation: { archived?: boolean } }).conversation.archived).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: 'conversation_updated', conversationId, archived: true });

    const off = await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { archived: false });
    expect(off.status).toBe(200);
    expect((off.body as { conversation: { archived?: boolean } }).conversation.archived).toBeUndefined();
    expect(frames.at(-1)).toMatchObject({ type: 'conversation_updated', conversationId, archived: false });
  });

  it('hides the row from listConversations until includeArchived', async () => {
    const { db, app, projectId, conversationId } = boot();
    expect(listConversations(db, projectId)).toHaveLength(1);
    await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { archived: true });
    expect(listConversations(db, projectId)).toHaveLength(0);
    expect(listConversations(db, projectId, { includeArchived: true })).toHaveLength(1);
  });

  it('rejects non-boolean archived with 400', async () => {
    const { app, conversationId } = boot();
    const res = await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { archived: 'yes' });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/boolean/);
  });

  it('rejects archiving a spawn child with 400', async () => {
    const { db, app, projectId, conversationId } = boot();
    const child = createConversation(db, {
      projectId,
      title: 'child',
      parentConversationId: conversationId,
    });
    const res = await fetchReq(app, 'PATCH', `/conversations/${child.id}`, { archived: true });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/root/i);
    expect(getConversation(db, child.id)?.archived).toBeUndefined();
  });

  it('exempts archived rows from the retention purge', () => {
    const { db, projectId } = boot();
    const old = createConversation(db, { projectId, title: 'old' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now() - 90 * 86_400_000, old.id);
    expect(listPurgeCandidates(db, 30).map((c) => c.id)).toContain(old.id);
    db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(old.id);
    expect(listPurgeCandidates(db, 30).map((c) => c.id)).not.toContain(old.id);
  });
});

describe('POST /conversations/bulk archive', () => {
  it('archives and unarchives roots, skips children', async () => {
    const { db, app, projectId, conversationId } = boot();
    const child = createConversation(db, {
      projectId,
      title: 'child',
      parentConversationId: conversationId,
    });
    const res = await fetchReq(app, 'POST', '/conversations/bulk', {
      action: 'archive',
      ids: [conversationId, child.id],
    });
    expect(res.status).toBe(200);
    const { results } = res.body as { results: Array<{ id: string; ok: boolean; skipped?: string }> };
    expect(results).toEqual([
      { id: conversationId, ok: true },
      { id: child.id, ok: true, skipped: 'not a root' },
    ]);
    expect(getConversation(db, conversationId)?.archived).toBe(true);
    expect(getConversation(db, child.id)?.archived).toBeUndefined();

    const back = await fetchReq(app, 'POST', '/conversations/bulk', {
      action: 'unarchive',
      ids: [conversationId],
    });
    expect(back.status).toBe(200);
    expect(getConversation(db, conversationId)?.archived).toBeUndefined();
  });
});

describe('PATCH /conversations/:id composer settings', () => {
  it('broadcasts settingsChanged for permissionMode and MCP, not for unrelated fields', async () => {
    const { db, app, frames, conversationId } = boot();
    expect((await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { permissionMode: 'prompt' })).status).toBe(200);
    expect(frames.at(-1)).toMatchObject({ type: 'conversation_updated', conversationId, settingsChanged: true });
    expect((await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { mcpServers: [] })).status).toBe(200);
    expect(frames.at(-1)).toMatchObject({ settingsChanged: true });
    expect((await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { effort: 'turbo' })).status).toBe(400);
    expect((await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { effort: 'high' })).status).toBe(200);
    expect(frames.at(-1)).toMatchObject({ settingsChanged: true });
    expect(getConversation(db, conversationId)?.effort).toBe('high');
    expect((await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { effort: null })).status).toBe(200);
    expect(getConversation(db, conversationId)?.effort).toBeUndefined();
    const n = frames.length;
    await fetchReq(app, 'PATCH', `/conversations/${conversationId}`, { archived: true });
    expect(frames.slice(n).some((f) => f.settingsChanged)).toBe(false);
  });
});
