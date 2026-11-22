import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RetentionStats } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { startRetentionScheduler } from '../repositories/retention.js';
import { registerGeneralSettingsRoutes, registerRetentionPurgeRoute } from './settings.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

let tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-ret-stats-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  const app = express();
  app.use(express.json());
  registerGeneralSettingsRoutes(app, () => db);
  return { db, app };
}

function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (r) => {
          const text = await r.text();
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
          return { status: r.status, body: parsed };
        })
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('POST /settings/general', () => {
  it('returns 400 JSON for an invalid retention value', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/general', { conversationRetentionDays: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.stringMatching(/0–3650/),
    }));
  });

  it('accepts the built-in hide toggles and round-trips them', async () => {
    const { app } = boot();
    const first = await fetchJson(app, 'POST', '/settings/general', { hidePresetPrompts: true });
    expect(first.status).toBe(200);
    expect(first.body).toEqual(expect.objectContaining({
      settings: expect.objectContaining({ hidePresetPrompts: true, hideShippedSchedulePacks: false }),
    }));
    const second = await fetchJson(app, 'POST', '/settings/general', { hideShippedSchedulePacks: true });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(expect.objectContaining({
      settings: expect.objectContaining({ hidePresetPrompts: true, hideShippedSchedulePacks: true }),
    }));
    const get = await fetchJson(app, 'GET', '/settings/general');
    expect(get.body).toEqual(expect.objectContaining({
      settings: expect.objectContaining({ hidePresetPrompts: true, hideShippedSchedulePacks: true }),
    }));
  });

  it('returns 400 when a hide toggle is not a boolean', async () => {
    const { app } = boot();
    const res = await fetchJson(app, 'POST', '/settings/general', { hidePresetPrompts: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.stringMatching(/hidePresetPrompts must be a boolean/),
    }));
  });
});

describe('POST /settings/retention/purge', () => {
  it('kicks a pass, returns first-pass counts, and reports already-running on a second call', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    for (let i = 0; i < 2; i++) {
      const c = createConversation(db, { projectId: p.id, title: `old-${i}` });
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - (100 + i) * DAY, c.id);
    }
    const ctl = startRetentionScheduler(db, {
      getRetentionDays: () => 90,
      now: () => NOW,
      chunkDelayMs: 60_000,
      maxConversations: 1,
    });
    const app = express();
    app.use(express.json());
    registerRetentionPurgeRoute(app, {
      getRetentionDays: () => 90,
      runNow: () => ctl.runNow(),
      getDb: () => db,
      dataDir: tmpdir(),
      dbPath: ':memory:',
      isPurgeRunning: () => false,
    });
    try {
      const first = await fetchJson(app, 'POST', '/settings/retention/purge', {});
      expect(first.status).toBe(200);
      expect(first.body).toEqual(expect.objectContaining({
        alreadyRunning: false,
        deleted: 1,
        remaining: 1,
        dbSizeBytes: expect.any(Number),
      }));
      const second = await fetchJson(app, 'POST', '/settings/retention/purge', {});
      expect(second.status).toBe(409);
      expect(second.body).toEqual(expect.objectContaining({ alreadyRunning: true }));
    } finally {
      ctl.stop();
    }
  });
});

describe('GET /settings/retention/stats', () => {
  function bootFileDb(days: number, isPurgeRunning = () => false) {
    const dir = tmpDir();
    const dbPath = join(dir, 'tierwyn.db');
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    const app = express();
    app.use(express.json());
    registerRetentionPurgeRoute(app, {
      getRetentionDays: () => days,
      runNow: async () => ({ alreadyRunning: true }),
      getDb: () => db,
      dataDir: dir,
      dbPath,
      isPurgeRunning,
    });
    return { db, app, dir, dbPath };
  }

  it('returns size, counts, eligible, and archive zeros when the archive dir is missing', async () => {
    const { db, app, dbPath } = bootFileDb(90);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const old = createConversation(db, { projectId: p.id, title: 'old' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, old.id);
    createConversation(db, { projectId: p.id, title: 'fresh' });
    db.prepare(
      `INSERT INTO agents (id, type, label, description, env_vars, created_at) VALUES (?,?,?,?,?,?)`,
    ).run('a1', 'a1', 'a1', '', '{}', NOW);
    db.prepare(
      'INSERT INTO sessions (id,conversation_id,agent_id,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run('s1', old.id, 'a1', NOW, NOW);
    db.prepare(
      "INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)",
    ).run('e1', 's1', 'message', '{}', 'agent', 1, NOW);

    const res = await fetchJson(app, 'GET', '/settings/retention/stats');
    expect(res.status).toBe(200);
    const body = res.body as RetentionStats;
    expect(body.dbSizeBytes).toBeGreaterThan(0);
    expect(body.walSizeBytes).toBeGreaterThanOrEqual(0);
    expect(body.totalConversations).toBe(2);
    expect(body.eventsCount).toBe(1);
    expect(body.eligibleConversations).toBe(1);
    expect(body.archivedCount).toBe(0);
    expect(body.archiveBytes).toBe(0);
    expect(body.purgeRunning).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  it('reports eligibleConversations = 0 when retention days is 0', async () => {
    const { db, app } = bootFileDb(0);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const old = createConversation(db, { projectId: p.id, title: 'old' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, old.id);
    const res = await fetchJson(app, 'GET', '/settings/retention/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ eligibleConversations: 0, purgeRunning: false }));
    db.close();
  });

  it('counts archive files and bytes; missing dir does not throw', async () => {
    const { db, app, dir } = bootFileDb(90);
    mkdirSync(join(dir, 'archive'));
    writeFileSync(join(dir, 'archive', 'a.jsonl'), 'x'.repeat(100));
    writeFileSync(join(dir, 'archive', 'b.jsonl'), 'y'.repeat(50));
    const res = await fetchJson(app, 'GET', '/settings/retention/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      archivedCount: 2,
      archiveBytes: 150,
    }));
    db.close();
  });

  it('surfaces purgeRunning from the scheduler flag', async () => {
    const { db, app } = bootFileDb(90, () => true);
    const res = await fetchJson(app, 'GET', '/settings/retention/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ purgeRunning: true }));
    db.close();
  });
});
