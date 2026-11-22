import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { Handoff } from '@tierwyn/shared';

export function insertHandoff(db: Database, row: Omit<Handoff, 'id' | 'created_at'>): Handoff {
  const h: Handoff = { id: randomUUID(), created_at: Date.now(), ...row };
  db.prepare(
    `INSERT INTO handoffs
       (id, conversation_id, from_profile_id, to_profile_id, requested_mode,
        resolved_mode, anchor_event_id, summary_id, priming_context, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    h.id, h.conversation_id, h.from_profile_id, h.to_profile_id,
    h.requested_mode, h.resolved_mode, h.anchor_event_id, h.summary_id,
    h.priming_context ?? null, h.created_at,
  );
  return h;
}

export function listHandoffs(db: Database, conversationId: string): Handoff[] {
  return db
    .prepare(`SELECT * FROM handoffs WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(conversationId) as Handoff[];
}

export function getHandoffByAnchor(
  db: Database,
  conversationId: string,
  anchorEventId: string,
): Handoff | undefined {
  return db
    .prepare(`SELECT * FROM handoffs WHERE conversation_id = ? AND anchor_event_id = ? LIMIT 1`)
    .get(conversationId, anchorEventId) as Handoff | undefined;
}
