import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { Conversation, GrokBotLifecycleStatus } from '@tierwyn/shared';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { registerGrokBotRoutes, resetGrokBotCreateLockForTests } from './grokBot.js';
import type { GrokBotSupervisor } from '../adapters/grok-bot/supervisor.js';
import type { CdpLike } from '../adapters/grok-bot/cdp.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, ensureRemoteAgentsProject } from '../db/seed.js';
import { upsertDiscoveredModels } from '../repositories/models.js';
import { createRemoteAgentConversation, findRemoteAgentConversation } from '../repositories/remoteAgents.js';
import { readCursors } from '../repositories/grokBotWatch.js';
import { updateGeneralSettings } from '../repositories/settings.js';

function status(over: Partial<GrokBotLifecycleStatus> = {}): GrokBotLifecycleStatus {
  return {
    state: 'stopped',
    enabled: true,
    autoStart: 'keep-running',
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

function stub(over: Partial<GrokBotSupervisor> = {}): GrokBotSupervisor & { ensure: ReturnType<typeof vi.fn> } {
  const snap = status();
  const ensure = vi.fn(async () => snap);
  return {
    start: () => undefined,
    stop: () => undefined,
    status: () => snap,
    ensureRunning: ensure,
    kick: () => undefined,
    refresh: () => undefined,
    probeIfStale: async () => snap,
    ensure,
    ...over,
  };
}

async function call(app: express.Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { error: text }; }
    }
    return { status: r.status, json };
  } finally { server.close(); }
}

function dummyClient(): CdpLike {
  return {
    async evaluate() { return null; },
    async send() { return {}; },
    on() { return () => undefined; },
    async close() { /* noop */ },
  };
}

function memoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  ensureRemoteAgentsProject(db);
  return db;
}

function convCount(db: ReturnType<typeof memoryDb>): number {
  return (db.prepare(
    'SELECT COUNT(*) AS n FROM conversations WHERE project_id = ?',
  ).get(REMOTE_AGENTS_PROJECT_ID) as { n: number }).n;
}

const NEW_BOT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function appWith(sup: GrokBotSupervisor, deps: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  registerGrokBotRoutes(app, sup, deps as never);
  return app;
}

describe('registerGrokBotRoutes', () => {
  it('GET /grok-bot/status returns the status shape', async () => {
    const sup = stub({ probeIfStale: async () => status({ state: 'running' }) });
    const res = await call(appWith(sup), 'GET', '/grok-bot/status');
    expect(res.status).toBe(200);
    expect((res.json as GrokBotLifecycleStatus).state).toBe('running');
  });

  it('POST 400 on a bad/missing reason and on extra command/path fields', async () => {
    const app = appWith(stub());
    expect((await call(app, 'POST', '/grok-bot/start', {})).status).toBe(400);
    expect((await call(app, 'POST', '/grok-bot/start', { reason: 'prompt' })).status).toBe(400);
    expect((await call(app, 'POST', '/grok-bot/start', { reason: 'manual', command: 'x' })).status).toBe(400);
    expect((await call(app, 'POST', '/grok-bot/start', { reason: 'manual', path: '/opt/x' })).status).toBe(400);
  });

  it('POST 409 when disabled', async () => {
    const snap = status({ enabled: false, state: 'disabled' });
    const sup = stub({ status: () => snap });
    const res = await call(appWith(sup), 'POST', '/grok-bot/start', { reason: 'manual' });
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/disabled/i);
  });

  it('POST 202 fire-and-forget ensureRunning', async () => {
    let resolve!: (s: GrokBotLifecycleStatus) => void;
    const hung = new Promise<GrokBotLifecycleStatus>((r) => { resolve = r; });
    const ensure = vi.fn(() => hung);
    const sup = stub({ ensureRunning: ensure });
    const res = await call(appWith(sup), 'POST', '/grok-bot/start', { reason: 'on-demand' });
    expect(res.status).toBe(202);
    expect(ensure).toHaveBeenCalledWith('on-demand');
    resolve(status({ state: 'starting' }));
  });
});

describe('POST /grok-bot/bots', () => {
  const longTitle = 'x'.repeat(121);

  beforeEach(() => {
    resetGrokBotCreateLockForTests();
  });

  it('400s when title is missing, blank, or too long', async () => {
    const db = memoryDb();
    const app = appWith(stub(), { getDb: () => db, getClient: async () => dummyClient() });
    expect((await call(app, 'POST', '/grok-bot/bots', {})).status).toBe(400);
    expect((await call(app, 'POST', '/grok-bot/bots', { title: '  ' })).status).toBe(400);
    expect((await call(app, 'POST', '/grok-bot/bots', { title: longTitle })).status).toBe(400);
    expect(convCount(db)).toBe(0);
  });

  it('409s when Grok Bot is disabled without calling createAgent', async () => {
    const snap = status({ enabled: false, state: 'disabled' });
    const create = vi.fn();
    const app = appWith(stub({ status: () => snap }), {
      getDb: () => memoryDb(),
      createAgent: create,
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/disabled/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('201s a Remote Agents conversation after CDP create', async () => {
    const db = memoryDb();
    const catalogue = vi.fn();
    const ensure = vi.fn(async () => status({ state: 'running' }));
    const app = appWith(stub({ ensureRunning: ensure }), {
      getDb: () => db,
      getClient: async () => dummyClient(),
      createAgent: async () => NEW_BOT,
      readRoster: async () => [{ id: NEW_BOT, name: 'Inbox' }],
      onCatalogueChanged: catalogue,
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(201);
    expect(ensure).toHaveBeenCalledWith('manual');
    const conv = (res.json as { conversation: Conversation }).conversation;
    expect(conv.title).toBe('Inbox');
    expect(conv.projectId).toBe(REMOTE_AGENTS_PROJECT_ID);
    expect(findRemoteAgentConversation(db, NEW_BOT)?.id).toBe(conv.id);
    expect(catalogue).toHaveBeenCalled();
  });

  it('arms watcher backfill (empty entryId, K from settings) and kicks tickNow', async () => {
    const db = memoryDb();
    const tickNow = vi.fn(async () => undefined);
    const app = appWith(stub(), {
      getDb: () => db,
      getClient: async () => dummyClient(),
      createAgent: async () => NEW_BOT,
      readRoster: async () => [{ id: NEW_BOT, name: 'Inbox', newestEntryId: 'welcome-1' }],
      tickNow,
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(201);
    const cursor = readCursors(db)[NEW_BOT];
    expect(cursor?.entryId).toBe('');
    expect(cursor?.backfill).toBe(200);
    expect(cursor?.seq).toBe(0);
    expect(cursor?.name).toBe('Inbox');
    expect(tickNow).toHaveBeenCalledTimes(1);
  });

  it('when K=0 arms cursor at newestEntryId without backfill and still kicks tickNow', async () => {
    const db = memoryDb();
    updateGeneralSettings(db, { grokBotBackfillEntries: 0 });
    const tickNow = vi.fn(async () => undefined);
    const app = appWith(stub(), {
      getDb: () => db,
      getClient: async () => dummyClient(),
      createAgent: async () => NEW_BOT,
      readRoster: async () => [{ id: NEW_BOT, name: 'Inbox', newestEntryId: 'welcome-1' }],
      tickNow,
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(201);
    const cursor = readCursors(db)[NEW_BOT];
    expect(cursor?.entryId).toBe('welcome-1');
    expect(cursor?.backfill).toBeUndefined();
    expect(tickNow).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm cursors when the watcher already created the conversation', async () => {
    const db = memoryDb();
    upsertDiscoveredModels(db, 'grok-bot', [{
      name: NEW_BOT, label: 'Grok Bot · Inbox', provider: 'xai', vision: false, steer: true,
    }]);
    createRemoteAgentConversation(db, NEW_BOT, 'Inbox');
    const tickNow = vi.fn(async () => undefined);
    const app = appWith(stub(), {
      getDb: () => db,
      getClient: async () => dummyClient(),
      createAgent: async () => NEW_BOT,
      readRoster: async () => [{ id: NEW_BOT, name: 'Inbox', newestEntryId: 'welcome-1' }],
      tickNow,
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(200);
    expect(readCursors(db)[NEW_BOT]).toBeUndefined();
    expect(tickNow).not.toHaveBeenCalled();
  });

  it('returns the existing conversation when the watcher already created it', async () => {
    const db = memoryDb();
    upsertDiscoveredModels(db, 'grok-bot', [{
      name: NEW_BOT, label: 'Grok Bot · Inbox', provider: 'xai', vision: false, steer: true,
    }]);
    const existingId = createRemoteAgentConversation(db, NEW_BOT, 'Inbox');
    const app = appWith(stub(), {
      getDb: () => db,
      getClient: async () => dummyClient(),
      createAgent: async () => NEW_BOT,
      readRoster: async () => [{ id: NEW_BOT, name: 'Inbox' }],
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(200);
    expect((res.json as { conversation: Conversation }).conversation.id).toBe(existingId);
    expect(convCount(db)).toBe(1);
  });

  it('502s and writes no conversation when CDP create fails', async () => {
    const db = memoryDb();
    const app = appWith(stub(), {
      getDb: () => db,
      getClient: async () => dummyClient(),
      createAgent: async () => null,
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toMatch(/create/i);
    expect(convCount(db)).toBe(0);
  });

  it('502s and writes no conversation when CDP connect throws', async () => {
    const db = memoryDb();
    const app = appWith(stub(), {
      getDb: () => db,
      getClient: async () => { throw new Error('CDP unreachable on 127.0.0.1:9333'); },
      createAgent: async () => NEW_BOT,
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toMatch(/CDP|unreachable|connect/i);
    expect(convCount(db)).toBe(0);
  });

  it('skips catalogue upsert when post-create roster read fails (does not disable other Bots)', async () => {
    const db = memoryDb();
    const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    upsertDiscoveredModels(db, 'grok-bot', [{
      name: OTHER, label: 'Grok Bot · Other', provider: 'xai', vision: false, steer: true,
    }]);
    createRemoteAgentConversation(db, OTHER, 'Other');
    const catalogue = vi.fn();
    const app = appWith(stub(), {
      getDb: () => db,
      getClient: async () => dummyClient(),
      createAgent: async () => NEW_BOT,
      readRoster: async () => { throw new Error('roster read failed'); },
      onCatalogueChanged: catalogue,
    });
    const res = await call(app, 'POST', '/grok-bot/bots', { title: 'Inbox' });
    expect(res.status).toBe(201);
    expect(catalogue).toHaveBeenCalled();
    const other = db.prepare(
      `SELECT enabled_flag AS e FROM agent_models WHERE agent_id = 'grok-bot' AND model_name = ?`,
    ).get(OTHER) as { e: number };
    expect(other.e).toBe(1);
    expect(findRemoteAgentConversation(db, NEW_BOT)).toBeTruthy();
    const neu = db.prepare(
      `SELECT enabled_flag AS e FROM agent_models WHERE agent_id = 'grok-bot' AND model_name = ?`,
    ).get(NEW_BOT) as { e: number };
    expect(neu.e).toBe(1);
  });

  it('409s a second create while one is in flight', async () => {
    resetGrokBotCreateLockForTests();
    const db = memoryDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const app = appWith(stub(), {
      getDb: () => db,
      getClient: async () => dummyClient(),
      createAgent: async () => { await gate; return NEW_BOT; },
      readRoster: async () => [{ id: NEW_BOT, name: 'Inbox' }],
    });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const first = fetch(`http://127.0.0.1:${port}/grok-bot/bots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Inbox' }),
      });
      await new Promise((r) => setTimeout(r, 30));
      const second = await fetch(`http://127.0.0.1:${port}/grok-bot/bots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Other' }),
      });
      expect(second.status).toBe(409);
      const body = await second.json() as { error: string };
      expect(body.error).toMatch(/in progress/i);
      release();
      expect((await first).status).toBe(201);
    } finally {
      server.close();
      resetGrokBotCreateLockForTests();
    }
  });
});
