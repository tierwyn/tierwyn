import { describe, it, expect } from 'vitest';
import type { Conversation, Project, RemoteHostView } from '@tierwyn/shared';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { PINNED_PROJECT_ID } from './pinned.js';
import {
  newlySpawnedParents,
  parseGroupBy,
  parseProjectOrder,
  parseSearchScope,
  resolveSearchScopeProjectId,
  bucketFromDot,
  filterConversations,
  activityAt,
  subtreeActivity,
  orderProjects,
  groupProjectsByHost,
  hostBadgedProjectOptions,
  projectScheduleDeleteNote,
  scheduleProjectActivity,
  layoutScheduleProjects,
  buildRecentRows,
  buildStatusBuckets,
  aggregateCounts,
  clampSidebarWidth,
  parseStoredSidebarWidth,
  SIDEBAR_W_MIN,
  SIDEBAR_W_MAX,
  SIDEBAR_W_DEFAULT,
} from './sidebarViews.js';

function makeConv(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
    projectId: 'proj-1',
    title: 'Test Conversation',
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

function makeProject(partial: Partial<Project> & { id: string; name: string }): Project {
  return {
    rootPath: `/tmp/${partial.name}`,
    createdAt: 1000,
    ...partial,
  };
}

describe('sidebarViews pure logic', () => {
  describe('parseGroupBy and parseProjectOrder', () => {
    it('parses valid group by values, defaults to project', () => {
      expect(parseGroupBy('project')).toBe('project');
      expect(parseGroupBy('host')).toBe('host');
      expect(parseGroupBy('recent')).toBe('recent');
      expect(parseGroupBy('status')).toBe('status');
      expect(parseGroupBy(null)).toBe('project');
      expect(parseGroupBy('unknown')).toBe('project');
      expect(parseGroupBy('')).toBe('project');
    });

    it('parses valid project orders, defaults to created', () => {
      expect(parseProjectOrder('created')).toBe('created');
      expect(parseProjectOrder('activity')).toBe('activity');
      expect(parseProjectOrder('name')).toBe('name');
      expect(parseProjectOrder(null)).toBe('created');
      expect(parseProjectOrder('invalid')).toBe('created');
      expect(parseProjectOrder('')).toBe('created');
    });
  });

  describe('bucketFromDot', () => {
    it('maps all dot classes correctly to status buckets', () => {
      expect(bucketFromDot({ dotClass: 'status-dot waiting', title: 'waiting' })).toBe('waiting');
      expect(bucketFromDot({ dotClass: 'status-dot error', title: 'error' })).toBe('error');
      expect(bucketFromDot({ dotClass: 'status-dot running', title: 'running' })).toBe('running');
      expect(bucketFromDot({ dotClass: 'status-dot descendant-active', title: 'subagent active' })).toBe('subagents');
      expect(bucketFromDot({ dotClass: 'status-dot unread', title: 'unread' })).toBe('unread');
      expect(bucketFromDot({ dotClass: 'status-dot done', title: 'recent' })).toBe('unread');
      expect(bucketFromDot({ dotClass: 'status-dot helpers-active', title: 'helpers running' })).toBe('idle');
      expect(bucketFromDot({ dotClass: 'status-dot grey', title: 'idle' })).toBe('idle');
      expect(bucketFromDot({ dotClass: 'status-dot job-enabled', title: 'armed' })).toBe('idle');
      expect(bucketFromDot({ dotClass: 'status-dot disabled', title: 'disabled' })).toBe('idle');
      expect(bucketFromDot({ dotClass: 'status-dot', title: 'none' })).toBe('idle');
    });

    it('maps running spawn child (with parentConversationId) to subagents bucket so ◇ badge matches row diamond', () => {
      const child = makeConv({ id: 'ch1', parentConversationId: 'p1' });
      const root = makeConv({ id: 'p1' });
      expect(bucketFromDot({ dotClass: 'status-dot running', title: 'running' }, child)).toBe('subagents');
      expect(bucketFromDot({ dotClass: 'status-dot running', title: 'running' }, root)).toBe('running');
      expect(bucketFromDot({ dotClass: 'status-dot waiting', title: 'waiting' }, child)).toBe('waiting');
      expect(bucketFromDot({ dotClass: 'status-dot error', title: 'error' }, child)).toBe('error');
    });
  });

  describe('filterConversations', () => {
    const conv1 = makeConv({ id: 'c1', title: 'Alpha', updatedAt: 50_000, tags: ['frontend'] });
    const conv2 = makeConv({ id: 'c2', title: 'Beta', updatedAt: 10_000, parentConversationId: 'c1', tags: ['bug'] });
    const conv3 = makeConv({ id: 'c3', title: 'Gamma', updatedAt: 2_000, tags: ['backend'] });
    const convArchivedRoot = makeConv({ id: 'c4', title: 'Old Root', updatedAt: 1_000, archived: true });
    const convArchivedChild = makeConv({ id: 'c5', title: 'Old Child', updatedAt: 1_500, parentConversationId: 'c4' });

    it('filters by recency window and keeps ancestors, selected conv, and content hits', () => {
      const now = 60_000;
      const recentDays = 0.0003; // ~25.9 seconds window
      // threshold: 60000 - 25.9s = ~34100
      // conv1 updatedAt 50_000 (kept by recency)
      // conv2 updatedAt 10_000 (older than threshold)
      const res = filterConversations([conv1, conv2, conv3], {
        recentDays,
        now,
        selectedConversationId: 'c2', // explicitly selected -> must survive!
        showArchived: false,
        activeTag: null,
        searchQuery: '',
        contentSearch: false,
        contentHitIds: new Set(),
      });
      expect(res.map((c) => c.id)).toContain('c1');
      expect(res.map((c) => c.id)).toContain('c2');
      expect(res.map((c) => c.id)).not.toContain('c3');
    });

    it('keeps ancestors of recency matches even if parent is old', () => {
      const oldParent = makeConv({ id: 'p1', title: 'Old Parent', updatedAt: 1_000 });
      const recentChild = makeConv({ id: 'ch1', title: 'Recent Child', parentConversationId: 'p1', updatedAt: 90_000 });
      const res = filterConversations([oldParent, recentChild], {
        recentDays: 0.0003,
        now: 100_000,
        selectedConversationId: null,
        showArchived: false,
        activeTag: null,
        searchQuery: '',
        contentSearch: false,
        contentHitIds: new Set(),
      });
      expect(res.map((c) => c.id)).toEqual(['ch1', 'p1']);
    });

    it('respects root-archived semantics for children', () => {
      const list = [convArchivedRoot, convArchivedChild, conv1];
      // When showArchived is false
      const unarchived = filterConversations(list, {
        recentDays: 0,
        now: 100_000,
        selectedConversationId: null,
        showArchived: false,
        activeTag: null,
        searchQuery: '',
        contentSearch: false,
        contentHitIds: new Set(),
      });
      expect(unarchived.map((c) => c.id)).toEqual(['c1']);

      // When showArchived is true: both archived root and child survive
      const archived = filterConversations(list, {
        recentDays: 0,
        now: 100_000,
        selectedConversationId: null,
        showArchived: true,
        activeTag: null,
        searchQuery: '',
        contentSearch: false,
        contentHitIds: new Set(),
      });
      expect(archived.map((c) => c.id)).toContain('c4');
      expect(archived.map((c) => c.id)).toContain('c5');
    });

    it('combines tag and search filter with AND logic', () => {
      const res = filterConversations([conv1, conv2, conv3], {
        recentDays: 0,
        now: 100_000,
        selectedConversationId: null,
        showArchived: false,
        activeTag: 'frontend',
        searchQuery: 'alph',
        contentSearch: false,
        contentHitIds: new Set(),
      });
      expect(res.map((c) => c.id)).toEqual(['c1']);
    });

    it('statusFilter keeps matching conversations and their ancestors', () => {
      const parent = makeConv({ id: 'p1', title: 'Idle Parent', updatedAt: 2000 });
      const child = makeConv({ id: 'ch1', title: 'Waiting Child', parentConversationId: 'p1', updatedAt: 3000 });
      const other = makeConv({ id: 'o1', title: 'Idle Other', updatedAt: 1000 });

      const res = filterConversations([parent, child, other], {
        recentDays: 0,
        now: 100_000,
        selectedConversationId: null,
        showArchived: false,
        activeTag: null,
        searchQuery: '',
        contentSearch: false,
        contentHitIds: new Set(),
        statusFilter: new Set(['waiting']),
        bucketOf: (c) => (c.id === 'ch1' ? 'waiting' : 'idle'),
      });

      expect(res.map((c) => c.id)).toContain('ch1');
      expect(res.map((c) => c.id)).toContain('p1'); // Ancestor preserved
      expect(res.map((c) => c.id)).not.toContain('o1');
    });

    it('statusFilter survives recentDays threshold even when older than window', () => {
      const oldParent = makeConv({ id: 'p1', title: 'Old Parent', updatedAt: 1000 });
      const oldChild = makeConv({ id: 'ch1', title: 'Old Unread Child', parentConversationId: 'p1', updatedAt: 2000 });
      const otherOld = makeConv({ id: 'o1', title: 'Old Idle', updatedAt: 1500 });

      const res = filterConversations([oldParent, oldChild, otherOld], {
        recentDays: 0.0001, // ~8.6s window, threshold 99991360
        now: 100_000_000,
        selectedConversationId: null,
        showArchived: false,
        activeTag: null,
        searchQuery: '',
        contentSearch: false,
        contentHitIds: new Set(),
        statusFilter: new Set(['unread']),
        bucketOf: (c) => (c.id === 'ch1' ? 'unread' : 'idle'),
      });

      expect(res.map((c) => c.id)).toContain('ch1');
      expect(res.map((c) => c.id)).toContain('p1'); // Ancestor preserved
      expect(res.map((c) => c.id)).not.toContain('o1');
    });

    it('combines statusFilter with searchQuery and preserves ancestors', () => {
      const parent = makeConv({ id: 'p1', title: 'Main Project Flow', updatedAt: 5000 });
      const matchChild = makeConv({ id: 'ch1', title: 'Feature bug fix', parentConversationId: 'p1', updatedAt: 6000 });
      const otherChild = makeConv({ id: 'ch2', title: 'Feature docs', parentConversationId: 'p1', updatedAt: 7000 });

      const res = filterConversations([parent, matchChild, otherChild], {
        recentDays: 0,
        now: 100_000,
        selectedConversationId: null,
        showArchived: false,
        activeTag: null,
        searchQuery: 'bug',
        contentSearch: false,
        contentHitIds: new Set(),
        statusFilter: new Set(['unread']),
        bucketOf: (c) => (c.id === 'ch1' || c.id === 'ch2' ? 'unread' : 'idle'),
      });

      expect(res.map((c) => c.id)).toContain('ch1'); // Matches query + status
      expect(res.map((c) => c.id)).toContain('p1'); // Ancestor of matchChild
      expect(res.map((c) => c.id)).not.toContain('ch2'); // Does not match search query
    });
  });

  describe('activityAt and subtreeActivity', () => {
    it('activityAt returns max of updatedAt and live timestamp', () => {
      const conv = makeConv({ id: 'c1', updatedAt: 5000 });
      expect(activityAt(conv, {})).toBe(5000);
      expect(activityAt(conv, { c1: 9000 })).toBe(9000);
      expect(activityAt(conv, { c1: 2000 })).toBe(5000);
    });

    it('subtreeActivity returns max over root and descendant subtree', () => {
      const root = makeConv({ id: 'r1', updatedAt: 1000 });
      const ch1 = makeConv({ id: 'ch1', parentConversationId: 'r1', updatedAt: 2000 });
      const ch2 = makeConv({ id: 'ch2', parentConversationId: 'r1', updatedAt: 3000 });
      const grandKid = makeConv({ id: 'gk', parentConversationId: 'ch1', updatedAt: 8000 });

      const childrenByParent = new Map<string, Conversation[]>([
        ['r1', [ch1, ch2]],
        ['ch1', [grandKid]],
      ]);

      expect(subtreeActivity(root, childrenByParent, {})).toBe(8000);
      expect(subtreeActivity(root, childrenByParent, { ch2: 12000 })).toBe(12000);
      expect(subtreeActivity('r1', childrenByParent, { r1: 15000 }, root)).toBe(15000);
    });
  });

  describe('orderProjects', () => {
    const p1 = makeProject({ id: 'p1', name: 'Zebra', createdAt: 100 });
    const p2 = makeProject({ id: 'p2', name: 'Apple', createdAt: 300 });
    const p3 = makeProject({ id: 'p3', name: 'Banana', createdAt: 200 });

    it('orders by created descending', () => {
      const res = orderProjects([p1, p2, p3], 'created', () => 0);
      expect(res.map((p) => p.name)).toEqual(['Apple', 'Banana', 'Zebra']);
    });

    it('orders by name ascending', () => {
      const res = orderProjects([p1, p2, p3], 'name', () => 0);
      expect(res.map((p) => p.name)).toEqual(['Apple', 'Banana', 'Zebra']);
    });

    it('orders by activity descending', () => {
      const activities: Record<string, number> = { p1: 500, p2: 100, p3: 900 };
      const res = orderProjects([p1, p2, p3], 'activity', (pid) => activities[pid] ?? 0);
      expect(res.map((p) => p.name)).toEqual(['Banana', 'Zebra', 'Apple']);
    });
  });

  describe('groupProjectsByHost', () => {
    const pHub = makeProject({ id: 'pHub', name: 'Hub Project' });
    const pBox1 = makeProject({ id: 'pBox1', name: 'Box Project 1', remoteHostId: 'h1' });
    const pBox2 = makeProject({ id: 'pBox2', name: 'Box Project 2', remoteHostId: 'h1' });
    const pUnknown = makeProject({ id: 'pUnk', name: 'Orphan Project', remoteHostId: 'unknown-id' });

    const hosts: RemoteHostView[] = [
      { id: 'h1', name: 'Build Box', state: 'connected', hello: { hostname: 'build-box-01', os: 'linux', arch: 'x64', homedir: '/', roots: [], listenPort: 0, agents: {}, models: {} }, allowMcpSecrets: false, allowAgentEnvSecrets: false, createdAt: 1000 },
      { id: 'h2', name: 'Empty Box', state: 'disconnected', hello: {}, allowMcpSecrets: false, allowAgentEnvSecrets: false, createdAt: 1000 },
    ];

    it('places Hub first, remote hosts sorted by name, omits empty hosts, and adds unknown host at end', () => {
      const groups = groupProjectsByHost([pUnknown, pBox1, pHub, pBox2], hosts);
      expect(groups.length).toBe(3);
      expect(groups[0].key).toBe('hub');
      expect(groups[0].projects).toEqual([pHub]);

      expect(groups[1].key).toBe('h1');
      expect(groups[1].label).toBe('build-box-01');
      expect(groups[1].host?.id).toBe('h1');
      expect(groups[1].state).toBe('connected');
      expect(groups[1].projects).toEqual([pBox1, pBox2]);

      expect(groups[2].key).toBe('unknown');
      expect(groups[2].label).toBe('Unknown host');
      expect(groups[2].projects).toEqual([pUnknown]);
    });
  });

  describe('buildRecentRows', () => {
    it('builds flat rows sorted by subtree activity with proper folding and depths', () => {
      const r1 = makeConv({ id: 'r1', updatedAt: 1000 });
      const ch1 = makeConv({ id: 'ch1', parentConversationId: 'r1', updatedAt: 2000 });
      const r2 = makeConv({ id: 'r2', updatedAt: 5000 });

      // When r1's child has higher live activity than r2, r1 should rise above r2!
      const rows = buildRecentRows([r1, ch1, r2], {
        folded: (id) => id !== 'r1', // r1 is expanded
        live: { ch1: 9000 },
      });

      expect(rows).toEqual([
        { c: r1, depth: 0 },
        { c: ch1, depth: 1 },
        { c: r2, depth: 0 },
      ]);
    });
  });

  describe('buildStatusBuckets', () => {
    it('surfaces active/waiting children individually with breadcrumb and keeps idle children grouped under root', () => {
      const root = makeConv({ id: 'r1', projectId: 'p1', title: 'Root Plan', updatedAt: 1000 });
      const waitingChild = makeConv({ id: 'ch1', projectId: 'p1', parentConversationId: 'r1', title: 'Child Task', updatedAt: 2000 });
      const idleChild = makeConv({ id: 'ch2', projectId: 'p1', parentConversationId: 'r1', title: 'Idle Child', updatedAt: 500 });

      const buckets = buildStatusBuckets([root, waitingChild, idleChild], {
        bucketOf: (c) => (c.id === 'ch1' ? 'waiting' : 'idle'),
        live: {},
        parentTitle: (id) => (id === 'r1' ? 'Root Plan' : undefined),
        projectName: () => 'Tierwyn',
      });

      // Waiting bucket has waitingChild with breadcrumb
      const waitingBucket = buckets.find((b) => b.bucket === 'waiting');
      expect(waitingBucket).toBeDefined();
      expect(waitingBucket?.rows).toEqual([
        { c: waitingChild, depth: 0, breadcrumb: 'Tierwyn › Root Plan' },
      ]);

      // Idle bucket has root, idle child is omitted
      const idleBucket = buckets.find((b) => b.bucket === 'idle');
      expect(idleBucket).toBeDefined();
      expect(idleBucket?.rows).toEqual([
        { c: root, depth: 0, breadcrumb: 'Tierwyn' },
      ]);
    });

    it('sticky selection prevents immediate jump out of unread when opening', () => {
      const conv = makeConv({ id: 'c1', projectId: 'p1', title: 'Now Read', updatedAt: 1000 });
      // dot resolution already says idle, but sticky says unread
      const buckets = buildStatusBuckets([conv], {
        bucketOf: () => 'idle',
        live: {},
        sticky: { id: 'c1', bucket: 'unread' },
        parentTitle: () => undefined,
        projectName: () => 'Tierwyn',
      });

      expect(buckets.map((b) => b.bucket)).toEqual(['unread']);
      expect(buckets[0].rows[0].c.id).toBe('c1');
    });

    it('sticky selection releases if live status becomes waiting, error or running', () => {
      const conv = makeConv({ id: 'c1', projectId: 'p1', title: 'Errored', updatedAt: 1000 });
      const buckets = buildStatusBuckets([conv], {
        bucketOf: () => 'error',
        live: {},
        sticky: { id: 'c1', bucket: 'unread' },
        parentTitle: () => undefined,
        projectName: () => 'Tierwyn',
      });

      expect(buckets.map((b) => b.bucket)).toEqual(['error']);
    });
  });

  describe('aggregateCounts', () => {
    it('aggregates counts across status buckets', () => {
      const c1 = makeConv({ id: 'c1' });
      const c2 = makeConv({ id: 'c2' });
      const c3 = makeConv({ id: 'c3' });
      const c4 = makeConv({ id: 'c4', parentConversationId: 'c1' });
      const c5 = makeConv({ id: 'c5' });
      const c6 = makeConv({ id: 'c6' });

      const buckets: Record<string, any> = {
        c1: 'waiting',
        c2: 'error',
        c3: 'running',
        c4: 'subagents',
        c5: 'unread',
        c6: 'idle',
      };

      const counts = aggregateCounts([c1, c2, c3, c4, c5, c6], (c) => buckets[c.id]);
      expect(counts).toEqual({
        waiting: 1,
        error: 1,
        running: 1,
        subagents: 1,
        unread: 1,
      });
    });

    it('does not double-count an idle parent in subagents bucket when its active spawn child (or grandchild) is in the list', () => {
      const parent = makeConv({ id: 'p1', title: 'Check connection' });
      const activeChild = makeConv({ id: 'ch1', parentConversationId: 'p1', title: 'Claude Opus 5.5' });
      const doneChild = makeConv({ id: 'ch2', parentConversationId: 'p1', title: 'Cursor Grok 4.6' });

      const buckets: Record<string, any> = {
        p1: 'subagents', // descendant-active ring on parent
        ch1: 'subagents', // running spawn child diamond
        ch2: 'idle',
      };

      const counts = aggregateCounts([parent, activeChild, doneChild], (c) => buckets[c.id]);
      expect(counts).toEqual({
        waiting: 0,
        error: 0,
        running: 0,
        subagents: 1,
        unread: 0,
      });

      // Grandchild running: root -> idle mid-child -> running grandchild
      const grandChild = makeConv({ id: 'gc1', parentConversationId: 'ch2', title: 'Grandchild' });
      const deepBuckets: Record<string, any> = {
        p1: 'subagents', // descendant-active
        ch2: 'subagents', // descendant-active
        gc1: 'subagents', // running grandchild
      };
      // Waiting child under idle parent: parent has descendant-active ('subagents'),
      // child has 'waiting'. Only the child should be counted (waiting: 1, subagents: 0).
      const waitingParent = makeConv({ id: 'wp1', title: 'Parent' });
      const waitingChild = makeConv({ id: 'wch1', parentConversationId: 'wp1', title: 'Waiting Child' });
      const waitingBuckets: Record<string, any> = {
        wp1: 'subagents',
        wch1: 'waiting',
      };
      expect(aggregateCounts([waitingParent, waitingChild], (c) => waitingBuckets[c.id])).toEqual({
        waiting: 1,
        error: 0,
        running: 0,
        subagents: 0,
        unread: 0,
      });

      // Missing intermediate parent in list: root -> (missing ch1) -> grandchild
      const orphanGrandchild = makeConv({ id: 'ogc1', parentConversationId: 'missing-ch1' });
      const missingMidBuckets: Record<string, any> = {
        p1: 'subagents',
        ogc1: 'subagents',
      };
      expect(aggregateCounts([parent, orphanGrandchild], (c) => missingMidBuckets[c.id])).toEqual({
        waiting: 0,
        error: 0,
        running: 0,
        subagents: 1,
        unread: 0,
      });
    });
  });

  describe('clampSidebarWidth and parseStoredSidebarWidth', () => {
    it('clamps width within [SIDEBAR_W_MIN, min(SIDEBAR_W_MAX, viewportW - MAIN_MIN)]', () => {
      // normal viewport 1440
      expect(clampSidebarWidth(360, 1440)).toBe(360);
      expect(clampSidebarWidth(200, 1440)).toBe(SIDEBAR_W_MIN); // 340
      expect(clampSidebarWidth(700, 1440)).toBe(SIDEBAR_W_MAX); // 560

      // small viewport 700: 700 - 480 = 220 < 340 -> clamps to 340
      expect(clampSidebarWidth(400, 700)).toBe(340);
      expect(clampSidebarWidth(100, 700)).toBe(340);

      // medium viewport 850: 850 - 480 = 370 -> max allowed is 370
      expect(clampSidebarWidth(400, 850)).toBe(370);
      expect(clampSidebarWidth(350, 850)).toBe(350);
    });

    it('parses stored width with fallbacks', () => {
      expect(parseStoredSidebarWidth('450')).toBe(450);
      expect(parseStoredSidebarWidth(null)).toBe(SIDEBAR_W_DEFAULT);
      expect(parseStoredSidebarWidth('')).toBe(SIDEBAR_W_DEFAULT);
      expect(parseStoredSidebarWidth('not-a-number')).toBe(SIDEBAR_W_DEFAULT);
      expect(parseStoredSidebarWidth('NaN')).toBe(SIDEBAR_W_DEFAULT);
    });
  });

  it('hostBadgedProjectOptions orders by host and badges host + non-connected state', async () => {
    // REMOTE_AGENTS_PROJECT_ID imported at top
    const hosts: RemoteHostView[] = [
      { id: 'h1', name: 'Box', state: 'disconnected', hello: {}, allowMcpSecrets: false, allowAgentEnvSecrets: false, createdAt: 1 },
    ];
    const opts = hostBadgedProjectOptions([
      makeProject({ id: REMOTE_AGENTS_PROJECT_ID, name: 'Remote Agents' }),
      makeProject({ id: 'r', name: 'App', remoteHostId: 'h1' }),
      makeProject({ id: 'l', name: 'App' }),
    ], hosts);
    expect(opts.map((o) => [o.value, o.badge])).toEqual([
      ['l', 'Hub'], ['r', 'Box · disconnected'], [REMOTE_AGENTS_PROJECT_ID, 'Remote Agents'],
    ]);
  });

  it('projectScheduleDeleteNote counts schedules and enabled ones, null when none', () => {
    const j = (enabled: boolean) => ({ job: { enabled } });
    expect(projectScheduleDeleteNote(undefined)).toBeNull();
    expect(projectScheduleDeleteNote([])).toBeNull();
    expect(projectScheduleDeleteNote([j(true)])).toBe('This includes 1 schedule (1 enabled).');
    expect(projectScheduleDeleteNote([j(true), j(false), j(false)])).toBe('This includes 3 schedules (1 enabled).');
  });
});

describe('schedules tab view', () => {
  const tree = (...fired: number[]) => ({ jobs: [{ runs: fired.map((firedAt) => ({ run: { firedAt } })) }] });
  const hosts: RemoteHostView[] = [
    { id: 'h1', name: 'Zeta Box', state: 'connected', hello: {}, allowMcpSecrets: false, allowAgentEnvSecrets: false, createdAt: 1 },
    { id: 'h2', name: 'Alpha Box', state: 'disconnected', hello: {}, allowMcpSecrets: false, allowAgentEnvSecrets: false, createdAt: 1 },
    { id: 'h3', name: 'Empty Box', state: 'connected', hello: {}, allowMcpSecrets: false, allowAgentEnvSecrets: false, createdAt: 1 },
  ];
  const a = makeProject({ id: 'a', name: 'Alpha', createdAt: 300 });
  const b = makeProject({ id: 'b', name: 'Bravo', createdAt: 100, remoteHostId: 'h1' });
  const c = makeProject({ id: 'c', name: 'Charlie', createdAt: 200, remoteHostId: 'h2' });
  const d = makeProject({ id: 'd', name: 'Delta', createdAt: 50 });
  const ra = makeProject({ id: REMOTE_AGENTS_PROJECT_ID, name: 'Remote Agents', createdAt: 999 });
  const trees = { a: tree(), b: tree(10, 5000, 20), c: tree(400), d: tree(), [REMOTE_AGENTS_PROJECT_ID]: tree() };

  it('activity = latest firedAt, else createdAt', () => {
    expect(scheduleProjectActivity(b, trees.b)).toBe(5000);
    expect(scheduleProjectActivity(a, trees.a)).toBe(300);
    expect(scheduleProjectActivity(a, undefined)).toBe(300);
  });

  it('flat for project/recent/status; only project mode applies projectOrder', () => {
    const proj = layoutScheduleProjects([a, b, c, d], trees, hosts, 'project', 'activity');
    expect(proj.groups).toBeNull();
    expect(proj.ordered.map((p) => p.id)).toEqual(['b', 'c', 'a', 'd']);
    for (const g of ['recent', 'status'] as const) {
      const out = layoutScheduleProjects([d, c, b, a], trees, hosts, g, 'name');
      expect(out.groups).toBeNull();
      expect(out.ordered.map((p) => p.id)).toEqual(['d', 'c', 'b', 'a']);
    }
    expect(layoutScheduleProjects([d, c, b, a], trees, hosts, 'project', 'name').ordered.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(layoutScheduleProjects([d, b, a, c], trees, hosts, 'project', 'created').ordered.map((p) => p.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('host mode: Hub, hosts by name, Remote Agents last, empty hosts omitted, ordered within groups', () => {
    const out = layoutScheduleProjects([ra, d, c, b, a], trees, hosts, 'host', 'name');
    expect(out.groups!.map((g) => g.key)).toEqual(['hub', 'h2', 'h1', 'remote-agents']);
    expect(out.groups![0].projects.map((p) => p.id)).toEqual(['a', 'd']);
    expect(out.groups![1]).toMatchObject({ label: 'Alpha Box', state: 'disconnected' });
    expect(out.groups![3].projects).toEqual([ra]);
    const act = layoutScheduleProjects([a, d], { a: tree(), d: tree(9999) }, hosts, 'host', 'activity');
    expect(act.groups!.map((g) => g.key)).toEqual(['hub']);
    expect(act.groups![0].projects.map((p) => p.id)).toEqual(['d', 'a']);
  });

  it('collectScheduleTreeConversations gathers non-archived run conversations and descendants across jobs', async () => {
    const { collectScheduleTreeConversations } = await import('./sidebarViews.js');
    const runConv = makeConv({ id: 'rc1', title: 'Run 1' });
    const childConv = makeConv({ id: 'sc1', parentConversationId: 'rc1', title: 'Spawn 1' });
    const archivedConv = makeConv({ id: 'arch1', archived: true, title: 'Archived Run' });
    const jobs = [
      {
        job: { archived: false },
        runs: [
          { conversation: runConv, descendants: [childConv] },
          { conversation: archivedConv, descendants: [] },
        ],
      },
    ];
    expect(collectScheduleTreeConversations(jobs).map((c) => c.id)).toEqual(['rc1', 'sc1']);
  });
});

describe('parseSearchScope', () => {
  it('defaults to all', () => {
    expect(parseSearchScope(null)).toBe('all');
    expect(parseSearchScope('garbage')).toBe('all');
  });
  it('accepts project', () => { expect(parseSearchScope('project')).toBe('project'); });
});

describe('resolveSearchScopeProjectId', () => {
  it('all scope -> null', () => { expect(resolveSearchScopeProjectId('all', 'A', 'foo')).toBeNull(); });
  it('project scope + query -> project id', () => { expect(resolveSearchScopeProjectId('project', 'A', 'foo')).toBe('A'); });
  it('no selected project -> null', () => { expect(resolveSearchScopeProjectId('project', null, 'foo')).toBeNull(); });
  it('empty / whitespace query -> null', () => {
    expect(resolveSearchScopeProjectId('project', 'A', '')).toBeNull();
    expect(resolveSearchScopeProjectId('project', 'A', '   ')).toBeNull();
  });
  it('pinned pseudo project -> null', () => {
    expect(resolveSearchScopeProjectId('project', PINNED_PROJECT_ID, 'foo')).toBeNull();
  });
});

describe('filterConversations scopeProjectId', () => {
  const base = {
    recentDays: 0, now: 100_000, selectedConversationId: null, showArchived: false,
    activeTag: null, searchQuery: 'alpha', contentSearch: true, contentHitIds: new Set<string>(),
  };
  const a1 = makeConv({ id: 'a1', projectId: 'A', title: 'alpha one', updatedAt: 3 });
  const a2 = makeConv({ id: 'a2', projectId: 'A', title: 'zzz', updatedAt: 2, parentConversationId: 'a1' });
  const b1 = makeConv({ id: 'b1', projectId: 'B', title: 'alpha two', updatedAt: 1 });

  it('unscoped keeps matches from every project (today)', () => {
    expect(filterConversations([a1, b1], base).map((c) => c.id)).toEqual(['a1', 'b1']);
  });
  it('scoped drops other projects, title matches included', () => {
    expect(filterConversations([a1, b1], { ...base, scopeProjectId: 'A' }).map((c) => c.id)).toEqual(['a1']);
  });
  it('scoped drops other projects content hits too', () => {
    const res = filterConversations([a1, a2, b1], {
      ...base, searchQuery: 'qqq', contentHitIds: new Set(['a2', 'b1']), scopeProjectId: 'A',
    });
    expect(res.map((c) => c.id)).toEqual(['a2']);
  });
  it('null scope is a no-op', () => {
    expect(filterConversations([a1, b1], { ...base, scopeProjectId: null }).map((c) => c.id)).toEqual(['a1', 'b1']);
  });
  it('scoped + selected conversation in another project is still dropped', () => {
    const res = filterConversations([a1, b1], { ...base, selectedConversationId: 'b1', recentDays: 1, scopeProjectId: 'A' });
    expect(res.map((c) => c.id)).toEqual(['a1']);
  });
  it('status-filter ancestor walk never pulls in an out-of-scope parent', () => {
    // Cross-project parent edge cannot happen in real data, but the walk must
    // run over the already-scoped list regardless.
    const bParent = makeConv({ id: 'bp', projectId: 'B', title: 'alpha parent', updatedAt: 5 });
    const aChild = makeConv({ id: 'ac', projectId: 'A', title: 'alpha child', updatedAt: 4, parentConversationId: 'bp' });
    const res = filterConversations([bParent, aChild], {
      ...base, scopeProjectId: 'A',
      statusFilter: new Set(['idle'] as const), bucketOf: () => 'idle',
    });
    expect(res.map((c) => c.id)).toEqual(['ac']);
  });
});

describe('newlySpawnedParents', () => {
  it('ignores the first snapshot of a project, then reports first-child parents only', () => {
    const known = new Map<string, Set<string>>();
    expect(newlySpawnedParents(known, { p1: [{ parentConversationId: 'a' }, {}] })).toEqual([]);
    expect(newlySpawnedParents(known, { p1: [{ parentConversationId: 'a' }, { parentConversationId: 'a' }] })).toEqual([]);
    expect(newlySpawnedParents(known, { p1: [{ parentConversationId: 'a' }, { parentConversationId: 'b' }] })).toEqual(['b']);
    expect(newlySpawnedParents(known, { p1: [], p2: [{ parentConversationId: 'c' }] })).toEqual([]);
  });

  it('does not treat archived children revealed by "Show archived" as fresh spawns', () => {
    const known = new Map<string, Set<string>>();
    newlySpawnedParents(known, { p1: [] });
    expect(newlySpawnedParents(known, { p1: [{ parentConversationId: 'old', archived: true }] })).toEqual([]);
  });
});
