/**
 * FW-20 — pure month-grid maths for the schedule calendar.
 *
 * Everything the calendar computes lives here so it is covered by node Vitest;
 * `ScheduleBrowser.tsx` only renders. No fire projection happens on the client —
 * the server's /schedules/calendar route owns that (one source of truth for cron,
 * interval anchors and operator skip holes).
 */
import { formatIsoLocalInTimezone, parseIsoLocalInTimezone } from '@tierwyn/shared';

export type ScheduleCalendarKind = 'interval' | 'cron' | 'once';

/** Mirror of the server DTO in apps/server/src/routes/schedules.ts — keep field-identical. */
export interface ScheduleCalendarJob {
  jobId: string;
  /** Owning project — the All view routes marker clicks on this. */
  projectId: string;
  projectName: string;
  name: string;
  timezone: string;
  enabled: boolean;
  scheduleKind: ScheduleCalendarKind;
  fires: number[];
  skipped: number[];
  truncated: boolean;
}

export interface ScheduleCalendarResponse {
  from: number;
  to: number;
  jobs: ScheduleCalendarJob[];
}

export interface CalendarMarker {
  jobId: string;
  /** Required, not optional: the All-view click handler routes on projectId (D9). */
  projectId: string;
  projectName: string;
  name: string;
  ms: number;
  enabled: boolean;
  skipped: boolean;
  /** The owning job's zone — shown in the tooltip only when it differs from the grid. */
  jobTimezone: string;
}

export interface CalendarDay {
  /** YYYY-MM-DD in the grid timezone. */
  key: string;
  dayOfMonth: number;
  inMonth: boolean;
  isToday: boolean;
  markers: CalendarMarker[];
  visible: CalendarMarker[];
  overflow: CalendarMarker[];
}

export const MAX_DAY_CHIPS = 4;

export type CalendarViewMode = 'month' | 'week' | 'day';

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** localStorage key for the full-window pane's scope choice (D7). */
export const SCOPE_STORAGE_KEY = 'tierwyn.scheduleCalendar.scope';
/** Scope sentinel meaning "every project". Any other value is a project id. */
export const SCOPE_ALL = 'all';

/** localStorage key for the user's preferred calendar view mode (month | week | day). */
export const CALENDAR_VIEW_STORAGE_KEY = 'tierwyn.scheduleCalendar.viewMode';

export function resolveCalendarViewMode(stored: string | null | undefined): CalendarViewMode {
  if (stored === 'week' || stored === 'day') return stored;
  return 'month';
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** ±18h covers every UTC offset (−12…+14) plus a DST hour on the edge days. */
const WINDOW_PAD_MS = 18 * 3_600_000;

const pad2 = (n: number) => String(n).padStart(2, '0');
const pad4 = (n: number) => String(n).padStart(4, '0');

export function dayKeyInTimezone(ms: number, timezone: string): string {
  return formatIsoLocalInTimezone(ms, timezone).slice(0, 10);
}

/**
 * The operator's own zone — the axis for the full-window pane, which has no
 * selected job to borrow a timezone from (D8). Falls back to UTC if Intl is
 * unavailable or reports an empty zone (some locked-down embedded browsers).
 */
export function operatorTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Validate a persisted scope against the projects that actually exist, so a
 * deleted project degrades to All instead of a permanent 404 loop (D7).
 */
export function resolveScope(stored: string | null | undefined, projectIds: string[]): string {
  if (!stored || stored === SCOPE_ALL) return SCOPE_ALL;
  return projectIds.includes(stored) ? stored : SCOPE_ALL;
}

/** Civil-date arithmetic in UTC — exact, DST-free, and independent of any zone. */
export function addDaysToDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad4(t.getUTCFullYear())}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Always 42 keys (6 weeks), Monday-first, so the grid height never jumps. */
export function monthDayKeys(year: number, month0: number): string[] {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstKey = `${pad4(year)}-${pad2(month0 + 1)}-01`;
  const mondayIndex = (first.getUTCDay() + 6) % 7; // 0 = Monday
  const start = addDaysToDayKey(firstKey, -mondayIndex);
  return Array.from({ length: 42 }, (_, i) => addDaysToDayKey(start, i));
}

/** Exactly 7 keys (Monday-Sunday) for the week containing the given day key. */
export function weekDayKeys(dayKey: string): string[] {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const mondayIndex = (date.getUTCDay() + 6) % 7; // 0 = Monday
  const mondayKey = addDaysToDayKey(dayKey, -mondayIndex);
  return Array.from({ length: 7 }, (_, i) => addDaysToDayKey(mondayKey, i));
}

/** Return day keys corresponding to the active view mode and anchor date. */
export function calendarDayKeys(dayKey: string, viewMode: CalendarViewMode): string[] {
  if (viewMode === 'day') return [dayKey];
  if (viewMode === 'week') return weekDayKeys(dayKey);
  const [y, m] = dayKey.split('-').map(Number);
  return monthDayKeys(y, m - 1);
}

/**
 * Universal UTC ms window for any set of dayKeys (1 day, 7 days, 42 days).
 * Anchored on local NOON, not local midnight: some zones delete midnight on a DST
 * spring-forward, which makes `parseIsoLocalInTimezone(key + 'T00:00', tz)` NaN.
 * Over-fetching a few hours is free — bucketing discards anything off-grid.
 */
export function calendarWindowMs(days: string[], timezone: string): { from: number; to: number } {
  const noon = (key: string): number => {
    const parsed = parseIsoLocalInTimezone(`${key}T12:00`, timezone);
    if (Number.isFinite(parsed)) return parsed;
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12);
  };
  return {
    from: noon(days[0]) - WINDOW_PAD_MS,
    to: noon(days[days.length - 1]) + WINDOW_PAD_MS,
  };
}

/** Backward-compatible alias for monthWindowMs. */
export const monthWindowMs = calendarWindowMs;

/** Shift the anchor day key by delta units of the active view mode. */
export function shiftCalendarAnchor(dayKey: string, viewMode: CalendarViewMode, delta: number): string {
  if (viewMode === 'day') {
    return addDaysToDayKey(dayKey, delta);
  }
  if (viewMode === 'week') {
    return addDaysToDayKey(dayKey, delta * 7);
  }
  // month
  const [y, m, d] = dayKey.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + delta, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth0 = target.getUTCMonth();
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth0 + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, daysInTargetMonth);
  return `${pad4(targetYear)}-${pad2(targetMonth0 + 1)}-${pad2(clampedDay)}`;
}

/** Formatted title label for the nav bar in any view mode. */
export function calendarNavLabel(dayKey: string, viewMode: CalendarViewMode): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  if (viewMode === 'day') {
    const date = new Date(Date.UTC(y, m - 1, d));
    const weekday = WEEKDAY_LABELS[(date.getUTCDay() + 6) % 7];
    const monthShort = MONTH_NAMES[m - 1].slice(0, 3);
    return `${weekday}, ${d} ${monthShort} ${y}`;
  }
  if (viewMode === 'week') {
    const weekDays = weekDayKeys(dayKey);
    const first = weekDays[0];
    const last = weekDays[6];
    const [y1, m1, d1] = first.split('-').map(Number);
    const [y2, m2, d2] = last.split('-').map(Number);
    const m1Short = MONTH_NAMES[m1 - 1].slice(0, 3);
    const m2Short = MONTH_NAMES[m2 - 1].slice(0, 3);
    if (y1 === y2) {
      if (m1 === m2) {
        return `${d1} – ${d2} ${m1Short} ${y1}`;
      }
      return `${d1} ${m1Short} – ${d2} ${m2Short} ${y1}`;
    }
    return `${d1} ${m1Short} ${y1} – ${d2} ${m2Short} ${y2}`;
  }
  return monthLabel(y, m - 1);
}

export function buildCalendarGrid(opts: {
  days: string[];
  viewMode: CalendarViewMode;
  timezone: string;
  nowMs: number;
  jobs: ScheduleCalendarJob[];
  maxChips?: number;
  anchorDayKey?: string;
}): CalendarDay[] {
  const { days, viewMode, timezone, nowMs, jobs, anchorDayKey } = opts;
  const defaultMaxChips = viewMode === 'day' ? 1000 : (viewMode === 'week' ? 12 : MAX_DAY_CHIPS);
  const maxChips = opts.maxChips ?? defaultMaxChips;
  const todayKey = dayKeyInTimezone(nowMs, timezone);
  const monthPrefix = anchorDayKey ? anchorDayKey.slice(0, 7) : (days.length > 0 ? days[0].slice(0, 7) : '');

  const buckets = new Map<string, CalendarMarker[]>();
  for (const key of days) buckets.set(key, []);

  for (const job of jobs) {
    if (!job.enabled) continue;
    const place = (ms: number, skipped: boolean) => {
      const bucket = buckets.get(dayKeyInTimezone(ms, timezone));
      if (!bucket) return; // off-grid (window padding) — drop it
      bucket.push({
        jobId: job.jobId,
        projectId: job.projectId,
        projectName: job.projectName,
        name: job.name,
        ms,
        enabled: job.enabled,
        skipped,
        jobTimezone: job.timezone,
      });
    };
    for (const ms of job.fires) place(ms, false);
    for (const ms of job.skipped) place(ms, true);
  }

  return days.map((key) => {
    const markers = (buckets.get(key) ?? []).sort(
      (a, b) => a.ms - b.ms || a.name.localeCompare(b.name) || a.jobId.localeCompare(b.jobId),
    );
    return {
      key,
      dayOfMonth: Number(key.slice(8, 10)),
      inMonth: viewMode !== 'month' || key.startsWith(monthPrefix),
      isToday: key === todayKey,
      markers,
      visible: markers.slice(0, maxChips),
      overflow: markers.slice(maxChips),
    };
  });
}

export function buildMonthGrid(opts: {
  year: number;
  month0: number;
  timezone: string;
  nowMs: number;
  jobs: ScheduleCalendarJob[];
  maxChips?: number;
}): CalendarDay[] {
  const days = monthDayKeys(opts.year, opts.month0);
  const anchorDayKey = `${pad4(opts.year)}-${pad2(opts.month0 + 1)}-01`;
  return buildCalendarGrid({
    days,
    viewMode: 'month',
    timezone: opts.timezone,
    nowMs: opts.nowMs,
    jobs: opts.jobs,
    maxChips: opts.maxChips,
    anchorDayKey,
  });
}

export function monthLabel(year: number, month0: number): string {
  return `${MONTH_NAMES[month0]} ${year}`;
}

export function shiftMonth(year: number, month0: number, delta: number): { year: number; month0: number } {
  const t = new Date(Date.UTC(year, month0 + delta, 1));
  return { year: t.getUTCFullYear(), month0: t.getUTCMonth() };
}

export function monthOfDayKey(key: string): { year: number; month0: number } {
  const [y, m] = key.split('-').map(Number);
  return { year: y, month0: m - 1 };
}

export function formatMarkerTime(ms: number, timezone: string): string {
  return formatIsoLocalInTimezone(ms, timezone).slice(11);
}

export function markerTooltip(
  marker: CalendarMarker,
  gridTimezone: string,
  isCurrentJob: boolean,
  showProject = false,
): string {
  const parts: string[] = [];
  // All view only: the job name alone is ambiguous across projects (D10).
  if (showProject && marker.projectName) parts.push(marker.projectName);
  parts.push(`${marker.name} · ${formatIsoLocalInTimezone(marker.ms, gridTimezone).replace('T', ' ')}`);
  if (marker.jobTimezone !== gridTimezone) {
    parts.push(`job timezone ${marker.jobTimezone} (${formatMarkerTime(marker.ms, marker.jobTimezone)} there)`);
  }
  if (!marker.enabled) parts.push('disabled (will not fire)');
  if (marker.skipped) parts.push('operator-skipped');
  if (isCurrentJob) parts.push('this job');
  return parts.join(' · ');
}

export function truncatedJobNames(jobs: ScheduleCalendarJob[]): string[] {
  return jobs.filter((j) => j.truncated).map((j) => j.name);
}

/** Minimal tree shape shared by calendar helpers and Sidebar scheduleTrees. */
export type ScheduleTreeLookup = {
  jobs?: Array<{
    /** Present on live schedule-tree responses; omit only in minimal fixtures. */
    job?: { executionMode?: string };
    runs?: Array<{
      conversation?: { id: string };
      descendants?: Array<{ id: string }>;
    }>;
  }>;
};

/**
 * Resolve a conversation object from a project's schedule tree (⏱ run or
 * descendant). Projects-tab lists deliberately omit these rows, so boot /
 * tab restore must look here — not in `listConversations` / `mapped`.
 *
 * Resume jobs are skipped: their bound chats stay on the Projects tab (same
 * rule as `sidebarTabs.scheduleConversationIds`).
 */
export function findScheduleTreeConversation<T extends { id: string }>(
  tree: {
    jobs?: Array<{
      job?: { executionMode?: string };
      runs?: Array<{ conversation?: T; descendants?: T[] }>;
    }>;
  } | undefined,
  convId: string,
): T | undefined {
  if (!convId || !tree?.jobs) return undefined;
  for (const entry of tree.jobs) {
    if (entry.job?.executionMode === 'resume_conversation') continue;
    if (!entry.runs) continue;
    for (const runEntry of entry.runs) {
      if (runEntry.conversation?.id === convId) return runEntry.conversation;
      if (runEntry.descendants) {
        for (const d of runEntry.descendants) {
          if (d.id === convId) return d;
        }
      }
    }
  }
  return undefined;
}

/** Check whether a conversation ID belongs to a schedule run or descendant spawn. */
export function isScheduleConversation(
  convId: string,
  scheduleTrees: Record<string, ScheduleTreeLookup>,
): boolean {
  if (!convId || !scheduleTrees) return false;
  for (const tree of Object.values(scheduleTrees)) {
    if (findScheduleTreeConversation(tree, convId)) return true;
  }
  return false;
}

