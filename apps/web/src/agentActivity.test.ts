import { describe, it, expect } from 'vitest';
import type {
  ActiveSessionsResponse, ActiveAgentSessionDto, ActiveAgentConversationDto, Conversation,
  PendingTimerSummary, SpawnRequestRow,
} from '@tierwyn/shared';
import {
  activeAgentDotClass, activeAgentsButtonClass, agentActivityButtonClass, buildAgentTree, flattenAgentRows,
  flattenAgentTree, flattenProjectRootTrees, groupAgentForest, sessionMetaParts, activityAgentLabel,
  subtreeSessionCount, subtreeCompletedCount, isCompletedUnread, buildCompletedAgentTree,
  groupCompletedAgentForest, collectUnreadConversationIds, formatRelativeTime, RECENT_OPTIONS, type AgentTreeNode,
  groupPendingTimers, timedRowTimeLabel,
  buildAttentionItems, groupAttentionItems, attentionDotStatus, attentionReasonLabel,
  type AttentionItem, type BuildAttentionOpts,
} from './agentActivity.js';
import { countdownLabel } from './promptTimer.js';


function sess(partial: Partial<ActiveAgentSessionDto> & Pick<ActiveAgentSessionDto, 'sessionId' | 'conversationId'>): ActiveAgentSessionDto {
  return {
    agentType: 'claude-code',
    profileId: 'claude-code:opus',
    model: 'opus',
    status: 'running',
    startedAt: 1_000,
    ...partial,
  };
}

function payload(partial: Partial<ActiveSessionsResponse>): ActiveSessionsResponse {
  return {
    sessions: [],
    conversations: [],
    projects: [{ id: 'proj-1', name: 'Alpha' }],
    now: 10_000,
    ...partial,
  };
}

function collectIds(nodes: AgentTreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (ns: AgentTreeNode[]): void => {
    for (const n of ns) {
      ids.push(n.conversationId);
      walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

describe('buildAgentTree', () => {
  it('builds a single root with one session and depth 0', () => {
    const tree = buildAgentTree(payload({
      sessions: [sess({ sessionId: 's1', conversationId: 'c1' })],
      conversations: [{ id: 'c1', title: 'Root', projectId: 'proj-1' }],
    }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.sessions).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(0);
    expect(tree[0]!.projectName).toBe('Alpha');
  });

  it('preserves description and tags on agent tree nodes when present', () => {
    const tree = buildAgentTree(payload({
      sessions: [sess({ sessionId: 's1', conversationId: 'c1' })],
      conversations: [{
        id: 'c1',
        title: 'Root',
        projectId: 'proj-1',
        description: 'Testing conversation description',
        tags: ['frontend', 'react'],
      }],
    }));
    expect(tree[0]!.description).toBe('Testing conversation description');
    expect(tree[0]!.tags).toEqual(['frontend', 'react']);
  });

  it('nests a two-level parent+child both active', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 'sp', conversationId: 'parent', startedAt: 1 }),
        sess({ sessionId: 'sc', conversationId: 'child', startedAt: 2 }),
      ],
      conversations: [
        { id: 'parent', title: 'Parent', projectId: 'proj-1' },
        { id: 'child', title: 'Child', projectId: 'proj-1', parentConversationId: 'parent' },
      ],
    }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.conversationId).toBe('parent');
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.conversationId).toBe('child');
    expect(tree[0]!.children[0]!.depth).toBe(1);
  });

  it('renders an inactive parent as a placeholder with an empty sessions array', () => {
    const tree = buildAgentTree(payload({
      sessions: [sess({ sessionId: 'sc', conversationId: 'child' })],
      conversations: [
        { id: 'parent', title: 'Parent', projectId: 'proj-1' },
        { id: 'child', title: 'Child', projectId: 'proj-1', parentConversationId: 'parent' },
      ],
    }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.sessions).toEqual([]);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.sessions).toHaveLength(1);
  });

  it('orders independent roots by earliest startedAt ascending', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 's-late', conversationId: 'late', startedAt: 5_000 }),
        sess({ sessionId: 's-early', conversationId: 'early', startedAt: 1_000 }),
      ],
      conversations: [
        { id: 'late', title: 'Late', projectId: 'proj-1' },
        { id: 'early', title: 'Early', projectId: 'proj-1' },
      ],
    }));
    expect(tree.map((n) => n.conversationId)).toEqual(['early', 'late']);
  });

  it('assigns exact depth 0…4 on a 5-level chain', () => {
    const conversations = [
      { id: 'c0', title: 'L0', projectId: 'proj-1' },
      { id: 'c1', title: 'L1', projectId: 'proj-1', parentConversationId: 'c0' },
      { id: 'c2', title: 'L2', projectId: 'proj-1', parentConversationId: 'c1' },
      { id: 'c3', title: 'L3', projectId: 'proj-1', parentConversationId: 'c2' },
      { id: 'c4', title: 'L4', projectId: 'proj-1', parentConversationId: 'c3' },
    ];
    const tree = buildAgentTree(payload({
      sessions: [sess({ sessionId: 's4', conversationId: 'c4' })],
      conversations,
    }));
    const flat = flattenAgentTree(tree, new Set());
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(flat.map((n) => n.conversationId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('orders siblings by startedAt, then title.localeCompare', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 'sz', conversationId: 'z', startedAt: 2_000 }),
        sess({ sessionId: 'sa', conversationId: 'a', startedAt: 1_000 }),
      ],
      conversations: [
        { id: 'parent', title: 'Parent', projectId: 'proj-1' },
        { id: 'z', title: 'Zed', projectId: 'proj-1', parentConversationId: 'parent' },
        { id: 'a', title: 'Able', projectId: 'proj-1', parentConversationId: 'parent' },
      ],
    }));
    expect(tree[0]!.children.map((n) => n.conversationId)).toEqual(['a', 'z']);
  });

  it('orders siblings with identical startedAt by title.localeCompare, not conversationId', () => {
    // ids sort opposite to titles (aa < zz, but Alpha < Beta) so key 2 is isolated from key 3.
    const tied = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 'sb', conversationId: 'aa', startedAt: 1_000 }),
        sess({ sessionId: 'sa2', conversationId: 'zz', startedAt: 1_000 }),
      ],
      conversations: [
        { id: 'parent', title: 'Parent', projectId: 'proj-1' },
        { id: 'aa', title: 'Beta', projectId: 'proj-1', parentConversationId: 'parent' },
        { id: 'zz', title: 'Alpha', projectId: 'proj-1', parentConversationId: 'parent' },
      ],
    }));
    expect(tied[0]!.children.map((n) => n.conversationId)).toEqual(['zz', 'aa']);
  });

  it('orders siblings with identical startedAt and title by conversationId.localeCompare', () => {
    const tied = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 's-zz', conversationId: 'zz', startedAt: 1_000 }),
        sess({ sessionId: 's-aa', conversationId: 'aa', startedAt: 1_000 }),
      ],
      conversations: [
        { id: 'parent', title: 'Parent', projectId: 'proj-1' },
        { id: 'zz', title: 'Same', projectId: 'proj-1', parentConversationId: 'parent' },
        { id: 'aa', title: 'Same', projectId: 'proj-1', parentConversationId: 'parent' },
      ],
    }));
    expect(tied[0]!.children.map((n) => n.conversationId)).toEqual(['aa', 'zz']);
  });

  it('keeps multiple sessions on one conversation as a single node', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 's1', conversationId: 'c1', startedAt: 1 }),
        sess({ sessionId: 's2', conversationId: 'c1', startedAt: 2 }),
      ],
      conversations: [{ id: 'c1', title: 'Busy', projectId: 'proj-1' }],
    }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.sessions).toHaveLength(2);
  });

  it('builds a schedule tree under a schedule_home root with no session of its own', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 'st', conversationId: 'tick', startedAt: 1 }),
        sess({ sessionId: 'sc', conversationId: 'spawnChild', startedAt: 2 }),
      ],
      conversations: [
        { id: 'home', title: '⏱ Nightly triage', projectId: 'proj-1', kind: 'schedule_home' },
        { id: 'tick', title: '⏱ Nightly triage @ 2026-08-29T03:00', projectId: 'proj-1', parentConversationId: 'home' },
        { id: 'spawnChild', title: 'Grok 4.6 Implementer', projectId: 'proj-1', parentConversationId: 'tick' },
      ],
    }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.kind).toBe('schedule_home');
    expect(tree[0]!.sessions).toEqual([]);
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.conversationId).toBe('tick');
    expect(tree[0]!.children[0]!.depth).toBe(0);
    expect(tree[0]!.children[0]!.sessions).toHaveLength(1);
    expect(tree[0]!.children[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.children[0]!.conversationId).toBe('spawnChild');
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(1);
    expect(tree[0]!.children[0]!.children[0]!.sessions).toHaveLength(1);
    expect(subtreeSessionCount(tree[0]!)).toBe(2);
    expect(flattenAgentTree(tree, new Set(['home'])).map((n) => n.conversationId)).toEqual(['home']);
  });

  it('nests two concurrent ticks of the same job under one schedule_home, ordered by startedAt', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 's-late', conversationId: 'tick-late', startedAt: 5_000 }),
        sess({ sessionId: 's-early', conversationId: 'tick-early', startedAt: 1_000 }),
      ],
      conversations: [
        { id: 'home', title: '⏱ Nightly triage', projectId: 'proj-1', kind: 'schedule_home' },
        { id: 'tick-late', title: 'Late tick', projectId: 'proj-1', parentConversationId: 'home' },
        { id: 'tick-early', title: 'Early tick', projectId: 'proj-1', parentConversationId: 'home' },
      ],
    }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.kind).toBe('schedule_home');
    expect(tree[0]!.children).toHaveLength(2);
    expect(tree[0]!.children.map((n) => n.conversationId)).toEqual(['tick-early', 'tick-late']);
  });

  it('treats a missing parent as a root instead of dropping the node', () => {
    const tree = buildAgentTree(payload({
      sessions: [sess({ sessionId: 's1', conversationId: 'orphan' })],
      conversations: [{
        id: 'orphan',
        title: 'Orphan',
        projectId: 'proj-1',
        parentConversationId: 'absent',
      }],
    }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.conversationId).toBe('orphan');
    expect(tree[0]!.depth).toBe(0);
  });

  it('terminates a parent cycle and emits every conversation once', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 'sa', conversationId: 'a' }),
        sess({ sessionId: 'sb', conversationId: 'b' }),
      ],
      conversations: [
        { id: 'a', title: 'A', projectId: 'proj-1', parentConversationId: 'b' },
        { id: 'b', title: 'B', projectId: 'proj-1', parentConversationId: 'a' },
      ],
    }));
    const ids = collectIds(tree);
    expect(ids.sort()).toEqual(['a', 'b']);
    expect(ids).toHaveLength(2);
  });

  it('returns an empty forest for an empty payload', () => {
    expect(buildAgentTree(payload({ sessions: [], conversations: [], projects: [] }))).toEqual([]);
  });

  it('drops a session that disappeared between payloads without corrupting depths', () => {
    const conversations = [
      { id: 'parent', title: 'Parent', projectId: 'proj-1' },
      { id: 'keep', title: 'Keep', projectId: 'proj-1', parentConversationId: 'parent' },
      { id: 'gone', title: 'Gone', projectId: 'proj-1', parentConversationId: 'parent' },
    ];
    const before = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 'sk', conversationId: 'keep' }),
        sess({ sessionId: 'sg', conversationId: 'gone' }),
      ],
      conversations,
    }));
    expect(collectIds(before).sort()).toEqual(['gone', 'keep', 'parent']);

    const after = buildAgentTree(payload({
      sessions: [sess({ sessionId: 'sk', conversationId: 'keep' })],
      conversations: conversations.filter((c) => c.id !== 'gone'),
    }));
    expect(collectIds(after).sort()).toEqual(['keep', 'parent']);
    expect(after[0]!.depth).toBe(0);
    expect(after[0]!.children[0]!.depth).toBe(1);
    expect(after[0]!.children[0]!.conversationId).toBe('keep');
  });
});

describe('flattenAgentTree', () => {
  const chain = (): AgentTreeNode[] => buildAgentTree(payload({
    sessions: [
      sess({ sessionId: 's0', conversationId: 'c0' }),
      sess({ sessionId: 's2', conversationId: 'c2' }),
    ],
    conversations: [
      { id: 'c0', title: 'L0', projectId: 'proj-1' },
      { id: 'c1', title: 'L1', projectId: 'proj-1', parentConversationId: 'c0' },
      { id: 'c2', title: 'L2', projectId: 'proj-1', parentConversationId: 'c1' },
    ],
  }));

  it('returns only the root when the root is collapsed', () => {
    const flat = flattenAgentTree(chain(), new Set(['c0']));
    expect(flat.map((n) => n.conversationId)).toEqual(['c0']);
  });

  it('omits descendants of a collapsed mid-level node', () => {
    const flat = flattenAgentTree(chain(), new Set(['c1']));
    expect(flat.map((n) => n.conversationId)).toEqual(['c0', 'c1']);
  });

  it('returns every node in pre-order when collapsed is empty', () => {
    const flat = flattenAgentTree(chain(), new Set());
    expect(flat.map((n) => n.conversationId)).toEqual(['c0', 'c1', 'c2']);
  });

  it('returns a branching forest in pre-order, not level-order', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 's-root', conversationId: 'root', startedAt: 1 }),
        sess({ sessionId: 's-a', conversationId: 'a', startedAt: 2 }),
        sess({ sessionId: 's-a1', conversationId: 'a1', startedAt: 3 }),
        sess({ sessionId: 's-b', conversationId: 'b', startedAt: 4 }),
        sess({ sessionId: 's-b1', conversationId: 'b1', startedAt: 5 }),
      ],
      conversations: [
        { id: 'root', title: 'Root', projectId: 'proj-1' },
        { id: 'a', title: 'A', projectId: 'proj-1', parentConversationId: 'root' },
        { id: 'a1', title: 'A1', projectId: 'proj-1', parentConversationId: 'a' },
        { id: 'b', title: 'B', projectId: 'proj-1', parentConversationId: 'root' },
        { id: 'b1', title: 'B1', projectId: 'proj-1', parentConversationId: 'b' },
      ],
    }));
    expect(flattenAgentTree(tree, new Set()).map((n) => n.conversationId))
      .toEqual(['root', 'a', 'a1', 'b', 'b1']);
  });
});

describe('flattenAgentRows', () => {
  const branch = (): AgentTreeNode[] => buildAgentTree(payload({
    sessions: [
      sess({ sessionId: 's-root', conversationId: 'root', startedAt: 1 }),
      sess({ sessionId: 's-a', conversationId: 'a', startedAt: 2 }),
      sess({ sessionId: 's-a1', conversationId: 'a1', startedAt: 3 }),
      sess({ sessionId: 's-b', conversationId: 'b', startedAt: 4 }),
    ],
    conversations: [
      { id: 'root', title: 'Root', projectId: 'proj-1' },
      { id: 'a', title: 'A', projectId: 'proj-1', parentConversationId: 'root' },
      { id: 'a1', title: 'A1', projectId: 'proj-1', parentConversationId: 'a' },
      { id: 'b', title: 'B', projectId: 'proj-1', parentConversationId: 'root' },
    ],
  }));

  it('gives roots no guides', () => {
    expect(flattenAgentRows(branch(), new Set())[0]!.guides).toEqual([]);
  });

  it('rails each node at its ancestors\u2019 chevron columns; continuing rails for open branches, elbows for last children', () => {
    const rows = flattenAgentRows(branch(), new Set());
    // 'a' (depth 1) has a following sibling 'b': rail continues past it.
    expect(rows[1]!.guides).toEqual([{ x: 16, last: false }]);
    // 'a1' (depth 2, last child of 'a'): continuing rail from root, elbow from 'a' at x 30.
    expect(rows[2]!.guides).toEqual([{ x: 16, last: false }, { x: 30, last: true }]);
    // 'b' (depth 1, last child of root): elbow at the root column.
    expect(rows[3]!.guides).toEqual([{ x: 16, last: true }]);
  });

  it('omits descendants of a collapsed node so their rails never render', () => {
    const rows = flattenAgentRows(branch(), new Set(['a']));
    expect(rows.map((r) => r.node.conversationId)).toEqual(['root', 'a', 'b']);
    expect(rows[2]!.guides).toEqual([{ x: 16, last: true }]);
  });

  it('clamps rail x at max indent on deep chains', () => {
    const conversations = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
      id: `d${i}`,
      title: `L${i}`,
      projectId: 'proj-1',
      ...(i > 0 ? { parentConversationId: `d${i - 1}` } : {}),
    }));
    const tree = buildAgentTree(payload({
      sessions: [sess({ sessionId: 's7', conversationId: 'd7' })],
      conversations,
    }));
    const rows = flattenAgentRows(tree, new Set());
    const last = rows[7]!.guides;
    expect(last).toHaveLength(7);
    expect(last[last.length - 1]).toEqual({ x: 16 + 6 * 14, last: true });
  });
});

describe('groupAgentForest', () => {
  const forest = (): AgentTreeNode[] => buildAgentTree(payload({
    sessions: [
      sess({ sessionId: 's1', conversationId: 'a1', startedAt: 1 }),
      sess({ sessionId: 's2', conversationId: 'b1', startedAt: 2 }),
      sess({ sessionId: 's3', conversationId: 'b2', startedAt: 3 }),
      sess({ sessionId: 's4', conversationId: 'orphan', startedAt: 4 }),
    ],
    conversations: [
      { id: 'a1', title: 'A', projectId: 'proj-1' },
      { id: 'b1', title: 'B parent', projectId: 'proj-2' },
      { id: 'b2', title: 'B child', projectId: 'proj-2', parentConversationId: 'b1' },
      { id: 'orphan', title: 'Orphan', projectId: '' },
    ],
    projects: [
      { id: 'proj-1', name: 'Beta' },
      { id: 'proj-2', name: 'alpha' },
    ],
  }));

  it('groups roots by project, sums subtree sessions, sorts named projects first and unknown last', () => {
    const groups = groupAgentForest(forest());
    expect(groups.map((g) => [g.projectName, g.running])).toEqual([
      ['alpha', 2], // b1 + b2, case-insensitive sort before Beta
      ['Beta', 1],
      [undefined, 1], // unknown project ('' id) trails
    ]);
    expect(groups[0]!.roots.map((n) => n.conversationId)).toEqual(['b1']);
    expect(groups[2]!.projectId).toBe('');
  });

  it('keeps forest order within a group and returns an empty list for an empty forest', () => {
    const groups = groupAgentForest(forest());
    expect(groups[1]!.roots.map((n) => n.conversationId)).toEqual(['a1']);
    expect(groupAgentForest([])).toEqual([]);
  });
});

describe('subtreeSessionCount', () => {
  it('counts sessions at levels 0 and 2 of a 3-level chain as 2', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 's0', conversationId: 'c0' }),
        sess({ sessionId: 's2', conversationId: 'c2' }),
      ],
      conversations: [
        { id: 'c0', title: 'L0', projectId: 'proj-1' },
        { id: 'c1', title: 'L1', projectId: 'proj-1', parentConversationId: 'c0' },
        { id: 'c2', title: 'L2', projectId: 'proj-1', parentConversationId: 'c1' },
      ],
    }));
    expect(subtreeSessionCount(tree[0]!)).toBe(2);
    expect(subtreeSessionCount(tree[0]!.children[0]!.children[0]!)).toBe(1);
  });
});

describe('activeAgentDotClass', () => {
  it('maps live session status to sidebar status-dot classes at depth 0', () => {
    expect(activeAgentDotClass('running', 0)).toBe('status-dot running');
    expect(activeAgentDotClass('waiting', 0)).toBe('status-dot waiting');
    expect(activeAgentDotClass('error', 0)).toBe('status-dot error');
  });

  it('renders grey for idle/done/absent status and ancestor placeholders', () => {
    expect(activeAgentDotClass('idle', 0)).toBe('status-dot grey');
    expect(activeAgentDotClass('done', 0)).toBe('status-dot grey');
    expect(activeAgentDotClass(undefined, 0)).toBe('status-dot grey');
  });

  it('adds subagent-diamond for spawned child rows (depth > 0)', () => {
    expect(activeAgentDotClass('running', 1)).toBe('status-dot running subagent-diamond');
    expect(activeAgentDotClass('waiting', 2)).toBe('status-dot waiting subagent-diamond');
    expect(activeAgentDotClass('error', 3)).toBe('status-dot error subagent-diamond');
    expect(activeAgentDotClass(undefined, 1)).toBe('status-dot grey subagent-diamond');
  });

  it('uses descendant-active (hollow spawn ring) for idle ancestors with live children', () => {
    expect(activeAgentDotClass(undefined, 0, true)).toBe('status-dot descendant-active');
    expect(activeAgentDotClass('idle', 0, true)).toBe('status-dot descendant-active');
    expect(activeAgentDotClass(undefined, 1, true)).toBe('status-dot descendant-active subagent-diamond');
  });

  it('own live status wins over descendant-active', () => {
    expect(activeAgentDotClass('running', 0, true)).toBe('status-dot running');
    expect(activeAgentDotClass('waiting', 1, true)).toBe('status-dot waiting subagent-diamond');
    expect(activeAgentDotClass('error', 0, true)).toBe('status-dot error');
  });
});

describe('sessionMetaParts', () => {
  it('splits a catalogue "Runtime · Model" label and does not append the same model again', () => {
    expect(sessionMetaParts('Claude Code · Haiku 4.5', 'Haiku 4.5', 'Tierwyn')).toEqual({
      agent: 'Claude Code',
      model: 'Haiku 4.5',
      project: 'Tierwyn',
    });
  });

  it('keeps a runtime-only label and a distinct session model as two parts', () => {
    expect(sessionMetaParts('claude-code', 'claude-haiku-4-5', 'Tierwyn')).toEqual({
      agent: 'claude-code',
      model: 'claude-haiku-4-5',
      project: 'Tierwyn',
    });
  });

  it('prefers the catalogue remainder over a different session model id', () => {
    expect(sessionMetaParts('Claude Code · Fable 5', 'claude-fable-5', 'Alpha')).toEqual({
      agent: 'Claude Code',
      model: 'Fable 5',
      project: 'Alpha',
    });
  });

  it('treats a label that is only the model as model, not agent', () => {
    expect(sessionMetaParts('GLM-5.3-Flash', 'GLM-5.3-Flash', 'Tierwyn')).toEqual({
      agent: '',
      model: 'GLM-5.3-Flash',
      project: 'Tierwyn',
    });
  });

  it('omits empty model and project', () => {
    expect(sessionMetaParts('Claude Code', '', undefined)).toEqual({
      agent: 'Claude Code',
      model: '',
      project: '',
    });
  });

  it('trims whitespace and still splits on the middle-dot separator', () => {
    expect(sessionMetaParts('  Claude Code · Haiku 4.5  ', ' Haiku 4.5 ', ' Tierwyn ')).toEqual({
      agent: 'Claude Code',
      model: 'Haiku 4.5',
      project: 'Tierwyn',
    });
  });
});

describe('agentActivityButtonClass', () => {
  it('returns base class when closed and zero active agents', () => {
    expect(agentActivityButtonClass(false, 0)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn');
    expect(activeAgentsButtonClass(false, 0)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn');
  });

  it('adds has-active class when there is at least 1 active agent', () => {
    expect(agentActivityButtonClass(false, 1)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn has-active');
    expect(agentActivityButtonClass(false, 4)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn has-active');
  });

  it('adds active class when modal is open', () => {
    expect(agentActivityButtonClass(true, 0)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn active');
  });

  it('adds has-timed class when there are 0 active agents but > 0 timed messages', () => {
    expect(agentActivityButtonClass(false, 0, 1)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn has-timed');
    expect(agentActivityButtonClass(false, 0, 3)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn has-timed');
    expect(agentActivityButtonClass(true, 0, 2)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn active has-timed');
  });

  it('prefers has-active when both active and timed agents exist', () => {
    expect(agentActivityButtonClass(false, 2, 5)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn has-active');
  });

  it('adds both active and has-active when open with running agents', () => {
    expect(agentActivityButtonClass(true, 2)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn active has-active');
    expect(activeAgentsButtonClass(true, 2)).toBe('theme-toggle agent-activity-toggle active-agents-toggle gt-header-btn active has-active');
  });
});

describe('flattenProjectRootTrees', () => {
  it('separates multiple roots in the same project into distinct root trees', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 's1', conversationId: 'c1', startedAt: 1_000 }),
        sess({ sessionId: 's2', conversationId: 'c2', startedAt: 2_000 }),
      ],
      conversations: [
        { id: 'c1', title: 'Root 1', projectId: 'proj-1' },
        { id: 'c2', title: 'Root 2', projectId: 'proj-1' },
      ],
    }));
    const groups = groupAgentForest(tree);
    expect(groups).toHaveLength(1);
    const rootTrees = flattenProjectRootTrees(groups[0]!, new Set());
    expect(rootTrees).toHaveLength(2);
    expect(rootTrees[0]!.root.conversationId).toBe('c1');
    expect(rootTrees[0]!.rows).toHaveLength(1);
    expect(rootTrees[0]!.rows[0]!.node.conversationId).toBe('c1');
    expect(rootTrees[1]!.root.conversationId).toBe('c2');
    expect(rootTrees[1]!.rows).toHaveLength(1);
    expect(rootTrees[1]!.rows[0]!.node.conversationId).toBe('c2');
  });

  it('keeps child nodes within their respective root tree', () => {
    const tree = buildAgentTree(payload({
      sessions: [
        sess({ sessionId: 's1', conversationId: 'c1', startedAt: 1_000 }),
        sess({ sessionId: 's2', conversationId: 'c2-child', startedAt: 2_000 }),
      ],
      conversations: [
        { id: 'c1', title: 'Root 1', projectId: 'proj-1' },
        { id: 'c2', title: 'Root 2', projectId: 'proj-1' },
        { id: 'c2-child', title: 'Child 2', projectId: 'proj-1', parentConversationId: 'c2' },
      ],
    }));
    const groups = groupAgentForest(tree);
    const rootTrees = flattenProjectRootTrees(groups[0]!, new Set());
    expect(rootTrees).toHaveLength(2);
    expect(rootTrees[0]!.rows.map((r) => r.node.conversationId)).toEqual(['c1']);
    expect(rootTrees[1]!.rows.map((r) => r.node.conversationId)).toEqual(['c2', 'c2-child']);
  });
});

describe('activeAgentDotClass with isUnread', () => {
  it('returns status-dot unread when isUnread is true at depth 0', () => {
    expect(activeAgentDotClass(undefined, 0, false, true)).toBe('status-dot unread');
  });

  it('returns status-dot unread subagent-diamond when isUnread is true at depth > 0', () => {
    expect(activeAgentDotClass(undefined, 1, false, true)).toBe('status-dot unread subagent-diamond');
  });

  it('live status still takes priority over isUnread', () => {
    expect(activeAgentDotClass('running', 0, false, true)).toBe('status-dot running');
    expect(activeAgentDotClass('waiting', 1, false, true)).toBe('status-dot waiting subagent-diamond');
    expect(activeAgentDotClass('error', 2, false, true)).toBe('status-dot error subagent-diamond');
  });
});

describe('formatRelativeTime', () => {
  const base = 1_000_000_000;
  it('formats < 1m as just now', () => {
    expect(formatRelativeTime(base, base)).toBe('just now');
    expect(formatRelativeTime(base - 30_000, base)).toBe('just now');
  });

  it('formats minutes ago', () => {
    expect(formatRelativeTime(base - 5 * 60_000, base)).toBe('5m ago');
    expect(formatRelativeTime(base - 59 * 60_000, base)).toBe('59m ago');
  });

  it('formats hours ago', () => {
    expect(formatRelativeTime(base - 2 * 3600_000, base)).toBe('2h ago');
    expect(formatRelativeTime(base - 47 * 3600_000, base)).toBe('47h ago');
  });

  it('formats days ago', () => {
    expect(formatRelativeTime(base - 48 * 3600_000, base)).toBe('2d ago');
    expect(formatRelativeTime(base - 7 * 86_400_000, base)).toBe('7d ago');
  });
});

describe('isCompletedUnread', () => {
  const baseConv: Conversation = {
    id: 'c1',
    projectId: 'p1',
    title: 'Test',
    createdAt: 1000,
    updatedAt: 2000,
  };

  it('returns true when conversation id is in unread set and not running', () => {
    expect(isCompletedUnread(baseConv, new Set(), new Set(['c1']))).toBe(true);
  });

  it('returns true when lastStatus is done and not running', () => {
    expect(isCompletedUnread({ ...baseConv, lastStatus: 'done' }, new Set(), new Set())).toBe(true);
  });

  it('returns true when lastStatus is error and not running', () => {
    expect(isCompletedUnread({ ...baseConv, lastStatus: 'error' }, new Set(), new Set())).toBe(true);
  });

  it('returns false when conversation is currently running in runningConvIds', () => {
    expect(isCompletedUnread({ ...baseConv, lastStatus: 'done' }, new Set(['c1']), new Set(['c1']))).toBe(false);
  });

  it('returns false when conversation is active via isActive or liveStatus', () => {
    expect(isCompletedUnread({ ...baseConv, isActive: true, lastStatus: 'done' }, new Set(), new Set(['c1']))).toBe(false);
    expect(isCompletedUnread({ ...baseConv, liveStatus: 'running', lastStatus: 'done' }, new Set(), new Set(['c1']))).toBe(false);
  });

  it('returns false when conversation is schedule_home', () => {
    expect(isCompletedUnread({ ...baseConv, kind: 'schedule_home', lastStatus: 'done' }, new Set(), new Set(['c1']))).toBe(false);
  });

  it('returns false when conversation is archived', () => {
    expect(isCompletedUnread({ ...baseConv, archived: true, lastStatus: 'done' }, new Set(), new Set(['c1']))).toBe(false);
  });

  it('returns false when conversation is read and has no terminal status', () => {
    expect(isCompletedUnread(baseConv, new Set(), new Set())).toBe(false);
  });
});

describe('buildCompletedAgentTree and groupCompletedAgentForest', () => {
  const projects = [
    { id: 'p1', name: 'Alpha Project' },
    { id: 'p2', name: 'Beta Project' },
  ];

  const now = 1_000_000_000;

  it('builds completed tree for unread completed conversations', () => {
    const convs: Conversation[] = [
      { id: 'c1', projectId: 'p1', title: 'Alpha Chat 1', createdAt: 1000, updatedAt: now - 3600_000, lastStatus: 'done' },
      { id: 'c2', projectId: 'p1', title: 'Alpha Chat 2', createdAt: 1000, updatedAt: now - 7200_000 },
      { id: 'c3', projectId: 'p2', title: 'Beta Chat 1', createdAt: 1000, updatedAt: now - 1800_000 },
    ];
    const roots = buildCompletedAgentTree({
      conversations: convs,
      projects,
      runningConversationIds: new Set(),
      unreadConversationIds: new Set(['c3']),
      recentDays: 0,
      now,
    });

    expect(roots).toHaveLength(2);
    // Should be sorted by recency: c3 (updatedAt now - 1800k) then c1 (now - 3600k)
    expect(roots[0]!.conversationId).toBe('c3');
    expect(roots[0]!.isUnread).toBe(true);
    expect(roots[0]!.projectName).toBe('Beta Project');
    expect(roots[1]!.conversationId).toBe('c1');
    expect(roots[1]!.isUnread).toBe(true);
    expect(roots[1]!.projectName).toBe('Alpha Project');
  });

  it('preserves ancestor hierarchy even if ancestor is not unread', () => {
    const convs: Conversation[] = [
      { id: 'p-conv', projectId: 'p1', title: 'Parent Conv', createdAt: 1000, updatedAt: now - 50_000_000 },
      { id: 'c-conv', projectId: 'p1', title: 'Child Conv', createdAt: 2000, updatedAt: now - 1000, parentConversationId: 'p-conv', lastStatus: 'done' },
    ];
    const roots = buildCompletedAgentTree({
      conversations: convs,
      projects,
      runningConversationIds: new Set(),
      unreadConversationIds: new Set(),
      recentDays: 1, // 24 hours: parent is older, child is fresh
      now,
    });

    expect(roots).toHaveLength(1);
    expect(roots[0]!.conversationId).toBe('p-conv');
    expect(roots[0]!.isUnread).toBe(false);
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.conversationId).toBe('c-conv');
    expect(roots[0]!.children[0]!.isUnread).toBe(true);
    expect(roots[0]!.children[0]!.depth).toBe(1);
  });

  it('filters by recentDays properly', () => {
    const convs: Conversation[] = [
      { id: 'fresh', projectId: 'p1', title: 'Fresh', createdAt: 1000, updatedAt: now - 3600_000, lastStatus: 'done' }, // 1h ago
      { id: 'yesterday', projectId: 'p1', title: 'Yesterday', createdAt: 1000, updatedAt: now - 48 * 3600_000, lastStatus: 'done' }, // 2 days ago
      { id: 'old', projectId: 'p1', title: 'Old', createdAt: 1000, updatedAt: now - 10 * 86_400_000, lastStatus: 'done' }, // 10 days ago
    ];

    // 24h filter
    const trees24h = buildCompletedAgentTree({
      conversations: convs,
      projects,
      runningConversationIds: new Set(),
      unreadConversationIds: new Set(),
      recentDays: 1,
      now,
    });
    expect(trees24h.map((t) => t.conversationId)).toEqual(['fresh']);

    // 3 days filter
    const trees3d = buildCompletedAgentTree({
      conversations: convs,
      projects,
      runningConversationIds: new Set(),
      unreadConversationIds: new Set(),
      recentDays: 3,
      now,
    });
    expect(trees3d.map((t) => t.conversationId)).toEqual(['fresh', 'yesterday']);

    // All filter (0)
    const treesAll = buildCompletedAgentTree({
      conversations: convs,
      projects,
      runningConversationIds: new Set(),
      unreadConversationIds: new Set(),
      recentDays: 0,
      now,
    });
    expect(treesAll.map((t) => t.conversationId)).toEqual(['fresh', 'yesterday', 'old']);
  });

  it('groupCompletedAgentForest groups by project and calculates completed count', () => {
    const convs: Conversation[] = [
      { id: 'c1', projectId: 'p1', title: 'Alpha 1', createdAt: 1000, updatedAt: now - 1000, lastStatus: 'done' },
      { id: 'c2', projectId: 'p1', title: 'Alpha 2', createdAt: 1000, updatedAt: now - 2000, lastStatus: 'done' },
      { id: 'c3', projectId: 'p2', title: 'Beta 1', createdAt: 1000, updatedAt: now - 3000, lastStatus: 'done' },
    ];
    const roots = buildCompletedAgentTree({
      conversations: convs,
      projects,
      runningConversationIds: new Set(),
      unreadConversationIds: new Set(),
      recentDays: 0,
      now,
    });
    const groups = groupCompletedAgentForest(roots);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.projectName).toBe('Alpha Project');
    expect(groups[0]!.completed).toBe(2);
    expect(groups[1]!.projectName).toBe('Beta Project');
    expect(groups[1]!.completed).toBe(1);
  });

  it('subtreeCompletedCount counts unread in nested hierarchy', () => {
    const node: AgentTreeNode = {
      conversationId: 'p',
      title: 'Parent',
      projectId: 'p1',
      isUnread: false,
      depth: 0,
      sessions: [],
      children: [
        {
          conversationId: 'c1',
          title: 'Child 1',
          projectId: 'p1',
          isUnread: true,
          depth: 1,
          sessions: [],
          children: [],
        },
        {
          conversationId: 'c2',
          title: 'Child 2',
          projectId: 'p1',
          isUnread: true,
          depth: 1,
          sessions: [],
          children: [],
        },
      ],
    };
    expect(subtreeCompletedCount(node)).toBe(2);
  });

  it('collectUnreadConversationIds collects all isUnread conversation IDs across groups', () => {
    const node1: AgentTreeNode = {
      conversationId: 'c1',
      title: 'C1',
      projectId: 'p1',
      isUnread: true,
      depth: 0,
      sessions: [],
      children: [],
    };
    const node2: AgentTreeNode = {
      conversationId: 'p2',
      title: 'P2',
      projectId: 'p2',
      isUnread: false,
      depth: 0,
      sessions: [],
      children: [
        {
          conversationId: 'c3',
          title: 'C3',
          projectId: 'p2',
          isUnread: true,
          depth: 1,
          sessions: [],
          children: [],
        },
      ],
    };
    const groups = [
      {
        projectId: 'p1',
        completed: 1,
        roots: [node1],
        rootTrees: flattenProjectRootTrees({ roots: [node1] }, new Set()),
      },
      {
        projectId: 'p2',
        completed: 1,
        roots: [node2],
        rootTrees: flattenProjectRootTrees({ roots: [node2] }, new Set()),
      },
    ];

    const unreadIds = collectUnreadConversationIds(groups);
    expect(unreadIds.sort()).toEqual(['c1', 'c3']);
  });
});

describe('pending timers grouping and time label', () => {
  const s = (id: string, projectId: string, fireAtMs: number): PendingTimerSummary => ({
    id, conversationId: `c-${id}`, conversationTitle: `T${id}`, projectId, projectName: `P${projectId}`,
    promptPreview: 'x', promptTruncated: false, profileId: 'p', fireAtMs, createdAt: 0, origin: 'operator',
  });

  it('groupPendingTimers groups by project in soonest-first order', () => {
    const g = groupPendingTimers([s('1', 'b', 10), s('2', 'a', 20), s('3', 'b', 30)]);
    expect(g.map((x) => x.projectId)).toEqual(['b', 'a']);
    expect(g[0].timers.map((t) => t.id)).toEqual(['1', '3']);
  });

  it('groupPendingTimers on empty input is empty', () => expect(groupPendingTimers([])).toEqual([]));

  it('timedRowTimeLabel', () => {
    expect(timedRowTimeLabel(1000, 1000)).toBe('firing…');
    expect(timedRowTimeLabel(1000, 2000)).toBe('firing…');
    expect(timedRowTimeLabel(61_000, 1000)).toBe(`in ${countdownLabel(60_000)}`);
  });
});

function conv(partial: Partial<Conversation> & Pick<Conversation, 'id'>): Conversation {
  return {
    projectId: 'proj-1',
    title: 'Chat',
    createdAt: 1_000,
    updatedAt: 2_000,
    ...partial,
  };
}

function pconv(partial: Partial<ActiveAgentConversationDto> & Pick<ActiveAgentConversationDto, 'id'>): ActiveAgentConversationDto {
  return {
    title: 'Chat',
    projectId: 'proj-1',
    ...partial,
  };
}

function spawnReq(partial: Partial<SpawnRequestRow> & Pick<SpawnRequestRow, 'id' | 'parentConversationId'>): SpawnRequestRow {
  return {
    parentSessionId: 'ps',
    prompt: 'do it',
    wait: false,
    notifyParent: true,
    status: 'pending',
    createdAt: 3_000,
    ...partial,
  };
}

function attn(partial: Partial<BuildAttentionOpts> = {}): AttentionItem[] {
  return buildAttentionItems({
    sessions: [],
    payloadConversations: [],
    payloadProjects: [{ id: 'proj-1', name: 'Alpha' }],
    conversations: [],
    projects: [{ id: 'proj-1', name: 'Alpha' }],
    conversationStatuses: {},
    errorRecoveredIds: new Set(),
    spawnRequests: [],
    ...partial,
  });
}

function item(partial: Partial<AttentionItem> & Pick<AttentionItem, 'reasons'>): AttentionItem {
  return {
    conversationId: 'c',
    title: 'Chat',
    projectId: 'proj-1',
    pendingSpawnRequests: 0,
    at: 1,
    isChild: false,
    ...partial,
  };
}

describe('buildAttentionItems', () => {
  it('includes a live waiting session as reasons [waiting]', () => {
    const items = attn({
      sessions: [sess({ sessionId: 's1', conversationId: 'c1', status: 'waiting', startedAt: 5_000 })],
      payloadConversations: [pconv({ id: 'c1', title: 'Ask me' })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.conversationId).toBe('c1');
    expect(items[0]!.reasons).toEqual(['waiting']);
    expect(items[0]!.title).toBe('Ask me');
    expect(items[0]!.at).toBe(5_000);
  });

  it('includes a live error session and excludes it when recovered', () => {
    const base = {
      sessions: [sess({ sessionId: 's1', conversationId: 'c1', status: 'error' as const })],
      payloadConversations: [pconv({ id: 'c1' })],
    };
    expect(attn(base).map((i) => i.reasons)).toEqual([['error']]);
    expect(attn({ ...base, errorRecoveredIds: new Set(['c1']) })).toEqual([]);
  });

  it('includes directory lastStatus error with no session; running WS or recovery excludes it', () => {
    const conversations = [conv({ id: 'c1', lastStatus: 'error', updatedAt: 9_000 })];
    expect(attn({ conversations }).map((i) => [i.reasons, i.at])).toEqual([[['error'], 9_000]]);
    expect(attn({ conversations, conversationStatuses: { c1: 'running' } })).toEqual([]);
    expect(attn({ conversations, errorRecoveredIds: new Set(['c1']) })).toEqual([]);
  });

  it('includes a WS error status for a directory conversation with no session', () => {
    const items = attn({
      conversations: [conv({ id: 'c1', title: 'Boom' })],
      conversationStatuses: { c1: 'error' },
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.reasons).toEqual(['error']);
    expect(items[0]!.title).toBe('Boom');
  });

  it('keeps only waiting when waiting and lastStatus error coexist', () => {
    const items = attn({
      sessions: [sess({ sessionId: 's1', conversationId: 'c1', status: 'waiting' })],
      payloadConversations: [pconv({ id: 'c1' })],
      conversations: [conv({ id: 'c1', lastStatus: 'error' })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.reasons).toEqual(['waiting']);
  });

  it('merges two pending spawn approvals with parent error into one item', () => {
    const items = attn({
      conversations: [conv({ id: 'P', lastStatus: 'error', updatedAt: 100 })],
      spawnRequests: [
        spawnReq({ id: 'r1', parentConversationId: 'P', createdAt: 200 }),
        spawnReq({ id: 'r2', parentConversationId: 'P', createdAt: 400 }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.reasons).toEqual(['error', 'spawn_approval']);
    expect(items[0]!.pendingSpawnRequests).toBe(2);
    expect(items[0]!.at).toBe(400);
  });

  it('ignores non-pending spawn requests', () => {
    expect(attn({
      conversations: [conv({ id: 'P' })],
      spawnRequests: [spawnReq({ id: 'r1', parentConversationId: 'P', status: 'approved' })],
    })).toEqual([]);
  });

  it('excludes archived error conversations and schedule_home', () => {
    expect(attn({
      conversations: [conv({ id: 'c1', lastStatus: 'error', archived: true })],
    })).toEqual([]);
    expect(attn({
      conversations: [conv({ id: 'home', lastStatus: 'error', kind: 'schedule_home' })],
    })).toEqual([]);
    expect(attn({
      sessions: [sess({ sessionId: 's1', conversationId: 'home', status: 'waiting' })],
      payloadConversations: [pconv({ id: 'home', kind: 'schedule_home' })],
    })).toEqual([]);
  });

  it('drops an unresolvable WS error ghost and keeps an unknown pending-spawn parent', () => {
    expect(attn({ conversationStatuses: { ghost: 'error' } })).toEqual([]);
    const items = attn({
      spawnRequests: [spawnReq({ id: 'r1', parentConversationId: 'ghost', createdAt: 7_000 })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.conversationId).toBe('ghost');
    expect(items[0]!.title).toBe('(unknown conversation)');
    expect(items[0]!.reasons).toEqual(['spawn_approval']);
    expect(items[0]!.projectId).toBe('');
    expect(items[0]!.at).toBe(7_000);
  });

  it('sorts newest at first, then title', () => {
    const items = attn({
      conversations: [
        conv({ id: 'old', title: 'Old', lastStatus: 'error', updatedAt: 1_000 }),
        conv({ id: 'new', title: 'New', lastStatus: 'error', updatedAt: 5_000 }),
        conv({ id: 'beta', title: 'Beta', lastStatus: 'error', updatedAt: 3_000 }),
        conv({ id: 'alpha', title: 'Alpha', lastStatus: 'error', updatedAt: 3_000 }),
      ],
    });
    expect(items.map((i) => i.conversationId)).toEqual(['new', 'alpha', 'beta', 'old']);
  });

  it('excludes done, idle, and unread-only conversations', () => {
    expect(attn({
      conversations: [
        conv({ id: 'done', lastStatus: 'done' }),
        conv({ id: 'idle', liveStatus: 'idle' }),
        conv({ id: 'plain' }),
      ],
      conversationStatuses: { idle: 'idle', done: 'done' },
    })).toEqual([]);
  });

  it('accepts conversations as a Record and as an array', () => {
    const row = conv({ id: 'c1', lastStatus: 'error' });
    const fromArray = attn({ conversations: [row] });
    const fromRecord = attn({ conversations: { 'proj-1': [row] } });
    expect(fromArray).toEqual(fromRecord);
    expect(fromArray).toHaveLength(1);
    expect(fromArray[0]!.conversationId).toBe('c1');
  });

  it('marks spawned children with isChild', () => {
    const items = attn({
      conversations: [conv({ id: 'child', lastStatus: 'error', parentConversationId: 'parent' })],
    });
    expect(items[0]!.isChild).toBe(true);
  });
});

describe('groupAttentionItems', () => {
  it('preserves project order of first appearance and keeps unknown project as its own group', () => {
    const grouped = groupAttentionItems([
      item({ conversationId: 'b1', projectId: 'proj-b', projectName: 'Bravo', reasons: ['waiting'] }),
      item({ conversationId: 'a1', projectId: 'proj-a', projectName: 'Alpha', reasons: ['error'] }),
      item({ conversationId: 'u1', projectId: '', reasons: ['spawn_approval'] }),
      item({ conversationId: 'b2', projectId: 'proj-b', projectName: 'Bravo', reasons: ['error'] }),
    ]);
    expect(grouped.map((g) => g.projectId)).toEqual(['proj-b', 'proj-a', '']);
    expect(grouped[0]!.projectName).toBe('Bravo');
    expect(grouped[0]!.items.map((i) => i.conversationId)).toEqual(['b1', 'b2']);
    expect(grouped[2]!.projectName).toBeUndefined();
    expect(grouped[2]!.items).toHaveLength(1);
  });
});

describe('attentionDotStatus / attentionReasonLabel', () => {
  it('maps reasons to labels and dots, including plural spawn approvals', () => {
    expect(attentionReasonLabel('waiting', 0)).toBe('Needs input');
    expect(attentionReasonLabel('error', 0)).toBe('Error');
    expect(attentionReasonLabel('spawn_approval', 1)).toBe('Spawn approval');
    expect(attentionReasonLabel('spawn_approval', 3)).toBe('Spawn approvals (3)');
    expect(attentionDotStatus(item({ reasons: ['waiting'] }))).toBe('waiting');
    expect(attentionDotStatus(item({ reasons: ['error', 'spawn_approval'] }))).toBe('waiting');
    expect(attentionDotStatus(item({ reasons: ['error'] }))).toBe('error');
  });
});



describe('activityAgentLabel', () => {
  it('prefixes model-only labels with the agent name', () => {
    expect(activityAgentLabel('GLM-5.3-Flash', 'kilocode')).toMatch(/^Kilo ?Code · GLM-5.3-Flash$/);
    expect(sessionMetaParts(activityAgentLabel('GLM-5.3-Flash', 'opencode'), 'GLM-5.3-Flash').agent).toBe('OpenCode');
  });
  it('keeps labels that already carry the agent, and names unknown profiles', () => {
    expect(activityAgentLabel('Claude Code · Haiku 4.5', 'claude-code')).toBe('Claude Code · Haiku 4.5');
    expect(activityAgentLabel('Claude Code', 'claude-code')).toBe('Claude Code');
    expect(activityAgentLabel(undefined, 'claude-code')).toBe('Claude Code');
  });
});
