import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { registry } from '../registry.js';
import { registerCatalogueRoutes } from './catalogue.js';
import { AGENT_BINARIES } from '../discovery.js';
import { buildPrereqPrefix } from '../node/install.js';
import { ensureAgent } from '../repositories/models.js';
import { seedCommands } from '../db/seed.js';
import * as versions from '../versions.js';
import type { AgentAdapter, ModelDescriptor } from '@tierwyn/shared';

// A stub adapter whose listModels returns a fixed descriptor set (no real binary).
class StubAdapter implements AgentAdapter {
  async start() {}
  async sendPrompt() {}
  streamEvents() { return { on() {}, emit() {} } as never; }
  async stop() {}
  async listSessions() { return []; }
  async loadSession() {}
  async listModels(): Promise<ModelDescriptor[]> {
    return [{ name: 'm1', label: 'Stub · M1', provider: 'stub', vision: true, steer: false }];
  }
  async listCommands() {
    return [{ name: 'find-skills', label: 'find-skills', sourceDetail: 'skill' as const }];
  }
}

function setup(opts?: Parameters<typeof registerCatalogueRoutes>[3]) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  let reloads = 0;
  const app = express();
  app.use(express.json());
  registerCatalogueRoutes(app, () => db, () => { reloads++; }, opts);
  return { app, db, reloads: () => reloads };
}

async function call(app: express.Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  } finally { server.close(); }
}

beforeEach(() => {
  // Register a stub for the 'stub' type used by create/pull tests.
  registry.register('stub', () => new StubAdapter());
});

describe('catalogue routes', () => {
  it('GET /agents lists known agents with install state', async () => {
    const { app } = setup();
    const res = await call(app, 'GET', '/agents');
    expect(res.status).toBe(200);
    const types = res.json.agents.map((a: { type: string }) => a.type);
    expect(types).toContain('antigravity');
    expect(types).toContain('opencode');
    // Each carries an `installed` boolean.
    expect(typeof res.json.agents[0].installed).toBe('boolean');
    expect(res.json.supportedSandboxAgents).toContain('claude-code');
    expect(res.json.supportedSandboxAgents).not.toContain('grok-bot');
    expect(typeof res.json.sandboxAvailable).toBe('boolean');
  });

  it('POST /agents rejects an unregistered type', async () => {
    const { app, reloads } = setup();
    const res = await call(app, 'POST', '/agents', { type: 'nope', label: 'Nope' });
    expect(res.status).toBe(400);
    expect(reloads()).toBe(0);
  });

  it('POST /agents creates an agent for a registered type and reloads', async () => {
    const { app, reloads } = setup();
    const res = await call(app, 'POST', '/agents', { type: 'stub', label: 'Stub', description: 'd' });
    expect(res.status).toBe(200);
    expect(res.json.agent.id).toBe('stub');
    expect(reloads()).toBe(1);
  });

  it('PATCH /agents/:id updates editable fields', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const res = await call(app, 'PATCH', '/agents/stub', { label: 'Renamed', executablePath: '/x/stub' });
    expect(res.status).toBe(200);
    expect(res.json.agent.label).toBe('Renamed');
    expect(res.json.agent.executablePath).toBe('/x/stub');
  });

  it('model CRUD: create, patch enabled, delete', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const created = await call(app, 'POST', '/agents/stub/models', { modelName: 'm1', label: 'M1' });
    expect(created.status).toBe(200);
    expect(created.json.model.enabled).toBe(true);
    expect(created.json.model.label).toBe('Stub · M1');

    const patched = await call(app, 'PATCH', `/models/${created.json.model.id}`, { enabled: false, vision: true });
    expect(patched.status).toBe(200);
    expect(patched.json.model.enabled).toBe(false);
    expect(patched.json.model.vision).toBe(true);

    const del = await call(app, 'DELETE', `/models/${created.json.model.id}`);
    expect(del.status).toBe(200);
    const after = await call(app, 'GET', '/catalogue');
    expect(after.json.models.find((m: { id: string }) => m.id === created.json.model.id)).toBeUndefined();
  });

  it('PATCH/DELETE /models/:id accepts encodeURIComponent for slash and tab ids', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const slash = await call(app, 'POST', '/agents/stub/models', {
      modelName: 'kilo/anthropic/claude',
      label: 'Claude',
    });
    expect(slash.status).toBe(200);
    const slashId = slash.json.model.id as string;
    expect(slashId).toContain('/');

    const slashPatched = await call(
      app,
      'PATCH',
      `/models/${encodeURIComponent(slashId)}`,
      { maxConcurrentSpawns: 3 },
    );
    expect(slashPatched.status).toBe(200);
    expect(slashPatched.json.model.maxConcurrentSpawns).toBe(3);

    // Legacy agy line before slug\\tlabel split — tab must survive encoding.
    const tabName = 'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)';
    db.prepare(
      `INSERT INTO agent_models
         (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, source, created_at)
       VALUES (?, 'stub', ?, 'Legacy', NULL, 0, 0, 0, '', 'discovered', ?)`,
    ).run(`stub:${tabName}`, tabName, Date.now());

    const tabPatched = await call(
      app,
      'PATCH',
      `/models/${encodeURIComponent(`stub:${tabName}`)}`,
      { maxConcurrentSpawns: 2 },
    );
    expect(tabPatched.status).toBe(200);
    expect(tabPatched.json.model.maxConcurrentSpawns).toBe(2);

    const tabDel = await call(app, 'DELETE', `/models/${encodeURIComponent(`stub:${tabName}`)}`);
    expect(tabDel.status).toBe(200);
  });

  it('POST /agents/:id/pull-models persists discovered models and reloads', async () => {
    const { app, db, reloads } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const before = reloads();
    const res = await call(app, 'POST', '/agents/stub/pull-models');
    expect(res.status).toBe(200);
    expect(res.json.models).toHaveLength(1);
    expect(reloads()).toBe(before + 1);
    const cat = await call(app, 'GET', '/catalogue');
    expect(cat.json.models.find((m: { modelName: string }) => m.modelName === 'm1')).toBeTruthy();
  });

  it('pull-models 404s for a missing agent', async () => {
    const { app } = setup();
    const res = await call(app, 'POST', '/agents/ghost/pull-models');
    expect(res.status).toBe(404);
  });

  it('GET /agents/:id/commands returns seeded commands', async () => {
    const { app, db } = setup();
    seedCommands(db);
    const res = await call(app, 'GET', '/agents/claude-code/commands');
    expect(res.status).toBe(200);
    expect(res.json.commands.some((c: { name: string }) => c.name === 'clear')).toBe(true);
  });

  it('POST /agents/:id/pull-commands persists discovered commands', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const res = await call(app, 'POST', '/agents/stub/pull-commands');
    expect(res.status).toBe(200);
    expect(res.json.commands).toHaveLength(1);
    const list = await call(app, 'GET', '/agents/stub/commands');
    expect(list.json.commands.find((c: { name: string }) => c.name === 'find-skills')).toBeTruthy();
  });
});

describe('command CRUD', () => {
  it('T1 POST creates a user command with opaque id', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const res = await call(app, 'POST', '/agents/stub/commands', { name: 'deploy', description: 'ship it' });
    expect(res.status).toBe(200);
    expect(res.json.command.source).toBe('user');
    expect(res.json.command.enabled).toBe(true);
    expect(res.json.command.label).toBe('deploy');
    expect(res.json.command.sourceDetail).toBeNull();
    expect(res.json.command.id.startsWith('user:')).toBe(true);
  });

  it('T2 GET lists the created user command', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    await call(app, 'POST', '/agents/stub/commands', { name: 'deploy', description: 'ship it' });
    const list = await call(app, 'GET', '/agents/stub/commands');
    expect(list.status).toBe(200);
    expect(list.json.commands.some((c: { name: string }) => c.name === 'deploy')).toBe(true);
  });

  it('T3 duplicate POST returns 409', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const first = await call(app, 'POST', '/agents/stub/commands', { name: 'deploy' });
    expect(first.status).toBe(200);
    const second = await call(app, 'POST', '/agents/stub/commands', { name: 'deploy' });
    expect(second.status).toBe(409);
    expect(second.json.error).toContain('already exists');
  });

  it('T4 invalid name with whitespace returns 400', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const res = await call(app, 'POST', '/agents/stub/commands', { name: 'two words' });
    expect(res.status).toBe(400);
  });

  it('T5 leading slash is stripped', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const res = await call(app, 'POST', '/agents/stub/commands', { name: '/deploy' });
    expect(res.status).toBe(200);
    expect(res.json.command.name).toBe('deploy');
  });

  it('T6 PATCH label+description on a user row', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const created = await call(app, 'POST', '/agents/stub/commands', { name: 'deploy' });
    const res = await call(app, 'PATCH', `/agents/stub/commands/${created.json.command.id}`, {
      label: 'Ship',
      description: 'ship the thing',
    });
    expect(res.status).toBe(200);
    expect(res.json.command.label).toBe('Ship');
    expect(res.json.command.description).toBe('ship the thing');
  });

  it('T7 rename collision returns 409', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    await call(app, 'POST', '/agents/stub/commands', { name: 'a' });
    const b = await call(app, 'POST', '/agents/stub/commands', { name: 'b' });
    const res = await call(app, 'PATCH', `/agents/stub/commands/${b.json.command.id}`, { name: 'a' });
    expect(res.status).toBe(409);
  });

  it('T8 disabling hides from default GET but not includeDisabled', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const created = await call(app, 'POST', '/agents/stub/commands', { name: 'deploy' });
    const patched = await call(app, 'PATCH', `/agents/stub/commands/${created.json.command.id}`, { enabled: false });
    expect(patched.status).toBe(200);
    const enabledOnly = await call(app, 'GET', '/agents/stub/commands');
    expect(enabledOnly.json.commands.find((c: { name: string }) => c.name === 'deploy')).toBeUndefined();
    const all = await call(app, 'GET', '/agents/stub/commands?includeDisabled=1');
    expect(all.json.commands.find((c: { name: string }) => c.name === 'deploy')).toBeTruthy();
  });

  it('T9 PATCH enabled on a discovered row', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    await call(app, 'POST', '/agents/stub/pull-commands');
    const list = await call(app, 'GET', '/agents/stub/commands');
    const discovered = list.json.commands.find((c: { name: string }) => c.name === 'find-skills');
    expect(discovered).toBeTruthy();
    const res = await call(app, 'PATCH', `/agents/stub/commands/${discovered.id}`, { enabled: false });
    expect(res.status).toBe(200);
    expect(res.json.command.enabled).toBe(false);
  });

  it('T10 PATCH label on a discovered row returns 400', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    await call(app, 'POST', '/agents/stub/pull-commands');
    const list = await call(app, 'GET', '/agents/stub/commands');
    const discovered = list.json.commands.find((c: { name: string }) => c.name === 'find-skills');
    const res = await call(app, 'PATCH', `/agents/stub/commands/${discovered.id}`, { label: 'x' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('only user commands');
  });

  it('T11 DELETE a user row', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const created = await call(app, 'POST', '/agents/stub/commands', { name: 'deploy' });
    const del = await call(app, 'DELETE', `/agents/stub/commands/${created.json.command.id}`);
    expect(del.status).toBe(200);
    const all = await call(app, 'GET', '/agents/stub/commands?includeDisabled=1');
    expect(all.json.commands.find((c: { name: string }) => c.name === 'deploy')).toBeUndefined();
  });

  it('T12 DELETE a discovered row returns 400 and the row remains', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    await call(app, 'POST', '/agents/stub/pull-commands');
    const list = await call(app, 'GET', '/agents/stub/commands');
    const discovered = list.json.commands.find((c: { name: string }) => c.name === 'find-skills');
    const del = await call(app, 'DELETE', `/agents/stub/commands/${discovered.id}`);
    expect(del.status).toBe(400);
    expect(del.json.error).toContain('disable it instead');
    const after = await call(app, 'GET', '/agents/stub/commands?includeDisabled=1');
    expect(after.json.commands.find((c: { name: string }) => c.name === 'find-skills')).toBeTruthy();
  });

  it('T13 404s for unknown agent and unknown command', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const postNope = await call(app, 'POST', '/agents/nope/commands', { name: 'deploy' });
    expect(postNope.status).toBe(404);
    const patchNope = await call(app, 'PATCH', '/agents/nope/commands/user:x', { enabled: false });
    expect(patchNope.status).toBe(404);
    const delNope = await call(app, 'DELETE', '/agents/nope/commands/user:x');
    expect(delNope.status).toBe(404);
    const patchMissing = await call(app, 'PATCH', '/agents/stub/commands/user:missing', { enabled: false });
    expect(patchMissing.status).toBe(404);
    const delMissing = await call(app, 'DELETE', '/agents/stub/commands/user:missing');
    expect(delMissing.status).toBe(404);
  });

  it('T14 cross-agent PATCH returns 404', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    ensureAgent(db, { id: 'claude-code', label: 'Claude Code' });
    const created = await call(app, 'POST', '/agents/stub/commands', { name: 'deploy' });
    const res = await call(app, 'PATCH', `/agents/claude-code/commands/${created.json.command.id}`, { enabled: false });
    expect(res.status).toBe(404);
  });

  // ── WP-2.3 tests ──────────────────────────────────────────────────────────
  it('GET /agents rows carry installedVersion, latestVersion, behind, upgradeable from pre-seeded agent_versions', async () => {
    const { app, db } = setup();
    const cache = {
      'claude-code': { installed: '2.1.286', latest: '2.1.300', checkedAt: Date.now() },
      codex: { installed: '0.150.0', latest: '0.150.0', checkedAt: Date.now() },
    };
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_versions', ?)").run(JSON.stringify(cache));

    const res = await call(app, 'GET', '/agents');
    expect(res.status).toBe(200);

    const cc = res.json.agents.find((a: any) => a.type === 'claude-code');
    expect(cc).toBeDefined();
    expect(cc.installedVersion).toBe('2.1.286');
    expect(cc.latestVersion).toBe('2.1.300');
    expect(cc.behind).toBe(true);
    expect(cc.upgradeable).toBe(true);

    const codex = res.json.agents.find((a: any) => a.type === 'codex');
    expect(codex).toBeDefined();
    expect(codex.installedVersion).toBe('0.150.0');
    expect(codex.latestVersion).toBe('0.150.0');
    expect(codex.behind).toBe(false);
    expect(codex.upgradeable).toBe(true);
  });

  describe('POST /agents/:id/upgrade', () => {
    it('returns 404 for unknown agent id', async () => {
      const { app } = setup();
      const res = await call(app, 'POST', '/agents/unknown-agent-id/upgrade');
      expect(res.status).toBe(404);
      expect(res.json.error).toBe('no such agent');
    });

    it('returns 400 for agent with no scripted install (grok-bot)', async () => {
      const { app } = setup();
      const res = await call(app, 'POST', '/agents/grok-bot/upgrade');
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/no scripted install/);
    });

    it('returns 409 when agent has live sessions', async () => {
      const { app } = setup({
        getActiveSessions: () => [{ agentType: 'codex' }],
      });
      const res = await call(app, 'POST', '/agents/codex/upgrade');
      expect(res.status).toBe(409);
      expect(res.json.error).toMatch(/live sessions/);
    });

    it('happy path: responds 200 immediately, shows upgrading in GET /agents, rejects concurrent with 409, and clears when done', async () => {
      const refreshSpy = vi.spyOn(versions, 'refreshAgentVersions').mockResolvedValue({});
      try {
        let resolveRunner!: (val: { code: number | null; stdout: string; stderr: string }) => void;
        const runnerPromise = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          resolveRunner = resolve;
        });

        const { app, reloads } = setup({
          runUpgrade: async () => runnerPromise,
        });

        const initialReloads = reloads();
        const res = await call(app, 'POST', '/agents/claude-code/upgrade');
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true, started: true });
        expect(reloads()).toBe(initialReloads + 1);

        // GET /agents shows upgrading: true
        const agentsRes = await call(app, 'GET', '/agents');
        const cc = agentsRes.json.agents.find((a: any) => a.type === 'claude-code');
        expect(cc.upgrading).toBe(true);

        // Concurrent upgrade yields 409
        const secondPost = await call(app, 'POST', '/agents/claude-code/upgrade');
        expect(secondPost.status).toBe(409);
        expect(secondPost.json.error).toMatch(/upgrade already running/);

        // Resolve the background runner
        resolveRunner({ code: 0, stdout: 'ok', stderr: '' });

        // Poll briefly with vi.waitFor until upgrading clears and reload runs
        await vi.waitFor(async () => {
          const check = await call(app, 'GET', '/agents');
          const item = check.json.agents.find((a: any) => a.type === 'claude-code');
          expect(item.upgrading).toBe(false);
        });

        await vi.waitFor(() => {
          expect(reloads()).toBeGreaterThanOrEqual(initialReloads + 2);
        });

        expect(refreshSpy).toHaveBeenCalled();
      } finally {
        refreshSpy.mockRestore();
      }
    });

    it('clears upgrading flag when runner returns non-zero code without throwing', async () => {
      const { app } = setup({
        runUpgrade: async () => ({ code: 1, stdout: '', stderr: 'mocked failure' }),
      });

      const res = await call(app, 'POST', '/agents/claude-code/upgrade');
      expect(res.status).toBe(200);

      await vi.waitFor(async () => {
        const check = await call(app, 'GET', '/agents');
        const item = check.json.agents.find((a: any) => a.type === 'claude-code');
        expect(item.upgrading).toBe(false);
      });
    });
  });

  describe('POST /agents/install-all', () => {
    type RunnerVal = { code: number | null; stdout: string; stderr: string };

    /** Deterministic install state: every known agent installed
     *  (executable_path → /bin/sh) except the listed missing types. */
    function forceInstallState(db: Database, missing: string[]) {
      for (const type of Object.keys(AGENT_BINARIES)) {
        ensureAgent(db, { id: type, label: type });
        db.prepare('UPDATE agents SET executable_path = ? WHERE type = ?')
          .run(missing.includes(type) ? `/nonexistent-tierwyn-test/${type}` : '/bin/sh', type);
      }
    }

    /** Runner whose installs never settle until the test says so. */
    function deferredRunner() {
      const pending: Array<(v: RunnerVal) => void> = [];
      return {
        runner: vi.fn(() => new Promise<RunnerVal>((resolve) => { pending.push(resolve); })),
        settleNext(v: RunnerVal) { pending.shift()?.(v); },
        settleAll(v: RunnerVal = { code: 0, stdout: 'ok', stderr: '' }) {
          while (pending.length) pending.shift()?.(v);
        },
      };
    }

    const seedBehind = (db: Database, type: string) => {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_versions', ?)").run(
        JSON.stringify({ [type]: { installed: '1.0.0', latest: '2.0.0', checkedAt: Date.now() } }),
      );
    };

    it('missing+behind batches sequentially: skips live-session types, 409s queued/in-flight singles and a second batch (incl. the final-item window), isolates failures', async () => {
      const refreshSpy = vi.spyOn(versions, 'refreshAgentVersions').mockResolvedValue({});
      try {
        const d = deferredRunner();
        const { app, db } = setup({
          runUpgrade: d.runner,
          getActiveSessions: () => [{ agentType: 'cursor' }],
        });
        forceInstallState(db, ['pi', 'cursor']);
        seedBehind(db, 'opencode');

        const res = await call(app, 'POST', '/agents/install-all', { mode: 'missing+behind' });
        expect(res.status).toBe(200);
        expect(res.json.started).toBe(true);
        expect(res.json.targets).toEqual(['opencode', 'pi']);
        expect(res.json.skipped).toEqual([{ type: 'cursor', reason: 'agent has live sessions' }]);

        // First target is in flight and has already left the queue.
        let agents = (await call(app, 'GET', '/agents')).json;
        expect(agents.batch).toEqual({ running: true, remaining: ['pi'] });
        expect(agents.agents.find((a: any) => a.type === 'opencode').upgrading).toBe(true);

        // Any single upgrade 409s while the batch runs — queued or in-flight type.
        const queued = await call(app, 'POST', '/agents/pi/upgrade');
        expect(queued.status).toBe(409);
        expect(queued.json.error).toMatch(/batch running/);
        const inflight = await call(app, 'POST', '/agents/opencode/upgrade');
        expect(inflight.status).toBe(409);
        expect(inflight.json.error).toMatch(/batch running/);

        // Second install-all while the batch runs → 409.
        const second = await call(app, 'POST', '/agents/install-all', { mode: 'missing' });
        expect(second.status).toBe(409);
        expect(second.json.error).toMatch(/install-all already running/);

        // Final-item window: last target in flight, queue empty, batch still on.
        d.settleNext({ code: 0, stdout: 'added 1 package', stderr: '' });
        await vi.waitFor(async () => {
          agents = (await call(app, 'GET', '/agents')).json;
          expect(agents.agents.find((a: any) => a.type === 'pi').upgrading).toBe(true);
        });
        expect(agents.batch).toEqual({ running: true, remaining: [] });
        const windowBatch = await call(app, 'POST', '/agents/install-all', { mode: 'missing' });
        expect(windowBatch.status).toBe(409);
        const windowSingle = await call(app, 'POST', '/agents/pi/upgrade');
        expect(windowSingle.status).toBe(409);
        expect(windowSingle.json.error).toMatch(/batch running/);

        // Second install fails → failure isolated, batch still completes.
        d.settleNext({ code: 1, stdout: 'npm warn deprecated', stderr: 'fatal: boom' });
        await vi.waitFor(async () => {
          agents = (await call(app, 'GET', '/agents')).json;
          expect(agents.batch).toBeUndefined();
        });
        expect(d.runner).toHaveBeenCalledTimes(2);
        expect(agents.agents.find((a: any) => a.type === 'opencode').upgradeResult.ok).toBe(true);
        expect(agents.agents.find((a: any) => a.type === 'pi').upgradeResult.ok).toBe(false);
        expect(refreshSpy).toHaveBeenCalled();
      } finally {
        refreshSpy.mockRestore();
      }
    });

    it("mode 'missing' does not touch installed-but-behind agents", async () => {
      const refreshSpy = vi.spyOn(versions, 'refreshAgentVersions').mockResolvedValue({});
      try {
        const d = deferredRunner();
        const { app, db } = setup({ runUpgrade: d.runner });
        forceInstallState(db, ['pi']);
        seedBehind(db, 'opencode');

        const res = await call(app, 'POST', '/agents/install-all', { mode: 'missing' });
        expect(res.status).toBe(200);
        expect(res.json.started).toBe(true);
        expect(res.json.targets).toEqual(['pi']);
        expect(res.json.skipped).toEqual([]);

        d.settleAll();
        await vi.waitFor(async () => {
          const agents = (await call(app, 'GET', '/agents')).json;
          expect(agents.batch).toBeUndefined();
        });
        expect(d.runner).toHaveBeenCalledTimes(1);
      } finally {
        refreshSpy.mockRestore();
      }
    });

    it('everything installed and current → started: false with no batch', async () => {
      const { app, db } = setup();
      forceInstallState(db, []);

      const res = await call(app, 'POST', '/agents/install-all', { mode: 'missing+behind' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, started: false, targets: [], skipped: [] });

      const agents = (await call(app, 'GET', '/agents')).json;
      expect(agents.batch).toBeUndefined();
    });

    it('prefixes each batch item with its prereq check (kiro gets the unzip guard)', async () => {
      const refreshSpy = vi.spyOn(versions, 'refreshAgentVersions').mockResolvedValue({});
      try {
        const d = deferredRunner();
        const { app, db } = setup({ runUpgrade: d.runner });
        forceInstallState(db, ['kiro', 'pi']);

        const res = await call(app, 'POST', '/agents/install-all', { mode: 'missing' });
        expect(res.json.targets).toEqual(['kiro', 'pi']);

        // Settle items one at a time — item 2's runner call only exists after
        // item 1's promise resolves.
        await vi.waitFor(() => expect(d.runner).toHaveBeenCalledTimes(1));
        d.settleNext({ code: 0, stdout: 'ok', stderr: '' });
        await vi.waitFor(() => expect(d.runner).toHaveBeenCalledTimes(2));
        d.settleNext({ code: 0, stdout: 'ok', stderr: '' });
        await vi.waitFor(async () => {
          const agents = (await call(app, 'GET', '/agents')).json;
          expect(agents.batch).toBeUndefined();
        });
        expect(d.runner).toHaveBeenCalledTimes(2);
        // The runner observes the exact command: prereq prefix + vendor install.
        expect(d.runner.mock.calls[0][0]).toBe(
          buildPrereqPrefix(AGENT_BINARIES['kiro']!.prereqs) + AGENT_BINARIES['kiro']!.install,
        );
        // No prereqs → the plain install command.
        expect(d.runner.mock.calls[1][0]).toBe(AGENT_BINARIES['pi']!.install);
      } finally {
        refreshSpy.mockRestore();
      }
    });

    it('re-checks live sessions per item: a session started mid-batch skips that type', async () => {
      const refreshSpy = vi.spyOn(versions, 'refreshAgentVersions').mockResolvedValue({});
      try {
        const sessions: Array<{ agentType: string }> = [];
        const d = deferredRunner();
        const { app, db } = setup({
          runUpgrade: (cmd) => {
            // A chat starts on pi while the first install is in flight.
            sessions.push({ agentType: 'pi' });
            return d.runner(cmd);
          },
          getActiveSessions: () => sessions,
        });
        forceInstallState(db, ['opencode', 'pi']);

        const res = await call(app, 'POST', '/agents/install-all', { mode: 'missing' });
        expect(res.json.targets).toEqual(['opencode', 'pi']);

        await vi.waitFor(() => expect(d.runner).toHaveBeenCalledTimes(1));
        d.settleNext({ code: 0, stdout: 'ok', stderr: '' });
        await vi.waitFor(async () => {
          const agents = (await call(app, 'GET', '/agents')).json;
          expect(agents.batch).toBeUndefined();
        });
        // opencode ran; pi was never handed to the runner and is recorded as skipped.
        expect(d.runner).toHaveBeenCalledTimes(1);
        const agents = (await call(app, 'GET', '/agents')).json;
        expect(agents.agents.find((a: any) => a.type === 'opencode').upgradeResult.ok).toBe(true);
        expect(agents.agents.find((a: any) => a.type === 'pi').upgradeResult).toMatchObject({
          ok: false,
          tail: 'skipped — agent has live sessions',
        });
      } finally {
        refreshSpy.mockRestore();
      }
    });
  });

  describe('POST /agents/versions/refresh', () => {
    it('200 started, 409 while running, flag resets on completion, works again', async () => {
      let release!: () => void;
      const refreshSpy = vi.spyOn(versions, 'refreshAgentVersions').mockImplementation(
        () => new Promise<void>((res) => { release = () => res(); }),
      );
      try {
        const { app } = setup();

        const first = await call(app, 'POST', '/agents/versions/refresh');
        expect(first.status).toBe(200);
        expect(first.json).toEqual({ ok: true, started: true });

        // Flag visible while the refresh is in flight; a second POST 409s.
        let agents = (await call(app, 'GET', '/agents')).json;
        expect(agents.versionsRefreshing).toBe(true);
        const dup = await call(app, 'POST', '/agents/versions/refresh');
        expect(dup.status).toBe(409);
        expect(dup.json.error).toMatch(/already running/);

        release();
        await vi.waitFor(async () => {
          agents = (await call(app, 'GET', '/agents')).json;
          expect(agents.versionsRefreshing).toBeUndefined();
        });
        expect(refreshSpy).toHaveBeenCalledWith(expect.anything(), { force: true });

        const again = await call(app, 'POST', '/agents/versions/refresh');
        expect(again.status).toBe(200);
        release();
        await vi.waitFor(async () => {
          agents = (await call(app, 'GET', '/agents')).json;
          expect(agents.versionsRefreshing).toBeUndefined();
        });
      } finally {
        refreshSpy.mockRestore();
      }
    });
  });
});

describe('GET /agents/:id/commands for remote-host projects', () => {
  function remoteSetup() {
    const s = setup();
    const { db } = s;
    ensureAgent(db, { id: 'stub', label: 'Stub' });
    const ins = db.prepare(
      "INSERT INTO agent_commands (id, agent_id, name, label, description, source, source_detail, enabled_flag, created_at) VALUES (?, 'stub', ?, ?, '', ?, ?, 1, 1)");
    ins.run('c1', 'local-skill', 'local-skill', 'discovered', 'skill');
    ins.run('c2', 'compact', 'compact', 'seed', 'builtin');
    db.prepare("INSERT INTO remote_hosts (id, name, created_at, updated_at) VALUES ('h1', 'h1', 1, 1)").run();
    db.prepare("INSERT INTO projects (id, name, root_path, created_at, remote_host_id) VALUES ('rp', 'rp', '/r', 1, 'h1')").run();
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM agent_commands').get() as { n: number }).n;
    return { ...s, count };
  }
  const url = '/agents/stub/commands?projectId=rp';
  const names = (j: { commands: { name: string }[] }) => j.commands.map((c) => c.name).sort();
  afterEach(() => { registry.setRemoteFactory(undefined); vi.useRealTimers(); });

  it('merges host skills and never writes agent_commands', async () => {
    const { app, count } = remoteSetup();
    registry.setRemoteFactory(() => ({
      listCommands: async () => [{ name: 'host-skill', label: 'host-skill', sourceDetail: 'skill' as const }],
    } as unknown as AgentAdapter));
    const before = count();
    const res = await call(app, 'GET', url);
    expect(res.status).toBe(200);
    expect(names(res.json)).toEqual(['compact', 'host-skill']);
    expect(res.json.hostOffline).toBeUndefined();
    expect(count()).toBe(before);
  });

  it('rejected call → hostOffline, builtins only', async () => {
    const { app } = remoteSetup();
    registry.setRemoteFactory(() => ({ listCommands: async () => { throw new Error('host_disconnected'); } } as unknown as AgentAdapter));
    const res = await call(app, 'GET', url);
    expect(res.json.hostOffline).toBe(true);
    expect(names(res.json)).toEqual(['compact']);
  });

  it('never-settling call → hostOffline after the 10s timeout', async () => {
    const { app } = remoteSetup();
    registry.setRemoteFactory(() => ({ listCommands: () => new Promise(() => {}) } as unknown as AgentAdapter));
    // Fire only the route's 10s timer immediately; leave fetch/undici timers real.
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) =>
      real(fn, ms === 10_000 ? 0 : ms, ...a)) as unknown as typeof setTimeout);
    let res;
    try { res = await call(app, 'GET', url); } finally { spy.mockRestore(); }
    expect(res.json.hostOffline).toBe(true);
  });

  it('proxy without listCommands → hostOffline', async () => {
    const { app } = remoteSetup();
    registry.setRemoteFactory(() => ({} as unknown as AgentAdapter));
    const res = await call(app, 'GET', url);
    expect(res.json.hostOffline).toBe(true);
  });

  it('includeDisabled=1 never calls the remote factory', async () => {
    const { app } = remoteSetup();
    const factory = vi.fn();
    registry.setRemoteFactory(factory);
    const res = await call(app, 'GET', `${url}&includeDisabled=1`);
    expect(factory).not.toHaveBeenCalled();
    expect(names(res.json)).toEqual(['compact', 'local-skill']);
  });

  it('synchronous factory throw → 200 hostOffline', async () => {
    const { app } = remoteSetup();
    registry.setRemoteFactory(() => { throw new Error('boom'); });
    const res = await call(app, 'GET', url);
    expect(res.status).toBe(200);
    expect(res.json.hostOffline).toBe(true);
  });
});
