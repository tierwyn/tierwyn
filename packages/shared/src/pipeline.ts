import type { SpawnTemplateRole } from './domain.js';

export const STAGE_ID_RE = /^[a-z][a-z0-9]{0,23}$/;
export const PIPELINE_MAX_STAGES = 8;

export const DEFAULT_ROLE_MATCH_KEYWORDS: Record<string, string[]> = {
  plan: ['plan', 'planner', 'specs', 'specification', 'architect'],
  implement: ['implement', 'implementer', 'code', 'builder', 'developer'],
  review: ['review', 'reviewer', 'adversary', 'audit', 'test'],
};
export const ROLE_MATCH_MAX_STAGES = 16;
export const ROLE_MATCH_MAX_KEYWORDS = 16;
export const ROLE_MATCH_KEYWORD_RE = /^[a-z0-9][a-z0-9 -]{0,31}$/;

const OPT_OUT_RE = /\b(specifically|disabled for automatic)\b/i;
const FORBIDDEN_STAGE_KEYS = new Set(['constructor', 'prototype']);

export const BUILTIN_STAGE_FUNCTIONS: Record<string, string> = {
  plan: 'Write a plan file under the repo plans directory for the selected row. Skip this stage when the row is simple (risk low, <=2 files, 1 subsystem, no migration/shared-type/protocol change).',
  implement: 'Implement the selected row against the plan file (or the roster row scope). Run the row verify commands.',
  review: 'Adversarially review the uncommitted diff. Report file:line findings and end with VERDICT: SHIP | SHIP-AFTER-FIX: ... | BLOCK: ...',
  test: 'Write or extend tests for the change, then run them.',
};

export interface ResolvedStage {
  id: string;
  role: string | null;
  fn: string;
  skipped: boolean;
}

/**
 * Parse a comma-separated list of stage IDs.
 * Rules: 1–8 stages, trimmed, unique, matching STAGE_ID_RE.
 */
export function parseStages(csv: string | undefined): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (csv === undefined || csv.trim() === '') {
    return { ok: false, error: 'stages must be a non-empty comma-separated list' };
  }
  const rawParts = csv.split(',');
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const part of rawParts) {
    const trimmed = part.trim();
    if (trimmed === '') {
      return { ok: false, error: 'empty stage id in stages list' };
    }
    if (!STAGE_ID_RE.test(trimmed)) {
      return {
        ok: false,
        error: `invalid stage id "${trimmed}" (must match ^[a-z][a-z0-9]{0,23}$)`,
      };
    }
    if (seen.has(trimmed)) {
      return { ok: false, error: `duplicate stage id "${trimmed}" in stages list` };
    }
    seen.add(trimmed);
    ids.push(trimmed);
  }

  if (ids.length > PIPELINE_MAX_STAGES) {
    return {
      ok: false,
      error: `too many stages (got ${ids.length}, max ${PIPELINE_MAX_STAGES})`,
    };
  }

  return { ok: true, ids };
}

/**
 * Resolve stage definitions and commit behaviour from job variables.
 * Default stages: 'plan,implement,review' if missing from vars.
 */
export function resolveStages(
  vars: Record<string, string>,
): { ok: true; stages: ResolvedStage[]; commit: boolean } | { ok: false; error: string } {
  const rawStages = vars.stages !== undefined && vars.stages.trim() !== ''
    ? vars.stages
    : 'plan,implement,review';

  const parsed = parseStages(rawStages);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  // Parse commitOnTick: absent/undefined or 'true' -> true; 'false' -> false; others -> error.
  let commit = true;
  if (vars.commitOnTick !== undefined) {
    const val = vars.commitOnTick.trim();
    if (val === 'false') {
      commit = false;
    } else if (val === 'true') {
      commit = true;
    } else {
      return { ok: false, error: 'commitOnTick must be "true" or "false"' };
    }
  }

  const stages: ResolvedStage[] = [];
  for (const id of parsed.ids) {
    const rawRole = vars[`${id}Role`];
    const roleTrimmed = rawRole !== undefined ? rawRole.trim() : '';
    const isSkipped = roleTrimmed === '' || roleTrimmed.toLowerCase() === 'none';

    const rawFn = vars[`${id}Function`];
    const fnTrimmed = rawFn !== undefined ? rawFn.trim() : '';
    let fn = fnTrimmed;
    if (fn === '') {
      fn = Object.hasOwn(BUILTIN_STAGE_FUNCTIONS, id)
        ? BUILTIN_STAGE_FUNCTIONS[id]!
        : '(no function set)';
    }

    stages.push({
      id,
      role: isSkipped ? null : roleTrimmed,
      fn,
      skipped: isSkipped,
    });
  }

  return { ok: true, stages, commit };
}

/** Collapse CR/LF and escape pipes so a cell cannot forge extra markdown-table rows. */
function sanitiseTableCell(s: string): string {
  return s.replace(/\r\n|\n|\r/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Render markdown section for {{pipeline}} substitution. Never throws.
 */
export function renderPipelineSection(vars: Record<string, string>): string {
  try {
    const res = resolveStages(vars);
    if (!res.ok) {
      return `Pipeline: not configured (${res.error})`;
    }

    const rows = res.stages.map((stage, idx) => {
      const num = idx + 1;
      const roleCol = sanitiseTableCell(stage.skipped ? '— skipped (role none)' : stage.role!);
      const fnCol = sanitiseTableCell(stage.skipped ? '—' : stage.fn);
      return `| ${num} | ${stage.id} | ${roleCol} | ${fnCol} |`;
    });

    const commitLine = res.commit
      ? 'Commit on tick: **yes** — after the last stage passes, commit once (`type(scope): subject`, exact paths).'
      : 'Commit on tick: **no** — do NOT commit; leave changes in the working tree and list them in your summary.';

    return [
      '## Pipeline Stages & Role Functions',
      '',
      'Run these stages **in order** for the selected roster row, each as one `POST /spawn` child',
      '(async + notify; your turn resumes when the child reports). Skipped stages are listed so you do not invent them.',
      '',
      '| # | stage | role (spawn this exact roster name) | function |',
      '|---|---|---|---|',
      ...rows,
      '',
      commitLine,
    ].join('\n');
  } catch (err) {
    return `Pipeline: not configured (${err instanceof Error ? err.message : String(err)})`;
  }
}

function escapeRegExp(k: string): string {
  return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordsForStage(stage: string, customKeywords?: Record<string, string[]>): string[] {
  const custom = customKeywords && Object.hasOwn(customKeywords, stage) ? customKeywords[stage] : undefined;
  const fromDefault = Object.hasOwn(DEFAULT_ROLE_MATCH_KEYWORDS, stage)
    ? DEFAULT_ROLE_MATCH_KEYWORDS[stage]
    : undefined;
  const kw = custom ?? fromDefault ?? [stage];
  return kw.length === 0 ? [stage] : kw;
}

function hit(text: string, kw: string[]): boolean {
  if (!text) return false;
  return kw.some((k) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(k)}`, 'i').test(text));
}

function scoreDelegate(
  stageKw: string[],
  delegate: Pick<SpawnTemplateRole, 'role' | 'when'>,
): number | null {
  const when = delegate.when ?? '';
  if (OPT_OUT_RE.test(when)) return null;
  const whenHit = hit(when, stageKw);
  const roleHit = hit(delegate.role, stageKw);
  if (!whenHit && !roleHit) return null;
  let score = (whenHit ? 50 : 0) + (roleHit ? 20 : 0);
  if (/\bsecondary\b/i.test(when)) score -= 20;
  else if (/\bprimary\b/i.test(when)) score += 50;
  return score;
}

/**
 * Pick the best template delegate for each stage by scoring `when` text (then role name).
 * Unmatched stages are omitted. Ties go to the first template role.
 */
export function autoMatchStageRoles(
  stages: string[],
  templateRoles: Pick<SpawnTemplateRole, 'role' | 'when'>[],
  customKeywords?: Record<string, string[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const stage of stages) {
    const kw = keywordsForStage(stage, customKeywords);
    let bestRole: string | undefined;
    let bestScore = 0;
    for (const delegate of templateRoles) {
      const role = delegate.role.trim();
      if (!role) continue;
      const score = scoreDelegate(kw, delegate);
      if (score === null || score <= 0) continue;
      if (score > bestScore) {
        bestScore = score;
        bestRole = role;
      }
    }
    if (bestRole !== undefined) out[stage] = bestRole;
  }
  return out;
}

/** Fill blank `<stage>Role` vars from the template. Explicit values (incl. `none`) are never touched. */
export function fillStageRoles(
  vars: Record<string, string>,
  templateRoles: Pick<SpawnTemplateRole, 'role' | 'when'>[],
  customKeywords?: Record<string, string[]>,
): { vars: Record<string, string>; notes: string[] } {
  const rawStages = vars.stages !== undefined && vars.stages.trim() !== ''
    ? vars.stages
    : 'plan,implement,review';
  const parsed = parseStages(rawStages);
  if (!parsed.ok) return { vars, notes: [] };

  const matched = autoMatchStageRoles(parsed.ids, templateRoles, customKeywords);
  const next: Record<string, string> = { ...vars };
  const notes: string[] = [];
  for (const id of parsed.ids) {
    const current = vars[`${id}Role`];
    if (current !== undefined && current.trim() !== '') continue;
    const role = matched[id];
    if (role) {
      next[`${id}Role`] = role;
      notes.push(`stage '${id}' → '${role}' (auto-matched)`);
    } else {
      next[`${id}Role`] = 'none';
      notes.push(`stage '${id}' skipped: no template delegate matched`);
    }
  }
  return { vars: next, notes };
}

/** Trim + lowercase + dedupe keywords; validate shape. */
export function sanitiseRoleMatchKeywords(v: unknown):
  | { ok: true; value: Record<string, string[]> }
  | { ok: false; error: string } {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: 'roleMatchKeywords must be a JSON object' };
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > ROLE_MATCH_MAX_STAGES) {
    return { ok: false, error: `roleMatchKeywords: at most ${ROLE_MATCH_MAX_STAGES} stages` };
  }
  const value: Record<string, string[]> = {};
  for (const key of keys) {
    if (FORBIDDEN_STAGE_KEYS.has(key) || !STAGE_ID_RE.test(key)) {
      return { ok: false, error: `roleMatchKeywords: invalid stage id "${key}"` };
    }
    const raw = obj[key];
    if (!Array.isArray(raw)) {
      return { ok: false, error: `roleMatchKeywords.${key} must be an array of strings` };
    }
    const seen = new Set<string>();
    const kws: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') {
        return { ok: false, error: `roleMatchKeywords.${key} must be an array of strings` };
      }
      const kw = item.trim().toLowerCase();
      if (kw === '') continue;
      if (!ROLE_MATCH_KEYWORD_RE.test(kw)) {
        return { ok: false, error: `roleMatchKeywords.${key}: invalid keyword "${item}"` };
      }
      if (seen.has(kw)) continue;
      seen.add(kw);
      kws.push(kw);
    }
    if (kws.length > ROLE_MATCH_MAX_KEYWORDS) {
      return { ok: false, error: `roleMatchKeywords.${key}: at most ${ROLE_MATCH_MAX_KEYWORDS} keywords` };
    }
    value[key] = kws;
  }
  return { ok: true, value };
}

/**
 * Apply-time check of pipeline roles against template roles.
 * Exact case-sensitive matching.
 * - Required stages: must exist in template and not be skipped/empty/none.
 * - Optional stages: if role is missing in template, role becomes 'none' and note is added.
 */
export function checkPipelineRoles(
  vars: Record<string, string>,
  templateRoles: string[],
  required: string[],
): { ok: true; vars: Record<string, string>; notes: string[] } | { ok: false; error: string } {
  const rawStages = vars.stages !== undefined && vars.stages.trim() !== ''
    ? vars.stages
    : 'plan,implement,review';

  const parsed = parseStages(rawStages);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const roleSet = new Set(templateRoles);
  const nextVars: Record<string, string> = { ...vars };
  const notes: string[] = [];

  // Check required stages first
  for (const reqId of required) {
    if (!parsed.ids.includes(reqId)) {
      return {
        ok: false,
        error: `pipeline: required stage '${reqId}' not in stages list (${rawStages})`,
      };
    }
    const role = (vars[`${reqId}Role`] ?? '').trim();
    if (role === '' || role.toLowerCase() === 'none') {
      return {
        ok: false,
        error: `pipeline: required stage '${reqId}' is skipped (role none or empty)`,
      };
    }
    if (!roleSet.has(role)) {
      return {
        ok: false,
        error: `pipeline: required stage '${reqId}' role '${role}' not in template roles`,
      };
    }
  }

  // Check optional stages
  for (const id of parsed.ids) {
    if (required.includes(id)) continue;
    const role = (vars[`${id}Role`] ?? '').trim();
    if (role === '' || role.toLowerCase() === 'none') {
      continue;
    }
    if (!roleSet.has(role)) {
      nextVars[`${id}Role`] = 'none';
      notes.push(`stage '${id}' skipped at apply: role '${role}' not in template`);
    }
  }

  return { ok: true, vars: nextVars, notes };
}
