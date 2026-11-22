import type { Database } from 'better-sqlite3';
import type { PromptAttachment, TranscriptEvent } from '@tierwyn/shared';
import { listEventsForSession } from '../repositories/events.js';

/** Max images re-forwarded on cross-agent handoff (deduped, chronological). */
const MAX_HANDOFF_IMAGES = 20;

function attachmentKey(a: Pick<PromptAttachment, 'base64' | 'mediaType'>): string {
  return `${a.mediaType}:${a.base64.length}:${a.base64.slice(0, 32)}`;
}

/** Collect image attachments from prior user prompts in the handoff event window.
 *  Text transcripts/summaries omit binary payloads — this restores them for the
 *  receiving vision-capable adapter. */
export function collectHandoffAttachments(events: TranscriptEvent[]): PromptAttachment[] {
  const seen = new Set<string>();
  const out: PromptAttachment[] = [];
  for (const e of events) {
    if (e.type !== 'prompt') continue;
    const atts = (e.payload as { attachments?: PromptAttachment[] }).attachments;
    if (!atts?.length) continue;
    for (const a of atts) {
      if (!a.mediaType?.toLowerCase().startsWith('image/')) continue;
      if (!a.base64) continue;
      const key = attachmentKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ base64: a.base64, mediaType: a.mediaType, name: a.name });
      if (out.length >= MAX_HANDOFF_IMAGES) return out;
    }
  }
  return out;
}

/** Prior-turn images plus the current handoff prompt (persisted on the excluded
 *  session row before buildResumePlan runs). */
export function collectAllHandoffAttachments(
  priorEvents: TranscriptEvent[],
  db: Database,
  currentSessionId?: string,
): PromptAttachment[] {
  const prior = collectHandoffAttachments(priorEvents);
  if (!currentSessionId) return prior;
  const currentPrompts = listEventsForSession(db, currentSessionId)
    .filter((e) => e.type === 'prompt');
  return mergePromptAttachments(prior, collectHandoffAttachments(currentPrompts));
}

/** Merge attachment groups in order, dropping exact duplicates (by base64 head). */
export function mergePromptAttachments(
  ...groups: (readonly PromptAttachment[] | undefined)[]
): PromptAttachment[] {
  const seen = new Set<string>();
  const out: PromptAttachment[] = [];
  for (const group of groups) {
    for (const a of group ?? []) {
      if (!a.base64) continue;
      const key = attachmentKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}
