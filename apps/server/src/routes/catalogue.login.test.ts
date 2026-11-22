import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import type { ChildProcess } from 'child_process';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { registerCatalogueRoutes, disposeCatalogueLogin } from './catalogue.js';
import { binaryOnPath } from '../discovery.js';
import { probeLogin } from '../node/loginProbe.js';

vi.mock('../discovery.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../discovery.js')>();
  return {
    ...orig,
    binaryOnPath: vi.fn(() => true),
    discoverInstalledAgents: vi.fn((...args: Parameters<typeof orig.discoverInstalledAgents>) =>
      orig.discoverInstalledAgents(...args).map((d) => ({ ...d, installed: true })),
    ),
  };
});

vi.mock('../node/loginProbe.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../node/loginProbe.js')>();
  return { ...orig, probeLogin: vi.fn(() => false) };
});

const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code'
  + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=x'
  + '&code_challenge=abc&code_challenge_method=S256&state=st';

function fakeLoginChild(): {
  child: ChildProcess;
  writeStdout(s: string): void;
  writeStderr(s: string): void;
  exit(code: number): void;
  killed: () => boolean;
  stdinChunks: string[];
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const stdinChunks: string[] = [];
  stdin.on('data', (c: Buffer | string) => {
    stdinChunks.push(typeof c === 'string' ? c : c.toString('utf8'));
  });
  const ee = new EventEmitter();
  let killed = false;
  const child = Object.assign(ee, {
    stdout,
    stderr,
    stdin,
    pid: 4242,
    get killed() { return killed; },
    kill(_sig?: NodeJS.Signals | number) {
      killed = true;
      queueMicrotask(() => ee.emit('close', null, 'SIGTERM'));
      return true;
    },
  }) as unknown as ChildProcess;
  return {
    child,
    writeStdout(s: string) { stdout.write(s); },
    writeStderr(s: string) { stderr.write(s); },
    exit(code: number) { queueMicrotask(() => ee.emit('close', code)); },
    killed: () => killed,
    stdinChunks,
  };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
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

function agentOf(json: { agents: Array<{ type: string; login?: { running?: boolean; userCode?: string; url?: string; codeSubmitted?: boolean } }> }, type: string) {
  return json.agents.find((a) => a.type === type);
}

describe('GET /agents hub-local login badge', () => {
  it('installed claude-code carries loggedIn:false so the UI shows Log in', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'hub-bin-'));
    writeFileSync(join(dir, 'claude'), '');
    const prev = process.env.PATH;
    process.env.PATH = dir;
    vi.mocked(probeLogin).mockReturnValue(false);
    try {
      const { app } = setup();
      const g = await call(app, 'GET', '/agents');
      const a = g.json.agents.find((x: { type: string }) => x.type === 'claude-code');
      expect(a.installed).toBe(true);
      expect(a.loggedIn).toBe(false);
    } finally { process.env.PATH = prev; }
  });
});

describe('POST /agents/:type/login', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(binaryOnPath).mockReturnValue(true);
    vi.mocked(probeLogin).mockReturnValue(false);
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
  });

  afterEach(() => {
    disposeCatalogueLogin();
    killSpy.mockRestore();
  });

  it('start codex → 202, stdout device code lands on GET /agents, close(0) drops login', { timeout: 15_000 }, async () => {
    const fake = fakeLoginChild();
    const { app } = setup({ spawnLogin: () => fake.child });
    const started = await call(app, 'POST', '/agents/codex/login');
    expect(started.status).toBe(202);
    expect(started.json).toEqual({ ok: true, started: true });

    fake.writeStdout('Visit https://auth.openai.com/codex/device and enter TAEF-M7I6R\n');
    await until(async () => {
      const g = await call(app, 'GET', '/agents');
      const a = agentOf(g.json, 'codex');
      return Boolean(a?.login?.running && a.login.userCode);
    });
    const during = await call(app, 'GET', '/agents');
    const row = agentOf(during.json, 'codex');
    expect(row?.login?.running).toBe(true);
    expect(row?.login?.userCode).toBe('TAEF-M7I6R');

    fake.exit(0);
    await until(async () => {
      const g = await call(app, 'GET', '/agents');
      return agentOf(g.json, 'codex')?.login === undefined;
    });
  });

  it('second agent while one runs → 409', async () => {
    const fake = fakeLoginChild();
    const { app } = setup({ spawnLogin: () => fake.child });
    expect((await call(app, 'POST', '/agents/codex/login')).status).toBe(202);
    const busy = await call(app, 'POST', '/agents/claude-code/login');
    expect(busy.status).toBe(409);
    expect(busy.json.error).toMatch(/another login is running/i);
  });

  it('claude-code /login/code rejects malformed and writes a valid code to stdin', { timeout: 15_000 }, async () => {
    const fake = fakeLoginChild();
    const { app } = setup({ spawnLogin: () => fake.child });
    expect((await call(app, 'POST', '/agents/claude-code/login')).status).toBe(202);
    fake.writeStderr(`visit: ${CLAUDE_URL}\n`);
    await until(async () => {
      const g = await call(app, 'GET', '/agents');
      return Boolean(agentOf(g.json, 'claude-code')?.login?.url);
    });

    const bad = await call(app, 'POST', '/agents/claude-code/login/code', { code: 'not a code' });
    expect(bad.status).toBe(400);
    expect(fake.stdinChunks).toEqual([]);

    const ok = await call(app, 'POST', '/agents/claude-code/login/code', { code: 'abc#st' });
    expect(ok.status).toBe(200);
    expect(fake.stdinChunks).toEqual(['abc#st\n']);
  });

  it('cancel drops login and SIGTERMs the child', async () => {
    const fake = fakeLoginChild();
    const { app } = setup({ spawnLogin: () => fake.child });
    expect((await call(app, 'POST', '/agents/codex/login')).status).toBe(202);
    const cancelled = await call(app, 'POST', '/agents/codex/login/cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toEqual({ ok: true, cancelled: true });
    expect(fake.killed()).toBe(true);
    const g = await call(app, 'GET', '/agents');
    expect(agentOf(g.json, 'codex')?.login).toBeUndefined();
  });
});
