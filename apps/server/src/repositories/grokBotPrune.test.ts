import { afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, ensureRemoteAgentsProject } from '../db/seed.js';
import { createProject } from './projects.js';
import {
  createConversation, getConversation, setConversationPinned, setConversationArchived,
} from './conversations.js';
import { createSession } from './sessions.js';
import { upsertDiscoveredModels } from './models.js';
import { createRemoteAgentConversation, retireRemoteAgentConversation } from './remoteAgents.js';
import { writeCursors, readCursors } from './grokBotWatch.js';
import { runGrokBotPruneSweep } from './grokBotPrune.js';

const BOT_A = '8c236467-9550-4bb2-bb9d-80938bc7e5f6';
const BOT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function setup(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  ensureRemoteAgentsProject(db);
  return db;
}

function pin(db: Db, botId: string): void {
  upsertDiscoveredModels(db, 'grok-bot', [{
    name: botId,
    label: `Grok Bot · ${botId}`,
    provider: 'xai',
    vision: false,
    steer: true,
  }]);
}

function watcherSession(db: Db, conversationId: string): string {
  const row = db.prepare(
    `SELECT id FROM sessions WHERE conversation_id = ? AND agent_id = 'grok-bot' ORDER BY created_at ASC LIMIT 1`,
  ).get(conversationId) as { id: string };
  return row.id;
}

function addEvents(
  db: Db,
  sessionId: string,
  count: number,
  opts?: { startTs?: number; idPrefix?: string; fts?: boolean },
): void {
  const startTs = opts?.startTs ?? 1_000;
  const prefix = opts?.idPrefix ?? 'e';
  const insert = db.prepare(
    'INSERT INTO events (id,session_id,type,payload,sender,seq,ts) VALUES (?,?,?,?,?,?,?)',
  );
  const tx = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      const payload = opts?.fts
        ? JSON.stringify({
            text: i === 0 ? `dropword${prefix}` : i === n - 1 ? `keepword${prefix}` : `midword${prefix}`,
          })
        : '{}';
      const type = opts?.fts ? 'prompt' : 'message';
      insert.run(`${prefix}-${i}`, sessionId, type, payload, opts?.fts ? 'user' : 'agent', i, startTs + i);
    }
  });
  tx(count);
}

function eventCount(db: Db, conversationId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.conversation_id = ?`,
  ).get(conversationId) as { n: number }).n;
}

function sessionCount(db: Db, conversationId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE conversation_id = ?',
  ).get(conversationId) as { n: number }).n;
}

function ftsCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM event_fts').get() as { n: number }).n;
}

function ftsMatch(db: Db, token: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM event_fts WHERE event_fts MATCH ?').get(token) as { n: number }).n;
}

let tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-prune-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

describe('truncateRemoteAgentTranscripts', () => {
  it('deletes nothing at the exact-N boundary', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 2000);
    const res = await runGrokBotPruneSweep(db, { eventLimit: 2000, retentionDays: 0 });
    expect(res.truncated).toEqual([]);
    expect(eventCount(db, id)).toBe(2000);
  });

  it('deletes exactly the oldest overflow event and keeps the newest N', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const sid = watcherSession(db, id);
    addEvents(db, sid, 2001);
    const updatedAt = getConversation(db, id)!.updatedAt;
    const res = await runGrokBotPruneSweep(db, { eventLimit: 2000, retentionDays: 0 });
    expect(res.truncated).toEqual([{ id, deleted: 1 }]);
    expect(eventCount(db, id)).toBe(2000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get('e-0')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get('e-2000')).toEqual({ n: 1 });
    expect(getConversation(db, id)?.updatedAt).toBe(updatedAt);
  });

  it('chunks a 12 000-event overflow down to 2000', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 12_000);
    const res = await runGrokBotPruneSweep(db, { eventLimit: 2000, retentionDays: 0 });
    expect(res.truncated).toEqual([{ id, deleted: 10_000 }]);
    expect(eventCount(db, id)).toBe(2000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get('e-0')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get('e-11999')).toEqual({ n: 1 });
  });

  it('limit 0 deletes nothing even with a large transcript', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 50_000);
    const res = await runGrokBotPruneSweep(db, { eventLimit: 0, retentionDays: 0 });
    expect(res.truncated).toEqual([]);
    expect(eventCount(db, id)).toBe(50_000);
  });

  it('keep-last-N spans two sessions and never deletes a sessions row', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const sid1 = watcherSession(db, id);
    db.prepare(
      `INSERT INTO agents (id, type, label, description, env_vars, created_at) VALUES (?,?,?,?,?,?)`,
    ).run('a1', 'a1', 'a1', '', '{}', Date.now());
    createSession(db, { id: 's2', conversationId: id, agentId: 'a1' });
    addEvents(db, sid1, 80, { idPrefix: 'a' });
    addEvents(db, 's2', 80, { idPrefix: 'b', startTs: 2_000 });
    expect(sessionCount(db, id)).toBe(2);
    const res = await runGrokBotPruneSweep(db, { eventLimit: 100, retentionDays: 0 });
    expect(res.truncated[0]?.deleted).toBe(60);
    expect(eventCount(db, id)).toBe(100);
    expect(sessionCount(db, id)).toBe(2);
  });

  it('skips a pinned container conversation', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 5000);
    setConversationPinned(db, id, true);
    const res = await runGrokBotPruneSweep(db, { eventLimit: 100, retentionDays: 0 });
    expect(res.skippedPinned).toEqual([id]);
    expect(res.truncated).toEqual([]);
    expect(eventCount(db, id)).toBe(5000);
  });

  it('skips a live container conversation', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 500);
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 100,
      retentionDays: 0,
      isLive: (cid) => cid === id,
    });
    expect(res.skippedLive).toEqual([id]);
    expect(res.truncated).toEqual([]);
    expect(eventCount(db, id)).toBe(500);
  });

  it('never touches a conversation in a normal project', async () => {
    const db = setup();
    pin(db, BOT_A);
    createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'Normal' });
    db.prepare(
      `INSERT INTO agents (id, type, label, description, env_vars, created_at) VALUES (?,?,?,?,?,?)`,
    ).run('a1', 'a1', 'a1', '', '{}', Date.now());
    createSession(db, { id: 'sn', conversationId: c.id, agentId: 'a1' });
    addEvents(db, 'sn', 10_000, { idPrefix: 'n' });
    await runGrokBotPruneSweep(db, { eventLimit: 100, retentionDays: 0 });
    expect(eventCount(db, c.id)).toBe(10_000);
  });

  it('does not truncate an archived container conversation', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 10_000);
    retireRemoteAgentConversation(db, id);
    const res = await runGrokBotPruneSweep(db, { eventLimit: 100, retentionDays: 0 });
    expect(res.truncated).toEqual([]);
    expect(eventCount(db, id)).toBe(10_000);
  });

  it('keeps event_fts in step with remaining indexed events', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 6000, { fts: true });
    expect(ftsCount(db)).toBe(6000);
    await runGrokBotPruneSweep(db, { eventLimit: 1000, retentionDays: 0 });
    expect(eventCount(db, id)).toBe(1000);
    expect(ftsCount(db)).toBe(1000);
    expect(ftsMatch(db, 'dropworde')).toBe(0);
    expect(ftsMatch(db, 'keepworde')).toBe(1);
  });

  it('does not bump conversations.updated_at', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 300);
    const before = db.prepare('SELECT updated_at AS u FROM conversations WHERE id = ?').get(id);
    await runGrokBotPruneSweep(db, { eventLimit: 100, retentionDays: 0 });
    const after = db.prepare('SELECT updated_at AS u FROM conversations WHERE id = ?').get(id);
    expect(after).toEqual(before);
  });

  it('leaves an in-flight event_fts_buffer row in place', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const sid = watcherSession(db, id);
    addEvents(db, sid, 300);
    db.prepare('INSERT INTO event_fts_buffer (session_id, body) VALUES (?, ?)').run(sid, 'inflight-tail');
    await runGrokBotPruneSweep(db, { eventLimit: 100, retentionDays: 0 });
    expect(sessionCount(db, id)).toBe(1);
    const buf = db.prepare('SELECT body FROM event_fts_buffer WHERE session_id = ?').get(sid) as { body: string };
    expect(buf.body).toBe('inflight-tail');
  });
});

describe('sweepStaleRemoteAgents', () => {
  it('archives then deletes a stale retired container conversation', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    addEvents(db, watcherSession(db, id), 3, { fts: true });
    retireRemoteAgentConversation(db, id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 40 * DAY, id);
    const dataDir = tmpDir();
    const file = join(dataDir, 'archive', `${id}.jsonl`);
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir, now: NOW,
    });
    expect(existsSync(file)).toBe(true);
    expect(getConversation(db, id)).toBeUndefined();
    expect(res.purgedIds).toEqual([id]);
  });

  it('removes the attachment shard dir after a successful purge', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    retireRemoteAgentConversation(db, id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 40 * DAY, id);
    const dataDir = tmpDir();
    const shard = join(dataDir, 'attachments', id, 'x.txt');
    mkdirSync(join(dataDir, 'attachments', id), { recursive: true });
    writeFileSync(shard, 'bytes');
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir, now: NOW,
    });
    expect(res.purgedIds).toEqual([id]);
    expect(existsSync(join(dataDir, 'attachments', id))).toBe(false);
  });

  it('leaves a recently-updated archived conversation alone', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    retireRemoteAgentConversation(db, id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 10 * DAY, id);
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir: tmpDir(), now: NOW,
    });
    expect(res.purgedIds).toEqual([]);
    expect(getConversation(db, id)).toBeDefined();
  });

  it('does not purge a non-archived container conversation, however old', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 400 * DAY, id);
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir: tmpDir(), now: NOW,
    });
    expect(res.purgedIds).toEqual([]);
    expect(getConversation(db, id)).toBeDefined();
  });

  it('retentionDays 0 disables the stale sweep', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    retireRemoteAgentConversation(db, id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 400 * DAY, id);
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 0, dataDir: tmpDir(), now: NOW,
    });
    expect(res.purgedIds).toEqual([]);
    expect(getConversation(db, id)).toBeDefined();
  });

  it('skips archived-and-pinned', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    retireRemoteAgentConversation(db, id);
    setConversationPinned(db, id, true);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 40 * DAY, id);
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir: tmpDir(), now: NOW,
    });
    expect(res.skippedPinned).toEqual([id]);
    expect(res.purgedIds).toEqual([]);
    expect(getConversation(db, id)).toBeDefined();
  });

  it('skips a live archived conversation', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    retireRemoteAgentConversation(db, id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 40 * DAY, id);
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir: tmpDir(), now: NOW,
      isLive: (cid) => cid === id,
    });
    expect(res.skippedLive).toEqual([id]);
    expect(res.purgedIds).toEqual([]);
    expect(getConversation(db, id)).toBeDefined();
  });

  it('keeps the conversation when the archive write fails', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    retireRemoteAgentConversation(db, id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 40 * DAY, id);
    const blocked = join(tmpDir(), 'not-a-dir');
    writeFileSync(blocked, 'nope');
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir: blocked, now: NOW,
    });
    expect(res.purgedIds).toEqual([]);
    expect(getConversation(db, id)).toBeDefined();
    expect(existsSync(join(blocked, 'archive', `${id}.jsonl`))).toBe(false);
  });

  it('never purges an archived conversation in a normal project', async () => {
    const db = setup();
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'User archive' });
    setConversationArchived(db, c.id, true);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 400 * DAY, c.id);
    const res = await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir: tmpDir(), now: NOW,
    });
    expect(res.purgedIds).toEqual([]);
    expect(getConversation(db, c.id)).toBeDefined();
  });

  it('clears the purged Bot cursor and leaves another Bot\'s cursor', async () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'A', provider: 'xai', vision: false, steer: true },
      { name: BOT_B, label: 'B', provider: 'xai', vision: false, steer: true },
    ]);
    const idA = createRemoteAgentConversation(db, BOT_A, 'A');
    createRemoteAgentConversation(db, BOT_B, 'B');
    retireRemoteAgentConversation(db, idA);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 40 * DAY, idA);
    writeCursors(db, {
      [BOT_A]: { entryId: 'ea', seq: 1, updatedAt: NOW },
      [BOT_B]: { entryId: 'eb', seq: 2, updatedAt: NOW },
    });
    await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir: tmpDir(), now: NOW,
    });
    const cursors = readCursors(db);
    expect(cursors[BOT_A]).toBeUndefined();
    expect(cursors[BOT_B]?.entryId).toBe('eb');
  });

  it('cascades sessions and event_fts when a stale container conversation is purged', async () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const sid = watcherSession(db, id);
    addEvents(db, sid, 5, { fts: true });
    expect(ftsCount(db)).toBe(5);
    retireRemoteAgentConversation(db, id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(NOW - 40 * DAY, id);
    await runGrokBotPruneSweep(db, {
      eventLimit: 0, retentionDays: 30, dataDir: tmpDir(), now: NOW,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE conversation_id = ?').get(id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(sid)).toEqual({ n: 0 });
    expect(ftsCount(db)).toBe(0);
  });
});
