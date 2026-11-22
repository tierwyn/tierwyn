import type { Database } from 'better-sqlite3';
import { childConversationIds } from '../repositories/conversations.js';
import { getCompactionSettings } from '../repositories/settings.js';
import { countLiveOutbound, getLiveEdge, insertMeshAudit, mintMeshEdge } from './edges.js';

/**
 * Mint the adjacent ring for a freshly spawned child: child ↔ parent and
 * child ↔ every existing sibling, both directions.
 *
 * Authority-conservative: every pair is adjacent by construction, so this mints
 * only edges the operator could mint in Settings and the parent agent could
 * already mint itself (D9). What it removes is the per-spawn hand-wiring that
 * made messaging unusable for disposable spawn children.
 *
 * Silent skip on duplicate or peer cap — same contract as the reverse-edge mint
 * in POST /mesh/edges. Gated on meshMessaging AND meshAutoEdges: with either
 * gate closed this writes nothing at all.
 */
export function autoMintPeerRing(db: Database, opts: { parentId: string; childId: string }): number {
  const settings = getCompactionSettings(db);
  if (settings.meshMessaging !== 'tree' || !settings.meshAutoEdges) return 0;
  const cap = settings.meshMaxPeersPerConversation;
  const peers = [
    opts.parentId,
    ...childConversationIds(db, opts.parentId).filter((id) => id !== opts.childId),
  ];
  let minted = 0;
  for (const peer of peers) {
    for (const [from, to] of [[opts.childId, peer], [peer, opts.childId]] as const) {
      if (getLiveEdge(db, from, to)) continue;
      if (countLiveOutbound(db, from) >= cap) continue;
      const edge = mintMeshEdge(db, {
        fromConversation: from,
        toConversation: to,
        mintedBy: `auto:${opts.parentId}`,
      });
      insertMeshAudit(db, {
        callerKind: 'auto',
        fromConversation: from,
        toConversation: to,
        edgeId: edge.id,
        decision: 'mint',
      });
      minted += 1;
    }
  }
  return minted;
}
