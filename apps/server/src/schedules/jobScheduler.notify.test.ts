import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import {
  createJob, createRun, listRunsForJob, updateRun,
} from '../repositories/schedules.js';
import { JobScheduler } from './jobScheduler.js';

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
  return createJob(db, {
    projectId,
    name: 'Nightly wave',
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

describe('JobScheduler notification broadcasts', () => {
  it('fires a once job with event auto_disabled and jobName', async () => {
    const now = Date.now();
    const atMs = now - 1;
    const job = seedJob({
      name: 'One-shot wave',
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      nextFireAt: atMs,
    });
    const broadcasts: Record<string, unknown>[] = [];
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      broadcastScheduleUpdated: (_projectId, _jobId, detail) => {
        broadcasts.push({ ...detail });
      },
    });
    await scheduler.tickOnce();

    expect(broadcasts).toContainEqual(expect.objectContaining({
      event: 'auto_disabled',
      jobName: 'One-shot wave',
    }));
  });

  it('finalize broadcast carries jobName and a terminal runStatus', async () => {
    const now = Date.now();
    const job = seedJob({ name: 'Nightly wave', nextFireAt: now - 1 });
    const runConv = createConversation(db, {
      projectId, title: 'run child', parentConversationId: homeId,
    });
    const broadcasts: Record<string, unknown>[] = [];
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      broadcastScheduleUpdated: (_projectId, _jobId, detail) => {
        broadcasts.push({ ...detail });
      },
    });
    await scheduler.tickOnce();
    const run = listRunsForJob(db, job.id)[0];
    updateRun(db, run.id, { conversationId: runConv.id });
    scheduler.registerActiveRun(runConv.id, {
      projectId: job.projectId, jobId: job.id, runId: run.id,
    });
    broadcasts.length = 0;
    scheduler.finalizeRun(run.id, { status: 'succeeded', outcomeSummary: 'ok', stepUpdated: true });

    expect(broadcasts).toContainEqual(expect.objectContaining({
      jobName: 'Nightly wave',
      runStatus: 'succeeded',
      runId: run.id,
    }));
  });

  it('reclaimStuck broadcast carries jobName', () => {
    const now = Date.now();
    const job = seedJob({ name: 'Nightly wave', nextFireAt: now + 999_999, runTimeoutMs: 60_000 });
    const stuckConv = createConversation(db, {
      projectId, title: 'stuck run', parentConversationId: homeId,
    });
    const run = createRun(db, {
      jobId: job.id, status: 'running', firedAt: now - 60_000 - 1, conversationId: stuckConv.id,
    });
    const broadcasts: Record<string, unknown>[] = [];
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      broadcastScheduleUpdated: (_projectId, _jobId, detail) => {
        broadcasts.push({ ...detail });
      },
    });
    scheduler.registerActiveRun(stuckConv.id, {
      projectId: job.projectId, jobId: job.id, runId: run.id,
    });
    expect(scheduler.reclaimStuck()).toBe(1);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      jobName: 'Nightly wave',
      runStatus: 'failed',
    }));
  });

  it('bare running dispatch broadcast carries no event field', async () => {
    const now = Date.now();
    const job = seedJob({ nextFireAt: now - 1 });
    const broadcasts: Record<string, unknown>[] = [];
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => now,
      broadcastScheduleUpdated: (_projectId, _jobId, detail) => {
        broadcasts.push({ ...detail });
      },
    });
    await scheduler.tickOnce();
    const run = listRunsForJob(db, job.id)[0];
    const running = broadcasts.find((b) => b.runStatus === 'running' && b.runId === run.id);
    expect(running).toBeTruthy();
    expect(running).not.toHaveProperty('event');
  });
});
