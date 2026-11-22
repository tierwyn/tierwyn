import { describe, it, expect } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, getProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';
import { setDb } from '../db/index.js';
import { registerShellRoutes } from './shell.js';
import { SessionManager } from '../sessionManager.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  ensureRemoteAgentsProject(db);
  setDb(db);

  const app = express();
  app.use(express.json());

  const sessionManager = new SessionManager({ broadcast: () => {} });
  registerShellRoutes(app, { getDb: () => db, sessionManager });

  const ordinaryProject = createProject(db, { name: 'Ordinary', rootPath: '/tmp/ordinary' });
  const ordinaryConv = createConversation(db, { projectId: ordinaryProject.id, title: 'Chat' });

  const grokConv = createConversation(db, { projectId: REMOTE_AGENTS_PROJECT_ID, title: 'Grok Chat' });

  return { db, app, ordinaryProject, ordinaryConv, grokConv };
}

function req(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
        .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('shell routes grok-bot restrictions', () => {
  it('rejects GET /projects/:id/shell-allow for grok-bot folder', async () => {
    const { app } = boot();
    const res = await req(app, 'GET', `/projects/${REMOTE_AGENTS_PROJECT_ID}/shell-allow`);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/grok/i);
  });

  it('rejects POST /projects/:id/shell-allow for grok-bot folder', async () => {
    const { app } = boot();
    const res = await req(app, 'POST', `/projects/${REMOTE_AGENTS_PROJECT_ID}/shell-allow`, {
      rule: ['npm', 'test'],
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/grok/i);
  });

  it('rejects DELETE /projects/:id/shell-allow/:ruleId for grok-bot folder', async () => {
    const { app } = boot();
    const res = await req(app, 'DELETE', `/projects/${REMOTE_AGENTS_PROJECT_ID}/shell-allow/some-rule-id`);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/grok/i);
  });

  it('rejects POST /conversations/:id/shell for remote-host projects', async () => {
    const { db, app } = boot();
    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    const project = createProject(db, { name: 'remote', rootPath: '/tmp/r', remoteHostId: host.id });
    const conv = createConversation(db, { projectId: project.id, title: 'rc' });
    const res = await req(app, 'POST', `/conversations/${conv.id}/shell`, {
      command: 'git status',
    });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: 'not available for remote-host projects (P3)' });
  });

  it('rejects POST /conversations/:id/shell for grok-bot conversations', async () => {
    const { app, grokConv } = boot();
    const res = await req(app, 'POST', `/conversations/${grokConv.id}/shell`, {
      command: 'git status',
    });
    expect(res.status).toBe(400);
    expect(res.json.reason).toBe('grok_bot');
  });

  it('allows shell allow-list management for ordinary projects', async () => {
    const { app, ordinaryProject } = boot();
    const getRes = await req(app, 'GET', `/projects/${ordinaryProject.id}/shell-allow`);
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.json.base)).toBe(true);

    const postRes = await req(app, 'POST', `/projects/${ordinaryProject.id}/shell-allow`, {
      rule: ['git', 'status'],
    });
    expect(postRes.status).toBe(200);
    expect(postRes.json.rule.rule).toEqual(['git', 'status']);

    const ruleId = postRes.json.rule.id;
    const delRes = await req(app, 'DELETE', `/projects/${ordinaryProject.id}/shell-allow/${ruleId}`);
    expect(delRes.status).toBe(200);
    expect(delRes.json.ok).toBe(true);
  });
});
