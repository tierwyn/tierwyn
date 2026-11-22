import type {
  CreateScheduleJobRequest,
  ExecutionMode,
  ScheduleJobDetail,
  ScheduleKind,
  SchedulePack,
  SchedulePackCadence,
  Workdir,
} from '@tierwyn/shared';
import { jobNameToSlug, PACK_INTERVAL_MIN_MS, PACK_ONCE_MAX_MS, PACK_ONCE_MIN_MS } from '@tierwyn/shared';
import { formatIntervalExpr, formatOnceExpr, parseIntervalEveryMs, parseOnceAtMs } from './duration.js';

/** Standing stub the Blank-job modal has always sent when the prompt box is empty. */
export const BLANK_JOB_PROMPT = 'Execute the current plan step.';

const BLANK_JOB_STEPS: CreateScheduleJobRequest['steps'] = [
  { title: 'Step 1', body: 'Describe the work for this step.' },
];

const ONCE_MIN_MS = PACK_ONCE_MIN_MS;
const DEFAULT_INTERVAL_MS = 86_400_000;
const DEFAULT_CRON = '0 9 * * *';
const DEFAULT_FIRE_IN_MS = 3_600_000;

export interface CadenceFormState {
  kind: ScheduleKind;
  everyMs: number;
  cronExpr: string;
  fireInMs: number;
}

export interface ScheduleCreateFormState {
  name: string;
  timezone: string;
  kind: ScheduleKind;
  everyMs: number;
  cronExpr: string;
  fireInMs: number;
  profileId: string;
  promptTemplate: string;
  steer: string;
  workdir: Workdir;
  templateName: string;
  /** Empty string = Blank job. */
  packSlug: string;
  goal: string;
  packVars: Record<string, string>;
  /** Bare-prompt agents (e.g. grok-bot): omit pack/steps/template/worktree. */
  barePrompt?: boolean;
  /** Default `'spawn_child'`. Resume mode binds an existing conversation. */
  executionMode?: ExecutionMode;
  /** Required when `executionMode === 'resume_conversation'`. */
  boundConversationId?: string;
}

/** Pack cadence → form fields. Unused kind fields keep modal defaults so toggling is safe. */
export function cadenceToFormState(cadence: SchedulePackCadence): CadenceFormState {
  if (cadence.kind === 'interval') {
    return {
      kind: 'interval',
      everyMs: cadence.everyMs,
      cronExpr: DEFAULT_CRON,
      fireInMs: DEFAULT_FIRE_IN_MS,
    };
  }
  if (cadence.kind === 'cron') {
    return {
      kind: 'cron',
      everyMs: DEFAULT_INTERVAL_MS,
      cronExpr: cadence.expr,
      fireInMs: DEFAULT_FIRE_IN_MS,
    };
  }
  return {
    kind: 'once',
    everyMs: DEFAULT_INTERVAL_MS,
    cronExpr: DEFAULT_CRON,
    fireInMs: cadence.fireInMs,
  };
}

function scheduleExprFor(state: ScheduleCreateFormState, nowMs: number): string {
  if (state.kind === 'interval') return formatIntervalExpr(state.everyMs);
  if (state.kind === 'cron') return state.cronExpr;
  return formatOnceExpr(nowMs + state.fireInMs);
}

/**
 * Build the POST /projects/:id/schedules body.
 * Blank job is byte-identical to the pre-pack Sidebar payload.
 * With a pack selected, empty promptTemplate is omitted so the server merge
 * keeps the pack's policy (a defined '' would win and fail/overwrite).
 */
export function formStateToCreateBody(
  state: ScheduleCreateFormState,
  nowMs = Date.now(),
): CreateScheduleJobRequest {
  const packSelected = Boolean(state.packSlug);
  const prompt = state.promptTemplate.trim();
  const steer = state.steer.trim();
  const templateName = state.templateName.trim();
  const goal = state.goal.trim();
  const resume = state.executionMode === 'resume_conversation';
  const resumeFields = resume
    ? {
        executionMode: 'resume_conversation' as const,
        boundConversationId: (state.boundConversationId ?? '').trim(),
      }
    : {};

  if (resume) {
    // Bound chat owns its context — omit pack/steps/workdir/templateName.
    return {
      name: state.name.trim(),
      timezone: state.timezone.trim() || 'UTC',
      scheduleKind: state.kind,
      scheduleExpr: scheduleExprFor(state, nowMs),
      profileId: state.profileId.trim(),
      promptTemplate: prompt || '',
      ...(steer ? { steer } : {}),
      ...resumeFields,
    };
  }

  if (state.barePrompt) {
    return {
      name: state.name.trim(),
      timezone: state.timezone.trim() || 'UTC',
      scheduleKind: state.kind,
      scheduleExpr: scheduleExprFor(state, nowMs),
      profileId: state.profileId.trim(),
      promptTemplate: prompt || '',
      ...(steer ? { steer } : {}),
      workdir: 'shared',
    };
  }

  if (!packSelected) {
    return {
      name: state.name.trim(),
      timezone: state.timezone.trim() || 'UTC',
      scheduleKind: state.kind,
      scheduleExpr: scheduleExprFor(state, nowMs),
      profileId: state.profileId.trim(),
      promptTemplate: prompt || BLANK_JOB_PROMPT,
      ...(steer ? { steer } : {}),
      workdir: state.workdir,
      ...(templateName ? { templateName } : {}),
      steps: BLANK_JOB_STEPS,
    };
  }

  return {
    name: state.name.trim(),
    timezone: state.timezone.trim() || 'UTC',
    scheduleKind: state.kind,
    scheduleExpr: scheduleExprFor(state, nowMs),
    profileId: state.profileId.trim(),
    ...(prompt ? { promptTemplate: prompt } : {}),
    ...(steer ? { steer } : {}),
    workdir: state.workdir,
    ...(templateName ? { templateName } : {}),
    packSlug: state.packSlug,
    ...(goal ? { goal } : {}),
    packVars: state.packVars,
  };
}

/** Kebab-case a job name for a pack slug. Strips a leading `[prefix] `. */
export function slugFromJobName(name: string): string {
  return jobNameToSlug(name, '');
}

const ONCE_FALLBACK_MS = ONCE_MIN_MS;

/** Job detail → imported pack document. Files are not captured. */
export function jobToPackDoc(
  job: ScheduleJobDetail,
  meta: { slug: string; title: string; description: string },
  nowMs = Date.now(),
): SchedulePack {
  let cadence: SchedulePackCadence;
  if (job.scheduleKind === 'interval') {
    const raw = parseIntervalEveryMs(job.scheduleExpr) ?? DEFAULT_INTERVAL_MS;
    cadence = { kind: 'interval', everyMs: Math.max(PACK_INTERVAL_MIN_MS, raw) };
  } else if (job.scheduleKind === 'cron') {
    cadence = { kind: 'cron', expr: job.scheduleExpr };
  } else {
    const atMs = parseOnceAtMs(job.scheduleExpr);
    const raw = atMs != null ? atMs - nowMs : ONCE_FALLBACK_MS;
    cadence = {
      kind: 'once',
      fireInMs: Math.min(PACK_ONCE_MAX_MS, Math.max(ONCE_MIN_MS, raw)),
    };
  }

  const pack: SchedulePack = {
    slug: meta.slug,
    title: meta.title,
    description: meta.description,
    version: 1,
    origin: 'imported',
    job: {
      cadence,
      promptTemplate: job.promptTemplate,
      ...(job.steer ? { steer: job.steer } : {}),
      workdir: job.workdir,
      overlapPolicy: job.overlapPolicy,
      executionMode: job.executionMode,
      runTimeoutMs: job.runTimeoutMs,
      agentMayComplete: job.agentMayComplete,
      ...(job.steps.length > 0
        ? { steps: job.steps.map((s) => ({ title: s.title, body: s.body })) }
        : {}),
    },
  };
  if (job.templateName) pack.requiresTemplate = true;
  return pack;
}

export function spawnCapRemedy(profileId: string): string {
  return `profile '${profileId}' has no spawn capacity — set maxConcurrentSpawns for it in Settings → Agents`;
}

export function profileHasSpawnCapacity(maxConcurrentSpawns: number | undefined): boolean {
  return (maxConcurrentSpawns ?? 0) > 0;
}

export const INTERVAL_PACK_DISABLED_TOAST =
  'Interval pack jobs start disabled — enable the job in the Schedule browser when you are ready for it to fire.';

/** Combine pack-apply warnings with the interval-disabled note so neither is dropped. */
export function packApplyToastMessage(opts: {
  warnings?: string[];
  intervalPackDisabled?: boolean;
}): string | null {
  const parts: string[] = [];
  if (opts.warnings && opts.warnings.length > 0) {
    parts.push(`Pack apply notes: ${opts.warnings.join('; ')}`);
  }
  if (opts.intervalPackDisabled) {
    parts.push(INTERVAL_PACK_DISABLED_TOAST);
  }
  return parts.length ? parts.join(' ') : null;
}
