import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import {
  createConversation, createScheduleHomeConversation, getConversation, setConversationPinned,
} from './conversations.js';
import { insertTtsRecording, setTtsRecordingsRoot } from './ttsRecordings.js';
import {
  listPurgeCandidates, runRetentionPurge, archiveConversation, archiveExists,
  RETENTION_HOUR, msUntilNextRetentionHour, startRetentionScheduler,
  trimOldToolResults, TOOL_RESULT_KEEP_CHARS,
} from './retention.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function seedAgent(db: Database, agentId = 'a1'): void {
  db.prepare(
    `INSERT INTO agents (id, type, label, description, env_vars, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(agentId, agentId, agentId, '', '{}', Date.now());
}

function addSession(db: Database, sessionId: string, conversationId: string, agentId?: string): void {
  db.prepare(
    'INSERT INTO sessions (id,conversation_id,agent_id,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run(sessionId, conversationId, agentId ?? null, Date.now(), Date.now());
}

function addEvent(
  db: Database,
  id: string,
  sessionId: string,
  ts: number,
  seq: number,
  payload = '{}',
): void {
  db.prepare(
    "INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)",
  ).run(id, sessionId, 'message', payload, 'agent', seq, ts);
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

let tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-ret-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  setTtsRecordingsRoot(null);
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

describe('listPurgeCandidates', () => {
  it('excludes pinned conversations', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const old = createConversation(db, { projectId: p.id, title: 'old' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, old.id);
    setConversationPinned(db, old.id, true);
    expect(listPurgeCandidates(db, 90, NOW)).toEqual([]);
  });

  it('excludes schedule_home conversations', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const home = createScheduleHomeConversation(db, { projectId: p.id, jobName: 'job' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, home.id);
    expect(listPurgeCandidates(db, 90, NOW).map((c) => c.id)).not.toContain(home.id);
  });

  it('excludes non-root (spawn child) conversations', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root' });
    const child = createConversation(db, { projectId: p.id, title: 'child', parentConversationId: root.id });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, child.id);
    const ids = listPurgeCandidates(db, 90, NOW).map((c) => c.id);
    expect(ids).toContain(root.id);
    expect(ids).not.toContain(child.id);
  });

  it('respects the age boundary (updated_at < cutoff)', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const expired = createConversation(db, { projectId: p.id, title: 'expired' });
    const boundary = createConversation(db, { projectId: p.id, title: 'boundary' });
    const fresh = createConversation(db, { projectId: p.id, title: 'fresh' });
    const cutoff = NOW - 90 * DAY;
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(cutoff - 1, expired.id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(cutoff, boundary.id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(cutoff + 1, fresh.id);
    const ids = listPurgeCandidates(db, 90, NOW).map((c) => c.id);
    expect(ids).toContain(expired.id);
    expect(ids).not.toContain(boundary.id);
    expect(ids).not.toContain(fresh.id);
  });
});

describe('runRetentionPurge', () => {
  it('skips a live root', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'live' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, c.id);
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, isLive: (id) => id === c.id,
    });
    expect(res.skippedLive).toEqual([c.id]);
    expect(res.deletedIds).toEqual([]);
    expect(getConversation(db, c.id)).toBeDefined();
  });

  it('skips the tree when a descendant is live', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root' });
    const child = createConversation(db, { projectId: p.id, title: 'child', parentConversationId: root.id });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, isLive: (id) => id === child.id,
    });
    expect(res.skippedLive).toEqual([root.id]);
    expect(res.deletedIds).toEqual([]);
    expect(getConversation(db, root.id)).toBeDefined();
    expect(getConversation(db, child.id)).toBeDefined();
  });

  it('deletes subtree events with the root', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root' });
    const child = createConversation(db, { projectId: p.id, title: 'child', parentConversationId: root.id });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    addSession(db, 's-root', root.id);
    addSession(db, 's-child', child.id);
    addEvent(db, 'e-root', 's-root', 1, 1);
    addEvent(db, 'e-child', 's-child', 2, 1);
    const res = await runRetentionPurge({ db, retentionDays: 90, now: NOW });
    expect(res.deletedIds).toEqual([root.id]);
    expect(res.eventsDeleted).toBe(2);
    expect(getConversation(db, root.id)).toBeUndefined();
    expect(getConversation(db, child.id)).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
  });

  it('invokes unlinkTts with wav paths from the deleted tree', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const ttsDir = tmpDir();
    setTtsRecordingsRoot(ttsDir);
    const root = createConversation(db, { projectId: p.id, title: 'root' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    const rec = insertTtsRecording(db, {
      conversationId: root.id,
      source: 'message',
      mode: 'as-is',
      provider: 'piper',
      voice: 'en',
      title: 't',
      spokenText: 'hi',
      buf: Buffer.from('RIFF....WAVEfmt '),
    });
    expect(rec).not.toBeNull();
    const seen: string[][] = [];
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW,
      unlinkTts: (paths) => { seen.push(paths); },
    });
    expect(res.deletedIds).toEqual([root.id]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(join(ttsDir, `${rec!.id}.wav`));
  });

  // P2c: native rows must carry their project so the route can route the
  // unlink through createAdapterFor to the right remote host.
  it('passes projectId through onNativeSessions', async () => {
    const db = freshDb();
    seedAgent(db, 'a1');
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    db.prepare(
      'INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).run('s-native', root.id, 'a1', 'nat-1', Date.now(), Date.now());

    const seen: Array<{ agentId: string; nativeSessionId: string; projectId?: string }>[] = [];
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW,
      onNativeSessions: (sessions) => { seen.push(sessions); },
    });
    expect(res.deletedIds).toEqual([root.id]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContainEqual({ agentId: 'a1', nativeSessionId: 'nat-1', projectId: p.id });
  });

  it('keeps the tree when archive write fails (unwritable dataDir)', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    const blocker = join(tmpDir(), 'not-a-dir');
    writeFileSync(blocker, 'x');
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, dataDir: blocker,
    });
    expect(res.deletedIds).toEqual([]);
    expect(getConversation(db, root.id)).toBeDefined();
  });

  it('honours maxConversations and reports remaining', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = createConversation(db, { projectId: p.id, title: `old-${i}` });
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - (100 + i) * DAY, c.id);
      ids.push(c.id);
    }
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, maxConversations: 1,
    });
    expect(res.deletedIds).toHaveLength(1);
    expect(res.remaining).toBe(2);
    const still = ids.filter((id) => getConversation(db, id));
    expect(still).toHaveLength(2);
  });

  it('deletes a child with its expired root even if the child row is pinned', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root' });
    const child = createConversation(db, { projectId: p.id, title: 'child', parentConversationId: root.id });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, root.id);
    setConversationPinned(db, child.id, true); // leftover child pin must not protect the tree
    const res = await runRetentionPurge({ db, retentionDays: 90, now: NOW });
    expect(res.deletedIds).toEqual([root.id]);
    expect(getConversation(db, root.id)).toBeUndefined();
    expect(getConversation(db, child.id)).toBeUndefined();
  });

  it('keeps bytesAfter equal to bytesBefore when an intermediate pass skips VACUUM', async () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'tierwyn.db');
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    for (let i = 0; i < 2; i++) {
      const c = createConversation(db, { projectId: p.id, title: `old-${i}` });
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - (100 + i) * DAY, c.id);
    }
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, maxConversations: 1,
    });
    expect(res.remaining).toBeGreaterThan(0);
    expect(res.deletedIds).toHaveLength(1);
    expect(res.bytesBefore).toBeGreaterThan(0);
    expect(res.bytesAfter).toBe(res.bytesBefore);
    db.close();
  });

  it('VACUUMs only on the final chunk (remaining === 0)', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    for (let i = 0; i < 2; i++) {
      const c = createConversation(db, { projectId: p.id, title: `old-${i}` });
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - (100 + i) * DAY, c.id);
    }
    const vacuums: number[] = [];
    const vacuum = () => { vacuums.push(1); };
    const chunk = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, maxConversations: 1, vacuum,
    });
    expect(chunk.remaining).toBe(1);
    expect(chunk.deletedIds).toHaveLength(1);
    expect(vacuums).toHaveLength(0);
    const final = await runRetentionPurge({ db, retentionDays: 90, now: NOW, vacuum });
    expect(final.remaining).toBe(0);
    expect(final.deletedIds).toHaveLength(1);
    expect(vacuums).toHaveLength(1);
  });
});

describe('runRetentionPurge VACUUM safety', () => {
  function fileDb() {
    const dbPath = join(tmpDir(), 'tierwyn.db');
    const db = openDb(dbPath);
    runMigrations(db, migrations);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'old' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, c.id);
    return { db, dbPath };
  }

  it('openDb caps the WAL file at 128 MB', () => {
    const { db } = fileDb();
    expect(db.pragma('journal_size_limit', { simple: true })).toBe(134217728);
    db.close();
  });

  it('skips VACUUM and reports it when free space is too low', async () => {
    const { db } = fileDb();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vacuum = vi.fn();
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, vacuum, getFreeBytes: () => 0,
    });
    spy.mockRestore();
    expect(res.deletedIds).toHaveLength(1);
    expect(vacuum).not.toHaveBeenCalled();
    expect(res.vacuumSkipped).toBe(true);
    expect(res.vacuumFailed).toBeUndefined();
    expect(res.bytesAfter).toBe(res.bytesBefore);
    db.close();
  });

  it('leaves an empty WAL after a real VACUUM', async () => {
    const { db, dbPath } = fileDb();
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, getFreeBytes: () => Number.MAX_SAFE_INTEGER,
    });
    expect(res.vacuumSkipped).toBeUndefined();
    expect(res.vacuumFailed).toBeUndefined();
    expect(statSync(`${dbPath}-wal`).size).toBe(0);
    db.close();
  });

  it('still checkpoints when VACUUM throws, and reports the failure', async () => {
    const { db, dbPath } = fileDb();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await runRetentionPurge({
      db, retentionDays: 90, now: NOW, getFreeBytes: () => Number.MAX_SAFE_INTEGER,
      vacuum: (d) => {
        d.exec('CREATE TABLE wal_filler (x)');
        expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
        throw new Error('database or disk is full');
      },
    });
    spy.mockRestore();
    expect(res.vacuumFailed).toBe(true);
    expect(res.bytesAfter).toBe(res.bytesBefore);
    expect(statSync(`${dbPath}-wal`).size).toBe(0);
    db.close();
  });
});

describe('archiveConversation', () => {
  it('writes a v2 header, descendant file, summaries/draft lines, and events ordered by ts,seq', async () => {
    const db = freshDb();
    seedAgent(db);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const root = createConversation(db, { projectId: p.id, title: 'root' });
    const child = createConversation(db, { projectId: p.id, title: 'child', parentConversationId: root.id });
    addSession(db, 's-root', root.id, 'a1');
    addEvent(db, 'e-late', 's-root', 200, 1, '{"n":"late"}');
    addEvent(db, 'e-early-b', 's-root', 100, 2, '{"n":"early-b"}');
    addEvent(db, 'e-early-a', 's-root', 100, 1, '{"n":"early-a"}');
    db.prepare(
      'INSERT INTO summaries (id, conversation_id, last_event_id, summary_text, created_at) VALUES (?,?,?,?,?)',
    ).run('sum1', root.id, 'e-late', 'a summary', NOW);
    db.prepare(
      'INSERT INTO draft_prompts (conversation_id, text, updated_at, attachments) VALUES (?,?,?,?)',
    ).run(root.id, 'draft text', NOW, '[]');

    const dataDir = tmpDir();
    const ok = await archiveConversation(db, dataDir, root.id);
    expect(ok).toBe(true);
    expect(archiveExists(dataDir, root.id)).toBe(true);
    expect(archiveExists(dataDir, child.id)).toBe(true);

    const lines = readFileSync(join(dataDir, 'archive', `${root.id}.jsonl`), 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]) as {
      archive: string; version: number; eventCount: number;
      conversation: {
        id: string; title: string; project_id: string; kind: string;
        parent_conversation_id: string | null; pinned: number;
        created_at: number; updated_at: number;
      };
    };
    expect(header.archive).toBe('tierwyn-conversation');
    expect(header.version).toBe(2);
    expect(header.eventCount).toBe(3);
    expect(header.conversation.id).toBe(root.id);
    expect(header.conversation.title).toBe('root');
    expect(header.conversation.project_id).toBe(p.id);
    expect(header.conversation.kind).toBe('chat');
    expect(header.conversation.parent_conversation_id).toBeNull();
    expect(header.conversation.pinned).toBe(0);
    expect(typeof header.conversation.created_at).toBe('number');
    expect(typeof header.conversation.updated_at).toBe('number');

    const eventLines = lines.slice(1, 4).map((l) => JSON.parse(l) as { id: string; ts: number; seq: number });
    expect(eventLines.map((e) => e.id)).toEqual(['e-early-a', 'e-early-b', 'e-late']);
    expect(eventLines[0].ts).toBe(100);
    expect(eventLines[0].seq).toBe(1);

    const extras = lines.slice(4).map((l) => JSON.parse(l) as { record: string });
    expect(extras.some((r) => r.record === 'summary')).toBe(true);
    expect(extras.some((r) => r.record === 'draft')).toBe(true);

    expect(existsSync(join(dataDir, 'archive', `${child.id}.jsonl`))).toBe(true);
    const childHeader = JSON.parse(
      readFileSync(join(dataDir, 'archive', `${child.id}.jsonl`), 'utf8').split('\n')[0],
    ) as { conversation: { parent_conversation_id: string; id: string } };
    expect(childHeader.conversation.id).toBe(child.id);
    expect(childHeader.conversation.parent_conversation_id).toBe(root.id);
  });
});

describe('retention schedule constants', () => {
  it('fires at 03:00 local', () => {
    expect(RETENTION_HOUR).toBe(3);
    const before = new Date(2026, 7, 15, 2, 0, 0, 0).getTime();
    const atHour = new Date(2026, 7, 15, 3, 0, 0, 0).getTime();
    expect(msUntilNextRetentionHour(before)).toBe(atHour - before);
    const after = new Date(2026, 7, 15, 12, 0, 0, 0).getTime();
    const nextDay = new Date(2026, 7, 16, 3, 0, 0, 0).getTime();
    expect(msUntilNextRetentionHour(after)).toBe(nextDay - after);
  });
});

describe('startRetentionScheduler runNow', () => {
  it('kicks an immediate first pass and reports already-running on a second call while draining', async () => {
    const db = freshDb();
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
    try {
      const first = await ctl.runNow();
      expect(first.alreadyRunning).toBe(false);
      if (first.alreadyRunning) return;
      expect(first.deletedIds).toHaveLength(1);
      expect(first.remaining).toBe(1);
      const second = await ctl.runNow();
      expect(second.alreadyRunning).toBe(true);
      expect(ctl.isRunning()).toBe(true);
    } finally {
      ctl.stop();
      expect(ctl.isRunning()).toBe(false);
    }
  });
});

describe('startRetentionScheduler boot', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits for the nightly hour even with candidates present at boot', async () => {
    vi.useFakeTimers();
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'old' });
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 100 * DAY, c.id);
    const ctl = startRetentionScheduler(db, { getRetentionDays: () => 90, now: () => NOW });
    try {
      const untilNightly = msUntilNextRetentionHour(NOW);
      // Well past the old 5-minute boot pass.
      await vi.advanceTimersByTimeAsync(untilNightly - 1);
      expect(getConversation(db, c.id)).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(getConversation(db, c.id)).toBeUndefined();
    } finally {
      ctl.stop();
    }
  });
});

describe('startRetentionScheduler afterPass', () => {
  it('runs afterPass once on the settled pass, not per chunk', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    for (let i = 0; i < 2; i++) {
      const c = createConversation(db, { projectId: p.id, title: `old-${i}` });
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - (100 + i) * DAY, c.id);
    }
    let calls = 0;
    const ctl = startRetentionScheduler(db, {
      getRetentionDays: () => 90,
      now: () => NOW,
      chunkDelayMs: 25,
      maxConversations: 1,
      afterPass: async () => { calls += 1; },
    });
    try {
      const first = await ctl.runNow();
      expect(first.alreadyRunning).toBe(false);
      expect(calls).toBe(0);
      await new Promise<void>((r) => setTimeout(r, 400));
      expect(calls).toBe(1);
    } finally {
      ctl.stop();
    }
  });

  it('runs afterPass when retention is disabled and still reschedules', async () => {
    const db = freshDb();
    let calls = 0;
    const ctl = startRetentionScheduler(db, {
      getRetentionDays: () => 0,
      now: () => NOW,
      afterPass: async () => { calls += 1; },
    });
    try {
      await ctl.runNow();
      expect(calls).toBe(1);
      expect(ctl.isRunning()).toBe(false);
      await ctl.runNow();
      expect(calls).toBe(2);
    } finally {
      ctl.stop();
      expect(ctl.isRunning()).toBe(false);
    }
  });

  it('logs afterPass rejection without breaking stop or isRunning', async () => {
    const db = freshDb();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctl = startRetentionScheduler(db, {
      getRetentionDays: () => 0,
      now: () => NOW,
      afterPass: async () => { throw new Error('prune boom'); },
    });
    try {
      await ctl.runNow();
      expect(spy).toHaveBeenCalledWith('[retention] afterPass failed:', expect.any(Error));
      expect(ctl.isRunning()).toBe(false);
      ctl.stop();
      expect(ctl.isRunning()).toBe(false);
    } finally {
      spy.mockRestore();
      ctl.stop();
    }
  });
});

describe('trimOldToolResults', () => {
  it('shortens only old, long tool_result content and leaves prose + FTS intact', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'c' });
    addSession(db, 's1', c.id);
    const ins = db.prepare('INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)');
    const big = 'x'.repeat(10_000);
    ins.run('old-big', 's1', 'tool_result', JSON.stringify({ toolUseId: 't1', content: big }), 'agent', 1, NOW - 40 * DAY);
    ins.run('old-small', 's1', 'tool_result', JSON.stringify({ toolUseId: 't2', content: 'ok' }), 'agent', 2, NOW - 40 * DAY);
    ins.run('new-big', 's1', 'tool_result', JSON.stringify({ toolUseId: 't3', content: big }), 'agent', 3, NOW - 1 * DAY);
    ins.run('old-msg', 's1', 'message', JSON.stringify({ chunk: `zebrafish ${big}` }), 'agent', 4, NOW - 40 * DAY);

    const r = await trimOldToolResults(db, 30, NOW);
    expect(r.rows).toBe(1);
    expect(r.bytes).toBeGreaterThan(7_000);

    const content = (id: string) => (JSON.parse((db.prepare('SELECT payload FROM events WHERE id = ?').get(id) as { payload: string }).payload) as { content?: string; toolUseId?: string });
    const trimmed = content('old-big');
    expect(trimmed.toolUseId).toBe('t1');
    expect(trimmed.content!.startsWith('x'.repeat(TOOL_RESULT_KEEP_CHARS) + '\n… [8000 more chars trimmed')).toBe(true);
    expect(content('old-small').content).toBe('ok');
    expect(content('new-big').content).toBe(big);
    expect((db.prepare("SELECT count(*) n FROM event_fts WHERE event_fts MATCH 'zebrafish'").get() as { n: number }).n).toBe(1);

    // Idempotent.
    expect((await trimOldToolResults(db, 30, NOW)).rows).toBe(0);
    // Off.
    expect((await trimOldToolResults(db, 0, NOW)).rows).toBe(0);
  });

  it('runRetentionPurge trims and VACUUMs even with retention off', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'c' });
    addSession(db, 's1', c.id);
    db.prepare('INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)')
      .run('e', 's1', 'tool_result', JSON.stringify({ toolUseId: 't', content: 'y'.repeat(5000) }), 'agent', 1, NOW - 40 * DAY);
    const vacuum = vi.fn();
    const res = await runRetentionPurge({ db, retentionDays: 0, toolResultTrimDays: 30, now: NOW, vacuum, getFreeBytes: () => Infinity });
    expect(res.toolResultsTrimmed).toBe(1);
    expect(res.deletedIds).toEqual([]);
    expect(vacuum).toHaveBeenCalledOnce();
  });
});
