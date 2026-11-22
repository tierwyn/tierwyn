/** Pure support for the Prompt timer modal + chips. No DOM, no React — so it is
 *  covered by the web workspace's node-environment vitest run.
 *
 *  v2 works in WHOLE MINUTES end to end: the In… clock has an H segment and an
 *  MM segment and nothing finer, so there is no seconds unit and no days unit
 *  anywhere in here. Chips render minute precision too. */

import { promptOptionsFor, type TimerOrigin } from '@tierwyn/shared';

export const TIMER_MIN_MINUTES = 1;
/** 7 days = 168 hours. Matches TIMER_MAX_DELAY_MS on the wire. */
export const TIMER_MAX_MINUTES = 7 * 24 * 60;
export const TIMER_DEFAULT_MINUTES = 5;

export const TIMER_PRESET_MINUTES: readonly number[] = [1, 5, 15, 30, 60, 180];
export const TIMER_NUDGE_MINUTES: readonly number[] = [5, 15, 60];

/** Any proposed total → a whole number of minutes inside [1, 10080]. */
export function clampTimerMinutes(total: number): number {
  if (!Number.isFinite(total)) {
    return total === Number.POSITIVE_INFINITY ? TIMER_MAX_MINUTES : TIMER_MIN_MINUTES;
  }
  const floored = Math.floor(total);
  if (floored < TIMER_MIN_MINUTES) return TIMER_MIN_MINUTES;
  if (floored > TIMER_MAX_MINUTES) return TIMER_MAX_MINUTES;
  return floored;
}

/** Total → the two segment strings. Minutes are zero-padded so the clock reads
 *  0 : 05, not 0 : 5. */
export function draftsFromTotal(total: number): { hours: string; minutes: string } {
  const clamped = clampTimerMinutes(total);
  return {
    hours: String(Math.floor(clamped / 60)),
    minutes: String(clamped % 60).padStart(2, '0'),
  };
}

function segment(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Segment text → clamped total. Minutes ≥ 60 carry into hours for free because
 *  this is plain arithmetic; draftsFromTotal is what re-renders the carry. */
export function totalFromDrafts(hoursDraft: string, minutesDraft: string): number {
  return clampTimerMinutes(segment(hoursDraft) * 60 + segment(minutesDraft));
}

/** Preview copy: "5 minutes" / "1 hour" / "1h 30m". No days unit by design. */
export function durationLabel(totalMinutes: number): string {
  const total = clampTimerMinutes(totalMinutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** `<input type="datetime-local">` value → epoch ms in the BROWSER-LOCAL zone.
 *  `new Date('YYYY-MM-DDTHH:mm')` (no trailing Z) is defined to parse as local
 *  time, which is what the operator means by "at 14:30". Same control and same
 *  semantics as the schedule editor's Once field. */
export function datetimeLocalToEpoch(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms → a datetime-local input value in the browser-local zone, truncated
 *  to the minute (the control has no seconds). */
export function epochToDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Chip countdown. Two units max, minute precision: "2d 3h" / "1h 30m" / "5m" /
 *  "<1m". A fired-but-not-yet-refetched chip sits at "<1m" until the next poll. */
export function countdownLabel(msRemaining: number): string {
  const minutes = Math.max(0, Math.floor(msRemaining / 60_000));
  if (minutes < 1) return '<1m';
  const d = Math.floor(minutes / 1_440);
  const h = Math.floor((minutes % 1_440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Absolute preview: "Fires <this>" in the browser's locale, to the minute. */
export function fireAtLabel(fireAtMs: number): string {
  return new Date(fireAtMs).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Informational chips for the options that will be snapshotted. Read-only —
 *  v2 has no options editor in the modal. */
export function optionChipLabels(
  agentType: string | undefined,
  options: Record<string, unknown> | null,
): string[] {
  if (!options) return [];
  const descriptors = promptOptionsFor(agentType);
  return Object.entries(options).map(([key, value]) => {
    const label = descriptors.find((d) => d.key === key)?.label ?? key;
    return value === true ? `${label} on` : `${label}: ${String(value)}`;
  });
}

/** Origin badge for a timer chip: operator pings are unlabelled; agent- and
 *  auto-scheduled timers get a small pill so the operator can tell who set it. */
export function timerOriginBadge(origin: TimerOrigin | undefined): { label: string; title: string } | null {
  if (origin === 'agent-self') {
    return { label: 'self', title: "Scheduled by this conversation's own agent (self wake-up)" };
  }
  if (origin === 'agent-resume') {
    return { label: 'agent', title: 'Scheduled by a parent agent (deferred resume)' };
  }
  if (origin === 'auto-resume') {
    return { label: 'auto', title: 'Scheduled by the usage-limit watcher' };
  }
  return null;
}

