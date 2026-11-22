import type {
  GlobalTaskDto,
  GlobalTaskView,
  GlobalTaskCounts,
  GlobalTaskUpdatedFrame,
} from '@tierwyn/shared';
import { isTaskStale } from '@tierwyn/shared';
import { formatRelativeTime } from './agentActivity.js';

export interface TaskGroup {
  projectId: string;
  projectName: string;
  tasks: GlobalTaskDto[];
}

export function taskMatchesView(t: GlobalTaskDto, view: GlobalTaskView): boolean {
  if (view === 'hidden') {
    return t.hiddenAt != null;
  }
  if (t.hiddenAt != null) {
    return false;
  }
  return t.status === view;
}

/**
 * Groups tasks by project. Groups are ordered by their newest task's updatedAt DESC.
 * Tasks within each group are sorted by updatedAt DESC.
 */
export function groupTasksByProject(tasks: GlobalTaskDto[]): TaskGroup[] {
  if (tasks.length === 0) return [];

  const groupsByProject = new Map<string, { projectName: string; tasks: GlobalTaskDto[]; maxUpdatedAt: number }>();

  for (const task of tasks) {
    const existing = groupsByProject.get(task.projectId);
    if (!existing) {
      groupsByProject.set(task.projectId, {
        projectName: task.projectName || '',
        tasks: [task],
        maxUpdatedAt: task.updatedAt,
      });
    } else {
      existing.tasks.push(task);
      if (task.updatedAt > existing.maxUpdatedAt) {
        existing.maxUpdatedAt = task.updatedAt;
      }
      if (!existing.projectName && task.projectName) {
        existing.projectName = task.projectName;
      }
    }
  }

  const result: TaskGroup[] = [];
  for (const [projectId, entry] of groupsByProject.entries()) {
    entry.tasks.sort((a, b) => b.updatedAt - a.updatedAt);
    result.push({
      projectId,
      projectName: entry.projectName,
      tasks: entry.tasks,
    });
  }

  result.sort((a, b) => {
    const maxA = groupsByProject.get(a.projectId)?.maxUpdatedAt ?? 0;
    const maxB = groupsByProject.get(b.projectId)?.maxUpdatedAt ?? 0;
    return maxB - maxA;
  });

  return result;
}

/**
 * Pure frame application. Returns a new array with the frame applied.
 * Never mutates input.
 */
export function applyTaskFrame(
  tasks: GlobalTaskDto[],
  frame: GlobalTaskUpdatedFrame,
  view: GlobalTaskView,
  projectId?: string,
): GlobalTaskDto[] {
  if (frame.op === 'delete') {
    return tasks.filter((t) => t.id !== frame.taskId);
  }

  if (frame.op === 'upsert') {
    const updated = frame.task;
    if (!updated) {
      return [...tasks];
    }

    const matchesProject = !projectId || updated.projectId === projectId;
    const matchesCurrentView = taskMatchesView(updated, view);

    const existsIndex = tasks.findIndex((t) => t.id === updated.id);

    if (!matchesProject || !matchesCurrentView) {
      if (existsIndex !== -1) {
        return tasks.filter((t) => t.id !== updated.id);
      }
      return [...tasks];
    }

    let next: GlobalTaskDto[];
    if (existsIndex !== -1) {
      next = [...tasks];
      next[existsIndex] = updated;
    } else {
      next = [...tasks, updated];
    }

    next.sort((a, b) => b.updatedAt - a.updatedAt);
    return next;
  }

  return [...tasks];
}

export type TaskBadge = {
  kind: 'live' | 'stale' | 'archived' | 'deleted' | 'sub' | 'done-agent' | 'done-operator';
  label: string;
};

/**
 * Returns badge pills for a task.
 * Priority/order:
 * - live ("LIVE") if live
 * - stale ("STALE · Xd") if isTaskStale (never show both live and stale; live wins)
 * - sub ("↳ SUB-AGENT") if parentConversationId
 * - archived ("ARCHIVED") if conversationArchived
 * - deleted ("CONVERSATION DELETED") if !conversationId
 * - for completed tasks: done-agent ("✓ BY AGENT") or done-operator ("✓ BY YOU")
 */
export function taskBadges(t: GlobalTaskDto, now: number, staleAfterHours: number): TaskBadge[] {
  const badges: TaskBadge[] = [];

  if (t.live) {
    badges.push({ kind: 'live', label: 'LIVE' });
  } else if (isTaskStale(t, now, staleAfterHours)) {
    const age = relativeAge(t.updatedAt, now);
    const shortAge = age.replace(/\s*ago$/, '');
    badges.push({ kind: 'stale', label: `STALE · ${shortAge}` });
  }

  if (t.parentConversationId) {
    badges.push({ kind: 'sub', label: '↳ SUB-AGENT' });
  }

  if (t.conversationArchived) {
    badges.push({ kind: 'archived', label: 'ARCHIVED' });
  }

  if (!t.conversationId) {
    badges.push({ kind: 'deleted', label: 'CONVERSATION DELETED' });
  }

  if (t.status === 'completed') {
    if (t.completedBy === 'operator') {
      badges.push({ kind: 'done-operator', label: '✓ BY YOU' });
    } else if (t.completedBy === 'agent') {
      badges.push({ kind: 'done-agent', label: '✓ BY AGENT' });
    }
  }

  return badges;
}

export function relativeAge(ms: number, now = Date.now()): string {
  return formatRelativeTime(ms, now);
}

export function tabLabel(view: GlobalTaskView, counts: GlobalTaskCounts): string {
  switch (view) {
    case 'in_progress':
      return `In progress (${counts.inProgress})`;
    case 'completed':
      return `Completed (${counts.completedVisible})`;
    case 'hidden':
      return `Hidden (${counts.hidden})`;
  }
}
