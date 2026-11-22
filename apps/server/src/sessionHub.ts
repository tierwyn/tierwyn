import type { ServerFrame } from '@tierwyn/shared';

export interface Sendable {
  send(frame: ServerFrame): void;
}

export class SessionHub {
  private byConversation = new Map<string, Set<Sendable>>();
  // Operator-global fan-out: every connected operator socket. Used for
  // operator-wide signals that don't belong to a specific conversation —
  // currently spawn_request_updated (approval queue must reach the operator
  // regardless of which conversation they're viewing). A socket may be in
  // allSockets AND in one or more byConversation sets; drop() removes it from both.
  private allSockets = new Set<Sendable>();

  subscribe(conversationId: string, socket: Sendable): void {
    let set = this.byConversation.get(conversationId);
    if (!set) {
      set = new Set();
      this.byConversation.set(conversationId, set);
    }
    set.add(socket);
  }

  unsubscribe(conversationId: string, socket: Sendable): void {
    this.byConversation.get(conversationId)?.delete(socket);
  }

  /** Register a socket to receive operator-global broadcasts. Idempotent. */
  register(socket: Sendable): void {
    this.allSockets.add(socket);
  }

  /** Remove a socket from the global set (conversation sets unaffected). */
  unregister(socket: Sendable): void {
    this.allSockets.delete(socket);
  }

  drop(socket: Sendable): void {
    for (const set of this.byConversation.values()) set.delete(socket);
    this.allSockets.delete(socket);
  }

  broadcast(conversationId: string, frame: ServerFrame): void {
    const set = this.byConversation.get(conversationId);
    if (!set) return;
    for (const socket of set) socket.send(frame);
  }

  /** Deliver a frame to EVERY connected operator socket, regardless of which
   *  conversation (if any) it has subscribed to. */
  broadcastAll(frame: ServerFrame): void {
    for (const socket of this.allSockets) socket.send(frame);
  }
}

export const sessionHub = new SessionHub();
