import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, enableAllAgents } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import { upsertDiscoveredModels } from '../repositories/models.js';
import { createProject } from '../repositories/projects.js';
import {
  createRun, getJob, listSteps, getRun, updateStepStatus, createJob,
  setPendingContext, PENDING_CONTEXT_MAX_BYTES, listRunsForJob, setNextFireAt,
} from '../repositories/schedules.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { createSession, setNativeSessionId } from '../repositories/sessions.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { registry } from '../registry.js';
import { issueRunToken, revokeRunToken } from '../schedules/runTokens.js';
import { issueSpawnToken, revokeSpawnTokensForSession } from '../spawn/tokens.js';
import { JobScheduler } from '../schedules/jobScheduler.js';
import {
  registerScheduleRoutes, registerScheduleAgentRoutes, decideAgentEnabled, type JobSchedulerLike,
} from './schedules.js';
import { requireAuth } from '../auth/middleware.js';
import { registerGeneralSettingsRoutes } from './settings.js';
import { saveTemplate } from '../repositories/settings.js';

const GROK_BOT_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const GROK_PROFILE = `grok-bot:${GROK_BOT_ID}`;

/** Bound chat with a grok-bot session so Task 8 pinning succeeds. */
function boundBotConversation(title = 'bot chat') {
  const bound = createConversation(getDb(), { projectId, title });
  const sid = `s-${bound.id.slice(0, 8)}`;
  createSession(getDb(), {
    id: sid,
    conversationId: bound.id,
    agentId: 'grok-bot',
    agentModelId: GROK_PROFILE,
  });
  setNativeSessionId(getDb(), sid, GROK_BOT_ID);
  return bound;
}

function grokResumeOverrides(extra: Record<string, unknown> = {}) {
  const bound = boundBotConversation();
  return {
    executionMode: 'resume_conversation' as const,
    boundConversationId: bound.id,
    profileId: GROK_PROFILE,
    ...extra,
  };
}

let server: Server;
let base: string;
let projectId: string;
let broadcasts: Array<{ projectId: string; jobId: string }>;
let runNow: ReturnType<typeof vi.fn>;
let isAuthed: boolean;
let remoteHostView: ((id: string) => import('@tierwyn/shared').RemoteHostView | undefined) | undefined;

function mountApp() {
  broadcasts = [];
  isAuthed = false;
  runNow = vi.fn(async (jobId: string) => ({ ok: true as const, runId: `run-for-${jobId}` }));
  const stubScheduler: JobSchedulerLike = { runNow };
  const app = express();
  app.use(express.json());
  const broadcast = (pid: string, jobId: string) => broadcasts.push({ projectId: pid, jobId });
  // Agent routes first (pre-auth dual-auth), same order as index.ts.
  registerScheduleAgentRoutes(app, {
    getDb,
    isAuthed: () => isAuthed,
    broadcast,
    remoteHostView,
  });
  registerScheduleRoutes(app, {
    getDb,
    jobScheduler: stubScheduler,
    broadcast,
    remoteHostView,
  });
  return app;
}

beforeEach(async () => {
  remoteHostView = undefined;
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedCatalogue(db);
  enableAllAgents(db);
  upsertDiscoveredModels(db, 'grok-bot', [{
    name: GROK_BOT_ID, label: 'Grok Bot · Test', provider: 'xai', vision: false, steer: true,
  }]);
  setDb(db);
  catalogue.load(db);
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  const app = mountApp();
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => {
  registry.setRemoteFactory(undefined);
  server.close(() => r());
}));

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'nightly digest',
    timezone: 'UTC',
    scheduleKind: 'interval',
    scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    profileId: 'claude-code:opus-4.8',
    promptTemplate: 'Summarize the day',
    ...overrides,
  };
}

async function createJobViaApi(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/projects/${projectId}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validCreateBody(overrides)),
  });
  const body = await res.json() as { job: { id: string } };
  return { res, body };
}

describe('POST /projects/:projectId/schedules', () => {
  it('creates a home conversation + job and computes an initial nextFireAt', async () => {
    const { res, body } = await createJobViaApi();
    expect(res.status).toBe(201);
    expect(body.job.id).toBeTruthy();
    const job = getJob(getDb(), body.job.id)!;
    expect(job.nextFireAt).toBeGreaterThan(Date.now() - 1000);
    expect(job.homeConversationId).toBeTruthy();
    expect(job.workdir).toBe('shared');
  });

  it('accepts workdir on create and PATCH', async () => {
    const { res, body } = await createJobViaApi({ workdir: 'worktree' });
    expect(res.status).toBe(201);
    expect(getJob(getDb(), body.job.id)!.workdir).toBe('worktree');

    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workdir: 'shared' }),
    });
    expect(patchRes.status).toBe(200);
    expect(getJob(getDb(), body.job.id)!.workdir).toBe('shared');
  });

  it('links the home conversation to the job (kind + schedule_job_id)', async () => {
    const { body } = await createJobViaApi();
    const job = getJob(getDb(), body.job.id)!;
    const row = getDb().prepare('SELECT kind, schedule_job_id FROM conversations WHERE id = ?')
      .get(job.homeConversationId) as { kind: string; schedule_job_id: string };
    expect(row.kind).toBe('schedule_home');
    expect(row.schedule_job_id).toBe(job.id);
  });

  it('broadcasts schedule_updated on create', async () => {
    await createJobViaApi();
    expect(broadcasts).toHaveLength(1);
  });

  it('persists variables on create and 400s on a bad map', async () => {
    const { res, body } = await createJobViaApi({ variables: { focus: 'audio' } });
    expect(res.status).toBe(201);
    expect(getJob(getDb(), body.job.id)!.variables).toEqual({ focus: 'audio' });

    const bad = await fetch(`${base}/projects/${projectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody({ variables: { 'a.b': 'x' } })),
    });
    expect(bad.status).toBe(400);
    const badBody = await bad.json() as { error: string };
    expect(badBody.error).toMatch(/invalid key/);
  });

  it('404s for an unknown project', async () => {
    const res = await fetch(`${base}/projects/nope/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody()),
    });
    expect(res.status).toBe(404);
  });

  it('400s when required fields are missing', async () => {
    const res = await fetch(`${base}/projects/${projectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody({ name: '' })),
    });
    expect(res.status).toBe(400);
  });

  it('400s on an invalid schedule expression', async () => {
    const res = await fetch(`${base}/projects/${projectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody({ scheduleExpr: 'not json' })),
    });
    expect(res.status).toBe(400);
  });

  it('400s when resume_conversation is missing boundConversationId', async () => {
    const res = await fetch(`${base}/projects/${projectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody({ executionMode: 'resume_conversation' })),
    });
    expect(res.status).toBe(400);
  });

  it('creates once job with future atMs and nextFireAt === atMs', async () => {
    const atMs = Date.now() + 3_600_000;
    const { res, body } = await createJobViaApi({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job.id)!;
    expect(job.scheduleKind).toBe('once');
    expect(job.nextFireAt).toBe(atMs);
  });

  it('400s when once atMs is in the past', async () => {
    const res = await fetch(`${base}/projects/${projectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody({
        scheduleKind: 'once',
        scheduleExpr: JSON.stringify({ atMs: Date.now() - 60_000 }),
      })),
    });
    expect(res.status).toBe(400);
    const err = await res.json() as { error: string };
    expect(err.error).toMatch(/future/i);
  });

  it('400s when grok-bot profile is paired with plan steps', async () => {
    const res = await fetch(`${base}/projects/${projectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody({
        profileId: GROK_PROFILE,
        steps: [{ title: 'A', body: 'do it' }],
      })),
    });
    expect(res.status).toBe(400);
    const err = await res.json() as { error: string; code?: string };
    expect(err.code).toBe('bare_prompt_unsupported');
    expect(err.error).toMatch(/plan steps is not supported/);
  });

  it('creates a resume_conversation job with boundConversationId', async () => {
    const bound = createConversation(getDb(), { projectId, title: 'bound chat' });
    const { res, body } = await createJobViaApi({
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
      profileId: 'inherit',
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job.id)!;
    expect(job.executionMode).toBe('resume_conversation');
    expect(job.boundConversationId).toBe(bound.id);
    expect(job.profileId).toBe('inherit');
  });
});

describe('PATCH resume_conversation / executionMode immutability', () => {
  async function createResumeJob() {
    const bound = createConversation(getDb(), { projectId, title: 'bound chat' });
    const { res, body } = await createJobViaApi({
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
      profileId: 'claude-code:opus-4.8',
    });
    expect(res.status).toBe(201);
    return { jobId: body.job.id, boundId: bound.id };
  }

  it('400s when PATCH changes executionMode', async () => {
    const { jobId } = await createResumeJob();
    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionMode: 'spawn_child' }),
    });
    expect(patchRes.status).toBe(400);
    const err = await patchRes.json() as { error: string };
    expect(err.error).toBe('executionMode is immutable');
  });

  it('200 when PATCH restates the same executionMode', async () => {
    const { jobId } = await createResumeJob();
    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionMode: 'resume_conversation', name: 'renamed resume' }),
    });
    expect(patchRes.status).toBe(200);
    expect(getJob(getDb(), jobId)!.name).toBe('renamed resume');
    expect(getJob(getDb(), jobId)!.executionMode).toBe('resume_conversation');
  });

  it('200 when PATCH rebinds to a valid chat', async () => {
    const { jobId } = await createResumeJob();
    const other = createConversation(getDb(), { projectId, title: 'other chat' });
    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boundConversationId: other.id }),
    });
    expect(patchRes.status).toBe(200);
    expect(getJob(getDb(), jobId)!.boundConversationId).toBe(other.id);
  });

  it('400 when PATCH boundConversationId: null on a resume job', async () => {
    const { jobId } = await createResumeJob();
    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boundConversationId: null }),
    });
    expect(patchRes.status).toBe(400);
    const err = await patchRes.json() as { error: string };
    expect(err.error).toMatch(/boundConversationId required/);
  });

  it('400 when PATCH sets empty promptTemplate on a resume job', async () => {
    const { jobId } = await createResumeJob();
    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptTemplate: '   ' }),
    });
    expect(patchRes.status).toBe(400);
    const err = await patchRes.json() as { error: string };
    expect(err.error).toMatch(/promptTemplate/);
  });
});

describe('PATCH once / clock recompute', () => {
  it('400s when PATCH sets templateName on a grok-bot job', async () => {
    saveTemplate(getDb(), {
      name: 'delegate',
      roles: [{ role: 'impl', profileId: 'claude-code:opus-4.8', when: 'test' }],
    });
    const { res, body } = await createJobViaApi(grokResumeOverrides());
    expect(res.status).toBe(201);
    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateName: 'delegate' }),
    });
    expect(patchRes.status).toBe(400);
    const err = await patchRes.json() as { error: string; code?: string };
    expect(err.code).toBe('bare_prompt_unsupported');
    expect(err.error).toMatch(/delegation template is not supported/);
  });

  function insertLegacyStep(jobId: string) {
    getDb().prepare(
      `INSERT INTO schedule_steps (id, job_id, ordinal, title, body, status, updated_at)
       VALUES (?, ?, 0, 'Legacy', 'pre-phase1 step', 'ready', ?)`,
    ).run(randomUUID(), jobId, Date.now());
  }

  it('rename-only PATCH on a grok-bot job with a stored step → 200', async () => {
    const { res, body } = await createJobViaApi(grokResumeOverrides());
    expect(res.status).toBe(201);
    insertLegacyStep(body.job.id);
    expect(listSteps(getDb(), body.job.id)).toHaveLength(1);

    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed bot job' }),
    });
    expect(patchRes.status).toBe(200);
    expect(getJob(getDb(), body.job.id)!.name).toBe('renamed bot job');
    expect(listSteps(getDb(), body.job.id)).toHaveLength(1);
  });

  it('unchanged-values PATCH on a grok-bot job with a stored step → 200', async () => {
    const { res, body } = await createJobViaApi(grokResumeOverrides());
    expect(res.status).toBe(201);
    insertLegacyStep(body.job.id);

    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: GROK_PROFILE,
        workdir: 'shared',
        agentMayComplete: false,
      }),
    });
    expect(patchRes.status).toBe(200);
    expect(listSteps(getDb(), body.job.id)).toHaveLength(1);
  });

  it('profile switch claude-code → grok-bot with stored steps → 400 naming plan steps', async () => {
    const bound = boundBotConversation();
    const { res, body } = await createJobViaApi({
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
      steps: [{ title: 'A', body: 'do it' }],
    });
    expect(res.status).toBe(201);
    expect(listSteps(getDb(), body.job.id).length).toBeGreaterThan(0);

    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: GROK_PROFILE }),
    });
    expect(patchRes.status).toBe(400);
    const err = await patchRes.json() as { error: string; code?: string };
    expect(err.code).toBe('bare_prompt_unsupported');
    expect(err.error).toMatch(/plan steps/);
  });

  it('profile switch resume claude-code → grok-bot with steps:[] pins the Bot', async () => {
    const bound = boundBotConversation();
    const { res, body } = await createJobViaApi({
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
      steps: [{ title: 'A', body: 'do it' }],
    });
    expect(res.status).toBe(201);

    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: GROK_PROFILE, steps: [] }),
    });
    expect(patchRes.status).toBe(200);
    expect(getJob(getDb(), body.job.id)!.profileId).toBe(GROK_PROFILE);
    expect(listSteps(getDb(), body.job.id)).toHaveLength(0);
  });

  it('profile switch spawn_child → grok-bot rejects grok_bot_requires_resume', async () => {
    const { res, body } = await createJobViaApi({
      steps: [{ title: 'A', body: 'do it' }],
    });
    expect(res.status).toBe(201);

    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: GROK_PROFILE, steps: [] }),
    });
    expect(patchRes.status).toBe(400);
    const err = await patchRes.json() as { error: string; code?: string };
    expect(err.code).toBe('grok_bot_requires_resume');
  });

  it('PATCH interval→once recomputes next_fire_at to atMs', async () => {
    const { body: created } = await createJobViaApi();
    const jobId = created.job.id as string;
    const atMs = Date.now() + 7_200_000;

    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleKind: 'once',
        scheduleExpr: JSON.stringify({ atMs }),
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { job: { scheduleKind: string; nextFireAt: number } };
    expect(patchBody.job.scheduleKind).toBe('once');
    expect(patchBody.job.nextFireAt).toBe(atMs);
    expect(getJob(getDb(), jobId)!.nextFireAt).toBe(atMs);
  });

  it('PATCH variables replaces wholesale, 400s on bad map, omitted leaves untouched', async () => {
    const { body: created } = await createJobViaApi({ variables: { focus: 'audio', cap: '3' } });
    const jobId = created.job.id as string;

    const omit = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(omit.status).toBe(200);
    expect(getJob(getDb(), jobId)!.variables).toEqual({ focus: 'audio', cap: '3' });

    const bad = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables: { n: 1 } }),
    });
    expect(bad.status).toBe(400);
    expect(getJob(getDb(), jobId)!.variables).toEqual({ focus: 'audio', cap: '3' });

    const ok = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables: { focus: 'video' } }),
    });
    expect(ok.status).toBe(200);
    expect(getJob(getDb(), jobId)!.variables).toEqual({ focus: 'video' });

    const clear = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables: null }),
    });
    expect(clear.status).toBe(200);
    expect(getJob(getDb(), jobId)!.variables).toBeUndefined();
  });

  it('PATCH once with past atMs → 400', async () => {
    const { body: created } = await createJobViaApi();
    const jobId = created.job.id as string;
    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleKind: 'once',
        scheduleExpr: JSON.stringify({ atMs: Date.now() - 1_000 }),
      }),
    });
    expect(patchRes.status).toBe(400);
  });

  // Adversary F2 — exhausted once cannot be re-armed via enable alone.
  it('enable on exhausted once → 400; PATCH clock re-arms', async () => {
    const { ONCE_EXHAUSTED_MS } = await import('../schedules/nextFire.js');
    const { setNextFireAt, setJobEnabled } = await import('../repositories/schedules.js');
    const atMs = Date.now() + 3_600_000;
    const { body: created } = await createJobViaApi({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
    });
    const jobId = created.job.id as string;
    // Simulate claim-time exhaustion.
    setNextFireAt(getDb(), jobId, ONCE_EXHAUSTED_MS);
    setJobEnabled(getDb(), jobId, false);

    const enableRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/enable`, {
      method: 'POST',
    });
    expect(enableRes.status).toBe(400);
    const enableErr = await enableRes.json() as { error: string };
    expect(enableErr.error).toMatch(/exhausted/i);

    const patchEnableOnly = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(patchEnableOnly.status).toBe(400);

    const newAt = Date.now() + 7_200_000;
    const patchClock = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleKind: 'once',
        scheduleExpr: JSON.stringify({ atMs: newAt }),
        enabled: true,
      }),
    });
    expect(patchClock.status).toBe(200);
    const patched = await patchClock.json() as { job: { enabled: boolean; nextFireAt: number } };
    expect(patched.job.enabled).toBe(true);
    expect(patched.job.nextFireAt).toBe(newAt);
  });
});

describe('full operator lifecycle', () => {
  it('create → list → get → patch name → disable → enable → upcoming length 5 → delete archives → run-now creates a run', async () => {
    const { body: created } = await createJobViaApi({ name: 'lifecycle job' });
    const jobId = created.job.id as string;

    // list
    const listRes = await fetch(`${base}/projects/${projectId}/schedules`);
    const listBody = await listRes.json() as { jobs: Array<{ id: string }> };
    expect(listRes.status).toBe(200);
    expect(listBody.jobs.map((j) => j.id)).toContain(jobId);

    // get
    const getRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`);
    const getBody = await getRes.json() as { job: { name: string; stepProgress: { done: number; total: number } } };
    expect(getRes.status).toBe(200);
    expect(getBody.job.name).toBe('lifecycle job');
    expect(getBody.job.stepProgress).toEqual({ done: 0, total: 0 });

    // patch name
    const patchRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed job' }),
    });
    const patchBody = await patchRes.json() as { job: { name: string } };
    expect(patchRes.status).toBe(200);
    expect(patchBody.job.name).toBe('renamed job');

    // disable
    const disableRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/disable`, { method: 'POST' });
    const disableBody = await disableRes.json() as { job: { enabled: boolean } };
    expect(disableBody.job.enabled).toBe(false);

    // enable
    const enableRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/enable`, { method: 'POST' });
    const enableBody = await enableRes.json() as { job: { enabled: boolean } };
    expect(enableBody.job.enabled).toBe(true);

    // upcoming length 5
    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming`);
    const upcomingBody = await upcomingRes.json() as { fires: number[] };
    expect(upcomingRes.status).toBe(200);
    expect(upcomingBody.fires).toHaveLength(5);
    for (let i = 1; i < upcomingBody.fires.length; i++) {
      expect(upcomingBody.fires[i]).toBeGreaterThan(upcomingBody.fires[i - 1]);
    }

    // run-now creates a run
    const runNowRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/run-now`, { method: 'POST' });
    const runNowBody = await runNowRes.json() as { runId: string };
    expect(runNowRes.status).toBe(202);
    expect(runNow).toHaveBeenCalledWith(jobId);
    expect(runNowBody.runId).toBe(`run-for-${jobId}`);

    // archive soft-hides the job
    const archiveRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/archive`, { method: 'POST' });
    const archiveBody = await archiveRes.json() as { job: { archived: boolean; enabled: boolean } };
    expect(archiveRes.status).toBe(200);
    expect(archiveBody.job.archived).toBe(true);
    expect(archiveBody.job.enabled).toBe(false);

    // archived jobs drop out of the default list
    const listAfterArchive = await fetch(`${base}/projects/${projectId}/schedules`);
    const listAfterArchiveBody = await listAfterArchive.json() as { jobs: Array<{ id: string }> };
    expect(listAfterArchiveBody.jobs.map((j) => j.id)).not.toContain(jobId);

    // hard DELETE purges the job row entirely
    const deleteRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, { method: 'DELETE' });
    const deleteBody = await deleteRes.json() as { ok: boolean };
    expect(deleteRes.status).toBe(200);
    expect(deleteBody.ok).toBe(true);
    expect(getJob(getDb(), jobId)).toBeUndefined();
  });

  it('re-enabling a job with a stale past next_fire_at waits for the next slot (no immediate fire)', async () => {
    const { body: created } = await createJobViaApi({ name: 'stale enable' });
    const jobId = created.job.id as string;
    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/disable`, { method: 'POST' });
    getDb().prepare('UPDATE schedule_jobs SET next_fire_at = ? WHERE id = ?').run(Date.now() - 60_000, jobId);
    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/enable`, { method: 'POST' });
    expect(getJob(getDb(), jobId)!.nextFireAt).toBeGreaterThan(Date.now());

    // Same via PATCH { enabled: true }.
    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/disable`, { method: 'POST' });
    getDb().prepare('UPDATE schedule_jobs SET next_fire_at = ? WHERE id = ?').run(Date.now() - 60_000, jobId);
    await fetch(`${base}/projects/${projectId}/schedules/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(getJob(getDb(), jobId)!.nextFireAt).toBeGreaterThan(Date.now());
  });

  it('deletes an individual schedule run row via DELETE /runs/:runId', async () => {
    const { body: created } = await createJobViaApi({ name: 'delete run' });
    const jobId = created.job.id as string;
    const run = createRun(getDb(), {
      jobId,
      status: 'failed',
      firedAt: Date.now(),
      error: 'conversation_deleted',
    });
    expect(listRunsForJob(getDb(), jobId)).toHaveLength(1);

    const res = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/runs/${run.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; deletedRunId: string };
    expect(body.ok).toBe(true);
    expect(body.deletedRunId).toBe(run.id);
    expect(listRunsForJob(getDb(), jobId)).toHaveLength(0);
  });

  it('clears failed/errored runs via POST /clear-errors', async () => {
    const { body: created } = await createJobViaApi({ name: 'clear errors' });
    const jobId = created.job.id as string;
    createRun(getDb(), {
      jobId,
      status: 'failed',
      firedAt: Date.now() - 2000,
      error: 'conversation_deleted',
    });
    createRun(getDb(), {
      jobId,
      status: 'timed_out',
      firedAt: Date.now() - 1000,
    });
    createRun(getDb(), {
      jobId,
      status: 'succeeded',
      firedAt: Date.now(),
    });
    expect(listRunsForJob(getDb(), jobId)).toHaveLength(3);

    const res = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/clear-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; deletedCount: number };
    expect(body.ok).toBe(true);
    expect(body.deletedCount).toBe(2);
    const remaining = listRunsForJob(getDb(), jobId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('succeeded');
  });
});

describe('run-now error mapping', () => {
  it('maps active_run_exists to 409 with a clear message', async () => {
    const { body } = await createJobViaApi();
    runNow.mockResolvedValueOnce({ ok: false, error: 'active_run_exists' });
    const res = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}/run-now`, { method: 'POST' });
    expect(res.status).toBe(409);
    const errBody = await res.json() as { error: string };
    expect(errBody.error).toMatch(/already in progress/i);
  });

  it('maps job_not_found to 404', async () => {
    const { body } = await createJobViaApi();
    runNow.mockResolvedValueOnce({ ok: false, error: 'job_not_found' });
    const res = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}/run-now`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('project/job scoping', () => {
  it('404s job routes for a job that belongs to a different project', async () => {
    const { body } = await createJobViaApi();
    const otherProjectId = createProject(getDb(), { name: 'other', rootPath: '/tmp/other' }).id;
    const res = await fetch(`${base}/projects/${otherProjectId}/schedules/${body.job.id}`);
    expect(res.status).toBe(404);
  });

  it('404s for an unknown jobId', async () => {
    const res = await fetch(`${base}/projects/${projectId}/schedules/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/:projectId/schedules/tree', () => {
  it('returns jobs with their runs, conversations, and descendants', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const db = getDb();
    const run = createRun(db, { jobId, status: 'succeeded', firedAt: Date.now() });

    const res = await fetch(`${base}/projects/${projectId}/schedules/tree`);
    const treeBody = await res.json() as {
      jobs: Array<{ job: { id: string }; runs: Array<{ run: { id: string }; conversation?: unknown; descendants: unknown[] }> }>;
    };
    expect(res.status).toBe(200);
    const treeJob = treeBody.jobs.find((j) => j.job.id === jobId)!;
    expect(treeJob.runs.map((r) => r.run.id)).toContain(run.id);
    const treeRun = treeJob.runs.find((r) => r.run.id === run.id)!;
    expect(treeRun.conversation).toBeUndefined(); // no conversation attached to this run
    expect(treeRun.descendants).toEqual([]);
  });

  it('hides /btw answer-children from run descendants (same as projects tab)', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const db = getDb();
    const home = createConversation(db, {
      projectId, title: '⏱ home', kind: 'schedule_home',
    });
    const runConv = createConversation(db, {
      projectId,
      title: '⏱ nightly @ 2026-07-25T12:00',
      parentConversationId: home.id,
    });
    const spawnChild = createConversation(db, {
      projectId,
      title: '↳ Implementer: do the thing',
      parentConversationId: runConv.id,
    });
    const btwChild = createConversation(db, {
      projectId,
      title: '⁇ btw: what happened?',
      parentConversationId: runConv.id,
    });
    // Register as a real BTW child — title alone is not enough; list uses btw_queries.
    db.prepare(
      `INSERT INTO btw_queries
         (id, parent_conv_id, child_conv_id, question, status, agent_id, created_at)
       VALUES (?, ?, ?, ?, 'done', 'claude-code', ?)`,
    ).run('btw-1', runConv.id, btwChild.id, 'what happened?', Date.now());

    createRun(db, {
      jobId,
      status: 'succeeded',
      firedAt: Date.now(),
      conversationId: runConv.id,
    });

    const res = await fetch(`${base}/projects/${projectId}/schedules/tree`);
    const treeBody = await res.json() as {
      jobs: Array<{
        job: { id: string };
        runs: Array<{
          conversation?: { id: string };
          descendants: Array<{ id: string; title: string }>;
        }>;
      }>;
    };
    expect(res.status).toBe(200);
    const treeJob = treeBody.jobs.find((j) => j.job.id === jobId)!;
    const treeRun = treeJob.runs.find((r) => r.conversation?.id === runConv.id)!;
    const descIds = treeRun.descendants.map((d) => d.id);
    expect(descIds).toContain(spawnChild.id);
    expect(descIds).not.toContain(btwChild.id);
  });

  it('404s for an unknown project', async () => {
    const res = await fetch(`${base}/projects/nope/schedules/tree`);
    expect(res.status).toBe(404);
  });

  it('returns descendants: [] for resume_conversation runs (keeps conversation link)', async () => {
    const bound = createConversation(getDb(), { projectId, title: 'bound chat' });
    const child = createConversation(getDb(), {
      projectId, title: '↳ spawn of bound', parentConversationId: bound.id,
    });
    const { res: createRes, body } = await createJobViaApi({
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
    });
    expect(createRes.status).toBe(201);
    const jobId = body.job.id;
    createRun(getDb(), {
      jobId, conversationId: bound.id, status: 'succeeded', firedAt: Date.now(),
    });

    const res = await fetch(`${base}/projects/${projectId}/schedules/tree`);
    const treeBody = await res.json() as {
      jobs: Array<{
        job: { id: string; executionMode: string };
        runs: Array<{
          conversation?: { id: string };
          descendants: Array<{ id: string }>;
        }>;
      }>;
    };
    expect(res.status).toBe(200);
    const treeJob = treeBody.jobs.find((j) => j.job.id === jobId)!;
    expect(treeJob.job.executionMode).toBe('resume_conversation');
    const treeRun = treeJob.runs.find((r) => r.conversation?.id === bound.id)!;
    expect(treeRun.conversation?.id).toBe(bound.id);
    expect(treeRun.descendants).toEqual([]);
    expect(treeRun.descendants.map((d) => d.id)).not.toContain(child.id);
  });
});

describe('DELETE resume job with busy bound chat', () => {
  it('does not 409 when the bound chat has an in-flight session', async () => {
    const { performScheduleDelete } = await import('./schedules.js');
    const bound = createConversation(getDb(), { projectId, title: 'bound chat' });
    const { res: createRes, body } = await createJobViaApi({
      executionMode: 'resume_conversation',
      boundConversationId: bound.id,
    });
    expect(createRes.status).toBe(201);
    const job = getJob(getDb(), body.job.id)!;
    createRun(getDb(), {
      jobId: job.id, conversationId: bound.id, status: 'succeeded', firedAt: Date.now(),
    });

    const out = await performScheduleDelete(
      {
        getDb,
        broadcast: () => {},
        sessionManager: {
          activeSessionForConversation: () => undefined,
          inFlightSessionForConversation: (id: string) => (id === bound.id ? { id: 'busy' } : undefined),
          reapParkedSessions: async () => {},
        },
      },
      job.id,
      projectId,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.deletedConversationIds).not.toContain(bound.id);
    }
    expect(getConversation(getDb(), bound.id)).toBeTruthy();
  });
});

describe('GET /projects/:projectId/schedules/:jobId/runs', () => {
  it('lists runs for the job', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    createRun(getDb(), { jobId, status: 'succeeded', firedAt: Date.now() });
    createRun(getDb(), { jobId, status: 'failed', firedAt: Date.now() });

    const res = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/runs`);
    const runsBody = await res.json() as { runs: Array<{ jobId: string }> };
    expect(res.status).toBe(200);
    expect(runsBody.runs).toHaveLength(2);
    expect(runsBody.runs.every((r) => r.jobId === jobId)).toBe(true);
  });

  it('does not let operator hole rows crowd out real past runs under limit', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const db = getDb();
    const t0 = Date.now();
    const real = createRun(db, { jobId, status: 'succeeded', firedAt: t0 });
    for (let i = 1; i <= 5; i++) {
      const hole = createRun(db, { jobId, status: 'skipped', firedAt: t0 + i * 60_000 });
      db.prepare(`UPDATE schedule_runs SET error = 'operator_unskip', finished_at = ? WHERE id = ?`)
        .run(t0, hole.id);
    }

    const res = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/runs?limit=3`);
    const runsBody = await res.json() as { runs: Array<{ id: string; error?: string }> };
    expect(res.status).toBe(200);
    expect(runsBody.runs.map((r) => r.id)).toEqual([real.id]);
    expect(runsBody.runs.every((r) => r.error !== 'operator_unskip')).toBe(true);
  });
});

describe('GET /projects/:projectId/schedules (stepProgress)', () => {
  it('returns bare jobs by default and detailed jobs with ?stepProgress=true', async () => {
    await createJobViaApi();
    const bare = await fetch(`${base}/projects/${projectId}/schedules`);
    const bareBody = await bare.json() as { jobs: Array<{ steps?: unknown }> };
    expect(bareBody.jobs[0].steps).toBeUndefined();

    const detailed = await fetch(`${base}/projects/${projectId}/schedules?stepProgress=true`);
    const detailedBody = await detailed.json() as { jobs: Array<{ stepProgress: { done: number; total: number } }> };
    expect(detailedBody.jobs[0].stepProgress).toEqual({ done: 0, total: 0 });
  });
});

// ── Task 9: agent step API ──────────────────────────────────────────────────

describe('agent step API auth + authorship', () => {
  it('Bearer with run token can PUT steps', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const token = issueRunToken({ jobId, runId: 'run-1', conversationId: 'c1' });

    const res = await fetch(`${base}/schedules/${jobId}/steps`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        steps: [
          { title: 'A', body: 'do A', status: 'done' },
          { title: 'B', body: 'do B', status: 'ready' },
        ],
      }),
    });
    const resBody = await res.json() as { steps: Array<{ title: string; status: string }> };
    expect(res.status).toBe(200);
    expect(resBody.steps).toHaveLength(2);
    expect(resBody.steps[0]).toMatchObject({ title: 'A', status: 'done' });
    expect(resBody.steps[1]).toMatchObject({ title: 'B', status: 'ready' });
    expect(listSteps(getDb(), jobId)).toHaveLength(2);
    expect(broadcasts.some((b) => b.jobId === jobId)).toBe(true);
    revokeRunToken(token);
  });

  it('PUT replace with dependsOn + existing run does not FK-fail', async () => {
    // Regression: replaceSteps used to DELETE steps while self-deps and
    // schedule_runs.step_id still referenced them → FOREIGN KEY constraint failed.
    const { body } = await createJobViaApi({
      steps: [
        { title: 'discover', body: 'find work' },
        { title: 'implement', body: 'do work', dependsOnOrdinal: 0 },
      ],
    });
    const jobId = body.job.id as string;
    const before = listSteps(getDb(), jobId);
    expect(before).toHaveLength(2);
    expect(before[1].dependsOnStepId).toBe(before[0].id);

    const run = createRun(getDb(), {
      jobId,
      stepId: before[0].id,
      status: 'succeeded',
      firedAt: Date.now(),
    });

    isAuthed = true;
    const res = await fetch(`${base}/schedules/${jobId}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: [
          { title: 'discover', body: 'find work', status: 'done' },
          { title: 'implement', body: 'do work', status: 'running', dependsOnOrdinal: 0 },
          { title: 'review', body: 'check work', status: 'pending', dependsOnOrdinal: 1 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const resBody = await res.json() as {
      steps: Array<{ title: string; status: string; dependsOnStepId?: string }>;
    };
    expect(resBody.steps).toHaveLength(3);
    expect(resBody.steps[0]).toMatchObject({ title: 'discover', status: 'done' });
    expect(resBody.steps[1]).toMatchObject({ title: 'implement', status: 'running' });
    expect(resBody.steps[1].dependsOnStepId).toBe(resBody.steps[0].id);
    expect(resBody.steps[2].dependsOnStepId).toBe(resBody.steps[1].id);

    // Historical run survives; step link is cleared (ids were re-minted).
    const runAfter = getRun(getDb(), run.id)!;
    expect(runAfter.stepId).toBeUndefined();
    expect(runAfter.status).toBe('succeeded');
  });

  it('cookie (isAuthed) can PUT steps', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    isAuthed = true;

    const res = await fetch(`${base}/schedules/${jobId}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: [{ title: 'via cookie', body: 'ok', status: 'pending' }],
      }),
    });
    expect(res.status).toBe(200);
    const resBody = await res.json() as { steps: Array<{ title: string }> };
    expect(resBody.steps[0].title).toBe('via cookie');
  });

  it('PUT steps on a grok-bot job → 400 bare_prompt_unsupported', async () => {
    const { res: createRes, body } = await createJobViaApi(grokResumeOverrides());
    expect(createRes.status).toBe(201);
    isAuthed = true;

    const res = await fetch(`${base}/schedules/${body.job.id}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: [{ title: 'Nope', body: 'cannot add steps to a bot job' }],
      }),
    });
    expect(res.status).toBe(400);
    const err = await res.json() as { error: string; code?: string };
    expect(err.code).toBe('bare_prompt_unsupported');
    expect(err.error).toMatch(/plan steps/);
  });

  it('operator PUT /projects/.../steps on a grok-bot job → 400', async () => {
    const { res: createRes, body } = await createJobViaApi(grokResumeOverrides());
    expect(createRes.status).toBe(201);

    const res = await fetch(`${base}/projects/${projectId}/schedules/${body.job.id}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: [{ title: 'Nope', body: 'still blocked' }],
      }),
    });
    expect(res.status).toBe(400);
    const err = await res.json() as { error: string; code?: string };
    expect(err.code).toBe('bare_prompt_unsupported');
  });

  it('run token for job A cannot modify job B', async () => {
    const { body: a } = await createJobViaApi({ name: 'job A' });
    const { body: b } = await createJobViaApi({ name: 'job B' });
    const tokenA = issueRunToken({ jobId: a.job.id, runId: 'run-a', conversationId: 'c-a' });

    const res = await fetch(`${base}/schedules/${b.job.id}/steps`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ steps: [{ title: 'x', body: 'y' }] }),
    });
    expect(res.status).toBe(401);
    revokeRunToken(tokenA);
  });

  it('PUT with { enabled: false } → 403', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const token = issueRunToken({ jobId, runId: 'run-1', conversationId: 'c1' });

    const res = await fetch(`${base}/schedules/${jobId}/steps`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ enabled: false, steps: [{ title: 'x', body: 'y' }] }),
    });
    expect(res.status).toBe(403);
    const resBody = await res.json() as { error: string };
    expect(resBody.error).toMatch(/enabled/);
    revokeRunToken(token);
  });

  it('PUT with { workdir: "worktree" } → 403 (operator-owned)', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const token = issueRunToken({ jobId, runId: 'run-1', conversationId: 'c1' });

    const res = await fetch(`${base}/schedules/${jobId}/steps`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ workdir: 'worktree', steps: [{ title: 'x', body: 'y' }] }),
    });
    expect(res.status).toBe(403);
    const resBody = await res.json() as { error: string };
    expect(resBody.error).toMatch(/workdir/);
    revokeRunToken(token);
  });

  it('PUT with { scheduleExpr: "…" } → 403', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    isAuthed = true;

    const res = await fetch(`${base}/schedules/${jobId}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduleExpr: JSON.stringify({ everyMs: 1 }),
        steps: [{ title: 'x', body: 'y' }],
      }),
    });
    expect(res.status).toBe(403);
  });

  it('unauthenticated request → 401', async () => {
    const { body } = await createJobViaApi();
    const res = await fetch(`${base}/schedules/${body.job.id}/steps`);
    expect(res.status).toBe(401);
  });

  it('PATCH is an alias of PUT', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const token = issueRunToken({ jobId, runId: 'run-p', conversationId: 'c' });

    const res = await fetch(`${base}/schedules/${jobId}/steps`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ steps: [{ title: 'patched', body: 'b', status: 'done' }] }),
    });
    expect(res.status).toBe(200);
    expect(listSteps(getDb(), jobId)[0].title).toBe('patched');
    revokeRunToken(token);
  });

  it('spawn token for a conversation under the job home can GET steps', async () => {
    const { body } = await createJobViaApi();
    const job = getJob(getDb(), body.job.id)!;
    const child = createConversation(getDb(), {
      projectId,
      title: 'run child',
      parentConversationId: job.homeConversationId,
    });
    const spawnTok = issueSpawnToken(child.id, 'sess-spawn-1');

    const res = await fetch(`${base}/schedules/${job.id}/steps`, {
      headers: { Authorization: `Bearer ${spawnTok}` },
    });
    expect(res.status).toBe(200);
    revokeSpawnTokensForSession('sess-spawn-1');
  });

  it('spawn token for a conversation outside the job home is rejected on GET steps', async () => {
    const { body } = await createJobViaApi();
    const outsider = createConversation(getDb(), { projectId, title: 'unrelated' });
    const spawnTok = issueSpawnToken(outsider.id, 'sess-outsider');

    const res = await fetch(`${base}/schedules/${body.job.id}/steps`, {
      headers: { Authorization: `Bearer ${spawnTok}` },
    });
    expect(res.status).toBe(401);
    revokeSpawnTokensForSession('sess-outsider');
  });

  it('pause-request blocks running step, stamps agent_pause_request, does not disable job', async () => {
    const { body } = await createJobViaApi({
      steps: [{ title: 'S1', body: 'work' }],
    });
    const jobId = body.job.id as string;
    const step = listSteps(getDb(), jobId)[0];
    updateStepStatus(getDb(), step.id, 'running');
    const run = createRun(getDb(), {
      jobId, stepId: step.id, status: 'running', firedAt: Date.now(),
    });
    const token = issueRunToken({ jobId, runId: run.id, conversationId: 'c' });

    const res = await fetch(`${base}/schedules/${jobId}/pause-request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(202);
    expect(listSteps(getDb(), jobId)[0].status).toBe('blocked');
    expect(getRun(getDb(), run.id)!.error).toBe('agent_pause_request');
    expect(getRun(getDb(), run.id)!.status).toBe('running'); // not finalized
    expect(getJob(getDb(), jobId)!.enabled).toBe(true);
    revokeRunToken(token);
  });

  it('complete-job → 403 when agentMayComplete is false', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const token = issueRunToken({ jobId, runId: 'r', conversationId: 'c' });

    const res = await fetch(`${base}/schedules/${jobId}/complete-job`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(getJob(getDb(), jobId)!.enabled).toBe(true);
    revokeRunToken(token);
  });

  it('complete-job disables job when agentMayComplete is true', async () => {
    const { body } = await createJobViaApi({ agentMayComplete: true });
    const jobId = body.job.id as string;
    const token = issueRunToken({ jobId, runId: 'r', conversationId: 'c' });

    const res = await fetch(`${base}/schedules/${jobId}/complete-job`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(getJob(getDb(), jobId)!.enabled).toBe(false);
    revokeRunToken(token);
  });
});

// ── Task 17: pending_context ────────────────────────────────────────────────

describe('PUT pending-context', () => {
  it('operator cookie can set text and enable carry in one request', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;

    const res = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/pending-context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'remember to merge PR #12',
        carryContextEnabled: true,
      }),
    });
    expect(res.status).toBe(200);
    const resBody = await res.json() as {
      job: { pendingContext?: string; carryContextEnabled: boolean; pendingContextSource?: string };
    };
    expect(resBody.job.carryContextEnabled).toBe(true);
    expect(resBody.job.pendingContext).toBe('remember to merge PR #12');
    expect(resBody.job.pendingContextSource).toBe('operator');
    expect(getJob(getDb(), jobId)!.pendingContext).toBe('remember to merge PR #12');
  });

  it('operator can clear pending context with null text', async () => {
    const { body } = await createJobViaApi({ carryContextEnabled: true });
    const jobId = body.job.id as string;
    setPendingContext(getDb(), jobId, { text: 'to clear', source: 'operator' });

    const res = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/pending-context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: null }),
    });
    expect(res.status).toBe(200);
    expect(getJob(getDb(), jobId)!.pendingContext).toBeUndefined();
  });

  it('bearer cannot set context when carry disabled', async () => {
    const { body } = await createJobViaApi({ carryContextEnabled: false });
    const jobId = body.job.id as string;
    const token = issueRunToken({ jobId, runId: 'run-1', conversationId: 'c1' });

    const res = await fetch(`${base}/schedules/${jobId}/pending-context`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: 'should fail' }),
    });
    expect(res.status).toBe(403);
    const resBody = await res.json() as { error: string };
    expect(resBody.error).toMatch(/carry_context_enabled/i);
    expect(getJob(getDb(), jobId)!.pendingContext).toBeUndefined();
    revokeRunToken(token);
  });

  it('bearer can set context when carry enabled; cannot toggle flag', async () => {
    const { body } = await createJobViaApi({ carryContextEnabled: true });
    const jobId = body.job.id as string;
    const token = issueRunToken({ jobId, runId: 'run-1', conversationId: 'c1' });

    const ok = await fetch(`${base}/schedules/${jobId}/pending-context`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: 'from run' }),
    });
    expect(ok.status).toBe(200);
    expect(getJob(getDb(), jobId)!.pendingContext).toBe('from run');
    expect(getJob(getDb(), jobId)!.pendingContextSource).toBe('run');

    const forbidden = await fetch(`${base}/schedules/${jobId}/pending-context`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: 'x', carryContextEnabled: false }),
    });
    expect(forbidden.status).toBe(403);
    expect(getJob(getDb(), jobId)!.carryContextEnabled).toBe(true);
    revokeRunToken(token);
  });

  it('rejects oversize context', async () => {
    const { body } = await createJobViaApi({ carryContextEnabled: true });
    const jobId = body.job.id as string;
    const oversize = 'x'.repeat(PENDING_CONTEXT_MAX_BYTES + 1);

    const res = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/pending-context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: oversize }),
    });
    expect(res.status).toBe(400);
    const resBody = await res.json() as { error: string };
    expect(resBody.error).toBe('pending_context_too_large');
  });
});

describe('no_step_update on finalize without step write', () => {
  it('after dispatch finalize without step write → step ready (not blocked), run.error no_step_update', async () => {
    const db = getDb();
    const home = createConversation(db, {
      projectId, title: 'home', kind: 'schedule_home',
    });
    const job = createJob(db, {
      projectId,
      name: 'tick',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
      profileId: 'claude-code:opus-4.8',
      homeConversationId: home.id,
      promptTemplate: 'work',
      nextFireAt: Date.now() - 1,
      steps: [{ title: 'only', body: 'do it' }],
    });

    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: vi.fn(async () => {}),
      now: () => Date.now(),
    });
    await scheduler.tickOnce();

    const step = listSteps(db, job.id)[0];
    const run = getDb().prepare('SELECT id FROM schedule_runs WHERE job_id = ?')
      .get(job.id) as { id: string };
    expect(step.status).toBe('running');

    // Agent never wrote steps → stepUpdated false → ready for retry, not permanent blocked.
    scheduler.finalizeRun(run.id, { status: 'failed', stepUpdated: false });

    expect(listSteps(db, job.id)[0].status).toBe('ready');
    expect(getRun(db, run.id)!.error).toBe('no_step_update');
  });
});

describe('PATCH /schedules/:jobId/steps/:stepId', () => {
  it('marks step done and auto-promotes dependent pending → ready', async () => {
    const { body } = await createJobViaApi({
      steps: [
        { title: 'A', body: 'first' },
        { title: 'B', body: 'second', dependsOnOrdinal: 0 },
      ],
    });
    const jobId = body.job.id as string;
    const steps = listSteps(getDb(), jobId);
    expect(steps[0].status).toBe('ready');
    expect(steps[1].status).toBe('pending');

    isAuthed = true;
    const res = await fetch(`${base}/schedules/${jobId}/steps/${steps[0].id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(res.status).toBe(200);
    const resBody = await res.json() as {
      step: { id: string; status: string };
      promoted?: Array<{ id: string; status: string }>;
    };
    expect(resBody.step.status).toBe('done');
    expect(resBody.promoted).toHaveLength(1);
    expect(resBody.promoted![0].id).toBe(steps[1].id);
    expect(resBody.promoted![0].status).toBe('ready');
    expect(listSteps(getDb(), jobId)[1].status).toBe('ready');
    // Ids stable — no remint
    expect(listSteps(getDb(), jobId)[0].id).toBe(steps[0].id);
  });

  it('run token can PATCH; 404 for foreign step id', async () => {
    const { body } = await createJobViaApi({
      steps: [{ title: 'only', body: 'x' }],
    });
    const jobId = body.job.id as string;
    const step = listSteps(getDb(), jobId)[0];
    const token = issueRunToken({ jobId, runId: 'run-p', conversationId: 'c' });

    const ok = await fetch(`${base}/schedules/${jobId}/steps/${step.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'done', body: 'finished offline' }),
    });
    expect(ok.status).toBe(200);

    const miss = await fetch(`${base}/schedules/${jobId}/steps/not-a-real-id`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(miss.status).toBe(404);
    revokeRunToken(token);
  });

  it('POST retry turns blocked → ready', async () => {
    const { body } = await createJobViaApi({
      steps: [{ title: 'S', body: 'work' }],
    });
    const jobId = body.job.id as string;
    const step = listSteps(getDb(), jobId)[0];
    updateStepStatus(getDb(), step.id, 'blocked');

    isAuthed = true;
    const res = await fetch(`${base}/schedules/${jobId}/steps/${step.id}/retry`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(listSteps(getDb(), jobId)[0].status).toBe('ready');
  });

  it('POST complete-all marks every step done', async () => {
    const { body } = await createJobViaApi({
      steps: [
        { title: 'A', body: 'a' },
        { title: 'B', body: 'b', dependsOnOrdinal: 0 },
      ],
    });
    const jobId = body.job.id as string;
    isAuthed = true;
    const res = await fetch(`${base}/schedules/${jobId}/steps/complete-all`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const steps = listSteps(getDb(), jobId);
    expect(steps.every((s) => s.status === 'done')).toBe(true);
  });
});

// ── Operator skip / unskip (this | through) ──────────────────────────────────

describe('POST /projects/:projectId/schedules/:jobId/skip', () => {
  it('interval nextFireAt stays on the createdAt grid (no 1ms create drift)', async () => {
    const everyMs = 3_600_000;
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs }),
    });
    const job = getJob(getDb(), body.job.id as string)!;
    expect(job.nextFireAt).toBe(job.createdAt + everyMs);

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${job.id}/upcoming?count=2`);
    const { fires } = await upcomingRes.json() as { fires: number[] };
    expect(fires[0]).toBe(job.nextFireAt);
    expect(fires[1]).toBe(job.nextFireAt + everyMs);
  });

  it('upcoming first fire is the stored clock even if createdAt grid drifted 1ms', async () => {
    const everyMs = 3_600_000;
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs }),
    });
    const jobId = body.job.id as string;
    const job = getJob(getDb(), jobId)!;
    // Reproduce the pre-fix createJob Date.now() tick: clock 1ms off the createdAt grid.
    const drifted = job.createdAt + everyMs - 1;
    setNextFireAt(getDb(), jobId, drifted);

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=2`);
    const { fires } = await upcomingRes.json() as { fires: number[] };
    expect(fires[0]).toBe(drifted);

    const skipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[0] }),
    });
    expect(skipRes.status).toBe(200);
    const skipBody = await skipRes.json() as { job: { nextFireAt: number } };
    expect(skipBody.job.nextFireAt).not.toBe(drifted);
  });

  it('mode this (default) on first fire: next moves to second; job stays enabled', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;
    const created = getJob(getDb(), jobId)!;
    expect(created.nextFireAt).toBe(created.createdAt + 3_600_000);

    const upcomingBefore = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires: before, skipped: skippedBefore } = await upcomingBefore.json() as {
      fires: number[]; skipped: number[];
    };
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(skippedBefore).toEqual([]);
    const first = before[0]!;
    const second = before[1]!;
    expect(first).toBe(created.nextFireAt);
    expect(second).toBe(first + 3_600_000);

    const skipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: first }), // default mode this
    });
    expect(skipRes.status).toBe(200);
    const skipBody = await skipRes.json() as { job: { nextFireAt: number; enabled: boolean } };
    expect(skipBody.job.enabled).toBe(true);
    expect(skipBody.job.nextFireAt).toBe(second);

    const upcomingAfter = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires: after, skipped } = await upcomingAfter.json() as {
      fires: number[]; skipped: number[];
    };
    expect(after[0]).toBe(second);
    expect(after).not.toContain(first);
    expect(skipped).toEqual([first]);
    expect(broadcasts.some((b) => b.jobId === jobId)).toBe(true);
  });

  it('mode this on 3rd fire: hole only — clock stays on 1st; 2nd still active', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires } = await upcomingRes.json() as { fires: number[] };
    expect(fires.length).toBeGreaterThanOrEqual(4);
    const first = fires[0]!;
    const second = fires[1]!;
    const third = fires[2]!;
    const fourth = fires[3]!;

    const skipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: third, mode: 'this' }),
    });
    expect(skipRes.status).toBe(200);
    const skipBody = await skipRes.json() as { job: { nextFireAt: number; enabled: boolean } };
    expect(skipBody.job.enabled).toBe(true);
    expect(skipBody.job.nextFireAt).toBe(first);

    const afterRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires: after, skipped } = await afterRes.json() as {
      fires: number[]; skipped: number[];
    };
    expect(after[0]).toBe(first);
    expect(after).toContain(second);
    expect(after).toContain(fourth);
    expect(after).not.toContain(third);
    expect(skipped).toEqual([third]);
  });

  it('mode through on 3rd advances clock past 1st–3rd and records all three', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires } = await upcomingRes.json() as { fires: number[] };
    expect(fires.length).toBeGreaterThanOrEqual(4);
    const third = fires[2]!;
    const fourth = fires[3]!;

    const skipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: third, mode: 'through' }),
    });
    expect(skipRes.status).toBe(200);
    const skipBody = await skipRes.json() as { job: { nextFireAt: number; enabled: boolean } };
    expect(skipBody.job.enabled).toBe(true);
    expect(skipBody.job.nextFireAt).toBe(fourth);

    const afterRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires: after, skipped } = await afterRes.json() as {
      fires: number[]; skipped: number[];
    };
    expect(after[0]).toBe(fourth);
    expect(after).not.toContain(fires[0]);
    expect(after).not.toContain(fires[1]);
    expect(after).not.toContain(third);
    expect(skipped).toEqual([fires[0], fires[1], third]);
  });

  it('once job skip exhausts and disables but keeps skip restorable', async () => {
    const { ONCE_EXHAUSTED_MS } = await import('../schedules/nextFire.js');
    const atMs = Date.now() + 3_600_000;
    const { body } = await createJobViaApi({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
    });
    const jobId = body.job.id as string;
    expect(getJob(getDb(), jobId)!.enabled).toBe(true);

    const skipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: atMs, mode: 'this' }),
    });
    expect(skipRes.status).toBe(200);
    const skipBody = await skipRes.json() as { job: { nextFireAt: number; enabled: boolean } };
    expect(skipBody.job.enabled).toBe(false);
    expect(skipBody.job.nextFireAt).toBe(ONCE_EXHAUSTED_MS);

    const afterRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires, skipped } = await afterRes.json() as { fires: number[]; skipped: number[] };
    expect(fires).toEqual([]);
    expect(skipped).toEqual([atMs]);
  });

  it('400s on bad body, bad mode, and fireAtMs before nextFireAt', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    const job = getJob(getDb(), jobId)!;

    const missing = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const badMode = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: job.nextFireAt, mode: 'nope' }),
    });
    expect(badMode.status).toBe(400);

    const before = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: job.nextFireAt - 1 }),
    });
    expect(before.status).toBe(400);

    const random = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: job.nextFireAt + 1234 }),
    });
    expect(random.status).toBe(400);
  });

  it('allows skip while job is disabled', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;
    const created = getJob(getDb(), jobId)!;
    expect(created.nextFireAt).toBe(created.createdAt + 3_600_000);
    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/disable`, { method: 'POST' });

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=3`);
    const { fires } = await upcomingRes.json() as { fires: number[] };
    expect(fires.length).toBeGreaterThanOrEqual(2);
    expect(fires[0]).toBe(created.nextFireAt);
    expect(fires[1]).toBe(created.nextFireAt + 3_600_000);

    const skipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[0], mode: 'this' }),
    });
    expect(skipRes.status).toBe(200);
    const skipBody = await skipRes.json() as { job: { nextFireAt: number; enabled: boolean } };
    expect(skipBody.job.enabled).toBe(false);
    expect(skipBody.job.nextFireAt).toBe(fires[1]);
  });

  it('does not consume pending_context on operator skip', async () => {
    const { body } = await createJobViaApi();
    const jobId = body.job.id as string;
    setPendingContext(getDb(), jobId, { text: 'keep me', source: 'operator' });

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=2`);
    const { fires } = await upcomingRes.json() as { fires: number[] };

    const skipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[0] }),
    });
    expect(skipRes.status).toBe(200);
    expect(getJob(getDb(), jobId)!.pendingContext).toBe('keep me');
  });
});

describe('POST /projects/:projectId/schedules/:jobId/unskip', () => {
  it('restores nextFireAt to a skipped fire and clears that hole only', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires } = await upcomingRes.json() as { fires: number[] };
    const first = fires[0]!;
    const second = fires[1]!;

    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: first, mode: 'this' }),
    });

    const unskipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/unskip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: first }),
    });
    expect(unskipRes.status).toBe(200);
    const unskipBody = await unskipRes.json() as { job: { nextFireAt: number; enabled: boolean } };
    expect(unskipBody.job.enabled).toBe(true);
    expect(unskipBody.job.nextFireAt).toBe(first);

    const after = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires: afterFires, skipped } = await after.json() as {
      fires: number[]; skipped: number[];
    };
    expect(afterFires[0]).toBe(first);
    expect(afterFires).toContain(second);
    expect(skipped).toEqual([]);

    // Unskip hard-deletes the hole row (no operator_unskip relabel).
    const runs = listRunsForJob(getDb(), jobId);
    expect(runs.every((r) => r.error !== 'operator_skip')).toBe(true);
    expect(runs.every((r) => r.error !== 'operator_unskip')).toBe(true);
    expect(runs.some((r) => r.firedAt === first && r.status === 'skipped')).toBe(false);
  });

  it('unskip one slot after through leaves other holes; pulls next back', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires } = await upcomingRes.json() as { fires: number[] };
    const third = fires[2]!;

    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: third, mode: 'through' }),
    });

    const unskipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/unskip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[0] }),
    });
    expect(unskipRes.status).toBe(200);
    const unskipBody = await unskipRes.json() as { job: { nextFireAt: number } };
    expect(unskipBody.job.nextFireAt).toBe(fires[0]);

    const after = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires: afterFires, skipped } = await after.json() as {
      fires: number[]; skipped: number[];
    };
    expect(afterFires[0]).toBe(fires[0]);
    // 2nd and 3rd remain holes until unskipped
    expect(afterFires).not.toContain(fires[1]);
    expect(afterFires).not.toContain(third);
    expect(skipped).toEqual([fires[1], third]);
  });

  it('unskip middle through-hole pulls next to that middle; earlier hole stays', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires } = await upcomingRes.json() as { fires: number[] };

    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[2], mode: 'through' }),
    });

    const unskipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/unskip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[1] }),
    });
    expect(unskipRes.status).toBe(200);
    const unskipBody = await unskipRes.json() as { job: { nextFireAt: number } };
    expect(unskipBody.job.nextFireAt).toBe(fires[1]);

    const after = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires: afterFires, skipped } = await after.json() as {
      fires: number[]; skipped: number[];
    };
    expect(afterFires[0]).toBe(fires[1]);
    expect(skipped).toEqual([fires[0], fires[2]]);
  });

  it('unskip future hole (mode this) does not move next', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires } = await upcomingRes.json() as { fires: number[] };

    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[2], mode: 'this' }),
    });
    expect(getJob(getDb(), jobId)!.nextFireAt).toBe(fires[0]);

    const unskipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/unskip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[2] }),
    });
    expect(unskipRes.status).toBe(200);
    expect(getJob(getDb(), jobId)!.nextFireAt).toBe(fires[0]);

    const after = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires: afterFires, skipped } = await after.json() as {
      fires: number[]; skipped: number[];
    };
    expect(afterFires[0]).toBe(fires[0]);
    expect(afterFires).toContain(fires[2]);
    expect(skipped).toEqual([]);
  });

  it('once unskip re-enables and restores the fire', async () => {
    const atMs = Date.now() + 3_600_000;
    const { body } = await createJobViaApi({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
    });
    const jobId = body.job.id as string;

    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: atMs }),
    });
    expect(getJob(getDb(), jobId)!.enabled).toBe(false);

    const unskipRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/unskip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: atMs }),
    });
    expect(unskipRes.status).toBe(200);
    const unskipBody = await unskipRes.json() as { job: { nextFireAt: number; enabled: boolean } };
    expect(unskipBody.job.enabled).toBe(true);
    expect(unskipBody.job.nextFireAt).toBe(atMs);

    const after = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=5`);
    const { fires, skipped } = await after.json() as { fires: number[]; skipped: number[] };
    expect(fires).toEqual([atMs]);
    expect(skipped).toEqual([]);
  });

  it('400s when fireAtMs is not a restorable skip', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;
    const job = getJob(getDb(), jobId)!;

    const missing = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/unskip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const noSkip = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/unskip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: job.nextFireAt }),
    });
    expect(noSkip.status).toBe(400);
  });

  it('does not consume pending_context on unskip', async () => {
    const { body } = await createJobViaApi({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    const jobId = body.job.id as string;
    setPendingContext(getDb(), jobId, { text: 'keep me', source: 'operator' });

    const upcomingRes = await fetch(`${base}/projects/${projectId}/schedules/${jobId}/upcoming?count=2`);
    const { fires } = await upcomingRes.json() as { fires: number[] };

    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[0] }),
    });
    await fetch(`${base}/projects/${projectId}/schedules/${jobId}/unskip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: fires[0] }),
    });
    expect(getJob(getDb(), jobId)!.pendingContext).toBe('keep me');
  });
});

describe('decideAgentEnabled (D3 truth table)', () => {
  it('evaluates all 8 combinations of scheduleKind, recurringConsent, and spawnApproval', () => {
    // once: enabled by default when spawnApprovalRequired is false
    expect(decideAgentEnabled({
      scheduleKind: 'once',
      general: { allowAgentRecurringSchedules: false },
      spawnApprovalRequired: false,
    })).toBe(true);

    expect(decideAgentEnabled({
      scheduleKind: 'once',
      general: { allowAgentRecurringSchedules: true },
      spawnApprovalRequired: false,
    })).toBe(true);

    // once: disabled if spawnApprovalRequired is true
    expect(decideAgentEnabled({
      scheduleKind: 'once',
      general: { allowAgentRecurringSchedules: false },
      spawnApprovalRequired: true,
    })).toBe(false);

    expect(decideAgentEnabled({
      scheduleKind: 'once',
      general: { allowAgentRecurringSchedules: true },
      spawnApprovalRequired: true,
    })).toBe(false);

    // interval: disabled if allowAgentRecurringSchedules is false
    expect(decideAgentEnabled({
      scheduleKind: 'interval',
      general: { allowAgentRecurringSchedules: false },
      spawnApprovalRequired: false,
    })).toBe(false);

    // interval: enabled only when allowAgentRecurringSchedules is true AND spawnApprovalRequired is false
    expect(decideAgentEnabled({
      scheduleKind: 'interval',
      general: { allowAgentRecurringSchedules: true },
      spawnApprovalRequired: false,
    })).toBe(true);

    // interval: disabled if spawnApprovalRequired is true even when allowAgentRecurringSchedules is true
    expect(decideAgentEnabled({
      scheduleKind: 'interval',
      general: { allowAgentRecurringSchedules: false },
      spawnApprovalRequired: true,
    })).toBe(false);

    expect(decideAgentEnabled({
      scheduleKind: 'interval',
      general: { allowAgentRecurringSchedules: true },
      spawnApprovalRequired: true,
    })).toBe(false);
  });
});

describe('decideAgentEnabled master gate (allowAgentAutoScheduling)', () => {
  it('forces every kind disabled when the gate is off, even with recurring consent', () => {
    for (const scheduleKind of ['once', 'interval'] as const) {
      expect(decideAgentEnabled({
        scheduleKind,
        general: { allowAgentAutoScheduling: false, allowAgentRecurringSchedules: true },
        spawnApprovalRequired: false,
      })).toBe(false);
    }
    expect(decideAgentEnabled({
      scheduleKind: 'once',
      general: { allowAgentAutoScheduling: true, allowAgentRecurringSchedules: false },
      spawnApprovalRequired: false,
    })).toBe(true);
  });
});

describe('POST /settings/general auth boundary', () => {
  it('rejects agent bearer token and unauthenticated request with 401', async () => {
    const authApp = express();
    authApp.use(express.json());
    authApp.use(requireAuth({
      configured: true,
      disabled: false,
      sessionSecret: 'secret-12345678901234567890123456789012',
    }));
    registerGeneralSettingsRoutes(authApp, getDb);

    const s = authApp.listen(0);
    const { port } = s.address() as { port: number };
    const authBase = `http://127.0.0.1:${port}`;

    try {
      // 1. Without cookie or bearer token
      const noAuth = await fetch(`${authBase}/settings/general`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowAgentRecurringSchedules: true }),
      });
      expect(noAuth.status).toBe(401);

      // 2. With agent bearer token (agent trying to escalate to allow recurring schedules)
      const bearerAuth = await fetch(`${authBase}/settings/general`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer fake-agent-token',
        },
        body: JSON.stringify({ allowAgentRecurringSchedules: true }),
      });
      expect(bearerAuth.status).toBe(401);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

// P2c: schedule hard-delete must unlink native sessions through the remote
// factory when the conversation tree belongs to a remote-host project.
describe('schedule delete: remote native-session unlink', () => {
  it('routes the unlink through the remote factory, not the hub-local one', async () => {
    const db = getDb();
    const remoteCalls: { type: string; host: string }[] = [];
    const deleted: string[] = [];
    registry.register('remote-file-agent', () => ({
      deleteNativeSession: async () => { throw new Error('local factory must not run'); },
    } as never));
    registry.setRemoteFactory((type, opts) => {
      remoteCalls.push({ type, host: opts.remoteHostId });
      return {
        deleteNativeSession: async (nativeSessionId: string) => { deleted.push(nativeSessionId); },
      } as never;
    });

    const host = createPendingHost(db, 'box', 'h-remote', Date.now() + 60_000);
    remoteHostView = () => ({
      id: host.id,
      name: 'box',
      state: 'connected',
      hello: {
        agents: { 'claude-code': { installed: true, methods: [] } },
        models: { 'claude-code': ['claude-opus-4-8'] },
      },
      allowMcpSecrets: true,
      createdAt: Date.now(),
    });
    // Remount so routes pick up remoteHostView.
    await new Promise<void>((r) => server.close(() => r()));
    const app = mountApp();
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    const addr = server.address();
    base = `http://127.0.0.1:${(addr as { port: number }).port}`;

    const remoteProject = createProject(db, { name: 'remote', rootPath: '/tmp/r', remoteHostId: host.id });
    const { res: created, body } = await fetch(`${base}/projects/${remoteProject.id}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody()),
    }).then(async (r) => ({ res: r, body: await r.json() as { job: { id: string; homeConversationId: string } } }));
    expect(created.status).toBe(201);

    db.prepare(
      `INSERT INTO agents (id, type, label, description, env_vars, created_at) VALUES (?,?,?,?,?,?)`,
    ).run('remote-file-agent', 'remote-file-agent', 'remote-file-agent', '', '{}', Date.now());
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s-remote', body.job.homeConversationId, 'remote-file-agent', 'native-remote-1', Date.now(), Date.now());

    const res = await fetch(`${base}/projects/${remoteProject.id}/schedules/${body.job.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(remoteCalls).toEqual([{ type: 'remote-file-agent', host: host.id }]);
    expect(deleted).toEqual(['native-remote-1']);
  });
});

describe('operator create: remote host availability (Task 11)', () => {
  it('remote project + uninstalled agent → 400 reason agent_not_installed', async () => {
    const db = getDb();
    const host = createPendingHost(db, 'box', 'h-avail', Date.now() + 60_000);
    remoteHostView = () => ({
      id: host.id,
      name: 'box',
      state: 'connected',
      hello: {
        agents: { 'claude-code': { installed: false, methods: [] } },
        models: {},
      },
      allowMcpSecrets: true,
      createdAt: Date.now(),
    });
    await new Promise<void>((r) => server.close(() => r()));
    const app = mountApp();
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const remoteProject = createProject(db, { name: 'remote', rootPath: '/tmp/r2', remoteHostId: host.id });
    const res = await fetch(`${base}/projects/${remoteProject.id}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody()),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; reason?: string };
    expect(body).toMatchObject({ error: 'not available on host', reason: 'agent_not_installed' });
  });
});

describe('step replace: disconnected remote host (fix round 1)', () => {
  it('operator + agent PUT steps succeed while the host is offline', async () => {
    const db = getDb();
    const host = createPendingHost(db, 'box', 'h-steps', Date.now() + 60_000);
    let hostState: 'connected' | 'disconnected' = 'connected';
    remoteHostView = () => ({
      id: host.id,
      name: 'box',
      state: hostState,
      hello: {
        agents: { 'claude-code': { installed: true, methods: [] } },
        // Same model id shape as the remote native-session unlink fixture.
        models: { 'claude-code': ['claude-opus-4-8'] },
      },
      allowMcpSecrets: true,
      createdAt: Date.now(),
    });
    await new Promise<void>((r) => server.close(() => r()));
    const app = mountApp();
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const remoteProject = createProject(db, { name: 'remote-steps', rootPath: '/tmp/r-steps', remoteHostId: host.id });
    const createRes = await fetch(`${base}/projects/${remoteProject.id}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody({ name: 'remote plan' })),
    });
    expect(createRes.status).toBe(201);
    const { job } = await createRes.json() as { job: { id: string } };

    hostState = 'disconnected';

    const opRes = await fetch(`${base}/projects/${remoteProject.id}/schedules/${job.id}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: [{ title: 'Offline edit', body: 'plan while host sleeps' }],
      }),
    });
    expect(opRes.status).toBe(200);
    const opBody = await opRes.json() as { steps: Array<{ title: string }> };
    expect(opBody.steps[0]?.title).toBe('Offline edit');

    isAuthed = true;
    const agentRes = await fetch(`${base}/schedules/${job.id}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        steps: [{ title: 'Agent offline edit', body: 'still ok' }],
      }),
    });
    expect(agentRes.status).toBe(200);
    const agentBody = await agentRes.json() as { steps: Array<{ title: string }> };
    expect(agentBody.steps[0]?.title).toBe('Agent offline edit');
  });
});
