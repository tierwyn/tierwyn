import type { Database } from 'better-sqlite3';
import type { AgentStatus, MeshPeer } from '@tierwyn/shared';
import { childConversationIds, isStopped } from '../repositories/conversations.js';
import { getEdgeByChild } from '../repositories/spawnEdges.js';
import { sanitizeToken } from '../spawn/prose.js';

export type MeshRelation = MeshPeer['relation'];

export function parentOf(db: Database, id: string): string | null {
  const row = db.prepare('SELECT parent_conversation_id FROM conversations WHERE id = ?').get(id) as
    | { parent_conversation_id: string | null }
    | undefined;
  return row?.parent_conversation_id ?? null;
}

/** D7 neighbourhood: direct parent, direct children, siblings. Adjacency implies
 *  a shared root — no separate same-tree walk. */
export function listNeighbourhood(
  db: Database,
  id: string,
): { id: string; relation: MeshRelation }[] {
  const out: { id: string; relation: MeshRelation }[] = [];
  const parent = parentOf(db, id);
  if (parent) out.push({ id: parent, relation: 'parent' });
  for (const child of childConversationIds(db, id)) {
    out.push({ id: child, relation: 'child' });
  }
  if (parent) {
    for (const sib of childConversationIds(db, parent)) {
      if (sib !== id) out.push({ id: sib, relation: 'sibling' });
    }
  }
  return out;
}

export interface AwarenessLiveSession {
  conversationId: string;
  status?: AgentStatus;
  startedAt: number;
}

/** Sanitised projection: role only — never title, model, profileId, cost, or project. */
export function projectAwareness(opts: {
  db: Database;
  conversationId: string;
  active: AwarenessLiveSession[];
  hasLiveEdge?: (toConversationId: string) => boolean;
}): MeshPeer[] {
  const byConv = new Map(opts.active.map((s) => [s.conversationId, s]));
  return listNeighbourhood(opts.db, opts.conversationId).map(({ id, relation }) => {
    const live = byConv.get(id);
    const stopped = isStopped(opts.db, id) && (!live || live.status === 'idle' || live.status === 'done' || live.status === 'error');
    return {
      conversationId: id,
      relation,
      role: sanitizeToken(getEdgeByChild(opts.db, id)?.role, 'agent'),
      status: stopped ? 'stopped' : (live?.status ?? 'idle'),
      startedAt: live?.startedAt ?? 0,
      canMessage: stopped ? false : (opts.hasLiveEdge?.(id) ?? false),
    };
  });
}
