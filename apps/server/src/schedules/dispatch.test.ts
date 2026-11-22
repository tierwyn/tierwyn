import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { EventEmitter } from 'events';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';
import { agentSupportsPermissionMode, formatIsoLocalInTimezone } from '@tierwyn/shared';
import { updateCompactionSettings } from '../repositories/settings.js';
import { openDb, setDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedCommands, seedDefaultSettings } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import { registry } from '../registry.js';
import { sessionHub } from '../sessionHub.js';
import { createProject } from '../repositories/projects.js';
import { SCHEDULE_INHERIT_PROFILE_ID } from '@tierwyn/shared';
import { createConversation, getConversation, setConversationArchived } from '../repositories/conversations.js';
import { createSession, setNativeSessionId } from '../repositories/sessions.js';
import { upsertDiscoveredModels } from '../repositories/models.js';
import { createJob, getRun, listRunsForJob, listSteps } from '../repositories/schedules.js';
import { validateRunToken } from './runTokens.js';
import { SessionManager } from '../sessionManager.js';
import { JobScheduler } from './jobScheduler.js';
import { createScheduleDispatch, detectStepUpdate } from './dispatch.js';
import { bindEnsureGrokBot } from './grokBotEnsure.js';
import * as worktree from '../worktree.js';
import type { GrokBotLifecycleStatus } from '@tierwyn/shared';

const PROFILE = 'claude-code:opus-4.8';

class ConsolidatingFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'done: scaffold created.' }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {}
  async listModels() { return []; }
  async listSessions() { return []; }
  async loadSession() {}
}

let db: Database;
let projectId: string;
let homeId: string;

beforeEach(() => {
  vi.restoreAllMocks();
  db = openDb(':memory:');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  homeId = createConversation(db, { projectId, title: '⏱ job home', kind: 'schedule_home' }).id;
});

function seedJob(overrides: Partial<Parameters<typeof createJob>[1]> = {}) {
  const now = Date.now();
  return createJob(db, {
    projectId,
    name: 'nightly',
    timezone: 'UTC',
    scheduleKind: 'interval',
    scheduleExpr: JSON.stringify({ everyMs: 3_600_000, anchor: now - 3_600_000 - 1 }),
    profileId: PROFILE,
    homeConversationId: homeId,
    promptTemplate: 'Do step: {{step.title}}\n{{step.body}}',
    nextFireAt: now - 1,
    steps: [{ title: 'Scaffold', body: 'Create files' }],
    ...overrides,
  });
}

function makeSessionManager() {
  return new SessionManager({ broadcast: (conversationId, frame) => sessionHub.broadcast(conversationId, frame) });
}

describe('createScheduleDispatch: spawn_child path', () => {
  it('creates a child under home and runs handlePrompt to a succeeded run', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const job = seedJob();

    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    const run = getRun(db, listRunsForJob(db, job.id)[0].id)!;
    expect(run.conversationId).toBeTruthy();

    const child = getConversation(db, run.conversationId!)!;
    expect(child.parentConversationId).toBe(homeId);
    expect(child.sandbox).toBeUndefined();
    expect(child.templateName).toBeUndefined();
    expect(child.title).toMatch(/^⏱ nightly @ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(child.title).toBe(`⏱ nightly @ ${formatIsoLocalInTimezone(run.firedAt, 'UTC')}`);

    // Wait for the fire-and-forget turn + watcher to settle.
    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    }, { timeout: 2000 });

    expect(completions[0].runId).toBe(run.id);
    expect(completions[0].result).toMatchObject({ status: 'succeeded', outcomeSummary: expect.stringContaining('scaffold') });
  });

  it('inherits effective sandbox from schedule home onto the run conversation', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    db.prepare('UPDATE conversations SET sandbox = ? WHERE id = ?').run('on', homeId);
    const job = seedJob();
    const dispatchTick = createScheduleDispatch({
      sessionManager: makeSessionManager(),
      getDb: () => db,
      onComplete: () => {},
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();
    const run = getRun(db, listRunsForJob(db, job.id)[0].id)!;
    expect(getConversation(db, run.conversationId!)!.sandbox).toBe('on');
  });

  it('stamps the job capability profile onto the run conversation (null = all)', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const job = seedJob({ capabilityProfile: 'media' });
    const dispatchTick = createScheduleDispatch({
      sessionManager: makeSessionManager(),
      getDb: () => db,
      onComplete: () => {},
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();
    const run = getRun(db, listRunsForJob(db, job.id)[0].id)!;
    expect(getConversation(db, run.conversationId!)!.capabilityProfile).toBe('media');
  });

  it('leaves the run conversation on the default all profile when the job has none', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const job = seedJob();
    const dispatchTick = createScheduleDispatch({
      sessionManager: makeSessionManager(),
      getDb: () => db,
      onComplete: () => {},
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();
    const run = getRun(db, listRunsForJob(db, job.id)[0].id)!;
    expect(getConversation(db, run.conversationId!)!.capabilityProfile).toBeUndefined();
  });

  it('formats run conversation title in job timezone, not UTC', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const job = seedJob({ timezone: 'America/New_York' });

    const dispatchTick = createScheduleDispatch({
      sessionManager: makeSessionManager(),
      getDb: () => db,
      onComplete: () => {},
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    const run = getRun(db, listRunsForJob(db, job.id)[0].id)!;
    const child = getConversation(db, run.conversationId!)!;
    expect(child.title).toBe(`⏱ nightly @ ${formatIsoLocalInTimezone(run.firedAt, 'America/New_York')}`);
    expect(child.title).not.toMatch(/Z$/);
    expect(child.title).not.toBe(`⏱ nightly @ ${new Date(run.firedAt).toISOString().slice(0, 16)}`);
  });

  it('registers active run and broadcasts conversation bind after createConversation', async () => {
    // Hold the agent turn open so we can assert registry membership mid-run.
    class HoldingAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start(_cfg: SessionConfig) {}
      async sendPrompt() {
        this.emitter.emit('event', {
          type: 'status', payload: { status: 'running' },
          sessionId: '', seq: 1, ts: Date.now(),
        });
        // Never emit end — test finalizes explicitly.
      }
      async stop() {
        this.emitter.emit('end');
      }
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }
    registry.register('claude-code', () => new HoldingAdapter());
    const job = seedJob();

    const broadcasts: unknown[] = [];
    const registered: { conversationId: string; runId: string }[] = [];
    const sessionManager = makeSessionManager();

    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: createScheduleDispatch({
        sessionManager,
        getDb: () => db,
        onComplete: (runId, result) => {
          scheduler.finalizeRun(runId, result);
        },
        registerActiveRun: (conversationId, binding) => {
          registered.push({ conversationId, runId: binding.runId });
          scheduler.registerActiveRun(conversationId, binding);
        },
        broadcastScheduleUpdated: (projectId, jobId, detail) => {
          broadcasts.push({ projectId, jobId, ...detail });
        },
      }),
      broadcastScheduleUpdated: (projectId, jobId, detail) => {
        broadcasts.push({ projectId, jobId, ...detail });
      },
    });

    await scheduler.tickOnce();

    const run = getRun(db, listRunsForJob(db, job.id)[0].id)!;
    expect(run.conversationId).toBeTruthy();
    expect(registered).toContainEqual(expect.objectContaining({
      conversationId: run.conversationId,
      runId: run.id,
    }));
    expect(broadcasts).toContainEqual(expect.objectContaining({
      runId: run.id,
      runStatus: 'running',
      conversationId: run.conversationId,
    }));
    expect(scheduler.lookupActiveRunByConversation(run.conversationId!)?.runId).toBe(run.id);

    // End the turn so finalize unregisters.
    scheduler.finalizeRun(run.id, { status: 'succeeded', stepUpdated: true, outcomeSummary: 'ok' });
    expect(scheduler.lookupActiveRunByConversation(run.conversationId!)).toBeUndefined();
  });

  it('copies job.templateName onto the tick conversation for delegation preamble', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const job = seedJob({ templateName: 'nightly-team' });

    const sessionManager = makeSessionManager();
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: () => {},
    });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    const run = getRun(db, listRunsForJob(db, job.id)[0].id)!;
    const child = getConversation(db, run.conversationId!)!;
    expect(child.templateName).toBe('nightly-team');
  });

  it('rebinds the run token to the child conversation before the turn ever starts', async () => {
    const job = seedJob();

    const sessionManager = makeSessionManager();
    let seenValidation: ReturnType<typeof validateRunToken> | undefined;
    let seenConversationId = '';
    // Capture token state synchronously at the moment dispatch hands off to
    // handlePrompt — before any turn/finalize activity can revoke it.
    vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(async (input) => {
      seenConversationId = input.conversationId;
      seenValidation = validateRunToken(runTokenSeen, job.id);
      return 'fake-session-id';
    });

    let runTokenSeen = '';
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: () => {},
    });
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: async (ctx) => { runTokenSeen = ctx.runToken; return dispatchTick(ctx); },
    });
    await scheduler.tickOnce();

    expect(seenValidation).toEqual({
      ok: true, jobId: job.id, runId: expect.any(String), conversationId: seenConversationId,
    });
  });

  it('finalizes failed (no child created) when the profile is unknown', async () => {
    const job = seedJob({ profileId: 'nope:does-not-exist' });

    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    expect(completions).toHaveLength(1);
    expect(completions[0].result).toMatchObject({ status: 'failed', stepUpdated: false });
    const run = (await import('../repositories/schedules.js')).listRunsForJob(db, job.id)[0];
    expect(run.conversationId).toBeFalsy();
  });

  it('finalizes failed when handlePrompt itself rejects (no session ever starts)', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    seedJob();

    const sessionManager = makeSessionManager();
    vi.spyOn(sessionManager, 'handlePrompt').mockRejectedValue(new Error('boom'));

    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    }, { timeout: 2000 });
    expect(completions[0].result).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('does not hardcode interactionMode bypass — handlePrompt sees undefined (global applies)', async () => {
    const sessionManager = makeSessionManager();
    let seen: string | undefined = 'sentinel';
    vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(async (input) => {
      seen = input.interactionMode;
      return 'fake-session-id';
    });
    seedJob();
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: () => {},
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();
    expect(seen).toBeUndefined();
  });

  it('global prompt mode rejects a bypass-only tick profile', async () => {
    updateCompactionSettings(db, { interactionMode: 'prompt' });
    const bypassOnly = catalogue.listProfiles().find((p) => p.enabled && !agentSupportsPermissionMode(p.agentType));
    expect(bypassOnly).toBeTruthy();
    seedJob({ profileId: bypassOnly!.id });

    const sessionManager = makeSessionManager();
    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    }, { timeout: 2000 });
    expect(completions[0].result).toMatchObject({ status: 'failed' });
    expect(String((completions[0].result as { error?: string }).error)).toMatch(/does not support permission mode/);
  });

  it('uses project.rootPath as cwd when workdir is shared (default)', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    seedJob(); // default workdir = shared

    const sessionManager = makeSessionManager();
    let seenCwd = '';
    vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(async (input) => {
      seenCwd = input.cwd;
      return 'fake-session-id';
    });

    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: () => {},
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    expect(seenCwd).toBe('/tmp/p');
  });

  it('creates a worktree and uses its path as cwd when workdir is worktree', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    seedJob({ workdir: 'worktree' });

    const wtPath = '/tmp/p-spawn-deadbeef';
    vi.spyOn(worktree, 'isGitRepo').mockReturnValue(true);
    vi.spyOn(worktree, 'createWorktree').mockReturnValue({ path: wtPath, branch: 'tierwyn/spawn-deadbeef' });

    const sessionManager = makeSessionManager();
    let seenCwd = '';
    let seenConversationId = '';
    vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(async (input) => {
      seenCwd = input.cwd;
      seenConversationId = input.conversationId;
      return 'fake-session-id';
    });

    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    expect(worktree.createWorktree).toHaveBeenCalledWith('/tmp/p', seenConversationId);
    expect(seenCwd).toBe(wtPath);
    const child = getConversation(db, seenConversationId)!;
    expect(child.workdirPath).toBe(wtPath);
    expect(child.spawnWorkdir).toBe('worktree');
  });

  it('remote schedule worktree creates worktree on node when host has git.worktree', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { basename, join } = await import('path');
    const { execFileSync } = await import('child_process');
    const { createPendingHost, saveHello } = await import('../repositories/remoteHosts.js');
    const { NodeRuntime } = await import('../node/runtime.js');
    const { memoryPair, RpcPeer } = await import('../node/rpc.js');

    const parentRoot = mkdtempSync(join(tmpdir(), 'tierwyn-sched-rh-wt-'));
    const dir = join(parentRoot, 'repo');
    mkdirSync(dir);
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: dir });
      writeFileSync(join(dir, 'base.txt'), 'base');
      execFileSync('git', ['add', 'base.txt'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });

      const [hubT, nodeT] = memoryPair();
      const runtime = new NodeRuntime({
        create: () => { throw new Error('no adapters'); },
        has: () => false,
        policy: { roots: [parentRoot], allowedAgents: [], maxSessions: 4 },
      });
      const nodePeer = new RpcPeer(nodeT, runtime.handlers());
      const hubPeer = new RpcPeer(hubT, {});
      void nodePeer;

      const host = createPendingHost(db, 'box', 'tok', Date.now() + 60_000);
      saveHello(db, host.id, {
        protocol: 1, gitSha: 'test', hostname: 'box', os: 'linux', arch: 'x64',
        homedir: parentRoot, roots: [parentRoot], listenPort: 0,
        agents: { 'claude-code': { installed: true, methods: [] } },
        models: { 'claude-code': ['claude-opus-4-8'] },
        sessions: [],
        features: ['git.worktree'],
      }, Date.now());
      const rProj = createProject(db, { name: 'rp', rootPath: dir, remoteHostId: host.id });
      const rHome = createConversation(db, { projectId: rProj.id, title: '⏱ job home', kind: 'schedule_home' }).id;
      seedJob({ projectId: rProj.id, homeConversationId: rHome, workdir: 'worktree' });

      const sessionManager = makeSessionManager();
      let seenCwd = '';
      let seenConversationId = '';
      vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(async (input) => {
        seenCwd = input.cwd ?? '';
        seenConversationId = input.conversationId;
        return 'fake-session-id';
      });

      const completions: { runId: string; result: unknown }[] = [];
      const dispatchTick = createScheduleDispatch({
        sessionManager,
        getDb: () => db,
        nodeHub: { link: () => hubPeer },
        onComplete: (runId, result) => completions.push({ runId, result }),
        remoteHostView: () => ({
          id: host.id,
          name: 'box',
          state: 'connected',
          hello: {
            agents: { 'claude-code': { installed: true, methods: [] } },
            models: { 'claude-code': ['claude-opus-4-8'] },
            features: ['git.worktree'],
          },
          allowMcpSecrets: true,
          createdAt: Date.now(),
        }),
      });
      const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
      await scheduler.tickOnce();

      const expectedWt = realpathSync(join(parentRoot, `${basename(dir)}-spawn-${seenConversationId.slice(0, 8)}`));
      expect(seenCwd).toBe(expectedWt);
      const child = getConversation(db, seenConversationId)!;
      expect(child.workdirPath).toBe(expectedWt);
      expect(child.spawnWorkdir).toBe('worktree');
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
    }
  });

  it('fails the run (no child) when workdir is worktree but project is not a git repo', async () => {
    const job = seedJob({ workdir: 'worktree' });
    vi.spyOn(worktree, 'isGitRepo').mockReturnValue(false);
    const createWt = vi.spyOn(worktree, 'createWorktree');

    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    expect(completions).toHaveLength(1);
    expect(completions[0].result).toMatchObject({
      status: 'failed',
      stepUpdated: false,
      error: expect.stringMatching(/not a git repo/i),
    });
    expect(createWt).not.toHaveBeenCalled();
    expect(handlePrompt).not.toHaveBeenCalled();
    const run = listRunsForJob(db, job.id)[0];
    expect(run.conversationId).toBeFalsy();
  });

  it('waits for active session to become idle before finalizing run (run-settle guard)', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const job = seedJob();

    const sessionManager = makeSessionManager();
    let polls = 0;
    // Simulate kids = 0, steer = 0, but session busy for 2 checks before becoming idle
    vi.spyOn(sessionManager, 'hasPendingSteerWork').mockReturnValue(false);
    vi.spyOn(sessionManager, 'inFlightSessionForConversation').mockImplementation(() => {
      polls++;
      if (polls <= 2) {
        return { id: 'busy-session', conversationId: 'child', steerQueue: [], abortController: new AbortController() } as any;
      }
      return undefined;
    });

    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });

    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    }, { timeout: 2000 });

    expect(polls).toBeGreaterThanOrEqual(3);
    expect(completions[0].result).toMatchObject({ status: 'succeeded' });
  });

  it('timeout while handlePrompt pending stops the child active session', async () => {
    // Slow start: handlePrompt has not resolved (tickSessionId unset) but the
    // schedule-owned child already has an active session — forceTimeout must
    // fall back to that session (pre-refactor spawn_child behaviour).
    seedJob({ runTimeoutMs: 1 });

    const sessionManager = makeSessionManager();
    const stopped: string[] = [];
    vi.spyOn(sessionManager, 'stopSession').mockImplementation(async (id) => {
      stopped.push(id);
    });
    vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );
    vi.spyOn(sessionManager, 'activeSessionForConversation').mockReturnValue({
      id: 'child-active-during-start',
    } as ReturnType<SessionManager['activeSessionForConversation']>);

    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await scheduler.tickOnce();
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.waitFor(() => {
        expect(completions).toHaveLength(1);
      }, { timeout: 2_000 });
    } finally {
      vi.useRealTimers();
    }
    expect(completions[0].result).toMatchObject({ status: 'timed_out' });
    expect(stopped).toEqual(['child-active-during-start']);
  }, 15_000);
});

describe('detectStepUpdate', () => {
  it('is false when no step has been touched since startedAt', () => {
    const job = seedJob();
    const startedAt = Date.now() + 10;
    expect(detectStepUpdate(db, job.id, startedAt)).toBe(false);
  });

  it('is true when a step was patched after startedAt', () => {
    const job = seedJob();
    const startedAt = Date.now() - 1;
    const step = listSteps(db, job.id)[0];
    db.prepare('UPDATE schedule_steps SET updated_at = ? WHERE id = ?').run(startedAt + 100, step.id);
    expect(detectStepUpdate(db, job.id, startedAt)).toBe(true);
  });
});

describe('createScheduleDispatch: resume_conversation path', () => {
  function seedResumeJob(boundId: string, overrides: Partial<Parameters<typeof createJob>[1]> = {}) {
    return seedJob({
      executionMode: 'resume_conversation',
      boundConversationId: boundId,
      ...overrides,
    });
  }

  function convCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
  }

  it('prompts the bound conversation without creating a child', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    const before = convCount();
    const job = seedResumeJob(bound.id);

    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    let seenPrompt: { conversationId: string; schedule?: unknown; profileId?: string } | undefined;
    const realHandle = sessionManager.handlePrompt.bind(sessionManager);
    vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(async (input) => {
      seenPrompt = {
        conversationId: input.conversationId,
        schedule: input.schedule,
        profileId: input.profileId,
      };
      return realHandle(input);
    });

    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    }, { timeout: 2000 });

    expect(convCount()).toBe(before); // home already existed; no new child
    const run = getRun(db, listRunsForJob(db, job.id)[0].id)!;
    expect(run.conversationId).toBe(bound.id);
    expect(seenPrompt?.conversationId).toBe(bound.id);
    expect(seenPrompt?.schedule).toEqual({
      jobId: job.id,
      jobName: job.name,
      runId: run.id,
    });
    expect(completions[0].result).toMatchObject({ status: 'succeeded' });
  });

  it('finish() on success does not call stopSession', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    seedResumeJob(bound.id);

    const sessionManager = makeSessionManager();
    const stopSpy = vi.spyOn(sessionManager, 'stopSession');
    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    }, { timeout: 2000 });
    expect(completions[0].result).toMatchObject({ status: 'succeeded' });
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('finish() on failed does not call stopSession', async () => {
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    seedResumeJob(bound.id);

    const sessionManager = makeSessionManager();
    const stopSpy = vi.spyOn(sessionManager, 'stopSession');
    vi.spyOn(sessionManager, 'handlePrompt').mockRejectedValue(new Error('start boom'));
    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();

    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    }, { timeout: 2000 });
    expect(completions[0].result).toMatchObject({
      status: 'failed',
      error: 'start boom',
    });
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('timeout stops only tickSessionId, not a later operator session', async () => {
    class HoldingAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start(_cfg: SessionConfig) {}
      async sendPrompt() {
        this.emitter.emit('event', {
          type: 'status', payload: { status: 'running' },
          sessionId: '', seq: 1, ts: Date.now(),
        });
      }
      async stop() { this.emitter.emit('end'); }
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }
    registry.register('claude-code', () => new HoldingAdapter());
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    seedResumeJob(bound.id, { runTimeoutMs: 1 });

    const sessionManager = makeSessionManager();
    const stopped: string[] = [];
    vi.spyOn(sessionManager, 'stopSession').mockImplementation(async (id) => {
      stopped.push(id);
    });
    // Capture tick session, then pretend a later operator session is active.
    vi.spyOn(sessionManager, 'handlePrompt').mockResolvedValue('tick-session');
    vi.spyOn(sessionManager, 'activeSessionForConversation').mockReturnValue({
      id: 'operator-followup',
    } as ReturnType<SessionManager['activeSessionForConversation']>);

    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await scheduler.tickOnce();
      // First stall-poll tick (SCHEDULE_STALL_POLL_MS = 5s); runTimeoutMs is 1ms.
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.waitFor(() => {
        expect(completions).toHaveLength(1);
      }, { timeout: 2_000 });
    } finally {
      vi.useRealTimers();
    }
    expect(completions[0].result).toMatchObject({ status: 'timed_out' });
    expect(stopped).toEqual(['tick-session']);
    expect(stopped).not.toContain('operator-followup');
  }, 15_000);

  it('fails when bound conversation is missing', async () => {
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    const job = seedResumeJob(bound.id);
    // Simulate post-delete nulling of the FK (repositories/conversations.ts).
    db.prepare('UPDATE schedule_jobs SET bound_conversation_id = NULL WHERE id = ?').run(job.id);
    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    const scheduler = new JobScheduler({ getDb: () => db, dispatchTick });
    await scheduler.tickOnce();
    expect(completions).toHaveLength(1);
    expect(completions[0].result).toMatchObject({
      status: 'failed',
      error: 'bound conversation missing',
    });
    expect(handlePrompt).not.toHaveBeenCalled();
    expect(listRunsForJob(db, job.id)[0].conversationId).toBeFalsy();
  });

  it('fails when bound conversation is archived', async () => {
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    setConversationArchived(db, bound.id, true);
    seedResumeJob(bound.id);
    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(completions[0].result).toMatchObject({
      status: 'failed',
      error: 'bound conversation archived',
    });
    expect(handlePrompt).not.toHaveBeenCalled();
  });

  it('fails when bound conversation moved to another project', async () => {
    const other = createProject(db, { name: 'other', rootPath: '/tmp/other' });
    const bound = createConversation(db, { projectId: other.id, title: 'foreign' });
    seedResumeJob(bound.id);
    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(completions[0].result).toMatchObject({
      status: 'failed',
      error: 'bound conversation moved to another project',
    });
    expect(handlePrompt).not.toHaveBeenCalled();
  });

  it('skips when the bound conversation is busy', async () => {
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    const job = seedResumeJob(bound.id);
    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    vi.spyOn(sessionManager, 'inFlightSessionForConversation').mockReturnValue({
      id: 'busy',
    } as ReturnType<SessionManager['inFlightSessionForConversation']>);
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(completions[0].result).toMatchObject({
      status: 'skipped',
      error: 'bound_conversation_busy',
    });
    expect(handlePrompt).not.toHaveBeenCalled();
    expect(listRunsForJob(db, job.id)[0].conversationId).toBe(bound.id);
  });

  it('inherit uses the bound conversation last agentModelId', async () => {
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    createSession(db, {
      id: 'sess-bound',
      conversationId: bound.id,
      agentId: 'claude-code',
      agentModelId: PROFILE,
    });
    const job = seedResumeJob(bound.id, { profileId: SCHEDULE_INHERIT_PROFILE_ID });

    const sessionManager = makeSessionManager();
    let seenProfileId = '';
    const realHandle = sessionManager.handlePrompt.bind(sessionManager);
    vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(async (input) => {
      seenProfileId = input.profileId;
      return realHandle(input);
    });
    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    await vi.waitFor(() => expect(completions).toHaveLength(1), { timeout: 2000 });
    expect(seenProfileId).toBe(PROFILE);
    expect(completions[0].result).toMatchObject({ status: 'succeeded' });
    void job;
  });

  it('inherit fails when the bound conversation has no previous agent', async () => {
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    seedResumeJob(bound.id, { profileId: SCHEDULE_INHERIT_PROFILE_ID });
    const completions: { runId: string; result: unknown }[] = [];
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(completions[0].result).toMatchObject({
      status: 'failed',
      error: 'bound conversation has no previous agent to inherit',
    });
    expect(handlePrompt).not.toHaveBeenCalled();
  });

  it('spawn_child handlePrompt also receives schedule metadata', async () => {
    const sessionManager = makeSessionManager();
    let seenSchedule: unknown;
    vi.spyOn(sessionManager, 'handlePrompt').mockImplementation(async (input) => {
      seenSchedule = input.schedule;
      return 'fake-session-id';
    });
    const job = seedJob();
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: () => {},
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    const run = listRunsForJob(db, job.id)[0];
    expect(seenSchedule).toEqual({
      jobId: job.id,
      jobName: job.name,
      runId: run.id,
    });
  });
});

describe('createScheduleDispatch: ensureGrokBot pre-check', () => {
  const BOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const GROK_PROFILE = `grok-bot:${BOT}`;

  function grokStatus(over: Partial<GrokBotLifecycleStatus> = {}): GrokBotLifecycleStatus {
    return {
      state: 'stopped',
      enabled: true,
      autoStart: 'on-demand',
      envLocks: { autostart: false, watch: false },
      launcher: null,
      attribution: null,
      layout: 'native',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastErrorAt: null,
      since: 1,
      ...over,
    };
  }

  function seedGrokResumeJob() {
    upsertDiscoveredModels(db, 'grok-bot', [{
      name: BOT, label: 'Grok Bot · Test', provider: 'xai', vision: false, steer: true,
    }]);
    catalogue.load(db);
    const bound = createConversation(db, { projectId, title: 'bot chat' });
    const sid = `s-${bound.id.slice(0, 8)}`;
    createSession(db, {
      id: sid,
      conversationId: bound.id,
      agentId: 'grok-bot',
      agentModelId: GROK_PROFILE,
    });
    setNativeSessionId(db, sid, BOT);
    return seedJob({
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
      profileId: GROK_PROFILE,
      steps: [],
      promptTemplate: 'Ping the bot',
    });
  }

  // Semantics (fix round 2 / I2): production wires bindEnsureGrokBot —
  // kick ensureRunning without awaiting, return live status(). Dispatch's 5 s
  // race is only a safety net around a wedged status() read. Proceed on
  // running|starting; fail terminal non-runnable before bind.

  /** Fake supervisor mirroring real kick+status wiring (ensure never resolves). */
  function fakeSupervisor(live: GrokBotLifecycleStatus) {
    const ensureRunning = vi.fn(
      (_reason: 'on-demand') => new Promise<GrokBotLifecycleStatus>(() => {}),
    );
    const status = vi.fn(() => live);
    return { ensureRunning, status };
  }

  it('kick+status starting (ensure never resolves) → proceeds; ensure called once', async () => {
    seedGrokResumeJob();
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt').mockResolvedValue('sess');
    const sup = fakeSupervisor(grokStatus({ state: 'starting' }));
    const ensureGrokBot = bindEnsureGrokBot(sup);
    const t0 = Date.now();
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: () => {},
      ensureGrokBot,
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(sup.ensureRunning).toHaveBeenCalledTimes(1);
    expect(sup.ensureRunning).toHaveBeenCalledWith('on-demand');
    expect(sup.status).toHaveBeenCalled();
    expect(handlePrompt).toHaveBeenCalled();
  });

  it('status() terminal non-runnable → immediate grok_bot_unavailable, no bind', async () => {
    const job = seedGrokResumeJob();
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const completions: { runId: string; result: unknown }[] = [];
    const sup = fakeSupervisor(grokStatus({ state: 'disabled', enabled: false }));
    const t0 = Date.now();
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
      ensureGrokBot: bindEnsureGrokBot(sup),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(sup.ensureRunning).toHaveBeenCalledTimes(1);
    expect(completions).toHaveLength(1);
    expect(completions[0].result).toMatchObject({ status: 'failed' });
    expect(String((completions[0].result as { error?: string }).error)).toMatch(/^grok_bot_unavailable:/);
    expect(handlePrompt).not.toHaveBeenCalled();
    expect(listRunsForJob(db, job.id)[0].conversationId).toBeFalsy();
  });

  it('status() stopped → failed grok_bot_unavailable, no handlePrompt, no conversation bind', async () => {
    const job = seedGrokResumeJob();
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
      ensureGrokBot: bindEnsureGrokBot(fakeSupervisor(grokStatus({ state: 'stopped' }))),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(completions).toHaveLength(1);
    expect(completions[0].result).toMatchObject({ status: 'failed' });
    expect(String((completions[0].result as { error?: string }).error)).toMatch(/^grok_bot_unavailable:/);
    expect(handlePrompt).not.toHaveBeenCalled();
    expect(listRunsForJob(db, job.id)[0].conversationId).toBeFalsy();
  });

  it('status() running → proceeds to handlePrompt', async () => {
    seedGrokResumeJob();
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt').mockResolvedValue('sess');
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: () => {},
      ensureGrokBot: bindEnsureGrokBot(fakeSupervisor(grokStatus({ state: 'running' }))),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(handlePrompt).toHaveBeenCalled();
  });

  it('status() wedged past race → failed did not report a usable status', async () => {
    const job = seedGrokResumeJob();
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const completions: { runId: string; result: unknown }[] = [];
    // Wedged status() read — safety-net race must fire and clear its timer.
    const ensureGrokBot = vi.fn(() => new Promise<GrokBotLifecycleStatus>(() => {}));
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
      ensureGrokBot,
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(completions).toHaveLength(1);
    expect(completions[0].result).toMatchObject({ status: 'failed' });
    expect(String((completions[0].result as { error?: string }).error))
      .toBe('grok_bot_unavailable: did not report a usable status');
    expect(handlePrompt).not.toHaveBeenCalled();
    expect(listRunsForJob(db, job.id)[0].conversationId).toBeFalsy();
  }, 15_000);

  it('legacy spawn_child grok job → failed grok_bot_requires_resume', async () => {
    upsertDiscoveredModels(db, 'grok-bot', [{
      name: BOT, label: 'Grok Bot · Test', provider: 'xai', vision: false, steer: true,
    }]);
    catalogue.load(db);
    const job = seedJob({
      profileId: GROK_PROFILE,
      steps: [],
      promptTemplate: 'legacy',
      executionMode: 'spawn_child',
    });
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
      ensureGrokBot: async () => grokStatus({ state: 'running' }),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();
    expect(completions).toHaveLength(1);
    expect(completions[0].result).toMatchObject({
      status: 'failed',
      error: 'grok_bot_requires_resume',
    });
    expect(handlePrompt).not.toHaveBeenCalled();
    expect(listRunsForJob(db, job.id)[0].conversationId).toBeFalsy();
  });
});

describe('createScheduleDispatch: remote host availability (Task 11)', () => {
  it('disconnected host → failed host_disconnected, no createConversation, no handlePrompt', async () => {
    const { createPendingHost, saveHello } = await import('../repositories/remoteHosts.js');
    const host = createPendingHost(db, 'box', 'tok', Date.now() + 60_000);
    saveHello(db, host.id, {
      protocol: 1, gitSha: 't', hostname: 'box', os: 'linux', arch: 'x64',
      homedir: '/tmp', roots: ['/tmp'], listenPort: 0,
      agents: { 'claude-code': { installed: true, methods: [] } },
      models: { 'claude-code': ['claude-opus-4-8'] },
      sessions: [],
    }, Date.now());
    const rProj = createProject(db, { name: 'rp', rootPath: '/tmp/rp', remoteHostId: host.id });
    const rHome = createConversation(db, { projectId: rProj.id, title: '⏱ job home', kind: 'schedule_home' }).id;
    const job = seedJob({ projectId: rProj.id, homeConversationId: rHome });

    const beforeConvCount = (db.prepare('SELECT COUNT(*) AS c FROM conversations').get() as { c: number }).c;
    const sessionManager = makeSessionManager();
    const handlePrompt = vi.spyOn(sessionManager, 'handlePrompt');
    const completions: { runId: string; result: unknown }[] = [];
    const dispatchTick = createScheduleDispatch({
      sessionManager,
      getDb: () => db,
      onComplete: (runId, result) => completions.push({ runId, result }),
      remoteHostView: () => ({
        id: host.id,
        name: 'box',
        state: 'disconnected',
        hello: {
          agents: { 'claude-code': { installed: true, methods: [] } },
          models: { 'claude-code': ['claude-opus-4-8'] },
        },
        allowMcpSecrets: true,
        createdAt: Date.now(),
      }),
    });
    await new JobScheduler({ getDb: () => db, dispatchTick }).tickOnce();

    expect(completions).toHaveLength(1);
    expect(completions[0].result).toMatchObject({
      status: 'failed',
      stepUpdated: false,
    });
    expect(String((completions[0].result as { error?: string }).error))
      .toMatch(/^host_disconnected:/);
    expect(handlePrompt).not.toHaveBeenCalled();
    // No new run conversation (home already existed).
    const afterConvCount = (db.prepare('SELECT COUNT(*) AS c FROM conversations').get() as { c: number }).c;
    expect(afterConvCount).toBe(beforeConvCount);
    expect(listRunsForJob(db, job.id)[0].conversationId).toBeFalsy();
  });
});
