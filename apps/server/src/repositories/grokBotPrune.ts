/**
 * Phase 4 — nightly pruning sweep for the Remote Agents container.
 *
 * Two passes, both scoped ENTIRELY to conversations returned by
 * listRemoteAgentConversations(). Neither pass ever accepts an id from outside
 * that list; neither writes new destructive SQL (truncation reuses
 * deleteTurnEventsByIds, the stale sweep reuses archiveConversation +
 * deleteConversation).
 *
 * FTS: event_fts is kept consistent by the AFTER DELETE trigger in migration
 * 109 — ANY delete from `events` is safe. deleteTurnEventsByIds carries no
 * special FTS handling and needs none. event_fts_buffer is keyed by session_id
 * and only cleared on `final`/session cascade; truncation keeps the NEWEST
 * events and never deletes a session, so it cannot disturb an in-flight tail.
 */
import type { Database } from 'better-sqlite3';
import { rm } from 'fs/promises';
import { join } from 'path';
import { getConversation, deleteConversation } from './conversations.js';
import { deleteTurnEventsByIds } from './events.js';
import { listRemoteAgentConversations } from './remoteAgents.js';
import { readCursors, replaceCursors } from './grokBotWatch.js';
import { archiveConversation } from './retention.js';

/** Rows deleted per transaction. Bounded so a 500k-event backlog never
 *  materialises as one array or one long write lock. */
const CHUNK = 5000;

export interface PruneOptions {
  /** GeneralSettings.grokBotTranscriptEventLimit — 0 disables truncation. */
  eventLimit: number;
  /** GeneralSettings.conversationRetentionDays — 0 disables the stale sweep. */
  retentionDays: number;
  /** Directory containing the DB file; archives land in <dataDir>/archive. Required to sweep. */
  dataDir?: string;
  /** Skip conversations with live/parked sessions — pass the SessionManager probe. */
  isLive?: (conversationId: string) => boolean;
  /** Test seam. */
  now?: number;
}

export interface PruneResult {
  truncated: { id: string; deleted: number }[];
  purgedIds: string[];
  skippedLive: string[];
  skippedPinned: string[];
}

/** True when this container conversation must not be touched by either pass. */
function protectedConv(db: Database, id: string, opts: PruneOptions, res: PruneResult): boolean {
  if (opts.isLive?.(id)) { res.skippedLive.push(id); return true; }
  if (getConversation(db, id)?.pinned) { res.skippedPinned.push(id); return true; }
  return false;
}

/**
 * Keep the last `eventLimit` events per ACTIVE container conversation.
 *
 * Archived container conversations are excluded on purpose: they are heading
 * for the stale sweep, which writes a .jsonl of the WHOLE transcript.
 *
 * ponytail: checkpoints.event_id cascades ON DELETE, so truncation also drops
 *   checkpoints anchored to pruned events — including manual/pinned ones. Bot
 *   conversations do not get manual checkpoints today. If they ever do, add
 *   `AND e.id NOT IN (SELECT event_id FROM checkpoints WHERE pinned = 1)`.
 *   handoffs.anchor_event_id / summaries.last_event_id have no FK and could
 *   dangle — unreachable here: grok-bot is in BARE_PROMPT_ADAPTERS, so these
 *   conversations produce no handoff or summary rows.
 */
export async function truncateRemoteAgentTranscripts(
  db: Database,
  opts: PruneOptions,
  res: PruneResult,
): Promise<void> {
  if (opts.eventLimit <= 0) return;

  // Newest-first, skip the keep-window, take a bounded chunk. Re-running the
  // identical query after a delete returns the NEXT chunk — no cursor state,
  // and an interrupted pass leaves a transcript that is merely longer than N.
  // Uses e.session_id IN (...) to leverage idx_sessions_conversation instead of a full events scan.
  const overflow = db.prepare(
    `SELECT e.id
       FROM events e
      WHERE e.session_id IN (SELECT id FROM sessions WHERE conversation_id = ?)
      ORDER BY e.ts DESC, e.seq DESC
      LIMIT ? OFFSET ?`,
  );

  for (const { id } of listRemoteAgentConversations(db, { archived: false })) {
    if (protectedConv(db, id, opts, res)) continue;

    let deleted = 0;
    for (;;) {
      const ids = (overflow.all(id, CHUNK, opts.eventLimit) as { id: string }[]).map((r) => r.id);
      if (ids.length === 0) break;
      // Ordinary delete; migration 109's AFTER DELETE trigger keeps event_fts in sync.
      // Deleting `events` never touches `conversations`, so updated_at stays frozen —
      // which is what lets a retired Bot age into the stale sweep below.
      deleted += deleteTurnEventsByIds(db, ids);
      await new Promise<void>((r) => setImmediate(r));
      if (ids.length < CHUNK) break;
    }
    if (deleted > 0) res.truncated.push({ id, deleted });
  }
}

/**
 * Delete container conversations that Phase-2 reconcile archived (their Bot
 * left the roster) and that have been silent longer than the retention window.
 *
 * DELIBERATE EXCEPTION: listPurgeCandidates filters archived = 0 so archived
 * conversations are immune forever, and migration 114 says archiving "must
 * preserve, not destroy". This pass is the ONLY place that overrides that, and
 * ONLY for machine-created Remote Agents rows. Never widen it to user archives.
 *
 * ponytail: the clock is updated_at (there is no archived_at column and
 *   setConversationArchived deliberately does not bump updated_at), so the rule
 *   reads "retired AND silent for N days". Ceiling: a Bot retired today whose
 *   last message predates the window is swept on the next pass. Add archived_at
 *   (migration 119) only if retire-time semantics are genuinely wanted.
 */
export async function sweepStaleRemoteAgents(
  db: Database,
  opts: PruneOptions,
  res: PruneResult,
): Promise<void> {
  const dataDir = opts.dataDir;
  if (opts.retentionDays <= 0 || !dataDir) return;
  const cutoff = (opts.now ?? Date.now()) - opts.retentionDays * 86_400_000;

  const cursors = readCursors(db);
  let cursorsDirty = false;

  try {
    for (const { id, botId } of listRemoteAgentConversations(db, { archived: true })) {
      const conv = getConversation(db, id);
      if (!conv || conv.updatedAt >= cutoff) continue;
      if (protectedConv(db, id, opts, res)) continue;

      // All-or-nothing archive first; a failed write keeps the conversation for a retry tomorrow.
      if (!(await archiveConversation(db, dataDir, id))) continue;

      // deleteConversation returns nativeSessions, and index.ts feeds those to
      // adapter.deleteNativeSession for the generic purge. NOT wired here: a
      // container conversation's nativeSessionId is a LIVE Bot UUID in the Grok
      // Bot app. Tierwyn never deletes anything inside that app.
      if (!deleteConversation(db, id).ok) continue;
      // ponytail: shard dir is <dataDir>/attachments/<uuid>; skip a sweep of orphans
      await rm(join(dataDir, 'attachments', id), { recursive: true, force: true }).catch(() => undefined);

      res.purgedIds.push(id);
      if (cursors[botId]) { delete cursors[botId]; cursorsDirty = true; }
      await new Promise<void>((r) => setImmediate(r));
    }
  } finally {
    if (cursorsDirty) replaceCursors(db, cursors);
  }
}

/** One nightly sweep: truncate active transcripts, then purge stale retired ones. */
export async function runGrokBotPruneSweep(db: Database, opts: PruneOptions): Promise<PruneResult> {
  const res: PruneResult = { truncated: [], purgedIds: [], skippedLive: [], skippedPinned: [] };
  await truncateRemoteAgentTranscripts(db, opts, res);
  await sweepStaleRemoteAgents(db, opts, res);

  if (res.truncated.length > 0 || res.purgedIds.length > 0) {
    const events = res.truncated.reduce((n, t) => n + t.deleted, 0);
    console.log(
      `[grokbot-prune] truncated ${res.truncated.length} conversation(s) (${events} events), ` +
      `purged ${res.purgedIds.length} retired, ` +
      `${res.skippedLive.length} live / ${res.skippedPinned.length} pinned skipped`,
    );
  }
  return res;
}
