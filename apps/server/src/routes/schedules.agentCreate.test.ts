import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { Request, Response, NextFunction } from 'express';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedCommands, seedDefaultSettings } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import { createProject } from '../repositories/projects.js';
import {
  createConversation, getConversation, setConversationCapabilityProfile,
  setConversationPermissionMode, setConversationSandbox,
} from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { countAgentJobsForConversation, countAgentJobsForProject } from '../repositories/schedules.js';
import { saveTemplate, updateCompactionSettings, updateGeneralSettings } from '../repositories/settings.js';
import { issueSpawnToken, revokeSpawnTokensForSession } from '../spawn/tokens.js';
import {
  registerScheduleAgentRoutes, registerScheduleRoutes, agentCreateBeforeInsert, type JobSchedulerLike,
} from './schedules.js';
import { registerSpawnRoutes } from './spawn.js';
import { SessionManager } from '../sessionManager.js';

let server: Server;
let base: string;
let projectId: string;
let rootConvId: string;
let profileId: string;
let isAuthed: boolean;
let broadcasts: Array<{ projectId: string; jobId: string }>;
let mgr: SessionManager;
let remoteHostView: ((id: string) => import('@tierwyn/shared').RemoteHostView | undefined) | undefined;

function mountApp(opts?: { loopback?: boolean }) {
  broadcasts = [];
  isAuthed = false;
  const runNow = vi.fn(async (jobId: string) => ({ ok: true as const, runId: `run-for-${jobId}` }));
  const stubScheduler: JobSchedulerLike = { runNow };
  const app = express();
  app.use(express.json());
  app.use(express.text({ type: 'text/plain', limit: '1mb' }));

  // Optionally spoof non-loopback peer for help-route tests.
  if (opts?.loopback === false) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        value: '8.8.8.8',
        configurable: true,
      });
      next();
    });
  }

  const broadcast = (pid: string, jobId: string) => broadcasts.push({ projectId: pid, jobId });
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
  // Spawn routes mounted so schedule-token scope-guard tests can hit /spawn/raw.
  mgr = new SessionManager({ broadcast: () => {} });
  registerSpawnRoutes(app, { getDb, sessionManager: mgr, isAuthed: () => isAuthed });
  return app;
}

beforeEach(async () => {
  remoteHostView = undefined;
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db);
  seedCommands(db);
  seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  profileId = catalogue.listProfiles().find((p) => p.enabled)!.id;
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  rootConvId = createConversation(db, { projectId, title: 'root' }).id;
  createSession(db, {
    id: 'sess-root',
    conversationId: rootConvId,
    agentId: profileId.split(':')[0],
    agentModelId: profileId,
  });
  const app = mountApp();
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});
afterEach(async () => {
  agentCreateBeforeInsert.wait = async () => {};
  revokeSpawnTokensForSession('sess-root');
  await new Promise<void>((r) => server.close(() => r()));
});

function agentToken(): string {
  return issueSpawnToken(rootConvId, 'sess-root');
}

function agentBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Delayed check',
    fireInMs: 120_000,
    promptTemplate: 'Verify the thing and complete-job if green.',
    ...overrides,
  };
}

async function postAgent(
  body: Record<string, unknown>,
  opts?: { token?: string | null; projectId?: string },
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.token !== null) {
    headers.Authorization = `Bearer ${opts?.token ?? agentToken()}`;
  }
  return fetch(`${base}/projects/${opts?.projectId ?? projectId}/schedules/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /projects/:projectId/schedules/agent', () => {
  it('401 without bearer', async () => {
    const res = await postAgent(agentBody(), { token: null });
    expect(res.status).toBe(401);
  });

  it('401 with invalid bearer', async () => {
    const res = await postAgent(agentBody(), { token: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('403 wrong_project when token conv is in another project', async () => {
    const other = createProject(getDb(), { name: 'other', rootPath: '/tmp/other' }).id;
    const res = await postAgent(agentBody(), { projectId: other });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('wrong_project');
  });

  // Requirement A — depth-agnostic: depth>0 create now succeeds (was 403 depth_not_allowed).
  it('201 for spawned child (depth ≥ 1) with spawn-scoped token', async () => {
    const child = createConversation(getDb(), {
      projectId,
      title: 'child',
      parentConversationId: rootConvId,
    });
    createSession(getDb(), {
      id: 'sess-child',
      conversationId: child.id,
      agentId: profileId.split(':')[0],
      agentModelId: profileId,
    });
    const tok = issueSpawnToken(child.id, 'sess-child', 'spawn');
    const res = await postAgent(agentBody({ profileId }), { token: tok });
    expect(res.status).toBe(201);
    const body = await res.json() as { status: string; job: { createdBy: string } };
    expect(body.status).toBe('active'); // D3: one-shot active when approval is off
    expect(body.job.createdBy).toBe('agent');
    revokeSpawnTokensForSession('sess-child');
  });

  it('stamps the creating conversation capability_profile onto the job', async () => {
    setConversationCapabilityProfile(getDb(), rootConvId, 'media');
    const tok = issueSpawnToken(rootConvId, 'sess-root', 'spawn');
    const res = await postAgent(agentBody({ profileId }), { token: tok });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { capabilityProfile?: string } };
    expect(body.job.capabilityProfile).toBe('media');
  });

  it('creator under a stricter permission mode than global → job lands disabled', async () => {
    setConversationPermissionMode(getDb(), rootConvId, 'prompt'); // global stays bypass
    const res = await postAgent(agentBody({ profileId }));
    expect(res.status).toBe(201);
    const body = await res.json() as { status: string; job: { enabled: boolean } };
    expect(body.status).toBe('pending_operator_enable');
    expect(body.job.enabled).toBe(false);
  });

  it('201 with schedule-scoped token (non-spawn-capable conversation)', async () => {
    const tok = issueSpawnToken(rootConvId, 'sess-root', 'schedule');
    const res = await postAgent(agentBody({ profileId }), { token: tok });
    expect(res.status).toBe(201);
    const body = await res.json() as { status: string; job: { createdBy: string } };
    expect(body.status).toBe('active'); // D3: one-shot active when approval is off
    expect(body.job.createdBy).toBe('agent');
  });

  // Requirement A + schedule scope: depth>0 child with schedule-only token can create.
  it('201 for depth ≥ 1 child with schedule-scoped token', async () => {
    const child = createConversation(getDb(), {
      projectId,
      title: 'child-sched',
      parentConversationId: rootConvId,
    });
    createSession(getDb(), {
      id: 'sess-child-sched',
      conversationId: child.id,
      agentId: profileId.split(':')[0],
      agentModelId: profileId,
    });
    const tok = issueSpawnToken(child.id, 'sess-child-sched', 'schedule');
    const res = await postAgent(agentBody({ profileId }), { token: tok });
    expect(res.status).toBe(201);
    revokeSpawnTokensForSession('sess-child-sched');
  });

  it('401 at /spawn/raw when schedule-scoped token is presented (no escalation)', async () => {
    const tok = issueSpawnToken(rootConvId, 'sess-root', 'schedule');
    const res = await fetch(`${base}/spawn/raw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Authorization: `Bearer ${tok}`,
        'X-Spawn-Parent': rootConvId,
        'X-Spawn-Role': 'any',
      },
      body: 'do something',
    });
    expect(res.status).toBe(401);
  });

  it('pins home conversation sandbox from the creating conversation', async () => {
    setConversationSandbox(getDb(), rootConvId, 'on');
    const res = await postAgent(agentBody({ profileId }));
    expect(res.status).toBe(201);
    const body = await res.json() as { homeConversationId: string };
    expect(getConversation(getDb(), body.homeConversationId)?.sandbox).toBe('on');
  });

  it('201 with fireInMs → once, atMs≈now+fireInMs, agentMayComplete true (no interval/365d)', async () => {
    const fireInMs = 180_000;
    const before = Date.now();
    const res = await postAgent(agentBody({ fireInMs, profileId }));
    const after = Date.now();
    expect(res.status).toBe(201);
    const body = await res.json() as {
      job: {
        id: string;
        createdBy: string;
        agentMayComplete: boolean;
        scheduleKind: string;
        scheduleExpr: string;
        nextFireAt: number;
        enabled: boolean;
      };
      nextFireAtIso: string;
      status: string;
      homeConversationId: string;
    };
    expect(body.status).toBe('active'); // D3: one-shot active when approval is off
    expect(body.job.createdBy).toBe('agent');
    expect(body.job.agentMayComplete).toBe(true);
    expect(body.job.scheduleKind).toBe('once');
    const expr = JSON.parse(body.job.scheduleExpr) as { atMs?: number; everyMs?: number };
    expect(expr.everyMs).toBeUndefined();
    expect(typeof expr.atMs).toBe('number');
    expect(expr.atMs).toBeGreaterThanOrEqual(before + fireInMs - 5);
    expect(expr.atMs).toBeLessThanOrEqual(after + fireInMs + 5);
    expect(body.job.enabled).toBe(true); // D3: one-shot active when approval is off
    expect(body.homeConversationId).toBeTruthy();
    expect(body.job.nextFireAt).toBe(expr.atMs);
    expect(new Date(body.nextFireAtIso).getTime()).toBe(body.job.nextFireAt);
    expect(broadcasts).toHaveLength(1);
  });

  it('201 with fireAtMs → once within 7d', async () => {
    const fireAtMs = Date.now() + 3_600_000;
    const res = await postAgent({
      name: 'absolute once',
      promptTemplate: 'check',
      profileId,
      fireAtMs,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      job: { scheduleKind: string; scheduleExpr: string; agentMayComplete: boolean; nextFireAt: number };
    };
    expect(body.job.scheduleKind).toBe('once');
    expect(body.job.agentMayComplete).toBe(true);
    expect(JSON.parse(body.job.scheduleExpr).atMs).toBe(fireAtMs);
    expect(body.job.nextFireAt).toBe(fireAtMs);
  });

  it('400 when fireAtMs is in the past', async () => {
    const res = await postAgent({
      name: 'past',
      promptTemplate: 'x',
      profileId,
      fireAtMs: Date.now() - 60_000,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/future within 7 days/i);
  });

  it('400 when fireAtMs is more than 7 days out', async () => {
    const res = await postAgent({
      name: 'far',
      promptTemplate: 'x',
      profileId,
      fireAtMs: Date.now() + 8 * 86_400_000,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/future within 7 days/i);
  });

  it('400 when both fireInMs and fireAtMs present', async () => {
    const res = await postAgent({
      name: 'both',
      promptTemplate: 'x',
      profileId,
      fireInMs: 120_000,
      fireAtMs: Date.now() + 120_000,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/mutually exclusive/i);
  });

  it('400 cron_not_allowed', async () => {
    const res = await postAgent(agentBody({
      fireInMs: undefined,
      scheduleKind: 'cron',
      scheduleExpr: '0 0 * * *',
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('cron_not_allowed');
  });

  it('400 when scheduleExpr everyMs < 5 minutes', async () => {
    const res = await postAgent(agentBody({
      fireInMs: undefined,
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }), // 1 min < floor
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/everyMs/);
  });

  // Adversary F3 — declared scheduleKind must match expr shape.
  it('400 when scheduleKind once but scheduleExpr is interval', async () => {
    const res = await postAgent({
      name: 'mismatch',
      promptTemplate: 'x',
      profileId,
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ everyMs: 86_400_000 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/does not match/i);
  });

  it('400 when scheduleKind interval but scheduleExpr is once', async () => {
    const res = await postAgent({
      name: 'mismatch2',
      promptTemplate: 'x',
      profileId,
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ atMs: Date.now() + 120_000 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/does not match/i);
  });

  it('400 when both fireInMs and scheduleExpr present', async () => {
    const res = await postAgent(agentBody({
      fireInMs: 120_000,
      scheduleExpr: JSON.stringify({ everyMs: 86_400_000 }),
    }));
    expect(res.status).toBe(400);
  });

  it('400 when neither fireInMs nor fireAtMs nor scheduleExpr', async () => {
    const res = await postAgent({
      name: 'x',
      promptTemplate: 'y',
    });
    expect(res.status).toBe(400);
  });

  it('429 conversation_cap on 51st agent job for same conversation', async () => {
    for (let i = 0; i < 50; i++) {
      const res = await postAgent(agentBody({ name: `job-${i}`, profileId }));
      expect(res.status).toBe(201);
    }
    expect(countAgentJobsForConversation(getDb(), rootConvId)).toBe(50);
    const res = await postAgent(agentBody({ name: 'job-51', profileId }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('conversation_cap');
  });

  it('re-checks caps after the pre-insert await so concurrent creates cannot both pass', async () => {
    for (let i = 0; i < 49; i++) {
      const res = await postAgent(agentBody({ name: `job-${i}`, profileId }));
      expect(res.status).toBe(201);
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    agentCreateBeforeInsert.wait = () => gate;
    const a = postAgent(agentBody({ name: 'race-a', profileId }));
    const b = postAgent(agentBody({ name: 'race-b', profileId }));
    await new Promise((r) => setImmediate(r));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 429]);
    const loser = ra.status === 429 ? ra : rb;
    expect((await loser.json() as { error: string }).error).toBe('conversation_cap');
    expect(countAgentJobsForConversation(getDb(), rootConvId)).toBe(50);
  });

  it('archiving an agent job frees the conversation cap', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const res = await postAgent(agentBody({ name: `job-${i}`, profileId }));
      expect(res.status).toBe(201);
      const body = await res.json() as { job: { id: string } };
      ids.push(body.job.id);
    }
    const blocked = await postAgent(agentBody({ name: 'job-51', profileId }));
    expect(blocked.status).toBe(429);

    const archiveRes = await fetch(`${base}/projects/${projectId}/schedules/${ids[0]}/archive`, {
      method: 'POST',
    });
    expect(archiveRes.status).toBe(200);
    expect(countAgentJobsForConversation(getDb(), rootConvId)).toBe(49);

    const res = await postAgent(agentBody({ name: 'job-51', profileId }));
    expect(res.status).toBe(201);
  });

  it('429 project_cap on 51st agent job in project', async () => {
    // Create 50 agent jobs via different conversations.
    for (let i = 0; i < 50; i++) {
      const conv = createConversation(getDb(), { projectId, title: `root-${i}` });
      createSession(getDb(), {
        id: `sess-cap-${i}`,
        conversationId: conv.id,
        agentId: profileId.split(':')[0],
        agentModelId: profileId,
      });
      const tok = issueSpawnToken(conv.id, `sess-cap-${i}`);
      const res = await postAgent(agentBody({ name: `p-job-${i}`, profileId }), { token: tok });
      expect(res.status).toBe(201);
      revokeSpawnTokensForSession(`sess-cap-${i}`);
    }
    expect(countAgentJobsForProject(getDb(), projectId)).toBe(50);
    const res = await postAgent(agentBody({ name: 'p-job-51', profileId }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('project_cap');
  });

  it('defaults profileId from conversation last session when omitted', async () => {
    const res = await fetch(`${base}/projects/${projectId}/schedules/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentToken()}`,
      },
      body: JSON.stringify({
        name: 'default-profile',
        fireInMs: 120_000,
        promptTemplate: 'check',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { profileId: string } };
    expect(body.job.profileId).toBe(profileId);
  });

  it('approval on → enabled false + status pending_operator_enable', async () => {
    updateCompactionSettings(getDb(), { spawnApprovalRequired: true });
    const res = await postAgent(agentBody({ profileId }));
    expect(res.status).toBe(201);
    const body = await res.json() as {
      job: { enabled: boolean; createdBy: string };
      status: string;
    };
    expect(body.job.enabled).toBe(false);
    expect(body.job.createdBy).toBe('agent');
    expect(body.status).toBe('pending_operator_enable');
  });

  it('accepts interval ≥ 5 min and always creates disabled (operator opt-in)', async () => {
    const res = await postAgent({
      name: 'hourly',
      promptTemplate: 'hourly check',
      profileId,
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      job: { scheduleKind: string; scheduleExpr: string; createdBy: string; enabled: boolean };
      status: string;
    };
    expect(body.job.createdBy).toBe('agent');
    expect(body.job.scheduleKind).toBe('interval');
    expect(JSON.parse(body.job.scheduleExpr).everyMs).toBe(3_600_000);
    expect(body.job.enabled).toBe(false);
    expect(body.status).toBe('pending_operator_enable');
  });

  it('daily interval also forced off even when approval is off', async () => {
    const res = await postAgent({
      name: 'daily',
      promptTemplate: 'daily check',
      profileId,
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 86_400_000 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { enabled: boolean }; status: string };
    expect(body.job.enabled).toBe(false);
    expect(body.status).toBe('pending_operator_enable');
  });

  // D3 — one-shot lands enabled:true / active when spawn approval is off
  it('one-shot lands enabled:true / active when spawn approval is off', async () => {
    updateCompactionSettings(getDb(), { spawnApprovalRequired: false });
    const res = await postAgent(agentBody({ profileId }));
    expect(res.status).toBe(201);
    const body = await res.json() as {
      job: { enabled: boolean; scheduleKind: string }; status: string;
    };
    expect(body.job.scheduleKind).toBe('once');
    expect(body.job.enabled).toBe(true);
    expect(body.status).toBe('active');
  });

  it('one-shot lands enabled:false / pending_operator_enable when spawn approval is ON', async () => {
    updateCompactionSettings(getDb(), { spawnApprovalRequired: true });
    const res = await postAgent(agentBody({ profileId }));
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { enabled: boolean }; status: string };
    expect(body.job.enabled).toBe(false);
    expect(body.status).toBe('pending_operator_enable');
  });

  it('conversation template spawnApprovalRequired forces one-shot disabled even when templateName is omitted (H1)', async () => {
    updateCompactionSettings(getDb(), { spawnApprovalRequired: false });
    saveTemplate(getDb(), {
      name: 'safe-team',
      roles: [{ role: 'impl', profileId, when: 'test' }],
      spawnApprovalRequired: true,
    });
    getDb().prepare('UPDATE conversations SET template_name = ? WHERE id = ?').run('safe-team', rootConvId);

    const res = await postAgent(agentBody({ profileId }));
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { enabled: boolean }; status: string };
    expect(body.job.enabled).toBe(false);
    expect(body.status).toBe('pending_operator_enable');
  });

  it('interval lands enabled:true / active when allowAgentRecurringSchedules is ON', async () => {
    updateCompactionSettings(getDb(), { spawnApprovalRequired: false });
    updateGeneralSettings(getDb(), { allowAgentRecurringSchedules: true });
    const res = await postAgent({
      name: 'daily',
      promptTemplate: 'daily check',
      profileId,
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 86_400_000 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { enabled: boolean }; status: string };
    expect(body.job.enabled).toBe(true);
    expect(body.status).toBe('active');
  });

  // R2b — bypass-only profile rejected at CREATE, mirroring routes/spawn.ts:159-165,
  // so the operator learns immediately instead of at first tick.
  it('bypass-only profile rejected at create when global mode is prompt', async () => {
    const bypassOnly = catalogue.listProfiles().find((p) => p.enabled && p.agentType === 'pi');
    if (!bypassOnly) return; // catalogue has no bypass-only agent seeded: nothing to assert
    updateCompactionSettings(getDb(), { interactionMode: 'prompt' });
    const res = await postAgent(agentBody({ profileId: bypassOnly.id }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('does not support permission mode');
  });

  it('permission-capable profile still accepted when global mode is prompt', async () => {
    updateCompactionSettings(getDb(), { interactionMode: 'prompt' });
    const res = await postAgent(agentBody({ profileId }));
    expect(res.status).toBe(201);
  });
});

describe('Bearer schedule-create roster lock', () => {
  function attachRoster(conversationId: string, pid: string, name = 'team', role = 'impl') {
    saveTemplate(getDb(), { name, roles: [{ role, profileId: pid, when: 'test' }] });
    getDb().prepare('UPDATE conversations SET template_name = ? WHERE id = ?').run(name, conversationId);
    return name;
  }
  const offRoster = () => catalogue.listProfiles().find((p) => p.enabled && p.id !== profileId)!.id;

  it('bearer + template + off-roster profileId → 400', async () => {
    attachRoster(rootConvId, profileId);
    const res = await postAgent(agentBody({ profileId: offRoster() }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('profile not in parent template roster');
  });

  it('bearer + template + on-roster profileId → 201', async () => {
    attachRoster(rootConvId, profileId);
    const res = await postAgent(agentBody({ profileId }));
    expect(res.status).toBe(201);
  });

  it('bearer + template + unknown role → 400', async () => {
    attachRoster(rootConvId, profileId);
    const res = await postAgent(agentBody({ role: 'nope' }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('not found in the conversation template');
  });

  it('bearer + template + foreign templateName → 400', async () => {
    attachRoster(rootConvId, profileId, 'mine');
    saveTemplate(getDb(), { name: 'other', roles: [{ role: 'x', profileId, when: 't' }] });
    const res = await postAgent(agentBody({ profileId, templateName: 'other' }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('templateName is not the conversation template');
  });

  it('bearer + no template + named profileId is ignored (defaults to last session)', async () => {
    const res = await postAgent(agentBody({ profileId: offRoster() }));
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { profileId: string } };
    expect(body.job.profileId).toBe(profileId);
  });

  it('cookie + off-roster profileId stays unrestricted', async () => {
    isAuthed = true;
    attachRoster(rootConvId, profileId);
    const off = offRoster();
    const res = await postAgent(agentBody({ profileId: off }), { token: null });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { profileId: string } };
    expect(body.job.profileId).toBe(off);
  });

  it('ignores executionMode and boundConversationId on agent create', async () => {
    const res = await postAgent(agentBody({
      profileId,
      executionMode: 'resume_conversation',
      boundConversationId: rootConvId,
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { executionMode: string; boundConversationId?: string | null } };
    expect(body.job.executionMode).toBe('spawn_child');
    expect(body.job.boundConversationId == null).toBe(true);
  });

  it('forces spawn_child when a pack job.executionMode is resume_conversation', async () => {
    const { upsertImportedPack } = await import('../repositories/schedulePacks.js');
    upsertImportedPack(getDb(), {
      slug: 'resume-pack',
      title: 'Resume Pack',
      description: 'd',
      version: 1,
      origin: 'imported',
      job: {
        cadence: { kind: 'once', fireInMs: 120_000 },
        promptTemplate: 'Ping the bound chat',
        executionMode: 'resume_conversation',
      },
    });
    const res = await postAgent(agentBody({
      profileId,
      packSlug: 'resume-pack',
      fireInMs: 120_000,
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { executionMode: string; boundConversationId?: string | null } };
    expect(body.job.executionMode).toBe('spawn_child');
    expect(body.job.boundConversationId == null).toBe(true);
  });

  it('persists variables on agent create and 400s on a bad map', async () => {
    const ok = await postAgent(agentBody({
      profileId,
      variables: { focus: 'audio' },
    }));
    expect(ok.status).toBe(201);
    const okBody = await ok.json() as { job: { variables?: Record<string, string> } };
    expect(okBody.job.variables).toEqual({ focus: 'audio' });

    const bad = await postAgent(agentBody({
      profileId,
      variables: { n: 3 },
    }));
    expect(bad.status).toBe(400);
    const badBody = await bad.json() as { error: string };
    expect(badBody.error).toMatch(/must be a string/);
  });
});

describe('GET /agent/schedule-help', () => {
  it('200 markdown from loopback', async () => {
    const res = await fetch(`${base}/agent/schedule-help`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toMatch(/markdown|text\/plain|text\/md/i);
    const text = await res.text();
    expect(text).toContain('Agent schedule creation');
    expect(text).toContain('/schedules/agent');
    expect(text).toContain('fireInMs');
    expect(text).toContain('fireAtMs');
    expect(text).toContain('once');
    expect(text).not.toMatch(/365/);
    expect(text).toContain('complete-job');
    expect(text).toContain('Discovering valid');
    // Resolve replaces the old "read the DB yourself" prose — and must not list the catalogue.
    expect(text).toContain('## Resolve (no query)');
    expect(text).toContain('resolve=');
    expect(text).toContain('inherits the');
    expect(text).toContain('Prefer `fireInMs`');
    expect(text).toContain('only if the operator asked to schedule');
    expect(text).toContain('Default is do not create');
    expect(text).toContain('do not schedule as a');
    expect(text).toContain('Do not GET this document unless you are about to create');
    expect(text).toContain('already contains');
    expect(text).toContain('300000'); // 5 min interval floor
    expect(text).toMatch(/interval.*disabled|always.*disabled|enabled: false/i);
    expect(text).toMatch(/Schedule browser.*Archive/i);
    expect(text).toMatch(/sidebar/i);
    expect(text).toContain('variables');
    expect(text).toContain('{{vars.<key>}}');
    expect(text).toMatch(/never put secrets in variables/i);
  });

  it('never dumps the catalogue: bare help omits every enabled profile id', async () => {
    const text = await (await fetch(`${base}/agent/schedule-help`)).text();
    const ids = catalogue.listProfiles().filter((p) => p.enabled).map((p) => p.id);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) expect(text).not.toContain(id);
  });

  it('resolve without a token → 401', async () => {
    const res = await fetch(`${base}/agent/schedule-help?resolve=opus`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/token/i);
  });

  it('resolve with a schedule-scoped token is allowed', async () => {
    const tok = issueSpawnToken(rootConvId, 'sess-root', 'schedule');
    const res = await fetch(`${base}/agent/schedule-help?resolve=opus`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
  });

  it('resolve returns the exact profileId for a fragment the agent already holds', async () => {
    const target = catalogue.listProfiles().find((p) => p.enabled)!;
    const fragment = target.id.split(':')[1] ?? target.id;
    const text = await (await fetch(
      `${base}/agent/schedule-help?resolve=${encodeURIComponent(fragment)}`,
      { headers: { Authorization: `Bearer ${agentToken()}` } },
    )).text();
    expect(text).toContain(`## Resolve: "${fragment}"`);
    expect(text).toContain(target.id);
    // Cap holds — a fragment must never return the whole catalogue.
    const listed = catalogue.listProfiles().filter((p) => p.enabled && text.includes(p.id));
    expect(listed.length).toBeLessThanOrEqual(5);
  });

  it('resolve rejects sub-minimum queries instead of matching everything', async () => {
    const text = await (await fetch(
      `${base}/agent/schedule-help?resolve=a`,
      { headers: { Authorization: `Bearer ${agentToken()}` } },
    )).text();
    expect(text).toContain('## Resolve (no query)');
    for (const p of catalogue.listProfiles()) expect(text).not.toContain(p.id);
  });

  it('resolve reports no match without suggesting alternatives', async () => {
    const text = await (await fetch(
      `${base}/agent/schedule-help?resolve=zzzznotathing`,
      { headers: { Authorization: `Bearer ${agentToken()}` } },
    )).text();
    expect(text).toContain('no match');
    expect(text).toContain('ask the operator');
    for (const p of catalogue.listProfiles()) expect(text).not.toContain(p.id);
  });

  it('403 when remoteAddress is a public IP', async () => {
    // Remount with non-loopback spoof.
    await new Promise<void>((r) => server.close(() => r()));
    const app = mountApp({ loopback: false });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const addr = server.address();
    base = `http://127.0.0.1:${(addr as { port: number }).port}`;

    const res = await fetch(`${base}/agent/schedule-help`);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('loopback only');
  });
});

describe('operator create still defaults createdBy operator', () => {
  it('POST /projects/:id/schedules stamps createdBy operator', async () => {
    const res = await fetch(`${base}/projects/${projectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'op job',
        timezone: 'UTC',
        scheduleKind: 'interval',
        scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
        profileId,
        promptTemplate: 'hi',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { createdBy: string } };
    expect(body.job.createdBy).toBe('operator');
  });
});

describe('agent create: remote host availability (Task 11)', () => {
  it('remote project + uninstalled agent → 400 reason agent_not_installed', async () => {
    const { createPendingHost } = await import('../repositories/remoteHosts.js');
    const db = getDb();
    const host = createPendingHost(db, 'box', 'h-agent-avail', Date.now() + 60_000);
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
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const remoteProjectId = createProject(db, {
      name: 'remote',
      rootPath: '/tmp/remote-agent',
      remoteHostId: host.id,
    }).id;
    const remoteConv = createConversation(db, { projectId: remoteProjectId, title: 'remote root' }).id;
    createSession(db, {
      id: 'sess-remote',
      conversationId: remoteConv,
      agentId: 'claude-code',
      agentModelId: 'claude-code:opus-4.8',
    });
    const tok = issueSpawnToken(remoteConv, 'sess-remote', 'spawn');
    const res = await postAgent(
      agentBody({ profileId: 'claude-code:opus-4.8' }),
      { token: tok, projectId: remoteProjectId },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; reason?: string };
    expect(body).toMatchObject({ error: 'not available on host', reason: 'agent_not_installed' });
    revokeSpawnTokensForSession('sess-remote');
  });
});
