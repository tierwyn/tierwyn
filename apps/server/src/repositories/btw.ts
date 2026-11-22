import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { BtwQuery } from '@tierwyn/shared';

interface BtwRow {
  id: string;
  parent_conv_id: string;
  child_conv_id: string | null;
  forked_conv_id: string | null;
  question: string;
  answer: string | null;
  status: string;
  agent_id: string;
  model: string | null;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
}

// ponytail: reuse the watcher's cheap length heuristic — no extra column, schema locked.
function toQuery(r: BtwRow): BtwQuery {
  const q: BtwQuery = {
    id: r.id,
    parentConvId: r.parent_conv_id,
    childConvId: r.child_conv_id,
    forkedConvId: r.forked_conv_id,
    question: r.question,
    answer: r.answer,
    status: r.status as BtwQuery['status'],
    agentId: r.agent_id,
    model: r.model,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
  if (q.status === 'done' && q.answer != null) {
    q.degenerate = q.answer.trim().length < 15;
  }
  return q;
}

export function insertBtw(
  db: Database,
  row: { id?: string; parentConvId: string; question: string; agentId: string; model?: string },
): BtwQuery {
  const id = row.id ?? randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO btw_queries
       (id, parent_conv_id, question, status, agent_id, model, created_at)
     VALUES (?, ?, ?, 'asking', ?, ?, ?)`,
  ).run(id, row.parentConvId, row.question, row.agentId, row.model ?? null, now);
  return toQuery({
    id,
    parent_conv_id: row.parentConvId,
    child_conv_id: null,
    forked_conv_id: null,
    question: row.question,
    answer: null,
    status: 'asking',
    agent_id: row.agentId,
    model: row.model ?? null,
    error_message: null,
    created_at: now,
    completed_at: null,
  });
}

// ponytail: no new writer after the sidecar BTW rewrite. child_conv_id is a
// sidebar-hide list for legacy ephemeral ⁇ btw: children only.
export function setBtwChild(db: Database, id: string, childConvId: string): void {
  db.prepare(`UPDATE btw_queries SET child_conv_id = ? WHERE id = ?`).run(childConvId, id);
}

export function setBtwFork(db: Database, id: string, convId: string): void {
  db.prepare(`UPDATE btw_queries SET forked_conv_id = ? WHERE id = ?`).run(convId, id);
}

export function completeBtw(
  db: Database,
  id: string,
  opts: { answer: string; model?: string },
): void {
  db.prepare(
    `UPDATE btw_queries
     SET status = 'done', answer = ?, model = COALESCE(?, model), completed_at = ?
     WHERE id = ?`,
  ).run(opts.answer, opts.model ?? null, Date.now(), id);
}

export function failBtw(db: Database, id: string, errorMessage: string): void {
  db.prepare(
    `UPDATE btw_queries
     SET status = 'error', error_message = ?, completed_at = ?
     WHERE id = ?`,
  ).run(errorMessage, Date.now(), id);
}

export function getBtw(db: Database, id: string): BtwQuery | undefined {
  const row = db.prepare(`SELECT * FROM btw_queries WHERE id = ?`).get(id) as BtwRow | undefined;
  return row ? toQuery(row) : undefined;
}

/** Newest-first for the drawer. */
export function listBtwForConversation(db: Database, parentConvId: string): BtwQuery[] {
  const rows = db
    .prepare(`SELECT * FROM btw_queries WHERE parent_conv_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(parentConvId) as BtwRow[];
  return rows.map(toQuery);
}

/**
 * Conversation ids that are ephemeral /btw answer-children.
 * Same set `listConversations` excludes so sidebar trees stay consistent.
 */
export function listBtwChildConversationIds(db: Database): Set<string> {
  const rows = db
    .prepare(`SELECT child_conv_id AS id FROM btw_queries WHERE child_conv_id IS NOT NULL`)
    .all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}
