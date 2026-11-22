import { describe, expect, it } from 'vitest';
import type { Conversation, ScheduleJob, ScheduleRun } from '@tierwyn/shared';
import type { ScheduleTreeResponse } from './api.js';
import {
  shouldApplyRequestedMainTab,
  shouldAttemptSidebarReveal,
  shouldFollowSelectionToSchedules,
  shouldSyncScheduleTabForSelection,
  shouldSyncSidebarTabOnSelect,
  projectsTabRestoreIds,
  visibleOnProjectsTab,
  scheduleConversationIds,
  scheduleConversationIdsForJobs,
} from './sidebarTabs.js';

function conv(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
    projectId: 'p',
    title: partial.title ?? partial.id,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('shouldApplyRequestedMainTab', () => {
  it('applies a new tick once', () => {
    expect(shouldApplyRequestedMainTab(0, { tab: 'projects', tick: 100 })).toBe(true);
  });

  it('does not re-apply the same tick (setter identity churn)', () => {
    expect(shouldApplyRequestedMainTab(100, { tab: 'projects', tick: 100 })).toBe(false);
  });

  it('applies a later tick even if the tab string is unchanged', () => {
    expect(shouldApplyRequestedMainTab(100, { tab: 'projects', tick: 101 })).toBe(true);
  });

  it('ignores a missing or zero-tick request', () => {
    expect(shouldApplyRequestedMainTab(0, null)).toBe(false);
    expect(shouldApplyRequestedMainTab(0, { tab: 'schedules', tick: 0 })).toBe(false);
  });
});

describe('shouldAttemptSidebarReveal', () => {
  it('runs for a new Active Agents jump tick', () => {
    expect(shouldAttemptSidebarReveal(0, 1)).toBe(true);
  });

  it('does not re-scroll or re-expand after the jump already landed (folder collapse/expand)', () => {
    expect(shouldAttemptSidebarReveal(3, 3)).toBe(false);
  });

  it('runs again when a subsequent indirect activation arrives with a higher tick', () => {
    expect(shouldAttemptSidebarReveal(3, 4)).toBe(true);
  });

  it('ignores idle / unset ticks', () => {
    expect(shouldAttemptSidebarReveal(0, 0)).toBe(false);
    expect(shouldAttemptSidebarReveal(0, undefined)).toBe(false);
  });
});

describe('shouldFollowSelectionToSchedules', () => {
  it('follows a newly selected schedule conversation onto Schedules', () => {
    expect(shouldFollowSelectionToSchedules(null, 'run-1', true, 'projects')).toBe(true);
  });

  it('does not fight an explicit Projects tap while the same schedule conv stays selected', () => {
    expect(shouldFollowSelectionToSchedules('run-1', 'run-1', true, 'projects')).toBe(false);
  });

  it('does not run for a project conversation', () => {
    expect(shouldFollowSelectionToSchedules(null, 'chat-1', false, 'projects')).toBe(false);
  });
});

describe('shouldSyncScheduleTabForSelection', () => {
  it('syncs when a schedule-tree row is selected but the tab is still Projects', () => {
    expect(shouldSyncScheduleTabForSelection('run-1', true, 'projects', false)).toBe(true);
  });

  it('does not fight an explicit Projects tab tap', () => {
    expect(shouldSyncScheduleTabForSelection('run-1', true, 'projects', true)).toBe(false);
  });

  it('is a no-op when already on Schedules or the row is not schedule-tree', () => {
    expect(shouldSyncScheduleTabForSelection('run-1', true, 'schedules', false)).toBe(false);
    expect(shouldSyncScheduleTabForSelection('chat-1', false, 'projects', false)).toBe(false);
  });
});

describe('shouldSyncSidebarTabOnSelect', () => {
  it('syncs by default (user clicked a conversation)', () => {
    expect(shouldSyncSidebarTabOnSelect()).toBe(true);
    expect(shouldSyncSidebarTabOnSelect({})).toBe(true);
  });

  it('does not sync for tab-switch restore', () => {
    expect(shouldSyncSidebarTabOnSelect({ syncSidebarTab: false })).toBe(false);
  });
});

describe('projectsTabRestoreIds', () => {
  it('uses only lastProjects* keys, not lastConversationId', () => {
    expect(projectsTabRestoreIds({
      lastProjectsProjectId: 'p1',
      lastProjectsConversationId: 'c1',
    })).toEqual({ pid: 'p1', cid: 'c1' });
    expect(projectsTabRestoreIds({
      lastProjectsProjectId: null,
      lastProjectsConversationId: 'schedule-run',
    })).toBeNull();
  });
});

describe('visibleOnProjectsTab', () => {
  it('keeps ordinary chats and their spawn children', () => {
    const root = conv({ id: 'root', title: 'chat' });
    const child = conv({ id: 'child', title: '↳ spawn', parentConversationId: 'root' });
    expect(visibleOnProjectsTab([root, child]).map((c) => c.id)).toEqual(['root', 'child']);
  });

  it('drops schedule homes, tick runs, and tick-spawned descendants even when the home is absent', () => {
    const home = conv({ id: 'home', title: '⏱ nightly', kind: 'schedule_home' });
    const run = conv({ id: 'run', title: '⏱ nightly @ noon', parentConversationId: 'home' });
    const child = conv({ id: 'child', title: '↳ planner', parentConversationId: 'run' });
    const grand = conv({ id: 'grand', title: '↳ implementer', parentConversationId: 'child' });
    const ordinary = conv({ id: 'chat', title: 'operator chat' });
    expect(visibleOnProjectsTab([home, run, child, grand, ordinary]).map((c) => c.id)).toEqual(['chat']);
    expect(visibleOnProjectsTab([run, child, grand, ordinary]).map((c) => c.id)).toEqual(['chat']);
  });
});

function fakeJob(partial: Partial<ScheduleJob> & { id: string; executionMode: ScheduleJob['executionMode'] }): ScheduleJob {
  return {
    projectId: 'p',
    name: partial.name ?? partial.id,
    enabled: true,
    archived: false,
    timezone: 'UTC',
    scheduleKind: 'interval',
    scheduleExpr: '{}',
    overlapPolicy: 'skip',
    profileId: 'claude-code:opus-4.8',
    homeConversationId: 'home',
    promptTemplate: 'x',
    runTimeoutMs: 60_000,
    nextFireAt: 1,
    agentMayComplete: false,
    carryContextEnabled: false,
    workdir: 'shared',
    createdBy: 'operator',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function fakeRun(id: string): ScheduleRun {
  return {
    id,
    jobId: 'job',
    status: 'succeeded',
    firedAt: 1,
  };
}

describe('scheduleConversationIds', () => {
  it('excludes resume-job run conversations and includes spawn_child runs + descendants', () => {
    const tree: ScheduleTreeResponse = {
      jobs: [
        {
          job: fakeJob({ id: 'resume', executionMode: 'resume_conversation' }),
          runs: [{
            run: fakeRun('r1'),
            conversation: conv({ id: 'bound-chat', title: 'bound' }),
            descendants: [conv({ id: 'bound-child', title: '↳', parentConversationId: 'bound-chat' })],
          }],
        },
        {
          job: fakeJob({ id: 'spawn', executionMode: 'spawn_child' }),
          runs: [{
            run: fakeRun('r2'),
            conversation: conv({ id: 'tick-run', title: '⏱ run' }),
            descendants: [conv({ id: 'tick-child', title: '↳', parentConversationId: 'tick-run' })],
          }],
        },
      ],
    };
    const ids = scheduleConversationIds(tree);
    expect(ids.has('bound-chat')).toBe(false);
    expect(ids.has('bound-child')).toBe(false);
    expect(ids.has('tick-run')).toBe(true);
    expect(ids.has('tick-child')).toBe(true);
  });

  it('visibleOnProjectsTab keeps the bound chat when resume ids are excluded', () => {
    const bound = conv({ id: 'bound-chat', title: 'bound' });
    const tick = conv({ id: 'tick-run', title: '⏱ run', parentConversationId: 'home' });
    const home = conv({ id: 'home', title: '⏱ home', kind: 'schedule_home' });
    const tree: ScheduleTreeResponse = {
      jobs: [
        {
          job: fakeJob({ id: 'resume', executionMode: 'resume_conversation' }),
          runs: [{ run: fakeRun('r1'), conversation: bound, descendants: [] }],
        },
        {
          job: fakeJob({ id: 'spawn', executionMode: 'spawn_child' }),
          runs: [{ run: fakeRun('r2'), conversation: tick, descendants: [] }],
        },
      ],
    };
    const ids = scheduleConversationIds(tree);
    expect(visibleOnProjectsTab([bound, tick, home], ids).map((c) => c.id)).toEqual(['bound-chat']);
  });
});

describe('scheduleConversationIdsForJobs', () => {
  it('skips resume jobs when collecting delete hide-set', () => {
    const trees: Record<string, ScheduleTreeResponse> = {
      p: {
        jobs: [
          {
            job: fakeJob({ id: 'resume', executionMode: 'resume_conversation' }),
            runs: [{
              run: fakeRun('r1'),
              conversation: conv({ id: 'bound-chat', title: 'bound' }),
              descendants: [],
            }],
          },
        ],
      },
    };
    expect(scheduleConversationIdsForJobs(trees, new Set(['resume'])).has('bound-chat')).toBe(false);
  });
});
