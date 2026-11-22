import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent } from '../repositories/events.js';
import { createSpawnEdge } from '../repositories/spawnEdges.js';
import {
  createJob, createRun, getJob, getStep, listRunsForJob, listSteps, getRun,
  setPendingContext, updateRun, getDeferredFire, setDeferredFire, setJobEnabled,
} from '../repositories/schedules.js';
import { ONCE_EXHAUSTED_MS } from './nextFire.js';
import { recordOperatorSkipThis } from './operatorSkip.js';
import { JobScheduler, HOST_MISS_AUTO_DISABLE, type TickContext } from './jobScheduler.js';

/** Finish all pending/running runs and reset steps so the next tick can re-select. */
function finalizeActiveRuns(db: Database, jobId: string, finishedAt: number): void {
  for (const r of listRunsForJob(db, jobId, { limit: 50 })) {
    if (r.status === 'running' || r.status === 'pending') {
      updateRun(db, r.id, { status: 'succeeded', finishedAt });
    }
  }
  for (const step of listSteps(db, jobId)) {
    if (step.status === 'running') {
      db.prepare(`UPDATE schedule_steps SET status = 'ready' WHERE id = ?`).run(step.id);
    }
  }
}

let db: Database;
let projectId: string;
let homeId: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  homeId = createConversation(db, {
    projectId, title: '⏱ job home', kind: 'schedule_home',
  }).id;
});

function seedJob(overrides: Partial<Parameters<typeof createJob>[1]> = {}) {
  const now = Date.now();
  // Pin the interval anchor explicitly so next-fire math is deterministic and
  // independent of the real wall-clock `created_at` timestamp createJob stamps
  // internally (which can otherwise land in the same millisecond as `now`).
  return createJob(db, {
    projectId,
    name: 'nightly',
    timezone: 'UTC',
    scheduleKind: 'interval',
    scheduleExpr: JSON.stringify({ everyMs: 3_600_000, anchor: now - 3_600_000 - 1 }),
    profileId: 'claude-code:opus-4.8',
    homeConversationId: homeId,
    promptTemplate: 'Do step: {{step.title}}\n{{step.body}}',
    nextFireAt: now - 1,
    steps: [{ title: 'Scaffold', body: 'Create files' }],
    ...overrides,
  });
}

describe('JobScheduler operator skip (hole-punch)', () => {
  it('never dispatches an operator-skipped fire (claim path jumps holes)', async () => {
    const everyMs = 3_600_000;
    const t0 = Date.now();
    const fire1 = t0;
    const fire2 = t0 + everyMs;
    const fire3 = t0 + 2 * everyMs;

    const job = seedJob({
      scheduleExpr: JSON.stringify({ everyMs, anchor: t0 }),
      nextFireAt: fire1,
    });

    // Hole-punch fire #2 so the claim path must jump over it after fire #1.
    recordOperatorSkipThis(db, job.id, fire2);

    let clock = fire1;
    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => clock });

    // Fire #1 due — should dispatch; next_fire_at jumps over #2 to #3.
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getJob(db, job.id)!.nextFireAt).toBe(fire3);

    // Finish fire #1 so the next real slot can dispatch (overlap would otherwise skip).
    for (const r of listRunsForJob(db, job.id)) {
      if (r.status === 'running' || r.status === 'pending') {
        updateRun(db, r.id, { status: 'succeeded', finishedAt: clock });
      }
    }
    const step = listSteps(db, job.id)[0];
    db.prepare(`UPDATE schedule_steps SET status = 'ready' WHERE id = ?`).run(step.id);

    // Clock at fire #2 — hole must not produce a dispatched/pending/running run.
    clock = fire2;
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getJob(db, job.id)!.nextFireAt).toBe(fire3);

    // Fire #3 due — second dispatch.
    clock = fire3;
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(2);

    const runs = listRunsForJob(db, job.id, { limit: 50 });
    // Only the operator_skip audit row for fire #2 — never a real run at that slot.
    expect(runs.filter((r) => r.error === 'operator_skip')).toEqual([
      expect.objectContaining({ status: 'skipped', error: 'operator_skip', firedAt: fire2 }),
    ]);
    const dispatched = runs.filter(
      (r) => r.status === 'pending' || r.status === 'running' || r.status === 'succeeded' || r.status === 'failed',
    );
    expect(dispatched.every((r) => r.firedAt !== fire2)).toBe(true);
    expect(dispatched.some((r) => r.firedAt === fire1)).toBe(true);
    expect(dispatched.some((r) => r.firedAt === fire3)).toBe(true);
  });
});

describe('JobScheduler skip overlap', () => {
  it('advances next_fire_at and records a skipped run when an active run exists', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    createRun(db, { jobId: job.id, status: 'running', firedAt: now });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).not.toHaveBeenCalled();

    const updatedJob = getJob(db, job.id)!;
    // next_fire_at must advance from the overdue slot (may equal `now` on same-ms boundary).
    expect(updatedJob.nextFireAt).toBeGreaterThanOrEqual(now);
    expect(updatedJob.nextFireAt).toBeGreaterThan(job.nextFireAt);

    const runs = listRunsForJob(db, job.id);
    expect(runs).toContainEqual(expect.objectContaining({ status: 'skipped', error: 'overlap_skip' }));
  });

  it('dispatches when no active run exists and advances next_fire_at', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });

    let seenCtx: TickContext | undefined;
    const dispatchTick = vi.fn(async (ctx: TickContext) => { seenCtx = ctx; });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledOnce();
    expect(seenCtx!.job.id).toBe(job.id);
    expect(seenCtx!.run.status).toBe('running');
    expect(seenCtx!.step?.title).toBe('Scaffold');
    expect(seenCtx!.prompt).toContain('Do step: Scaffold');
    expect(seenCtx!.runToken).toBeTruthy();

    const updatedJob = getJob(db, job.id)!;
    expect(updatedJob.nextFireAt).toBeGreaterThan(now);

    const step = listSteps(db, job.id)[0];
    expect(step.status).toBe('running');
  });

  it('does not dispatch a job that is not yet due', async () => {
    const now = Date.now();
    seedJob({ nextFireAt: now + 60_000 });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).not.toHaveBeenCalled();
  });
});

describe('JobScheduler once kind', () => {
  it('fires exactly once then disables; second tick produces no run', async () => {
    const now = Date.now();
    const atMs = now - 1;
    const job = seedJob({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      nextFireAt: atMs,
      steps: [{ title: 'One-shot', body: 'Do it once' }],
    });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledOnce();
    const afterFirst = getJob(db, job.id)!;
    expect(afterFirst.enabled).toBe(false);
    expect(afterFirst.nextFireAt).toBe(ONCE_EXHAUSTED_MS);

    // Finish the run so overlap isn't the reason for no dispatch.
    const runs = listRunsForJob(db, job.id);
    const active = runs.find((r) => r.status === 'running' || r.status === 'pending');
    if (active) {
      updateRun(db, active.id, { status: 'succeeded', finishedAt: now });
    }

    // Second tick far in the future still must not re-fire (disabled + sentinel).
    const later = now + 86_400_000;
    const scheduler2 = new JobScheduler({ getDb: () => db, dispatchTick, now: () => later });
    await scheduler2.tickOnce();

    expect(dispatchTick).toHaveBeenCalledOnce(); // still one
    const afterSecond = getJob(db, job.id)!;
    expect(afterSecond.enabled).toBe(false);
    expect(afterSecond.nextFireAt).toBe(ONCE_EXHAUSTED_MS);
  });
});

describe('JobScheduler queue_one overlap', () => {
  // Matrix row 3: due + active → latch, no run row, next_fire_at advanced
  it('latches deferred_fire with no run row when an active run exists (row 3)', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1, overlapPolicy: 'queue_one' });
    createRun(db, { jobId: job.id, status: 'running', firedAt: now });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).not.toHaveBeenCalled();
    expect(getDeferredFire(db, job.id)).toBe(true);
    expect(getJob(db, job.id)!.nextFireAt).toBeGreaterThan(job.nextFireAt);
    const runs = listRunsForJob(db, job.id);
    // Only the pre-existing running row — no skipped overlap row.
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
    expect(runs.every((r) => r.error !== 'overlap_skip')).toBe(true);
  });

  // Matrix row 4: latch → finalize succeeded → drain tick dispatches once
  it('drains one deferred fire after active run succeeds (row 4)', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1, overlapPolicy: 'queue_one' });
    const active = createRun(db, { jobId: job.id, status: 'running', firedAt: now });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();
    expect(getDeferredFire(db, job.id)).toBe(true);
    expect(dispatchTick).not.toHaveBeenCalled();

    // Finalize the pre-existing active run (scheduler.finalizeRun path).
    scheduler.finalizeRun(active.id, { status: 'succeeded', stepUpdated: true });
    // Reset step so dispatch can re-select.
    for (const s of listSteps(db, job.id)) {
      if (s.status === 'running') {
        db.prepare(`UPDATE schedule_steps SET status = 'ready' WHERE id = ?`).run(s.id);
      }
    }

    // Push next_fire_at into the future so claimDueJobs does not also fire.
    db.prepare('UPDATE schedule_jobs SET next_fire_at = ? WHERE id = ?')
      .run(now + 999_999, job.id);

    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getDeferredFire(db, job.id)).toBe(false);
  });

  // Matrix row 5: three due ticks while busy → still only one deferred fire
  it('only one deferred fire even after three due ticks while busy (row 5)', async () => {
    const now = Date.now();
    // Long timeout so reclaimStuck does not free the active run mid-test.
    const job = seedJob({
      nextFireAt: now - 1,
      overlapPolicy: 'queue_one',
      runTimeoutMs: 86_400_000,
    });
    createRun(db, { jobId: job.id, status: 'running', firedAt: now });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });

    // Three consecutive due ticks while busy (re-due by rewriting next_fire_at).
    for (let i = 0; i < 3; i++) {
      db.prepare('UPDATE schedule_jobs SET next_fire_at = ? WHERE id = ?')
        .run(now - 1, job.id);
      await scheduler.tickOnce();
    }
    expect(dispatchTick).not.toHaveBeenCalled();
    expect(getDeferredFire(db, job.id)).toBe(true);

    finalizeActiveRuns(db, job.id, now);
    // Keep next_fire_at in the future so only drain fires (not a new due claim).
    db.prepare('UPDATE schedule_jobs SET next_fire_at = ? WHERE id = ?')
      .run(now + 999_999, job.id);

    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getDeferredFire(db, job.id)).toBe(false);

    // Another drain tick must not fire again.
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
  });

  // Matrix row 6: restart with persisted flag + no active run
  it('honors deferred_fire after restart (new scheduler, same db) (row 6)', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999, overlapPolicy: 'queue_one' });
    setDeferredFire(db, job.id, true);
    expect(getDeferredFire(db, job.id)).toBe(true);

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getDeferredFire(db, job.id)).toBe(false);
  });

  // Matrix row 7: reclaimStuck fails run → drain on same tick dispatches once
  it('drains deferred fire after reclaimStuck fails the active run (row 7)', async () => {
    const now = Date.now();
    const job = seedJob({
      nextFireAt: now + 999_999, // not due — only reclaim + drain
      overlapPolicy: 'queue_one',
      runTimeoutMs: 60_000,
    });
    setDeferredFire(db, job.id, true);
    createRun(db, {
      jobId: job.id, status: 'running', firedAt: now - 60_000 - 1,
    });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    // reclaimStuck fails the stuck run, then drainDeferred claims + dispatches.
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getDeferredFire(db, job.id)).toBe(false);
    expect(listRunsForJob(db, job.id, { limit: 50 }).some((r) => r.error === 'reclaimed_stuck')).toBe(true);
  });

  // Matrix row 8: flag=1 but a new run is active at drain → leave flag, no dispatch
  it('leaves deferred_fire set when drain sees a new active run (row 8)', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999, overlapPolicy: 'queue_one' });
    setDeferredFire(db, job.id, true);
    createRun(db, { jobId: job.id, status: 'running', firedAt: now });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).not.toHaveBeenCalled();
    expect(getDeferredFire(db, job.id)).toBe(true);
  });

  // GAP 3: queue_one latch must NOT consume pending_context; deferred dispatch does.
  it('queue_one latch preserves pending_context until deferred dispatch (GAP 3)', async () => {
    const now = Date.now();
    const job = seedJob({
      nextFireAt: now - 1,
      overlapPolicy: 'queue_one',
      carryContextEnabled: true,
    });
    setPendingContext(db, job.id, {
      text: 'keep me for the deferred fire',
      source: 'operator',
    });
    createRun(db, { jobId: job.id, status: 'running', firedAt: now });

    const prompts: string[] = [];
    const dispatchTick = vi.fn(async (ctx: TickContext) => { prompts.push(ctx.prompt); });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });

    // Latch only — no dispatch, pending_context still present.
    await scheduler.tickOnce();
    expect(dispatchTick).not.toHaveBeenCalled();
    expect(getDeferredFire(db, job.id)).toBe(true);
    expect(getJob(db, job.id)!.pendingContext).toBe('keep me for the deferred fire');

    finalizeActiveRuns(db, job.id, now);
    // Keep next_fire_at in the future so only drain fires (not a new due claim).
    db.prepare('UPDATE schedule_jobs SET next_fire_at = ? WHERE id = ?')
      .run(now + 999_999, job.id);

    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('keep me for the deferred fire');
    expect(getJob(db, job.id)!.pendingContext).toBeUndefined();
    expect(getDeferredFire(db, job.id)).toBe(false);
  });
});

describe('JobScheduler catch_up overlap', () => {
  const everyMs = 3_600_000;

  function seedCatchUp(missedSlots: number, now: number) {
    // Slots: t0, t0+every, … ; next_fire_at = t0; clock at t0 + (missedSlots-1)*every
    const t0 = now - (missedSlots - 1) * everyMs;
    const job = seedJob({
      scheduleExpr: JSON.stringify({ everyMs, anchor: t0 }),
      nextFireAt: t0,
      overlapPolicy: 'catch_up',
    });
    return { job, t0 };
  }

  // Matrix row 9: 3 missed slots → exactly 3 dispatches across tick+finalize cycles
  it('drains 3 missed slots serially — exactly 3 dispatches total (row 9)', async () => {
    const now = Date.now();
    const { job, t0 } = seedCatchUp(3, now);
    // now is t0 + 2*every → slots t0, t0+every, t0+2*every all ≤ now
    const clock = t0 + 2 * everyMs;

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => clock });

    for (let i = 0; i < 3; i++) {
      await scheduler.tickOnce();
      expect(dispatchTick).toHaveBeenCalledTimes(i + 1);
      // One active run — finalize before next drain cycle.
      finalizeActiveRuns(db, job.id, clock);
    }

    // Caught up: next_fire_at > now, no more dispatches.
    expect(getJob(db, job.id)!.nextFireAt).toBeGreaterThan(clock);
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(3);
    expect(getDeferredFire(db, job.id)).toBe(false);
  });

  // Matrix row 10: 8 missed → serial drain, enumeration cap 5/poll, no 6th after 5? 
  // Actually 8 missed should produce 8 total dispatches over 8 cycles; cap is enum only.
  // Parent: "verify no 6th dispatch" for row 10 — re-read: "the backlog terminates for row 10 — verify no 6th dispatch"
  // Wait, parent said: "assert the exact total dispatch count across the full drain (3 for row 9; the backlog terminates for row 10 — verify no 6th dispatch)"
  // 
  // "no 6th dispatch" might mean: after 5 cycles of the enum window progressing, or that we don't burst 5+1?
  // Plan row 10: "1/cycle; drains serially; enumeration capped at 5/poll"
  // Parent: "verify no 6th dispatch" — hmm, if 8 missed we need 8 dispatches.
  // 
  // Re-read parent carefully: "For matrix rows 9 and 10, assert the exact total dispatch count across the full drain (3 for row 9; the backlog terminates for row 10 — verify no 6th dispatch)"
  // 
  // "no 6th dispatch" is odd for 8 slots. Maybe they mean: in one cycle never more than 1 (so not 5+1 burst), and after full drain of 5 enumeration window...
  // Or: CATCH_UP_MAX_PER_CYCLE=5 means with 8 missed, first poll only "sees" 5 in the enum, dispatches 1, advances one. Still 8 total.
  // 
  // I'll assert: 1 per cycle, exactly 8 total for 8 missed, no 9th, and never 2 in one cycle.
  // Parent's "no 6th" might mean after draining a 5-cap window incorrectly? Or they meant for a 5-slot case?
  // Plan says missed slots = 8 for row 10. I'll implement exact 8 total + no 9th.
  it('drains 8 missed slots serially one-per-cycle; no burst; terminates (row 10)', async () => {
    const now = Date.now();
    const { job, t0 } = seedCatchUp(8, now);
    const clock = t0 + 7 * everyMs;

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => clock });

    for (let i = 0; i < 8; i++) {
      const before = dispatchTick.mock.calls.length;
      await scheduler.tickOnce();
      // At most one dispatch per cycle (no burst).
      expect(dispatchTick).toHaveBeenCalledTimes(before + 1);
      finalizeActiveRuns(db, job.id, clock);
    }

    expect(dispatchTick).toHaveBeenCalledTimes(8);
    expect(getJob(db, job.id)!.nextFireAt).toBeGreaterThan(clock);
    await scheduler.tickOnce();
    // No 9th dispatch — backlog terminated.
    expect(dispatchTick).toHaveBeenCalledTimes(8);
  });

  // Matrix row 11: pre-existing active run → latch, next_fire_at unchanged
  it('latches without advancing next_fire_at when a run is already active (row 11)', async () => {
    const now = Date.now();
    const { job, t0 } = seedCatchUp(2, now);
    const clock = t0 + everyMs;
    createRun(db, { jobId: job.id, status: 'running', firedAt: clock });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => clock });
    await scheduler.tickOnce();

    expect(dispatchTick).not.toHaveBeenCalled();
    expect(getDeferredFire(db, job.id)).toBe(true);
    expect(getJob(db, job.id)!.nextFireAt).toBe(t0); // unadvanced
  });

  // GAP 1: row 11 extended — latch → finalize → re-tick drains one slot, then
  // remaining backlog one-per-cycle until next_fire_at > now (row-9 shape via latch).
  it('after catch_up latch, finalize + tick drains one slot and clears deferred_fire (GAP 1)', async () => {
    const now = Date.now();
    const { job, t0 } = seedCatchUp(3, now);
    const clock = t0 + 2 * everyMs;
    createRun(db, { jobId: job.id, status: 'running', firedAt: clock });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => clock });

    // Action 1: active + due → processCatchUp step 2 latches; next_fire_at unadvanced.
    await scheduler.tickOnce();
    expect(dispatchTick).not.toHaveBeenCalled();
    expect(getDeferredFire(db, job.id)).toBe(true);
    expect(getJob(db, job.id)!.nextFireAt).toBe(t0);

    // Action 2: free the active run so the next tick can dispatch the owed slot.
    finalizeActiveRuns(db, job.id, clock);

    // Action 3: one dispatch, flag cleared, next_fire_at advanced by exactly one slot.
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getDeferredFire(db, job.id)).toBe(false);
    expect(getJob(db, job.id)!.nextFireAt).toBe(t0 + everyMs);

    // Remaining backlog drains one-per-completed-run until caught up.
    finalizeActiveRuns(db, job.id, clock);
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(2);
    expect(getJob(db, job.id)!.nextFireAt).toBe(t0 + 2 * everyMs);

    finalizeActiveRuns(db, job.id, clock);
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(3);
    expect(getJob(db, job.id)!.nextFireAt).toBeGreaterThan(clock);

    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(3);
    expect(getDeferredFire(db, job.id)).toBe(false);
  });

  // GAP 1 sibling: drainDeferred stale-latch guard — claim clears flag, no extra run
  // when next_fire_at is already past now (only-future slots remain).
  it('drainDeferred drops stale catch_up latch when next_fire_at already past now (GAP 1 stale)', async () => {
    const now = Date.now();
    const { job } = seedCatchUp(1, now);
    const future = now + everyMs;
    // Latched with next_fire_at already advanced past now (step 3 / only-future shape).
    db.prepare('UPDATE schedule_jobs SET next_fire_at = ? WHERE id = ?').run(future, job.id);
    setDeferredFire(db, job.id, true);
    expect(getDeferredFire(db, job.id)).toBe(true);

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    // claimDeferredFire alone cleared the flag; guard skipped dispatch.
    expect(dispatchTick).not.toHaveBeenCalled();
    expect(getDeferredFire(db, job.id)).toBe(false);
    expect(getJob(db, job.id)!.nextFireAt).toBe(future);
    // No new run rows (seed created none; nothing dispatched).
    expect(listRunsForJob(db, job.id, { limit: 50 })).toHaveLength(0);
  });

  // GAP 1 drain path: catch_up advance-then-dispatch inside drainDeferred.
  // Job is disabled so claimDueJobs skips it; only drainDeferred consumes the latch
  // (same pattern as once+queue_one: listJobsWithDeferredFire ignores enabled).
  it('drainDeferred catch_up advances one slot then dispatches owed fire (GAP 1 drain)', async () => {
    const now = Date.now();
    const { job, t0 } = seedCatchUp(3, now);
    const clock = t0 + 2 * everyMs;
    setDeferredFire(db, job.id, true);
    db.prepare('UPDATE schedule_jobs SET enabled = 0 WHERE id = ?').run(job.id);

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => clock });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getDeferredFire(db, job.id)).toBe(false);
    expect(getJob(db, job.id)!.nextFireAt).toBe(t0 + everyMs);
  });

  // GAP 2: catch_up + scheduleKind once — fires exactly once then stops
  it('catch_up + once fires exactly once then disables with no re-fire (GAP 2)', async () => {
    const now = Date.now();
    const atMs = now - 1;
    const job = seedJob({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      nextFireAt: atMs,
      overlapPolicy: 'catch_up',
      steps: [{ title: 'Once catch-up', body: 'single' }],
    });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getJob(db, job.id)!.enabled).toBe(false);
    expect(getJob(db, job.id)!.nextFireAt).toBe(ONCE_EXHAUSTED_MS);
    expect(getDeferredFire(db, job.id)).toBe(false);

    finalizeActiveRuns(db, job.id, now);
    await scheduler.tickOnce();
    // No further dispatches (exhausted + disabled; drain stale-latch would drop if latched).
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(getJob(db, job.id)!.enabled).toBe(false);
    expect(getJob(db, job.id)!.nextFireAt).toBe(ONCE_EXHAUSTED_MS);
  });

  // Matrix row 12: operator-skipped slot never dispatched.
  // getActiveOperatorSkipSet only includes holes with firedAt >= now, so the
  // hole must sit on the clock boundary (still "live") to be filtered.
  it('never dispatches an operator-skipped hole during catch_up (row 12)', async () => {
    const clock = Date.now();
    const t0 = clock - everyMs;
    const fire1 = t0; // real missed slot
    const fire2 = clock; // operator-skipped (still live: firedAt >= now)
    // fire3 = clock + everyMs is future — not missed

    const job = seedJob({
      scheduleExpr: JSON.stringify({ everyMs, anchor: t0 }),
      nextFireAt: fire1,
      overlapPolicy: 'catch_up',
    });
    recordOperatorSkipThis(db, job.id, fire2);

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => clock });

    // Only fire1 is a real catch-up candidate; fire2 is a hole.
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    finalizeActiveRuns(db, job.id, clock);

    // next_fire_at must have jumped the hole to fire3 > clock.
    expect(getJob(db, job.id)!.nextFireAt).toBeGreaterThan(clock);
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1); // no second dispatch for the hole
  });

  // Matrix row 13: pending_context consumed only on first real catch-up dispatch
  it('consumes pending_context only on the first catch_up dispatch (row 13)', async () => {
    const now = Date.now();
    const { job, t0 } = seedCatchUp(2, now);
    const clock = t0 + everyMs;
    // re-create with carry enabled
    db.prepare('UPDATE schedule_jobs SET carry_context_enabled = 1 WHERE id = ?').run(job.id);
    setPendingContext(db, job.id, { text: 'catch-up note', source: 'operator' });

    const prompts: string[] = [];
    const dispatchTick = vi.fn(async (ctx: TickContext) => { prompts.push(ctx.prompt); });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => clock });

    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('catch-up note');
    expect(getJob(db, job.id)!.pendingContext).toBeUndefined();

    finalizeActiveRuns(db, job.id, clock);
    await scheduler.tickOnce();
    expect(dispatchTick).toHaveBeenCalledTimes(2);
    expect(prompts[1]).not.toContain('catch-up note');
  });
});

describe('JobScheduler pending_context consume', () => {
  it('consumes pending context on fire and injects into prompt once', async () => {
    const now = Date.now();
    const job = seedJob({
      nextFireAt: now - 1,
      carryContextEnabled: true,
    });
    setPendingContext(db, job.id, {
      text: 'remember to merge PR #12',
      source: 'operator',
    });

    let firstPrompt: string | undefined;
    const dispatchTick = vi.fn(async (ctx: TickContext) => { firstPrompt = ctx.prompt; });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledOnce();
    expect(firstPrompt).toContain('Operator/parent context (this run only — UNTRUSTED');
    expect(firstPrompt).toContain('remember to merge PR #12');

    const after = getJob(db, job.id)!;
    expect(after.pendingContext).toBeUndefined();

    // Force next due tick and confirm section is gone.
    const later = after.nextFireAt + 1;
    // Reset step so selectCurrentStep can pick it again.
    const step = listSteps(db, job.id)[0];
    db.prepare(`UPDATE schedule_steps SET status = 'ready' WHERE id = ?`).run(step.id);
    // Finish the first run so skip path doesn't fire.
    const runs = listRunsForJob(db, job.id);
    for (const r of runs) {
      if (r.status === 'running' || r.status === 'pending') {
        db.prepare(`UPDATE schedule_runs SET status = 'succeeded', finished_at = ? WHERE id = ?`)
          .run(now, r.id);
      }
    }
    db.prepare('UPDATE schedule_jobs SET next_fire_at = ? WHERE id = ?').run(later - 1, job.id);

    let secondPrompt: string | undefined;
    dispatchTick.mockImplementation(async (ctx: TickContext) => { secondPrompt = ctx.prompt; });
    const scheduler2 = new JobScheduler({ getDb: () => db, dispatchTick, now: () => later });
    await scheduler2.tickOnce();

    expect(dispatchTick).toHaveBeenCalledTimes(2);
    expect(secondPrompt).not.toContain('Operator/parent context');
    expect(secondPrompt).not.toContain('remember to merge PR #12');
  });

  it('skip overlap does not consume pending context', async () => {
    const now = Date.now();
    const job = seedJob({
      nextFireAt: now - 1,
      carryContextEnabled: true,
    });
    setPendingContext(db, job.id, {
      text: 'keep me for the real fire',
      source: 'operator',
    });
    createRun(db, { jobId: job.id, status: 'running', firedAt: now });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).not.toHaveBeenCalled();
    const after = getJob(db, job.id)!;
    expect(after.pendingContext).toBe('keep me for the real fire');
    expect(listRunsForJob(db, job.id)).toContainEqual(
      expect.objectContaining({ status: 'skipped', error: 'overlap_skip' }),
    );
  });

  it('does not consume pending context when carryContextEnabled is false', async () => {
    const now = Date.now();
    const job = seedJob({
      nextFireAt: now - 1,
      carryContextEnabled: false,
    });
    // Write context even though flag is off (operator may enable later).
    setPendingContext(db, job.id, { text: 'held until enabled', source: 'operator' });

    let seenPrompt: string | undefined;
    const dispatchTick = vi.fn(async (ctx: TickContext) => { seenPrompt = ctx.prompt; });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledOnce();
    expect(seenPrompt).not.toContain('held until enabled');
    expect(getJob(db, job.id)!.pendingContext).toBe('held until enabled');
  });
});

describe('JobScheduler.runNow', () => {
  it('dispatches immediately, ignoring next_fire_at', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999 });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    const result = await scheduler.runNow(job.id);

    expect(result.ok).toBe(true);
    expect(dispatchTick).toHaveBeenCalledOnce();
    // next_fire_at is untouched by run-now (only tickOnce's claim path advances it)
    expect(getJob(db, job.id)!.nextFireAt).toBe(now + 999_999);
  });

  it('refuses to run when an active run already exists', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999 });
    createRun(db, { jobId: job.id, status: 'running', firedAt: now });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    const result = await scheduler.runNow(job.id);

    expect(result).toEqual({ ok: false, error: 'active_run_exists' });
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('returns an error for an unknown job id', async () => {
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}) });
    const result = await scheduler.runNow('nope');
    expect(result).toEqual({ ok: false, error: 'job_not_found' });
  });

  // Adversary F1: run-now on a pending once must not leave a second auto-fire.
  it('runNow on pending once exhausts the job so tick does not fire again', async () => {
    const now = Date.now();
    const atMs = now + 3_600_000; // one hour in the future
    const job = seedJob({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      nextFireAt: atMs,
      steps: [{ title: 'Once', body: 'single' }],
    });

    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    const result = await scheduler.runNow(job.id);

    expect(result.ok).toBe(true);
    expect(dispatchTick).toHaveBeenCalledOnce();
    const afterRunNow = getJob(db, job.id)!;
    expect(afterRunNow.enabled).toBe(false);
    expect(afterRunNow.nextFireAt).toBe(ONCE_EXHAUSTED_MS);

    // Finish the run so overlap isn't why the later tick skips.
    const runs = listRunsForJob(db, job.id);
    const active = runs.find((r) => r.status === 'running' || r.status === 'pending');
    if (active) {
      updateRun(db, active.id, { status: 'succeeded', finishedAt: now });
    }

    // Clock past original atMs — still must not re-fire.
    const later = atMs + 1;
    const scheduler2 = new JobScheduler({ getDb: () => db, dispatchTick, now: () => later });
    await scheduler2.tickOnce();
    expect(dispatchTick).toHaveBeenCalledOnce();
  });
});

describe('JobScheduler.finalizeRun', () => {
  it('marks the run succeeded and leaves an agent-updated step alone', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}), now: () => now });
    await scheduler.tickOnce();

    const step = listSteps(db, job.id)[0];
    const run = listRunsForJob(db, job.id)[0];

    scheduler.finalizeRun(run.id, { status: 'succeeded', outcomeSummary: 'done', stepUpdated: true });

    const finalRun = getRun(db, run.id)!;
    expect(finalRun.status).toBe('succeeded');
    expect(finalRun.outcomeSummary).toBe('done');
    expect(getStep(db, step.id)!.status).toBe('running'); // untouched — agent owns it
  });

  it('returns a still-running step to ready (not blocked) when the agent never touched it', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}), now: () => now });
    await scheduler.tickOnce();

    const step = listSteps(db, job.id)[0];
    const run = listRunsForJob(db, job.id)[0];

    scheduler.finalizeRun(run.id, { status: 'failed', stepUpdated: false });

    const finalRun = getRun(db, run.id)!;
    expect(finalRun.status).toBe('failed');
    expect(finalRun.error).toBe('no_step_update');
    // ready so next tick can re-select — blocked is only for agent-declared halt
    expect(getStep(db, step.id)!.status).toBe('ready');
  });

  it('on succeeded without step write, sets step ready and stamps no_step_update', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}), now: () => now });
    await scheduler.tickOnce();

    const step = listSteps(db, job.id)[0];
    const run = listRunsForJob(db, job.id)[0];

    scheduler.finalizeRun(run.id, { status: 'succeeded', outcomeSummary: 'worked', stepUpdated: false });

    expect(getRun(db, run.id)!.status).toBe('succeeded');
    expect(getRun(db, run.id)!.error).toBe('no_step_update');
    expect(getStep(db, step.id)!.status).toBe('ready');
  });

  it('interval busy-skip updates the run and broadcasts but does not notify', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    const notify = vi.fn();
    const broadcast = vi.fn();
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      notify,
      broadcastScheduleUpdated: broadcast,
    });
    await scheduler.tickOnce();
    broadcast.mockClear();
    notify.mockClear();

    const run = listRunsForJob(db, job.id)[0];
    scheduler.finalizeRun(run.id, {
      status: 'skipped',
      stepUpdated: false,
      error: 'bound_conversation_busy',
    });

    expect(getRun(db, run.id)!.status).toBe('skipped');
    expect(getRun(db, run.id)!.error).toBe('bound_conversation_busy');
    expect(broadcast).toHaveBeenCalledWith(
      job.projectId,
      job.id,
      expect.objectContaining({ runId: run.id, runStatus: 'skipped' }),
    );
    // Interval: next tick retries (D11) — no operator notify.
    expect(notify).not.toHaveBeenCalled();
  });

  it('once-job busy-skip notifies that the one-shot was lost', async () => {
    const now = Date.now();
    const atMs = now - 1;
    const bound = createConversation(db, { projectId, title: 'My chat' });
    const job = seedJob({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      nextFireAt: atMs,
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
      steps: [{ title: 'One-shot', body: 'Ping' }],
    });
    const notify = vi.fn();
    const broadcast = vi.fn();
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      notify,
      broadcastScheduleUpdated: broadcast,
    });
    await scheduler.tickOnce();
    broadcast.mockClear();
    notify.mockClear();

    const run = listRunsForJob(db, job.id)[0];
    scheduler.finalizeRun(run.id, {
      status: 'skipped',
      stepUpdated: false,
      error: 'bound_conversation_busy',
    });

    expect(getRun(db, run.id)!.status).toBe('skipped');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      category: 'scheduleRunEnded',
      jobId: job.id,
      jobName: job.name,
      runId: run.id,
      runStatus: 'skipped',
      conversationId: bound.id,
      conversationTitle: 'My chat',
      description:
        'Skipped because the conversation was busy; this one-shot schedule does not repeat',
    }));
  });
});

describe('JobScheduler.finalizeRun interrupt filter', () => {
  async function setup(deps: Partial<ConstructorParameters<typeof JobScheduler>[0]>) {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    const broadcast = vi.fn();
    const notify = vi.fn();
    const scheduler = new JobScheduler({
      getDb: () => db, dispatchTick: vi.fn(async () => {}), now: () => now,
      broadcastScheduleUpdated: broadcast, notify, ...deps,
    });
    await scheduler.tickOnce();
    broadcast.mockClear();
    notify.mockClear();
    return { scheduler, run: listRunsForJob(db, job.id)[0], broadcast, notify };
  }

  it('finalizeRun with judge=false broadcasts interruptWorthy:false and notify(input,false)', async () => {
    const { scheduler, run, broadcast, notify } = await setup({ judge: () => Promise.resolve(false) });
    scheduler.finalizeRun(run.id, { status: 'succeeded', stepUpdated: true });
    // Held until the verdict resolves.
    expect(broadcast).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1));
    expect(broadcast.mock.calls[0]![2]).toMatchObject({ runId: run.id, runStatus: 'succeeded', interruptWorthy: false });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ category: 'scheduleRunEnded', runStatus: 'succeeded' }), false);
  });

  it('finalizeRun without judge stays synchronous', async () => {
    const { scheduler, run, broadcast, notify } = await setup({});
    scheduler.finalizeRun(run.id, { status: 'succeeded', stepUpdated: true });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect('interruptWorthy' in (broadcast.mock.calls[0]![2] as object)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toBeUndefined();
  });
});

describe('JobScheduler.reclaimStuck', () => {
  it('marks old running runs failed and blocks their running step', () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999, runTimeoutMs: 60_000 });
    const step = listSteps(db, job.id)[0];
    const run = createRun(db, {
      jobId: job.id, stepId: step.id, status: 'running', firedAt: now - 60_000 - 1,
    });
    db.prepare(`UPDATE schedule_steps SET status = 'running' WHERE id = ?`).run(step.id);

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}), now: () => now });
    expect(scheduler.reclaimStuck()).toBe(1);

    expect(getRun(db, run.id)!.status).toBe('failed');
    expect(getStep(db, step.id)!.status).toBe('blocked');
  });

  it('does not reclaim runs still within the timeout window', () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999, runTimeoutMs: 60_000 });
    createRun(db, { jobId: job.id, status: 'running', firedAt: now - 1_000 });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}), now: () => now });
    expect(scheduler.reclaimStuck()).toBe(0);
  });

  it('does not reclaim a wall-clock-old run that still has recent tick activity', () => {
    // Multi-spawn wave: fired > timeout ago, but events keep landing → not stalled.
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999, runTimeoutMs: 60_000 });
    const tick = createConversation(db, { projectId, title: '⏱ active wave', kind: 'chat' });
    const run = createRun(db, {
      jobId: job.id, status: 'running', firedAt: now - 60_000 - 1, conversationId: tick.id,
    });
    createSession(db, { id: 'sess-active', conversationId: tick.id });
    appendEvent(db, {
      sessionId: 'sess-active', type: 'message', ts: now - 5_000,
      seq: 1, sender: 'agent', payload: { chunk: 'still working on children' },
    });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}), now: () => now });
    expect(scheduler.reclaimStuck()).toBe(0);
    expect(getRun(db, run.id)!.status).toBe('running');
  });

  it('does not reclaim when only an open notifyParent child has recent activity', () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999, runTimeoutMs: 60_000 });
    const tick = createConversation(db, { projectId, title: '⏱ parent parked', kind: 'chat' });
    const child = createConversation(db, {
      projectId, title: '↳ child', parentConversationId: tick.id,
    });
    createSpawnEdge(db, {
      parentConversationId: tick.id,
      childConversationId: child.id,
      role: 'impl',
      notifyParent: true,
    });
    const run = createRun(db, {
      jobId: job.id, status: 'running', firedAt: now - 60_000 - 1, conversationId: tick.id,
    });
    createSession(db, { id: 'sess-child', conversationId: child.id });
    appendEvent(db, {
      sessionId: 'sess-child', type: 'message', ts: now - 2_000,
      seq: 1, sender: 'agent', payload: { chunk: 'implementing…' },
    });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}), now: () => now });
    expect(scheduler.reclaimStuck()).toBe(0);
    expect(getRun(db, run.id)!.status).toBe('running');
  });

  it('tickOnce reclaims overdue runs before claiming due jobs (no restart required)', async () => {
    const now = Date.now();
    // Job is due, but a ghost running row (e.g. post-OOM) would block dispatch
    // under skip unless reclaim runs first on this poll.
    const job = seedJob({ nextFireAt: now - 1, runTimeoutMs: 60_000 });
    const stuck = createRun(db, {
      jobId: job.id, status: 'running', firedAt: now - 60_000 - 1,
    });
    const dispatchTick = vi.fn(async () => {});
    const scheduler = new JobScheduler({
      getDb: () => db, dispatchTick, now: () => now,
    });

    await scheduler.tickOnce();

    expect(getRun(db, stuck.id)!.status).toBe('failed');
    expect(getRun(db, stuck.id)!.error).toBe('reclaimed_stuck');
    // After reclaim, the due slot should dispatch a fresh run.
    expect(dispatchTick).toHaveBeenCalledOnce();
    const runs = listRunsForJob(db, job.id);
    expect(runs.some((r) => r.status === 'running' || r.status === 'pending' || r.status === 'succeeded')).toBe(true);
    expect(runs.find((r) => r.id === stuck.id)?.status).toBe('failed');
  });
});

describe('JobScheduler.start/stop', () => {
  it('polls tickOnce every SCHEDULE_POLL_MS and stops cleanly', async () => {
    vi.useFakeTimers();
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick: vi.fn(async () => {}) });
    const tickSpy = vi.spyOn(scheduler, 'tickOnce');
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe('JobScheduler broadcast detail payloads', () => {
  it('includes runId + runStatus:running on dispatch', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    const broadcasts: unknown[] = [];
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      broadcastScheduleUpdated: (projectId, jobId, detail) => {
        broadcasts.push({ projectId, jobId, ...detail });
      },
    });
    await scheduler.tickOnce();

    const run = listRunsForJob(db, job.id)[0];
    expect(broadcasts).toContainEqual(expect.objectContaining({
      projectId,
      jobId: job.id,
      runId: run.id,
      runStatus: 'running',
    }));
  });

  it('includes runId + runStatus:skipped on overlap skip', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    createRun(db, { jobId: job.id, status: 'running', firedAt: now });
    const broadcasts: unknown[] = [];
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      broadcastScheduleUpdated: (projectId, jobId, detail) => {
        broadcasts.push({ projectId, jobId, ...detail });
      },
    });
    await scheduler.tickOnce();

    expect(broadcasts).toContainEqual(expect.objectContaining({
      jobId: job.id,
      runStatus: 'skipped',
    }));
    expect((broadcasts[0] as { runId?: string }).runId).toBeTruthy();
  });

  it('includes finalize runStatus and unregisters active run', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    const runConv = createConversation(db, {
      projectId, title: 'run child', parentConversationId: homeId,
    });
    const broadcasts: unknown[] = [];
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      broadcastScheduleUpdated: (projectId, jobId, detail) => {
        broadcasts.push({ projectId, jobId, ...detail });
      },
    });
    await scheduler.tickOnce();
    const run = listRunsForJob(db, job.id)[0];
    // Simulate dispatch binding conversation.
    updateRun(db, run.id, { conversationId: runConv.id });
    scheduler.registerActiveRun(runConv.id, {
      projectId: job.projectId,
      jobId: job.id,
      runId: run.id,
    });
    expect(scheduler.lookupActiveRunByConversation(runConv.id)?.runId).toBe(run.id);

    broadcasts.length = 0;
    scheduler.finalizeRun(run.id, { status: 'succeeded', outcomeSummary: 'ok', stepUpdated: true });

    expect(broadcasts).toContainEqual(expect.objectContaining({
      runId: run.id,
      runStatus: 'succeeded',
      conversationId: runConv.id,
    }));
    expect(scheduler.lookupActiveRunByConversation(runConv.id)).toBeUndefined();
  });

  it('reclaim broadcasts failed and unregisters', () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 999_999, runTimeoutMs: 60_000 });
    const stuckConv = createConversation(db, {
      projectId, title: 'stuck run', parentConversationId: homeId,
    });
    const run = createRun(db, {
      jobId: job.id, status: 'running', firedAt: now - 60_000 - 1, conversationId: stuckConv.id,
    });
    const broadcasts: unknown[] = [];
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      broadcastScheduleUpdated: (projectId, jobId, detail) => {
        broadcasts.push({ projectId, jobId, ...detail });
      },
    });
    scheduler.registerActiveRun(stuckConv.id, {
      projectId: job.projectId, jobId: job.id, runId: run.id,
    });

    expect(scheduler.reclaimStuck()).toBe(1);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      runId: run.id,
      runStatus: 'failed',
      conversationId: stuckConv.id,
    }));
    expect(scheduler.lookupActiveRunByConversation(stuckConv.id)).toBeUndefined();
  });
});

describe('conversation timer sweep hook', () => {
  it('invokes sweepTimers once per tick, after the job loop', async () => {
    const calls: string[] = [];
    const sweepTimers = vi.fn(async (now: number) => { calls.push(`sweep:${typeof now}`); });
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: async () => { calls.push('dispatch'); },
      sweepTimers,
    });

    await scheduler.tickOnce();

    expect(sweepTimers).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['sweep:number']);
  });

  it('a throwing sweep does not break the tick', async () => {
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: async () => {},
      sweepTimers: async () => { throw new Error('boom'); },
    });

    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
  });
});

describe('usage-watcher sweep hook', () => {
  it('invokes sweepUsageLimits once per tick, after sweepTimers', async () => {
    const calls: string[] = [];
    const sweepTimers = vi.fn(async () => { calls.push('sweepTimers'); });
    const sweepUsageLimits = vi.fn(async () => { calls.push('sweepUsageLimits'); });
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: async () => {},
      sweepTimers,
      sweepUsageLimits,
    });

    await scheduler.tickOnce();

    expect(sweepUsageLimits).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['sweepTimers', 'sweepUsageLimits']);
  });

  it('a throwing usage sweep does not break the tick', async () => {
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: async () => {},
      sweepTimers: async () => {},
      sweepUsageLimits: async () => { throw new Error('boom'); },
    });

    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
  });
});

describe('JobScheduler bare tick prompt (grok-bot)', () => {
  const BOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const GROK_PROFILE = `grok-bot:${BOT}`;

  beforeEach(async () => {
    const { seedCatalogue, enableAllAgents } = await import('../db/seed.js');
    const { catalogue } = await import('../catalogue.js');
    const { upsertDiscoveredModels } = await import('../repositories/models.js');
    const { setDb } = await import('../db/index.js');
    seedCatalogue(db);
    enableAllAgents(db);
    upsertDiscoveredModels(db, 'grok-bot', [{
      name: BOT, label: 'Grok Bot · Test', provider: 'xai', vision: false, steer: true,
    }]);
    setDb(db);
    catalogue.load(db);
  });

  it('grok-bot job → empty runToken and prompt without footer', async () => {
    const now = Date.now();
    const bound = createConversation(db, { projectId, title: 'bot chat' });
    seedJob({
      nextFireAt: now - 1,
      profileId: GROK_PROFILE,
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
      steps: [],
      promptTemplate: 'Ping the bot about {{vars.topic}}',
      variables: { topic: 'weather' },
      steer: 'Be brief',
    });

    let seenCtx: TickContext | undefined;
    const dispatchTick = vi.fn(async (ctx: TickContext) => { seenCtx = ctx; });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledOnce();
    expect(seenCtx!.runToken).toBe('');
    expect(seenCtx!.prompt).toContain('Ping the bot about weather');
    expect(seenCtx!.prompt).toContain('Be brief');
    expect(seenCtx!.prompt).not.toContain('Run token');
    expect(seenCtx!.prompt).not.toContain('/steps');
    expect(seenCtx!.prompt).not.toContain('complete-job');
    expect(seenCtx!.prompt).not.toContain('UNTRUSTED');
    expect(seenCtx!.prompt).not.toContain('Schedule step API');
  });

  it('claude-code job is unchanged (token non-empty, footer present)', async () => {
    const now = Date.now();
    seedJob({ nextFireAt: now - 1 });

    let seenCtx: TickContext | undefined;
    const dispatchTick = vi.fn(async (ctx: TickContext) => { seenCtx = ctx; });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await scheduler.tickOnce();

    expect(dispatchTick).toHaveBeenCalledOnce();
    expect(seenCtx!.runToken).toBeTruthy();
    expect(seenCtx!.prompt).toContain('Run token (ephemeral):');
    expect(seenCtx!.prompt).toContain('Schedule step API');
  });
});

describe('JobScheduler host-miss auto-disable (Task 11)', () => {
  const HOST_ERR = 'host_disconnected: profile claude-code:opus-4.8 not available on host';

  function seedHostMiss(jobId: string, firedAt: number): void {
    const run = createRun(db, { jobId, status: 'failed', firedAt });
    updateRun(db, run.id, { finishedAt: firedAt + 1, error: HOST_ERR });
  }

  it('two host misses → job still enabled', () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 60_000, enabled: true });
    seedHostMiss(job.id, now - 2_000);
    const run = createRun(db, { jobId: job.id, status: 'running', firedAt: now - 1_000 });
    const notify = vi.fn();
    const broadcast = vi.fn();
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      notify,
      broadcastScheduleUpdated: broadcast,
    });
    scheduler.finalizeRun(run.id, { status: 'failed', stepUpdated: false, error: HOST_ERR });
    expect(getJob(db, job.id)!.enabled).toBe(true);
    expect(broadcast).not.toHaveBeenCalledWith(
      job.projectId,
      job.id,
      expect.objectContaining({ event: 'auto_disabled' }),
    );
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ category: 'scheduleDisabled' }));
    expect(HOST_MISS_AUTO_DISABLE).toBe(3);
  });

  it('third consecutive host miss → disabled + auto_disabled broadcast + scheduleDisabled notify', () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 60_000, enabled: true });
    seedHostMiss(job.id, now - 3_000);
    seedHostMiss(job.id, now - 2_000);
    const run = createRun(db, { jobId: job.id, status: 'running', firedAt: now - 1_000 });
    const notify = vi.fn();
    const broadcast = vi.fn();
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      notify,
      broadcastScheduleUpdated: broadcast,
    });
    scheduler.finalizeRun(run.id, { status: 'failed', stepUpdated: false, error: HOST_ERR });
    expect(getJob(db, job.id)!.enabled).toBe(false);
    expect(broadcast).toHaveBeenCalledWith(
      job.projectId,
      job.id,
      expect.objectContaining({ jobName: job.name, event: 'auto_disabled' }),
    );
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      category: 'scheduleDisabled',
      jobId: job.id,
      jobName: job.name,
    }));
  });

  it('miss, success, miss, miss → still enabled (not 3 consecutive)', () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 60_000, enabled: true });
    seedHostMiss(job.id, now - 4_000);
    const ok = createRun(db, { jobId: job.id, status: 'succeeded', firedAt: now - 3_000 });
    updateRun(db, ok.id, { finishedAt: now - 2_900 });
    seedHostMiss(job.id, now - 2_000);
    const run = createRun(db, { jobId: job.id, status: 'running', firedAt: now - 1_000 });
    const notify = vi.fn();
    const broadcast = vi.fn();
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      notify,
      broadcastScheduleUpdated: broadcast,
    });
    scheduler.finalizeRun(run.id, { status: 'failed', stepUpdated: false, error: HOST_ERR });
    expect(getJob(db, job.id)!.enabled).toBe(true);
    expect(broadcast).not.toHaveBeenCalledWith(
      job.projectId,
      job.id,
      expect.objectContaining({ event: 'auto_disabled' }),
    );
  });

  it('already-disabled job is not re-notified on another host miss', () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now + 60_000, enabled: true });
    setJobEnabled(db, job.id, false);
    seedHostMiss(job.id, now - 3_000);
    seedHostMiss(job.id, now - 2_000);
    const run = createRun(db, { jobId: job.id, status: 'running', firedAt: now - 1_000 });
    const notify = vi.fn();
    const broadcast = vi.fn();
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      notify,
      broadcastScheduleUpdated: broadcast,
    });
    scheduler.finalizeRun(run.id, { status: 'failed', stepUpdated: false, error: HOST_ERR });
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ category: 'scheduleDisabled' }));
    expect(broadcast).not.toHaveBeenCalledWith(
      job.projectId,
      job.id,
      expect.objectContaining({ event: 'auto_disabled' }),
    );
  });
});

describe('JobScheduler tick failures', () => {
  it('a job whose dispatch throws (project deleted mid-dispatch) does not reject the tick or stall the next tick', async () => {
    const now = Date.now();
    const a = seedJob({ name: 'a', nextFireAt: now - 1 });
    const b = seedJob({ name: 'b', nextFireAt: now - 1 });
    const seen: string[] = [];
    const dispatchTick = vi.fn(async (ctx: TickContext) => {
      seen.push(ctx.job.id);
      if (ctx.job.id === a.id) throw new Error('FOREIGN KEY constraint failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick, now: () => now });
    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
    expect(seen).toEqual(expect.arrayContaining([a.id, b.id]));
    warn.mockRestore();
  });

  it('a tick-level throw resolves and the next tick still runs', async () => {
    let calls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scheduler = new JobScheduler({
      getDb: () => { calls++; if (calls === 1) throw new Error('boom'); return db; },
      dispatchTick: vi.fn(async () => {}),
      now: () => Date.now(),
    });
    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
    expect(calls).toBeGreaterThan(1);
    warn.mockRestore();
  });
});
