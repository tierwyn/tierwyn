import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { appendEvent } from '../repositories/events.js';
import { registerSearchRoutes, toMatchQuery } from './search.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('migration 109 — event_fts', () => {
  it('creates the FTS table and the buffer table', () => {
    const db = freshDb();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('event_fts','event_fts_buffer')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toContain('event_fts');
    expect(names).toContain('event_fts_buffer');
  });

  it('supports contentless delete by rowid', () => {
    const db = freshDb();
    db.prepare('INSERT INTO event_fts(rowid, body) VALUES (?,?)').run(4242, 'hello regenerate');
    expect(db.prepare('SELECT rowid FROM event_fts WHERE event_fts MATCH ?').all('regenerate'))
      .toHaveLength(1);
    db.prepare('DELETE FROM event_fts WHERE rowid = ?').run(4242);
    expect(db.prepare('SELECT rowid FROM event_fts WHERE event_fts MATCH ?').all('regenerate'))
      .toHaveLength(0);
  });
});

function seed(db: Database.Database, title = 'C') {
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title });
  const now = Date.now();
  const sid = `s-${c.id}`;
  db.prepare('INSERT INTO sessions (id,conversation_id,created_at,updated_at) VALUES (?,?,?,?)')
    .run(sid, c.id, now, now);
  return { projectId: p.id, conversationId: c.id, sessionId: sid };
}

function ftsCount(db: Database.Database, match: string) {
  return (db.prepare('SELECT count(*) c FROM event_fts WHERE event_fts MATCH ?')
    .get(match) as { c: number }).c;
}

describe('event_fts triggers', () => {
  it('indexes a prompt on appendEvent, with no restart', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'ship the marmalade parser' }, sender: 'user' });
    expect(ftsCount(db, '"marmalade"')).toBe(1);
  });

  it('indexes a non-streaming message (no final key) per row', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'the marmalade is ready' }, sender: 'agent' });
    expect(ftsCount(db, '"marmalade"')).toBe(1);
  });

  it('concatenates streaming chunks so a phrase spanning chunks matches', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    // Deliberately split the phrase across a chunk boundary — this is the whole point of D2.
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'the marma', final: false }, sender: 'agent', seq: 1 });
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'lade parser is ', final: false }, sender: 'agent', seq: 2 });
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'ready', final: false }, sender: 'agent', seq: 3 });
    expect(ftsCount(db, '"marmalade"')).toBe(0);      // not flushed yet
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: '', final: true }, sender: 'agent', seq: 4 });
    expect(ftsCount(db, '"marmalade parser"')).toBe(1); // one doc for the whole turn
    expect(db.prepare('SELECT count(*) c FROM event_fts_buffer').get()).toEqual({ c: 0 });
  });

  it('indexes a whole-turn message that carries text on the final:true row', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    appendEvent(db, {
      sessionId,
      type: 'message',
      payload: { chunk: 'the marmalade parser shipped', final: true },
      sender: 'agent',
    });
    expect(ftsCount(db, '"marmalade"')).toBe(1);
    expect(db.prepare('SELECT count(*) c FROM event_fts_buffer').get()).toEqual({ c: 0 });
  });

  it('indexes a tail carried on the streaming terminator', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'head dam', final: false }, sender: 'agent', seq: 1 });
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'son tail', final: true }, sender: 'agent', seq: 2 });
    expect(ftsCount(db, '"damson"')).toBe(1);
    expect(db.prepare('SELECT count(*) c FROM event_fts_buffer').get()).toEqual({ c: 0 });
  });

  it('does not index tool_result payloads', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'tool_result', payload: { content: 'marmalade build log' }, sender: 'agent' });
    expect(ftsCount(db, '"marmalade"')).toBe(0);
  });

  it('removes the FTS row when the event is deleted', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    const ev = appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
    expect(ftsCount(db, '"marmalade"')).toBe(0);
  });

  it('removes FTS rows when a conversation cascade-deletes its events', () => {
    const db = freshDb();
    const { conversationId, sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
    expect(ftsCount(db, '"marmalade"')).toBe(0);
  });

  it('re-indexes on payload update', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    const ev = appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    db.prepare('UPDATE events SET payload = ? WHERE id = ?').run('{"text":"chutney"}', ev.id);
    expect(ftsCount(db, '"marmalade"')).toBe(0);
    expect(ftsCount(db, '"chutney"')).toBe(1);
  });
});

function helperPayload(over: Record<string, unknown> = {}) {
  return {
    taskId: 't1',
    toolUseId: 'tu1',
    label: 'Explore',
    description: '',
    summary: '',
    status: 'completed',
    startedAt: 1,
    ...over,
  };
}

describe('event_fts_ai_helper trigger', () => {
  it('skips running snapshots and indexes completed, failed, and stopped', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'running', description: 'list marmalade files' }), sender: 'agent', seq: 1 });
    expect(ftsCount(db, '"marmalade"')).toBe(0);
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'completed', taskId: 'done', description: 'list marmalade files' }), sender: 'agent', seq: 2 });
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'failed', taskId: 'fail', description: 'chutney exploded' }), sender: 'agent', seq: 3 });
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'stopped', taskId: 'stop', summary: 'damson halted' }), sender: 'agent', seq: 4 });
    expect(ftsCount(db, '"marmalade"')).toBe(1);
    expect(ftsCount(db, '"chutney"')).toBe(1);
    expect(ftsCount(db, '"damson"')).toBe(1);
  });

  it('skips terminal helpers whose label/description/summary is empty', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    appendEvent(db, {
      sessionId, type: 'helper', sender: 'agent',
      payload: helperPayload({ label: '', description: '', summary: '', status: 'completed' }),
    });
    expect(ftsCount(db, '"Explore"')).toBe(0);
  });

  it('removes the FTS row when a terminal helper event is deleted', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    const ev = appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ description: 'list marmalade files' }), sender: 'agent' });
    expect(ftsCount(db, '"marmalade"')).toBe(1);
    db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
    expect(ftsCount(db, '"marmalade"')).toBe(0);
  });

  it('replaces the prior FTS row when a second terminal snapshot arrives for the same task', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'completed', summary: 'old marmalade' }), sender: 'agent', seq: 1 });
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'completed', summary: 'new damson' }), sender: 'agent', seq: 2 });
    expect(ftsCount(db, '"Explore"')).toBe(1);
    expect(ftsCount(db, '"marmalade"')).toBe(0);
    expect(ftsCount(db, '"damson"')).toBe(1);
  });

  it('re-indexes a helper row when its payload is updated to a terminal snapshot', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    const ev = appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'running', description: 'list marmalade files' }), sender: 'agent' });
    expect(ftsCount(db, '"marmalade"')).toBe(0);
    db.prepare('UPDATE events SET payload = ? WHERE id = ?')
      .run(JSON.stringify(helperPayload({ status: 'completed', description: '', summary: 'now the damson is ready' })), ev.id);
    expect(ftsCount(db, '"marmalade"')).toBe(0);
    expect(ftsCount(db, '"damson"')).toBe(1);
  });
});

describe('helper FTS backfill', () => {
  it('indexes the latest terminal helper per (session_id, taskId) and is idempotent', () => {
    const db = freshDb();
    const { sessionId } = seed(db);
    db.exec('DROP TRIGGER IF EXISTS event_fts_ai_helper');
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'running', description: 'still looking' }), sender: 'agent', seq: 1 });
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'completed', summary: 'old marmalade' }), sender: 'agent', seq: 2 });
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'completed', summary: 'new damson' }), sender: 'agent', seq: 3 });
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ taskId: 'other', status: 'failed', description: 'chutney' }), sender: 'agent', seq: 4 });
    expect(ftsCount(db, '"marmalade"')).toBe(0);
    expect(ftsCount(db, '"damson"')).toBe(0);
    expect(ftsCount(db, '"chutney"')).toBe(0);

    db.exec(migrations[0]!.sql);
    expect(ftsCount(db, '"marmalade"')).toBe(0); // older terminal snapshot skipped
    expect(ftsCount(db, '"damson"')).toBe(1);
    expect(ftsCount(db, '"chutney"')).toBe(1);

    db.exec(migrations[0]!.sql);
    expect(ftsCount(db, '"damson"')).toBe(1);
    expect(ftsCount(db, '"chutney"')).toBe(1);
  });
});

describe('migration 109 backfill', () => {
  it('indexes events that already existed before the migration ran', () => {
    // Migrate only up to 108, insert events, then apply 109 — proving backfill, not triggers.
    // Raw inserts: createConversation writes designation (122), which does not exist at 108.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations.filter((m) => m.version < 109));
    const now = Date.now();
    db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?,?,?,?)')
      .run('p1', 'P', '/p', now);
    db.prepare('INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('c1', 'p1', 'C', now, now);
    const sessionId = 's-c1';
    db.prepare('INSERT INTO sessions (id,conversation_id,created_at,updated_at) VALUES (?,?,?,?)')
      .run(sessionId, 'c1', now, now);
    db.prepare('INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)')
      .run('e1', sessionId, 'prompt', '{"text":"legacy marmalade prompt"}', 'user', 1, now);
    db.prepare('INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)')
      .run('e2', sessionId, 'message', '{"chunk":"legacy chut","final":false}', 'agent', 2, now);
    db.prepare('INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)')
      .run('e3', sessionId, 'message', '{"chunk":"ney reply","final":false}', 'agent', 3, now);
    db.prepare('INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)')
      .run('e4', sessionId, 'message', '{"chunk":"","final":true}', 'agent', 4, now);

    runMigrations(db, migrations);

    expect(ftsCount(db, '"marmalade"')).toBe(1);
    expect(ftsCount(db, '"chutney"')).toBe(1); // chunks joined by the window-function backfill
  });
});

function bootApp() {
  const db = freshDb();
  const app = express();
  app.use(express.json());
  registerSearchRoutes(app, () => db);
  return { db, app };
}

// Same helper shape as routes/conversations.description.test.ts
function fetchJson(app: express.Express, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`)
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

type Hit = {
  id: string; projectId: string; title: string; updatedAt: number;
  eventId?: string; snippet?: string;
};

describe('toMatchQuery', () => {
  it('quotes tokens and prefix-matches the last one', () => {
    expect(toMatchQuery('regenerate button')).toBe('"regenerate" "button"*');
  });

  it('neutralises FTS metacharacters', () => {
    expect(toMatchQuery('foo"bar')).toBe('"foobar"*');
    expect(toMatchQuery('a-b')).toBe('"a b"*');
    expect(toMatchQuery('AND')).toBe('"AND"*');
    expect(toMatchQuery('NEAR(')).toBe('"NEAR"*');
  });

  it('returns null for input with nothing indexable', () => {
    expect(toMatchQuery('')).toBeNull();
    expect(toMatchQuery('   ')).toBeNull();
    expect(toMatchQuery('*')).toBeNull();
    expect(toMatchQuery('!!! ???')).toBeNull();
  });
});

describe('GET /conversations/search', () => {
  it('matches on prompt text', async () => {
    const { db, app } = bootApp();
    const { conversationId, sessionId } = seed(db, 'Untitled');
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'ship the marmalade parser' }, sender: 'user' });
    const res = await fetchJson(app, '/conversations/search?q=marmalade');
    expect(res.status).toBe(200);
    expect((res.body as Hit[]).map((h) => h.id)).toEqual([conversationId]);
  });

  it('matches on assistant message chunk', async () => {
    const { db, app } = bootApp();
    const { conversationId, sessionId } = seed(db, 'Untitled');
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'the marmalade is ready' }, sender: 'agent' });
    const res = await fetchJson(app, '/conversations/search?q=marmalade');
    expect((res.body as Hit[]).map((h) => h.id)).toEqual([conversationId]);
  });

  it('does not match on title alone — title search stays client-side', async () => {
    const { db, app } = bootApp();
    seed(db, 'Marmalade Project');
    const res = await fetchJson(app, '/conversations/search?q=marmalade');
    expect(res.body).toEqual([]);
  });

  it('ranks by recency — most recently updated conversation first', async () => {
    const { db, app } = bootApp();
    const a = seed(db, 'A');
    const b = seed(db, 'B');
    appendEvent(db, { sessionId: a.sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    appendEvent(db, { sessionId: b.sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(1000, a.conversationId);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(2000, b.conversationId);
    const res = await fetchJson(app, '/conversations/search?q=marmalade');
    expect((res.body as Hit[]).map((h) => h.id)).toEqual([b.conversationId, a.conversationId]);
  });

  it('returns each conversation once even with many matching events', async () => {
    const { db, app } = bootApp();
    const { conversationId, sessionId } = seed(db);
    for (let i = 0; i < 5; i++) {
      appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user', seq: i });
    }
    const res = await fetchJson(app, '/conversations/search?q=marmalade');
    expect((res.body as Hit[]).map((h) => h.id)).toEqual([conversationId]);
  });

  it('rejects an empty or unindexable query with 400', async () => {
    const { app } = bootApp();
    expect((await fetchJson(app, '/conversations/search?q=')).status).toBe(400);
    expect((await fetchJson(app, '/conversations/search')).status).toBe(400);
    expect((await fetchJson(app, '/conversations/search?q=%20%20')).status).toBe(400);
  });

  it('does not 500 on FTS metacharacters', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    for (const q of ['foo%22bar', 'a-b', 'AND', 'OR', 'NEAR(', '%2A', 'marmalade*']) {
      const res = await fetchJson(app, `/conversations/search?q=${q}`);
      expect([200, 400]).toContain(res.status);
    }
  });

  it('scopes to projectId and excludes other projects', async () => {
    const { db, app } = bootApp();
    const a = seed(db);
    const b = seed(db);
    appendEvent(db, { sessionId: a.sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    appendEvent(db, { sessionId: b.sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    const res = await fetchJson(app, `/conversations/search?q=marmalade&projectId=${a.projectId}`);
    expect((res.body as Hit[]).map((h) => h.id)).toEqual([a.conversationId]);
  });

  it('treats an empty projectId as unscoped', async () => {
    const { db, app } = bootApp();
    const a = seed(db);
    const b = seed(db);
    appendEvent(db, { sessionId: a.sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    appendEvent(db, { sessionId: b.sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    const res = await fetchJson(app, '/conversations/search?q=marmalade&projectId=');
    expect(res.status).toBe(200);
    expect((res.body as Hit[]).length).toBe(2);
  });

  it('returns 200 [] for an unknown projectId', async () => {
    const { app } = bootApp();
    const res = await fetchJson(app, '/conversations/search?q=marmalade&projectId=nope');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('excludes schedule_home conversations', async () => {
    const { db, app } = bootApp();
    const { conversationId, sessionId } = seed(db);
    db.prepare("UPDATE conversations SET kind = 'schedule_home' WHERE id = ?").run(conversationId);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    const res = await fetchJson(app, '/conversations/search?q=marmalade');
    expect(res.body).toEqual([]);
  });

  it('includes a non-chat kind that is not schedule_home', async () => {
    const { db, app } = bootApp();
    const { conversationId, sessionId } = seed(db);
    db.prepare("UPDATE conversations SET kind = 'btw' WHERE id = ?").run(conversationId);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    const res = await fetchJson(app, '/conversations/search?q=marmalade');
    expect((res.body as Hit[]).map((h) => h.id)).toEqual([conversationId]);
  });

  it('caps limit at 50', async () => {
    const { db, app } = bootApp();
    for (let i = 0; i < 3; i++) {
      const s = seed(db, `C${i}`);
      appendEvent(db, { sessionId: s.sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    }
    expect((await fetchJson(app, '/conversations/search?q=marmalade&limit=2')).body).toHaveLength(2);
    expect((await fetchJson(app, '/conversations/search?q=marmalade&limit=9999')).body).toHaveLength(3);
    expect((await fetchJson(app, '/conversations/search?q=marmalade&limit=abc')).body).toHaveLength(3);
  });

  it('is registered before GET /conversations/:id so "search" is not read as an id', async () => {
    // Mirrors index.ts ordering. If search is registered second, this returns
    // 404 { error: 'no such conversation' } instead of 400.
    const db = freshDb();
    const app = express();
    app.use(express.json());
    registerSearchRoutes(app, () => db);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerConversationMutationRoutes } = await import('./conversations.js');
    registerConversationMutationRoutes(app, () => db);
    const res = await fetchJson(app, '/conversations/search');
    expect(res.status).toBe(400);
  });

  it('carries the matched eventId and a snippet for a prompt match', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    const ev = appendEvent(db, {
      sessionId, type: 'prompt', payload: { text: 'ship the marmalade parser' }, sender: 'user',
    });
    const res = await fetchJson(app, '/conversations/search?q=marmalade');
    const hits = res.body as Hit[];
    expect(hits).toHaveLength(1);
    expect(hits[0].eventId).toBe(ev.id);
    expect(hits[0].snippet).toContain('marmalade');
  });

  it('still carries the legacy hit fields alongside the new ones', async () => {
    const { db, app } = bootApp();
    const { projectId, conversationId, sessionId } = seed(db, 'Legacy');
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade')).body as Hit[];
    expect(hit.id).toBe(conversationId);
    expect(hit.projectId).toBe(projectId);
    expect(hit.title).toBe('Legacy');
    expect(typeof hit.updatedAt).toBe('number');
  });

  it('picks the most recent matching event when a conversation matches twice', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, {
      sessionId, type: 'prompt', payload: { text: 'marmalade first' }, sender: 'user', seq: 1, ts: 1000,
    });
    const newer = appendEvent(db, {
      sessionId, type: 'prompt', payload: { text: 'marmalade second' }, sender: 'user', seq: 2, ts: 2000,
    });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade')).body as Hit[];
    expect(hit.eventId).toBe(newer.id);
    expect(hit.snippet).toContain('second');
  });

  it('points a streaming-turn match at that turn\'s indexed event row', async () => {
    // D3: the live `final` trigger indexes at the terminator row; the 109 backfill
    // indexes at the last content chunk. Either way the id must belong to THIS turn,
    // which is all the client needs (mergeMessageChunks merges the whole turn).
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    const c1 = appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'the marma', final: false }, sender: 'agent', seq: 1, ts: 1000 });
    const c2 = appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'lade parser', final: false }, sender: 'agent', seq: 2, ts: 1001 });
    const term = appendEvent(db, { sessionId, type: 'message', payload: { chunk: '', final: true }, sender: 'agent', seq: 3, ts: 1002 });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade')).body as Hit[];
    expect([c1.id, c2.id, term.id]).toContain(hit.eventId);
  });

  it('gives every conversation its own eventId', async () => {
    const { db, app } = bootApp();
    const a = seed(db, 'A');
    const b = seed(db, 'B');
    const ea = appendEvent(db, { sessionId: a.sessionId, type: 'prompt', payload: { text: 'marmalade a' }, sender: 'user' });
    const eb = appendEvent(db, { sessionId: b.sessionId, type: 'prompt', payload: { text: 'marmalade b' }, sender: 'user' });
    const hits = (await fetchJson(app, '/conversations/search?q=marmalade')).body as Hit[];
    expect(hits).toHaveLength(2);
    const byConv = Object.fromEntries(hits.map((h) => [h.id, h.eventId]));
    expect(byConv[a.conversationId]).toBe(ea.id);
    expect(byConv[b.conversationId]).toBe(eb.id);
  });

  it('caps the snippet body at 160 characters plus an ellipsis', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: `marmalade ${'x'.repeat(500)}` }, sender: 'user' });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade')).body as Hit[];
    expect(hit.snippet!.length).toBe(161);
    expect(hit.snippet!.startsWith('marmalade')).toBe(true);
    expect(hit.snippet!.endsWith('…')).toBe(true);
  });

  it('centres the snippet on the matched word deep inside a long prompt', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: `${'lorem '.repeat(100)}marmalade${' ipsum'.repeat(100)}` }, sender: 'user' });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade')).body as Hit[];
    expect(hit.snippet!.startsWith('…')).toBe(true);
    expect(hit.snippet).toContain('marmalade');
  });

  it('reconstructs a streaming turn for the snippet', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'the marma', final: false }, sender: 'agent', seq: 1 });
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: 'lade parser', final: false }, sender: 'agent', seq: 2 });
    appendEvent(db, { sessionId, type: 'message', payload: { chunk: '', final: true }, sender: 'agent', seq: 3 });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade')).body as Hit[];
    expect(hit.snippet).toContain('marmalade parser');
  });

  it('omits matches when matchesPerConversation is absent', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade')).body as Record<string, unknown>[];
    expect(Object.keys(hit).sort()).toEqual(['eventId', 'id', 'projectId', 'snippet', 'title', 'updatedAt']);
  });

  it('returns up to N newest matches per conversation, newest first, top-level = matches[0]', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    for (let i = 1; i <= 7; i++) {
      appendEvent(db, { sessionId, type: 'prompt', payload: { text: `marmalade ${i}` }, sender: 'user', seq: i, ts: 1000 + i });
    }
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade&matchesPerConversation=3')).body as any[];
    expect(hit.matches.map((m: any) => m.snippet)).toEqual(['marmalade 7', 'marmalade 6', 'marmalade 5']);
    expect(hit.eventId).toBe(hit.matches[0].eventId);
    expect(hit.snippet).toBe(hit.matches[0].snippet);
    expect(hit.matches[0]).toMatchObject({ ts: 1007, sender: 'user' });
  });

  it('clamps matchesPerConversation to 1..5 and limit still counts conversations', async () => {
    const { db, app } = bootApp();
    const a = seed(db, 'A'); const b = seed(db, 'B');
    for (let i = 1; i <= 7; i++) {
      appendEvent(db, { sessionId: a.sessionId, type: 'prompt', payload: { text: `marmalade a${i}` }, sender: 'user', seq: i });
      appendEvent(db, { sessionId: b.sessionId, type: 'prompt', payload: { text: `marmalade b${i}` }, sender: 'user', seq: i });
    }
    const hits = (await fetchJson(app, '/conversations/search?q=marmalade&matchesPerConversation=99&limit=1')).body as any[];
    expect(hits).toHaveLength(1);
    expect(hits[0].matches).toHaveLength(5);
    const zero = (await fetchJson(app, '/conversations/search?q=marmalade&matchesPerConversation=0')).body as any[];
    expect(zero[0].matches).toHaveLength(1);
  });

  it('treats a non-numeric matchesPerConversation as absent', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade' }, sender: 'user' });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade&matchesPerConversation=abc')).body as any[];
    expect('matches' in hit).toBe(false);
  });

  it('includes a length-1 matches array for matchesPerConversation=1', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade one' }, sender: 'user', seq: 1, ts: 1 });
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'marmalade two' }, sender: 'user', seq: 2, ts: 2 });
    const [hit] = (await fetchJson(app, '/conversations/search?q=marmalade&matchesPerConversation=1')).body as any[];
    expect(hit.matches).toHaveLength(1);
    expect(hit.matches[0].snippet).toBe('marmalade two');
  });

  it('returns one helper match when two terminal snapshots share a taskId', async () => {
    const { db, app } = bootApp();
    const { sessionId } = seed(db);
    appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'completed', summary: 'old marmalade' }), sender: 'agent', seq: 1 });
    const newest = appendEvent(db, { sessionId, type: 'helper', payload: helperPayload({ status: 'completed', summary: 'new damson' }), sender: 'agent', seq: 2 });
    const res = await fetchJson(app, '/conversations/search?q=Explore&matchesPerConversation=5');
    const hits = res.body as any[];
    expect(hits).toHaveLength(1);
    expect(hits[0].matches).toHaveLength(1);
    expect(hits[0].matches[0].eventId).toBe(newest.id);
    expect(hits[0].matches[0].sender).toBe('helper');
  });

  it('returns helper matches with sender helper and a centred snippet', async () => {
    const { db, app } = bootApp();
    const { conversationId, sessionId } = seed(db);
    const ev = appendEvent(db, {
      sessionId,
      type: 'helper',
      sender: 'agent',
      payload: {
        taskId: 't1',
        toolUseId: 'tu1',
        label: 'Explore',
        description: `${'lorem '.repeat(40)}marmalade${' ipsum'.repeat(40)}`,
        summary: 'found the parser',
        status: 'completed',
        startedAt: 1,
      },
    });
    const res = await fetchJson(app, '/conversations/search?q=marmalade&matchesPerConversation=3');
    expect(res.status).toBe(200);
    const hits = res.body as any[];
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(conversationId);
    expect(hits[0].eventId).toBe(ev.id);
    expect(hits[0].matches[0]).toMatchObject({ eventId: ev.id, sender: 'helper' });
    expect(hits[0].matches[0].snippet).toContain('marmalade');
    expect(hits[0].matches[0].snippet.startsWith('…')).toBe(true);
  });
});


