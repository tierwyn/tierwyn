import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createScheduleHomeConversation } from '../repositories/conversations.js';
import { createJob, getJob, createRun } from '../repositories/schedules.js';
import { ONCE_EXHAUSTED_MS } from '../schedules/nextFire.js';
import { registerScheduleBulkRoutes } from './schedulesBulk.js';

type BulkResult = { id: string; ok: boolean; error?: string; skipped?: string };
type BulkBody = { results?: BulkResult[]; deletedConversationIds?: string[]; deletedIds?: string[]; error?: string };

function boot(opts: { inFlightIds?: string[] } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const a = createProject(db, { name: 'A', rootPath: '/a' });
  const b = createProject(db, { name: 'B', rootPath: '/b' });

  const inFlight = new Set(opts.inFlightIds ?? []);
  const sessionManager = {
    activeSessionForConversation: () => undefined,
    inFlightSessionForConversation: (id: string) => (inFlight.has(id) ? ({} as never) : undefined),
    reapParkedSessions: async () => {},
  };

  const broadcasts: Array<{ projectId: string; jobId: string }> = [];
  const app = express();
  app.use(express.json());
  registerScheduleBulkRoutes(app, {
    getDb: () => db,
    sessionManager: sessionManager as never,
    broadcast: (projectId, jobId) => { broadcasts.push({ projectId, jobId }); },
  });
  return { db, app, projectA: a.id, projectB: b.id, broadcasts, inFlight };
}

function post(app: express.Express, body: unknown): Promise<{ status: number; json: BulkBody }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}/schedules/bulk`, {
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

function makeJob(db: Database.Database, projectId: string, name: string, opts?: { enabled?: boolean; scheduleKind?: 'interval' | 'once'; scheduleExpr?: string; nextFireAt?: number }) {
  const home = createScheduleHomeConversation(db, { projectId, title: name });
  return createJob(db, {
    projectId,
    name,
    timezone: 'UTC',
    scheduleKind: opts?.scheduleKind ?? 'interval',
    scheduleExpr: opts?.scheduleExpr ?? '{"everyMs":3600000}',
    profileId: 'claude-code:claude-sonnet-4.6',
    homeConversationId: home.id,
    promptTemplate: 'test prompt',
    nextFireAt: opts?.nextFireAt ?? (Date.now() + 3600000),
    enabled: opts?.enabled ?? true,
  });
}

const resultFor = (json: BulkBody, id: string): BulkResult =>
  (json.results ?? []).find((r) => r.id === id)!;

describe('POST /schedules/bulk — request shape', () => {
  it('400s an unknown action', async () => {
    const { app } = boot();
    const res = await post(app, { action: 'pin', ids: ['x'] });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('action must be one of: delete, archive, unarchive, enable, disable');
  });

  it('400s a missing action before validating ids', async () => {
    const { app } = boot();
    const res = await post(app, { ids: [] });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('action must be one of: delete, archive, unarchive, enable, disable');
  });

  it('400s an empty ids array', async () => {
    const { app } = boot();
    const res = await post(app, { action: 'enable', ids: [] });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('ids (non-empty string[]) required');
  });

  it('400s non-string or empty elements in ids', async () => {
    const { app } = boot();
    for (const ids of [undefined, 'abc', [1, 2], ['ok', ''], ['ok', null]]) {
      const res = await post(app, { action: 'disable', ids });
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
  });

  it('dedupes ids in the request', async () => {
    const { db, app, projectA } = boot();
    const j = makeJob(db, projectA, 'Dedup Job');
    const res = await post(app, { action: 'disable', ids: [j.id, j.id, j.id] });
    expect(res.status).toBe(200);
    expect(res.json.results?.length).toBe(1);
    expect(res.json.results?.[0]).toEqual({ id: j.id, ok: true });
    expect(getJob(db, j.id)?.enabled).toBe(false);
  });
});

describe('POST /schedules/bulk — enable & disable', () => {
  it('enables and disables multiple jobs', async () => {
    const { db, app, projectA, projectB } = boot();
    const j1 = makeJob(db, projectA, 'Job 1', { enabled: true });
    const j2 = makeJob(db, projectB, 'Job 2', { enabled: true });

    // Disable both
    const disRes = await post(app, { action: 'disable', ids: [j1.id, j2.id] });
    expect(disRes.status).toBe(200);
    expect(resultFor(disRes.json, j1.id)).toEqual({ id: j1.id, ok: true });
    expect(resultFor(disRes.json, j2.id)).toEqual({ id: j2.id, ok: true });
    expect(getJob(db, j1.id)?.enabled).toBe(false);
    expect(getJob(db, j2.id)?.enabled).toBe(false);

    // Enable both
    const enRes = await post(app, { action: 'enable', ids: [j1.id, j2.id] });
    expect(enRes.status).toBe(200);
    expect(resultFor(enRes.json, j1.id)).toEqual({ id: j1.id, ok: true });
    expect(resultFor(enRes.json, j2.id)).toEqual({ id: j2.id, ok: true });
    expect(getJob(db, j1.id)?.enabled).toBe(true);
    expect(getJob(db, j2.id)?.enabled).toBe(true);
  });

  it('reports error for exhausted once job on enable', async () => {
    const { db, app, projectA } = boot();
    const j = makeJob(db, projectA, 'Exhausted Once', {
      scheduleKind: 'once',
      scheduleExpr: '{"atMs":1000}',
      nextFireAt: ONCE_EXHAUSTED_MS,
      enabled: false,
    });

    const res = await post(app, { action: 'enable', ids: [j.id] });
    expect(res.status).toBe(200);
    const r = resultFor(res.json, j.id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('once job is exhausted');
  });

  it('reports 404 for missing jobs on enable / disable', async () => {
    const { app } = boot();
    const res = await post(app, { action: 'enable', ids: ['non-existent-id'] });
    expect(res.status).toBe(200);
    expect(resultFor(res.json, 'non-existent-id')).toEqual({
      id: 'non-existent-id',
      ok: false,
      error: 'no such schedule job',
    });
  });
});

describe('POST /schedules/bulk — archive / unarchive', () => {
  it('soft-archives multiple jobs and sets enabled=false', async () => {
    const { db, app, projectA, projectB } = boot();
    const j1 = makeJob(db, projectA, 'Job 1', { enabled: true });
    const j2 = makeJob(db, projectB, 'Job 2', { enabled: true });

    const res = await post(app, { action: 'archive', ids: [j1.id, j2.id] });
    expect(res.status).toBe(200);
    expect(resultFor(res.json, j1.id)).toEqual({ id: j1.id, ok: true });
    expect(resultFor(res.json, j2.id)).toEqual({ id: j2.id, ok: true });
    expect(getJob(db, j1.id)?.archived).toBe(true);
    expect(getJob(db, j1.id)?.enabled).toBe(false);
    expect(getJob(db, j2.id)?.archived).toBe(true);
    expect(getJob(db, j2.id)?.enabled).toBe(false);
  });

  it('unarchives multiple jobs', async () => {
    const { db, app, projectA, projectB } = boot();
    const j1 = makeJob(db, projectA, 'Job 1', { archived: true });
    const j2 = makeJob(db, projectB, 'Job 2', { archived: true });

    const res = await post(app, { action: 'unarchive', ids: [j1.id, j2.id] });
    expect(res.status).toBe(200);
    expect(resultFor(res.json, j1.id)).toEqual({ id: j1.id, ok: true });
    expect(resultFor(res.json, j2.id)).toEqual({ id: j2.id, ok: true });
    expect(getJob(db, j1.id)?.archived).toBe(false);
    expect(getJob(db, j2.id)?.archived).toBe(false);
  });
});

describe('POST /schedules/bulk — delete', () => {
  it('hard-deletes jobs and reports deletedConversationIds', async () => {
    const { db, app, projectA } = boot();
    const j1 = makeJob(db, projectA, 'Job 1');
    const j2 = makeJob(db, projectA, 'Job 2');

    const res = await post(app, { action: 'delete', ids: [j1.id, j2.id] });
    expect(res.status).toBe(200);
    expect(resultFor(res.json, j1.id)).toEqual({ id: j1.id, ok: true });
    expect(resultFor(res.json, j2.id)).toEqual({ id: j2.id, ok: true });
    expect(getJob(db, j1.id)).toBeUndefined();
    expect(getJob(db, j2.id)).toBeUndefined();
    expect(res.json.deletedConversationIds).toBeDefined();
    expect(res.json.deletedConversationIds).toContain(j1.homeConversationId);
    expect(res.json.deletedConversationIds).toContain(j2.homeConversationId);
  });

  it('rejects delete when schedule has an active run', async () => {
    const { db, app, projectA } = boot();
    const j = makeJob(db, projectA, 'Busy Job');
    createRun(db, {
      jobId: j.id,
      status: 'running',
      trigger: 'due',
      firedAt: Date.now(),
    });

    const res = await post(app, { action: 'delete', ids: [j.id] });
    expect(res.status).toBe(200);
    expect(resultFor(res.json, j.id)).toEqual({
      id: j.id,
      ok: false,
      error: 'schedule has an active run; wait or stop it first',
    });
    expect(getJob(db, j.id)).toBeDefined();
  });

  it('rejects delete when conversation tree has an in-flight session', async () => {
    const { db, app, projectA, inFlight } = boot();
    const j = makeJob(db, projectA, 'In-Flight Job');
    inFlight.add(j.homeConversationId);

    const res = await post(app, { action: 'delete', ids: [j.id] });
    expect(res.status).toBe(200);
    expect(resultFor(res.json, j.id)).toEqual({
      id: j.id,
      ok: false,
      error: 'schedule conversation tree has a live session',
    });
    expect(getJob(db, j.id)).toBeDefined();
  });

  it('handles mixed success and failures gracefully', async () => {
    const { db, app, projectA } = boot();
    const jGood = makeJob(db, projectA, 'Good Job');
    const jActive = makeJob(db, projectA, 'Active Job');
    createRun(db, {
      jobId: jActive.id,
      status: 'running',
      trigger: 'due',
      firedAt: Date.now(),
    });

    const res = await post(app, { action: 'delete', ids: [jGood.id, 'missing-id', jActive.id] });
    expect(res.status).toBe(200);
    expect(resultFor(res.json, jGood.id)).toEqual({ id: jGood.id, ok: true });
    expect(resultFor(res.json, 'missing-id')).toEqual({ id: 'missing-id', ok: false, error: 'no such schedule job' });
    expect(resultFor(res.json, jActive.id)).toEqual({ id: jActive.id, ok: false, error: 'schedule has an active run; wait or stop it first' });
    expect(getJob(db, jGood.id)).toBeUndefined();
    expect(getJob(db, jActive.id)).toBeDefined();
  });
});
