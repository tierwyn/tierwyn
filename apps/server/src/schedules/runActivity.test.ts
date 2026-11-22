import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, setDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent } from '../repositories/events.js';
import { createSpawnEdge, resolveSpawnEdge } from '../repositories/spawnEdges.js';
import {
  isScheduleRunStalled,
  lastTickActivityMs,
  scheduleTickActivityConversationIds,
} from './runActivity.js';

let db: Database;
let projectId: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  setDb(db);
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
});

describe('isScheduleRunStalled', () => {
  it('is stalled when idle longer than runTimeoutMs from fire', () => {
    expect(isScheduleRunStalled({
      now: 100_000,
      firedAt: 0,
      runTimeoutMs: 60_000,
      lastActivityMs: 0,
    })).toBe(true);
  });

  it('is not stalled when still within the idle budget from fire', () => {
    expect(isScheduleRunStalled({
      now: 30_000,
      firedAt: 0,
      runTimeoutMs: 60_000,
      lastActivityMs: 0,
    })).toBe(false);
  });

  it('resets the idle clock when lastActivity is recent (long multi-spawn wave)', () => {
    // Fired 2h ago, but child activity 10s ago with a 30m budget → not stalled.
    expect(isScheduleRunStalled({
      now: 7_200_000 + 10_000,
      firedAt: 0,
      runTimeoutMs: 1_800_000,
      lastActivityMs: 7_200_000,
    })).toBe(false);
  });

  it('stalls when last activity itself is older than the budget', () => {
    expect(isScheduleRunStalled({
      now: 7_200_000 + 1_800_000 + 1,
      firedAt: 0,
      runTimeoutMs: 1_800_000,
      lastActivityMs: 7_200_000,
    })).toBe(true);
  });
});

describe('lastTickActivityMs + open notify children', () => {
  it('falls back when the tick has no events', () => {
    const tick = createConversation(db, { projectId, title: 'tick' });
    expect(lastTickActivityMs(db, tick.id, 42)).toBe(42);
  });

  it('uses the tick conversation event timestamps', () => {
    const tick = createConversation(db, { projectId, title: 'tick' });
    createSession(db, { id: 's1', conversationId: tick.id });
    appendEvent(db, {
      sessionId: 's1', type: 'status', ts: 1_000,
      seq: 1, sender: 'agent', payload: { status: 'running' },
    });
    appendEvent(db, {
      sessionId: 's1', type: 'status', ts: 5_000,
      seq: 2, sender: 'agent', payload: { status: 'done' },
    });
    expect(lastTickActivityMs(db, tick.id, 0)).toBe(5_000);
  });

  it('includes open notifyParent child activity (not closed / non-notify edges)', () => {
    const tick = createConversation(db, { projectId, title: 'tick' });
    const childNotify = createConversation(db, {
      projectId, title: 'child-notify', parentConversationId: tick.id,
    });
    const childSilent = createConversation(db, {
      projectId, title: 'child-silent', parentConversationId: tick.id,
    });
    const childClosed = createConversation(db, {
      projectId, title: 'child-closed', parentConversationId: tick.id,
    });

    createSpawnEdge(db, {
      parentConversationId: tick.id,
      childConversationId: childNotify.id,
      role: 'impl',
      notifyParent: true,
    });
    createSpawnEdge(db, {
      parentConversationId: tick.id,
      childConversationId: childSilent.id,
      role: 'impl',
      notifyParent: false,
    });
    const closed = createSpawnEdge(db, {
      parentConversationId: tick.id,
      childConversationId: childClosed.id,
      role: 'impl',
      notifyParent: true,
    });
    resolveSpawnEdge(db, closed.id, 'resolved', 'success');

    const ids = scheduleTickActivityConversationIds(db, tick.id);
    expect(ids).toContain(tick.id);
    expect(ids).toContain(childNotify.id);
    expect(ids).not.toContain(childSilent.id);
    expect(ids).not.toContain(childClosed.id);

    createSession(db, { id: 'sc', conversationId: childNotify.id });
    appendEvent(db, {
      sessionId: 'sc', type: 'message', ts: 99_000,
      seq: 1, sender: 'agent', payload: { chunk: 'still working' },
    });

    // Tick itself has no events; child activity should lift lastActivity.
    expect(lastTickActivityMs(db, tick.id, 1)).toBe(99_000);
  });
});
