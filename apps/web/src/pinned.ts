import type { Conversation, Project } from '@tierwyn/shared';

/**
 * Id of the virtual "Pinned" sidebar folder. Deliberately NOT a UUID: real
 * project ids are UUIDs, so this can never collide, and any accidental leak
 * into an API call fails loudly instead of hitting a real row.
 */
export const PINNED_PROJECT_ID = 'pinned-virtual';

/** The pseudo-`Project` spliced into the sidebar list. Never persisted. */
export function pinnedPseudoProject(): Project {
  return {
    id: PINNED_PROJECT_ID,
    name: 'Pinned',
    rootPath: '',
    createdAt: 0,
    system: true,
  };
}

/**
 * Flatten every pinned ROOT conversation plus its full transitive subtree,
 * across all projects, into one list. The sidebar's normal per-project
 * pipeline re-nests this by `parentConversationId` and computes depth, so the
 * order here only needs to be deterministic.
 *
 * Only roots count: a pinned child is shown in place inside its root's tree,
 * never promoted to a top-level Pinned entry (otherwise its subtree would
 * render twice).
 */
export function collectPinnedConversations(
  listByProject: Record<string, Conversation[]>,
): Conversation[] {
  const out: Conversation[] = [];
  for (const pid of Object.keys(listByProject)) {
    const list = listByProject[pid] ?? [];
    if (list.length === 0) continue;
    const childrenByParent = new Map<string, Conversation[]>();
    for (const c of list) {
      if (!c.parentConversationId) continue;
      const arr = childrenByParent.get(c.parentConversationId) ?? [];
      arr.push(c);
      childrenByParent.set(c.parentConversationId, arr);
    }
    const roots = list.filter((c) => c.pinned && !c.parentConversationId);
    // parentConversationId is a single scalar, so the graph is a tree (never a
    // DAG / diamond). `seen` is per-project and guards only malformed parent
    // cycles that would otherwise recurse forever.
    const seen = new Set<string>();
    const walk = (c: Conversation) => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      out.push(c);
      for (const kid of childrenByParent.get(c.id) ?? []) walk(kid);
    };
    for (const r of roots) walk(r);
  }
  return out;
}

export type PinnedListItem =
  | { kind: 'row'; c: Conversation; depth: number; projectLabel?: string }
  | { kind: 'group'; projectId: string; projectName: string; count: number; collapsed: boolean };

/**
 * Group the FULL filtered+ordered Pinned row list (the sidebar then paginates
 * by slicing this item list — blocks, not raw rows). A collapsed group is one
 * block (header only) and consumes one page slot. A project contributing ≥2
 * pinned roots gets a collapsible header with its subtree indented one level.
 * Single-root projects stay flat and carry a `projectLabel` chip instead.
 *
 * Ordering: projects appear in order of first appearance in the input row
 * list (sidebar sort is updatedAt DESC). Within each group and for singleton
 * runs, that updatedAt DESC row order is preserved. `depth === 0` marks the
 * start of a new root block.
 */
export function groupPinnedItems(
  rows: { c: Conversation; depth: number }[],
  projectNameById: Record<string, string>,
  collapsedGroups: Record<string, boolean>,
): PinnedListItem[] {
  // Slice `rows` into root blocks and bucket them by project.
  const blocksByProject = new Map<string, { c: Conversation; depth: number }[][]>();
  const order: string[] = [];
  let current: { c: Conversation; depth: number }[] | null = null;
  let currentPid = '';
  for (const row of rows) {
    if (row.depth === 0 || current === null) {
      currentPid = row.c.projectId;
      current = [row];
      const arr = blocksByProject.get(currentPid);
      if (arr) arr.push(current);
      else {
        blocksByProject.set(currentPid, [current]);
        order.push(currentPid);
      }
    } else {
      current.push(row);
    }
  }

  const out: PinnedListItem[] = [];
  for (const pid of order) {
    const blocks = blocksByProject.get(pid) ?? [];
    const projectName = projectNameById[pid] ?? pid;
    if (blocks.length < 2) {
      for (const block of blocks) {
        for (const [i, row] of block.entries()) {
          out.push(i === 0
            ? { kind: 'row', c: row.c, depth: row.depth, projectLabel: projectName }
            : { kind: 'row', c: row.c, depth: row.depth });
        }
      }
      continue;
    }
    const collapsed = collapsedGroups[pid] === true;
    out.push({ kind: 'group', projectId: pid, projectName, count: blocks.length, collapsed });
    if (collapsed) continue;
    for (const block of blocks) {
      for (const row of block) out.push({ kind: 'row', c: row.c, depth: row.depth + 1 });
    }
  }
  return out;
}
