import type { Database, Statement } from 'better-sqlite3';
import type { SubtreeTimeSummary, SubtreeTimeNode } from '@tierwyn/shared';

export const MAX_NODES = 500; // ponytail: cap; raise or paginate if real trees exceed it
const MAX_DEPTH = 32;
const CACHE_MAX = 20_000; // sessions; ~100 B each → ~2 MB

interface CacheEntry {
  sig: string;
  workedMs: number;
  turns: number;
}

const sessionCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SubtreeTimeSummary>>();

/** Exported for tests. */
export function _resetSubtreeTimeCache(): void {
  sessionCache.clear();
  inflight.clear();
}

interface TreeRow {
  id: string;
  parent_id: string | null;
  depth: number;
  title: string;
}

interface SessionRow {
  id: string;
  conversation_id: string;
  n: number;
  max_ts: number | null;
}

interface ScanRow {
  worked_ms: number;
  turns: number;
}

interface PreparedStmts {
  treeStmt: Statement<[string], TreeRow>;
  sessionsStmt: Statement<[string], SessionRow>;
  scanStmt: Statement<[string], ScanRow>;
}

const dbStmts = new WeakMap<Database, PreparedStmts>();

function getStatements(db: Database): PreparedStmts {
  let stmts = dbStmts.get(db);
  if (!stmts) {
    stmts = {
      treeStmt: db.prepare(`
        WITH RECURSIVE tree(id, parent_id, depth) AS (
          SELECT id, NULL, 0 FROM conversations WHERE id = ?
          UNION
          SELECT c.id, c.parent_conversation_id, t.depth + 1
            FROM conversations c JOIN tree t ON c.parent_conversation_id = t.id
           WHERE t.depth < ${MAX_DEPTH}
             AND c.id NOT IN (SELECT child_conv_id FROM btw_queries WHERE child_conv_id IS NOT NULL)
        )
        SELECT t.id, t.parent_id, t.depth, c.title FROM tree t JOIN conversations c ON c.id = t.id
        ORDER BY t.depth, c.created_at
      `) as Statement<[string], TreeRow>,
      sessionsStmt: db.prepare(`
        SELECT s.id, s.conversation_id,
               (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS n,
               (SELECT MAX(ts)  FROM events e WHERE e.session_id = s.id) AS max_ts
          FROM sessions s WHERE s.conversation_id IN (SELECT value FROM json_each(?))
      `) as Statement<[string], SessionRow>,
      // Worked = sum of gaps between consecutive events in a turn, skipping gaps
      // while an interaction_request (question/approval card) is unresolved and
      // gaps that start at a done/error/idle status.
      scanStmt: db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN pending <= 0 AND settled = 0 THEN MAX(next_ts - ts, 0) ELSE 0 END), 0) AS worked_ms,
               COUNT(DISTINCT turn) AS turns FROM (
          SELECT ts, turn, settled,
                 LEAD(ts) OVER (PARTITION BY turn ORDER BY ts, seq) AS next_ts,
                 SUM(CASE type WHEN 'interaction_request' THEN 1 WHEN 'interaction_resolved' THEN -1 ELSE 0 END)
                   OVER (PARTITION BY turn ORDER BY ts, seq ROWS UNBOUNDED PRECEDING) AS pending
            FROM (
              SELECT e.ts, e.seq, e.type,
                     -- gap after done/error/idle is post-turn dead time (late idle on park), not work
                     CASE WHEN e.type = 'status' AND json_valid(e.payload)
                               AND json_extract(e.payload, '$.status') IN ('done', 'error', 'idle')
                          THEN 1 ELSE 0 END AS settled,
                     SUM(e.type = 'prompt') OVER (ORDER BY e.ts, e.seq ROWS UNBOUNDED PRECEDING) AS turn
                FROM events e WHERE e.session_id = ? AND e.type != 'helper'
            )
           WHERE turn > 0
        )
      `) as Statement<[string], ScanRow>,
    };
    dbStmts.set(db, stmts);
  }
  return stmts;
}

// ponytail: a single session with roughly 500 k or more events would block for about 1 s per cold scan. The upgrade path is a keyset-paged scan of that one session, carrying the open turn's start and max across pages with a yield between pages.

/** Async; yields to the event loop after every cache-miss scan. Concurrent calls
 *  for the same root share one promise. */
export function computeSubtreeTime(
  db: Database,
  rootId: string,
  options?: { maxNodes?: number },
): Promise<SubtreeTimeSummary> {
  const maxNodes = options?.maxNodes ?? MAX_NODES;
  const inflightKey = `${rootId}:${maxNodes}`;
  const existing = inflight.get(inflightKey);
  if (existing) return existing;

  const promise = (async () => {
    const { treeStmt, sessionsStmt, scanStmt } = getStatements(db);
    const rows = treeStmt.all(rootId);
    const seen = new Set<string>();
    const uniq = rows.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));

    if (uniq.length === 0) {
      return {
        rootConversationId: rootId,
        selfMs: 0,
        descendantsMs: 0,
        totalMs: 0,
        descendantCount: 0,
        truncated: false,
        omittedCount: 0,
        nodes: [],
        computedAt: Date.now(),
      };
    }

    const limit = maxNodes + 1;
    const truncated = uniq.length > limit;
    const keptRows = truncated ? uniq.slice(0, limit) : uniq;
    const omittedCount = uniq.length - keptRows.length;

    const keptIds = keptRows.map((r) => r.id);
    const sessionRows = sessionsStmt.all(JSON.stringify(keptIds));

    interface NodeStats {
      workedMs: number;
      turns: number;
      lastEventTs: number | null;
    }

    const convStats = new Map<string, NodeStats>();

    for (const s of sessionRows) {
      const sig = `${s.n}:${s.max_ts}`;
      let workedMs = 0;
      let turns = 0;

      const cached = sessionCache.get(s.id);
      if (cached && cached.sig === sig) {
        workedMs = cached.workedMs;
        turns = cached.turns;
        sessionCache.delete(s.id);
        sessionCache.set(s.id, cached);
      } else {
        const scan = scanStmt.get(s.id);
        workedMs = Number(scan?.worked_ms) || 0;
        turns = Number(scan?.turns) || 0;

        const entry: CacheEntry = { sig, workedMs, turns };
        sessionCache.delete(s.id);
        sessionCache.set(s.id, entry);
        while (sessionCache.size > CACHE_MAX) {
          const oldestKey = sessionCache.keys().next().value;
          if (oldestKey !== undefined) {
            sessionCache.delete(oldestKey);
          } else {
            break;
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      let stats = convStats.get(s.conversation_id);
      if (!stats) {
        stats = { workedMs: 0, turns: 0, lastEventTs: null };
        convStats.set(s.conversation_id, stats);
      }
      stats.workedMs += workedMs;
      stats.turns += turns;
      if (s.max_ts != null) {
        stats.lastEventTs = stats.lastEventTs == null ? s.max_ts : Math.max(stats.lastEventTs, s.max_ts);
      }
    }

    const nodes: SubtreeTimeNode[] = keptRows.map((r, idx) => {
      const stats = convStats.get(r.id) ?? { workedMs: 0, turns: 0, lastEventTs: null };
      return {
        conversationId: r.id,
        parentConversationId: idx === 0 ? null : (r.parent_id ?? null),
        title: r.title,
        depth: r.depth,
        workedMs: stats.workedMs,
        turns: stats.turns,
        lastEventTs: stats.lastEventTs,
      };
    });

    const rootNode = nodes[0];
    const selfMs = rootNode ? rootNode.workedMs : 0;
    let descendantsMs = 0;
    for (let i = 1; i < nodes.length; i++) {
      descendantsMs += nodes[i].workedMs;
    }
    const totalMs = selfMs + descendantsMs;
    const descendantCount = nodes.length > 0 ? nodes.length - 1 : 0;

    return {
      rootConversationId: rootId,
      selfMs,
      descendantsMs,
      totalMs,
      descendantCount,
      truncated,
      omittedCount,
      nodes,
      computedAt: Date.now(),
    };
  })();

  inflight.set(inflightKey, promise);
  promise
    .finally(() => {
      inflight.delete(inflightKey);
    })
    .catch(() => {});
  return promise;
}
