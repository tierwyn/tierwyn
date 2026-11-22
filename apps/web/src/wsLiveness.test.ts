import { describe, it, expect } from 'vitest';
import { HEARTBEAT_STALE_MS, isHeartbeatStale, reconnectDelayMs } from './wsLiveness.js';

describe('isHeartbeatStale', () => {
  it('returns false at exact threshold and true past threshold', () => {
    expect(isHeartbeatStale(1000, 1000 + HEARTBEAT_STALE_MS)).toBe(false);
    expect(isHeartbeatStale(1000, 1000 + HEARTBEAT_STALE_MS + 1)).toBe(true);
  });

  it('respects custom staleMs', () => {
    expect(isHeartbeatStale(500, 1500, 1000)).toBe(false);
    expect(isHeartbeatStale(500, 1501, 1000)).toBe(true);
  });

  it('is never stale when lastSeenAt equals now', () => {
    const now = Date.now();
    expect(isHeartbeatStale(now, now)).toBe(false);
  });
});

describe('reconnectDelayMs', () => {
  it('backs off 1s -> 2s -> 5s -> 10s and clamps out-of-range attempts', () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(5000);
    expect(reconnectDelayMs(3)).toBe(10_000);
    expect(reconnectDelayMs(50)).toBe(10_000);
    expect(reconnectDelayMs(-1)).toBe(1000);
  });
});
