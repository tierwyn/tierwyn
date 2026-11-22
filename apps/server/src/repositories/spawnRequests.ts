import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { SpawnRequestRow } from '@tierwyn/shared';

// ponytail: snake_case mirrors the DB row; camelCase conversion is one-way (read path).
interface DbRow {
  id: string;
  parent_conversation_id: string;
  parent_session_id: string;
  role: string | null;
  profile_id: string | null;
  prompt: string;
  workdir: string | null;
  wait: number;
  notify_parent: number;
  designation: string | null;
  status: string;
  child_conversation_id: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  error: string | null;
}

function toRow(r: DbRow): SpawnRequestRow {
  return {
    id: r.id,
    parentConversationId: r.parent_conversation_id,
    parentSessionId: r.parent_session_id,
    role: r.role ?? undefined,
    profileId: r.profile_id ?? undefined,
    prompt: r.prompt,
    workdir: (r.workdir as 'shared' | 'worktree' | null) ?? undefined,
    wait: r.wait === 1,
    notifyParent: r.notify_parent === 1,
    designation: r.designation ?? undefined,
    status: r.status as SpawnRequestRow['status'],
    childConversationId: r.child_conversation_id ?? undefined,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? undefined,
    decidedBy: r.decided_by ?? undefined,
    error: r.error ?? undefined,
  };
}

export function createSpawnRequest(
  db: Database,
  input: {
    parentConversationId: string;
    parentSessionId: string;
    role?: string;
    profileId?: string;
    prompt: string;
    workdir?: 'shared' | 'worktree';
    wait: boolean;
    notifyParent: boolean;
    designation?: string;
  },
): SpawnRequestRow {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO spawn_requests
      (id, parent_conversation_id, parent_session_id, role, profile_id,
       prompt, workdir, wait, notify_parent, designation, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id,
    input.parentConversationId,
    input.parentSessionId,
    input.role ?? null,
    input.profileId ?? null,
    input.prompt,
    input.workdir ?? null,
    input.wait ? 1 : 0,
    input.notifyParent ? 1 : 0,
    input.designation ?? null,
    now,
  );
  return getSpawnRequest(db, id)!;
}

export function getSpawnRequest(db: Database, id: string): SpawnRequestRow | undefined {
  const row = db.prepare('SELECT * FROM spawn_requests WHERE id = ?').get(id) as DbRow | undefined;
  return row ? toRow(row) : undefined;
}

export function listPendingForConversation(db: Database, parentConversationId: string): SpawnRequestRow[] {
  const rows = db.prepare(
    "SELECT * FROM spawn_requests WHERE parent_conversation_id = ? AND status = 'pending' ORDER BY created_at ASC"
  ).all(parentConversationId) as DbRow[];
  return rows.map(toRow);
}

/** All pending rows across every conversation, oldest first. Used by the
 *  operator-global approval queue (the modal surfaces requests regardless of
 *  which conversation is currently open). */
export function listAllPending(db: Database): SpawnRequestRow[] {
  const rows = db.prepare(
    "SELECT * FROM spawn_requests WHERE status = 'pending' ORDER BY created_at ASC"
  ).all() as DbRow[];
  return rows.map(toRow);
}

/** Atomic CAS: only flips status from pending → approved. Returns true if this call won. */
export function approveSpawnRequest(db: Database, id: string, decidedBy?: string): boolean {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE spawn_requests
    SET status = 'approved', decided_at = ?, decided_by = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, decidedBy ?? null, id);
  return result.changes === 1;
}

/** Atomic CAS: rolls an approved-but-undispatched row back to pending. Used when
 *  the approve re-dispatch rejects (e.g. the breadth cap's 429) so the request
 *  returns to the operator queue instead of being stranded unreadable. Only
 *  matches status = 'approved' — an already-dispatched row is never touched. */
export function requeueSpawnRequest(db: Database, id: string): boolean {
  const result = db.prepare(`
    UPDATE spawn_requests
    SET status = 'pending', decided_at = NULL, decided_by = NULL
    WHERE id = ? AND status = 'approved'
  `).run(id);
  return result.changes === 1;
}

/** Atomic CAS: only flips status from pending → denied. Returns true if this call won. */
export function denySpawnRequest(db: Database, id: string, reason?: string, decidedBy?: string): boolean {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE spawn_requests
    SET status = 'denied', error = ?, decided_at = ?, decided_by = ?
    WHERE id = ? AND status = 'pending'
  `).run(reason ?? null, now, decidedBy ?? null, id);
  return result.changes === 1;
}

/** Link the spawned child conversation and mark the request as dispatched. */
export function attachChild(db: Database, id: string, childConversationId: string): void {
  db.prepare(`
    UPDATE spawn_requests
    SET child_conversation_id = ?, status = 'dispatched'
    WHERE id = ?
  `).run(childConversationId, id);
}

/** Flip all pending rows for a session to 'expired'. Returns the expired rows for notification. */
export function expirePendingForSession(db: Database, sessionId: string): SpawnRequestRow[] {
  const now = Date.now();
  // Select first so we can return the rows; then update. Single-writer SQLite, so no TOCTOU.
  const rows = db.prepare(
    "SELECT * FROM spawn_requests WHERE parent_session_id = ? AND status = 'pending'"
  ).all(sessionId) as DbRow[];
  if (rows.length === 0) return [];
  db.prepare(`
    UPDATE spawn_requests SET status = 'expired', decided_at = ?
    WHERE parent_session_id = ? AND status = 'pending'
  `).run(now, sessionId);
  return rows.map(toRow);
}

/** Flip all pending rows older than ttlMs to 'expired'. Returns the expired rows.
 *  Lazy sweep — called at list/approve time; no janitor cron. Default TTL is 24h:
 *  the operator's spec is that pending requests "sit there until I approve it" —
 *  they must NOT expire when the spawning agent's session ends (see sessionManager
 *  cleanup) and should only fall to the janitor after a full day unattended. */
export function expireStale(db: Database, ttlMs = 24 * 60 * 60_000): SpawnRequestRow[] {
  const cutoff = Date.now() - ttlMs;
  const rows = db.prepare(
    "SELECT * FROM spawn_requests WHERE status = 'pending' AND created_at < ?"
  ).all(cutoff) as DbRow[];
  if (rows.length === 0) return [];
  db.prepare(`
    UPDATE spawn_requests SET status = 'expired', decided_at = ?
    WHERE status = 'pending' AND created_at < ?
  `).run(Date.now(), cutoff);
  return rows.map(toRow);
}
