import type { AgentStatus, RunStatus } from '@tierwyn/shared';

export type SelectedBadgeStatus = 'running' | 'waiting' | 'error' | 'done' | 'grey';
export type DotResult = { dotClass: string; title: string };

export function isLiveAgentStatus(s: AgentStatus | undefined): s is 'running' | 'waiting' {
  return s === 'running' || s === 'waiting';
}

/** Map schedule DB run lifecycle → agent-ish status for fallback only. */
export function runStatusToAgentFallback(runStatus: RunStatus): AgentStatus | undefined {
  switch (runStatus) {
    case 'running':
    case 'pending':
      return 'running';
    case 'failed':
    case 'timed_out':
      return 'error';
    case 'succeeded':
      return 'done';
    case 'skipped':
    default:
      return undefined; // grey via idle path
  }
}

/**
 * Run fallback that respects "viewed": a failed run stops being red once the
 * operator has opened its conversation after the run finished. Persisted via
 * `lastViewedAt`, so a refresh doesn't resurrect the dot.
 */
export function runFallbackStatus(
  run: { status: RunStatus; firedAt: number; finishedAt?: number },
  conv?: { lastViewedAt?: number },
): AgentStatus | undefined {
  const fb = runStatusToAgentFallback(run.status);
  if (fb === 'error' && (conv?.lastViewedAt ?? 0) >= (run.finishedAt ?? run.firedAt)) return undefined;
  return fb;
}

/**
 * Prefer live agent status over REST run lifecycle for past-run chips
 * (ScheduleBrowser). Shared with dots so colours can't drift.
 */
export function resolveRunChip(opts: {
  runStatus: RunStatus;
  liveStatus: AgentStatus | undefined;
}): { label: string; colorVar: string } {
  const live = opts.liveStatus;
  if (live === 'running') return { label: 'running', colorVar: 'var(--amber)' };
  if (live === 'waiting') return { label: 'waiting', colorVar: 'var(--amber)' };
  if (live === 'error') return { label: 'error', colorVar: 'var(--red)' };
  switch (opts.runStatus) {
    case 'running': return { label: 'running', colorVar: 'var(--amber)' };
    case 'succeeded': return { label: 'succeeded', colorVar: 'var(--green)' };
    case 'failed': return { label: 'failed', colorVar: 'var(--red)' };
    case 'timed_out': return { label: 'timed_out', colorVar: 'var(--red)' };
    case 'pending': return { label: 'pending', colorVar: 'var(--text-3)' };
    case 'skipped':
    default: return { label: opts.runStatus, colorVar: 'var(--text-3)' };
  }
}

/**
 * Single status-dot resolver for Projects rows, schedule run rows, spawn rows.
 * Priority (own activity always wins over descendants / unread):
 *   1. live agent status: running | waiting | error
 *   2. lastStatus sticky running | waiting | error (REST / run fallback;
 *      sticky error suppressed when errorRecovered)
 *   3. selectedBadgeStatus only for selected-row refinements that live map lacks
 *      (green "recently completed" pulse, manual unread while grey)
 *   4. descendant-active
 *   5. helpers-active (native CLI helpers still running; parent itself idle)
 *   6. unread → unreadClass ('unread' default for conversations, 'done' for
 *      schedule surfaces that opt into green)
 *   7. grey
 *
 * Non-selected rows MUST NOT depend on selectedBadgeStatus.
 * liveStatus is preferred over lastStatus and over runStatus fallback.
 */
export function resolveConversationDot(opts: {
  isSelected: boolean;
  selectedBadgeStatus?: SelectedBadgeStatus;
  manuallyMarkedUnread: boolean;
  liveStatus: AgentStatus | undefined;
  lastStatus: AgentStatus | undefined;
  isUnread: boolean;
  descendantActive: boolean;
  /** Native CLI helpers still running while this conversation itself is idle. */
  helpersActive?: boolean;
  /** A non-error status was observed for this conversation AFTER the REST
   *  snapshot that produced `lastStatus`. Suppresses the sticky error red.
   *  Never suppresses `liveStatus === 'error'` — a live failure is current
   *  truth, not a stale snapshot. */
  errorRecovered?: boolean;
  /** Which unread colour this surface uses. Conversations use 'unread'
   *  (sky blue); pass 'done' to keep a surface on the green schedule vocabulary. */
  unreadClass?: 'unread' | 'done';
}): DotResult {
  const {
    isSelected, selectedBadgeStatus, manuallyMarkedUnread,
    liveStatus, lastStatus,     isUnread, descendantActive, helpersActive,
    errorRecovered,
    unreadClass = 'unread',
  } = opts;

  // 1. Live agent status always wins (selected or not).
  if (liveStatus === 'running') return { dotClass: 'status-dot running', title: 'running' };
  if (liveStatus === 'waiting') return { dotClass: 'status-dot waiting', title: 'waiting' };
  if (liveStatus === 'error') return { dotClass: 'status-dot error', title: 'error' };

  // 2. Sticky lastStatus for active/error when live map is empty (REST / run fallback).
  if (lastStatus === 'running') return { dotClass: 'status-dot running', title: 'running' };
  if (lastStatus === 'waiting') return { dotClass: 'status-dot waiting', title: 'waiting' };
  if (lastStatus === 'error' && !errorRecovered) {
    return { dotClass: 'status-dot error', title: 'error' };
  }

  // 3. Selected-row refinements that the live map lacks (green pulse, mark-unread).
  //    Do NOT treat selectedBadge as a full replacement for running/waiting/error —
  //    that caused "stale until click" asymmetry vs non-selected rows.
  if (isSelected && selectedBadgeStatus) {
    if (manuallyMarkedUnread && selectedBadgeStatus === 'grey') {
      if (descendantActive) {
        return { dotClass: 'status-dot descendant-active', title: 'subagent active' };
      }
      if (helpersActive) {
        return { dotClass: 'status-dot helpers-active', title: 'helpers running' };
      }
      return { dotClass: `status-dot ${unreadClass}`, title: 'unread' };
    }
    if (descendantActive) {
      return { dotClass: 'status-dot descendant-active', title: 'subagent active' };
    }
    if (helpersActive) {
      return { dotClass: 'status-dot helpers-active', title: 'helpers running' };
    }
    if (manuallyMarkedUnread) {
      return { dotClass: `status-dot ${unreadClass}`, title: 'unread' };
    }
    if (selectedBadgeStatus === 'done') {
      // "just finished while you were watching" — temporal, stays green.
      return { dotClass: 'status-dot done', title: 'recent' };
    }
    // badge grey / other → fall through
  }

  // 4. Descendant activity (any depth spawn child live).
  if (descendantActive) {
    return { dotClass: 'status-dot descendant-active', title: 'subagent active' };
  }

  // 5. Native CLI helpers still running (parent itself is idle/done).
  if (helpersActive) {
    return { dotClass: 'status-dot helpers-active', title: 'helpers running' };
  }

  // 6. Unread / finished unviewed.
  if (isUnread) return { dotClass: `status-dot ${unreadClass}`, title: 'unread' };

  // 7. Idle.
  return { dotClass: 'status-dot grey', title: 'idle' };
}

/**
 * WS map first, then REST-hydrated liveStatus from list/tree load.
 *
 * Once the WS layer has observed a conversation (`wsObservedIds`), an absent
 * map entry means "not live" (done/idle/session_ended cleared it). Do **not**
 * fall back to REST `liveStatus` in that case — the list snapshot often still
 * says `running` for parked hold-open sessions after status:done, which left
 * the sidebar pulsing amber until a full page refresh.
 */
export function effectiveLiveStatus(
  conversationId: string | undefined | null,
  conversationStatuses: Record<string, AgentStatus>,
  conv?: { liveStatus?: AgentStatus },
  wsObservedIds?: ReadonlySet<string>,
): AgentStatus | undefined {
  const cid = conversationId ?? undefined;
  if (!cid) return undefined;
  if (Object.prototype.hasOwnProperty.call(conversationStatuses, cid)) {
    return conversationStatuses[cid];
  }
  if (wsObservedIds?.has(cid)) return undefined;
  return conv?.liveStatus;
}

/** True when any spawn descendant (any depth) is currently running/waiting. */
export function hasActiveDescendant(
  conversationId: string,
  childrenByParent: Map<string, { id: string; liveStatus?: AgentStatus }[]>,
  conversationStatuses: Record<string, AgentStatus>,
  wsObservedIds?: ReadonlySet<string>,
): boolean {
  const kids = childrenByParent.get(conversationId) ?? [];
  for (const k of kids) {
    if (isLiveAgentStatus(effectiveLiveStatus(k.id, conversationStatuses, k, wsObservedIds))) return true;
    if (hasActiveDescendant(k.id, childrenByParent, conversationStatuses, wsObservedIds)) return true;
  }
  return false;
}

/**
 * Aggregate status for a schedule job parent row from its runs + live map.
 * Reuses existing status-dot classes only.
 */
export function resolveJobAggregateDot(opts: {
  runs: Array<{ status: RunStatus; conversationId?: string | null; liveStatus?: AgentStatus }>;
  conversationStatuses: Record<string, AgentStatus>;
  /** Conversations the WS layer has observed — gates REST liveStatus fallback. */
  wsObservedConversationIds?: ReadonlySet<string>;
  /** Per run-conversation: unread or lastStatus done. */
  isRunUnread: (conversationId: string | undefined | null, runStatus: RunStatus) => boolean;
  /** Per run: any spawn descendant live under that run conversation. */
  isRunDescendantActive: (conversationId: string | undefined | null) => boolean;
  /** Job's enabled flag — an enabled job with no activity is "armed", not idle. */
  jobEnabled: boolean;
  /** Per run-conversation: a non-error status was seen after the REST snapshot,
   *  so a historical failed/timed_out run must not keep the parent red. */
  isRunErrorRecovered: (conversationId: string | undefined | null) => boolean;
}): DotResult {
  const {
    runs, conversationStatuses, wsObservedConversationIds,
    isRunUnread, isRunDescendantActive,
    jobEnabled, isRunErrorRecovered,
  } = opts;

  let anyError = false;
  let anyLive = false;
  let anyWaiting = false;
  let anyDesc = false;
  let anyDoneUnread = false;

  for (const run of runs) {
    const cid = run.conversationId ?? undefined;
    const live = effectiveLiveStatus(cid, conversationStatuses, run, wsObservedConversationIds);
    const unread = isRunUnread(cid, run.status);

    // Live agent error always; failed/timed_out only when still unviewed AND
    // not superseded by a later non-error turn on that run's conversation.
    if (live === 'error') anyError = true;
    else if (
      (run.status === 'failed' || run.status === 'timed_out')
      && unread
      && !isRunErrorRecovered(cid)
    ) {
      anyError = true;
    }

    if (live === 'waiting') anyWaiting = true;
    if (
      live === 'running'
      || live === 'waiting'
      || run.status === 'pending'
      || run.status === 'running'
    ) {
      anyLive = true;
    }
    if (isRunDescendantActive(cid)) anyDesc = true;
    // Green for unviewed activity on the job parent. Succeeded+unread always
    // counts. Failed/timed_out only counts once recovered (no longer red) so a
    // resumed failure doesn't drop the parent to armed-teal while the run row
    // still shows unread sky-blue underneath (adversary F2 / smoke M8).
    if (run.status === 'succeeded' && unread) anyDoneUnread = true;
    else if (unread && isRunErrorRecovered(cid)) anyDoneUnread = true;
    else if (unread && run.status !== 'failed' && run.status !== 'timed_out' && run.status !== 'skipped') {
      anyDoneUnread = true;
    }
  }

  if (anyError) return { dotClass: 'status-dot error', title: 'error' };
  if (anyWaiting) return { dotClass: 'status-dot waiting', title: 'waiting' };
  if (anyLive) return { dotClass: 'status-dot running', title: 'running' };
  if (anyDesc) return { dotClass: 'status-dot descendant-active', title: 'subagent active' };
  if (anyDoneUnread) return { dotClass: 'status-dot unread', title: 'unread' };
  // Resting states: an enabled job is "armed" (dedicated colour); a disabled
  // job stays grey and carries the separate `off` text badge in the sidebar.
  if (jobEnabled) return { dotClass: 'status-dot job-enabled', title: 'enabled' };
  return { dotClass: 'status-dot grey', title: 'disabled' };
}

/**
 * Map a schedule job aggregate (or any DotResult) onto the session-header pill.
 * Keeps the schedule view status pill in lockstep with the sidebar job-row dot.
 */
export type SessionBadgeFromDot = {
  /** CSS suffix for `.session-agent-badge.status-*` and `.status-dot`. */
  badgeClass:
    | 'running'
    | 'waiting'
    | 'error'
    | 'done'
    | 'unread'
    | 'grey'
    | 'disabled'
    | 'job-enabled'
    | 'descendant-active';
  label: string;
  inFlight: boolean;
};

export function sessionBadgeFromDot(dot: DotResult): SessionBadgeFromDot {
  const cls = dot.dotClass.replace(/^status-dot\s+/, '').trim();
  switch (cls) {
    case 'running':
      return { badgeClass: 'running', label: 'running', inFlight: true };
    case 'waiting':
      return { badgeClass: 'waiting', label: 'waiting', inFlight: true };
    case 'error':
      return { badgeClass: 'error', label: 'error', inFlight: false };
    case 'done':
      return { badgeClass: 'done', label: dot.title === 'unread' ? 'unread' : 'done', inFlight: false };
    case 'unread':
      return { badgeClass: 'unread', label: 'unread', inFlight: false };
    case 'job-enabled':
      return { badgeClass: 'job-enabled', label: 'enabled', inFlight: false };
    case 'descendant-active':
      return { badgeClass: 'descendant-active', label: 'subagent', inFlight: true };
    case 'grey':
      // Disabled job resting state — dedicated class so it is not the same green
      // as conversation "idle" (status-idle) or the same soft grey as chat idle.
      if (dot.title === 'disabled') {
        return { badgeClass: 'disabled', label: 'disabled', inFlight: false };
      }
      return { badgeClass: 'grey', label: dot.title || 'idle', inFlight: false };
    default:
      return {
        badgeClass: 'grey',
        label: dot.title || 'idle',
        inFlight: false,
      };
  }
}

/**
 * Session-header pill for a schedule job: same aggregate as the sidebar, but when
 * the job is **disabled** and not live/error, always show muted disabled grey —
 * never green idle/unread. Live runs (and errors) still surface while finishing.
 */
export function sessionBadgeForScheduleJob(
  dot: DotResult,
  jobEnabled: boolean,
): SessionBadgeFromDot {
  const badge = sessionBadgeFromDot(dot);
  if (jobEnabled) return badge;
  if (
    badge.badgeClass === 'running'
    || badge.badgeClass === 'waiting'
    || badge.badgeClass === 'error'
    || badge.badgeClass === 'descendant-active'
  ) {
    return badge;
  }
  return { badgeClass: 'disabled', label: 'disabled', inFlight: false };
}
