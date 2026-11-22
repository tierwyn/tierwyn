import type { ConversationUpdatedFrame } from '@tierwyn/shared';

export interface UnreadMachine {
  subscribedId: string | null;
  unreadIds: readonly string[];
  /**
   * Promote-on-leave queue. Live or subscribe-replayed parked-done does
   * not enqueue — the operator already saw the turn (or just opened the
   * row). ReduceSubscribe still promotes if a future producer adds here.
   */
  pendingLeaveUnread: ReadonlySet<string>;
}

export function initialUnreadMachine(): UnreadMachine {
  return {
    subscribedId: null,
    unreadIds: [],
    pendingLeaveUnread: new Set(),
  };
}

function addUnread(ids: readonly string[], conversationId: string): readonly string[] {
  return ids.includes(conversationId) ? ids : [...ids, conversationId];
}

function dropUnread(ids: readonly string[], conversationId: string): readonly string[] {
  return ids.filter((id) => id !== conversationId);
}

export function reduceSubscribe(state: UnreadMachine, conversationId: string): UnreadMachine {
  const prevId = state.subscribedId;
  const pending = new Set(state.pendingLeaveUnread);
  let unreadIds = dropUnread(state.unreadIds, conversationId);
  pending.delete(conversationId);
  if (prevId && prevId !== conversationId && pending.has(prevId)) {
    unreadIds = addUnread(unreadIds, prevId);
    pending.delete(prevId);
  }
  return {
    subscribedId: conversationId,
    unreadIds,
    pendingLeaveUnread: pending,
  };
}

export function reduceConversationUpdated(
  state: UnreadMachine,
  frame: Pick<ConversationUpdatedFrame, 'conversationId' | 'status'>,
): UnreadMachine {
  const cid = frame.conversationId;
  let unreadIds = state.unreadIds;
  let pendingLeaveUnread = state.pendingLeaveUnread;

  // Activity on a conversation the operator is not viewing is unread.
  // Terminal done/error on the *subscribed* conversation is not: they are
  // looking at it. The subscribe handler also re-sends conversation_updated
  // {status:done} for parked hold-open sessions (to unstick session_started
  // → running); treating that replay as leave-unread made the blue dot
  // return on every navigate-away until a full refresh.
  if (cid !== state.subscribedId) {
    unreadIds = addUnread(unreadIds, cid);
  }

  return { ...state, unreadIds, pendingLeaveUnread };
}
