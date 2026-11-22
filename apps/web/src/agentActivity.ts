import type {
  ActiveSessionsResponse, ActiveAgentSessionDto, ActiveAgentConversationDto, AgentStatus,
  ConversationKind, Conversation, PendingTimerSummary, SpawnRequestRow,
} from '@tierwyn/shared';
import { agentDisplayName } from '@tierwyn/shared';
import { countdownLabel } from './promptTimer.js';

export interface AgentTreeNode {
  conversationId: string;
  title: string;
  projectId: string;
  /** Undefined when the project is unknown (deleted conversation). */
  projectName?: string;
  /** 'schedule_home' → render as a ⏱ job grouping header (no action buttons,
   *  no runtime — it never holds a session). */
  kind?: ConversationKind;
  description?: string;
  tags?: string[];
  /** Empty on an ancestor placeholder with no live session of its own. */
  sessions: ActiveAgentSessionDto[];
  children: AgentTreeNode[];
  /** 0 for roots. Exact — the renderer clamps indent separately. */
  depth: number;
  /** Timestamp when the conversation was last updated. */
  updatedAt?: number;
  /** True when this node represents a completed unread conversation. */
  isUnread?: boolean;
  /** Last status event payload (done/error) if any. */
  lastStatus?: AgentStatus;
  /** Newest session's profile/agent (completed rows; live rows use `sessions`). */
  lastProfileId?: string;
  lastAgentType?: string;
}

function earliestStartedAt(node: AgentTreeNode): number {
  let min = Infinity;
  for (const s of node.sessions) {
    if (s.startedAt < min) min = s.startedAt;
  }
  for (const child of node.children) {
    const childMin = earliestStartedAt(child);
    if (childMin < min) min = childMin;
  }
  return min;
}

function compareNodes(a: AgentTreeNode, b: AgentTreeNode): number {
  const ea = earliestStartedAt(a);
  const eb = earliestStartedAt(b);
  if (ea !== eb) return ea - eb;
  const titleCmp = a.title.localeCompare(b.title);
  if (titleCmp !== 0) return titleCmp;
  return a.conversationId.localeCompare(b.conversationId);
}

function sortForest(nodes: AgentTreeNode[]): void {
  nodes.sort(compareNodes);
  for (const n of nodes) sortForest(n.children);
}

function assignDepth(nodes: AgentTreeNode[], depth: number): void {
  for (const n of nodes) {
    n.depth = depth;
    const nextDepth = n.kind === 'schedule_home' ? 0 : depth + 1;
    assignDepth(n.children, nextDepth);
  }
}

function isAncestorOf(
  maybeAncestorId: string,
  nodeId: string,
  parentOf: Map<string, string>,
): boolean {
  let cur: string | undefined = nodeId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === maybeAncestorId) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

/** Flat payload → forest. Deterministic ordering (see plan D3). */
export function buildAgentTree(payload: ActiveSessionsResponse): AgentTreeNode[] {
  const projectById = new Map(payload.projects.map((p) => [p.id, p.name]));
  const nodes = new Map<string, AgentTreeNode>();

  for (const c of payload.conversations) {
    nodes.set(c.id, {
      conversationId: c.id,
      title: c.title,
      projectId: c.projectId,
      ...(c.projectId && projectById.has(c.projectId)
        ? { projectName: projectById.get(c.projectId) }
        : {}),
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.description ? { description: c.description } : {}),
      ...(c.tags && c.tags.length > 0 ? { tags: c.tags } : {}),
      sessions: [],
      children: [],
      depth: 0,
    });
  }

  for (const s of payload.sessions) {
    let node = nodes.get(s.conversationId);
    if (!node) {
      node = {
        conversationId: s.conversationId,
        title: '(deleted conversation)',
        projectId: '',
        sessions: [],
        children: [],
        depth: 0,
      };
      nodes.set(s.conversationId, node);
    }
    node.sessions.push(s);
  }

  const parentOf = new Map<string, string>();
  const attached = new Set<string>();

  for (const c of payload.conversations) {
    const node = nodes.get(c.id);
    if (!node) continue;
    const parentId = c.parentConversationId;
    if (!parentId || !nodes.has(parentId) || parentId === c.id) continue;
    if (isAncestorOf(c.id, parentId, parentOf)) continue;
    const parent = nodes.get(parentId)!;
    parent.children.push(node);
    parentOf.set(c.id, parentId);
    attached.add(c.id);
  }

  const roots: AgentTreeNode[] = [];
  for (const node of nodes.values()) {
    if (!attached.has(node.conversationId)) roots.push(node);
  }

  sortForest(roots);
  assignDepth(roots, 0);
  return roots;
}

/** Horizontal distance (px) from a row's left edge to the chevron/spacer centre
 *  at `depth` — the column where a parent's tree rail runs. Clamped to the
 *  same max indent the renderer uses. */
export function agentGuideX(depth: number): number {
  return 16 + Math.min(depth, 6) * 14;
}

/** One vertical rail segment drawn behind a row, connecting it to an ancestor. */
export interface AgentTreeGuide {
  /** Distance in px from the row's left edge to the rail. */
  x: number;
  /** True when the branch ends with this row: the rail stops at the row's
   *  mid-line (elbow) instead of continuing to a following sibling. */
  last: boolean;
}

/** A flattened node plus the rails needed to render it inside a tree. */
export interface AgentTreeRow {
  node: AgentTreeNode;
  /** One entry per ancestor level, outermost first. */
  guides: AgentTreeGuide[];
}

/** Depth-first pre-order with tree-rail metadata; children of a collapsed
 *  conversation are omitted. */
export function flattenAgentRows(
  roots: readonly AgentTreeNode[],
  collapsed: ReadonlySet<string>,
): AgentTreeRow[] {
  const out: AgentTreeRow[] = [];
  const walk = (
    nodes: readonly AgentTreeNode[],
    xs: readonly number[],
    lastChain: readonly boolean[],
  ): void => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      const isLast = i === nodes.length - 1;
      // lastChain[k] = whether the ancestor at depth k was a last child; the
      // rail at level k elbows iff the chain child at depth k+1 (this node for
      // k = depth-1) is its parent's last child.
      out.push({
        node: n,
        guides: xs.map((x, k) => ({ x, last: k + 1 < lastChain.length ? lastChain[k + 1]! : isLast })),
      });
      if (!collapsed.has(n.conversationId)) {
        walk(n.children, [...xs, agentGuideX(n.depth)], [...lastChain, isLast]);
      }
    }
  };
  walk(roots, [], []);
  return out;
}

/** Depth-first pre-order; children of a collapsed conversation are omitted. */
export function flattenAgentTree(
  roots: readonly AgentTreeNode[],
  collapsed: ReadonlySet<string>,
): AgentTreeNode[] {
  return flattenAgentRows(roots, collapsed).map((r) => r.node);
}

/** A project-scoped box of top-level conversations for the Active Agents modal. */
export interface AgentProjectGroup {
  projectId: string;
  /** Undefined when no root names the project (deleted conversation). */
  projectName?: string;
  /** Total live sessions across the group's subtrees. */
  running: number;
  roots: AgentTreeNode[];
}

/** Group a forest by project. Named projects sort alphabetically first;
 *  unknown-project roots ('' id) form a trailing group. */
export function groupAgentForest(roots: readonly AgentTreeNode[]): AgentProjectGroup[] {
  const groups = new Map<string, AgentProjectGroup>();
  for (const root of roots) {
    let group = groups.get(root.projectId);
    if (!group) {
      group = {
        projectId: root.projectId,
        ...(root.projectName ? { projectName: root.projectName } : {}),
        running: 0,
        roots: [],
      };
      groups.set(root.projectId, group);
    }
    if (!group.projectName && root.projectName) group.projectName = root.projectName;
    group.running += subtreeSessionCount(root);
    group.roots.push(root);
  }
  return [...groups.values()].sort((a, b) => {
    const an = a.projectName ?? '';
    const bn = b.projectName ?? '';
    if (an === '' && bn !== '') return 1;
    if (an !== '' && bn === '') return -1;
    const byName = an.localeCompare(bn, undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return a.projectId.localeCompare(b.projectId);
  });
}

/** A single root conversation and its flattened subtree rows for the Active Agents modal. */
export interface AgentRootTree {
  root: AgentTreeNode;
  rows: AgentTreeRow[];
}

export const RECENT_OPTIONS = [
  { label: 'All', value: 0 },
  { label: '24 h', value: 1 },
  { label: '3 days', value: 3 },
  { label: '1 week', value: 7 },
] as const;

export type RecentOptionValue = (typeof RECENT_OPTIONS)[number]['value'];

/** Human-readable relative time string (e.g. 'just now', '5m ago', '2h ago', '3d ago'). */
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const delta = ms - now;
  const abs = Math.abs(delta);
  if (abs < 60_000) return 'just now';
  const mins = Math.round(abs / 60_000);
  if (mins < 60) return delta > 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return delta > 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return delta > 0 ? `in ${days}d` : `${days}d ago`;
}

/** Check if a conversation is no longer running and unread. */
export function isCompletedUnread(
  conv: Conversation,
  runningConvIds: ReadonlySet<string>,
  unreadConvIds: ReadonlySet<string>,
): boolean {
  if (conv.kind === 'schedule_home') return false;
  if (conv.archived) return false;
  if (runningConvIds.has(conv.id) || conv.isActive || conv.liveStatus === 'running' || conv.liveStatus === 'waiting') {
    return false;
  }
  return unreadConvIds.has(conv.id) || conv.lastStatus === 'done' || conv.lastStatus === 'error';
}

export interface BuildCompletedAgentTreeOpts {
  conversations: Record<string, Conversation[]> | Conversation[];
  projects: { id: string; name: string }[];
  runningConversationIds: ReadonlySet<string>;
  unreadConversationIds: ReadonlySet<string>;
  recentDays?: number;
  now?: number;
}

export function buildCompletedAgentTree(opts: BuildCompletedAgentTreeOpts): AgentTreeNode[] {
  const {
    projects,
    runningConversationIds,
    unreadConversationIds,
    recentDays = 0,
    now = Date.now(),
  } = opts;

  const allConvs: Conversation[] = Array.isArray(opts.conversations)
    ? opts.conversations
    : Object.values(opts.conversations).flat();

  const convById = new Map<string, Conversation>();
  for (const c of allConvs) {
    convById.set(c.id, c);
  }

  const projectById = new Map(projects.map((p) => [p.id, p.name]));

  const threshold = recentDays * 86_400_000;
  const keepIds = new Set<string>();

  for (const c of allConvs) {
    if (!isCompletedUnread(c, runningConversationIds, unreadConversationIds)) {
      continue;
    }
    if (recentDays === 0 || (now - c.updatedAt < threshold)) {
      keepIds.add(c.id);
    }
  }

  // Preserve ancestors so child conversations remain nested under parents
  let added = true;
  while (added) {
    added = false;
    for (const id of Array.from(keepIds)) {
      const c = convById.get(id);
      if (c?.parentConversationId && !keepIds.has(c.parentConversationId)) {
        if (convById.has(c.parentConversationId)) {
          keepIds.add(c.parentConversationId);
          added = true;
        }
      }
    }
  }

  const nodes = new Map<string, AgentTreeNode>();
  for (const id of keepIds) {
    const c = convById.get(id)!;
    const isUnread = isCompletedUnread(c, runningConversationIds, unreadConversationIds);
    nodes.set(c.id, {
      conversationId: c.id,
      title: c.title,
      projectId: c.projectId,
      ...(c.projectId && projectById.has(c.projectId)
        ? { projectName: projectById.get(c.projectId) }
        : {}),
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.description ? { description: c.description } : {}),
      ...(c.tags && c.tags.length > 0 ? { tags: c.tags } : {}),
      sessions: [],
      children: [],
      depth: 0,
      updatedAt: c.updatedAt,
      isUnread,
      lastStatus: c.lastStatus,
      ...(c.lastProfileId ? { lastProfileId: c.lastProfileId } : {}),
      ...(c.lastAgentType ? { lastAgentType: c.lastAgentType } : {}),
    });
  }

  const parentOf = new Map<string, string>();
  const attached = new Set<string>();

  for (const id of keepIds) {
    const c = convById.get(id)!;
    const parentId = c.parentConversationId;
    if (!parentId || !nodes.has(parentId) || parentId === c.id) continue;
    if (isAncestorOf(c.id, parentId, parentOf)) continue;
    const parent = nodes.get(parentId)!;
    const node = nodes.get(c.id)!;
    parent.children.push(node);
    parentOf.set(c.id, parentId);
    attached.add(c.id);
  }

  const roots: AgentTreeNode[] = [];
  for (const node of nodes.values()) {
    if (!attached.has(node.conversationId)) roots.push(node);
  }

  // Sort roots by recency (newest updatedAt first), then title
  roots.sort((a, b) => {
    const aTime = a.updatedAt ?? 0;
    const bTime = b.updatedAt ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.title.localeCompare(b.title);
  });

  for (const r of roots) {
    sortSubtreeByRecency(r);
  }

  assignDepth(roots, 0);
  return roots;
}

function sortSubtreeByRecency(node: AgentTreeNode): void {
  node.children.sort((a, b) => {
    const aTime = a.updatedAt ?? 0;
    const bTime = b.updatedAt ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.title.localeCompare(b.title);
  });
  for (const c of node.children) {
    sortSubtreeByRecency(c);
  }
}

export interface CompletedProjectGroup {
  projectId: string;
  projectName?: string;
  completed: number;
  roots: AgentTreeNode[];
}

/** Total completed unread conversations in this node's subtree. */
export function subtreeCompletedCount(node: AgentTreeNode): number {
  let count = node.isUnread ? 1 : 0;
  for (const child of node.children) count += subtreeCompletedCount(child);
  return count;
}

export function groupCompletedAgentForest(roots: readonly AgentTreeNode[]): CompletedProjectGroup[] {
  const groups = new Map<string, CompletedProjectGroup>();
  for (const root of roots) {
    let group = groups.get(root.projectId);
    if (!group) {
      group = {
        projectId: root.projectId,
        ...(root.projectName ? { projectName: root.projectName } : {}),
        completed: 0,
        roots: [],
      };
      groups.set(root.projectId, group);
    }
    if (!group.projectName && root.projectName) group.projectName = root.projectName;
    group.completed += subtreeCompletedCount(root);
    group.roots.push(root);
  }
  return [...groups.values()].sort((a, b) => {
    const an = a.projectName ?? '';
    const bn = b.projectName ?? '';
    if (an === '' && bn !== '') return 1;
    if (an !== '' && bn === '') return -1;
    const byName = an.localeCompare(bn, undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return a.projectId.localeCompare(b.projectId);
  });
}

/** Flatten each root of a project group into its own tree with guides. */
export function flattenProjectRootTrees(
  group: { roots: AgentTreeNode[] },
  collapsed: ReadonlySet<string>,
): AgentRootTree[] {
  return group.roots.map((root) => ({
    root,
    rows: flattenAgentRows([root], collapsed),
  }));
}

/** Total live sessions in this node's subtree, including its own. */
export function subtreeSessionCount(node: AgentTreeNode): number {
  let count = node.sessions.length;
  for (const child of node.children) count += subtreeSessionCount(child);
  return count;
}

/**
 * Sidebar-vocabulary status indicator for an Active Agents modal row.
 * Live session rows use running|waiting|error. Ancestor placeholders with
 * live descendants use descendant-active (hollow spawn ring — same as the
 * sidebar). Other idle/done/absent fall through to grey. Spawned children
 * (depth > 0) add the hollow-diamond modifier. Schedule-home headers skip
 * this helper and keep the ⏱ icon.
 */
export function activeAgentDotClass(
  status: AgentStatus | undefined,
  depth: number,
  descendantActive = false,
  isUnread = false,
): string {
  const kind = status === 'running' || status === 'waiting' || status === 'error'
    ? status
    : isUnread
      ? 'unread'
      : descendantActive
        ? 'descendant-active'
        : 'grey';
  const base = `status-dot ${kind}`;
  return depth > 0 ? `${base} subagent-diamond` : base;
}

/** Structured Active Agents meta line: runtime, model, project — each once. */
export interface SessionMetaParts {
  agent: string;
  model: string;
  project: string;
}

/**
 * Compose the three meta roles for an Active Agents session row.
 *
 * Catalogue `label`s are typically `"Runtime · PrettyModel"`, and the session
 * also carries a separate `model` that used to be appended again. Split the
 * label on ` · ` so each role can render in its own span. If the session
 * model already appears as a label segment, it is not appended; if the label
 * already has a model remainder, that remainder wins over a different model
 * id so we never show both "Fable 5" and "claude-fable-5".
 */
export function sessionMetaParts(
  label: string,
  model?: string,
  projectName?: string,
): SessionMetaParts {
  const rawLabel = label.trim();
  const rawModel = (model ?? '').trim();
  const project = (projectName ?? '').trim();
  const segments = rawLabel ? rawLabel.split(/\s*·\s*/).filter((s) => s.length > 0) : [];

  if (segments.length >= 2) {
    return {
      agent: segments[0]!,
      model: segments.slice(1).join(' · '),
      project,
    };
  }

  const agent = segments[0] ?? '';
  if (rawModel && agent === rawModel) {
    return { agent: '', model: rawModel, project };
  }
  return { agent, model: rawModel, project };
}

/**
 * Row label for a session: the catalogue label, prefixed with the agent's
 * display name when the label is model-only ("GLM-5.3-Flash" → "Kilo Code ·
 * GLM-5.3-Flash") so sessionMetaParts always has an agent segment.
 */
export function activityAgentLabel(label: string | undefined, agentType: string): string {
  const agent = agentDisplayName(agentType);
  const l = (label ?? '').trim();
  if (!l) return agent;
  if (l.includes('·') || l.toLowerCase().startsWith(agent.toLowerCase())) return l;
  return `${agent} · ${l}`;
}

/**
 * Resolves the CSS class for the topbar Agent Activity button.
 */
export function agentActivityButtonClass(
  isOpen: boolean,
  activeCount: number,
  timedCount = 0,
): string {
  const base = 'theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn';
  const openClass = isOpen ? ' active' : '';
  const statusClass = activeCount > 0
    ? ' has-active'
    : timedCount > 0
      ? ' has-timed'
      : '';
  return `${base}${openClass}${statusClass}`;
}

export const activeAgentsButtonClass = agentActivityButtonClass;

function collectUnreadFromNode(node: AgentTreeNode, ids: string[]): void {
  if (node.isUnread) ids.push(node.conversationId);
  for (const child of node.children) {
    collectUnreadFromNode(child, ids);
  }
}

/**
 * Collect all unread conversation IDs from completed project groups.
 */
export function collectUnreadConversationIds(groups: readonly { roots: AgentTreeNode[] }[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const root of group.roots) {
      collectUnreadFromNode(root, ids);
    }
  }
  return ids;
}

export interface PendingTimerProjectGroup {
  projectId: string;
  projectName: string | null;
  timers: PendingTimerSummary[];
}

/**
 * Group pending timers by project preserving first-appearance order (input is
 * already sorted soonest-first, so the project with the soonest timer is first).
 * Timers within each project preserve input order.
 */
export function groupPendingTimers(timers: readonly PendingTimerSummary[]): PendingTimerProjectGroup[] {
  const groups: PendingTimerProjectGroup[] = [];
  const byProject = new Map<string, PendingTimerProjectGroup>();
  for (const t of timers) {
    let group = byProject.get(t.projectId);
    if (!group) {
      group = {
        projectId: t.projectId,
        projectName: t.projectName,
        timers: [],
      };
      byProject.set(t.projectId, group);
      groups.push(group);
    }
    group.timers.push(t);
  }
  return groups;
}

/**
 * Time label for a timed row: "firing…" when fireAtMs - nowServerMs <= 0,
 * otherwise "in <countdownLabel>".
 */
export function timedRowTimeLabel(fireAtMs: number, nowServerMs: number): string {
  const diff = fireAtMs - nowServerMs;
  if (diff <= 0) return 'firing…';
  return `in ${countdownLabel(diff)}`;
}

export type AttentionReason = 'waiting' | 'error' | 'spawn_approval';

export interface AttentionItem {
  conversationId: string;
  title: string;
  projectId: string;
  projectName?: string;
  /** Ordered waiting, error, spawn_approval. Never contains both waiting and error. */
  reasons: AttentionReason[];
  pendingSpawnRequests: number;
  /** Sort key: max(conv.updatedAt, live session startedAt, pending spawn createdAt). */
  at: number;
  isChild: boolean;
  /** Live session's profile, else the conversation's newest session. */
  profileId?: string;
  agentType?: string;
}

export interface BuildAttentionOpts {
  sessions: readonly ActiveAgentSessionDto[];
  payloadConversations: readonly ActiveAgentConversationDto[];
  payloadProjects: readonly { id: string; name: string }[];
  conversations: Record<string, Conversation[]> | Conversation[];
  projects: readonly { id: string; name: string }[];
  conversationStatuses: Readonly<Record<string, AgentStatus>>;
  errorRecoveredIds: ReadonlySet<string>;
  spawnRequests: readonly SpawnRequestRow[];
}

export interface AttentionProjectGroup {
  projectId: string;
  projectName?: string;
  items: AttentionItem[];
}

function flattenDirectoryConversations(
  conversations: Record<string, Conversation[]> | Conversation[],
): Conversation[] {
  return Array.isArray(conversations) ? conversations : Object.values(conversations).flat();
}

export function buildAttentionItems(opts: BuildAttentionOpts): AttentionItem[] {
  const dirList = flattenDirectoryConversations(opts.conversations);
  const convById = new Map(dirList.map((c) => [c.id, c]));
  const pconvById = new Map(opts.payloadConversations.map((c) => [c.id, c]));
  const projectById = new Map(opts.projects.map((p) => [p.id, p.name]));
  for (const p of opts.payloadProjects) {
    if (!projectById.has(p.id)) projectById.set(p.id, p.name);
  }

  const candidateIds = new Set<string>();
  for (const s of opts.sessions) candidateIds.add(s.conversationId);
  for (const c of dirList) candidateIds.add(c.id);
  for (const id of Object.keys(opts.conversationStatuses)) candidateIds.add(id);
  for (const r of opts.spawnRequests) candidateIds.add(r.parentConversationId);

  const sessionsByConv = new Map<string, ActiveAgentSessionDto[]>();
  for (const s of opts.sessions) {
    const list = sessionsByConv.get(s.conversationId);
    if (list) list.push(s);
    else sessionsByConv.set(s.conversationId, [s]);
  }

  const items: AttentionItem[] = [];
  for (const id of candidateIds) {
    const conv = convById.get(id);
    const pconv = pconvById.get(id);
    if (conv?.archived) continue;
    if ((conv ?? pconv)?.kind === 'schedule_home') continue;

    const liveSessions = sessionsByConv.get(id) ?? [];
    const live = liveSessions.map((s) => s.status);
    const ws = opts.conversationStatuses[id];
    const waiting = live.includes('waiting') || ws === 'waiting';
    const running = live.includes('running') || ws === 'running';
    const errorSignal = live.includes('error') || ws === 'error' || conv?.lastStatus === 'error';
    const error = !waiting && !running && !!errorSignal && !opts.errorRecoveredIds.has(id);
    const pending = opts.spawnRequests.filter((r) => r.parentConversationId === id && r.status === 'pending');
    const approvals = pending.length;

    if (!waiting && !error && approvals === 0) continue;
    if (!conv && !pconv && approvals === 0) continue;

    const reasons: AttentionReason[] = [];
    if (waiting) reasons.push('waiting');
    else if (error) reasons.push('error');
    if (approvals > 0) reasons.push('spawn_approval');

    let at = conv?.updatedAt ?? 0;
    for (const s of liveSessions) {
      if (s.startedAt > at) at = s.startedAt;
    }
    for (const r of pending) {
      if (r.createdAt > at) at = r.createdAt;
    }

    const projectId = conv?.projectId ?? pconv?.projectId ?? '';
    const projectName = projectId ? projectById.get(projectId) : undefined;
    items.push({
      conversationId: id,
      title: conv?.title ?? pconv?.title ?? '(unknown conversation)',
      projectId,
      ...(projectName ? { projectName } : {}),
      reasons,
      pendingSpawnRequests: approvals,
      at,
      isChild: !!(conv?.parentConversationId ?? pconv?.parentConversationId),
      ...((liveSessions[0]?.profileId ?? conv?.lastProfileId) ? { profileId: liveSessions[0]?.profileId ?? conv?.lastProfileId } : {}),
      ...((liveSessions[0]?.agentType ?? conv?.lastAgentType) ? { agentType: liveSessions[0]?.agentType ?? conv?.lastAgentType } : {}),
    });
  }

  items.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    const byTitle = a.title.localeCompare(b.title);
    if (byTitle !== 0) return byTitle;
    return a.conversationId.localeCompare(b.conversationId);
  });
  return items;
}

/** Group attention items by project, preserving first-appearance order. */
export function groupAttentionItems(items: readonly AttentionItem[]): AttentionProjectGroup[] {
  const groups: AttentionProjectGroup[] = [];
  const byProject = new Map<string, AttentionProjectGroup>();
  for (const item of items) {
    let group = byProject.get(item.projectId);
    if (!group) {
      group = {
        projectId: item.projectId,
        ...(item.projectName ? { projectName: item.projectName } : {}),
        items: [],
      };
      byProject.set(item.projectId, group);
      groups.push(group);
    }
    if (!group.projectName && item.projectName) group.projectName = item.projectName;
    group.items.push(item);
  }
  return groups;
}

export function attentionReasonLabel(reason: AttentionReason, pendingSpawnRequests = 0): string {
  if (reason === 'waiting') return 'Needs input';
  if (reason === 'error') return 'Error';
  if (pendingSpawnRequests > 1) return `Spawn approvals (${pendingSpawnRequests})`;
  return 'Spawn approval';
}

export function attentionDotStatus(item: AttentionItem): AgentStatus {
  if (item.reasons.includes('waiting') || item.reasons.includes('spawn_approval')) return 'waiting';
  return 'error';
}

