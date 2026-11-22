import type { SessionManager } from '../sessionManager.js';
import { getDb } from '../db/index.js';
import { insertMeshAudit } from './edges.js';
import { deliverLateral } from './deliver.js';

export interface PendingPeerMessage {
  /** Already redacted and framed by the route — do not re-frame on flush. */
  text: string;
  replyTo: string;
  role?: string;
  edgeId?: string;
  hop: number;
  bytes: number;
}

export const MAILBOX_MAX = 4;

// ponytail: in-memory, same durability as the rate buckets — a restart drops
// undelivered mail. Persist to SQLite only if operators report actual loss.
const boxes = new Map<string, { items: PendingPeerMessage[]; dropped: number }>();

export function queuePeerMessage(conversationId: string, msg: PendingPeerMessage): void {
  const box = boxes.get(conversationId) ?? { items: [], dropped: 0 };
  box.items.push(msg);
  while (box.items.length > MAILBOX_MAX) {
    box.items.shift();
    box.dropped += 1;
  }
  boxes.set(conversationId, box);
}

export function pendingCount(conversationId: string): number {
  return boxes.get(conversationId)?.items.length ?? 0;
}

export function dropMailbox(conversationId: string): void {
  boxes.delete(conversationId);
}

/**
 * Flush at session end: one new turn carrying every queued peer message, in
 * arrival order. One audit row per queued message so the log still counts
 * senders, not deliveries.
 *
 * If a new session started in the gap, deliverLateral may re-queue — that is
 * correct, the box flushes again at the next session end.
 */
export async function flushMeshMailbox(sm: SessionManager, conversationId: string): Promise<void> {
  const box = boxes.get(conversationId);
  if (!box || box.items.length === 0) return;
  boxes.delete(conversationId);

  const parts = box.items.map((m) => m.text);
  if (box.dropped > 0) {
    parts.unshift(`[tierwyn] ${box.dropped} earlier peer message(s) were dropped: mailbox cap (${MAILBOX_MAX}).`);
  }
  const last = box.items[box.items.length - 1];
  const result = await deliverLateral(sm, conversationId, parts.join('\n\n'), {
    replyTo: last.replyTo,
    role: last.role,
    edgeId: last.edgeId,
    hop: last.hop,
    bytes: last.bytes,
  });

  const db = getDb();
  const decision = result.decision === 'allowed_steer' || result.decision === 'delivered_new_turn'
    ? 'delivered_deferred' as const
    : result.decision;
  for (const m of box.items) {
    insertMeshAudit(db, {
      callerKind: 'agent',
      fromConversation: m.replyTo,
      toConversation: conversationId,
      edgeId: m.edgeId,
      decision,
      hop: m.hop,
      bytes: m.bytes,
      content: m.text,
    });
  }
}
