import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './sessionManager.js';
import type { AgentAdapter } from '@tierwyn/shared';

function managerWithSession() {
  const calls: { requestId: string; response: unknown }[] = [];
  const adapter = {
    respondToInteraction: (requestId: string, response: unknown) => calls.push({ requestId, response }),
  } as unknown as AgentAdapter;
  const mgr = new SessionManager({ broadcast: vi.fn() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any).sessions.set('sess1', { id: 'sess1', conversationId: 'c1', adapter });
  return { mgr, calls };
}

describe('SessionManager.respondToInteraction', () => {
  it('routes a response to the session adapter', () => {
    const { mgr, calls } = managerWithSession();
    const res = mgr.respondToInteraction('sess1', 'req1', { selection: ['allow'] });
    expect(res.accepted).toBe(true);
    expect(calls).toEqual([{ requestId: 'req1', response: { selection: ['allow'] } }]);
  });

  it('returns not_found for an unknown session', () => {
    const { mgr } = managerWithSession();
    const res = mgr.respondToInteraction('nope', 'req1', { selection: ['allow'] });
    expect(res).toEqual({ accepted: false, reason: 'not_found', message: 'Session not found' });
  });

  it('returns unsupported when the adapter cannot respond', () => {
    const mgr = new SessionManager({ broadcast: vi.fn() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).sessions.set('s2', { id: 's2', conversationId: 'c', adapter: {} });
    const res = mgr.respondToInteraction('s2', 'r', { selection: ['allow'] });
    expect(res.reason).toBe('unsupported');
  });
});
