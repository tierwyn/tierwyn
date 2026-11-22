import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue } from '../db/seed.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import { createSession } from './sessions.js';
import { appendEvent, listEventsForSession, listEventsForConversation, deleteTurnEventsByIds, latestPromptTextForConversation, lastAssistantText } from './events.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  createSession(db, { id: 's1', conversationId: c.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
  return { db, conversationId: c.id };
}

describe('events repository', () => {
  it('appends and lists events for a session in ts order', () => {
    const { db } = setup();
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'hi' }, sender: 'user', ts: 1, seq: 0 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'hello', final: true }, sender: 'agent', agentModelId: 'claude-code:opus-4.8', ts: 2, seq: 1 });

    const rows = listEventsForSession(db, 's1');
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('prompt');
    expect(rows[0].sender).toBe('user');
    expect(rows[1].payload).toEqual({ chunk: 'hello', final: true });
    expect(rows[1].agentProfileId).toBe('claude-code:opus-4.8');
  });

  it('lists events across all sessions in a conversation', () => {
    const { db, conversationId } = setup();
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'x', final: true }, sender: 'agent', ts: 5, seq: 0 });
    expect(listEventsForConversation(db, conversationId)).toHaveLength(1);
  });

  it('deleteTurnEventsByIds removes exactly the supplied ids and returns the count', () => {
    const { db } = setup();
    const a = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'a' }, sender: 'user', ts: 1, seq: 0 });
    const b = appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'a-r' }, sender: 'agent', ts: 2, seq: 0 });
    const c = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'c' }, sender: 'user', ts: 3, seq: 0 });
    const d = appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'c-r' }, sender: 'agent', ts: 4, seq: 0 });

    // Delete turn 1 (a + b); turn 2 (c + d) must survive.
    const deleted = deleteTurnEventsByIds(db, [a.id, b.id]);
    expect(deleted).toBe(2);
    const remaining = listEventsForSession(db, 's1');
    expect(remaining.map((r) => r.id)).toEqual([c.id, d.id]);
  });

  it('deleteTurnEventsByIds is a no-op for empty input', () => {
    const { db } = setup();
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'a' }, sender: 'user', ts: 1, seq: 0 });
    expect(deleteTurnEventsByIds(db, [])).toBe(0);
    expect(listEventsForSession(db, 's1')).toHaveLength(1);
  });

  it('deleteTurnEventsByIds silently skips unknown ids (no FK blow-up)', () => {
    const { db } = setup();
    const a = appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'a' }, sender: 'user', ts: 1, seq: 0 });
    // One real id + one bogus id; only the real one is deleted, count = 1.
    expect(deleteTurnEventsByIds(db, [a.id, 'never-existed'])).toBe(1);
  });
});

describe('latestPromptTextForConversation', () => {
  it('returns the newest prompt text, or null when there is none', () => {
    const { db, conversationId } = setup();
    expect(latestPromptTextForConversation(db, conversationId)).toBeNull();
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'first' }, sender: 'user', seq: 0, ts: 1 });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'second' }, sender: 'user', seq: 1, ts: 2 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'reply' }, sender: 'agent', seq: 2, ts: 3 });
    expect(latestPromptTextForConversation(db, conversationId)).toBe('second');
  });
});

describe('lastAssistantText', () => {
  it('prefers latest final message without spawnMarker', () => {
    const { db, conversationId } = setup();
    expect(lastAssistantText(db, conversationId)).toBeNull();
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'old final', final: true }, sender: 'agent', seq: 0, ts: 1 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'new final', final: true }, sender: 'agent', seq: 1, ts: 2 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'marker', final: true, spawnMarker: { kind: 'x' } }, sender: 'agent', seq: 2, ts: 3 });
    appendEvent(db, { sessionId: 's1', type: 'tool_result', payload: { content: 'tool noise' }, sender: 'agent', seq: 3, ts: 4 });
    expect(lastAssistantText(db, conversationId)).toBe('new final');
  });

  it('falls back to concatenated chunks when no final exists', () => {
    const { db, conversationId } = setup();
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'foo ' }, sender: 'agent', seq: 0, ts: 1 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'bar' }, sender: 'agent', seq: 1, ts: 2 });
    expect(lastAssistantText(db, conversationId)).toBe('foo bar');
  });
});
