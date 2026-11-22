import type { Database } from 'better-sqlite3';
import { enabledTagCatalogue, MAX_TAGS, mergeAutoTags, pickAutoTags, type ServerFrame } from '@tierwyn/shared';
import { decide, type Question } from './decide.js';
import { getConversation, updateConversationTags } from './repositories/conversations.js';
import { getDecisionSettings, getTagCatalogueSettings } from './repositories/settings.js';

/** Test seam, like interruptDeps / decideDeps. */
export const autoTagDeps = { decide };

export const AUTOTAG_THRESHOLD = 0.7;
export const AUTOTAG_MAX_APPLIED = 3;
export const AUTOTAG_MIN_PROMPTS = 3;
/** Detached path (nobody waits) with ~25 questions per call; same budget as the Test probe. */
export const AUTOTAG_TIMEOUT_MS = 5000;

// ponytail: SQL count mirrors isEligibleUserPrompt (no commands, operator-sourced only) without
// loading every event row per `done`. It skips the "non-empty text after envelope strip" nuance,
// so a blank prompt counts as a turn — harmless.
export function countUserPrompts(db: Database, conversationId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?
        AND e.type = 'prompt'
        AND json_extract(e.payload, '$.commandName') IS NULL
        AND COALESCE(json_extract(e.payload, '$.source'), 'user') = 'user'`,
  ).get(conversationId) as { n: number };
  return row.n;
}

interface GateRow {
  auto_tagged_at: number | null;
  description: string | null;
  parent_conversation_id: string | null;
  schedule_job_id: string | null;
  kind: string | null;
}

/**
 * Jev auto-tagging, once per conversation. Called detached on every `done`; the cheap gates make
 * re-checks free until it fires. Fail-closed: any error, null verdict or missing gate changes
 * nothing and never throws.
 */
export async function autoTagConversationIfDue(
  db: Database,
  conversationId: string,
  broadcastAll?: (frame: ServerFrame) => void,
): Promise<void> {
  try {
    const settings = getDecisionSettings(db);
    if (!settings.enabled || !settings.apiKey || !settings.autoTagEnabled) return;

    const row = db.prepare(
      `SELECT auto_tagged_at, description, parent_conversation_id, schedule_job_id, kind
         FROM conversations WHERE id = ?`,
    ).get(conversationId) as GateRow | undefined;
    // ponytail: root chats only — spawn children and schedule runs are machine-driven and not worth a
    // billed call each. Add `AND project is not system` here if Remote Agents containers should be skipped.
    if (
      !row || row.auto_tagged_at !== null || !row.description?.trim()
      || row.parent_conversation_id !== null || row.schedule_job_id !== null
      || (row.kind ?? 'chat') !== 'chat'
    ) return;
    // Not marked: later turns retry once enough prompts exist.
    if (countUserPrompts(db, conversationId) < AUTOTAG_MIN_PROMPTS) return;

    const catalogue = enabledTagCatalogue(getTagCatalogueSettings(db));

    // ponytail: claim before the call so racing `done`s make exactly one request; release on a null
    // verdict so a TypeSafe blip doesn't burn the one shot. Ceiling: one failed 5 s call per turn
    // while TypeSafe is down — add an attempt-counter column if that ever matters.
    const claim = db.prepare(
      'UPDATE conversations SET auto_tagged_at = ? WHERE id = ? AND auto_tagged_at IS NULL',
    ).run(Date.now(), conversationId);
    if (claim.changes !== 1) return;

    const conv = getConversation(db, conversationId);
    if (!conv) return;
    if (catalogue.length === 0 || (conv.tags ?? []).length >= MAX_TAGS) {
      console.log(`[autotag] conversation=${conversationId} skipped=${catalogue.length === 0 ? 'no-catalogue' : 'full'}`);
      return;
    }

    const questions: Record<string, Question> = {};
    catalogue.forEach((c, i) => {
      questions[`t${i}`] = {
        type: 'noul',
        instructions: `Should this conversation be tagged "${c.tag}"?`,
        criteria: { true: c.hint, false: 'The conversation is not mainly about this.' },
      };
    });
    const state = { title: conv.title.slice(0, 120), description: (conv.description ?? '').slice(0, 200) };

    let result: Awaited<ReturnType<typeof decide>> = null;
    try {
      result = await autoTagDeps.decide(state, questions, {
        settings, timeoutMs: AUTOTAG_TIMEOUT_MS, consumer: 'autotag', conversationId,
      });
    } catch { /* treated as a null verdict */ }
    if (!result) {
      db.prepare('UPDATE conversations SET auto_tagged_at = NULL WHERE id = ?').run(conversationId);
      return;
    }

    const picked = pickAutoTags(catalogue, result.answers, AUTOTAG_THRESHOLD, AUTOTAG_MAX_APPLIED);
    // One synchronous transaction after the await: a PATCH that landed meanwhile is already
    // committed, so the merge sees it and never clobbers it.
    const written = db.transaction((): { tags: string[]; added: number } | undefined => {
      const cur = getConversation(db, conversationId);
      if (!cur) return undefined;
      const before = cur.tags ?? [];
      const merged = mergeAutoTags(before, picked);
      if (merged.length === before.length) return undefined;
      updateConversationTags(db, conversationId, merged);
      return { tags: merged, added: merged.length - before.length };
    })();
    if (written) {
      broadcastAll?.({ type: 'conversation_updated', conversationId, ts: Date.now(), tags: written.tags });
    }
    console.log(`[autotag] conversation=${conversationId} asked=${catalogue.length} applied=${written?.added ?? 0}`);
  } catch (err) {
    // Content-free: the message could quote SQL or state.
    console.warn(`[autotag] conversation=${conversationId} failed: ${err instanceof Error ? err.name : 'error'}`);
  }
}
