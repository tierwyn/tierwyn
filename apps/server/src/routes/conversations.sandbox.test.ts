import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation, duplicateConversation, forkConversation } from '../repositories/conversations.js';
import { registerConversationMutationRoutes } from './conversations.js';
import type { ServerFrame } from '@tierwyn/shared';

let server: Server;
let base: string;
let convId: string;
let projectId: string;
const broadcastFrames: ServerFrame[] = [];

beforeEach(async () => {
  broadcastFrames.length = 0;
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  seedCatalogue(db);
  setDb(db);
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  projectId = project.id;
  convId = createConversation(db, { projectId: project.id, title: 'root' }).id;

  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, {
    getDb: () => db,
    broadcastAll: (frame) => broadcastFrames.push(frame),
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        base = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('PATCH /conversations/:id sandbox', () => {
  it('rejects invalid sandbox with 400', async () => {
    const res = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandbox: 'bogus' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('invalid sandbox');
  });

  it('persists on and clears with null', async () => {
    const on = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandbox: 'on' }),
    });
    expect(on.status).toBe(200);
    expect(getConversation(getDb(), convId)?.sandbox).toBe('on');

    const off = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandbox: null }),
    });
    expect(off.status).toBe(200);
    expect(getConversation(getDb(), convId)?.sandbox).toBeUndefined();

    // Verify broadcastAll emitted conversation_updated with sandbox
    const onFrame = broadcastFrames.find((f) => f.type === 'conversation_updated' && f.conversationId === convId && f.sandbox === 'on');
    expect(onFrame).toBeDefined();
    const offFrame = broadcastFrames.find((f) => f.type === 'conversation_updated' && f.conversationId === convId && f.sandbox === null);
    expect(offFrame).toBeDefined();
  });

  it('duplicate and fork preserve sandbox', () => {
    const db = getDb();
    const original = createConversation(db, { projectId, title: 'src', sandbox: 'on' });
    db.prepare("INSERT INTO sessions (id, conversation_id, created_at, updated_at) VALUES ('s1', ?, 0, 0)").run(original.id);
    db.prepare("INSERT INTO events (id, session_id, type, payload, sender, seq, ts) VALUES ('e1', 's1', 'message', '{}', 'agent', 0, 1)").run();
    const dup = duplicateConversation(db, original.id);
    expect(dup.sandbox).toBe('on');
    const fork = forkConversation(db, original.id, 'e1');
    expect(fork.sandbox).toBe('on');
  });
});
