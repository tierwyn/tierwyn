import type { Database } from 'better-sqlite3';
import { mkdirSync, existsSync, statSync, openSync, appendFileSync, closeSync, unlinkSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import type { RetentionStats } from '@tierwyn/shared';
import { freeBytesFor } from './backups.js';
import { deleteConversation } from './conversations.js';
import { unlinkTtsWavPaths } from './ttsRecordings.js';

export interface PurgeCandidate {
  id: string;
  title: string;
  updatedAt: number;
}

export interface PurgeResult {
  /** Conversations deleted (roots only — descendants cascade). */
  deletedIds: string[];
  /** Candidates skipped because a live/parked session held them. */
  skippedLive: string[];
  /** Bytes of the DB file at pass start. After a skipped VACUUM, bytesAfter equals this. */
  bytesBefore: number;
  bytesAfter: number;
  /** Total rows removed from the events table (descendants included). */
  eventsDeleted: number;
  /** Candidates not processed because maxConversations was hit. */
  remaining: number;
  /** VACUUM was due but not attempted: too little free disk. */
  vacuumSkipped?: boolean;
  /** VACUUM was attempted and threw (e.g. SQLITE_FULL); the DB is intact, unshrunk. */
  vacuumFailed?: boolean;
  /** tool_result rows shortened this pass (toolResultTrimDays). */
  toolResultsTrimmed?: number;
  /** Payload bytes removed by the trim (before VACUUM). */
  trimmedBytes?: number;
}

/**
 * Conversations eligible for retention purge: chat-kind roots only, unpinned,
 * unarchived, idle (updated_at) for more than `retentionDays`. Schedule homes
 * are excluded by kind. Pin and archive are root-only; children follow their
 * root and are deleted with it when the root expires. The `pinned = 0` /
 * `archived = 0` filters on this root query are sufficient — leftover flags
 * on a child row are ignored.
 */
export function listPurgeCandidates(db: Database, retentionDays: number, now = Date.now()): PurgeCandidate[] {
  if (retentionDays <= 0) return [];
  const cutoff = now - retentionDays * 86_400_000;
  return db.prepare(
    `SELECT id, title, updated_at AS updatedAt
       FROM conversations
      WHERE (kind IS NULL OR kind = 'chat')
        AND (pinned IS NULL OR pinned = 0)
        AND (archived IS NULL OR archived = 0)
        AND parent_conversation_id IS NULL
        AND updated_at < ?
      ORDER BY updated_at ASC`,
  ).all(cutoff) as PurgeCandidate[];
}

/** Chars of a trimmed tool_result kept. Exported for tests. */
// ponytail: fixed head size; make it a setting if someone needs more of old output.
export const TOOL_RESULT_KEEP_CHARS = 2000;
const TRIM_BATCH_ROWIDS = 5000;

/**
 * Shorten tool_result content older than `days` to its first
 * TOOL_RESULT_KEEP_CHARS chars plus a marker. Prompts/messages (the only FTS-
 * indexed types) are never touched. Walks rowid ranges in small transactions,
 * yielding between batches so the event loop stays responsive. Idempotent:
 * already-trimmed rows fall under the length threshold.
 */
export async function trimOldToolResults(
  db: Database,
  days: number,
  now = Date.now(),
): Promise<{ rows: number; bytes: number }> {
  const out = { rows: 0, bytes: 0 };
  if (days <= 0) return out;
  const cutoff = now - days * 86_400_000;
  const max = (db.prepare('SELECT MAX(rowid) AS m FROM events').get() as { m: number | null }).m ?? 0;
  const keep = TOOL_RESULT_KEEP_CHARS;
  // length(payload) is a cheap prefilter before the JSON parse.
  const sizeStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM events
      WHERE rowid > ? AND rowid <= ? AND type = 'tool_result' AND ts < ?
        AND length(payload) > ? AND json_valid(payload)
        AND length(json_extract(payload, '$.content')) > ?`,
  );
  // keep is inlined (a constant): a bound JS number arrives as REAL → "8000.0 more chars".
  const updStmt = db.prepare(
    `UPDATE events
        SET payload = json_set(payload, '$.content',
              substr(json_extract(payload, '$.content'), 1, ${keep})
              || char(10) || '… [' || (length(json_extract(payload, '$.content')) - ${keep})
              || ' more chars trimmed by retention]')
      WHERE rowid > ? AND rowid <= ? AND type = 'tool_result' AND ts < ?
        AND length(payload) > ? AND json_valid(payload)
        AND length(json_extract(payload, '$.content')) > ?`,
  );
  const afterStmt = db.prepare(
    `SELECT COALESCE(SUM(length(payload)), 0) AS b FROM events
      WHERE rowid > ? AND rowid <= ? AND type = 'tool_result' AND ts < ?`,
  );
  // Only rows longer than keep + 200 chars are worth rewriting.
  const threshold = keep + 200;
  for (let lo = 0; lo < max; lo += TRIM_BATCH_ROWIDS) {
    const hi = lo + TRIM_BATCH_ROWIDS;
    db.transaction(() => {
      const before = sizeStmt.get(lo, hi, cutoff, threshold, threshold) as { n: number };
      if (before.n === 0) return;
      const beforeAll = (afterStmt.get(lo, hi, cutoff) as { b: number }).b;
      updStmt.run(lo, hi, cutoff, threshold, threshold);
      out.rows += before.n;
      out.bytes += beforeAll - (afterStmt.get(lo, hi, cutoff) as { b: number }).b;
    })();
    await new Promise<void>((r) => setImmediate(r));
  }
  return out;
}

function fileBytes(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function archiveDirStats(archiveDir: string): { archivedCount: number; archiveBytes: number } {
  try {
    let archivedCount = 0;
    let archiveBytes = 0;
    for (const name of readdirSync(archiveDir)) {
      try {
        const st = statSync(join(archiveDir, name));
        if (!st.isFile()) continue;
        archivedCount++;
        archiveBytes += st.size;
      } catch { /* vanished between readdir and stat */ }
    }
    return { archivedCount, archiveBytes };
  } catch {
    return { archivedCount: 0, archiveBytes: 0 };
  }
}

/** Read-only snapshot for Settings. COUNT(*) on ~2M events is ~50ms — cheap enough to live on GET. */
export function getRetentionStats(
  db: Database,
  opts: { dbPath: string; dataDir: string; retentionDays: number; purgeRunning?: boolean },
): RetentionStats {
  const eventsCount = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  const totalConversations = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
  return {
    dbSizeBytes: fileBytes(opts.dbPath),
    walSizeBytes: fileBytes(`${opts.dbPath}-wal`),
    totalConversations,
    eventsCount,
    eligibleConversations: listPurgeCandidates(db, opts.retentionDays).length,
    ...archiveDirStats(join(opts.dataDir, 'archive')),
    purgeRunning: opts.purgeRunning ?? false,
  };
}

function collectDescendantIds(db: Database, rootId: string): string[] {
  const out: string[] = [];
  const stmt = db.prepare('SELECT id FROM conversations WHERE parent_conversation_id = ?');
  const queue = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const children = (stmt.all(cur) as { id: string }[]).map((r) => r.id);
    out.push(...children);
    queue.push(...children);
  }
  return out;
}

type ConvArchiveRow = {
  id: string;
  title: string;
  project_id: string;
  kind: string | null;
  parent_conversation_id: string | null;
  pinned: number | null;
  created_at: number;
  updated_at: number;
};

function archiveFilePath(dataDir: string, id: string): string {
  return join(dataDir, 'archive', `${id}.jsonl`);
}

/**
 * Write one conversation's events (+ summaries / draft) as JSONL.
 * Streaming: stmt.iterate() + fd append — never .all() + join (OOM risk on
 * multi-hundred-MB transcripts).
 *
 * Archives are not HTTP-servable via GET /files on two independent layers:
 * (1) `jsonl` is not in OPENABLE_EXTENSIONS; (2) files.ts rejects any
 * resolved path inside `<dataDir>/archive/` before the extension check
 * (`isRetentionArchivePath`). Layer 2 holds even if jsonl later becomes
 * openable. The data dir IS lexically inside an allowed project root.
 */
function archiveOneConversation(db: Database, dataDir: string, id: string): boolean {
  const conv = db.prepare(
    `SELECT id, title, project_id, kind, parent_conversation_id, pinned, created_at, updated_at
       FROM conversations WHERE id = ?`,
  ).get(id) as ConvArchiveRow | undefined;
  if (!conv) return false;

  const eventCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?`,
  ).get(id) as { n: number }).n;

  const file = archiveFilePath(dataDir, id);
  let fd: number | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(file, 'w');
    appendFileSync(fd, JSON.stringify({
      archive: 'tierwyn-conversation',
      version: 2,
      conversation: {
        id: conv.id,
        title: conv.title,
        project_id: conv.project_id,
        kind: conv.kind,
        parent_conversation_id: conv.parent_conversation_id,
        pinned: conv.pinned,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
      },
      eventCount,
    }) + '\n');

    const eventStmt = db.prepare(
      `SELECT e.id, e.session_id AS sessionId, e.type, e.payload, e.sender,
              e.agent_model_id AS agentModelId, e.seq, e.ts
         FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.conversation_id = ?
        ORDER BY e.ts ASC, e.seq ASC`,
    );
    for (const row of eventStmt.iterate(id) as Iterable<Record<string, unknown>>) {
      appendFileSync(fd, JSON.stringify(row) + '\n');
    }

    const sumStmt = db.prepare('SELECT * FROM summaries WHERE conversation_id = ?');
    for (const row of sumStmt.iterate(id) as Iterable<Record<string, unknown>>) {
      appendFileSync(fd, JSON.stringify({ record: 'summary', ...row }) + '\n');
    }

    const draft = db.prepare('SELECT * FROM draft_prompts WHERE conversation_id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (draft) {
      appendFileSync(fd, JSON.stringify({ record: 'draft', ...draft }) + '\n');
    }

    closeSync(fd);
    fd = undefined;
    return true;
  } catch (err) {
    console.error(`[retention] archive write failed for ${id}:`, err);
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
      fd = undefined;
    }
    try { if (existsSync(file)) unlinkSync(file); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Archive a conversation tree (root AND all descendants, one `.jsonl` each)
 * to `<dataDir>/archive/<id>.jsonl` before deletion.
 *
 * All-or-nothing per tree: any write failure returns false so the caller
 * keeps the whole tree. Partial files written before the failure are unlinked.
 *
 * Archives are not HTTP-servable via GET /files on two independent layers:
 * (1) `jsonl` is not in OPENABLE_EXTENSIONS; (2) files.ts rejects any
 * resolved path inside `<dataDir>/archive/` before the extension check.
 */
export async function archiveConversation(db: Database, dataDir: string, rootId: string): Promise<boolean> {
  const subtree = [rootId, ...collectDescendantIds(db, rootId)];
  const written: string[] = [];
  for (const id of subtree) {
    if (!archiveOneConversation(db, dataDir, id)) {
      for (const f of written) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
      return false;
    }
    written.push(archiveFilePath(dataDir, id));
  }
  return true;
}

/**
 * Run one retention pass. Deletes unpinned chat conversations idle for more
 * than `retentionDays` days, archiving each tree to data/archive/<id>.jsonl
 * first (when dataDir is provided). A live/parked session on ANY subtree
 * member skips the whole tree. Pin is root-only — children die with their
 * expired root even if a leftover child row has pinned=1.
 * VACUUMs once when the drain finishes (`remaining === 0` and at least one
 * deletion) so the file actually shrinks — SQLite never returns pages to the
 * OS on DELETE alone. Intermediate chunked passes do not VACUUM.
 *
 * Yields via setImmediate after each deletion. Caps work per pass with
 * maxConversations (default 25); leftover candidates are reported as
 * `remaining` so the scheduler can re-fire.
 */
export async function runRetentionPurge(options: {
  db: Database;
  retentionDays: number;
  /** Directory containing the DB file; archives land in <dataDir>/archive. Required for archiving. */
  dataDir?: string;
  /** Test seam + boot check. */
  now?: number;
  /** Skip conversations with live/parked sessions — pass the SessionManager probe. */
  isLive?: (conversationId: string) => boolean;
  /** Post-commit hook for native-session unlink (mirrors DELETE /conversations/:id). */
  onNativeSessions?: (sessions: { agentId: string; nativeSessionId: string; projectId: string }[]) => void;
  /** Max roots to delete this pass (default 25). */
  maxConversations?: number;
  /** Test seam; defaults to unlinkTtsWavPaths. */
  unlinkTts?: (paths: string[]) => void;
  /** Test seam replacing the VACUUM statement only; checkpoints and the disk guard still run. Production skips VACUUM for :memory:. */
  vacuum?: (db: Database) => void;
  /** Test seam; defaults to freeBytesFor. */
  getFreeBytes?: (dir: string) => number;
  /** Trim tool_result output older than N days before purging (0 = skip). */
  toolResultTrimDays?: number;
}): Promise<PurgeResult> {
  const { db, retentionDays, dataDir, now, isLive } = options;
  const maxConversations = options.maxConversations ?? 25;
  const result: PurgeResult = {
    deletedIds: [], skippedLive: [], bytesBefore: 0, bytesAfter: 0, eventsDeleted: 0, remaining: 0,
  };

  const dbPath = db.name; // ':memory:' in tests — fileBytes returns 0
  result.bytesBefore = fileBytes(dbPath);
  result.bytesAfter = result.bytesBefore;

  if ((options.toolResultTrimDays ?? 0) > 0) {
    const t = await trimOldToolResults(db, options.toolResultTrimDays!, now);
    result.toolResultsTrimmed = t.rows;
    result.trimmedBytes = t.bytes;
  }
  const trimmed = (result.toolResultsTrimmed ?? 0) > 0;

  const candidates = listPurgeCandidates(db, retentionDays, now);
  if (candidates.length === 0 && !trimmed) return result;

  const wavAcc: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    // Compute subtree BEFORE the live check so a live descendant protects the root.
    // BTW children intentionally die with their root (accepted policy) — they
    // are in this subtree and are archived+deleted with it when nothing is live.
    const subtree = [c.id, ...collectDescendantIds(db, c.id)];
    if (subtree.some((id) => isLive?.(id))) {
      result.skippedLive.push(c.id);
      continue;
    }

    const countStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id IN
         (SELECT id FROM sessions WHERE conversation_id = ?)`,
    );
    let eventsBefore = 0;
    for (const sid of subtree) eventsBefore += (countStmt.get(sid) as { n: number }).n;

    if (dataDir && !(await archiveConversation(db, dataDir, c.id))) continue; // archive failed → keep

    const del = deleteConversation(db, c.id);
    if (del.ok) {
      result.deletedIds.push(c.id);
      result.eventsDeleted += eventsBefore;
      wavAcc.push(...del.ttsWavPaths);
      options.onNativeSessions?.(del.nativeSessions);
      await new Promise<void>((r) => setImmediate(r));
    }

    if (result.deletedIds.length >= maxConversations) {
      result.remaining = candidates.length - (i + 1);
      break;
    }
  }

  (options.unlinkTts ?? unlinkTtsWavPaths)(wavAcc);

  // VACUUM is synchronous better-sqlite3 (~20-40s on a 2.3GB DB) and freezes the
  // whole process — no HTTP, no WS heartbeats. Run it ONLY on the final chunk
  // of a drain (remaining === 0), never once per chunked pass.
  const vacuum = options.vacuum ?? (dbPath === ':memory:' ? undefined : (d: Database) => { d.exec('VACUUM'); });
  if (vacuum && (result.deletedIds.length > 0 || trimmed) && result.remaining === 0) {
    // Pre-VACUUM checkpoint: flush WAL so free-space measurement is accurate.
    // If this fails, skip VACUUM entirely (treat as vacuumSkipped with a warning).
    let preCheckpointOk = true;
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      preCheckpointOk = false;
      console.warn('[retention] pre-VACUUM checkpoint failed, skipping VACUUM:', err);
      result.vacuumSkipped = true;
    }

    if (preCheckpointOk) {
      try {
        const required = fileBytes(dbPath) * VACUUM_FREE_SPACE_FACTOR;
        const free = (options.getFreeBytes ?? freeBytesFor)(dirname(dbPath));
        if (free < required) {
          result.vacuumSkipped = true;
          console.warn(`[retention] VACUUM skipped: ${free} bytes free, need ${required}`);
        } else {
          vacuum(db);
        }
      } catch (err) {
        result.vacuumFailed = true;
        console.error('[retention] VACUUM failed:', err);
      } finally {
        // Post-VACUUM checkpoint: truncate WAL even on failure.
        try {
          db.pragma('wal_checkpoint(TRUNCATE)');
        } catch (err) {
          console.error('[retention] post-VACUUM checkpoint failed:', err);
        }
      }
    }

    if (!result.vacuumSkipped && !result.vacuumFailed) result.bytesAfter = fileBytes(dbPath);
  }
  return result;
}

/** Local hour at which the nightly pass fires. Exported for tests. */
export const RETENTION_HOUR = 3;

const CHUNK_DELAY_MS = 10 * 60 * 1000;

/** VACUUM needs a temp copy plus a WAL, each up to DB size; the rest is slack. */
const VACUUM_FREE_SPACE_FACTOR = 2.2;

/** Milliseconds until the next local RETENTION_HOUR:00:00. */
export function msUntilNextRetentionHour(now = Date.now()): number {
  const next = new Date(now);
  next.setHours(RETENTION_HOUR, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

export type RetentionKickResult =
  | { alreadyRunning: true }
  | ({ alreadyRunning: false } & PurgeResult);

/**
 * Nightly 03:00-local scheduler as a self-rescheduling setTimeout chain.
 * Boot never runs a pass — VACUUM would freeze the hub right after a restart —
 * so a backlog waits for 03:00. Chunked re-fires run 10 min apart while
 * remaining > 0. Returns stop() + runNow() (immediate first pass, then the same
 * chunked drain).
 */
export function startRetentionScheduler(
  db: Database,
  opts: {
    getRetentionDays: () => number;
    /** GeneralSettings.toolResultTrimDays (0 = off). */
    getToolResultTrimDays?: () => number;
    dataDir?: string;
    isLive?: (conversationId: string) => boolean;
    onNativeSessions?: (sessions: { agentId: string; nativeSessionId: string; projectId: string }[]) => void;
    /** Test seam for 03:00 calculations. */
    now?: () => number;
    /** Test seam; default 10 minutes. */
    chunkDelayMs?: number;
    /** Test seam; default 25. */
    maxConversations?: number;
    /** Extra nightly work (Phase 4 Grok Bot prune). Runs once per SETTLED chain —
     *  never per chunk — and also on the retention-disabled path, because its
     *  settings are independent of conversationRetentionDays. Errors are logged. */
    afterPass?: () => Promise<void>;
  },
): { stop: () => void; runNow: () => Promise<RetentionKickResult>; isRunning: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let inFlight = false;
  /** True from the start of a pass until remaining === 0 (includes the 10-min wait). */
  let chainActive = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { void run(); }, delayMs);
    timer.unref?.();
  };

  const skipped = (r: PurgeResult) => r.skippedLive.length;

  const runAfterPass = async () => {
    try {
      await opts.afterPass?.();
    } catch (err) {
      // Never let extra work break the chain — the chain is the whole scheduler.
      console.error('[retention] afterPass failed:', err);
    }
  };

  const run = async (): Promise<PurgeResult | 'busy' | 'stopped' | 'disabled'> => {
    if (stopped) return 'stopped';
    if (inFlight) return 'busy';
    inFlight = true;
    const chainStart = !chainActive;
    chainActive = true;
    try {
      const days = opts.getRetentionDays();
      // Trim once per chain, not per 10-min chunk.
      const trimDays = chainStart ? (opts.getToolResultTrimDays?.() ?? 0) : 0;
      if (days <= 0 && trimDays <= 0) {
        chainActive = false;
        await runAfterPass();
        schedule(msUntilNextRetentionHour(opts.now?.() ?? Date.now()));
        return 'disabled';
      }
      try {
        const res = await runRetentionPurge({
          db,
          retentionDays: days,
          dataDir: opts.dataDir,
          now: opts.now?.(),
          isLive: opts.isLive,
          onNativeSessions: opts.onNativeSessions,
          maxConversations: opts.maxConversations,
          toolResultTrimDays: trimDays,
        });
        const trimmedRows = res.toolResultsTrimmed ?? 0;
        if (res.deletedIds.length > 0 || trimmedRows > 0) {
          const vacuumed = res.remaining === 0 && !res.vacuumSkipped && !res.vacuumFailed;
          let msg =
            `[retention] purged ${res.deletedIds.length} conversation(s), ${res.eventsDeleted} events, ` +
            `${skipped(res)} skipped (live)`;
          if (trimmedRows > 0) {
            msg += `, trimmed ${trimmedRows} tool result(s) (${((res.trimmedBytes ?? 0) / 1048576).toFixed(0)}MB)`;
          }
          if (vacuumed) {
            const reclaimed = res.bytesBefore - res.bytesAfter;
            msg += `, DB ${(res.bytesBefore / 1048576).toFixed(0)}MB → ${(res.bytesAfter / 1048576).toFixed(0)}MB`;
            if (reclaimed > 0) msg += ` (reclaimed ${(reclaimed / 1048576).toFixed(0)}MB)`;
          }
          if (res.vacuumSkipped) msg += ', VACUUM skipped (low disk)';
          if (res.vacuumFailed) msg += ', VACUUM failed';
          console.log(msg);
        }
        if (res.remaining > 0) {
          schedule(opts.chunkDelayMs ?? CHUNK_DELAY_MS);
          return res;
        }
        chainActive = false;
        await runAfterPass();
        schedule(msUntilNextRetentionHour(opts.now?.() ?? Date.now()));
        return res;
      } catch (err) {
        console.error('[retention] purge pass failed:', err);
        chainActive = false;
        schedule(msUntilNextRetentionHour(opts.now?.() ?? Date.now()));
        return 'busy';
      }
    } finally {
      inFlight = false;
    }
  };

  const runNow = async (): Promise<RetentionKickResult> => {
    if (stopped || inFlight || chainActive) return { alreadyRunning: true };
    const res = await run();
    if (res === 'busy' || res === 'stopped' || res === 'disabled') {
      return { alreadyRunning: true };
    }
    return { alreadyRunning: false, ...res };
  };

  schedule(msUntilNextRetentionHour(opts.now?.() ?? Date.now()));

  return {
    stop: () => {
      stopped = true;
      chainActive = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    runNow,
    isRunning: () => inFlight || chainActive,
  };
}

/** True when the archive file for a conversation exists (used by tests/UI checks). */
export function archiveExists(dataDir: string, conversationId: string): boolean {
  return existsSync(join(dataDir, 'archive', `${conversationId}.jsonl`));
}
