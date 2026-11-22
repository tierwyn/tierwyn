import { describe, it, expect } from 'vitest';
import type {
  NormalisedEvent, InteractionRequestEvent, InteractionResolvedEvent,
} from './events.js';
import type { ClientFrame, ServerFrame } from './protocol.js';

describe('interaction contract', () => {
  it('interaction_request is a NormalisedEvent', () => {
    const e: NormalisedEvent = {
      type: 'interaction_request', sessionId: 's', seq: 1, ts: 0,
      payload: {
        requestId: 'r1', kind: 'permission', prompt: 'Run ls?',
        choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
        toolName: 'Bash', toolInput: { command: 'ls' },
      },
    };
    expect((e as InteractionRequestEvent).payload.kind).toBe('permission');
  });

  it('interaction_resolved is a NormalisedEvent', () => {
    const e: NormalisedEvent = {
      type: 'interaction_resolved', sessionId: 's', seq: 2, ts: 0,
      payload: { requestId: 'r1', selection: ['allow'], resolution: 'answered' },
    };
    expect((e as InteractionResolvedEvent).payload.resolution).toBe('answered');
  });

  it('interaction_response is a ClientFrame and interaction_result a ServerFrame', () => {
    const c: ClientFrame = {
      type: 'interaction_response', conversationId: 'c', sessionId: 's',
      requestId: 'r1', selection: ['allow'],
    };
    const s: ServerFrame = {
      type: 'interaction_result', sessionId: 's', requestId: 'r1', accepted: true,
    };
    expect(c.type).toBe('interaction_response');
    expect(s.type).toBe('interaction_result');
  });
});
