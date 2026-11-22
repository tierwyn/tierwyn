/**
 * FW-17 — backup routes. Cookie-auth like every other `/settings/*` route
 * (inherited from the global requireAuth in index.ts) — no bearer, no token,
 * no public URL. All filesystem behaviour lives in repositories/backups.ts;
 * this file only maps results onto HTTP codes and holds the in-flight flag.
 */
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { createReadStream, statSync } from 'fs';
import { pipeline } from 'stream';
import {
  BACKUP_KEEP,
  audioDirStats,
  createBackup,
  deleteBackup,
  listBackups,
  resolveBackupPath,
  type CreateBackupOptions,
  type CreateBackupResult,
} from '../repositories/backups.js';

export const BACKUP_RUNNING_ERROR = 'a backup is already running';
export const INVALID_NAME_ERROR = 'invalid backup name';
export const NO_SUCH_BACKUP_ERROR = 'no such backup';

export interface BackupRoutesOptions {
  getDb: () => Database;
  dbPath: string;
  dataDir: string;
  /** Tests pin the clock; production omits it. */
  now?: () => number;
  getFreeBytes?: (dir: string) => number;
  keep?: number;
  /** Test seam only (D7) — index.ts never passes this. */
  runBackup?: (opts: CreateBackupOptions) => Promise<CreateBackupResult>;
}

export function registerBackupRoutes(app: Express, opts: BackupRoutesOptions): void {
  // Closure-scoped, not module-scoped: tests register several apps per process.
  let running = false;
  const run = opts.runBackup ?? createBackup;

  app.get('/settings/backups', (_req, res) => {
    res.json({ items: listBackups(opts.dataDir), ...audioDirStats(opts.dataDir) });
  });

  app.post('/settings/backup', async (req, res) => {
    if (running) {
      res.status(409).json({ error: BACKUP_RUNNING_ERROR });
      return;
    }
    running = true;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await run({
        db: opts.getDb(),
        dbPath: opts.dbPath,
        dataDir: opts.dataDir,
        includeAudio: body.includeAudio === true, // D8: only a real `true` opts in
        now: opts.now?.(),
        getFreeBytes: opts.getFreeBytes,
        keep: opts.keep ?? BACKUP_KEEP,
      });
      if (result.ok) {
        res.json({ backup: result.entry, rotated: result.rotated });
        return;
      }
      res.status(result.code === 'disk' ? 507 : 500).json({ error: result.message });
    } catch (e) {
      res.status(500).json({
        error: `backup failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      running = false;
    }
  });

  app.get('/settings/backups/:name/download', (req, res) => {
    const abs = resolveBackupPath(opts.dataDir, req.params.name);
    if (!abs) {
      res.status(400).json({ error: INVALID_NAME_ERROR });
      return;
    }
    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      res.status(404).json({ error: NO_SUCH_BACKUP_ERROR });
      return;
    }
    res.setHeader('Content-Type', abs.endsWith('.tar') ? 'application/x-tar' : 'application/x-sqlite3');
    // The name is regex-constrained (no quotes, no separators) — nothing to escape.
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.setHeader('Content-Length', String(size));
    res.setHeader('Cache-Control', 'no-store');
    // pipeline attaches an error listener (bare .pipe() does not). A vanished
    // or unreadable file after the stat above must not become an uncaught
    // ENOENT that kills the process — rotateBackups / a second tab's Delete
    // make that race reachable. Also destroys the source fd if the client aborts.
    pipeline(createReadStream(abs), res, () => {});
  });

  app.delete('/settings/backups/:name', (req, res) => {
    const out = deleteBackup(opts.dataDir, req.params.name);
    if (out === 'ok') {
      res.json({ deleted: 1 });
      return;
    }
    res.status(out === 'invalid' ? 400 : 404)
      .json({ error: out === 'invalid' ? INVALID_NAME_ERROR : NO_SUCH_BACKUP_ERROR });
  });
}
