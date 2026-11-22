import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { Checkpoint, CheckpointKind } from '@tierwyn/shared';

interface Row {
  id: string;
  conversation_id: string;
  event_id: string;
  session_id: string;
  native_session_id: string | null;
  native_turn_index: number | null;
  code_ref: string | null;
  label: string | null;
  kind: string;
  pinned: number;
  created_at: number;
  /** Only populated by listCheckpoints (correlated subquery); null on raw SELECTs. */
  prompt_preview?: string | null;
  /** Only populated by listCheckpoints (correlated subquery); null on raw SELECTs. */
  turn_index?: number | null;
}

function toCheckpoint(r: Row): Checkpoint {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    eventId: r.event_id,
    sessionId: r.session_id,
    nativeSessionId: r.native_session_id ?? undefined,
    nativeTurnIndex: r.native_turn_index ?? undefined,
    codeRef: r.code_ref ?? undefined,
    label: r.label ?? undefined,
    kind: r.kind as CheckpointKind,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    promptPreview: r.prompt_preview ?? undefined,
    turnIndex: r.turn_index ?? undefined,
  };
}

export function createCheckpoint(
  db: Database,
  input: {
    conversationId: string;
    eventId: string;
    sessionId: string;
    nativeSessionId?: string;
    nativeTurnIndex?: number;
    codeRef?: string;
    label?: string;
    kind: CheckpointKind;
    pinned?: boolean;
  },
): Checkpoint {
  const row: Row = {
    id: randomUUID(),
    conversation_id: input.conversationId,
    event_id: input.eventId,
    session_id: input.sessionId,
    native_session_id: input.nativeSessionId ?? null,
    native_turn_index: input.nativeTurnIndex ?? null,
    code_ref: input.codeRef ?? null,
    label: input.label ?? null,
    kind: input.kind,
    pinned: input.pinned ? 1 : 0,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO checkpoints
       (id, conversation_id, event_id, session_id, native_session_id, native_turn_index,
        code_ref, label, kind, pinned, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.conversation_id, row.event_id, row.session_id,
    row.native_session_id, row.native_turn_index, row.code_ref, row.label,
    row.kind, row.pinned, row.created_at,
  );
  return toCheckpoint(row);
}

export function listCheckpoints(db: Database, conversationId: string): Checkpoint[] {
  // Single pass over checkpoints + single pass over operator-authored prompts,
  // matched in O(C log P) instead of correlated subqueries per checkpoint
  // (O(C * E) froze the server for ~19s on long conversations with 300+ checkpoints).
  const rows = db.prepare(
    `SELECT c.*, c_e.ts AS anchor_ts, c_e.seq AS anchor_seq
       FROM checkpoints c
       JOIN events c_e ON c_e.id = c.event_id
      WHERE c.conversation_id = ?
      ORDER BY c.created_at ASC`,
  ).all(conversationId) as (Row & { anchor_ts: number; anchor_seq: number })[];

  if (rows.length === 0) return [];

  const prompts = db.prepare(
    `SELECT p.ts, p.seq, json_extract(p.payload, '$.text') AS text
       FROM events p
       JOIN sessions s ON s.id = p.session_id
      WHERE s.conversation_id = ?
        AND p.type = 'prompt'
        AND json_valid(p.payload)
        AND (json_extract(p.payload, '$.source') IS NULL
             OR json_extract(p.payload, '$.source') != 'subagent_notify')
      ORDER BY p.ts ASC, p.seq ASC`,
  ).all(conversationId) as { ts: number; seq: number; text: string | null }[];

  return rows.map((r) => {
    let lo = 0;
    let hi = prompts.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = prompts[mid];
      if (p.ts < r.anchor_ts || (p.ts === r.anchor_ts && p.seq <= r.anchor_seq)) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return toCheckpoint({
      ...r,
      prompt_preview: idx >= 0 ? prompts[idx].text : null,
      turn_index: idx + 1,
    });
  });
}

export function getCheckpoint(db: Database, id: string): Checkpoint | undefined {
  const r = db.prepare(
    `SELECT c.*,
       (SELECT json_extract(p.payload, '$.text')
          FROM events p
          JOIN sessions s ON s.id = p.session_id
         WHERE s.conversation_id = c.conversation_id
           AND p.type = 'prompt'
           AND json_valid(p.payload)
           AND (json_extract(p.payload, '$.source') IS NULL
                OR json_extract(p.payload, '$.source') != 'subagent_notify')
           AND (p.ts < c_e.ts OR (p.ts = c_e.ts AND p.seq <= c_e.seq))
         ORDER BY p.ts DESC, p.seq DESC LIMIT 1) AS prompt_preview,
       (SELECT COUNT(*) FROM events p
          JOIN sessions s ON s.id = p.session_id
         WHERE s.conversation_id = c.conversation_id
           AND p.type = 'prompt'
           AND json_valid(p.payload)
           AND (json_extract(p.payload, '$.source') IS NULL
                OR json_extract(p.payload, '$.source') != 'subagent_notify')
           AND (p.ts < c_e.ts OR (p.ts = c_e.ts AND p.seq <= c_e.seq))) AS turn_index
        FROM checkpoints c
        LEFT JOIN events c_e ON c_e.id = c.event_id
       WHERE c.id = ?`,
  ).get(id) as Row | undefined;
  return r ? toCheckpoint(r) : undefined;
}

export function getCheckpointByEvent(db: Database, eventId: string): Checkpoint | undefined {
  const r = db.prepare('SELECT * FROM checkpoints WHERE event_id = ?').get(eventId) as Row | undefined;
  return r ? toCheckpoint(r) : undefined;
}

export function deleteCheckpoint(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
  return info.changes > 0;
}

export function setCheckpointCodeRef(db: Database, id: string, codeRef: string): void {
  db.prepare('UPDATE checkpoints SET code_ref = ? WHERE id = ?').run(codeRef, id);
}

export function updateCheckpoint(
  db: Database,
  id: string,
  patch: { label?: string | null; pinned?: boolean },
): Checkpoint | undefined {
  const existing = getCheckpoint(db, id);
  if (!existing) return undefined;
  const label = patch.label !== undefined ? patch.label : existing.label ?? null;
  const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : (existing.pinned ? 1 : 0);
  db.prepare('UPDATE checkpoints SET label = ?, pinned = ? WHERE id = ?').run(label, pinned, id);
  return getCheckpoint(db, id);
}

export function pinnedBoundaryEventIds(
  db: Database,
  conversationId: string,
): { eventId: string; ts: number; seq: number }[] {
  return db.prepare(
    `SELECT c.event_id AS eventId, e.ts, e.seq
       FROM checkpoints c
       JOIN events e ON e.id = c.event_id
      WHERE c.conversation_id = ? AND c.pinned = 1
      ORDER BY e.ts ASC, e.seq ASC`,
  ).all(conversationId) as { eventId: string; ts: number; seq: number }[];
}

export function deleteCheckpointsForConversation(db: Database, conversationId: string): void {
  db.prepare('DELETE FROM checkpoints WHERE conversation_id = ?').run(conversationId);
}
