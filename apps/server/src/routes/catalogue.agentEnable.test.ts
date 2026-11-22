import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { registry } from '../registry.js';
import { registerCatalogueRoutes } from './catalogue.js';
import { ensureAgent } from '../repositories/models.js';
import { seedCatalogue } from '../db/seed.js';
import type { AgentAdapter, ModelDescriptor } from '@tierwyn/shared';

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
}

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  let reloads = 0;
  const app = express();
  app.use(express.json());
  registerCatalogueRoutes(app, () => db, () => { reloads++; });
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
  registry.register('stub', () => new StubAdapter());
  registry.register('pi', () => new StubAdapter());
});

describe('PATCH /agents/:id enabled', () => {
  it('PATCH enabled:true returns 400 with installHint when the binary is missing', async () => {
    const { app, db, reloads } = setup();
    ensureAgent(db, { id: 'claude-code', label: 'Claude Code' });
    await call(app, 'PATCH', '/agents/claude-code', { executablePath: '/nonexistent/tierwyn-test-binary' });
    const before = reloads();
    const res = await call(app, 'PATCH', '/agents/claude-code', { enabled: true });
    expect(res.status).toBe(400);
    expect(typeof res.json.installHint).toBe('string');
    expect(res.json.installHint.length).toBeGreaterThan(0);
    expect(reloads()).toBe(before);
    const row = db.prepare("SELECT enabled_flag FROM agents WHERE id='claude-code'").get() as { enabled_flag: number };
    expect(row.enabled_flag).toBe(0);
  });

  it('PATCH enabled:true succeeds when executable_path points at a real file', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'claude-code', label: 'Claude Code' });
    await call(app, 'PATCH', '/agents/claude-code', { executablePath: process.execPath });
    const res = await call(app, 'PATCH', '/agents/claude-code', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.json.agent.enabled).toBe(true);
    const row = db.prepare("SELECT enabled_flag FROM agents WHERE id='claude-code'").get() as { enabled_flag: number };
    expect(row.enabled_flag).toBe(1);
  });

  it('PATCH enabled:false always succeeds, even for a missing binary', async () => {
    const { app, db } = setup();
    ensureAgent(db, { id: 'claude-code', label: 'Claude Code' });
    await call(app, 'PATCH', '/agents/claude-code', { executablePath: process.execPath });
    await call(app, 'PATCH', '/agents/claude-code', { enabled: true });
    await call(app, 'PATCH', '/agents/claude-code', { executablePath: '/nonexistent/tierwyn-test-binary' });
    const res = await call(app, 'PATCH', '/agents/claude-code', { enabled: false });
    expect(res.status).toBe(200);
    expect(res.json.agent.enabled).toBe(false);
    const row = db.prepare("SELECT enabled_flag FROM agents WHERE id='claude-code'").get() as { enabled_flag: number };
    expect(row.enabled_flag).toBe(0);
  });

  it('PATCH enabled reloads the catalogue', async () => {
    const { app, db, reloads } = setup();
    ensureAgent(db, { id: 'claude-code', label: 'Claude Code' });
    await call(app, 'PATCH', '/agents/claude-code', { executablePath: '/nonexistent/tierwyn-test-binary' });
    const afterPath = reloads();
    const rejected = await call(app, 'PATCH', '/agents/claude-code', { enabled: true });
    expect(rejected.status).toBe(400);
    expect(reloads()).toBe(afterPath);

    await call(app, 'PATCH', '/agents/claude-code', { executablePath: process.execPath });
    const beforeEnable = reloads();
    const ok = await call(app, 'PATCH', '/agents/claude-code', { enabled: true });
    expect(ok.status).toBe(200);
    expect(reloads()).toBe(beforeEnable + 1);
  });

  it('PATCH enabled:true on a known-but-unstored type creates the row first', async () => {
    const { app, db } = setup();
    const pathRes = await call(app, 'PATCH', '/agents/pi', { executablePath: process.execPath });
    expect(pathRes.status).toBe(200);
    const enableRes = await call(app, 'PATCH', '/agents/pi', { enabled: true });
    expect(enableRes.status).toBe(200);
    expect(enableRes.json.agent.enabled).toBe(true);
    const row = db.prepare("SELECT id, enabled_flag FROM agents WHERE id='pi'").get() as { id: string; enabled_flag: number } | undefined;
    expect(row?.id).toBe('pi');
    expect(row?.enabled_flag).toBe(1);
  });

  it('PATCH enabled:true and executablePath in one body enables using the new path', async () => {
    const { app, db, reloads } = setup();
    const res = await call(app, 'PATCH', '/agents/pi', {
      enabled: true,
      executablePath: process.execPath,
    });
    expect(res.status).toBe(200);
    expect(res.json.agent.enabled).toBe(true);
    expect(res.json.agent.executablePath).toBe(process.execPath);
    expect(reloads()).toBe(1);
    const row = db.prepare("SELECT enabled_flag, executable_path FROM agents WHERE id='pi'")
      .get() as { enabled_flag: number; executable_path: string };
    expect(row.enabled_flag).toBe(1);
    expect(row.executable_path).toBe(process.execPath);
  });

  it('PATCH on an unknown, unregistered id still 404s', async () => {
    const { app, reloads } = setup();
    const res = await call(app, 'PATCH', '/agents/not-an-agent', { enabled: true });
    expect(res.status).toBe(404);
    expect(reloads()).toBe(0);
  });

  it('GET /agents reports enabled for stored rows and false for virtual rows', async () => {
    const { app, db } = setup();
    seedCatalogue(db);
    db.prepare("UPDATE agents SET enabled_flag=1 WHERE id='claude-code'").run();
    const res = await call(app, 'GET', '/agents');
    expect(res.status).toBe(200);
    const byType = new Map((res.json.agents as Array<{ type: string; enabled: boolean }>).map((a) => [a.type, a]));
    expect(byType.get('claude-code')?.enabled).toBe(true);
    expect(byType.get('pi')?.enabled).toBe(false);
  });

  it('PATCH enabled:true succeeds when agent id differs from type', async () => {
    const { app, db } = setup();
    const created = await call(app, 'POST', '/agents', {
      id: 'my-claude',
      type: 'pi',
      label: 'My Claude',
      executablePath: process.execPath,
    });
    expect(created.status).toBe(200);
    expect(created.json.agent.id).toBe('my-claude');
    expect(created.json.agent.type).toBe('pi');
    // Canonical same-type row with a missing binary must not steal the probe.
    const canon = await call(app, 'PATCH', '/agents/pi', {
      label: 'Pi',
      executablePath: '/nonexistent/tierwyn-canonical-missing',
    });
    expect(canon.status).toBe(200);
    const ids = db.prepare("SELECT id FROM agents WHERE type='pi' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(ids.map((r) => r.id).sort()).toEqual(['my-claude', 'pi']);
    const res = await call(app, 'PATCH', '/agents/my-claude', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.json.agent.enabled).toBe(true);
    const row = db.prepare("SELECT enabled_flag FROM agents WHERE id='my-claude'")
      .get() as { enabled_flag: number };
    expect(row.enabled_flag).toBe(1);
    const canonRow = db.prepare("SELECT enabled_flag FROM agents WHERE id='pi'")
      .get() as { enabled_flag: number };
    expect(canonRow.enabled_flag).toBe(0);
  });

  it('PATCH enabled:true on a custom row with a bogus path is 400 even when the canonical type is installed', async () => {
    const { app, db } = setup();
    const created = await call(app, 'POST', '/agents', {
      id: 'my-pi',
      type: 'pi',
      label: 'My Pi',
      executablePath: '/nonexistent/tierwyn-bogus',
    });
    expect(created.status).toBe(200);
    // Canonical same-type row is installed (PATH stand-in: this process binary).
    const canon = await call(app, 'PATCH', '/agents/pi', {
      label: 'Pi',
      executablePath: process.execPath,
    });
    expect(canon.status).toBe(200);
    const ids = db.prepare("SELECT id FROM agents WHERE type='pi' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(ids.map((r) => r.id).sort()).toEqual(['my-pi', 'pi']);
    const res = await call(app, 'PATCH', '/agents/my-pi', { enabled: true });
    expect(res.status).toBe(400);
    expect(typeof res.json.installHint).toBe('string');
    expect(res.json.installHint.length).toBeGreaterThan(0);
    const row = db.prepare("SELECT enabled_flag FROM agents WHERE id='my-pi'")
      .get() as { enabled_flag: number };
    expect(row.enabled_flag).toBe(0);
  });

  it('combined PATCH with a bogus path writes the path but does not enable', async () => {
    const { app, db, reloads } = setup();
    const before = reloads();
    const res = await call(app, 'PATCH', '/agents/pi', {
      executablePath: '/nonexistent/tierwyn-test-binary',
      enabled: true,
    });
    expect(res.status).toBe(400);
    expect(reloads()).toBe(before);
    const row = db.prepare("SELECT enabled_flag, executable_path FROM agents WHERE id='pi'")
      .get() as { enabled_flag: number; executable_path: string };
    expect(row.enabled_flag).toBe(0);
    expect(row.executable_path).toBe('/nonexistent/tierwyn-test-binary');
  });
});
