import type { Conversation, Project, RemoteHostState, RemoteHostView } from '@tierwyn/shared';
import { matchesTagQuery, REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import type { DotResult } from './statusDot.js';
import { remoteHostSidebarLabel } from './remoteHostSidebar.js';
import { PINNED_PROJECT_ID } from './pinned.js';

export { remoteHostMatchesSearch } from './remoteHostSidebar.js';

export type SidebarGroupBy = 'project' | 'host' | 'recent' | 'status';
export type ProjectOrder = 'created' | 'activity' | 'name';
export type StatusBucket = 'waiting' | 'error' | 'running' | 'subagents' | 'unread' | 'idle';

export const STATUS_BUCKET_ORDER: readonly StatusBucket[] = [
  'waiting',
  'error',
  'running',
  'subagents',
  'unread',
  'idle',
] as const;

export function parseGroupBy(raw: string | null): SidebarGroupBy {
  if (raw === 'host' || raw === 'recent' || raw === 'status') return raw;
  return 'project';
}

export function parseProjectOrder(raw: string | null): ProjectOrder {
  if (raw === 'activity' || raw === 'name') return raw;
  return 'created';
}

export type SearchScope = 'all' | 'project';

export function parseSearchScope(raw: string | null): SearchScope {
  return raw === 'project' ? 'project' : 'all';
}

/** D2/D3: the project a sidebar search is scoped to, or null = all projects. */
export function resolveSearchScopeProjectId(
  scope: SearchScope,
  selectedProjectId: string | null,
  searchQuery: string,
): string | null {
  if (scope !== 'project' || !searchQuery.trim()) return null;
  if (!selectedProjectId || selectedProjectId === PINNED_PROJECT_ID) return null;
  return selectedProjectId;
}

export function bucketFromDot(
  dot: DotResult,
  conv?: { parentConversationId?: string | null },
): StatusBucket {
  const tokens = dot.dotClass.split(/\s+/);
  if (tokens.includes('waiting')) return 'waiting';
  if (tokens.includes('error')) return 'error';
  if (tokens.includes('running')) {
    return conv?.parentConversationId ? 'subagents' : 'running';
  }
  if (tokens.includes('descendant-active')) return 'subagents';
  if (tokens.includes('unread') || tokens.includes('done')) return 'unread';
  return 'idle';
}

/**
 * Filter conversations within a project or folder.
 * Parity with original Sidebar pipeline (~L3242–3310).
 * Returns sorted by updatedAt desc, ancestors-of-kept included.
 */
export function filterConversations(
  list: Conversation[],
  f: {
    recentDays: number;
    now: number;
    selectedConversationId: string | null;
    showArchived: boolean;
    activeTag: string | null;
    searchQuery: string;
    contentSearch: boolean;
    contentHitIds: ReadonlySet<string>;
    statusFilter?: ReadonlySet<StatusBucket>;
    bucketOf?: (c: Conversation) => StatusBucket;
    isPinnedFolder?: boolean;
    scopeProjectId?: string | null;
  },
): Conversation[] {
  // Sidebar "This project" search scope. Applied before recency/ancestor
  // expansion; a parent always shares its child's project, so ancestry is intact.
  if (f.scopeProjectId) list = list.filter((c) => c.projectId === f.scopeProjectId);
  let timeFilteredList = list;
  // A pin means "keep this reachable" — a 1-day window must not hide it.
  if (f.recentDays !== 0 && !f.isPinnedFolder) {
    const threshold = f.recentDays * 86_400_000;
    const keepIds = new Set<string>();

    for (const c of list) {
      const matchesStatus = Boolean(
        f.statusFilter &&
        f.statusFilter.size > 0 &&
        f.bucketOf &&
        f.statusFilter.has(f.bucketOf(c))
      );
      if (
        f.now - c.updatedAt < threshold ||
        c.id === f.selectedConversationId ||
        matchesStatus ||
        (f.contentSearch && f.contentHitIds.has(c.id))
      ) {
        keepIds.add(c.id);
      }
    }

    let added = true;
    while (added) {
      added = false;
      for (const c of list) {
        if (keepIds.has(c.id) && c.parentConversationId && !keepIds.has(c.parentConversationId)) {
          keepIds.add(c.parentConversationId);
          added = true;
        }
      }
    }

    timeFilteredList = list.filter((c) => keepIds.has(c.id));
  }

  const archivedRootIds = new Set(
    list.filter((c) => c.archived && !c.parentConversationId).map((c) => c.id),
  );
  const rootIsArchived = (c: Conversation): boolean => {
    let cur = c;
    const seen = new Set<string>();
    while (cur.parentConversationId) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      const parent: Conversation | undefined = list.find((x) => x.id === cur.parentConversationId);
      if (!parent) break;
      cur = parent;
    }
    return archivedRootIds.has(cur.id);
  };

  let filteredConvs = timeFilteredList
    .filter((c) => {
      if (!f.showArchived && (c.archived || rootIsArchived(c))) return false;
      if (f.showArchived) return c.archived || rootIsArchived(c);
      return true;
    })
    .filter((c) => matchesTagQuery(c, f.activeTag))
    .filter((c) => {
      const q = f.searchQuery.toLowerCase();
      return (
        c.title.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q) ||
        (f.contentSearch && f.contentHitIds.has(c.id))
      );
    });

  if (f.statusFilter && f.statusFilter.size > 0 && f.bucketOf) {
    const statusMatches = new Set<string>();
    for (const c of filteredConvs) {
      if (f.statusFilter.has(f.bucketOf(c))) {
        statusMatches.add(c.id);
      }
    }
    // Keep ancestors of matching items so tree context is preserved
    let added = true;
    while (added) {
      added = false;
      for (const c of list) {
        if (statusMatches.has(c.id) && c.parentConversationId && !statusMatches.has(c.parentConversationId)) {
          statusMatches.add(c.parentConversationId);
          added = true;
        }
      }
    }
    filteredConvs = list.filter(
      (c) =>
        statusMatches.has(c.id) &&
        (!f.showArchived ? !c.archived : (c.archived || rootIsArchived(c))),
    );
  }

  return filteredConvs.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function activityAt(c: Conversation, live: Record<string, number>): number {
  return Math.max(c.updatedAt ?? 0, live[c.id] ?? 0);
}

export function subtreeActivity(
  root: Conversation | string,
  childrenByParent: Map<string, Conversation[]>,
  live: Record<string, number>,
  rootConv?: Conversation,
): number {
  const rootObj = typeof root === 'string' ? rootConv : root;
  const rootId = typeof root === 'string' ? root : root.id;
  let max = rootObj ? activityAt(rootObj, live) : (live[rootId] ?? 0);

  const stack = [...(childrenByParent.get(rootId) ?? [])];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const child = stack.pop()!;
    if (visited.has(child.id)) continue;
    visited.add(child.id);
    const childAct = activityAt(child, live);
    if (childAct > max) max = childAct;
    const grandKids = childrenByParent.get(child.id);
    if (grandKids) {
      for (const gk of grandKids) stack.push(gk);
    }
  }
  return max;
}

export function orderProjects(
  projects: Project[],
  order: ProjectOrder,
  activityOf: (pid: string) => number,
): Project[] {
  if (order === 'name') {
    return [...projects].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (order === 'activity') {
    return [...projects].sort((a, b) => {
      const diff = activityOf(b.id) - activityOf(a.id);
      if (diff !== 0) return diff;
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
  }
  return [...projects].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export interface HostGroup {
  key: 'hub' | 'unknown' | string;
  label: string;
  state?: RemoteHostState;
  /** Set for remote-host groups (sidebar tooltip / search). */
  host?: RemoteHostView;
  projects: Project[];
}

export function groupProjectsByHost(projects: Project[], hosts: RemoteHostView[]): HostGroup[] {
  const hostMap = new Map<string, RemoteHostView>();
  for (const h of hosts) hostMap.set(h.id, h);

  const hubProjects: Project[] = [];
  const hostProjectsMap = new Map<string, Project[]>();
  const unknownProjects: Project[] = [];

  for (const p of projects) {
    if (!p.remoteHostId) {
      hubProjects.push(p);
    } else if (hostMap.has(p.remoteHostId)) {
      const arr = hostProjectsMap.get(p.remoteHostId) ?? [];
      arr.push(p);
      hostProjectsMap.set(p.remoteHostId, arr);
    } else {
      unknownProjects.push(p);
    }
  }

  const groups: HostGroup[] = [];

  // 1. Hub first
  if (hubProjects.length > 0) {
    groups.push({
      key: 'hub',
      label: 'Hub',
      projects: hubProjects,
    });
  }

  // 2. Remote hosts sorted by name
  const sortedHosts = [...hosts].sort((a, b) => a.name.localeCompare(b.name));
  for (const h of sortedHosts) {
    const projs = hostProjectsMap.get(h.id);
    if (projs && projs.length > 0) {
      groups.push({
        key: h.id,
        label: remoteHostSidebarLabel(h),
        state: h.state,
        host: h,
        projects: projs,
      });
    }
  }

  // 3. Unknown host last
  if (unknownProjects.length > 0) {
    groups.push({
      key: 'unknown',
      label: 'Unknown host',
      projects: unknownProjects,
    });
  }

  return groups;
}

/** Project picker options ordered + badged by host (Hub, hosts by name, Unknown
 *  host, Remote Agents container last) so same-named projects on different
 *  hosts are distinguishable. Disconnected hosts stay listed, badged with state. */
export function hostBadgedProjectOptions(
  projects: Project[], hosts: RemoteHostView[],
): { value: string; label: string; badge: string }[] {
  const container = projects.filter((p) => p.id === REMOTE_AGENTS_PROJECT_ID);
  const rest = projects.filter((p) => p.id !== REMOTE_AGENTS_PROJECT_ID);
  const out = groupProjectsByHost(rest, hosts).flatMap((g) => g.projects.map((p) => ({
    value: p.id,
    label: p.name,
    badge: g.state && g.state !== 'connected' ? `${g.label} · ${g.state}` : g.label,
  })));
  return [...out, ...container.map((p) => ({ value: p.id, label: p.name, badge: 'Remote Agents' }))];
}

/** Schedules-tab activity: latest run `firedAt` in the loaded tree, else project creation. */
export function scheduleProjectActivity(
  p: Project, tree: { jobs: { runs: { run: { firedAt: number } }[] }[] } | undefined,
): number {
  let max = 0;
  for (const j of tree?.jobs ?? []) for (const r of j.runs) if (r.run.firedAt > max) max = r.run.firedAt;
  return max || (p.createdAt ?? 0);
}

/** Schedules tab follows the View menu: ordered only in the modes whose menu
 *  shows the order options (`project` / `host`); host-grouped only for `host`
 *  (Remote Agents container last). Recent/Status keep input order, flat
 *  (`groups: null`) — ponytail: no status/recent semantics for schedules yet. */
export function layoutScheduleProjects(
  projects: Project[],
  trees: Record<string, { jobs: { runs: { run: { firedAt: number } }[] }[] }>,
  hosts: RemoteHostView[],
  groupBy: SidebarGroupBy,
  order: ProjectOrder,
): { ordered: Project[]; groups: HostGroup[] | null } {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const ordered = groupBy === 'project' || groupBy === 'host'
    ? orderProjects(projects, order, (pid) => scheduleProjectActivity(byId.get(pid)!, trees[pid]))
    : projects;
  if (groupBy !== 'host') return { ordered, groups: null };
  const container = ordered.filter((p) => p.id === REMOTE_AGENTS_PROJECT_ID);
  const groups = groupProjectsByHost(ordered.filter((p) => p.id !== REMOTE_AGENTS_PROJECT_ID), hosts);
  if (container.length > 0) groups.push({ key: 'remote-agents', label: 'Remote Agents', projects: container });
  return { ordered, groups };
}

/** Delete-project confirm line, or null when the project has no schedules. */
export function projectScheduleDeleteNote(jobs: { job: { enabled: boolean } }[] | undefined): string | null {
  const n = jobs?.length ?? 0;
  if (n === 0) return null;
  const on = jobs!.filter((e) => e.job.enabled).length;
  return `This includes ${n} schedule${n === 1 ? '' : 's'} (${on} enabled).`;
}

/** Collect non-archived run conversations and their spawn descendants from schedule tree job entries. */
export function collectScheduleTreeConversations(
  jobs: ReadonlyArray<{
    runs: ReadonlyArray<{
      conversation?: Conversation;
      descendants: ReadonlyArray<Conversation>;
    }>;
  }>,
): Conversation[] {
  const out: Conversation[] = [];
  for (const entry of jobs) {
    for (const r of entry.runs) {
      if (r.conversation && !r.conversation.archived) {
        out.push(r.conversation);
      }
      for (const d of r.descendants) {
        if (!d.archived) {
          out.push(d);
        }
      }
    }
  }
  return out;
}

export interface FlatRow {
  c: Conversation;
  depth: number;
  breadcrumb?: string;
}

export function buildRecentRows(
  convs: Conversation[],
  opts: {
    folded: (id: string) => boolean;
    live: Record<string, number>;
  },
): FlatRow[] {
  const convMap = new Map<string, Conversation>();
  for (const c of convs) convMap.set(c.id, c);

  const childrenByParent = new Map<string, Conversation[]>();
  for (const c of convs) {
    if (c.parentConversationId) {
      const arr = childrenByParent.get(c.parentConversationId) ?? [];
      arr.push(c);
      childrenByParent.set(c.parentConversationId, arr);
    }
  }

  const roots = convs.filter(
    (c) => !c.parentConversationId || !convMap.has(c.parentConversationId),
  );

  roots.sort((a, b) => {
    const actB = subtreeActivity(b, childrenByParent, opts.live);
    const actA = subtreeActivity(a, childrenByParent, opts.live);
    if (actB !== actA) return actB - actA;
    return b.updatedAt - a.updatedAt;
  });

  const rows: FlatRow[] = [];
  const appendRowAndKids = (conv: Conversation, depth: number) => {
    rows.push({ c: conv, depth });
    if (!opts.folded(conv.id)) {
      const kids = childrenByParent.get(conv.id) ?? [];
      const sortedKids = [...kids].sort((a, b) => {
        const actB = subtreeActivity(b, childrenByParent, opts.live);
        const actA = subtreeActivity(a, childrenByParent, opts.live);
        if (actB !== actA) return actB - actA;
        return b.updatedAt - a.updatedAt;
      });
      for (const kid of sortedKids) {
        appendRowAndKids(kid, depth + 1);
      }
    }
  };

  for (const root of roots) {
    appendRowAndKids(root, 0);
  }

  return rows;
}

export function buildStatusBuckets(
  convs: Conversation[],
  opts: {
    bucketOf: (c: Conversation) => StatusBucket;
    live: Record<string, number>;
    sticky?: { id: string; bucket: StatusBucket } | null;
    parentTitle: (id: string) => string | undefined;
    projectName: (pid: string) => string;
  },
): Array<{ bucket: StatusBucket; rows: FlatRow[] }> {
  const buckets: Record<StatusBucket, FlatRow[]> = {
    waiting: [],
    error: [],
    running: [],
    subagents: [],
    unread: [],
    idle: [],
  };

  for (const c of convs) {
    let bucket: StatusBucket;
    const rawBucket = opts.bucketOf(c);
    if (opts.sticky && opts.sticky.id === c.id) {
      if (rawBucket === 'waiting' || rawBucket === 'error' || rawBucket === 'running') {
        bucket = rawBucket;
      } else {
        bucket = opts.sticky.bucket;
      }
    } else {
      bucket = rawBucket;
    }

    const isChild = !!c.parentConversationId;
    if (isChild) {
      if (bucket === 'idle') {
        continue;
      }
      const pName = opts.projectName(c.projectId) || 'Project';
      const pTitle = opts.parentTitle(c.parentConversationId!);
      const breadcrumb = pTitle ? `${pName} › ${pTitle}` : pName;
      buckets[bucket].push({
        c,
        depth: 0,
        breadcrumb,
      });
    } else {
      const pName = opts.projectName(c.projectId);
      buckets[bucket].push({
        c,
        depth: 0,
        breadcrumb: pName || undefined,
      });
    }
  }

  for (const b of STATUS_BUCKET_ORDER) {
    buckets[b].sort((a, bRow) => {
      const actB = activityAt(bRow.c, opts.live);
      const actA = activityAt(a.c, opts.live);
      if (actB !== actA) return actB - actA;
      return bRow.c.updatedAt - a.c.updatedAt;
    });
  }

  const result: Array<{ bucket: StatusBucket; rows: FlatRow[] }> = [];
  for (const b of STATUS_BUCKET_ORDER) {
    if (buckets[b].length > 0) {
      result.push({ bucket: b, rows: buckets[b] });
    }
  }

  return result;
}

export interface AggregateCounts {
  waiting: number;
  error: number;
  running: number;
  subagents: number;
  unread: number;
}

export function aggregateCounts(
  convs: Conversation[],
  bucketOf: (c: Conversation) => StatusBucket,
): AggregateCounts {
  let waiting = 0;
  let error = 0;
  let running = 0;
  let subagents = 0;
  let unread = 0;
  const activeParentIds = new Set<string>();
  const buckets = new Map<string, StatusBucket>();
  let anyActiveChild = false;
  for (const c of convs) {
    const b = bucketOf(c);
    buckets.set(c.id, b);
    if (c.parentConversationId && (b === 'subagents' || b === 'running' || b === 'waiting')) {
      anyActiveChild = true;
      activeParentIds.add(c.parentConversationId);
    }
  }
  for (const c of convs) {
    const b = buckets.get(c.id)!;
    if (b === 'waiting') waiting++;
    else if (b === 'error') error++;
    else if (b === 'running') running++;
    else if (b === 'subagents') {
      // A root conversation (no parentConversationId) only lands in `subagents`
      // via `descendant-active`. Do not double-count an ancestor's
      // `descendant-active` cue when an active spawn child is already in `convs`.
      const isRootDescendantCue = !c.parentConversationId && anyActiveChild;
      if (!isRootDescendantCue && !activeParentIds.has(c.id)) {
        subagents++;
      }
    } else if (b === 'unread') unread++;
  }
  return { waiting, error, running, subagents, unread };
}

export const SIDEBAR_W_DEFAULT = 340;
export const SIDEBAR_W_MIN = 340;
export const SIDEBAR_W_MAX = 560;
export const MAIN_MIN = 480;

export function clampSidebarWidth(px: number, viewportW: number): number {
  const maxAllowed = Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, viewportW - MAIN_MIN));
  return Math.max(SIDEBAR_W_MIN, Math.min(maxAllowed, px));
}

export function parseStoredSidebarWidth(raw: string | null): number {
  if (raw === null || raw.trim() === '') return SIDEBAR_W_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return SIDEBAR_W_DEFAULT;
  return parsed;
}

/**
 * Parents that just gained their first child since the last snapshot. `known`
 * maps projectId → parent ids seen last time and is updated in place. A project
 * seen for the first time only seeds `known`, so a lazy bucket load never
 * looks like a burst of fresh spawns.
 */
export function newlySpawnedParents(
  known: Map<string, Set<string>>,
  conversations: Record<string, readonly { parentConversationId?: string; archived?: boolean }[]>,
): string[] {
  const out: string[] = [];
  for (const [pid, bucket] of Object.entries(conversations)) {
    const now = new Set<string>();
    // A fresh spawn is never archived; skipping archived rows keeps the "Show
    // archived" toggle from unfolding old parents whose children are all archived.
    for (const c of bucket) if (c.parentConversationId && !c.archived) now.add(c.parentConversationId);
    const prev = known.get(pid);
    known.set(pid, now);
    if (!prev) continue;
    for (const p of now) if (!prev.has(p)) out.push(p);
  }
  return out;
}
