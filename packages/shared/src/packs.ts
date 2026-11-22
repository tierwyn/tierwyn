import type { ExecutionMode, OverlapPolicy, Workdir } from './domain.js';
import { PIPELINE_MAX_STAGES, STAGE_ID_RE } from './pipeline.js';
import { parseScheduleVariables } from './scheduleVars.js';

/** Keep in sync with AGENT_PROMPT_MAX_BYTES in apps/server/src/routes/schedules.ts */
export const PACK_PROMPT_MAX_BYTES = 8192;
/** Keep in sync with AGENT_STEPS_MAX in apps/server/src/routes/schedules.ts */
export const PACK_STEPS_MAX = 5;
export const PACK_FILE_MAX_BYTES = 65536;
export const PACK_DOC_MAX_BYTES = 262144;
export const PACK_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Cadence floors — interval matches AGENT_MIN_INTERVAL_MS; once matches agent fireInMs. */
export const PACK_INTERVAL_MIN_MS = 300_000;
export const PACK_ONCE_MIN_MS = 60_000;
export const PACK_ONCE_MAX_MS = 604_800_000;

export const FILE_KINDS = ['prompt', 'progress', 'roster', 'README'] as const;

/** Where the row came from. Shipped rows are seeded from app source and undeletable. */
export type SchedulePackOrigin = 'shipped' | 'imported';

/** Cadence default. Absolute `once` times are computed at apply, never stored. */
export type SchedulePackCadence =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expr: string }
  | { kind: 'once'; fireInMs: number };

/** File materialised under <projectRoot>/.tierwyn/schedule/ at apply time.
 *  `kind` — not a path — is the whole point: no operator- or pack-supplied path
 *  ever reaches the filesystem, so traversal is impossible by construction. */
export type SchedulePackFileKind = typeof FILE_KINDS[number];

export interface SchedulePackFile {
  kind: SchedulePackFileKind;
  /** Markdown body. Apply-time tokens use [[double square brackets]]. */
  body: string;
}

/** Extra control rendered in the apply modal, above cadence. v1 supports one type. */
export interface SchedulePackApplyField {
  /** Token name — substituted as [[<key>]] into promptTemplate and file bodies. */
  key: string;
  label: string;
  help?: string;
  type: 'select' | 'profile';
  /** Required for type 'select' when options are frozen. First entry is the default.
   *  Omitted/empty is allowed for live catalogues (e.g. implementer templates). */
  options?: Array<{ value: string; label: string }>;
}

/** Everything copied into CreateScheduleJobRequest. Name/timezone/profileId/templateName
 *  are supplied by the operator at apply, so they are absent here on purpose. */
export interface SchedulePackJob {
  cadence: SchedulePackCadence;
  promptTemplate: string;
  steer?: string;
  workdir?: Workdir;
  overlapPolicy?: OverlapPolicy;
  executionMode?: ExecutionMode;
  runTimeoutMs?: number;
  agentMayComplete?: boolean;
  /** ≤ AGENT_STEPS_MAX (5). */
  steps?: Array<{ title: string; body: string }>;
  /** Typical job variables seeded at apply (caller packVars still win). */
  variables?: Record<string, string>;
}

export interface SchedulePack {
  /** Identity. `^[a-z0-9][a-z0-9-]{0,47}$`. Also the job-name prefix. NOT the file
   *  stem — that is derived from the job name so a pack can be applied
   *  more than once in the same repository. */
  slug: string;
  title: string;
  description: string;
  /** Bumped by hand when a shipped body changes; informational only. */
  version: number;
  origin: SchedulePackOrigin;
  job: SchedulePackJob;
  /** Required pipeline stage IDs that must exist in the selected template and not be skipped. */
  requiredStages?: string[];
  /** Recipe spawns ⇒ apply requires a template + a spawn-capable profile. */
  requiresTemplate?: boolean;
  /** e.g. 'claude-code' — preselect a matching profile; operator may override. */
  profileAgentHint?: string;
  applyFields?: SchedulePackApplyField[];
  files?: SchedulePackFile[];
}

export type ValidateSchedulePackResult =
  | { ok: true; pack: SchedulePack }
  | { ok: false; error: string };

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Sanitised job name → file stem. Falls back to the pack slug when the name
 * sanitises to nothing (non-latin titles, punctuation-only names).
 */
export function jobNameToSlug(jobName: string, packSlug: string): string {
  let s = jobName.trim().replace(/^\[[^\]]*\]\s+/, '');
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 48) {
    s = s.slice(0, 48).replace(/-+$/g, '');
  }
  return PACK_SLUG_RE.test(s) ? s : packSlug;
}

function parseCadence(raw: unknown): { ok: true; cadence: SchedulePackCadence } | { ok: false; error: string } {
  if (!isRecord(raw) || typeof raw.kind !== 'string') {
    return { ok: false, error: 'job.cadence required' };
  }
  if (raw.kind === 'interval') {
    if (typeof raw.everyMs !== 'number' || !Number.isFinite(raw.everyMs) || raw.everyMs < PACK_INTERVAL_MIN_MS) {
      return { ok: false, error: 'cadence.everyMs must be ≥ 300000' };
    }
    return { ok: true, cadence: { kind: 'interval', everyMs: raw.everyMs } };
  }
  if (raw.kind === 'cron') {
    if (typeof raw.expr !== 'string' || !raw.expr.trim()) {
      return { ok: false, error: 'cadence.expr required' };
    }
    return { ok: true, cadence: { kind: 'cron', expr: raw.expr } };
  }
  if (raw.kind === 'once') {
    if (
      typeof raw.fireInMs !== 'number' ||
      !Number.isFinite(raw.fireInMs) ||
      raw.fireInMs < PACK_ONCE_MIN_MS ||
      raw.fireInMs > PACK_ONCE_MAX_MS
    ) {
      return { ok: false, error: 'cadence.fireInMs must be in [60000, 604800000]' };
    }
    return { ok: true, cadence: { kind: 'once', fireInMs: raw.fireInMs } };
  }
  return { ok: false, error: 'job.cadence.kind must be interval, cron, or once' };
}

function parseSteps(raw: unknown): { ok: true; steps?: Array<{ title: string; body: string }> } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'job.steps must be an array' };
  if (raw.length > PACK_STEPS_MAX) {
    return { ok: false, error: `job.steps must have ≤ ${PACK_STEPS_MAX} items` };
  }
  const steps: Array<{ title: string; body: string }> = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!isRecord(s) || typeof s.title !== 'string' || typeof s.body !== 'string') {
      return { ok: false, error: `job.steps[${i}] must have string title and body` };
    }
    steps.push({ title: s.title, body: s.body });
  }
  return { ok: true, steps };
}

function parseFiles(raw: unknown): { ok: true; files?: SchedulePackFile[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'files must be an array' };
  if (raw.length > FILE_KINDS.length) {
    return { ok: false, error: `files must have ≤ ${FILE_KINDS.length} items` };
  }
  const files: SchedulePackFile[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!isRecord(f) || typeof f.kind !== 'string' || typeof f.body !== 'string') {
      return { ok: false, error: `files[${i}] must have kind and body` };
    }
    if (!(FILE_KINDS as readonly string[]).includes(f.kind)) {
      return { ok: false, error: `files[${i}].kind invalid` };
    }
    if (seen.has(f.kind)) return { ok: false, error: `files: duplicate kind ${f.kind}` };
    seen.add(f.kind);
    if (utf8Bytes(f.body) > PACK_FILE_MAX_BYTES) {
      return { ok: false, error: `files[${i}].body exceeds ${PACK_FILE_MAX_BYTES} bytes` };
    }
    files.push({ kind: f.kind as SchedulePackFileKind, body: f.body });
  }
  return { ok: true, files: files.length ? files : undefined };
}

function parseApplyFields(raw: unknown): { ok: true; fields?: SchedulePackApplyField[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'applyFields must be an array' };
  const fields: SchedulePackApplyField[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!isRecord(f) || typeof f.key !== 'string' || !f.key.trim() || typeof f.label !== 'string' || !f.label.trim()) {
      return { ok: false, error: `applyFields[${i}] must have key and label` };
    }
    if (f.type !== 'select' && f.type !== 'profile') {
      return { ok: false, error: `applyFields[${i}].type must be select or profile` };
    }
    const field: SchedulePackApplyField = { key: f.key, label: f.label, type: f.type };
    if (typeof f.help === 'string') field.help = f.help;
    if (f.options !== undefined) {
      if (!Array.isArray(f.options)) return { ok: false, error: `applyFields[${i}].options must be an array` };
      field.options = [];
      for (const opt of f.options) {
        if (!isRecord(opt) || typeof opt.value !== 'string' || typeof opt.label !== 'string') {
          return { ok: false, error: `applyFields[${i}].options entries need value and label` };
        }
        field.options.push({ value: opt.value, label: opt.label });
      }
    }
    fields.push(field);
  }
  return { ok: true, fields: fields.length ? fields : undefined };
}

function parseRequiredStages(raw: unknown): { ok: true; stages?: string[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'requiredStages must be an array' };
  if (raw.length > PIPELINE_MAX_STAGES) {
    return { ok: false, error: `requiredStages must have ≤ ${PIPELINE_MAX_STAGES} items` };
  }
  const stages: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (typeof s !== 'string' || !STAGE_ID_RE.test(s)) {
      return { ok: false, error: `requiredStages[${i}] must match ^[a-z][a-z0-9]{0,23}$` };
    }
    if (seen.has(s)) {
      return { ok: false, error: `requiredStages: duplicate stage "${s}"` };
    }
    seen.add(s);
    stages.push(s);
  }
  return { ok: true, stages: stages.length ? stages : undefined };
}

/**
 * Pure import validator. Unknown optional keys are stripped. `origin` is always
 * forced to `imported` — an import can never mint a shipped row.
 */
export function validateSchedulePack(doc: unknown): ValidateSchedulePackResult {
  if (!isRecord(doc)) return { ok: false, error: 'pack must be a JSON object' };

  let encoded: string;
  try {
    encoded = JSON.stringify(doc);
  } catch {
    return { ok: false, error: 'pack is not JSON-serialisable' };
  }
  if (utf8Bytes(encoded) > PACK_DOC_MAX_BYTES) {
    return { ok: false, error: `pack document exceeds ${PACK_DOC_MAX_BYTES} bytes` };
  }

  if (typeof doc.slug !== 'string' || !PACK_SLUG_RE.test(doc.slug)) {
    return { ok: false, error: 'slug must match ^[a-z0-9][a-z0-9-]{0,47}$' };
  }
  if (typeof doc.title !== 'string' || !doc.title.trim()) {
    return { ok: false, error: 'title required' };
  }
  if (!isRecord(doc.job)) return { ok: false, error: 'job required' };

  const cadence = parseCadence(doc.job.cadence);
  if (!cadence.ok) return cadence;

  if (typeof doc.job.promptTemplate !== 'string' || !doc.job.promptTemplate.trim()) {
    return { ok: false, error: 'job.promptTemplate required' };
  }
  if (utf8Bytes(doc.job.promptTemplate) > PACK_PROMPT_MAX_BYTES) {
    return { ok: false, error: `job.promptTemplate exceeds ${PACK_PROMPT_MAX_BYTES} bytes` };
  }

  const job: SchedulePackJob = {
    cadence: cadence.cadence,
    promptTemplate: doc.job.promptTemplate,
  };

  if (doc.job.steer !== undefined) {
    if (typeof doc.job.steer !== 'string') return { ok: false, error: 'job.steer must be a string' };
    if (utf8Bytes(doc.job.steer) > PACK_PROMPT_MAX_BYTES) {
      return { ok: false, error: `job.steer exceeds ${PACK_PROMPT_MAX_BYTES} bytes` };
    }
    job.steer = doc.job.steer;
  }
  if (doc.job.workdir !== undefined) {
    if (doc.job.workdir !== 'shared' && doc.job.workdir !== 'worktree') {
      return { ok: false, error: 'job.workdir must be shared or worktree' };
    }
    job.workdir = doc.job.workdir;
  }
  if (doc.job.overlapPolicy !== undefined) {
    if (doc.job.overlapPolicy !== 'skip' && doc.job.overlapPolicy !== 'queue_one' && doc.job.overlapPolicy !== 'catch_up') {
      return { ok: false, error: 'job.overlapPolicy invalid' };
    }
    job.overlapPolicy = doc.job.overlapPolicy;
  }
  if (doc.job.executionMode !== undefined) {
    if (doc.job.executionMode !== 'spawn_child' && doc.job.executionMode !== 'resume_conversation') {
      return { ok: false, error: 'job.executionMode invalid' };
    }
    job.executionMode = doc.job.executionMode;
  }
  if (doc.job.runTimeoutMs !== undefined) {
    if (typeof doc.job.runTimeoutMs !== 'number' || !Number.isFinite(doc.job.runTimeoutMs) || doc.job.runTimeoutMs <= 0) {
      return { ok: false, error: 'job.runTimeoutMs must be a positive number' };
    }
    job.runTimeoutMs = doc.job.runTimeoutMs;
  }
  if (doc.job.agentMayComplete !== undefined) {
    if (typeof doc.job.agentMayComplete !== 'boolean') {
      return { ok: false, error: 'job.agentMayComplete must be a boolean' };
    }
    job.agentMayComplete = doc.job.agentMayComplete;
  }

  const steps = parseSteps(doc.job.steps);
  if (!steps.ok) return steps;
  if (steps.steps) job.steps = steps.steps;

  if (doc.job.variables !== undefined) {
    const parsedVars = parseScheduleVariables(doc.job.variables);
    if (!parsedVars.ok) return { ok: false, error: `job.variables: ${parsedVars.error}` };
    if (parsedVars.value) job.variables = parsedVars.value;
  }

  const pack: SchedulePack = {
    slug: doc.slug,
    title: doc.title.trim(),
    description: typeof doc.description === 'string' ? doc.description : '',
    version: typeof doc.version === 'number' && Number.isFinite(doc.version) ? doc.version : 1,
    origin: 'imported',
    job,
  };

  if (doc.requiresTemplate !== undefined) {
    if (typeof doc.requiresTemplate !== 'boolean') return { ok: false, error: 'requiresTemplate must be a boolean' };
    pack.requiresTemplate = doc.requiresTemplate;
  }
  if (doc.profileAgentHint !== undefined) {
    if (typeof doc.profileAgentHint !== 'string') return { ok: false, error: 'profileAgentHint must be a string' };
    pack.profileAgentHint = doc.profileAgentHint;
  }

  const fields = parseApplyFields(doc.applyFields);
  if (!fields.ok) return fields;
  if (fields.fields) pack.applyFields = fields.fields;

  const reqStages = parseRequiredStages(doc.requiredStages);
  if (!reqStages.ok) return reqStages;
  if (reqStages.stages) pack.requiredStages = reqStages.stages;

  const files = parseFiles(doc.files);
  if (!files.ok) return files;
  if (files.files) pack.files = files.files;

  return { ok: true, pack };
}
