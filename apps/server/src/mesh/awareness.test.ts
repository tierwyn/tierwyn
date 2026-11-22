import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSpawnEdge } from '../repositories/spawnEdges.js';
import { listNeighbourhood, projectAwareness } from './awareness.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const root = createConversation(db, { projectId: p.id, title: 'root-title-secret' });
  const a = createConversation(db, { projectId: p.id, title: 'child-a-title', parentConversationId: root.id });
  const b = createConversation(db, { projectId: p.id, title: 'child-b-title', parentConversationId: root.id });
  const g = createConversation(db, { projectId: p.id, title: 'grandchild', parentConversationId: a.id });
  createSpawnEdge(db, { parentConversationId: root.id, childConversationId: a.id, role: 'impl<script>', notifyParent: false });
  createSpawnEdge(db, { parentConversationId: root.id, childConversationId: b.id, role: 'reviewer', notifyParent: false });
  createSpawnEdge(db, { parentConversationId: a.id, childConversationId: g.id, role: 'worker', notifyParent: false });
  return { db, root, a, b, g };
}

describe('listNeighbourhood', () => {
  it('returns parent, children, and siblings — not cousins or grandchildren', () => {
    const { db, root, a, b, g } = boot();
    const fromA = listNeighbourhood(db, a.id);
    expect(fromA).toEqual(expect.arrayContaining([
      { id: root.id, relation: 'parent' },
      { id: b.id, relation: 'sibling' },
      { id: g.id, relation: 'child' },
    ]));
    expect(fromA.find((n) => n.id === a.id)).toBeUndefined();
    const fromRoot = listNeighbourhood(db, root.id);
    expect(fromRoot.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(fromRoot.every((n) => n.relation === 'child')).toBe(true);
  });
});

describe('projectAwareness', () => {
  it('sanitises role and omits title/model/profileId/cost/project', () => {
    const { db, root, a, b } = boot();
    const peers = projectAwareness({
      db,
      conversationId: a.id,
      active: [{ conversationId: b.id, status: 'running', startedAt: 42 }],
    });
    const sibling = peers.find((p) => p.conversationId === b.id)!;
    const parent = peers.find((p) => p.conversationId === root.id)!;
    expect(sibling.role).toBe('reviewer');
    expect(sibling.status).toBe('running');
    expect(sibling.startedAt).toBe(42);
    expect(sibling.canMessage).toBe(false);
    expect(parent.status).toBe('idle');
    const impl = peers.find((p) => p.conversationId === a.id);
    expect(impl).toBeUndefined();
    const poisoned = peers.find((p) => p.relation === 'parent' || p.conversationId === root.id);
    expect(JSON.stringify(peers)).not.toContain('title');
    expect(JSON.stringify(peers)).not.toContain('root-title-secret');
    expect(JSON.stringify(peers)).not.toContain('child-a-title');
    expect(JSON.stringify(peers)).not.toMatch(/profileId|model|cost|project/i);
    expect(poisoned).toBeDefined();
    const selfEdgeRole = projectAwareness({ db, conversationId: b.id, active: [] })
      .find((p) => p.conversationId === a.id)!.role;
    expect(selfEdgeRole).toBe('implscript');
    expect(selfEdgeRole).not.toContain('<');
  });
});
