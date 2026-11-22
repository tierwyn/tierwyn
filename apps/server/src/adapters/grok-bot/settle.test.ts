import { describe, it, expect, vi, afterEach } from 'vitest';
import { isTurnSettled, pollUntilSettled, type TurnSnapshot } from './settle.js';

const idle = {
  sawUserEntry: true,
  sawAssistantEntry: true,
  anyStreaming: false,
  msSinceLastNewEntry: 4000,
  msSinceLastActivity: 4000,
  idleMs: 4000,
};

describe('isTurnSettled', () => {
  it('is false until a user entry and an assistant entry both exist', () => {
    expect(isTurnSettled({ ...idle, sawUserEntry: false })).toBe(false);
    expect(isTurnSettled({ ...idle, sawAssistantEntry: false })).toBe(false);
  });

  it('is false while any replica entry is streaming', () => {
    expect(isTurnSettled({ ...idle, anyStreaming: true })).toBe(false);
  });

  it('is false before the idle window on new entries', () => {
    expect(isTurnSettled({ ...idle, msSinceLastNewEntry: 3999 })).toBe(false);
  });

  it('is false while lastActivityAt is fresher than idleMs', () => {
    expect(isTurnSettled({ ...idle, msSinceLastActivity: 100 })).toBe(false);
  });

  it('is true when no new entries and lastActivityAt have both been idle', () => {
    expect(isTurnSettled(idle)).toBe(true);
  });

  it('falls back to the no-new-entry window when lastActivityAt is unknown', () => {
    expect(isTurnSettled({ ...idle, msSinceLastActivity: null, msSinceLastNewEntry: 4000 })).toBe(true);
    expect(isTurnSettled({ ...idle, msSinceLastActivity: null, msSinceLastNewEntry: 100 })).toBe(false);
  });
});

describe('pollUntilSettled', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('resolves settled after idleMs of no new entries (fake timers)', async () => {
    vi.useFakeTimers();
    const frozenActivity = Date.now();
    const started = Date.now();
    const p = pollUntilSettled({
      snapshot: async (): Promise<TurnSnapshot> => ({
        entryCount: 2,
        sawUserEntry: true,
        sawAssistantEntry: true,
        anyStreaming: false,
        lastActivityAt: frozenActivity,
      }),
      idleMs: 4000,
      pollMs: 750,
      timeoutMs: 30_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe('settled');
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
  });

  it('returns timeout when activity has been stale for timeoutMs', async () => {
    vi.useFakeTimers();
    const frozen = Date.now() - 60_000;
    const p = pollUntilSettled({
      snapshot: async () => ({
        entryCount: 1,
        sawUserEntry: true,
        sawAssistantEntry: false,
        anyStreaming: false,
        lastActivityAt: frozen,
      }),
      idleMs: 4000,
      pollMs: 750,
      timeoutMs: 10_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe('timeout');
  });

  it('slides the timeout while snapshots keep reporting streaming', async () => {
    vi.useFakeTimers();
    let polls = 0;
    let lastActivityAt = Date.now();
    const p = pollUntilSettled({
      snapshot: async (): Promise<TurnSnapshot> => {
        polls += 1;
        const streaming = polls < 20;
        if (streaming) lastActivityAt = Date.now();
        return {
          entryCount: streaming ? 1 : 2,
          sawUserEntry: true,
          sawAssistantEntry: !streaming,
          anyStreaming: streaming,
          lastActivityAt,
        };
      },
      idleMs: 4000,
      pollMs: 750,
      timeoutMs: 10_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(p).resolves.toBe('settled');
  });
});
