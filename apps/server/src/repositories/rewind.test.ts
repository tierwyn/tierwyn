import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import { appendEvent } from './events.js';
import { getSession } from './sessions.js';
import { insertSummary } from './summaries.js';
import { insertHandoff } from './handoffs.js';
import { createCheckpoint } from './checkpoints.js';
import { nativeTurnIndex, rewindConversationToEvent } from './rewind.js';
import type { AgentAdapter } from '@tierwyn/shared';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function seedConversation(db: Db) {
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  return { project: p, conversation: c };
}

function insertSession(db: Db, conversationId: string, opts: {
  id: string; agentId?: string; nativeSessionId?: string; createdAt: number;
}) {
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(opts.id, conversationId, opts.agentId ?? null, opts.nativeSessionId ?? null, opts.createdAt, opts.createdAt);
}

describe('nativeTurnIndex', () => {
  it('counts prompt and steer events ordered by (ts, seq)', () => {
    const db = freshDb();
    const { conversation } = seedConversation(db);
    insertSession(db, conversation.id, { id: 's1', createdAt: 1 });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'a' }, sender: 'user', ts: 100, seq: 0 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'r' }, sender: 'agent', ts: 110, seq: 1 });
    const steer = appendEvent(db, { sessionId: 's1', type: 'steer', payload: { text: 's' }, sender: 'user', ts: 120, seq: 0 });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'b' }, sender: 'user', ts: 130, seq: 0 });

    expect(nativeTurnIndex(db, steer.id)).toBe(2);
  });

  it('uses lexicographic (ts, seq) when multiple events share ts', () => {
    const db = freshDb();
    const { conversation } = seedConversation(db);
    insertSession(db, conversation.id, { id: 's1', createdAt: 1 });
    const p1 = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'a' }, sender: 'user', ts: 100, seq: 0 });
    const p2 = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'b' }, sender: 'user', ts: 100, seq: 1 });
    expect(nativeTurnIndex(db, p1.id)).toBe(1);
    expect(nativeTurnIndex(db, p2.id)).toBe(2);
  });
});

describe('rewindConversationToEvent truncation', () => {
  it('drops events after anchor and cleans summaries, handoffs, checkpoints', async () => {
    const db = freshDb();
    const { conversation } = seedConversation(db);
    insertSession(db, conversation.id, { id: 's1', createdAt: 10 });
    const e1 = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'a' }, sender: 'user', ts: 100, seq: 0 });
    const e2 = appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'r' }, sender: 'agent', ts: 110, seq: 1 });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'b' }, sender: 'user', ts: 200, seq: 0 });

    insertSummary(db, { conversation_id: conversation.id, last_event_id: e2.id, summary_text: 'ok' });
    insertHandoff(db, {
      conversation_id: conversation.id,
      from_profile_id: 'a:1', to_profile_id: 'b:1',
      requested_mode: 'summary', resolved_mode: 'compacted',
      anchor_event_id: e2.id, summary_id: null, priming_context: null,
    });
    createCheckpoint(db, {
      conversationId: conversation.id, eventId: e2.id, sessionId: 's1', kind: 'auto',
    });
    const e3 = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'c' }, sender: 'user', ts: 300, seq: 0 });
    createCheckpoint(db, {
      conversationId: conversation.id, eventId: e3.id, sessionId: 's1', kind: 'auto',
    });

    const noopAdapter = () => ({}) as AgentAdapter;
    await rewindConversationToEvent(db, noopAdapter, {
      conversationId: conversation.id,
      eventId: e2.id,
      mode: 'rewind',
      createCheckpoint: false,
    });

    const events = db.prepare('SELECT id FROM events').all() as { id: string }[];
    expect(events.map((e) => e.id).sort()).toEqual([e1.id, e2.id].sort());
    expect((db.prepare('SELECT COUNT(*) n FROM summaries').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM handoffs').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM checkpoints WHERE event_id = ?').get('deleted-event') as { n: number } | undefined)?.n ?? 0).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM checkpoints WHERE event_id = ?').get(e3.id) as { n: number } | undefined)?.n ?? 0).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM checkpoints WHERE event_id = ?').get(e2.id) as { n: number }).n).toBe(1);
  });

  // v1 message-delete → native-session sync anchor mapping.
  // The rewind machinery truncates STRICTLY AFTER the anchor (ts > anchor), so
  // the anchor MUST be the last surviving event of the PREVIOUS turn. Passing
  // the deleted turn's own prompt would keep that turn alive in the DB —
  // contradicting the transcript-only delete path which removes it. This test
  // pins the off-by-one so a future "simplification" cannot silently regress.
  it('v1 anchor off-by-one: anchoring the previous turn last event drops the selected turn', async () => {
    const db = freshDb();
    const { conversation } = seedConversation(db);
    insertSession(db, conversation.id, { id: 's1', createdAt: 10 });
    // Turn 1: prompt + reply
    const t1Prompt = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'turn1' }, sender: 'user', ts: 100, seq: 0 });
    const t1Reply = appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'r1' }, sender: 'agent', ts: 110, seq: 1 });
    // Turn 2: prompt + reply (the turn the user is deleting)
    const t2Prompt = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'turn2' }, sender: 'user', ts: 200, seq: 0 });
    const t2Reply = appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'r2' }, sender: 'agent', ts: 210, seq: 1 });
    // Turn 3 (also swept by the trailing-suffix delete)
    const t3Prompt = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'turn3' }, sender: 'user', ts: 300, seq: 0 });

    // The UI computes: anchor = last surviving event of turns[deleteTurnIndex - 1]
    //                  = t1Reply.id (NOT t2Prompt.id).
    const noopAdapter = () => ({}) as AgentAdapter;
    await rewindConversationToEvent(db, noopAdapter, {
      conversationId: conversation.id,
      eventId: t1Reply.id, // CORRECT anchor — end of the previous turn
      mode: 'rewind',
      createCheckpoint: false,
    });

    const survivors = (db.prepare('SELECT id FROM events').all() as { id: string }[]).map((r) => r.id);
    expect(new Set(survivors)).toEqual(new Set([t1Prompt.id, t1Reply.id]));
    // The deleted turn's prompt and everything after MUST be gone.
    expect(survivors).not.toContain(t2Prompt.id);
    expect(survivors).not.toContain(t2Reply.id);
    expect(survivors).not.toContain(t3Prompt.id);
  });

  it('v1 anchor off-by-one: anchoring the deleted turn own prompt KEEPS it (regression guard)', async () => {
    const db = freshDb();
    const { conversation } = seedConversation(db);
    insertSession(db, conversation.id, { id: 's1', createdAt: 10 });
    const t1Prompt = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'turn1' }, sender: 'user', ts: 100, seq: 0 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'r1' }, sender: 'agent', ts: 110, seq: 1 });
    const t2Prompt = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'turn2' }, sender: 'user', ts: 200, seq: 0 });

    // WRONG anchor (what a naive implementation would pass): the deleted turn's prompt.
    const noopAdapter = () => ({}) as AgentAdapter;
    await rewindConversationToEvent(db, noopAdapter, {
      conversationId: conversation.id,
      eventId: t2Prompt.id,
      mode: 'rewind',
      createCheckpoint: false,
    });

    // This is the bug: t2Prompt SURVIVES because truncation is strictly-after-anchor.
    // The test documents WHY the UI must not pass the selected turn's prompt.
    const survivors = (db.prepare('SELECT id FROM events').all() as { id: string }[]).map((r) => r.id);
    expect(survivors).toContain(t2Prompt.id);
    expect(survivors).toContain(t1Prompt.id);
  });
});

describe('rewindConversationToEvent A→B→A', () => {
  it('drops later sessions and repoints anchor native id', async () => {
    const db = freshDb();
    const { conversation } = seedConversation(db);
    insertSession(db, conversation.id, { id: 'sA1', nativeSessionId: 'native-A1', createdAt: 10 });
    insertSession(db, conversation.id, { id: 'sB', nativeSessionId: 'native-B', createdAt: 20 });
    insertSession(db, conversation.id, { id: 'sA2', nativeSessionId: 'native-A2', createdAt: 30 });

    const eA1 = appendEvent(db, { sessionId: 'sA1', type: 'prompt', payload: { text: 'a' }, sender: 'user', ts: 100, seq: 0 });
    appendEvent(db, { sessionId: 'sA1', type: 'message', payload: { chunk: 'r' }, sender: 'agent', ts: 110, seq: 1 });
    appendEvent(db, { sessionId: 'sB', type: 'prompt', payload: { text: 'b' }, sender: 'user', ts: 200, seq: 0 });
    appendEvent(db, { sessionId: 'sA2', type: 'prompt', payload: { text: 'c' }, sender: 'user', ts: 300, seq: 0 });

    const mockAdapter: AgentAdapter = {
      start: async () => {},
      sendPrompt: async () => {},
      streamEvents: () => { throw new Error('n/a'); },
      stop: async () => {},
      listSessions: async () => [],
      loadSession: async () => {},
      listModels: async () => [],
      isNativeSessionAvailable: async () => true,
      rewindNativeSession: async () => 'native-forked',
    };

    db.prepare('INSERT OR IGNORE INTO agents (id, type, label, description, created_at) VALUES (?,?,?,?,?)')
      .run('claude-code', 'claude-code', 'Claude', '', Date.now());
    db.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run('claude-code', 'sA1');

    await rewindConversationToEvent(db, () => mockAdapter, {
      conversationId: conversation.id,
      eventId: eA1.id,
      mode: 'rewind',
      createCheckpoint: false,
    });

    const sessions = db.prepare('SELECT id FROM sessions WHERE conversation_id = ?').all(conversation.id) as { id: string }[];
    expect(sessions.map((s) => s.id)).toEqual(['sA1']);
    expect(getSession(db, 'sA1')?.nativeSessionId).toBe('native-forked');
  });
});

describe('rewindConversationToEvent degradation', () => {
  it('nulls native id and sets nativeDrift when fork unavailable', async () => {
    const db = freshDb();
    const { conversation } = seedConversation(db);
    insertSession(db, conversation.id, { id: 's1', nativeSessionId: 'native-1', createdAt: 10 });
    const e1 = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'a' }, sender: 'user', ts: 100, seq: 0 });
    db.prepare('INSERT OR IGNORE INTO agents (id, type, label, description, created_at) VALUES (?,?,?,?,?)')
      .run('claude-code', 'claude-code', 'Claude', '', Date.now());
    db.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run('claude-code', 's1');

    const mockAdapter: AgentAdapter = {
      start: async () => {},
      sendPrompt: async () => {},
      streamEvents: () => { throw new Error('n/a'); },
      stop: async () => {},
      listSessions: async () => [],
      loadSession: async () => {},
      listModels: async () => [],
      isNativeSessionAvailable: async () => false,
    };

    const result = await rewindConversationToEvent(db, () => mockAdapter, {
      conversationId: conversation.id,
      eventId: e1.id,
      mode: 'rewind',
      createCheckpoint: false,
    });

    expect(result.nativeDrift).toBe(true);
    expect(getSession(db, 's1')?.nativeSessionId).toBeUndefined();
  });
});
