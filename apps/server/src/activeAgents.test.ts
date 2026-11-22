import { describe, it, expect } from 'vitest';
import type { AgentStatus, EffortLevel, ConversationKind } from '@tierwyn/shared';
import {
  buildActiveSessionsResponse,
  isParkedSession,
  MAX_ANCESTOR_DEPTH,
  type ActiveAgentSessionLike,
  type ActiveAgentConversationRow,
} from './activeAgents.js';

function session(partial: Partial<ActiveAgentSessionLike> & Pick<ActiveAgentSessionLike, 'id' | 'conversationId'>): ActiveAgentSessionLike {
  return {
    agentType: 'claude-code',
    profileId: 'claude-code:opus',
    model: 'opus',
    startedAt: 1_000,
    ...partial,
  };
}

function conv(
  id: string,
  opts: {
    title?: string;
    projectId?: string;
    parentConversationId?: string;
    kind?: ConversationKind;
    description?: string;
    tags?: string[];
  } = {},
): ActiveAgentConversationRow {
  return {
    id,
    title: opts.title ?? id,
    projectId: opts.projectId ?? 'proj-1',
    ...(opts.parentConversationId ? { parentConversationId: opts.parentConversationId } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
  };
}

function lookups(
  conversations: ActiveAgentConversationRow[],
  projects: { id: string; name: string }[] = [{ id: 'proj-1', name: 'Alpha' }],
) {
  const convMap = new Map(conversations.map((c) => [c.id, c]));
  const projMap = new Map(projects.map((p) => [p.id, p]));
  return {
    lookupConversation: (id: string) => convMap.get(id),
    lookupProject: (id: string) => projMap.get(id),
  };
}

describe('buildActiveSessionsResponse', () => {
  it('emits one session DTO, one conversation DTO, one project, and echoes now', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1', { title: 'Root chat' })]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'c1' })],
      lookupConversation,
      lookupProject,
      9_000,
    );
    expect(body.now).toBe(9_000);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      sessionId: 's1',
      conversationId: 'c1',
      agentType: 'claude-code',
      profileId: 'claude-code:opus',
      model: 'opus',
      startedAt: 1_000,
    });
    expect(body.conversations).toEqual([
      { id: 'c1', title: 'Root chat', projectId: 'proj-1' },
    ]);
    expect(body.projects).toEqual([{ id: 'proj-1', name: 'Alpha' }]);
  });

  it('carries effort when present and omits the key when undefined', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1')]);
    const withEffort = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'c1', effort: 'high' as EffortLevel })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(withEffort.sessions[0]!.effort).toBe('high');

    const without = buildActiveSessionsResponse(
      [session({ id: 's2', conversationId: 'c1' })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect('effort' in without.sessions[0]!).toBe(false);
  });

  it('maps lastStatus running/waiting/error through as-is', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1')]);
    for (const lastStatus of ['running', 'waiting', 'error'] as AgentStatus[]) {
      const body = buildActiveSessionsResponse(
        [session({ id: 's1', conversationId: 'c1', lastStatus })],
        lookupConversation,
        lookupProject,
        1,
      );
      expect(body.sessions[0]!.status).toBe(lastStatus);
    }
  });

  it('carries description and tags on conversation DTOs when present', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('c1', {
        title: 'Tagged conv',
        description: 'Testing active agents modal description',
        tags: ['bug', 'urgent'],
      }),
    ]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'c1' })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.conversations[0]).toMatchObject({
      id: 'c1',
      title: 'Tagged conv',
      description: 'Testing active agents modal description',
      tags: ['bug', 'urgent'],
    });
  });

  it('maps absent lastStatus to running', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1')]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'c1', lastStatus: undefined })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.sessions[0]!.status).toBe('running');
  });

  it('omits parked done/idle sessions with an empty steer queue', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1')]);
    for (const lastStatus of ['done', 'idle'] as AgentStatus[]) {
      const body = buildActiveSessionsResponse(
        [session({ id: 's1', conversationId: 'c1', lastStatus })],
        lookupConversation,
        lookupProject,
        1,
      );
      expect(body.sessions).toEqual([]);
      expect(body.conversations).toEqual([]);
      expect(body.projects).toEqual([]);
    }
  });

  it('keeps a settled session that still has a pending steer', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1')]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'c1', lastStatus: 'done', steerQueueLength: 1 })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.sessionId).toBe('s1');
    expect(body.sessions[0]!.status).toBe('idle');
    expect(body.conversations).toHaveLength(1);
  });

  it('keeps running, waiting, error, and absent lastStatus', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1')]);
    const cases: { lastStatus?: AgentStatus; expected: AgentStatus }[] = [
      { lastStatus: 'running', expected: 'running' },
      { lastStatus: 'waiting', expected: 'waiting' },
      { lastStatus: 'error', expected: 'error' },
      { lastStatus: undefined, expected: 'running' },
    ];
    for (const { lastStatus, expected } of cases) {
      const body = buildActiveSessionsResponse(
        [session({ id: 's1', conversationId: 'c1', lastStatus })],
        lookupConversation,
        lookupProject,
        1,
      );
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0]!.status).toBe(expected);
    }
  });

  it('drops a parked leaf conversation and does not emit orphan ancestors', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('a', { title: 'A' }),
      conv('b', { title: 'B', parentConversationId: 'a' }),
      conv('c', { title: 'C', parentConversationId: 'b' }),
    ]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's-leaf', conversationId: 'c', lastStatus: 'done' })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.sessions).toEqual([]);
    expect(body.conversations).toEqual([]);
    expect(body.projects).toEqual([]);
  });

  it('keeps an ancestor when a sibling session is still live after a parked leaf is hidden', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('root', { title: 'Root' }),
      conv('left', { title: 'Left', parentConversationId: 'root' }),
      conv('right', { title: 'Right', parentConversationId: 'root' }),
    ]);
    const body = buildActiveSessionsResponse(
      [
        session({ id: 's-live', conversationId: 'left', lastStatus: 'running' }),
        session({ id: 's-parked', conversationId: 'right', lastStatus: 'idle' }),
      ],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.sessionId).toBe('s-live');
    expect(body.conversations.map((c) => c.id).sort()).toEqual(['left', 'root']);
    expect(body.conversations.find((c) => c.id === 'right')).toBeUndefined();
  });

  it('hides a parked child under a live parent without emitting the child conversation', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('parent', { title: 'Parent' }),
      conv('child', { title: 'Child', parentConversationId: 'parent' }),
    ]);
    const body = buildActiveSessionsResponse(
      [
        session({ id: 's-parent', conversationId: 'parent', lastStatus: 'running' }),
        session({ id: 's-child', conversationId: 'child', lastStatus: 'done' }),
      ],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['s-parent']);
    expect(body.conversations.map((c) => c.id)).toEqual(['parent']);
  });

  it('emits an inactive parent conversation that has no session of its own', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('parent', { title: 'Parent' }),
      conv('child', { title: 'Child', parentConversationId: 'parent' }),
    ]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'child' })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.sessions).toHaveLength(1);
    expect(body.conversations.map((c) => c.id).sort()).toEqual(['child', 'parent']);
    expect(body.conversations.find((c) => c.id === 'child')?.parentConversationId).toBe('parent');
    expect(body.conversations.find((c) => c.id === 'parent')?.parentConversationId).toBeUndefined();
  });

  it('emits a 3-deep ancestor chain when only the leaf is active', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('a', { title: 'A' }),
      conv('b', { title: 'B', parentConversationId: 'a' }),
      conv('c', { title: 'C', parentConversationId: 'b' }),
    ]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'c' })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.conversations).toHaveLength(3);
    const byId = Object.fromEntries(body.conversations.map((c) => [c.id, c]));
    expect(byId['c']?.parentConversationId).toBe('b');
    expect(byId['b']?.parentConversationId).toBe('a');
    expect(byId['a']?.parentConversationId).toBeUndefined();
  });

  it('emits two session DTOs and exactly one conversation DTO when they share a conversation', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1')]);
    const body = buildActiveSessionsResponse(
      [
        session({ id: 's1', conversationId: 'c1', startedAt: 1 }),
        session({ id: 's2', conversationId: 'c1', startedAt: 2 }),
      ],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.id).toBe('c1');
  });

  it('emits a shared ancestor exactly once', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('root'),
      conv('left', { parentConversationId: 'root' }),
      conv('right', { parentConversationId: 'root' }),
    ]);
    const body = buildActiveSessionsResponse(
      [
        session({ id: 's1', conversationId: 'left' }),
        session({ id: 's2', conversationId: 'right' }),
      ],
      lookupConversation,
      lookupProject,
      1,
    );
    const ancestorHits = body.conversations.filter((c) => c.id === 'root');
    expect(ancestorHits).toHaveLength(1);
    expect(body.conversations.map((c) => c.id).sort()).toEqual(['left', 'right', 'root']);
  });

  it('terminates a parent cycle and emits each conversation once', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('a', { parentConversationId: 'b' }),
      conv('b', { parentConversationId: 'a' }),
    ]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'a' })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.conversations.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('caps ancestor walks at MAX_ANCESTOR_DEPTH + 1 conversations', () => {
    const chain: ActiveAgentConversationRow[] = [];
    const length = MAX_ANCESTOR_DEPTH + 8;
    for (let i = 0; i < length; i++) {
      chain.push(conv(`c${i}`, i === 0 ? {} : { parentConversationId: `c${i - 1}` }));
    }
    const { lookupConversation, lookupProject } = lookups(chain);
    const leafId = `c${length - 1}`;
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: leafId })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.conversations.length).toBeLessThanOrEqual(MAX_ANCESTOR_DEPTH + 1);
    expect(body.conversations.length).toBe(MAX_ANCESTOR_DEPTH + 1);
  });

  it('emits a schedule_home ancestor with kind and keeps both tick and spawn sessions', () => {
    const { lookupConversation, lookupProject } = lookups([
      conv('home', { title: '⏱ Nightly triage', kind: 'schedule_home' }),
      conv('tick', { title: '⏱ Nightly triage @ 2026-08-29T03:00', parentConversationId: 'home' }),
      conv('spawnChild', { title: 'Grok 4.6 Implementer', parentConversationId: 'tick' }),
    ]);
    const body = buildActiveSessionsResponse(
      [
        session({ id: 's-tick', conversationId: 'tick' }),
        session({ id: 's-child', conversationId: 'spawnChild' }),
      ],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.conversations).toHaveLength(3);
    expect(body.conversations.map((c) => c.id).sort()).toEqual(['home', 'spawnChild', 'tick']);
    expect(body.conversations.find((c) => c.id === 'home')?.kind).toBe('schedule_home');
    expect(body.conversations.find((c) => c.id === 'tick')?.kind).toBeUndefined();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['s-tick', 's-child']);
  });

  it('preserves a session whose conversation row is missing and synthesizes a placeholder', () => {
    const { lookupConversation, lookupProject } = lookups([]);
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'gone' })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.sessionId).toBe('s1');
    expect(body.conversations).toEqual([
      { id: 'gone', title: '(deleted conversation)', projectId: '' },
    ]);
    expect(body.projects).toEqual([]);
  });

  it('omits a missing project without throwing', () => {
    const { lookupConversation, lookupProject } = lookups(
      [conv('c1', { projectId: 'missing' })],
      [],
    );
    const body = buildActiveSessionsResponse(
      [session({ id: 's1', conversationId: 'c1' })],
      lookupConversation,
      lookupProject,
      1,
    );
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.projectId).toBe('missing');
    expect(body.projects).toEqual([]);
  });

  it('returns empty arrays when there are no sessions', () => {
    const { lookupConversation, lookupProject } = lookups([conv('c1')]);
    const body = buildActiveSessionsResponse([], lookupConversation, lookupProject, 42);
    expect(body).toEqual({ sessions: [], conversations: [], projects: [], now: 42 });
  });
});

describe('isParkedSession', () => {
  it('is true for done/idle with an empty or omitted queue', () => {
    expect(isParkedSession({ lastStatus: 'done' })).toBe(true);
    expect(isParkedSession({ lastStatus: 'idle' })).toBe(true);
    expect(isParkedSession({ lastStatus: 'done', steerQueueLength: 0 })).toBe(true);
    expect(isParkedSession({ lastStatus: 'idle', steerQueueLength: 0 })).toBe(true);
  });

  it('is false when a settled session still has a queued follow-up', () => {
    expect(isParkedSession({ lastStatus: 'done', steerQueueLength: 1 })).toBe(false);
    expect(isParkedSession({ lastStatus: 'idle', steerQueueLength: 2 })).toBe(false);
  });

  it('is false for running, waiting, error, and absent lastStatus', () => {
    expect(isParkedSession({ lastStatus: 'running' })).toBe(false);
    expect(isParkedSession({ lastStatus: 'waiting' })).toBe(false);
    expect(isParkedSession({ lastStatus: 'error' })).toBe(false);
    expect(isParkedSession({ lastStatus: undefined })).toBe(false);
    expect(isParkedSession({})).toBe(false);
  });
});
