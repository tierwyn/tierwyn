import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { parseMemoryId, type ServerFrame } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { getMemory, flagMemory, countMemories } from '../repositories/memories.js';
import { updateGeneralSettings } from '../repositories/settings.js';
import { issueSpawnToken, CONVERSATION_CAPABILITIES, type TokenCapability } from '../spawn/tokens.js';
import { withSessionScope } from '../sessionManager.js';
import { registerAgentMemoryRoutes } from './memories.js';
import { profileAllowsMemory } from '@tierwyn/shared';

const NOW = 1_800_000_000_000;
const PROFILE_ID = 'claude-code:test-model';

let db: Database.Database;
let app: express.Express;
let convA: string;
let convB: string;
let projectA: string;
let projectB: string;
let now = NOW;
let frames: ServerFrame[];
let liveToken: string;

function memoryScope(): Set<TokenCapability> {
  return new Set<TokenCapability>([...CONVERSATION_CAPABILITIES, 'memory']);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  updateGeneralSettings(db, { memories: true });
  now = NOW;
  frames = [];

  db.prepare(`INSERT INTO agents (id, type, label, created_at) VALUES ('claude-code', 'claude-code', 'Claude Code', ?)`).run(NOW);
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, 'claude-code', 'test-model', 'Test', 1, ?)`,
  ).run(PROFILE_ID, NOW);

  const pA = createProject(db, { name: 'A', rootPath: '/tmp/a' });
  const pB = createProject(db, { name: 'B', rootPath: '/tmp/b' });
  projectA = pA.id;
  projectB = pB.id;
  convA = createConversation(db, { projectId: pA.id, title: 'A' }).id;
  convB = createConversation(db, { projectId: pB.id, title: 'B' }).id;
  createSession(db, { id: 'sess-a', conversationId: convA, agentId: 'claude-code', agentModelId: PROFILE_ID });
  createSession(db, { id: 'sess-b', conversationId: convB, agentId: 'claude-code', agentModelId: PROFILE_ID });

  app = express();
  app.use(express.json());
  registerAgentMemoryRoutes(app, {
    getDb: () => db,
    now: () => now,
    broadcastAll: (f) => { frames.push(f); },
  });
  liveToken = issueSpawnToken(convA, 'sess-a', memoryScope());
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function call(
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

function post(body: unknown, token = liveToken) {
  return call('POST', '/agent/memory', body, auth(token));
}

describe('POST /agent/memory', () => {
  it('POST saves, redacts a live spawn token, returns similar with a hint', async () => {
    const res = await post({ kind: 'gotcha', text: `routes behind web need ${liveToken}` });
    expect(res.status).toBe(201);
    const row = getMemory(db, parseMemoryId(res.body.id)!)!;
    expect(row.text).not.toContain(liveToken);
    expect(row.text).toContain('[REDACTED]');
  });

  it('similar lists an existing overlapping memory and the supersede hint', async () => {
    const first = await post({ kind: 'gotcha', text: 'new API prefixes must join HTTP_ROUTES behind the web proxy' });
    const second = await post({ kind: 'gotcha', text: 'HTTP_ROUTES prefixes behind the web proxy must be listed' });
    expect(second.status).toBe(201);
    expect(second.body.similar.map((s: { id: string }) => s.id)).toContain(first.body.id);
    expect(second.body.hint).toContain(`/agent/memory/${first.body.id}/supersede`);
    expect(second.body.hint).toContain(second.body.id);
  });

  it('text of 501 chars is 400; exactly 500 saves', async () => {
    expect((await post({ kind: 'fact', text: 'x'.repeat(501) })).status).toBe(400);
    expect((await post({ kind: 'fact', text: 'x'.repeat(500) })).status).toBe(201);
  });

  it('newlines in text are collapsed to spaces', async () => {
    const res = await post({ kind: 'fact', text: 'alpha\n\nbeta\troutes' });
    expect(res.status).toBe(201);
    expect(getMemory(db, parseMemoryId(res.body.id)!)!.text).toBe('alpha beta routes');
  });

  it('the 21st save in an hour is 429, the next window saves', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await post({ kind: 'fact', text: `save number ${i} unique widget` })).status).toBe(201);
    }
    const blocked = await post({ kind: 'fact', text: 'save number 20 unique widget' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    now += 60 * 60_000 + 1;
    expect((await post({ kind: 'fact', text: 'save number 21 unique widget' })).status).toBe(201);
  });

  it('another conversation is unaffected by the first one\'s rate limit', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await post({ kind: 'fact', text: `rate ${i} widget alpha` })).status).toBe(201);
    }
    expect((await post({ kind: 'fact', text: 'rate overflow widget' })).status).toBe(429);
    const tB = issueSpawnToken(convB, 'sess-b', memoryScope());
    expect((await post({ kind: 'fact', text: 'other conversation widget' }, tB)).status).toBe(201);
  });

  it('sixth suggestRule returns 201, ruleSuggestion rejected, and a warning', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await post({ kind: 'gotcha', text: `pending ${i} unique widget`, suggestRule: true });
      expect(r.body.ruleSuggestion).toBe('pending');
    }
    const sixth = await post({ kind: 'gotcha', text: 'sixth unique widget', suggestRule: true });
    expect(sixth.status).toBe(201);
    expect(sixth.body.ruleSuggestion).toBe('rejected');
    expect(sixth.body.warning).toMatch(/5 pending/);
  });

  it('a store failure answers 503 and does not throw', async () => {
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO memories')) {
        throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
      }
      return orig(sql);
    }) as typeof db.prepare;
    const res = await post({ kind: 'fact', text: 'should not persist widget' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('memory store unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/INSERT/i);
  });

  it('an unexpected throw answers 500 without leaking SQL', async () => {
    const boomApp = express();
    boomApp.use(express.json());
    registerAgentMemoryRoutes(boomApp, {
      getDb: () => {
        throw new Error('SQL: SELECT * FROM memories WHERE leaked');
      },
      now: () => now,
      broadcastAll: () => {},
    });
    const { createServer } = await import('node:http');
    const server = createServer(boomApp);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/agent/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(liveToken) },
        body: JSON.stringify({ kind: 'fact', text: 'guard throw widget' }),
      });
      const body = await res.json().catch(() => ({}));
      expect(res.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toMatch(/SELECT|SQL|memories WHERE/i);
    } finally {
      server.close();
    }
  });

  it('post-commit side-effect failure still answers 201 with the saved id', async () => {
    const boomApp = express();
    boomApp.use(express.json());
    registerAgentMemoryRoutes(boomApp, {
      getDb: () => db,
      now: () => now,
      broadcastAll: () => { throw new Error('broadcast boom'); },
    });
    const { createServer } = await import('node:http');
    const server = createServer(boomApp);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/agent/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(liveToken) },
        body: JSON.stringify({ kind: 'fact', text: 'saved despite broadcast widget' }),
      });
      const body = await res.json().catch(() => ({}));
      expect(res.status).toBe(201);
      expect(body.id).toMatch(/^m_\d+$/);
      const after = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      expect(after.n).toBe(before.n + 1);
    } finally {
      server.close();
    }
  });
});

describe('GET /agent/memory', () => {
  it('search never returns another project\'s memory', async () => {
    await post({ kind: 'fact', text: 'alpha widget in project a' });
    const tB = issueSpawnToken(convB, 'sess-b', memoryScope());
    await post({ kind: 'fact', text: 'alpha widget in project b' }, tB);
    const res = await call('GET', '/agent/memory?q=alpha%20widget', undefined, auth(liveToken));
    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(/not instructions/);
    expect(res.body.memories.every((m: { text: string }) => !m.text.includes('project b'))).toBe(true);
  });
});

describe('POST /agent/memory/:id/supersede', () => {
  it('supersede across projects is 404 and the target stays active', async () => {
    const a = await post({ kind: 'fact', text: 'alpha widget stays in a' });
    const tB = issueSpawnToken(convB, 'sess-b', memoryScope());
    const b = await post({ kind: 'fact', text: 'alpha widget in b' }, tB);
    const res = await call(
      'POST',
      `/agent/memory/${a.body.id}/supersede`,
      { by: b.body.id },
      auth(tB),
    );
    expect(res.status).toBe(404);
    expect(getMemory(db, parseMemoryId(a.body.id)!)!.status).toBe('active');
  });

  it('superseding a flagged row is 409 and the flagged count stays', async () => {
    const old = await post({ kind: 'fact', text: 'flagged widget alpha routes' });
    const neu = await post({ kind: 'fact', text: 'replacement widget alpha routes' });
    flagMemory(db, parseMemoryId(old.body.id)!, 'secret_like');
    expect(countMemories(db).flagged).toBe(1);
    const res = await call(
      'POST',
      `/agent/memory/${old.body.id}/supersede`,
      { by: neu.body.id },
      auth(liveToken),
    );
    expect(res.status).toBe(409);
    expect(getMemory(db, parseMemoryId(old.body.id)!)!.status).toBe('flagged');
    expect(countMemories(db).flagged).toBe(1);
  });

  it('re-superseding an already-superseded row is 409', async () => {
    const old = await post({ kind: 'fact', text: 'old widget alpha routes' });
    const neu = await post({ kind: 'fact', text: 'new widget alpha routes' });
    const third = await post({ kind: 'fact', text: 'third widget alpha routes' });
    const first = await call(
      'POST',
      `/agent/memory/${old.body.id}/supersede`,
      { by: neu.body.id },
      auth(liveToken),
    );
    expect(first.status).toBe(200);
    const again = await call(
      'POST',
      `/agent/memory/${old.body.id}/supersede`,
      { by: third.body.id },
      auth(liveToken),
    );
    expect(again.status).toBe(409);
    expect(getMemory(db, parseMemoryId(old.body.id)!)!.status).toBe('superseded');
  });

  it('supersede counts against the same per-hour save window', async () => {
    const old = await post({ kind: 'fact', text: 'old unique widget supersede' });
    const neu = await post({ kind: 'fact', text: 'new unique widget supersede' });
    for (let i = 0; i < 18; i++) {
      expect((await post({ kind: 'fact', text: `fill ${i} unique widget` })).status).toBe(201);
    }
    const blocked = await call(
      'POST',
      `/agent/memory/${old.body.id}/supersede`,
      { by: neu.body.id },
      auth(liveToken),
    );
    expect(blocked.status).toBe(429);
    expect(getMemory(db, parseMemoryId(old.body.id)!)!.status).toBe('active');
  });
});

describe('agent memory guards', () => {
  it('token without memory scope is 403; profile memory:false is 403; setting off is 403', async () => {
    const noMem = issueSpawnToken(convA, 'sess-a', CONVERSATION_CAPABILITIES);
    expect((await post({ kind: 'fact', text: 'no scope widget' }, noMem)).status).toBe(403);

    const denied = issueSpawnToken(convA, 'sess-a', memoryScope(), {
      id: 'minimal', plugins: [], usage: false, memory: false,
    });
    const deniedRes = await post({ kind: 'fact', text: 'denied profile widget' }, denied);
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body.error).toBe('no_memory_capability');

    updateGeneralSettings(db, { memories: false });
    const off = await post({ kind: 'fact', text: 'setting off widget' });
    expect(off.status).toBe(403);
    expect(off.body.error).toBe('memories_off');
  });
});

describe('withSessionScope memory', () => {
  it('withSessionScope adds memory iff the setting is on', () => {
    updateGeneralSettings(db, { memories: false });
    expect(withSessionScope(db, CONVERSATION_CAPABILITIES, { id: convA }).has('memory')).toBe(false);
    updateGeneralSettings(db, { memories: true });
    expect(withSessionScope(db, CONVERSATION_CAPABILITIES, { id: convA }).has('memory')).toBe(true);
  });
});

describe('profileAllowsMemory', () => {
  it('existing stored profiles without the field allow memory; minimal denies', () => {
    expect(profileAllowsMemory({ id: 'all', plugins: '*', usage: true })).toBe(true);
    expect(profileAllowsMemory({ id: 'minimal', plugins: [], usage: false, memory: false })).toBe(false);
  });
});
