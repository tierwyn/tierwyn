/**
 * FW-17 — on-disk database backups.
 *
 * Everything filesystem-shaped lives here: the one filename regex, the backups
 * directory, the free-space guard, better-sqlite3's native online `.backup()`,
 * and keep-10 rotation. No Express, no schema, no migration — backups are
 * plain files in `<dirname(TIERWYN_DB)>/backups`.
 *
 * The filename regex is the security boundary for the download/delete routes:
 * it admits no separator, no dot-segment and no NUL, so a validated name can
 * never escape the backups directory. `resolveBackupPath` re-checks the
 * resolved path anyway.
 */
import type { Database } from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readdirSync, statSync, statfsSync, unlinkSync } from 'fs';
import { join, resolve, sep } from 'path';

const execFileAsync = promisify(execFile);

/** Hung tar must not wedge the in-flight 409 flag until restart (adversary F3). */
const TAR_TIMEOUT_MS = 30 * 60_000;
const TAR_MAX_BUFFER = 8 * 1024 * 1024;

/** The only accepted backup filename shape (D2).
 *  Tightened vs the plan's `/^tierwyn-\d{8}-\d{6}(-full)?\.(db|tar)$/` so
 *  `-full.db` and a bare `.tar` are rejected — only the two generated
 *  shapes (`.db` and `-full.tar`) pass, matching the Task 1 reject list. */
export const BACKUP_NAME_RE = /^tierwyn-\d{8}-\d{6}(-full\.tar|\.db)$/;

/** How many backup files survive rotation — `.db` and `-full.tar` share one pool (D6). */
export const BACKUP_KEEP = 10;

export const DISK_GUARD_ERROR = 'not enough free disk space for a backup';

/** Max +1s bumps when a name is already taken in the same UTC second (D2). */
const MAX_NAME_ATTEMPTS = 60;

export interface BackupEntry {
  name: string;
  bytes: number;
  /** File mtime in ms — backups are immutable once written. */
  createdAt: number;
  kind: 'db' | 'full';
}

export function backupsDirFor(dataDir: string): string {
  return join(resolve(dataDir), 'backups');
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** UTC-stamped filename (D2) — local time would collide across a DST fall-back. */
export function backupFileName(now: number, kind: 'db' | 'full'): string {
  const d = new Date(now);
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return kind === 'full' ? `tierwyn-${stamp}-full.tar` : `tierwyn-${stamp}.db`;
}

export function isSafeBackupName(name: unknown): name is string {
  return typeof name === 'string' && BACKUP_NAME_RE.test(name);
}

/** Absolute path for a validated name, or null when unsafe / escaping (D2/D11). */
export function resolveBackupPath(dataDir: string, name: unknown): string | null {
  if (!isSafeBackupName(name)) return null;
  const dir = backupsDirFor(dataDir);
  const abs = resolve(dir, name);
  const withSep = dir.endsWith(sep) ? dir : dir + sep;
  return abs.startsWith(withSep) ? abs : null; // belt & braces — the regex already forbids it
}

function kindOf(name: string): 'db' | 'full' {
  return name.endsWith('.tar') ? 'full' : 'db';
}

function fileBytes(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/** Newest first; ties break on name descending, which is chronological (D6). */
export function listBackups(dataDir: string): BackupEntry[] {
  const dir = backupsDirFor(dataDir);
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }

  const items: BackupEntry[] = [];
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      items.push({ name, bytes: st.size, createdAt: Math.round(st.mtimeMs), kind: kindOf(name) });
    } catch { /* vanished between readdir and stat */ }
  }
  items.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  return items;
}

export function deleteBackup(dataDir: string, name: unknown): 'ok' | 'invalid' | 'not_found' {
  const abs = resolveBackupPath(dataDir, name);
  if (!abs) return 'invalid';
  if (!existsSync(abs)) return 'not_found';
  try { unlinkSync(abs); } catch { return 'not_found'; }
  return 'ok';
}

/** Names + stat only — prod holds ~800 MB of WAVs, never read their contents (D10). */
export function audioDirStats(dataDir: string): { audioBytes: number; audioFiles: number } {
  const dir = join(resolve(dataDir), 'tts-recordings');
  let audioBytes = 0;
  let audioFiles = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return { audioBytes: 0, audioFiles: 0 }; }
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      audioFiles += 1;
      audioBytes += st.size;
    } catch { /* vanished */ }
  }
  return { audioBytes, audioFiles };
}

/** Free bytes on the filesystem holding `dir`. Unknown → allow (D5). */
export function freeBytesFor(dir: string): number {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    // ponytail: an unreadable statfs must not block the operator's only safety net.
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Delete oldest-first down to `keep`, never `keepName`, never a foreign file (D6). */
export function rotateBackups(dataDir: string, keep: number, keepName: string): string[] {
  const dir = backupsDirFor(dataDir);
  const doomed = listBackups(dataDir).slice(keep).filter((e) => e.name !== keepName);
  const removed: string[] = [];
  for (const e of doomed) {
    try {
      unlinkSync(join(dir, e.name));
      removed.push(e.name);
    } catch { /* a stuck old file must not fail a fresh backup */ }
  }
  return removed;
}

/** First free name at or after `now`, bumping one second at a time (D2). */
function allocateName(dir: string, now: number, kind: 'db' | 'full'): string | null {
  for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
    const name = backupFileName(now + i * 1000, kind);
    if (!existsSync(join(dir, name))) return name;
  }
  return null;
}

export interface CreateBackupOptions {
  db: Database;
  dbPath: string;
  dataDir: string;
  includeAudio: boolean;
  now?: number;
  getFreeBytes?: (dir: string) => number;
  keep?: number;
}

export type CreateBackupResult =
  | { ok: true; entry: BackupEntry; rotated: string[] }
  | { ok: false; code: 'disk' | 'failed'; message: string };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const dir = backupsDirFor(opts.dataDir);
  mkdirSync(dir, { recursive: true });

  const audio = opts.includeAudio ? audioDirStats(opts.dataDir).audioBytes : 0;
  const required = 2 * (fileBytes(opts.dbPath) + fileBytes(`${opts.dbPath}-wal`) + audio);
  const free = (opts.getFreeBytes ?? freeBytesFor)(dir);
  if (free < required) return { ok: false, code: 'disk', message: DISK_GUARD_ERROR };

  const now = opts.now ?? Date.now();
  const dbName = allocateName(dir, now, 'db');
  if (!dbName) {
    return { ok: false, code: 'failed', message: 'backup failed: could not allocate a filename' };
  }
  const dbDest = join(dir, dbName);

  try {
    await opts.db.backup(dbDest);
  } catch (e) {
    try { if (existsSync(dbDest)) unlinkSync(dbDest); } catch { /* ignore */ }
    return { ok: false, code: 'failed', message: `backup failed: ${errText(e)}` };
  }

  let finalName = dbName;

  if (opts.includeAudio) {
    const tarName = allocateName(dir, now, 'full');
    if (!tarName) {
      try { unlinkSync(dbDest); } catch { /* ignore */ }
      return { ok: false, code: 'failed', message: 'backup failed: could not allocate a filename' };
    }
    const tarDest = join(dir, tarName);

    // Uncompressed (D9). Layout: the timestamped .db at tar root, plus
    // `tts-recordings/<id>.wav`. Every argv element is server-derived and
    // execFile uses no shell.
    const args = ['-cf', tarDest, '-C', dir, dbName];
    const audioDir = join(resolve(opts.dataDir), 'tts-recordings');
    if (existsSync(audioDir)) args.push('-C', resolve(opts.dataDir), 'tts-recordings');

    try {
      await execFileAsync('tar', args, {
        timeout: TAR_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: TAR_MAX_BUFFER,
      });
    } catch (e) {
      // GNU tar exit 1 = warning (member changed while reading); archive is
      // still usable. Exit ≥2 / spawn failure (ENOENT, timeout) is fatal.
      const warning = typeof e === 'object' && e !== null
        && (e as { code?: unknown }).code === 1
        && existsSync(tarDest);
      if (!warning) {
        try { if (existsSync(tarDest)) unlinkSync(tarDest); } catch { /* ignore */ }
        try { if (existsSync(dbDest)) unlinkSync(dbDest); } catch { /* ignore */ }
        return { ok: false, code: 'failed', message: `backup failed: ${errText(e)}` };
      }
    }

    try { unlinkSync(dbDest); } catch { /* ignore */ }
    finalName = tarName;
  }

  const st = statSync(join(dir, finalName));
  const entry: BackupEntry = {
    name: finalName,
    bytes: st.size,
    createdAt: Math.round(st.mtimeMs),
    kind: kindOf(finalName),
  };
  return { ok: true, entry, rotated: rotateBackups(opts.dataDir, opts.keep ?? BACKUP_KEEP, finalName) };
}
