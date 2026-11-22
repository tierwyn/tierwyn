import { describe, it, expect } from 'vitest';
import {
  lastResolveIndexByRequestId,
  isInteractionRequestResolved,
  answeredInteractionRequestIds,
  isRedundantAutoResolve,
} from './interactionResolve.js';

type Ev = { type: string; payload?: { requestId?: string; resolution?: string } };

function req(id: string): Ev {
  return { type: 'interaction_request', payload: { requestId: id } };
}

function resolved(id: string, resolution = 'answered'): Ev {
  return { type: 'interaction_resolved', payload: { requestId: id, resolution } };
}

describe('lastResolveIndexByRequestId', () => {
  it('maps each requestId to the last resolve index', () => {
    const events = [req('a'), resolved('a'), req('a'), resolved('a')];
    const map = lastResolveIndexByRequestId(events);
    expect(map.get('a')).toBe(3);
  });
});

describe('isInteractionRequestResolved', () => {
  it('request → resolve → request (same id): first disabled, second enabled', () => {
    const events = [req('gb-same'), resolved('gb-same'), req('gb-same')];
    const map = lastResolveIndexByRequestId(events);
    expect(isInteractionRequestResolved('gb-same', 0, map)).toBe(true);
    expect(isInteractionRequestResolved('gb-same', 2, map)).toBe(false);
  });

  it('request → resolve → request → resolve: both disabled', () => {
    const events = [req('gb-same'), resolved('gb-same'), req('gb-same'), resolved('gb-same')];
    const map = lastResolveIndexByRequestId(events);
    expect(isInteractionRequestResolved('gb-same', 0, map)).toBe(true);
    expect(isInteractionRequestResolved('gb-same', 2, map)).toBe(true);
  });

  it('two different ids stay independent', () => {
    const events = [req('a'), resolved('a'), req('b')];
    const map = lastResolveIndexByRequestId(events);
    expect(isInteractionRequestResolved('a', 0, map)).toBe(true);
    expect(isInteractionRequestResolved('b', 2, map)).toBe(false);
  });
});

describe('isRedundantAutoResolve', () => {
  it('hides auto when the transcript already has answered for the same requestId', () => {
    const events = [req('gb-1'), resolved('gb-1', 'answered'), resolved('gb-1', 'auto')];
    const answered = answeredInteractionRequestIds(events);
    expect(answered.has('gb-1')).toBe(true);
    expect(isRedundantAutoResolve(events[2]!, answered)).toBe(true);
  });

  it('hides expired when answered already exists for the same requestId', () => {
    const events = [resolved('gb-1', 'answered'), resolved('gb-1', 'expired')];
    expect(isRedundantAutoResolve(events[1]!, answeredInteractionRequestIds(events))).toBe(true);
  });

  it('keeps auto when this requestId was never answered', () => {
    const events = [req('gb-1'), resolved('gb-1', 'auto')];
    expect(isRedundantAutoResolve(events[1]!, answeredInteractionRequestIds(events))).toBe(false);
  });

  it('keeps the answered line itself', () => {
    const events = [resolved('gb-1', 'answered')];
    expect(isRedundantAutoResolve(events[0]!, answeredInteractionRequestIds(events))).toBe(false);
  });
});
