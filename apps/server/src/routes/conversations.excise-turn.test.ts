import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { appendEvent } from '../repositories/events.js';
import { getSession } from '../repositories/sessions.js';
import { registerConversationMutationRoutes } from './conversations.js';
import { registry } from '../registry.js';
import type { AgentAdapter } from '@tierwyn/shared';

function boot(opts: { inFlight?: boolean } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });

  const sessionManager = {
    inFlightSessionForConversation: () => opts.inFlight ? ({} as never) : undefined,
    reapParkedSessions: async () => {},
  };

  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, { getDb: () => db, sessionManager: sessionManager as never });
  return { db, app, conversationId: c.id };
}

function seedAgent(db: Db, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (id, type, label, description, env_vars, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(agentId, agentId, agentId, '', '{}', Date.now());
}

/** Attach a session row owned by `agentId` with a native id, then append a
 *  prompt + message + steer + message turn structure so we have ids to delete. */
function seedTurn(db: Db, conversationId: string, agentId: string, sessionId: string, nativeId: string) {
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run(sessionId, conversationId, agentId, nativeId, Date.now(), Date.now());
  const prompt = appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'turn one' }, sender: 'user', ts: 100, seq: 0 });
  const reply = appendEvent(db, { sessionId, type: 'message', payload: { text: 'reply one' }, sender: 'agent', ts: 101, seq: 0 });
  const steer = appendEvent(db, { sessionId, type: 'steer', payload: { text: 'a steer' }, sender: 'user', ts: 102, seq: 0 });
  const reply2 = appendEvent(db, { sessionId, type: 'message', payload: { text: 'reply two' }, sender: 'agent', ts: 103, seq: 0 });
  return { prompt, reply, steer, reply2 };
}

function postJson(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (r) => ({ status: r.status, body: await r.json() }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('POST /conversations/:id/excise-turn', () => {
  it('returns 409 when the adapter lacks exciseNativeTurn (unsupported)', async () => {
    // Stub adapter with NO exciseNativeTurn — simulates hermes/opencode.
    const stub = ({} as never) as AgentAdapter;
    registry.register('shared-db-agent', () => stub, 'shared-db-agent');

    const { db, app, conversationId } = boot();
    seedAgent(db, 'shared-db-agent');
    const { prompt } = seedTurn(db, conversationId, 'shared-db-agent', 's1', 'native-1');

    const res = await postJson(app, `/conversations/${conversationId}/excise-turn`, {
      turnIndex: 0, eventIds: [prompt.id],
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/not supported/);
  });

  it('happy path: deletes the event ids, forks the native session, repoints the session row', async () => {
    const calls: { nativeId: string; turn: number }[] = [];
    const stub = ({
      exciseNativeTurn: async (nativeSessionId: string, turnToRemove: number) => {
        calls.push({ nativeId: nativeSessionId, turn: turnToRemove });
        return 'native-forked';
      },
    } as never) as AgentAdapter;
    registry.register('file-agent', () => stub, 'file-agent');

    const { db, app, conversationId } = boot();
    seedAgent(db, 'file-agent');
    const seeded = seedTurn(db, conversationId, 'file-agent', 's-file', 'native-original');

    const res = await postJson(app, `/conversations/${conversationId}/excise-turn`, {
      turnIndex: 0,
      eventIds: [seeded.prompt.id, seeded.reply.id],
    });
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    // Adapter was called with the original native id and a 1-indexed turn.
    expect(calls).toEqual([{ nativeId: 'native-original', turn: 1 }]);

    // The two event ids are gone; the other two (steer + reply2) survive.
    const remaining = db.prepare('SELECT id FROM events WHERE session_id = ? ORDER BY ts').all('s-file') as { id: string }[];
    const remainingIds = new Set(remaining.map((r) => r.id));
    expect(remainingIds.has(seeded.prompt.id)).toBe(false);
    expect(remainingIds.has(seeded.reply.id)).toBe(false);
    expect(remainingIds.has(seeded.steer.id)).toBe(true);
    expect(remainingIds.has(seeded.reply2.id)).toBe(true);

    // Session row repointed at the forked native id.
    const session = getSession(db, 's-file');
    expect(session!.nativeSessionId).toBe('native-forked');
  });

  it('returns 409 when a session is in-flight for the conversation', async () => {
    const stub = ({
      exciseNativeTurn: async () => 'native-forked',
    } as never) as AgentAdapter;
    registry.register('file-agent', () => stub, 'file-agent');

    const { db, app, conversationId } = boot({ inFlight: true });
    seedAgent(db, 'file-agent');
    const seeded = seedTurn(db, conversationId, 'file-agent', 's1', 'native-1');

    const res = await postJson(app, `/conversations/${conversationId}/excise-turn`, {
      turnIndex: 0, eventIds: [seeded.prompt.id],
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/live session/);
  });

  it('off-by-one guard: client turnIndex 0 → adapter turnToRemove 1', async () => {
    const calls: number[] = [];
    const stub = ({
      exciseNativeTurn: async (_n: string, turn: number) => { calls.push(turn); return 'native-forked'; },
    } as never) as AgentAdapter;
    registry.register('file-agent', () => stub, 'file-agent');

    const { db, app, conversationId } = boot();
    seedAgent(db, 'file-agent');
    const seeded = seedTurn(db, conversationId, 'file-agent', 's-idx', 'native-idx');

    // Client sends turnIndex 5 (arbitrary 0-indexed) → adapter must receive 6.
    const res = await postJson(app, `/conversations/${conversationId}/excise-turn`, {
      turnIndex: 5, eventIds: [seeded.prompt.id],
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([6]);
  });

  it('maps a single-turn rejection from the adapter to 400', async () => {
    const stub = ({
      exciseNativeTurn: async () => { throw new Error('cannot excise the only turn in a single-turn session; delete the conversation instead'); },
    } as never) as AgentAdapter;
    registry.register('file-agent', () => stub, 'file-agent');

    const { db, app, conversationId } = boot();
    seedAgent(db, 'file-agent');
    const seeded = seedTurn(db, conversationId, 'file-agent', 's-solo', 'native-solo');

    const res = await postJson(app, `/conversations/${conversationId}/excise-turn`, {
      turnIndex: 0, eventIds: [seeded.prompt.id],
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/single-turn/);
  });

  it('rejects 400 when eventIds is empty or turnIndex missing', async () => {
    const { app, conversationId } = boot();
    const r1 = await postJson(app, `/conversations/${conversationId}/excise-turn`, { turnIndex: 0, eventIds: [] });
    expect(r1.status).toBe(400);
    const r2 = await postJson(app, `/conversations/${conversationId}/excise-turn`, { eventIds: ['x'] });
    expect(r2.status).toBe(400);
  });

  it('rejects 400 when an event id is unknown', async () => {
    const stub = ({ exciseNativeTurn: async () => 'x' } as never) as AgentAdapter;
    registry.register('file-agent', () => stub, 'file-agent');
    const { app, conversationId } = boot();
    const res = await postJson(app, `/conversations/${conversationId}/excise-turn`, {
      turnIndex: 0, eventIds: ['never-existed'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects 404 when the conversation does not exist', async () => {
    const stub = ({ exciseNativeTurn: async () => 'x' } as never) as AgentAdapter;
    registry.register('file-agent', () => stub, 'file-agent');
    const { app } = boot();
    const res = await postJson(app, `/conversations/no-such-conv/excise-turn`, {
      turnIndex: 0, eventIds: ['x'],
    });
    expect(res.status).toBe(404);
  });
});
