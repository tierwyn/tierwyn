import { describe, it, expect } from 'vitest';
import {
  getUnionTemplateRoles,
  moveStageInVars,
  addStageToVars,
  removeStageFromVars,
  updateStageInVars,
  setCommitOnTickInVars,
  renameStageInVars,
  listStageIdsFromVars,
} from './pipelineVars.js';

describe('pipelineVars', () => {
  describe('getUnionTemplateRoles', () => {
    it('extracts unique, sorted role names', () => {
      const templates = [
        {
          roles: [
            { role: 'Planner' },
            { role: 'Implementer' },
            { role: '   ' },
          ],
        },
        {
          roles: [
            { role: 'Reviewer' },
            { role: 'Planner' },
          ],
        },
      ];
      expect(getUnionTemplateRoles(templates)).toEqual(['Implementer', 'Planner', 'Reviewer']);
    });
  });

  describe('variables map helpers', () => {
    it('moves stage in vars map', () => {
      const vars = { stages: 'plan,implement,review' };
      const moved = moveStageInVars(vars, 0, 'down');
      expect(moved.stages).toBe('implement,plan,review');
    });

    it('adds stage to vars map', () => {
      const vars = { stages: 'plan,implement' };
      const next = addStageToVars(vars, 'test', 'Tester', 'run tests');
      expect(next.stages).toBe('plan,implement,test');
      expect(next.testRole).toBe('Tester');
      expect(next.testFunction).toBe('run tests');
    });

    it('removes stage from vars map', () => {
      const vars = {
        stages: 'plan,implement,review',
        implementRole: 'Dev',
        implementFunction: 'write code',
      };
      const next = removeStageFromVars(vars, 'implement');
      expect(next.stages).toBe('plan,review');
      expect(next.implementRole).toBeUndefined();
      expect(next.implementFunction).toBeUndefined();
    });

    it('updates stage in vars map', () => {
      const vars = { stages: 'plan', planRole: 'Old' };
      const next = updateStageInVars(vars, 'plan', { role: 'New' });
      expect(next.planRole).toBe('New');
    });

    it('sets commitOnTick in vars map', () => {
      expect(setCommitOnTickInVars({}, true)).toEqual({ commitOnTick: 'true' });
      expect(setCommitOnTickInVars({}, false)).toEqual({ commitOnTick: 'false' });
    });
  });

  describe('listStageIdsFromVars', () => {
    it('returns [] when stages is missing or blank (no default phantom rows)', () => {
      expect(listStageIdsFromVars({})).toEqual([]);
      expect(listStageIdsFromVars({ stages: '' })).toEqual([]);
      expect(listStageIdsFromVars({ stages: '   ' })).toEqual([]);
    });

    it('splits committed stage ids without mutating them', () => {
      expect(listStageIdsFromVars({ stages: 'plan,implement,review' })).toEqual([
        'plan',
        'implement',
        'review',
      ]);
    });
  });

  describe('renameStageInVars', () => {
    const vars = {
      stages: 'plan,implement,review',
      planRole: 'Planner',
      planFunction: 'write the plan',
      implementRole: 'Dev',
    };

    it('renames id and moves Role/Function keys', () => {
      const result = renameStageInVars(vars, 'plan', 'scope');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.vars.stages).toBe('scope,implement,review');
      expect(result.vars.scopeRole).toBe('Planner');
      expect(result.vars.scopeFunction).toBe('write the plan');
      expect(result.vars.planRole).toBeUndefined();
      expect(result.vars.planFunction).toBeUndefined();
      expect(result.vars.implementRole).toBe('Dev');
    });

    it('rejects invalid ids without mutating vars', () => {
      const result = renameStageInVars(vars, 'plan', 'Plan!');
      expect(result).toEqual({ ok: false, reason: 'invalid' });
      expect(vars.stages).toBe('plan,implement,review');
    });

    it('rejects duplicate ids so another stage is not overwritten', () => {
      const result = renameStageInVars(vars, 'plan', 'implement');
      expect(result).toEqual({ ok: false, reason: 'duplicate' });
    });

    it('treats same id after trim/lowercase as unchanged', () => {
      expect(renameStageInVars(vars, 'plan', '  PLAN  ')).toEqual({
        ok: false,
        reason: 'unchanged',
      });
    });

    it('rejects empty and too-long ids', () => {
      expect(renameStageInVars(vars, 'plan', '')).toEqual({ ok: false, reason: 'invalid' });
      expect(renameStageInVars(vars, 'plan', 'a'.repeat(25))).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });
  });
});
