import { describe, expect, it, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createConversation } from '../repositories/conversations.js';
import { createProject } from '../repositories/projects.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { issueSpawnToken, revokeSpawnTokensForSession } from '../spawn/tokens.js';
import {
  NODE_HEADER,
  NODE_SECRET_HEADER,
  originGuard,
} from './originGuard.js';

const SECRET = 'node-secret-for-tests';
const sessions: string[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) revokeSpawnTokensForSession(s);
});

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const localProject = createProject(db, { name: 'local', rootPath: '/tmp/local' });
  const localConv = createConversation(db, { projectId: localProject.id, title: 'lc' });
  const host = createPendingHost(db, 'alpha', 'tok', Date.now() + 60_000);
  const other = createPendingHost(db, 'beta', 'tok2', Date.now() + 60_000);
  const remoteProject = createProject(db, {
    name: 'remote',
    rootPath: '/tmp/remote',
    remoteHostId: host.id,
  });
  const remoteConv = createConversation(db, { projectId: remoteProject.id, title: 'rc' });
  return { db, localConv, remoteConv, host, other };
}

function token(conversationId: string): string {
  const sessionId = `sess-${conversationId}`;
  sessions.push(sessionId);
  return issueSpawnToken(conversationId, sessionId);
}

async function invoke(
  db: Database,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ status: number; body: unknown; next: boolean; locals: Record<string, unknown>; headers: Request['headers'] }> {
  const guard = originGuard({ db: () => db, nodeSecret: SECRET });
  const req = { headers: { ...headers } } as Request;
  const locals: Record<string, unknown> = {};
  let status = 200;
  let body: unknown;
  let nexted = false;
  await new Promise<void>((resolve) => {
    const res = {
      locals,
      status(n: number) { status = n; return res; },
      json(b: unknown) { body = b; resolve(); return res; },
    } as unknown as Response;
    const next: NextFunction = () => { nexted = true; resolve(); };
    guard(req, res, next);
  });
  return { status: nexted ? 200 : status, body, next: nexted, locals, headers: req.headers };
}

describe('originGuard', () => {
  it('local token on plain loopback → next', async () => {
    const { db, localConv } = fresh();
    const out = await invoke(db, { authorization: `Bearer ${token(localConv.id)}` });
    expect(out.next).toBe(true);
    expect(out.status).toBe(200);
  });

  it('remote token on plain loopback → 403', async () => {
    const { db, remoteConv } = fresh();
    const out = await invoke(db, { authorization: `Bearer ${token(remoteConv.id)}` });
    expect(out.next).toBe(false);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: 'token_origin_mismatch' });
  });

  it('remote token via tunnel of same host → next', async () => {
    const { db, remoteConv, host } = fresh();
    const out = await invoke(db, {
      authorization: `Bearer ${token(remoteConv.id)}`,
      [NODE_SECRET_HEADER]: SECRET,
      [NODE_HEADER]: host.id,
    });
    expect(out.next).toBe(true);
    expect(out.locals.nodeHostId).toBe(host.id);
  });

  it('remote token via tunnel of other host → 403', async () => {
    const { db, remoteConv, other } = fresh();
    const out = await invoke(db, {
      authorization: `Bearer ${token(remoteConv.id)}`,
      [NODE_SECRET_HEADER]: SECRET,
      [NODE_HEADER]: other.id,
    });
    expect(out.next).toBe(false);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: 'token_origin_mismatch' });
  });

  it('local token via tunnel → 403', async () => {
    const { db, localConv, host } = fresh();
    const out = await invoke(db, {
      authorization: `Bearer ${token(localConv.id)}`,
      [NODE_SECRET_HEADER]: SECRET,
      [NODE_HEADER]: host.id,
    });
    expect(out.next).toBe(false);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: 'token_origin_mismatch' });
  });

  it('forged x-tierwyn-node without secret is stripped → remote token 403', async () => {
    const { db, remoteConv, host } = fresh();
    const out = await invoke(db, {
      authorization: `Bearer ${token(remoteConv.id)}`,
      [NODE_HEADER]: host.id,
    });
    expect(out.headers[NODE_HEADER]).toBeUndefined();
    expect(out.locals.nodeHostId).toBeUndefined();
    expect(out.next).toBe(false);
    expect(out.status).toBe(403);
  });

  it('node headers (x-tierwyn-*) authenticate', async () => {
    const { db, remoteConv, host } = fresh();
    const out = await invoke(db, {
      authorization: `Bearer ${token(remoteConv.id)}`,
      [NODE_SECRET_HEADER]: SECRET,
      [NODE_HEADER]: host.id,
    });
    expect(out.next).toBe(true);
    expect(out.locals.nodeHostId).toBe(host.id);
  });

  it('cookie request without bearer → next', async () => {
    const { db } = fresh();
    const out = await invoke(db, { cookie: 'tierwyn=operator' });
    expect(out.next).toBe(true);
  });

  it('matched secret header is gone by next()', async () => {
    const { db, host } = fresh();
    const out = await invoke(db, {
      cookie: 'tierwyn=operator',
      [NODE_SECRET_HEADER]: SECRET,
      [NODE_HEADER]: host.id,
    });
    expect(out.next).toBe(true);
    expect(out.locals.nodeHostId).toBe(host.id);
    expect(out.headers[NODE_SECRET_HEADER]).toBeUndefined();
    expect(out.headers[NODE_HEADER]).toBe(host.id);
  });
});
