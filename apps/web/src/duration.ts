/** Human-facing duration units (API often stores milliseconds). */
export type DurationUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export const DURATION_UNIT_MS: Record<DurationUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export const DURATION_UNIT_OPTIONS: { value: DurationUnit; label: string }[] = [
  { value: 'seconds', label: 'seconds' },
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];

/** Largest-first so whole days/hours win over minutes when exact. */
const DURATION_UNITS_DESC: DurationUnit[] = ['days', 'hours', 'minutes', 'seconds'];

/** Pick a friendly amount + unit (largest exact unit; else nearest minutes). */
export function msToDurationParts(
  ms: number,
  fallback: { amount: number; unit: DurationUnit } = { amount: 30, unit: 'minutes' },
): { amount: number; unit: DurationUnit } {
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  for (const unit of DURATION_UNITS_DESC) {
    const factor = DURATION_UNIT_MS[unit];
    if (ms % factor === 0) {
      return { amount: ms / factor, unit };
    }
  }
  const mins = Math.round((ms / DURATION_UNIT_MS.minutes) * 10) / 10;
  return { amount: mins > 0 ? mins : 0.1, unit: 'minutes' };
}

export function durationPartsToMs(amount: number, unit: DurationUnit): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * DURATION_UNIT_MS[unit]);
}

/** Parse interval scheduleExpr `{"everyMs":N}` → ms, or null if not parseable. */
export function parseIntervalEveryMs(expr: string): number | null {
  try {
    const parsed = JSON.parse(expr) as { everyMs?: unknown };
    if (typeof parsed.everyMs === 'number' && Number.isFinite(parsed.everyMs) && parsed.everyMs > 0) {
      return parsed.everyMs;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** Parse once scheduleExpr `{"atMs":N}` → epoch ms, or null if not parseable. */
export function parseOnceAtMs(expr: string): number | null {
  try {
    const parsed = JSON.parse(expr) as { atMs?: unknown };
    if (typeof parsed.atMs === 'number' && Number.isFinite(parsed.atMs) && parsed.atMs > 0) {
      return parsed.atMs;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export function formatIntervalExpr(everyMs: number): string {
  return JSON.stringify({ everyMs });
}

export function formatOnceExpr(atMs: number): string {
  return JSON.stringify({ atMs });
}

import { formatIsoLocalInTimezone } from '@tierwyn/shared';

/** datetime-local value (YYYY-MM-DDTHH:mm) from UTC epoch ms in the given IANA timezone. */
export function atMsToDatetimeLocal(atMs: number, timezone = 'UTC'): string {
  return formatIsoLocalInTimezone(atMs, timezone);
}
