import { copyText } from '../clipboard';
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type {
  AgentProfile,
  AgentStatus,
  PatchScheduleJobRequest,
  PatchScheduleStepsRequest,
  ScheduleJobDetail,
  ScheduleRun,
  ScheduleStep,
  SpawnTemplate,
  StepStatus,
  VoiceTtsSettings,
  Workdir,
} from '@tierwyn/shared';
import {
  PACK_SLUG_RE,
  parseScheduleVariables,
  resolveStages,
  PIPELINE_MAX_STAGES,
  SCHEDULE_INHERIT_PROFILE_ID,
} from '@tierwyn/shared';
import {
  moveStageInVars,
  addStageToVars,
  removeStageFromVars,
  updateStageInVars,
  setCommitOnTickInVars,
  getUnionTemplateRoles,
  renameStageInVars,
  listStageIdsFromVars,
} from '../pipelineVars.js';
import { jobToPackDoc, slugFromJobName } from '../schedulePackForm.js';
import { formatDateTimeInTimezone, formatIsoLocalInTimezone, parseIsoLocalInTimezone } from '@tierwyn/shared';
import { api } from '../api.js';
import {
  DURATION_UNIT_OPTIONS,
  atMsToDatetimeLocal,
  durationPartsToMs,
  formatIntervalExpr,
  formatOnceExpr,
  msToDurationParts,
  parseIntervalEveryMs,
  parseOnceAtMs,
  type DurationUnit,
} from '../duration.js';
import {
  CALENDAR_VIEW_STORAGE_KEY,
  buildCalendarGrid,
  calendarDayKeys,
  calendarWindowMs,
  dayKeyInTimezone,
  resolveCalendarViewMode,
  type CalendarViewMode,
  type ScheduleCalendarJob,
} from '../scheduleCalendar.js';
import { lsGet, lsSet } from '../prefixedStorage.js';
import { ScheduleCalendarGrid } from './ScheduleCalendarGrid.js';
import { SelectDropdown } from './SelectDropdown.js';
import { ModelSelector } from './ModelSelector.js';
import { VariableValueCombobox, detectVarMode } from './VariableValueCombobox.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CronBuilderModal, describeCron } from './CronBuilderModal.js';
import { TimezoneField } from './TimezonePickerModal.js';
import { MarkdownBody } from './MarkdownBody.js';
import { FileModal } from './FileModal.js';
import {
  resolveJobAggregateDot,
  resolveRunChip,
  sessionBadgeForScheduleJob,
  type SessionBadgeFromDot,
} from '../statusDot.js';

type VarDraft = { id: string; key: string; value: string; mode: 'text' | 'dropdown' };

function newVarDraft(key = '', value = '', mode: 'text' | 'dropdown' = 'text'): VarDraft {
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
    key,
    value,
    mode,
  };
}

export interface ScheduleBrowserProps {
  projectId: string;
  jobId: string;
  /** Open a run's conversation in the main chat pane. */
  onOpenRun: (conversationId: string) => void;
  /** Open full schedule calendar. */
  onOpenCalendar?: () => void;
  /** Bumped by App when a schedule_updated frame arrives for this job. */
  refetchTrigger?: number;
  /** Optional profiles for the edit form ModelSelector; loaded via /profiles when omitted. */
  profiles?: AgentProfile[];
  profilesLoaded?: boolean;
  /** After hard-delete job — clear selection and refresh tree. */
  onJobDeleted?: (jobId: string, deletedConversationIds: string[]) => void;
  /** After soft-archive — hide from lists, keep history, free a cap slot. */
  onJobArchived?: (jobId: string) => void;
  /** After deleting a run conversation (+ subtree). */
  onRunConversationDeleted?: (deletedIds: string[]) => void;
  /** FW-20 calendar: a marker click selects that job (project-wide grid). */
  onSelectJob?: (jobId: string) => void;
  /** Live per-conversation agent status — preferred over REST run.status for colour. */
  conversationStatuses?: Record<string, AgentStatus>;
  /** Unread run conversations — same set as the sidebar job-dot aggregate. */
  unreadConversationIds?: string[];
  /** Conversations where a non-error status superseded a sticky REST error. */
  errorRecoveredConversationIds?: ReadonlySet<string>;
  /** Conversations the WS layer has observed (gates REST liveStatus fallback). */
  wsObservedConversationIds?: ReadonlySet<string>;
  /** Report aggregate job status for the session-header pill (mirrors sidebar dot). */
  onJobStatusChange?: (badge: SessionBadgeFromDot | null) => void;
  /** Voice TTS — forwarded to FileModal for path links in prompt/steer. */
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
  fileEditsEnabled?: boolean;
}

/** Progressive past-runs list — matches sidebar conversation/schedule lists. */
const RUNS_LIST_INITIAL = 7;
const RUNS_LIST_STEP = 10;

/** Progressive upcoming fires (server caps at 50). */
const UPCOMING_INITIAL = 5;
const UPCOMING_STEP = 5;
const UPCOMING_MAX = 50;

function runsLimitForPage(page: number): number {
  return RUNS_LIST_INITIAL + (page - 1) * RUNS_LIST_STEP;
}

function RunsShowMoreButton({
  hiddenCount,
  total,
  onClick,
}: {
  hiddenCount: number;
  total?: number;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const step = Math.min(hiddenCount, RUNS_LIST_STEP);
  return (
    <button
      type="button"
      className="conversation-list-toggle"
      onClick={onClick}
      title={`Show ${step} more`}
      aria-expanded={false}
    >
      <span className="conversation-list-toggle-dots" aria-hidden>···</span>
      <span className="conversation-list-toggle-count">
        {total != null ? `Show ${step} more (${total} total)` : `Show ${step} more`}
      </span>
    </button>
  );
}

function formatWhen(ms: number, timezone: string): string {
  return formatDateTimeInTimezone(ms, timezone);
}

function formatRelative(ms: number): string {
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return delta >= 0 ? 'now' : 'just now';
  if (mins < 60) return delta >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return delta >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return delta >= 0 ? `in ${days}d` : `${days}d ago`;
}

/** Human duration for interval everyMs (exact units when divisible; otherwise ~approx). */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
  const unit = (n: number, singular: string, plural: string) =>
    n === 1 ? `1 ${singular}` : `${n} ${plural}`;

  if (ms % 86_400_000 === 0) return unit(ms / 86_400_000, 'day', 'days');
  if (ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour', 'hours');
  if (ms % 60_000 === 0) return unit(ms / 60_000, 'minute', 'minutes');
  if (ms % 1000 === 0) return unit(ms / 1000, 'second', 'seconds');

  // Not aligned to a whole unit — show nearest useful measure.
  if (ms >= 86_400_000) {
    const d = ms / 86_400_000;
    return `~${d < 10 ? d.toFixed(1) : Math.round(d)} days`;
  }
  if (ms >= 3_600_000) {
    const h = ms / 3_600_000;
    return `~${h < 10 ? h.toFixed(1) : Math.round(h)} hours`;
  }
  if (ms >= 60_000) {
    const m = ms / 60_000;
    return `~${m < 10 ? m.toFixed(1) : Math.round(m)} minutes`;
  }
  return `~${Math.round(ms / 1000)} seconds`;
}

/**
 * Operator-facing schedule label.
 * interval `{"everyMs":10800000}` → "every 3 hours"
 * once `{"atMs":…}` → "once @ YYYY-MM-DD HH:mm UTC"
 * cron stays as the expression; raw JSON kept for title/tooltip.
 */
function formatScheduleLabel(
  kind: 'interval' | 'cron' | 'once' | string,
  expr: string,
  timezone = 'UTC',
): string {
  if (kind === 'cron') {
    const trimmed = expr.trim();
    if (!trimmed) return 'cron';
    const { text, valid } = describeCron(trimmed);
    return valid ? text : trimmed;
  }
  if (kind === 'interval') {
    const everyMs = parseIntervalEveryMs(expr);
    if (everyMs != null) return `every ${formatDurationMs(everyMs)}`;
  }
  if (kind === 'once') {
    const atMs = parseOnceAtMs(expr);
    if (atMs != null) {
      return `once @ ${formatIsoLocalInTimezone(atMs, timezone).replace('T', ' ')}`;
    }
  }
  return expr;
}

const STEP_STATUS_COLOR: Record<StepStatus, string> = {
  pending: 'var(--text-3)',
  ready: 'var(--accent)',
  running: 'var(--amber)',
  done: 'var(--green)',
  blocked: 'var(--red)',
  skipped: 'var(--text-3)',
};

const STEP_STATUS_OPTIONS: Array<{ value: StepStatus; label: string }> = [
  { value: 'pending', label: 'pending' },
  { value: 'ready', label: 'ready' },
  { value: 'running', label: 'running' },
  { value: 'done', label: 'done' },
  { value: 'blocked', label: 'blocked' },
  { value: 'skipped', label: 'skipped' },
];

/** Local draft for the operator form; serializes to PatchScheduleStepsRequest.steps. */
interface StepDraft {
  /** Stable React key (existing step id, or client-generated for new rows). */
  key: string;
  id?: string;
  title: string;
  body: string;
  status: StepStatus;
  /** Key of another draft this step depends on; null = no dependency. */
  dependsOnKey: string | null;
}

let stepDraftSeq = 0;
function newStepDraftKey(): string {
  stepDraftSeq += 1;
  return `new-${Date.now()}-${stepDraftSeq}`;
}

function stepsToDrafts(steps: ScheduleStep[]): StepDraft[] {
  return steps.map((s) => ({
    key: s.id,
    id: s.id,
    title: s.title,
    body: s.body,
    status: s.status,
    dependsOnKey: s.dependsOnStepId ?? null,
  }));
}

function emptyStepDraft(status: StepStatus = 'pending'): StepDraft {
  return {
    key: newStepDraftKey(),
    title: '',
    body: '',
    status,
    dependsOnKey: null,
  };
}

/**
 * Serialize form drafts to the PUT /steps body.
 * Hides JSON from the operator; still emits the structure the API expects:
 * `{ steps: [{ id?, title, body, status?, dependsOnStepId? }] }` and, when the
 * dependency is a brand-new row without an id yet, `dependsOnOrdinal` (accepted
 * by the server parser even though the shared type only documents step ids).
 */
function draftsToPutBody(drafts: StepDraft[]): PatchScheduleStepsRequest {
  const keyToOrdinal = new Map(drafts.map((d, i) => [d.key, i]));
  const steps = drafts.map((d) => {
    let dependsOnOrdinal: number | undefined;
    if (d.dependsOnKey) {
      const ord = keyToOrdinal.get(d.dependsOnKey);
      if (ord !== undefined) dependsOnOrdinal = ord;
    }
    const depId =
      dependsOnOrdinal !== undefined ? (drafts[dependsOnOrdinal]?.id ?? undefined) : undefined;

    // Prefer dependsOnStepId when the target already has a persisted id (in this
    // request array). Fall back to ordinal so newly added rows can depend on each other.
    const base: Record<string, unknown> = {
      ...(d.id ? { id: d.id } : {}),
      title: d.title.trim(),
      body: d.body,
      status: d.status,
    };
    if (dependsOnOrdinal === undefined) {
      base.dependsOnStepId = null;
    } else if (depId) {
      base.dependsOnStepId = depId;
    } else {
      base.dependsOnOrdinal = dependsOnOrdinal;
    }
    return base;
  });
  return { steps } as PatchScheduleStepsRequest;
}

const sectionStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)',
  padding: '14px 16px',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  marginBottom: 10,
  fontFamily: 'var(--ui)',
};

const metaChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  fontSize: 11,
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
};

/**
 * Inline copy button for schedule section headers (prompt template / steer).
 * Always visible (these are short title rows, not hover-reveal code blocks).
 */
function SectionCopyButton({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={async () => {
        try {
          await copyText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        padding: 0,
        background: 'transparent',
        color: copied ? 'var(--green)' : 'var(--text-3)',
        border: '1px solid var(--border)',
        borderRadius: 3,
        cursor: 'pointer',
        transition: 'color 0.12s ease',
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
    </button>
  );
}

export function ScheduleBrowser({
  projectId, jobId, onOpenRun, onOpenCalendar, refetchTrigger = 0, profiles: profilesProp,
  profilesLoaded = true,
  onJobDeleted, onJobArchived, onRunConversationDeleted, onSelectJob, conversationStatuses = {},
  unreadConversationIds = [],
  errorRecoveredConversationIds,
  wsObservedConversationIds,
  onJobStatusChange,
  tts = null, ttsSummarizeAvailable = false, fileEditsEnabled = false,
}: ScheduleBrowserProps) {
  const [job, setJob] = useState<ScheduleJobDetail | null>(null);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [runsPage, setRunsPage] = useState(1);
  const [runsFetchLimit, setRunsFetchLimit] = useState(RUNS_LIST_INITIAL);
  const [fires, setFires] = useState<number[]>([]);
  /** Operator-skipped fires still restorable via unskip (hole-punch or through). */
  const [skippedFires, setSkippedFires] = useState<number[]>([]);
  const [upcomingCount, setUpcomingCount] = useState(UPCOMING_INITIAL);
  // FW-20 calendar. Deliberately NOT reset on jobId
  // change — clicking a marker switches jobs and must not bounce back to List.
  const [upcomingView, setUpcomingView] = useState<'list' | 'calendar'>('list');
  const [calendarViewMode, setCalendarViewMode] = useState<CalendarViewMode>(() => {
    try {
      return resolveCalendarViewMode(lsGet(CALENDAR_VIEW_STORAGE_KEY));
    } catch {
      return 'month';
    }
  });
  const [calendarAnchorKey, setCalendarAnchorKey] = useState<string | null>(null);
  const [calendarJobs, setCalendarJobs] = useState<ScheduleCalendarJob[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  /** Open skip split-menu for this fireAtMs (null = closed). */
  const [skipMenuFor, setSkipMenuFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [cronBuilderOpen, setCronBuilderOpen] = useState(false);
  const [confirmDeleteJob, setConfirmDeleteJob] = useState(false);
  const [confirmArchiveJob, setConfirmArchiveJob] = useState(false);
  const [savePackOpen, setSavePackOpen] = useState(false);
  const [savePackSlug, setSavePackSlug] = useState('');
  const [savePackTitle, setSavePackTitle] = useState('');
  const [savePackDescription, setSavePackDescription] = useState('');
  const [savePackBusy, setSavePackBusy] = useState(false);
  const [savePackError, setSavePackError] = useState<string | null>(null);
  const [confirmDeleteRun, setConfirmDeleteRun] = useState<ScheduleRun | null>(null);
  const [stepsEditOpen, setStepsEditOpen] = useState(false);
  const [stepDrafts, setStepDrafts] = useState<StepDraft[]>([]);
  const [pendingDraft, setPendingDraft] = useState('');
  /** File-path links in prompt/steer markdown open FileModal (same as chat). */
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [loadedProfiles, setLoadedProfiles] = useState<AgentProfile[]>([]);
  const [templates, setTemplates] = useState<SpawnTemplate[]>([]);
  const [editForm, setEditForm] = useState({
    name: '',
    timezone: '',
    scheduleKind: 'interval' as 'interval' | 'cron' | 'once',
    /** Cron expression, or interval/once JSON — always what we PATCH. */
    scheduleExpr: '',
    /** UI-only for interval kind: amount + unit → scheduleExpr everyMs. */
    intervalAmount: 24,
    intervalUnit: 'hours' as DurationUnit,
    /** UI-only for once kind: datetime-local value (YYYY-MM-DDTHH:mm). */
    onceAtLocal: '',
    overlapPolicy: 'skip' as 'skip' | 'queue_one' | 'catch_up',
    executionMode: 'spawn_child' as 'spawn_child' | 'resume_conversation',
    profileId: '',
    promptTemplate: '',
    steer: '',
    runTimeoutMs: 0,
    /** UI-only: amount shown next to runTimeoutUnit (converted to runTimeoutMs on change/save). */
    runTimeoutAmount: 30,
    runTimeoutUnit: 'minutes' as DurationUnit,
    agentMayComplete: false,
    carryContextEnabled: false,
    workdir: 'shared' as Workdir,
    templateName: '',
    variables: [] as VarDraft[],
  });

  // Prefer prop from App; fall back to /profiles. Keep disabled profiles so an
  // existing job's profileId still resolves in ModelSelector.
  const editProfiles = profilesProp && profilesProp.length > 0 ? profilesProp : loadedProfiles;

  const attachedTemplate = useMemo(
    () => templates.find((t) => t.name === editForm.templateName),
    [templates, editForm.templateName],
  );
  const rosterProfiles = useMemo(
    () => attachedTemplate?.roles ?? [],
    [attachedTemplate],
  );
  const rosterProfileIds = useMemo(
    () => rosterProfiles.map((r) => r.profileId),
    [rosterProfiles],
  );

  const varTokenHint = useMemo(() => {
    const text = `${editForm.promptTemplate}\n${editForm.steer}`;
    const re = /\{\{vars\.(\w+)\}\}/g;
    const referenced: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!referenced.includes(m[1]!)) referenced.push(m[1]!);
    }
    const setKeys = editForm.variables.map((d) => d.key.trim()).filter(Boolean);
    return {
      missing: referenced.filter((k) => !setKeys.includes(k)),
      unused: setKeys.filter((k) => !referenced.includes(k)),
    };
  }, [editForm.promptTemplate, editForm.steer, editForm.variables]);

  const [customRoleStages, setCustomRoleStages] = useState<Record<string, boolean>>({});
  const [stageIdDrafts, setStageIdDrafts] = useState<Record<number, string>>({});
  const [stageIdWarning, setStageIdWarning] = useState<string | null>(null);

  const editVarsMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of editForm.variables) {
      const k = d.key.trim();
      if (k) m[k] = d.value;
    }
    return m;
  }, [editForm.variables]);

  const editorStageIds = useMemo(() => listStageIdsFromVars(editVarsMap), [editVarsMap]);

  const hasPipeline = useMemo(() => {
    return editForm.variables.some((d) => d.key.trim() === 'stages') || Boolean(job?.variables && 'stages' in job.variables);
  }, [editForm.variables, job?.variables]);

  const resolvedPipeline = useMemo(() => {
    if (!hasPipeline) return null;
    return resolveStages(editVarsMap);
  }, [hasPipeline, editVarsMap]);

  const availableRoles = useMemo(() => {
    const roles = attachedTemplate
      ? attachedTemplate.roles.map((r) => r.role.trim()).filter(Boolean)
      : getUnionTemplateRoles(templates);
    return Array.from(new Set(roles)).sort((a, b) => a.localeCompare(b));
  }, [attachedTemplate, templates]);

  const applyVarsMap = useCallback((nextVars: Record<string, string>) => {
    setEditForm((prev) => {
      const updatedDrafts: VarDraft[] = [];
      const handledKeys = new Set<string>();

      for (const d of prev.variables) {
        const k = d.key.trim();
        if (!k) {
          updatedDrafts.push(d);
          continue;
        }
        if (k in nextVars) {
          updatedDrafts.push({
            ...d,
            value: nextVars[k]!,
          });
          handledKeys.add(k);
        }
      }

      for (const [k, v] of Object.entries(nextVars)) {
        if (!handledKeys.has(k)) {
          updatedDrafts.push(
            newVarDraft(k, v, detectVarMode(k, v, prev.templateName, templates, editProfiles)),
          );
        }
      }

      return {
        ...prev,
        variables: updatedDrafts,
      };
    });
  }, [templates, editProfiles]);

  const commitStageId = useCallback((index: number, oldId: string) => {
    const draft = stageIdDrafts[index];
    if (draft === undefined) return;
    const result = renameStageInVars(editVarsMap, oldId, draft);
    setStageIdDrafts((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    if (!result.ok) {
      if (result.reason !== 'unchanged') {
        const trimmed = draft.trim().toLowerCase();
        setStageIdWarning(
          result.reason === 'duplicate'
            ? `Stage id "${trimmed}" is already in use`
            : `Invalid stage id "${draft.trim()}" (must match ^[a-z][a-z0-9]{0,23}$)`,
        );
      } else {
        setStageIdWarning(null);
      }
      return;
    }
    const trimmed = draft.trim().toLowerCase();
    setStageIdWarning(null);
    setCustomRoleStages((prev) => {
      if (!(oldId in prev)) return prev;
      const { [oldId]: val, ...rest } = prev;
      return { ...rest, [trimmed]: val };
    });
    applyVarsMap(result.vars);
  }, [stageIdDrafts, editVarsMap, applyVarsMap]);

  const handleAddStage = useCallback(() => {
    const stages = listStageIdsFromVars(editVarsMap);
    if (stages.length >= PIPELINE_MAX_STAGES) return;
    let candidate = 'stage';
    let counter = 1;
    while (stages.includes(counter === 1 ? candidate : `${candidate}${counter}`)) {
      counter++;
    }
    const idToAdd = counter === 1 ? candidate : `${candidate}${counter}`;
    applyVarsMap(addStageToVars(editVarsMap, idToAdd, 'none', ''));
  }, [editVarsMap, applyVarsMap]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [j, r, u] = await Promise.all([
        api.getSchedule(projectId, jobId),
        api.listScheduleRuns(projectId, jobId, runsFetchLimit),
        api.scheduleUpcoming(projectId, jobId, upcomingCount),
      ]);
      setJob(j);
      setRuns(r);
      setFires(u.fires);
      setSkippedFires(u.skipped ?? []);
      setPendingDraft(j.pendingContext ?? '');
      const timeoutParts = msToDurationParts(j.runTimeoutMs, { amount: 30, unit: 'minutes' });
      const everyMs = j.scheduleKind === 'interval' ? parseIntervalEveryMs(j.scheduleExpr) : null;
      const intervalParts = msToDurationParts(everyMs ?? 86_400_000, { amount: 24, unit: 'hours' });
      const onceAt = j.scheduleKind === 'once' ? parseOnceAtMs(j.scheduleExpr) : null;
      setEditForm({
        name: j.name,
        timezone: j.timezone,
        scheduleKind: j.scheduleKind === 'once' || j.scheduleKind === 'cron' ? j.scheduleKind : 'interval',
        scheduleExpr: j.scheduleExpr,
        intervalAmount: intervalParts.amount,
        intervalUnit: intervalParts.unit,
        onceAtLocal: onceAt != null
          ? atMsToDatetimeLocal(onceAt, j.timezone)
          : atMsToDatetimeLocal(Date.now() + 3_600_000, j.timezone),
        overlapPolicy: j.overlapPolicy,
        executionMode: j.executionMode,
        profileId: j.profileId,
        promptTemplate: j.promptTemplate,
        steer: j.steer ?? '',
        runTimeoutMs: j.runTimeoutMs,
        runTimeoutAmount: timeoutParts.amount,
        runTimeoutUnit: timeoutParts.unit,
        agentMayComplete: j.agentMayComplete,
        carryContextEnabled: j.carryContextEnabled,
        workdir: j.workdir === 'worktree' ? 'worktree' : 'shared',
        templateName: j.templateName ?? '',
        variables: Object.entries(j.variables ?? {}).map(([key, value]) =>
          newVarDraft(
            key,
            value,
            detectVarMode(key, value, j.templateName, templates, editProfiles),
          ),
        ),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setError(errMsg);
      if (errMsg.includes('404') || errMsg.toLowerCase().includes('not found')) {
        try {
          if (localStorage.getItem('lastScheduleJobId') === jobId) {
            localStorage.removeItem('lastScheduleJobId');
          }
          if (localStorage.getItem('lastSchedulesJobId') === jobId) {
            localStorage.removeItem('lastSchedulesJobId');
          }
        } catch { /* ignore */ }
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, jobId, runsFetchLimit, upcomingCount]);

  useEffect(() => {
    setRunsPage(1);
    setRunsFetchLimit(RUNS_LIST_INITIAL);
    setUpcomingCount(UPCOMING_INITIAL);
    setSkipMenuFor(null);
    setCustomRoleStages({});
    setStageIdDrafts({});
    setStageIdWarning(null);
  }, [projectId, jobId]);

  useEffect(() => {
    const ids = new Set(editorStageIds);
    setCustomRoleStages((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (ids.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [editorStageIds]);

  // Same aggregate as the Schedules sidebar job-row dot → session-header pill.
  const jobStatusBadge = useMemo((): SessionBadgeFromDot | null => {
    if (!job) return null;
    const unreadSet = new Set(unreadConversationIds);
    const recovered = errorRecoveredConversationIds ?? new Set<string>();
    const dot = resolveJobAggregateDot({
      runs: runs.map((r) => ({
        status: r.status,
        conversationId: r.conversationId,
      })),
      conversationStatuses,
      wsObservedConversationIds,
      isRunUnread: (conversationId, runStatus) => {
        if (!conversationId) {
          return false;
        }
        return unreadSet.has(conversationId);
      },
      // Browser does not load the spawn tree; tick `waiting` already covers most
      // "kids still running" cases via live agent status on the run conversation.
      isRunDescendantActive: () => false,
      jobEnabled: job.enabled,
      isRunErrorRecovered: (conversationId) =>
        !!conversationId && recovered.has(conversationId),
    });
    return sessionBadgeForScheduleJob(dot, job.enabled);
  }, [
    job, runs, conversationStatuses, unreadConversationIds,
    errorRecoveredConversationIds, wsObservedConversationIds,
  ]);

  useEffect(() => {
    onJobStatusChange?.(jobStatusBadge);
  }, [jobStatusBadge, onJobStatusChange]);

  useEffect(() => {
    return () => { onJobStatusChange?.(null); };
  }, [onJobStatusChange]);

  // Close skip split-menu on outside click / Escape.
  useEffect(() => {
    if (skipMenuFor == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSkipMenuFor(null);
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-skip-split]')) return;
      setSkipMenuFor(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [skipMenuFor]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, refetchTrigger]);

  const gridTimezone = job?.timezone ?? 'UTC';
  const effectiveAnchorKey = calendarAnchorKey ?? dayKeyInTimezone(Date.now(), gridTimezone);

  const dayKeys = useMemo(
    () => (upcomingView === 'calendar' ? calendarDayKeys(effectiveAnchorKey, calendarViewMode) : []),
    [upcomingView, effectiveAnchorKey, calendarViewMode],
  );

  useEffect(() => {
    if (upcomingView !== 'calendar' || !job) return;
    let cancelled = false;
    const { from, to } = calendarWindowMs(dayKeys, gridTimezone);
    setCalendarLoading(true);
    setCalendarError(null);
    api.scheduleCalendar(projectId, from, to)
      .then((r) => { if (!cancelled) setCalendarJobs(r.jobs); })
      .catch((e) => { if (!cancelled) setCalendarError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setCalendarLoading(false); });
    return () => { cancelled = true; };
  }, [upcomingView, dayKeys, gridTimezone, projectId, refetchTrigger, job]);

  const calendarGrid = useMemo(
    () => (upcomingView === 'calendar'
      ? buildCalendarGrid({
        days: dayKeys,
        viewMode: calendarViewMode,
        timezone: gridTimezone,
        nowMs: Date.now(),
        jobs: calendarJobs,
        anchorDayKey: effectiveAnchorKey,
      })
      : []),
    [upcomingView, dayKeys, calendarViewMode, gridTimezone, calendarJobs, effectiveAnchorKey],
  );

  useEffect(() => {
    if (profilesProp && profilesProp.length > 0) return;
    fetch('/profiles', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<{ profiles: AgentProfile[] }>) : { profiles: [] }))
      .then((data) => setLoadedProfiles(data.profiles ?? []))
      .catch(() => setLoadedProfiles([]));
  }, [profilesProp]);

  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = () => {
    if (!job) return;
    void withBusy(async () => {
      if (job.enabled) await api.disableSchedule(projectId, jobId);
      else await api.enableSchedule(projectId, jobId);
    });
  };

  const skipFire = (fireAtMs: number, mode: 'this' | 'through' = 'this') => {
    setSkipMenuFor(null);
    void withBusy(async () => {
      await api.skipScheduleFire(projectId, jobId, fireAtMs, mode);
    });
  };

  const unskipFire = (fireAtMs: number) => {
    setSkipMenuFor(null);
    void withBusy(async () => {
      await api.unskipScheduleFire(projectId, jobId, fireAtMs);
    });
  };

  const runNow = () => {
    void withBusy(async () => {
      await api.runScheduleNow(projectId, jobId);
    });
  };

  const confirmAndDeleteJob = () => {
    void withBusy(async () => {
      const res = await api.deleteSchedule(projectId, jobId);
      setConfirmDeleteJob(false);
      onJobDeleted?.(jobId, res.deletedConversationIds ?? []);
    });
  };

  const confirmAndArchiveJob = () => {
    void withBusy(async () => {
      await api.archiveSchedule(projectId, jobId);
      setConfirmArchiveJob(false);
      onJobArchived?.(jobId);
    });
  };

  const openSavePack = () => {
    if (!job) return;
    setSavePackSlug(slugFromJobName(job.name));
    setSavePackTitle(job.name);
    setSavePackDescription('');
    setSavePackError(null);
    setSavePackOpen(true);
  };

  const submitSavePack = async () => {
    if (!job) return;
    const slug = savePackSlug.trim();
    if (!PACK_SLUG_RE.test(slug)) {
      setSavePackError('Slug must match ^[a-z0-9][a-z0-9-]{0,47}$');
      return;
    }
    setSavePackBusy(true);
    setSavePackError(null);
    try {
      await api.importSchedulePack(jobToPackDoc(job, {
        slug,
        title: savePackTitle.trim() || job.name,
        description: savePackDescription.trim(),
      }));
      setSavePackOpen(false);
    } catch (err) {
      setSavePackError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavePackBusy(false);
    }
  };

  const confirmAndDeleteRun = () => {
    const run = confirmDeleteRun;
    if (!run) return;
    void withBusy(async () => {
      if (run.conversationId) {
        const res = await api.deleteConversation(run.conversationId);
        onRunConversationDeleted?.(res.deletedIds ?? [run.conversationId]);
      } else {
        await api.deleteScheduleRun(projectId, jobId, run.id);
      }
      setConfirmDeleteRun(null);
      await load();
    });
  };

  const saveEdit = () => {
    void withBusy(async () => {
      let scheduleExpr = editForm.scheduleExpr.trim();
      if (editForm.scheduleKind === 'interval') {
        const everyMs = durationPartsToMs(editForm.intervalAmount, editForm.intervalUnit);
        if (everyMs < 1000) {
          setError('Interval must be at least 1 second');
          return;
        }
        scheduleExpr = formatIntervalExpr(everyMs);
      } else if (editForm.scheduleKind === 'once') {
        const atMs = parseIsoLocalInTimezone(editForm.onceAtLocal, editForm.timezone.trim() || 'UTC');
        if (!Number.isFinite(atMs)) {
          setError('Pick a valid date/time');
          return;
        }
        if (!(atMs > Date.now())) {
          setError('Pick a future date/time');
          return;
        }
        scheduleExpr = formatOnceExpr(atMs);
      }
      const kept = editForm.variables.filter((d) => d.key.trim() !== '' || d.value !== '');
      const keys = kept.map((d) => d.key.trim());
      if (keys.some((k) => k === '')) {
        setError('Variable keys cannot be empty when a value is set');
        return;
      }
      const dup = keys.find((k, i) => keys.indexOf(k) !== i);
      if (dup) {
        setError(`Duplicate variable key "${dup}"`);
        return;
      }
      const obj: Record<string, string> = {};
      for (const d of kept) obj[d.key.trim()] = d.value;
      const parsedVars = parseScheduleVariables(Object.keys(obj).length === 0 ? null : obj);
      if (!parsedVars.ok) {
        setError(parsedVars.error);
        return;
      }
      // R1: executionMode is immutable after create — never PATCH it.
      // Omit profileId when unchanged so change-based validation skips it (and
      // so an 'inherit' value the picker can't represent stays untouched).
      const nextProfileId = editForm.profileId.trim();
      const body: PatchScheduleJobRequest = {
        name: editForm.name.trim(),
        timezone: editForm.timezone.trim(),
        scheduleKind: editForm.scheduleKind,
        scheduleExpr,
        overlapPolicy: editForm.overlapPolicy,
        ...(job && nextProfileId !== job.profileId ? { profileId: nextProfileId } : {}),
        promptTemplate: editForm.promptTemplate,
        steer: editForm.steer.trim() || null,
        runTimeoutMs: editForm.runTimeoutMs,
        agentMayComplete: editForm.agentMayComplete,
        carryContextEnabled: editForm.carryContextEnabled,
        workdir: editForm.workdir,
        // null clears; empty string from "None" option.
        templateName: editForm.templateName.trim() || null,
        variables: parsedVars.value ?? null,
      };
      await api.patchSchedule(projectId, jobId, body);
      setEditOpen(false);
    });
  };

  const openStepsEdit = () => {
    if (job) setStepDrafts(stepsToDrafts(job.steps));
    else setStepDrafts([emptyStepDraft('ready')]);
    setStepsEditOpen(true);
  };

  const cancelStepsEdit = () => {
    setStepsEditOpen(false);
    setStepDrafts([]);
  };

  const updateDraft = (key: string, patch: Partial<StepDraft>) => {
    setStepDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };

  const moveDraft = (index: number, dir: -1 | 1) => {
    setStepDrafts((prev) => {
      const next = [...prev];
      const j = index + dir;
      if (j < 0 || j >= next.length) return prev;
      const tmp = next[index]!;
      next[index] = next[j]!;
      next[j] = tmp;
      return next;
    });
  };

  const removeDraft = (key: string) => {
    setStepDrafts((prev) => {
      const filtered = prev.filter((d) => d.key !== key);
      // Drop deps that pointed at the removed row.
      return filtered.map((d) =>
        d.dependsOnKey === key ? { ...d, dependsOnKey: null } : d,
      );
    });
  };

  const addDraft = () => {
    setStepDrafts((prev) => [
      ...prev,
      emptyStepDraft(prev.length === 0 ? 'ready' : 'pending'),
    ]);
  };

  const saveSteps = () => {
    void withBusy(async () => {
      for (let i = 0; i < stepDrafts.length; i++) {
        const d = stepDrafts[i]!;
        if (!d.title.trim()) throw new Error(`Step #${i}: title required`);
      }
      await api.putScheduleSteps(projectId, jobId, draftsToPutBody(stepDrafts));
      setStepsEditOpen(false);
      setStepDrafts([]);
    });
  };

  const savePendingContext = (opts?: { clear?: boolean; carryContextEnabled?: boolean }) => {
    void withBusy(async () => {
      const text = opts?.clear ? null : (pendingDraft.trim() === '' ? null : pendingDraft);
      await api.putSchedulePendingContext(projectId, jobId, {
        text,
        ...(opts?.carryContextEnabled !== undefined
          ? { carryContextEnabled: opts.carryContextEnabled }
          : {}),
      });
    });
  };

  const toggleCarryForward = (enabled: boolean) => {
    void withBusy(async () => {
      // Persist flag + current draft so enable+set can be one operator action.
      await api.putSchedulePendingContext(projectId, jobId, {
        text: pendingDraft.trim() === '' ? (job?.pendingContext ?? null) : pendingDraft,
        carryContextEnabled: enabled,
      });
    });
  };

  if (loading && !job) {
    return (
      <div className="conversation-loading-placeholder">
        <div className="placeholder-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        </div>
        <h3>Loading schedule…</h3>
        <p>Fetching schedule details and run history.</p>
      </div>
    );
  }

  if (!job) {
    const isNotFound = !error || error.includes('404') || error.toLowerCase().includes('not found');
    return (
      <div className="empty-conversation-placeholder">
        <div className="placeholder-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </div>
        <h3>{isNotFound ? 'Schedule not found' : 'Unable to display schedule'}</h3>
        <p>
          {isNotFound
            ? 'This schedule does not exist or may have been deleted.'
            : error}
        </p>
        {onOpenCalendar && (
          <button
            type="button"
            className="modal-btn"
            style={{ marginTop: 16 }}
            onClick={onOpenCalendar}
          >
            Open schedule calendar
          </button>
        )}
      </div>
    );
  }

  const progress = job.stepProgress;

  const runsVisibleLimit = runsLimitForPage(runsPage);
  const visibleRuns = runs.slice(0, runsVisibleLimit);
  const hiddenRunsInFetched = runs.length - visibleRuns.length;
  const atRunsFetchCap = runs.length >= runsFetchLimit;
  const hiddenRunsCount = hiddenRunsInFetched > 0 ? hiddenRunsInFetched : (atRunsFetchCap ? RUNS_LIST_STEP : 0);
  const showRunsMore = hiddenRunsInFetched > 0 || (atRunsFetchCap && visibleRuns.length === runs.length);

  return (
    <div
      className="schedule-browser"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}
    >
      {/* Header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-1)', fontFamily: 'var(--ui)' }}>
            {job.name}
          </h2>
          <button
            type="button"
            role="switch"
            aria-checked={job.enabled}
            className={`toggle-switch${job.enabled ? ' on' : ''}`}
            onClick={toggleEnabled}
            disabled={busy}
            title={job.enabled ? 'Disable job' : 'Enable job'}
          >
            <span className="toggle-knob" />
          </button>
          <span style={{ fontSize: 11, color: job.enabled ? 'var(--green)' : 'var(--text-3)', fontFamily: 'var(--ui)' }}>
            {job.enabled ? 'Enabled' : 'Disabled'}
          </span>
          {job.archived && (
            <span style={{ ...metaChipStyle, color: 'var(--amber)', borderColor: 'var(--amber)' }}>archived</span>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          <span style={metaChipStyle} title="Next fire">
            Next: {formatWhen(job.nextFireAt, job.timezone)}
            <span style={{ color: 'var(--text-3)' }}>({formatRelative(job.nextFireAt)})</span>
          </span>
          <span style={metaChipStyle}>{job.overlapPolicy}</span>
          <span style={metaChipStyle} title={job.boundConversationId ?? undefined}>
            {job.executionMode === 'resume_conversation'
              ? `Send to ${job.boundConversationId ?? 'conversation'}`
              : 'New run each time'}
          </span>
          <span style={metaChipStyle}>workdir: {job.workdir === 'worktree' ? 'worktree' : 'shared'}</span>
          <span style={metaChipStyle} title={job.profileId}>
            profile: {job.profileId === SCHEDULE_INHERIT_PROFILE_ID
              ? "Conversation's last agent"
              : job.profileId}
          </span>
          <span style={metaChipStyle} title={job.templateName ?? 'none'}>
            template: {job.templateName ?? 'none'}
          </span>
          <span
            style={metaChipStyle}
            title={
              job.scheduleKind === 'interval' || job.scheduleKind === 'once'
                ? `${job.scheduleKind}: ${job.scheduleExpr}`
                : job.scheduleExpr
            }
          >
            {job.scheduleKind === 'interval' || job.scheduleKind === 'once'
              ? formatScheduleLabel(job.scheduleKind, job.scheduleExpr, job.timezone)
              : `cron: ${formatScheduleLabel(job.scheduleKind, job.scheduleExpr, job.timezone)}`}
          </span>
          <span style={metaChipStyle}>{job.timezone}</span>
          <span style={metaChipStyle} title={`${job.runTimeoutMs} ms`}>
            timeout {formatDurationMs(job.runTimeoutMs)}
          </span>
          <span style={metaChipStyle}>
            steps {progress.done}/{progress.total}
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <button type="button" className="modal-btn primary" onClick={runNow} disabled={busy || job.archived}>
            Run now
          </button>
          <button
            type="button"
            className={`modal-btn${editOpen ? ' primary' : ''}`}
            onClick={() => setEditOpen((v) => !v)}
            disabled={busy}
          >
            {editOpen ? 'Close edit' : 'Edit schedule'}
          </button>
          <button
            type="button"
            className="modal-btn"
            onClick={openSavePack}
            disabled={busy}
            title="Save this job's prompt, cadence, and steps as an imported pack"
          >
            Save as pack
          </button>
          <button
            type="button"
            className="modal-btn"
            onClick={() => setConfirmArchiveJob(true)}
            disabled={busy || job.archived}
            title="Hide from lists; keep history; free an agent-create cap slot"
          >
            Archive
          </button>
          <button
            type="button"
            className="modal-btn danger"
            onClick={() => setConfirmDeleteJob(true)}
            disabled={busy}
            title="Permanently delete this schedule and all run conversations"
          >
            Delete schedule
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{error}</div>
        )}

        {(() => {
          // Only the most recent *executed* run counts. `runs` is newest-first, so a bare
          // find() surfaced the newest run that ever hit this — the banner stuck around for
          // ticks after the job had recovered, while its own copy claimed "last run".
          const lastExecuted = runs.find(
            (r) => r.status === 'succeeded' || r.status === 'failed' || r.status === 'timed_out',
          );
          const infraRun = lastExecuted && isInfraRunError(lastExecuted.error) ? lastExecuted : null;
          if (!infraRun) return null;
          return (
            <div
              role="status"
              style={{
                marginTop: 12,
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--amber)',
                background: 'color-mix(in srgb, var(--amber) 12%, var(--surface-1))',
                fontSize: 12,
                color: 'var(--text-1)',
                fontFamily: 'var(--ui)',
              }}
            >
              <strong style={{ color: 'var(--amber)' }}>Step not updated</strong>
              {' — '}
              the last run ended without writing its step (
              <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{infraRun.error}</code>
              ). The step was returned to <strong>ready</strong>, so the next tick picks it up —
              nothing is stuck. Jobs with a single evergreen step do this by design.
              If it repeats <em>and</em> the job is making no progress, restart the API in case it is
              serving a stale <code>dist</code>.
            </div>
          );
        })()}
      </div>

      {/* Edit form — .schedule-edit-form constrains SelectDropdown/ModelSelector (ms-trigger min-width:280px) */}
      {editOpen && (
        <div style={{ ...sectionStyle, background: 'var(--surface-2)' }}>
          <div style={sectionTitleStyle}>Edit schedule (operator)</div>
          <div className="schedule-edit-form">
            <label className="schedule-edit-field">
              Name
              <input className="modal-input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </label>
            <label className="schedule-edit-field">
              Timezone
              <TimezoneField
                value={editForm.timezone}
                onChange={(timezone) => {
                  setEditForm((prev) => {
                    const next = { ...prev, timezone };
                    if (prev.scheduleKind === 'once') {
                      const atMs = parseOnceAtMs(prev.scheduleExpr)
                        ?? parseIsoLocalInTimezone(prev.onceAtLocal, prev.timezone || 'UTC');
                      if (Number.isFinite(atMs)) {
                        next.onceAtLocal = atMsToDatetimeLocal(atMs, timezone);
                      }
                    }
                    return next;
                  });
                }}
                required
              />
            </label>
            <div className="schedule-edit-row">
              <label className="schedule-edit-field">
                Kind
                <SelectDropdown
                  options={[
                    { value: 'interval', label: 'interval' },
                    { value: 'cron', label: 'cron' },
                    { value: 'once', label: 'once' },
                  ]}
                  value={editForm.scheduleKind}
                  onChange={(scheduleKind) => {
                    if (scheduleKind === 'interval') {
                      const everyMs = parseIntervalEveryMs(editForm.scheduleExpr)
                        ?? (durationPartsToMs(editForm.intervalAmount, editForm.intervalUnit) || 86_400_000);
                      const parts = msToDurationParts(everyMs, { amount: 24, unit: 'hours' });
                      setEditForm({
                        ...editForm,
                        scheduleKind,
                        intervalAmount: parts.amount,
                        intervalUnit: parts.unit,
                        scheduleExpr: formatIntervalExpr(everyMs),
                      });
                    } else if (scheduleKind === 'once') {
                      const fromExpr = parseOnceAtMs(editForm.scheduleExpr);
                      const atMs = fromExpr ?? Date.now() + 3_600_000;
                      setEditForm({
                        ...editForm,
                        scheduleKind,
                        onceAtLocal: atMsToDatetimeLocal(atMs, editForm.timezone || 'UTC'),
                        scheduleExpr: formatOnceExpr(atMs),
                      });
                    } else {
                      // cron — don't keep interval/once JSON in the cron field
                      const trimmed = editForm.scheduleExpr.trim();
                      const looksLikeJson = trimmed.startsWith('{');
                      const looksLikeCron = !looksLikeJson && trimmed.split(/\s+/).length >= 5;
                      setEditForm({
                        ...editForm,
                        scheduleKind: 'cron',
                        scheduleExpr: looksLikeCron ? trimmed : '0 9 * * *',
                      });
                    }
                  }}
                  placement="bottom"
                />
              </label>
              {editForm.scheduleKind === 'interval' ? (
                <label className="schedule-edit-field">
                  Every
                  <div className="settings-input-group" style={{ marginTop: 0 }}>
                    <input
                      className="modal-input timeout-input"
                      type="number"
                      min={0.1}
                      step="any"
                      style={{ width: 96 }}
                      value={editForm.intervalAmount}
                      onChange={(e) => {
                        const amount = Number(e.target.value);
                        const safe = Number.isFinite(amount) && amount > 0 ? amount : 0;
                        const everyMs = durationPartsToMs(safe, editForm.intervalUnit);
                        setEditForm({
                          ...editForm,
                          intervalAmount: Number.isFinite(amount) ? amount : 0,
                          scheduleExpr: everyMs > 0 ? formatIntervalExpr(everyMs) : editForm.scheduleExpr,
                        });
                      }}
                    />
                    <div className="timeout-unit-select">
                      <SelectDropdown
                        options={DURATION_UNIT_OPTIONS}
                        value={editForm.intervalUnit}
                        onChange={(unit) => {
                          const intervalUnit = unit as DurationUnit;
                          const amount = editForm.intervalAmount;
                          const safe = Number.isFinite(amount) && amount > 0 ? amount : 0;
                          const everyMs = durationPartsToMs(safe, intervalUnit);
                          setEditForm({
                            ...editForm,
                            intervalUnit,
                            scheduleExpr: everyMs > 0 ? formatIntervalExpr(everyMs) : editForm.scheduleExpr,
                          });
                        }}
                        placement="bottom"
                      />
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                    {formatScheduleLabel('interval', editForm.scheduleExpr, editForm.timezone)}
                  </span>
                </label>
              ) : editForm.scheduleKind === 'once' ? (
                <label className="schedule-edit-field">
                  Fire at ({editForm.timezone || 'UTC'})
                  <input
                    className="modal-input"
                    type="datetime-local"
                    value={editForm.onceAtLocal}
                    onChange={(e) => {
                      const onceAtLocal = e.target.value;
                      const atMs = parseIsoLocalInTimezone(onceAtLocal, editForm.timezone.trim() || 'UTC');
                      setEditForm({
                        ...editForm,
                        onceAtLocal,
                        scheduleExpr: Number.isFinite(atMs) ? formatOnceExpr(atMs) : editForm.scheduleExpr,
                      });
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                    {formatScheduleLabel('once', editForm.scheduleExpr, editForm.timezone)}
                  </span>
                </label>
              ) : (
                <label className="schedule-edit-field">
                  Cron expression
                  <div className="cron-expr-row">
                    <input
                      className="modal-input"
                      style={{ fontFamily: 'var(--mono)' }}
                      value={editForm.scheduleExpr}
                      onChange={(e) => setEditForm({ ...editForm, scheduleExpr: e.target.value })}
                      placeholder="0 9 * * *"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => setCronBuilderOpen(true)}
                      disabled={busy}
                      title="Open visual cron builder"
                    >
                      Design
                    </button>
                  </div>
                  {(() => {
                    const { text, valid } = describeCron(editForm.scheduleExpr);
                    return (
                      <span
                        style={{
                          fontSize: 11,
                          color: valid ? 'var(--text-3)' : 'var(--red)',
                          fontFamily: 'var(--ui)',
                        }}
                      >
                        {text}
                      </span>
                    );
                  })()}
                </label>
              )}
            </div>
            <div className="schedule-edit-row">
              <label className="schedule-edit-field">
                Overlap
                <SelectDropdown
                  options={[
                    { value: 'skip', label: 'skip' },
                    { value: 'queue_one', label: 'queue_one' },
                    { value: 'catch_up', label: 'catch_up' },
                  ]}
                  value={editForm.overlapPolicy}
                  onChange={(overlapPolicy) => setEditForm({ ...editForm, overlapPolicy })}
                  placement="bottom"
                />
              </label>
              <label className="schedule-edit-field">
                Mode
                <div
                  className="modal-input"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    minHeight: 34,
                    color: 'var(--text-2)',
                    cursor: 'default',
                  }}
                  title="Execution mode is fixed at create time"
                >
                  {editForm.executionMode === 'resume_conversation'
                    ? `Send to ${job?.boundConversationId ?? 'conversation'}`
                    : 'New run each time'}
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                  Mode cannot be changed after create.
                </span>
              </label>
            </div>
            {editForm.executionMode !== 'resume_conversation' && (
            <label className="schedule-edit-field">
              Roster / Delegation template
              <SelectDropdown
                options={[
                  { value: '', label: 'None (no autonomous delegation)' },
                  ...templates.map((t) => ({
                    value: t.name,
                    label: t.name,
                    badge: `${t.roles.length} roles`,
                  })),
                  // Keep a deleted/renamed template selectable so Save does not silently clear it.
                  ...(editForm.templateName
                    && !templates.some((t) => t.name === editForm.templateName)
                    ? [{ value: editForm.templateName, label: `${editForm.templateName} (missing)` }]
                    : []),
                ]}
                value={editForm.templateName}
                onChange={(templateName) => setEditForm({ ...editForm, templateName })}
                placement="bottom"
                searchable
              />
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                Roster of available roles and models. Attached to each spawn_child tick so the agent can spawn delegates.
              </span>
            </label>
            )}
            <label className="schedule-edit-field">
              Profile
              {editForm.profileId === SCHEDULE_INHERIT_PROFILE_ID ? (
                <>
                  <div
                    className="modal-input"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      minHeight: 34,
                      color: 'var(--text-2)',
                      cursor: 'default',
                    }}
                    title={SCHEDULE_INHERIT_PROFILE_ID}
                  >
                    Conversation&apos;s last agent
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                    Reuses whichever profile last ran in the bound conversation. Leave unchanged to keep inherit.
                  </span>
                </>
              ) : (
                <ModelSelector
                  profiles={editProfiles}
                  profilesLoaded={profilesLoaded}
                  selectedProfileId={editForm.profileId}
                  onChange={(profileId) => setEditForm({ ...editForm, profileId })}
                  placement="bottom"
                  allowEmpty={editProfiles.length === 0}
                  rosterProfileIds={rosterProfileIds}
                />
              )}
              {editForm.profileId !== SCHEDULE_INHERIT_PROFILE_ID && rosterProfiles.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                    Roster models ({editForm.templateName}):
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {rosterProfiles.map(({ role, profileId }) => (
                      <button
                        key={`${role}-${profileId}`}
                        type="button"
                        className={`schedule-roster-pill${editForm.profileId === profileId ? ' active' : ''}`}
                        onClick={() => setEditForm({ ...editForm, profileId })}
                        title={`Set schedule profile to ${profileId} (${role})`}
                      >
                        <span style={{ fontWeight: 600 }}>{role}</span>
                        <span style={{ opacity: 0.7, fontFamily: 'var(--mono)', fontSize: 10 }}>{profileId}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </label>
            <label className="schedule-edit-field">
              Tick workdir
              <SelectDropdown
                options={[
                  { value: 'shared', label: 'Shared' },
                  { value: 'worktree', label: 'Worktree' },
                ]}
                value={editForm.workdir}
                onChange={(workdir) => setEditForm({ ...editForm, workdir })}
                placement="bottom"
              />
            </label>
            <label className="schedule-edit-field">
              Prompt template
              <textarea
                className="modal-input"
                style={{ height: 120, resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }}
                value={editForm.promptTemplate}
                onChange={(e) => setEditForm({ ...editForm, promptTemplate: e.target.value })}
              />
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                Standing prompt prose for the tick. Replaces the pack prompt when edited.
              </span>
            </label>
            <label className="schedule-edit-field">
              Steer (optional)
              <textarea
                className="modal-input"
                style={{ height: 80, resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }}
                value={editForm.steer}
                onChange={(e) => setEditForm({ ...editForm, steer: e.target.value })}
                placeholder="e.g. Prioritize high-value video and audio processing features"
              />
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                Durable focus on what to prioritize right now. Included every tick until you change it.
              </span>
            </label>
            <div className="schedule-edit-field">
              Variables
              {hasPipeline && (
                <div
                  className="pipeline-subpanel"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    padding: '12px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
                    marginBottom: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-1)' }}>Pipeline</span>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Interpolated by {'{{pipeline}}'}</span>
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text-1)' }}>
                      <input
                        type="checkbox"
                        checked={resolvedPipeline?.ok ? resolvedPipeline.commit : (editVarsMap.commitOnTick !== 'false')}
                        onChange={(e) => applyVarsMap(setCommitOnTickInVars(editVarsMap, e.target.checked))}
                      />
                      <span>Commit on tick</span>
                    </label>
                  </div>

                  {resolvedPipeline && !resolvedPipeline.ok && editorStageIds.length > 0 && (
                    <div style={{ color: 'var(--red, #ef4444)', fontSize: 12, padding: '6px 10px', borderRadius: 4, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                      {resolvedPipeline.error}
                    </div>
                  )}

                  {stageIdWarning && (
                    <div style={{ color: 'var(--red, #ef4444)', fontSize: 12, padding: '6px 10px', borderRadius: 4, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                      {stageIdWarning}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {editorStageIds.length === 0 && (
                      <div style={{ color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic', padding: '4px 0' }}>
                        No pipeline stages configured. Click &lsquo;Add stage&rsquo; to create one.
                      </div>
                    )}

                    {editorStageIds.length > 0 && resolvedPipeline && resolvedPipeline.ok && resolvedPipeline.stages.map((stage, i) => {
                      const currentRole = stage.role ?? '';
                      const isNone = stage.skipped || !currentRole || currentRole.toLowerCase() === 'none';
                      const isTemplateRole = availableRoles.includes(currentRole);
                      const isCustomRole = !isNone && !isTemplateRole;
                      const showCustomInput = customRoleStages[stage.id] || isCustomRole;

                      return (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            padding: '8px 10px',
                            borderRadius: 6,
                            border: '1px solid var(--border)',
                            background: 'var(--surface-1)',
                          }}
                        >
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <div style={{ flex: '0 0 120px', minWidth: 90 }}>
                              <input
                                type="text"
                                className="modal-input"
                                style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, width: '100%' }}
                                placeholder="stage id"
                                pattern="^[a-z][a-z0-9]{0,23}$"
                                value={stageIdDrafts[i] ?? stage.id}
                                onChange={(e) => {
                                  setStageIdDrafts((prev) => ({ ...prev, [i]: e.target.value }));
                                  setStageIdWarning(null);
                                }}
                                onBlur={() => commitStageId(i, stage.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    (e.currentTarget as HTMLInputElement).blur();
                                  }
                                }}
                                title="Stage ID: lowercase letters and digits, starting with a letter, max 24 chars"
                                aria-label={`Stage ${stage.id} ID`}
                              />
                            </div>
                            <div style={{ flex: 1, minWidth: 140 }}>
                              <select
                                className="modal-input"
                                style={{ width: '100%', fontSize: 12 }}
                                value={isCustomRole ? '__custom__' : (stage.role || 'none')}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val === '__custom__') {
                                    setCustomRoleStages((prev) => ({ ...prev, [stage.id]: true }));
                                  } else {
                                    setCustomRoleStages((prev) => ({ ...prev, [stage.id]: false }));
                                    applyVarsMap(updateStageInVars(editVarsMap, stage.id, { role: val === 'none' ? 'none' : val }));
                                  }
                                }}
                                aria-label={`Stage ${stage.id} role`}
                              >
                                <option value="none">none (skip)</option>
                                {availableRoles.map((r) => (
                                  <option key={r} value={r}>{r}</option>
                                ))}
                                {isCustomRole && (
                                  <option value={stage.role!}>{stage.role} (custom)</option>
                                )}
                                <option value="__custom__">Custom…</option>
                              </select>
                            </div>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                              <button
                                type="button"
                                className="modal-btn"
                                style={{ fontSize: 11, padding: '2px 8px', height: 'auto' }}
                                disabled={i === 0}
                                onClick={() => applyVarsMap(moveStageInVars(editVarsMap, i, 'up'))}
                                title="Move up"
                                aria-label={`Move stage ${stage.id} up`}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="modal-btn"
                                style={{ fontSize: 11, padding: '2px 8px', height: 'auto' }}
                                disabled={i === resolvedPipeline.stages.length - 1}
                                onClick={() => applyVarsMap(moveStageInVars(editVarsMap, i, 'down'))}
                                title="Move down"
                                aria-label={`Move stage ${stage.id} down`}
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                className="modal-btn"
                                style={{ fontSize: 11, padding: '2px 8px', height: 'auto', color: 'var(--red, #ef4444)' }}
                                onClick={() => applyVarsMap(removeStageFromVars(editVarsMap, stage.id))}
                                title="Remove stage"
                                aria-label={`Remove stage ${stage.id}`}
                              >
                                🗑
                              </button>
                            </div>
                          </div>

                          {showCustomInput && (
                            <div>
                              <input
                                type="text"
                                className="modal-input"
                                style={{ fontSize: 12, width: '100%' }}
                                placeholder="Enter custom role name"
                                value={stage.role ?? ''}
                                onChange={(e) => {
                                  applyVarsMap(updateStageInVars(editVarsMap, stage.id, { role: e.target.value }));
                                }}
                                aria-label={`Stage ${stage.id} custom role`}
                              />
                            </div>
                          )}

                          <div>
                            <textarea
                              className="modal-input"
                              rows={2}
                              style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }}
                              placeholder={stage.fn || 'Function contract (e.g. prompt instructions, verification rules)'}
                              value={editVarsMap[`${stage.id}Function`] ?? ''}
                              onChange={(e) => {
                                applyVarsMap(updateStageInVars(editVarsMap, stage.id, { fn: e.target.value }));
                              }}
                              aria-label={`Stage ${stage.id} function`}
                            />
                          </div>
                        </div>
                      );
                    })}

                    <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 4 }}>
                      <button
                        type="button"
                        className="modal-btn"
                        style={{ fontSize: 11, padding: '4px 10px', height: 'auto' }}
                        disabled={editorStageIds.length >= PIPELINE_MAX_STAGES}
                        onClick={handleAddStage}
                      >
                        + Add stage
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {editForm.variables.map((row, i) => (
                <div key={row.id} className="schedule-var-row">
                  <input
                    className="modal-input"
                    style={{ fontFamily: 'var(--mono)', fontSize: 12, flex: '0 0 140px', width: 140 }}
                    placeholder="key"
                    value={row.key}
                    spellCheck={false}
                    onChange={(e) => {
                      const newKey = e.target.value;
                      const variables = editForm.variables.slice();
                      let nextMode = row.mode;
                      if (row.mode === 'text' && /(role|profile|model|template|agent|roster)/i.test(newKey)) {
                        nextMode = 'dropdown';
                      }
                      variables[i] = { ...row, key: newKey, mode: nextMode };
                      setEditForm({ ...editForm, variables });
                    }}
                  />
                  {row.mode === 'dropdown' ? (
                    <VariableValueCombobox
                      value={row.value}
                      onChange={(value) => {
                        const variables = editForm.variables.slice();
                        variables[i] = { ...row, value };
                        setEditForm({ ...editForm, variables });
                      }}
                      templateName={editForm.templateName}
                      templates={templates}
                      profiles={editProfiles}
                    />
                  ) : (
                    <input
                      type="text"
                      className="modal-input"
                      style={{ flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12 }}
                      placeholder="value"
                      value={row.value}
                      onChange={(e) => {
                        const variables = editForm.variables.slice();
                        variables[i] = { ...row, value: e.target.value };
                        setEditForm({ ...editForm, variables });
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className={`schedule-var-mode-btn${row.mode === 'dropdown' ? ' active' : ''}`}
                    title={row.mode === 'dropdown' ? 'Switch to plain text' : 'Pick from roster roles, models, or rosters'}
                    onClick={() => {
                      const variables = editForm.variables.slice();
                      variables[i] = {
                        ...row,
                        mode: row.mode === 'dropdown' ? 'text' : 'dropdown',
                      };
                      setEditForm({ ...editForm, variables });
                    }}
                  >
                    {row.mode === 'dropdown' ? (
                      <>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <polyline points="4 7 4 4 20 4 20 7" />
                          <line x1="9" y1="20" x2="15" y2="20" />
                          <line x1="12" y1="4" x2="12" y2="20" />
                        </svg>
                        <span>Text</span>
                      </>
                    ) : (
                      <>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                        <span>Dropdown</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="modal-btn"
                    style={{ fontSize: 11, padding: '2px 8px', height: 'auto', flex: '0 0 auto' }}
                    onClick={() => setEditForm({
                      ...editForm,
                      variables: editForm.variables.filter((_, j) => j !== i),
                    })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="modal-btn"
                  style={{ fontSize: 11, padding: '4px 10px', height: 'auto', alignSelf: 'flex-start' }}
                  onClick={() => setEditForm({
                    ...editForm,
                    variables: [...editForm.variables, newVarDraft('', '', 'text')],
                  })}
                >
                  Add variable
                </button>
                {!hasPipeline && (
                  <button
                    type="button"
                    className="modal-btn"
                    style={{ fontSize: 11, padding: '4px 10px', height: 'auto', alignSelf: 'flex-start' }}
                    onClick={() => {
                      applyVarsMap(addStageToVars(editVarsMap, 'plan', 'none', ''));
                    }}
                  >
                    Add pipeline
                  </button>
                )}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                Reference as {'{{vars.<key>}}'} in the prompt template or steer.
                A variable naming a model or role is prose the tick reads — it does not change which
                profile runs the tick, and it does not widen the spawn roster.
                Never put secrets here — they are stored in plaintext and rendered into transcripts.
              </span>
              {(varTokenHint.missing.length > 0 || varTokenHint.unused.length > 0) ? (
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                  {varTokenHint.missing.length > 0
                    ? `Referenced but not set: ${varTokenHint.missing.join(', ')}`
                    : null}
                  {varTokenHint.missing.length > 0 && varTokenHint.unused.length > 0 ? ' · ' : null}
                  {varTokenHint.unused.length > 0
                    ? `Set but never used: ${varTokenHint.unused.join(', ')}`
                    : null}
                </span>
              ) : null}
            </div>
            <label className="schedule-edit-field">
              Run timeout
              <div className="settings-input-group" style={{ marginTop: 0 }}>
                <input
                  className="modal-input timeout-input"
                  type="number"
                  min={0.1}
                  step="any"
                  style={{ width: 96 }}
                  value={editForm.runTimeoutAmount}
                  onChange={(e) => {
                    const amount = Number(e.target.value);
                    const safe = Number.isFinite(amount) && amount > 0 ? amount : 0;
                    setEditForm({
                      ...editForm,
                      runTimeoutAmount: Number.isFinite(amount) ? amount : 0,
                      runTimeoutMs: durationPartsToMs(safe, editForm.runTimeoutUnit),
                    });
                  }}
                />
                <div className="timeout-unit-select">
                  <SelectDropdown
                    options={DURATION_UNIT_OPTIONS}
                    value={editForm.runTimeoutUnit}
                    onChange={(unit) => {
                      const runTimeoutUnit = unit as DurationUnit;
                      const amount = editForm.runTimeoutAmount;
                      const safe = Number.isFinite(amount) && amount > 0 ? amount : 0;
                      setEditForm({
                        ...editForm,
                        runTimeoutUnit,
                        // Keep the typed amount; re-derive ms for the new unit.
                        runTimeoutMs: durationPartsToMs(safe, runTimeoutUnit),
                      });
                    }}
                    placement="bottom"
                  />
                </div>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
                Hard stop per tick
                {editForm.runTimeoutMs > 0
                  ? ` — ${formatDurationMs(editForm.runTimeoutMs)}`
                  : ' — enter a duration'}
              </span>
            </label>
            <div className="schedule-edit-checks">
              <div className="schedule-edit-toggle-row">
                <span>Agent may complete</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={editForm.agentMayComplete}
                  className={`toggle-switch${editForm.agentMayComplete ? ' on' : ''}`}
                  disabled={busy}
                  onClick={() => setEditForm({ ...editForm, agentMayComplete: !editForm.agentMayComplete })}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
              <div className="schedule-edit-toggle-row">
                <span>Carry context</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={editForm.carryContextEnabled}
                  className={`toggle-switch${editForm.carryContextEnabled ? ' on' : ''}`}
                  disabled={busy}
                  onClick={() => setEditForm({ ...editForm, carryContextEnabled: !editForm.carryContextEnabled })}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="modal-btn primary" onClick={saveEdit} disabled={busy}>Save</button>
              <button type="button" className="modal-btn" onClick={() => setEditOpen(false)} disabled={busy}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Upcoming (+ restorable operator skips) */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={sectionTitleStyle}>Upcoming</div>
          <div className="schedule-view-toggle" role="group" aria-label="Upcoming view">
            <button
              type="button"
              className={upcomingView === 'list' ? 'active' : ''}
              onClick={() => setUpcomingView('list')}
            >
              List
            </button>
            <button
              type="button"
              className={upcomingView === 'calendar' ? 'active' : ''}
              onClick={() => {
                if (!calendarAnchorKey) setCalendarAnchorKey(dayKeyInTimezone(Date.now(), job.timezone));
                setUpcomingView('calendar');
              }}
            >
              Calendar
            </button>
          </div>
        </div>
        {upcomingView === 'calendar' ? (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, fontFamily: 'var(--ui)' }}>
              Every schedule in this project, shown in {gridTimezone}. Past fires are not shown. Click a fire to open that job.
            </div>
            <ScheduleCalendarGrid
              days={calendarGrid}
              timezone={gridTimezone}
              anchorDayKey={effectiveAnchorKey}
              viewMode={calendarViewMode}
              onAnchorChange={setCalendarAnchorKey}
              onViewModeChange={(m) => {
                setCalendarViewMode(m);
                lsSet(CALENDAR_VIEW_STORAGE_KEY, m);
              }}
              loading={calendarLoading}
              error={calendarError}
              jobs={calendarJobs}
              currentJobId={jobId}
              onSelectMarker={(m) => onSelectJob?.(m.jobId)}
            />
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, fontFamily: 'var(--ui)' }}>
              Skip cancels one tick. Use ▾ for skip through (jump past earlier ticks too).
            </div>
            {(() => {
          type Row = { t: number; state: 'skipped' | 'upcoming' };
          const activeSet = new Set(fires);
          const rows: Row[] = [
            ...skippedFires
              .filter((t) => !activeSet.has(t))
              .map((t) => ({ t, state: 'skipped' as const })),
            ...fires.map((t) => ({ t, state: 'upcoming' as const })),
          ].sort((a, b) => a.t - b.t);

          if (rows.length === 0) {
            return (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                No upcoming fires (job may be disabled, exhausted, or schedule invalid).
              </div>
            );
          }

          const isNextRow = (t: number) => fires[0] === t;

          return (
            <>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {rows.map(({ t, state }) => {
                  const isSkipped = state === 'skipped';
                  const menuOpen = skipMenuFor === t;
                  return (
                    <li
                      key={`${state}-${t}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        fontSize: 12,
                        color: isSkipped ? 'var(--text-3)' : 'var(--text-1)',
                        fontFamily: 'var(--mono)',
                        padding: '6px 8px',
                        borderRadius: 4,
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border)',
                        opacity: isSkipped ? 0.9 : 1,
                      }}
                    >
                      <span style={{ minWidth: 0 }}>
                        {formatWhen(t, job.timezone)}
                        <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>{formatRelative(t)}</span>
                        {isSkipped && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: 10,
                              fontFamily: 'var(--ui)',
                              color: 'var(--amber)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                            }}
                          >
                            skipped
                          </span>
                        )}
                      </span>
                      {isSkipped ? (
                        <button
                          type="button"
                          className="modal-btn"
                          style={{ fontSize: 11, padding: '2px 8px', height: 'auto', flexShrink: 0 }}
                          disabled={busy || job.archived}
                          title="Restore this occurrence only"
                          onClick={() => unskipFire(t)}
                        >
                          Unskip
                        </button>
                      ) : (
                        <div data-skip-split style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                          <button
                            type="button"
                            className="modal-btn"
                            style={{
                              fontSize: 11,
                              padding: '2px 8px',
                              height: 'auto',
                              borderTopRightRadius: 0,
                              borderBottomRightRadius: 0,
                              borderRight: 'none',
                            }}
                            disabled={busy || job.archived}
                            title="Skip only this occurrence; earlier ticks still run"
                            onClick={() => skipFire(t, 'this')}
                          >
                            Skip
                          </button>
                          <button
                            type="button"
                            className="modal-btn"
                            style={{
                              fontSize: 11,
                              padding: '2px 6px',
                              height: 'auto',
                              borderTopLeftRadius: 0,
                              borderBottomLeftRadius: 0,
                              minWidth: 22,
                            }}
                            disabled={busy || job.archived}
                            title="More skip options"
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={() => setSkipMenuFor(menuOpen ? null : t)}
                          >
                            ▾
                          </button>
                          {menuOpen && (
                            <div
                              role="menu"
                              style={{
                                position: 'absolute',
                                right: 0,
                                top: '100%',
                                marginTop: 2,
                                zIndex: 20,
                                minWidth: 180,
                                padding: 4,
                                borderRadius: 6,
                                border: '1px solid var(--border)',
                                background: 'var(--surface-1)',
                                boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                                fontFamily: 'var(--ui)',
                              }}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                className="modal-btn"
                                style={{
                                  display: 'block',
                                  width: '100%',
                                  textAlign: 'left',
                                  fontSize: 11,
                                  padding: '6px 8px',
                                  height: 'auto',
                                  border: 'none',
                                  background: 'transparent',
                                }}
                                onClick={() => skipFire(t, 'this')}
                              >
                                Skip this only
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="modal-btn"
                                style={{
                                  display: 'block',
                                  width: '100%',
                                  textAlign: 'left',
                                  fontSize: 11,
                                  padding: '6px 8px',
                                  height: 'auto',
                                  border: 'none',
                                  background: 'transparent',
                                }}
                                title={
                                  isNextRow(t)
                                    ? 'Same as skip this — no earlier ticks'
                                    : 'Skip this and every earlier upcoming fire'
                                }
                                onClick={() => skipFire(t, 'through')}
                              >
                                Skip through this
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {fires.length === upcomingCount && upcomingCount < UPCOMING_MAX && (
                <button
                  type="button"
                  className="conversation-list-toggle"
                  style={{ marginTop: 6 }}
                  onClick={() => setUpcomingCount((n) => Math.min(n + UPCOMING_STEP, UPCOMING_MAX))}
                  title={`Show ${Math.min(UPCOMING_STEP, UPCOMING_MAX - upcomingCount)} more`}
                  aria-expanded={false}
                >
                  <span className="conversation-list-toggle-dots" aria-hidden>···</span>
                  <span className="conversation-list-toggle-count">
                    Show {Math.min(UPCOMING_STEP, UPCOMING_MAX - upcomingCount)} more
                  </span>
                </button>
              )}
            </>
          );
            })()}
          </>
        )}
      </div>

      {/* Past runs */}
      <div style={{ ...sectionStyle, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ ...sectionTitleStyle, marginBottom: 0 }}>Past runs</div>
          {runs.some((r) => r.status === 'failed' || r.status === 'timed_out') && (
            <button
              type="button"
              className="modal-btn"
              style={{ fontSize: 11, padding: '3px 8px', height: 'auto' }}
              disabled={busy}
              title="Clear failed runs and errors for this schedule"
              onClick={() => {
                void withBusy(async () => {
                  await api.clearScheduleErrors(projectId, jobId);
                  await load();
                });
              }}
            >
              Clear errors
            </button>
          )}
        </div>
        <div style={{ overflow: 'auto', maxHeight: 280, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {runs.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No runs yet.</div>
          ) : (
            <>
            {visibleRuns.map((run) => {
              const clickable = !!run.conversationId;
              const statusDisplay = resolveRunChip({
                runStatus: run.status,
                liveStatus: run.conversationId ? conversationStatuses?.[run.conversationId] : undefined,
              });
              return (
                <div
                  key={run.id}
                  style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 6,
                  }}
                >
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => {
                      if (run.conversationId) onOpenRun(run.conversationId);
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--surface-2)',
                      color: 'var(--text-1)',
                      cursor: clickable ? 'pointer' : 'default',
                      opacity: clickable ? 1 : 0.7,
                      fontFamily: 'var(--ui)',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          color: statusDisplay.colorVar,
                        }}
                      >
                        {statusDisplay.label}
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>
                        {formatWhen(run.firedAt, job.timezone)}
                      </span>
                      {run.finishedAt != null && (
                        <span style={{ color: 'var(--text-3)' }}>
                          → {formatWhen(run.finishedAt, job.timezone)}
                        </span>
                      )}
                    </div>
                    {(run.outcomeSummary || run.error) && (
                      <div style={{ marginTop: 4, color: 'var(--text-3)', fontSize: 11 }}>
                        {run.outcomeSummary}
                        {run.error && (
                          <span style={{
                            color: isInfraRunError(run.error) ? 'var(--amber)' : 'var(--red)',
                            display: run.outcomeSummary ? 'block' : undefined,
                            marginTop: run.outcomeSummary ? 2 : undefined,
                          }}
                          >
                            {isInfraRunError(run.error) ? `⚠ ${run.error}` : run.error}
                          </span>
                        )}
                      </div>
                    )}
                    {!clickable && (
                      <div style={{ marginTop: 2, color: 'var(--text-3)', fontSize: 10 }}>No conversation</div>
                    )}
                  </button>
                  <button
                    type="button"
                    className="modal-btn danger"
                    style={{ fontSize: 11, padding: '4px 8px', height: 'auto', alignSelf: 'center' }}
                    disabled={busy}
                    title={clickable ? 'Delete run conversation and all spawn children' : 'Delete run record'}
                    onClick={() => setConfirmDeleteRun(run)}
                  >
                    Delete
                  </button>
                </div>
              );
            })
            }
            {showRunsMore && (
              <RunsShowMoreButton
                hiddenCount={hiddenRunsCount}
                total={hiddenRunsInFetched > 0 ? runs.length : undefined}
                onClick={() => {
                  const remaining = runs.length - runsVisibleLimit;
                  if (remaining > 0) {
                    setRunsPage((page) => page + 1);
                  } else if (runs.length >= runsFetchLimit) {
                    setRunsFetchLimit((limit) => limit + RUNS_LIST_STEP);
                    setRunsPage((page) => page + 1);
                  }
                }}
              />
            )}
            </>
          )}
        </div>
      </div>

      {savePackOpen && job && (
        <div className="modal-overlay">
          <form
            className="modal-content"
            onSubmit={(e) => {
              e.preventDefault();
              void submitSavePack();
            }}
          >
            <div className="modal-header">Save as pack</div>
            <div className="modal-body">
              <div className="modal-field">
                <label className="modal-label">Slug</label>
                <input
                  type="text"
                  className="modal-input"
                  value={savePackSlug}
                  onChange={(e) => setSavePackSlug(e.target.value)}
                  required
                  spellCheck={false}
                  style={{ fontFamily: 'var(--mono)' }}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Title</label>
                <input
                  type="text"
                  className="modal-input"
                  value={savePackTitle}
                  onChange={(e) => setSavePackTitle(e.target.value)}
                  required
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Description (optional)</label>
                <textarea
                  className="modal-input"
                  rows={2}
                  value={savePackDescription}
                  onChange={(e) => setSavePackDescription(e.target.value)}
                />
              </div>
              <div className="modal-help-text">
                Files are not captured — a pack saved this way is prompt-and-steps only.
                Intervals under 5 minutes are saved as 5 minutes; once jobs more than 7 days
                out are saved as 7 days (pack cadence floors).
              </div>
              {savePackError && (
                <div className="modal-help-text" style={{ color: 'var(--red)' }}>{savePackError}</div>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn"
                onClick={() => setSavePackOpen(false)}
                disabled={savePackBusy}
              >
                Cancel
              </button>
              <button type="submit" className="modal-btn primary" disabled={savePackBusy}>
                {savePackBusy ? 'Saving…' : 'Save pack'}
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmArchiveJob && job && (
        <ConfirmDialog
          title="Archive schedule"
          busy={busy}
          confirmLabel="Archive"
          body={(
            <>
              Hide schedule <code>{job.name}</code> from the list?
              <br /><br />
              The job and its run history stay in the database. This frees an agent-create cap slot. Permanent delete is the trash control.
            </>
          )}
          onCancel={() => setConfirmArchiveJob(false)}
          onConfirm={confirmAndArchiveJob}
        />
      )}

      {confirmDeleteJob && job && (
        <ConfirmDialog
          title="Delete schedule"
          danger
          busy={busy}
          confirmLabel="Delete permanently"
          body={(
            <>
              Permanently delete schedule <code>{job.name}</code>?
              <br /><br />
              This removes the job, all past runs, their conversations and spawn children, and any TTS recordings. This cannot be undone.
            </>
          )}
          onCancel={() => setConfirmDeleteJob(false)}
          onConfirm={confirmAndDeleteJob}
        />
      )}

      {confirmDeleteRun && (
        <ConfirmDialog
          title={confirmDeleteRun.conversationId ? 'Delete run conversation' : 'Delete run record'}
          danger
          busy={busy}
          confirmLabel="Delete"
          body={(
            <>
              {confirmDeleteRun.conversationId ? (
                <>
                  Delete this run conversation and all of its spawn sub-conversations?
                  <br /><br />
                  TTS recordings for those chats are removed too.
                </>
              ) : (
                <>
                  Delete this historical run record from the schedule?
                </>
              )}
            </>
          )}
          onCancel={() => setConfirmDeleteRun(null)}
          onConfirm={confirmAndDeleteRun}
        />
      )}

      <CronBuilderModal
        open={cronBuilderOpen}
        onClose={() => setCronBuilderOpen(false)}
        initialValue={editForm.scheduleExpr}
        onApply={(cronExpression) => {
          setEditForm((prev) => ({ ...prev, scheduleKind: 'cron', scheduleExpr: cronExpression }));
        }}
      />

      {/* Steps — form editor (hides JSON; still PUT full structured list) */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
          <div style={{ ...sectionTitleStyle, marginBottom: 0 }}>Steps</div>
          {!stepsEditOpen ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {job.steps.some((s) => s.status !== 'done') ? (
                <button
                  type="button"
                  className="modal-btn"
                  style={{ fontSize: 11, padding: '4px 10px', height: 'auto' }}
                  disabled={busy}
                  title="Mark every step done (workload finished offline)"
                  onClick={() => {
                    void withBusy(async () => {
                      await api.completeAllScheduleSteps(projectId, jobId);
                    });
                  }}
                >
                  Complete all
                </button>
              ) : null}
              <button
                type="button"
                className="modal-btn"
                style={{ fontSize: 11, padding: '4px 10px', height: 'auto' }}
                onClick={openStepsEdit}
                disabled={busy}
              >
                Edit steps
              </button>
            </div>
          ) : null}
        </div>

        {stepsEditOpen ? (
          <StepsFormEditor
            drafts={stepDrafts}
            busy={busy}
            onChange={updateDraft}
            onMove={moveDraft}
            onRemove={removeDraft}
            onAdd={addDraft}
            onSave={saveSteps}
            onCancel={cancelStepsEdit}
          />
        ) : (
          <StepsList
            steps={job.steps}
            runs={runs}
            busy={busy}
            onRetry={(stepId) => {
              void withBusy(async () => {
                await api.retryScheduleStep(projectId, jobId, stepId);
              });
            }}
            onMarkDone={(stepId) => {
              void withBusy(async () => {
                await api.patchScheduleStep(projectId, jobId, stepId, { status: 'done' });
              });
            }}
          />
        )}
      </div>

      {job.promptTemplate ? (
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span
              style={{
                ...sectionTitleStyle,
                marginBottom: 0,
                color: 'var(--accent)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 3,
                  height: 12,
                  borderRadius: 2,
                  background: 'var(--accent)',
                }}
              />
              Prompt template
            </span>
            <span
              style={{
                ...metaChipStyle,
                borderColor: 'color-mix(in srgb, var(--accent) 50%, var(--border))',
                color: 'var(--accent)',
                background: 'color-mix(in srgb, var(--accent) 10%, var(--surface-2))',
              }}
            >
              Tick envelope
            </span>
            <div style={{ flex: 1 }} />
            <SectionCopyButton text={job.promptTemplate} title="Copy prompt template" />
          </div>
          <div
            className="schedule-template-view event-message"
            style={{
              padding: '8px 10px',
              borderRadius: 4,
              borderLeft: '3px solid var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 6%, var(--surface-2))',
            }}
          >
            <MarkdownBody onOpenFile={setOpenFile}>{job.promptTemplate}</MarkdownBody>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Standing workflow envelope — how to work each tick. Edit in Edit schedule.
          </div>
        </div>
      ) : null}

      {job.steer ? (
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span
              style={{
                ...sectionTitleStyle,
                marginBottom: 0,
                color: 'var(--amber)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 3,
                  height: 12,
                  borderRadius: 2,
                  background: 'var(--amber)',
                }}
              />
              Steer
            </span>
            <span
              style={{
                ...metaChipStyle,
                borderColor: 'color-mix(in srgb, var(--amber) 50%, var(--border))',
                color: 'var(--amber)',
                background: 'color-mix(in srgb, var(--amber) 10%, var(--surface-2))',
              }}
            >
              Durable focus
            </span>
            <div style={{ flex: 1 }} />
            <SectionCopyButton text={job.steer} title="Copy steer" />
          </div>
          <div
            className="schedule-template-view event-message"
            style={{
              padding: '8px 10px',
              borderRadius: 4,
              borderLeft: '3px solid var(--amber)',
              background: 'color-mix(in srgb, var(--amber) 6%, var(--surface-2))',
            }}
          >
            <MarkdownBody onOpenFile={setOpenFile}>{job.steer}</MarkdownBody>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Included every tick until edited in Edit schedule.
          </div>
        </div>
      ) : null}

      {job.variables?.stages ? (() => {
        const resolved = resolveStages(job.variables);
        if (!resolved.ok) {
          return (
            <div style={sectionStyle}>
              <div style={{ ...sectionTitleStyle, marginBottom: 6 }}>Pipeline stages</div>
              <div style={{ color: 'var(--red, #ef4444)', fontSize: 12 }}>
                Invalid pipeline configuration: {resolved.error}
              </div>
            </div>
          );
        }
        return (
          <div style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...sectionTitleStyle, marginBottom: 0 }}>Pipeline stages</span>
                <span style={metaChipStyle}>
                  {resolved.stages.length} stage{resolved.stages.length === 1 ? '' : 's'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                Commit on tick: <strong style={{ color: resolved.commit ? 'var(--green, #22c55e)' : 'var(--amber, #f59e0b)' }}>{resolved.commit ? 'yes' : 'no'}</strong>
              </div>
            </div>
            <table className="schedule-vars-table" style={{ marginBottom: 4 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ width: '15%' }}>Stage</th>
                  <th style={{ width: '25%' }}>Role</th>
                  <th style={{ width: '15%' }}>Status</th>
                  <th>Function</th>
                </tr>
              </thead>
              <tbody>
                {resolved.stages.map((stage) => (
                  <tr key={stage.id}>
                    <td style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{stage.id}</td>
                    <td>
                      {stage.role ? (
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{stage.role}</span>
                      ) : (
                        <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>none</span>
                      )}
                    </td>
                    <td>
                      {stage.skipped ? (
                        <span style={{ color: 'var(--text-3)', fontSize: 11, fontStyle: 'italic' }}>skipped</span>
                      ) : (
                        <span style={{ color: 'var(--green, #22c55e)', fontSize: 11, fontWeight: 500 }}>active</span>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
                      {stage.fn}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })() : null}

      {job.variables && Object.keys(job.variables).length > 0 ? (
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span
              style={{
                ...sectionTitleStyle,
                marginBottom: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              Variables
            </span>
            <span style={metaChipStyle}>Fire-time knobs</span>
          </div>
          <table className="schedule-vars-table">
            <tbody>
              {Object.entries(job.variables).map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Interpolated as {'{{vars.<key>}}'} in the prompt template and steer on every tick.
          </div>
        </div>
      ) : null}

      {/* Carry-forward context for next non-skip tick */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
          <div style={{ ...sectionTitleStyle, marginBottom: 0 }}>Context for next run</div>
          {job.carryContextEnabled && job.pendingContext ? (
            <span
              style={{
                ...metaChipStyle,
                borderColor: 'var(--amber)',
                color: 'var(--amber)',
                fontWeight: 600,
              }}
              title="Queued note will be injected into the next non-skip tick, then cleared"
            >
              Will be included in next run
            </span>
          ) : null}
        </div>

        <div className="schedule-edit-toggle-row" style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Enable carry-forward</span>
          <button
            type="button"
            role="switch"
            aria-checked={job.carryContextEnabled}
            className={`toggle-switch${job.carryContextEnabled ? ' on' : ''}`}
            disabled={busy}
            onClick={() => toggleCarryForward(!job.carryContextEnabled)}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <textarea
          className="modal-input"
          style={{ height: 100, resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 8 }}
          value={pendingDraft}
          onChange={(e) => setPendingDraft(e.target.value)}
          placeholder={job.carryContextEnabled
            ? 'Note for the next scheduled tick (consumed once, max 8 KiB)…'
            : 'Enable carry-forward to inject this note on the next run…'}
          spellCheck={false}
          disabled={busy}
        />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => savePendingContext()}
            disabled={busy}
          >
            Save context
          </button>
          <button
            type="button"
            className="modal-btn"
            onClick={() => {
              setPendingDraft('');
              savePendingContext({ clear: true });
            }}
            disabled={busy || (!job.pendingContext && pendingDraft === '')}
          >
            Clear
          </button>
          {!job.carryContextEnabled && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Off by default — agents cannot enable this flag.
            </span>
          )}
        </div>
      </div>

      {openFile && (
        <FileModal
          path={openFile}
          onClose={() => setOpenFile(null)}
          onOpenFile={setOpenFile}
          projectId={projectId}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
          fileEditsEnabled={fileEditsEnabled}
        />
      )}
    </div>
  );
}

/** Run errors that mean "step API / telemetry missed", not agent-declared halt. */
function isInfraRunError(error: string | undefined): boolean {
  if (!error) return false;
  return (
    error === 'no_step_update'
    || error === 'step_api_failed'
    || error.startsWith('step_api_failed:')
    || error.startsWith('step_api_failed')
  );
}

function blockReasonForStep(step: ScheduleStep, runs: ScheduleRun[]): string | null {
  if (step.status !== 'blocked') return null;
  const last = runs.find((r) => r.stepId === step.id && r.error);
  if (last?.error) {
    if (isInfraRunError(last.error)) {
      return `Infra: ${last.error} (retryable — not an agent halt)`;
    }
    return last.error;
  }
  const body = step.body?.trim();
  if (body) {
    if (body.startsWith('step_api_failed') || body.startsWith('no_step_update')) {
      return `Infra: ${body.slice(0, 120)}`;
    }
    return body.length > 160 ? `${body.slice(0, 160)}…` : body;
  }
  return 'Blocked (no reason recorded)';
}

function StepsList({
  steps,
  runs,
  busy,
  onRetry,
  onMarkDone,
}: {
  steps: ScheduleStep[];
  runs: ScheduleRun[];
  busy: boolean;
  onRetry: (stepId: string) => void;
  onMarkDone: (stepId: string) => void;
}) {
  if (steps.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No steps defined.</div>;
  }
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map((s, i) => {
        const reason = blockReasonForStep(s, runs);
        const canRetry = s.status === 'blocked' || s.status === 'running';
        const canDone = s.status !== 'done' && s.status !== 'skipped';
        return (
          <li
            key={s.id}
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              border: s.status === 'blocked'
                ? '1px solid color-mix(in srgb, var(--red) 50%, var(--border))'
                : '1px solid var(--border)',
              background: 'var(--surface-2)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>#{i}</span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: STEP_STATUS_COLOR[s.status] ?? 'var(--text-3)',
                }}
              >
                {s.status}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)', fontFamily: 'var(--ui)', flex: 1, minWidth: 0 }}>
                {s.title}
              </span>
              {canRetry ? (
                <button
                  type="button"
                  className="modal-btn"
                  style={{ fontSize: 10, padding: '2px 8px', height: 'auto' }}
                  disabled={busy}
                  title="Set ready so the next tick can re-run this step"
                  onClick={() => onRetry(s.id)}
                >
                  Retry
                </button>
              ) : null}
              {canDone ? (
                <button
                  type="button"
                  className="modal-btn"
                  style={{ fontSize: 10, padding: '2px 8px', height: 'auto' }}
                  disabled={busy}
                  title="Mark this step done without rewriting the plan"
                  onClick={() => onMarkDone(s.id)}
                >
                  Mark done
                </button>
              ) : null}
            </div>
            {reason && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: 'var(--red)',
                  fontFamily: 'var(--ui)',
                  lineHeight: 1.35,
                }}
              >
                {reason}
              </div>
            )}
            {s.body && s.status !== 'blocked' && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: 'var(--text-3)',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--mono)',
                  maxHeight: 72,
                  overflow: 'hidden',
                }}
              >
                {s.body}
              </div>
            )}
            {s.body && s.status === 'blocked' && reason !== s.body && !reason?.startsWith('Infra:') && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: 'var(--text-3)',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--mono)',
                  maxHeight: 72,
                  overflow: 'hidden',
                }}
              >
                {s.body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 11,
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  minWidth: 0, // let grid children shrink; SelectDropdown has a 280px min otherwise
};

function StepsFormEditor({
  drafts,
  busy,
  onChange,
  onMove,
  onRemove,
  onAdd,
  onSave,
  onCancel,
}: {
  drafts: StepDraft[];
  busy: boolean;
  onChange: (key: string, patch: Partial<StepDraft>) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemove: (key: string) => void;
  onAdd: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--ui)' }}>
        Edit the plan as a list. Save sends the full structured step array to the API
        (same shape agents use — no raw JSON required).
      </div>

      {drafts.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          No steps yet. Add one to seed the plan (e.g. a single evergreen step).
        </div>
      ) : null}

      {drafts.map((d, i) => {
        const depOptions: Array<{ value: string; label: string }> = [
          { value: '', label: 'None' },
          ...drafts
            .map((other, oi) =>
              other.key === d.key
                ? null
                : {
                    value: other.key,
                    label: `#${oi} ${other.title.trim() || '(untitled)'}`,
                  },
            )
            .filter((x): x is { value: string; label: string } => x !== null),
        ];
        const depValue = d.dependsOnKey && drafts.some((x) => x.key === d.dependsOnKey)
          ? d.dependsOnKey
          : '';

        return (
          <div
            key={d.key}
            style={{
              padding: 12,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>#{i}</span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: STEP_STATUS_COLOR[d.status] ?? 'var(--text-3)',
                }}
              >
                {d.status}
              </span>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="modal-btn"
                style={{ fontSize: 11, padding: '2px 8px', height: 'auto' }}
                onClick={() => onMove(i, -1)}
                disabled={busy || i === 0}
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                className="modal-btn"
                style={{ fontSize: 11, padding: '2px 8px', height: 'auto' }}
                onClick={() => onMove(i, 1)}
                disabled={busy || i === drafts.length - 1}
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                className="modal-btn"
                style={{ fontSize: 11, padding: '2px 8px', height: 'auto', color: 'var(--red)' }}
                onClick={() => onRemove(d.key)}
                disabled={busy}
                title="Remove step"
              >
                Remove
              </button>
            </div>

            <label style={fieldLabelStyle}>
              Title
              <input
                className="modal-input"
                value={d.title}
                onChange={(e) => onChange(d.key, { title: e.target.value })}
                placeholder="Short label for this step"
                disabled={busy}
              />
            </label>

            {/* minmax(0,1fr) so ms-trigger (min-width:280px) can shrink in-form via .schedule-step-field */}
            <div
              className="schedule-step-fields"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 10,
              }}
            >
              <label className="schedule-step-field" style={fieldLabelStyle}>
                Status
                <SelectDropdown
                  options={STEP_STATUS_OPTIONS}
                  value={d.status}
                  onChange={(status) => onChange(d.key, { status })}
                  placement="bottom"
                  disabled={busy}
                />
              </label>
              <label className="schedule-step-field" style={fieldLabelStyle}>
                Depends on
                <SelectDropdown
                  options={depOptions}
                  value={depValue}
                  onChange={(v) => onChange(d.key, { dependsOnKey: v === '' ? null : v })}
                  placement="bottom"
                  disabled={busy}
                />
              </label>
            </div>

            <label style={fieldLabelStyle}>
              Body (instruction for the tick)
              <textarea
                className="modal-input"
                style={{ height: 88, resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 11 }}
                value={d.body}
                onChange={(e) => onChange(d.key, { body: e.target.value })}
                placeholder="What the agent should do when this step is selected…"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="modal-btn" onClick={onAdd} disabled={busy}>
          + Add step
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="modal-btn primary" onClick={onSave} disabled={busy}>
          Save steps
        </button>
        <button type="button" className="modal-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
