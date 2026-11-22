import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type {
  ScheduleJob, ScheduleStep, ScheduleRun,
  ScheduleKind, OverlapPolicy, ExecutionMode, StepStatus, RunStatus,
  PatchScheduleJobRequest, Workdir,
} from '@tierwyn/shared';
import { deleteConversation } from './conversations.js';

export type OperatorJobPatch = PatchScheduleJobRequest;

export interface StepWrite {
  title: string;
  body: string;
  dependsOnOrdinal?: number;
  /** When set (agent step API), overrides the default pending/ready seed status. */
  status?: StepStatus;
}

export interface CreateJobInput {
  projectId: string;
  name: string;
  timezone: string;
  scheduleKind: ScheduleKind;
  scheduleExpr: string;
  overlapPolicy?: OverlapPolicy;
  executionMode?: ExecutionMode;
  profileId: string;
  role?: string;
  boundConversationId?: string;
  homeConversationId: string;
  promptTemplate: string;
  runTimeoutMs?: number;
  steer?: string;
  nextFireAt: number;
  agentMayComplete?: boolean;
  carryContextEnabled?: boolean;
  workdir?: Workdir;
  templateName?: string;
  steps?: StepWrite[];
  enabled?: boolean;
  /** Defaults to `operator` when omitted. */
  createdBy?: 'operator' | 'agent';
  createdByConversationId?: string;
  /** Creating conversation's capability profile. Null/omit = `all`. */
  capabilityProfile?: string | null;
  variables?: Record<string, string>;
}

interface JobRow {
  id: string;
  project_id: string;
  name: string;
  enabled: number;
  archived: number;
  timezone: string;
  schedule_kind: ScheduleKind;
  schedule_expr: string;
  overlap_policy: OverlapPolicy;
  execution_mode: ExecutionMode;
  profile_id: string;
  role: string | null;
  bound_conversation_id: string | null;
  home_conversation_id: string;
  prompt_template: string;
  run_timeout_ms: number;
  next_fire_at: number;
  agent_may_complete: number;
  carry_context_enabled: number;
  pending_context: string | null;
  pending_context_source: 'operator' | 'run' | 'system' | null;
  pending_context_updated_at: number | null;
  deferred_fire: number;
  workdir: Workdir;
  template_name: string | null;
  steer: string | null;
  created_by: string;
  created_by_conversation_id: string | null;
  created_at: number;
  updated_at: number;
  variables: string | null;
  capability_profile: string | null;
}

interface StepRow {
  id: string;
  job_id: string;
  ordinal: number;
  title: string;
  body: string;
  status: StepStatus;
  depends_on_step_id: string | null;
  updated_at: number;
}

interface RunRow {
  id: string;
  job_id: string;
  step_id: string | null;
  conversation_id: string | null;
  status: RunStatus;
  fired_at: number;
  finished_at: number | null;
  error: string | null;
  outcome_summary: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Defensive column parse — a corrupt row must not take down the job list. */
function parseVariablesColumn(s: string | null): Record<string, string> | undefined {
  if (s == null || s === '') return undefined;
  try {
    const v = JSON.parse(s) as unknown;
    if (!isPlainObject(v)) return undefined;
    const out: Record<string, string> = Object.create(null);
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string') {
        out[k] = val;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function serialiseVars(v: Record<string, string> | null | undefined): string | null {
  if (v == null) return null;
  if (Object.keys(v).length === 0) return null;
  return JSON.stringify(v);
}

function toJob(r: JobRow): ScheduleJob {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    enabled: r.enabled === 1,
    archived: r.archived === 1,
    timezone: r.timezone,
    scheduleKind: r.schedule_kind,
    scheduleExpr: r.schedule_expr,
    overlapPolicy: r.overlap_policy,
    executionMode: r.execution_mode,
    profileId: r.profile_id,
    role: r.role ?? undefined,
    boundConversationId: r.bound_conversation_id ?? undefined,
    homeConversationId: r.home_conversation_id,
    promptTemplate: r.prompt_template,
    steer: r.steer ?? undefined,
    runTimeoutMs: r.run_timeout_ms,
    nextFireAt: r.next_fire_at,
    agentMayComplete: r.agent_may_complete === 1,
    carryContextEnabled: r.carry_context_enabled === 1,
    pendingContext: r.pending_context ?? undefined,
    pendingContextSource: r.pending_context_source ?? undefined,
    pendingContextUpdatedAt: r.pending_context_updated_at ?? undefined,
    workdir: r.workdir === 'worktree' ? 'worktree' : 'shared',
    templateName: r.template_name ?? undefined,
    createdBy: r.created_by === 'agent' ? 'agent' : 'operator',
    createdByConversationId: r.created_by_conversation_id ?? undefined,
    capabilityProfile: r.capability_profile ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    variables: parseVariablesColumn(r.variables),
  };
}

function toStep(r: StepRow): ScheduleStep {
  return {
    id: r.id,
    jobId: r.job_id,
    ordinal: r.ordinal,
    title: r.title,
    body: r.body,
    status: r.status,
    dependsOnStepId: r.depends_on_step_id ?? undefined,
    updatedAt: r.updated_at,
  };
}

function toRun(r: RunRow): ScheduleRun {
  return {
    id: r.id,
    jobId: r.job_id,
    stepId: r.step_id ?? undefined,
    conversationId: r.conversation_id ?? undefined,
    status: r.status,
    firedAt: r.fired_at,
    finishedAt: r.finished_at ?? undefined,
    error: r.error ?? undefined,
    outcomeSummary: r.outcome_summary ?? undefined,
  };
}

export function getJob(db: Database, id: string): ScheduleJob | undefined {
  const row = db.prepare('SELECT * FROM schedule_jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? toJob(row) : undefined;
}

export function listJobsForProject(
  db: Database, projectId: string, opts?: { includeArchived?: boolean }
): ScheduleJob[] {
  const sql = opts?.includeArchived
    ? 'SELECT * FROM schedule_jobs WHERE project_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM schedule_jobs WHERE project_id = ? AND archived = 0 ORDER BY created_at DESC';
  return (db.prepare(sql).all(projectId) as JobRow[]).map(toJob);
}

/** Active (non-archived) agent-created jobs linked to a conversation. */
export function countAgentJobsForConversation(db: Database, conversationId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM schedule_jobs
     WHERE created_by_conversation_id = ? AND archived = 0`,
  ).get(conversationId) as { n: number };
  return row.n;
}

/** Active (non-archived) agent-created jobs in a project. */
export function countAgentJobsForProject(db: Database, projectId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM schedule_jobs
     WHERE project_id = ? AND created_by = 'agent' AND archived = 0`,
  ).get(projectId) as { n: number };
  return row.n;
}

/**
 * Create a schedule job and, in the same transaction, its initial steps.
 * Steps are inserted with ordinals 0..n-1, then `dependsOnOrdinal` is
 * resolved to `depends_on_step_id` in a second pass (ids don't exist until
 * after insert). The first step with no unmet dependency starts 'ready';
 * every other step starts 'pending' (selectCurrentStep accepts both).
 */
export function createJob(db: Database, input: CreateJobInput): ScheduleJob {
  const id = randomUUID();
  const now = Date.now();
  const tx = db.transaction(() => {
    const workdir: Workdir = input.workdir === 'worktree' ? 'worktree' : 'shared';
    const templateName = input.templateName?.trim() || null;
    const createdBy = input.createdBy === 'agent' ? 'agent' : 'operator';
    const createdByConversationId = input.createdByConversationId?.trim() || null;
    const capabilityProfile = input.capabilityProfile?.trim() || null;
    db.prepare(
      `INSERT INTO schedule_jobs (
         id, project_id, name, enabled, archived, timezone, schedule_kind, schedule_expr,
         overlap_policy, execution_mode, profile_id, role, bound_conversation_id,
         home_conversation_id, prompt_template, steer, variables, run_timeout_ms, next_fire_at,
         agent_may_complete, carry_context_enabled, workdir, template_name,
         created_by, created_by_conversation_id, capability_profile, created_at, updated_at
       ) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, input.projectId, input.name, input.enabled === false ? 0 : 1,
      input.timezone, input.scheduleKind, input.scheduleExpr,
      input.overlapPolicy ?? 'skip', input.executionMode ?? 'spawn_child',
      input.profileId, input.role ?? null, input.boundConversationId ?? null,
      input.homeConversationId, input.promptTemplate, input.steer?.trim() || null,
      serialiseVars(input.variables),
      input.runTimeoutMs ?? 1_800_000,
      input.nextFireAt, input.agentMayComplete ? 1 : 0, input.carryContextEnabled ? 1 : 0,
      workdir, templateName, createdBy, createdByConversationId, capabilityProfile, now, now,
    );

    const steps = input.steps ?? [];
    const stepIds: string[] = steps.map(() => randomUUID());
    const insertStep = db.prepare(
      `INSERT INTO schedule_steps (id, job_id, ordinal, title, body, status, updated_at)
       VALUES (?,?,?,?,?,'pending',?)`
    );
    steps.forEach((s, i) => {
      insertStep.run(stepIds[i], id, i, s.title, s.body, now);
    });

    const updateDeps = db.prepare('UPDATE schedule_steps SET depends_on_step_id = ? WHERE id = ?');
    steps.forEach((s, i) => {
      if (s.dependsOnOrdinal !== undefined) {
        const depId = stepIds[s.dependsOnOrdinal];
        if (depId) updateDeps.run(depId, stepIds[i]);
      }
    });

    // First step with no dependency (unresolved ordinal or none) starts ready.
    const firstEligibleIdx = steps.findIndex((s) => s.dependsOnOrdinal === undefined);
    if (firstEligibleIdx >= 0) {
      db.prepare(`UPDATE schedule_steps SET status = 'ready' WHERE id = ?`).run(stepIds[firstEligibleIdx]);
    }
  });
  tx();
  return getJob(db, id)!;
}

export function updateJob(db: Database, id: string, patch: OperatorJobPatch): ScheduleJob | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, val: unknown) => { fields.push(`${col} = ?`); values.push(val); };

  if (patch.name !== undefined) set('name', patch.name);
  if (patch.timezone !== undefined) set('timezone', patch.timezone);
  if (patch.scheduleKind !== undefined) set('schedule_kind', patch.scheduleKind);
  if (patch.scheduleExpr !== undefined) set('schedule_expr', patch.scheduleExpr);
  if (patch.overlapPolicy !== undefined) set('overlap_policy', patch.overlapPolicy);
  if (patch.executionMode !== undefined) set('execution_mode', patch.executionMode);
  if (patch.profileId !== undefined) set('profile_id', patch.profileId);
  if (patch.role !== undefined) set('role', patch.role);
  if (patch.boundConversationId !== undefined) set('bound_conversation_id', patch.boundConversationId);
  if (patch.promptTemplate !== undefined) set('prompt_template', patch.promptTemplate);
  if (patch.steer !== undefined) {
    set('steer', patch.steer === null || patch.steer === '' ? null : patch.steer);
  }
  if (patch.runTimeoutMs !== undefined) set('run_timeout_ms', patch.runTimeoutMs);
  if (patch.agentMayComplete !== undefined) set('agent_may_complete', patch.agentMayComplete ? 1 : 0);
  if (patch.carryContextEnabled !== undefined) set('carry_context_enabled', patch.carryContextEnabled ? 1 : 0);
  if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
  if (patch.workdir !== undefined) set('workdir', patch.workdir === 'worktree' ? 'worktree' : 'shared');
  if (patch.templateName !== undefined) {
    set('template_name', patch.templateName === null || patch.templateName === ''
      ? null
      : patch.templateName);
  }
  if (patch.variables !== undefined) {
    set('variables', serialiseVars(patch.variables));
  }

  if (fields.length === 0) return getJob(db, id);

  set('updated_at', Date.now());
  const info = db.prepare(`UPDATE schedule_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  if (info.changes === 0) return undefined;
  return getJob(db, id);
}

export function setJobEnabled(db: Database, id: string, enabled: boolean): ScheduleJob | undefined {
  const info = db.prepare('UPDATE schedule_jobs SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id);
  if (info.changes === 0) return undefined;
  return getJob(db, id);
}

export function archiveJob(db: Database, id: string): ScheduleJob | undefined {
  const info = db.prepare('UPDATE schedule_jobs SET archived = 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
  if (info.changes === 0) return undefined;
  return getJob(db, id);
}

export function unarchiveJob(db: Database, id: string): ScheduleJob | undefined {
  const info = db.prepare('UPDATE schedule_jobs SET archived = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
  if (info.changes === 0) return undefined;
  return getJob(db, id);
}

export type HardDeleteJobResult = {
  ok: boolean;
  /** Conversation ids removed (runs + spawn trees + home). */
  deletedConversationIds: string[];
  nativeSessions: { agentId: string; nativeSessionId: string; projectId: string }[];
  ttsWavPaths: string[];
};

/**
 * Permanently remove a schedule job and all associated data:
 * - spawn_child run conversations (children of home) and their spawn subtrees
 *   (+ TTS WAVs, sessions, events). Resume-bound project chats are never purged.
 * - the schedule home conversation
 * - steps + runs (via FK CASCADE on schedule_jobs)
 *
 * Callers must ensure no active run and reaped sessions before invoking.
 */
export function hardDeleteJob(db: Database, id: string): HardDeleteJobResult {
  const job = getJob(db, id);
  if (!job) {
    return { ok: false, deletedConversationIds: [], nativeSessions: [], ttsWavPaths: [] };
  }

  // Only purge run conversations owned by this schedule (parented under home).
  // resume_conversation runs point at ordinary project chats — leave those alone (D1).
  const runConvIds = (
    db.prepare(
      `SELECT DISTINCT r.conversation_id AS id FROM schedule_runs r
         JOIN conversations c ON c.id = r.conversation_id
        WHERE r.job_id = ? AND c.parent_conversation_id = ?`,
    ).all(id, job.homeConversationId) as { id: string }[]
  ).map((r) => r.id);

  const deletedConversationIds: string[] = [];
  const nativeSessions: { agentId: string; nativeSessionId: string; projectId: string }[] = [];
  const ttsWavPaths: string[] = [];

  for (const convId of runConvIds) {
    const r = deleteConversation(db, convId);
    if (r.ok) {
      deletedConversationIds.push(...r.deletedIds);
      nativeSessions.push(...r.nativeSessions);
      ttsWavPaths.push(...r.ttsWavPaths);
    }
  }

  // Drop the job first so home_conversation_id FK is released, then home row.
  db.prepare('UPDATE schedule_steps SET depends_on_step_id = NULL WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM schedule_jobs WHERE id = ?').run(id);

  if (job.homeConversationId) {
    const home = deleteConversation(db, job.homeConversationId);
    if (home.ok) {
      deletedConversationIds.push(...home.deletedIds);
      nativeSessions.push(...home.nativeSessions);
      ttsWavPaths.push(...home.ttsWavPaths);
    }
  }

  return { ok: true, deletedConversationIds, nativeSessions, ttsWavPaths };
}

export function setNextFireAt(db: Database, id: string, nextFireAt: number): void {
  db.prepare('UPDATE schedule_jobs SET next_fire_at = ?, updated_at = ? WHERE id = ?')
    .run(nextFireAt, Date.now(), id);
}

/** No lock manager; single-process server. Order by next_fire_at ascending. */
export function claimDueJobs(db: Database, nowMs: number, limit = 20): ScheduleJob[] {
  const rows = db.prepare(
    `SELECT * FROM schedule_jobs
      WHERE enabled = 1 AND archived = 0 AND next_fire_at <= ?
      ORDER BY next_fire_at ASC
      LIMIT ?`
  ).all(nowMs, limit) as JobRow[];
  return rows.map(toJob);
}

export function replaceSteps(db: Database, jobId: string, steps: StepWrite[]): ScheduleStep[] {
  const tx = db.transaction(() => {
    // Self-FK (depends_on_step_id → schedule_steps.id) and schedule_runs.step_id
    // both reference step rows. Delete-all would FK-fail unless those refs are
    // cleared first. Same pattern as hardDeleteJob for self-deps; runs lose the
    // step link on rewrite (step ids are always re-minted below).
    db.prepare('UPDATE schedule_steps SET depends_on_step_id = NULL WHERE job_id = ?').run(jobId);
    db.prepare('UPDATE schedule_runs SET step_id = NULL WHERE job_id = ?').run(jobId);
    db.prepare('DELETE FROM schedule_steps WHERE job_id = ?').run(jobId);
    const now = Date.now();
    const stepIds = steps.map(() => randomUUID());
    const insertStep = db.prepare(
      `INSERT INTO schedule_steps (id, job_id, ordinal, title, body, status, updated_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    steps.forEach((s, i) => {
      const status = s.status ?? 'pending';
      insertStep.run(stepIds[i], jobId, i, s.title, s.body, status, now);
    });

    const updateDeps = db.prepare('UPDATE schedule_steps SET depends_on_step_id = ? WHERE id = ?');
    steps.forEach((s, i) => {
      if (s.dependsOnOrdinal !== undefined) {
        const depId = stepIds[s.dependsOnOrdinal];
        if (depId) updateDeps.run(depId, stepIds[i]);
      }
    });

    // Seed first eligible as ready only when no step carried an explicit status
    // (agent full-replace owns status; create-job path leaves status unset).
    const anyExplicitStatus = steps.some((s) => s.status !== undefined);
    if (!anyExplicitStatus) {
      const firstEligibleIdx = steps.findIndex((s) => s.dependsOnOrdinal === undefined);
      if (firstEligibleIdx >= 0) {
        db.prepare(`UPDATE schedule_steps SET status = 'ready' WHERE id = ?`).run(stepIds[firstEligibleIdx]);
      }
    }
  });
  tx();
  return listSteps(db, jobId);
}

export function listSteps(db: Database, jobId: string): ScheduleStep[] {
  return (db.prepare('SELECT * FROM schedule_steps WHERE job_id = ? ORDER BY ordinal ASC').all(jobId) as StepRow[])
    .map(toStep);
}

export function getStep(db: Database, stepId: string): ScheduleStep | undefined {
  const row = db.prepare('SELECT * FROM schedule_steps WHERE id = ?').get(stepId) as StepRow | undefined;
  return row ? toStep(row) : undefined;
}

export function updateStepStatus(db: Database, stepId: string, status: StepStatus): void {
  db.prepare('UPDATE schedule_steps SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), stepId);
}

export interface StepPatch {
  status?: StepStatus;
  title?: string;
  body?: string;
}

/**
 * In-place update of one step (no graph rewrite, no id remint).
 * When status becomes `done`, promote direct dependents that are still `pending` to `ready`.
 */
export function patchStep(
  db: Database,
  jobId: string,
  stepId: string,
  patch: StepPatch,
): { ok: true; step: ScheduleStep; promoted: ScheduleStep[] } | { ok: false; reason: 'not_found' } {
  const existing = getStep(db, stepId);
  if (!existing || existing.jobId !== jobId) return { ok: false, reason: 'not_found' };

  const now = Date.now();
  const title = patch.title !== undefined ? patch.title : existing.title;
  const body = patch.body !== undefined ? patch.body : existing.body;
  const status = patch.status !== undefined ? patch.status : existing.status;

  db.prepare(
    `UPDATE schedule_steps SET title = ?, body = ?, status = ?, updated_at = ? WHERE id = ?`,
  ).run(title, body, status, now, stepId);

  const promoted: ScheduleStep[] = [];
  if (patch.status === 'done') {
    const dependents = listSteps(db, jobId).filter(
      (s) => s.dependsOnStepId === stepId && s.status === 'pending',
    );
    for (const dep of dependents) {
      updateStepStatus(db, dep.id, 'ready');
      const refreshed = getStep(db, dep.id);
      if (refreshed) promoted.push(refreshed);
    }
  }

  return { ok: true, step: getStep(db, stepId)!, promoted };
}

/** Operator/agent recovery: blocked|running → ready so the next tick can re-select. */
export function retryStep(
  db: Database,
  jobId: string,
  stepId: string,
): { ok: true; step: ScheduleStep } | { ok: false; reason: 'not_found' | 'not_retryable' } {
  const step = getStep(db, stepId);
  if (!step || step.jobId !== jobId) return { ok: false, reason: 'not_found' };
  if (step.status !== 'blocked' && step.status !== 'running') {
    return { ok: false, reason: 'not_retryable' };
  }
  updateStepStatus(db, stepId, 'ready');
  return { ok: true, step: getStep(db, stepId)! };
}

/** Mark every step done (workload finished offline / operator complete-all). */
export function completeAllSteps(db: Database, jobId: string): ScheduleStep[] {
  const now = Date.now();
  db.prepare(`UPDATE schedule_steps SET status = 'done', updated_at = ? WHERE job_id = ?`).run(now, jobId);
  return listSteps(db, jobId);
}

/**
 * Infra / telemetry false-blocks that should not freeze the plan forever.
 * Used by tick auto-heal and UI classification.
 */
export const INFRA_STEP_ERRORS = new Set(['no_step_update', 'step_api_failed']);

export function isInfraStepError(error: string | null | undefined): boolean {
  if (!error) return false;
  if (INFRA_STEP_ERRORS.has(error)) return true;
  return error.startsWith('step_api_failed:') || error.startsWith('step_api_failed');
}

function isInfraBlockBody(body: string | undefined): boolean {
  if (!body) return false;
  const t = body.trim();
  return (
    t.startsWith('step_api_failed:')
    || t.startsWith('step_api_failed')
    || t === 'no_step_update'
    || t.startsWith('no_step_update')
  );
}

/**
 * Promote steps left `blocked` by missing step writes / step-API failures so
 * the next tick can re-select them. Agent-declared blocked (human reason, no
 * infra marker on run error or step body) is left alone.
 */
export function healInfraBlockedSteps(db: Database, jobId: string): ScheduleStep[] {
  const steps = listSteps(db, jobId);
  const healed: ScheduleStep[] = [];
  for (const s of steps) {
    if (s.status !== 'blocked') continue;

    const lastRun = (
      db.prepare(
        `SELECT error, status FROM schedule_runs
          WHERE job_id = ? AND step_id = ?
            AND status IN ('succeeded','failed','timed_out')
          ORDER BY fired_at DESC LIMIT 1`,
      ).get(jobId, s.id) as { error: string | null; status: string } | undefined
    );

    const shouldHeal =
      isInfraStepError(lastRun?.error)
      || isInfraBlockBody(s.body)
      // Succeeded tick, step still blocked, empty body → almost always false freeze.
      || (lastRun?.status === 'succeeded' && !(s.body ?? '').trim());

    if (!shouldHeal) continue;

    updateStepStatus(db, s.id, 'ready');
    const refreshed = getStep(db, s.id);
    if (refreshed) healed.push(refreshed);
  }
  return healed;
}

/** First step (by ordinal) that is ready/pending and whose dependency (if any) is done. */
export function selectCurrentStep(db: Database, jobId: string): ScheduleStep | undefined {
  const steps = listSteps(db, jobId);
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const s of steps) {
    if (s.status !== 'ready' && s.status !== 'pending') continue;
    if (s.dependsOnStepId) {
      const dep = byId.get(s.dependsOnStepId);
      if (!dep || dep.status !== 'done') continue;
    }
    return s;
  }
  return undefined;
}

export function createRun(
  db: Database,
  input: { jobId: string; stepId?: string; conversationId?: string; status: RunStatus; firedAt: number }
): ScheduleRun {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO schedule_runs (id, job_id, step_id, conversation_id, status, fired_at)
     VALUES (?,?,?,?,?,?)`
  ).run(id, input.jobId, input.stepId ?? null, input.conversationId ?? null, input.status, input.firedAt);
  return getRun(db, id)!;
}

export function getRun(db: Database, id: string): ScheduleRun | undefined {
  const row = db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function updateRun(
  db: Database,
  id: string,
  patch: Partial<{
    status: RunStatus; conversationId: string; finishedAt: number; error: string; outcomeSummary: string;
  }>
): ScheduleRun | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, val: unknown) => { fields.push(`${col} = ?`); values.push(val); };

  if (patch.status !== undefined) set('status', patch.status);
  if (patch.conversationId !== undefined) set('conversation_id', patch.conversationId);
  if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);
  if (patch.error !== undefined) set('error', patch.error);
  if (patch.outcomeSummary !== undefined) set('outcome_summary', patch.outcomeSummary);

  if (fields.length === 0) return getRun(db, id);

  const info = db.prepare(`UPDATE schedule_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  if (info.changes === 0) return undefined;
  return getRun(db, id);
}

/** Hard-delete a schedule_runs row by id. Used by operator unskip to remove hole rows. */
export function deleteRun(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM schedule_runs WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * Clear failed / errored runs for a schedule job, or remove orphaned runs
 * whose conversation was deleted. If `onlyOrphaned` is true, only runs where
 * `conversation_id IS NULL` and status is failed/timed_out are deleted.
 * Otherwise, all failed/timed_out runs for this job are purged so the schedule
 * returns to a clean healthy state.
 */
export function clearJobErrors(
  db: Database,
  jobId: string,
  opts?: { onlyOrphaned?: boolean },
): number {
  if (opts?.onlyOrphaned) {
    const info = db.prepare(
      `DELETE FROM schedule_runs
        WHERE job_id = ?
          AND conversation_id IS NULL
          AND status IN ('failed', 'timed_out')`,
    ).run(jobId);
    return info.changes;
  }
  const info = db.prepare(
    `DELETE FROM schedule_runs
      WHERE job_id = ?
        AND status IN ('failed', 'timed_out')`,
  ).run(jobId);
  return info.changes;
}

/**
 * List runs for a job (newest first).
 *
 * `excludeHoleRows` — omit operator hole bookkeeping (`operator_skip` /
 * legacy `operator_unskip`). Past-runs UI and the schedules tree must use this
 * so hole-punch / unskip leftovers cannot fill the progressive `LIMIT` and
 * bury real tick conversations. Skip-set helpers leave this false.
 */
export function listRunsForJob(
  db: Database,
  jobId: string,
  opts?: { limit?: number; excludeHoleRows?: boolean },
): ScheduleRun[] {
  const limit = opts?.limit ?? 50;
  if (opts?.excludeHoleRows) {
    return (
      db.prepare(
        `SELECT * FROM schedule_runs
          WHERE job_id = ?
            AND NOT (status = 'skipped' AND error IN ('operator_skip', 'operator_unskip'))
          ORDER BY fired_at DESC LIMIT ?`,
      ).all(jobId, limit) as RunRow[]
    ).map(toRun);
  }
  return (
    db.prepare('SELECT * FROM schedule_runs WHERE job_id = ? ORDER BY fired_at DESC LIMIT ?')
      .all(jobId, limit) as RunRow[]
  ).map(toRun);
}

/**
 * Delete legacy `operator_unskip` rows left by the old unskip-relabel path.
 * New unskip hard-deletes holes; these leftovers only clutter past-runs LIMIT.
 * Live/future `operator_skip` holes are kept for Upcoming / unskip.
 * Returns rows deleted.
 */
export function pruneInertOperatorHoleRows(db: Database, _nowMs = Date.now()): number {
  const info = db.prepare(
    `DELETE FROM schedule_runs
      WHERE status = 'skipped' AND error = 'operator_unskip'`,
  ).run();
  return info.changes;
}

export function getActiveRunForJob(db: Database, jobId: string): ScheduleRun | undefined {
  const row = db.prepare(
    `SELECT * FROM schedule_runs WHERE job_id = ? AND status IN ('pending','running')
      ORDER BY fired_at DESC LIMIT 1`
  ).get(jobId) as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function listStuckRunningRuns(db: Database, olderThanMs: number): ScheduleRun[] {
  return (
    db.prepare(`SELECT * FROM schedule_runs WHERE status = 'running' AND fired_at <= ?`)
      .all(olderThanMs) as RunRow[]
  ).map(toRun);
}

export function hasActiveRun(db: Database, jobId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM schedule_runs WHERE job_id = ? AND status IN ('pending','running') LIMIT 1`
  ).get(jobId);
  return row !== undefined;
}

/** Read the single-bit "one fire is owed" latch (queue_one / catch_up). */
export function getDeferredFire(db: Database, jobId: string): boolean {
  const row = db.prepare(
    'SELECT deferred_fire FROM schedule_jobs WHERE id = ?',
  ).get(jobId) as { deferred_fire: number } | undefined;
  return row?.deferred_fire === 1;
}

/** Set or clear the deferred_fire latch. */
export function setDeferredFire(db: Database, jobId: string, on: boolean): void {
  db.prepare(
    `UPDATE schedule_jobs SET deferred_fire = ?, updated_at = ? WHERE id = ?`,
  ).run(on ? 1 : 0, Date.now(), jobId);
}

/**
 * Atomic compare-and-swap: claim an owed fire (1→0).
 * Returns true only when this caller owns the fire (changes === 1).
 */
export function claimDeferredFire(db: Database, jobId: string): boolean {
  const info = db.prepare(
    `UPDATE schedule_jobs
        SET deferred_fire = 0, updated_at = ?
      WHERE id = ? AND deferred_fire = 1`,
  ).run(Date.now(), jobId);
  return info.changes > 0;
}

/**
 * Jobs with a deferred fire owed. Does NOT filter enabled — a once+queue_one
 * job disables itself on the latching tick but still owes exactly one fire.
 */
export function listJobsWithDeferredFire(db: Database): ScheduleJob[] {
  return (
    db.prepare(
      `SELECT * FROM schedule_jobs
        WHERE deferred_fire = 1 AND archived = 0
        ORDER BY next_fire_at ASC`,
    ).all() as JobRow[]
  ).map(toJob);
}

/** Max UTF-8 byte length for pending_context body (reject oversize at the route). */
export const PENDING_CONTEXT_MAX_BYTES = 8 * 1024;

export type PendingContextSource = 'operator' | 'run' | 'system';

/**
 * Set or clear held carry-forward context for the next tick.
 * `text` null/empty clears context (and source / updated_at).
 * Does not toggle `carry_context_enabled`.
 */
export function setPendingContext(
  db: Database,
  jobId: string,
  opts: { text: string | null; source: PendingContextSource },
): void {
  const now = Date.now();
  const cleared = opts.text == null || opts.text === '';
  if (cleared) {
    db.prepare(
      `UPDATE schedule_jobs
          SET pending_context = NULL,
              pending_context_source = NULL,
              pending_context_updated_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(now, jobId);
    return;
  }
  db.prepare(
    `UPDATE schedule_jobs
        SET pending_context = ?,
            pending_context_source = ?,
            pending_context_updated_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(opts.text, opts.source, now, now, jobId);
}

/**
 * Atomically read and clear pending_context (+ source / updated_at).
 * Returns the previous text, or undefined when empty/null.
 */
export function consumePendingContext(db: Database, jobId: string): string | undefined {
  const tx = db.transaction(() => {
    const row = db.prepare(
      'SELECT pending_context FROM schedule_jobs WHERE id = ?',
    ).get(jobId) as { pending_context: string | null } | undefined;
    if (!row) return undefined;
    const prev = row.pending_context;
    db.prepare(
      `UPDATE schedule_jobs
          SET pending_context = NULL,
              pending_context_source = NULL,
              pending_context_updated_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(Date.now(), jobId);
    return prev == null || prev === '' ? undefined : prev;
  });
  return tx();
}

/** Links a pre-created home conversation to its job (chicken/egg: home is
 *  created first without a job id, the job is created with the home id,
 *  then this backfills conversations.schedule_job_id + kind). */
export function linkHomeConversation(db: Database, homeId: string, jobId: string): void {
  db.prepare(`UPDATE conversations SET schedule_job_id = ?, kind = 'schedule_home' WHERE id = ?`)
    .run(jobId, homeId);
}
