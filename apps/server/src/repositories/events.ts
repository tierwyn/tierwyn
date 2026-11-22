import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { TranscriptEvent } from '@tierwyn/shared';
import { redactAll } from '../secrets/redactAll.js';

interface AppendInput {
  sessionId: string;
  type: string;
  payload: unknown;
  sender: 'user' | 'agent' | 'system';
  agentModelId?: string;
  seq?: number;
  ts?: number;
}

interface Row {
  id: string; session_id: string; type: string; payload: string;
  sender: string; agent_model_id: string | null; seq: number; ts: number;
}

function toEvent(r: Row): TranscriptEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    type: r.type as TranscriptEvent['type'],
    payload: JSON.parse(r.payload),
    sender: r.sender as TranscriptEvent['sender'],
    agentProfileId: r.agent_model_id ?? undefined,
    seq: r.seq,
    ts: r.ts,
  };
}

export function appendEvent(db: Database, input: AppendInput): TranscriptEvent {
  const row: Row = {
    id: randomUUID(),
    session_id: input.sessionId,
    type: input.type,
    // ponytail: scrub any live spawn/run token before persist so it never lands in the
    // DB file / REST transcript (LAN + VPN = other humans can read it). The tick prompt
    // bakes the run token in cleartext (schedules/prompt.ts footer) so this is the only
    // choke point that redacts it out of the stored 'prompt' event.
    // MCP secret values (vault + TIERWYN_MCP_* env) are scrubbed here too.
    payload: redactAll(JSON.stringify(input.payload ?? {})),
    sender: input.sender,
    agent_model_id: input.agentModelId ?? null,
    seq: input.seq ?? 0,
    ts: input.ts ?? Date.now(),
  };
  db.prepare(
    `INSERT INTO events (id, session_id, type, payload, sender, agent_model_id, seq, ts)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(row.id, row.session_id, row.type, row.payload, row.sender, row.agent_model_id, row.seq, row.ts);
  return toEvent(row);
}

export function listEventsForSession(db: Database, sessionId: string): TranscriptEvent[] {
  return (db.prepare(
    'SELECT * FROM events WHERE session_id = ? ORDER BY ts ASC, seq ASC'
  ).all(sessionId) as Row[]).map(toEvent);
}

export function listEventsForConversation(db: Database, conversationId: string): TranscriptEvent[] {
  return (db.prepare(
    `SELECT e.* FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?
      ORDER BY e.ts ASC, e.seq ASC`
  ).all(conversationId) as Row[]).map(toEvent);
}

export function listEventsForConversationPage(
  db: Database,
  conversationId: string,
  options: { tailTurns: number; before?: string },
): { events: TranscriptEvent[]; hasMore: boolean; cursor?: string } {
  const tailTurns = Math.max(1, Math.floor(options.tailTurns));

  let beforeTs: number | undefined;
  let beforeSeq: number | undefined;
  if (options.before) {
    const parts = options.before.split(':');
    if (parts.length === 2) {
      beforeTs = Number(parts[0]);
      beforeSeq = Number(parts[1]);
    }
  }

  const hasBefore = beforeTs !== undefined && !Number.isNaN(beforeTs) && beforeSeq !== undefined && !Number.isNaN(beforeSeq);

  const boundarySql = hasBefore
    ? `SELECT e.ts, e.seq FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.conversation_id = ?
          AND e.type = 'prompt'
          AND (e.ts < ? OR (e.ts = ? AND e.seq < ?))
        ORDER BY e.ts DESC, e.seq DESC
        LIMIT 1 OFFSET ?`
    : `SELECT e.ts, e.seq FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.conversation_id = ?
          AND e.type = 'prompt'
        ORDER BY e.ts DESC, e.seq DESC
        LIMIT 1 OFFSET ?`;

  const boundaryParams = hasBefore
    ? [conversationId, beforeTs, beforeTs, beforeSeq, tailTurns - 1]
    : [conversationId, tailTurns - 1];

  const boundary = db.prepare(boundarySql).get(...boundaryParams) as { ts: number; seq: number } | undefined;

  if (boundary) {
    const pageSql = hasBefore
      ? `SELECT e.* FROM events e
           JOIN sessions s ON s.id = e.session_id
          WHERE s.conversation_id = ?
            AND (e.ts > ? OR (e.ts = ? AND e.seq >= ?))
            AND (e.ts < ? OR (e.ts = ? AND e.seq < ?))
          ORDER BY e.ts ASC, e.seq ASC`
      : `SELECT e.* FROM events e
           JOIN sessions s ON s.id = e.session_id
          WHERE s.conversation_id = ?
            AND (e.ts > ? OR (e.ts = ? AND e.seq >= ?))
          ORDER BY e.ts ASC, e.seq ASC`;

    const pageParams = hasBefore
      ? [conversationId, boundary.ts, boundary.ts, boundary.seq, beforeTs, beforeTs, beforeSeq]
      : [conversationId, boundary.ts, boundary.ts, boundary.seq];

    const rows = db.prepare(pageSql).all(...pageParams) as Row[];
    const events = rows.map(toEvent);

    const hasMoreSql = `SELECT 1 FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?
        AND (e.ts < ? OR (e.ts = ? AND e.seq < ?))
      LIMIT 1`;
    const hasMoreRow = db.prepare(hasMoreSql).get(conversationId, boundary.ts, boundary.ts, boundary.seq);
    const hasMore = Boolean(hasMoreRow);
    const cursor = `${boundary.ts}:${boundary.seq}`;

    return { events, hasMore, cursor };
  }

  const pageSql = hasBefore
    ? `SELECT e.* FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.conversation_id = ?
          AND (e.ts < ? OR (e.ts = ? AND e.seq < ?))
        ORDER BY e.ts ASC, e.seq ASC`
    : `SELECT e.* FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.conversation_id = ?
        ORDER BY e.ts ASC, e.seq ASC`;

  const pageParams = hasBefore
    ? [conversationId, beforeTs, beforeTs, beforeSeq]
    : [conversationId];

  const rows = db.prepare(pageSql).all(...pageParams) as Row[];
  const events = rows.map(toEvent);
  const cursor = events.length > 0 ? `${events[0].ts}:${events[0].seq}` : undefined;

  return { events, hasMore: false, cursor };
}

/** Shell tool_calls with no matching tool_result (matched by toolUseId across the
 *  whole events table — a result may live in a later session than its call).
 *  Used by the boot reconciliation to synthesize a result for commands whose
 *  process died with the server before child.on('close') could settle them. */
export function listOrphanShellToolCalls(
  db: Database,
): { toolUseId: string; conversationId: string }[] {
  return db.prepare(
    `SELECT
       json_extract(c.payload,'$.toolUseId') AS toolUseId,
       s.conversation_id                      AS conversationId
     FROM events c
     JOIN sessions s ON s.id = c.session_id
     WHERE c.type = 'tool_call'
       AND c.sender = 'user'
       AND json_extract(c.payload,'$.name') = 'shell'
       AND json_extract(c.payload,'$.toolUseId') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM events r
         WHERE r.type = 'tool_result'
           AND json_extract(r.payload,'$.toolUseId') = json_extract(c.payload,'$.toolUseId')
       )`,
  ).all() as { toolUseId: string; conversationId: string }[];
}

export function getEvent(db: Database, id: string): TranscriptEvent | null {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
  return row ? toEvent(row) : null;
}

/** Latest event (by ts DESC, seq DESC) for a conversation — used to anchor a pre-restore checkpoint. */
export function latestEventForConversation(
  db: Database,
  conversationId: string,
): { id: string; sessionId: string } | null {
  const row = db.prepare(
    `SELECT e.id, e.session_id AS sessionId
       FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?
      ORDER BY e.ts DESC, e.seq DESC
      LIMIT 1`,
  ).get(conversationId) as { id: string; sessionId: string } | undefined;
  return row ?? null;
}

/** Text of the newest `prompt` event in a conversation. The Grok Bot watcher uses it
 *  to suppress the replica echo of a prompt Tierwyn itself just sent. */
export function latestPromptTextForConversation(
  db: Database,
  conversationId: string,
): string | null {
  const row = db.prepare(
    `SELECT json_extract(e.payload, '$.text') AS text
       FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ? AND e.type = 'prompt'
      ORDER BY e.ts DESC, e.seq DESC
      LIMIT 1`,
  ).get(conversationId) as { text: string | null } | undefined;
  return row?.text ?? null;
}

/** Newest assistant prose for a conversation, bounded. Prefers the latest `final` message
 *  without a spawnMarker; else concatenates the newest message chunks. Already redacted at append. */
export function lastAssistantText(db: Database, conversationId: string): string | null {
  const rows = db.prepare(
    `SELECT json_extract(e.payload, '$.chunk') AS chunk,
            json_extract(e.payload, '$.text') AS text,
            json_extract(e.payload, '$.final') AS final,
            json_extract(e.payload, '$.spawnMarker') AS spawnMarker
       FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ? AND e.type = 'message'
      ORDER BY e.ts DESC, e.seq DESC
      LIMIT 50`,
  ).all(conversationId) as { chunk: unknown; text: unknown; final: unknown; spawnMarker: unknown }[];
  const textOf = (r: (typeof rows)[number]): string =>
    typeof r.chunk === 'string' && r.chunk.trim() ? r.chunk
      : typeof r.text === 'string' && r.text.trim() ? r.text : '';
  const final = rows.find((r) => r.final === 1 && r.spawnMarker == null && textOf(r));
  if (final) return textOf(final);
  const joined = rows.map(textOf).filter(Boolean).reverse().join('');
  return joined || null;
}

export function updateEvent(db: Database, eventId: string, newPayload: unknown): TranscriptEvent | null {
  const event = getEvent(db, eventId);
  if (!event) return null;

  if (event.type === 'message') {
    db.transaction(() => {
      db.prepare(
        "DELETE FROM events WHERE session_id = ? AND type = 'message' AND id != ?"
      ).run(event.sessionId, eventId);
      db.prepare(
        'UPDATE events SET payload = ? WHERE id = ?'
      ).run(JSON.stringify(newPayload), eventId);
    })();
  } else {
    db.prepare(
      'UPDATE events SET payload = ? WHERE id = ?'
    ).run(JSON.stringify(newPayload), eventId);
  }

  return getEvent(db, eventId);
}

export function deleteEvent(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM events WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Delete a specific set of events by id (NOT a truncate-by-anchored-ts). Used by
 * v2 surgical single-turn delete: the client sends the exact event ids of the
 * deleted turn (prompt + reply + any tool events) and we remove exactly those,
 * leaving turns before and after intact. Returns the number of rows deleted.
 *
 * Caller is responsible for validating that the ids all belong to the same
 * conversation before calling (the route does this). An empty input is a no-op.
 */
export function deleteTurnEventsByIds(db: Database, eventIds: string[]): number {
  if (eventIds.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM events WHERE id = ?');
  let deleted = 0;
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      deleted += stmt.run(id).changes;
    }
  });
  tx(eventIds);
  return deleted;
}
