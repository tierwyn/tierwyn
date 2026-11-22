import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PublicNotificationSettings } from '@tierwyn/shared';
import { NOTIFICATION_DEFAULTS } from '@tierwyn/shared';
import { NotificationDispatcher } from './notifications.js';

const { vapidPrivateKey: _omit, ...pub } = NOTIFICATION_DEFAULTS;
const settings: PublicNotificationSettings = { ...pub, enabled: true };

let shown: ReturnType<typeof vi.fn>;
let d: NotificationDispatcher;

beforeEach(() => {
  shown = vi.fn();
  vi.stubGlobal('Notification', Object.assign(
    function (this: unknown, title: string, opts: unknown) { shown(title, opts); },
    { permission: 'granted' },
  ));
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  d = new NotificationDispatcher(() => ({
    settings,
    deviceEnabled: true,
    selectedConversationId: null,
    lookup: () => ({ title: 'Impl' }),
    lookupProjectName: () => 'Tierwyn',
    onClick: () => {},
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const done = (extra: object = {}) => ({
  type: 'conversation_updated' as const, conversationId: 'c1', ts: 1, status: 'done' as const, ...extra,
});
const runEnded = (extra: object = {}) => ({
  type: 'schedule_updated' as const, projectId: 'p1', jobId: 'j1', runId: 'r1',
  runStatus: 'succeeded' as const, jobName: 'nightly', ...extra,
});

describe('NotificationDispatcher interruptWorthy', () => {
  it('interruptWorthy false suppresses completion toast', () => {
    d.observeStatus('c1', 'running');
    d.handleConversationUpdated(done({ interruptWorthy: false }));
    expect(shown).not.toHaveBeenCalled();
    // Still disarmed: a stray unstamped frame cannot toast afterwards.
    d.handleConversationUpdated(done());
    expect(shown).not.toHaveBeenCalled();
  });

  it('interruptWorthy false suppresses scheduleRunEnded toast', () => {
    d.handleScheduleUpdated(runEnded({ interruptWorthy: false }));
    expect(shown).not.toHaveBeenCalled();
  });

  it('absent interruptWorthy still toasts (regression)', () => {
    d.observeStatus('c1', 'running');
    d.handleConversationUpdated(done());
    expect(shown).toHaveBeenCalledTimes(1);
    d.handleScheduleUpdated(runEnded());
    expect(shown).toHaveBeenCalledTimes(2);
  });

  it('interruptWorthy true still toasts', () => {
    d.observeStatus('c1', 'running');
    d.handleConversationUpdated(done({ interruptWorthy: true }));
    expect(shown).toHaveBeenCalledTimes(1);
  });
});
