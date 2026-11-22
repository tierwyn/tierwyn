import type { SessionManager } from '../sessionManager.js';
import { getDb } from '../db/index.js';
import { getConversation, isDescendedFrom } from '../repositories/conversations.js';
import { lastSessionForConversation } from '../repositories/sessions.js';
import { catalogue } from '../catalogue.js';
import type { MeshAuditDecision } from './edges.js';
import { queuePeerMessage, dropMailbox } from './mailbox.js';

export type LateralDelivery = {
  decision: Extract<MeshAuditDecision,
    'allowed_steer' | 'deferred_pending' | 'delivered_new_turn' | 'dropped_no_session'>;
  delivered: 'steered' | 'deferred' | 'new_turn' | 'dropped';
};

/**
 * Steer if live+injectable; defer if live but not steerable; wake as a new
 * turn if idle; drop if the profile is gone. Never block the sender.
 * Framing happens in the route, once, before this is called.
 */
export async function deliverLateral(
  sessionManager: SessionManager,
  targetConversationId: string,
  text: string,
  meta: { replyTo: string; role?: string; edgeId?: string; hop: number; bytes: number },
): Promise<LateralDelivery> {
  const subagent = {
    role: meta.role,
    childConversationId: targetConversationId,
    replyTo: meta.replyTo,
  };
  const live = sessionManager.inFlightSessionForConversation(targetConversationId);
  if (live && sessionManager.isInjectable(live.id)) {
    await sessionManager.steerSession(live.id, text, undefined, { source: 'peer_message', subagent });
    return { decision: 'allowed_steer', delivered: 'steered' };
  }
  if (live) {
    // D4 REVERSED. Was: stopSession + wake. Killing a peer's
    // running turn to deliver prose is lossy — files already written stay
    // written, the rest of the plan dies with the subprocess, and the
    // replacement turn pays a compaction handoff. A peer could trigger that
    // 6x/min. Hold instead; sessionManager.cleanup flushes at session end.
    queuePeerMessage(targetConversationId, {
      text, replyTo: meta.replyTo, role: meta.role,
      edgeId: meta.edgeId, hop: meta.hop, bytes: meta.bytes,
    });
    return { decision: 'deferred_pending', delivered: 'deferred' };
  }
  const woke = await wakeAsNewTurn(sessionManager, targetConversationId, text, subagent);
  if (!woke) {
    dropMailbox(targetConversationId);
    return { decision: 'dropped_no_session', delivered: 'dropped' };
  }
  return { decision: 'delivered_new_turn', delivered: 'new_turn' };
}

async function wakeAsNewTurn(
  sessionManager: SessionManager,
  targetConversationId: string,
  text: string,
  subagent: { role?: string; childConversationId: string; replyTo: string },
): Promise<boolean> {
  const db = getDb();
  const target = getConversation(db, targetConversationId);
  const last = lastSessionForConversation(db, targetConversationId);
  if (!target || !last?.agentId || !last.agentModelId) return false;
  const profile = catalogue.getProfile(last.agentModelId);
  if (!profile?.enabled || profile.agentType !== last.agentId) return false;
  await sessionManager.reapParkedSessions(targetConversationId);
  // Bypass only when the target is strictly below the sender. Siblings and
  // (D8) the sender's parent keep the target's own interactionMode — pinning
  // bypass here was copied from messageDescendant, whose targets are always children.
  const downward = isDescendedFrom(db, targetConversationId, subagent.replyTo);
  await sessionManager.handlePrompt({
    projectId: target.projectId,
    conversationId: targetConversationId,
    agent: last.agentId,
    model: profile.model,
    profileId: last.agentModelId,
    text,
    source: 'peer_message',
    subagent,
    interactionMode: downward ? 'bypass' : undefined,
  });
  return true;
}
