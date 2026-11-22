import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation, getConversation } from './conversations.js';
import { createSession } from './sessions.js';
import { appendEvent, listEventsForConversation } from './events.js';
import {
  createJob, listJobsForProject, claimDueJobs, listSteps, selectCurrentStep,
  createRun, hasActiveRun, setNextFireAt, getJob, updateJob, updateStepStatus,
  updateRun, healInfraBlockedSteps, listRunsForJob, pruneInertOperatorHoleRows,
  setPendingContext, consumePendingContext, PENDING_CONTEXT_MAX_BYTES,
  archiveJob, countAgentJobsForConversation, countAgentJobsForProject,
  hardDeleteJob,
} from './schedules.js';

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

describe('schedule_jobs repository', () => {
  it('creates a job with initial steps and claims when due', () => {
    const now = Date.parse('2026-07-17T10:00:00.000Z');
    const job = createJob(db, {
      projectId,
      name: 'weekday morning',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
      profileId: 'claude-code:opus-4.8',
      homeConversationId: homeId,
      promptTemplate: 'Do step: {{step.title}}\n{{step.body}}',
      nextFireAt: now - 1,
      steps: [
        { title: 'Scaffold', body: 'Create files' },
        { title: 'Tests', body: 'Write tests', dependsOnOrdinal: 0 },
      ],
    });
    expect(job.enabled).toBe(true);
    expect(job.overlapPolicy).toBe('skip');
    expect(job.executionMode).toBe('spawn_child');
    expect(job.capabilityProfile).toBeUndefined();
    expect(listSteps(db, job.id)).toHaveLength(2);
    expect(claimDueJobs(db, now).map((j) => j.id)).toContain(job.id);

    const current = selectCurrentStep(db, job.id)!;
    expect(current.title).toBe('Scaffold');
    expect(current.status).toBe('ready');
  });

  it('round-trips capabilityProfile on agent-created jobs (null = all)', () => {
    const stamped = createJob(db, {
      projectId, name: 'from-media', timezone: 'UTC', scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: Date.now() + 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: Date.now() + 60_000,
      createdBy: 'agent', createdByConversationId: homeId,
      capabilityProfile: 'media',
    });
    expect(getJob(db, stamped.id)!.capabilityProfile).toBe('media');
    const unset = createJob(db, {
      projectId, name: 'legacy', timezone: 'UTC', scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: Date.now() + 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: Date.now() + 60_000,
    });
    expect(getJob(db, unset.id)!.capabilityProfile).toBeUndefined();
  });

  it('hasActiveRun is true for pending/running', () => {
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: Date.now() + 99999,
    });
    expect(hasActiveRun(db, job.id)).toBe(false);
    createRun(db, { jobId: job.id, status: 'running', firedAt: Date.now() });
    expect(hasActiveRun(db, job.id)).toBe(true);
  });

  it('setNextFireAt updates durable wake time', () => {
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
    });
    setNextFireAt(db, job.id, 42);
    expect(getJob(db, job.id)!.nextFireAt).toBe(42);
  });

  it('listJobsForProject hides archived by default', () => {
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
    });
    db.prepare('UPDATE schedule_jobs SET archived = 1 WHERE id = ?').run(job.id);
    expect(listJobsForProject(db, projectId)).toHaveLength(0);
    expect(listJobsForProject(db, projectId, { includeArchived: true })).toHaveLength(1);
  });

  it('archiveJob drops the job from agent-create cap counts', () => {
    const convId = createConversation(db, { projectId, title: 'creator' }).id;
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
      createdBy: 'agent', createdByConversationId: convId,
    });
    expect(countAgentJobsForConversation(db, convId)).toBe(1);
    expect(countAgentJobsForProject(db, projectId)).toBe(1);
    archiveJob(db, job.id);
    expect(countAgentJobsForConversation(db, convId)).toBe(0);
    expect(countAgentJobsForProject(db, projectId)).toBe(0);
  });

  it('persists templateName on create, update, and clear', () => {
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
      templateName: 'nightly-team',
    });
    expect(getJob(db, job.id)!.templateName).toBe('nightly-team');

    updateJob(db, job.id, { templateName: 'other' });
    expect(getJob(db, job.id)!.templateName).toBe('other');

    updateJob(db, job.id, { templateName: null });
    expect(getJob(db, job.id)!.templateName).toBeUndefined();
  });

  it('persists variables on create, wholesale replace on patch, and null clears', () => {
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
      variables: { focus: 'audio', cap: '3' },
    });
    expect(getJob(db, job.id)!.variables).toEqual({ focus: 'audio', cap: '3' });

    updateJob(db, job.id, { variables: { focus: 'video' } });
    expect(getJob(db, job.id)!.variables).toEqual({ focus: 'video' });

    updateJob(db, job.id, { variables: null });
    expect(getJob(db, job.id)!.variables).toBeUndefined();
  });

  it('toJob returns undefined for corrupt variables JSON and does not throw', () => {
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
    });
    db.prepare('UPDATE schedule_jobs SET variables = ? WHERE id = ?').run('not-json', job.id);
    expect(() => getJob(db, job.id)).not.toThrow();
    expect(getJob(db, job.id)!.variables).toBeUndefined();

    db.prepare('UPDATE schedule_jobs SET variables = ? WHERE id = ?').run('[1,2]', job.id);
    expect(getJob(db, job.id)!.variables).toBeUndefined();

    db.prepare('UPDATE schedule_jobs SET variables = ? WHERE id = ?').run('"string"', job.id);
    expect(getJob(db, job.id)!.variables).toBeUndefined();

    db.prepare('UPDATE schedule_jobs SET variables = ? WHERE id = ?').run('{"a":{"b":1}}', job.id);
    expect(getJob(db, job.id)!.variables).toBeUndefined();

    db.prepare('UPDATE schedule_jobs SET variables = ? WHERE id = ?').run('{"a":1,"b":"ok"}', job.id);
    expect(getJob(db, job.id)!.variables).toEqual({ b: 'ok' });
  });
});

describe('listRunsForJob excludeHoleRows', () => {
  it('excludes operator_skip and operator_unskip from the limited page so real ticks stay visible', () => {
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
    });
    const t0 = Date.parse('2026-07-28T10:00:00.000Z');
    // Newest rows are hole bookkeeping — without exclude they fill limit=2.
    const holeFuture = createRun(db, { jobId: job.id, status: 'skipped', firedAt: t0 + 3_600_000 });
    updateRun(db, holeFuture.id, { finishedAt: t0, error: 'operator_skip' });
    const holeUnskip = createRun(db, { jobId: job.id, status: 'skipped', firedAt: t0 + 7_200_000 });
    updateRun(db, holeUnskip.id, { finishedAt: t0, error: 'operator_unskip' });
    const real = createRun(db, { jobId: job.id, status: 'succeeded', firedAt: t0 });
    const overlap = createRun(db, { jobId: job.id, status: 'skipped', firedAt: t0 - 60_000 });
    updateRun(db, overlap.id, { finishedAt: t0, error: 'overlap_skip' });

    expect(listRunsForJob(db, job.id, { limit: 2 }).map((r) => r.id)).toEqual([
      holeUnskip.id, holeFuture.id,
    ]);
    expect(listRunsForJob(db, job.id, { limit: 2, excludeHoleRows: true }).map((r) => r.id)).toEqual([
      real.id, overlap.id,
    ]);
  });
});

describe('pruneInertOperatorHoleRows', () => {
  it('deletes operator_unskip only; keeps operator_skip (live holes) and real runs', () => {
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
    });
    const now = Date.parse('2026-07-28T12:00:00.000Z');
    const pastSkip = createRun(db, { jobId: job.id, status: 'skipped', firedAt: now - 60_000 });
    updateRun(db, pastSkip.id, { finishedAt: now - 60_000, error: 'operator_skip' });
    const futureSkip = createRun(db, { jobId: job.id, status: 'skipped', firedAt: now + 60_000 });
    updateRun(db, futureSkip.id, { finishedAt: now, error: 'operator_skip' });
    const unskip = createRun(db, { jobId: job.id, status: 'skipped', firedAt: now + 120_000 });
    updateRun(db, unskip.id, { finishedAt: now, error: 'operator_unskip' });
    const real = createRun(db, { jobId: job.id, status: 'succeeded', firedAt: now - 120_000 });

    expect(pruneInertOperatorHoleRows(db, now)).toBe(1);
    const left = listRunsForJob(db, job.id, { limit: 50 }).map((r) => r.id).sort();
    expect(left).toEqual([pastSkip.id, futureSkip.id, real.id].sort());
  });
});

describe('healInfraBlockedSteps', () => {
  function seedWithStep() {
    return createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
      steps: [{ title: 'only', body: 'do it' }],
    });
  }

  it('promotes blocked step when last run has no_step_update', () => {
    const job = seedWithStep();
    const step = listSteps(db, job.id)[0];
    updateStepStatus(db, step.id, 'blocked');
    const run = createRun(db, {
      jobId: job.id, stepId: step.id, status: 'running', firedAt: Date.now(),
    });
    updateRun(db, run.id, { status: 'failed', finishedAt: Date.now(), error: 'no_step_update' });

    const healed = healInfraBlockedSteps(db, job.id);
    expect(healed).toHaveLength(1);
    expect(listSteps(db, job.id)[0].status).toBe('ready');
    // selectCurrentStep can pick it again
    expect(selectCurrentStep(db, job.id)?.id).toBe(step.id);
  });

  it('does not heal agent-declared blocked with a clear body', () => {
    const job = seedWithStep();
    const step = listSteps(db, job.id)[0];
    db.prepare(`UPDATE schedule_steps SET status = 'blocked', body = ? WHERE id = ?`)
      .run('Waiting on human approval for prod deploy', step.id);
    createRun(db, {
      jobId: job.id, stepId: step.id, status: 'failed', firedAt: Date.now(),
    });

    expect(healInfraBlockedSteps(db, job.id)).toHaveLength(0);
    expect(listSteps(db, job.id)[0].status).toBe('blocked');
  });

  it('heals when body starts with step_api_failed', () => {
    const job = seedWithStep();
    const step = listSteps(db, job.id)[0];
    db.prepare(`UPDATE schedule_steps SET status = 'blocked', body = ? WHERE id = ?`)
      .run('step_api_failed: FOREIGN KEY constraint failed', step.id);

    expect(healInfraBlockedSteps(db, job.id)).toHaveLength(1);
    expect(listSteps(db, job.id)[0].status).toBe('ready');
  });
});

describe('pending_context repository', () => {
  function seed() {
    return createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8', homeConversationId: homeId,
      promptTemplate: 'x', nextFireAt: 1,
      carryContextEnabled: true,
    });
  }

  it('setPendingContext stores text + source; empty clears', () => {
    const job = seed();
    setPendingContext(db, job.id, { text: 'remember PR #12', source: 'operator' });
    let j = getJob(db, job.id)!;
    expect(j.pendingContext).toBe('remember PR #12');
    expect(j.pendingContextSource).toBe('operator');
    expect(j.pendingContextUpdatedAt).toBeTypeOf('number');

    setPendingContext(db, job.id, { text: null, source: 'operator' });
    j = getJob(db, job.id)!;
    expect(j.pendingContext).toBeUndefined();
    expect(j.pendingContextSource).toBeUndefined();
    expect(j.pendingContextUpdatedAt).toBeUndefined();
  });

  it('consumePendingContext atomically clears and returns previous text once', () => {
    const job = seed();
    setPendingContext(db, job.id, { text: 'once only', source: 'run' });

    const first = consumePendingContext(db, job.id);
    expect(first).toBe('once only');
    expect(getJob(db, job.id)!.pendingContext).toBeUndefined();

    const second = consumePendingContext(db, job.id);
    expect(second).toBeUndefined();
  });

  it('PENDING_CONTEXT_MAX_BYTES is 8 KiB', () => {
    expect(PENDING_CONTEXT_MAX_BYTES).toBe(8 * 1024);
  });
});

describe('hardDeleteJob resume vs spawn', () => {
  it('does not purge a resume-bound project chat or its events', () => {
    const bound = createConversation(db, { projectId, title: 'bound chat' });
    // No catalogue seed in this file — leave agent columns null.
    const sess = createSession(db, { id: 'sess-bound', conversationId: bound.id });
    appendEvent(db, {
      sessionId: sess.id,
      type: 'prompt',
      sender: 'user',
      payload: { text: 'keep me' },
    });
    const job = createJob(db, {
      projectId,
      name: 'resume-job',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8',
      homeConversationId: homeId,
      promptTemplate: 'tick',
      nextFireAt: Date.now() + 99999,
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
    });
    createRun(db, {
      jobId: job.id, conversationId: bound.id, status: 'succeeded', firedAt: Date.now(),
    });

    const r = hardDeleteJob(db, job.id);
    expect(r.ok).toBe(true);
    expect(r.deletedConversationIds).not.toContain(bound.id);
    expect(getConversation(db, bound.id)).toBeTruthy();
    expect(listEventsForConversation(db, bound.id).some((e) => e.type === 'prompt')).toBe(true);
    expect(getJob(db, job.id)).toBeUndefined();
  });

  it('still deletes a spawn_child run conversation under home', () => {
    const job = createJob(db, {
      projectId,
      name: 'spawn-job',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8',
      homeConversationId: homeId,
      promptTemplate: 'tick',
      nextFireAt: Date.now() + 99999,
    });
    const runConv = createConversation(db, {
      projectId, title: '⏱ run', parentConversationId: homeId,
    });
    createRun(db, {
      jobId: job.id, conversationId: runConv.id, status: 'succeeded', firedAt: Date.now(),
    });

    const r = hardDeleteJob(db, job.id);
    expect(r.ok).toBe(true);
    expect(r.deletedConversationIds).toContain(runConv.id);
    expect(getConversation(db, runConv.id)).toBeUndefined();
  });
});
