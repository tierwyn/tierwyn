import type { NormalisedEvent } from '@tierwyn/shared';
import type { PromptTurn } from './groupTurns.js';

/** Minimum cumulative waiting time to display the "Waiting for you" segment in the elapsed bar. */
export const WAITING_DISPLAY_THRESHOLD_MS = 30_000;

/** A turn has settled once a done/error/idle status lands; the gap that follows (often hours,
 *  until the session is parked and emits a late `idle`) is neither worked nor waiting. */
function isSettled(e: NormalisedEvent): boolean {
  if (e.type !== 'status') return false;
  const s = e.payload?.status;
  return s === 'done' || s === 'error' || s === 'idle';
}

/** Prompt-to-latest-event duration for one turn, minus time spent blocked on an
 *  unresolved `interaction_request` (question / approval card waiting on the operator).
 *  `liveNow` extends an in-flight turn unless it is currently blocked. */
export function turnElapsedMs(turn: PromptTurn, liveNow?: number): number | null {
  const start = turn.prompt?.event.ts;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  let worked = 0;
  let prev = start;
  let pending = 0;
  let settled = false;
  for (const m of turn.events) {
    if (m.event.type === 'helper') continue;
    const ts = m.event.ts;
    if (!Number.isFinite(ts)) continue;
    if (ts > prev) {
      if (pending === 0 && !settled) worked += ts - prev;
      prev = ts;
    }
    settled = isSettled(m.event);
    if (m.event.type === 'interaction_request') pending++;
    else if (m.event.type === 'interaction_resolved' && pending > 0) pending--;
  }
  if (typeof liveNow === 'number' && Number.isFinite(liveNow) && pending === 0 && !settled && liveNow > prev) {
    worked += liveNow - prev;
  }
  return Math.max(0, worked);
}

/** Time spent blocked on unresolved `interaction_request`s (question / approval card waiting
 *  on the operator) during one turn. */
export function turnWaitingMs(turn: PromptTurn, liveNow?: number): number | null {
  const start = turn.prompt?.event.ts;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  let waiting = 0;
  let prev = start;
  let pending = 0;
  let settled = false;
  for (const m of turn.events) {
    if (m.event.type === 'helper') continue;
    const ts = m.event.ts;
    if (!Number.isFinite(ts)) continue;
    if (ts > prev) {
      if (pending > 0 && !settled) waiting += ts - prev;
      prev = ts;
    }
    settled = isSettled(m.event);
    if (m.event.type === 'interaction_request') pending++;
    else if (m.event.type === 'interaction_resolved' && pending > 0) pending--;
  }
  if (typeof liveNow === 'number' && Number.isFinite(liveNow) && pending > 0 && !settled && liveNow > prev) {
    waiting += liveNow - prev;
  }
  return Math.max(0, waiting);
}

/** Sum of per-turn waiting durations from the start of the conversation through `upToIndex`. */
export function cumulativeTurnWaitingMs(
  turns: readonly PromptTurn[],
  upToIndex: number,
): number | null {
  if (turns.length === 0 || upToIndex < 0) return null;
  const last = Math.min(upToIndex, turns.length - 1);
  let sum = 0;
  let any = false;
  for (let i = 0; i <= last; i++) {
    const ms = turnWaitingMs(turns[i]!);
    if (ms == null) continue;
    any = true;
    sum += ms;
  }
  return any ? sum : null;
}

/** Sum of per-turn durations from the start of the conversation through `upToIndex`. */
export function cumulativeTurnElapsedMs(
  turns: readonly PromptTurn[],
  upToIndex: number,
  liveNow?: number,
): number | null {
  if (turns.length === 0 || upToIndex < 0) return null;
  const last = Math.min(upToIndex, turns.length - 1);
  let sum = 0;
  let any = false;
  for (let i = 0; i <= last; i++) {
    const ms = turnElapsedMs(turns[i]!, i === last ? liveNow : undefined);
    if (ms == null) continue;
    any = true;
    sum += ms;
  }
  return any ? sum : null;
}

/** Subagent wall-clock that terminated inside this turn.
 *  ponytail: SpawnMarker.durationMs is the child's whole lifetime, so it already
 *  covers that child's own subtree — no recursion needed. Deduped by child id
 *  because a child can emit more than one terminal marker (result then stalled). */
export function turnSubagentElapsedMs(turn: PromptTurn): number | null {
  const byChild = new Map<string, number>();
  for (const m of turn.events) {
    if (m.event.type !== 'message') continue;
    const sm = m.event.payload.spawnMarker;
    if (!sm || (sm.kind !== 'result' && sm.kind !== 'stalled')) continue;
    if (!sm.childConversationId) continue;               // denied/expired carry ''
    if (typeof sm.durationMs !== 'number' || !Number.isFinite(sm.durationMs)) continue;
    byChild.set(sm.childConversationId, Math.max(0, sm.durationMs));
  }
  if (byChild.size === 0) return null;
  let sum = 0;
  for (const ms of byChild.values()) sum += ms;
  return sum;
}

/** Subagent time from the start of the conversation through `upToIndex`. */
export function cumulativeSubagentElapsedMs(
  turns: readonly PromptTurn[],
  upToIndex: number,
): number | null {
  if (turns.length === 0 || upToIndex < 0) return null;
  const last = Math.min(upToIndex, turns.length - 1);
  let sum = 0;
  let any = false;
  for (let i = 0; i <= last; i++) {
    const ms = turnSubagentElapsedMs(turns[i]!);
    if (ms == null) continue;
    any = true;
    sum += ms;
  }
  return any ? sum : null;
}

/** Subagent time across the whole conversation. */
export function conversationSubagentTotalMs(turns: readonly PromptTurn[]): number | null {
  return turns.length === 0 ? null : cumulativeSubagentElapsedMs(turns, turns.length - 1);
}
