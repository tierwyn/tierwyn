import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import Database from 'better-sqlite3';
import { parseMemoryId, type ServerFrame } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import {
  saveMemory,
  searchVisibleMemories,
  extractRecallKeywords,
  supersedeMemory,
  flagMemory,
  type SaveInput,
} from '../repositories/memories.js';
import { registerOperatorMemoryRoutes } from './memories.js';

const NOW = 1_800_000_000_000;

let db: Database.Database;
let app: express.Express;
let projectA: string;
let projectB: string;
let convA: string;
let frames: ServerFrame[];

function base(over: Partial<SaveInput> = {}): SaveInput {
  return {
    projectId: projectA,
    kind: 'fact',
    text: 'alpha widget routes behind web',
    agent: 'claude-code',
    conversationId: convA,
    now: NOW,
    ...over,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  frames = [];
  const pA = createProject(db, { name: 'A', rootPath: '/tmp/a' });
  const pB = createProject(db, { name: 'B', rootPath: '/tmp/b' });
  projectA = pA.id;
  projectB = pB.id;
  convA = createConversation(db, { projectId: pA.id, title: 'Chat A' }).id;
  app = express();
  app.use(express.json());
  registerOperatorMemoryRoutes(app, {
    getDb: () => db,
    broadcastAll: (f) => { frames.push(f); },
  });
});

async function call(
  method: string,
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

describe('operator memory routes', () => {
  it('operator list returns all projects; projectId filters', async () => {
    saveMemory(db, base({ text: 'alpha in project A' }));
    saveMemory(db, base({ projectId: projectB, conversationId: null, text: 'alpha in project B' }));
    const all = await call('GET', '/memories');
    expect(all.status).toBe(200);
    expect(all.body.memories).toHaveLength(2);
    const filtered = await call('GET', `/memories?projectId=${projectA}`);
    expect(filtered.body.memories).toHaveLength(1);
    expect(filtered.body.memories[0].projectId).toBe(projectA);
  });

  it('Review Focus 4: a row whose conversation was purged lists with a null title', async () => {
    const { memory } = saveMemory(db, base({}));
    db.prepare('DELETE FROM conversations WHERE id = ?').run(convA);
    const got = await call('GET', `/memories/${memory.id}`);
    expect(got.status).toBe(200);
    expect(got.body.createdByConversation).toBe(convA);
    expect(got.body.createdByConversationTitle).toBeNull();
  });

  it('superseded rows appear only with includeSuperseded', async () => {
    const old = saveMemory(db, base({ text: 'old alpha widget' })).memory;
    const neu = saveMemory(db, base({ text: 'new alpha widget' })).memory;
    expect(supersedeMemory(db, projectA, parseMemoryId(old.id)!, parseMemoryId(neu.id)!)).toBe('ok');
    const hidden = await call('GET', '/memories');
    expect(hidden.body.memories.map((m: { id: string }) => m.id)).not.toContain(old.id);
    const shown = await call('GET', '/memories?includeSuperseded=1');
    expect(shown.body.memories.map((m: { id: string }) => m.id)).toContain(old.id);
  });

  it('promote without a pending suggestion is 409', async () => {
    const { memory } = saveMemory(db, base({}));
    const res = await call('POST', `/memories/${memory.id}/promote`);
    expect(res.status).toBe(409);
  });

  it('promote and dismiss leave no pending count; promoted disappears from agent search', async () => {
    const pending = saveMemory(db, base({
      text: 'promote me alpha widget', suggestRule: true, ruleReason: 'agents need it',
    })).memory;
    expect((await call('GET', '/memories/counts')).body).toMatchObject({ pendingSuggestions: 1, flagged: 0 });
    expect((await call('POST', `/memories/${pending.id}/promote`)).status).toBe(200);
    expect((await call('GET', '/memories/counts')).body.pendingSuggestions).toBe(0);
    const hits = searchVisibleMemories(db, projectA, extractRecallKeywords('promote me alpha widget'), 10);
    expect(hits.map((h) => `m_${h.id}`)).not.toContain(pending.id);

    const other = saveMemory(db, base({
      text: 'dismiss me alpha widget', suggestRule: true, ruleReason: 'maybe',
    })).memory;
    expect((await call('POST', `/memories/${other.id}/dismiss`)).status).toBe(200);
    expect((await call('GET', '/memories/counts')).body.pendingSuggestions).toBe(0);
    const still = searchVisibleMemories(db, projectA, extractRecallKeywords('dismiss me alpha widget'), 10);
    expect(still.map((h) => `m_${h.id}`)).toContain(other.id);
  });

  it('no operator route accepts a Bearer token', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const auth = src.indexOf('app.use(requireAuth(authConfig))');
    const op = src.indexOf('registerOperatorMemoryRoutes(app');
    expect(auth).toBeGreaterThan(-1);
    expect(op).toBeGreaterThan(auth);
  });

  it('each mutation broadcasts memory_updated with counts', async () => {
    const flagged = saveMemory(db, base({ text: 'flagged alpha widget' })).memory;
    flagMemory(db, parseMemoryId(flagged.id)!, 'task_chatter');
    const pending = saveMemory(db, base({
      text: 'pending alpha widget', suggestRule: true, ruleReason: 'r',
    })).memory;
    const doomed = saveMemory(db, base({ text: 'doomed alpha widget' })).memory;
    frames.length = 0;

    expect((await call('POST', `/memories/${flagged.id}/approve`)).status).toBe(200);
    expect((await call('POST', `/memories/${pending.id}/dismiss`)).status).toBe(200);
    expect((await call('DELETE', `/memories/${doomed.id}`)).status).toBe(204);

    const updates = frames.filter((f) => f.type === 'memory_updated');
    expect(updates).toHaveLength(3);
    for (const f of updates) {
      expect(f).toMatchObject({ type: 'memory_updated', counts: { pendingSuggestions: expect.any(Number), flagged: expect.any(Number) } });
    }
  });

  it('POST /memories/:id/flag flags an active memory', async () => {
    const { memory } = saveMemory(db, base({ text: 'active alpha widget' }));
    frames.length = 0;
    const res = await call('POST', `/memories/${memory.id}/flag`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await call('GET', `/memories/${memory.id}`)).body).toMatchObject({
      status: 'flagged',
      flagReason: 'irrelevant_recall',
    });
    expect(frames.filter((f) => f.type === 'memory_updated')).toHaveLength(1);
  });

  it('POST /memories/:id/flag on already-flagged is 409', async () => {
    const { memory } = saveMemory(db, base({ text: 'flagged alpha widget' }));
    flagMemory(db, parseMemoryId(memory.id)!, 'task_chatter');
    const res = await call('POST', `/memories/${memory.id}/flag`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('memory is not active');
  });

  it('POST /memories/:id/flag with malformed id is 400', async () => {
    const res = await call('POST', '/memories/not-an-id/flag');
    expect(res.status).toBe(400);
  });

  it('POST /memories/:id/edit supersedes with an operator-authored copy', async () => {
    const { memory } = saveMemory(db, base({ kind: 'gotcha', text: 'set TIERWYN_GIT_RUN_HOOKS widget' }));
    frames.length = 0;
    const res = await call('POST', `/memories/${memory.id}/edit`, { text: '  set TIERWYN_GIT_RUN_HOOKS widget ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'gotcha', text: 'set TIERWYN_GIT_RUN_HOOKS widget', status: 'active',
      projectId: projectA, createdByAgent: 'operator',
    });
    expect((await call('GET', `/memories/${memory.id}`)).body).toMatchObject({
      status: 'superseded', supersededBy: res.body.id,
    });
    const hits = searchVisibleMemories(db, projectA, extractRecallKeywords('tierwyn_git_run_hooks widget'), 5);
    expect(hits.map((h) => `m_${h.id}`)).toEqual([res.body.id]);
    expect(frames.filter((f) => f.type === 'memory_updated')).toHaveLength(1);
  });

  it('POST /memories/:id/edit rejects bad input and non-active rows', async () => {
    const { memory } = saveMemory(db, base({ text: 'edit target widget' }));
    expect((await call('POST', `/memories/${memory.id}/edit`, { text: '   ' })).status).toBe(400);
    expect((await call('POST', `/memories/${memory.id}/edit`, { text: 'x'.repeat(501) })).status).toBe(400);
    expect((await call('POST', `/memories/${memory.id}/edit`, {})).status).toBe(400);
    expect((await call('POST', '/memories/m_9999/edit', { text: 'nope' })).status).toBe(404);
    flagMemory(db, parseMemoryId(memory.id)!, 'task_chatter');
    expect((await call('POST', `/memories/${memory.id}/edit`, { text: 'fixed' })).status).toBe(409);
  });
});
