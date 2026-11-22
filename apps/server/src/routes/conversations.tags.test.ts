import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import {
  createConversation,
  getConversation,
  listConversations,
} from '../repositories/conversations.js';
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

const tagsOf = (body: unknown) => (body as { conversation: { tags?: string[] } }).conversation.tags;
const errorOf = (body: unknown) => (body as { error: string }).error;

describe('PATCH /conversations/:id tags', () => {
  it('defaults an untouched conversation to an empty tag array', () => {
    const { db, conversationId } = boot();
    expect(getConversation(db, conversationId)?.tags).toEqual([]);
  });

  it('round-trips ["research","bug"] through PATCH, get and list', async () => {
    const { db, app, projectId, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { tags: ['research', 'bug'] });
    expect(res.status).toBe(200);
    expect(tagsOf(res.body)).toEqual(['research', 'bug']);
    expect(getConversation(db, conversationId)?.tags).toEqual(['research', 'bug']);
    const listed = listConversations(db, projectId).find((c) => c.id === conversationId);
    expect(listed?.tags).toEqual(['research', 'bug']);
  });

  it('trims and de-duplicates before persisting', async () => {
    const { db, app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, {
      tags: ['  bug  ', 'bug', 'Bug', '   '],
    });
    expect(res.status).toBe(200);
    expect(tagsOf(res.body)).toEqual(['bug', 'Bug']);
    expect(getConversation(db, conversationId)?.tags).toEqual(['bug', 'Bug']);
  });

  it('clears tags when passed an empty array', async () => {
    const { db, app, conversationId } = boot();
    await fetchPatch(app, `/conversations/${conversationId}`, { tags: ['bug'] });
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { tags: [] });
    expect(res.status).toBe(200);
    expect(tagsOf(res.body)).toEqual([]);
    expect(getConversation(db, conversationId)?.tags).toEqual([]);
  });

  it('leaves existing tags untouched when the field is absent', async () => {
    const { db, app, conversationId } = boot();
    await fetchPatch(app, `/conversations/${conversationId}`, { tags: ['bug'] });
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { title: 'Renamed' });
    expect(res.status).toBe(200);
    expect(getConversation(db, conversationId)?.tags).toEqual(['bug']);
    expect(getConversation(db, conversationId)?.title).toBe('Renamed');
  });

  it('applies tags alongside another field in the same PATCH', async () => {
    const { db, app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, {
      title: 'Tagged', tags: ['research'],
    });
    expect(res.status).toBe(200);
    const after = getConversation(db, conversationId);
    expect(after?.title).toBe('Tagged');
    expect(after?.tags).toEqual(['research']);
  });

  it('tags a spawn child (no root-only rule, unlike pin and move)', async () => {
    const { db, app, projectId, conversationId } = boot();
    const child = createConversation(db, {
      projectId, title: 'child', parentConversationId: conversationId,
    });
    const res = await fetchPatch(app, `/conversations/${child.id}`, { tags: ['bug'] });
    expect(res.status).toBe(200);
    expect(getConversation(db, child.id)?.tags).toEqual(['bug']);
  });

  it('rejects an 11th tag with 400 and persists nothing', async () => {
    const { db, app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, {
      tags: Array.from({ length: 11 }, (_, i) => `t${i}`),
    });
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatch(/10/);
    expect(getConversation(db, conversationId)?.tags).toEqual([]);
  });

  it('rejects a 33-character tag with 400', async () => {
    const { db, app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { tags: ['x'.repeat(33)] });
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatch(/32/);
    expect(getConversation(db, conversationId)?.tags).toEqual([]);
  });

  it('rejects a non-array tags value with 400', async () => {
    const { app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { tags: 'bug' });
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatch(/array of strings/);
  });

  it('rejects a non-string element with 400', async () => {
    const { app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { tags: ['bug', 7] });
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatch(/array of strings/);
  });

  it('rejects a tag containing a newline with 400', async () => {
    const { app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { tags: ['a\nb'] });
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatch(/control character/);
  });

  it('returns 404 for an unknown conversation id', async () => {
    const { app } = boot();
    const res = await fetchPatch(app, '/conversations/no-such-id', { tags: ['bug'] });
    expect(res.status).toBe(404);
    expect(errorOf(res.body)).toMatch(/no such conversation/);
  });

  it('still 400s an entirely empty PATCH body and names tags in the error', async () => {
    const { app, conversationId } = boot();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, {});
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatch(/tags/);
  });

  it('degrades a malformed tags column to [] instead of throwing', () => {
    const { db, projectId, conversationId } = boot();
    db.prepare('UPDATE conversations SET tags = ? WHERE id = ?').run('{not json', conversationId);
    expect(() => getConversation(db, conversationId)).not.toThrow();
    expect(getConversation(db, conversationId)?.tags).toEqual([]);
    expect(() => listConversations(db, projectId)).not.toThrow();
  });

  it('drops non-string elements found in the stored column', () => {
    const { db, conversationId } = boot();
    db.prepare('UPDATE conversations SET tags = ? WHERE id = ?').run('["bug", 7, null]', conversationId);
    expect(getConversation(db, conversationId)?.tags).toEqual(['bug']);
  });

  it('dedups duplicate strings already stored in the column (F7)', () => {
    const { db, conversationId } = boot();
    db.prepare('UPDATE conversations SET tags = ? WHERE id = ?').run('["dup","dup"]', conversationId);
    expect(getConversation(db, conversationId)?.tags).toEqual(['dup']);
  });

  it('broadcasts conversation_updated with the new tags (F10)', async () => {
    const frames: unknown[] = [];
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    seedDefaultSettings(db);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'C' });
    const app = express();
    app.use(express.json());
    registerConversationMutationRoutes(app, {
      getDb: () => db,
      broadcastAll: (frame) => { frames.push(frame); },
    });
    const res = await fetchPatch(app, `/conversations/${c.id}`, { tags: ['bug'] });
    expect(res.status).toBe(200);
    expect(frames).toEqual([
      expect.objectContaining({
        type: 'conversation_updated',
        conversationId: c.id,
        tags: ['bug'],
      }),
    ]);
  });
});
