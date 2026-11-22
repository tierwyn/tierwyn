import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { openAgentSqliteReadonly } from './agentSqlite.js';

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-agent-sqlite-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function walFixture(dir: string): string {
  const path = join(dir, 'store.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, b BLOB)');
  db.prepare('INSERT INTO t (id, name, b) VALUES (?, ?, ?)').run(1, 'alpha', Buffer.from('x'));
  db.prepare('INSERT INTO t (id, name, b) VALUES (?, ?, ?)').run(2, 'beta', Buffer.from('y'));
  db.close();
  return path;
}

describe('openAgentSqliteReadonly', () => {
  it('reads rows through prepare().get and .all', () => {
    const path = walFixture(tmp());
    const db = openAgentSqliteReadonly(path);
    try {
      const one = db.prepare('SELECT name FROM t WHERE id = ?').get(1) as { name: string };
      expect(one.name).toBe('alpha');
      const rows = db.prepare('SELECT id FROM t ORDER BY id').all() as { id: number }[];
      expect(rows.map((r) => r.id)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });

  it('rejects writes', () => {
    const path = walFixture(tmp());
    const db = openAgentSqliteReadonly(path);
    try {
      expect(() => db.prepare('INSERT INTO t (id, name) VALUES (3, \'gamma\')').all()).toThrow();
    } finally {
      db.close();
    }
  });

  it('throws on a missing file and does not create it', () => {
    const missing = join(tmp(), 'absent.db');
    expect(() => openAgentSqliteReadonly(missing)).toThrow(/unable to open database file/i);
    expect(existsSync(missing)).toBe(false);
  });

  it('returns BLOB columns usable by Buffer.from', () => {
    const path = walFixture(tmp());
    const db = openAgentSqliteReadonly(path);
    try {
      const row = db.prepare('SELECT b FROM t WHERE id = ?').get(1) as { b: Buffer | Uint8Array };
      expect(Buffer.from(row.b).toString()).toBe('x');
    } finally {
      db.close();
    }
  });

  it('issues PRAGMA busy_timeout after open (Node 22.13 ignores constructor timeout)', () => {
    // Constructor `timeout` is a no-op on 22.13.0 (documented floor). CI/dev
    // Node 24 already maps timeout→pragma, so this source check is the
    // mutation that would pass on 24 and fail on 22.13.
    const src = readFileSync(fileURLToPath(new URL('./agentSqlite.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/PRAGMA busy_timeout\s*=\s*\$\{busyMs\}/);
    const path = walFixture(tmp());
    const db = openAgentSqliteReadonly(path);
    try {
      const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(row.timeout).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('busyMs 250 fails a locked DB in well under a second', { timeout: 5_000 }, () => {
    const path = join(tmp(), 'locked-fast.db');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA journal_mode = DELETE');
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    writer.exec('BEGIN EXCLUSIVE');
    const t0 = Date.now();
    let err: unknown;
    try {
      const db = openAgentSqliteReadonly(path, { busyMs: 250 });
      try {
        db.prepare('SELECT 1 AS n').get();
      } finally {
        db.close();
      }
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;
    writer.exec('ROLLBACK');
    writer.close();
    expect(err).toBeTruthy();
    expect(elapsed).toBeLessThan(1000);
  });

  it('waits on a locked rollback-journal database', { timeout: 15_000 }, () => {
    const path = join(tmp(), 'locked.db');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA journal_mode = DELETE');
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    writer.exec('BEGIN EXCLUSIVE');
    const t0 = Date.now();
    let err: unknown;
    try {
      const db = openAgentSqliteReadonly(path);
      try {
        db.prepare('SELECT 1 AS n').get();
      } finally {
        db.close();
      }
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;
    writer.exec('ROLLBACK');
    writer.close();
    expect(err).toBeTruthy();
    expect(elapsed).toBeGreaterThanOrEqual(4000);
  });
});
