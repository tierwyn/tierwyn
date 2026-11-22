import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../auth/middleware.js';
import * as timerRepo from '../repositories/conversationTimers.js';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { claimDueTimers } from '../repositories/conversationTimers.js';
import { catalogue } from '../catalogue.js';
import { registerConversationTimerRoutes } from './conversationTimers.js';
import { TIMER_MAX_PROMPT_CHARS } from '@tierwyn/shared';

const PROFILE_ID = 'claude-code:test-model';
const PI_PROFILE_ID = 'pi:test-model';
const NOW = 1_800_000_000_000;

let db: Database.Database;
let app: express.Express;
let convA: string;
let convB: string;

function seedProfile(): void {
  db.prepare(
    `INSERT INTO agents (id, type, label, created_at)
     VALUES ('claude-code', 'claude-code', 'Claude Code', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, 'claude-code', 'test-model', 'Test', 1, ?)`,
  ).run(PROFILE_ID, NOW);
  db.prepare(
    `INSERT INTO agents (id, type, label, created_at)
     VALUES ('pi', 'pi', 'Pi', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, 'pi', 'test-model', 'Pi Test', 1, ?)`,
  ).run(PI_PROFILE_ID, NOW);
  catalogue.load(db);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedProfile();
  const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
  convA = createConversation(db, { projectId: project.id, title: 'A' }).id;
  convB = createConversation(db, { projectId: project.id, title: 'B' }).id;

  app = express();
  app.use(express.json());
  registerConversationTimerRoutes(app, { getDb: () => db, now: () => NOW });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const body = { prompt: 'run the tests', profileId: PROFILE_ID };

describe('POST /conversations/:id/timers', () => {
  it('creates a timer from a relative delay', async () => {
    const res = await call('POST', `/conversations/${convA}/timers`, { ...body, fireInMs: 90_000 });
    expect(res.status).toBe(201);
    expect(res.body.timer).toMatchObject({
      conversationId: convA, prompt: 'run the tests', profileId: PROFILE_ID,
      fireAtMs: NOW + 90_000, firedAt: null, cancelledAt: null,
    });
  });

  it('creates a timer from an absolute fire time', async () => {
    const at = NOW + 26 * 60 * 60 * 1000;   // crosses a day boundary
    const res = await call('POST', `/conversations/${convA}/timers`, { ...body, fireAtMs: at });
    expect(res.status).toBe(201);
    expect(res.body.timer.fireAtMs).toBe(at);
  });

  it('rejects the v1 five-second delay — the floor is now one minute', async () => {
    const res = await call('POST', `/conversations/${convA}/timers`, { ...body, fireInMs: 5_000 });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range, both-fields, neither-field and empty prompt', async () => {
    const bad = [
      { ...body, fireInMs: 59_999 },
      { ...body, fireInMs: 7 * 24 * 60 * 60 * 1000 + 1 },
      { ...body, fireInMs: 60_000, fireAtMs: NOW + 60_000 },
      { ...body },
      { prompt: '   ', profileId: PROFILE_ID, fireInMs: 60_000 },
      { prompt: 'x', profileId: 'no-such:profile', fireInMs: 60_000 },
    ];
    for (const payload of bad) {
      const res = await call('POST', `/conversations/${convA}/timers`, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
    const count = db.prepare('SELECT COUNT(*) c FROM conversation_timers').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('404s for an unknown conversation', async () => {
    const res = await call('POST', '/conversations/nope/timers', { ...body, fireInMs: 60_000 });
    expect(res.status).toBe(404);
  });
});

describe('GET /conversations/:id/timers', () => {
  it('is conversation-scoped', async () => {
    await call('POST', `/conversations/${convA}/timers`, { ...body, fireInMs: 60_000 });
    const listA = await call('GET', `/conversations/${convA}/timers`);
    const listB = await call('GET', `/conversations/${convB}/timers`);
    expect(listA.body.timers).toHaveLength(1);
    expect(listB.body.timers).toEqual([]);
  });
});

describe('DELETE /conversations/:id/timers/:timerId', () => {
  it('cancels a pending timer', async () => {
    const created = await call('POST', `/conversations/${convA}/timers`, { ...body, fireInMs: 60_000 });
    const id = created.body.timer.id;
    const res = await call('DELETE', `/conversations/${convA}/timers/${id}`);
    expect(res.status).toBe(204);
    const list = await call('GET', `/conversations/${convA}/timers`);
    expect(list.body.timers).toEqual([]);
  });

  it('409s on an already-fired timer', async () => {
    const created = await call('POST', `/conversations/${convA}/timers`, { ...body, fireInMs: 60_000 });
    const id = created.body.timer.id;
    claimDueTimers(db, NOW + 60_000);
    const res = await call('DELETE', `/conversations/${convA}/timers/${id}`);
    expect(res.status).toBe(409);
  });

  it('404s when the timer belongs to another conversation', async () => {
    const created = await call('POST', `/conversations/${convA}/timers`, { ...body, fireInMs: 60_000 });
    const res = await call('DELETE', `/conversations/${convB}/timers/${created.body.timer.id}`);
    expect(res.status).toBe(404);
  });

  it('409s when the sweep claims the row between get and cancel', async () => {
    const created = await call('POST', `/conversations/${convA}/timers`, { ...body, fireInMs: 60_000 });
    const id = created.body.timer.id as string;
    const realCancel = timerRepo.cancelTimer;
    vi.spyOn(timerRepo, 'cancelTimer').mockImplementation((database, timerId, ts) => {
      // TOCTOU: claimDueTimers stamps fired_at after getTimer saw a pending row.
      timerRepo.claimDueTimers(database, NOW + 60_000);
      return realCancel(database, timerId, ts);
    });
    const res = await call('DELETE', `/conversations/${convA}/timers/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already fired or cancelled/);
  });
});

describe('timer routes auth', () => {
  it('returns 401 without a cookie when requireAuth is mounted', async () => {
    const authedApp = express();
    authedApp.use(express.json());
    authedApp.use(requireAuth({
      disabled: false,
      configured: true,
      sessionSecret: 'unit-test-session-secret-value-32bytes',
      passwordHash: 'not-used',
      cookieSecure: false,
    }));
    registerConversationTimerRoutes(authedApp, { getDb: () => db, now: () => NOW });
    const { createServer } = await import('node:http');
    const server = createServer(authedApp);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/conversations/${convA}/timers`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('registerConversationTimerRoutes is after requireAuth in index.ts', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), '../index.ts');
    const src = readFileSync(indexPath, 'utf8');
    const authIdx = src.indexOf('app.use(requireAuth(authConfig))');
    const timerIdx = src.indexOf('registerConversationTimerRoutes(');
    expect(authIdx).toBeGreaterThan(-1);
    expect(timerIdx).toBeGreaterThan(-1);
    expect(timerIdx).toBeGreaterThan(authIdx);
  });
});

describe('POST /conversations/:id/timers — send snapshot', () => {
  const ATT = [{ base64: 'QUJD', mediaType: 'text/plain', name: 'rebuild.log' }];

  it('stores effort, options, attachments and handoff override', async () => {
    const res = await call('POST', `/conversations/${convA}/timers`, {
      ...body, fireInMs: 60_000,
      effort: 'high', options: { disableSlashCommands: true }, attachments: ATT,
      handoffOverride: 'transcript',
    });
    expect(res.status).toBe(201);
    expect(res.body.timer).toMatchObject({
      effort: 'high', handoffOverride: 'transcript', attachmentNames: ['rebuild.log'],
    });
    expect(res.body.timer.options).toEqual({ disableSlashCommands: true });
    expect(JSON.stringify(res.body)).not.toContain('QUJD');

    const row = db.prepare('SELECT attachments FROM conversation_timers').get() as { attachments: string };
    expect(JSON.parse(row.attachments)).toEqual(ATT);
  });

  it('drops an effort level the timer profile does not support instead of 400ing', async () => {
    // claude-code accepts low/medium/high/xhigh/max; 'turbo' is not an EffortLevel.
    const res = await call('POST', `/conversations/${convA}/timers`, {
      ...body, fireInMs: 60_000, effort: 'turbo',
    });
    expect(res.status).toBe(201);
    expect(res.body.timer.effort).toBeNull();
  });

  it('rejects a handoff override that is not summary or transcript', async () => {
    const res = await call('POST', `/conversations/${convA}/timers`, {
      ...body, fireInMs: 60_000, handoffOverride: 'magic',
    });
    expect(res.status).toBe(400);
  });

  it('applies the draft attachment caps', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      base64: 'QUJD', mediaType: 'text/plain', name: `f${i}.txt`,
    }));
    const res = await call('POST', `/conversations/${convA}/timers`, {
      ...body, fireInMs: 60_000, attachments: eleven,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too many attachments/);
  });

  it('rejects options that fail sanitisation for the timer profile', async () => {
    const res = await call('POST', `/conversations/${convA}/timers`, {
      ...body, fireInMs: 60_000, options: { jsonSchema: '-rm-rf' },
    });
    expect(res.status).toBe(400);
  });

  it('stores nulls when no snapshot is sent', async () => {
    const res = await call('POST', `/conversations/${convA}/timers`, { ...body, fireInMs: 60_000 });
    expect(res.status).toBe(201);
    expect(res.body.timer).toMatchObject({
      effort: null, options: null, attachmentNames: [], handoffOverride: null,
    });
  });
});

describe('PATCH /conversations/:id/timers/:timerId', () => {
  async function pendingTimer(extra: Record<string, unknown> = {}) {
    const created = await call('POST', `/conversations/${convA}/timers`, {
      ...body, fireInMs: 120_000, ...extra,
    });
    expect(created.status).toBe(201);
    return created.body.timer as { id: string; fireAtMs: number; prompt: string };
  }

  it('404s for an unknown timer id', async () => {
    const res = await call('PATCH', `/conversations/${convA}/timers/nope`, { prompt: 'x' });
    expect(res.status).toBe(404);
  });

  it('404s when the timer belongs to another conversation', async () => {
    const t = await pendingTimer();
    const res = await call('PATCH', `/conversations/${convB}/timers/${t.id}`, { prompt: 'x' });
    expect(res.status).toBe(404);
  });

  it('409s on an already-fired timer', async () => {
    const t = await pendingTimer();
    claimDueTimers(db, NOW + 120_000);
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, { prompt: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already fired or cancelled/);
  });

  it('409s on an already-cancelled timer', async () => {
    const t = await pendingTimer();
    await call('DELETE', `/conversations/${convA}/timers/${t.id}`);
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, { prompt: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already fired or cancelled/);
  });

  it('[S3-4] PATCH never rewrites origin — even if the body asks for it', async () => {
    // Deferrals stamp agent-resume at the spawn route; an operator re-timing
    // that timer must not silently convert it to an operator-origin row
    // (origin decides whether a fresh prompt cancels it — see S2-2).
    const agentTimer = timerRepo.createTimer(db, {
      conversationId: convA, prompt: 'auto-resume after limit', profileId: PROFILE_ID,
      fireAtMs: NOW + 120_000, origin: 'agent-resume', attempt: 1,
    });
    const res = await call('PATCH', `/conversations/${convA}/timers/${agentTimer.id}`, {
      prompt: 'operator retimed', fireInMs: 300_000, origin: 'operator',
    });
    expect(res.status).toBe(200);
    expect((res.body.timer as { origin: string }).origin).toBe('agent-resume');
    const row = db.prepare('SELECT origin FROM conversation_timers WHERE id = ?')
      .get(agentTimer.id) as { origin: string };
    expect(row.origin).toBe('agent-resume');
  });

  it('400s on an empty prompt', async () => {
    const t = await pendingTimer();
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, { prompt: '   ' });
    expect(res.status).toBe(400);
  });

  it('400s on an over-length prompt', async () => {
    const t = await pendingTimer();
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      prompt: 'x'.repeat(TIMER_MAX_PROMPT_CHARS + 1),
    });
    expect(res.status).toBe(400);
  });

  it('400s on an unknown or disabled profile', async () => {
    const t = await pendingTimer();
    const unknown = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      profileId: 'no-such:profile',
    });
    expect(unknown.status).toBe(400);

    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
       VALUES ('claude-code:off', 'claude-code', 'off', 'Off', 0, ?)`,
    ).run(NOW);
    catalogue.load(db);
    const disabled = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      profileId: 'claude-code:off',
    });
    expect(disabled.status).toBe(400);
  });

  it('400s when both fireInMs and fireAtMs are sent', async () => {
    const t = await pendingTimer();
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      fireInMs: 60_000, fireAtMs: NOW + 60_000,
    });
    expect(res.status).toBe(400);
  });

  it('400s when the new fire time is under 1 minute', async () => {
    const t = await pendingTimer();
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, { fireInMs: 30_000 });
    expect(res.status).toBe(400);
  });

  it('400s when the new fire time is over 7 days', async () => {
    const t = await pendingTimer();
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      fireInMs: 7 * 24 * 60 * 60 * 1000 + 1,
    });
    expect(res.status).toBe(400);
  });

  it('200 with neither time field leaves fireAtMs untouched', async () => {
    const t = await pendingTimer();
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      prompt: 'just the text',
    });
    expect(res.status).toBe(200);
    expect(res.body.timer.fireAtMs).toBe(t.fireAtMs);
    expect(res.body.timer.prompt).toBe('just the text');
  });

  it('re-clamps effort when profileId changes to an agent that does not support it', async () => {
    const t = await pendingTimer({ effort: 'xhigh' });
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      profileId: PI_PROFILE_ID,
    });
    expect(res.status).toBe(200);
    expect(res.body.timer.profileId).toBe(PI_PROFILE_ID);
    expect(res.body.timer.effort).toBeNull();
  });

  it('clears options when agentType changes and options were omitted', async () => {
    const t = await pendingTimer({ options: { disableSlashCommands: true } });
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      profileId: PI_PROFILE_ID,
    });
    expect(res.status).toBe(200);
    expect(res.body.timer.options).toBeNull();
  });

  it('200 body is { timer }', async () => {
    const t = await pendingTimer();
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, { prompt: 'renamed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timer: expect.objectContaining({ id: t.id, prompt: 'renamed' }) });
    expect(Object.keys(res.body)).toEqual(['timer']);
  });

  it('PATCH { effort: null } clears effort and leaves the rest', async () => {
    const t = await pendingTimer({
      effort: 'high', options: { disableSlashCommands: true }, handoffOverride: 'transcript',
    });
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, { effort: null });
    expect(res.status).toBe(200);
    expect(res.body.timer.effort).toBeNull();
    expect(res.body.timer.options).toEqual({ disableSlashCommands: true });
    expect(res.body.timer.handoffOverride).toBe('transcript');
    expect(res.body.timer.prompt).toBe(t.prompt);
    expect(res.body.timer.fireAtMs).toBe(t.fireAtMs);
  });

  it('omitting attachments on PATCH preserves attachmentNames and bodies', async () => {
    const att = [{ base64: 'QUJD', mediaType: 'text/plain', name: 'rebuild.log' }];
    const t = await pendingTimer({ attachments: att });
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, { prompt: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.timer.prompt).toBe('x');
    expect(res.body.timer.attachmentNames).toEqual(['rebuild.log']);
    expect(JSON.stringify(res.body)).not.toContain('QUJD');
    const row = db.prepare(
      'SELECT attachments FROM conversation_timers WHERE id = ?',
    ).get(t.id) as { attachments: string };
    expect(JSON.parse(row.attachments)).toEqual(att);
  });

  it('accepts handoffOverride summary / transcript / null and 400s garbage', async () => {
    const t = await pendingTimer();
    const summary = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      handoffOverride: 'summary',
    });
    expect(summary.status).toBe(200);
    expect(summary.body.timer.handoffOverride).toBe('summary');

    const fresh = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      handoffOverride: 'fresh',
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.timer.handoffOverride).toBe('fresh');

    const transcript = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      handoffOverride: 'transcript',
    });
    expect(transcript.status).toBe(200);
    expect(transcript.body.timer.handoffOverride).toBe('transcript');

    const cleared = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      handoffOverride: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.timer.handoffOverride).toBeNull();

    const garbage = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      handoffOverride: 'magic',
    });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error).toMatch(/handoffOverride must be "summary", "transcript", "fresh" or null/);
    expect(getTimerAfter(t.id)?.handoffOverride).toBeNull();
  });

  it('preserves options when profileId changes within the same agentType', async () => {
    const otherId = 'claude-code:other-model';
    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
       VALUES (?, 'claude-code', 'other-model', 'Other', 1, ?)`,
    ).run(otherId, NOW);
    catalogue.load(db);

    const t = await pendingTimer({ options: { disableSlashCommands: true }, effort: 'high' });
    const res = await call('PATCH', `/conversations/${convA}/timers/${t.id}`, {
      profileId: otherId,
    });
    expect(res.status).toBe(200);
    expect(res.body.timer.profileId).toBe(otherId);
    expect(res.body.timer.options).toEqual({ disableSlashCommands: true });
    expect(res.body.timer.effort).toBe('high');
  });
});

describe('GET /timers/pending', () => {
  it('returns all pending timers with the server clock', async () => {
    timerRepo.createTimer(db, { conversationId: convA, prompt: 'op', profileId: PROFILE_ID, fireAtMs: NOW + 200_000 });
    timerRepo.createTimer(db, { conversationId: convB, prompt: 'self', profileId: PROFILE_ID, fireAtMs: NOW + 100_000, origin: 'agent-self' });
    const res = await call('GET', '/timers/pending');
    expect(res.status).toBe(200);
    expect(res.body.now).toBe(NOW);
    expect(res.body.truncated).toBe(false);
    expect(res.body.timers.map((t: any) => t.origin)).toEqual(['agent-self', 'operator']);
  });
  it('is empty when nothing is pending', async () => {
    const res = await call('GET', '/timers/pending');
    expect(res.body).toEqual({ now: NOW, truncated: false, timers: [] });
  });
});

function getTimerAfter(id: string): { handoffOverride: string | null } | undefined {

  const row = db.prepare(
    'SELECT handoff_override FROM conversation_timers WHERE id = ?',
  ).get(id) as { handoff_override: string | null } | undefined;
  return row ? { handoffOverride: row.handoff_override } : undefined;
}

/** Minimal in-process request helper — mirrors routes/btw.test.ts. */
async function call(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(payload === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}
