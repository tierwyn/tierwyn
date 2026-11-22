import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import { createSpawnEdge, getEdgeByChild, resolveSpawnEdge, incrementFollowup, listOpenEdges, listOpenEdgesForParent } from './spawnEdges.js';

let db: Database; let parent: string; let child: string;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  const p = createProject(db, { name: 'p', rootPath: '/tmp/p' });
  parent = createConversation(db, { projectId: p.id, title: 'l0' }).id;
  child = createConversation(db, { projectId: p.id, title: 'l1', parentConversationId: parent }).id;
});

describe('spawn_edges repository', () => {
  it('create → lookup by child → listed as open', () => {
    const e = createSpawnEdge(db, { parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: false });
    expect(getEdgeByChild(db, child)!.id).toBe(e.id);
    expect(getEdgeByChild(db, child)!.notifyParent).toBe(false);
    expect(listOpenEdges(db).map((x) => x.id)).toContain(e.id);
  });

  it('CAS resolve: first caller wins, second loses, status sticks', () => {
    const e = createSpawnEdge(db, { parentConversationId: parent, childConversationId: child, notifyParent: true });
    expect(resolveSpawnEdge(db, e.id, 'resolved', 'success')).toBe(true);
    expect(resolveSpawnEdge(db, e.id, 'stalled', 'stalled')).toBe(false);   // 🔒 concern 7: exactly-once
    expect(getEdgeByChild(db, child)!.status).toBe('resolved');
    expect(listOpenEdges(db)).toHaveLength(0);
  });

  it('followup_count increments without touching status', () => {
    const e = createSpawnEdge(db, { parentConversationId: parent, childConversationId: child, notifyParent: true });
    resolveSpawnEdge(db, e.id, 'resolved', 'success');
    incrementFollowup(db, e.id);
    incrementFollowup(db, e.id);
    const row = getEdgeByChild(db, child)!;
    expect(row.followupCount).toBe(2);
    expect(row.status).toBe('resolved');
  });

  it('listOpenEdgesForParent filters by parent', () => {
    const p = createProject(db, { name: 'p2', rootPath: '/tmp/p2' });
    const otherParent = createConversation(db, { projectId: p.id, title: 'other' }).id;
    const otherChild = createConversation(db, { projectId: p.id, title: 'oc', parentConversationId: otherParent }).id;
    createSpawnEdge(db, { parentConversationId: parent, childConversationId: child, notifyParent: true });
    createSpawnEdge(db, { parentConversationId: otherParent, childConversationId: otherChild, notifyParent: true });
    const forParent = listOpenEdgesForParent(db, parent);
    expect(forParent).toHaveLength(1);
    expect(forParent[0].childConversationId).toBe(child);
  });

  it('[S3-7] outcome is part of the resolution contract and persists on the row', () => {
    const e = createSpawnEdge(db, { parentConversationId: parent, childConversationId: child, notifyParent: true });
    expect(getEdgeByChild(db, child)!.outcome).toBeNull();
    expect(resolveSpawnEdge(db, e.id, 'resolved', 'failed')).toBe(true);
    expect(getEdgeByChild(db, child)!.outcome).toBe('failed');
    expect(getEdgeByChild(db, child)!.status).toBe('resolved');

    // The parameter is REQUIRED at the type level: a caller cannot resolve an
    // edge into an uninterpretable NULL outcome, whatever the status.
    const p = createProject(db, { name: 'p3', rootPath: '/tmp/p3' });
    const parent2 = createConversation(db, { projectId: p.id, title: 'p2' }).id;
    const child2 = createConversation(db, { projectId: p.id, title: 'c2', parentConversationId: parent2 }).id;
    const stalledEdge = createSpawnEdge(db, { parentConversationId: parent2, childConversationId: child2, notifyParent: true });
    expect(resolveSpawnEdge(db, stalledEdge.id, 'stalled', 'stalled')).toBe(true);
    expect(getEdgeByChild(db, child2)!.outcome).toBe('stalled');
  });
});
