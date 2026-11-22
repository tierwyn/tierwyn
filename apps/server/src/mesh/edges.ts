import { randomUUID, createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { getRootAncestor } from '../repositories/conversations.js';
import { evictMeshRate, evictMeshRates } from './rate.js';

export type MeshDenyReason =
  | 'denied_no_edge'
  | 'denied_wrong_tree'
  | 'denied_hop_cap'
  | 'denied_rate'
  | 'denied_revoked'
  | 'denied_scope';

export type MeshAuditDecision =
  | 'mint'
  | 'allowed_steer'
  | 'allowed_interrupt'      // historical rows only
  | 'deferred_pending'
  | 'delivered_deferred'
  | 'delivered_new_turn'
  | 'dropped_no_session'
  | 'denied_too_large'
  | 'delivery_error'
  | MeshDenyReason;

export interface MeshEdgeRow {
  id: string;
  treeRoot: string;
  fromConversation: string;
  toConversation: string;
  mintedBy: string;
  scope: string;
  expiresAt: number | null;
  createdAt: number;
  revokedAt: number | null;
  note: string | null;
}

interface EdgeSql {
  id: string;
  tree_root: string;
  from_conversation: string;
  to_conversation: string;
  minted_by: string;
  scope: string;
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
  note: string | null;
}

function toEdge(r: EdgeSql): MeshEdgeRow {
  return {
    id: r.id,
    treeRoot: r.tree_root,
    fromConversation: r.from_conversation,
    toConversation: r.to_conversation,
    mintedBy: r.minted_by,
    scope: r.scope,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    note: r.note,
  };
}

export function getLiveEdge(db: Database, fromId: string, toId: string): MeshEdgeRow | undefined {
  const row = db.prepare(
    `SELECT * FROM mesh_edges
      WHERE from_conversation = ? AND to_conversation = ? AND revoked_at IS NULL`,
  ).get(fromId, toId) as EdgeSql | undefined;
  return row ? toEdge(row) : undefined;
}

export function countLiveOutbound(db: Database, fromId: string): number {
  const r = db.prepare(
    `SELECT COUNT(*) AS n FROM mesh_edges WHERE from_conversation = ? AND revoked_at IS NULL`,
  ).get(fromId) as { n: number };
  return r.n;
}

export function listMeshEdges(db: Database): MeshEdgeRow[] {
  return (db.prepare(`SELECT * FROM mesh_edges ORDER BY created_at DESC`).all() as EdgeSql[]).map(toEdge);
}

export function getMeshEdge(db: Database, id: string): MeshEdgeRow | undefined {
  const row = db.prepare(`SELECT * FROM mesh_edges WHERE id = ?`).get(id) as EdgeSql | undefined;
  return row ? toEdge(row) : undefined;
}

export function mintMeshEdge(db: Database, e: {
  fromConversation: string;
  toConversation: string;
  mintedBy: string;
  note?: string;
}): MeshEdgeRow {
  const id = randomUUID();
  const now = Date.now();
  const treeRoot = getRootAncestor(db, e.fromConversation);
  db.prepare(`
    INSERT INTO mesh_edges (id, tree_root, from_conversation, to_conversation, minted_by, scope, created_at)
    VALUES (?, ?, ?, ?, ?, 'tree', ?)
  `).run(id, treeRoot, e.fromConversation, e.toConversation, e.mintedBy, now);
  return getMeshEdge(db, id)!;
}

export function revokeMeshEdge(db: Database, id: string): boolean {
  const info = db.prepare(
    `UPDATE mesh_edges SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
  ).run(Date.now(), id);
  if (info.changes > 0) evictMeshRate(id);
  return info.changes > 0;
}

/** Revoke every live mesh edge that touches this conversation (either end). */
export function revokeMeshEdgesFor(db: Database, conversationId: string): number {
  const ids = (db.prepare(
    `SELECT id FROM mesh_edges WHERE revoked_at IS NULL AND (from_conversation = ? OR to_conversation = ?)`,
  ).all(conversationId, conversationId) as { id: string }[]).map((r) => r.id);
  const info = db.prepare(
    `UPDATE mesh_edges SET revoked_at = ? WHERE revoked_at IS NULL AND (from_conversation = ? OR to_conversation = ?)`,
  ).run(Date.now(), conversationId, conversationId);
  if (ids.length > 0) evictMeshRates(ids);
  return info.changes;
}

export function insertMeshAudit(db: Database, row: {
  ts?: number;
  callerKind: 'agent' | 'operator' | 'auto';
  fromConversation: string;
  toConversation: string;
  edgeId?: string | null;
  decision: MeshAuditDecision;
  hop?: number;
  bytes?: number;
  content?: string;
  durationMs?: number;
  error?: string | null;
}): void {
  const sha = row.content
    ? createHash('sha256').update(row.content).digest('hex')
    : null;
  db.prepare(`
    INSERT INTO mesh_messages (ts, caller_kind, from_conversation, to_conversation, edge_id, decision, hop, bytes, content_sha256, duration_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ts ?? Date.now(),
    row.callerKind,
    row.fromConversation,
    row.toConversation,
    row.edgeId ?? null,
    row.decision,
    row.hop ?? 0,
    row.bytes ?? 0,
    sha,
    row.durationMs ?? 0,
    row.error ?? null,
  );
}

export function listMeshMessages(db: Database, limit = 100): Array<{
  id: number;
  ts: number;
  callerKind: string;
  fromConversation: string;
  toConversation: string;
  edgeId: string | null;
  decision: string;
  hop: number;
  bytes: number;
  contentSha256: string | null;
  durationMs: number;
  error: string | null;
}> {
  const rows = db.prepare(
    `SELECT * FROM mesh_messages ORDER BY ts DESC, id DESC LIMIT ?`,
  ).all(limit) as Array<{
    id: number; ts: number; caller_kind: string; from_conversation: string; to_conversation: string;
    edge_id: string | null; decision: string; hop: number; bytes: number;
    content_sha256: string | null; duration_ms: number; error: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    callerKind: r.caller_kind,
    fromConversation: r.from_conversation,
    toConversation: r.to_conversation,
    edgeId: r.edge_id,
    decision: r.decision,
    hop: r.hop,
    bytes: r.bytes,
    contentSha256: r.content_sha256,
    durationMs: r.duration_ms,
    error: r.error,
  }));
}

/**
 * Causal-chain depth of the message this conversation is about to send.
 * 0 = originating (nothing lateral was delivered here this session).
 *
 * Replaces the old boolean session taint (D11), which forbade every send after
 * any receive and so forbade the coordinator pattern the mesh exists for. A
 * counter bounds cycles just as hard: every forward increments, so any ring
 * terminates within meshMaxHops regardless of its length.
 */
export function inboundHopDepth(db: Database, conversationId: string, sessionStartedAt: number): number {
  if (!sessionStartedAt) return 0;
  const row = db.prepare(
    `SELECT MAX(hop) AS h FROM mesh_messages
      WHERE to_conversation = ?
        AND decision IN ('allowed_steer','allowed_interrupt','delivered_new_turn','delivered_deferred')
        AND ts >= ?`,
  ).get(conversationId, sessionStartedAt) as { h: number | null };
  return row.h ?? 0;
}

export function liveEdgeSetHash(db: Database, conversationId: string): string {
  const rows = db.prepare(
    `SELECT id FROM mesh_edges
      WHERE (from_conversation = ? OR to_conversation = ?) AND revoked_at IS NULL
      ORDER BY id`,
  ).all(conversationId, conversationId) as { id: string }[];
  return createHash('sha256').update(rows.map((r) => r.id).join(',')).digest('hex').slice(0, 16);
}
