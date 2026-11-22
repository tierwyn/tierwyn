import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { PluginManifest, ResolvedCapabilityProfile } from '@tierwyn/shared';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, getConversation, setConversationCapabilityProfile } from '../repositories/conversations.js';
import { resolveConversationProfile, saveCapabilityProfile } from '../repositories/capabilityProfiles.js';
import { PluginHost } from '../plugins/host.js';
import { registerPluginAgentRoutes } from './plugins.js';
import {
  issueSpawnToken,
  peekSpawnToken,
  getLiveTokenForConversation,
} from '../spawn/tokens.js';
import { registerConversationMutationRoutes } from './conversations.js';

let server: Server;
let base: string;
let convId: string;
let projectId: string;
const mockReap = vi.fn();
const mockReissue = vi.fn();
const liveSessionIds = new Set<string>();

function plugin(over: Partial<PluginManifest> & { id: string }): PluginManifest {
  return {
    name: over.id,
    version: '1.0.0',
    apiVersion: 1,
    capabilities: [{ name: 'echo', summary: 'echo', agentCallable: true }],
    ...over,
  };
}

beforeEach(async () => {
  mockReap.mockReset();
  mockReissue.mockReset();
  liveSessionIds.clear();
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  setDb(db);
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  projectId = project.id;
  convId = createConversation(db, { projectId: project.id, title: 'root' }).id;
  saveCapabilityProfile(db, { id: 'media', label: 'Media & Vision', plugins: ['gemini-image'], usage: false });
  saveCapabilityProfile(db, { id: 'minimal', label: 'Minimal', plugins: [], usage: false });

  const host = new PluginHost({ getDb: () => db, timeoutMs: 40 });
  const gemini = host.addManifest(plugin({
    id: 'gemini-image',
    capabilities: [{ name: 'image.generate', summary: 'img', agentCallable: true }],
  }), { enabled: true });
  gemini.capability('image.generate', async () => ({ image: true }));
  host.markActivated('gemini-image');
  const zai = host.addManifest(plugin({
    id: 'zai-usage',
    capabilities: [{ name: 'usage.get', summary: 'quota', agentCallable: true, usageProvider: { label: 'Z.AI' } }],
  }), { enabled: true });
  zai.capability('usage.get', async () => ({ fiveHourPct: 42 }));
  host.markActivated('zai-usage');

  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, {
    getDb,
    sessionManager: {
      reapParkedSessions: mockReap,
      reissueSpawnToken: mockReissue.mockImplementation(async (id: string) => {
        const conv = getConversation(getDb(), id);
        const profile = resolveConversationProfile(getDb(), conv?.capabilityProfile);
        const token = issueSpawnToken(id, `reissued-${id}`, 'spawn', profile);
        return { token, expiresAt: Date.now() + 60_000, injected: true };
      }),
      hasLiveSession: (id: string) => liveSessionIds.has(id),
    } as any,
  });
  registerPluginAgentRoutes(app, { host, isAuthed: () => false });

  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

async function patch(body: Record<string, unknown>, id = convId) {
  const res = await fetch(`${base}/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('PATCH /conversations/:id capabilityProfile', () => {
  it('rejects an unknown profile id with 400 and leaves the row untouched', async () => {
    const { status, data } = await patch({ capabilityProfile: 'no-such-profile' });
    expect(status).toBe(400);
    expect(data.error).toBe('unknown capability profile: no-such-profile');
    expect(getConversation(getDb(), convId)?.capabilityProfile).toBeUndefined();
  });

  it('accepts a built-in profile, reaps parked sessions, and re-mints only when a session is live', async () => {
    const { status } = await patch({ capabilityProfile: 'minimal' });
    expect(status).toBe(200);
    expect(getConversation(getDb(), convId)?.capabilityProfile).toBe('minimal');
    expect(mockReap).toHaveBeenCalledWith(convId, { all: true });
    expect(mockReissue).not.toHaveBeenCalled();
  });

  it('re-issues when a live session exists', async () => {
    liveSessionIds.add(convId);
    const { status } = await patch({ capabilityProfile: 'minimal' });
    expect(status).toBe(200);
    expect(mockReissue).toHaveBeenCalledWith(convId);
  });

  it('round-trips a custom profile', async () => {
    saveCapabilityProfile(getDb(), { id: 'team', label: 'Team', plugins: ['gemini-image'], usage: true });
    const { status } = await patch({ capabilityProfile: 'team' });
    expect(status).toBe(200);
    expect(getConversation(getDb(), convId)?.capabilityProfile).toBe('team');
  });

  it('clears the profile on null', async () => {
    setConversationCapabilityProfile(getDb(), convId, 'media');
    const { status } = await patch({ capabilityProfile: null });
    expect(status).toBe(200);
    expect(getConversation(getDb(), convId)?.capabilityProfile).toBeUndefined();
  });

  it('does not reap or re-issue when the value is unchanged', async () => {
    setConversationCapabilityProfile(getDb(), convId, 'media');
    const { status } = await patch({ capabilityProfile: 'media' });
    expect(status).toBe(200);
    expect(mockReap).not.toHaveBeenCalled();
    expect(mockReissue).not.toHaveBeenCalled();
  });

  it('treats explicit all and null as the same grant (no revoke)', async () => {
    const { status } = await patch({ capabilityProfile: 'all' });
    expect(status).toBe(200);
    expect(getConversation(getDb(), convId)?.capabilityProfile).toBeUndefined();
    expect(mockReap).not.toHaveBeenCalled();
    expect(mockReissue).not.toHaveBeenCalled();
  });

  it('cascades the new profile onto descendants and revokes their tokens', async () => {
    const child = createConversation(getDb(), {
      projectId,
      title: 'child',
      parentConversationId: convId,
    });
    const grand = createConversation(getDb(), {
      projectId,
      title: 'grand',
      parentConversationId: child.id,
    });
    const all: ResolvedCapabilityProfile = { id: 'all', plugins: '*', usage: true };
    const childTok = issueSpawnToken(child.id, 'sess-child', 'spawn', all);
    const grandTok = issueSpawnToken(grand.id, 'sess-grand', 'spawn', all);
    liveSessionIds.add(child.id);
    const { status } = await patch({ capabilityProfile: 'media' });
    expect(status).toBe(200);
    expect(getConversation(getDb(), child.id)?.capabilityProfile).toBe('media');
    expect(getConversation(getDb(), grand.id)?.capabilityProfile).toBe('media');
    expect(peekSpawnToken(childTok)).toBeUndefined();
    expect(peekSpawnToken(grandTok)).toBeUndefined();
    expect(mockReissue).toHaveBeenCalledWith(child.id);
    expect(mockReissue).not.toHaveBeenCalledWith(grand.id);
  });

  it('kills the old token on PATCH-narrow; the reissued token matches the new profile', async () => {
    liveSessionIds.add(convId);
    const all: ResolvedCapabilityProfile = { id: 'all', plugins: '*', usage: true };
    const oldTok = issueSpawnToken(convId, 'sess-old', 'spawn', all);
    const before = await fetch(`${base}/agent/plugins/zai-usage/capabilities/usage.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${oldTok}` },
      body: '{}',
    });
    expect(before.status).toBe(200);

    const { status } = await patch({ capabilityProfile: 'media' });
    expect(status).toBe(200);
    expect(peekSpawnToken(oldTok)).toBeUndefined();
    const dead = await fetch(`${base}/agent/plugins/zai-usage/capabilities/usage.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${oldTok}` },
      body: '{}',
    });
    expect(dead.status).toBe(401);

    const live = getLiveTokenForConversation(convId);
    expect(live).toBeDefined();
    expect(live!.capProfile).toEqual({ id: 'media', plugins: ['gemini-image'], usage: false });
    const denied = await fetch(`${base}/agent/plugins/zai-usage/capabilities/usage.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${live!.token}` },
      body: '{}',
    });
    expect(denied.status).toBe(403);
    const deniedBody = await denied.json() as { code: string };
    expect(deniedBody.code).toBe('not_in_profile');
    const allowed = await fetch(`${base}/agent/plugins/gemini-image/capabilities/image.generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${live!.token}` },
      body: '{}',
    });
    expect(allowed.status).toBe(200);
  });

  it('404 for unknown conversation', async () => {
    const { status } = await patch({ capabilityProfile: 'minimal' }, 'nonexistent-id');
    expect(status).toBe(404);
  });
});
