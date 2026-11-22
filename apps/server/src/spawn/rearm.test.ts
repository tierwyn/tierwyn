import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedCommands, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSpawnEdge, getEdgeByChild } from '../repositories/spawnEdges.js';
import { listEventsForConversation } from '../repositories/events.js';
import { SessionManager } from '../sessionManager.js';
import { catalogue } from '../catalogue.js';
import { reconcileSpawnEdges } from './rearm.js';

describe('reconcileSpawnEdges', () => {
  let parent: string; let child: string;
  beforeEach(() => {
    const db = openDb(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
    setDb(db);
    catalogue.load(db);
    const p = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    parent = createConversation(db, { projectId: p.id, title: 'l0' }).id;
    child = createConversation(db, { projectId: p.id, title: 'l1', parentConversationId: parent }).id;
  });

  it('marks open edges interrupted, records a marker, and is idempotent', () => {
    const db = getDb();
    createSpawnEdge(db, { parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: false });
    const mgr = new SessionManager({ broadcast: () => {} });
    expect(reconcileSpawnEdges(db, mgr)).toBe(1);
    expect(getEdgeByChild(db, child)!.status).toBe('interrupted');
    const markers = listEventsForConversation(db, parent)
      .filter((e) => e.type === 'message' && (e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text.includes('restart'));
    expect(markers).toHaveLength(1);
    // second boot: nothing open → no-op, no duplicate markers (🔒 concern 7)
    expect(reconcileSpawnEdges(db, mgr)).toBe(0);
    expect(listEventsForConversation(db, parent)
      .filter((e) => e.type === 'message' && (e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text.includes('restart'))).toHaveLength(1);
  });
});
