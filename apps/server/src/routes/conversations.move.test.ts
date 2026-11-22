import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings, ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import {
  createConversation, createScheduleHomeConversation, getConversation, moveConversationTree,
} from '../repositories/conversations.js';
import { registerConversationMutationRoutes } from './conversations.js';

/** In-memory DB with two projects and a root conversation in project A. */
function bootDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const a = createProject(db, { name: 'A', rootPath: '/a' });
  const b = createProject(db, { name: 'B', rootPath: '/b' });
  const c = createConversation(db, { projectId: a.id, title: 'C' });
  return { db, projectA: a.id, projectB: b.id, conversationId: c.id };
}

describe('moveConversationTree', () => {
  it('moves a lone root conversation to the target project', () => {
    const { db, projectB, conversationId } = bootDb();
    const out = moveConversationTree(db, conversationId, projectB);
    expect(out?.conversation.projectId).toBe(projectB);
    expect(out?.movedIds).toEqual([conversationId]);
    expect(getConversation(db, conversationId)?.projectId).toBe(projectB);
  });

  it('bumps updated_at on a real move', () => {
    const { db, projectB, conversationId } = bootDb();
    const before = getConversation(db, conversationId)!.updatedAt;
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(before - 10_000, conversationId);
    const out = moveConversationTree(db, conversationId, projectB);
    expect(out!.conversation.updatedAt).toBeGreaterThan(before - 10_000);
  });

  it('moves the whole spawn subtree, children and grandchildren', () => {
    const { db, projectB, conversationId } = bootDb();
    const child = createConversation(db, {
      projectId: getConversation(db, conversationId)!.projectId,
      title: 'child',
      parentConversationId: conversationId,
    });
    const grandchild = createConversation(db, {
      projectId: child.projectId,
      title: 'grandchild',
      parentConversationId: child.id,
    });

    const out = moveConversationTree(db, conversationId, projectB);

    expect(out!.movedIds).toContain(conversationId);
    expect(out!.movedIds).toContain(child.id);
    expect(out!.movedIds).toContain(grandchild.id);
    expect(getConversation(db, child.id)?.projectId).toBe(projectB);
    expect(getConversation(db, grandchild.id)?.projectId).toBe(projectB);
  });

  it('leaves unrelated conversations in the source project alone', () => {
    const { db, projectA, projectB, conversationId } = bootDb();
    const bystander = createConversation(db, { projectId: projectA, title: 'bystander' });

    moveConversationTree(db, conversationId, projectB);

    expect(getConversation(db, bystander.id)?.projectId).toBe(projectA);
  });

  it('is a no-op returning the row when the target is the current project', () => {
    const { db, projectA, conversationId } = bootDb();
    const before = getConversation(db, conversationId)!;
    const out = moveConversationTree(db, conversationId, projectA);
    expect(out?.movedIds).toEqual([]);
    expect(out?.conversation.projectId).toBe(projectA);
    expect(out?.conversation.updatedAt).toBe(before.updatedAt);
  });

  it('returns undefined for an unknown conversation id', () => {
    const { db, projectB } = bootDb();
    expect(moveConversationTree(db, 'nope', projectB)).toBeUndefined();
  });

  it('clears workdir_path so the next turn uses the destination project root', () => {
    const { db, projectA, projectB, conversationId } = bootDb();
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?')
      .run('/a/.worktrees/old', conversationId);
    const child = createConversation(db, {
      projectId: projectA,
      title: 'child',
      parentConversationId: conversationId,
      workdirPath: '/a/.worktrees/child',
    });

    moveConversationTree(db, conversationId, projectB);

    expect(getConversation(db, conversationId)?.workdirPath).toBeUndefined();
    expect(getConversation(db, child.id)?.workdirPath).toBeUndefined();
    expect(getConversation(db, conversationId)?.projectId).toBe(projectB);
  });

  it('clears native_session_id so the next prompt cannot resume the old cwd session', () => {
    const { db, projectB, conversationId } = bootDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', conversationId, 'claude-code', 'native-old', now, now);

    moveConversationTree(db, conversationId, projectB);

    const row = db.prepare(
      'SELECT native_session_id AS nativeSessionId FROM sessions WHERE id = ?',
    ).get('sess-1') as { nativeSessionId: string | null };
    expect(row.nativeSessionId).toBeNull();
  });

  it('does not clear native_session_id on a same-project no-op', () => {
    const { db, projectA, conversationId } = bootDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-2', conversationId, 'claude-code', 'native-keep', now, now);

    moveConversationTree(db, conversationId, projectA);

    const row = db.prepare(
      'SELECT native_session_id AS nativeSessionId FROM sessions WHERE id = ?',
    ).get('sess-2') as { nativeSessionId: string | null };
    expect(row.nativeSessionId).toBe('native-keep');
  });
});

/** Boots the DB from bootDb() plus a mounted express app.
 *  `inFlight` makes every conversation look mid-turn (same shape as
 *  conversations.delete.test.ts). `notified` records notifyConversationUpdated. */
function bootApp(opts: { inFlight?: boolean } = {}) {
  const base = bootDb();
  const notified: string[] = [];
  const sessionManager = {
    inFlightSessionForConversation: () => (opts.inFlight ? ({} as never) : undefined),
    reapParkedSessions: async () => {},
  };
  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, {
    getDb: () => base.db,
    sessionManager: sessionManager as never,
    notifyConversationUpdated: (id: string) => { notified.push(id); },
  });
  return { ...base, app, notified };
}

function fetchPatch(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (r) => ({ status: r.status, body: await r.json() }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

type PatchOk = { conversation: { id: string; projectId: string; title: string } };
type PatchErr = { error: string };

describe('PATCH /conversations/:id projectId (FW-10)', () => {
  it('moves the conversation and returns the updated row', async () => {
    const { db, app, projectB, conversationId } = bootApp();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { projectId: projectB });
    expect(res.status).toBe(200);
    expect((res.body as PatchOk).conversation.projectId).toBe(projectB);
    expect(getConversation(db, conversationId)?.projectId).toBe(projectB);
  });

  it('broadcasts conversation_updated for the moved root', async () => {
    const { app, projectB, conversationId, notified } = bootApp();
    await fetchPatch(app, `/conversations/${conversationId}`, { projectId: projectB });
    expect(notified).toEqual([conversationId]);
  });

  it('does not broadcast for a same-project no-op', async () => {
    const { app, projectA, conversationId, notified } = bootApp();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { projectId: projectA });
    expect(res.status).toBe(200);
    expect((res.body as PatchOk).conversation.projectId).toBe(projectA);
    expect(notified).toEqual([]);
  });

  it('returns 404 for an unknown target project', async () => {
    const { db, app, projectA, conversationId } = bootApp();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { projectId: 'no-such-project' });
    expect(res.status).toBe(404);
    expect((res.body as PatchErr).error).toMatch(/no such project/i);
    expect(getConversation(db, conversationId)?.projectId).toBe(projectA);
  });

  it('returns 404 for an unknown conversation', async () => {
    const { app, projectB } = bootApp();
    const res = await fetchPatch(app, '/conversations/nope', { projectId: projectB });
    expect(res.status).toBe(404);
    expect((res.body as PatchErr).error).toMatch(/no such conversation/i);
  });

  it('returns 409 when the source is a schedule home', async () => {
    const { db, app, projectA, projectB } = bootApp();
    const home = createScheduleHomeConversation(db, { projectId: projectA, jobName: 'nightly' });
    const res = await fetchPatch(app, `/conversations/${home.id}`, { projectId: projectB });
    expect(res.status).toBe(409);
    expect((res.body as PatchErr).error).toMatch(/schedule home/i);
    expect(getConversation(db, home.id)?.projectId).toBe(projectA);
  });

  it('returns 400 for a spawn child (root conversations only)', async () => {
    const { db, app, projectA, projectB, conversationId } = bootApp();
    const child = createConversation(db, {
      projectId: projectA, title: 'child', parentConversationId: conversationId,
    });
    const res = await fetchPatch(app, `/conversations/${child.id}`, { projectId: projectB });
    expect(res.status).toBe(400);
    expect((res.body as PatchErr).error).toMatch(/root/i);
    expect(getConversation(db, child.id)?.projectId).toBe(projectA);
  });

  it('returns 409 when any conversation in the subtree has a live session', async () => {
    const { db, app, projectA, projectB, conversationId } = bootApp({ inFlight: true });
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { projectId: projectB });
    expect(res.status).toBe(409);
    expect((res.body as PatchErr).error).toMatch(/live session/i);
    expect(getConversation(db, conversationId)?.projectId).toBe(projectA);
  });

  it('rejects a blank projectId as the only field with 400', async () => {
    const { app, conversationId } = bootApp();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, { projectId: '   ' });
    expect(res.status).toBe(400);
    expect((res.body as PatchErr).error).toMatch(/projectId/);
  });

  it('mentions projectId in the "nothing to update" 400', async () => {
    const { app, conversationId } = bootApp();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, {});
    expect(res.status).toBe(400);
    expect((res.body as PatchErr).error).toMatch(/projectId/);
  });

  it('applies a combined title + projectId patch', async () => {
    const { db, app, projectB, conversationId } = bootApp();
    const res = await fetchPatch(app, `/conversations/${conversationId}`, {
      title: 'Renamed', projectId: projectB,
    });
    expect(res.status).toBe(200);
    const body = (res.body as PatchOk).conversation;
    expect(body.title).toBe('Renamed');
    expect(body.projectId).toBe(projectB);
    expect(getConversation(db, conversationId)?.title).toBe('Renamed');
  });

  it('moves spawn children along with the root over HTTP', async () => {
    const { db, app, projectA, projectB, conversationId } = bootApp();
    const child = createConversation(db, {
      projectId: projectA, title: 'child', parentConversationId: conversationId,
    });
    const bystander = createConversation(db, { projectId: projectA, title: 'bystander' });

    const res = await fetchPatch(app, `/conversations/${conversationId}`, { projectId: projectB });

    expect(res.status).toBe(200);
    expect(getConversation(db, child.id)?.projectId).toBe(projectB);
    expect(getConversation(db, bystander.id)?.projectId).toBe(projectA);
  });

  it('409s a move out of the Remote Agents container', async () => {
    const { db, app, projectB } = bootApp();
    ensureRemoteAgentsProject(db);
    const bot = createConversation(db, {
      projectId: REMOTE_AGENTS_PROJECT_ID, title: 'Bot chat',
    });
    const res = await fetchPatch(app, `/conversations/${bot.id}`, { projectId: projectB });
    expect(res.status).toBe(409);
    expect((res.body as PatchErr).error).toBe('Remote Agents conversations cannot be moved');
    expect(getConversation(db, bot.id)?.projectId).toBe(REMOTE_AGENTS_PROJECT_ID);
  });

  it('409s a move into the Remote Agents container', async () => {
    const { db, app, conversationId, projectA } = bootApp();
    ensureRemoteAgentsProject(db);
    const res = await fetchPatch(app, `/conversations/${conversationId}`, {
      projectId: REMOTE_AGENTS_PROJECT_ID,
    });
    expect(res.status).toBe(409);
    expect((res.body as PatchErr).error).toBe('Remote Agents conversations cannot be moved');
    expect(getConversation(db, conversationId)?.projectId).toBe(projectA);
  });

  it('keeps a title change when a combined move into Remote Agents is 409', async () => {
    const { db, app, conversationId, projectA } = bootApp();
    ensureRemoteAgentsProject(db);
    const res = await fetchPatch(app, `/conversations/${conversationId}`, {
      title: 'Renamed', projectId: REMOTE_AGENTS_PROJECT_ID,
    });
    expect(res.status).toBe(409);
    expect((res.body as PatchErr).error).toBe('Remote Agents conversations cannot be moved');
    expect(getConversation(db, conversationId)?.title).toBe('Renamed');
    expect(getConversation(db, conversationId)?.projectId).toBe(projectA);
  });
});

