import type { Database } from 'better-sqlite3';
import type { DraftProcessing } from '@tierwyn/shared';

export interface DraftRow {
  text: string;
  attachments: string;
  updatedAt: number;
  processing: string;              // raw column; use effectiveProcessing() to read
  processingId: string | null;
  processingStartedAt: number | null;
  preText: string | null;
  autoSend: number;
  autoSendProfileId: string | null;
  autoSendAgent: string | null;
  autoSendModel: string | null;
  profileId: string | null;
}

/** Lazy stale-lock TTL. // ponytail: lazy expiry only — a crashed server leaves
 *  a lock row that the next begin/read silently clears. Add a reaper only if
 *  we ever run >1 server process. */
export const PROCESSING_STALE_MS = 180_000;

/** Returns null when no draft row exists for this conversation. */
export function getDraft(db: Database, conversationId: string): DraftRow | null {
  const row = db.prepare(
    `SELECT text, attachments, updated_at AS updatedAt,
            processing, processing_id AS processingId,
            processing_started_at AS processingStartedAt, pre_text AS preText,
            auto_send AS autoSend,
            auto_send_profile_id AS autoSendProfileId,
            auto_send_agent AS autoSendAgent,
            auto_send_model AS autoSendModel,
            profile_id AS profileId
       FROM draft_prompts WHERE conversation_id = ?`
  ).get(conversationId) as DraftRow | undefined;
  return row ?? null;
}

/** Reads the lock, treating an expired one as idle (lazy expiry — see D2). */
export function effectiveProcessing(row: DraftRow | null, now = Date.now()): DraftProcessing {
  if (!row || !row.processing) return 'idle';
  if ((row.processingStartedAt ?? 0) < now - PROCESSING_STALE_MS) return 'idle';
  return row.processing as DraftProcessing;
}

/** Convenience for routes: current lock for a conversation. */
export function getProcessing(db: Database, conversationId: string): DraftProcessing {
  return effectiveProcessing(getDraft(db, conversationId));
}

/** Undo is only offered after a *successful* enhance (stash exists and we are idle).
 *  During processing, and after a failed enhance (stash cleared), this is false. */
export function draftCanUndo(row: DraftRow | null, processing = effectiveProcessing(row)): boolean {
  return processing === 'idle' && row?.preText != null;
}

/**
 * Acquire the composer lock. Returns false when another live job holds it.
 * Creates the draft row if absent. Optionally snapshots the current text into
 * pre_text (enhance does; transcribe does not).
 * // ponytail: one job per conversation. Per-kind locks only if a real use case appears.
 */
export function beginProcessing(
  db: Database,
  conversationId: string,
  kind: Exclude<DraftProcessing, 'idle'>,
  jobId: string,
  opts: { stashPreText?: boolean } = {},
): boolean {
  const now = Date.now();
  const staleBefore = now - PROCESSING_STALE_MS;
  db.prepare(
    `INSERT INTO draft_prompts (conversation_id, text, attachments, updated_at)
     VALUES (?, '', '[]', ?) ON CONFLICT(conversation_id) DO NOTHING`
  ).run(conversationId, now);
  const info = db.prepare(
    `UPDATE draft_prompts
        SET processing = ?, processing_id = ?, processing_started_at = ?,
            pre_text = CASE WHEN ? = 1 THEN text ELSE pre_text END
      WHERE conversation_id = ?
        AND (processing = '' OR processing_started_at IS NULL OR processing_started_at < ?)`
  ).run(kind, jobId, now, opts.stashPreText ? 1 : 0, conversationId, staleBefore);
  return info.changes > 0;
}

/**
 * Release the lock IF we still own it. `text` (when provided) is written in the
 * same statement so a completing job can never lose a race with its own release.
 * Returns false when another job stole the lock (stale steal) — caller must then
 * NOT broadcast a result, because a newer job owns the draft.
 */
export function endProcessing(
  db: Database,
  conversationId: string,
  jobId: string,
  opts: { text?: string } = {},
): boolean {
  const now = Date.now();
  const info = db.prepare(
    `UPDATE draft_prompts
        SET processing = '', processing_id = NULL, processing_started_at = NULL,
            text = COALESCE(?, text),
            pre_text = CASE WHEN ? IS NOT NULL THEN pre_text ELSE NULL END,
            updated_at = ?
      WHERE conversation_id = ? AND processing_id = ?`
  ).run(opts.text ?? null, opts.text ?? null, now, conversationId, jobId);
  return info.changes > 0;
}

/** Snapshot current text into pre_text (Slow-Yes dictation: undo back to raw). */
export function stashDraftPreText(db: Database, conversationId: string): void {
  db.prepare('UPDATE draft_prompts SET pre_text = text WHERE conversation_id = ?').run(conversationId);
}

/** Store a value in pre_text without changing `text` (Slow-Yes: stash the
 *  typed+raw transcript while the composer still shows the pre-dictation draft). */
export function stashDraftPreTextValue(db: Database, conversationId: string, value: string): void {
  db.prepare(
    `INSERT INTO draft_prompts (conversation_id, text, attachments, updated_at, pre_text)
     VALUES (?, '', '[]', ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET pre_text = excluded.pre_text`,
  ).run(conversationId, Date.now(), value);
}

export type DraftAutoSendCtx = { profileId: string; agent: string; model: string };

export function setDraftAutoSend(
  db: Database,
  conversationId: string,
  ctx: DraftAutoSendCtx | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO draft_prompts (conversation_id, text, attachments, updated_at)
     VALUES (?, '', '[]', ?) ON CONFLICT(conversation_id) DO NOTHING`,
  ).run(conversationId, now);
  if (ctx) {
    db.prepare(
      `UPDATE draft_prompts
          SET auto_send = 1,
              auto_send_profile_id = ?,
              auto_send_agent = ?,
              auto_send_model = ?
        WHERE conversation_id = ?`,
    ).run(ctx.profileId, ctx.agent, ctx.model, conversationId);
  } else {
    db.prepare(
      `UPDATE draft_prompts
          SET auto_send = 0,
              auto_send_profile_id = NULL,
              auto_send_agent = NULL,
              auto_send_model = NULL
        WHERE conversation_id = ?`,
    ).run(conversationId);
  }
}

export function draftAutoSendCtx(row: DraftRow | null): DraftAutoSendCtx | null {
  if (!row || !row.autoSend) return null;
  const profileId = row.autoSendProfileId ?? '';
  const agent = row.autoSendAgent ?? '';
  const model = row.autoSendModel ?? '';
  if (!profileId || !agent || !model) return null;
  return { profileId, agent, model };
}

/** Clears the pre-enhance stash (any user edit invalidates it). */
export function clearPreText(db: Database, conversationId: string): void {
  db.prepare('UPDATE draft_prompts SET pre_text = NULL WHERE conversation_id = ?').run(conversationId);
}

/** Restores pre_text into text and clears the stash. Returns the restored text, or null.
 *  // ponytail: one undo level, as today — no stack. */
export function undoEnhance(db: Database, conversationId: string): { text: string; updatedAt: number } | null {
  const row = getDraft(db, conversationId);
  if (!row || row.preText == null) return null;
  const now = Date.now();
  const info = db.prepare(
    `UPDATE draft_prompts
        SET text = pre_text, pre_text = NULL, updated_at = ?
      WHERE conversation_id = ? AND pre_text IS NOT NULL`
  ).run(now, conversationId);
  if (info.changes === 0) return null;
  return { text: row.preText, updatedAt: now };
}

/** Idempotent upsert. Returns the persisted updatedAt (the value written).
 *  User writes clear pre_text — an explicit edit invalidates undo.
 *  If profileId is provided, updates profile_id; if omitted/undefined, preserves existing profile_id. */
export function upsertDraft(
  db: Database,
  conversationId: string,
  text: string,
  attachmentsJson = '[]',
  profileId?: string | null,
): number {
  const now = Date.now();
  if (profileId !== undefined) {
    db.prepare(
      `INSERT INTO draft_prompts (conversation_id, text, attachments, updated_at, profile_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         text = excluded.text,
         attachments = excluded.attachments,
         updated_at = excluded.updated_at,
         profile_id = excluded.profile_id,
         pre_text = NULL`
    ).run(conversationId, text, attachmentsJson, now, profileId);
  } else {
    db.prepare(
      `INSERT INTO draft_prompts (conversation_id, text, attachments, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         text = excluded.text,
         attachments = excluded.attachments,
         updated_at = excluded.updated_at,
         pre_text = NULL`
    ).run(conversationId, text, attachmentsJson, now);
  }
  return now;
}

/** Update only the selected profile for a draft row, creating it if absent. */
export function setDraftProfile(db: Database, conversationId: string, profileId: string | null): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO draft_prompts (conversation_id, text, attachments, updated_at, profile_id)
     VALUES (?, '', '[]', ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       profile_id = excluded.profile_id,
       updated_at = excluded.updated_at`
  ).run(conversationId, now, profileId);
  return now;
}

/** Append a chunk to the draft, atomically. Creates the row if absent. Uses a
 *  single space separator, with no leading space when the existing draft is
 *  empty (or the row is new). Returns the persisted updatedAt.
 *  Does not clear pre_text — a transcription chunk is not an edit that
 *  invalidates undo (and enhance+transcribe cannot overlap anyway). */
export function appendDraft(db: Database, conversationId: string, chunk: string): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO draft_prompts (conversation_id, text, attachments, updated_at)
     VALUES (?, ?, '[]', ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       text = CASE WHEN draft_prompts.text = '' THEN excluded.text
                   ELSE draft_prompts.text || ' ' || excluded.text END,
       updated_at = excluded.updated_at`
  ).run(conversationId, chunk, now);
  return now;
}

/** No-op if the row is absent. */
export function deleteDraft(db: Database, conversationId: string): void {
  db.prepare('DELETE FROM draft_prompts WHERE conversation_id = ?').run(conversationId);
}

/** Force-clear an orphaned 'transcribing' lock — used by /transcribe/cancel
 *  when no in-flight job exists (server restarted mid-transcribe, or the
 *  settle broadcast was missed). Such a lock can never settle on its own and
 *  would freeze the composer until the 180 s stale TTL; a page refresh
 *  re-reads the same row, so clicking the processing strip must free it.
 *  'enhancing' locks are left alone — enhance has its own runner and client
 *  gate. pre_text is preserved: a Slow-Yes stash is still undoable after the
 *  release. Returns true when a lock was cleared. */
export function forceReleaseTranscribing(db: Database, conversationId: string): boolean {
  const info = db.prepare(
    `UPDATE draft_prompts
        SET processing = '', processing_id = NULL, processing_started_at = NULL,
            updated_at = ?
      WHERE conversation_id = ? AND processing = 'transcribing'`
  ).run(Date.now(), conversationId);
  return info.changes > 0;
}
