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

let server: Server;
let base: string;
let convId: string;
let projectId: string;
const mockApply = vi.fn();

beforeEach(async () => {
  mockApply.mockReset();
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
    sessionManager: { applyConversationPermissionMode: mockApply } as any,
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

describe('PATCH /conversations/:id permissionMode', () => {
  it('updates permissionMode to prompt, calls applyConversationPermissionMode, and persists', async () => {
    const res = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'prompt' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { conversation: { permissionMode: string } };
    expect(body.conversation.permissionMode).toBe('prompt');
    expect(mockApply).toHaveBeenCalledWith(convId);

    const saved = getConversation(getDb(), convId);
    expect(saved?.permissionMode).toBe('prompt');
  });

  it('updates permissionMode to questions and bypass', async () => {
    for (const mode of ['questions', 'bypass'] as const) {
      const res = await fetch(`${base}/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionMode: mode }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { conversation: { permissionMode: string } };
      expect(body.conversation.permissionMode).toBe(mode);
    }
  });

  it('clears permissionMode with null', async () => {
    // First set to prompt
    await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'prompt' }),
    });

    // Clear to null
    const res = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { conversation: { permissionMode?: string } };
    expect(body.conversation.permissionMode).toBeUndefined();

    const saved = getConversation(getDb(), convId);
    expect(saved?.permissionMode).toBeUndefined();
  });

  it('rejects invalid permissionMode with 400', async () => {
    const res = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'unsupported' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('invalid permissionMode');
  });

  it('duplicate and fork preserve permission_mode', () => {
    const db = getDb();
    const original = createConversation(db, {
      projectId,
      title: 'source',
      permissionMode: 'prompt',
    });
    expect(original.permissionMode).toBe('prompt');

    const dup = duplicateConversation(db, original.id);
    expect(dup?.permissionMode).toBe('prompt');

    db.prepare("INSERT INTO sessions (id, conversation_id, agent_id, created_at, updated_at) VALUES ('s1', ?, 'claude-code', 0, 0)").run(original.id);
    db.prepare("INSERT INTO events (id, session_id, type, payload, sender, seq, ts) VALUES ('e1', 's1', 'prompt', '{}', 'user', 1, 100)").run();

    const fork = forkConversation(db, original.id, 'e1');
    expect(fork.permissionMode).toBe('prompt');
  });
});
