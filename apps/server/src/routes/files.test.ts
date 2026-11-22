import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, chmodSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { get as httpGet } from 'http';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent } from '../repositories/events.js';
import { updateGeneralSettings } from '../repositories/settings.js';
import { isPathAllowed, isRetentionArchivePath, registerFileRoutes, resolveDateTemplatePath } from './files.js';

describe('isPathAllowed', () => {
  const projectRoot = '/home/user/myproj';

  it('allows an image inside the project root', () => {
    expect(isPathAllowed('/home/user/myproj/diagram.png', { projectRoots: [projectRoot] })).toBe(true);
  });

  it('allows markdown inside the project root', () => {
    expect(isPathAllowed('/home/user/myproj/notes.md', { projectRoots: [projectRoot] })).toBe(true);
  });

  it('rejects an extension not on the allow-list', () => {
    expect(isPathAllowed('/home/user/myproj/.env', { projectRoots: [projectRoot] })).toBe(false);
    expect(isPathAllowed('/home/user/myproj/binary.bin', { projectRoots: [projectRoot] })).toBe(false);
  });

  it('allows json and yaml inside the project root', () => {
    expect(isPathAllowed('/home/user/myproj/config.json', { projectRoots: [projectRoot] })).toBe(true);
    expect(isPathAllowed('/home/user/myproj/config.yaml', { projectRoots: [projectRoot] })).toBe(true);
  });

  it('allows a file whose realpath sits under a symlinked project root', () => {
    const real = mkdtempSync(join(tmpdir(), 'tierwyn-realproj-'));
    writeFileSync(join(real, 'notes.md'), 'ok');
    const link = join(tmpdir(), `tierwyn-projlink-${Date.now()}`);
    symlinkSync(real, link);
    try {
      expect(isPathAllowed(join(real, 'notes.md'), { projectRoots: [link] })).toBe(true);
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('rejects paths outside any allowed root', () => {
    expect(isPathAllowed('/etc/passwd', { projectRoots: [projectRoot] })).toBe(false);
    // .png so extension passes, but root is wrong
    expect(isPathAllowed('/etc/secrets.png', { projectRoots: [projectRoot] })).toBe(false);
  });

  it('rejects the project root itself (not a file)', () => {
    expect(isPathAllowed(projectRoot, { projectRoots: [projectRoot] })).toBe(false);
  });

  it('rejects relative or empty paths', () => {
    expect(isPathAllowed('', { projectRoots: [projectRoot] })).toBe(false);
    expect(isPathAllowed('relative.png', { projectRoots: [projectRoot] })).toBe(false);
  });

  it('allows /tmp paths (covered by os.tmpdir())', () => {
    expect(isPathAllowed('/tmp/foo.png', { projectRoots: [] })).toBe(true);
  });

  it('allows agent home paths', () => {
    // Build against the real homedir; assert that a known subdir is allowed
    const expectedAllowed = `${process.env.HOME}/.claude/foo.md`;
    expect(isPathAllowed(expectedAllowed, { projectRoots: [] })).toBe(true);
  });

  it('allows Pictures/Downloads screenshots (user-facing dirs)', () => {
    expect(isPathAllowed(`${process.env.HOME}/Pictures/Screenshot 2026-06-28.png`, { projectRoots: [] })).toBe(true);
  });

  it('allows Media library images under $HOME/Media', () => {
    expect(isPathAllowed(`${process.env.HOME}/Media/Images/tierwyn-logo.png`, { projectRoots: [] })).toBe(true);
  });

  it('allows media files under $HOME/Videos and $HOME/Music', () => {
    expect(isPathAllowed(`${process.env.HOME}/Videos/holiday.mp4`, { projectRoots: [] })).toBe(true);
    expect(isPathAllowed(`${process.env.HOME}/Music/track.mp3`, { projectRoots: [] })).toBe(true);
  });

  it('allows non-hidden openable files directly in $HOME', () => {
    expect(isPathAllowed(`${process.env.HOME}/Screenshot 2026-09-11.png`, { projectRoots: [] })).toBe(true);
    expect(isPathAllowed(`${process.env.HOME}/notes.md`, { projectRoots: [] })).toBe(true);
    expect(isPathAllowed(`${process.env.HOME}/.bashrc`, { projectRoots: [] })).toBe(false);
    expect(isPathAllowed(`${process.env.HOME}/unrelated/foo.png`, { projectRoots: [] })).toBe(false);
  });

  it('allows any extension under <dataDir>/attachments but not a .gz outside it', () => {
    const dataDir = '/home/user/tierwyn/data';
    const conv = 'bc33dace-50e8-4206-9d84-ca7a57187c1b';
    expect(isPathAllowed(`${dataDir}/attachments/${conv}/abc.gz`, { dataDir })).toBe(true);
    expect(isPathAllowed(`${dataDir}/attachments/${conv}/notes.md`, { dataDir })).toBe(true);
    expect(isPathAllowed('/tmp/outside.gz', { dataDir })).toBe(false);
  });

  it('never serves a FW-17 database backup through /files', () => {
    const dataDir = '/home/user/tierwyn/data';
    expect(isPathAllowed(`${dataDir}/backups/tierwyn-20260824-090503.db`, {
      dataDir, extraRoots: [dataDir],
    })).toBe(false);
    expect(isPathAllowed(`${dataDir}/backups/tierwyn-20260824-090503-full.tar`, {
      dataDir, extraRoots: [dataDir],
    })).toBe(false);
  });
});

describe('isRetentionArchivePath', () => {
  const dataDir = '/home/user/proj/data';

  it('matches the archive subtree even when the extension is openable', () => {
    expect(isRetentionArchivePath('/home/user/proj/data/archive/abc.md', dataDir)).toBe(true);
    expect(isRetentionArchivePath('/home/user/proj/data/archive/abc.jsonl', dataDir)).toBe(true);
    expect(isRetentionArchivePath('/home/user/proj/data/archive/nested/x.txt', dataDir)).toBe(true);
  });

  it('does not match a sibling directory (prefix-safe)', () => {
    expect(isRetentionArchivePath('/home/user/proj/data/archive-old/x.md', dataDir)).toBe(false);
    expect(isRetentionArchivePath('/home/user/proj/data/notes.md', dataDir)).toBe(false);
  });

  it('is consulted by isPathAllowed before the extension check', () => {
    // .md is openable and the path sits inside a project root — only the
    // archive denial layer should reject it.
    expect(isPathAllowed('/home/user/proj/data/archive/abc.md', {
      projectRoots: ['/home/user/proj'],
      dataDir,
    })).toBe(false);
  });
});

describe('GET /files', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-files-test-'));
    createProject(db, { name: 'Scratch', rootPath: scratch });
    app = express();
    app.use(express.json());
    registerFileRoutes(app, () => db);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
  });

  async function get(path: string): Promise<{ status: number; body: string; contentType: string }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      const body = await r.text();
      return { status: r.status, body, contentType: r.headers.get('content-type') ?? '' };
    } finally {
      server.close();
    }
  }

  async function head(path: string): Promise<{ status: number; body: string; contentLength: string | null }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'HEAD' });
      const body = await r.text();
      return { status: r.status, body, contentLength: r.headers.get('content-length') };
    } finally {
      server.close();
    }
  }

  it('serves an image inside the project root with the right Content-Type', async () => {
    const png = join(scratch, 'pixel.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await get(`/files?path=${encodeURIComponent(png)}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/png');
    expect(res.body.length).toBe(4);
  });

  it('serves markdown with text/markdown Content-Type', async () => {
    const md = join(scratch, 'notes.md');
    writeFileSync(md, '# Hello');
    const res = await get(`/files?path=${encodeURIComponent(md)}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/markdown');
    expect(res.body).toBe('# Hello');
  });

  it('HEAD probes openability without streaming a body', async () => {
    const md = join(scratch, 'probe.md');
    writeFileSync(md, '# probe body should not be sent');
    const res = await head(`/files?path=${encodeURIComponent(md)}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.contentLength).toBe(String(Buffer.byteLength('# probe body should not be sent')));
  });

  it('HEAD returns 404 for a permitted but missing file', async () => {
    const res = await head(`/files?path=${encodeURIComponent(join(scratch, 'missing-probe.md'))}`);
    expect(res.status).toBe(404);
  });

  it('serves a video inside the project root with a video Content-Type', async () => {
    const f = join(scratch, 'clip.mp4');
    writeFileSync(f, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    const res = await get(`/files?path=${encodeURIComponent(f)}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('video/mp4');
    expect(res.body.length).toBe(8);
  });

  it('serves 206 partial content for media Range requests (seeking)', async () => {
    const f = join(scratch, 'seekable.mp4');
    writeFileSync(f, Buffer.alloc(1000, 7));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(f)}`, {
        headers: { Range: 'bytes=0-99' },
      });
      const body = await r.text();
      expect(r.status).toBe(206);
      expect(r.headers.get('content-range')).toBe('bytes 0-99/1000');
      expect(r.headers.get('content-length')).toBe('100');
      expect(body.length).toBe(100);
    } finally {
      server.close();
    }
  });

  it('clamps a Range end past EOF to the file size', async () => {
    const f = join(scratch, 'clamped.webm');
    writeFileSync(f, Buffer.alloc(1000, 7));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(f)}`, {
        headers: { Range: 'bytes=900-1999' },
      });
      expect(r.status).toBe(206);
      expect(r.headers.get('content-range')).toBe('bytes 900-999/1000');
      expect(r.headers.get('content-length')).toBe('100');
    } finally {
      server.close();
    }
  });

  it('serves a suffix Range (bytes=-N) as the last N bytes', async () => {
    const f = join(scratch, 'suffix.webm');
    writeFileSync(f, Buffer.alloc(1000, 7));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(f)}`, {
        headers: { Range: 'bytes=-100' },
      });
      expect(r.status).toBe(206);
      expect(r.headers.get('content-range')).toBe('bytes 900-999/1000');
      expect(r.headers.get('content-length')).toBe('100');
    } finally {
      server.close();
    }
  });

  it('returns 416 when the Range start is past EOF', async () => {
    const f = join(scratch, 'oob.mkv');
    writeFileSync(f, Buffer.alloc(1000, 7));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(f)}`, {
        headers: { Range: 'bytes=5000-5999' },
      });
      // Reading the body must complete cleanly — a stale Content-Length would
      // corrupt response framing and surface as a client socket error.
      const body = await r.arrayBuffer();
      expect(r.status).toBe(416);
      expect(r.headers.get('content-range')).toBe('bytes */1000');
      expect(body.byteLength).toBe(0);
    } finally {
      server.close();
    }
  });

  it('ignores a malformed Range header and serves 200', async () => {
    const f = join(scratch, 'badrange.mov');
    writeFileSync(f, Buffer.alloc(100, 7));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(f)}`, {
        headers: { Range: 'bytes=nonsense' },
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-length')).toBe('100');
    } finally {
      server.close();
    }
  });

  it('expands ~ to the user home', async () => {
    // Create a real file under a permitted agent home subdir.
    const dir = join(process.env.HOME!, '.tierwyn-test-files-tmp');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'fromhome.md');
    writeFileSync(f, 'hi');
    try {
      // Pretend the home dir is a project root by adding it explicitly
      // via a second project so ~ resolves to a permitted path.
      createProject(db, { name: 'Home', rootPath: process.env.HOME! });
      const tilde = `~/.tierwyn-test-files-tmp/fromhome.md`;
      const res = await get(`/files?path=${encodeURIComponent(tilde)}`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('hi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 403 for a path outside all roots', async () => {
    const res = await get(`/files?path=${encodeURIComponent('/etc/hostname')}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 even when extension matches but root is wrong', async () => {
    // Synthesize a fake /etc/secrets.png; we don't need to write it,
    // the request should be rejected before stat().
    const res = await get(`/files?path=${encodeURIComponent('/etc/secrets.png')}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing path param', async () => {
    const res = await get('/files');
    expect(res.status).toBe(400);
  });

  it('returns 404 for a permitted but missing file', async () => {
    const res = await get(`/files?path=${encodeURIComponent(join(scratch, 'nope.png'))}`);
    expect(res.status).toBe(404);
  });

  it('collapses .. traversal before the allow-list check', async () => {
    // /tmp is allowed; /tmp/../etc/secrets.png resolves to /etc/secrets.png which is not allowed
    const res = await get(`/files?path=${encodeURIComponent('/tmp/../etc/secrets.png')}`);
    expect(res.status).toBe(403);
  });

  it('403s a symlink to a secret outside the project', async () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'tierwyn-secret-home-'));
    const secret = join(secretDir, 'id_ed25519');
    writeFileSync(secret, 'SECRETKEY');
    const link = join(scratch, 'leak.md');
    symlinkSync(secret, link);
    try {
      const res = await get(`/files?path=${encodeURIComponent(link)}`);
      expect(res.status).toBe(403);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('serves a symlink to another file inside the project', async () => {
    const target = join(scratch, 'real.md');
    writeFileSync(target, '# ok');
    const link = join(scratch, 'alias.md');
    symlinkSync(target, link);
    const res = await get(`/files?path=${encodeURIComponent(link)}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('# ok');
  });

  it('403s agent credential files inside the project', async () => {
    const f = join(scratch, 'auth.json');
    writeFileSync(f, '{"token":"x"}');
    const res = await get(`/files?path=${encodeURIComponent(f)}`);
    expect(res.status).toBe(403);
  });

  it('rejects a non-openable extension even inside the project root', async () => {
    const env = join(scratch, '.env');
    writeFileSync(env, 'SECRET=1');
    const res = await get(`/files?path=${encodeURIComponent(env)}`);
    expect(res.status).toBe(403);
  });

  it('serves a file under $HOME/Media', async () => {
    const dir = join(process.env.HOME!, 'Media', '.tierwyn-files-test');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'pixel.png');
    writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const res = await get(`/files?path=${encodeURIComponent(f)}`);
      expect(res.status).toBe(200);
      expect(res.contentType).toBe('image/png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves a non-hidden screenshot directly under $HOME with spaces in filename', async () => {
    const f = join(process.env.HOME!, 'Screenshot 2026-09-11.png');
    const created = !existsSync(f);
    if (created) writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const res = await get(`/files?path=${encodeURIComponent(f)}`);
      expect(res.status).toBe(200);
      expect(res.contentType).toBe('image/png');
    } finally {
      if (created) rmSync(f, { force: true });
    }
  });

  it('falls back to $HOME for relative paths missing from the project root', async () => {
    const project = createProject(db, { name: 'RelMedia', rootPath: scratch });
    const convo = createConversation(db, { projectId: project.id, title: 'rel-media' });
    const dir = join(process.env.HOME!, 'Media', '.tierwyn-files-test-rel');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'home-only.png');
    writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const rel = 'Media/.tierwyn-files-test-rel/home-only.png';
      const res = await get(
        `/files?path=${encodeURIComponent(rel)}&conversationId=${encodeURIComponent(convo.id)}`,
      );
      expect(res.status).toBe(200);
      expect(res.contentType).toBe('image/png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves relative paths against projectId (no conversation)', async () => {
    const project = createProject(db, { name: 'SchedProj', rootPath: scratch });
    const md = join(scratch, 'schedule-note.md');
    writeFileSync(md, '# from projectId');
    const res = await get(
      `/files?path=${encodeURIComponent('schedule-note.md')}&projectId=${encodeURIComponent(project.id)}`,
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/markdown/);
    expect(res.body).toBe('# from projectId');
  });

  it('returns 404 for unknown projectId with a relative path', async () => {
    const res = await get(
      `/files?path=${encodeURIComponent('missing.md')}&projectId=${encodeURIComponent('no-such-project')}`,
    );
    expect(res.status).toBe(404);
  });

  it('resolves file:/// URLs with hash line numbers and url encoding', async () => {
    const targetFile = join(scratch, 'file-uri-test.ts');
    writeFileSync(targetFile, 'console.log("hello");');
    const res = await get(`/files?path=${encodeURIComponent(`file://${targetFile}#L10-L20`)}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('console.log("hello");');
  });

  it('exposes version + writable headers on a project-root file when edits are enabled', async () => {
    updateGeneralSettings(db, { fileEditsEnabled: true });
    const md = join(scratch, 'editable.md');
    writeFileSync(md, '# edit me');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(md)}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('X-Tierwyn-File-Version')).toMatch(/^\d+-\d+$/);
      expect(r.headers.get('X-Tierwyn-File-Writable')).toBe('1');
      expect(r.headers.get('X-Tierwyn-File-Version')).toBe(r.headers.get('X-Tierwyn-File-Version'));
      expect(await r.text()).toBe('# edit me');
    } finally {
      server.close();
    }
  });

  it('returns writable 0 for an agent-home file while still serving the body', async () => {
    // Override HOME so the test builds its fake agent home in a scratch dir
    // instead of mutating the operator's real ~/.claude.
    const fakeHome = mkdtempSync(join(tmpdir(), 'tierwyn-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const dir = join(fakeHome, '.claude');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'tierwyn-writable-header-test.md');
    writeFileSync(f, 'agent-home-body');
    try {
      updateGeneralSettings(db, { fileEditsEnabled: true });
      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(f)}`);
        expect(r.status).toBe(200);
        expect(r.headers.get('X-Tierwyn-File-Writable')).toBe('0');
        expect(await r.text()).toBe('agent-home-body');
      } finally {
        server.close();
      }
    } finally {
      process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('GET /files archive denial', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;
  let dataDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-files-arch-'));
    dataDir = join(scratch, 'data');
    mkdirSync(join(dataDir, 'archive'), { recursive: true });
    // Project root is the scratch dir so data/archive is lexically inside it —
    // the same layout as prod (repo root registered as a project).
    createProject(db, { name: 'Scratch', rootPath: scratch });
    app = express();
    app.use(express.json());
    registerFileRoutes(app, () => db, { dataDir });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
  });

  async function get(path: string): Promise<{ status: number; body: string }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: r.status, body: await r.text() };
    } finally {
      server.close();
    }
  }

  it('rejects data/archive/<id>.md even though md is openable', async () => {
    const archived = join(dataDir, 'archive', 'conv-1.md');
    writeFileSync(archived, '# archived');
    const res = await get(`/files?path=${encodeURIComponent(archived)}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/not allowed/);
  });
});

describe('GET /files/git-diff', () => {
  let db: Database.Database;
  let app: express.Express;
  let gitRepoDir: string;
  let nonGitDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);

    gitRepoDir = mkdtempSync(join(tmpdir(), 'tierwyn-git-diff-repo-'));
    nonGitDir = mkdtempSync(join(tmpdir(), 'tierwyn-git-diff-nongit-'));

    execFileSync('git', ['init'], { cwd: gitRepoDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: gitRepoDir });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: gitRepoDir });

    createProject(db, { name: 'GitProject', rootPath: gitRepoDir });
    createProject(db, { name: 'NonGitProject', rootPath: nonGitDir });

    app = express();
    app.use(express.json());
    registerFileRoutes(app, () => db);
  });

  afterEach(() => {
    rmSync(gitRepoDir, { recursive: true, force: true });
    rmSync(nonGitDir, { recursive: true, force: true });
    db.close();
  });

  async function get(path: string): Promise<{ status: number; body: any }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await r.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* ignore */ }
      return { status: r.status, body };
    } finally {
      server.close();
    }
  }

  it('returns modified false and empty diff when file has no git changes', async () => {
    const filePath = join(gitRepoDir, 'hello.md');
    writeFileSync(filePath, '# Initial\nLine 1\n');
    execFileSync('git', ['add', 'hello.md'], { cwd: gitRepoDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: gitRepoDir });

    const res = await get(`/files/git-diff?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ modified: false, diff: '', isTracked: true });
  });

  it('returns modified true and diff text when tracked file is modified', async () => {
    const filePath = join(gitRepoDir, 'hello.md');
    writeFileSync(filePath, '# Initial\nLine 1\n');
    execFileSync('git', ['add', 'hello.md'], { cwd: gitRepoDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: gitRepoDir });

    writeFileSync(filePath, '# Initial\nLine 1\nLine 2 added\n');

    const res = await get(`/files/git-diff?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(200);
    expect(res.body.modified).toBe(true);
    expect(res.body.isTracked).toBe(true);
    expect(res.body.diff).toContain('+Line 2 added');
  });

  it('returns modified false for files in non-git directory', async () => {
    const filePath = join(nonGitDir, 'plain.md');
    writeFileSync(filePath, '# Plain file\n');

    const res = await get(`/files/git-diff?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ modified: false, diff: '', isTracked: false });
  });

  it('returns 404 for missing file', async () => {
    const filePath = join(gitRepoDir, 'missing.md');
    const res = await get(`/files/git-diff?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 for disallowed path', async () => {
    const res = await get(`/files/git-diff?path=${encodeURIComponent('/etc/passwd')}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /files/git-restore', () => {
  let db: Database.Database;
  let app: express.Express;
  let gitRepoDir: string;
  let nonGitDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);

    gitRepoDir = mkdtempSync(join(tmpdir(), 'tierwyn-git-restore-repo-'));
    nonGitDir = mkdtempSync(join(tmpdir(), 'tierwyn-git-restore-nongit-'));

    execFileSync('git', ['init'], { cwd: gitRepoDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: gitRepoDir });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: gitRepoDir });

    createProject(db, { name: 'GitProject', rootPath: gitRepoDir });
    createProject(db, { name: 'NonGitProject', rootPath: nonGitDir });

    app = express();
    app.use(express.json());
    registerFileRoutes(app, () => db);
  });

  afterEach(() => {
    rmSync(gitRepoDir, { recursive: true, force: true });
    rmSync(nonGitDir, { recursive: true, force: true });
    db.close();
  });

  async function post(body: any): Promise<{ status: number; body: any }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/files/git-restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let resBody: any = text;
      try { resBody = JSON.parse(text); } catch { /* ignore */ }
      return { status: r.status, body: resBody };
    } finally {
      server.close();
    }
  }

  it('reverts modified tracked file to HEAD content', async () => {
    const filePath = join(gitRepoDir, 'hello.md');
    writeFileSync(filePath, '# Initial committed content\n');
    execFileSync('git', ['add', 'hello.md'], { cwd: gitRepoDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: gitRepoDir });

    writeFileSync(filePath, '# Modified uncommitted content\n');

    const res = await post({ path: filePath });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('restored');

    const content = readFileSync(filePath, 'utf8');
    expect(content).toBe('# Initial committed content\n');
  });

  it('deletes untracked file from disk', async () => {
    const filePath = join(gitRepoDir, 'untracked.md');
    writeFileSync(filePath, '# Untracked file\n');

    expect(existsSync(filePath)).toBe(true);

    const res = await post({ path: filePath });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('deleted');
    expect(existsSync(filePath)).toBe(false);
  });

  it('rejects file in non-git directory', async () => {
    const filePath = join(nonGitDir, 'plain.md');
    writeFileSync(filePath, '# Plain file\n');

    const res = await post({ path: filePath });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not in a git repository/);
  });

  it('returns 403 for disallowed path', async () => {
    const res = await post({ path: '/etc/passwd' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for missing file', async () => {
    const filePath = join(gitRepoDir, 'missing.md');
    const res = await post({ path: filePath });
    expect(res.status).toBe(404);
  });
});

describe('GET /files smart resolution fallbacks', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-smart-files-test-'));
    createProject(db, { name: 'SmartScratch', rootPath: scratch });
    app = express();
    app.use(express.json());
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
      const body = await r.text();
      return { status: r.status, body, headers: r.headers };
    } finally {
      server.close();
    }
  }

  it('resolves bare filename to nested monorepo file via project subpath search', async () => {
    const project = createProject(db, { name: 'Monorepo', rootPath: scratch });
    const convo = createConversation(db, { projectId: project.id, title: 'mono-test' });
    const nestedDir = join(scratch, 'apps', 'server', 'src');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'commitMessage.ts'), 'export const commit = true;');

    const res = await get(
      `/files?path=${encodeURIComponent('commitMessage.ts')}&conversationId=${encodeURIComponent(convo.id)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('export const commit = true;');
    expect(res.headers.get('x-tierwyn-file-path')).toBe(encodeURIComponent(join(nestedDir, 'commitMessage.ts')));
  });

  it('resolves partial subpath to nested file', async () => {
    const project = createProject(db, { name: 'SubpathProj', rootPath: scratch });
    const convo = createConversation(db, { projectId: project.id, title: 'subpath-test' });
    const nestedDir = join(scratch, 'apps', 'server', 'src', 'routes');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'enhance.ts'), 'export const enhanceRoute = true;');

    const res = await get(
      `/files?path=${encodeURIComponent('routes/enhance.ts')}&conversationId=${encodeURIComponent(convo.id)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('export const enhanceRoute = true;');
    expect(res.headers.get('x-tierwyn-file-path')).toBe(encodeURIComponent(join(nestedDir, 'enhance.ts')));
  });

  it('resolves YYYY-MM-DD template placeholder to actual date-stamped file', async () => {
    const project = createProject(db, { name: 'PlanProj', rootPath: scratch });
    const convo = createConversation(db, { projectId: project.id, title: 'plan-test' });
    const planDir = join(scratch, 'internal', 'docs', 'plans');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, '2026-09-13-my-plan.md'), '# Actual Plan Content');

    const templatePath = 'internal/docs/plans/YYYY-MM-DD-my-plan.md';
    const res = await get(
      `/files?path=${encodeURIComponent(templatePath)}&conversationId=${encodeURIComponent(convo.id)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('# Actual Plan Content');
    expect(res.headers.get('x-tierwyn-file-path')).toBe(encodeURIComponent(join(planDir, '2026-09-13-my-plan.md')));
  });

  it('resolves fuzzy screenshot date when exact timestamp is omitted', async () => {
    const screenshotsDir = join(process.env.HOME!, 'Pictures', 'Screenshots');
    const testScreenshot = join(screenshotsDir, 'Screenshot From 2026-09-11 99-99-99.png');
    mkdirSync(screenshotsDir, { recursive: true });
    writeFileSync(testScreenshot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      const res = await get(
        `/files?path=${encodeURIComponent('Screenshot 2026-09-11.png')}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
    } finally {
      rmSync(testScreenshot, { force: true });
    }
  });
});

describe('GET /files attachment shard', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;
  let dataDir: string;
  const conv = 'bc33dace-50e8-4206-9d84-ca7a57187c1b';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-files-att-'));
    dataDir = join(scratch, 'data');
    mkdirSync(join(dataDir, 'attachments', conv), { recursive: true });
    createProject(db, { name: 'Scratch', rootPath: scratch });
    app = express();
    app.use(express.json());
    registerFileRoutes(app, () => db, { dataDir });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
  });

  async function get(path: string): Promise<{
    status: number; body: string; contentType: string; headers: Headers;
  }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return {
        status: r.status,
        body: await r.text(),
        contentType: r.headers.get('content-type') ?? '',
        headers: r.headers,
      };
    } finally {
      server.close();
    }
  }

  it('serves an ATT_ROOT .gz as octet-stream with CSP sandbox and nosniff', async () => {
    const file = join(dataDir, 'attachments', conv, 'abc.gz');
    writeFileSync(file, 'gzip-bytes');
    const res = await get(`/files?path=${encodeURIComponent(file)}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('gzip-bytes');
    expect(res.contentType).toMatch(/octet-stream/);
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('still 403s a .gz outside ATT_ROOT', async () => {
    const outside = join(scratch, 'other.gz');
    writeFileSync(outside, 'nope');
    const res = await get(`/files?path=${encodeURIComponent(outside)}`);
    expect(res.status).toBe(403);
  });

  it('download=1 emits Content-Disposition attachment with filename*', async () => {
    const file = join(dataDir, 'attachments', conv, 'abc.md');
    writeFileSync(file, '# hi');
    const res = await get(`/files?path=${encodeURIComponent(file)}&download=1&name=${encodeURIComponent('notes.md')}`);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/^attachment;/);
    expect(cd).toMatch(/filename="notes.md"/);
    expect(cd).toMatch(/filename\*=UTF-8''notes\.md/);
  });

  it('sanitises the name= override', async () => {
    const file = join(dataDir, 'attachments', conv, 'abc.md');
    writeFileSync(file, '# hi');
    const res = await get(`/files?path=${encodeURIComponent(file)}&download=1&name=${encodeURIComponent('a\r\nX: 1.md')}`);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).not.toMatch(/\r|\n/);
    expect(cd).not.toMatch(/X: 1/);
  });

  it('sandboxes non-attachment files too (a project SVG must not run script on our origin)', async () => {
    const svg = join(scratch, 'evil.svg');
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await get(`/files?path=${encodeURIComponent(svg)}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('/proxy refuses cross-site and navigation requests before fetching', async () => {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    // Raw http.get: undici's fetch overwrites sec-fetch-mode.
    const hit = (headers: Record<string, string>) => new Promise<{ status: number; headers: { get: (k: string) => string | null } }>((resolve, reject) => {
      httpGet(`http://127.0.0.1:${port}/proxy?url=${encodeURIComponent('http://127.0.0.1:1/x')}`, { headers }, (r) => {
        r.resume();
        resolve({ status: r.statusCode ?? 0, headers: { get: (k) => (r.headers[k] as string | undefined) ?? null } });
      }).on('error', reject);
    });
    try {
      expect((await hit({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await hit({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
      expect((await hit({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' })).status).toBe(403);
      // Same-origin fetch passes the site gate; loopback is blocked as SSRF (public-only).
      const ok = await hit({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });
      expect(ok.status).toBe(400);
      expect(ok.headers.get('content-security-policy')).toBe('sandbox');
    } finally {
      server.close();
    }
  });

  it('403s a symlink that escapes ATT_ROOT', async () => {
    const secret = join(scratch, 'secret.txt');
    writeFileSync(secret, 'classified');
    const link = join(dataDir, 'attachments', conv, 'escape.gz');
    symlinkSync(secret, link);
    const res = await get(`/files?path=${encodeURIComponent(link)}`);
    expect(res.status).toBe(403);
  });

  it('still denies the retention archive', async () => {
    mkdirSync(join(dataDir, 'archive'), { recursive: true });
    const archived = join(dataDir, 'archive', 'conv-1.md');
    writeFileSync(archived, '# archived');
    const res = await get(`/files?path=${encodeURIComponent(archived)}`);
    expect(res.status).toBe(403);
  });

  it('resolves a bare display name via conversation attachment files payload', async () => {
    const project = createProject(db, { name: 'AttRel', rootPath: scratch });
    const convo = createConversation(db, { projectId: project.id, title: 'att-rel' });
    mkdirSync(join(dataDir, 'attachments', convo.id), { recursive: true });
    const shard = join(dataDir, 'attachments', convo.id, 'deadbeef.txt');
    writeFileSync(shard, 'hello-att');
    createSession(db, { id: 'sess-att', conversationId: convo.id });
    appendEvent(db, {
      sessionId: 'sess-att',
      type: 'message',
      sender: 'agent',
      seq: 1,
      payload: {
        chunk: '📎 test-file.txt',
        final: true,
        files: [{
          name: 'test-file.txt',
          mediaType: 'text/plain',
          status: 'ok',
          size: 9,
          path: shard,
        }],
      },
    });
    const res = await get(
      `/files?path=${encodeURIComponent('test-file.txt')}&conversationId=${encodeURIComponent(convo.id)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello-att');
  });
});


describe('GET /files/list', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;
  let outside: string;
  let workdir: string;
  let dataDir: string;
  let projectId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-files-list-'));
    outside = mkdtempSync(join(tmpdir(), 'tierwyn-files-list-out-'));
    workdir = mkdtempSync(join(tmpdir(), 'tierwyn-files-list-wt-'));
    dataDir = join(scratch, 'data');
    mkdirSync(join(scratch, 'src'), { recursive: true });
    writeFileSync(join(scratch, 'src', 'a.ts'), 'export {};');
    writeFileSync(join(scratch, 'src', 'B.md'), '# B');
    writeFileSync(join(scratch, 'README.md'), '# readme');
    writeFileSync(join(scratch, '.env'), 'X=1');
    writeFileSync(join(scratch, '.hidden.txt'), 'h');
    writeFileSync(join(scratch, 'Makefile'), 'all:');
    mkdirSync(join(scratch, '.git'), { recursive: true });
    writeFileSync(join(scratch, '.git', 'HEAD'), 'ref: refs/heads/main');
    mkdirSync(join(dataDir, 'archive'), { recursive: true });
    writeFileSync(join(dataDir, 'archive', 'x.jsonl'), '{}');
    writeFileSync(join(outside, 'secret.md'), '# secret');
    symlinkSync(outside, join(scratch, 'escape'));
    symlinkSync(join(scratch, 'src'), join(scratch, 'inner-link'));
    writeFileSync(join(workdir, 'a.md'), '# worktree');
    projectId = createProject(db, { name: 'Scratch', rootPath: scratch }).id;
    app = express();
    app.use(express.json());
    registerFileRoutes(app, () => db, { dataDir });
  });

  afterEach(() => {
    for (const d of [scratch, outside, workdir]) rmSync(d, { recursive: true, force: true });
    db.close();
  });

  async function get(path: string): Promise<{ status: number; body: any }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await r.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* raw */ }
      return { status: r.status, body };
    } finally {
      server.close();
    }
  }
  const list = (p?: string, id = projectId) =>
    get(`/files/list?projectId=${id}${p === undefined ? '' : `&path=${encodeURIComponent(p)}`}`);
  const entry = (body: any, name: string) => body.entries.find((e: any) => e.name === name);

  it('lists the root: no .git, dirs first, secret/Makefile not openable', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('');
    expect(res.body.root).toBe(scratch);
    const names = res.body.entries.map((e: any) => e.name);
    expect(names).not.toContain('.git');
    const kinds = res.body.entries.map((e: any) => e.kind);
    expect(kinds.lastIndexOf('dir')).toBeLessThan(kinds.indexOf('file'));
    expect(entry(res.body, '.env').openable).toBe(false);
    expect(entry(res.body, 'README.md').openable).toBe(true);
    expect(entry(res.body, 'Makefile').openable).toBe(false);
    expect(entry(res.body, '.hidden.txt')).toBeTruthy();
    expect(res.body.truncated).toBe(false);
  });

  it('lists a subdir case-insensitively sorted and normalises the path', async () => {
    for (const p of ['src', 'src/', './src']) {
      const res = await list(p);
      expect(res.status).toBe(200);
      expect(res.body.path).toBe('src');
      expect(res.body.entries.map((e: any) => e.name)).toEqual(['a.ts', 'B.md']);
    }
  });

  it('rejects escapes with 403', async () => {
    for (const p of ['..', '../', 'src/../../', 'escape', 'escape/']) {
      expect((await list(p)).status, p).toBe(403);
    }
  });

  it('rejects absolute, home and NUL paths with 400', async () => {
    for (const p of ['/etc', '~/', '\0']) {
      expect((await list(p)).status, JSON.stringify(p)).toBe(400);
    }
  });

  it('denies .git and data/archive', async () => {
    expect((await list('.git')).status).toBe(403);
    expect((await list('data/archive')).status).toBe(403);
  });

  it('400 for a file, 404 for a missing dir', async () => {
    const f = await list('README.md');
    expect(f.status).toBe(400);
    expect(f.body.error).toBe('not a directory');
    expect((await list('nope')).status).toBe(404);
  });

  it('400 without context, 404 for unknown ids', async () => {
    expect((await get('/files/list?path=')).status).toBe(400);
    expect((await list('', 'nope')).status).toBe(404);
    expect((await get('/files/list?conversationId=nope')).status).toBe(404);
  });

  it('lists a sibling worktree root for a conversation and GET /files serves it relatively', async () => {
    const convo = createConversation(db, { projectId, title: 'wt', workdirPath: workdir });
    const res = await get(`/files/list?conversationId=${convo.id}`);
    expect(res.status).toBe(200);
    expect(res.body.root).toBe(workdir);
    expect(res.body.entries.map((e: any) => e.name)).toEqual(['a.md']);
    const file = await get(`/files?path=a.md&conversationId=${convo.id}`);
    expect(file.status).toBe(200);
  });

  it('follows an in-root symlinked dir', async () => {
    const root = await list();
    expect(entry(root.body, 'inner-link')).toMatchObject({ kind: 'dir', symlink: true });
    expect((await list('inner-link')).status).toBe(200);
  });

  it('lists the root of a project registered with a trailing slash', async () => {
    const id = createProject(db, { name: 'Slash', rootPath: `${scratch}/` }).id;
    const res = await list(undefined, id);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('');
  });

  // Root ignores mode 000, so this check only means something for non-root users.
  it.skipIf(process.getuid?.() === 0)('403s an unreadable folder and still lists its parent', async () => {
    const locked = join(scratch, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const parent = await list();
      expect(parent.status).toBe(200);
      expect(entry(parent.body, 'locked')).toMatchObject({ kind: 'dir' });
      const res = await list('locked');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('cannot read directory');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('remote-host project list and relative read 503 without nodeHub before hub fs', async () => {
    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    const remote = createProject(db, { name: 'remote', rootPath: scratch, remoteHostId: host.id });
    const convo = createConversation(db, { projectId: remote.id, title: 'rc' });
    const listRes = await list(undefined, remote.id);
    expect(listRes.status).toBe(503);
    expect(listRes.body).toEqual({ error: 'remote host not connected' });
    const readRes = await get(`/files?path=README.md&conversationId=${convo.id}`);
    expect(readRes.status).toBe(503);
    expect(readRes.body).toEqual({ error: 'remote host not connected' });
  });

  // Remote-only root outside tmpdir/home-subdirs: sharing `scratch` would stay
  // allow-listed via the local Scratch project; dispatch must happen before any
  // hub fs access.
  it('does not serve or git-restore hub files via a remote project root allow-list', async () => {
    const remoteRoot = mkdtempSync(join(homedir(), 'tierwyn-t15-m1-'));
    try {
      execFileSync('git', ['init'], { cwd: remoteRoot });
      const readme = join(remoteRoot, 'README.md');
      writeFileSync(readme, 'hub copy must not be served');
      const host = createPendingHost(db, 'box-abs', 'h-abs', Date.now() + 60_000);
      const remote = createProject(db, { name: 'remote-abs', rootPath: remoteRoot, remoteHostId: host.id });
      const convo = createConversation(db, { projectId: remote.id, title: 'rc-abs' });

      const readRes = await get(
        `/files?path=${encodeURIComponent(readme)}&conversationId=${convo.id}`,
      );
      expect(readRes.status).toBe(503);
      expect(String(readRes.body)).not.toContain('hub copy must not be served');

      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;
      let restoreStatus = 0;
      try {
        const restoreRes = await fetch(`http://127.0.0.1:${port}/files/git-restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: readme, conversationId: convo.id }),
        });
        restoreStatus = restoreRes.status;
      } finally {
        server.close();
      }
      expect(restoreStatus).toBe(503);
      expect(existsSync(readme)).toBe(true);
    } finally {
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it('caps at 2000 entries', async () => {
    mkdirSync(join(scratch, 'many'));
    for (let i = 0; i < 2001; i++) writeFileSync(join(scratch, 'many', `f${i}.txt`), '');
    const res = await list('many');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2000);
    expect(res.body.truncated).toBe(true);
  });

  it('treats * and ? in date template filenames literally rather than as regex quantifiers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-date-tpl-'));
    try {
      writeFileSync(join(dir, 'report-2026-01-01.txt'), 'wrong');
      writeFileSync(join(dir, 'report*-2026-01-01.txt'), 'right');
      const found = await resolveDateTemplatePath(dir, 'report*-YYYY-MM-DD.txt');
      expect(found).toBe(join(dir, 'report*-2026-01-01.txt'));

      const noWildcardMatch = await resolveDateTemplatePath(dir, 'repor?*-YYYY-MM-DD.txt');
      expect(noWildcardMatch).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
