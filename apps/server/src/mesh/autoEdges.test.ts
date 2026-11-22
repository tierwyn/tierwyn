import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { updateCompactionSettings } from '../repositories/settings.js';
import { getLiveEdge, countLiveOutbound } from './edges.js';
import { autoMintPeerRing } from './autoEdges.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const root = createConversation(db, { projectId: p.id, title: 'root' });
  const a = createConversation(db, { projectId: p.id, title: 'a', parentConversationId: root.id });
  return { db, root, a, p };
}

describe('autoMintPeerRing', () => {
  it('mints nothing while messaging is off', () => {
    const { db, root, a } = boot();
    expect(autoMintPeerRing(db, { parentId: root.id, childId: a.id })).toBe(0);
    expect(getLiveEdge(db, a.id, root.id)).toBeUndefined();
  });

  it('mints nothing when meshAutoEdges is off, even with messaging on', () => {
    const { db, root, a } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree', meshAutoEdges: false });
    expect(autoMintPeerRing(db, { parentId: root.id, childId: a.id })).toBe(0);
  });

  it('mints both directions to the parent and to each existing sibling', () => {
    const { db, root, a, p } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const b = createConversation(db, { projectId: p.id, title: 'b', parentConversationId: root.id });
    const minted = autoMintPeerRing(db, { parentId: root.id, childId: b.id });
    expect(minted).toBe(4);
    expect(getLiveEdge(db, b.id, root.id)).toBeDefined();
    expect(getLiveEdge(db, root.id, b.id)).toBeDefined();
    expect(getLiveEdge(db, b.id, a.id)).toBeDefined();
    expect(getLiveEdge(db, a.id, b.id)).toBeDefined();
  });

  it('is idempotent and honours the peer cap per conversation', () => {
    const { db, root, a, p } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree', meshMaxPeersPerConversation: 1 });
    const b = createConversation(db, { projectId: p.id, title: 'b', parentConversationId: root.id });
    autoMintPeerRing(db, { parentId: root.id, childId: b.id });
    // The cap is per from_conversation, so under cap=1 the ring comes out
    // asymmetric (b→a skipped once b's outbound slot is spent, a→b minted).
    // That is the cap doing its job — assert the invariant, not exact counts.
    expect(countLiveOutbound(db, b.id)).toBeLessThanOrEqual(1);
    expect(countLiveOutbound(db, root.id)).toBeLessThanOrEqual(1);
    expect(countLiveOutbound(db, a.id)).toBeLessThanOrEqual(1);
    expect(getLiveEdge(db, b.id, root.id)).toBeDefined();
    expect(autoMintPeerRing(db, { parentId: root.id, childId: b.id })).toBe(0);
  });
});
