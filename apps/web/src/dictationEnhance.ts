import type { DraftProcessing } from '@tierwyn/shared';

export interface PendingContextEnhance {
  conversationId: string;
  baselineText: string;
}

/** Fire the auto-enhance after a Slow-Yes clip lands in the draft.
 *  Re-entry is prevented by nulling `pending` before POST /enhance — not by
 *  requiring a transcribing→idle edge. That edge is missed when the freeze
 *  frame never lands; the voice strip still looks busy via local upload. */
export function shouldKickContextEnhance(args: {
  pending: PendingContextEnhance | null;
  prev: DraftProcessing;
  next: DraftProcessing;
  conversationId: string | null;
  text: string;
}): boolean {
  const { pending, prev, next, conversationId, text } = args;
  if (!pending) return false;
  if (pending.conversationId !== conversationId) return false;
  if (next !== 'idle') return false;
  // Enhance settle is also idle; do not chain a second kick off that edge.
  if (prev === 'enhancing') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === pending.baselineText.trim()) return false;
  return true;
}

/** Slow dictation choice. Stored in the legacy boolean key
 *  `tierwyn.voice.slowEnhanceContext`: 'false' | 'true' | 'project'. */
export type SlowEnhanceChoice = 'cleanup' | 'context' | 'project';

/** Modal row order (top to bottom). */
export const SLOW_ENHANCE_ORDER: readonly SlowEnhanceChoice[] = ['project', 'context', 'cleanup'];

export function parseSlowEnhanceChoice(raw: string | null): SlowEnhanceChoice {
  return raw === 'project' ? 'project' : raw === 'true' ? 'context' : 'cleanup';
}

export function serialiseSlowEnhanceChoice(c: SlowEnhanceChoice): string {
  return c === 'project' ? 'project' : c === 'context' ? 'true' : 'false';
}

/** useWhisperInput.toggle() opts. Never sets both enhance flags. */
export function slowEnhanceToggleOpts(c: SlowEnhanceChoice):
  { skipCleanup: boolean; enhanceContext?: true; enhanceProject?: true } {
  if (c === 'project') return { skipCleanup: true, enhanceProject: true };
  if (c === 'context') return { skipCleanup: true, enhanceContext: true };
  return { skipCleanup: false };
}

export function enabledSlowChoices(a: { contextAvailable: boolean; projectAvailable: boolean }): SlowEnhanceChoice[] {
  return SLOW_ENHANCE_ORDER.filter((c) =>
    c === 'cleanup' || (c === 'context' ? a.contextAvailable : a.projectAvailable));
}

export function initialSlowChoice(pref: SlowEnhanceChoice, enabled: readonly SlowEnhanceChoice[]): SlowEnhanceChoice {
  return enabled.includes(pref) ? pref : 'cleanup';
}

export function cycleSlowChoice(
  current: SlowEnhanceChoice, dir: 1 | -1, enabled: readonly SlowEnhanceChoice[],
): SlowEnhanceChoice {
  if (enabled.length === 0) return 'cleanup';
  const i = enabled.indexOf(current);
  if (i < 0) return enabled[0]!;
  return enabled[(i + dir + enabled.length) % enabled.length]!;
}
