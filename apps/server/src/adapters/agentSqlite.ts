/**
 * Lazy node:sqlite access for adapters that read their agent CLI's own
 * session stores (copilot / hermes / opencode / antigravity native DBs).
 *
 * The module is loaded on first use via createRequire instead of a top-level
 * `import { DatabaseSync } from 'node:sqlite'`, so old Node fails at the call,
 * not at startup. The node entry graph stays free of better-sqlite3 —
 * enforced by src/node/isolation.test.ts.
 */
import { createRequire } from 'module';

export type AgentSqliteDb = {
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  exec(sql: string): void;
  close(): void;
};

type DatabaseSyncCtor = new (path: string, opts?: { readOnly?: boolean; timeout?: number }) => AgentSqliteDb;

let ctor: DatabaseSyncCtor | undefined;

/** Open an existing SQLite file read-only; throws when the file is missing. */
export function openAgentSqliteReadonly(dbPath: string, opts?: { busyMs?: number }): AgentSqliteDb {
  if (!ctor) {
    ctor = createRequire(import.meta.url)('node:sqlite').DatabaseSync as DatabaseSyncCtor;
  }
  // Constructor `timeout` is silently ignored on Node 22.13.0 (documented floor).
  // PRAGMA busy_timeout works on 22.13 and later; keep timeout as a belt for 22.16+.
  const busyMs = Number.isFinite(opts?.busyMs) ? Math.max(0, Math.trunc(opts!.busyMs!)) : 5000;
  const db = new ctor(dbPath, { readOnly: true, timeout: busyMs });
  db.exec(`PRAGMA busy_timeout = ${busyMs}`);
  return db;
}
