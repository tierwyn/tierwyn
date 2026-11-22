import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import {
  createConversation, createScheduleHomeConversation, getConversation,
} from '../repositories/conversations.js';
import { registerConversationBulkRoutes } from './conversationsBulk.js';

type BulkResult = { id: string; ok: boolean; error?: string; skipped?: string };
type BulkBody = { results?: BulkResult[]; deletedIds?: string[]; error?: string };

/** Two projects (A, B) and a stub SessionManager whose in-flight set is explicit. */
function boot(opts: { inFlightIds?: string[] } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const a = createProject(db, { name: 'A', rootPath: '/a' });
  const b = createProject(db, { name: 'B', rootPath: '/b' });

  // Mutable so a test can mark a conversation busy AFTER creating it — the ids
  // are generated, so they cannot be passed to boot() up front.
  const inFlight = new Set(opts.inFlightIds ?? []);
  const sessionManager = {
    inFlightSessionForConversation: (id: string) => (inFlight.has(id) ? ({} as never) : undefined),
    reapParkedSessions: async () => {},
  };

  const notified: string[] = [];
  const app = express();
  app.use(express.json());
  registerConversationBulkRoutes(app, {
    getDb: () => db,
    sessionManager: sessionManager as never,
    notifyConversationUpdated: (id: string) => { notified.push(id); },
  });
  return { db, app, projectA: a.id, projectB: b.id, notified, inFlight };
}

/** POST JSON against an ephemeral listener; returns status + parsed body. */
function post(app: express.Express, body: unknown): Promise<{ status: number; json: BulkBody }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}/conversations/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as BulkBody }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const resultFor = (json: BulkBody, id: string): BulkResult =>
  (json.results ?? []).find((r) => r.id === id)!;

describe('POST /conversations/bulk — request shape', () => {
  it('400s an unknown action', async () => {
    const { app } = boot();
    const res = await post(app, { action: 'explode', ids: ['x'] });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('action must be one of: delete, move, pin, unpin, archive, unarchive');
  });

  it('400s a missing action before it looks at ids', async () => {
    const { app } = boot();
    const res = await post(app, { ids: [] });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('action must be one of: delete, move, pin, unpin, archive, unarchive');
  });

  it('400s an empty ids array', async () => {
    const { app } = boot();
    const res = await post(app, { action: 'delete', ids: [] });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('ids (non-empty string[]) required');
  });

  it('400s a non-array or non-string-element ids', async () => {
    const { app } = boot();
    for (const ids of [undefined, 'abc', [1, 2], ['ok', ''], ['ok', null]]) {
      const res = await post(app, { action: 'pin', ids });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('ids (non-empty string[]) required');
    }
  });

  it('400s more than 50 ids', async () => {
    const { app } = boot();
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const res = await post(app, { action: 'delete', ids });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('too many ids (max 50)');

    const ok = await post(app, { action: 'delete', ids: ids.slice(0, 50) });
    expect(ok.status).toBe(200);
  });

  it('400s move without a projectId', async () => {
    const { db, app, projectA } = boot();
    const c = createConversation(db, { projectId: projectA, title: 'C' });
    for (const body of [
      { action: 'move', ids: [c.id] },
      { action: 'move', ids: [c.id], projectId: '   ' },
      { action: 'move', ids: [c.id], projectId: 7 },
    ]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('projectId (non-empty string) required for move');
    }
    expect(getConversation(db, c.id)?.projectId).toBe(projectA);
  });

  it('404s move to an unknown project, before touching any row', async () => {
    const { db, app, projectA } = boot();
    const c = createConversation(db, { projectId: projectA, title: 'C' });
    const res = await post(app, { action: 'move', ids: [c.id], projectId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('no such project');
    expect(getConversation(db, c.id)?.projectId).toBe(projectA);
  });

  it('dedupes repeated ids into a single result', async () => {
    const { db, app, projectA } = boot();
    const c = createConversation(db, { projectId: projectA, title: 'C' });
    const res = await post(app, { action: 'pin', ids: [c.id, c.id, c.id] });
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([{ id: c.id, ok: true }]);
  });
});

describe('POST /conversations/bulk — delete', () => {
  it('deletes two roots and reports both ok', async () => {
    const { db, app, projectA } = boot();
    const c1 = createConversation(db, { projectId: projectA, title: 'one' });
    const c2 = createConversation(db, { projectId: projectA, title: 'two' });
    const keep = createConversation(db, { projectId: projectA, title: 'keep' });

    const res = await post(app, { action: 'delete', ids: [c1.id, c2.id] });

    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([{ id: c1.id, ok: true }, { id: c2.id, ok: true }]);
    expect(getConversation(db, c1.id)).toBeUndefined();
    expect(getConversation(db, c2.id)).toBeUndefined();
    expect(getConversation(db, keep.id)).toBeDefined();
  });

  it('includes cascaded descendants in deletedIds', async () => {
    const { db, app, projectA } = boot();
    const root = createConversation(db, { projectId: projectA, title: 'root' });
    const child = createConversation(db, {
      projectId: projectA, title: 'child', parentConversationId: root.id,
    });

    const res = await post(app, { action: 'delete', ids: [root.id] });

    expect(res.status).toBe(200);
    expect(res.json.deletedIds).toContain(root.id);
    expect(res.json.deletedIds).toContain(child.id);
    expect(getConversation(db, child.id)).toBeUndefined();
  });

  it('reports a child already removed by its parent cascade as skipped, not 404', async () => {
    const { db, app, projectA } = boot();
    const root = createConversation(db, { projectId: projectA, title: 'root' });
    const child = createConversation(db, {
      projectId: projectA, title: 'child', parentConversationId: root.id,
    });

    const res = await post(app, { action: 'delete', ids: [root.id, child.id] });

    expect(res.status).toBe(200);
    expect(resultFor(res.json, root.id)).toEqual({ id: root.id, ok: true });
    expect(resultFor(res.json, child.id)).toEqual({ id: child.id, ok: true, skipped: 'already deleted' });
  });

  it('handles a child listed before its parent', async () => {
    const { db, app, projectA } = boot();
    const root = createConversation(db, { projectId: projectA, title: 'root' });
    const child = createConversation(db, {
      projectId: projectA, title: 'child', parentConversationId: root.id,
    });

    const res = await post(app, { action: 'delete', ids: [child.id, root.id] });

    expect(res.status).toBe(200);
    expect(resultFor(res.json, child.id).ok).toBe(true);
    expect(resultFor(res.json, root.id).ok).toBe(true);
    expect(getConversation(db, root.id)).toBeUndefined();
  });

  it('reports a missing id without aborting the batch', async () => {
    const { db, app, projectA } = boot();
    const real = createConversation(db, { projectId: projectA, title: 'real' });

    const res = await post(app, { action: 'delete', ids: ['ghost', real.id] });

    expect(res.status).toBe(200);
    expect(resultFor(res.json, 'ghost')).toEqual({ id: 'ghost', ok: false, error: 'no such conversation' });
    expect(resultFor(res.json, real.id).ok).toBe(true);
    expect(getConversation(db, real.id)).toBeUndefined();
  });

  it('refuses a schedule home per-id and still deletes its sibling', async () => {
    const { db, app, projectA } = boot();
    const home = createScheduleHomeConversation(db, { projectId: projectA, jobName: 'nightly' });
    const sibling = createConversation(db, { projectId: projectA, title: 'sibling' });

    const res = await post(app, { action: 'delete', ids: [home.id, sibling.id] });

    expect(res.status).toBe(200);
    expect(resultFor(res.json, home.id)).toEqual({
      id: home.id,
      ok: false,
      error: 'cannot delete schedule home conversation; delete the schedule job instead',
    });
    expect(getConversation(db, home.id)).toBeDefined();
    expect(getConversation(db, sibling.id)).toBeUndefined();
  });

  it('refuses an in-flight conversation per-id and still deletes its sibling', async () => {
    const { db, app, projectA, inFlight } = boot();
    const busy = createConversation(db, { projectId: projectA, title: 'busy' });
    const quiet = createConversation(db, { projectId: projectA, title: 'quiet' });
    inFlight.add(busy.id);

    const res = await post(app, { action: 'delete', ids: [busy.id, quiet.id] });

    expect(res.status).toBe(200);
    expect(resultFor(res.json, busy.id)).toEqual({
      id: busy.id, ok: false, error: 'conversation tree has a live session',
    });
    expect(getConversation(db, busy.id)).toBeDefined();
    expect(getConversation(db, quiet.id)).toBeUndefined();
    expect(res.json.deletedIds).toEqual([quiet.id]);
  });
});

describe('POST /conversations/bulk — move', () => {
  it('moves two roots into the target project', async () => {
    const { db, app, projectA, projectB, notified } = boot();
    const c1 = createConversation(db, { projectId: projectA, title: 'one' });
    const c2 = createConversation(db, { projectId: projectA, title: 'two' });

    const res = await post(app, { action: 'move', ids: [c1.id, c2.id], projectId: projectB });

    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([{ id: c1.id, ok: true }, { id: c2.id, ok: true }]);
    expect(getConversation(db, c1.id)?.projectId).toBe(projectB);
    expect(getConversation(db, c2.id)?.projectId).toBe(projectB);
    expect(notified).toEqual([c1.id, c2.id]);
    expect(res.json.deletedIds).toBeUndefined();
  });

  it('moves a root together with its spawn subtree', async () => {
    const { db, app, projectA, projectB } = boot();
    const root = createConversation(db, { projectId: projectA, title: 'root' });
    const child = createConversation(db, {
      projectId: projectA, title: 'child', parentConversationId: root.id,
    });

    await post(app, { action: 'move', ids: [root.id], projectId: projectB });

    expect(getConversation(db, child.id)?.projectId).toBe(projectB);
  });

  it('fails a spawn child per-id rather than skipping it', async () => {
    const { db, app, projectA, projectB } = boot();
    const root = createConversation(db, { projectId: projectA, title: 'root' });
    const child = createConversation(db, {
      projectId: projectA, title: 'child', parentConversationId: root.id,
    });
    const other = createConversation(db, { projectId: projectA, title: 'other' });

    const res = await post(app, { action: 'move', ids: [child.id, other.id], projectId: projectB });

    expect(res.status).toBe(200);
    expect(resultFor(res.json, child.id)).toEqual({
      id: child.id, ok: false, error: 'move applies to root conversations only',
    });
    expect(resultFor(res.json, other.id).ok).toBe(true);
    expect(getConversation(db, other.id)?.projectId).toBe(projectB);
    void root;
  });

  it('fails a schedule home per-id and reports a missing id', async () => {
    const { db, app, projectA, projectB } = boot();
    const home = createScheduleHomeConversation(db, { projectId: projectA, jobName: 'nightly' });
    const real = createConversation(db, { projectId: projectA, title: 'real' });

    const res = await post(app, {
      action: 'move', ids: [home.id, 'ghost', real.id], projectId: projectB,
    });

    expect(res.status).toBe(200);
    expect(resultFor(res.json, home.id)).toEqual({
      id: home.id,
      ok: false,
      error: 'cannot move schedule home conversation; move the schedule job instead',
    });
    expect(resultFor(res.json, 'ghost')).toEqual({ id: 'ghost', ok: false, error: 'no such conversation' });
    expect(resultFor(res.json, real.id).ok).toBe(true);
    expect(getConversation(db, home.id)?.projectId).toBe(projectA);
  });

  it('treats a same-project move as an ok no-op with no broadcast', async () => {
    const { db, app, projectA, notified } = boot();
    const c = createConversation(db, { projectId: projectA, title: 'C' });
    const res = await post(app, { action: 'move', ids: [c.id], projectId: projectA });
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([{ id: c.id, ok: true }]);
    expect(notified).toEqual([]);
  });
});

describe('POST /conversations/bulk — pin / unpin', () => {
  it('pins roots and silently skips spawn children', async () => {
    const { db, app, projectA } = boot();
    const root = createConversation(db, { projectId: projectA, title: 'root' });
    const child = createConversation(db, {
      projectId: projectA, title: 'child', parentConversationId: root.id,
    });

    const res = await post(app, { action: 'pin', ids: [root.id, child.id] });

    expect(res.status).toBe(200);
    expect(resultFor(res.json, root.id)).toEqual({ id: root.id, ok: true });
    expect(resultFor(res.json, child.id)).toEqual({ id: child.id, ok: true, skipped: 'not a root' });
    expect(getConversation(db, root.id)?.pinned).toBe(true);
    expect(getConversation(db, child.id)?.pinned).toBeUndefined();
  });

  it('returns 200 with everything skipped for a children-only selection', async () => {
    const { db, app, projectA } = boot();
    const root = createConversation(db, { projectId: projectA, title: 'root' });
    const c1 = createConversation(db, {
      projectId: projectA, title: 'c1', parentConversationId: root.id,
    });
    const c2 = createConversation(db, {
      projectId: projectA, title: 'c2', parentConversationId: root.id,
    });

    const res = await post(app, { action: 'pin', ids: [c1.id, c2.id] });

    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([
      { id: c1.id, ok: true, skipped: 'not a root' },
      { id: c2.id, ok: true, skipped: 'not a root' },
    ]);
  });

  it('unpins roots', async () => {
    const { db, app, projectA } = boot();
    const c1 = createConversation(db, { projectId: projectA, title: 'one' });
    const c2 = createConversation(db, { projectId: projectA, title: 'two' });
    await post(app, { action: 'pin', ids: [c1.id, c2.id] });

    const res = await post(app, { action: 'unpin', ids: [c1.id, c2.id] });

    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([{ id: c1.id, ok: true }, { id: c2.id, ok: true }]);
    expect(getConversation(db, c1.id)?.pinned).toBeFalsy();
    expect(getConversation(db, c2.id)?.pinned).toBeFalsy();
  });

  it('reports a missing id on pin without aborting', async () => {
    const { db, app, projectA } = boot();
    const c = createConversation(db, { projectId: projectA, title: 'C' });
    const res = await post(app, { action: 'pin', ids: ['ghost', c.id] });
    expect(res.status).toBe(200);
    expect(resultFor(res.json, 'ghost')).toEqual({ id: 'ghost', ok: false, error: 'no such conversation' });
    expect(getConversation(db, c.id)?.pinned).toBe(true);
  });
});
