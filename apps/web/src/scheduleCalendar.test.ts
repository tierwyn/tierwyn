import { describe, it, expect } from 'vitest';
import {
  CALENDAR_VIEW_STORAGE_KEY,
  MAX_DAY_CHIPS,
  SCOPE_ALL,
  SCOPE_STORAGE_KEY,
  WEEKDAY_LABELS,
  addDaysToDayKey,
  buildCalendarGrid,
  buildMonthGrid,
  calendarDayKeys,
  calendarNavLabel,
  calendarWindowMs,
  dayKeyInTimezone,
  formatMarkerTime,
  findScheduleTreeConversation,
  isScheduleConversation,
  markerTooltip,
  monthDayKeys,
  monthLabel,
  monthOfDayKey,
  monthWindowMs,
  operatorTimezone,
  resolveCalendarViewMode,
  resolveScope,
  shiftCalendarAnchor,
  shiftMonth,
  truncatedJobNames,
  weekDayKeys,
  type CalendarViewMode,
  type ScheduleCalendarJob,
} from './scheduleCalendar.js';

const HOUR = 3_600_000;

function job(over: Partial<ScheduleCalendarJob> = {}): ScheduleCalendarJob {
  return {
    jobId: 'j1',
    projectId: 'p1',
    projectName: 'Alpha Project',
    name: 'nightly digest',
    timezone: 'UTC',
    enabled: true,
    scheduleKind: 'cron',
    fires: [],
    skipped: [],
    truncated: false,
    ...over,
  };
}

describe('dayKeyInTimezone', () => {
  it('returns the civil date in the given zone', () => {
    const ms = Date.UTC(2026, 7, 24, 9, 30);
    expect(dayKeyInTimezone(ms, 'UTC')).toBe('2026-08-24');
  });

  it('rolls forward when the zone is ahead of UTC', () => {
    // 23:30Z in August is 00:30 next day in Europe/London (BST, +1).
    const ms = Date.UTC(2026, 7, 24, 23, 30);
    expect(dayKeyInTimezone(ms, 'Europe/London')).toBe('2026-08-25');
  });

  it('rolls backward when the zone is behind UTC', () => {
    // 02:00Z is 22:00 the previous day in America/New_York (EDT, -4).
    const ms = Date.UTC(2026, 7, 24, 2, 0);
    expect(dayKeyInTimezone(ms, 'America/New_York')).toBe('2026-08-23');
  });
});

describe('addDaysToDayKey', () => {
  it('adds and subtracts within a month', () => {
    expect(addDaysToDayKey('2026-08-24', 1)).toBe('2026-08-25');
    expect(addDaysToDayKey('2026-08-24', -1)).toBe('2026-08-23');
    expect(addDaysToDayKey('2026-08-24', 0)).toBe('2026-08-24');
  });

  it('crosses month and year boundaries', () => {
    expect(addDaysToDayKey('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDaysToDayKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDayKey('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('handles leap days', () => {
    expect(addDaysToDayKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToDayKey('2028-02-29', 1)).toBe('2028-03-01');
    expect(addDaysToDayKey('2027-02-28', 1)).toBe('2027-03-01');
  });
});

describe('monthDayKeys', () => {
  it('returns exactly 42 keys starting on the Monday of the first week', () => {
    // 2026-08-01 is a Saturday, so the grid starts Monday 2026-07-27.
    const days = monthDayKeys(2026, 7);
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2026-07-27');
    expect(days[41]).toBe('2026-09-06');
    expect(days).toContain('2026-08-01');
    expect(days).toContain('2026-08-31');
  });

  it('is always 42 cells even for a short month', () => {
    expect(monthDayKeys(2027, 1)).toHaveLength(42); // February 2027, 28 days
    expect(monthDayKeys(2028, 1)).toHaveLength(42); // February 2028, 29 days
  });

  it('starts exactly on the 1st when the 1st is a Monday', () => {
    // 2027-02-01 is a Monday.
    expect(monthDayKeys(2027, 1)[0]).toBe('2027-02-01');
  });

  it('produces consecutive days with no gaps', () => {
    const days = monthDayKeys(2026, 11);
    for (let i = 1; i < days.length; i++) {
      expect(days[i]).toBe(addDaysToDayKey(days[i - 1], 1));
    }
  });
});

describe('monthWindowMs', () => {
  it('brackets noon of the first and last cells with 18h of padding', () => {
    const days = monthDayKeys(2026, 7);
    const { from, to } = monthWindowMs(days, 'UTC');
    expect(from).toBe(Date.UTC(2026, 6, 27, 12) - 18 * HOUR);
    expect(to).toBe(Date.UTC(2026, 8, 6, 12) + 18 * HOUR);
  });

  it('covers local midnight of the first and last cells', () => {
    const days = monthDayKeys(2026, 7);
    for (const tz of ['UTC', 'Europe/London', 'Pacific/Auckland', 'America/Los_Angeles']) {
      const { from, to } = monthWindowMs(days, tz);
      expect(dayKeyInTimezone(from, tz) <= days[0]).toBe(true);
      expect(dayKeyInTimezone(to, tz) >= days[41]).toBe(true);
    }
  });

  it('never returns NaN in a zone whose DST jump deletes local midnight', () => {
    // America/Santiago springs forward at 00:00 — 'YYYY-MM-DDT00:00' does not exist there.
    const days = monthDayKeys(2026, 8);
    const { from, to } = monthWindowMs(days, 'America/Santiago');
    expect(Number.isFinite(from)).toBe(true);
    expect(Number.isFinite(to)).toBe(true);
    expect(to).toBeGreaterThan(from);
  });

  it('stays inside the route 62-day window cap', () => {
    const days = monthDayKeys(2026, 7);
    const { from, to } = monthWindowMs(days, 'UTC');
    expect(to - from).toBeLessThanOrEqual(62 * 24 * HOUR);
  });
});

describe('buildMonthGrid', () => {
  const nowMs = Date.UTC(2026, 7, 24, 10, 0);

  it('buckets fires into the correct day cell', () => {
    const grid = buildMonthGrid({
      year: 2026,
      month0: 7,
      timezone: 'UTC',
      nowMs,
      jobs: [job({ fires: [Date.UTC(2026, 7, 24, 9, 0), Date.UTC(2026, 7, 25, 9, 0)] })],
    });
    const d24 = grid.find((d) => d.key === '2026-08-24')!;
    const d25 = grid.find((d) => d.key === '2026-08-25')!;
    expect(d24.markers).toHaveLength(1);
    expect(d25.markers).toHaveLength(1);
    expect(d24.markers[0].name).toBe('nightly digest');
    expect(d24.markers[0].skipped).toBe(false);
  });

  it('marks skipped fires and keeps them out of the fire markers', () => {
    const grid = buildMonthGrid({
      year: 2026,
      month0: 7,
      timezone: 'UTC',
      nowMs,
      jobs: [job({ fires: [Date.UTC(2026, 7, 24, 9, 0)], skipped: [Date.UTC(2026, 7, 24, 12, 0)] })],
    });
    const d24 = grid.find((d) => d.key === '2026-08-24')!;
    expect(d24.markers.map((m) => m.skipped)).toEqual([false, true]);
  });

  it('flags inMonth and isToday correctly', () => {
    const grid = buildMonthGrid({ year: 2026, month0: 7, timezone: 'UTC', nowMs, jobs: [] });
    expect(grid[0].key).toBe('2026-07-27');
    expect(grid[0].inMonth).toBe(false);
    expect(grid[0].dayOfMonth).toBe(27);
    expect(grid.find((d) => d.key === '2026-08-01')!.inMonth).toBe(true);
    expect(grid.filter((d) => d.isToday)).toHaveLength(1);
    expect(grid.find((d) => d.isToday)!.key).toBe('2026-08-24');
  });

  it('discards markers that fall outside the 42-cell grid', () => {
    const grid = buildMonthGrid({
      year: 2026,
      month0: 7,
      timezone: 'UTC',
      nowMs,
      jobs: [job({ fires: [Date.UTC(2026, 9, 15, 9, 0)] })], // October — off-grid
    });
    expect(grid.reduce((n, d) => n + d.markers.length, 0)).toBe(0);
  });

  it('sorts a day cell by time, then job name, then id', () => {
    const at = Date.UTC(2026, 7, 24, 9, 0);
    const grid = buildMonthGrid({
      year: 2026,
      month0: 7,
      timezone: 'UTC',
      nowMs,
      jobs: [
        job({ jobId: 'b', name: 'zeta', fires: [at] }),
        job({ jobId: 'a', name: 'alpha', fires: [at, at - HOUR] }),
      ],
    });
    const d24 = grid.find((d) => d.key === '2026-08-24')!;
    expect(d24.markers.map((m) => `${m.ms}:${m.name}`)).toEqual([
      `${at - HOUR}:alpha`,
      `${at}:alpha`,
      `${at}:zeta`,
    ]);
  });

  it('splits a busy day into 4 visible chips plus overflow', () => {
    const base = Date.UTC(2026, 7, 24, 1, 0);
    const fires = Array.from({ length: 7 }, (_, i) => base + i * HOUR);
    const grid = buildMonthGrid({
      year: 2026, month0: 7, timezone: 'UTC', nowMs, jobs: [job({ fires })],
    });
    const d24 = grid.find((d) => d.key === '2026-08-24')!;
    expect(MAX_DAY_CHIPS).toBe(4);
    expect(d24.markers).toHaveLength(7);
    expect(d24.visible).toHaveLength(4);
    expect(d24.overflow).toHaveLength(3);
    expect(d24.visible[0].ms).toBe(base);
    expect(d24.overflow[0].ms).toBe(base + 4 * HOUR);
  });

  it('honours a maxChips override', () => {
    const base = Date.UTC(2026, 7, 24, 1, 0);
    const grid = buildMonthGrid({
      year: 2026, month0: 7, timezone: 'UTC', nowMs, maxChips: 2,
      jobs: [job({ fires: [base, base + HOUR, base + 2 * HOUR] })],
    });
    const d24 = grid.find((d) => d.key === '2026-08-24')!;
    expect(d24.visible).toHaveLength(2);
    expect(d24.overflow).toHaveLength(1);
  });

  it('buckets by the grid timezone, not the owning job timezone', () => {
    // 23:30Z belongs to 2026-08-25 in Europe/London even though the job is a Tokyo job.
    const grid = buildMonthGrid({
      year: 2026,
      month0: 7,
      timezone: 'Europe/London',
      nowMs,
      jobs: [job({ timezone: 'Asia/Tokyo', fires: [Date.UTC(2026, 7, 24, 23, 30)] })],
    });
    expect(grid.find((d) => d.key === '2026-08-25')!.markers).toHaveLength(1);
    expect(grid.find((d) => d.key === '2026-08-24')!.markers).toHaveLength(0);
    // The marker still remembers its own zone for the tooltip.
    expect(grid.find((d) => d.key === '2026-08-25')!.markers[0].jobTimezone).toBe('Asia/Tokyo');
  });

  it('returns 42 empty cells when there are no jobs', () => {
    const grid = buildMonthGrid({ year: 2026, month0: 7, timezone: 'UTC', nowMs, jobs: [] });
    expect(grid).toHaveLength(42);
    expect(grid.every((d) => d.markers.length === 0)).toBe(true);
  });

  it('omits markers for disabled jobs', () => {
    const grid = buildMonthGrid({
      year: 2026,
      month0: 7,
      timezone: 'UTC',
      nowMs,
      jobs: [job({ enabled: false, fires: [Date.UTC(2026, 7, 24, 9, 0)] })],
    });
    expect(grid.reduce((n, d) => n + d.markers.length, 0)).toBe(0);
  });
});

describe('month label / navigation helpers', () => {
  it('labels a month in English with a full year', () => {
    expect(monthLabel(2026, 7)).toBe('August 2026');
    expect(monthLabel(2027, 0)).toBe('January 2027');
  });

  it('shifts across year boundaries', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month0: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month0: 11 });
    expect(shiftMonth(2026, 7, 0)).toEqual({ year: 2026, month0: 7 });
  });

  it('derives the month of a day key', () => {
    expect(monthOfDayKey('2026-08-24')).toEqual({ year: 2026, month0: 7 });
  });

  it('exposes seven Monday-first weekday labels', () => {
    expect(WEEKDAY_LABELS).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });
});

describe('chip formatting', () => {
  it('formats a marker time as HH:mm in the grid timezone', () => {
    expect(formatMarkerTime(Date.UTC(2026, 7, 24, 9, 5), 'UTC')).toBe('09:05');
    expect(formatMarkerTime(Date.UTC(2026, 7, 24, 9, 5), 'Europe/London')).toBe('10:05');
  });

  it('builds a plain tooltip for an enabled same-timezone job', () => {
    const marker = {
      jobId: 'j1', projectId: 'p1', projectName: 'Alpha Project',
      name: 'nightly digest', ms: Date.UTC(2026, 7, 24, 9, 0),
      enabled: true, skipped: false, jobTimezone: 'UTC',
    };
    expect(markerTooltip(marker, 'UTC', false)).toBe('nightly digest · 2026-08-24 09:00');
  });

  it('discloses the job timezone only when it differs from the grid', () => {
    const marker = {
      jobId: 'j1', projectId: 'p1', projectName: 'Alpha Project',
      name: 'tokyo sweep', ms: Date.UTC(2026, 7, 24, 9, 0),
      enabled: true, skipped: false, jobTimezone: 'Asia/Tokyo',
    };
    expect(markerTooltip(marker, 'UTC', false)).toBe(
      'tokyo sweep · 2026-08-24 09:00 · job timezone Asia/Tokyo (18:00 there)',
    );
  });

  it('appends disabled, skipped and this-job suffixes in a fixed order', () => {
    const marker = {
      jobId: 'j1', projectId: 'p1', projectName: 'Alpha Project',
      name: 'paused job', ms: Date.UTC(2026, 7, 24, 9, 0),
      enabled: false, skipped: true, jobTimezone: 'UTC',
    };
    expect(markerTooltip(marker, 'UTC', true)).toBe(
      'paused job · 2026-08-24 09:00 · disabled (will not fire) · operator-skipped · this job',
    );
  });

  it('prepends the project name when showProject is true (All view, D10)', () => {
    const marker = {
      jobId: 'j1', projectId: 'p1', projectName: 'Alpha Project',
      name: 'nightly digest', ms: Date.UTC(2026, 7, 24, 9, 0),
      enabled: true, skipped: false, jobTimezone: 'UTC',
    };
    expect(markerTooltip(marker, 'UTC', false, true)).toBe(
      'Alpha Project · nightly digest · 2026-08-24 09:00',
    );
  });

  it('omits the project name when showProject is false or the name is empty', () => {
    const base = {
      jobId: 'j1', projectId: 'p1', name: 'nightly digest',
      ms: Date.UTC(2026, 7, 24, 9, 0),
      enabled: true, skipped: false, jobTimezone: 'UTC',
    };
    expect(markerTooltip({ ...base, projectName: 'Alpha Project' }, 'UTC', false))
      .toBe('nightly digest · 2026-08-24 09:00');
    expect(markerTooltip({ ...base, projectName: '' }, 'UTC', false, true))
      .toBe('nightly digest · 2026-08-24 09:00');
  });
});

describe('truncatedJobNames', () => {
  it('lists only truncated jobs, in response order', () => {
    expect(truncatedJobNames([
      job({ jobId: 'a', name: 'alpha', truncated: false }),
      job({ jobId: 'b', name: 'beta', truncated: true }),
      job({ jobId: 'c', name: 'gamma', truncated: true }),
    ])).toEqual(['beta', 'gamma']);
  });

  it('returns an empty array when nothing was truncated', () => {
    expect(truncatedJobNames([job()])).toEqual([]);
  });
});

describe('buildMonthGrid — project identity', () => {
  it('copies projectId and projectName onto every marker (D9)', () => {
    const grid = buildMonthGrid({
      year: 2026,
      month0: 7,
      timezone: 'UTC',
      nowMs: Date.UTC(2026, 7, 24, 10, 0),
      jobs: [job({
        projectId: 'p2',
        projectName: 'Beta Project',
        fires: [Date.UTC(2026, 7, 24, 9, 0)],
        skipped: [Date.UTC(2026, 7, 24, 12, 0)],
      })],
    });
    const d24 = grid.find((d) => d.key === '2026-08-24')!;
    expect(d24.markers).toHaveLength(2);
    for (const m of d24.markers) {
      expect(m.projectId).toBe('p2');
      expect(m.projectName).toBe('Beta Project');
    }
  });
});

describe('operatorTimezone', () => {
  it('returns a non-empty zone that dayKeyInTimezone accepts', () => {
    const tz = operatorTimezone();
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
    expect(dayKeyInTimezone(Date.UTC(2026, 7, 24, 12, 0), tz)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is usable as a grid timezone end-to-end', () => {
    const tz = operatorTimezone();
    const days = monthDayKeys(2026, 7);
    const { from, to } = monthWindowMs(days, tz);
    expect(Number.isFinite(from)).toBe(true);
    expect(Number.isFinite(to)).toBe(true);
    expect(to).toBeGreaterThan(from);
  });
});

describe('resolveScope', () => {
  const ids = ['p1', 'p2'];

  it('exposes the locked storage key and sentinel', () => {
    expect(SCOPE_STORAGE_KEY).toBe('tierwyn.scheduleCalendar.scope');
    expect(SCOPE_ALL).toBe('all');
  });

  it('falls back to all for null, undefined and empty string', () => {
    expect(resolveScope(null, ids)).toBe('all');
    expect(resolveScope(undefined, ids)).toBe('all');
    expect(resolveScope('', ids)).toBe('all');
  });

  it('passes the all sentinel through', () => {
    expect(resolveScope('all', ids)).toBe('all');
    expect(resolveScope('all', [])).toBe('all');
  });

  it('keeps a stored id that still exists', () => {
    expect(resolveScope('p2', ids)).toBe('p2');
  });

  it('falls back to all for a deleted or unknown project id (D7)', () => {
    expect(resolveScope('p9', ids)).toBe('all');
    expect(resolveScope('p1', [])).toBe('all');
  });
});

describe('resolveCalendarViewMode', () => {
  it('exposes the storage key', () => {
    expect(CALENDAR_VIEW_STORAGE_KEY).toBe('tierwyn.scheduleCalendar.viewMode');
  });

  it('resolves valid view modes and defaults to month', () => {
    expect(resolveCalendarViewMode('month')).toBe('month');
    expect(resolveCalendarViewMode('week')).toBe('week');
    expect(resolveCalendarViewMode('day')).toBe('day');
    expect(resolveCalendarViewMode(null)).toBe('month');
    expect(resolveCalendarViewMode(undefined)).toBe('month');
    expect(resolveCalendarViewMode('invalid')).toBe('month');
  });
});

describe('weekDayKeys', () => {
  it('returns Monday-Sunday 7 days for a given date', () => {
    // 2026-08-25 is a Tuesday. Week starts Monday 2026-08-24 and ends Sunday 2026-08-30.
    const week = weekDayKeys('2026-08-25');
    expect(week).toHaveLength(7);
    expect(week[0]).toBe('2026-08-24');
    expect(week[1]).toBe('2026-08-25');
    expect(week[6]).toBe('2026-08-30');
  });

  it('correctly handles month boundaries in week keys', () => {
    // 2026-09-02 is a Wednesday. Week starts Mon 2026-08-31 to Sun 2026-09-06.
    const week = weekDayKeys('2026-09-02');
    expect(week).toHaveLength(7);
    expect(week[0]).toBe('2026-08-31');
    expect(week[1]).toBe('2026-09-01');
    expect(week[6]).toBe('2026-09-06');
  });
});

describe('calendarDayKeys', () => {
  it('returns 42 keys for month view', () => {
    const keys = calendarDayKeys('2026-08-25', 'month');
    expect(keys).toHaveLength(42);
    expect(keys).toEqual(monthDayKeys(2026, 7));
  });

  it('returns 7 keys for week view', () => {
    const keys = calendarDayKeys('2026-08-25', 'week');
    expect(keys).toHaveLength(7);
    expect(keys).toEqual(weekDayKeys('2026-08-25'));
  });

  it('returns 1 key for day view', () => {
    const keys = calendarDayKeys('2026-08-25', 'day');
    expect(keys).toEqual(['2026-08-25']);
  });
});

describe('shiftCalendarAnchor', () => {
  it('shifts by month in month view', () => {
    expect(shiftCalendarAnchor('2026-08-25', 'month', 1)).toBe('2026-09-25');
    expect(shiftCalendarAnchor('2026-08-25', 'month', -1)).toBe('2026-07-25');
    // Month length clamping (e.g. Aug 31 -> Sep 30)
    expect(shiftCalendarAnchor('2026-08-31', 'month', 1)).toBe('2026-09-30');
  });

  it('shifts by 7 days in week view', () => {
    expect(shiftCalendarAnchor('2026-08-25', 'week', 1)).toBe('2026-09-01');
    expect(shiftCalendarAnchor('2026-08-25', 'week', -1)).toBe('2026-08-18');
  });

  it('shifts by 1 day in day view', () => {
    expect(shiftCalendarAnchor('2026-08-25', 'day', 1)).toBe('2026-08-26');
    expect(shiftCalendarAnchor('2026-08-25', 'day', -1)).toBe('2026-08-24');
  });
});

describe('calendarNavLabel', () => {
  it('formats month label', () => {
    expect(calendarNavLabel('2026-08-25', 'month')).toBe('August 2026');
  });

  it('formats week label within same month', () => {
    expect(calendarNavLabel('2026-08-25', 'week')).toBe('24 – 30 Aug 2026');
  });

  it('formats week label across different months in same year', () => {
    expect(calendarNavLabel('2026-09-02', 'week')).toBe('31 Aug – 6 Sep 2026');
  });

  it('formats day label with weekday and full date', () => {
    expect(calendarNavLabel('2026-08-25', 'day')).toBe('Tue, 25 Aug 2026');
  });
});

describe('buildCalendarGrid across view modes', () => {
  const nowMs = Date.UTC(2026, 7, 25, 10, 0);

  it('builds a week grid with 7 days', () => {
    const days = weekDayKeys('2026-08-25');
    const grid = buildCalendarGrid({
      days,
      viewMode: 'week',
      timezone: 'UTC',
      nowMs,
      jobs: [job({ fires: [Date.UTC(2026, 7, 25, 14, 0)] })],
    });
    expect(grid).toHaveLength(7);
    const tuesday = grid.find((d) => d.key === '2026-08-25')!;
    expect(tuesday.markers).toHaveLength(1);
    expect(tuesday.isToday).toBe(true);
    expect(tuesday.inMonth).toBe(true);
  });

  it('builds a day grid with 1 day containing all markers', () => {
    const days = ['2026-08-25'];
    const grid = buildCalendarGrid({
      days,
      viewMode: 'day',
      timezone: 'UTC',
      nowMs,
      jobs: [
        job({ name: 'job 1', fires: [Date.UTC(2026, 7, 25, 9, 0)] }),
        job({ name: 'job 2', fires: [Date.UTC(2026, 7, 25, 17, 30)] }),
      ],
    });
    expect(grid).toHaveLength(1);
    expect(grid[0].markers).toHaveLength(2);
    expect(grid[0].visible).toHaveLength(2);
    expect(grid[0].overflow).toHaveLength(0);
  });
});

describe('isScheduleConversation', () => {
  const scheduleTrees = {
    p1: {
      jobs: [
        {
          job: { executionMode: 'spawn_child' },
          runs: [
            {
              conversation: { id: 'run-conv-1' },
              descendants: [{ id: 'subagent-conv-1' }, { id: 'subagent-conv-2' }],
            },
          ],
        },
        {
          job: { executionMode: 'resume_conversation' },
          runs: [
            {
              conversation: { id: 'bound-chat' },
              descendants: [{ id: 'bound-child' }],
            },
          ],
        },
      ],
    },
  };

  it('identifies schedule run conversation IDs', () => {
    expect(isScheduleConversation('run-conv-1', scheduleTrees)).toBe(true);
  });

  it('identifies descendant subagent conversation IDs under schedule runs', () => {
    expect(isScheduleConversation('subagent-conv-1', scheduleTrees)).toBe(true);
    expect(isScheduleConversation('subagent-conv-2', scheduleTrees)).toBe(true);
  });

  it('returns false for regular project conversations and unknown IDs', () => {
    expect(isScheduleConversation('regular-chat-conv', scheduleTrees)).toBe(false);
    expect(isScheduleConversation('', scheduleTrees)).toBe(false);
  });

  it('does not treat a resume-bound chat (or its descendants) as a schedule conversation', () => {
    expect(isScheduleConversation('bound-chat', scheduleTrees)).toBe(false);
    expect(isScheduleConversation('bound-child', scheduleTrees)).toBe(false);
  });
});

describe('findScheduleTreeConversation', () => {
  const runConv = {
    id: 'run-conv-1',
    projectId: 'p1',
    title: '⏱ tick',
    createdAt: 1,
    updatedAt: 2,
  };
  const childConv = {
    id: 'subagent-conv-1',
    projectId: 'p1',
    title: 'child',
    parentConversationId: 'run-conv-1',
    createdAt: 3,
    updatedAt: 4,
  };
  const boundConv = {
    id: 'bound-chat',
    projectId: 'p1',
    title: 'bound',
    createdAt: 5,
    updatedAt: 6,
  };
  const tree = {
    jobs: [
      {
        job: { executionMode: 'spawn_child' },
        runs: [
          {
            conversation: runConv,
            descendants: [childConv],
          },
        ],
      },
      {
        job: { executionMode: 'resume_conversation' },
        runs: [
          {
            conversation: boundConv,
            descendants: [],
          },
        ],
      },
    ],
  };

  it('returns the run conversation object (not just a bool)', () => {
    expect(findScheduleTreeConversation(tree, 'run-conv-1')).toBe(runConv);
  });

  it('returns a descendant conversation under a run', () => {
    expect(findScheduleTreeConversation(tree, 'subagent-conv-1')).toBe(childConv);
  });

  it('returns undefined for a fired resume-bound chat (stays on Projects tab)', () => {
    expect(findScheduleTreeConversation(tree, 'bound-chat')).toBeUndefined();
  });

  it('returns undefined for unknown ids / empty tree', () => {
    expect(findScheduleTreeConversation(tree, 'regular-chat-conv')).toBeUndefined();
    expect(findScheduleTreeConversation(undefined, 'run-conv-1')).toBeUndefined();
    expect(findScheduleTreeConversation({ jobs: [] }, 'run-conv-1')).toBeUndefined();
    expect(findScheduleTreeConversation(tree, '')).toBeUndefined();
  });
});

