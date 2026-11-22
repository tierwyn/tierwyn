import type { Database } from 'better-sqlite3';
import { listOpenEdgesForParent } from '../repositories/spawnEdges.js';

/**
 * Conversation ids that count as "this schedule tick is still working":
 * the tick itself plus any open notifyParent spawn children.
 */
export function scheduleTickActivityConversationIds(
  db: Database,
  tickConversationId: string,
): string[] {
  const ids = [tickConversationId];
  for (const edge of listOpenEdgesForParent(db, tickConversationId)) {
    if (edge.notifyParent) ids.push(edge.childConversationId);
  }
  return ids;
}

/**
 * Latest event timestamp across the tick conversation and its open
 * notifyParent children. Falls back to `fallbackMs` when no events exist yet
 * (pre-session or empty transcript).
 */
export function lastTickActivityMs(
  db: Database,
  tickConversationId: string | null | undefined,
  fallbackMs: number,
): number {
  if (!tickConversationId) return fallbackMs;
  const ids = scheduleTickActivityConversationIds(db, tickConversationId);
  const placeholders = ids.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT MAX(e.ts) AS ts
         FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.conversation_id IN (${placeholders})`,
    )
    .get(...ids) as { ts: number | null } | undefined;
  const ts = row?.ts;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : fallbackMs;
}

/**
 * Whether a schedule run should be timed out / reclaimed.
 *
 * `runTimeoutMs` is an **idle/stall budget**, not a hard wall-clock from fire:
 * continuous activity (tick or open notify children) keeps the run alive.
 * Multi-spawn waves often exceed the nominal timeout while still progressing;
 * painting those as `timed_out` false-reds the job.
 */
export function isScheduleRunStalled(opts: {
  now: number;
  /** Run fire time — used when there is no later activity signal. */
  firedAt: number;
  runTimeoutMs: number;
  /** Latest known progress (events on tick / open notify kids). */
  lastActivityMs: number;
}): boolean {
  if (opts.runTimeoutMs <= 0) return true;
  const anchor = Math.max(opts.firedAt, opts.lastActivityMs);
  return opts.now - anchor >= opts.runTimeoutMs;
}

/** Poll interval for in-process stall checks during dispatch. */
export const SCHEDULE_STALL_POLL_MS = 5_000;
