import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { formatIsoLocalInTimezone } from '@tierwyn/shared';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createJob, getJob } from '../repositories/schedules.js';
import { createScheduleHomeConversation } from '../repositories/conversations.js';
import { computeNextFireAt } from '../schedules/nextFire.js';
import { registerScheduleRoutes, type JobSchedulerLike, type ScheduleCalendarResponse } from './schedules.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

let server: Server;
let base: string;
let projectId: string;

beforeEach(async () => {
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  setDb(db);
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;

  const app = express();
  app.use(express.json());
  const stubScheduler: JobSchedulerLike = { runNow: vi.fn(async (jobId: string) => ({ ok: true as const, runId: `run-${jobId}` })) };
  registerScheduleRoutes(app, { getDb, jobScheduler: stubScheduler, broadcast: () => {} } as never);
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

/** Insert a job directly (fast, no HTTP) with a home conversation, as the create route does. */
function makeJob(overrides: Record<string, unknown> = {}) {
  const db = getDb();
  const home = createScheduleHomeConversation(db, { projectId, jobName: 'j' });
  return createJob(db, {
    projectId,
    name: 'job',
    timezone: 'UTC',
    scheduleKind: 'interval',
    scheduleExpr: JSON.stringify({ everyMs: HOUR }),
    profileId: 'claude-code:opus-4.8',
    homeConversationId: home.id,
    promptTemplate: 'go',
    nextFireAt: Date.now() + HOUR,
    ...overrides,
  } as never);
}

/** Second project + a job in it, for the cross-project (All) scope. */
function makeOtherProject(name = 'q'): string {
  return createProject(getDb(), { name, rootPath: `/tmp/${name}` }).id;
}

/** Insert a job into an explicit project. */
function makeJobIn(pid: string, overrides: Record<string, unknown> = {}) {
  const db = getDb();
  const home = createScheduleHomeConversation(db, { projectId: pid, jobName: 'j' });
  return createJob(db, {
    projectId: pid,
    name: 'job',
    timezone: 'UTC',
    scheduleKind: 'interval',
    scheduleExpr: JSON.stringify({ everyMs: HOUR }),
    profileId: 'claude-code:opus-4.8',
    homeConversationId: home.id,
    promptTemplate: 'go',
    nextFireAt: Date.now() + HOUR,
    ...overrides,
  } as never);
}

async function calendar(from: number, to: number): Promise<{ status: number; body: ScheduleCalendarResponse & { error?: string } }> {
  const res = await fetch(`${base}/projects/${projectId}/schedules/calendar?from=${from}&to=${to}`);
  return { status: res.status, body: await res.json() as ScheduleCalendarResponse & { error?: string } };
}

async function globalCalendar(
  from: number, to: number, scopeProjectId?: string,
): Promise<{ status: number; body: ScheduleCalendarResponse & { error?: string } }> {
  const qs = `from=${from}&to=${to}${scopeProjectId ? `&projectId=${scopeProjectId}` : ''}`;
  const res = await fetch(`${base}/schedules/calendar?${qs}`);
  return { status: res.status, body: await res.json() as ScheduleCalendarResponse & { error?: string } };
}

describe('GET /projects/:projectId/schedules/calendar — validation', () => {
  it('404s for an unknown project', async () => {
    const res = await fetch(`${base}/projects/nope/schedules/calendar?from=1&to=2`);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('no such project');
  });

  it('is not swallowed by the /:jobId route', async () => {
    // Regression for the registration-order trap: `calendar` must not parse as a jobId.
    const { status, body } = await calendar(Date.now(), Date.now() + DAY);
    expect(status).toBe(200);
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it('400s when from/to are missing, non-numeric, or inverted', async () => {
    const missing = await fetch(`${base}/projects/${projectId}/schedules/calendar`);
    expect(missing.status).toBe(400);

    const nan = await fetch(`${base}/projects/${projectId}/schedules/calendar?from=abc&to=123`);
    expect(nan.status).toBe(400);

    const now = Date.now();
    const inverted = await calendar(now + DAY, now);
    expect(inverted.status).toBe(400);
    expect(inverted.body.error).toBe('from and to must be finite UTC ms with to > from');
  });

  it('400s when the window is longer than 62 days', async () => {
    const now = Date.now();
    const { status, body } = await calendar(now, now + 63 * DAY);
    expect(status).toBe(400);
    expect(body.error).toBe('calendar window must be 62 days or less');
  });

  it('echoes the requested from/to unchanged', async () => {
    const now = Date.now();
    const { body } = await calendar(now, now + DAY);
    expect(body.from).toBe(now);
    expect(body.to).toBe(now + DAY);
  });
});

describe('GET .../calendar — interval projection', () => {
  it('projects hourly fires across the window with the same phase as computeNextFireAt', async () => {
    const job = makeJob({ scheduleExpr: JSON.stringify({ everyMs: HOUR }) });
    const now = Date.now() + 10_000;
    const { body } = await calendar(now, now + 6 * HOUR);
    const entry = body.jobs.find((j) => j.jobId === job.id)!;

    expect(entry.fires.length).toBeGreaterThanOrEqual(5);
    expect(entry.fires.length).toBeLessThanOrEqual(6);
    // Ascending, inside the window, strictly in the future.
    for (let i = 0; i < entry.fires.length; i++) {
      expect(entry.fires[i]).toBeGreaterThanOrEqual(now);
      expect(entry.fires[i]).toBeLessThanOrEqual(now + 6 * HOUR);
      if (i > 0) expect(entry.fires[i] - entry.fires[i - 1]).toBe(HOUR);
    }
    // Phase must match the scheduler's own arithmetic, not a nextFireAt+everyMs guess.
    const stored = getJob(getDb(), job.id)!;
    const expectedFirst = computeNextFireAt({
      scheduleKind: stored.scheduleKind,
      scheduleExpr: stored.scheduleExpr,
      timezone: stored.timezone,
      afterMs: now - 1,
      createdAtMs: stored.createdAt,
    });
    expect(entry.fires[0]).toBe(expectedFirst);
  });

  it('clamps the window start to now — a fully past window yields no fires', async () => {
    const job = makeJob();
    const now = Date.now();
    const { body } = await calendar(now - 10 * DAY, now - 1 * DAY);
    const entry = body.jobs.find((j) => j.jobId === job.id)!;
    expect(entry.fires).toEqual([]);
    expect(entry.skipped).toEqual([]);
    expect(entry.truncated).toBe(false);
  });

  it('projects a month the operator navigated forward to (window start after nextFireAt)', async () => {
    const job = makeJob({ scheduleExpr: JSON.stringify({ everyMs: DAY }) });
    const now = Date.now();
    const from = now + 20 * DAY;
    const to = now + 25 * DAY;
    const { body } = await calendar(from, to);
    const entry = body.jobs.find((j) => j.jobId === job.id)!;
    expect(entry.fires.length).toBeGreaterThan(0);
    for (const t of entry.fires) {
      expect(t).toBeGreaterThanOrEqual(from);
      expect(t).toBeLessThanOrEqual(to);
    }
  });
});

describe('GET .../calendar — cron projection', () => {
  it('expands 5-field cron in the job timezone', async () => {
    const job = makeJob({
      scheduleKind: 'cron',
      scheduleExpr: '0 9 * * *',
      timezone: 'Europe/London',
    });
    const now = Date.now();
    const { body } = await calendar(now, now + 5 * DAY);
    const entry = body.jobs.find((j) => j.jobId === job.id)!;

    expect(entry.scheduleKind).toBe('cron');
    expect(entry.timezone).toBe('Europe/London');
    expect(entry.fires.length).toBeGreaterThanOrEqual(4);
    for (const t of entry.fires) {
      // 09:00 local wall time in the job timezone on every projected day.
      expect(formatIsoLocalInTimezone(t, 'Europe/London').slice(11)).toBe('09:00');
    }
  });

  it('does not 500 the whole month on a corrupt schedule_expr', async () => {
    const good = makeJob({ name: 'good' });
    const bad = makeJob({ name: 'bad', scheduleKind: 'cron', scheduleExpr: 'not a cron' });
    const now = Date.now();
    const { status, body } = await calendar(now, now + 2 * DAY);
    expect(status).toBe(200);
    expect(body.jobs.find((j) => j.jobId === bad.id)!.fires).toEqual([]);
    expect(body.jobs.find((j) => j.jobId === good.id)!.fires.length).toBeGreaterThan(0);
  });
});

describe('GET .../calendar — once jobs', () => {
  it('returns exactly one marker for a future once job', async () => {
    const at = Date.now() + 2 * DAY;
    const job = makeJob({ scheduleKind: 'once', scheduleExpr: JSON.stringify({ atMs: at }), nextFireAt: at });
    const now = Date.now();
    const { body } = await calendar(now, now + 5 * DAY);
    expect(body.jobs.find((j) => j.jobId === job.id)!.fires).toEqual([at]);
  });

  it('returns no marker for a once job whose time has passed', async () => {
    const at = Date.now() - 2 * DAY;
    const job = makeJob({ scheduleKind: 'once', scheduleExpr: JSON.stringify({ atMs: at }), nextFireAt: at });
    const now = Date.now();
    const { body } = await calendar(now, now + 5 * DAY);
    expect(body.jobs.find((j) => j.jobId === job.id)!.fires).toEqual([]);
  });
});

describe('GET .../calendar — job inclusion', () => {
  it('omits disabled jobs so they do not appear in the calendar', async () => {
    const job = makeJob({ enabled: false });
    const now = Date.now();
    const { body } = await calendar(now, now + 3 * HOUR);
    expect(body.jobs.find((j) => j.jobId === job.id)).toBeUndefined();
  });

  it('omits archived jobs entirely', async () => {
    const job = makeJob();
    getDb().prepare('UPDATE schedule_jobs SET archived = 1 WHERE id = ?').run(job.id);
    const now = Date.now();
    const { body } = await calendar(now, now + 3 * HOUR);
    expect(body.jobs.find((j) => j.jobId === job.id)).toBeUndefined();
  });

  it('carries the job name and id for every job in the project', async () => {
    const a = makeJob({ name: 'alpha' });
    const b = makeJob({ name: 'beta' });
    const now = Date.now();
    const { body } = await calendar(now, now + 3 * HOUR);
    const names = body.jobs.map((j) => j.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    expect(body.jobs.map((j) => j.jobId).sort()).toEqual([a.id, b.id].sort());
  });

  it('carries projectId and projectName on every job (D9)', async () => {
    makeJob({ name: 'alpha' });
    const now = Date.now();
    const { body } = await calendar(now, now + 3 * HOUR);
    for (const entry of body.jobs) {
      expect(entry.projectId).toBe(projectId);
      expect(entry.projectName).toBe('p');
    }
  });
});

describe('GET .../calendar — operator skips', () => {
  it('classifies an operator-skipped slot into skipped[], never fires[]', async () => {
    const job = makeJob({ scheduleExpr: JSON.stringify({ everyMs: HOUR }) });
    const now = Date.now();
    const before = await calendar(now, now + 6 * HOUR);
    const target = before.body.jobs.find((j) => j.jobId === job.id)!.fires[1];
    expect(target).toBeGreaterThan(0);

    const skipRes = await fetch(`${base}/projects/${projectId}/schedules/${job.id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireAtMs: target, mode: 'this' }),
    });
    expect(skipRes.status).toBe(200);

    const after = await calendar(now, now + 6 * HOUR);
    const entry = after.body.jobs.find((j) => j.jobId === job.id)!;
    expect(entry.skipped).toContain(target);
    expect(entry.fires).not.toContain(target);
    // Neighbours are untouched — a hole-punch, not a clock jump.
    expect(entry.fires).toContain(target - HOUR);
    expect(entry.fires).toContain(target + HOUR);
  });
});

describe('GET .../calendar — caps', () => {
  it('truncates a dense job at 200 fires and flags truncated', async () => {
    const job = makeJob({ scheduleExpr: JSON.stringify({ everyMs: 1_000 }) });
    const now = Date.now();
    const { body } = await calendar(now, now + DAY);
    const entry = body.jobs.find((j) => j.jobId === job.id)!;
    expect(entry.fires).toHaveLength(200);
    expect(entry.truncated).toBe(true);
    // Chronological prefix, not a subsample.
    for (let i = 1; i < entry.fires.length; i++) {
      expect(entry.fires[i] - entry.fires[i - 1]).toBe(1_000);
    }
  });

  it('does not flag truncated when the whole window fits', async () => {
    const job = makeJob({ scheduleExpr: JSON.stringify({ everyMs: HOUR }) });
    const now = Date.now();
    const { body } = await calendar(now, now + 3 * HOUR);
    const entry = body.jobs.find((j) => j.jobId === job.id)!;
    expect(entry.truncated).toBe(false);
  });

  it('shrinks the per-job cap so a busy project stays under the global budget', async () => {
    for (let i = 0; i < 25; i++) makeJob({ name: `j${i}`, scheduleExpr: JSON.stringify({ everyMs: 1_000 }) });
    const now = Date.now();
    const { body } = await calendar(now, now + DAY);
    expect(body.jobs).toHaveLength(25);
    // floor(2000 / 25) = 80 per job.
    for (const entry of body.jobs) expect(entry.fires).toHaveLength(80);
    const total = body.jobs.reduce((n, j) => n + j.fires.length, 0);
    expect(total).toBeLessThanOrEqual(2000);
  });
});

describe('GET /schedules/calendar — scope', () => {
  it('is not swallowed by any /schedules/:jobId/... route (D2)', async () => {
    const now = Date.now();
    const { status, body } = await globalCalendar(now, now + DAY);
    expect(status).toBe(200);
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.from).toBe(now);
    expect(body.to).toBe(now + DAY);
  });

  it('returns jobs from every project when projectId is omitted', async () => {
    const a = makeJob({ name: 'alpha' });
    const other = makeOtherProject('q');
    const b = makeJobIn(other, { name: 'beta' });
    const now = Date.now();
    const { body } = await globalCalendar(now, now + 3 * HOUR);
    expect(body.jobs.map((j) => j.jobId).sort()).toEqual([a.id, b.id].sort());
    expect(body.jobs.map((j) => j.projectName).sort()).toEqual(['p', 'q']);
  });

  it('scopes to one project when projectId is given', async () => {
    const a = makeJob({ name: 'alpha' });
    const other = makeOtherProject('q');
    makeJobIn(other, { name: 'beta' });
    const now = Date.now();
    const { body } = await globalCalendar(now, now + 3 * HOUR, projectId);
    expect(body.jobs.map((j) => j.jobId)).toEqual([a.id]);
    expect(body.jobs[0].projectId).toBe(projectId);
  });

  it('carries projectId and projectName on every job', async () => {
    makeJob({ name: 'alpha' });
    const other = makeOtherProject('q');
    makeJobIn(other, { name: 'beta' });
    const now = Date.now();
    const { body } = await globalCalendar(now, now + 3 * HOUR);
    const byName = Object.fromEntries(body.jobs.map((j) => [j.name, j]));
    expect(byName['alpha'].projectId).toBe(projectId);
    expect(byName['alpha'].projectName).toBe('p');
    expect(byName['beta'].projectId).toBe(other);
    expect(byName['beta'].projectName).toBe('q');
  });

  it('404s for an unknown projectId query param', async () => {
    const now = Date.now();
    const { status, body } = await globalCalendar(now, now + DAY, 'nope');
    expect(status).toBe(404);
    expect(body.error).toBe('no such project');
  });

  it('400s when from/to are missing, non-numeric, or inverted', async () => {
    const missing = await fetch(`${base}/schedules/calendar`);
    expect(missing.status).toBe(400);

    const nan = await fetch(`${base}/schedules/calendar?from=abc&to=123`);
    expect(nan.status).toBe(400);

    const now = Date.now();
    const inverted = await globalCalendar(now + DAY, now);
    expect(inverted.status).toBe(400);
    expect(inverted.body.error).toBe('from and to must be finite UTC ms with to > from');
  });

  it('400s when the window is longer than 62 days', async () => {
    const now = Date.now();
    const { status, body } = await globalCalendar(now, now + 63 * DAY);
    expect(status).toBe(400);
    expect(body.error).toBe('calendar window must be 62 days or less');
  });

  it('returns an empty jobs array when no project has schedules', async () => {
    makeOtherProject('q');
    const now = Date.now();
    const { status, body } = await globalCalendar(now, now + DAY);
    expect(status).toBe(200);
    expect(body.jobs).toEqual([]);
  });

  it('omits archived jobs in every project', async () => {
    const a = makeJob({ name: 'alpha' });
    const other = makeOtherProject('q');
    const b = makeJobIn(other, { name: 'beta' });
    getDb().prepare('UPDATE schedule_jobs SET archived = 1 WHERE id = ?').run(b.id);
    const now = Date.now();
    const { body } = await globalCalendar(now, now + 3 * HOUR);
    expect(body.jobs.map((j) => j.jobId)).toEqual([a.id]);
  });

  it('does not 500 the whole response when one project holds a corrupt job', async () => {
    const good = makeJob({ name: 'good' });
    const other = makeOtherProject('q');
    const bad = makeJobIn(other, { name: 'bad', scheduleKind: 'cron', scheduleExpr: 'not a cron' });
    const now = Date.now();
    const { status, body } = await globalCalendar(now, now + 2 * DAY);
    expect(status).toBe(200);
    expect(body.jobs.find((j) => j.jobId === bad.id)!.fires).toEqual([]);
    expect(body.jobs.find((j) => j.jobId === good.id)!.fires.length).toBeGreaterThan(0);
  });

  it('applies the fair-share cap over the TOTAL job count across projects (D1)', async () => {
    const dense = JSON.stringify({ everyMs: 1_000 });
    const other = makeOtherProject('q');
    for (let i = 0; i < 13; i++) makeJob({ name: `a${i}`, scheduleExpr: dense });
    for (let i = 0; i < 12; i++) makeJobIn(other, { name: `b${i}`, scheduleExpr: dense });
    const now = Date.now();
    const { body } = await globalCalendar(now, now + DAY);
    expect(body.jobs).toHaveLength(25);
    // floor(2000 / 25) = 80 per job — the same cap the per-project route would
    // apply to 25 jobs, NOT 80 for one project and 160 for the other.
    for (const entry of body.jobs) expect(entry.fires).toHaveLength(80);
    expect(body.jobs.reduce((n, j) => n + j.fires.length, 0)).toBeLessThanOrEqual(2000);
  });

  it('clamps the window start to now — a fully past window yields no fires', async () => {
    const job = makeJob();
    const now = Date.now();
    const { body } = await globalCalendar(now - 10 * DAY, now - 1 * DAY);
    const entry = body.jobs.find((j) => j.jobId === job.id)!;
    expect(entry.fires).toEqual([]);
    expect(entry.skipped).toEqual([]);
    expect(entry.truncated).toBe(false);
  });

  it('handles week-range (7 days) and day-range (1 day) queries properly', async () => {
    const job = makeJob({ scheduleExpr: JSON.stringify({ everyMs: HOUR }) });
    const now = Date.now();

    // 1-day query
    const dayRes = await globalCalendar(now, now + DAY);
    expect(dayRes.status).toBe(200);
    const dayEntry = dayRes.body.jobs.find((j) => j.jobId === job.id)!;
    expect(dayEntry.fires.length).toBeGreaterThanOrEqual(23);
    expect(dayEntry.fires.length).toBeLessThanOrEqual(25);

    // 7-day query
    const weekRes = await globalCalendar(now, now + 7 * DAY);
    expect(weekRes.status).toBe(200);
    const weekEntry = weekRes.body.jobs.find((j) => j.jobId === job.id)!;
    expect(weekEntry.fires.length).toBeGreaterThanOrEqual(160);
  });
});
