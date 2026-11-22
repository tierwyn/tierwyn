import { describe, it, expect } from 'vitest';
import { RULE_PRESETS_MAX_PER_LAYER } from '@tierwyn/shared';
import {
  appendPresetId,
  assignedProjectIds,
  planProjectAssignments,
  projectHasPreset,
  removePresetId,
} from './rulePresetAssignment.js';

const p = (id: string, name: string, rulePresetIds?: string[]) => ({ id, name, rulePresetIds });

describe('projectHasPreset', () => {
  it('is false when the stack is missing or empty', () => {
    expect(projectHasPreset({}, 'a')).toBe(false);
    expect(projectHasPreset({ rulePresetIds: [] }, 'a')).toBe(false);
  });

  it('is true only for an exact id match', () => {
    expect(projectHasPreset({ rulePresetIds: ['a', 'b'] }, 'b')).toBe(true);
    expect(projectHasPreset({ rulePresetIds: ['a'] }, 'b')).toBe(false);
  });
});

describe('assignedProjectIds', () => {
  it('returns ids of projects that currently attach the preset', () => {
    expect(assignedProjectIds([
      p('1', 'A', ['x']),
      p('2', 'B'),
      p('3', 'C', ['y', 'x']),
    ], 'x')).toEqual(['1', '3']);
  });
});

describe('appendPresetId', () => {
  it('appends when under the cap and skips duplicates', () => {
    expect(appendPresetId(['a'], 'b')).toEqual({ ok: true, ids: ['a', 'b'] });
    expect(appendPresetId(['a'], 'a')).toEqual({ ok: true, ids: ['a'] });
    expect(appendPresetId(undefined, 'a')).toEqual({ ok: true, ids: ['a'] });
  });

  it('refuses a ninth distinct preset', () => {
    const eight = Array.from({ length: RULE_PRESETS_MAX_PER_LAYER }, (_, i) => `p${i}`);
    expect(appendPresetId(eight, 'p-new')).toEqual({ ok: false, error: 'at_cap' });
    expect(appendPresetId(eight, 'p0')).toEqual({ ok: true, ids: eight });
  });
});

describe('removePresetId', () => {
  it('drops the id and leaves others', () => {
    expect(removePresetId(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(removePresetId(['a'], 'a')).toEqual([]);
    expect(removePresetId(undefined, 'a')).toEqual([]);
  });
});

describe('planProjectAssignments', () => {
  it('adds to newly selected projects and removes from unselected ones', () => {
    const projects = [
      p('1', 'Keep', ['x']),
      p('2', 'Drop', ['x', 'other']),
      p('3', 'Add', ['other']),
      p('4', 'Skip'),
    ];
    expect(planProjectAssignments(projects, 'x', ['1', '3'])).toEqual({
      ok: true,
      patches: [
        { projectId: '2', rulePresetIds: ['other'] },
        { projectId: '3', rulePresetIds: ['other', 'x'] },
      ],
    });
  });

  it('serialises an emptied stack as null', () => {
    expect(planProjectAssignments([p('1', 'A', ['x'])], 'x', [])).toEqual({
      ok: true,
      patches: [{ projectId: '1', rulePresetIds: null }],
    });
  });

  it('is a no-op when the selection already matches', () => {
    const projects = [p('1', 'A', ['x']), p('2', 'B')];
    expect(planProjectAssignments(projects, 'x', ['1'])).toEqual({ ok: true, patches: [] });
  });

  it('errors when a newly selected project is already at the layer cap', () => {
    const eight = Array.from({ length: RULE_PRESETS_MAX_PER_LAYER }, (_, i) => `p${i}`);
    const projects = [p('1', 'Tierwyn', eight), p('2', 'Demo', eight)];
    expect(planProjectAssignments(projects, 'new', ['1', '2'])).toEqual({
      ok: false,
      error: `Tierwyn, Demo already have ${RULE_PRESETS_MAX_PER_LAYER} presets at the project layer`,
    });
  });

  it('allows a full project that already has this preset', () => {
    const eight = Array.from({ length: RULE_PRESETS_MAX_PER_LAYER }, (_, i) => `p${i}`);
    const projects = [p('1', 'Tierwyn', eight)];
    expect(planProjectAssignments(projects, 'p0', ['1'])).toEqual({ ok: true, patches: [] });
  });

  it('only considers the projects passed in (project-specific checkbox)', () => {
    const projects = [p('target', 'Target'), p('other', 'Other', ['x'])];
    expect(planProjectAssignments([projects[0]!], 'x', [])).toEqual({ ok: true, patches: [] });
    expect(planProjectAssignments([projects[0]!], 'x', ['target'])).toEqual({
      ok: true,
      patches: [{ projectId: 'target', rulePresetIds: ['x'] }],
    });
  });
});
