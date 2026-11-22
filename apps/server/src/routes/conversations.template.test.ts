import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation } from '../repositories/conversations.js';
import { saveTemplate } from '../repositories/settings.js';
import { registerConversationMutationRoutes } from './conversations.js';

let server: Server; let base: string; let convId: string;

beforeEach(async () => {
  const db = openDb(':memory:'); runMigrations(db, migrations); seedDefaultSettings(db); setDb(db);
  saveTemplate(db, { name: 'team', roles: [] });
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  convId = createConversation(db, { projectId: project.id, title: 'root' }).id;
  const app = express(); app.use(express.json());
  registerConversationMutationRoutes(app, getDb);
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const patch = (body: unknown) => fetch(`${base}/conversations/${convId}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('PATCH /conversations/:id templateName', () => {
  it('attaches a known template', async () => {
    const res = await patch({ templateName: 'team' });
    expect(res.status).toBe(200);
    expect(getConversation(getDb(), convId)!.templateName).toBe('team');
  });
  it('rejects an unknown template', async () => {
    const res = await patch({ templateName: 'ghost' });
    expect(res.status).toBe(400);
  });
  it('detaches on null', async () => {
    await patch({ templateName: 'team' });
    const res = await patch({ templateName: null });
    expect(res.status).toBe(200);
    expect(getConversation(getDb(), convId)!.templateName).toBeUndefined();
  });
  it('rejects empty string as an unknown template', async () => {
    const res = await patch({ templateName: '' });
    expect(res.status).toBe(400);
  });
  it('still renames via title', async () => {
    const res = await patch({ title: 'renamed' });
    expect(res.status).toBe(200);
    expect(getConversation(getDb(), convId)!.title).toBe('renamed');
  });
  it('reaps parked sessions when template changes and sessionManager is present', async () => {
    const reapFn = vi.fn(async () => {});
    const app2 = express();
    app2.use(express.json());
    registerConversationMutationRoutes(app2, {
      getDb,
      sessionManager: { reapParkedSessions: reapFn } as any,
    });
    const s2 = app2.listen(0);
    const b2 = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;
    try {
      const res = await fetch(`${b2}/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateName: 'team' }),
      });
      expect(res.status).toBe(200);
      expect(reapFn).toHaveBeenCalledWith(convId, { all: true });
    } finally {
      s2.close();
    }
  });
});

describe('PATCH /conversations/:id spawnWorkdir', () => {
  it('sets worktree pin and reads it back', async () => {
    const res = await patch({ spawnWorkdir: 'worktree' });
    expect(res.status).toBe(200);
    expect(getConversation(getDb(), convId)!.spawnWorkdir).toBe('worktree');
  });
  it('clears pin with null', async () => {
    await patch({ spawnWorkdir: 'worktree' });
    const res = await patch({ spawnWorkdir: null });
    expect(res.status).toBe(200);
    expect(getConversation(getDb(), convId)!.spawnWorkdir).toBeUndefined();
  });
  it('rejects bogus value with 400', async () => {
    const res = await patch({ spawnWorkdir: 'bogus' });
    expect(res.status).toBe(400);
  });
});
