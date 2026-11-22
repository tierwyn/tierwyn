import { describe, it, expect } from 'vitest';
import { SessionHub } from './sessionHub.js';
import type { ServerFrame } from '@tierwyn/shared';

interface FakeSocket { sent: ServerFrame[]; }
function fakeSocket(): FakeSocket & { send: (f: ServerFrame) => void } {
  const sent: ServerFrame[] = [];
  return { sent, send: (f) => sent.push(f) };
}

describe('SessionHub', () => {
  it('broadcasts only to subscribers of a conversation', () => {
    const hub = new SessionHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.subscribe('conv-1', a);
    hub.subscribe('conv-2', b);

    const frame: ServerFrame = { type: 'heartbeat', ts: 1, connected: true };
    hub.broadcast('conv-1', frame);

    expect(a.sent).toEqual([frame]);
    expect(b.sent).toEqual([]);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = new SessionHub();
    const a = fakeSocket();
    hub.subscribe('c', a);
    hub.unsubscribe('c', a);
    hub.broadcast('c', { type: 'heartbeat', ts: 1, connected: true });
    expect(a.sent).toEqual([]);
  });

  it('removes a socket from all conversations on drop', () => {
    const hub = new SessionHub();
    const a = fakeSocket();
    hub.subscribe('c1', a);
    hub.subscribe('c2', a);
    hub.drop(a);
    hub.broadcast('c1', { type: 'heartbeat', ts: 1, connected: true });
    hub.broadcast('c2', { type: 'heartbeat', ts: 1, connected: true });
    expect(a.sent).toEqual([]);
  });

  it('broadcastAll reaches every registered socket, regardless of subscription', () => {
    const hub = new SessionHub();
    const a = fakeSocket();
    const b = fakeSocket();
    const c = fakeSocket();
    // a is subscribed to conv-1, b to conv-2, c to nothing — but all three
    // are registered for operator-global broadcasts.
    hub.subscribe('conv-1', a);
    hub.subscribe('conv-2', b);
    hub.register(a); hub.register(b); hub.register(c);

    const frame: ServerFrame = { type: 'heartbeat', ts: 1, connected: true };
    hub.broadcastAll(frame);

    expect(a.sent).toEqual([frame]);
    expect(b.sent).toEqual([frame]);
    expect(c.sent).toEqual([frame]);
  });

  it('drop removes a socket from the global set (no more broadcastAll delivery)', () => {
    const hub = new SessionHub();
    const a = fakeSocket();
    hub.register(a);
    hub.drop(a);
    hub.broadcastAll({ type: 'heartbeat', ts: 1, connected: true });
    expect(a.sent).toEqual([]);
  });

  it('unregister stops global delivery but keeps conversation subscriptions', () => {
    const hub = new SessionHub();
    const a = fakeSocket();
    hub.subscribe('conv-1', a);
    hub.register(a);
    hub.unregister(a);
    hub.broadcastAll({ type: 'heartbeat', ts: 1, connected: true });
    expect(a.sent).toEqual([]);
    hub.broadcast('conv-1', { type: 'heartbeat', ts: 2, connected: true });
    expect(a.sent).toEqual([{ type: 'heartbeat', ts: 2, connected: true }]);
  });
});
