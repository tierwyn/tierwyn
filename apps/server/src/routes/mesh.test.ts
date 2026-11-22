import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, markStopped } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { createSpawnEdge } from '../repositories/spawnEdges.js';
import { updateCompactionSettings } from '../repositories/settings.js';
import { issueSpawnToken, type TokenCapability } from '../spawn/tokens.js';
import { registerMeshRoutes } from './mesh.js';
import { mintMeshEdge } from '../mesh/edges.js';

let server: Server;
let base: string;
let db: Database.Database;
let isAuthed = false;
let rootId = '';
let childA = '';
let childB = '';

async function listen(app: express.Express): Promise<void> {
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
}

beforeEach(async () => {
  isAuthed = false;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const root = createConversation(db, { projectId: p.id, title: 'root-secret-title' });
  const a = createConversation(db, { projectId: p.id, title: 'a-title', parentConversationId: root.id });
  const b = createConversation(db, { projectId: p.id, title: 'b-title', parentConversationId: root.id });
  createSpawnEdge(db, { parentConversationId: root.id, childConversationId: a.id, role: 'impl', notifyParent: false });
  createSpawnEdge(db, { parentConversationId: root.id, childConversationId: b.id, role: 'reviewer', notifyParent: false });
  rootId = root.id;
  childA = a.id;
  childB = b.id;
  const app = express();
  app.use(express.json());
  registerMeshRoutes(app, {
    getDb: () => db,
    isAuthed: () => isAuthed,
    activeSessions: () => [{ conversationId: childB, lastStatus: 'running', startedAt: 99 }],
  });
  await listen(app);
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('GET /agent/mesh/peers', () => {
  it('returns 403 for a live spawn token when awareness is off', async () => {
    const tok = issueSpawnToken(childA, 's1', 'spawn');
    const res = await fetch(`${base}/agent/mesh/peers`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns 401 with no auth', async () => {
    updateCompactionSettings(db, { meshAwareness: 'subtree' });
    const res = await fetch(`${base}/agent/mesh/peers`);
    expect(res.status).toBe(401);
  });

  it('returns the D7 neighbourhood with sanitised role and no title/model/profileId', async () => {
    updateCompactionSettings(db, { meshAwareness: 'subtree' });
    const tok = issueSpawnToken(childA, 's1', 'spawn');
    const res = await fetch(`${base}/agent/mesh/peers`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { peers: { conversationId: string; relation: string; role: string; status: string }[] };
    expect(body.peers.some((p) => p.conversationId === rootId && p.relation === 'parent')).toBe(true);
    expect(body.peers.some((p) => p.conversationId === childB && p.relation === 'sibling' && p.status === 'running')).toBe(true);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('root-secret-title');
    expect(raw).not.toContain('a-title');
    expect(raw).not.toMatch(/profileId|"model"|costUsd|"project"/);
  });

  it('canMessage is false while messaging is off even if a live edge exists (L-6)', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    updateCompactionSettings(db, { meshAwareness: 'subtree', meshMessaging: 'off' });
    mintMeshEdge(db, { fromConversation: childA, toConversation: childB, mintedBy: 'operator' });
    const app = express();
    app.use(express.json());
    registerMeshRoutes(app, {
      getDb: () => db,
      isAuthed: () => false,
      activeSessions: () => [],
      hasLiveEdge: () => true,
    });
    await listen(app);
    const tok = issueSpawnToken(childA, 's-l6', 'spawn');
    const res = await fetch(`${base}/agent/mesh/peers`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { peers: { conversationId: string; canMessage: boolean }[] };
    expect(body.peers.every((p) => p.canMessage === false)).toBe(true);
  });

  it('cookie caller needs conversationId and works when authed', async () => {
    updateCompactionSettings(db, { meshAwareness: 'subtree' });
    isAuthed = true;
    const missing = await fetch(`${base}/agent/mesh/peers`);
    expect(missing.status).toBe(400);
    const res = await fetch(`${base}/agent/mesh/peers?conversationId=${childA}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { peers: unknown[] };
    expect(body.peers.length).toBeGreaterThan(0);
  });
});

describe('POST /mesh/edges', () => {
  it('403 when messaging is off even with a mesh token', async () => {
    const tok = issueSpawnToken(rootId, 's', new Set<TokenCapability>(['spawn', 'schedule', 'plugin', 'mesh']));
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromConversationId: childA, toConversationId: childB }),
    });
    expect(res.status).toBe(403);
  });

  it('403 for a mesh-scope-less token when messaging is on', async () => {
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const tok = issueSpawnToken(rootId, 's', new Set<TokenCapability>(['spawn', 'schedule', 'plugin']));
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromConversationId: childA, toConversationId: childB }),
    });
    expect(res.status).toBe(403);
  });

  it('403 when a non-parent agent mints a grandchild pair', async () => {
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const tok = issueSpawnToken(childA, 's', new Set<TokenCapability>(['spawn', 'schedule', 'plugin', 'mesh']));
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromConversationId: childA, toConversationId: childB }),
    });
    expect(res.status).toBe(403);
    const { listMeshMessages } = await import('../mesh/edges.js');
    expect(listMeshMessages(db).some((r) => r.decision === 'denied_scope')).toBe(true);
  });

  it('201 when the parent agent mints a sibling pair of its children', async () => {
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const tok = issueSpawnToken(rootId, 's', new Set<TokenCapability>(['spawn', 'schedule', 'plugin', 'mesh']));
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromConversationId: childA, toConversationId: childB }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { edge: { id: string }; reverse?: { id: string } };
    expect(body.edge.id).toBeTruthy();
    expect(body.reverse?.id).toBeTruthy();
  });

  it('audits a topology mint denial (L-1)', async () => {
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    isAuthed = true;
    const { getConversation } = await import('../repositories/conversations.js');
    const projectId = getConversation(db, rootId)!.projectId;
    const otherRoot = createConversation(db, { projectId, title: 'other-root' }).id;
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromConversationId: childA, toConversationId: otherRoot, allowReplies: false }),
    });
    expect(res.status).toBe(403);
    const { listMeshMessages } = await import('../mesh/edges.js');
    const rows = listMeshMessages(db);
    expect(rows.some((r) => r.decision === 'denied_wrong_tree')).toBe(true);
  });

  it('audits a peer-cap mint denial (L-1)', async () => {
    updateCompactionSettings(db, { meshMessaging: 'tree', meshMaxPeersPerConversation: 4 });
    isAuthed = true;
    const { getConversation } = await import('../repositories/conversations.js');
    const projectId = getConversation(db, rootId)!.projectId;
    const peers = [0, 1, 2, 3].map((i) =>
      createConversation(db, { projectId, title: `cap${i}`, parentConversationId: rootId }).id,
    );
    for (const to of peers) {
      mintMeshEdge(db, { fromConversation: childA, toConversation: to, mintedBy: 'operator' });
    }
    const fifth = createConversation(db, { projectId, title: 'cap4', parentConversationId: rootId }).id;
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromConversationId: childA, toConversationId: fifth, allowReplies: false }),
    });
    expect(res.status).toBe(400);
    const { listMeshMessages } = await import('../mesh/edges.js');
    expect(listMeshMessages(db).some((r) => r.decision === 'denied_rate')).toBe(true);
  });

  it('5th outbound peer mint is 400', async () => {
    updateCompactionSettings(db, { meshMessaging: 'tree', meshMaxPeersPerConversation: 4 });
    isAuthed = true;
    const { getConversation } = await import('../repositories/conversations.js');
    const projectId = getConversation(db, rootId)!.projectId;
    const peers = [0, 1, 2, 3].map((i) =>
      createConversation(db, { projectId, title: `p${i}`, parentConversationId: rootId }).id,
    );
    for (const to of peers) {
      mintMeshEdge(db, { fromConversation: childA, toConversation: to, mintedBy: 'operator' });
    }
    const fifth = createConversation(db, { projectId, title: 'p4', parentConversationId: rootId }).id;
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromConversationId: childA, toConversationId: fifth, allowReplies: false }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /agent/mesh/peers stopped children', () => {
  it('shows stopped + canMessage false even with a live mesh edge; revival clears it', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    updateCompactionSettings(db, { meshAwareness: 'subtree', meshMessaging: 'tree' });
    const last = createSession(db, { id: 'sess-b-old', conversationId: childB });
    markStopped(db, childB, last.createdAt + 1);
    mintMeshEdge(db, { fromConversation: childA, toConversation: childB, mintedBy: 'operator' });
    const app = express();
    app.use(express.json());
    registerMeshRoutes(app, {
      getDb: () => db,
      isAuthed: () => false,
      activeSessions: () => [],
      hasLiveEdge: () => true,
    });
    await listen(app);
    const tok = issueSpawnToken(childA, 's-stop', 'spawn');
    const res = await fetch(`${base}/agent/mesh/peers`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { peers: { conversationId: string; status: string; canMessage: boolean }[] };
    const peer = body.peers.find((p) => p.conversationId === childB);
    expect(peer?.status).toBe('stopped');
    expect(peer?.canMessage).toBe(false);

    const revived = createSession(db, { id: 'sess-b-new', conversationId: childB });
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(last.createdAt + 10_000, revived.id);
    const res2 = await fetch(`${base}/agent/mesh/peers`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const body2 = await res2.json() as { peers: { conversationId: string; status: string }[] };
    const peer2 = body2.peers.find((p) => p.conversationId === childB);
    expect(peer2?.status).not.toBe('stopped');
  });
});
