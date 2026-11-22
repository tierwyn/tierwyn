import type { Database } from 'better-sqlite3';

export interface GitCommitDraftRow {
  cwd: string;
  message: string;
  generating: number;                    // raw column; use getCommitDraft() to read
  generatingStartedAt: number | null;
  updatedAt: number;
}

/** Lazy stale-lock TTL, same value and same reasoning as drafts.ts
 *  PROCESSING_STALE_MS. The sidecar call itself is capped at
 *  COMMIT_TIMEOUT_SECS (120 s), comfortably inside this window.
 *  // ponytail: lazy expiry only — a server crash leaves a lock row that the
 *  next read or begin silently clears. Add a reaper only if we ever run >1
 *  server process. */
export const COMMIT_GENERATION_STALE_MS = 180_000;

/** Current draft for a worktree. `generating` already has the stale lock applied,
 *  so callers never see a lock older than the TTL. Returns zero-values when no
 *  row exists, so routes need no null branch. */
export function getCommitDraft(
  db: Database,
  cwd: string,
  now = Date.now(),
): { message: string; generating: boolean } {
  const row = db.prepare(
    `SELECT message, generating, generating_started_at AS generatingStartedAt
       FROM git_commit_drafts WHERE cwd = ?`,
  ).get(cwd) as Pick<GitCommitDraftRow, 'message' | 'generating' | 'generatingStartedAt'> | undefined;
  if (!row) return { message: '', generating: false };
  const live = row.generating === 1
    && (row.generatingStartedAt ?? 0) >= now - COMMIT_GENERATION_STALE_MS;
  return { message: row.message, generating: live };
}

/** Idempotent upsert of the operator's text. Does not touch the lock. */
export function setCommitDraft(db: Database, cwd: string, message: string): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO git_commit_drafts (cwd, message, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cwd) DO UPDATE SET message = excluded.message, updated_at = excluded.updated_at`,
  ).run(cwd, message, now);
  return now;
}

/** No-op if the row is absent. Called after a successful commit. */
export function clearCommitDraft(db: Database, cwd: string): void {
  db.prepare('DELETE FROM git_commit_drafts WHERE cwd = ?').run(cwd);
}

/** Acquire the generation lock. Returns false when a live (non-stale) job holds
 *  it; an expired lock is overwritten. Creates the row if absent. */
export function beginCommitGeneration(db: Database, cwd: string, now = Date.now()): boolean {
  const staleBefore = now - COMMIT_GENERATION_STALE_MS;
  db.prepare(
    `INSERT INTO git_commit_drafts (cwd, message, updated_at)
     VALUES (?, '', ?) ON CONFLICT(cwd) DO NOTHING`,
  ).run(cwd, now);
  const info = db.prepare(
    `UPDATE git_commit_drafts
        SET generating = 1, generating_started_at = ?, updated_at = ?
      WHERE cwd = ?
        AND (generating = 0 OR generating_started_at IS NULL OR generating_started_at < ?)`,
  ).run(now, now, cwd, staleBefore);
  return info.changes > 0;
}

/** Cancel in-flight generation. Clears the generating lock, keeping the message intact. */
export function cancelCommitGeneration(db: Database, cwd: string): boolean {
  const now = Date.now();
  const info = db.prepare(
    `UPDATE git_commit_drafts
        SET generating = 0, generating_started_at = NULL, updated_at = ?
      WHERE cwd = ?`,
  ).run(now, cwd);
  return info.changes > 0;
}

/** Release the lock. `message` is written in the same statement when the job
 *  succeeded; on failure it is omitted and the previous text survives.
 *  Returns false when the row is gone (e.g. cleared by a concurrent commit or cancel)
 *  so the settle path can skip broadcasting a message with no DB row behind it. */
export function endCommitGeneration(
  db: Database,
  cwd: string,
  message?: string,
  expectedStartedAt?: number,
): boolean {
  const now = Date.now();
  const info = expectedStartedAt !== undefined
    ? db.prepare(
        `UPDATE git_commit_drafts
            SET generating = 0, generating_started_at = NULL,
                message = COALESCE(?, message),
                updated_at = ?
          WHERE cwd = ? AND generating = 1 AND generating_started_at = ?`,
      ).run(message ?? null, now, cwd, expectedStartedAt)
    : db.prepare(
        `UPDATE git_commit_drafts
            SET generating = 0, generating_started_at = NULL,
                message = COALESCE(?, message),
                updated_at = ?
          WHERE cwd = ?`,
      ).run(message ?? null, now, cwd);
  return info.changes > 0;
}

