import { describe, it, expect } from 'vitest';
import {
  computeNextFireAt, computeUpcoming, parseOnceExpr, ONCE_EXHAUSTED_MS,
} from './nextFire.js';

describe('computeNextFireAt — interval', () => {
  it('anchors from createdAt when anchor omitted', () => {
    const createdAtMs = Date.parse('2026-07-17T09:00:00.000Z');
    const afterMs = createdAtMs; // just created
    const next = computeNextFireAt({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
      timezone: 'UTC',
      afterMs,
      createdAtMs,
    });
    expect(next).toBe(createdAtMs + 3_600_000);
  });

  it('skips past intervals so next is strictly after afterMs', () => {
    const createdAtMs = Date.parse('2026-07-17T09:00:00.000Z');
    const afterMs = Date.parse('2026-07-17T12:30:00.000Z');
    const next = computeNextFireAt({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }),
      timezone: 'UTC',
      afterMs,
      createdAtMs,
    });
    // 09, 10, 11, 12, 13 → first strictly after 12:30 is 13:00
    expect(next).toBe(Date.parse('2026-07-17T13:00:00.000Z'));
  });
});

describe('computeNextFireAt — cron + timezone', () => {
  it('interprets 5-field cron in the job timezone', () => {
    // 0 9 * * 1-5 = 09:00 Mon–Fri in America/New_York
    const afterMs = Date.parse('2026-07-17T12:00:00.000Z'); // Friday 08:00 EDT
    const next = computeNextFireAt({
      scheduleKind: 'cron',
      scheduleExpr: '0 9 * * 1-5',
      timezone: 'America/New_York',
      afterMs,
      createdAtMs: afterMs,
    });
    // Still Friday morning → 09:00 EDT = 13:00 UTC
    expect(next).toBe(Date.parse('2026-07-17T13:00:00.000Z'));
  });

  it('rolls to next weekday after Friday 09:00 ET', () => {
    const afterMs = Date.parse('2026-07-17T13:00:00.000Z'); // exactly Friday 09:00 ET
    const next = computeNextFireAt({
      scheduleKind: 'cron',
      scheduleExpr: '0 9 * * 1-5',
      timezone: 'America/New_York',
      afterMs,
      createdAtMs: afterMs,
    });
    // Monday 09:00 EDT
    expect(next).toBe(Date.parse('2026-07-20T13:00:00.000Z'));
  });
});

describe('computeUpcoming', () => {
  it('returns up to count future fires', () => {
    const afterMs = Date.parse('2026-07-17T00:00:00.000Z');
    const list = computeUpcoming({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000, anchor: afterMs }),
      timezone: 'UTC',
      afterMs,
      createdAtMs: afterMs,
      count: 5,
    });
    expect(list).toHaveLength(5);
    expect(list[0]).toBe(afterMs + 60_000);
    expect(list[4]).toBe(afterMs + 5 * 60_000);
  });
});

describe('computeNextFireAt — once', () => {
  const atMs = Date.parse('2026-07-27T15:40:00.000Z');

  it('returns atMs when afterMs < atMs', () => {
    const next = computeNextFireAt({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      timezone: 'UTC',
      afterMs: atMs - 1,
      createdAtMs: atMs - 60_000,
    });
    expect(next).toBe(atMs);
  });

  it('returns ONCE_EXHAUSTED_MS when afterMs >= atMs', () => {
    const next = computeNextFireAt({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      timezone: 'UTC',
      afterMs: atMs,
      createdAtMs: atMs - 60_000,
    });
    expect(next).toBe(ONCE_EXHAUSTED_MS);
  });
});

describe('parseOnceExpr', () => {
  it('accepts valid {atMs}', () => {
    expect(parseOnceExpr(JSON.stringify({ atMs: 1_700_000_000_000 }))).toEqual({
      atMs: 1_700_000_000_000,
    });
  });

  it('rejects empty object', () => {
    expect(() => parseOnceExpr('{}')).toThrow(/atMs/);
  });

  it('rejects non-positive atMs', () => {
    expect(() => parseOnceExpr(JSON.stringify({ atMs: -1 }))).toThrow(/atMs/);
    expect(() => parseOnceExpr(JSON.stringify({ atMs: 0 }))).toThrow(/atMs/);
  });

  it('rejects non-JSON', () => {
    expect(() => parseOnceExpr('not json')).toThrow(/JSON/i);
  });
});

describe('computeUpcoming — once', () => {
  it('returns a single upcoming fire (no sentinel)', () => {
    const atMs = Date.parse('2026-07-27T15:40:00.000Z');
    const list = computeUpcoming({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      timezone: 'UTC',
      afterMs: atMs - 1,
      createdAtMs: atMs - 60_000,
      count: 5,
    });
    expect(list).toEqual([atMs]);
  });

  it('returns empty when already exhausted', () => {
    const atMs = Date.parse('2026-07-27T15:40:00.000Z');
    const list = computeUpcoming({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs }),
      timezone: 'UTC',
      afterMs: atMs,
      createdAtMs: atMs - 60_000,
      count: 5,
    });
    expect(list).toEqual([]);
  });
});

describe('validation', () => {
  it('rejects everyMs < 1000', () => {
    expect(() => computeNextFireAt({
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 500 }),
      timezone: 'UTC',
      afterMs: Date.now(),
      createdAtMs: Date.now(),
    })).toThrow(/everyMs/i);
  });

  it('rejects invalid cron', () => {
    expect(() => computeNextFireAt({
      scheduleKind: 'cron',
      scheduleExpr: 'not a cron',
      timezone: 'UTC',
      afterMs: Date.now(),
      createdAtMs: Date.now(),
    })).toThrow();
  });
});
