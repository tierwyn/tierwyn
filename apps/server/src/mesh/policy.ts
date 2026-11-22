import type { Database } from 'better-sqlite3';
import type { TokenCapability } from '../spawn/tokens.js';
import { isDescendedFrom } from '../repositories/conversations.js';
import { lastSessionForConversation } from '../repositories/sessions.js';
import { getCompactionSettings } from '../repositories/settings.js';
import { parentOf } from './awareness.js';
import {
  getLiveEdge,
  inboundHopDepth,
  type MeshDenyReason,
} from './edges.js';
import { tryMeshRate } from './rate.js';

export type MeshDecision =
  | { ok: true; via: 'descent' | 'edge'; edgeId?: string; hop?: number }
  | { ok: false; decision: MeshDenyReason; status: 403 | 429; retryAfter?: number };

export type MeshCallerCtx = {
  callerKind: 'agent' | 'operator';
  tokenScope?: ReadonlySet<TokenCapability>;
};

/** Adjacency (direct parent↔child or siblings) already implies a shared root.
 *  Hot path: two indexed parent reads, no recursion. Do NOT add a same-tree
 *  conjunct — getRootAncestor/tree_root is advisory only. */
export function isAdjacent(db: Database, a: string, b: string): boolean {
  const pa = parentOf(db, a);
  const pb = parentOf(db, b);
  return pa === b || pb === a || (pa !== null && pa === pb);
}

/**
 * Authorization for POST /spawn/:id/message.
 * Re-reads settings on every call — tokens are immutable up to 30 min so the
 * kill-switch must not be hoisted.
 *
 * SIDE EFFECT: a successful `via: 'edge'` allow spends a tryMeshRate token.
 * Call only from POST /spawn/:id/message — not from any other predicate site.
 */
export function canMessage(
  db: Database,
  senderId: string,
  targetId: string,
  ctx: MeshCallerCtx,
): MeshDecision {
  if (senderId === targetId) {
    return { ok: false, decision: 'denied_wrong_tree', status: 403 };
  }
  // T0 descent still requires the capability it always required ('spawn', or
  // the operator cookie). A mesh-only token falls through and must present an
  // edge like any lateral sender — otherwise {schedule, mesh} silently
  // recovers unrated subtree steering.
  if (isDescendedFrom(db, targetId, senderId)) {
    if (ctx.callerKind === 'operator' || ctx.tokenScope?.has('spawn')) {
      return { ok: true, via: 'descent' };
    }
  }

  const settings = getCompactionSettings(db);
  if (settings.meshMessaging !== 'tree') {
    return { ok: false, decision: 'denied_scope', status: 403 };
  }
  if (ctx.callerKind === 'agent' && !ctx.tokenScope?.has('mesh')) {
    return { ok: false, decision: 'denied_scope', status: 403 };
  }
  if (!isAdjacent(db, senderId, targetId)) {
    return { ok: false, decision: 'denied_wrong_tree', status: 403 };
  }

  const edge = lookupDirected(db, senderId, targetId);
  if (!edge) {
    return { ok: false, decision: 'denied_no_edge', status: 403 };
  }
  if (edge.revokedAt != null || (edge.expiresAt != null && edge.expiresAt <= Date.now())) {
    return { ok: false, decision: 'denied_revoked', status: 403 };
  }
  if (edge.scope !== 'tree') {
    return { ok: false, decision: 'denied_scope', status: 403 };
  }

  const startedAt = lastSessionForConversation(db, senderId)?.createdAt ?? 0;
  const hop = inboundHopDepth(db, senderId, startedAt) + 1;
  if (hop > settings.meshMaxHops) {
    return { ok: false, decision: 'denied_hop_cap', status: 403 };
  }

  const rate = tryMeshRate({
    edgeId: edge.id,
    perEdgeLimit: settings.meshMessagesPerMinute,
    fleetLimit: settings.meshMessagesPerMinuteGlobal,
  });
  if (!rate.ok) {
    return { ok: false, decision: 'denied_rate', status: 429, retryAfter: rate.retryAfter };
  }

  return { ok: true, via: 'edge', edgeId: edge.id, hop };
}

function lookupDirected(db: Database, fromId: string, toId: string) {
  const live = getLiveEdge(db, fromId, toId);
  if (live) return live;
  const row = db.prepare(
    `SELECT id, tree_root, from_conversation, to_conversation, minted_by, scope,
            expires_at, created_at, revoked_at, note
       FROM mesh_edges
      WHERE from_conversation = ? AND to_conversation = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).get(fromId, toId) as {
    id: string; tree_root: string; from_conversation: string; to_conversation: string;
    minted_by: string; scope: string; expires_at: number | null; created_at: number;
    revoked_at: number | null; note: string | null;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    treeRoot: row.tree_root,
    fromConversation: row.from_conversation,
    toConversation: row.to_conversation,
    mintedBy: row.minted_by,
    scope: row.scope,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    note: row.note,
  };
}

export type MintCheck =
  | { ok: true }
  | { ok: false; reason: MeshDenyReason; status: 400 | 403; error: string };

/** D9 mint check. Bearer: both endpoints are the caller's children or the caller itself. */
export function canMintEdge(db: Database, opts: {
  callerKind: 'agent' | 'operator';
  callerConversationId?: string;
  fromId: string;
  toId: string;
}): MintCheck {
  if (opts.fromId === opts.toId) {
    return { ok: false, reason: 'denied_wrong_tree', error: 'from and to must differ', status: 400 };
  }
  if (!isAdjacent(db, opts.fromId, opts.toId)) {
    return { ok: false, reason: 'denied_wrong_tree', error: 'pair is not adjacent in the spawn tree', status: 403 };
  }
  if (opts.callerKind === 'operator') return { ok: true };
  const p = opts.callerConversationId;
  if (!p) return { ok: false, reason: 'denied_scope', error: 'unauthorized', status: 403 };
  const parentOfFrom = parentOf(db, opts.fromId);
  const parentOfTo = parentOf(db, opts.toId);
  const fromOk = parentOfFrom === p || opts.fromId === p;
  const toOk = parentOfTo === p || opts.toId === p;
  if (!fromOk || !toOk) {
    return {
      ok: false,
      reason: 'denied_scope',
      error: 'agent may only mint edges among itself and its direct children',
      status: 403,
    };
  }
  return { ok: true };
}
