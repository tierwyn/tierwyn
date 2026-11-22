import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, getProject } from '../repositories/projects.js';
import { createConversation, getConversation, setConversationRules } from '../repositories/conversations.js';
import { ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';
import { registerProjectMutationRoutes } from './projects.js';
import { registerConversationMutationRoutes } from './conversations.js';
import { registerRulePresetRoutes } from './rulePresets.js';
import { createRulePreset } from '../repositories/rulePresets.js';
import { requireAuth } from '../auth/middleware.js';
import { createSessionToken, SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { RULES_MAX_BYTES } from '../spawn/rules.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const app = express();
  app.use(express.json());
  registerProjectMutationRoutes(app, () => db);
  registerRulePresetRoutes(app, () => db);
  registerConversationMutationRoutes(app, () => db);
  const project = createProject(db, { name: 'Tierwyn', rootPath: '/tmp/k' });
  const conv = createConversation(db, { projectId: project.id, title: 'root' });
  return { db, app, project, conv };
}

function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      const init: RequestInit = { method, headers: { ...(headers ?? {}) } };
      if (body !== undefined) {
        (init.headers as Record<string, string>)['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('PATCH /projects/:id rules', () => {
  it('saves trimmed rules and returns them on the project', async () => {
    const { db, app, project } = boot();
    const res = await request(app, 'PATCH', `/projects/${project.id}`, { rules: '  always worktrees  ' });
    expect(res.status).toBe(200);
    expect(res.json.project.rules).toBe('always worktrees');
    expect(getProject(db, project.id)?.rules).toBe('always worktrees');
  });

  it('null or empty clears rules', async () => {
    const { db, app, project } = boot();
    await request(app, 'PATCH', `/projects/${project.id}`, { rules: 'keep' });
    const cleared = await request(app, 'PATCH', `/projects/${project.id}`, { rules: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.project.rules).toBeUndefined();
    expect(getProject(db, project.id)?.rules).toBeUndefined();

    await request(app, 'PATCH', `/projects/${project.id}`, { rules: 'again' });
    const empty = await request(app, 'PATCH', `/projects/${project.id}`, { rules: '   ' });
    expect(empty.status).toBe(200);
    expect(getProject(db, project.id)?.rules).toBeUndefined();
  });

  it('400s more than 4 KiB', async () => {
    const { app, project } = boot();
    const res = await request(app, 'PATCH', `/projects/${project.id}`, { rules: 'x'.repeat(RULES_MAX_BYTES + 1) });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/4096/);
  });

  it('409s a system project', async () => {
    const { db, app } = boot();
    ensureRemoteAgentsProject(db);
    const res = await request(app, 'PATCH', `/projects/${REMOTE_AGENTS_PROJECT_ID}`, { rules: 'nope' });
    expect(res.status).toBe(409);
    expect(getProject(db, REMOTE_AGENTS_PROJECT_ID)?.rules).toBeUndefined();
  });
});

describe('PATCH /conversations/:id rules', () => {
  it('saves, clears with null, and 400s oversize', async () => {
    const { db, app, conv } = boot();
    const saved = await request(app, 'PATCH', `/conversations/${conv.id}`, { rules: 'plan first' });
    expect(saved.status).toBe(200);
    expect(saved.json.conversation.rules).toBe('plan first');
    expect(getConversation(db, conv.id)?.rules).toBe('plan first');

    const cleared = await request(app, 'PATCH', `/conversations/${conv.id}`, { rules: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.conversation.rules).toBeUndefined();

    const over = await request(app, 'PATCH', `/conversations/${conv.id}`, { rules: 'y'.repeat(RULES_MAX_BYTES + 1) });
    expect(over.status).toBe(400);
  });
});

describe('GET /conversations/:id/rules', () => {
  it('returns project rules and ancestor chain root-first', async () => {
    const { db, app, project } = boot();
    await request(app, 'PATCH', `/projects/${project.id}`, { rules: 'project rule' });
    const root = createConversation(db, { projectId: project.id, title: 'Orchestrator' });
    setConversationRules(db, root.id, 'root rule');
    const child = createConversation(db, {
      projectId: project.id, title: 'Child', parentConversationId: root.id,
    });
    setConversationRules(db, child.id, 'child rule');

    const res = await request(app, 'GET', `/conversations/${child.id}/rules`);
    expect(res.status).toBe(200);
    expect(res.json.project.rules).toBe('project rule');
    expect(res.json.chain.map((c: { title: string; rules: string }) => [c.title, c.rules])).toEqual([
      ['Orchestrator', 'root rule'],
      ['Child', 'child rule'],
    ]);
    expect(res.json.rendered).toContain('### Project');
    expect(res.json.omitted).toBe(0);
  });
});

describe('rulePresetIds PATCH', () => {
  it('saves rules and rulePresetIds in one request', async () => {
    const { db, app, project, conv } = boot();
    const preset = createRulePreset(db, { name: 'Tone', content: 'terse' });
    const res = await request(app, 'PATCH', `/conversations/${conv.id}`, {
      rules: 'child custom',
      rulePresetIds: [preset.id],
    });
    expect(res.status).toBe(200);
    expect(res.json.conversation.rules).toBe('child custom');
    expect(res.json.conversation.rulePresetIds).toEqual([preset.id]);
  });

  it('400s nine ids, duplicate ids, and another project\'s preset', async () => {
    const { db, app, project, conv } = boot();
    const ids = Array.from({ length: 9 }, (_, i) => createRulePreset(db, { name: `N${i}`, content: 'x' }).id);
    const nine = await request(app, 'PATCH', `/conversations/${conv.id}`, { rulePresetIds: ids });
    expect(nine.status).toBe(400);
    const dup = await request(app, 'PATCH', `/conversations/${conv.id}`, { rulePresetIds: [ids[0], ids[0]] });
    expect(dup.status).toBe(400);
    const other = createProject(db, { name: 'O', rootPath: '/tmp/o' });
    const foreign = createRulePreset(db, { name: 'F', content: 'f', projectId: other.id });
    const bad = await request(app, 'PATCH', `/conversations/${conv.id}`, { rulePresetIds: [foreign.id] });
    expect(bad.status).toBe(400);
  });

  it('409s Remote Agents conversation rules', async () => {
    const { db, app } = boot();
    ensureRemoteAgentsProject(db);
    const conv = createConversation(db, { projectId: REMOTE_AGENTS_PROJECT_ID, title: 'bot' });
    const res = await request(app, 'PATCH', `/conversations/${conv.id}`, { rules: 'nope' });
    expect(res.status).toBe(409);
  });
});

describe('rule-presets CRUD', () => {
  it('creates, lists, rejects empty content, and scrubs on delete', async () => {
    const { db, app, project } = boot();
    const created = await request(app, 'POST', '/rule-presets', { name: 'Tone', content: 'be terse' });
    expect(created.status).toBe(201);
    const listed = await request(app, 'GET', `/rule-presets?projectId=${project.id}`);
    expect(listed.json.presets.some((p: { name: string }) => p.name === 'Tone')).toBe(true);
    const empty = await request(app, 'POST', '/rule-presets', { name: 'Empty', content: '  ' });
    expect(empty.status).toBe(400);
    const over = await request(app, 'POST', '/rule-presets', { name: 'Big', content: 'x'.repeat(RULES_MAX_BYTES + 1) });
    expect(over.status).toBe(400);
    await request(app, 'PATCH', `/projects/${project.id}`, { rulePresetIds: [created.json.preset.id] });
    const del = await request(app, 'DELETE', `/rule-presets/${created.json.preset.id}`);
    expect(del.status).toBe(200);
    expect(del.json.scrubbed.projects).toBe(1);
  });
});

describe('operator rules are cookie-only', () => {
  it('index.ts mounts project and conversation mutation routes after requireAuth', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../index.ts'), 'utf8');
    const authAt = src.indexOf('app.use(requireAuth(authConfig))');
    const projAt = src.indexOf('registerProjectMutationRoutes(app');
    const presetsAt = src.indexOf('registerRulePresetRoutes(app');
    const convAt = src.indexOf('registerConversationMutationRoutes(app');
    expect(authAt).toBeGreaterThan(0);
    expect(projAt).toBeGreaterThan(authAt);
    expect(presetsAt).toBeGreaterThan(authAt);
    expect(convAt).toBeGreaterThan(authAt);
  });

  it('Bearer spawn token cannot PATCH or GET rules', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const secret = 's'.repeat(32);
    const app = express();
    app.use(express.json());
    app.use(requireAuth({
      disabled: false,
      configured: true,
      sessionSecret: secret,
      passwordHash: 'x',
      cookieSecure: false,
    }));
    registerProjectMutationRoutes(app, () => db);
    registerRulePresetRoutes(app, () => db);
    registerConversationMutationRoutes(app, () => db);
    const project = createProject(db, { name: 'Tierwyn', rootPath: '/tmp/k' });
    const conv = createConversation(db, { projectId: project.id, title: 'root' });

    const bearer = { Authorization: 'Bearer 00000000-0000-4000-8000-000000000001' };
    const patchProj = await request(app, 'PATCH', `/projects/${project.id}`, { rules: 'injected' }, bearer);
    const patchConv = await request(app, 'PATCH', `/conversations/${conv.id}`, { rules: 'injected' }, bearer);
    const getRules = await request(app, 'GET', `/conversations/${conv.id}/rules`, undefined, bearer);
    const postPreset = await request(app, 'POST', '/rule-presets', { name: 'X', content: 'y' }, bearer);
    expect(patchProj.status).toBe(401);
    expect(patchConv.status).toBe(401);
    expect(getRules.status).toBe(401);
    expect(postPreset.status).toBe(401);

    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(secret, Date.now())}`;
    const ok = await request(app, 'PATCH', `/projects/${project.id}`, { rules: 'ok' }, { Cookie: cookie });
    expect(ok.status).toBe(200);
    expect(ok.json.project.rules).toBe('ok');
  });
});
