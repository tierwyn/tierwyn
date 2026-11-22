import { describe, it, expect } from 'vitest';
import {
  resolveConversationDot,
  hasActiveDescendant,
  runStatusToAgentFallback,
  runFallbackStatus,
  resolveJobAggregateDot,
  isLiveAgentStatus,
  effectiveLiveStatus,
  resolveRunChip,
  sessionBadgeFromDot,
  sessionBadgeForScheduleJob,
} from './statusDot.js';

describe('runStatusToAgentFallback', () => {
  it('maps lifecycle statuses to agent-ish fallbacks', () => {
    expect(runStatusToAgentFallback('running')).toBe('running');
    expect(runStatusToAgentFallback('pending')).toBe('running');
    expect(runStatusToAgentFallback('failed')).toBe('error');
    expect(runStatusToAgentFallback('timed_out')).toBe('error');
    expect(runStatusToAgentFallback('succeeded')).toBe('done');
    expect(runStatusToAgentFallback('skipped')).toBeUndefined();
  });
});

describe('isLiveAgentStatus', () => {
  it('only running and waiting are live', () => {
    expect(isLiveAgentStatus('running')).toBe(true);
    expect(isLiveAgentStatus('waiting')).toBe(true);
    expect(isLiveAgentStatus('error')).toBe(false);
    expect(isLiveAgentStatus('done')).toBe(false);
    expect(isLiveAgentStatus(undefined)).toBe(false);
  });
});

describe('resolveConversationDot matrix', () => {
  const base = {
    isSelected: false as boolean,
    selectedBadgeStatus: undefined as undefined,
    manuallyMarkedUnread: false,
    liveStatus: undefined as undefined,
    lastStatus: undefined as undefined,
    isUnread: false,
    descendantActive: false,
  };

  it('live running wins over everything', () => {
    const r = resolveConversationDot({
      ...base,
      liveStatus: 'running',
      lastStatus: 'error',
      isUnread: true,
      descendantActive: true,
      isSelected: true,
      selectedBadgeStatus: 'done',
    });
    expect(r.dotClass).toBe('status-dot running');
  });

  it('live waiting wins', () => {
    const r = resolveConversationDot({ ...base, liveStatus: 'waiting', descendantActive: true });
    expect(r.dotClass).toBe('status-dot waiting');
  });

  it('live error wins', () => {
    const r = resolveConversationDot({ ...base, liveStatus: 'error', isUnread: true });
    expect(r.dotClass).toBe('status-dot error');
  });

  it('descendant-active when idle and child live', () => {
    const r = resolveConversationDot({ ...base, descendantActive: true });
    expect(r.dotClass).toBe('status-dot descendant-active');
  });

  it('helpers-active when idle with native helpers running', () => {
    const r = resolveConversationDot({ ...base, helpersActive: true });
    expect(r.dotClass).toBe('status-dot helpers-active');
    expect(r.title).toBe('helpers running');
  });

  it('live running still wins over helpers-active', () => {
    const r = resolveConversationDot({ ...base, liveStatus: 'running', helpersActive: true });
    expect(r.dotClass).toBe('status-dot running');
  });

  it('descendant-active wins over helpers-active', () => {
    const r = resolveConversationDot({ ...base, descendantActive: true, helpersActive: true });
    expect(r.dotClass).toBe('status-dot descendant-active');
  });

  it('unread → unread class', () => {
    const r = resolveConversationDot({ ...base, isUnread: true });
    expect(r.dotClass).toBe('status-dot unread');
  });

  it('lastStatus done with unread → unread class', () => {
    const r = resolveConversationDot({ ...base, lastStatus: 'done', isUnread: true });
    expect(r.dotClass).toBe('status-dot unread');
  });

  it('fully idle → grey', () => {
    const r = resolveConversationDot({ ...base });
    expect(r.dotClass).toBe('status-dot grey');
  });

  it('selected badge done → green pulse when live map empty', () => {
    const r = resolveConversationDot({
      ...base,
      isSelected: true,
      selectedBadgeStatus: 'done',
    });
    expect(r.dotClass).toBe('status-dot done');
    expect(r.title).toBe('recent');
  });

  it('selected badge grey with descendant → descendant-active', () => {
    const r = resolveConversationDot({
      ...base,
      isSelected: true,
      selectedBadgeStatus: 'grey',
      descendantActive: true,
    });
    expect(r.dotClass).toBe('status-dot descendant-active');
  });

  it('lastStatus running used when live empty (REST / run fallback)', () => {
    const r = resolveConversationDot({ ...base, lastStatus: 'running' });
    expect(r.dotClass).toBe('status-dot running');
  });

  it('non-selected ignores selectedBadgeStatus', () => {
    const r = resolveConversationDot({
      ...base,
      isSelected: false,
      selectedBadgeStatus: 'done',
    });
    expect(r.dotClass).toBe('status-dot grey');
  });

  it('unread uses the new unread class, not green done', () => {
    const r = resolveConversationDot({ ...base, isUnread: true });
    expect(r.dotClass).toBe('status-dot unread');
    expect(r.title).toBe('unread');
  });

  it('unreadClass override opts a surface back into schedule green', () => {
    const r = resolveConversationDot({ ...base, isUnread: true, unreadClass: 'done' });
    expect(r.dotClass).toBe('status-dot done');
  });

  it('manual mark-unread on the selected row uses the unread class', () => {
    const r = resolveConversationDot({
      ...base, isSelected: true, selectedBadgeStatus: 'grey', manuallyMarkedUnread: true,
    });
    expect(r.dotClass).toBe('status-dot unread');
  });

  it('selected "recently completed" pulse stays green done, not unread', () => {
    const r = resolveConversationDot({ ...base, isSelected: true, selectedBadgeStatus: 'done' });
    expect(r.dotClass).toBe('status-dot done');
    expect(r.title).toBe('recent');
  });

  it('errorRecovered suppresses sticky lastStatus error', () => {
    const r = resolveConversationDot({ ...base, lastStatus: 'error', errorRecovered: true });
    expect(r.dotClass).toBe('status-dot grey');
  });

  it('errorRecovered does NOT suppress a live error', () => {
    const r = resolveConversationDot({ ...base, liveStatus: 'error', errorRecovered: true });
    expect(r.dotClass).toBe('status-dot error');
  });

  it('resume path: sticky error + live running → running', () => {
    const r = resolveConversationDot({ ...base, lastStatus: 'error', liveStatus: 'running' });
    expect(r.dotClass).toBe('status-dot running');
  });

  it('after a recovered turn finishes unviewed → unread, not error', () => {
    const r = resolveConversationDot({
      ...base, lastStatus: 'error', errorRecovered: true, isUnread: true,
    });
    expect(r.dotClass).toBe('status-dot unread');
  });

  it('without errorRecovered the sticky error still reddens', () => {
    const r = resolveConversationDot({ ...base, lastStatus: 'error' });
    expect(r.dotClass).toBe('status-dot error');
  });
});

describe('hasActiveDescendant', () => {
  it('detects nested live children', () => {
    const children = new Map<string, { id: string }[]>([
      ['root', [{ id: 'a' }]],
      ['a', [{ id: 'b' }]],
    ]);
    expect(hasActiveDescendant('root', children, { b: 'running' })).toBe(true);
    expect(hasActiveDescendant('root', children, { b: 'done' })).toBe(false);
    expect(hasActiveDescendant('root', children, {})).toBe(false);
  });

  it('falls back to REST liveStatus on children', () => {
    const children = new Map<string, { id: string; liveStatus?: 'running' }[]>([
      ['root', [{ id: 'child', liveStatus: 'running' }]],
    ]);
    expect(hasActiveDescendant('root', children, {})).toBe(true);
  });
});

describe('effectiveLiveStatus', () => {
  it('prefers WS map over REST liveStatus', () => {
    expect(effectiveLiveStatus('c1', { c1: 'waiting' }, { liveStatus: 'running' })).toBe('waiting');
  });

  it('uses REST liveStatus when WS map is empty and never observed', () => {
    expect(effectiveLiveStatus('c1', {}, { liveStatus: 'running' })).toBe('running');
  });

  it('ignores stale REST liveStatus once WS has observed the conversation', () => {
    // After status:done the map entry is deleted but parked sessions still
    // report liveStatus:running on the REST snapshot until refetch.
    expect(
      effectiveLiveStatus('c1', {}, { liveStatus: 'running' }, new Set(['c1'])),
    ).toBeUndefined();
  });

  it('still returns WS map value when observed', () => {
    expect(
      effectiveLiveStatus('c1', { c1: 'running' }, { liveStatus: 'waiting' }, new Set(['c1'])),
    ).toBe('running');
  });
});

describe('resolveJobAggregateDot', () => {
  const idleJob = {
    isRunUnread: () => false,
    isRunDescendantActive: () => false,
    jobEnabled: true,
    isRunErrorRecovered: () => false,
  };

  it('prefers live error over running', () => {
    const r = resolveJobAggregateDot({
      runs: [
        { status: 'running', conversationId: 'c1' },
        { status: 'running', conversationId: 'c2' },
      ],
      conversationStatuses: { c1: 'running', c2: 'error' },
      ...idleJob,
    });
    expect(r.dotClass).toBe('status-dot error');
  });

  it('shows running when any run live', () => {
    const r = resolveJobAggregateDot({
      runs: [{ status: 'running', conversationId: 'c1' }],
      conversationStatuses: { c1: 'running' },
      ...idleJob,
    });
    expect(r.dotClass).toBe('status-dot running');
  });

  it('shows waiting when any run waiting', () => {
    const r = resolveJobAggregateDot({
      runs: [{ status: 'running', conversationId: 'c1' }],
      conversationStatuses: { c1: 'waiting' },
      ...idleJob,
    });
    expect(r.dotClass).toBe('status-dot waiting');
  });

  it('uses REST liveStatus when WS map is empty', () => {
    const r = resolveJobAggregateDot({
      runs: [{ status: 'running', conversationId: 'c1', liveStatus: 'running' }],
      conversationStatuses: {},
      ...idleJob,
    });
    expect(r.dotClass).toBe('status-dot running');
  });

  it('enabled job with no activity shows the armed colour', () => {
    const r = resolveJobAggregateDot({
      runs: [], conversationStatuses: {},
      isRunUnread: () => false, isRunDescendantActive: () => false,
      jobEnabled: true, isRunErrorRecovered: () => false,
    });
    expect(r.dotClass).toBe('status-dot job-enabled');
    expect(r.title).toBe('enabled');
  });

  it('disabled job with no activity stays grey', () => {
    const r = resolveJobAggregateDot({
      runs: [], conversationStatuses: {},
      isRunUnread: () => false, isRunDescendantActive: () => false,
      jobEnabled: false, isRunErrorRecovered: () => false,
    });
    expect(r.dotClass).toBe('status-dot grey');
    expect(r.title).toBe('disabled');
  });

  it('enabled job with a live run still shows running, not armed', () => {
    const r = resolveJobAggregateDot({
      runs: [{ status: 'running', conversationId: 'c1' }],
      conversationStatuses: { c1: 'running' },
      isRunUnread: () => false, isRunDescendantActive: () => false,
      jobEnabled: true, isRunErrorRecovered: () => false,
    });
    expect(r.dotClass).toBe('status-dot running');
  });

  it('a recovered failed run stops reddening the job parent', () => {
    const r = resolveJobAggregateDot({
      runs: [{ status: 'failed', conversationId: 'c1' }],
      conversationStatuses: {},
      isRunUnread: () => true, isRunDescendantActive: () => false,
      jobEnabled: true, isRunErrorRecovered: (cid) => cid === 'c1',
    });
    expect(r.dotClass).not.toBe('status-dot error');
  });

  it('a recovered failed unviewed run shows sky-blue unread on the job parent, not armed teal', () => {
    const r = resolveJobAggregateDot({
      runs: [{ status: 'failed', conversationId: 'c1' }],
      conversationStatuses: {},
      isRunUnread: () => true, isRunDescendantActive: () => false,
      jobEnabled: true, isRunErrorRecovered: (cid) => cid === 'c1',
    });
    expect(r.dotClass).toBe('status-dot unread');
    expect(r.title).toBe('unread');
  });

  it('an unrecovered failed unviewed run still reddens the job parent', () => {
    const r = resolveJobAggregateDot({
      runs: [{ status: 'failed', conversationId: 'c1' }],
      conversationStatuses: {},
      isRunUnread: () => true, isRunDescendantActive: () => false,
      jobEnabled: true, isRunErrorRecovered: () => false,
    });
    expect(r.dotClass).toBe('status-dot error');
  });

  it('unread schedule activity is sky-blue unread (same as rows) on the job parent', () => {
    const r = resolveJobAggregateDot({
      runs: [{ status: 'succeeded', conversationId: 'c1' }],
      conversationStatuses: {},
      isRunUnread: () => true, isRunDescendantActive: () => false,
      jobEnabled: true, isRunErrorRecovered: () => false,
    });
    expect(r.dotClass).toBe('status-dot unread');
  });
});

describe('sessionBadgeFromDot', () => {
  it('maps job aggregate dots to session-header pill classes', () => {
    expect(sessionBadgeFromDot({ dotClass: 'status-dot running', title: 'running' })).toEqual({
      badgeClass: 'running', label: 'running', inFlight: true,
    });
    expect(sessionBadgeFromDot({ dotClass: 'status-dot waiting', title: 'waiting' })).toEqual({
      badgeClass: 'waiting', label: 'waiting', inFlight: true,
    });
    expect(sessionBadgeFromDot({ dotClass: 'status-dot error', title: 'error' })).toEqual({
      badgeClass: 'error', label: 'error', inFlight: false,
    });
    expect(sessionBadgeFromDot({ dotClass: 'status-dot job-enabled', title: 'enabled' })).toEqual({
      badgeClass: 'job-enabled', label: 'enabled', inFlight: false,
    });
    expect(sessionBadgeFromDot({ dotClass: 'status-dot grey', title: 'disabled' })).toEqual({
      badgeClass: 'disabled', label: 'disabled', inFlight: false,
    });
    expect(sessionBadgeFromDot({ dotClass: 'status-dot done', title: 'unread' })).toEqual({
      badgeClass: 'done', label: 'unread', inFlight: false,
    });
    expect(sessionBadgeFromDot({ dotClass: 'status-dot descendant-active', title: 'subagent active' })).toEqual({
      badgeClass: 'descendant-active', label: 'subagent', inFlight: true,
    });
  });
});

describe('sessionBadgeForScheduleJob', () => {
  it('forces muted disabled when job is off, even if aggregate is unread green', () => {
    expect(
      sessionBadgeForScheduleJob({ dotClass: 'status-dot done', title: 'unread' }, false),
    ).toEqual({ badgeClass: 'disabled', label: 'disabled', inFlight: false });
    expect(
      sessionBadgeForScheduleJob({ dotClass: 'status-dot grey', title: 'disabled' }, false),
    ).toEqual({ badgeClass: 'disabled', label: 'disabled', inFlight: false });
  });

  it('still surfaces live/error while a disabled job finishes a run', () => {
    expect(
      sessionBadgeForScheduleJob({ dotClass: 'status-dot running', title: 'running' }, false),
    ).toEqual({ badgeClass: 'running', label: 'running', inFlight: true });
    expect(
      sessionBadgeForScheduleJob({ dotClass: 'status-dot error', title: 'error' }, false),
    ).toEqual({ badgeClass: 'error', label: 'error', inFlight: false });
  });

  it('leaves enabled jobs on the aggregate colour', () => {
    expect(
      sessionBadgeForScheduleJob({ dotClass: 'status-dot job-enabled', title: 'enabled' }, true),
    ).toEqual({ badgeClass: 'job-enabled', label: 'enabled', inFlight: false });
  });
});

describe('resolveRunChip', () => {
  it('prefers live agent status over run lifecycle', () => {
    expect(resolveRunChip({ runStatus: 'succeeded', liveStatus: 'running' })).toEqual({
      label: 'running', colorVar: 'var(--amber)',
    });
    expect(resolveRunChip({ runStatus: 'running', liveStatus: 'waiting' })).toEqual({
      label: 'waiting', colorVar: 'var(--amber)',
    });
    expect(resolveRunChip({ runStatus: 'running', liveStatus: 'error' })).toEqual({
      label: 'error', colorVar: 'var(--red)',
    });
  });

  it('falls back to run lifecycle when live map empty', () => {
    expect(resolveRunChip({ runStatus: 'succeeded', liveStatus: undefined }).label).toBe('succeeded');
    expect(resolveRunChip({ runStatus: 'failed', liveStatus: undefined }).colorVar).toBe('var(--red)');
    expect(resolveRunChip({ runStatus: 'pending', liveStatus: undefined }).colorVar).toBe('var(--text-3)');
    expect(resolveRunChip({ runStatus: 'timed_out', liveStatus: undefined })).toEqual({
      label: 'timed_out', colorVar: 'var(--red)',
    });
    expect(resolveRunChip({ runStatus: 'skipped', liveStatus: undefined })).toEqual({
      label: 'skipped', colorVar: 'var(--text-3)',
    });
  });

  it('live done/idle do not override lifecycle colour (only running/waiting/error win)', () => {
    // resolveRunChip only special-cases live running/waiting/error; done falls through.
    expect(resolveRunChip({ runStatus: 'failed', liveStatus: 'done' })).toEqual({
      label: 'failed', colorVar: 'var(--red)',
    });
  });
});

describe('runFallbackStatus', () => {
  it('drops a failed run to undefined once viewed after it finished', () => {
    const run = { status: 'failed' as const, firedAt: 100, finishedAt: 200 };
    expect(runFallbackStatus(run, undefined)).toBe('error');
    expect(runFallbackStatus(run, { lastViewedAt: 150 })).toBe('error');
    expect(runFallbackStatus(run, { lastViewedAt: 200 })).toBeUndefined();
    expect(runFallbackStatus({ status: 'succeeded', firedAt: 1 }, { lastViewedAt: 9 })).toBe('done');
  });
});
