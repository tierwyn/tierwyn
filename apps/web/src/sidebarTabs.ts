import type { Conversation } from '@tierwyn/shared';
import type { ScheduleTreeResponse } from './api.js';

export type SidebarMainTab = 'projects' | 'schedules';

/**
 * Collect run + descendant conversation ids for a project's schedule tree.
 * Resume jobs are skipped — their bound chats stay visible on the Projects tab (D1).
 */
export function scheduleConversationIds(tree: ScheduleTreeResponse | undefined): Set<string> {
  const ids = new Set<string>();
  if (!tree) return ids;
  for (const entry of tree.jobs) {
    if (entry.job.executionMode === 'resume_conversation') continue;
    for (const runEntry of entry.runs) {
      if (runEntry.conversation?.id) ids.add(runEntry.conversation.id);
      for (const d of runEntry.descendants) ids.add(d.id);
    }
  }
  return ids;
}

/** Conversation ids removed when the listed schedule jobs are hard-deleted. */
export function scheduleConversationIdsForJobs(
  scheduleTrees: Record<string, ScheduleTreeResponse>,
  jobIds: Set<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const tree of Object.values(scheduleTrees)) {
    for (const entry of tree.jobs) {
      if (!jobIds.has(entry.job.id)) continue;
      if (entry.job.executionMode === 'resume_conversation') continue;
      for (const runEntry of entry.runs) {
        if (runEntry.conversation?.id) ids.add(runEntry.conversation.id);
        for (const d of runEntry.descendants) ids.add(d.id);
      }
    }
  }
  return ids;
}

export type RequestedMainTab = { tab: SidebarMainTab; tick: number };

/**
 * External tab requests must apply once per `tick`. Re-running the last
 * request because a setter identity changed snaps the tab back (e.g. click
 * Schedules while a Projects conversation is selected → Projects again).
 */
export function shouldApplyRequestedMainTab(
  lastAppliedTick: number,
  next: RequestedMainTab | null | undefined,
): next is RequestedMainTab {
  return !!next && next.tick > 0 && next.tick !== lastAppliedTick;
}

/**
 * Sidebar scroll-into-view is opt-in (Active Agents jump). Folder expand
 * must not retry a completed reveal just because fold state changed.
 */
export function shouldAttemptSidebarReveal(lastRevealedTick: number, revealTick: number | undefined): boolean {
  return typeof revealTick === 'number' && revealTick > 0 && revealTick !== lastRevealedTick;
}

/**
 * Follow a newly selected schedule-tree conversation onto the Schedules tab.
 * Do not run when only the tab changed — an explicit Projects tap would lose
 * to a still-selected schedule run (typical on mobile with no last-project restore).
 */
export function shouldFollowSelectionToSchedules(
  prevConvId: string | null | undefined,
  nextConvId: string | null | undefined,
  isScheduleConversation: boolean,
  currentTab: SidebarMainTab,
): boolean {
  if (!nextConvId || nextConvId === prevConvId) return false;
  return isScheduleConversation && currentTab !== 'schedules';
}

/**
 * Keep the Schedules tab aligned with a schedule-tree selection after the tree
 * loads (boot restore) or when the id was already selected before jobs/runs
 * arrived. Respects an explicit Projects-tab tap via `operatorChoseProjectsTab`.
 */
export function shouldSyncScheduleTabForSelection(
  selectedConvId: string | null | undefined,
  isScheduleConversation: boolean,
  currentTab: SidebarMainTab,
  operatorChoseProjectsTab: boolean,
): boolean {
  if (!selectedConvId || !isScheduleConversation || operatorChoseProjectsTab) return false;
  return currentTab !== 'schedules';
}

/** Tab-click restore must not emit a tab request — the click already chose the tab. */
export function shouldSyncSidebarTabOnSelect(opts?: { syncSidebarTab?: boolean }): boolean {
  return opts?.syncSidebarTab !== false;
}

/** Projects-tab restore must not reuse lastConversationId (often the schedule you just left). */
export function projectsTabRestoreIds(storage: {
  lastProjectsProjectId: string | null;
  lastProjectsConversationId: string | null;
}): { pid: string; cid: string } | null {
  const pid = storage.lastProjectsProjectId;
  const cid = storage.lastProjectsConversationId;
  if (!pid || !cid) return null;
  return { pid, cid };
}

/**
 * Conversations that belong under a project folder on the Projects tab.
 * Schedule homes, ⏱ tick runs, and spawn descendants of those runs live on
 * the Schedules tab. `scheduleConvIds` is an extra hide-set from the loaded
 * tree (covers resume_conversation binds that are not parented under a home).
 */
export function visibleOnProjectsTab(
  convs: Conversation[],
  scheduleConvIds?: Set<string>,
): Conversation[] {
  const byId = new Map(convs.map((c) => [c.id, c]));
  return convs.filter((c) => {
    if (c.kind === 'schedule_home') return false;
    if (scheduleConvIds?.has(c.id)) return false;
    let cur = c;
    const seen = new Set<string>();
    while (cur.parentConversationId) {
      if (seen.has(cur.id)) return false;
      seen.add(cur.id);
      const parent = byId.get(cur.parentConversationId);
      if (!parent) return false;
      if (parent.kind === 'schedule_home') return false;
      cur = parent;
    }
    return true;
  });
}


