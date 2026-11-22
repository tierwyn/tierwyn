/** Two 30 s server heartbeats + slack. */
export const HEARTBEAT_STALE_MS = 65_000;

/** Both args are CLIENT Date.now() values — never a server ts. */
export function isHeartbeatStale(lastSeenAt: number, now: number, staleMs = HEARTBEAT_STALE_MS): boolean {
  return now - lastSeenAt > staleMs;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000];

/** attempt 0-based; capped at 10 s. */
export function reconnectDelayMs(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(Math.max(0, attempt), RECONNECT_DELAYS_MS.length - 1)]!;
}
