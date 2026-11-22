import { describe, it, expect } from 'vitest';
import type { GlobalTaskDto, GlobalTaskCounts, GlobalTaskUpdatedFrame } from '@tierwyn/shared';
import {
  taskMatchesView,
  groupTasksByProject,
  applyTaskFrame,
  taskBadges,
  relativeAge,
  tabLabel,
} from './globalTasks.js';

function makeTask(overrides: Partial<GlobalTaskDto> = {}): GlobalTaskDto {
  return {
    id: 't-1',
    projectId: 'p-1',
    projectName: 'Tierwyn',
    conversationId: 'conv-1',
    conversationTitle: 'Main Conv',
    title: 'Do stuff',
    description: 'A description',
    testing: 'A test',
    progress: 'Some progress',
    status: 'in_progress',
    createdAt: 1000,
    updatedAt: 2000,
    live: false,
    ...overrides,
  };
}

describe('taskMatchesView', () => {
  it('matches hidden tasks iff hiddenAt != null', () => {
    const hiddenTask = makeTask({ hiddenAt: 1234 });
    const normalTask = makeTask({ hiddenAt: undefined });

    expect(taskMatchesView(hiddenTask, 'hidden')).toBe(true);
    expect(taskMatchesView(normalTask, 'hidden')).toBe(false);

    // When hidden, should NOT match in_progress or completed
    expect(taskMatchesView(hiddenTask, 'in_progress')).toBe(false);
    expect(taskMatchesView(hiddenTask, 'completed')).toBe(false);
  });

  it('matches in_progress tasks iff not hidden and status is in_progress', () => {
    const inProg = makeTask({ status: 'in_progress' });
    const done = makeTask({ status: 'completed' });

    expect(taskMatchesView(inProg, 'in_progress')).toBe(true);
    expect(taskMatchesView(done, 'in_progress')).toBe(false);
  });

  it('matches completed tasks iff not hidden and status is completed', () => {
    const inProg = makeTask({ status: 'in_progress' });
    const done = makeTask({ status: 'completed' });

    expect(taskMatchesView(inProg, 'completed')).toBe(false);
    expect(taskMatchesView(done, 'completed')).toBe(true);
  });
});

describe('groupTasksByProject', () => {
  it('groups tasks by project, ordered by newest project updatedAt, tasks sorted updatedAt DESC', () => {
    const t1 = makeTask({ id: 't1', projectId: 'p1', projectName: 'Proj 1', updatedAt: 100 });
    const t2 = makeTask({ id: 't2', projectId: 'p1', projectName: 'Proj 1', updatedAt: 300 });
    const t3 = makeTask({ id: 't3', projectId: 'p2', projectName: 'Proj 2', updatedAt: 200 });

    const groups = groupTasksByProject([t1, t2, t3]);
    expect(groups).toHaveLength(2);
    // Proj 1 has max updatedAt 300, Proj 2 has 200 -> Proj 1 first
    expect(groups[0].projectId).toBe('p1');
    expect(groups[0].projectName).toBe('Proj 1');
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['t2', 't1']);

    expect(groups[1].projectId).toBe('p2');
    expect(groups[1].projectName).toBe('Proj 2');
    expect(groups[1].tasks.map((t) => t.id)).toEqual(['t3']);
  });

  it('handles empty tasks list', () => {
    expect(groupTasksByProject([])).toEqual([]);
  });
});

describe('applyTaskFrame', () => {
  const counts: GlobalTaskCounts = { inProgress: 1, completedVisible: 1, hidden: 0 };

  it('removes by id on delete op', () => {
    const t1 = makeTask({ id: 't1', updatedAt: 100 });
    const t2 = makeTask({ id: 't2', updatedAt: 200 });
    const frame: GlobalTaskUpdatedFrame = {
      type: 'global_task_updated',
      taskId: 't1',
      op: 'delete',
      counts,
    };

    const next = applyTaskFrame([t1, t2], frame, 'in_progress');
    expect(next.map((t) => t.id)).toEqual(['t2']);
  });

  it('delete of an unknown id is a no-op', () => {
    const t1 = makeTask({ id: 't1', updatedAt: 100 });
    const frame: GlobalTaskUpdatedFrame = {
      type: 'global_task_updated',
      taskId: 'unknown',
      op: 'delete',
      counts,
    };

    const next = applyTaskFrame([t1], frame, 'in_progress');
    expect(next).toEqual([t1]);
    expect(next).not.toBe([t1]); // immutable copy
  });

  it('upserts matching task and re-sorts updatedAt DESC', () => {
    const t1 = makeTask({ id: 't1', updatedAt: 100 });
    const t2Updated = makeTask({ id: 't2', updatedAt: 500 });
    const frame: GlobalTaskUpdatedFrame = {
      type: 'global_task_updated',
      taskId: 't2',
      op: 'upsert',
      task: t2Updated,
      counts,
    };

    const next = applyTaskFrame([t1], frame, 'in_progress');
    expect(next.map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('removes task when upsert causes it to no longer match view (e.g. in_progress -> completed)', () => {
    const t1 = makeTask({ id: 't1', status: 'in_progress', updatedAt: 100 });
    const t1Completed = makeTask({ id: 't1', status: 'completed', updatedAt: 200 });
    const frame: GlobalTaskUpdatedFrame = {
      type: 'global_task_updated',
      taskId: 't1',
      op: 'upsert',
      task: t1Completed,
      counts,
    };

    const next = applyTaskFrame([t1], frame, 'in_progress');
    expect(next).toEqual([]);
  });

  it('ignores upsert for another project when projectId filter is given', () => {
    const t1 = makeTask({ id: 't1', projectId: 'p1', updatedAt: 100 });
    const t2 = makeTask({ id: 't2', projectId: 'p2', updatedAt: 200 });
    const frame: GlobalTaskUpdatedFrame = {
      type: 'global_task_updated',
      taskId: 't2',
      op: 'upsert',
      task: t2,
      counts,
    };

    const next = applyTaskFrame([t1], frame, 'in_progress', 'p1');
    expect(next.map((t) => t.id)).toEqual(['t1']);
  });

  it('removes existing task if projectId changes away from filter', () => {
    const t1 = makeTask({ id: 't1', projectId: 'p1', updatedAt: 100 });
    const t1Moved = makeTask({ id: 't1', projectId: 'p2', updatedAt: 200 });
    const frame: GlobalTaskUpdatedFrame = {
      type: 'global_task_updated',
      taskId: 't1',
      op: 'upsert',
      task: t1Moved,
      counts,
    };

    const next = applyTaskFrame([t1], frame, 'in_progress', 'p1');
    expect(next).toEqual([]);
  });
});

describe('taskBadges', () => {
  const H = 3_600_000;
  const now = 50 * H;

  it('live wins over stale', () => {
    const t = makeTask({
      status: 'in_progress',
      updatedAt: 0,
      live: true,
    });
    const badges = taskBadges(t, now, 48);
    expect(badges).toEqual([{ kind: 'live', label: 'LIVE' }]);
  });

  it('stale shows when not live and older than threshold', () => {
    const t = makeTask({
      status: 'in_progress',
      updatedAt: now - 3 * 86_400_000,
      live: false,
    });
    const badges = taskBadges(t, now, 48);
    expect(badges).toEqual([{ kind: 'stale', label: 'STALE · 3d' }]);
  });

  it('shows sub-agent badge when parentConversationId is present', () => {
    const t = makeTask({
      parentConversationId: 'parent-1',
    });
    const badges = taskBadges(t, now, 48);
    expect(badges.some((b) => b.kind === 'sub' && b.label === '↳ SUB-AGENT')).toBe(true);
  });

  it('shows archived badge when conversationArchived is true', () => {
    const t = makeTask({
      conversationId: 'c1',
      conversationArchived: true,
    });
    const badges = taskBadges(t, now, 48);
    expect(badges.some((b) => b.kind === 'archived')).toBe(true);
  });

  it('shows deleted badge when conversationId is missing', () => {
    const t = makeTask({
      conversationId: undefined,
    });
    const badges = taskBadges(t, now, 48);
    expect(badges.some((b) => b.kind === 'deleted' && b.label === 'CONVERSATION DELETED')).toBe(true);
  });

  it('shows completed badges for agent vs operator', () => {
    const tAgent = makeTask({
      status: 'completed',
      completedBy: 'agent',
    });
    const tOp = makeTask({
      status: 'completed',
      completedBy: 'operator',
    });

    expect(taskBadges(tAgent, now, 48).some((b) => b.kind === 'done-agent' && b.label === '✓ BY AGENT')).toBe(true);
    expect(taskBadges(tOp, now, 48).some((b) => b.kind === 'done-operator' && b.label === '✓ BY YOU')).toBe(true);
  });

  it('order of badges preserves expected priority', () => {
    const t = makeTask({
      status: 'completed',
      completedBy: 'agent',
      parentConversationId: 'p1',
      conversationId: undefined,
    });
    const badges = taskBadges(t, now, 48);
    // sub, deleted, done-agent
    expect(badges.map((b) => b.kind)).toEqual(['sub', 'deleted', 'done-agent']);
  });
});

describe('relativeAge and tabLabel', () => {
  it('relativeAge returns readable string', () => {
    const now = 100_000_000;
    expect(relativeAge(now, now)).toBe('just now');
    expect(relativeAge(now - 2 * 60_000, now)).toBe('2m ago');
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeAge(now - 6 * 86_400_000, now)).toBe('6d ago');
  });

  it('tabLabel formats correct count', () => {
    const counts: GlobalTaskCounts = { inProgress: 5, completedVisible: 3, hidden: 12 };
    expect(tabLabel('in_progress', counts)).toBe('In progress (5)');
    expect(tabLabel('completed', counts)).toBe('Completed (3)');
    expect(tabLabel('hidden', counts)).toBe('Hidden (12)');
  });
});
