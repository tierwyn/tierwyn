import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { registerConversationMutationRoutes } from './conversations.js';
import { registry } from '../registry.js';
import type { AgentAdapter } from '@tierwyn/shared';

function boot(opts: { inFlight?: boolean; dataDir?: string } = {}) {
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
  registerConversationMutationRoutes(app, {
    getDb: () => db,
    sessionManager: sessionManager as never,
    dataDir: opts.dataDir,
  });
  return { db, app, conversationId: c.id, projectId: p.id };
}

/** Insert a synthetic agent row so sessions.agent_id FK is satisfiable. */
function seedAgent(db: Database, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (id, type, label, description, env_vars, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(agentId, agentId, agentId, '', '{}', Date.now());
}

function fetchDelete(app: express.Express, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE' })
        .then(async (r) => ({ status: r.status, body: await r.json() }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('DELETE /conversations/:id', () => {
  afterEach(() => {
    registry.setRemoteFactory(undefined);
  });

  it('returns 404 for a non-existent conversation', async () => {
    const { app } = boot();
    const res = await fetchDelete(app, '/conversations/nope');
    expect(res.status).toBe(404);
  });

  it('returns 409 when a session is in-flight for the conversation', async () => {
    const { app, conversationId } = boot({ inFlight: true });
    const res = await fetchDelete(app, `/conversations/${conversationId}`);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/live session/);
  });

  // v1.5 safety mechanism: adapters that share one DB across conversations
  // (hermes, opencode) MUST NOT have deleteNativeSession — the route's optional
  // call (`?.`) must skip them without throwing. This pins the contract.
  it('skips native unlink gracefully for adapters without deleteNativeSession', async () => {
    const fakeAdapter: AgentAdapter = ({
      // intentionally NO deleteNativeSession — simulates hermes/opencode
    } as never) as AgentAdapter;
    // Register under a synthetic agentType so registry.create returns our stub.
    registry.register('shared-db-agent', () => fakeAdapter, 'shared-db-agent');

    const { db, app, conversationId } = boot();
    // Attach a session whose agent is the shared-db stub with a native id.
    seedAgent(db, 'shared-db-agent');
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s-shared', conversationId, 'shared-db-agent', 'native-shared', Date.now(), Date.now());

    const res = await fetchDelete(app, `/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it('calls deleteNativeSession for an adapter that implements it', async () => {
    const deleted: string[] = [];
    const fakeAdapter = ({
      deleteNativeSession: async (nativeSessionId: string) => { deleted.push(nativeSessionId); },
    } as never) as AgentAdapter;
    registry.register('file-agent', () => fakeAdapter, 'file-agent');

    const { db, app, conversationId } = boot();
    seedAgent(db, 'file-agent');
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s-file', conversationId, 'file-agent', 'native-file-1', Date.now(), Date.now());

    const res = await fetchDelete(app, `/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    expect(deleted).toEqual(['native-file-1']);
  });

  it('deletes a remote-project native session via the remote factory', async () => {
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

    const { db, app } = boot();
    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    const remoteProject = createProject(db, { name: 'remote', rootPath: '/tmp/r', remoteHostId: host.id });
    const conv = createConversation(db, { projectId: remoteProject.id, title: 'rc' });
    seedAgent(db, 'remote-file-agent');
    db.prepare(
      `INSERT INTO sessions (id,conversation_id,agent_id,native_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s-remote', conv.id, 'remote-file-agent', 'native-remote-1', Date.now(), Date.now());

    const res = await fetchDelete(app, `/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    expect(remoteCalls).toEqual([{ type: 'remote-file-agent', host: host.id }]);
    expect(deleted).toEqual(['native-remote-1']);
  });

  it('removes attachment shard dirs for the root and descendants', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tierwyn-del-att-'));
    try {
      const { db, app, conversationId, projectId } = boot({ dataDir });
      const child = createConversation(db, {
        projectId, title: 'child', parentConversationId: conversationId,
      });
      const rootShard = join(dataDir, 'attachments', conversationId, 'a.txt');
      const childShard = join(dataDir, 'attachments', child.id, 'b.txt');
      mkdirSync(join(dataDir, 'attachments', conversationId), { recursive: true });
      mkdirSync(join(dataDir, 'attachments', child.id), { recursive: true });
      writeFileSync(rootShard, 'a');
      writeFileSync(childShard, 'b');

      const res = await fetchDelete(app, `/conversations/${conversationId}`);
      expect(res.status).toBe(200);
      expect(existsSync(join(dataDir, 'attachments', conversationId))).toBe(false);
      expect(existsSync(join(dataDir, 'attachments', child.id))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
