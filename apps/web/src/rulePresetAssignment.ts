import type { Project } from '@tierwyn/shared';
import { RULE_PRESETS_MAX_PER_LAYER } from '@tierwyn/shared';

export type ProjectPresetRef = Pick<Project, 'id' | 'name' | 'rulePresetIds'>;

export type ProjectAssignmentPatch = {
  projectId: string;
  rulePresetIds: string[] | null;
};

export function projectHasPreset(project: Pick<Project, 'rulePresetIds'>, presetId: string): boolean {
  return (project.rulePresetIds ?? []).includes(presetId);
}

export function assignedProjectIds(projects: ProjectPresetRef[], presetId: string): string[] {
  return projects.filter((p) => projectHasPreset(p, presetId)).map((p) => p.id);
}

export function appendPresetId(
  current: string[] | undefined,
  presetId: string,
): { ok: true; ids: string[] } | { ok: false; error: 'at_cap' } {
  const ids = current ?? [];
  if (ids.includes(presetId)) return { ok: true, ids: [...ids] };
  if (ids.length >= RULE_PRESETS_MAX_PER_LAYER) return { ok: false, error: 'at_cap' };
  return { ok: true, ids: [...ids, presetId] };
}

export function removePresetId(current: string[] | undefined, presetId: string): string[] {
  return (current ?? []).filter((id) => id !== presetId);
}

/** Diff wanted folder-level attachments against current project stacks. */
export function planProjectAssignments(
  projects: ProjectPresetRef[],
  presetId: string,
  selectedProjectIds: string[],
): { ok: true; patches: ProjectAssignmentPatch[] } | { ok: false; error: string } {
  const selected = new Set(selectedProjectIds);
  const patches: ProjectAssignmentPatch[] = [];
  const capped: string[] = [];
  for (const p of projects) {
    const has = projectHasPreset(p, presetId);
    const want = selected.has(p.id);
    if (has === want) continue;
    if (want) {
      const next = appendPresetId(p.rulePresetIds, presetId);
      if (!next.ok) {
        capped.push(p.name);
        continue;
      }
      patches.push({ projectId: p.id, rulePresetIds: next.ids });
    } else {
      const next = removePresetId(p.rulePresetIds, presetId);
      patches.push({ projectId: p.id, rulePresetIds: next.length ? next : null });
    }
  }
  if (capped.length) {
    const verb = capped.length === 1 ? 'has' : 'have';
    return {
      ok: false,
      error: `${capped.join(', ')} already ${verb} ${RULE_PRESETS_MAX_PER_LAYER} presets at the project layer`,
    };
  }
  return { ok: true, patches };
}
