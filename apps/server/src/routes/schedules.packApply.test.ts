import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SchedulePack } from '@tierwyn/shared';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedCommands, seedDefaultSettings, seedSchedulePacks } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import {
  getJob, listJobsForProject, listSteps, PENDING_CONTEXT_MAX_BYTES,
  createJob, countAgentJobsForConversation,
} from '../repositories/schedules.js';
import { updateModel } from '../repositories/models.js';
import { saveTemplate, updateGeneralSettings } from '../repositories/settings.js';
import { upsertImportedPack } from '../repositories/schedulePacks.js';
import { createPendingHost, saveHello } from '../repositories/remoteHosts.js';
import { issueSpawnToken, revokeSpawnTokensForSession } from '../spawn/tokens.js';
import { issueRunToken, revokeRunToken } from '../schedules/runTokens.js';
import {
  registerScheduleRoutes, registerScheduleAgentRoutes, type JobSchedulerLike,
} from './schedules.js';

let server: Server;
let base: string;
let projectId: string;
let projectRoot: string;
let profileId: string;
let tmpDirs: string[] = [];
let nodeHub: { link: (id: string) => { request: ReturnType<typeof vi.fn> } } | undefined;
let remoteHostView: ((id: string) => import('@tierwyn/shared').RemoteHostView | undefined) | undefined;

function mountApp() {
  const runNow = vi.fn(async (jobId: string) => ({ ok: true as const, runId: `run-for-${jobId}` }));
  const stubScheduler: JobSchedulerLike = { runNow };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const broadcast = () => {};
  registerScheduleAgentRoutes(app, {
    getDb, isAuthed: () => false, broadcast, nodeHub, remoteHostView,
  });
  registerScheduleRoutes(app, {
    getDb, jobScheduler: stubScheduler, broadcast, nodeHub, remoteHostView,
  });
  return app;
}

beforeEach(async () => {
  nodeHub = undefined;
  remoteHostView = undefined;
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db);
  seedCommands(db);
  seedDefaultSettings(db);
  seedSchedulePacks(db);
  setDb(db);
  catalogue.load(db);
  profileId = catalogue.listProfiles().find((p) => p.enabled)!.id;
  updateModel(db, profileId, { maxConcurrentSpawns: 3 });
  catalogue.load(db);
  saveTemplate(db, { name: 'team', roles: [{ role: 'Implementer', profileId }] });

  projectRoot = mkdtempSync(join(tmpdir(), 'tierwyn-pack-apply-'));
  tmpDirs.push(projectRoot);
  projectId = createProject(db, { name: 'p', rootPath: projectRoot }).id;

  const app = mountApp();
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function apply(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/projects/${projectId}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'My job',
      timezone: 'UTC',
      profileId,
      packSlug: 'verify-after-change',
      ...overrides,
    }),
  });
  const body = await res.json() as {
    job?: {
      id: string;
      name: string;
      promptTemplate: string;
      scheduleKind: string;
      scheduleExpr: string;
      enabled: boolean;
      carryContextEnabled: boolean;
      pendingContext?: string;
      pendingContextSource?: string;
      agentMayComplete: boolean;
      workdir: string;
      steps: Array<{ title: string; body: string }>;
    };
    packFiles?: string[];
    error?: string;
    conflicts?: string[];
    warnings?: string[];
  };
  return { res, body };
}

describe('POST /projects/:id/schedules pack apply', () => {
  it('merges pack defaults onto the created row (not a 201 no-op)', async () => {
    const { res, body } = await apply({ goal: 'Ship tags' });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.name).toBe('[verify-after-change] My job');
    // The pack's own policy prose landed, not the request's (absent) promptTemplate.
    // The goal itself rides in the step body + pendingContext for this pack, asserted below;
    // [[goal]] substitution into a promptTemplate is covered by the client-override case.
    expect(job.promptTemplate).toContain('delayed verification tick');
    expect(job.promptTemplate).not.toMatch(/\[\[\w+\]\]/);
    expect(job.scheduleKind).toBe('once');
    const expr = JSON.parse(job.scheduleExpr) as { atMs: number };
    expect(expr.atMs).toBeGreaterThan(Date.now());
    expect(job.carryContextEnabled).toBe(true);
    expect(job.pendingContext).toBe('Ship tags');
    expect(job.pendingContextSource).toBe('operator');
    expect(job.agentMayComplete).toBe(true);
    expect(job.workdir).toBe('shared');
    const steps = listSteps(getDb(), job.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.title).toBe('Verify');
    expect(steps[0]!.body).toContain('Ship tags');
    expect(steps[0]!.body).not.toContain('[[goal]]');
  });

  it('lets client overrides win, treating false/0/empty-string as defined', async () => {
    const { res, body } = await apply({
      promptTemplate: 'custom [[goal]]',
      agentMayComplete: false,
      goal: 'G',
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.promptTemplate).toBe('custom G');
    expect(job.agentMayComplete).toBe(false);

    const empty = await apply({ name: 'empty prompt', promptTemplate: '' });
    expect(empty.res.status).toBe(400);
    expect(empty.body.error).toMatch(/promptTemplate/);
  });

  it('creates an interval pack disabled', async () => {
    const { res, body } = await apply({
      packSlug: 'phased-feature',
      templateName: 'team',
      name: 'Epic',
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.scheduleKind).toBe('interval');
    expect(job.enabled).toBe(false);
    expect(JSON.parse(job.scheduleExpr)).toEqual({ everyMs: 86_400_000 });
    expect(job.name).toBe('[phased-feature] Epic');
    expect(listSteps(getDb(), job.id)).toHaveLength(5);
  });

  it('creates a once pack as a real once job', async () => {
    const before = Date.now();
    const { res, body } = await apply();
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.scheduleKind).toBe('once');
    const { atMs } = JSON.parse(job.scheduleExpr) as { atMs: number };
    expect(atMs).toBeGreaterThan(before);
    expect(job.nextFireAt).toBe(atMs);
  });

  it('400 when requiresTemplate and no template is selected', async () => {
    const { res, body } = await apply({ packSlug: 'single-pr-feature' });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/template/i);
  });

  it('400 when maxConcurrentSpawns is undefined, naming Settings → Agents', async () => {
    const db = getDb();
    updateModel(db, profileId, { maxConcurrentSpawns: null as unknown as number });
    db.prepare('UPDATE agent_models SET max_concurrent_spawns = NULL WHERE id = ?').run(profileId);
    catalogue.load(db);
    const { res, body } = await apply({ packSlug: 'single-pr-feature', templateName: 'team' });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Settings → Agents/);
    expect(body.error).toContain(profileId);
    expect(body.error).toMatch(/maxConcurrentSpawns/);
  });

  it('stores goal as pendingContext and sets carryContextEnabled', async () => {
    const { res, body } = await apply({ goal: '  check the diff  ' });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.pendingContext).toBe('check the diff');
    expect(job.carryContextEnabled).toBe(true);
  });

  it('400 on oversize goal', async () => {
    const { res, body } = await apply({ goal: 'x'.repeat(PENDING_CONTEXT_MAX_BYTES + 1) });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/pending_context_too_large|too_large/);
    expect(listJobsForProject(getDb(), projectId)).toHaveLength(0);
  });

  it('prefixes the job name once, even when already prefixed', async () => {
    const first = await apply({ name: 'Foo' });
    expect(first.body.job!.name).toBe('[verify-after-change] Foo');
    const second = await apply({ name: '[verify-after-change] Foo' });
    expect(second.res.status).toBe(201);
    expect(second.body.job!.name).toBe('[verify-after-change] Foo');
    expect(second.body.job!.name).not.toMatch(/\[verify-after-change\] \[verify-after-change\]/);
  });

  it('writes pack files and 409s on conflict without creating a job', async () => {
    const first = await apply({ packSlug: 'phased-feature', templateName: 'team', name: 'Epic' });
    expect(first.res.status).toBe(201);
    expect(first.body.packFiles).toEqual(expect.arrayContaining([
      '.tierwyn/schedule/epic-prompt.md',
      '.tierwyn/schedule/epic-progress.md',
      '.tierwyn/schedule/epic-README.md',
    ]));
    expect(existsSync(join(projectRoot, '.tierwyn/schedule/epic-prompt.md'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.tierwyn/schedule/epic-prompt.md'), 'utf8')).not.toContain('[[goal]]');

    const second = await apply({ packSlug: 'phased-feature', templateName: 'team', name: 'Epic' });
    expect(second.res.status).toBe(409);
    expect(second.body.conflicts?.length).toBeGreaterThan(0);
    expect(listJobsForProject(getDb(), projectId)).toHaveLength(1);
    const homes = getDb().prepare(
      "SELECT COUNT(*) AS c FROM conversations WHERE kind = 'schedule_home'",
    ).get() as { c: number };
    expect(homes.c).toBe(1);
  });

  it('overwritePackFiles: true overwrites conflicting files and creates a job', async () => {
    const first = await apply({ packSlug: 'phased-feature', templateName: 'team', name: 'Epic' });
    expect(first.res.status).toBe(201);
    writeFileSync(join(projectRoot, '.tierwyn/schedule/epic-progress.md'), 'pre-existing');

    const second = await apply({ packSlug: 'phased-feature', templateName: 'team', name: 'Epic' });
    expect(second.res.status).toBe(409);

    const third = await apply({
      packSlug: 'phased-feature', templateName: 'team', name: 'Epic', overwritePackFiles: true,
    });
    expect(third.res.status).toBe(201);
    const progress = readFileSync(join(projectRoot, '.tierwyn/schedule/epic-progress.md'), 'utf8');
    expect(progress).not.toBe('pre-existing');
    expect(progress).not.toContain('[[');
    expect(listJobsForProject(getDb(), projectId)).toHaveLength(2);
  });

  it('overwritePackFiles string "true" still 409s', async () => {
    const first = await apply({ packSlug: 'phased-feature', templateName: 'team', name: 'Epic' });
    expect(first.res.status).toBe(201);
    const second = await apply({
      packSlug: 'phased-feature', templateName: 'team', name: 'Epic', overwritePackFiles: 'true',
    });
    expect(second.res.status).toBe(409);
    expect(listJobsForProject(getDb(), projectId)).toHaveLength(1);
  });

  it('unlinks written files when createJob fails after a successful write', async () => {
    getDb().exec(`
      CREATE TRIGGER fail_jobs BEFORE INSERT ON schedule_jobs
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    const res = await fetch(`${base}/projects/${projectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Boom',
        timezone: 'UTC',
        profileId,
        packSlug: 'phased-feature',
        templateName: 'team',
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(existsSync(join(projectRoot, '.tierwyn/schedule/boom-prompt.md'))).toBe(false);
    expect(existsSync(join(projectRoot, '.tierwyn/schedule/boom-progress.md'))).toBe(false);
    expect(listJobsForProject(getDb(), projectId)).toHaveLength(0);
  });

  it('404 on unknown packSlug', async () => {
    const { res, body } = await apply({ packSlug: 'no-such-pack' });
    expect(res.status).toBe(404);
    expect(body.error).toMatch(/no such pack/);
  });

  it('400 when a declared applyField is missing from a pack without job.variables', async () => {
    upsertImportedPack(getDb(), {
      slug: 'needs-vars',
      title: 'Needs vars',
      description: 'x',
      version: 1,
      origin: 'imported',
      applyFields: [{
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [{ value: 'closed', label: 'Closed' }],
      }],
      job: {
        cadence: { kind: 'once', fireInMs: 60_000 },
        promptTemplate: 'hi',
      },
    });
    const { res, body } = await apply({ packSlug: 'needs-vars', name: 'Wave' });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/packVars/);
  });

  it('applies feature-wave without packVars via shipped defaults and auto-match', async () => {
    saveTemplate(getDb(), {
      name: 'team',
      roles: [{
        role: 'Grok 4.6',
        profileId,
        when: 'Use this as primary implementer for code implementations before other options',
      }],
    });
    const { res, body } = await apply({
      packSlug: 'feature-wave',
      templateName: 'team',
      name: 'Auto wave',
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.variables?.implementRole).toBe('Grok 4.6');
    expect(job.variables?.mode).toBe('closed');
    expect(job.variables?.commitOnTick).toBe('true');
    expect(job.variables?.stages).toBe('plan,implement,review');
    expect(job.variables?.reviewRole).toBe('none');
    expect(job.variables?.planRole).toBe('none');
    expect(body.warnings?.some((w) => w.includes("stage 'implement' → 'Grok 4.6' (auto-matched)"))).toBe(true);
  });

  it('applies feature-wave when all applyFields are present', async () => {
    const { res, body } = await apply({
      packSlug: 'feature-wave',
      templateName: 'team',
      name: 'Evolve wave',
      packVars: {
        mode: 'closed',
        commitOnTick: 'true',
        implementRole: 'Implementer',
      },
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.name).toBe('[feature-wave] Evolve wave');
    expect(job.enabled).toBe(false);
    expect(job.steer).toBeUndefined();
    expect(job.variables?.commitOnTick).toBe('true');
    expect(job.variables?.mode).toBe('closed');
    expect(job.variables?.implementRole).toBe('Implementer');
    expect(existsSync(join(projectRoot, '.tierwyn/schedule/evolve-wave-roster.md'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.tierwyn/schedule/evolve-wave-README.md'), 'utf8')).toContain('closed');
    expect(readFileSync(join(projectRoot, '.tierwyn/schedule/evolve-wave-progress.md'), 'utf8')).toContain('created from feature-wave v4');
  });

  it('applies docs-campaign and seeds fire-time variables from packVars', async () => {
    const { res, body } = await apply({
      packSlug: 'docs-campaign',
      name: 'Docs wave',
      packVars: {
        archetype: 'monorepo',
        depth: 'light',
        docsTool: 'none',
        changelogPolicy: 'skip',
        commitMode: 'no-commit',
        implementerProfileId: profileId,
      },
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.name).toBe('[docs-campaign] Docs wave');
    expect(job.enabled).toBe(false);
    expect(job.steer).toContain('{{vars.archetype}}');
    expect(job.steer).toContain('{{vars.depth}}');
    expect(job.steer).toContain('{{vars.docsTool}}');
    expect(job.steer).toContain('{{vars.changelogPolicy}}');
    expect(job.steer).toContain('{{vars.commitMode}}');
    expect(job.steer).toContain('{{vars.implementerProfileId}}');
    expect(job.promptTemplate).not.toMatch(/\[\[(archetype|depth|docsTool|changelogPolicy|commitMode|implementerProfileId)\]\]/);
    expect(job.variables).toEqual({
      archetype: 'monorepo',
      depth: 'light',
      docsTool: 'none',
      changelogPolicy: 'skip',
      commitMode: 'no-commit',
      implementerProfileId: profileId,
    });
  });

  it('ignores unreferenced packVars (including hyphenated keys) and merges body.variables', async () => {
    const { res, body } = await apply({
      packSlug: 'feature-wave',
      templateName: 'team',
      name: 'Custom wave',
      packVars: {
        mode: 'open-propose',
        commitOnTick: 'true',
        implementRole: 'Implementer',
        'target-branch': 'main',
      },
      variables: {
        extra_knob: 'val',
      },
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.variables?.extra_knob).toBe('val');
    expect(job.variables?.['target-branch']).toBeUndefined();
    expect(job.variables?.mode).toBe('open-propose');
  });

  it('lets an explicit packVars.implementRole win over auto-match', async () => {
    saveTemplate(getDb(), {
      name: 'team',
      roles: [
        {
          role: 'Grok 4.6',
          profileId,
          when: 'Use this as primary implementer for code implementations',
        },
        { role: 'Implementer', profileId, when: 'fallback coder' },
      ],
    });
    const { res, body } = await apply({
      packSlug: 'feature-wave',
      templateName: 'team',
      name: 'Explicit role wave',
      packVars: {
        mode: 'closed',
        commitOnTick: 'true',
        implementRole: 'Implementer',
      },
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.variables?.implementRole).toBe('Implementer');
  });

  it('uses custom roleMatchKeywords from settings to pick a delegate', async () => {
    updateGeneralSettings(getDb(), { roleMatchKeywords: { implement: ['rust'] } });
    saveTemplate(getDb(), {
      name: 'team',
      roles: [
        { role: 'Grok 4.6', profileId, when: 'primary implementer for code' },
        { role: 'Rustacean', profileId, when: 'rust specialist' },
      ],
    });
    const { res, body } = await apply({
      packSlug: 'feature-wave',
      templateName: 'team',
      name: 'Rust wave',
    });
    expect(res.status).toBe(201);
    const job = getJob(getDb(), body.job!.id)!;
    expect(job.variables?.implementRole).toBe('Rustacean');
  });
});

describe('POST /projects/:id/schedules/agent pack apply', () => {
  it('applies feature-wave with packVars, materialises files, and returns 201', async () => {
    const db = getDb();
    const conv = createConversation(db, { projectId, title: 'root', templateName: 'team' });
    createSession(db, {
      id: 'sess-root',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const tok = issueSpawnToken(conv.id, 'sess-root');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Evolve wave',
        packSlug: 'feature-wave',
        packVars: {
          mode: 'closed',
          commitOnTick: 'true',
          implementRole: 'Implementer',
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      job: { id: string; name: string; scheduleKind: string; enabled: boolean };
      status: string;
      packFiles?: string[];
    };
    expect(body.job.name).toBe('[feature-wave] Evolve wave');
    expect(body.job.scheduleKind).toBe('interval');
    expect(body.job.enabled).toBe(false);
    expect(body.status).toBe('pending_operator_enable');
    expect(body.packFiles).toBeDefined();
    expect(body.packFiles!.length).toBeGreaterThan(0);
    expect(existsSync(join(projectRoot, '.tierwyn/schedule/evolve-wave-roster.md'))).toBe(true);

    const job = getJob(db, body.job.id)!;
    expect(job.variables?.mode).toBe('closed');
    expect(job.variables?.commitOnTick).toBe('true');
    expect(job.variables?.implementRole).toBe('Implementer');
    revokeSpawnTokensForSession('sess-root');
  });

  it('agent route auto-matches implementer when no role vars are sent', async () => {
    const db = getDb();
    saveTemplate(db, {
      name: 'team',
      roles: [{
        role: 'Grok 4.6',
        profileId,
        when: 'Use this as primary implementer for code implementations before other options',
      }],
    });
    const conv = createConversation(db, { projectId, title: 'root', templateName: 'team' });
    createSession(db, {
      id: 'sess-auto',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const tok = issueSpawnToken(conv.id, 'sess-auto');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Agent auto wave',
        packSlug: 'feature-wave',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { id: string }; warnings?: string[] };
    const job = getJob(db, body.job.id)!;
    expect(job.variables?.implementRole).toBe('Grok 4.6');
    expect(job.variables?.mode).toBe('closed');
    expect(job.variables?.reviewRole).toBe('none');
    expect(body.warnings?.some((w) => w.includes("stage 'implement' → 'Grok 4.6' (auto-matched)"))).toBe(true);
    revokeSpawnTokensForSession('sess-auto');
  });

  it('rejects with 400 and writes NO files when required stage role is missing from template', async () => {
    const db = getDb();
    saveTemplate(db, {
      name: 'dev-team',
      roles: [{ role: 'tester', profileId }],
    });
    const conv = createConversation(db, { projectId, title: 'root', templateName: 'dev-team' });
    createSession(db, {
      id: 'sess-dev',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const pipelinePack: SchedulePack = {
      slug: 'test-pipe-req',
      title: 'Pipe Req',
      description: 'Pipeline with required stage',
      version: 1,
      origin: 'imported',
      requiresTemplate: true,
      requiredStages: ['implement'],
      job: {
        cadence: { kind: 'interval', everyMs: 3_600_000 },
        promptTemplate: 'Run pipeline: {{pipeline}} [[pipelineNotes]]',
        agentMayComplete: true,
        variables: {
          stages: 'implement,test',
          implementRole: 'coder',
          testRole: 'tester',
        },
      },
      files: [
        { path: '.tierwyn/schedule/pipe-req-file.md', content: 'should not be created' },
      ],
    };
    upsertImportedPack(db, pipelinePack);

    const tok = issueSpawnToken(conv.id, 'sess-dev');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Pipe job',
        packSlug: 'test-pipe-req',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("pipeline: required stage 'implement'");
    expect(body.error).toContain("Settings → Schedules");
    expect(existsSync(join(projectRoot, '.tierwyn/schedule/pipe-req-file.md'))).toBe(false);
    revokeSpawnTokensForSession('sess-dev');
  });

  it('skips optional stage and includes warning when optional stage role is missing', async () => {
    const db = getDb();
    saveTemplate(db, {
      name: 'dev-team-coder',
      roles: [{ role: 'coder', profileId }],
    });
    const conv = createConversation(db, { projectId, title: 'root', templateName: 'dev-team-coder' });
    createSession(db, {
      id: 'sess-coder',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const pipelinePack: SchedulePack = {
      slug: 'test-pipe-opt',
      title: 'Pipe Opt',
      description: 'Pipeline with optional stage',
      version: 1,
      origin: 'imported',
      requiresTemplate: true,
      requiredStages: ['implement'],
      job: {
        cadence: { kind: 'interval', everyMs: 3_600_000 },
        promptTemplate: 'Run pipeline: {{pipeline}} [[pipelineNotes]]',
        agentMayComplete: true,
        variables: {
          stages: 'implement,translate',
          implementRole: 'coder',
          translateRole: 'translator',
        },
      },
    };
    upsertImportedPack(db, pipelinePack);

    const tok = issueSpawnToken(conv.id, 'sess-coder');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Opt pipe job',
        packSlug: 'test-pipe-opt',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      job: { id: string };
      warnings?: string[];
    };
    expect(body.warnings).toBeDefined();
    expect(body.warnings!.some((w) => w.includes("stage 'translate' skipped at apply"))).toBe(true);
    const job = getJob(db, body.job.id)!;
    expect(job.variables).toMatchObject({
      implementRole: 'coder',
      translateRole: 'none',
    });
    revokeSpawnTokensForSession('sess-coder');
  });

  it('pipeline variables: body.variables overrides packVars and missing optional role stays none (M1)', async () => {
    const db = getDb();
    saveTemplate(db, {
      name: 'dev-team-precedence',
      roles: [{ role: 'impl', profileId }],
    });
    const conv = createConversation(db, { projectId, title: 'root', templateName: 'dev-team-precedence' });
    createSession(db, {
      id: 'sess-pipe-prec',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const pipelinePack: SchedulePack = {
      slug: 'test-pipe-precedence',
      title: 'Pipe Precedence',
      description: 'Testing precedence with pipeline and referenced vars',
      version: 1,
      origin: 'imported',
      requiresTemplate: true,
      requiredStages: ['plan'],
      job: {
        cadence: { kind: 'interval', everyMs: 3_600_000 },
        // Referencing {{vars.reviewRole}} and {{vars.planRole}} causes them to enter seededVars
        promptTemplate: 'Run pipeline: {{pipeline}} {{vars.reviewRole}} {{vars.planRole}}',
        agentMayComplete: true,
        variables: {
          stages: 'plan,review',
          planRole: 'default-plan',
          reviewRole: 'default-review',
        },
      },
    };
    upsertImportedPack(db, pipelinePack);

    const tok = issueSpawnToken(conv.id, 'sess-pipe-prec');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Precedence test',
        packSlug: 'test-pipe-precedence',
        packVars: {
          reviewRole: 'bogus',
          planRole: 'fromPackVars',
        },
        variables: {
          planRole: 'impl',
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { id: string }; warnings?: string[] };
    expect(body.warnings).toBeDefined();
    expect(body.warnings!.some((w) => w.includes("stage 'review' skipped at apply"))).toBe(true);

    const job = getJob(db, body.job.id)!;
    // body.variables ('impl') should override packVars ('fromPackVars')
    expect(job.variables?.planRole).toBe('impl');
    // reviewRole should be downgraded to 'none' by checkPipelineRoles and NOT overwritten by raw packVars 'bogus'
    expect(job.variables?.reviewRole).toBe('none');
    revokeSpawnTokensForSession('sess-pipe-prec');
  });

  it('404 on unknown packSlug', async () => {
    const db = getDb();
    const conv = createConversation(db, { projectId, title: 'root' });
    createSession(db, {
      id: 'sess-root',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const tok = issueSpawnToken(conv.id, 'sess-root');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Bad pack',
        fireInMs: 60_000,
        packSlug: 'no-such-pack-xyz',
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('no such pack');
    revokeSpawnTokensForSession('sess-root');
  });

  it('400 when templateName does not match conversation template', async () => {
    const db = getDb();
    const conv = createConversation(db, { projectId, title: 'root', templateName: 'team' });
    createSession(db, {
      id: 'sess-root',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const tok = issueSpawnToken(conv.id, 'sess-root');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Mismatched',
        promptTemplate: 'verify something',
        fireInMs: 60_000,
        templateName: 'different-template',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('templateName is not the conversation template');
    revokeSpawnTokensForSession('sess-root');
  });

  it('400 cron_not_allowed when pack has cron cadence', async () => {
    const db = getDb();
    const conv = createConversation(db, { projectId, title: 'root' });
    createSession(db, {
      id: 'sess-root',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const cronPack: SchedulePack = {
      slug: 'cron-pack',
      title: 'Cron Pack',
      description: 'Cron cadence pack',
      version: 1,
      origin: 'imported',
      job: {
        cadence: { kind: 'cron', expr: '0 0 * * *' },
        promptTemplate: 'cron prompt',
      },
    };
    upsertImportedPack(db, cronPack);

    const tok = issueSpawnToken(conv.id, 'sess-root');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Cron attempt',
        packSlug: 'cron-pack',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('cron_not_allowed');
    revokeSpawnTokensForSession('sess-root');
  });

  it('409 on file conflict and creates no job row', async () => {
    const db = getDb();
    const conv = createConversation(db, { projectId, title: 'root', templateName: 'team' });
    createSession(db, {
      id: 'sess-root',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });

    // Pre-create the file to force a 409 conflict
    mkdirSync(join(projectRoot, '.tierwyn/schedule'), { recursive: true });
    writeFileSync(join(projectRoot, '.tierwyn/schedule/conflict-wave-roster.md'), 'pre-existing');

    const tok = issueSpawnToken(conv.id, 'sess-root');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Conflict wave',
        packSlug: 'feature-wave',
        packVars: {
          mode: 'closed',
          commitOnTick: 'true',
          implementRole: 'Implementer',
        },
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; conflicts: string[] };
    expect(body.conflicts).toContain('.tierwyn/schedule/conflict-wave-roster.md');

    // Confirm no job was created
    const jobs = listJobsForProject(db, projectId);
    expect(jobs.some((j) => j.name.includes('Conflict wave'))).toBe(false);
    revokeSpawnTokensForSession('sess-root');
  });

  it('agent route ignores overwritePackFiles: true and still 409s', async () => {
    const db = getDb();
    const conv = createConversation(db, { projectId, title: 'root', templateName: 'team' });
    createSession(db, {
      id: 'sess-ow',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    mkdirSync(join(projectRoot, '.tierwyn/schedule'), { recursive: true });
    const rosterPath = join(projectRoot, '.tierwyn/schedule/ow-wave-roster.md');
    writeFileSync(rosterPath, 'pre-existing');

    const tok = issueSpawnToken(conv.id, 'sess-ow');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Ow wave',
        packSlug: 'feature-wave',
        overwritePackFiles: true,
        packVars: {
          mode: 'closed',
          commitOnTick: 'true',
          implementRole: 'Implementer',
        },
      }),
    });
    expect(res.status).toBe(409);
    expect(readFileSync(rosterPath, 'utf8')).toBe('pre-existing');
    expect(listJobsForProject(db, projectId).some((j) => j.name.includes('Ow wave'))).toBe(false);
    revokeSpawnTokensForSession('sess-ow');
  });

  it('agent-applied pack preserves overlapPolicy and runTimeoutMs (M2)', async () => {
    const db = getDb();
    const conv = createConversation(db, { projectId, title: 'root' });
    createSession(db, {
      id: 'sess-docs',
      conversationId: conv.id,
      agentId: profileId.split(':')[0]!,
      agentModelId: profileId,
    });
    const tok = issueSpawnToken(conv.id, 'sess-docs');
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        name: 'Docs job',
        packSlug: 'docs-campaign',
        packVars: {
          archetype: 'monorepo',
          depth: 'light',
          docsTool: 'none',
          changelogPolicy: 'skip',
          commitMode: 'no-commit',
          implementerProfileId: profileId,
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { id: string } };
    const job = getJob(db, body.job.id)!;
    expect(job.overlapPolicy).toBe('skip');
    expect(job.runTimeoutMs).toBe(3_600_000);
    revokeSpawnTokensForSession('sess-docs');
  });
});

describe('POST /schedules/:jobId/complete-job auto-archive', () => {
  it('once job + autoArchiveCompletedOneShots: true -> archived: true and count drops', async () => {
    const db = getDb();
    updateGeneralSettings(db, { autoArchiveCompletedOneShots: true });
    const conv = createConversation(db, { projectId, title: 'root' });
    const job = createJob(db, {
      projectId,
      name: 'Once complete test',
      timezone: 'UTC',
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: Date.now() + 100_000 }),
      profileId,
      promptTemplate: 'do work and complete',
      homeConversationId: conv.id,
      nextFireAt: Date.now() + 100_000,
      enabled: true,
      agentMayComplete: true,
      createdBy: 'agent',
      createdByConversationId: conv.id,
    });

    expect(countAgentJobsForConversation(db, conv.id)).toBe(1);

    const token = issueRunToken({ jobId: job.id, runId: 'run-1', conversationId: conv.id });
    const res = await fetch(`${base}/schedules/${job.id}/complete-job`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { job: { enabled: boolean; archived: boolean }; archived: boolean };
    expect(body.archived).toBe(true);
    expect(body.job.enabled).toBe(false);
    expect(body.job.archived).toBe(true);

    const reloaded = getJob(db, job.id)!;
    expect(reloaded.enabled).toBe(false);
    expect(reloaded.archived).toBe(true);
    expect(countAgentJobsForConversation(db, conv.id)).toBe(0);
    revokeRunToken(token);
  });

  it('once job + autoArchiveCompletedOneShots: false -> disabled but not archived', async () => {
    const db = getDb();
    updateGeneralSettings(db, { autoArchiveCompletedOneShots: false });
    const conv = createConversation(db, { projectId, title: 'root' });
    const job = createJob(db, {
      projectId,
      name: 'Once no-archive test',
      timezone: 'UTC',
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: Date.now() + 100_000 }),
      profileId,
      promptTemplate: 'do work and complete',
      homeConversationId: conv.id,
      nextFireAt: Date.now() + 100_000,
      enabled: true,
      agentMayComplete: true,
      createdBy: 'agent',
      createdByConversationId: conv.id,
    });

    const token = issueRunToken({ jobId: job.id, runId: 'run-2', conversationId: conv.id });
    const res = await fetch(`${base}/schedules/${job.id}/complete-job`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { job: { enabled: boolean; archived: boolean }; archived: boolean };
    expect(body.archived).toBe(false);
    expect(body.job.enabled).toBe(false);
    expect(body.job.archived).toBe(false);

    const reloaded = getJob(db, job.id)!;
    expect(reloaded.enabled).toBe(false);
    expect(reloaded.archived).toBe(false);
    revokeRunToken(token);
  });

  it('interval job + autoArchiveCompletedOneShots: true -> disabled but not archived', async () => {
    const db = getDb();
    updateGeneralSettings(db, { autoArchiveCompletedOneShots: true });
    const conv = createConversation(db, { projectId, title: 'root' });
    const job = createJob(db, {
      projectId,
      name: 'Interval no-archive test',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
      profileId,
      promptTemplate: 'interval work',
      homeConversationId: conv.id,
      nextFireAt: Date.now() + 3_600_000,
      enabled: true,
      agentMayComplete: true,
      createdBy: 'agent',
      createdByConversationId: conv.id,
    });

    const token = issueRunToken({ jobId: job.id, runId: 'run-3', conversationId: conv.id });
    const res = await fetch(`${base}/schedules/${job.id}/complete-job`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { job: { enabled: boolean; archived: boolean }; archived: boolean };
    expect(body.archived).toBe(false);
    expect(body.job.enabled).toBe(false);
    expect(body.job.archived).toBe(false);
    revokeRunToken(token);
  });

  it('agentMayComplete: false -> 403', async () => {
    const db = getDb();
    const conv = createConversation(db, { projectId, title: 'root' });
    const job = createJob(db, {
      projectId,
      name: 'Forbidden complete test',
      timezone: 'UTC',
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: Date.now() + 100_000 }),
      profileId,
      promptTemplate: 'operator only complete',
      homeConversationId: conv.id,
      nextFireAt: Date.now() + 100_000,
      enabled: true,
      agentMayComplete: false,
      createdBy: 'agent',
      createdByConversationId: conv.id,
    });

    const token = issueRunToken({ jobId: job.id, runId: 'run-4', conversationId: conv.id });
    const res = await fetch(`${base}/schedules/${job.id}/complete-job`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('agent_may_complete');
    revokeRunToken(token);
  });
});

describe('remote pack apply via schedule.packFiles (Task 12)', () => {
  async function remount() {
    await new Promise<void>((r) => server.close(() => r()));
    const app = mountApp();
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  function connectedView(hostId: string, features: string[]) {
    const agentType = profileId.split(':')[0]!;
    return {
      id: hostId,
      name: 'box',
      state: 'connected' as const,
      hello: {
        agents: { [agentType]: { installed: true, methods: [] as string[] } },
        models: { [agentType]: [] as string[] },
        features: features as import('@tierwyn/shared').NodeFeature[],
      },
      allowMcpSecrets: true,
      createdAt: Date.now(),
    };
  }

  function seedRemoteHost(token: string, features: string[]) {
    const db = getDb();
    const host = createPendingHost(db, 'box', token, Date.now() + 60_000);
    const agentType = profileId.split(':')[0]!;
    saveHello(db, host.id, {
      protocol: 1, gitSha: 't', hostname: 'box', os: 'linux', arch: 'x64',
      homedir: '/remote', roots: ['/remote'], listenPort: 0,
      agents: { [agentType]: { installed: true, methods: [] } },
      models: { [agentType]: [] },
      sessions: [],
      features,
    } as never, Date.now());
    return host;
  }

  function packBody() {
    return {
      name: 'Epic',
      timezone: 'UTC',
      profileId,
      packSlug: 'phased-feature',
      templateName: 'team',
    };
  }

  it('remote project + pack → RPC write, no hub-fs write under project.rootPath', async () => {
    const host = seedRemoteHost('tok-pack', ['schedule.packFiles']);
    const remoteRoot = '/remote/proj';
    const remoteProject = createProject(getDb(), {
      name: 'remote', rootPath: remoteRoot, remoteHostId: host.id,
    });
    const request = vi.fn(async (_m: string, p: unknown) => {
      const params = p as { op: string; files: Array<{ body: string }> };
      expect(params.op).toBe('write');
      for (const f of params.files) {
        expect(f.body).not.toMatch(/\[\[/);
      }
      return {
        ok: true as const,
        written: [
          '.tierwyn/schedule/epic-prompt.md',
          '.tierwyn/schedule/epic-progress.md',
          '.tierwyn/schedule/epic-roster.md',
          '.tierwyn/schedule/epic-README.md',
        ],
      };
    });
    nodeHub = { link: () => ({ request }) };
    remoteHostView = () => connectedView(host.id, ['schedule.packFiles']);
    await remount();

    const res = await fetch(`${base}/projects/${remoteProject.id}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packBody()),
    });
    expect(res.status).toBe(201);
    expect(request).toHaveBeenCalledWith(
      'schedule.packFiles',
      expect.objectContaining({ op: 'write', root: remoteRoot, jobSlug: expect.any(String) }),
    );
    expect(existsSync(join(remoteRoot, '.tierwyn'))).toBe(false);
    const body = await res.json() as { job: { id: string }; packFiles?: string[] };
    expect(body.job.id).toBeTruthy();
    expect(body.packFiles?.length).toBeGreaterThan(0);
  });

  it('host without schedule.packFiles → 501 node_update_required and no job', async () => {
    const host = seedRemoteHost('tok-old', ['files.write']);
    const remoteProject = createProject(getDb(), {
      name: 'remote-old', rootPath: '/remote/old', remoteHostId: host.id,
    });
    const request = vi.fn();
    nodeHub = { link: () => ({ request }) };
    remoteHostView = () => connectedView(host.id, ['files.write']);
    await remount();

    const before = listJobsForProject(getDb(), remoteProject.id).length;
    const res = await fetch(`${base}/projects/${remoteProject.id}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packBody()),
    });
    expect(res.status).toBe(501);
    const body = await res.json() as { error: string; code?: string };
    expect(body).toMatchObject({ code: 'node_update_required' });
    expect(request).not.toHaveBeenCalled();
    expect(listJobsForProject(getDb(), remoteProject.id)).toHaveLength(before);
  });

  it('link throws disconnected → 409 host_disconnected and no job', async () => {
    const { RpcError } = await import('../node/rpc.js');
    const host = seedRemoteHost('tok-dc', ['schedule.packFiles']);
    const remoteProject = createProject(getDb(), {
      name: 'remote-dc', rootPath: '/remote/dc', remoteHostId: host.id,
    });
    nodeHub = {
      link: () => { throw new RpcError('host_disconnected', 'down'); },
    };
    remoteHostView = () => connectedView(host.id, ['schedule.packFiles']);
    await remount();

    const before = listJobsForProject(getDb(), remoteProject.id).length;
    const res = await fetch(`${base}/projects/${remoteProject.id}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packBody()),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; code?: string };
    expect(body).toMatchObject({ code: 'host_disconnected' });
    expect(listJobsForProject(getDb(), remoteProject.id)).toHaveLength(before);
  });

  it('node conflict → 409 with conflicts', async () => {
    const host = seedRemoteHost('tok-cf', ['schedule.packFiles']);
    const remoteProject = createProject(getDb(), {
      name: 'remote-cf', rootPath: '/remote/cf', remoteHostId: host.id,
    });
    const request = vi.fn(async () => ({
      ok: false as const,
      code: 'conflict' as const,
      conflicts: ['.tierwyn/schedule/epic-prompt.md'],
    }));
    nodeHub = { link: () => ({ request }) };
    remoteHostView = () => connectedView(host.id, ['schedule.packFiles']);
    await remount();

    const before = listJobsForProject(getDb(), remoteProject.id).length;
    const res = await fetch(`${base}/projects/${remoteProject.id}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packBody()),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; conflicts?: string[] };
    expect(body.conflicts).toEqual(['.tierwyn/schedule/epic-prompt.md']);
    expect(listJobsForProject(getDb(), remoteProject.id)).toHaveLength(before);
  });

  it('local project path unchanged (still writes under project.rootPath)', async () => {
    const { res, body } = await apply({
      packSlug: 'phased-feature', templateName: 'team', name: 'Local Epic',
    });
    expect(res.status).toBe(201);
    expect(body.packFiles?.length).toBeGreaterThan(0);
    for (const rel of body.packFiles ?? []) {
      expect(existsSync(join(projectRoot, rel))).toBe(true);
    }
  });
});
