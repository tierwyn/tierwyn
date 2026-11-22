import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from './projects.js';
import { createConversation, getConversation } from './conversations.js';
import { archiveConversation, runRetentionPurge } from './retention.js';
import { listEventsForConversation } from './events.js';
import {
  isSafeArchiveId, archiveFilePath, readArchiveHeader, forEachJsonlLine, listArchiveEntries,
  restoreArchivedConversation, deleteArchiveFile, deleteAllArchiveFiles,
} from './archiveRestore.js';

let tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-restore-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

function header(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    archive: 'tierwyn-conversation',
    version: 2,
    conversation: {
      id,
      title: `chat ${id}`,
      project_id: 'p1',
      kind: 'chat',
      parent_conversation_id: null,
      pinned: 0,
      created_at: 1000,
      updated_at: 2000,
      ...over,
    },
    eventCount: 3,
  });
}

function writeArchive(dir: string, id: string, lines: string[], over: Record<string, unknown> = {}): string {
  const archiveDir = join(dir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const p = join(archiveDir, `${id}.jsonl`);
  writeFileSync(p, [header(id, over), ...lines].join('\n') + '\n');
  return p;
}

describe('isSafeArchiveId', () => {
  it('accepts a uuid and rejects anything path-shaped', () => {
    expect(isSafeArchiveId('4f2c1e8a-0b1d-4f3a-9c2e-11aa22bb33cc')).toBe(true);
    expect(isSafeArchiveId('abc_DEF-123')).toBe(true);
    expect(isSafeArchiveId('../../etc/passwd')).toBe(false);
    expect(isSafeArchiveId('..')).toBe(false);
    expect(isSafeArchiveId('a/b')).toBe(false);
    expect(isSafeArchiveId('a\\b')).toBe(false);
    expect(isSafeArchiveId('a.jsonl')).toBe(false);
    expect(isSafeArchiveId('a b')).toBe(false);
    expect(isSafeArchiveId('')).toBe(false);
    expect(isSafeArchiveId('x'.repeat(129))).toBe(false);
  });
});

describe('archiveFilePath', () => {
  it('always lands inside <dataDir>/archive', () => {
    expect(archiveFilePath('/data', 'abc')).toBe('/data/archive/abc.jsonl');
  });
});

describe('forEachJsonlLine', () => {
  it('yields every non-empty line, including a final line with no trailing newline', () => {
    const dir = tmpDir();
    const p = join(dir, 'x.jsonl');
    writeFileSync(p, 'one\ntwo\n\nthree');
    const got: string[] = [];
    forEachJsonlLine(p, (l) => { got.push(l); });
    expect(got).toEqual(['one', 'two', 'three']);
  });

  it('does not corrupt a multi-byte character split across the 64KiB read boundary', () => {
    const dir = tmpDir();
    const p = join(dir, 'wide.jsonl');
    // 65535 ASCII bytes then a 2-byte char => the character straddles offset 65536.
    const line = 'a'.repeat(65535) + 'é';
    writeFileSync(p, line + '\n');
    const got: string[] = [];
    forEachJsonlLine(p, (l) => { got.push(l); });
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(line);
    expect(got[0]).not.toContain('�');
  });
});

describe('readArchiveHeader', () => {
  it('parses a version-2 header', () => {
    const dir = tmpDir();
    const p = writeArchive(dir, 'c1', ['{"id":"e1"}']);
    expect(readArchiveHeader(p)).toEqual(expect.objectContaining({
      id: 'c1', title: 'chat c1', project_id: 'p1', eventCount: 3,
    }));
  });

  it('returns undefined for a non-JSON first line', () => {
    const dir = tmpDir();
    const p = join(dir, 'junk.jsonl');
    writeFileSync(p, 'not json at all\n');
    expect(readArchiveHeader(p)).toBeUndefined();
  });

  it('returns undefined for JSON that is not a tierwyn archive header', () => {
    const dir = tmpDir();
    const p = join(dir, 'other.jsonl');
    writeFileSync(p, JSON.stringify({ archive: 'something-else', version: 2 }) + '\n');
    expect(readArchiveHeader(p)).toBeUndefined();
  });

});

describe('listArchiveEntries', () => {
  it('returns [] when the archive dir does not exist', () => {
    expect(listArchiveEntries(tmpDir())).toEqual([]);
  });

  it('lists jsonl archives newest-mtime first and skips junk without throwing', () => {
    const dir = tmpDir();
    const older = writeArchive(dir, 'c-old', ['{"id":"e1"}']);
    const newer = writeArchive(dir, 'c-new', ['{"id":"e2"}'], { title: 'newest' });
    writeFileSync(join(dir, 'archive', 'notes.txt'), 'ignored');
    writeFileSync(join(dir, 'archive', 'broken.jsonl'), 'this is not json\n');
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));

    const items = listArchiveEntries(dir);
    expect(items.map((i) => i.id)).toEqual(['c-new', 'c-old']);
    expect(items[0]).toEqual(expect.objectContaining({
      id: 'c-new',
      title: 'newest',
      projectId: 'p1',
      parentConversationId: null,
      eventCount: 3,
    }));
    expect(items[0].bytes).toBeGreaterThan(0);
    expect(items[0].mtime).toBeGreaterThan(items[1].mtime);
  });

  it('skips a file whose stem does not match its header id', () => {
    const dir = tmpDir();
    const archiveDir = join(dir, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, 'mismatch.jsonl'), header('c-real') + '\n');
    expect(listArchiveEntries(dir)).toEqual([]);
  });
});

describe('deleteArchiveFile', () => {
  it('unlinks one jsonl and leaves siblings', () => {
    const dir = tmpDir();
    writeArchive(dir, 'keep-me', ['{"id":"e1"}']);
    writeArchive(dir, 'drop-me', ['{"id":"e2"}']);
    expect(deleteArchiveFile(dir, 'drop-me')).toEqual({ ok: true });
    expect(existsSync(archiveFilePath(dir, 'drop-me'))).toBe(false);
    expect(existsSync(archiveFilePath(dir, 'keep-me'))).toBe(true);
    expect(listArchiveEntries(dir).map((i) => i.id)).toEqual(['keep-me']);
  });

  it('returns not_found for a missing file and bad_id for a path-shaped id', () => {
    const dir = tmpDir();
    expect(deleteArchiveFile(dir, 'nope-nope-nope'))
      .toEqual({ ok: false, code: 'not_found', message: expect.any(String) });
    expect(deleteArchiveFile(dir, '../../etc/passwd'))
      .toEqual({ ok: false, code: 'bad_id', message: 'invalid archive id' });
    expect(existsSync(join(dir, 'etc'))).toBe(false);
  });
});

describe('deleteAllArchiveFiles', () => {
  it('unlinks every regular file in the archive dir, including junk', () => {
    const dir = tmpDir();
    writeArchive(dir, 'a', ['{"id":"e1"}']);
    writeArchive(dir, 'b', ['{"id":"e2"}']);
    writeFileSync(join(dir, 'archive', 'notes.txt'), 'ignored by list, counted by stats');
    expect(deleteAllArchiveFiles(dir)).toEqual({ deleted: 3 });
    expect(listArchiveEntries(dir)).toEqual([]);
    expect(existsSync(join(dir, 'archive', 'notes.txt'))).toBe(false);
  });

  it('returns deleted: 0 when the archive dir is missing', () => {
    expect(deleteAllArchiveFiles(tmpDir())).toEqual({ deleted: 0 });
  });
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

/** File-backed DB so <dir>/archive/ is a real directory next to it. */
function bootDb(dir: string): Db {
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
  return db;
}

/** One session + a prompt and a final message on the given conversation. */
function seedTurn(db: Db, convId: string, sessionId: string, promptText: string, modelId: string | null) {
  db.prepare(
    'INSERT INTO sessions (id,conversation_id,agent_id,agent_model_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(sessionId, convId, 'a1', modelId, 'native-xyz', NOW, NOW);
  db.prepare(
    'INSERT INTO events (id,session_id,type,payload,sender,agent_model_id,seq,ts) VALUES (?,?,?,?,?,?,?,?)',
  ).run(`${sessionId}-e1`, sessionId, 'prompt', JSON.stringify({ text: promptText }), 'user', modelId, 1, NOW);
  db.prepare(
    'INSERT INTO events (id,session_id,type,payload,sender,agent_model_id,seq,ts) VALUES (?,?,?,?,?,?,?,?)',
  ).run(`${sessionId}-e2`, sessionId, 'message', JSON.stringify({ chunk: 'sure thing', final: 1 }), 'agent', modelId, 2, NOW + 1);
}

function ftsHits(db: Db, term: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM event_fts WHERE event_fts MATCH ?').get(term) as { n: number }).n;
}

describe('restoreArchivedConversation', () => {
  it('round-trips archive -> purge -> restore with preserved ids, events and FTS', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'the old chat' });
    seedTurn(db, c.id, 's1', 'restore me zebrafish', 'm1');
    db.prepare('UPDATE conversations SET updated_at = ?, pinned = 0 WHERE id = ?').run(NOW - 100 * DAY, c.id);

    const purge = await runRetentionPurge({
      db, retentionDays: 90, dataDir: dir, now: NOW, vacuum: () => { /* no VACUUM in tests */ },
    });
    expect(purge.deletedIds).toEqual([c.id]);
    expect(getConversation(db, c.id)).toBeUndefined();
    expect(ftsHits(db, 'zebrafish')).toBe(0);

    const out = restoreArchivedConversation(db, dir, c.id);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.restored).toEqual([{ id: c.id, title: 'the old chat' }]);
    expect(out.projectId).toBe(p.id);
    expect(out.eventsRestored).toBe(2);
    expect(out.parentCleared).toBe(false);

    const back = getConversation(db, c.id);
    expect(back).toEqual(expect.objectContaining({ id: c.id, title: 'the old chat', projectId: p.id }));
    // D11: clocks come from the header, not from now().
    expect(back!.updatedAt).toBe(NOW - 100 * DAY);

    const events = listEventsForConversation(db, c.id);
    expect(events.map((e) => e.id)).toEqual(['s1-e1', 's1-e2']);
    expect(events[0].payload).toEqual({ text: 'restore me zebrafish' });

    // D3: a stub session exists, with no native session id.
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>;
    expect(sess).toEqual(expect.objectContaining({
      conversation_id: c.id, agent_id: null, agent_model_id: 'm1', native_session_id: null,
    }));

    // D9: the AFTER INSERT triggers rebuilt the FTS index for us.
    expect(ftsHits(db, 'zebrafish')).toBe(1);
    db.close();
  });

  it('restores summaries and the draft row', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'with extras' });
    seedTurn(db, c.id, 's1', 'hello', 'm1');
    db.prepare(
      'INSERT INTO summaries (id, conversation_id, last_event_id, summary_text, created_at) VALUES (?,?,?,?,?)',
    ).run('sum1', c.id, 's1-e2', 'they said hello', NOW);
    db.prepare(
      'INSERT INTO draft_prompts (conversation_id, text, updated_at) VALUES (?,?,?)',
    ).run(c.id, 'half typed', NOW);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, c.id);

    await runRetentionPurge({ db, retentionDays: 90, dataDir: dir, now: NOW, vacuum: () => {} });
    const out = restoreArchivedConversation(db, dir, c.id);
    expect(out.ok).toBe(true);

    expect(db.prepare('SELECT summary_text FROM summaries WHERE id = ?').get('sum1'))
      .toEqual({ summary_text: 'they said hello' });
    expect(db.prepare('SELECT text FROM draft_prompts WHERE conversation_id = ?').get(c.id))
      .toEqual({ text: 'half typed' });
    db.close();
  });

  it('returns not_found for an id with no archive file', () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    expect(restoreArchivedConversation(db, dir, 'nope-nope-nope'))
      .toEqual({ ok: false, code: 'not_found', message: expect.any(String) });
    db.close();
  });

  it('returns bad_id for a path-shaped id and never touches the filesystem', () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    expect(restoreArchivedConversation(db, dir, '../../etc/passwd'))
      .toEqual({ ok: false, code: 'bad_id', message: expect.any(String) });
    db.close();
  });

  it('returns already_live when the conversation id is still in the DB', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'still here' });
    seedTurn(db, c.id, 's1', 'hi', 'm1');
    // Archive without deleting — the live row and the file now coexist.
    expect(await archiveConversation(db, dir, c.id)).toBe(true);

    expect(restoreArchivedConversation(db, dir, c.id))
      .toEqual({ ok: false, code: 'already_live', message: expect.any(String) });
    // D5: a failed restore leaves the archive on disk.
    expect(listArchiveEntries(dir).map((i) => i.id)).toContain(c.id);
    db.close();
  });

  it('restoring the same file twice returns already_live the second time', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'twice' });
    seedTurn(db, c.id, 's1', 'once only', 'm1');
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, c.id);
    await runRetentionPurge({ db, retentionDays: 90, dataDir: dir, now: NOW, vacuum: () => {} });

    expect(restoreArchivedConversation(db, dir, c.id).ok).toBe(true);
    expect(restoreArchivedConversation(db, dir, c.id))
      .toEqual({ ok: false, code: 'already_live', message: expect.any(String) });
    expect(listEventsForConversation(db, c.id)).toHaveLength(2); // not duplicated
    db.close();
  });

  it('returns no_project when the original project is gone, and succeeds with an explicit target', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p1 = createProject(db, { name: 'P1', rootPath: '/p1' });
    const p2 = createProject(db, { name: 'P2', rootPath: '/p2' });
    const c = createConversation(db, { projectId: p1.id, title: 'homeless' });
    seedTurn(db, c.id, 's1', 'orphan text', 'm1');
    expect(await archiveConversation(db, dir, c.id)).toBe(true);
    // Deleting the project cascades the conversation away — same end state as a purge.
    db.prepare('DELETE FROM projects WHERE id = ?').run(p1.id);
    expect(getConversation(db, c.id)).toBeUndefined();

    expect(restoreArchivedConversation(db, dir, c.id))
      .toEqual({ ok: false, code: 'no_project', message: expect.any(String) });
    expect(restoreArchivedConversation(db, dir, c.id, { projectId: 'does-not-exist' }))
      .toEqual({ ok: false, code: 'no_project', message: expect.any(String) });

    const out = restoreArchivedConversation(db, dir, c.id, { projectId: p2.id });
    expect(out.ok).toBe(true);
    expect(getConversation(db, c.id)!.projectId).toBe(p2.id);
    db.close();
  });

  it('restores a root together with its archived descendants, parent before child', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root chat' });
    const child = createConversation(db, {
      projectId: p.id, title: 'child chat', parentConversationId: root.id,
    });
    seedTurn(db, root.id, 's-root', 'root says badgerfish', 'm1');
    seedTurn(db, child.id, 's-child', 'child says otterfish', 'm1');
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    await runRetentionPurge({ db, retentionDays: 90, dataDir: dir, now: NOW, vacuum: () => {} });
    expect(getConversation(db, child.id)).toBeUndefined();

    const out = restoreArchivedConversation(db, dir, root.id);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.restored.map((r) => r.id)).toEqual([root.id, child.id]);
    expect(out.eventsRestored).toBe(4);
    expect(out.parentCleared).toBe(false);
    expect(getConversation(db, child.id)!.parentConversationId).toBe(root.id);
    expect(ftsHits(db, 'otterfish')).toBe(1);
    db.close();
  });

  it('restores a lone child as a root and reports parentCleared (D4)', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root chat' });
    const child = createConversation(db, {
      projectId: p.id, title: 'child chat', parentConversationId: root.id,
    });
    seedTurn(db, child.id, 's-child', 'lonely child', 'm1');
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    await runRetentionPurge({ db, retentionDays: 90, dataDir: dir, now: NOW, vacuum: () => {} });

    const out = restoreArchivedConversation(db, dir, child.id);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.restored.map((r) => r.id)).toEqual([child.id]);
    expect(out.parentCleared).toBe(true);
    expect(getConversation(db, child.id)!.parentConversationId).toBeUndefined();
    db.close();
  });

  it('already_live for a child-then-root restore names the descendant title, not a hidden uuid', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root chat' });
    const child = createConversation(db, {
      projectId: p.id, title: 'child chat', parentConversationId: root.id,
    });
    seedTurn(db, root.id, 's-root', 'root says', 'm1');
    seedTurn(db, child.id, 's-child', 'child says', 'm1');
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    await runRetentionPurge({ db, retentionDays: 90, dataDir: dir, now: NOW, vacuum: () => {} });

    expect(restoreArchivedConversation(db, dir, child.id).ok).toBe(true);
    const out = restoreArchivedConversation(db, dir, root.id);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('already_live');
    expect(out.message).toMatch(/descendant/i);
    expect(out.message).toContain('child chat');
    expect(out.message).not.toContain(child.id);
    db.close();
  });

  it('nulls an agent_model_id that the catalogue no longer has (D12)', async () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'stale model' });
    seedTurn(db, c.id, 's1', 'model went away', 'm1');
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, c.id);
    await runRetentionPurge({ db, retentionDays: 90, dataDir: dir, now: NOW, vacuum: () => {} });
    db.prepare('DELETE FROM agent_models WHERE id = ?').run('m1');

    const out = restoreArchivedConversation(db, dir, c.id);
    expect(out.ok).toBe(true);
    expect(db.prepare('SELECT agent_model_id FROM sessions WHERE id = ?').get('s1'))
      .toEqual({ agent_model_id: null });
    expect(db.prepare('SELECT DISTINCT agent_model_id FROM events WHERE session_id = ?').all('s1'))
      .toEqual([{ agent_model_id: null }]);
    db.close();
  });

  it('returns malformed and writes nothing when a body line is not JSON', () => {
    const dir = tmpDir();
    const db = bootDb(dir);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const archiveDir = join(dir, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const id = 'c-broken';
    writeFileSync(join(archiveDir, `${id}.jsonl`), [
      JSON.stringify({
        archive: 'tierwyn-conversation',
        version: 2,
        conversation: {
          id, title: 'broken', project_id: p.id, kind: 'chat',
          parent_conversation_id: null, pinned: 0, created_at: NOW, updated_at: NOW,
        },
        eventCount: 1,
      }),
      '{ this is not json',
    ].join('\n') + '\n');

    expect(restoreArchivedConversation(db, dir, id))
      .toEqual({ ok: false, code: 'malformed', message: expect.any(String) });
    // D8: the transaction rolled back, so no half-restored conversation exists.
    expect(getConversation(db, id)).toBeUndefined();
    db.close();
  });
});
