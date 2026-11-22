import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { SpawnEdgeOutcome } from '@tierwyn/shared';

export interface SpawnEdge {
  id: string;
  parentConversationId: string;
  childConversationId: string;
  role?: string;
  profileId?: string;
  notifyParent: boolean;
  status: 'open' | 'resolved' | 'stalled' | 'interrupted';
  followupCount: number;
  createdAt: number;
  resolvedAt?: number;
  /** NULL = legacy row (pre-131). */
  outcome: SpawnEdgeOutcome | null;
}

interface Row {
  id: string; parent_conversation_id: string; child_conversation_id: string;
  role: string | null; profile_id: string | null; notify_parent: number;
  status: SpawnEdge['status']; followup_count: number; created_at: number; resolved_at: number | null;
  outcome: string | null;
}

const toEdge = (r: Row): SpawnEdge => ({
  id: r.id,
  parentConversationId: r.parent_conversation_id,
  childConversationId: r.child_conversation_id,
  role: r.role ?? undefined,
  profileId: r.profile_id ?? undefined,
  notifyParent: r.notify_parent === 1,
  status: r.status,
  followupCount: r.followup_count,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at ?? undefined,
  outcome: (r.outcome as SpawnEdgeOutcome | null) ?? null,
});

export function createSpawnEdge(db: Database, e: {
  parentConversationId: string; childConversationId: string;
  role?: string; profileId?: string; notifyParent: boolean;
}): SpawnEdge {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO spawn_edges (id, parent_conversation_id, child_conversation_id, role, profile_id, notify_parent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, e.parentConversationId, e.childConversationId, e.role ?? null, e.profileId ?? null, e.notifyParent ? 1 : 0, Date.now());
  return getEdgeByChild(db, e.childConversationId)!;
}

export function getEdgeByChild(db: Database, childConversationId: string): SpawnEdge | undefined {
  const row = db.prepare('SELECT * FROM spawn_edges WHERE child_conversation_id = ?').get(childConversationId) as Row | undefined;
  return row ? toEdge(row) : undefined;
}

/** 🔒 Exactly-once initial resolution (threat-model concern 7): CAS on
 *  status='open'. Returns true iff THIS caller performed the transition. */
export function resolveSpawnEdge(
  db: Database,
  id: string,
  status: 'resolved' | 'stalled' | 'interrupted',
  outcome: SpawnEdgeOutcome,
): boolean {
  // [S3-7] Outcome is part of the resolution contract: an edge can never be
  // resolved into an uninterpretable NULL — callers must classify the run.
  const r = db.prepare(
    `UPDATE spawn_edges SET status = ?, resolved_at = ?, outcome = ? WHERE id = ? AND status = 'open'`,
  ).run(status, Date.now(), outcome, id);
  return r.changes === 1;
}

export function incrementFollowup(db: Database, id: string): void {
  db.prepare('UPDATE spawn_edges SET followup_count = followup_count + 1 WHERE id = ?').run(id);
}

/** 🔒 CAS consumption of the one-shot recovery slot: flips followup_count
 *  0 → 1 only if still unspent. Returns true iff THIS caller consumed it —
 *  two concurrent recovery-bridging turns cannot both win (the loser must
 *  not fire the parent notify turn). */
export function consumeFollowupSlot(db: Database, id: string): boolean {
  const r = db.prepare('UPDATE spawn_edges SET followup_count = 1 WHERE id = ? AND followup_count = 0').run(id);
  return r.changes === 1;
}

export function listOpenEdges(db: Database): SpawnEdge[] {
  return (db.prepare(`SELECT * FROM spawn_edges WHERE status = 'open' ORDER BY created_at`).all() as Row[]).map(toEdge);
}

/** Open edges whose parent is `parentConversationId` (children still running). */
export function listOpenEdgesForParent(db: Database, parentConversationId: string): SpawnEdge[] {
  return (db.prepare(
    `SELECT * FROM spawn_edges WHERE status = 'open' AND parent_conversation_id = ? ORDER BY created_at`,
  ).all(parentConversationId) as Row[]).map(toEdge);
}
