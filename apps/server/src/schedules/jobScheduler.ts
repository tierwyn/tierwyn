import type { Database } from 'better-sqlite3';
import type { ScheduleJob, ScheduleStep, ScheduleRun, RunStatus, AgentStatus, NotificationInput } from '@tierwyn/shared';
import { agentTakesBarePrompt } from '@tierwyn/shared';
import {
  claimDueJobs, hasActiveRun, createRun, updateRun, selectCurrentStep,
  updateStepStatus, setNextFireAt, setJobEnabled, getJob, getStep, getRun,
  listStuckRunningRuns, listSteps, consumePendingContext, healInfraBlockedSteps,
  pruneInertOperatorHoleRows, setDeferredFire, claimDeferredFire,
  listJobsWithDeferredFire, listRunsForJob,
} from '../repositories/schedules.js';
import { getProject } from '../repositories/projects.js';
import { getConversation } from '../repositories/conversations.js';
import { computeNextFireAt, ONCE_EXHAUSTED_MS } from './nextFire.js';
import { getActiveOperatorSkipSet, nextNonSkippedFireAt } from './operatorSkip.js';
import { resolveJobProfile } from './profile.js';
import { renderTickPrompt } from './prompt.js';
import { issueRunToken } from './runTokens.js';
import { isScheduleRunStalled, lastTickActivityMs } from './runActivity.js';

export const SCHEDULE_POLL_MS = 5_000;

/** Consecutive `host_disconnected` failures before auto-disable (H2). */
export const HOST_MISS_AUTO_DISABLE = 3;

/**
 * Bounds the missed-slot enumeration loop in processCatchUp so a year-paused
 * job cannot spin computeNextFireAt thousands of times on one poll.
 * NOT a per-tick dispatch count — dispatch is always ≤1 per tick per job.
 */
export const CATCH_UP_MAX_PER_CYCLE = 5;

export interface TickContext {
  job: ScheduleJob;
  run: ScheduleRun;
  step: ScheduleStep | undefined;
  prompt: string;
  runToken: string;
}

export interface FinalizeResult {
  status: 'succeeded' | 'failed' | 'timed_out' | 'skipped';
  outcomeSummary?: string;
  error?: string;
  /** true if the agent mutated steps during the run */
  stepUpdated: boolean;
}

/** Optional detail on schedule_updated so clients can patch live run status. */
export interface ScheduleUpdatedDetail {
  runId?: string;
  runStatus?: RunStatus;
  conversationId?: string;
  agentStatus?: AgentStatus;
  /** Job name on notification-worthy broadcasts (fire / finalize / auto-disable). */
  jobName?: string;
  /** Why this broadcast happened when not derivable from runStatus alone. */
  event?: 'fired' | 'auto_disabled';
  /** Jev verdict on the terminal finalize frame; false = clients skip the toast. */
  interruptWorthy?: boolean;
}

export interface ActiveRunBinding {
  projectId: string;
  jobId: string;
  runId: string;
}

export interface JobSchedulerDeps {
  getDb: () => Database;
  /** Injected so tests can stub dispatch without real agents */
  dispatchTick: (ctx: TickContext) => Promise<void>;
  now?: () => number;
  broadcastScheduleUpdated?: (
    projectId: string,
    jobId: string,
    detail?: ScheduleUpdatedDetail,
  ) => void;
  /** Base URL for the step API footer in prompts (e.g. http://127.0.0.1:8787); wired at boot. */
  stepApiBase?: string;
  /** Fire-and-forget operator notification (web push). */
  notify?: (input: NotificationInput, interruptWorthy?: boolean) => void;
  /** Jev interrupt filter. Sync undefined = not applicable (finalize stays synchronous). */
  judge?: (input: NotificationInput) => Promise<boolean | undefined> | undefined;
  /**
   * Optional per-conversation prompt-timer sweep, injected at boot. Runs once at
   * the end of every tick inside the same `ticking` guard — deliberately NOT a
   * second setInterval. Consequence: a 5s timer can slip by up to one poll
   * interval (SCHEDULE_POLL_MS). Accepted.
   */
  sweepTimers?: (now: number) => Promise<void>;
  /**
   * Usage-limit watcher layer-2 drain, invoked once per tick right after
   * sweepTimers inside the same `ticking` guard. Draining an empty arm Map is
   * cheap; a failure must never stall the job loop, so it is caught and logged.
   */
  sweepUsageLimits?: (now: number) => Promise<void>;
}

/**
 * Drives schedule_jobs through claim → skip / queue_one latch / catch_up /
 * dispatch → advance next_fire_at, and reclaims stuck `running` runs on every
 * poll (and at boot). Overlap policies never run two concurrent runs for the
 * same job; deferred backlog drains one dispatch per completed run via
 * drainDeferred. No agent dispatch lives here; `dispatchTick` is fully injected
 * so this module has zero knowledge of adapters/handlePrompt.
 */
export class JobScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /** In-memory map: conversationId → active schedule run binding (no DB hit for mid-run status). */
  private readonly activeRunsByConversation = new Map<string, ActiveRunBinding>();

  constructor(private readonly deps: JobSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, SCHEDULE_POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Register a run conversation for mid-run schedule_updated fan-out. */
  registerActiveRun(conversationId: string, binding: ActiveRunBinding): void {
    this.activeRunsByConversation.set(conversationId, binding);
  }

  /** Drop a conversation from the active-run registry (finalize / fail / reclaim). */
  unregisterActiveRun(conversationId: string): void {
    this.activeRunsByConversation.delete(conversationId);
  }

  /** Lookup without DB — used by SessionManager status fan-out. */
  lookupActiveRunByConversation(conversationId: string): ActiveRunBinding | undefined {
    return this.activeRunsByConversation.get(conversationId);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private broadcast(
    projectId: string,
    jobId: string,
    detail?: ScheduleUpdatedDetail,
  ): void {
    this.deps.broadcastScheduleUpdated?.(projectId, jobId, detail);
  }

  /**
   * One poll cycle — also used by tests and (indirectly) by run-now.
   * Always reclaims overdue `running` runs first so an OOM/restart that dropped
   * the in-process dispatch timeout cannot leave a permanent active_run lock.
   */
  async tickOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const reclaimed = this.reclaimStuck();
      if (reclaimed > 0) {
        console.log(`[schedules] reclaimed ${reclaimed} stuck run(s)`);
      }
      const db = this.deps.getDb();
      const now = this.now();
      // Drop legacy operator_unskip + past operator_skip so past-runs LIMIT stays honest.
      const pruned = pruneInertOperatorHoleRows(db, now);
      if (pruned > 0) {
        console.log(`[schedules] pruned ${pruned} inert operator hole row(s)`);
      }
      const due = claimDueJobs(db, now);
      for (const job of due) {
        // A job whose dispatch throws (e.g. its project was deleted mid-dispatch
        // → FK error) must not skip the rest of the batch.
        try {
          await this.processDueJob(db, job, now);
        } catch (e) {
          console.warn(`[schedules] job ${job.id} tick failed:`, e);
        }
      }
      // Single CAS-guarded consumer of deferred_fire for queue_one + catch_up.
      await this.drainDeferred(db, now);
      // Prompt timers ride this poll. A failure here must never stall the job
      // loop, so it is caught and logged rather than propagated.
      if (this.deps.sweepTimers) {
        try {
          await this.deps.sweepTimers(now);
        } catch (e) {
          console.warn('[timers] sweep failed:', e);
        }
      }
      // Usage-limit watcher layer-2 drain rides the same poll. Notification
      // only in Phase 5; a failure here must never stall the job loop.
      if (this.deps.sweepUsageLimits) {
        try {
          await this.deps.sweepUsageLimits(now);
        } catch (e) {
          console.warn('[usage-watcher] sweep failed:', e);
        }
      }
    } catch (e) {
      // tickOnce is fired with `void` from setInterval and the hub has no
      // unhandledRejection handler — a rejection here would kill the process.
      console.warn('[schedules] tick failed:', e);
    } finally {
      this.ticking = false;
    }
  }

  private async processDueJob(db: Database, job: ScheduleJob, now: number): Promise<void> {
    // catch_up owns next_fire_at advance itself (enumerate missed slots).
    if (job.overlapPolicy === 'catch_up') {
      await this.processCatchUp(db, job, now);
      return;
    }

    // skip / queue_one: always advance next_fire_at for a claimed due slot.
    // Jump over any operator_skip holes so hole-punched future ticks never dispatch.
    const skipSet = getActiveOperatorSkipSet(db, job, now);
    const next = nextNonSkippedFireAt(
      job,
      Math.max(job.nextFireAt, now - 1),
      skipSet,
    );
    setNextFireAt(db, job.id, next);
    if (job.scheduleKind === 'once') {
      // Claim-time disable — once fires exactly once; crash-safe vs double-fire (plan D2).
      setJobEnabled(db, job.id, false);
      this.broadcast(job.projectId, job.id, { jobName: job.name, event: 'auto_disabled' });
      this.deps.notify?.({
        category: 'scheduleDisabled',
        jobId: job.id,
        jobName: job.name,
        projectName: getProject(db, job.projectId)?.name,
      });
    }

    if (hasActiveRun(db, job.id)) {
      if (job.overlapPolicy === 'queue_one') {
        // Latch one owed fire; no run row, no skipped broadcast.
        setDeferredFire(db, job.id, true);
        return;
      }
      // skip (default)
      const skipped = createRun(db, { jobId: job.id, status: 'skipped', firedAt: now });
      updateRun(db, skipped.id, { finishedAt: now, error: 'overlap_skip' });
      this.broadcast(job.projectId, job.id, {
        runId: skipped.id,
        runStatus: 'skipped',
      });
      return;
    }

    await this.dispatchNewRun(db, job, now);
  }

  /**
   * catch_up: enumerate missed non-skipped slots (cap CATCH_UP_MAX_PER_CYCLE),
   * dispatch at most one run, advance next_fire_at by one real slot. Remaining
   * backlog stays due (next_fire_at ≤ now) and drains one-per-completed-run.
   */
  private async processCatchUp(db: Database, job: ScheduleJob, now: number): Promise<void> {
    const skipSet = getActiveOperatorSkipSet(db, job, now);

    // 1. Enumerate missed, non-skipped slots at/behind `now`, starting from the
    //    claimed slot. Cap the loop at CATCH_UP_MAX_PER_CYCLE (enumeration only).
    const missed: number[] = [];
    let cursor = job.nextFireAt - 1; // so first result ≥ job.nextFireAt
    for (let i = 0; i < CATCH_UP_MAX_PER_CYCLE; i++) {
      const slot = computeNextFireAt({
        scheduleKind: job.scheduleKind,
        scheduleExpr: job.scheduleExpr,
        timezone: job.timezone,
        afterMs: cursor,
        createdAtMs: job.createdAt,
      });
      if (slot >= ONCE_EXHAUSTED_MS) break;
      if (slot > now) break;
      cursor = slot;
      if (skipSet.has(slot)) continue; // operator hole → not a catch-up candidate
      missed.push(slot);
    }

    // 2. Active run: latch and LEAVE next_fire_at unadvanced so the slot is still owed.
    if (hasActiveRun(db, job.id)) {
      setDeferredFire(db, job.id, true);
      return;
    }

    // 3. Nothing actually missed (all holes, or only future) — advance past holes.
    if (missed.length === 0) {
      const next = nextNonSkippedFireAt(job, Math.max(job.nextFireAt, now - 1), skipSet);
      setNextFireAt(db, job.id, next);
      if (job.scheduleKind === 'once') setJobEnabled(db, job.id, false);
      // Symmetry with step 4: clear any vestigial latch so drainDeferred's
      // stale-latch guard is defensive rather than load-bearing for this path.
      setDeferredFire(db, job.id, false);
      return;
    }

    // 4. Dispatch ONE run for the oldest missed slot; advance by one non-skipped slot.
    const next = nextNonSkippedFireAt(job, missed[0], skipSet);
    setNextFireAt(db, job.id, next);
    if (job.scheduleKind === 'once') setJobEnabled(db, job.id, false);
    // Clear any stale latch — we are handling owed work now.
    setDeferredFire(db, job.id, false);
    await this.dispatchNewRun(db, job, now);
  }

  /**
   * Drain deferred_fire latches at end of tickOnce. Single CAS-guarded consumer:
   * hasActiveRun → leave flag; else claim → (catch_up: advance one slot) → dispatch.
   * At most one new run per job per call (dispatch creates running → next candidate skips).
   */
  private async drainDeferred(db: Database, now: number): Promise<void> {
    const owed = listJobsWithDeferredFire(db);
    for (const job of owed) {
      if (hasActiveRun(db, job.id)) {
        // Leave deferred_fire=1; retry next tick.
        continue;
      }
      if (!claimDeferredFire(db, job.id)) {
        // Another consumer already claimed (or flag cleared).
        continue;
      }

      // Re-read after claim for fresh next_fire_at / policy.
      const fresh = getJob(db, job.id);
      if (!fresh) continue;

      if (fresh.overlapPolicy === 'catch_up') {
        // Decision B: advance next_fire_at by exactly one non-skipped slot per
        // deferred fire so the backlog terminates (not infinite re-fire at same slot).
        // Stale-latch guard: if processCatchUp already advanced past now, claim
        // alone cleared the flag — do not dispatch an extra run.
        if (fresh.nextFireAt > now) {
          continue;
        }
        const skipSet = getActiveOperatorSkipSet(db, fresh, now);
        const next = nextNonSkippedFireAt(fresh, fresh.nextFireAt, skipSet);
        setNextFireAt(db, fresh.id, next);
        if (fresh.scheduleKind === 'once') setJobEnabled(db, fresh.id, false);
      }
      // queue_one: next_fire_at already advanced when the latch was set.

      await this.dispatchNewRun(db, fresh, now);
    }
  }

  private async dispatchNewRun(db: Database, job: ScheduleJob, now: number): Promise<ScheduleRun> {
    // Unstick false freezes from pre-fix finalize or step-API failures before pick.
    const healed = healInfraBlockedSteps(db, job.id);
    if (healed.length > 0) {
      console.log(
        `[schedules] auto-healed ${healed.length} infra-blocked step(s) on job ${job.id}: `
        + healed.map((s) => s.id.slice(0, 8)).join(', '),
      );
    }

    const step = selectCurrentStep(db, job.id);
    // CONCURRENCY INVARIANT: callers gate on hasActiveRun, then reach this createRun
    // with NO await in between. That synchronous check→create window is the ONLY
    // thing preventing runNow (un-guarded) and tickOnce from racing two runs into
    // existence for one job. Do NOT introduce an await between a hasActiveRun check
    // and this line (e.g. by making selectCurrentStep/healInfraBlockedSteps async).
    const run = createRun(db, { jobId: job.id, stepId: step?.id, status: 'pending', firedAt: now });
    if (step) updateStepStatus(db, step.id, 'running');

    // Consume-once: only on non-skip tick start, and only when carry is enabled.
    // Skipped overlap fires never reach this method.
    let pendingContext: string | undefined;
    if (job.carryContextEnabled) {
      pendingContext = consumePendingContext(db, job.id);
    }

    const prof = resolveJobProfile(db, job);
    // Bare agents (Grok Bot): no run token — rebindRunToken('', …) is already a no-op.
    const bare = prof.ok && agentTakesBarePrompt(prof.profile.agentType);
    const runToken = bare
      ? ''
      : issueRunToken({ jobId: job.id, runId: run.id, conversationId: '' });
    const prompt = renderTickPrompt({
      promptTemplate: job.promptTemplate,
      job,
      step,
      steps: listSteps(db, job.id),
      runId: run.id,
      stepApiBase: this.deps.stepApiBase ?? '',
      runToken,
      steer: job.steer,
      pendingContext,
      barePrompt: bare,
    });

    const running = updateRun(db, run.id, { status: 'running' }) ?? { ...run, status: 'running' as const };
    // conversationId often still empty — dispatch binds it after createConversation.
    this.broadcast(job.projectId, job.id, {
      runId: running.id,
      runStatus: 'running',
    });

    await this.deps.dispatchTick({ job, run: running, step, prompt, runToken });
    return running;
  }

  /** Operator run-now: ignore next_fire_at; still honor skip if an active run exists. */
  async runNow(jobId: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    // Reclaim overdue running rows first so a lost dispatch timer cannot block run-now forever.
    this.reclaimStuck();
    const db = this.deps.getDb();
    const job = getJob(db, jobId);
    if (!job) return { ok: false, error: 'job_not_found' };

    // Not under the ticking guard — safe only because the path from here to
    // dispatchNewRun's createRun is fully synchronous (see CONCURRENCY INVARIANT there).
    if (hasActiveRun(db, jobId)) {
      return { ok: false, error: 'active_run_exists' };
    }

    const now = this.now();
    // F1 (adversary): run-now on a pending once must consume the one-shot slot.
    // Without this, next_fire_at stays at atMs and the scheduler fires again later.
    if (job.scheduleKind === 'once') {
      setNextFireAt(db, jobId, ONCE_EXHAUSTED_MS);
      setJobEnabled(db, jobId, false);
    }
    const run = await this.dispatchNewRun(db, job, now);
    return { ok: true, runId: run.id };
  }

  /** Public so dispatch (Task 7+) can call it once the agent turn concludes. */
  finalizeRun(runId: string, result: FinalizeResult): void {
    const db = this.deps.getDb();
    const run = getRun(db, runId);
    if (!run) return;

    let error = result.error;
    // Missing step write is not "agent declared blocked". Put the step back to
    // ready so the next tick can re-select it (false freezes from API/FK failures
    // or agents that finished work without a successful PUT/PATCH).
    if (!result.stepUpdated && run.stepId) {
      const step = getStep(db, run.stepId);
      if (step && step.status === 'running') {
        updateStepStatus(db, step.id, 'ready');
        error = error ?? 'no_step_update';
      }
    }

    updateRun(db, runId, {
      status: result.status,
      finishedAt: this.now(),
      ...(result.outcomeSummary !== undefined ? { outcomeSummary: result.outcomeSummary } : {}),
      ...(error !== undefined ? { error } : {}),
    });

    if (run.conversationId) {
      this.unregisterActiveRun(run.conversationId);
    }

    const job = getJob(db, run.jobId);
    if (!job) return;

    // H2: K consecutive host_disconnected misses → auto-disable (first/second keep enabled).
    const failError = error ?? result.error;
    if (
      result.status === 'failed'
      && typeof failError === 'string'
      && failError.startsWith('host_disconnected')
      && job.enabled
    ) {
      const recent = listRunsForJob(db, job.id, {
        limit: HOST_MISS_AUTO_DISABLE,
        excludeHoleRows: true,
      });
      const allHostMisses = recent.length >= HOST_MISS_AUTO_DISABLE
        && recent.every(
          (r) => r.status === 'failed'
            && typeof r.error === 'string'
            && r.error.startsWith('host_disconnected'),
        );
      if (allHostMisses) {
        setJobEnabled(db, job.id, false);
        this.broadcast(job.projectId, job.id, {
          jobName: job.name,
          event: 'auto_disabled',
        });
        this.deps.notify?.({
          category: 'scheduleDisabled',
          jobId: job.id,
          jobName: job.name,
          projectName: getProject(db, job.projectId)?.name,
        });
      }
    }

    // Overlap / bound-busy skips: update + unregister + broadcast.
    // Interval busy-skips stay silent (next tick retries, D11). A once job that
    // busy-skips has no next fire — notify so the operator knows the message
    // was lost (notify-only; no re-arm).
    if (result.status === 'skipped') {
      const skipConvId = job.boundConversationId ?? run.conversationId ?? undefined;
      this.broadcast(job.projectId, job.id, {
        runId: run.id,
        runStatus: result.status,
        jobName: job.name,
        ...(skipConvId ? { conversationId: skipConvId } : {}),
      });
      const skipError = error ?? result.error;
      if (
        skipError === 'bound_conversation_busy'
        && job.scheduleKind === 'once'
      ) {
        const bound = skipConvId ? getConversation(db, skipConvId) : undefined;
        this.deps.notify?.({
          category: 'scheduleRunEnded',
          jobId: job.id,
          jobName: job.name,
          runId: run.id,
          runStatus: 'skipped',
          conversationId: skipConvId,
          conversationTitle: bound?.title,
          description:
            'Skipped because the conversation was busy; this one-shot schedule does not repeat',
          projectName: getProject(db, job.projectId)?.name,
        });
      }
      return;
    }

    const input: NotificationInput = {
      category: 'scheduleRunEnded',
      jobId: job.id,
      jobName: job.name,
      runId: run.id,
      runStatus: result.status,
      conversationId: run.conversationId,
      description: run.conversationId ? getConversation(db, run.conversationId)?.description : undefined,
      projectName: getProject(db, job.projectId)?.name,
    };
    const emit = (w?: boolean): void => {
      this.broadcast(job.projectId, job.id, {
        runId: run.id,
        runStatus: result.status,
        jobName: job.name,
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
        ...(w !== undefined ? { interruptWorthy: w } : {}),
      });
      this.deps.notify?.(input, w);
    };
    const pending = this.deps.judge?.(input);
    if (pending) {
      void pending
        .then(emit, () => emit())
        .catch((err) => console.warn('[schedules] deferred run-ended emit failed:', err instanceof Error ? err.message : 'error'));
    }
    else emit();
  }

  /**
   * Reclaim stalled `running` runs whose idle budget (`run_timeout_ms`) has
   * expired with no recent activity on the tick (or its open notifyParent
   * children). Wall-clock age alone is not enough — multi-spawn waves often
   * outlive the nominal timeout while still progressing.
   * Called at boot and at the start of every poll so DB timeout is source of
   * truth even when the in-process dispatch timer was lost (OOM/restart).
   * Returns count reclaimed.
   */
  reclaimStuck(): number {
    const db = this.deps.getDb();
    const now = this.now();
    const candidates = listStuckRunningRuns(db, now);
    let count = 0;
    for (const run of candidates) {
      const job = getJob(db, run.jobId);
      if (!job) continue;
      const lastActivityMs = lastTickActivityMs(db, run.conversationId, run.firedAt);
      if (!isScheduleRunStalled({
        now,
        firedAt: run.firedAt,
        runTimeoutMs: job.runTimeoutMs,
        lastActivityMs,
      })) {
        continue;
      }

      updateRun(db, run.id, { status: 'failed', finishedAt: now, error: 'reclaimed_stuck' });
      if (run.stepId) {
        const step = getStep(db, run.stepId);
        if (step && step.status === 'running') updateStepStatus(db, step.id, 'blocked');
      }
      if (run.conversationId) {
        this.unregisterActiveRun(run.conversationId);
      }
      count++;
      this.broadcast(job.projectId, job.id, {
        runId: run.id,
        runStatus: 'failed',
        jobName: job.name,
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      });
      this.deps.notify?.({
        category: 'scheduleRunEnded',
        jobId: job.id,
        jobName: job.name,
        runId: run.id,
        runStatus: 'failed',
        conversationId: run.conversationId,
        description: run.conversationId ? getConversation(db, run.conversationId)?.description : undefined,
        projectName: getProject(db, job.projectId)?.name,
      });
    }
    return count;
  }
}
