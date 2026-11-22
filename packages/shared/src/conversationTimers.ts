/**
 * Per-conversation prompt timers: a prompt scheduled to be delivered back into
 * its OWN conversation at a future moment, exactly as if the operator had typed
 * it. NOT a schedule_jobs row — timers never appear in the Schedules tab.
 */

import type { PromptAttachment } from './events.js';
import type { PromptOptions } from './promptOptions.js';
import type { EffortLevel } from './profiles.js';
import type { HandoffOverride } from './domain.js';

/** Floor on any timer delay. v2 raised this from 5s: the In… clock has no
 *  seconds segment, so sub-minute delays are unreachable from the UI and only
 *  ever arrived from hand-rolled POSTs. */
export const TIMER_MIN_DELAY_MS = 60_000;
/** Ceiling on any timer delay: 7 days. */
export const TIMER_MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
/** ponytail: generous cap well under the 25mb express.json limit; raise if a real prompt ever hits it. */
export const TIMER_MAX_PROMPT_CHARS = 100_000;
/** Tier 1: an AGENT-created resume timer may defer at most 8 hours. Operator
 *  timers keep the full 7-day TIMER_MAX_DELAY_MS ceiling. */
export const AGENT_DEFER_MAX_MS = 8 * 60 * 60 * 1000;

export type TimerOrigin = 'operator' | 'agent-resume' | 'auto-resume' | 'agent-self';

export interface ConversationTimer {
  id: string;
  conversationId: string;
  /** Verbatim operator text, delivered unchanged at fire time. */
  prompt: string;
  /** Catalogue profile snapshot taken at create time (composer selection). */
  profileId: string;
  fireAtMs: number;
  createdAt: number;
  cancelledAt: number | null;
  /** Stamped by the sweep BEFORE delivery — at-most-once, never at-least-once. */
  firedAt: number | null;
  /** Set when delivery failed after the claim (profile gone, handlePrompt threw). */
  error: string | null;
  /** Effective EffortLevel snapshotted at schedule time; null = send no flag. */
  effort: EffortLevel | null;
  /** Sanitised PromptOptions snapshotted at schedule time; null = none. */
  options: PromptOptions | null;
  /** Names only. Bodies stay in SQLite — the chip poll must never carry base64. */
  attachmentNames: string[];
  /** Operator's Summarize/Transcript pick when the handoff predicate was true
   *  at create time; null when it was not. Applied server-side at fire — the
   *  operator is not around to answer a modal. */
  handoffOverride: TimerHandoffOverride | null;
  /** Who scheduled this: the operator (chip), an agent deferring its own resume
   *  (Tier 1 usage-limit recovery), or the server's auto-resume sweep. */
  origin: TimerOrigin;
  /** Resume attempt counter for non-operator origins; 1 = first deferral. */
  attempt: number;
  /** Per-timer override of spawn_edges.notifyParent for deferred descent
   *  messages. null = inherit the edge at fire time; true/false = force. */
  notifyParent: boolean | null;
}


export type TimerHandoffOverride = HandoffOverride;

/** Fire-time view: the DTO plus the attachment bodies. Produced only by
 *  claimDueTimers — never serialised to a client. */
export interface ConversationTimerWithAttachments extends ConversationTimer {
  attachments: PromptAttachment[];
}

export interface CreateConversationTimerRequest {
  prompt: string;
  profileId: string;
  /** Relative delay. Exactly one of fireInMs / fireAtMs. */
  fireInMs?: number;
  /** Absolute epoch ms. Exactly one of fireInMs / fireAtMs. */
  fireAtMs?: number;
  /** Effective effort at schedule time. Re-clamped server-side against the
   *  TIMER's profile; an unsupported level is dropped, not rejected. */
  effort?: EffortLevel;
  /** Staged composer options. Re-sanitised server-side; omit / {} = none. */
  options?: PromptOptions;
  /** Persistable (base64) composer attachments. Draft caps apply. */
  attachments?: PromptAttachment[];
  /** Summarize vs full transcript, decided in the modal. */
  handoffOverride?: TimerHandoffOverride | null;
}

/** Partial update of a pending timer. Every field is optional; an omitted field
 *  is unchanged. `attachments` is omitted by the UI on purpose — the client
 *  never holds the bodies (see attachmentNames), so it cannot faithfully
 *  replace them. Sending it replaces the whole set. */
export interface UpdateConversationTimerRequest {
  prompt?: string;
  profileId?: string;
  /** At most one of fireInMs / fireAtMs. Neither = leave fire time alone. */
  fireInMs?: number;
  fireAtMs?: number;
  /** null clears the stored value; omitted leaves it. */
  effort?: EffortLevel | null;
  options?: PromptOptions | null;
  attachments?: PromptAttachment[];
  handoffOverride?: TimerHandoffOverride | null;
}

export interface ConversationTimerResponse { timer: ConversationTimer }
export interface ConversationTimersResponse { timers: ConversationTimer[] }

export type ResolveTimerFireAtResult =
  | { ok: true; fireAtMs: number }
  | { ok: false; error: string };

function isSaneInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n);
}

/**
 * fireInMs XOR fireAtMs → absolute epoch ms, bounds-checked.
 * Same exclusivity shape as the agent schedule-create validator.
 */
export function resolveTimerFireAt(input: {
  fireInMs?: number;
  fireAtMs?: number;
  now: number;
}): ResolveTimerFireAtResult {
  const hasIn = input.fireInMs !== undefined;
  const hasAt = input.fireAtMs !== undefined;
  if (hasIn === hasAt) {
    return { ok: false, error: 'exactly one of fireInMs or fireAtMs is required' };
  }
  const fireAtMs = hasIn ? input.now + (input.fireInMs as number) : (input.fireAtMs as number);
  if (!isSaneInt(hasIn ? input.fireInMs : input.fireAtMs) || !isSaneInt(fireAtMs)) {
    return { ok: false, error: 'fireInMs / fireAtMs must be an integer number of milliseconds' };
  }
  const delay = fireAtMs - input.now;
  if (delay < TIMER_MIN_DELAY_MS) {
    return { ok: false, error: `timer must fire at least 1 minute from now` };
  }
  if (delay > TIMER_MAX_DELAY_MS) {
    return { ok: false, error: `timer must fire at most ${TIMER_MAX_DELAY_MS / 86_400_000} days from now` };
  }
  return { ok: true, fireAtMs };
}

export type AgentSelfTimersMode = 'level0' | 'all' | 'off';

export interface CreateAgentSelfTimerRequest {
  text: string;
  fireInMs?: number;
  fireAtMs?: number;
}
export interface CreateAgentSelfTimerResponse { ok: true; timer: ConversationTimer }

export interface PendingTimerSummary {
  id: string;
  conversationId: string;
  conversationTitle: string;
  projectId: string;
  projectName: string | null;
  promptPreview: string;
  promptTruncated: boolean;
  profileId: string;
  fireAtMs: number;
  createdAt: number;
  origin: TimerOrigin;
}
export interface PendingTimersResponse { now: number; truncated: boolean; timers: PendingTimerSummary[] }

export const PENDING_TIMERS_LIST_CAP = 200;
export const PENDING_TIMER_PREVIEW_CHARS = 500;

export function agentDeferCapError(delayMs: number, maxDeferMs: number): { error: string; maxDeferMs: number } | null {
  if (maxDeferMs <= 0) return { error: 'agent deferral is disabled', maxDeferMs: 0 };
  if (delayMs <= maxDeferMs) return null;
  const requestedH = Math.round(delayMs / 3_600_000);
  const capH = Math.round(maxDeferMs / 3_600_000);
  return {
    error: `deferral exceeds the ${capH}h agent cap (requested ${requestedH}h). A weekly or monthly limit is an operator decision — surface it to the operator instead of waiting.`,
    maxDeferMs,
  };
}

export function selfTimerAllowed(mode: AgentSelfTimersMode, isRoot: boolean): boolean {
  return mode === 'all' || (mode === 'level0' && isRoot);
}

