/**
 * Kill-switch reachability harness.
 *
 * ONE claim, asserted end-to-end: with `meshMessaging: 'off'` (and separately
 * `meshAwareness: 'off'`), every mesh surface either 401/403s or returns the
 * pre-mesh response, no `mesh_edges` row is created, and no `mesh_messages`
 * (audit) row is written.
 *
 * Deliberately mounts BOTH routers on one app so the two agent-reachable
 * surfaces (`/agent/mesh/*` + `/mesh/*` from routes/mesh.ts, and
 * `POST /spawn/:id/message` from routes/spawn.ts) are exercised against the
 * same DB and the same settings row.
 *
 * ponytail: no fixtures, no helpers beyond the two the existing suites already
 * use. If this file needs a framework it has stopped being a kill-switch test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedCommands, seedDefaultSettings } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSpawnEdge } from '../repositories/spawnEdges.js';
import { getCompactionSettings, updateCompactionSettings } from '../repositories/settings.js';
import { SessionManager } from '../sessionManager.js';
import { registerSpawnRoutes } from '../routes/spawn.js';
import { registerMeshRoutes } from '../routes/mesh.js';
import { issueSpawnToken, type TokenCapability } from '../spawn/tokens.js';
import { listMeshEdges, listMeshMessages, mintMeshEdge } from './edges.js';
import { resetMeshRateForTests } from './rate.js';

const SPAWN_SET: ReadonlySet<TokenCapability> = new Set(['spawn', 'schedule', 'plugin']);
/** A token minted while the switch was ON, still live after the flip to OFF. */
const RESIDUAL_MESH: ReadonlySet<TokenCapability> = new Set(['schedule', 'mesh']);

let server: Server;
let base: string;
let isAuthed = false;
let mgr: SessionManager;
let rootId = '';
let childA = '';
let childB = '';
let grandchild = '';

beforeEach(async () => {
  resetMeshRateForTests();
  isAuthed = false;
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  const p = createProject(db, { name: 'P', rootPath: process.cwd() });
  rootId = createConversation(db, { projectId: p.id, title: 'root' }).id;
  childA = createConversation(db, { projectId: p.id, title: 'a', parentConversationId: rootId }).id;
  childB = createConversation(db, { projectId: p.id, title: 'b', parentConversationId: rootId }).id;
  grandchild = createConversation(db, { projectId: p.id, title: '↳ Impl ⏱', parentConversationId: childA }).id;
  createSpawnEdge(db, { parentConversationId: rootId, childConversationId: childA, role: 'impl', notifyParent: false });
  createSpawnEdge(db, { parentConversationId: rootId, childConversationId: childB, role: 'review', notifyParent: false });

  mgr = new SessionManager({ broadcast: () => {} });
  const app = express();
  app.use(express.json());
  app.use(express.text({ type: 'text/plain', limit: '1mb' }));
  registerSpawnRoutes(app, { getDb, sessionManager: mgr, isAuthed: () => isAuthed });
  registerMeshRoutes(app, {
    getDb,
    isAuthed: () => isAuthed,
    activeSessions: () => [],
    // Mirrors index.ts:406 — the switch is re-read inside the dep, not hoisted.
    hasLiveEdge: () => getCompactionSettings(getDb()).meshMessaging === 'tree',
  });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

function bearer(conversationId: string, scope: ReadonlySet<TokenCapability>) {
  return { Authorization: `Bearer ${issueSpawnToken(conversationId, `s-${Math.random()}`, scope)}` };
}

function sendMessage(target: string, from: string, headers: Record<string, string>, text = 'hi') {
  return fetch(`${base}/spawn/${target}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ parentConversationId: from, text }),
  });
}

/** The whole point: nothing above wrote a row. */
function expectNoMeshRows() {
  expect(listMeshMessages(getDb())).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// 1. Awareness surface — GET /agent/mesh/peers  (routes/mesh.ts:63)
// ---------------------------------------------------------------------------
describe('meshAwareness: off', () => {
  it('GET /agent/mesh/peers 403s for a live spawn token (routes/mesh.ts:71-74)', async () => {
    const res = await fetch(`${base}/agent/mesh/peers`, { headers: bearer(childA, SPAWN_SET) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mesh awareness is off', help: 'GET /agent/help/mesh' });
    expectNoMeshRows();
  });

  it('GET /agent/mesh/peers 403s for the operator cookie too', async () => {
    isAuthed = true;
    const res = await fetch(`${base}/agent/mesh/peers?conversationId=${childA}`);
    expect(res.status).toBe(403);
  });

  it('does not spend the peerBuckets rate token while off (routes/mesh.ts:71 precedes :83)', async () => {
    // Cap is 12/min. 20 calls with awareness off must ALL be 403, never 429 —
    // proving the bucket is neither created nor spent, i.e. an agent cannot
    // grow `peerBuckets` while the feature is off.
    const h = bearer(childA, SPAWN_SET);
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push((await fetch(`${base}/agent/mesh/peers`, { headers: h })).status);
    expect(new Set(codes)).toEqual(new Set([403]));
  });
});

describe('meshAwareness: subtree, meshMessaging: off', () => {
  it('peers are visible but every canMessage is false (routes/mesh.ts:102)', async () => {
    updateCompactionSettings(getDb(), { meshAwareness: 'subtree', meshMessaging: 'off' });
    mintMeshEdge(getDb(), { fromConversation: childA, toConversation: childB, mintedBy: 'operator' });
    const res = await fetch(`${base}/agent/mesh/peers`, { headers: bearer(childA, SPAWN_SET) });
    expect(res.status).toBe(200);
    const body = await res.json() as { peers: { canMessage: boolean }[] };
    expect(body.peers.length).toBeGreaterThan(0);
    expect(body.peers.every((p) => p.canMessage === false)).toBe(true);
    expectNoMeshRows();
  });
});

// ---------------------------------------------------------------------------
// 2. Edge minting — POST /mesh/edges  (routes/mesh.ts:109)
// ---------------------------------------------------------------------------
describe('meshMessaging: off — no edge can be pre-staged', () => {
  it('operator cookie cannot mint (routes/mesh.ts:122)', async () => {
    isAuthed = true;
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromConversationId: childA, toConversationId: childB }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mesh messaging is off' });
    expect(listMeshEdges(getDb())).toHaveLength(0);
    expectNoMeshRows();
  });

  it('a fresh agent token has no mesh capability at all (sessionManager.ts:34)', async () => {
    // The switch is off, so withMeshScope() never adds 'mesh'. routes/mesh.ts:111.
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(childA, SPAWN_SET) },
      body: JSON.stringify({ toConversationId: childB }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'token lacks mesh capability' });
    expect(listMeshEdges(getDb())).toHaveLength(0);
  });

  it('a RESIDUAL mesh token (minted while on, TTL up to 30 min) still cannot mint', async () => {
    // The 30-minute residual window is closed by the settings re-read at
    // routes/mesh.ts:122, not by token expiry.
    const res = await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(childA, RESIDUAL_MESH) },
      body: JSON.stringify({ toConversationId: childB }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mesh messaging is off' });
    expect(listMeshEdges(getDb())).toHaveLength(0);
    expectNoMeshRows();
  });
});

// ---------------------------------------------------------------------------
// 3. Operator read surfaces — cookie only, never bearer  (routes/mesh.ts:212,226)
// ---------------------------------------------------------------------------
describe('mesh read surfaces are cookie-only', () => {
  it('GET /mesh/edges rejects a bearer agent token', async () => {
    const res = await fetch(`${base}/mesh/edges`, { headers: bearer(childA, RESIDUAL_MESH) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'operator session required' });
  });

  it('GET /mesh/messages rejects a bearer agent token', async () => {
    const res = await fetch(`${base}/mesh/messages`, { headers: bearer(childA, RESIDUAL_MESH) });
    expect(res.status).toBe(401);
  });

  it('DELETE /mesh/edges/:id rejects a bearer agent token', async () => {
    const res = await fetch(`${base}/mesh/edges/whatever`, {
      method: 'DELETE',
      headers: bearer(childA, RESIDUAL_MESH),
    });
    expect(res.status).toBe(401);
  });

  it('the operator CAN still see stale edges while the switch is off (the pre-stage mitigation)', async () => {
    // Edges minted while the switch was on survive the flip to off — nothing
    // revokes them (repositories/settings.ts has no revoke hook). The operator's
    // only defence is that GET /mesh/edges is NOT switch-gated, so the Edges
    // card in MeshSettings.tsx:158-180 lists them before the switch goes back on.
    mintMeshEdge(getDb(), { fromConversation: childA, toConversation: childB, mintedBy: 'operator' });
    isAuthed = true;
    const res = await fetch(`${base}/mesh/edges`);
    expect(res.status).toBe(200);
    const body = await res.json() as { edges: { revokedAt: number | null }[] };
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0].revokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The T0 off-invariant — POST /spawn/:id/message  (routes/spawn.ts:580)
// ---------------------------------------------------------------------------
describe('meshMessaging: off — POST /spawn/:id/message is pre-mesh', () => {
  it('descent with a spawn token: 200 and the pre-mesh {ok, delivered} body', async () => {
    const spy = vi.spyOn(mgr, 'messageDescendant').mockReturnValue('dropped');
    const res = await sendMessage(childA, rootId, bearer(rootId, SPAWN_SET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, delivered: 'dropped' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expectNoMeshRows();
  });

  it('non-descendant sibling: 403 with the exact pre-mesh error string (routes/spawn.ts:620-621)', async () => {
    const res = await sendMessage(childB, childA, bearer(childA, SPAWN_SET));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'target conversation is not a strict descendant of the specified parent',
      help: 'GET /agent/help/messaging',
    });
    expectNoMeshRows();
  });

  it('a live pre-staged edge does NOT unlock the lateral path while off (mesh/policy.ts:59-61)', async () => {
    mintMeshEdge(getDb(), { fromConversation: childA, toConversation: childB, mintedBy: 'operator' });
    const handle = vi.spyOn(mgr, 'handlePrompt');
    const res = await sendMessage(childB, childA, bearer(childA, SPAWN_SET));
    expect(res.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
    handle.mockRestore();
    expectNoMeshRows();
  });

  it('a RESIDUAL mesh-only token cannot descent-steer (mesh/policy.ts:53-57)', async () => {
    const spy = vi.spyOn(mgr, 'messageDescendant');
    const res = await sendMessage(childA, rootId, bearer(rootId, RESIDUAL_MESH));
    // FINDING (documented, not a leak): pre-mesh this was 401 — validateSpawnToken
    // rejected a non-spawn token at routes/spawn.ts:590 before any DB read. The
    // branch's validateMessageToken (spawn/tokens.ts:65-69) accepts mesh, so the
    // request now reaches the 403. Capability is unchanged (no delivery); only the
    // status code and the 404-vs-403 existence oracle differ.
    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expectNoMeshRows();
  });

  it('the 429 caller flood cap is unreachable while off (routes/spawn.ts:605-613)', async () => {
    // MESH_CALLER_PER_MINUTE is 60. 80 denied calls must all be 403, never 429 —
    // proving `perCaller` (mesh/rate.ts:5) does not grow while the feature is off.
    const h = bearer(childA, SPAWN_SET);
    const codes: number[] = [];
    for (let i = 0; i < 80; i++) codes.push((await sendMessage(childB, childA, h)).status);
    expect(new Set(codes)).toEqual(new Set([403]));
    expectNoMeshRows();
  });

  it('the 413 lateral size cap is unreachable while off (routes/spawn.ts:661)', async () => {
    const res = await sendMessage(childB, childA, bearer(childA, SPAWN_SET), 'x'.repeat(33 * 1024));
    expect(res.status).toBe(403);
    expectNoMeshRows();
  });

  it('no auth: still 401, unchanged', async () => {
    const res = await fetch(`${base}/spawn/${childA}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentConversationId: rootId, text: 'hi' }),
    });
    expect(res.status).toBe(401);
    expectNoMeshRows();
  });

  it('the ⇩ descent marker is byte-identical to pre-mesh (raw title restored by sweep #2 item 3)', async () => {
    // sweep #2 moved sanitizeToken to the ⇄ lateral marker only; the
    // pre-existing ⇩ descent marker embeds child.title verbatim again, so the
    // off-state transcript bytes match pre-mesh behaviour.
    const spy = vi.spyOn(mgr, 'recordSpawnMarker');
    vi.spyOn(mgr, 'messageDescendant').mockReturnValue('dropped');
    await sendMessage(grandchild, rootId, bearer(rootId, SPAWN_SET));
    expect((spy.mock.calls[0][1] as { text: string }).text).toBe('⇩ message → ↳ Impl ⏱');
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// 5. The global invariant.
// ---------------------------------------------------------------------------
describe('audit table stays empty while the switch is off', () => {
  it('every mesh surface, hit once, writes zero mesh_messages rows', async () => {
    isAuthed = false;
    const h = bearer(childA, RESIDUAL_MESH);
    mintMeshEdge(getDb(), { fromConversation: childA, toConversation: childB, mintedBy: 'operator' });
    await fetch(`${base}/agent/mesh/peers`, { headers: h });
    await fetch(`${base}/mesh/edges`, { headers: h });
    await fetch(`${base}/mesh/messages`, { headers: h });
    await fetch(`${base}/mesh/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...h },
      body: JSON.stringify({ toConversationId: childB }),
    });
    await fetch(`${base}/mesh/edges/nope`, { method: 'DELETE', headers: h });
    await sendMessage(childB, childA, h);
    await sendMessage(childA, rootId, h);
    await sendMessage(rootId, childA, h);
    expectNoMeshRows();
  });
});
