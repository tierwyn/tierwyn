import { describe, it, expect, beforeEach } from 'vitest';
import { queuePeerMessage, pendingCount, dropMailbox, MAILBOX_MAX } from './mailbox.js';
import { deliverLateral } from './deliver.js';

const msg = (text: string) => ({ text, replyTo: 'sender', hop: 1, bytes: text.length });

describe('mesh mailbox', () => {
  beforeEach(() => dropMailbox('c1'));

  it('queues per conversation', () => {
    queuePeerMessage('c1', msg('one'));
    queuePeerMessage('c1', msg('two'));
    expect(pendingCount('c1')).toBe(2);
    expect(pendingCount('c2')).toBe(0);
  });

  it('caps the box and drops the oldest', () => {
    for (let i = 0; i < MAILBOX_MAX + 2; i += 1) queuePeerMessage('c1', msg(`m${i}`));
    expect(pendingCount('c1')).toBe(MAILBOX_MAX);
  });

  it('dropMailbox clears', () => {
    queuePeerMessage('c1', msg('one'));
    dropMailbox('c1');
    expect(pendingCount('c1')).toBe(0);
  });
});

describe('deliverLateral busy branch', () => {
  it('defers instead of interrupting when the target is live and not injectable', async () => {
    let stopped = false;
    const sm = {
      inFlightSessionForConversation: () => ({ id: 's1' }),
      isInjectable: () => false,
      stopSession: async () => { stopped = true; },
      steerSession: async () => {},
    } as never;
    dropMailbox('target');
    const out = await deliverLateral(sm, 'target', 'hello', {
      replyTo: 'sender', hop: 1, bytes: 5,
    });
    expect(out.decision).toBe('deferred_pending');
    expect(out.delivered).toBe('deferred');
    expect(stopped).toBe(false);
    expect(pendingCount('target')).toBe(1);
  });
});
