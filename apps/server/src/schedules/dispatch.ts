import type { Database } from 'better-sqlite3';
import {
  formatIsoLocalInTimezone,
  hostHasFeature,
  monotonicChildSandbox,
  profileAvailableOnHost,
  type GrokBotLifecycleStatus,
  type RemoteHostView,
} from '@tierwyn/shared';
import { supervisorMessage } from '../adapters/grok-bot/supervisor.js';
import { notifyOperator } from '../notifications/notifier.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { resolveSandboxFor } from '../repositories/sandboxSettings.js';
import { sandboxCapability } from '../sandbox/capability.js';
import { lastSessionForConversation } from '../repositories/sessions.js';
import { autoMintPeerRing } from '../mesh/autoEdges.js';
import { getProject } from '../repositories/projects.js';
import { getRemoteHost } from '../repositories/remoteHosts.js';
import { listSteps, updateRun } from '../repositories/schedules.js';
import { listOpenEdgesForParent } from '../repositories/spawnEdges.js';
import { isProjectMoving, PROJECT_MOVING_ERROR } from '../projectMove.js';
import type { SessionManager } from '../sessionManager.js';
import { watchChildResult } from '../spawn/watch.js';
import { isGitRepo, createWorktree } from '../worktree.js';
import { RemoteGitOps, type GitNodeHub } from '../git/remoteOps.js';
import { rebindRunToken, revokeRunTokensForRun } from './runTokens.js';
import { resolveJobProfile } from './profile.js';
import {
  isScheduleRunStalled,
  lastTickActivityMs,
  SCHEDULE_STALL_POLL_MS,
} from './runActivity.js';
import type {
  TickContext,
  FinalizeResult,
  ActiveRunBinding,
  ScheduleUpdatedDetail,
} from './jobScheduler.js';

/** Short race: fail-fast when the app can never run. Slow launch after
 *  `starting` is handled inside handlePrompt's `_awaitSupervisor` (~35 s),
 *  which does not block the scheduler tick. */
const GROK_BOT_ENSURE_MS = 5_000;

/**
 * Supervisor `GrokBotLifecycleState` vocabulary for the fire-time gate
 * (mirrors `grokBotUsable` / picker canLaunch: only `running` | `starting`):
 * - runnable-or-becoming → proceed with dispatch
 * - terminal non-runnable (disabled, stopped, failed, backoff, …) → fail
 */
function grokBotDispatchReady(s: GrokBotLifecycleStatus): boolean {
  return s.state === 'running' || s.state === 'starting';
}

function raceTimeout<T>(ms: number): { promise: Promise<T | undefined>; clear: () => void } {
  let h: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T | undefined>((resolve) => {
    h = setTimeout(() => resolve(undefined), ms);
    if (typeof (h as { unref?: () => void }).unref === 'function') {
      (h as { unref: () => void }).unref();
    }
  });
  return {
    promise,
    clear: () => {
      if (h !== undefined) clearTimeout(h);
      h = undefined;
    },
  };
}

export interface ScheduleDispatchDeps {
  sessionManager: SessionManager;
  getDb: () => Database;
  onComplete: (runId: string, result: FinalizeResult) => void;
  /** Bind run conversation for mid-run schedule_updated (JobScheduler registry). */
  registerActiveRun?: (conversationId: string, binding: ActiveRunBinding) => void;
  /** Unregister on fail-before-prompt after conversation was bound. */
  unregisterActiveRun?: (conversationId: string) => void;
  /** Broadcast schedule_updated with optional run detail. */
  broadcastScheduleUpdated?: (
    projectId: string,
    jobId: string,
    detail?: ScheduleUpdatedDetail,
  ) => void;
  nodeHub?: GitNodeHub;
  /**
   * Fire-time Grok Bot availability pre-check (D2/A5). Runs before any run
   * conversation bind. Production wires `bindEnsureGrokBot` (kick launch,
   * return live `status()` — never await the full ensure). Short 5 s race is
   * only a safety net around a wedged status read. `running` | `starting`
   * proceed; the adapter's `_awaitSupervisor` joins the in-flight launch.
   */
  ensureGrokBot?: () => Promise<GrokBotLifecycleStatus>;
  /** Live remote-host view for fire-time availability (H2/D6). */
  remoteHostView?: (id: string) => RemoteHostView | undefined;
}

/** True if any step of the job has been touched (agent PATCH bumps updated_at)
 *  strictly after `startedAt`. Used to decide whether an unfinished step should
 *  be blocked (see JobScheduler.finalizeRun's `stepUpdated` gate). */
export function detectStepUpdate(db: Database, jobId: string, startedAt: number): boolean {
  return listSteps(db, jobId).some((s) => s.updatedAt > startedAt);
}

/**
 * In-process tick dispatch for `spawn_child` and `resume_conversation`.
 * `spawn_child` mirrors `routes/spawn.ts` dispatchSpawn (creates a child under
 * the job's home, optional worktree). `resume_conversation` prompts the bound
 * chat in place — no new conversation, no worktree, no stop on success (D10).
 */
export function createScheduleDispatch(
  deps: ScheduleDispatchDeps,
): (ctx: TickContext) => Promise<void> {
  return async (ctx: TickContext) => {
    const db = deps.getDb();
    const { job, run } = ctx;
    const startedAt = Date.now();

    const fail = (error: string) => {
      revokeRunTokensForRun(run.id);
      deps.onComplete(run.id, { status: 'failed', stepUpdated: false, error });
    };

    const resolved = resolveJobProfile(db, job);
    if (!resolved.ok) {
      fail(resolved.error);
      return;
    }
    const profile = resolved.profile;

    const project = getProject(db, job.projectId);
    if (!project) {
      fail('project not found');
      return;
    }
    if (isProjectMoving(project.id)) {
      fail(PROJECT_MOVING_ERROR);
      return;
    }

    // Defensive: legacy spawn_child grok rows created before Task 8.
    if (profile.agentType === 'grok-bot' && job.executionMode === 'spawn_child') {
      fail('grok_bot_requires_resume');
      return;
    }

    // H2/D6: fire-time host availability BEFORE any conversation creation or binding.
    // Ordered after profile resolution so inherit resolves first; fail string leads
    // with the reason so K-miss auto-disable can match `host_disconnected`.
    if (project.remoteHostId) {
      const avail = profileAvailableOnHost(
        profile,
        deps.remoteHostView?.(project.remoteHostId),
      );
      if (!avail.ok) {
        fail(`${avail.reason}: profile ${profile.id} not available on host`);
        return;
      }
    }

    // Pre-check before any updateRun / registerActiveRun / createConversation (D2).
    if (profile.agentType === 'grok-bot' && deps.ensureGrokBot) {
      const race = raceTimeout<GrokBotLifecycleStatus>(GROK_BOT_ENSURE_MS);
      let s: GrokBotLifecycleStatus | undefined;
      try {
        s = await Promise.race([deps.ensureGrokBot(), race.promise]);
      } finally {
        race.clear();
      }
      if (!s || !grokBotDispatchReady(s)) {
        fail(
          'grok_bot_unavailable: '
            + (s ? supervisorMessage(s) : 'did not report a usable status'),
        );
        return;
      }
    }

    /** Shared turn tail for spawn_child and resume_conversation. */
    const runTurn = (convId: string, cwd: string, opts: { stopOnSuccess: boolean }) => {
      let settled = false;

      // Resume into an existing chat: arm on turn_start so a parked session's
      // session_ended / status:done during handlePrompt cannot settle early
      // (same as routes/spawn.ts messaging an existing conversation).
      const watcher = watchChildResult(convId, {
        ...(opts.stopOnSuccess ? {} : { armOn: 'turn_start' as const }),
        settleOnStop: true,
        onHeartbeat: () => {},
        onStalled: () => {},
      });

      const openNotifyKids = () =>
        listOpenEdgesForParent(db, convId).some((e) => e.notifyParent);

      /** Stall check: time out only after `runTimeoutMs` with no progress on the
       *  tick or its open notifyParent children — not on wall-clock age alone. */
      const checkStalled = (): boolean => {
        const now = Date.now();
        const lastActivityMs = lastTickActivityMs(db, convId, startedAt);
        return isScheduleRunStalled({
          now,
          firedAt: startedAt,
          runTimeoutMs: job.runTimeoutMs,
          lastActivityMs,
        });
      };

      // The tick's own session — captured when handlePrompt returns. finish() /
      // forceTimeout must stop this id, not whatever is currently active: an
      // operator follow-up after done starts a new session that must survive.
      let tickSessionId: string | undefined;

      const forceTimeout = () => {
        if (settled) return;
        settled = true;
        clearInterval(stallPoll);
        watcher.cancel();
        revokeRunTokensForRun(run.id);
        // Prefer the tick session returned by handlePrompt. For spawn_child
        // (stopOnSuccess), fall back to the schedule-owned child's active
        // session when timeout hits during a slow start (compaction / supervisor
        // wait) before handlePrompt resolves — same as pre-refactor behaviour.
        // Resume (stopOnSuccess: false) never falls back: an operator follow-up
        // must survive (D10).
        const stopId = tickSessionId
          ?? (opts.stopOnSuccess
            ? deps.sessionManager.activeSessionForConversation(convId)?.id
            : undefined);
        if (stopId) void deps.sessionManager.stopSession(stopId);
        deps.onComplete(run.id, {
          status: 'timed_out',
          stepUpdated: detectStepUpdate(db, job.id, startedAt),
        });
      };

      // Activity-aware stall poll (replaces absolute setTimeout(runTimeoutMs)).
      // Multi-spawn waves routinely exceed the nominal budget while still
      // progressing; absolute wall-clock timed_out false-reds the job.
      const stallPoll = setInterval(() => {
        if (settled) {
          clearInterval(stallPoll);
          return;
        }
        if (checkStalled()) forceTimeout();
      }, SCHEDULE_STALL_POLL_MS);

      const finish = (result: FinalizeResult) => {
        if (settled) return;
        settled = true;
        clearInterval(stallPoll);
        revokeRunTokensForRun(run.id);
        if (opts.stopOnSuccess) {
          const stopId = tickSessionId
            ?? deps.sessionManager.activeSessionForConversation(convId)?.id;
          if (stopId) void deps.sessionManager.stopSession(stopId);
        }
        deps.onComplete(run.id, result);
      };

      void watcher.promise.then(
        async ({ prose, stopped }) => {
          if (stopped) {
            finish({
              status: 'failed',
              error: 'stopped_by_operator',
              stepUpdated: detectStepUpdate(db, job.id, startedAt),
            });
            return;
          }
          // First status:done is not always final for hold-open / soft-interrupt
          // parents: async children may still be open, and subagent_notify steers
          // may still be queued. Wait for open notify-children + steer queue to
          // drain before stopSession (which would wipe undelivered notifies).
          //
          // Poll in chunks up to runTimeoutMs each; keep waiting while work is
          // still progressing. Only finish once settled, or let the stall poll
          // force timed_out when activity stops for a full budget.
          const chunkMs = Math.min(SCHEDULE_STALL_POLL_MS, Math.max(1_000, job.runTimeoutMs));
          while (!settled) {
            const busySession = deps.sessionManager.inFlightSessionForConversation(convId);
            if (!openNotifyKids() && !deps.sessionManager.hasPendingSteerWork(convId) && !busySession) {
              finish({
                status: 'succeeded',
                outcomeSummary: prose,
                stepUpdated: detectStepUpdate(db, job.id, startedAt),
              });
              return;
            }
            if (checkStalled()) {
              forceTimeout();
              return;
            }
            await deps.sessionManager.waitForConversationSettle(convId, {
              hasOpenNotifyChildren: openNotifyKids,
              timeoutMs: chunkMs,
            });
          }
        },
        (err: Error) => {
          finish({ status: 'failed', error: err.message, stepUpdated: detectStepUpdate(db, job.id, startedAt) });
        },
      );

      void deps.sessionManager.handlePrompt({
        projectId: job.projectId,
        conversationId: convId,
        agent: profile.agentType,
        model: profile.model,
        profileId: profile.id,
        text: ctx.prompt,
        cwd,
        // Tick is a top-level run standing in for the operator, not a spawn
        // child: omit interactionMode so handlePrompt uses the conversation column ?? global setting
        // and the permission-capable rejection can fire. Children still force
        // bypass at sessionManager.messageDescendant.
        source: 'user',
        schedule: { jobId: job.id, jobName: job.name, runId: run.id },
      }).then(
        (sessionId) => { tickSessionId = sessionId; },
        (err: unknown) => watcher.fail(err instanceof Error ? err.message : String(err)),
      );
    };

    // ── resume_conversation ───────────────────────────────────────────────
    if (job.executionMode === 'resume_conversation') {
      const bound = job.boundConversationId
        ? getConversation(db, job.boundConversationId)
        : undefined;
      if (!bound) {
        fail('bound conversation missing');
        return;
      }
      if (bound.archived) {
        fail('bound conversation archived');
        return;
      }
      if (bound.projectId !== job.projectId) {
        fail('bound conversation moved to another project');
        return;
      }

      if (deps.sessionManager.inFlightSessionForConversation(bound.id)) {
        revokeRunTokensForRun(run.id);
        updateRun(db, run.id, { conversationId: bound.id });
        deps.onComplete(run.id, {
          status: 'skipped',
          stepUpdated: false,
          error: 'bound_conversation_busy',
        });
        return;
      }

      updateRun(db, run.id, { conversationId: bound.id });
      rebindRunToken(ctx.runToken, bound.id);

      deps.registerActiveRun?.(bound.id, {
        projectId: job.projectId,
        jobId: job.id,
        runId: run.id,
      });
      deps.broadcastScheduleUpdated?.(job.projectId, job.id, {
        runId: run.id,
        runStatus: 'running',
        conversationId: bound.id,
        jobName: job.name,
        event: 'fired',
      });
      notifyOperator(db, {
        category: 'scheduleFired',
        conversationId: bound.id,
        jobId: job.id,
        jobName: job.name,
        projectName: project.name,
        runId: run.id,
      });

      const cwd = bound.workdirPath ?? project.rootPath;
      runTurn(bound.id, cwd, { stopOnSuccess: false });
      return;
    }

    // ── spawn_child ───────────────────────────────────────────────────────
    const remoteHostId = project.remoteHostId;
    const hostHello = remoteHostId ? getRemoteHost(db, remoteHostId)?.hello : undefined;
    const remoteSupportsWorktree = Boolean(remoteHostId && deps.nodeHub && hostHasFeature(hostHello, 'git.worktree'));
    const wantWorktree = job.workdir === 'worktree' && (!remoteHostId || remoteSupportsWorktree);
    if (wantWorktree) {
      let repoOk = false;
      try {
        repoOk = remoteHostId
          ? (await new RemoteGitOps(deps.nodeHub!, remoteHostId).readWorkingTree(project.rootPath)).isRepo
          : isGitRepo(project.rootPath);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!repoOk) {
        fail('workdir is worktree but project root is not a git repo');
        return;
      }
    }

    const home = getConversation(db, job.homeConversationId);
    const homeAgent = home
      ? (lastSessionForConversation(db, home.id)?.agentId ?? '')
      : '';
    const parentEff = resolveSandboxFor(
      db,
      home ?? {},
      project,
      homeAgent,
      homeAgent ? sandboxCapability(project.remoteHostId ?? 'hub', homeAgent, hostHello) : null,
    );
    const child = createConversation(db, {
      projectId: job.projectId,
      title: `⏱ ${job.name} @ ${formatIsoLocalInTimezone(run.firedAt, job.timezone)}`,
      parentConversationId: job.homeConversationId,
      // Same spawn roster as normal chats — enables multi-agent ticks.
      templateName: job.templateName,
      // Agent-created jobs stamp the creator's profile (migration 129).
      // NULL = `all` — existing jobs minted before the column, plus operator
      // jobs. Unknown ids fail closed to `minimal` at token mint, same as
      // every other conversation.
      capabilityProfile: job.capabilityProfile,
      sandbox: monotonicChildSandbox(parentEff),
      // kind defaults to 'chat' — runs ARE real conversations.
    });
    // Same auto-mint contract as routes/spawn.ts dispatchSpawn: a run
    // conversation is parented exactly like a spawn child.
    autoMintPeerRing(db, { parentId: job.homeConversationId, childId: child.id });
    updateRun(db, run.id, { conversationId: child.id });
    // Same token string the tick prompt's footer already baked in cleartext —
    // rebind its conversationId in place rather than issuing a new one.
    rebindRunToken(ctx.runToken, child.id);

    // Clients learn the run↔conversation link before the first agent event.
    deps.registerActiveRun?.(child.id, {
      projectId: job.projectId,
      jobId: job.id,
      runId: run.id,
    });
    deps.broadcastScheduleUpdated?.(job.projectId, job.id, {
      runId: run.id,
      runStatus: 'running',
      conversationId: child.id,
      jobName: job.name,
      event: 'fired',
    });
    notifyOperator(db, {
      category: 'scheduleFired',
      conversationId: child.id,
      jobId: job.id,
      jobName: job.name,
      projectName: project.name,
      runId: run.id,
    });

    let cwd = project.rootPath;
    if (wantWorktree) {
      try {
        const wt = remoteHostId
          ? await new RemoteGitOps(deps.nodeHub!, remoteHostId).createSpawnWorktree(project.rootPath, child.id)
          : createWorktree(project.rootPath, child.id);
        cwd = wt.path;
        // Persist BOTH the literal worktree path (cwd resolution, checkpoints)
        // AND the 'worktree' mode pin (so descendant /spawn calls inherit the
        // worktree mode via resolveSpawnWorkdir's conversation-pin rung). Without
        // the pin, tick-spawned children resolve to 'shared' → main repo even
        // though the tick itself runs in the worktree.
        db.prepare('UPDATE conversations SET workdir_path = ?, spawn_workdir = ? WHERE id = ?').run(wt.path, 'worktree', child.id);
      } catch (err: unknown) {
        // Conversation was bound — finalize path unregisters; do so eagerly if fail
        // short-circuits before onComplete in some paths (fail always calls onComplete).
        fail(err instanceof Error ? err.message : `worktree create failed: ${String(err)}`);
        return;
      }
    }

    runTurn(child.id, cwd, { stopOnSuccess: true });
  };
}
