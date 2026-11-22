/**
 * Operator skip / unskip helpers.
 *
 * Active holes are schedule_runs with status=skipped and error=operator_skip.
 * Only holes with firedAt >= now are live/restorable (past holes the clock
 * already jumped over cannot be re-armed usefully and must not pull next_fire_at
 * into the past). next_fire_at must always land on a non-hole (see nextNonSkippedFireAt).
 */
import type { Database } from 'better-sqlite3';
import type { ScheduleJob, ScheduleRun } from '@tierwyn/shared';
import {
  computeNextFireAt,
  computeUpcoming,
  ONCE_EXHAUSTED_MS,
} from './nextFire.js';
import { createRun, deleteRun, listRunsForJob, updateRun } from '../repositories/schedules.js';

const SKIP_ERROR = 'operator_skip';

export type OperatorSkipMode = 'this' | 'through';

export function isOnceExhaustedJob(job: Pick<ScheduleJob, 'scheduleKind' | 'nextFireAt'>): boolean {
  return job.scheduleKind === 'once' && job.nextFireAt >= ONCE_EXHAUSTED_MS;
}

/**
 * Live/restorable operator-skip fire times for a job.
 * Only holes with firedAt >= now — past holes are inert (clock already past them).
 */
export function listRestorableOperatorSkips(db: Database, job: ScheduleJob, nowMs = Date.now()): number[] {
  const runs = listRunsForJob(db, job.id, { limit: 200 });
  const times = new Set<number>();
  for (const r of runs) {
    if (r.status !== 'skipped' || r.error !== SKIP_ERROR) continue;
    if (r.firedAt < nowMs) continue;
    times.add(r.firedAt);
  }
  return [...times].sort((a, b) => a - b);
}

export function getActiveOperatorSkipSet(db: Database, job: ScheduleJob, nowMs = Date.now()): Set<number> {
  return new Set(listRestorableOperatorSkips(db, job, nowMs));
}

/**
 * Next schedule fire strictly after afterMs that is not in skipSet.
 * Returns ONCE_EXHAUSTED_MS when the schedule is exhausted (once) or no slot found.
 */
export function nextNonSkippedFireAt(
  job: Pick<ScheduleJob, 'scheduleKind' | 'scheduleExpr' | 'timezone' | 'createdAt'>,
  afterMs: number,
  skipSet: Set<number>,
  maxSteps = 64,
): number {
  let after = afterMs;
  for (let i = 0; i < maxSteps; i++) {
    const next = computeNextFireAt({
      scheduleKind: job.scheduleKind,
      scheduleExpr: job.scheduleExpr,
      timezone: job.timezone,
      afterMs: after,
      createdAtMs: job.createdAt,
    });
    if (next >= ONCE_EXHAUSTED_MS) return ONCE_EXHAUSTED_MS;
    if (!skipSet.has(next)) return next;
    after = next;
  }
  // Pathological: too many consecutive holes — treat as exhausted once-style sentinel.
  return ONCE_EXHAUSTED_MS;
}

/**
 * All operator_skip fire times (including past) — used only for insert dedup so
 * re-skip of a past hole does not create a duplicate row. New skips are always future.
 */
function existingOperatorSkipTimes(db: Database, jobId: string): Set<number> {
  const existing = new Set<number>();
  for (const r of listRunsForJob(db, jobId, { limit: 200 })) {
    if (r.status === 'skipped' && r.error === SKIP_ERROR) existing.add(r.firedAt);
  }
  return existing;
}

function recordOneSkip(db: Database, jobId: string, fireAtMs: number, existing: Set<number>): ScheduleRun | null {
  if (existing.has(fireAtMs)) return null;
  const now = Date.now();
  const run = createRun(db, { jobId, status: 'skipped', firedAt: fireAtMs });
  updateRun(db, run.id, { finishedAt: now, error: SKIP_ERROR });
  existing.add(fireAtMs);
  return run;
}

/** Record a single hole (skip-this). */
export function recordOperatorSkipThis(
  db: Database,
  jobId: string,
  fireAtMs: number,
): ScheduleRun[] {
  const existing = existingOperatorSkipTimes(db, jobId);
  const run = recordOneSkip(db, jobId, fireAtMs, existing);
  return run ? [run] : [];
}

/**
 * Record holes for every fire from the current clock through fireAtMs (inclusive).
 * Used by skip-through. Only records slots that are still at/after now (past
 * slots in an overdue window are not useful holes and would bloat the runs table).
 */
export function recordOperatorSkipsThrough(
  db: Database,
  job: ScheduleJob,
  fireAtMs: number,
  nowMs = Date.now(),
): ScheduleRun[] {
  const existing = existingOperatorSkipTimes(db, job.id);
  const window = isOnceExhaustedJob(job)
    ? []
    : computeUpcoming({
      scheduleKind: job.scheduleKind,
      scheduleExpr: job.scheduleExpr,
      timezone: job.timezone,
      afterMs: job.nextFireAt - 1,
      createdAtMs: job.createdAt,
      count: 50,
    });
  // Live holes only: drop past slots from an overdue clock, keep fireAtMs if still future.
  const toRecord = window.filter((t) => t <= fireAtMs && t >= nowMs);
  if (fireAtMs >= nowMs && !toRecord.includes(fireAtMs)) toRecord.push(fireAtMs);

  const created: ScheduleRun[] = [];
  for (const t of toRecord) {
    const run = recordOneSkip(db, job.id, t, existing);
    if (run) created.push(run);
  }
  return created;
}

/**
 * Undo a single operator_skip slot (per-row Unskip).
 * Hard-deletes the hole row(s) so skip→unskip→skip does not accumulate rows and
 * /runs does not show a future-dated skipped entry for a restored slot.
 */
export function markOperatorSkipUndone(db: Database, jobId: string, fireAtMs: number): void {
  const runs = listRunsForJob(db, jobId, { limit: 200 });
  for (const r of runs) {
    if (r.status !== 'skipped' || r.error !== SKIP_ERROR) continue;
    if (r.firedAt !== fireAtMs) continue;
    deleteRun(db, r.id);
  }
}

/**
 * After mutating the skip set, recompute next_fire_at.
 * - advancePastMs: jump strictly after that time (skip this on current next / skip-through).
 * - preferFireAtMs: unskip restore — pull clock back only when that slot is at/before current next
 *   (or once exhausted); future hole restores leave next unchanged when still valid.
 */
export function recomputeNextFireAfterSkipChange(
  db: Database,
  job: ScheduleJob,
  opts: {
    advancePastMs?: number;
    preferFireAtMs?: number;
  } = {},
): number {
  const skipSet = getActiveOperatorSkipSet(db, job);
  let afterMs: number;

  if (opts.preferFireAtMs !== undefined && !skipSet.has(opts.preferFireAtMs)) {
    const prefer = opts.preferFireAtMs;
    const pullBack =
      isOnceExhaustedJob(job)
      || prefer <= job.nextFireAt
      || job.nextFireAt >= ONCE_EXHAUSTED_MS;
    if (!pullBack) {
      // Restored a future hole; keep current next if it is still a non-hole.
      if (!skipSet.has(job.nextFireAt) && job.nextFireAt < ONCE_EXHAUSTED_MS) {
        return job.nextFireAt;
      }
      afterMs = isOnceExhaustedJob(job) ? Date.now() : job.nextFireAt - 1;
    } else {
      afterMs = prefer - 1;
    }
  } else if (opts.advancePastMs !== undefined) {
    afterMs = opts.advancePastMs;
  } else {
    if (!skipSet.has(job.nextFireAt) && !isOnceExhaustedJob(job)) {
      return job.nextFireAt;
    }
    afterMs = isOnceExhaustedJob(job) ? Date.now() : job.nextFireAt - 1;
  }

  return nextNonSkippedFireAt(job, afterMs, skipSet);
}
