import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ArchiveEntry, RetentionArchiveDeleteResponse, RetentionRestoreResponse } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { runRetentionPurge } from '../repositories/retention.js';
import { registerRetentionArchiveRoutes } from './settings.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

let tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-ret-restore-'));
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
  const dir = tmpDir();
  const db = new Database(join(dir, 'tierwyn.db'));
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  db.prepare(
    'INSERT INTO agents (id, type, label, description, env_vars, created_at) VALUES (?,?,?,?,?,?)',
  ).run('a1', 'claude-code', 'Claude', '', '{}', NOW);
  db.prepare(
    'INSERT INTO agent_models (id, agent_id, model_name, label, created_at) VALUES (?,?,?,?,?)',
  ).run('m1', 'a1', 'opus', 'Opus', NOW);
  const app = express();
  app.use(express.json());
  registerRetentionArchiveRoutes(app, { getDb: () => db, dataDir: dir });
  return { db, app, dir };
}

function seedTurn(db: Db, convId: string, sessionId: string, text: string) {
  db.prepare(
    'INSERT INTO sessions (id,conversation_id,agent_id,agent_model_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(sessionId, convId, 'a1', 'm1', 'native-xyz', NOW, NOW);
  db.prepare(
    'INSERT INTO events (id,session_id,type,payload,sender,agent_model_id,seq,ts) VALUES (?,?,?,?,?,?,?,?)',
  ).run(`${sessionId}-e1`, sessionId, 'prompt', JSON.stringify({ text }), 'user', 'm1', 1, NOW);
}

/** Same listen-on-port-0 harness as settings.retention.test.ts. */
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

/** Create + purge one conversation; returns its id (now archive-only). */
async function purgeOne(db: Db, dir: string, projectId: string, title: string): Promise<string> {
  const c = createConversation(db, { projectId, title });
  seedTurn(db, c.id, `s-${c.id.slice(0, 8)}`, `${title} body text`);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, c.id);
  await runRetentionPurge({ db, retentionDays: 90, dataDir: dir, now: NOW, vacuum: () => {} });
  return c.id;
}

describe('GET /settings/retention/archive', () => {
  it('returns an empty list before anything has been purged', async () => {
    const { db, app } = boot();
    const res = await fetchJson(app, 'GET', '/settings/retention/archive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    db.close();
  });

  it('lists a purged conversation with its title, size and event count', async () => {
    const { db, app, dir } = boot();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const id = await purgeOne(db, dir, p.id, 'archived chat');

    const res = await fetchJson(app, 'GET', '/settings/retention/archive');
    expect(res.status).toBe(200);
    const items = (res.body as { items: ArchiveEntry[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({
      id, title: 'archived chat', projectId: p.id, eventCount: 1,
    }));
    expect(items[0].bytes).toBeGreaterThan(0);
    // D1/D13: no file contents are ever returned.
    expect(JSON.stringify(items[0])).not.toContain('body text');
    db.close();
  });
});

describe('DELETE /settings/retention/archive/:id', () => {
  it('removes one archive file and 404s a second delete', async () => {
    const { db, app, dir } = boot();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const id = await purgeOne(db, dir, p.id, 'throw away');
    const first = await fetchJson(app, 'DELETE', `/settings/retention/archive/${id}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ deleted: 1 });
    expect(existsSync(join(dir, 'archive', `${id}.jsonl`))).toBe(false);

    const listed = await fetchJson(app, 'GET', '/settings/retention/archive');
    expect((listed.body as { items: ArchiveEntry[] }).items).toEqual([]);

    const second = await fetchJson(app, 'DELETE', `/settings/retention/archive/${id}`);
    expect(second.status).toBe(404);
    db.close();
  });

  it('400s a path-traversal id', async () => {
    const { db, app } = boot();
    const res = await fetchJson(app, 'DELETE', '/settings/retention/archive/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
    db.close();
  });
});

describe('DELETE /settings/retention/archive', () => {
  it('wipes every archive file and reports the count', async () => {
    const { db, app, dir } = boot();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    await purgeOne(db, dir, p.id, 'one');
    await purgeOne(db, dir, p.id, 'two');
    const res = await fetchJson(app, 'DELETE', '/settings/retention/archive');
    expect(res.status).toBe(200);
    expect((res.body as RetentionArchiveDeleteResponse).deleted).toBe(2);
    const listed = await fetchJson(app, 'GET', '/settings/retention/archive');
    expect((listed.body as { items: ArchiveEntry[] }).items).toEqual([]);
    db.close();
  });
});

describe('POST /settings/retention/archive/:id/restore', () => {
  it('restores a purged conversation and reports what came back', async () => {
    const { db, app, dir } = boot();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const id = await purgeOne(db, dir, p.id, 'bring it back');
    expect(getConversation(db, id)).toBeUndefined();

    const res = await fetchJson(app, 'POST', `/settings/retention/archive/${id}/restore`, {});
    expect(res.status).toBe(200);
    expect(res.body as RetentionRestoreResponse).toEqual({
      restored: [{ id, title: 'bring it back' }],
      projectId: p.id,
      eventsRestored: 1,
      parentCleared: false,
    });
    expect(getConversation(db, id)!.title).toBe('bring it back');
    db.close();
  });

  it('accepts no request body at all', async () => {
    const { db, app, dir } = boot();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const id = await purgeOne(db, dir, p.id, 'bodyless');
    const res = await fetchJson(app, 'POST', `/settings/retention/archive/${id}/restore`);
    expect(res.status).toBe(200);
    db.close();
  });

  it('404s when there is no archive file for the id', async () => {
    const { db, app } = boot();
    const res = await fetchJson(
      app, 'POST', '/settings/retention/archive/11111111-2222-3333-4444-555555555555/restore', {},
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    db.close();
  });

  it('409s when the conversation id is already live', async () => {
    const { db, app, dir } = boot();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const id = await purgeOne(db, dir, p.id, 'twice please');
    expect((await fetchJson(app, 'POST', `/settings/retention/archive/${id}/restore`, {})).status).toBe(200);

    const second = await fetchJson(app, 'POST', `/settings/retention/archive/${id}/restore`, {});
    expect(second.status).toBe(409);
    expect(second.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/already/i) }));
    db.close();
  });

  it('400s a path-traversal id without hitting the filesystem (D7)', async () => {
    const { db, app } = boot();
    const res = await fetchJson(
      app, 'POST', '/settings/retention/archive/..%2F..%2Fetc%2Fpasswd/restore', {},
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid/i) }));
    db.close();
  });

  it('400s when the original project is gone and no target is supplied, 200s with one', async () => {
    const { db, app, dir } = boot();
    const p1 = createProject(db, { name: 'P1', rootPath: '/p1' });
    const p2 = createProject(db, { name: 'P2', rootPath: '/p2' });
    const id = await purgeOne(db, dir, p1.id, 'homeless');
    db.prepare('DELETE FROM projects WHERE id = ?').run(p1.id);

    const bare = await fetchJson(app, 'POST', `/settings/retention/archive/${id}/restore`, {});
    expect(bare.status).toBe(400);

    const targeted = await fetchJson(
      app, 'POST', `/settings/retention/archive/${id}/restore`, { projectId: p2.id },
    );
    expect(targeted.status).toBe(200);
    expect(getConversation(db, id)!.projectId).toBe(p2.id);
    db.close();
  });

  it('404s when the supplied projectId does not exist', async () => {
    const { db, app, dir } = boot();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const id = await purgeOne(db, dir, p.id, 'bad target');
    const res = await fetchJson(
      app, 'POST', `/settings/retention/archive/${id}/restore`, { projectId: 'nope' },
    );
    expect(res.status).toBe(404);
    db.close();
  });

  it('ignores a non-string projectId instead of crashing', async () => {
    const { db, app, dir } = boot();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const id = await purgeOne(db, dir, p.id, 'weird body');
    const res = await fetchJson(
      app, 'POST', `/settings/retention/archive/${id}/restore`, { projectId: 42 },
    );
    expect(res.status).toBe(200);
    expect(getConversation(db, id)!.projectId).toBe(p.id);
    db.close();
  });
});
