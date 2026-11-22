import type { ServerFrame } from '@tierwyn/shared';
import { createProseAccumulator } from './prose.js';
import { sessionHub } from '../sessionHub.js';

// ponytail: fixed intervals; per-spawn overrides only if SLAs diverge across profiles
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Default stall budget. Per-call `stallMs` (e.g. btw) still wins when passed. */
export const HEARTBEAT_STALL_MS = 15 * 60_000;
let defaultStallMs = HEARTBEAT_STALL_MS;
export function setSpawnStallTimeoutMs(ms: number): void { defaultStallMs = ms; }
export function getSpawnStallTimeoutMs(): number { return defaultStallMs; }

/** Collect the child's final assistant prose and resolve on session_ended.
 *  Tracks prose by turn (tool boundaries are turn separators). On resolve, picks
 *  the last substantive turn; falls back to all chunks with degenerate=true if
 *  no substantive turn exists (e.g. child ended on a terse "Done." or a tool_call).
 *  Fires heartbeat markers into the parent transcript every HEARTBEAT_INTERVAL_MS of
 *  silence; rejects (stalled) after HEARTBEAT_STALL_MS (15 min default) of total silence.
 *  Settle-once: reject-before-onStalled so stop→end→session_ended cannot resolve
 *  with partial prose after a stall (R2). Any conversation event resets the silence
 *  clock so long quiet tools / status-only activity are not false-stalled (R1).
 *  ponytail: extracted from routes/spawn.ts so schedules/dispatch.ts and routes/btw.ts
 *  can reuse it without importing Express-bound route code. */
/** Result of a settled child wait. `errored` distinguishes a child that
 *  terminated via status:error (or whose handlePrompt never produced a
 *  session) from one that merely ended with terse prose. A parent-authorized
 *  stop force-settles with `stopped: true` instead of hanging the waiter. */
export interface ChildWatchResult {
  prose: string;
  degenerate: boolean;
  errored: boolean;
  /** Adapter's error text from the child transcript's error event, if any. */
  errorMessage?: string;
  /** True when a parent POST /spawn/:id/stop force-settled this watcher. */
  stopped?: boolean;
}

const forceSettlers = new Map<string, Set<(r: ChildWatchResult) => void>>();

function registerSettler(conversationId: string, fn: (r: ChildWatchResult) => void): void {
  let set = forceSettlers.get(conversationId);
  if (!set) {
    set = new Set();
    forceSettlers.set(conversationId, set);
  }
  set.add(fn);
}

function unregisterSettler(conversationId: string, fn: (r: ChildWatchResult) => void): void {
  const set = forceSettlers.get(conversationId);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) forceSettlers.delete(conversationId);
}

/** Force-settle every pending watchChildResult for this conversation. Returns
 *  how many settlers were invoked (already-resolved watchers are a no-op). */
export function settleWatchersFor(conversationId: string, r: ChildWatchResult): number {
  const set = forceSettlers.get(conversationId);
  if (!set || set.size === 0) return 0;
  const fns = [...set];
  for (const fn of fns) fn(r);
  return fns.length;
}

export function watchChildResult(
  conversationId: string,
  opts: {
    onHeartbeat: (childId: string, silentMs: number) => void;
    onStalled: (childId: string, silentMs: number) => void;
    now?: () => number;        // ponytail: injectable for tests
    checkIntervalMs?: number;  // ponytail: injectable for tests
    stallMs?: number;          // ponytail: injectable for tests
    armOn?: 'turn_start';
    /** Resolve `{ stopped: true }` when the operator hard-stops the session. */
    settleOnStop?: boolean;
  },
): { promise: Promise<ChildWatchResult>; cancel: () => void; fail: (msg: string) => void } {
  const _now = opts.now ?? (() => Date.now());
  const checkMs = opts.checkIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const stMs = opts.stallMs ?? defaultStallMs;

  const acc = createProseAccumulator();
  let lastActivity = _now();
  let settled = false;
  let errored = false;
  let armed = opts.armOn !== 'turn_start';
  let armedSessionId: string | undefined;
  let errorMessage: string | undefined;
  let resolve!: (r: ChildWatchResult) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<ChildWatchResult>((res, rej) => { resolve = res; reject = rej; });

  let sub!: { send(frame: ServerFrame): void };

  const forceSettle = (r: ChildWatchResult) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    sessionHub.drop(sub);
    unregisterSettler(conversationId, forceSettle);
    resolve(r);
  };

  const doResolve = () => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    unregisterSettler(conversationId, forceSettle);
    resolve({ ...acc.finish(), errored, errorMessage });
  };

  // ponytail: single interval; heartbeat each tick of silence, stall terminates watcher
  const timer = setInterval(() => {
    if (settled) return;
    const silentMs = _now() - lastActivity;
    if (silentMs >= stMs) {
      // Reject FIRST so onStalled → stopSession → session_ended → doResolve is a no-op.
      settled = true;
      clearInterval(timer);
      unregisterSettler(conversationId, forceSettle);
      reject(new Error(`spawn child stalled: no output for ${Math.round(silentMs / 1000)}s`));
      opts.onStalled(conversationId, silentMs);
    } else if (silentMs >= checkMs) {
      opts.onHeartbeat(conversationId, silentMs);
    }
  }, checkMs);

  // Operator Stop / Interrupt & Send must not settle the spawn watcher: the
  // parent stays waiting until a later natural done, or status:error / stall.
  let operatorHold = false;

  sub = {
    send(frame: ServerFrame) {
      if (frame.type === 'event' && frame.conversationId === conversationId) {
        // Any event proves the child is alive — not only message/tool frames.
        lastActivity = _now();
        const ev = frame.event;
        const sid = (ev as { sessionId?: string })?.sessionId
          ?? (ev?.payload as { sessionId?: string })?.sessionId
          ?? (frame as { sessionId?: string }).sessionId;
        if (ev?.type === 'prompt' || ev?.type === 'steer' || (ev?.type === 'status' && ev.payload?.status === 'running')) {
          armed = true;
          if (opts.armOn === 'turn_start' && !armedSessionId && sid) {
            armedSessionId = sid;
          }
        }
        if (ev?.type === 'message' && ev.payload?.chunk && ev.sender === 'agent') {
          acc.addChunk(ev.payload.chunk);
        }
        // Tool boundary = end of current prose turn for the accumulator.
        if (ev?.type === 'tool_call' || ev?.type === 'tool_result') {
          acc.toolBoundary();
        }
        if (ev?.type === 'status' && ev.payload?.status === 'running') {
          operatorHold = false;
        }
        // Errors still settle — operator interrupt is not a failure path.
        if (ev?.type === 'status' && ev.payload?.status === 'error') {
          if (!armed) return;
          if (armedSessionId && sid && sid !== armedSessionId) return;
          errored = true;
          doResolve();
          return;
        }
        // Capture the adapter's error text (emitted as its own error event,
        // usually just before status:error) so the failure notify can carry it.
        if (ev?.type === 'error' && typeof ev.payload?.message === 'string') {
          errorMessage = ev.payload.message;
        }
        // Resolve on status:done too — claude-agent-sdk keeps the
        // subprocess stdin open after result for follow-up turns, so
        // session_ended (which fires on subprocess exit) may never come.
        // Operator Interrupt & Send emits done with this cause; hold until
        // the follow-up turn's natural terminal.
        if (ev?.type === 'status' && ev.payload?.status === 'done') {
          if (!armed) return;
          if (armedSessionId && sid && sid !== armedSessionId) return;
          if (ev.payload.cause === 'operator_interrupt') {
            operatorHold = true;
            return;
          }
          doResolve();
        }
      }
      if (frame.type === 'session_ended' && frame.conversationId === conversationId) {
        if (!armed) return;
        if (armedSessionId && frame.sessionId && frame.sessionId !== armedSessionId) return;
        if (frame.cause === 'operator_interrupt') return;
        if (operatorHold) {
          // Hard Stop (session ended, no follow-up turn). Spawn waiters keep
          // holding; schedule runs opt in to settling as stopped.
          if (opts.settleOnStop) forceSettle({ ...acc.finish(), errored: false, stopped: true });
          return;
        }
        doResolve();
      }
    },
  };
  sessionHub.subscribe(conversationId, sub);
  registerSettler(conversationId, forceSettle);
  return {
    promise,
    cancel: () => {
      clearInterval(timer);
      sessionHub.drop(sub);
      unregisterSettler(conversationId, forceSettle);
    },
    // ponytail: exposed so dispatch-site can reject the watcher when handlePrompt
    // throws before it ever creates a session (no session_ended will fire)
    fail: (msg: string) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      sessionHub.drop(sub);
      unregisterSettler(conversationId, forceSettle);
      reject(new Error(msg));
    },
  };
}
