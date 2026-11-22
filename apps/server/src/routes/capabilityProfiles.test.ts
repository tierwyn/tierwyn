import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { issueSpawnToken, peekSpawnToken } from '../spawn/tokens.js';
import { registerCapabilityProfileRoutes } from './capabilityProfiles.js';

let server: Server;
let base: string;
let projectA: string;
let projectB: string;
const mockReap = vi.fn();
const mockReissue = vi.fn();
const liveSessionIds = new Set<string>();

beforeEach(async () => {
  mockReap.mockReset();
  mockReissue.mockReset();
  liveSessionIds.clear();
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  setDb(db);
  projectA = createProject(db, { name: 'a', rootPath: '/tmp' }).id;
  projectB = createProject(db, { name: 'b', rootPath: '/tmp' }).id;

  const app = express();
  app.use(express.json());
  registerCapabilityProfileRoutes(app, {
    getDb,
    listPluginIds: () => ['gemini-image', 'zai-usage'],
    sessionManager: {
      reapParkedSessions: mockReap,
      reissueSpawnToken: mockReissue,
      hasLiveSession: (id: string) => liveSessionIds.has(id),
    },
  });

  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

async function get() {
  const res = await fetch(`${base}/settings/capability-profiles`);
  return { status: res.status, data: (await res.json()) as { profiles: Array<{ id: string; builtin?: true }>; defaultProfileId: string } };
}

describe('GET /settings/capability-profiles', () => {
  it('lists built-in profiles first, no customs initially, and returns defaultProfileId', async () => {
    const { status, data } = await get();
    expect(status).toBe(200);
    expect(data.defaultProfileId).toBe('all');
    expect(data.profiles.map((p) => p.id)).toEqual(['all']);
    expect(data.profiles.every((p) => p.builtin === true)).toBe(true);
  });
});

describe('POST /settings/capability-profiles', () => {
  it('creates a custom profile (201) and echoes it in the list', async () => {
    const res = await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'image-only', label: 'Image only', plugins: ['gemini-image'], usage: false }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { profile: { id: string; plugins: string[] }; profiles: Array<{ id: string }> };
    expect(data.profile).toEqual({ id: 'image-only', label: 'Image only', plugins: ['gemini-image'], usage: false });
    expect(data.profiles.map((p) => p.id)).toEqual(['all', 'image-only']);
  });

  it('rejects unknown plugin ids with 400', async () => {
    const res = await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'team', label: 'Team', plugins: ['nope'], usage: false }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('nope');
    const list = await get();
    expect(list.data.profiles.map((p) => p.id)).toEqual(['all']);
  });

  it('rejects a built-in id with 409 — built-ins are read-only', async () => {
    const res = await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'all', label: 'Hijacked', plugins: '*', usage: false }),
    });
    expect(res.status).toBe(409);
    const list = await get();
    expect(list.data.profiles.find((p) => p.id === 'all')).toMatchObject({ usage: true, plugins: '*' });
  });

  it('revokes live tokens of conversations using the profile when the grant narrows', async () => {
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'team', label: 'Team', plugins: '*', usage: true }),
    });
    const conv = createConversation(getDb(), { projectId: projectA, title: 'one', capabilityProfile: 'team' });
    const tok = issueSpawnToken(conv.id, 'sess-team', 'spawn', { id: 'team', plugins: '*', usage: true });
    liveSessionIds.add(conv.id);
    const res = await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'team', label: 'Team', plugins: ['gemini-image'], usage: false }),
    });
    expect(res.status).toBe(201);
    expect(peekSpawnToken(tok)).toBeUndefined();
    expect(mockReap).toHaveBeenCalledWith(conv.id, { all: true });
    expect(mockReissue).toHaveBeenCalledWith(conv.id);
  });

  it('does not reissue when no live session is attached to a conversation using the profile', async () => {
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'team', label: 'Team', plugins: '*', usage: true }),
    });
    const conv = createConversation(getDb(), { projectId: projectA, title: 'one', capabilityProfile: 'team' });
    const tok = issueSpawnToken(conv.id, 'sess-team', 'spawn', { id: 'team', plugins: '*', usage: true });
    const res = await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'team', label: 'Team', plugins: ['gemini-image'], usage: false }),
    });
    expect(res.status).toBe(201);
    expect(peekSpawnToken(tok)).toBeUndefined();
    expect(mockReissue).not.toHaveBeenCalled();
  });

  it('skips revoke when only the label changes', async () => {
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'team', label: 'Team', plugins: ['gemini-image'], usage: false }),
    });
    const conv = createConversation(getDb(), { projectId: projectA, title: 'one', capabilityProfile: 'team' });
    const tok = issueSpawnToken(conv.id, 'sess-team', 'spawn', { id: 'team', plugins: ['gemini-image'], usage: false });
    const res = await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'team', label: 'Team renamed', plugins: ['gemini-image'], usage: false }),
    });
    expect(res.status).toBe(201);
    expect(peekSpawnToken(tok)).toBeDefined();
    expect(mockReissue).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload with 400', async () => {
    const res = await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'Bad Id', label: 'x', plugins: '*', usage: true }),
    });
    expect(res.status).toBe(400);
  });

  it('revokes tokens of conversations using default profile when the default profile itself is edited and narrows', async () => {
    // 1. Create custom profile and make it default
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-def', label: 'Custom Default', plugins: ['gemini-image'], usage: false }),
    });
    await fetch(`${base}/settings/capability-profiles/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-def' }),
    });

    // 2. Create conversation that has NULL capabilityProfile (i.e. uses default)
    const conv = createConversation(getDb(), { projectId: projectA, title: 'uses-default' });
    liveSessionIds.add(conv.id);
    const tok = issueSpawnToken(conv.id, 'sess-default-conv', 'spawn', { id: 'custom-def', plugins: ['gemini-image'], usage: false });

    mockReap.mockClear();
    mockReissue.mockClear();

    // 3. Narrow custom-def plugins from ['gemini-image'] to []
    const res = await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-def', label: 'Custom Default', plugins: [], usage: false }),
    });
    expect(res.status).toBe(201);

    // 4. Token must be dead and session reissued
    expect(peekSpawnToken(tok)).toBeUndefined();
    expect(mockReap).toHaveBeenCalledWith(conv.id, { all: true });
    expect(mockReissue).toHaveBeenCalledWith(conv.id);
  });
});

describe('POST /settings/capability-profiles/default', () => {
  it('switches the default profile and returns updated defaultProfileId', async () => {
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-def', label: 'Custom Def', plugins: [], usage: false }),
    });

    const res = await fetch(`${base}/settings/capability-profiles/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-def' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; defaultProfileId: string };
    expect(data.ok).toBe(true);
    expect(data.defaultProfileId).toBe('custom-def');

    const check = await get();
    expect(check.data.defaultProfileId).toBe('custom-def');
  });

  it('rejects an unknown profile id with 404', async () => {
    const res = await fetch(`${base}/settings/capability-profiles/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid payload with 400', async () => {
    const res = await fetch(`${base}/settings/capability-profiles/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('refreshes capability tokens for live conversations using the default profile', async () => {
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-def', label: 'Custom Def', plugins: ['gemini-image'], usage: false }),
    });

    const db = getDb();
    const conv = createConversation(db, { projectId: projectA, title: 'conv-default' });
    liveSessionIds.add(conv.id);

    const res = await fetch(`${base}/settings/capability-profiles/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-def' }),
    });
    expect(res.status).toBe(200);
    expect(mockReap).toHaveBeenCalledWith(conv.id, { all: true });
    expect(mockReissue).toHaveBeenCalledWith(conv.id);
  });
});

describe('DELETE /settings/capability-profiles/:id', () => {
  it('deletes a custom profile', async () => {
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'temp', label: 'Temp', plugins: [], usage: false }),
    });
    const res = await fetch(`${base}/settings/capability-profiles/temp`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { profiles: Array<{ id: string }> };
    expect(data.profiles.map((p) => p.id)).toEqual(['all']);
  });

  it('404 for unknown id', async () => {
    const res = await fetch(`${base}/settings/capability-profiles/nope`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('409 for a built-in id', async () => {
    const res = await fetch(`${base}/settings/capability-profiles/all`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const list = await get();
    expect(list.data.profiles.map((p) => p.id)).toContain('all');
  });

  it('409 when attempting to delete the active default profile', async () => {
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'active-def', label: 'Active Def', plugins: [], usage: false }),
    });
    // Set as default
    await fetch(`${base}/settings/capability-profiles/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'active-def' }),
    });

    const res = await fetch(`${base}/settings/capability-profiles/active-def`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('cannot delete the default capability profile');
  });

  it('409 with the conversation count when the profile is in use', async () => {
    await fetch(`${base}/settings/capability-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'team', label: 'Team', plugins: [], usage: true }),
    });
    const db = getDb();
    createConversation(db, { projectId: projectA, title: 'one', capabilityProfile: 'team' });
    createConversation(db, { projectId: projectB, title: 'two', capabilityProfile: 'team' });
    const res = await fetch(`${base}/settings/capability-profiles/team`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string; conversations: number };
    expect(data.conversations).toBe(2);
    expect(data.error).toContain('2 conversation');
  });
});
