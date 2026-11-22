import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type {
  ConversationTimer, ConversationTimerWithAttachments, TimerHandoffOverride,
  TimerOrigin, EffortLevel, PromptAttachment, PromptOptions,
  PendingTimerSummary,
} from '@tierwyn/shared';
import { PENDING_TIMER_PREVIEW_CHARS } from '@tierwyn/shared';


interface Row {
  id: string;
  conversation_id: string;
  prompt: string;
  profile_id: string;
  fire_at_ms: number;
  created_at: number;
  cancelled_at: number | null;
  fired_at: number | null;
  error: string | null;
  effort: string | null;
  options: string | null;
  attachments: string | null;
  handoff_override: string | null;
  origin: string;
  attempt: number;
  notify_parent: number | null;
}

/** A hand-edited or partially-written JSON column must degrade to "no snapshot",
 *  never throw — a corrupt row would otherwise stall the whole sweep. */
function parseOptions(raw: string | null): PromptOptions | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as PromptOptions) : null;
  } catch { return null; }
}

function parseAttachments(raw: string | null): PromptAttachment[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as PromptAttachment[]) : [];
  } catch { return []; }
}

function toTimer(r: Row): ConversationTimer {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    prompt: r.prompt,
    profileId: r.profile_id,
    fireAtMs: r.fire_at_ms,
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
    firedAt: r.fired_at,
    error: r.error,
    effort: (r.effort as EffortLevel | null) ?? null,
    options: parseOptions(r.options),
    // ponytail: names are derived in JS from the stored blob. The chip poll is
    // per conversation-switch / create / cancel (the 1s countdown tick is
    // client-local), and the blob is capped at 20 MiB by the draft caps, so the
    // read is bounded and rare. If timer polling ever gets hot, swap the SELECT
    // for `json_group_array(json_extract(value,'$.name')) FROM json_each(...)`.
    attachmentNames: parseAttachments(r.attachments)
      .map((a, i) => a.name ?? `attachment ${i + 1}`),
    handoffOverride: (r.handoff_override as TimerHandoffOverride | null) ?? null,
    origin: r.origin as TimerOrigin,
    attempt: r.attempt,
    notifyParent: r.notify_parent === null ? null : Boolean(r.notify_parent),
  };
}

function toTimerWithAttachments(r: Row): ConversationTimerWithAttachments {
  return { ...toTimer(r), attachments: parseAttachments(r.attachments) };
}

let timersListener: ((conversationIds: string[]) => void) | null = null;
let timersPending: Set<string> | null = null;

/** index.ts wires this to fanOpenClients (timers_changed). Tests leave it null. */
export function setTimersChangedListener(fn: typeof timersListener): void { timersListener = fn; }

// ponytail: same setImmediate coalescing as noteConversationsChanged — one
// frame per tick, ids only; clients refetch their chip row / Timed tab.
function noteTimersChanged(conversationId: string | undefined): void {
  if (!timersListener || !conversationId) return;
  if (!timersPending) {
    timersPending = new Set();
    setImmediate(() => {
      const ids = [...timersPending!]; timersPending = null;
      try { timersListener?.(ids); } catch (err) { console.error('[timers] timers_changed listener error:', err); }
    });
  }
  timersPending.add(conversationId);
}

export function createTimer(
  db: Database,
  input: {
    id?: string;
    conversationId: string;
    prompt: string;
    profileId: string;
    fireAtMs: number;
    createdAt?: number;
    effort?: EffortLevel | null;
    options?: PromptOptions | null;
    attachments?: PromptAttachment[] | null;
    handoffOverride?: TimerHandoffOverride | null;
    origin?: TimerOrigin;
    attempt?: number;
    notifyParent?: boolean | null;
  },
): ConversationTimer {
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const origin = input.origin ?? 'operator';
  const attempt = input.attempt ?? 1;
  const effort = input.effort ?? null;
  // Empty object / empty array are "no snapshot" — store NULL, not '{}' / '[]',
  // so a v1 row and an empty-v2 row read back identically.
  const options = input.options && Object.keys(input.options).length > 0
    ? JSON.stringify(input.options) : null;
  const attachments = input.attachments && input.attachments.length > 0
    ? JSON.stringify(input.attachments) : null;
  const handoffOverride = input.handoffOverride ?? null;
  const notifyParent =
    input.notifyParent === null || input.notifyParent === undefined
      ? null
      : (input.notifyParent ? 1 : 0);

  db.prepare(
    `INSERT INTO conversation_timers
       (id, conversation_id, prompt, profile_id, fire_at_ms, created_at,
        effort, options, attachments, handoff_override, origin, attempt, notify_parent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.conversationId, input.prompt, input.profileId, input.fireAtMs, createdAt,
    effort, options, attachments, handoffOverride, origin, attempt, notifyParent,
  );
  noteTimersChanged(input.conversationId);

  return toTimer({
    id,
    conversation_id: input.conversationId,
    prompt: input.prompt,
    profile_id: input.profileId,
    fire_at_ms: input.fireAtMs,
    created_at: createdAt,
    cancelled_at: null,
    fired_at: null,
    error: null,
    effort,
    options,
    attachments,
    handoff_override: handoffOverride,
    origin,
    attempt,
    notify_parent: notifyParent,
  });
}


export function getTimer(db: Database, id: string): ConversationTimer | undefined {
  const row = db.prepare('SELECT * FROM conversation_timers WHERE id = ?').get(id) as Row | undefined;
  return row ? toTimer(row) : undefined;
}

/** Chip row data source: still pending, soonest first. */
export function listPendingTimers(db: Database, conversationId: string): ConversationTimer[] {
  const rows = db.prepare(
    `SELECT * FROM conversation_timers
      WHERE conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL
      ORDER BY fire_at_ms ASC, rowid ASC`,
  ).all(conversationId) as Row[];
  return rows.map(toTimer);
}

/** Tier 1: the pending agent- or auto-created resume timer for a conversation,
 *  if any — operator rows never count. Soonest first. */
export function getPendingNonOperatorTimer(db: Database, conversationId: string): ConversationTimer | undefined {
  const row = db.prepare(
    `SELECT * FROM conversation_timers
      WHERE conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL AND origin != 'operator'
      ORDER BY fire_at_ms ASC, rowid ASC LIMIT 1`,
  ).get(conversationId) as Row | undefined;
  return row ? toTimer(row) : undefined;
}

/** Tier 1: cancel every pending agent/auto resume timer for a conversation
 *  (a fresh operator or agent prompt supersedes them). Returns rows cancelled;
 *  operator rows are never touched. */
export function cancelPendingNonOperatorTimers(db: Database, conversationId: string, now: number): number {
  const res = db.prepare(
    `UPDATE conversation_timers SET cancelled_at = ?
      WHERE conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL AND origin != 'operator'`,
  ).run(now, conversationId);
  if (res.changes > 0) noteTimersChanged(conversationId);
  return res.changes;
}

export interface TimerPatch {
  prompt?: string;
  profileId?: string;
  fireAtMs?: number;
  effort?: EffortLevel | null;
  options?: PromptOptions | null;
  attachments?: PromptAttachment[] | null;
  handoffOverride?: TimerHandoffOverride | null;
}

/** CAS update. Returns the new row, or undefined if the timer was already
 *  fired or cancelled (the sweep can claim it between the route's getTimer and
 *  this UPDATE — same race cancelTimer guards). */
export function updateTimer(db: Database, id: string, patch: TimerPatch): ConversationTimer | undefined {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if ('prompt' in patch) {
    setClauses.push('prompt = ?');
    values.push(patch.prompt);
  }
  if ('profileId' in patch) {
    setClauses.push('profile_id = ?');
    values.push(patch.profileId);
  }
  if ('fireAtMs' in patch) {
    setClauses.push('fire_at_ms = ?');
    values.push(patch.fireAtMs);
  }
  if ('effort' in patch) {
    setClauses.push('effort = ?');
    values.push(patch.effort ?? null);
  }
  if ('options' in patch) {
    // Empty object is "no snapshot" — store NULL, not '{}', matching createTimer.
    const options = patch.options && Object.keys(patch.options).length > 0
      ? JSON.stringify(patch.options) : null;
    setClauses.push('options = ?');
    values.push(options);
  }
  if ('attachments' in patch) {
    const attachments = patch.attachments && patch.attachments.length > 0
      ? JSON.stringify(patch.attachments) : null;
    setClauses.push('attachments = ?');
    values.push(attachments);
  }
  if ('handoffOverride' in patch) {
    setClauses.push('handoff_override = ?');
    values.push(patch.handoffOverride ?? null);
  }

  if (setClauses.length === 0) return getTimer(db, id);

  return db.transaction(() => {
    const res = db.prepare(
      `UPDATE conversation_timers SET ${setClauses.join(', ')}
        WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL`,
    ).run(...values, id);
    if (res.changes !== 1) return undefined;
    const t = getTimer(db, id);
    noteTimersChanged(t?.conversationId);
    return t;
  })();
}

/** True iff this call actually cancelled a still-pending timer. */
export function cancelTimer(db: Database, id: string, now: number): boolean {
  const res = db.prepare(
    `UPDATE conversation_timers SET cancelled_at = ?
      WHERE id = ? AND cancelled_at IS NULL AND fired_at IS NULL`,
  ).run(now, id);
  if (res.changes === 1) noteTimersChanged(getTimer(db, id)?.conversationId);
  return res.changes === 1;
}

/**
 * Claim-then-deliver, same philosophy as JobScheduler.drainDeferred: fired_at is
 * stamped BEFORE the prompt is dispatched, so a crash between claim and deliver
 * drops that one timer rather than double-firing it on the next poll.
 * Returns only the rows this call won.
 *
 * The SELECT→claim loop must stay synchronous (no await / setImmediate between
 * the SELECT and the per-row claim UPDATEs). updateTimer's CAS is only sound
 * against the sweep because nothing can interleave: an Express PATCH cannot
 * run between reading the pre-claim snapshot and stamping fired_at.
 */
export function claimDueTimers(db: Database, now: number): ConversationTimerWithAttachments[] {
  const rows = db.prepare(
    `SELECT * FROM conversation_timers
      WHERE fired_at IS NULL AND cancelled_at IS NULL AND fire_at_ms <= ?
      ORDER BY fire_at_ms ASC, rowid ASC`,
  ).all(now) as Row[];
  const claim = db.prepare(
    `UPDATE conversation_timers SET fired_at = ?
      WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL`,
  );
  const claimed: ConversationTimerWithAttachments[] = [];
  for (const r of rows) {
    if (claim.run(now, r.id).changes === 1) {
      claimed.push(toTimerWithAttachments({ ...r, fired_at: now }));
      noteTimersChanged(r.conversation_id);
    }
  }
  return claimed;
}

/** Post-claim failure note (profile gone, handlePrompt threw). Never un-fires. */
export function setTimerError(db: Database, id: string, error: string): void {
  db.prepare('UPDATE conversation_timers SET error = ? WHERE id = ?').run(error, id);
}

/** Agent Activity → Timed tab. Explicit columns: never the attachments blob
 *  (≤ 20 MiB/row) and never the full prompt — this is polled every 5 s.
 *  ponytail: hard cap + truncated flag; add a (fire_at_ms, id) cursor if a
 *  real install ever has > PENDING_TIMERS_LIST_CAP pending timers. */
export function listAllPendingTimerSummaries(db: Database, limit: number): { timers: PendingTimerSummary[]; truncated: boolean } {
  const rows = db.prepare(
    `SELECT t.id, t.conversation_id, c.title AS conversation_title, c.project_id, p.name AS project_name,
            substr(t.prompt, 1, ?) AS prompt_preview, length(t.prompt) > ? AS prompt_truncated,
            t.profile_id, t.fire_at_ms, t.created_at, t.origin
       FROM conversation_timers t
       JOIN conversations c ON c.id = t.conversation_id
       LEFT JOIN projects p ON p.id = c.project_id
      WHERE t.fired_at IS NULL AND t.cancelled_at IS NULL
      ORDER BY t.fire_at_ms ASC, t.rowid ASC
      LIMIT ?`,
  ).all(PENDING_TIMER_PREVIEW_CHARS, PENDING_TIMER_PREVIEW_CHARS, limit + 1) as Array<{
    id: string; conversation_id: string; conversation_title: string; project_id: string; project_name: string | null;
    prompt_preview: string; prompt_truncated: number; profile_id: string; fire_at_ms: number; created_at: number; origin: string;
  }>;
  return {
    truncated: rows.length > limit,
    timers: rows.slice(0, limit).map((r) => ({
      id: r.id, conversationId: r.conversation_id, conversationTitle: r.conversation_title,
      projectId: r.project_id, projectName: r.project_name,
      promptPreview: r.prompt_preview, promptTruncated: r.prompt_truncated === 1,
      profileId: r.profile_id, fireAtMs: r.fire_at_ms, createdAt: r.created_at,
      origin: r.origin as TimerOrigin,
    })),
  };
}

