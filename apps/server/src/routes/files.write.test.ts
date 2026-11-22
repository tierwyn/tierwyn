import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { updateGeneralSettings } from '../repositories/settings.js';
import { requireAuth } from '../auth/middleware.js';
import {
  isPathAllowed, isWritePathAllowed, realpathWithinRoots, registerFileRoutes,
} from './files.js';

const HOME = process.env.HOME ?? homedir();

describe('isWritePathAllowed', () => {
  const projectRoot = '/home/user/myproj';
  const workdir = '/tmp/tierwyn-wt-fake';
  const opts = { projectRoots: [projectRoot], workdirRoot: workdir };

  it('allows a file inside a project root', () => {
    expect(isWritePathAllowed('/home/user/myproj/notes.md', opts)).toBe(true);
  });

  it('allows a file inside opts.workdirRoot', () => {
    expect(isWritePathAllowed('/tmp/tierwyn-wt-fake/notes.md', opts)).toBe(true);
  });

  it('allows a file inside a dot-directory in a project root', () => {
    // yml is not an openable extension; md is. The rule under test is the
    // dot-directory (not the basename) — .github/…/ci.md and .claude/commands.
    expect(isWritePathAllowed('/home/user/myproj/.github/workflows/ci.md', opts)).toBe(true);
    expect(isWritePathAllowed('/home/user/myproj/.claude/commands/foo.md', opts)).toBe(true);
  });

  it('denies agent-home CLAUDE.md even though isPathAllowed allows it', () => {
    const p = `${HOME}/.claude/CLAUDE.md`;
    expect(isPathAllowed(p, { projectRoots: [] })).toBe(true);
    expect(isWritePathAllowed(p, opts)).toBe(false);
  });

  it('denies $HOME/Pictures even though isPathAllowed allows it', () => {
    const p = `${HOME}/Pictures/x.png`;
    expect(isPathAllowed(p, { projectRoots: [] })).toBe(true);
    expect(isWritePathAllowed(p, opts)).toBe(false);
  });

  it('denies /tmp even though isPathAllowed allows it', () => {
    expect(isPathAllowed('/tmp/x.md', { projectRoots: [] })).toBe(true);
    expect(isWritePathAllowed('/tmp/x.md', { projectRoots: [projectRoot] })).toBe(false);
  });

  it('denies any .git segment', () => {
    expect(isWritePathAllowed('/home/user/myproj/.git/config', opts)).toBe(false);
    expect(isWritePathAllowed('/home/user/myproj/.git/hooks/pre-commit.sh', opts)).toBe(false);
  });

  it('denies dot-basenames', () => {
    expect(isWritePathAllowed('/home/user/myproj/.env', opts)).toBe(false);
    expect(isWritePathAllowed('/home/user/myproj/.npmrc', opts)).toBe(false);
    expect(isWritePathAllowed('/home/user/myproj/sub/.bashrc', opts)).toBe(false);
  });

  it('denies isSecretPath hits with an openable extension', () => {
    expect(isWritePathAllowed('/home/user/myproj/credentials.md', opts)).toBe(false);
  });

  it('denies a non-openable extension', () => {
    expect(isWritePathAllowed('/home/user/myproj/binary.bin', opts)).toBe(false);
  });

  it('allows openable config extensions like json and yaml', () => {
    expect(isWritePathAllowed('/home/user/myproj/config.json', opts)).toBe(true);
    expect(isWritePathAllowed('/home/user/myproj/config.yaml', opts)).toBe(true);
  });

  it('denies the project root directory itself', () => {
    expect(isWritePathAllowed(projectRoot, opts)).toBe(false);
  });

  it('denies empty or relative paths', () => {
    expect(isWritePathAllowed('', opts)).toBe(false);
    expect(isWritePathAllowed('relative.md', opts)).toBe(false);
  });
});

describe('realpathWithinRoots', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-realpath-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns the real path when the target is inside a root', async () => {
    const f = join(scratch, 'a.md');
    writeFileSync(f, 'x');
    const real = await realpathWithinRoots(f, [scratch]);
    expect(real).toBe(f);
  });

  it('returns null when a symlink escapes the roots', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'tierwyn-outside-'));
    try {
      const outside = join(outsideDir, 'outside.md');
      writeFileSync(outside, 'secret');
      const link = join(scratch, 'link.md');
      symlinkSync(outside, link);
      expect(await realpathWithinRoots(link, [scratch])).toBeNull();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('PUT /files', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;
  let projectId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-files-write-'));
    const project = createProject(db, { name: 'Scratch', rootPath: scratch });
    projectId = project.id;
    app = express();
    app.use(express.json({ limit: '25mb' }));
    registerFileRoutes(app, () => db);
    updateGeneralSettings(db, { fileEditsEnabled: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
  });

  async function get(path: string): Promise<{ status: number; body: string; headers: Headers }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: r.status, body: await r.text(), headers: r.headers };
    } finally {
      server.close();
    }
  }

  async function put(body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let json: Record<string, unknown> | null = null;
      try { json = text ? JSON.parse(text) as Record<string, unknown> : null; } catch { json = { raw: text }; }
      return { status: r.status, json };
    } finally {
      server.close();
    }
  }

  async function versionOf(abs: string): Promise<string> {
    const res = await get(`/files?path=${encodeURIComponent(abs)}`);
    const v = res.headers.get('X-Tierwyn-File-Version');
    if (!v) throw new Error('missing version header');
    return v;
  }

  it('200 happy path writes the file and returns a new version', async () => {
    const md = join(scratch, 'notes.md');
    writeFileSync(md, 'hello');
    const ver = await versionOf(md);
    const res = await put({ path: md, content: 'hello world', version: ver, projectId });
    expect(res.status).toBe(200);
    expect(readFileSync(md, 'utf8')).toBe('hello world');
    expect(typeof res.json?.version).toBe('string');
    expect(res.json?.version).not.toBe(ver);
  });

  it('409 does not write and returns currentVersion', async () => {
    const md = join(scratch, 'stale.md');
    writeFileSync(md, 'original');
    const ver = await versionOf(md);
    writeFileSync(md, 'changed on disk');
    const res = await put({ path: md, content: 'from client', version: ver, projectId });
    expect(res.status).toBe(409);
    expect(typeof res.json?.currentVersion).toBe('string');
    expect(readFileSync(md, 'utf8')).toBe('changed on disk');
  });

  it('403 agent home', async () => {
    const res = await put({
      path: `${HOME}/.claude/x.md`,
      content: 'nope',
      version: '1-1',
    });
    expect(res.status).toBe(403);
  });

  it('403 symlink escape leaves the outside file unchanged', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'tierwyn-sym-out-'));
    try {
      const outside = join(outsideDir, 'outside.md');
      writeFileSync(outside, 'keep-me');
      const link = join(scratch, 'link.md');
      symlinkSync(outside, link);
      const res = await put({ path: link, content: 'pwned', version: '1-1', projectId });
      expect(res.status).toBe(403);
      expect(readFileSync(outside, 'utf8')).toBe('keep-me');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // Regression tests for the POST-REALPATH re-check in the PUT handler: a
  // symlink inside an allowed root that redirects onto a denied target IN
  // THE SAME ROOT passes realpathWithinRoots (the real path is still inside
  // the root) — only the second isWritePathAllowed(real, …) call stops it.
  // Deleting that re-check makes these fail with a 200 + overwrite.
  it('403 symlink redirecting onto a dot-basename inside the same root', async () => {
    const secret = join(scratch, '.env');
    writeFileSync(secret, 'SECRET=keep-me');
    symlinkSync(secret, join(scratch, 'notes.md'));
    const st = statSync(secret);
    const res = await put({
      path: join(scratch, 'notes.md'),
      content: 'PWNED=1',
      version: `${Math.floor(st.mtimeMs)}-${st.size}`,
      projectId,
    });
    expect(res.status).toBe(403);
    expect(readFileSync(secret, 'utf8')).toBe('SECRET=keep-me');
  });

  it('403 symlink redirecting into .git inside the same root', async () => {
    mkdirSync(join(scratch, '.git'), { recursive: true });
    const cfg = join(scratch, '.git', 'config.md');
    writeFileSync(cfg, '[core]');
    symlinkSync(cfg, join(scratch, 'harmless.md'));
    const st = statSync(cfg);
    const res = await put({
      path: join(scratch, 'harmless.md'),
      content: 'hook = evil',
      version: `${Math.floor(st.mtimeMs)}-${st.size}`,
      projectId,
    });
    expect(res.status).toBe(403);
    expect(readFileSync(cfg, 'utf8')).toBe('[core]');
  });

  // Pins the documented scope decision: write roots span every *local*
  // registered project (worktrees stay conversation-scoped), so an
  // absolute path into local project B is writable from project A's context.
  it('200 writes into another project root from a different project context', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'tierwyn-files-other-'));
    try {
      const projectB = createProject(db, { name: 'Other', rootPath: otherRoot });
      const md = join(otherRoot, 'from-a.md');
      writeFileSync(md, 'b');
      const ver = await versionOf(md);
      const res = await put({ path: md, content: 'written via A', version: ver, projectId });
      expect(res.status).toBe(200);
      expect(readFileSync(md, 'utf8')).toBe('written via A');
      expect(projectB.name).toBe('Other');
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('403 writes into a remote-host project root from a local project context', async () => {
    const remoteRoot = mkdtempSync(join(tmpdir(), 'tierwyn-files-remote-'));
    try {
      const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
      createProject(db, { name: 'Remote', rootPath: remoteRoot, remoteHostId: host.id });
      const md = join(remoteRoot, 'from-hub.md');
      writeFileSync(md, 'keep');
      const st = statSync(md);
      const ver = `${Math.floor(st.mtimeMs)}-${st.size}`;
      const res = await put({ path: md, content: 'pwned', version: ver, projectId });
      expect(res.status).toBe(403);
      expect(readFileSync(md, 'utf8')).toBe('keep');
    } finally {
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it('404 missing file', async () => {
    const res = await put({
      path: join(scratch, 'does-not-exist.md'),
      content: 'x',
      version: '1-1',
      projectId,
    });
    expect(res.status).toBe(404);
  });

  it('413 content of 3 MB hits the in-handler cap', async () => {
    const md = join(scratch, 'big.md');
    writeFileSync(md, 'small');
    const ver = await versionOf(md);
    const res = await put({ path: md, content: 'x'.repeat(3 * 1024 * 1024), version: ver, projectId });
    expect(res.status).toBe(413);
    expect(readFileSync(md, 'utf8')).toBe('small');
  });

  it('400 missing version', async () => {
    const md = join(scratch, 'notes.md');
    writeFileSync(md, 'hello');
    const res = await put({ path: md, content: 'x', projectId });
    expect(res.status).toBe(400);
  });

  it('400 relative path without conversationId or projectId', async () => {
    const res = await put({ path: 'notes.md', content: 'x', version: '1-1' });
    expect(res.status).toBe(400);
    expect(String(res.json?.error)).toMatch(/relative path requires conversationId or projectId/);
  });

  it('preserves mode 0o755 across save', async () => {
    const sh = join(scratch, 'run.sh');
    writeFileSync(sh, '#!/bin/sh\necho hi\n');
    chmodSync(sh, 0o755);
    const ver = await versionOf(sh);
    const res = await put({ path: sh, content: '#!/bin/sh\necho there\n', version: ver, projectId });
    expect(res.status).toBe(200);
    expect(statSync(sh).mode & 0o777).toBe(0o755);
  });

  it('200 worktree root outside the project', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'tierwyn-wt-'));
    try {
      const f = join(wt, 'wt-notes.md');
      writeFileSync(f, 'from-wt');
      const convo = createConversation(db, {
        projectId,
        title: 'wt',
        workdirPath: wt,
      });
      const st = statSync(f);
      const v = `${Math.floor(st.mtimeMs)}-${st.size}`;
      const res = await put({
        path: f,
        content: 'updated-wt',
        version: v,
        conversationId: convo.id,
      });
      expect(res.status).toBe(200);
      expect(readFileSync(f, 'utf8')).toBe('updated-wt');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('file edits setting gate', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-files-gate-'));
    createProject(db, { name: 'Scratch', rootPath: scratch });
    app = express();
    app.use(express.json({ limit: '25mb' }));
    registerFileRoutes(app, () => db);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
  });

  async function get(path: string): Promise<{ status: number; body: string; headers: Headers }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: r.status, body: await r.text(), headers: r.headers };
    } finally {
      server.close();
    }
  }

  async function put(body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let json: Record<string, unknown> | null = null;
      try { json = text ? JSON.parse(text) as Record<string, unknown> : null; } catch { json = { raw: text }; }
      return { status: r.status, json };
    } finally {
      server.close();
    }
  }

  it('default (no general-settings row) PUT is 403 and disk is unchanged', async () => {
    const md = join(scratch, 'notes.md');
    writeFileSync(md, 'untouched');
    const res = await put({ path: md, content: 'edited', version: '1-1' });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe('file edits are disabled');
    expect(readFileSync(md, 'utf8')).toBe('untouched');
  });

  it('GET on a project-root .md with setting off is readable but not writable', async () => {
    const md = join(scratch, 'notes.md');
    writeFileSync(md, '# still readable');
    const res = await get(`/files?path=${encodeURIComponent(md)}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('# still readable');
    expect(res.headers.get('X-Tierwyn-File-Writable')).toBe('0');
  });
});

describe('PUT /files auth mounting', () => {
  it('returns 401 without a cookie when requireAuth is configured', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const app = express();
    app.use(express.json({ limit: '25mb' }));
    app.use(requireAuth({
      disabled: false,
      configured: true,
      sessionSecret: 'unit-test-session-secret-value-32bytes',
      passwordHash: 'not-used',
      cookieSecure: false,
    }));
    registerFileRoutes(app, () => db);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/tmp/x.md', content: 'x', version: '1-1' }),
      });
      expect(r.status).toBe(401);
    } finally {
      server.close();
      db.close();
    }
  });

  it('registerFileRoutes is after requireAuth and spawn routes are before it', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), '../index.ts');
    const src = readFileSync(indexPath, 'utf8');
    const spawnIdx = src.indexOf('registerSpawnRoutes(app');
    const authIdx = src.indexOf('app.use(requireAuth(authConfig))');
    const filesIdx = src.indexOf('registerFileRoutes(app');
    const gitWtIdx = src.indexOf('registerGitWorkingTreeRoutes(app');
    expect(spawnIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeGreaterThan(-1);
    expect(gitWtIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeLessThan(authIdx);
    expect(filesIdx).toBeGreaterThan(authIdx);
    expect(gitWtIdx).toBeGreaterThan(authIdx);
  });
});
