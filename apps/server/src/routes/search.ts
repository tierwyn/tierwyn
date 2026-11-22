import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { centerSnippet, literalTokens, turnText } from '../searchSnippets.js';

export interface ConversationSearchMatch {
  eventId: string;
  snippet: string;
  ts: number;
  sender: 'user' | 'agent' | 'system' | 'helper';
}

/** One conversation that has at least one matching prompt/message document.
 *  `eventId`/`snippet` describe the most recent matching event in it (FW-12). */
export interface ConversationSearchHit {
  id: string;
  projectId: string;
  title: string;
  updatedAt: number;
  /** events.id (UUID) of the winning matched row — NOT the FTS rowid. */
  eventId: string;
  /** <=160 chars of that row's own payload text; '' when it holds none. */
  snippet: string;
  /** Present only when the request named `matchesPerConversation`. Newest first. */
  matches?: ConversationSearchMatch[];
}

/** Snippet cap. Long enough to recognise the turn in a tooltip, short enough
 *  that 50 hits stay a small JSON body. */
const SNIPPET_CHARS = 160;

const MAX_LIMIT = 50;

/**
 * Turn a raw sidebar string into a safe FTS5 MATCH expression.
 *
 * Users type prose, not FTS5 syntax. Unescaped input throws SQLITE_ERROR on `"` (unterminated
 * string), `-` (parsed as a column filter), bare AND/OR/NOT/NEAR (syntax error) and `*`
 * (unknown special query) — all verified. Every non-alphanumeric run is reduced to
 * a space and each token is wrapped as a quoted phrase, which makes operators inert. The last
 * token gets `*` so as-you-type prefixes match ("regen" finds "regenerate").
 *
 * Returns null when nothing indexable remains — the caller answers 400.
 */
export function toMatchQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').replace(/[^\p{L}\p{N}_]+/gu, ' ').trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ');
}

interface SearchRow {
  conversationId: string;
  projectId: string;
  title: string;
  updatedAt: number;
  eventId: string;
  type: string;
  sender: string;
  ts: number;
  sessionId: string;
  seq: number;
  payload: string;
  rn: number;
}

export function searchConversations(
  db: Database,
  match: string,
  opts: { projectId?: string; limit: number; matchesPerConversation?: number; tokens?: string[] },
): ConversationSearchHit[] {
  // FW-12: ROW_NUMBER() still yields ranked matching events per conversation so the
  // client can scroll to the newest one. Ordered ts DESC (what "most recent" means
  // everywhere else in the app) with rowid DESC as the tiebreak, because streaming
  // chunks share a millisecond. Filters live INSIDE the CTE so ranking never
  // considers rows we are about to drop.
  //
  // ponytail: the snippet is reconstructed and centred in JS. event_fts is contentless
  // (migration 109) so snippet() is unavailable. Ceiling: limit × N reconstruct queries
  // of ≤400 rows each (≤250 at the clamps). Upgrade path is a per-turn text column,
  // NOT a contentful FTS rebuild (+48 MB).
  //
  // D7 (FW-6): exclude schedule_home — not a chat whitelist, a future third kind stays
  // searchable.
  const n = opts.matchesPerConversation ?? 1;
  const tokens = opts.tokens ?? [];
  const includeMatches = opts.matchesPerConversation !== undefined;
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT c.id         AS conversationId,
                c.project_id AS projectId,
                c.title      AS title,
                c.updated_at AS updatedAt,
                e.id         AS eventId,
                e.type       AS type,
                e.sender     AS sender,
                e.ts         AS ts,
                e.session_id AS sessionId,
                e.seq        AS seq,
                e.payload    AS payload,
                ROW_NUMBER() OVER (PARTITION BY s.conversation_id
                                   ORDER BY e.ts DESC, e.rowid DESC) AS rn
           FROM event_fts f
           JOIN events e        ON e.rowid = f.rowid
           JOIN sessions s      ON s.id = e.session_id
           JOIN conversations c ON c.id = s.conversation_id
          WHERE f.event_fts MATCH ?
            AND c.kind <> 'schedule_home'
            AND (? IS NULL OR c.project_id = ?)
       ),
       capped AS (SELECT * FROM ranked WHERE rn <= ?),
       conv_rank AS (
         SELECT conversationId, MAX(updatedAt) AS updatedAt
           FROM capped GROUP BY conversationId
          ORDER BY updatedAt DESC LIMIT ?
       )
       SELECT capped.* FROM capped
         JOIN conv_rank ON conv_rank.conversationId = capped.conversationId
        ORDER BY conv_rank.updatedAt DESC, capped.rn ASC`,
    )
    .all(match, opts.projectId ?? null, opts.projectId ?? null, n, opts.limit) as SearchRow[];

  const order: string[] = [];
  const map = new Map<string, ConversationSearchHit>();
  for (const row of rows) {
    const snippet = centerSnippet(turnText(db, row), tokens, SNIPPET_CHARS);
    const sender: ConversationSearchMatch['sender'] =
      row.type === 'helper' ? 'helper'
      : row.sender === 'user' || row.sender === 'agent' || row.sender === 'system' ? row.sender
      : 'agent';
    const matchRow: ConversationSearchMatch = {
      eventId: row.eventId,
      snippet,
      ts: row.ts,
      sender,
    };
    let hit = map.get(row.conversationId);
    if (!hit) {
      hit = {
        id: row.conversationId,
        projectId: row.projectId,
        title: row.title,
        updatedAt: row.updatedAt,
        eventId: matchRow.eventId,
        snippet: matchRow.snippet,
      };
      if (includeMatches) hit.matches = [matchRow];
      map.set(row.conversationId, hit);
      order.push(row.conversationId);
    } else if (includeMatches) {
      hit.matches!.push(matchRow);
    }
  }
  return order.map((id) => map.get(id)!);
}

export function registerSearchRoutes(app: Express, getDb: () => Database): void {
  app.get('/conversations/search', (req, res) => {
    const raw = typeof req.query.q === 'string' ? req.query.q : '';
    const match = toMatchQuery(raw);
    if (match === null) {
      res.status(400).json({ error: 'q required' });
      return;
    }
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId
      ? req.query.projectId
      : undefined;
    const parsed = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : MAX_LIMIT;
    const mpcRaw = Number.parseInt(String(req.query.matchesPerConversation ?? ''), 10);
    const matchesPerConversation = Number.isFinite(mpcRaw)
      ? Math.min(5, Math.max(1, mpcRaw))
      : undefined;
    const tokens = literalTokens(raw);

    try {
      res.json(searchConversations(getDb(), match, { projectId, limit, matchesPerConversation, tokens }));
    } catch (err) {
      // Defense in depth: toMatchQuery should make MATCH errors impossible, but a malformed
      // expression must degrade to "no results", never a 500 that breaks the sidebar.
      console.warn('[search] MATCH failed:', err instanceof Error ? err.message : err);
      res.json([]);
    }
  });
}
