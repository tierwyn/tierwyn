import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { registerConversationMutationRoutes } from './conversations.js';

let server: Server;
let base: string;
let convId: string;
const mockBroadcast = vi.fn();

beforeEach(async () => {
  mockBroadcast.mockReset();
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  seedCatalogue(db);
  setDb(db);
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  convId = createConversation(db, { projectId: project.id, title: 'root' }).id;

  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, {
    getDb: () => db,
    broadcastAll: mockBroadcast,
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

describe('PATCH /conversations/:id pendingHandoffMode', () => {
  it('stages summary, broadcasts pendingHandoffMode, and does not bump updated_at', async () => {
    const before = getConversation(getDb(), convId)!;
    const res = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingHandoffMode: 'summary' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { conversation: { pendingHandoffMode?: string; updatedAt: number } };
    expect(body.conversation.pendingHandoffMode).toBe('summary');
    expect(body.conversation.updatedAt).toBe(before.updatedAt);
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'conversation_updated',
      conversationId: convId,
      pendingHandoffMode: 'summary',
    }));
  });

  it('rejects bogus pendingHandoffMode with 400', async () => {
    const res = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingHandoffMode: 'bogus' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid pendingHandoffMode/i);
  });

  it('clears with null and broadcasts null', async () => {
    await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingHandoffMode: 'fresh' }),
    });
    mockBroadcast.mockClear();
    const res = await fetch(`${base}/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingHandoffMode: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { conversation: { pendingHandoffMode?: string } };
    expect(body.conversation.pendingHandoffMode).toBeUndefined();
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'conversation_updated',
      conversationId: convId,
      pendingHandoffMode: null,
    }));
  });
});
