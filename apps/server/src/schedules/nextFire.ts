import { Cron } from 'croner';

export type ScheduleKind = 'interval' | 'cron' | 'once';

/** Far-future sentinel so exhausted once jobs never re-claim (INTEGER NOT NULL). */
export const ONCE_EXHAUSTED_MS = 8_640_000_000_000_000;

export interface IntervalExpr {
  everyMs: number;
  /** UTC ms epoch; when omitted, use createdAtMs */
  anchor?: number;
}

export interface OnceExpr {
  atMs: number;
}

export interface NextFireInput {
  scheduleKind: ScheduleKind;
  scheduleExpr: string;
  timezone: string;
  /** Exclusive lower bound — next fire must be strictly greater than this. */
  afterMs: number;
  createdAtMs: number;
}

export function parseIntervalExpr(raw: string): IntervalExpr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid interval schedule_expr JSON: ${raw}`);
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as IntervalExpr).everyMs !== 'number'
  ) {
    throw new Error('interval schedule_expr must be {"everyMs":number,"anchor"?:number}');
  }
  const everyMs = (parsed as IntervalExpr).everyMs;
  if (!Number.isFinite(everyMs) || everyMs < 1000) {
    throw new Error('interval everyMs must be a finite number >= 1000');
  }
  const anchor = (parsed as IntervalExpr).anchor;
  if (anchor !== undefined && (!Number.isFinite(anchor) || anchor < 0)) {
    throw new Error('interval anchor must be a non-negative ms epoch when provided');
  }
  return { everyMs, anchor };
}

export function parseOnceExpr(raw: string): OnceExpr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid once schedule_expr JSON: ${raw}`);
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as OnceExpr).atMs !== 'number'
  ) {
    throw new Error('once schedule_expr must be {"atMs":number>0}');
  }
  const atMs = (parsed as OnceExpr).atMs;
  if (!Number.isFinite(atMs) || atMs <= 0) {
    throw new Error('once schedule_expr must be {"atMs":number>0}');
  }
  return { atMs };
}

export function computeNextFireAt(input: NextFireInput): number {
  if (input.scheduleKind === 'interval') {
    const { everyMs, anchor } = parseIntervalExpr(input.scheduleExpr);
    const base = anchor ?? input.createdAtMs;
    if (input.afterMs < base) return base;
    const elapsed = input.afterMs - base;
    const steps = Math.floor(elapsed / everyMs) + 1;
    return base + steps * everyMs;
  }

  if (input.scheduleKind === 'once') {
    const { atMs } = parseOnceExpr(input.scheduleExpr);
    return input.afterMs < atMs ? atMs : ONCE_EXHAUSTED_MS;
  }

  // cron — 5-field, interpreted in job timezone
  let cron: Cron;
  try {
    cron = new Cron(input.scheduleExpr, { timezone: input.timezone });
  } catch (err) {
    throw new Error(
      `invalid cron schedule_expr "${input.scheduleExpr}" (tz=${input.timezone}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const next = cron.nextRun(new Date(input.afterMs + 1)); // strictly after afterMs
  if (!next) throw new Error(`cron produced no next run for "${input.scheduleExpr}"`);
  return next.getTime();
}

export function computeUpcoming(input: NextFireInput & { count: number }): number[] {
  const n = Math.max(0, Math.min(input.count, 50));
  const out: number[] = [];
  let after = input.afterMs;
  for (let i = 0; i < n; i++) {
    const next = computeNextFireAt({ ...input, afterMs: after });
    if (next >= ONCE_EXHAUSTED_MS) break; // exhausted once — don't push sentinel
    out.push(next);
    after = next;
  }
  return out;
}
