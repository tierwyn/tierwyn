import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { appendEvent } from '../repositories/events.js';
import { initVaultKey, vaultGet } from '../plugins/vault.js';
import { AGENT_VAULT_ID } from '../secrets/mcpRedact.js';
import { agentEnvVaultKey } from '../secrets/agentEnv.js';
import { refreshMcpRedactSet, redactMcpSecrets } from '../secrets/mcpRedact.js';
import { registerAgentEnvRoutes } from './agentEnv.js';

let server: Server;
let base: string;
const mockReapByAgent = vi.fn();
const mockSyncRemoteHosts = vi.fn();

beforeEach(async () => {
  mockReapByAgent.mockReset();
  mockReapByAgent.mockResolvedValue(undefined);
  mockSyncRemoteHosts.mockReset();
  mockSyncRemoteHosts.mockResolvedValue(undefined);
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  seedCatalogue(db);
  setDb(db);

  const app = express();
  app.use(express.json());
  registerAgentEnvRoutes(app, {
    getDb,
    sessionManager: {
      reapParkedSessionsByAgent: mockReapByAgent,
    },
    syncRemoteHosts: mockSyncRemoteHosts,
  });

  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('/settings/agent-env', () => {
  it('400s a bad name, a denied name, and a short value', async () => {
    initVaultKey({ sessionSecret: 'x'.repeat(48) });
    const put = (agentType: string, name: string, value: string) =>
      fetch(`${base}/settings/agent-env/${agentType}/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });

    expect((await put('codex', 'not-a-name', 'abcdefghij')).status).toBe(400);
    expect((await put('codex', 'PATH', 'abcdefghij')).status).toBe(400);
    expect((await put('codex', 'LD_PRELOAD', 'abcdefghij')).status).toBe(400);
    expect((await put('codex', 'OPENAI_API_KEY', 'short')).status).toBe(400);
    expect((await put('not-an-agent', 'OPENAI_API_KEY', 'abcdefghij')).status).toBe(400);
  });

  it('503s when the vault is unavailable', async () => {
    initVaultKey({ sessionSecret: '' });
    const res = await fetch(`${base}/settings/agent-env/codex/OPENAI_API_KEY`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'sk-codex-secret' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/derivation secret/i);
  });

  it('GET never returns values; PUT stores, redacts, reaps, and DELETE clears', async () => {
    initVaultKey({ sessionSecret: 'x'.repeat(48) });
    const secret = 'sk-codex-secret-value';
    const put = await fetch(`${base}/settings/agent-env/codex/OPENAI_API_KEY`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: ` ${secret} ` }),
    });
    const putBody = await put.text();
    expect(put.status).toBe(200);
    expect(putBody).not.toContain(secret);
    expect(mockReapByAgent).toHaveBeenCalledWith('codex');
    expect(vaultGet(getDb(), AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'))?.value).toBe(secret);

    const listed = await fetch(`${base}/settings/agent-env`);
    const listText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listText).not.toContain(secret);
    const listJson = JSON.parse(listText) as {
      vaultAvailable: boolean;
      vars: Array<{ agentType: string; name: string; updatedAt: number }>;
    };
    expect(listJson.vaultAvailable).toBe(true);
    expect(listJson.vars).toEqual([
      expect.objectContaining({ agentType: 'codex', name: 'OPENAI_API_KEY' }),
    ]);
    expect(listJson.vars[0]).not.toHaveProperty('value');

    const db = getDb();
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 't' });
    db.prepare(
      'INSERT INTO sessions (id, conversation_id, created_at, updated_at) VALUES (?, ?, 0, 0)',
    ).run('s', conv.id);
    refreshMcpRedactSet(db);
    const ev = appendEvent(db, {
      sessionId: 's',
      type: 'message',
      sender: 'agent',
      payload: { text: `leaked ${secret} here` },
    });
    expect(JSON.stringify(ev.payload)).not.toContain(secret);
    expect(redactMcpSecrets(`x ${secret} y`)).toBe('x [REDACTED] y');

    const del = await fetch(`${base}/settings/agent-env/codex/OPENAI_API_KEY`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(vaultGet(getDb(), AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'))).toBeUndefined();
    expect(mockReapByAgent).toHaveBeenCalledTimes(2);
  });

  it('stores COPILOT_GITHUB_TOKEN under the new vault key', async () => {
    initVaultKey({ sessionSecret: 'x'.repeat(48) });
    const url = `${base}/settings/agent-env/copilot/COPILOT_GITHUB_TOKEN`;
    const token = 'github_pat_abcdef123456';
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: ` ${token} ` }),
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain('github_pat_');
    expect(vaultGet(getDb(), AGENT_VAULT_ID, agentEnvVaultKey('copilot', 'COPILOT_GITHUB_TOKEN'))?.value).toBe(token);
    const listed = await (await fetch(`${base}/settings/agent-env`)).text();
    expect(listed).not.toContain(token);
    expect(await (await fetch(url, { method: 'DELETE' })).json()).toMatchObject({ ok: true });
    expect(vaultGet(getDb(), AGENT_VAULT_ID, agentEnvVaultKey('copilot', 'COPILOT_GITHUB_TOKEN'))).toBeUndefined();
  });

  it('PUT and DELETE fan out to remote hosts before reaping parked sessions', async () => {
    initVaultKey({ sessionSecret: 'x'.repeat(48) });
    const url = `${base}/settings/agent-env/codex/OPENAI_API_KEY`;
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'sk-codex-secret' }),
    });
    expect(put.status).toBe(200);
    expect(mockSyncRemoteHosts).toHaveBeenCalledTimes(1);
    expect(mockSyncRemoteHosts.mock.invocationCallOrder[0])
      .toBeLessThan(mockReapByAgent.mock.invocationCallOrder[0]);

    const del = await fetch(url, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(mockSyncRemoteHosts).toHaveBeenCalledTimes(2);
    expect(mockSyncRemoteHosts.mock.invocationCallOrder[1])
      .toBeLessThan(mockReapByAgent.mock.invocationCallOrder[1]);
  });

  it('a failed remote-host sync does not fail the request', async () => {
    initVaultKey({ sessionSecret: 'x'.repeat(48) });
    mockSyncRemoteHosts.mockRejectedValue(new Error('hub offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const put = await fetch(`${base}/settings/agent-env/codex/OPENAI_API_KEY`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'sk-codex-secret' }),
    });
    expect(put.status).toBe(200);
    // The reap still runs after the failed sync.
    await vi.waitFor(() => expect(mockReapByAgent).toHaveBeenCalledWith('codex'));
    warn.mockRestore();
  });
});
