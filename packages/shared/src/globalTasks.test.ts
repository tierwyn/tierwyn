import { describe, it, expect } from 'vitest';
import { isTaskStale, sanitiseGlobalTasksSettings, globalTasksAllowed, GLOBAL_TASKS_DEFAULTS, GLOBAL_TASK_LIMITS } from './globalTasks.js';

const H = 3_600_000;
describe('isTaskStale', () => {
  it('in_progress older than threshold is stale', () => {
    expect(isTaskStale({ status: 'in_progress', updatedAt: 0 }, 49 * H, 48)).toBe(true);
    expect(isTaskStale({ status: 'in_progress', updatedAt: 0 }, 47 * H, 48)).toBe(false);
  });
  it('completed is never stale; 0 hours disables', () => {
    expect(isTaskStale({ status: 'completed', updatedAt: 0 }, 1000 * H, 48)).toBe(false);
    expect(isTaskStale({ status: 'in_progress', updatedAt: 0 }, 1000 * H, 0)).toBe(false);
  });
});
describe('sanitiseGlobalTasksSettings', () => {
  it('defaults on garbage', () => {
    expect(sanitiseGlobalTasksSettings(null)).toEqual(GLOBAL_TASKS_DEFAULTS);
    expect(sanitiseGlobalTasksSettings({ enabled: 'yes', scope: 'x', staleAfterHours: -1, autoDeleteHiddenAfterDays: 'z' }))
      .toEqual(GLOBAL_TASKS_DEFAULTS);
  });
  it('keeps valid values, floors and clamps numbers', () => {
    expect(sanitiseGlobalTasksSettings({ enabled: false, scope: 'all', staleAfterHours: 12.7, autoDeleteHiddenAfterDays: 99999 }))
      .toEqual({ enabled: false, scope: 'all', staleAfterHours: 12, autoDeleteHiddenAfterDays: 3650 });
  });
  it('defaults are on/roots/48/30', () => {
    expect(GLOBAL_TASKS_DEFAULTS).toEqual({ enabled: true, scope: 'roots', staleAfterHours: 48, autoDeleteHiddenAfterDays: 30 });
    expect(GLOBAL_TASK_LIMITS).toEqual({ title: 200, text: 4000, openPerConversation: 3, listMax: 500 });
  });
});
describe('globalTasksAllowed', () => {
  it('off blocks everyone; roots blocks children; all allows children', () => {
    expect(globalTasksAllowed({ enabled: false, scope: 'all' }, true)).toBe(false);
    expect(globalTasksAllowed({ enabled: true, scope: 'roots' }, true)).toBe(true);
    expect(globalTasksAllowed({ enabled: true, scope: 'roots' }, false)).toBe(false);
    expect(globalTasksAllowed({ enabled: true, scope: 'all' }, false)).toBe(true);
  });
});
