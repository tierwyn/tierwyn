/**
 * Shared month/week/day calendar grid presentation for both calendar surfaces:
 *   - the in-job FW-20 grid inside ScheduleBrowser (job timezone, current-job chip)
 *   - the full-window ScheduleCalendarPane (operator timezone, project in tooltip)
 *
 * Owns the nav (‹ / title / › / Today), view toggles (Month | Week | Day), grid
 * cells, day view cards, chips, overflow, and notes.
 *
 * Contains NO calendar arithmetic: every date computation lives in scheduleCalendar.ts
 * so it is covered by node Vitest.
 */
import {
  WEEKDAY_LABELS,
  dayKeyInTimezone,
  formatMarkerTime,
  markerTooltip,
  calendarNavLabel,
  shiftCalendarAnchor,
  truncatedJobNames,
  type CalendarDay,
  type CalendarMarker,
  type CalendarViewMode,
  type ScheduleCalendarJob,
} from '../scheduleCalendar.js';

export interface MonthAnchor { year: number; month0: number }

export interface ScheduleCalendarGridProps {
  /** Cells from buildCalendarGrid. */
  days: CalendarDay[];
  /** Grid axis: the selected job's zone in-job, the operator's zone full-window. */
  timezone: string;
  /** Primary anchor date as YYYY-MM-DD. */
  anchorDayKey?: string;
  /** Active view mode. Defaults to 'month'. */
  viewMode?: CalendarViewMode;
  onAnchorChange?: (anchorDayKey: string) => void;
  onViewModeChange?: (viewMode: CalendarViewMode) => void;
  /** Legacy month anchor props for backwards compatibility. */
  monthAnchor?: MonthAnchor;
  onMonthChange?: (anchor: MonthAnchor) => void;
  loading: boolean;
  error: string | null;
  /** The raw response rows — only used for the truncation note. */
  jobs: ScheduleCalendarJob[];
  /** Chips for this job get `.current`, a "this job" tooltip and a dead click. */
  currentJobId?: string;
  /** All view: prefix tooltips with the owning project name. */
  showProject?: boolean;
  onSelectMarker?: (marker: CalendarMarker) => void;
}

export function ScheduleCalendarGrid({
  days,
  timezone,
  anchorDayKey: anchorDayKeyProp,
  viewMode = 'month',
  onAnchorChange,
  onViewModeChange,
  monthAnchor,
  onMonthChange,
  loading,
  error,
  jobs,
  currentJobId,
  showProject = false,
  onSelectMarker,
}: ScheduleCalendarGridProps) {
  const truncated = truncatedJobNames(jobs);
  const empty = !loading && days.every((d) => d.markers.length === 0);

  // Derive anchorDayKey from prop or legacy monthAnchor
  const anchorDayKey = anchorDayKeyProp
    ?? (monthAnchor
      ? `${monthAnchor.year}-${String(monthAnchor.month0 + 1).padStart(2, '0')}-01`
      : dayKeyInTimezone(Date.now(), timezone));

  const handleNav = (delta: number) => {
    const nextKey = shiftCalendarAnchor(anchorDayKey, viewMode, delta);
    if (onAnchorChange) {
      onAnchorChange(nextKey);
    } else if (onMonthChange) {
      const [y, m] = nextKey.split('-').map(Number);
      onMonthChange({ year: y, month0: m - 1 });
    }
  };

  const handleToday = () => {
    const todayKey = dayKeyInTimezone(Date.now(), timezone);
    if (onAnchorChange) {
      onAnchorChange(todayKey);
    } else if (onMonthChange) {
      const [y, m] = todayKey.split('-').map(Number);
      onMonthChange({ year: y, month0: m - 1 });
    }
  };

  return (
    <div className="schedule-calendar">
      <div className="schedule-calendar-nav">
        <div className="schedule-calendar-nav-left">
          <button
            type="button"
            className="modal-btn"
            title="Previous"
            onClick={() => handleNav(-1)}
          >
            ‹
          </button>
          <span className="schedule-calendar-month">
            {calendarNavLabel(anchorDayKey, viewMode)}
          </span>
          <button
            type="button"
            className="modal-btn"
            title="Next"
            onClick={() => handleNav(1)}
          >
            ›
          </button>
          <button
            type="button"
            className="modal-btn"
            title="Jump to current date"
            onClick={handleToday}
          >
            Today
          </button>
          {loading && <span className="schedule-calendar-note" style={{ margin: 0, marginLeft: 8 }}>Loading calendar…</span>}
        </div>

        {onViewModeChange && (
          <div className="schedule-calendar-view-toggle">
            <button
              type="button"
              className={`schedule-calendar-view-btn${viewMode === 'month' ? ' active' : ''}`}
              onClick={() => onViewModeChange('month')}
            >
              Month
            </button>
            <button
              type="button"
              className={`schedule-calendar-view-btn${viewMode === 'week' ? ' active' : ''}`}
              onClick={() => onViewModeChange('week')}
            >
              Week
            </button>
            <button
              type="button"
              className={`schedule-calendar-view-btn${viewMode === 'day' ? ' active' : ''}`}
              onClick={() => onViewModeChange('day')}
            >
              Day
            </button>
          </div>
        )}
      </div>

      {error ? (
        <div style={{ fontSize: 12, color: 'var(--red)' }}>
          Could not load the calendar: {error}
        </div>
      ) : (
        <>
          {viewMode !== 'day' ? (
            <div className={`schedule-calendar-grid view-${viewMode}`}>
              {WEEKDAY_LABELS.map((w, i) => (
                <div key={w} className="schedule-calendar-weekday">
                  <span>{w}</span>
                  {viewMode === 'week' && days[i] && (
                    <span className="schedule-calendar-weekday-date">{days[i].dayOfMonth}</span>
                  )}
                </div>
              ))}
              {days.map((day) => (
                <div
                  key={day.key}
                  className={
                    `schedule-calendar-day${day.inMonth ? '' : ' out-of-month'}${day.isToday ? ' today' : ''}`
                    + (viewMode === 'week' ? ' week-cell' : '')
                  }
                >
                  {viewMode === 'month' && (
                    <div className="schedule-calendar-daynum">{day.dayOfMonth}</div>
                  )}
                  {day.visible.map((m) => {
                    const isCurrent = currentJobId !== undefined && m.jobId === currentJobId;
                    return (
                      <button
                        key={`${m.jobId}-${m.ms}-${m.skipped ? 's' : 'f'}`}
                        type="button"
                        className={
                          `schedule-calendar-chip${m.enabled ? '' : ' disabled'}`
                          + `${m.skipped ? ' skipped' : ''}${isCurrent ? ' current' : ''}`
                        }
                        title={markerTooltip(m, timezone, isCurrent, showProject)}
                        onClick={() => { if (!isCurrent) onSelectMarker?.(m); }}
                      >
                        <span className="schedule-calendar-chip-time">
                          {formatMarkerTime(m.ms, timezone)}
                        </span>
                        <span className="schedule-calendar-chip-name">{m.name}</span>
                      </button>
                    );
                  })}
                  {day.overflow.length > 0 && (
                    <div
                      className="schedule-calendar-overflow"
                      title={day.overflow
                        .map((m) => `${formatMarkerTime(m.ms, timezone)} ${m.name}`)
                        .join('\n')}
                    >
                      +{day.overflow.length} more
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            /* Day View */
            <div className="schedule-calendar-day-view">
              {days[0] && (
                <div className={`schedule-calendar-day-card${days[0].isToday ? ' today' : ''}`}>
                  <div className="schedule-calendar-day-header">
                    <span className="schedule-calendar-day-header-title">
                      {calendarNavLabel(days[0].key, 'day')}
                    </span>
                    {days[0].isToday && <span className="schedule-calendar-today-badge">Today</span>}
                  </div>
                  <div className="schedule-calendar-day-markers">
                    {days[0].markers.length === 0 ? (
                      <div className="schedule-calendar-day-empty">No fires scheduled for this day.</div>
                    ) : (
                      days[0].markers.map((m) => {
                        const isCurrent = currentJobId !== undefined && m.jobId === currentJobId;
                        return (
                          <button
                            key={`${m.jobId}-${m.ms}-${m.skipped ? 's' : 'f'}`}
                            type="button"
                            className={
                              `schedule-calendar-day-row${m.skipped ? ' skipped' : ''}${isCurrent ? ' current' : ''}`
                            }
                            title={markerTooltip(m, timezone, isCurrent, showProject)}
                            onClick={() => { if (!isCurrent) onSelectMarker?.(m); }}
                          >
                            <span className="schedule-calendar-day-time">
                              {formatMarkerTime(m.ms, timezone)}
                            </span>
                            {showProject && m.projectName && (
                              <span className="schedule-calendar-day-project">{m.projectName}</span>
                            )}
                            <span className="schedule-calendar-day-job-name">{m.name}</span>
                            {m.skipped && <span className="schedule-calendar-skipped-badge">skipped</span>}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {empty && (
            <div className="schedule-calendar-note">
              {viewMode === 'day'
                ? 'No fires projected on this day.'
                : viewMode === 'week'
                  ? 'No fires projected in this week.'
                  : 'No fires projected in this month.'}
            </div>
          )}
          {truncated.length > 0 && (
            <div className="schedule-calendar-note">
              Truncated (too many fires): {truncated.join(', ')}.
            </div>
          )}
        </>
      )}
    </div>
  );
}
