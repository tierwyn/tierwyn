/** Turn-completion heuristic for grok-bot replica polls (Phase 1 pre-flight). */
import { envPrefFrom } from '../../config/env.js';

/** Generous because the busy mark can blink idle between a message and the next
 *  tool step; the mark, not this window, is the primary end-of-turn signal. */
export const DEFAULT_IDLE_MS = 8000;
export const DEFAULT_POLL_MS = 750;
export const DEFAULT_TURN_TIMEOUT_MS = 180_000;

export function idleMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(envPrefFrom(env, 'GROKBOT_IDLE_MS'));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS;
}

export interface SettleInput {
  sawUserEntry: boolean;
  sawAssistantEntry: boolean;
  anyStreaming: boolean;
  msSinceLastNewEntry: number;
  msSinceLastActivity: number | null;
  idleMs: number;
}

export function isTurnSettled(s: SettleInput): boolean {
  if (!s.sawUserEntry || !s.sawAssistantEntry || s.anyStreaming) return false;
  if (s.msSinceLastNewEntry < s.idleMs) return false;
  if (s.msSinceLastActivity != null && s.msSinceLastActivity < s.idleMs) return false;
  return true;
}

export interface TurnSnapshot {
  entryCount: number;
  sawUserEntry: boolean;
  sawAssistantEntry: boolean;
  anyStreaming: boolean;
  lastActivityAt: number | null;
}

export type SettleVerdict = 'settled' | 'timeout';

export async function pollUntilSettled(opts: {
  snapshot: () => Promise<TurnSnapshot>;
  idleMs: number;
  pollMs: number;
  timeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SettleVerdict> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  let lastCount = -1;
  let lastNewAt = started;
  let lastKeepalive = started;

  while (now() - lastKeepalive < opts.timeoutMs) {
    const snap = await opts.snapshot();
    const t = now();
    if (snap.entryCount !== lastCount) {
      lastCount = snap.entryCount;
      lastNewAt = t;
      lastKeepalive = t;
    }
    if (snap.anyStreaming) lastKeepalive = t;
    const activityIdle = snap.lastActivityAt == null ? null : t - snap.lastActivityAt;
    if (isTurnSettled({
      sawUserEntry: snap.sawUserEntry,
      sawAssistantEntry: snap.sawAssistantEntry,
      anyStreaming: snap.anyStreaming,
      msSinceLastNewEntry: t - lastNewAt,
      msSinceLastActivity: activityIdle,
      idleMs: opts.idleMs,
    })) {
      return 'settled';
    }
    const remaining = opts.timeoutMs - (now() - lastKeepalive);
    if (remaining <= 0) break;
    await sleep(Math.min(opts.pollMs, remaining));
  }
  return 'timeout';
}
