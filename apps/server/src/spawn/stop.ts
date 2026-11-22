import type { SpawnStopResponse } from '@tierwyn/shared';
import { getDb } from '../db/index.js';
import type { SessionManager } from '../sessionManager.js';
import {
  getConversation, isStopped, markStopped,
} from '../repositories/conversations.js';
import { getEdgeByChild, resolveSpawnEdge } from '../repositories/spawnEdges.js';
import { cancelPendingNonOperatorTimers } from '../repositories/conversationTimers.js';
import { listPendingForConversation, denySpawnRequest } from '../repositories/spawnRequests.js';
import { revokeMeshEdgesFor } from '../mesh/edges.js';
import { dropMailbox } from '../mesh/mailbox.js';
import { sessionHub } from '../sessionHub.js';
import { settleWatchersFor } from './watch.js';

export interface StopChildInput {
  childId: string;
  callerId: string;
  graceMs: number;
}

export const WRAP_UP_TEXT = (ms: number) =>
  `[tierwyn] Your parent has asked you to stop. Wrap up now: write a one-paragraph status of what you did and end your turn. You will be terminated in ${Math.round(ms / 1000)}s.`;

export const STOP_MARKER = (callerId: string, outcome: string) =>
  `◼ stopped-by-parent (${outcome}) by ${callerId}`;

const inflight = new Map<string, Promise<SpawnStopResponse>>();

export function stopChild(sm: SessionManager, input: StopChildInput): Promise<SpawnStopResponse> {
  const hit = inflight.get(input.childId);
  if (hit) return hit;
  const p = runStop(sm, input).finally(() => inflight.delete(input.childId));
  inflight.set(input.childId, p);
  return p;
}

async function pollUntil(fn: () => boolean, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return fn();
}

function denyPendingChildSpawnRequests(sm: SessionManager, childId: string): void {
  const db = getDb();
  for (const r of listPendingForConversation(db, childId)) {
    if (denySpawnRequest(db, r.id, 'requester stopped by parent', 'system')) {
      sessionHub.broadcastAll({ type: 'spawn_request_updated', conversationId: childId });
      sm.recordSpawnMarker(childId, {
        kind: 'denied',
        childConversationId: '',
        text: '✗ pending spawn request cancelled: requester stopped',
      });
    }
  }
}

function dropMesh(childId: string): void {
  revokeMeshEdgesFor(getDb(), childId);
  dropMailbox(childId);
}

function stoppedWatchResult(callerId: string, outcome: string) {
  return {
    prose: STOP_MARKER(callerId, outcome),
    degenerate: false,
    errored: false,
    stopped: true as const,
  };
}

async function runStop(sm: SessionManager, input: StopChildInput): Promise<SpawnStopResponse> {
  const { childId, callerId, graceMs } = input;
  const db = getDb();

  // S0 snapshot
  const live = sm.inFlightSessionForConversation(childId);
  const previousStatus = live?.lastStatus
    ?? sm.activeSessionForConversation(childId)?.lastStatus
    ?? (isStopped(db, childId) ? 'stopped' : 'idle');

  let outcome: SpawnStopResponse['stopped'] = live ? 'killed' : 'already-stopped';
  let wrapUpDelivered = false;
  let won = false;

  if (live && graceMs > 0) {
    // S1 grace
    const wrapUp = WRAP_UP_TEXT(graceMs);
    const r = await sm.steerSession(live.id, wrapUp);
    wrapUpDelivered = r.mode === 'injected';
    if (r.mode === 'queued') {
      const item = sm.getSession(live.id)?.steerQueue.find((q) => q.text === wrapUp);
      if (item) await sm.cancelSteerMessage(childId, live.id, item.id);
    }
    const settled = await pollUntil(() => !sm.inFlightSessionForConversation(childId), graceMs, 100);
    if (settled) {
      outcome = 'settled-naturally';
    }
  } else if (!live) {
    outcome = 'already-stopped';
  }

  if (outcome === 'killed' && live) {
    // S2 claim
    const edge = getEdgeByChild(db, childId);
    won = !!edge && edge.status === 'open' && resolveSpawnEdge(db, edge.id, 'interrupted', 'stopped');
    dropMesh(childId);
    settleWatchersFor(childId, stoppedWatchResult(callerId, outcome));

    // S3 kill
    const stopResult = await sm.stopSession(live.id);
    if (!stopResult.stopped && stopResult.reason === 'error') {
      console.warn(`[spawn/stop] stopSession(${live.id}) failed: ${stopResult.message ?? 'error'}`);
    }
  }

  // S4 common side effects
  await sm.reapParkedSessions(childId, { all: true });
  const timerCancelled = cancelPendingNonOperatorTimers(db, childId, Date.now()) > 0;
  denyPendingChildSpawnRequests(sm, childId);

  const edge = getEdgeByChild(db, childId);
  if (outcome !== 'settled-naturally' && !won) {
    won = !!edge && edge.status === 'open' && resolveSpawnEdge(db, edge.id, 'interrupted', 'stopped');
    if (won) settleWatchersFor(childId, stoppedWatchResult(callerId, outcome));
  }
  if (outcome !== 'killed') dropMesh(childId);

  const notifyFired = won && !!edge?.notifyParent;
  if (notifyFired && edge) {
    const who = edge.role ?? 'agent';
    sm.notifyParentSubagentResult(
      edge.parentConversationId,
      `◼ stopped-by-parent: Sub-agent (${who}) was stopped by ${callerId} (${outcome}; grace ${graceMs}ms). `
        + `Partial transcript: GET /spawn/${childId}/result?parentConversationId=${edge.parentConversationId}`,
      { role: who, childConversationId: childId },
    );
  }

  const markerText = STOP_MARKER(callerId, outcome);
  const who = edge?.role ?? 'agent';
  const parentId = edge?.parentConversationId ?? callerId;
  const childTitle = getConversation(db, childId)?.title;
  sm.recordSpawnMarker(parentId, {
    kind: 'stopped',
    childConversationId: childId,
    childTitle,
    text: markerText,
    role: who,
  });
  sm.recordSpawnMarker(childId, {
    kind: 'stopped',
    childConversationId: childId,
    text: markerText,
  });

  markStopped(db, childId, Date.now());

  return {
    ok: true,
    childId,
    previousStatus,
    stopped: outcome,
    alreadyStopped: outcome === 'already-stopped',
    notifyFired,
    timerCancelled,
    wrapUpDelivered,
  };
}
