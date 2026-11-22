import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { Summary } from '@tierwyn/shared';
import { listDescendants } from './conversations.js';

export function insertSummary(db: Database, s: Omit<Summary, 'id' | 'created_at'>): Summary {
  const row: Summary = { id: randomUUID(), created_at: Date.now(), ...s };
  // INSERT OR REPLACE: the UNIQUE(conversation_id, last_event_id) makes a re-compaction
  // at the same point overwrite rather than throw.
  db.prepare(
    `INSERT OR REPLACE INTO summaries (id, conversation_id, last_event_id, summary_text, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(row.id, row.conversation_id, row.last_event_id, row.summary_text, row.created_at);
  return row;
}

export function getLatestSummary(db: Database, conversationId: string): Summary | undefined {
  return db
    // rowid DESC tie-breaks summaries written in the same millisecond (Date.now() resolution).
    .prepare(`SELECT * FROM summaries WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(conversationId) as Summary | undefined;
}

export function listSummaries(db: Database, conversationId: string): Summary[] {
  return db
    .prepare(`SELECT * FROM summaries WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(conversationId) as Summary[];
}

/**
 * Summaries for `rootId` and ALL its descendants (root inclusive). Caller must
 * pass a validated root id (typically the output of getRootAncestor).
 *
 * Sort: `created_at ASC, rowid ASC` — SAME as listSummaries (oldest first,
 * timeline top-to-bottom). This DIFFERS from listTtsRecordingsForTree, which
 * is DESC by recency — do NOT copy-paste the sort from the recordings repo
 * here. A future reader normalising the two repos must keep summaries ASC.
 *
 * `hideBtw` is intentionally OFF — `/btw` answer-children are real
 * conversations that can hold summaries, and the user wants them included in
 * the tree view. Do not pass `{ hideBtw: true }` to listDescendants here.
 *
 * The ids are server-derived UUIDs from the conversations table (rootId +
 * listDescendants output), never user input. The placeholder string is built
 * from `ids.length` only; the ids themselves are bound as parameters via
 * `.all(...ids)`, never string-interpolated as literals — injection-safe by
 * construction.
 */
export function listSummariesForTree(db: Database, rootId: string): Summary[] {
  const ids = [rootId, ...listDescendants(db, rootId).map((c) => c.id)];
  if (ids.length === 0) return []; // defensive — rootId is always present
  const placeholders = ids.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT * FROM summaries
       WHERE conversation_id IN (${placeholders})
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...ids) as Summary[];
}

export function countSummaries(db: Database, conversationId: string): number {
  return (db
    .prepare(`SELECT COUNT(*) AS n FROM summaries WHERE conversation_id = ?`)
    .get(conversationId) as { n: number }).n;
}
