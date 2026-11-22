import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { backupsDirFor, listBackups, type BackupEntry, type CreateBackupResult } from '../repositories/backups.js';
import {
  BACKUP_RUNNING_ERROR, INVALID_NAME_ERROR, NO_SUCH_BACKUP_ERROR,
  registerBackupRoutes, type BackupRoutesOptions,
} from './backups.js';

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

/** File-backed DB + express app wired to the real registrar (D13). */
function boot(extra: Partial<BackupRoutesOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tierwyn-backup-http-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'tierwyn.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < 20; i++) ins.run(`row-${i}`);

  const app = express();
  app.use(express.json());
  registerBackupRoutes(app, {
    getDb: () => db,
    dbPath,
    dataDir: dir,
    now: () => Date.UTC(2026, 7, 24, 9, 5, 3),
    getFreeBytes: () => 10_000_000_000,
    ...extra,
  });
  return { db, app, dir, dbPath };
}

function seedBackupFile(dataDir: string, name: string, mtimeSec: number, body = 'x'): void {
  const d = backupsDirFor(dataDir);
  mkdirSync(d, { recursive: true });
  const p = join(d, name);
  writeFileSync(p, body);
  utimesSync(p, mtimeSec, mtimeSec);
}

/** Same listen-on-port-0 harness as settings.retention.restore.test.ts. */
function raw(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; headers: Headers; text: string; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (r) => {
          const buf = new Uint8Array(await r.arrayBuffer());
          return {
            status: r.status,
            headers: r.headers,
            text: new TextDecoder().decode(buf),
            bytes: buf,
          };
        })
        .then((out) => { server.close(); resolve(out); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

async function json(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const r = await raw(app, method, path, body);
  let parsed: unknown = r.text;
  try { parsed = JSON.parse(r.text); } catch { /* keep text */ }
  return { status: r.status, body: parsed };
}

describe('POST /settings/backup', () => {
  it('writes a timestamped .db and returns the entry (D1)', async () => {
    const { app, dir, db } = boot();
    const res = await json(app, 'POST', '/settings/backup', {});
    expect(res.status).toBe(200);
    const { backup, rotated } = res.body as { backup: BackupEntry; rotated: string[] };
    expect(backup.name).toBe('tierwyn-20260824-090503.db');
    expect(backup.kind).toBe('db');
    expect(backup.bytes).toBeGreaterThan(0);
    expect(rotated).toEqual([]);
    expect(existsSync(join(backupsDirFor(dir), backup.name))).toBe(true);
    db.close();
  });

  it('ignores a non-boolean / absent includeAudio and stays db-only (D8)', async () => {
    const { app, db } = boot();
    const res = await json(app, 'POST', '/settings/backup', { includeAudio: 'yes' });
    expect(res.status).toBe(200);
    expect((res.body as { backup: BackupEntry }).backup.kind).toBe('db');
    db.close();
  });

  it('returns 507 with the exact disk-guard message when space is short (D5)', async () => {
    const { app, dir, db } = boot({ getFreeBytes: () => 1 });
    const res = await json(app, 'POST', '/settings/backup', {});
    expect(res.status).toBe(507);
    expect(res.body).toEqual({ error: 'not enough free disk space for a backup' });
    expect(listBackups(dir)).toEqual([]);
    db.close();
  });

  it('returns 409 while another backup is in flight and recovers afterwards (D7)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fake: CreateBackupResult = {
      ok: true,
      entry: { name: 'tierwyn-20260824-090503.db', bytes: 1, createdAt: 1, kind: 'db' },
      rotated: [],
    };
    const { app, db } = boot({
      runBackup: async () => { await gate; return fake; },
    });

    const first = json(app, 'POST', '/settings/backup', {});
    await new Promise((r) => setTimeout(r, 30)); // let the first handler enter the flag
    const second = await json(app, 'POST', '/settings/backup', {});
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: BACKUP_RUNNING_ERROR });

    release();
    expect((await first).status).toBe(200);

    const third = await json(app, 'POST', '/settings/backup', {});
    expect(third.status).toBe(200); // the flag was cleared in finally
    db.close();
  });

  it('returns 500 and clears the in-flight flag when the backup throws (D7)', async () => {
    const { app, db } = boot({
      runBackup: async () => { throw new Error('boom'); },
    });
    const res = await json(app, 'POST', '/settings/backup', {});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'backup failed: boom' });

    const again = await json(app, 'POST', '/settings/backup', {});
    expect(again.status).toBe(500); // not 409 — the flag reset
    db.close();
  });

  it('rotates the pool to 10 including the new file (D6)', async () => {
    const { app, dir, db } = boot();
    for (let i = 1; i <= 12; i++) {
      seedBackupFile(dir, `tierwyn-20260101-0000${String(i).padStart(2, '0')}.db`, 1_600_000_000 + i);
    }
    const res = await json(app, 'POST', '/settings/backup', {});
    expect(res.status).toBe(200);
    const names = listBackups(dir).map((e) => e.name);
    expect(names).toHaveLength(10);
    expect(names).toContain('tierwyn-20260824-090503.db');
    expect(names).not.toContain('tierwyn-20260101-000001.db');
    db.close();
  });

  it('produces a -full.tar over HTTP when includeAudio is exactly true (D8)', async () => {
    const { app, dir, db } = boot();
    mkdirSync(join(dir, 'tts-recordings'), { recursive: true });
    writeFileSync(join(dir, 'tts-recordings', 'a.wav'), 'AAAA');

    const res = await json(app, 'POST', '/settings/backup', { includeAudio: true });
    expect(res.status).toBe(200);
    const { backup } = res.body as { backup: BackupEntry };
    expect(backup.name).toBe('tierwyn-20260824-090503-full.tar');
    expect(backup.kind).toBe('full');
    expect(existsSync(join(backupsDirFor(dir), backup.name))).toBe(true);
    expect(existsSync(join(backupsDirFor(dir), 'tierwyn-20260824-090503.db'))).toBe(false);
    db.close();
  });
});

describe('GET /settings/backups', () => {
  it('returns an empty list and zero audio before anything exists (D1/D10)', async () => {
    const { app, db } = boot();
    const res = await json(app, 'GET', '/settings/backups');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], audioBytes: 0, audioFiles: 0 });
    db.close();
  });

  it('lists newest first with audio totals from tts-recordings (D10)', async () => {
    const { app, dir, db } = boot();
    seedBackupFile(dir, 'tierwyn-20260824-090501.db', 1_700_000_001);
    seedBackupFile(dir, 'tierwyn-20260824-090502-full.tar', 1_700_000_002);
    mkdirSync(join(dir, 'tts-recordings'), { recursive: true });
    writeFileSync(join(dir, 'tts-recordings', 'a.wav'), 'aaaa');

    const res = await json(app, 'GET', '/settings/backups');
    expect(res.status).toBe(200);
    const out = res.body as { items: BackupEntry[]; audioBytes: number; audioFiles: number };
    expect(out.items.map((i) => i.name)).toEqual([
      'tierwyn-20260824-090502-full.tar',
      'tierwyn-20260824-090501.db',
    ]);
    expect(out.audioBytes).toBe(4);
    expect(out.audioFiles).toBe(1);
    db.close();
  });
});

describe('GET /settings/backups/:name/download', () => {
  it('streams the bytes with attachment headers (D11)', async () => {
    const { app, dir, db } = boot();
    seedBackupFile(dir, 'tierwyn-20260824-090501.db', 1_700_000_001, 'SQLITE-BYTES');

    const r = await raw(app, 'GET', '/settings/backups/tierwyn-20260824-090501.db/download');
    expect(r.status).toBe(200);
    expect(r.text).toBe('SQLITE-BYTES');
    expect(r.headers.get('content-type')).toBe('application/x-sqlite3');
    expect(r.headers.get('content-disposition'))
      .toBe('attachment; filename="tierwyn-20260824-090501.db"');
    expect(r.headers.get('content-length')).toBe('12');
    expect(r.headers.get('cache-control')).toBe('no-store');
    db.close();
  });

  it('uses the tar content type for a full backup (D11)', async () => {
    const { app, dir, db } = boot();
    seedBackupFile(dir, 'tierwyn-20260824-090502-full.tar', 1_700_000_002, 'TARBYTES');
    const r = await raw(app, 'GET', '/settings/backups/tierwyn-20260824-090502-full.tar/download');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/x-tar');
    db.close();
  });

  it('rejects path traversal with 400 and never reads outside the backups dir (D2)', async () => {
    const { app, db } = boot();
    for (const encoded of [
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '%2e%2e%2ftierwyn.db',
      // Raw `..` is omitted: fetch/WHATWG resolves `/settings/backups/../download`
      // to `/settings/download` (404) before Express sees the segment. Encoded
      // `%2e%2e%2f…` still arrives as `../…` and is 400'd by the regex (D2).
      '%2fetc%2fpasswd',
      'tierwyn.db',
      'tierwyn-20260824-090503.db%00',
    ]) {
      const res = await json(app, 'GET', `/settings/backups/${encoded}/download`);
      expect(res.status, encoded).toBe(400);
      expect(res.body, encoded).toEqual({ error: INVALID_NAME_ERROR });
    }
    db.close();
  });

  it('does not crash the process when the file is unreadable after stat', async () => {
    if (process.getuid?.() === 0) return;
    const { app, dir, db } = boot();
    const name = 'tierwyn-20260824-090501.db';
    seedBackupFile(dir, name, 1_700_000_001, 'SQLITE-BYTES');
    chmodSync(join(backupsDirFor(dir), name), 0o000);

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    try {
      await raw(app, 'GET', `/settings/backups/${name}/download`).catch(() => { /* aborted / empty is fine */ });
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('uncaughtException', onUnhandled);
      process.off('unhandledRejection', onUnhandled);
      chmodSync(join(backupsDirFor(dir), name), 0o600);
      db.close();
    }
  });

  it('returns 404 for a well-formed name that is not on disk', async () => {
    const { app, db } = boot();
    const res = await json(app, 'GET', '/settings/backups/tierwyn-20260824-090509.db/download');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NO_SUCH_BACKUP_ERROR });
    db.close();
  });
});

describe('DELETE /settings/backups/:name', () => {
  it('deletes the file and 404s the second time', async () => {
    const { app, dir, db } = boot();
    seedBackupFile(dir, 'tierwyn-20260824-090501.db', 1_700_000_001);

    const first = await json(app, 'DELETE', '/settings/backups/tierwyn-20260824-090501.db');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ deleted: 1 });
    expect(existsSync(join(backupsDirFor(dir), 'tierwyn-20260824-090501.db'))).toBe(false);

    const second = await json(app, 'DELETE', '/settings/backups/tierwyn-20260824-090501.db');
    expect(second.status).toBe(404);
    expect(second.body).toEqual({ error: NO_SUCH_BACKUP_ERROR });
    db.close();
  });

  it('rejects an unsafe name with 400 (D2)', async () => {
    const { app, db } = boot();
    const res = await json(app, 'DELETE', '/settings/backups/%2e%2e%2ftierwyn.db');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVALID_NAME_ERROR });
    db.close();
  });
});
