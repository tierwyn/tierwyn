import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { isDescendedFrom } from '../repositories/conversations.js';
import { updateCompactionSettings } from '../repositories/settings.js';
import { mintMeshEdge, insertMeshAudit } from './edges.js';
import { canMessage, canMintEdge } from './policy.js';
import { resetMeshRateForTests } from './rate.js';
import type { TokenCapability } from '../spawn/tokens.js';

const MESH: ReadonlySet<TokenCapability> = new Set(['schedule', 'mesh']);
const SPAWN: ReadonlySet<TokenCapability> = new Set(['spawn', 'schedule', 'plugin']);
const ctx = (scope: ReadonlySet<TokenCapability> = MESH) => ({ callerKind: 'agent' as const, tokenScope: scope });

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const root = createConversation(db, { projectId: p.id, title: 'root' });
  const a = createConversation(db, { projectId: p.id, title: 'a', parentConversationId: root.id });
  const b = createConversation(db, { projectId: p.id, title: 'b', parentConversationId: root.id });
  const cousinParent = createConversation(db, { projectId: p.id, title: 'other', parentConversationId: root.id });
  const cousin = createConversation(db, { projectId: p.id, title: 'cousin', parentConversationId: cousinParent.id });
  const g = createConversation(db, { projectId: p.id, title: 'grand', parentConversationId: a.id });
  return { db, root, a, b, cousin, cousinParent, g };
}

describe('canMessage off-invariant', () => {
  it('agrees with isDescendedFrom on every pair including live-edge pairs when both settings are off', () => {
    const { db, root, a, b, cousin, g } = boot();
    mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: root.id, mintedBy: 'operator' });
    const ids = [root.id, a.id, b.id, cousin.id, g.id];
    const pairs = ids.flatMap((s) => ids.map((t) => [s, t] as const));
    // Off-state tokens carry 'spawn', not 'mesh'. A {schedule, mesh} ctx is not
    // a real off-state token — see H-1.
    for (const [s, t] of pairs) {
      const legacy = s !== t && isDescendedFrom(db, t, s);
      const got = canMessage(db, s, t, ctx(SPAWN));
      expect(got.ok).toBe(legacy);
      if (got.ok) expect(got.via).toBe('descent');
    }
  });

  it('mesh-only token cannot descent-steer even while messaging is off (H-1 defense in depth)', () => {
    const { db, root, a } = boot();
    const got = canMessage(db, root.id, a.id, ctx(MESH));
    expect(got.ok).toBe(false);
  });
});

describe('canMessage mesh on', () => {
  beforeEach(() => resetMeshRateForTests());

  it('denies same-tree no-edge as denied_no_edge', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const got = canMessage(db, a.id, b.id, ctx());
    expect(got).toEqual({ ok: false, decision: 'denied_no_edge', status: 403 });
  });

  it('allows sibling with a live edge', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const edge = mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    const got = canMessage(db, a.id, b.id, ctx());
    expect(got).toEqual({ ok: true, via: 'edge', edgeId: edge.id, hop: 1 });
  });

  it('denies cousin even with a live edge as denied_wrong_tree', () => {
    const { db, a, cousin } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: cousin.id, mintedBy: 'operator' });
    const got = canMessage(db, a.id, cousin.id, ctx());
    expect(got).toEqual({ ok: false, decision: 'denied_wrong_tree', status: 403 });
  });

  it('child→parent without edge is denied; with edge is allowed (D8 twins)', () => {
    const { db, root, a } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    expect(canMessage(db, a.id, root.id, ctx()).ok).toBe(false);
    mintMeshEdge(db, { fromConversation: a.id, toConversation: root.id, mintedBy: 'operator' });
    expect(canMessage(db, a.id, root.id, ctx()).ok).toBe(true);
  });

  it('a coordinator may forward one hop: inbound hop 1 sends at hop 2', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    createSession(db, { id: 's-a', conversationId: a.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    insertMeshAudit(db, {
      callerKind: 'agent',
      fromConversation: b.id,
      toConversation: a.id,
      decision: 'allowed_steer',
      hop: 1,
    });
    const got = canMessage(db, a.id, b.id, ctx());
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.hop).toBe(2);
  });

  it('a third hop is denied_hop_cap at the default cap of 2', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    createSession(db, { id: 's-a', conversationId: a.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    insertMeshAudit(db, {
      callerKind: 'agent',
      fromConversation: b.id,
      toConversation: a.id,
      decision: 'allowed_steer',
      hop: 2,
    });
    expect(canMessage(db, a.id, b.id, ctx()).decision).toBe('denied_hop_cap');
  });

  it('a mailbox-flushed delivery (delivered_deferred) counts toward the hop chain', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    createSession(db, { id: 's-a', conversationId: a.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    insertMeshAudit(db, {
      callerKind: 'agent',
      fromConversation: b.id,
      toConversation: a.id,
      decision: 'delivered_deferred',
      hop: 2,
    });
    expect(canMessage(db, a.id, b.id, ctx()).decision).toBe('denied_hop_cap');
  });

  it('an originating send is hop 1 and a new session resets the chain', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    createSession(db, { id: 's-a', conversationId: a.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    const first = canMessage(db, a.id, b.id, ctx());
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.hop).toBe(1);
    insertMeshAudit(db, {
      callerKind: 'agent', fromConversation: b.id, toConversation: a.id,
      decision: 'allowed_steer', hop: 2,
    });
    expect(canMessage(db, a.id, b.id, ctx()).decision).toBe('denied_hop_cap');
    createSession(db, { id: 's-a2', conversationId: a.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    db.prepare("UPDATE sessions SET created_at = created_at + 10 WHERE id = 's-a2'").run();
    expect(canMessage(db, a.id, b.id, ctx()).ok).toBe(true);
  });

  it('revoked and expired edges are denied_revoked', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const edge = mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    db.prepare('UPDATE mesh_edges SET revoked_at = ? WHERE id = ?').run(Date.now(), edge.id);
    expect(canMessage(db, a.id, b.id, ctx()).decision).toBe('denied_revoked');
    db.prepare('UPDATE mesh_edges SET revoked_at = NULL, expires_at = ? WHERE id = ?').run(Date.now() - 1, edge.id);
    expect(canMessage(db, a.id, b.id, ctx()).decision).toBe('denied_revoked');
  });

  it('token without mesh is denied_scope on the mesh path', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    expect(canMessage(db, a.id, b.id, ctx(SPAWN)).decision).toBe('denied_scope');
  });

  it('kill-switch is live: flipping meshMessaging off mid-flight 403s even with a mesh token', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    expect(canMessage(db, a.id, b.id, ctx()).ok).toBe(true);
    updateCompactionSettings(db, { meshMessaging: 'off' });
    expect(canMessage(db, a.id, b.id, ctx()).ok).toBe(false);
  });

  it('schedule+mesh token cannot descent-steer; operator and spawn tokens still can (H-1)', () => {
    const { db, root, a } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const meshOnly = canMessage(db, root.id, a.id, ctx(MESH));
    expect(meshOnly.ok).toBe(false);
    if (!meshOnly.ok) expect(meshOnly.decision).toBe('denied_no_edge');
    expect(canMessage(db, root.id, a.id, ctx(SPAWN))).toEqual({ ok: true, via: 'descent' });
    const spawnMesh: ReadonlySet<TokenCapability> = new Set(['spawn', 'schedule', 'plugin', 'mesh']);
    expect(canMessage(db, root.id, a.id, ctx(spawnMesh))).toEqual({ ok: true, via: 'descent' });
    expect(canMessage(db, root.id, a.id, { callerKind: 'operator' })).toEqual({ ok: true, via: 'descent' });
  });

  it('7th message on one edge within a minute is denied_rate', () => {
    const { db, a, b } = boot();
    updateCompactionSettings(db, { meshMessaging: 'tree', meshMessagesPerMinute: 6, meshMessagesPerMinuteGlobal: 20 });
    mintMeshEdge(db, { fromConversation: a.id, toConversation: b.id, mintedBy: 'operator' });
    for (let i = 0; i < 6; i++) {
      expect(canMessage(db, a.id, b.id, ctx()).ok).toBe(true);
    }
    const seventh = canMessage(db, a.id, b.id, ctx());
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) {
      expect(seventh.decision).toBe('denied_rate');
      expect(seventh.status).toBe(429);
    }
  });
});

describe('canMintEdge structured denial', () => {
  it('same from/to is denied_wrong_tree (not a substring of the error text)', () => {
    const { db, a } = boot();
    const got = canMintEdge(db, { callerKind: 'operator', fromId: a.id, toId: a.id });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe('denied_wrong_tree');
      expect(got.status).toBe(400);
      expect(got.error).toBe('from and to must differ');
    }
  });

  it('non-adjacent pair is denied_wrong_tree', () => {
    const { db, a, cousin } = boot();
    const got = canMintEdge(db, { callerKind: 'operator', fromId: a.id, toId: cousin.id });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe('denied_wrong_tree');
      expect(got.status).toBe(403);
      expect(got.error).toBe('pair is not adjacent in the spawn tree');
    }
  });

  it('agent minting a pair outside itself and its children is denied_scope', () => {
    const { db, a, b } = boot();
    const got = canMintEdge(db, {
      callerKind: 'agent',
      callerConversationId: a.id,
      fromId: a.id,
      toId: b.id,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe('denied_scope');
      expect(got.status).toBe(403);
    }
  });

  it('parent agent may mint an edge among its children; operator may mint any adjacent pair', () => {
    const { db, root, a, b } = boot();
    expect(canMintEdge(db, {
      callerKind: 'agent',
      callerConversationId: root.id,
      fromId: a.id,
      toId: b.id,
    }).ok).toBe(true);
    expect(canMintEdge(db, { callerKind: 'operator', fromId: a.id, toId: b.id }).ok).toBe(true);
  });
});
