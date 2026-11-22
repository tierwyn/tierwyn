import Database from 'better-sqlite3';
import { dirname } from 'path';
import { mkdirSync } from 'fs';

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Per-connection, not persisted. Trims the WAL file after a checkpoint resets
  // it; does not limit growth inside one transaction (VACUUM still needs the disk).
  db.pragma('journal_size_limit = 134217728');
  return db;
}

let _db: Database.Database | null = null;

export function setDb(db: Database.Database): void {
  _db = db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialised — call setDb() at boot');
  return _db;
}
