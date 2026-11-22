import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, deleteProject } from './projects.js';
import {
  createConversation,
  getConversation,
  deleteConversation,
  moveConversationTree,
  forkConversation,
  duplicateConversation,
  setConversationPendingHandoffMode,
  clearConversationPendingHandoffMode,
  setConversationsChangedListener,
  noteConversationsChanged,
} from './conversations.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function flushChanged() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('noteConversationsChanged', () => {
  afterEach(async () => {
    setConversationsChangedListener(null);
    await flushChanged();
  });

  it('coalesces create + cascade-delete in the same tick into one listener call', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    const calls: Array<{ projectIds: string[]; createdIds?: string[]; deletedIds?: string[] }> = [];
    setConversationsChangedListener((c) => { calls.push(c); });

    const a = createConversation(db, { projectId: p.id, title: 'a' });
    const parent = createConversation(db, { projectId: p.id, title: 'parent' });
    const child = createConversation(db, { projectId: p.id, title: 'child', parentConversationId: parent.id });
    deleteConversation(db, parent.id);

    expect(calls).toHaveLength(0);
    await flushChanged();
    expect(calls).toHaveLength(1);
    expect(calls[0].projectIds).toEqual([p.id]);
    expect(calls[0].createdIds?.sort()).toEqual([a.id, parent.id, child.id].sort());
    expect(calls[0].deletedIds?.sort()).toEqual([parent.id, child.id].sort());
  });

  it('does not fire on delete of an unknown id', async () => {
    const listener = vi.fn();
    setConversationsChangedListener(listener);
    const db = freshDb();
    deleteConversation(db, 'no-such-id');
    await flushChanged();
    expect(listener).not.toHaveBeenCalled();
  });

  it('moveConversationTree emits both project ids and no created/deleted', async () => {
    const db = freshDb();
    const from = createProject(db, { name: 'from', rootPath: '/tmp/from' });
    const to = createProject(db, { name: 'to', rootPath: '/tmp/to' });
    const c = createConversation(db, { projectId: from.id, title: 'root' });
    await flushChanged(); // drain the create
    const calls: Array<{ projectIds: string[]; createdIds?: string[]; deletedIds?: string[] }> = [];
    setConversationsChangedListener((x) => { calls.push(x); });

    moveConversationTree(db, c.id, to.id);
    await flushChanged();
    expect(calls).toHaveLength(1);
    expect(calls[0].projectIds.sort()).toEqual([from.id, to.id].sort());
    expect(calls[0].createdIds).toBeUndefined();
    expect(calls[0].deletedIds).toBeUndefined();
  });

  it('deleteProject emits deleted conversation ids', async () => {
    const db = freshDb();
    const p = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    const c = createConversation(db, { projectId: p.id, title: 'c' });
    await flushChanged();
    const listener = vi.fn();
    setConversationsChangedListener(listener);
    deleteProject(db, p.id);
    await flushChanged();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual({
      projectIds: [p.id],
      deletedIds: [c.id],
    });
  });

  it('swallows listener errors so callers never throw', async () => {
    setConversationsChangedListener(() => { throw new Error('boom'); });
    expect(() => noteConversationsChanged(['p1'], { created: ['c1'] })).not.toThrow();
    await flushChanged();
  });
});

describe('pending_handoff_mode', () => {
  afterEach(async () => {
    setConversationsChangedListener(null);
    await flushChanged();
  });

  it('round-trips fresh/summary, rejects invalid, clear is idempotent, and does not bump updated_at', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'p', rootPath: '/tmp' });
    const c = createConversation(db, { projectId: p.id, title: 'c' });
    const originalUpdated = c.updatedAt;

    const set = setConversationPendingHandoffMode(db, c.id, 'fresh');
    expect(set?.pendingHandoffMode).toBe('fresh');
    expect(getConversation(db, c.id)?.pendingHandoffMode).toBe('fresh');
    expect(getConversation(db, c.id)?.updatedAt).toBe(originalUpdated);

    setConversationPendingHandoffMode(db, c.id, 'summary');
    expect(getConversation(db, c.id)?.pendingHandoffMode).toBe('summary');

    expect(() => setConversationPendingHandoffMode(db, c.id, 'transcript' as 'fresh')).toThrow(
      /invalid pending_handoff_mode/,
    );

    expect(clearConversationPendingHandoffMode(db, c.id)).toBe(true);
    expect(getConversation(db, c.id)?.pendingHandoffMode).toBeUndefined();
    expect(clearConversationPendingHandoffMode(db, c.id)).toBe(false);
    expect(getConversation(db, c.id)?.updatedAt).toBe(originalUpdated);
  });

  it('forkConversation and duplicateConversation do not copy pendingHandoffMode', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'p', rootPath: '/tmp' });
    const src = createConversation(db, { projectId: p.id, title: 'src' });
    setConversationPendingHandoffMode(db, src.id, 'fresh');

    const dup = duplicateConversation(db, src.id);
    expect(dup.pendingHandoffMode).toBeUndefined();

    db.prepare("INSERT INTO sessions (id, conversation_id, agent_id, created_at, updated_at) VALUES ('s1', ?, NULL, 0, 0)").run(src.id);
    db.prepare("INSERT INTO events (id, session_id, type, payload, sender, seq, ts) VALUES ('e1', 's1', 'prompt', '{}', 'user', 1, 100)").run();
    const fork = forkConversation(db, src.id, 'e1');
    expect(fork.pendingHandoffMode).toBeUndefined();
  });
});
