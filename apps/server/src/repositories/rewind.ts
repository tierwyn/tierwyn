import type { Database } from 'better-sqlite3';
import type { AgentAdapter, Checkpoint } from '@tierwyn/shared';
import { getEvent } from './events.js';
import { getSession, setNativeSessionId, clearNativeSessionId } from './sessions.js';
import { touchConversation } from './conversations.js';
import { createCheckpoint, getCheckpointByEvent } from './checkpoints.js';

export type AdapterFactory = (agentId: string) => AgentAdapter;

/** Count prompt+steer events in the anchor session up to and including P (1-based). */
export function nativeTurnIndex(db: Database, eventId: string): number {
  const anchor = getEvent(db, eventId);
  if (!anchor) return 0;
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM events
      WHERE session_id = ?
        AND type IN ('prompt', 'steer')
        AND (ts < ? OR (ts = ? AND seq <= ?))`,
  ).get(anchor.sessionId, anchor.ts, anchor.ts, anchor.seq) as { n: number };
  return row.n;
}

function survivingEventIds(db: Database, conversationId: string): string[] {
  return (db.prepare(
    `SELECT e.id FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?`,
  ).all(conversationId) as { id: string }[]).map((r) => r.id);
}

function truncateConversation(db: Database, conversationId: string, anchorEventId: string): void {
  const anchor = getEvent(db, anchorEventId);
  if (!anchor) throw new Error('anchor event not found');

  const anchorSession = getSession(db, anchor.sessionId);
  if (!anchorSession) throw new Error('anchor session not found');

  const anchorConvSession = db.prepare(
    'SELECT conversation_id FROM sessions WHERE id = ?',
  ).get(anchor.sessionId) as { conversation_id: string } | undefined;
  if (!anchorConvSession || anchorConvSession.conversation_id !== conversationId) {
    throw new Error('event does not belong to conversation');
  }

  db.prepare(
    `DELETE FROM events
      WHERE session_id IN (SELECT id FROM sessions WHERE conversation_id = ?)
        AND (ts > ? OR (ts = ? AND seq > ?))`,
  ).run(conversationId, anchor.ts, anchor.ts, anchor.seq);

  const orphanSessions = db.prepare(
    `SELECT s.id FROM sessions s
      WHERE s.conversation_id = ?
        AND s.created_at > ?
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)`,
  ).all(conversationId, anchorSession.createdAt) as { id: string }[];
  for (const { id } of orphanSessions) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  const surviving = survivingEventIds(db, conversationId);
  if (surviving.length === 0) {
    db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM handoffs WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM checkpoints WHERE conversation_id = ?').run(conversationId);
  } else {
    const placeholders = surviving.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM summaries WHERE conversation_id = ? AND last_event_id NOT IN (${placeholders})`,
    ).run(conversationId, ...surviving);
    db.prepare(
      `DELETE FROM handoffs WHERE conversation_id = ? AND anchor_event_id NOT IN (${placeholders})`,
    ).run(conversationId, ...surviving);
    db.prepare(
      `DELETE FROM checkpoints WHERE conversation_id = ? AND event_id NOT IN (${placeholders})`,
    ).run(conversationId, ...surviving);
  }

  touchConversation(db, conversationId);
}

export interface RewindResult {
  nativeDrift?: boolean;
  checkpoint?: Checkpoint;
}

export async function rewindConversationToEvent(
  db: Database,
  createAdapter: AdapterFactory,
  input: {
    conversationId: string;
    eventId: string;
    mode: 'rewind' | 'prune';
    createCheckpoint?: boolean;
  },
): Promise<RewindResult> {
  const anchor = getEvent(db, input.eventId);
  if (!anchor) throw new Error('event not found');

  const anchorSession = getSession(db, anchor.sessionId);
  if (!anchorSession) throw new Error('anchor session not found');

  const turnIdx = nativeTurnIndex(db, input.eventId);
  let newNativeId: string | null = null;
  let nativeDrift = false;

  if (anchorSession.agentId && anchorSession.nativeSessionId) {
    const adapter = createAdapter(anchorSession.agentId);
    const canFork = adapter.rewindNativeSession
      && adapter.isNativeSessionAvailable
      && await adapter.isNativeSessionAvailable(anchorSession.nativeSessionId);
    if (canFork) {
      try {
        newNativeId = await adapter.rewindNativeSession!(anchorSession.nativeSessionId, turnIdx);
      } catch {
        newNativeId = null;
      }
    }
    if (!newNativeId) nativeDrift = true;
  }

  const tx = db.transaction(() => {
    truncateConversation(db, input.conversationId, input.eventId);
    if (newNativeId) {
      setNativeSessionId(db, anchor.sessionId, newNativeId);
    } else if (anchorSession.nativeSessionId) {
      clearNativeSessionId(db, anchor.sessionId);
      nativeDrift = true;
    }
  });
  tx();

  let checkpoint: Checkpoint | undefined;
  if (input.createCheckpoint) {
    const existing = getCheckpointByEvent(db, input.eventId);
    if (existing) {
      checkpoint = existing;
    } else {
      const updatedSession = getSession(db, anchor.sessionId);
      checkpoint = createCheckpoint(db, {
        conversationId: input.conversationId,
        eventId: input.eventId,
        sessionId: anchor.sessionId,
        nativeSessionId: updatedSession?.nativeSessionId,
        nativeTurnIndex: turnIdx || undefined,
        kind: 'manual',
        pinned: false,
      });
    }
  }

  return { nativeDrift: nativeDrift || undefined, checkpoint };
}
