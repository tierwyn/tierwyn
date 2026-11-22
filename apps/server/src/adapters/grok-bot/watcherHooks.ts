import type { Database } from 'better-sqlite3';
import type { SpawnMarker } from '@tierwyn/shared';
import { getConversation } from '../../repositories/conversations.js';
import { getEdgeByChild } from '../../repositories/spawnEdges.js';
import { frameSubagentProse } from '../../spawn/prose.js';

export interface GrokBotHandover {
  botId: string;
  botName?: string;
  fromConversationId: string;
  toConversationId: string;
}

type MarkerSink = { recordSpawnMarker(conversationId: string, marker: SpawnMarker): void };

type RelaySink = MarkerSink & {
  notifyParentSubagentResult(parentId: string, text: string, meta: { role?: string; childConversationId: string }): void;
};

/** The "teleport" card: posted in both chats when a Bot's replies change owner. */
export function recordGrokBotHandover(db: Database, sm: MarkerSink, h: GrokBotHandover): void {
  const who = h.botName ? `Grok Bot · ${h.botName}` : 'Grok Bot';
  const from = getConversation(db, h.fromConversationId);
  const to = getConversation(db, h.toConversationId);
  if (to) {
    sm.recordSpawnMarker(h.toConversationId, {
      kind: 'handover', childConversationId: h.fromConversationId, childTitle: from?.title,
      text: `${who} replies now arrive here${from ? ` (moved from “${from.title}”)` : ''}`,
    });
  }
  if (from) {
    sm.recordSpawnMarker(h.fromConversationId, {
      kind: 'handover', childConversationId: h.toConversationId, childTitle: to?.title,
      text: `${who} moved — its replies now arrive in “${to?.title ?? h.toConversationId}”`,
    });
  }
}

/** A Grok Bot spawn child answered after its turn settled: surface it to the parent.
 *  Prose is untrusted Bot output — framed, never interpreted. */
export function relayLateChildReply(db: Database, sm: RelaySink, conversationId: string, prose: string): void {
  const edge = getEdgeByChild(db, conversationId);
  if (!edge) return;
  const role = edge.role ?? getConversation(db, conversationId)?.title.replace(/^↳\s*/, '');
  sm.recordSpawnMarker(edge.parentConversationId, {
    kind: 'result', childConversationId: conversationId, role,
    text: `◀ result (late reply): ${prose}`,
  });
  if (!edge.notifyParent) return;
  sm.notifyParentSubagentResult(
    edge.parentConversationId,
    frameSubagentProse(prose, { role, childConversationId: conversationId, followup: true }),
    { role, childConversationId: conversationId },
  );
}
