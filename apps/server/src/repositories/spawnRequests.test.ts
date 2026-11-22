import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import type { Database } from 'better-sqlite3';
import {
  createSpawnRequest, getSpawnRequest, listPendingForConversation, listAllPending,
  approveSpawnRequest, denySpawnRequest, attachChild,
  expirePendingForSession, expireStale,
} from './spawnRequests.js';

let db: Database;
let parentConversationId: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  const conv = createConversation(db, { projectId: project.id, title: 'root' });
  parentConversationId = conv.id;
});

function makeRequest(overrides: Partial<Parameters<typeof createSpawnRequest>[1]> = {}) {
  return createSpawnRequest(db, {
    parentConversationId,
    parentSessionId: 'sess-1',
    prompt: 'do the thing',
    wait: false,
    notifyParent: false,
    ...overrides,
  });
}

describe('createSpawnRequest / getSpawnRequest roundtrip', () => {
  it('inserts and reads back all fields', () => {
    const row = makeRequest({ role: 'tester', profileId: 'claude-code:sonnet-4.6', workdir: 'worktree', wait: true, notifyParent: true });
    expect(row.status).toBe('pending');
    expect(row.role).toBe('tester');
    expect(row.profileId).toBe('claude-code:sonnet-4.6');
    expect(row.workdir).toBe('worktree');
    expect(row.wait).toBe(true);
    expect(row.notifyParent).toBe(true);
    expect(row.parentConversationId).toBe(parentConversationId);
    expect(row.parentSessionId).toBe('sess-1');
    expect(row.createdAt).toBeGreaterThan(0);
    const fetched = getSpawnRequest(db, row.id);
    expect(fetched).toEqual(row);
  });

  it('returns undefined for unknown id', () => {
    expect(getSpawnRequest(db, 'nope')).toBeUndefined();
  });
});

describe('approveSpawnRequest idempotency', () => {
  it('first approve returns true, second returns false', () => {
    const row = makeRequest();
    expect(approveSpawnRequest(db, row.id)).toBe(true);
    const after = getSpawnRequest(db, row.id)!;
    expect(after.status).toBe('approved');
    expect(after.decidedAt).toBeGreaterThan(0);
    // Second attempt: already approved, not pending → 0 changes
    expect(approveSpawnRequest(db, row.id)).toBe(false);
  });
});

describe('denySpawnRequest idempotency', () => {
  it('first deny returns true, second returns false', () => {
    const row = makeRequest();
    expect(denySpawnRequest(db, row.id, 'nope')).toBe(true);
    const after = getSpawnRequest(db, row.id)!;
    expect(after.status).toBe('denied');
    expect(after.error).toBe('nope');
    // Second attempt
    expect(denySpawnRequest(db, row.id)).toBe(false);
  });

  it('deny after approve → false (approve already won)', () => {
    const row = makeRequest();
    expect(approveSpawnRequest(db, row.id)).toBe(true);
    expect(denySpawnRequest(db, row.id)).toBe(false);
    expect(getSpawnRequest(db, row.id)!.status).toBe('approved');
  });

  it('approve after deny → false (deny already won)', () => {
    const row = makeRequest();
    expect(denySpawnRequest(db, row.id, 'no')).toBe(true);
    expect(approveSpawnRequest(db, row.id)).toBe(false);
    expect(getSpawnRequest(db, row.id)!.status).toBe('denied');
  });
});

describe('attachChild', () => {
  it('sets child_conversation_id and status=dispatched', () => {
    const row = makeRequest();
    approveSpawnRequest(db, row.id);
    attachChild(db, row.id, 'child-conv-123');
    const after = getSpawnRequest(db, row.id)!;
    expect(after.childConversationId).toBe('child-conv-123');
    expect(after.status).toBe('dispatched');
  });
});

describe('expirePendingForSession', () => {
  it('flips pending rows for matching session to expired; leaves others', () => {
    const r1 = makeRequest({ parentSessionId: 'sess-A' });
    const r2 = makeRequest({ parentSessionId: 'sess-A' });
    const r3 = makeRequest({ parentSessionId: 'sess-B' });

    const expired = expirePendingForSession(db, 'sess-A');
    expect(expired.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    expect(getSpawnRequest(db, r1.id)!.status).toBe('expired');
    expect(getSpawnRequest(db, r2.id)!.status).toBe('expired');
    // sess-B row untouched
    expect(getSpawnRequest(db, r3.id)!.status).toBe('pending');
  });

  it('returns empty array when no pending rows for session', () => {
    const expired = expirePendingForSession(db, 'sess-nobody');
    expect(expired).toEqual([]);
  });

  it('does not touch already-decided rows for the session', () => {
    const r = makeRequest({ parentSessionId: 'sess-C' });
    approveSpawnRequest(db, r.id);
    const expired = expirePendingForSession(db, 'sess-C');
    expect(expired).toEqual([]);
    expect(getSpawnRequest(db, r.id)!.status).toBe('approved');
  });
});

describe('expireStale TTL', () => {
  it('flips only rows older than TTL to expired', () => {
    const old = makeRequest();
    // Back-date created_at to be older than TTL
    db.prepare('UPDATE spawn_requests SET created_at = ? WHERE id = ?')
      .run(Date.now() - 31 * 60_000, old.id);
    const fresh = makeRequest();

    const expired = expireStale(db, 30 * 60_000);
    expect(expired.map((r) => r.id)).toContain(old.id);
    expect(expired.map((r) => r.id)).not.toContain(fresh.id);
    expect(getSpawnRequest(db, old.id)!.status).toBe('expired');
    expect(getSpawnRequest(db, fresh.id)!.status).toBe('pending');
  });

  it('returns empty when nothing is stale', () => {
    makeRequest(); // recent row
    expect(expireStale(db, 30 * 60_000)).toEqual([]);
  });
});

describe('listPendingForConversation', () => {
  it('returns pending rows for the given conversation only', () => {
    const r1 = makeRequest({ parentSessionId: 'sess-1' });
    const r2 = makeRequest({ parentSessionId: 'sess-2' });
    // Add a conversation for another parent
    const otherConv = createConversation(db, { projectId: createProject(db, { name: 'p2', rootPath: '/tmp2' }).id, title: 'other' });
    createSpawnRequest(db, { parentConversationId: otherConv.id, parentSessionId: 'sess-3', prompt: 'other', wait: false, notifyParent: false });

    const list = listPendingForConversation(db, parentConversationId);
    expect(list.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    // Deny one; list should show only the remaining pending
    denySpawnRequest(db, r1.id);
    const list2 = listPendingForConversation(db, parentConversationId);
    expect(list2.map((r) => r.id)).toEqual([r2.id]);
  });
});
