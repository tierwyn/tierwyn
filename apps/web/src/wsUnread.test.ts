import { describe, it, expect } from 'vitest';
import { resolveConversationDot } from './statusDot.js';
import {
  initialUnreadMachine,
  reduceConversationUpdated,
  reduceSubscribe,
} from './wsUnread.js';

function unreadDot(unreadIds: readonly string[], conversationId = 'A'): string {
  return resolveConversationDot({
    isSelected: false,
    liveStatus: undefined,
    lastStatus: undefined,
    isUnread: unreadIds.includes(conversationId),
    descendantActive: false,
    manuallyMarkedUnread: false,
  }).dotClass;
}

describe('held-open parked-blue unread machine', () => {
  it('held-open done on a conversation the operator is not viewing turns the dot unread (blue)', () => {
    let s = initialUnreadMachine();
    s = reduceSubscribe(s, 'B');
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'running' });
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'done' });

    expect(s.unreadIds).toContain('A');
    expect(unreadDot(s.unreadIds)).toBe('status-dot unread');
  });

  it('idle after parked-done does not clear unread', () => {
    let s = initialUnreadMachine();
    s = reduceSubscribe(s, 'B');
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'done' });
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'idle' });

    expect(s.unreadIds).toContain('A');
    expect(unreadDot(s.unreadIds)).toBe('status-dot unread');
  });

  it('watching parked-done then leaving does not mark unread (operator already saw the turn end)', () => {
    let s = initialUnreadMachine();
    s = reduceSubscribe(s, 'A');
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'running' });
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'done' });

    expect(s.unreadIds).not.toContain('A');
    expect(s.pendingLeaveUnread.has('A')).toBe(false);

    s = reduceSubscribe(s, 'B');
    expect(s.unreadIds).not.toContain('A');
    expect(unreadDot(s.unreadIds)).toBe('status-dot grey');
  });

  it('subscribe replay of parked-done does not re-queue unread on the next leave', () => {
    // Server subscribe handler re-sends conversation_updated {status:done} for a
    // hold-open session so the header/Stop unstick from session_started=running.
    // That replay must not be treated as a fresh terminal event.
    let s = initialUnreadMachine();
    s = reduceSubscribe(s, 'B');
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'done' });
    expect(s.unreadIds).toContain('A');

    s = reduceSubscribe(s, 'A');
    expect(s.unreadIds).not.toContain('A');
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'done' });

    s = reduceSubscribe(s, 'B');
    expect(s.unreadIds).not.toContain('A');
    expect(s.pendingLeaveUnread.has('A')).toBe(false);
    expect(unreadDot(s.unreadIds)).toBe('status-dot grey');
  });

  it('subscribing to the parked conversation clears blue', () => {
    let s = initialUnreadMachine();
    s = reduceSubscribe(s, 'B');
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'done' });
    expect(s.unreadIds).toContain('A');

    s = reduceSubscribe(s, 'A');
    expect(s.unreadIds).not.toContain('A');
    expect(s.pendingLeaveUnread.has('A')).toBe(false);
  });

  it('idle while subscribed does not queue leave-unread (stop of a still-running turn)', () => {
    let s = initialUnreadMachine();
    s = reduceSubscribe(s, 'A');
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'running' });
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'idle' });
    expect(s.pendingLeaveUnread.has('A')).toBe(false);
    s = reduceSubscribe(s, 'B');
    expect(s.unreadIds).not.toContain('A');
  });

  it('a parked conversation the operator already viewed since done is not blue after leaving', () => {
    let s = initialUnreadMachine();
    s = reduceSubscribe(s, 'B');
    s = reduceConversationUpdated(s, { conversationId: 'A', status: 'done' });
    s = reduceSubscribe(s, 'A');
    s = reduceSubscribe(s, 'B');
    expect(s.unreadIds).not.toContain('A');
    expect(unreadDot(s.unreadIds)).toBe('status-dot grey');
  });
});
