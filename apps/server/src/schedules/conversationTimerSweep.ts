import type { Database } from 'better-sqlite3';
import type {
  AgentProfile, EffortLevel, PromptAttachment, PromptOptions, SubagentNotifyMeta, TimerHandoffOverride,
} from '@tierwyn/shared';
import { clampEffort, sanitisePromptOptions } from '@tierwyn/shared';
import { catalogue } from '../catalogue.js';
import { getConversation } from '../repositories/conversations.js';
import { lastSessionForConversation } from '../repositories/sessions.js';
import { getCompactionSettings } from '../repositories/settings.js';
import { claimDueTimers, setTimerError } from '../repositories/conversationTimers.js';
import { getEdgeByChild } from '../repositories/spawnEdges.js';

/** The subset of SessionManager.PromptInput a timer needs. Every snapshot field
 *  is optional and SPREAD conditionally — an explicit `undefined` would make the
 *  parked-session adoption checks in handlePrompt read as "options were set". */
export interface TimerPromptInput {
  projectId: string;
  conversationId: string;
  agent: string;
  model: string;
  profileId: string;
  text: string;
  attachments?: PromptAttachment[];
  effort?: EffortLevel;
  options?: PromptOptions;
  handoffOverride?: TimerHandoffOverride;
  /** [S1-2] Deferred (non-operator) delivery of a spawned child runs as a
   *  parent-sourced turn so the result bridges back up the spawn tree. */
  source?: 'parent_message';
  subagent?: SubagentNotifyMeta;
  interactionMode?: 'bypass' | 'questions' | 'prompt';
}

export interface ConversationTimerSweepDeps {
  getDb: () => Database;
  /** Injected so tests never touch a real adapter. Wired to sessionManager.handlePrompt. */
  handlePrompt: (input: TimerPromptInput) => Promise<unknown>;
  /** Injected in tests; defaults to the live catalogue. */
  getProfile?: (profileId: string) => AgentProfile | undefined;
  onPendingHandoffConsumed?: (conversationId: string) => void;
}

/**
 * Deliver due conversation timers. Called once at the end of JobScheduler.tickOnce
 * (5s poll) — NOT on its own interval.
 *
 * Contract:
 *  - claim-before-deliver: claimDueTimers stamps fired_at first, so a crash
 *    between claim and dispatch DROPS that timer rather than double-firing it.
 *  - delivery is the operator-send path (handlePrompt). No liveness branching:
 *    handlePrompt itself steers an in-flight session, adopts a parked one, or
 *    starts a new one, exactly as it does for a typed message.
 *  - never throws: a bad timer must not stall the schedule tick loop.
 *  - never await turn-end: handlePrompt may stay pending for a hold-open child
 *    (hold-open sendPrompt resolves on child.close). Kick delivery and move on
 *    so the next JobScheduler tick can claim other due timers.
 */

/** Snapshot wins. Otherwise, a cross-agent fire under handoffMode 'prompt'
 *  (the client-modal setting) defaults to summary — timers have no UI to pick.
 *  A same-agent model change keeps native resume. */
function resolveTimerHandoffOverride(
  db: Database,
  timer: { conversationId: string; profileId: string; agentType: string; handoffOverride: TimerHandoffOverride | null; origin?: string },
): TimerHandoffOverride | undefined {
  if (timer.origin !== 'operator' && timer.handoffOverride) return timer.handoffOverride;
  const last = lastSessionForConversation(db, timer.conversationId);
  // Same profile at fire time (switch no longer exists): a stale snapshot must
  // not force a Handover or stop a live turn.
  if (last?.agentModelId === timer.profileId) return undefined;
  if (timer.handoffOverride) return timer.handoffOverride;
  if (!last?.agentModelId || last.agentId === timer.agentType) return undefined;
  return getCompactionSettings(db).handoffMode === 'prompt' ? 'summary' : undefined;
}

export function createConversationTimerSweep(
  deps: ConversationTimerSweepDeps,
): (now: number) => Promise<void> {
  const getProfile = deps.getProfile ?? ((id: string) => catalogue.getProfile(id));

  return async function sweepConversationTimers(now: number): Promise<void> {
    const db = deps.getDb();
    const due = claimDueTimers(db, now);
    for (const timer of due) {
      try {
        const conversation = getConversation(db, timer.conversationId);
        if (!conversation) {
          setTimerError(db, timer.id, 'conversation no longer exists');
          continue;
        }
        const profile = getProfile(timer.profileId);
        if (!profile || !profile.enabled) {
          setTimerError(db, timer.id, `profile unavailable: ${timer.profileId}`);
          continue;
        }
        const effort = clampEffort(profile.agentType, timer.effort ?? undefined);
        // A snapshot sanitised at create time can still fail here if the
        // adapter's descriptor set changed under it. Dropping the options and
        // sending the prompt plain beats refusing to fire at all.
        let options: PromptOptions | undefined;
        try {
          options = sanitisePromptOptions(profile.agentType, timer.options);
        } catch (e) {
          console.warn(
            `[timers] dropping unusable options snapshot for ${timer.id}:`,
            e instanceof Error ? e.message : String(e),
          );
        }
        let handoffOverride = resolveTimerHandoffOverride(db, { ...timer, agentType: profile.agentType });
        const staged = timer.origin !== 'operator' ? getConversation(db, timer.conversationId)?.pendingHandoffMode : undefined;
        if (!handoffOverride && staged) handoffOverride = staged;
        if (staged) deps.onPendingHandoffConsumed?.(timer.conversationId);
        // [S1-2] agent-resume / auto-resume on a spawned child: parent-sourced turn
        // so the result bridges up. agent-self is the child waking ITSELF — the
        // parent never asked for it, so no upward relay; it still runs bypass
        // because children always do (and a bypass-only adapter would otherwise be
        // rejected under a non-bypass global mode). Operator timers: plain send.
        const edge = timer.origin !== 'operator' ? getEdgeByChild(db, timer.conversationId) : undefined;
        const relayUp = !!edge && timer.origin !== 'agent-self';
        void deps.handlePrompt({
          projectId: conversation.projectId,
          conversationId: timer.conversationId,
          agent: profile.agentType,
          model: profile.model,
          profileId: timer.profileId,
          text: timer.prompt,
          ...(timer.attachments.length > 0 ? { attachments: timer.attachments } : {}),
          ...(effort ? { effort } : {}),
          ...(options ? { options } : {}),
          ...(handoffOverride ? { handoffOverride } : {}),
          ...(relayUp && edge ? {
            source: 'parent_message' as const,
            subagent: {
              role: edge.role ?? undefined,
              childConversationId: timer.conversationId,
              replyTo: edge.parentConversationId,
              ...(timer.notifyParent !== null ? { notify: timer.notifyParent } : {}),
            },
            interactionMode: 'bypass' as const,
          } : edge ? { interactionMode: 'bypass' as const } : {}),
        }).catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          console.warn(`[timers] delivery failed for ${timer.id}:`, message);
          try { setTimerError(db, timer.id, message); } catch { /* DB gone — nothing to do */ }
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[timers] delivery failed for ${timer.id}:`, message);
        try { setTimerError(db, timer.id, message); } catch { /* DB gone — nothing to do */ }
      }
    }
  };
}
