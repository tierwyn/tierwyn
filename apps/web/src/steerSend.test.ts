import { describe, expect, it } from 'vitest';
import { decideSteerDispatch } from './steerSend.js';

describe('decideSteerDispatch', () => {
  it('uses a plain prompt when the turn is not live', () => {
    expect(decideSteerDispatch({ isRunning: false, currentSessionId: 's1' })).toEqual({
      kind: 'prompt',
    });
    expect(decideSteerDispatch({ isRunning: false, currentSessionId: null })).toEqual({
      kind: 'prompt',
    });
  });

  it('defers when running but session_started has not arrived yet', () => {
    expect(decideSteerDispatch({ isRunning: true, currentSessionId: null })).toEqual({
      kind: 'defer',
    });
    expect(decideSteerDispatch({ isRunning: true, currentSessionId: undefined })).toEqual({
      kind: 'defer',
    });
  });

  it('steers once the live session id is known', () => {
    expect(decideSteerDispatch({ isRunning: true, currentSessionId: 's1' })).toEqual({
      kind: 'steer',
      sessionId: 's1',
    });
  });
});
