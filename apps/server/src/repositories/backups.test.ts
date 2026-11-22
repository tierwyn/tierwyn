import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BACKUP_KEEP,
  BACKUP_NAME_RE,
  DISK_GUARD_ERROR,
  audioDirStats,
  backupFileName,
  backupsDirFor,
  createBackup,
  deleteBackup,
  freeBytesFor,
  isSafeBackupName,
  listBackups,
  resolveBackupPath,
  rotateBackups,
} from './backups.js';

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

/** File-backed source DB in a temp dir (D4/D13 — never `:memory:`, never the live DB). */
function boot(rows = 50) {
  const dir = mkdtempSync(join(tmpdir(), 'tierwyn-backup-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'tierwyn.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < rows; i++) ins.run(`row-${i}`);
  return { dir, dbPath, db };
}

/** Write a plausible-looking file into the backups dir with an explicit mtime. */
function seedBackupFile(dataDir: string, name: string, mtimeSec: number, body = 'x'): void {
  const dir = backupsDirFor(dataDir);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  utimesSync(p, mtimeSec, mtimeSec);
}

describe('backup filenames (D2)', () => {
  it('formats the timestamp in UTC and matches the one governing regex', () => {
    const t = Date.UTC(2026, 7, 24, 9, 5, 3); // 2026-08-24T09:05:03Z
    expect(backupFileName(t, 'db')).toBe('tierwyn-20260824-090503.db');
    expect(backupFileName(t, 'full')).toBe('tierwyn-20260824-090503-full.tar');
    expect(BACKUP_NAME_RE.test(backupFileName(t, 'db'))).toBe(true);
    expect(BACKUP_NAME_RE.test(backupFileName(t, 'full'))).toBe(true);
  });

  it('pads single-digit month/day/time components', () => {
    expect(backupFileName(Date.UTC(2026, 0, 2, 3, 4, 5), 'db')).toBe('tierwyn-20260102-030405.db');
  });
});

describe('isSafeBackupName / resolveBackupPath (D2)', () => {
  const good = 'tierwyn-20260824-090503.db';

  it('accepts only the two generated shapes', () => {
    expect(isSafeBackupName(good)).toBe(true);
    expect(isSafeBackupName('tierwyn-20260824-090503-full.tar')).toBe(true);
  });

  it('rejects traversal, absolute paths, NUL, and anything off-shape', () => {
    for (const bad of [
      '..',
      '../tierwyn-20260824-090503.db',
      '../../etc/passwd',
      'tierwyn-20260824-090503.db/../../etc/passwd',
      '/etc/passwd',
      'tierwyn-20260824-090503.db\0',
      'tierwyn-20260824-090503.db.txt',
      'tierwyn-2026-08-24.db',
      'tierwyn-20260824-090503.sqlite',
      'tierwyn-20260824-090503-full.db',
      'notes.txt',
      '',
      'TIERWYN-20260824-090503.DB',
    ]) {
      expect(isSafeBackupName(bad), bad).toBe(false);
    }
    expect(isSafeBackupName(undefined)).toBe(false);
    expect(isSafeBackupName(42)).toBe(false);
  });

  it('resolves a safe name inside the backups dir and null for everything else', () => {
    const dataDir = '/tmp/tierwyn-data';
    expect(resolveBackupPath(dataDir, good)).toBe(join(backupsDirFor(dataDir), good));
    expect(resolveBackupPath(dataDir, '../../etc/passwd')).toBeNull();
    expect(resolveBackupPath(dataDir, '/etc/passwd')).toBeNull();
  });

  it('puts the backups dir next to the DB file (D3)', () => {
    expect(backupsDirFor('/srv/tierwyn/data')).toBe('/srv/tierwyn/data/backups');
  });
});

describe('listBackups (D1/D6)', () => {
  it('returns [] when the directory does not exist yet', () => {
    const { dir } = boot(1);
    expect(listBackups(dir)).toEqual([]);
  });

  it('lists matching files newest-first, tags kind, and ignores foreign files', () => {
    const { dir } = boot(1);
    seedBackupFile(dir, 'tierwyn-20260824-090501.db', 1_700_000_001);
    seedBackupFile(dir, 'tierwyn-20260824-090502-full.tar', 1_700_000_002);
    seedBackupFile(dir, 'notes.txt', 1_700_000_003);
    seedBackupFile(dir, 'tierwyn-bad-name.db', 1_700_000_004);

    const items = listBackups(dir);
    expect(items.map((i) => i.name)).toEqual([
      'tierwyn-20260824-090502-full.tar',
      'tierwyn-20260824-090501.db',
    ]);
    expect(items[0].kind).toBe('full');
    expect(items[1].kind).toBe('db');
    expect(items[0].bytes).toBeGreaterThan(0);
    expect(items[0].createdAt).toBeGreaterThan(items[1].createdAt);
  });
});

describe('deleteBackup (D1)', () => {
  it('deletes a real file, reports not_found twice, and refuses unsafe names', () => {
    const { dir } = boot(1);
    seedBackupFile(dir, 'tierwyn-20260824-090501.db', 1_700_000_001);

    expect(deleteBackup(dir, 'tierwyn-20260824-090501.db')).toBe('ok');
    expect(existsSync(join(backupsDirFor(dir), 'tierwyn-20260824-090501.db'))).toBe(false);
    expect(deleteBackup(dir, 'tierwyn-20260824-090501.db')).toBe('not_found');
    expect(deleteBackup(dir, '../../etc/passwd')).toBe('invalid');
  });
});

describe('audioDirStats (D10)', () => {
  it('counts tts-recordings files by stat only', () => {
    const { dir } = boot(1);
    expect(audioDirStats(dir)).toEqual({ audioBytes: 0, audioFiles: 0 });

    mkdirSync(join(dir, 'tts-recordings'), { recursive: true });
    writeFileSync(join(dir, 'tts-recordings', 'a.wav'), 'aaaa');
    writeFileSync(join(dir, 'tts-recordings', 'b.wav'), 'bb');
    expect(audioDirStats(dir)).toEqual({ audioBytes: 6, audioFiles: 2 });
  });
});

describe('rotateBackups (D6)', () => {
  it('keeps the newest N, never deletes keepName, never touches foreign files', () => {
    const { dir } = boot(1);
    for (let i = 1; i <= 12; i++) {
      const stamp = `tierwyn-20260824-0905${String(i).padStart(2, '0')}.db`;
      seedBackupFile(dir, stamp, 1_700_000_000 + i);
    }
    seedBackupFile(dir, 'notes.txt', 1_700_000_000);

    const removed = rotateBackups(dir, BACKUP_KEEP, 'tierwyn-20260824-090512.db');
    expect(removed.sort()).toEqual([
      'tierwyn-20260824-090501.db',
      'tierwyn-20260824-090502.db',
    ]);
    expect(listBackups(dir)).toHaveLength(10);
    expect(readdirSync(backupsDirFor(dir))).toContain('notes.txt');
  });

  it('never deletes the file just created even when it is the oldest', () => {
    const { dir } = boot(1);
    seedBackupFile(dir, 'tierwyn-20260824-090501.db', 1_700_000_001); // oldest = the new one
    for (let i = 2; i <= 12; i++) {
      seedBackupFile(dir, `tierwyn-20260824-0905${String(i).padStart(2, '0')}.db`, 1_700_000_000 + i);
    }

    const removed = rotateBackups(dir, BACKUP_KEEP, 'tierwyn-20260824-090501.db');
    expect(removed).not.toContain('tierwyn-20260824-090501.db');
    expect(existsSync(join(backupsDirFor(dir), 'tierwyn-20260824-090501.db'))).toBe(true);
    expect(listBackups(dir)).toHaveLength(11); // 10 kept + the protected new file
  });

  it('is a no-op below the keep threshold', () => {
    const { dir } = boot(1);
    seedBackupFile(dir, 'tierwyn-20260824-090501.db', 1_700_000_001);
    expect(rotateBackups(dir, BACKUP_KEEP, 'tierwyn-20260824-090501.db')).toEqual([]);
  });
});

describe('createBackup — db only (D4/D5/D6)', () => {
  it('writes a timestamped .db that opens read-only with the source rows', async () => {
    const { dir, dbPath, db } = boot(50);

    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: false,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 10_000_000_000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.name).toBe('tierwyn-20260824-090503.db');
    expect(res.entry.kind).toBe('db');
    expect(res.entry.bytes).toBeGreaterThan(0);
    expect(res.rotated).toEqual([]);

    const abs = join(backupsDirFor(dir), res.entry.name);
    expect(existsSync(abs)).toBe(true);

    const copy = new Database(abs, { readonly: true });
    const n = (copy.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    expect(n).toBe(50);
    expect((copy.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string }).v).toBe('row-0');
    copy.close();
    db.close();
  });

  it('bumps the timestamp by a second when the name is already taken (D2)', async () => {
    const { dir, dbPath, db } = boot(1);
    const now = Date.UTC(2026, 7, 24, 9, 5, 3);
    seedBackupFile(dir, 'tierwyn-20260824-090503.db', 1_700_000_001);

    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: false, now, getFreeBytes: () => 10_000_000_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.name).toBe('tierwyn-20260824-090504.db');
    db.close();
  });

  it('refuses and writes nothing when free space is below 2x the DB size (D5)', async () => {
    const { dir, dbPath, db } = boot(50);

    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: false,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 1,
    });

    expect(res).toEqual({ ok: false, code: 'disk', message: DISK_GUARD_ERROR });
    expect(listBackups(dir)).toEqual([]);
    db.close();
  });

  it('rotates the pool down to 10 after a successful write (D6)', async () => {
    const { dir, dbPath, db } = boot(1);
    for (let i = 1; i <= 12; i++) {
      seedBackupFile(dir, `tierwyn-20260101-0000${String(i).padStart(2, '0')}.db`, 1_600_000_000 + i);
    }

    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: false,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 10_000_000_000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const names = listBackups(dir).map((i) => i.name);
    expect(names).toHaveLength(10);
    expect(names).toContain('tierwyn-20260824-090503.db');
    expect(names).not.toContain('tierwyn-20260101-000001.db');
    expect(names).not.toContain('tierwyn-20260101-000002.db');
    expect(names).not.toContain('tierwyn-20260101-000003.db');
    db.close();
  });
});

describe('createBackup — includeAudio (D8/D9)', () => {
  /** Entry names inside a tar, as GNU tar reports them. */
  function tarEntries(tarPath: string): string[] {
    return execFileSync('/usr/bin/tar', ['-tf', tarPath], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
  }

  it('bundles the .db plus tts-recordings and deletes the intermediate .db', async () => {
    const { dir, dbPath, db } = boot(20);
    mkdirSync(join(dir, 'tts-recordings'), { recursive: true });
    writeFileSync(join(dir, 'tts-recordings', 'a.wav'), 'AAAA');
    writeFileSync(join(dir, 'tts-recordings', 'b.wav'), 'BB');

    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: true,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 10_000_000_000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.name).toBe('tierwyn-20260824-090503-full.tar');
    expect(res.entry.kind).toBe('full');

    const tarPath = join(backupsDirFor(dir), res.entry.name);
    expect(tarEntries(tarPath)).toEqual([
      'tierwyn-20260824-090503.db',
      'tts-recordings/',
      'tts-recordings/a.wav',
      'tts-recordings/b.wav',
    ]);

    // The intermediate .db is gone — the pool only lists the tar.
    expect(existsSync(join(backupsDirFor(dir), 'tierwyn-20260824-090503.db'))).toBe(false);
    expect(listBackups(dir).map((e) => e.name)).toEqual(['tierwyn-20260824-090503-full.tar']);
    db.close();
  });

  it('still produces a tar containing just the .db when tts-recordings is missing', async () => {
    const { dir, dbPath, db } = boot(5);

    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: true,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 10_000_000_000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.kind).toBe('full');
    expect(tarEntries(join(backupsDirFor(dir), res.entry.name)))
      .toEqual(['tierwyn-20260824-090503.db']);
    db.close();
  });

  it('the extracted .db is a real openable database', async () => {
    const { dir, dbPath, db } = boot(7);
    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: true,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 10_000_000_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const out = join(dir, 'extracted');
    mkdirSync(out, { recursive: true });
    execFileSync('tar', ['-xf', join(backupsDirFor(dir), res.entry.name), '-C', out]);

    const copy = new Database(join(out, 'tierwyn-20260824-090503.db'), { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(7);
    copy.close();
    db.close();
  });

  it('counts audio bytes in the disk guard when includeAudio is true (D5)', async () => {
    const { dir, dbPath, db } = boot(5);
    mkdirSync(join(dir, 'tts-recordings'), { recursive: true });
    writeFileSync(join(dir, 'tts-recordings', 'big.wav'), 'x'.repeat(50_000));

    // Enough room for the DB alone, nowhere near enough once 50 KB of audio counts.
    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: true,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 60_000,
    });

    expect(res).toEqual({ ok: false, code: 'disk', message: DISK_GUARD_ERROR });
    expect(listBackups(dir)).toEqual([]);
    db.close();
  });

  it('rotates a mixed .db / -full.tar pool as one list of 10 (D6)', async () => {
    const { dir, dbPath, db } = boot(2);
    for (let i = 1; i <= 6; i++) {
      seedBackupFile(dir, `tierwyn-20260101-0000${String(i).padStart(2, '0')}.db`, 1_600_000_000 + i);
    }
    for (let i = 7; i <= 12; i++) {
      seedBackupFile(dir, `tierwyn-20260101-0000${String(i).padStart(2, '0')}-full.tar`, 1_600_000_000 + i);
    }

    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: true,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 10_000_000_000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const names = listBackups(dir).map((e) => e.name);
    expect(names).toHaveLength(10);
    expect(names).toContain('tierwyn-20260824-090503-full.tar');
    expect(names).not.toContain('tierwyn-20260101-000001.db');
    expect(names).not.toContain('tierwyn-20260101-000002.db');
    expect(names).not.toContain('tierwyn-20260101-000003.db');
    db.close();
  });

  it('keeps the tar and drops only the intermediate .db when tar exits 1', async () => {
    const { dir, dbPath, db } = boot(5);
    mkdirSync(join(dir, 'tts-recordings'), { recursive: true });
    writeFileSync(join(dir, 'tts-recordings', 'a.wav'), 'AAAA');

    // PATH shim: real GNU tar, then exit 1 (file-changed-as-we-read warning).
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tar'), '#!/bin/sh\n/usr/bin/tar "$@"\nexit 1\n', { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev ?? ''}`;
    try {
      const res = await createBackup({
        db, dbPath, dataDir: dir, includeAudio: true,
        now: Date.UTC(2026, 7, 24, 9, 5, 3),
        getFreeBytes: () => 10_000_000_000,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.entry.kind).toBe('full');
      expect(existsSync(join(backupsDirFor(dir), 'tierwyn-20260824-090503.db'))).toBe(false);
      expect(tarEntries(join(backupsDirFor(dir), res.entry.name))).toContain('tierwyn-20260824-090503.db');
    } finally {
      process.env.PATH = prev;
      db.close();
    }
  });

  it('leaves no partial artefacts when tar fails', async () => {
    // root can read anything, so the failure cannot be staged there.
    if (process.getuid?.() === 0) return;
    const { dir, dbPath, db } = boot(3);
    // An unreadable member makes GNU tar print an error and exit non-zero.
    mkdirSync(join(dir, 'tts-recordings'), { recursive: true });
    const locked = join(dir, 'tts-recordings', 'locked.wav');
    writeFileSync(locked, 'AAAA');
    chmodSync(locked, 0o000);

    const res = await createBackup({
      db, dbPath, dataDir: dir, includeAudio: true,
      now: Date.UTC(2026, 7, 24, 9, 5, 3),
      getFreeBytes: () => 10_000_000_000,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('failed');
    expect(res.message).toMatch(/^backup failed: /);
    // Neither the intermediate .db nor a listable tar survives.
    expect(existsSync(join(backupsDirFor(dir), 'tierwyn-20260824-090503.db'))).toBe(false);
    expect(listBackups(dir)).toEqual([]);
    chmodSync(locked, 0o600); // so the afterEach rmSync can clean up
    db.close();
  });
});

describe('freeBytesFor (D5 / F7)', () => {
  it('reports a finite positive free-space number on a real directory', () => {
    const { dir, db } = boot(1);
    mkdirSync(backupsDirFor(dir), { recursive: true });
    const free = freeBytesFor(backupsDirFor(dir));
    expect(free).toBeGreaterThan(0);
    expect(free).toBeLessThan(Number.MAX_SAFE_INTEGER);
    db.close();
  });
});
