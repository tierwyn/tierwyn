/**
 * Full-window schedule calendar: the Schedules main pane when no job is selected.
 *
 * Owns its own project list (D6) — directoryRef in App is a ref, not state, so it
 * cannot drive a reactive dropdown without adding an App-wide re-render on every
 * sidebar refresh. One GET /projects on mount is cheaper and self-contained.
 *
 * Axis is the operator's own timezone (D8): there is no selected job to borrow
 * one from. The in-job FW-20 grid still uses the job's zone.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@tierwyn/shared';
import { api } from '../api.js';
import {
  CALENDAR_VIEW_STORAGE_KEY,
  SCOPE_ALL,
  SCOPE_STORAGE_KEY,
  buildCalendarGrid,
  calendarDayKeys,
  calendarWindowMs,
  dayKeyInTimezone,
  operatorTimezone,
  resolveCalendarViewMode,
  resolveScope,
  type CalendarViewMode,
  type ScheduleCalendarJob,
} from '../scheduleCalendar.js';
import { lsGet, lsSet } from '../prefixedStorage.js';
import { SelectDropdown } from './SelectDropdown.js';
import { ScheduleCalendarGrid } from './ScheduleCalendarGrid.js';

export interface ScheduleCalendarPaneProps {
  /** Bumped by App on schedule_updated — re-fires the fetch. */
  refetchTrigger?: number;
  onSelectJob: (project: Project, jobId: string) => void;
}

export function ScheduleCalendarPane({ refetchTrigger = 0, onSelectJob }: ScheduleCalendarPaneProps) {
  const timezone = useMemo(() => operatorTimezone(), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scope, setScope] = useState<string>(SCOPE_ALL);
  const [viewMode, setViewMode] = useState<CalendarViewMode>(() => {
    try {
      return resolveCalendarViewMode(lsGet(CALENDAR_VIEW_STORAGE_KEY));
    } catch {
      return 'month';
    }
  });
  const [anchorDayKey, setAnchorDayKey] = useState<string>(() => dayKeyInTimezone(Date.now(), timezone));
  const [jobs, setJobs] = useState<ScheduleCalendarJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Project list first, then restore the persisted scope against it — validating
  // a stored id needs something to validate against (D7).
  useEffect(() => {
    let cancelled = false;
    api.listProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setScope(resolveScope(lsGet(SCOPE_STORAGE_KEY), list.map((p) => p.id)));
      })
      .catch(() => { /* dropdown degrades to All-only; the grid still loads */ });
    return () => { cancelled = true; };
  }, []);

  const dayKeys = useMemo(
    () => calendarDayKeys(anchorDayKey, viewMode),
    [anchorDayKey, viewMode],
  );

  useEffect(() => {
    let cancelled = false;
    const { from, to } = calendarWindowMs(dayKeys, timezone);
    setLoading(true);
    setError(null);
    api.scheduleCalendarGlobal(from, to, scope === SCOPE_ALL ? undefined : scope)
      .then((r) => { if (!cancelled) setJobs(r.jobs); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, dayKeys, timezone, refetchTrigger]);

  const days = useMemo(
    () => buildCalendarGrid({
      days: dayKeys,
      viewMode,
      timezone,
      nowMs: Date.now(),
      jobs,
      anchorDayKey,
    }),
    [dayKeys, viewMode, timezone, jobs, anchorDayKey],
  );

  const changeScope = (next: string) => {
    setScope(next);
    lsSet(SCOPE_STORAGE_KEY, next);
  };

  const changeViewMode = (next: CalendarViewMode) => {
    setViewMode(next);
    lsSet(CALENDAR_VIEW_STORAGE_KEY, next);
  };

  const scopeOptions = [
    { value: SCOPE_ALL, label: 'All projects' },
    ...projects.map((p) => ({ value: p.id, label: p.name })),
  ];
  const scopeName = scope === SCOPE_ALL
    ? 'every project'
    : (projects.find((p) => p.id === scope)?.name ?? 'this project');

  return (
    <div className="schedule-calendar-pane">
      <div className="schedule-calendar-pane-head">
        <h2 className="schedule-calendar-pane-title">Schedule calendar</h2>
        <div className="schedule-calendar-scope">
          <span className="schedule-calendar-scope-label">Scope</span>
          <SelectDropdown options={scopeOptions} value={scope} onChange={changeScope} searchable />
        </div>
      </div>
      <div className="schedule-calendar-pane-hint">
        Every schedule in {scopeName}, shown in {timezone}. Past fires are not shown. Click a fire to open that job.
      </div>
      <ScheduleCalendarGrid
        days={days}
        timezone={timezone}
        anchorDayKey={anchorDayKey}
        viewMode={viewMode}
        onAnchorChange={setAnchorDayKey}
        onViewModeChange={changeViewMode}
        loading={loading}
        error={error}
        jobs={jobs}
        showProject
        onSelectMarker={(m) => {
          const p = projects.find((proj) => proj.id === m.projectId);
          // Unresolvable = project deleted mid-session; a no-op beats a bad route.
          if (p) onSelectJob(p, m.jobId);
        }}
      />
    </div>
  );
}
