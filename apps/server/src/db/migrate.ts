import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  sql: string;
  /**
   * When true, run this migration with PRAGMA foreign_keys=OFF so a parent-table
   * rebuild (DROP + RENAME) does not CASCADE-delete child rows. Default false —
   * only table-rebuild migrations should opt in (adversary F4).
   */
  needsFkOff?: boolean;
}

export function runMigrations(db: Database, migrations: Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version)
  );

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const m of ordered) {
    if (applied.has(m.version)) continue;
    const fkOff = m.needsFkOff === true;
    if (fkOff) db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        record.run(m.version, Date.now());
      });
      tx();
    } finally {
      if (fkOff) db.pragma('foreign_keys = ON');
    }
  }
}
