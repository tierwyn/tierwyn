import { PIPELINE_MAX_STAGES, STAGE_ID_RE } from '@tierwyn/shared';

/** Extract unique, sorted role names across templates */
export function getUnionTemplateRoles(
  templates: Array<{ roles?: Array<{ role: string }> }>,
): string[] {
  const set = new Set<string>();
  for (const t of templates) {
    for (const r of t.roles ?? []) {
      const trimmed = r.role.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// Variables map helpers (for ScheduleBrowser / variables tab operations)

/** Move stage in variables map */
export function moveStageInVars(
  vars: Record<string, string>,
  index: number,
  direction: 'up' | 'down',
): Record<string, string> {
  const raw = (vars.stages ?? '').trim();
  const stages = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (index < 0 || index >= stages.length) return { ...vars };
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= stages.length) return { ...vars };

  const next = [...stages];
  const item = next[index];
  next[index] = next[targetIndex];
  next[targetIndex] = item;

  return {
    ...vars,
    stages: next.join(','),
  };
}

/** Add stage to variables map */
export function addStageToVars(
  vars: Record<string, string>,
  id: string,
  role?: string,
  fn?: string,
): Record<string, string> {
  const raw = (vars.stages ?? '').trim();
  const stages = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (stages.length >= PIPELINE_MAX_STAGES || stages.includes(id)) {
    return { ...vars };
  }

  const next = [...stages, id];
  const res: Record<string, string> = {
    ...vars,
    stages: next.join(','),
  };
  if (role !== undefined) res[`${id}Role`] = role;
  if (fn !== undefined) res[`${id}Function`] = fn;
  return res;
}

/** Remove stage from variables map */
export function removeStageFromVars(
  vars: Record<string, string>,
  id: string,
): Record<string, string> {
  const raw = (vars.stages ?? '').trim();
  const stages = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const nextStages = stages.filter((s) => s !== id);

  const res: Record<string, string> = { ...vars };
  if (nextStages.length > 0) {
    res.stages = nextStages.join(',');
  } else {
    delete res.stages;
  }
  delete res[`${id}Role`];
  delete res[`${id}Function`];
  return res;
}

/** Update stage in variables map */
export function updateStageInVars(
  vars: Record<string, string>,
  id: string,
  patch: { role?: string; fn?: string },
): Record<string, string> {
  const res: Record<string, string> = { ...vars };
  if (patch.role !== undefined) {
    if (patch.role === '') {
      delete res[`${id}Role`];
    } else {
      res[`${id}Role`] = patch.role;
    }
  }
  if (patch.fn !== undefined) {
    if (patch.fn === '') {
      delete res[`${id}Function`];
    } else {
      res[`${id}Function`] = patch.fn;
    }
  }
  return res;
}

/** Set commitOnTick in variables map */
export function setCommitOnTickInVars(
  vars: Record<string, string>,
  commit: boolean,
): Record<string, string> {
  return {
    ...vars,
    commitOnTick: String(commit),
  };
}

/**
 * Committed stage ids from the variables map. Empty/missing → [] (no default
 * plan/implement/review rows — the editor shows an empty state instead).
 */
export function listStageIdsFromVars(vars: Record<string, string>): string[] {
  const raw = (vars.stages ?? '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export type RenameStageResult =
  | { ok: true; vars: Record<string, string> }
  | { ok: false; reason: 'invalid' | 'duplicate' | 'unchanged' | 'missing' };

/**
 * Rename a stage id in the variables map. Validates format, uniqueness, and
 * that oldId is present. Moves `<id>Role` / `<id>Function` with the id.
 * Never mutates `vars`.
 */
export function renameStageInVars(
  vars: Record<string, string>,
  oldId: string,
  newId: string,
): RenameStageResult {
  const trimmed = newId.trim().toLowerCase();
  if (!STAGE_ID_RE.test(trimmed)) return { ok: false, reason: 'invalid' };
  if (trimmed === oldId) return { ok: false, reason: 'unchanged' };

  const stages = listStageIdsFromVars(vars);
  if (!stages.includes(oldId)) return { ok: false, reason: 'missing' };
  if (stages.includes(trimmed)) return { ok: false, reason: 'duplicate' };

  const nextStages = stages.map((s) => (s === oldId ? trimmed : s));
  const nextVars: Record<string, string> = { ...vars, stages: nextStages.join(',') };
  if (nextVars[`${oldId}Role`] !== undefined) {
    nextVars[`${trimmed}Role`] = nextVars[`${oldId}Role`]!;
    delete nextVars[`${oldId}Role`];
  }
  if (nextVars[`${oldId}Function`] !== undefined) {
    nextVars[`${trimmed}Function`] = nextVars[`${oldId}Function`]!;
    delete nextVars[`${oldId}Function`];
  }
  return { ok: true, vars: nextVars };
}
