import type { Database } from 'better-sqlite3';
import {
  formatMemoryId,
  parseMemoryId,
  MEMORY_LIMITS,
  type MemoryDto,
  type MemoryCounts,
  type MemoryFlagCategory,
  type MemoryKind,
  type MemoryRuleSuggestion,
  type MemoryStatus,
} from '@tierwyn/shared';
import { toMatchQuery } from '../routes/search.js';

/** Visible to agents (recall + search) and to the default operator list. */
export const MEMORY_VISIBLE_SQL = `status = 'active' AND COALESCE(rule_suggestion,'') <> 'promoted'`;

export interface SaveInput {
  projectId: string;
  kind: MemoryKind;
  text: string;
  suggestRule?: boolean;
  ruleReason?: string | null;
  agent: string | null;
  conversationId: string | null;
  now: number;
}

export interface RankedMemory {
  id: number;
  kind: MemoryKind;
  text: string;
  createdAt: number;
  score: number;
  hits: number;
}

export interface ListOpts {
  view: 'all' | 'suggestions' | 'flagged';
  projectId?: string;
  q?: string;
  includeSuperseded?: boolean;
  limit: number;
}

interface MemoryRow {
  id: number;
  project_id: string;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  superseded_by: number | null;
  rule_suggestion: MemoryRuleSuggestion | null;
  rule_reason: string | null;
  flag_reason: MemoryFlagCategory | null;
  created_by_agent: string | null;
  created_by_conversation: string | null;
  created_at: number;
  title?: string | null;
}

const SELECT_WITH_TITLE = `
  SELECT m.*, c.title
  FROM memories m
  LEFT JOIN conversations c ON c.id = m.created_by_conversation
`;

function toDto(r: MemoryRow): MemoryDto {
  return {
    id: formatMemoryId(r.id),
    projectId: r.project_id,
    kind: r.kind,
    text: r.text,
    status: r.status,
    supersededBy: r.superseded_by != null ? formatMemoryId(r.superseded_by) : null,
    ruleSuggestion: r.rule_suggestion,
    ruleReason: r.rule_reason,
    flagReason: r.flag_reason,
    createdByAgent: r.created_by_agent,
    createdByConversation: r.created_by_conversation,
    createdByConversationTitle: r.title ?? null,
    createdAt: r.created_at,
  };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it',
  'this', 'that', 'with', 'from', 'at', 'by', 'as', 'be', 'are', 'was', 'were',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'not', 'no', 'nor', 'so', 'if',
  'then', 'than', 'too', 'very', 'just', 'also', 'only', 'but', 'about', 'into',
  'over', 'after', 'before', 'between', 'through', 'during', 'without', 'within',
  'because', 'while', 'when', 'where', 'who', 'what', 'which', 'how', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
  'own', 'same',
  'add', 'fix', 'run', 'new', 'check', 'use', 'make', 'need',
]);

/** Lowercased, no stopwords or words under 3 chars, plural-deduped, first 30 kept. */
export function extractRecallKeywords(text: string): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    // ponytail: crude stem dedupe; 'routes'+'routing' still counts as 2 words. Harmless false positive, use fts5vocab if the chips show it matters
    const stem = word.replace(/s$/, '');
    if (seen.has(stem)) continue;
    seen.add(stem);
    kept.push(word);
    if (kept.length >= 30) break;
  }
  return kept;
}

export function ftsRowCount(db: Database): number {
  const row = db.prepare('SELECT count(*) AS c FROM memories_fts').get() as { c: number };
  return row.c;
}

export function getMemory(db: Database, id: number): MemoryDto | undefined {
  const r = db.prepare(`${SELECT_WITH_TITLE} WHERE m.id = ?`).get(id) as MemoryRow | undefined;
  return r ? toDto(r) : undefined;
}

export function saveMemory(db: Database, i: SaveInput): { memory: MemoryDto; ruleSuggestion: 'pending' | 'rejected' | null } {
  return db.transaction(() => {
    let ruleSuggestion: 'pending' | 'rejected' | null = null;
    let stored: MemoryRuleSuggestion | null = null;
    let reason: string | null = null;
    if (i.suggestRule) {
      const pending = db.prepare(
        `SELECT count(*) AS c FROM memories
         WHERE project_id = ? AND rule_suggestion = 'pending' AND status <> 'superseded'`,
      ).get(i.projectId) as { c: number };
      if (pending.c >= MEMORY_LIMITS.pendingSuggestionsPerProject) {
        ruleSuggestion = 'rejected';
      } else {
        ruleSuggestion = 'pending';
        stored = 'pending';
        reason = i.ruleReason ?? null;
      }
    }
    const info = db.prepare(
      `INSERT INTO memories
         (project_id, kind, text, status, rule_suggestion, rule_reason,
          created_by_agent, created_by_conversation, created_at)
       VALUES (?,?,?,'active',?,?,?,?,?)`,
    ).run(
      i.projectId, i.kind, i.text, stored, reason,
      i.agent, i.conversationId, i.now,
    );
    const memory = getMemory(db, Number(info.lastInsertRowid))!;
    return { memory, ruleSuggestion };
  })();
}

export function searchVisibleMemories(
  db: Database,
  projectId: string,
  keywords: string[],
  limit: number,
): RankedMemory[] {
  if (keywords.length === 0 || limit <= 0) return [];
  const match = keywords.map((k) => `"${k}"`).join(' OR ');
  const rows = db.prepare(
    `SELECT m.id, m.kind, m.text, m.created_at AS createdAt, -bm25(memories_fts) AS score
     FROM memories_fts
     JOIN memories m ON m.id = memories_fts.rowid
     WHERE memories_fts MATCH ?
       AND m.project_id = ?
       AND ${MEMORY_VISIBLE_SQL}
     ORDER BY score DESC
     LIMIT ?`,
  ).all(match, projectId, limit) as Array<{
    id: number; kind: MemoryKind; text: string; createdAt: number; score: number;
  }>;
  // Don't use `rowid = ? AND MATCH ?`: FTS5 drops the rowid filter when better-sqlite3
  // binds a JS number, so every row scored as matching any word in the corpus.
  const hitStmt = db.prepare(`SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?`);
  const matched = keywords.map((k) => new Set((hitStmt.all(`"${k}"`) as Array<{ id: number }>).map((h) => h.id)));
  return rows.map((r) => ({
    ...r,
    hits: matched.reduce((n, s) => n + (s.has(r.id) ? 1 : 0), 0),
  }));
}

/** Recall scoring: term rarity within this project's visible memories only.
 *  w(word) = ln(1 + N/df) / ln(1 + N): 1.0 for a word in exactly one project memory, -> ln2/ln(1+N) for a word in all.
 *  Same scale for any N, so a floor of 2 means "about two project-unique words" in a 1-row or a 40-row project. */
export function scoreProjectMemories(db: Database, projectId: string, keywords: string[]): RankedMemory[] {
  if (keywords.length === 0) return [];
  const visible = db.prepare(
    `SELECT id, kind, text, created_at AS createdAt FROM memories WHERE project_id = ? AND ${MEMORY_VISIBLE_SQL}`,
  ).all(projectId) as Array<{ id: number; kind: MemoryKind; text: string; createdAt: number }>;
  const N = visible.length;
  if (N === 0) return [];
  const byId = new Map(visible.map((r) => [r.id, r]));
  // Same rowid-binding caveat as searchVisibleMemories: match first, filter in JS.
  const hitStmt = db.prepare(`SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?`);
  const acc = new Map<number, { hits: number; score: number }>();
  const norm = Math.log(1 + N);
  for (const k of keywords) {
    const ids = (hitStmt.all(`"${k}"`) as Array<{ id: number }>).map((h) => h.id).filter((id) => byId.has(id));
    if (ids.length === 0) continue;
    const w = Math.log(1 + N / ids.length) / norm;
    for (const id of ids) {
      const a = acc.get(id) ?? { hits: 0, score: 0 };
      a.hits += 1; a.score += w;
      acc.set(id, a);
    }
  }
  return [...acc.entries()]
    .map(([id, a]) => ({ ...byId.get(id)!, ...a }))
    .sort((x, y) => y.score - x.score || y.createdAt - x.createdAt);
}

export function supersedeMemory(
  db: Database,
  projectId: string,
  id: number,
  by: number,
): 'ok' | 'not_found' | 'conflict' {
  if (id === by) return 'conflict';
  const old = db.prepare('SELECT id, project_id, status FROM memories WHERE id = ?').get(id) as
    | { id: number; project_id: string; status: MemoryStatus } | undefined;
  if (!old || old.project_id !== projectId) return 'not_found';
  if (old.status !== 'active') return 'conflict';
  const target = db.prepare(
    `SELECT id, project_id, status, rule_suggestion FROM memories WHERE id = ?`,
  ).get(by) as
    | { id: number; project_id: string; status: MemoryStatus; rule_suggestion: string | null } | undefined;
  if (!target || target.project_id !== projectId) return 'not_found';
  const visible = target.status === 'active' && (target.rule_suggestion ?? '') !== 'promoted';
  if (!visible) return 'conflict';
  db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?`).run(by, id);
  return 'ok';
}

/** Operator correction: a new operator-authored row supersedes the old one, so the
 *  original stays visible under "Show superseded" and Approve restores it. */
export function editMemory(
  db: Database,
  id: number,
  text: string,
  now: number,
): MemoryDto | 'not_found' | 'conflict' {
  return db.transaction(() => {
    const old = db.prepare('SELECT project_id, kind, status FROM memories WHERE id = ?').get(id) as
      | { project_id: string; kind: MemoryKind; status: MemoryStatus } | undefined;
    if (!old) return 'not_found' as const;
    if (old.status !== 'active') return 'conflict' as const;
    const { memory } = saveMemory(db, {
      projectId: old.project_id, kind: old.kind, text, agent: 'operator', conversationId: null, now,
    });
    const by = parseMemoryId(memory.id)!;
    db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?`).run(by, id);
    return memory;
  })();
}

export function listMemories(db: Database, o: ListOpts): MemoryDto[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (o.projectId) {
    where.push('m.project_id = ?');
    params.push(o.projectId);
  }
  if (o.view === 'suggestions') {
    where.push(`m.rule_suggestion = 'pending' AND m.status <> 'superseded'`);
  } else if (o.view === 'flagged') {
    where.push(`m.status = 'flagged'`);
  } else if (!o.includeSuperseded) {
    where.push(`m.status <> 'superseded'`);
  }
  if (o.q) {
    const match = toMatchQuery(o.q);
    if (match) {
      where.push(`m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)`);
      params.push(match);
    }
  }
  const sql = `${SELECT_WITH_TITLE}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY m.created_at DESC
    LIMIT ?`;
  params.push(o.limit);
  return (db.prepare(sql).all(...params) as MemoryRow[]).map(toDto);
}

export function countMemories(db: Database): MemoryCounts {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN rule_suggestion = 'pending' AND status <> 'superseded' THEN 1 ELSE 0 END), 0) AS pendingSuggestions,
       COALESCE(SUM(CASE WHEN status = 'flagged' THEN 1 ELSE 0 END), 0) AS flagged
     FROM memories`,
  ).get() as MemoryCounts;
  return { pendingSuggestions: row.pendingSuggestions, flagged: row.flagged };
}

export function deleteMemory(db: Database, id: number): boolean {
  const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return info.changes > 0;
}

export function activateMemory(db: Database, id: number): boolean {
  const info = db.prepare(
    `UPDATE memories SET status = 'active', superseded_by = NULL, flag_reason = NULL
     WHERE id = ? AND status IN ('flagged','superseded')`,
  ).run(id);
  return info.changes > 0;
}

export function resolveSuggestion(db: Database, id: number, to: 'promoted' | 'dismissed'): boolean {
  const info = db.prepare(
    `UPDATE memories SET rule_suggestion = ? WHERE id = ? AND rule_suggestion = 'pending'`,
  ).run(to, id);
  return info.changes > 0;
}

export function flagMemory(db: Database, id: number, category: MemoryFlagCategory): boolean {
  const info = db.prepare(
    `UPDATE memories SET status = 'flagged', flag_reason = ? WHERE id = ? AND status = 'active'`,
  ).run(category, id);
  return info.changes > 0;
}
