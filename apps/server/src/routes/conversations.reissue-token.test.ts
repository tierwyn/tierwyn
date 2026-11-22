import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { registerConversationMutationRoutes } from './conversations.js';

let server: Server;
let base: string;
let convId: string;
const mockReissue = vi.fn();

beforeEach(async () => {
  mockReissue.mockReset();
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  setDb(db);
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  convId = createConversation(db, { projectId: project.id, title: 'root' }).id;

  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, {
    getDb,
    sessionManager: {
      reissueSpawnToken: mockReissue,
    } as any,
  });

  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('POST /conversations/:id/reissue-token', () => {
  it('returns 404 for unknown conversation', async () => {
    const res = await fetch(`${base}/conversations/nonexistent-id/reissue-token`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('re-issues token and returns token data for valid conversation', async () => {
    mockReissue.mockResolvedValueOnce({
      token: 'test-spawn-token-1234',
      expiresAt: Date.now() + 1800000,
      injected: true,
    });

    const res = await fetch(`${base}/conversations/${convId}/reissue-token`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe('test-spawn-token-1234');
    expect(data.injected).toBe(true);
    expect(mockReissue).toHaveBeenCalledWith(convId);
  });

  it('returns 409 when the conversation takes no token', async () => {
    mockReissue.mockResolvedValueOnce(null);

    const res = await fetch(`${base}/conversations/${convId}/reissue-token`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('conversation takes no token');
  });
});
