import { describe, it, expect, vi } from 'vitest';
import { conversationUpdatedFromSessionFrame, holdTerminalFrame, statusFromSessionFrame } from './conversationUpdatedFan.js';
import type { ServerFrame } from '@tierwyn/shared';

describe('conversationUpdatedFromSessionFrame', () => {
  it('extracts status:done from a hold-open turn-end event frame', () => {
    const frame: ServerFrame = {
      type: 'event',
      conversationId: 'c1',
      event: {
        type: 'status',
        sessionId: 's1',
        seq: 3,
        ts: 1,
        payload: { status: 'done' },
      },
    };
    expect(statusFromSessionFrame(frame)).toBe('done');
    expect(conversationUpdatedFromSessionFrame('c1', frame, 42)).toEqual({
      type: 'conversation_updated',
      conversationId: 'c1',
      ts: 42,
      status: 'done',
    });
  });

  it('leaves status undefined for session_started (non-event) frames', () => {
    const frame: ServerFrame = {
      type: 'session_started',
      conversationId: 'c1',
      sessionId: 's1',
      profileId: 'p',
      model: 'm',
    };
    expect(statusFromSessionFrame(frame)).toBeUndefined();
    expect(conversationUpdatedFromSessionFrame('c1', frame, 42).status).toBeUndefined();
  });

  it('JSON.stringify omits undefined status (same as pre-helper production)', () => {
    const started: ServerFrame = {
      type: 'session_started',
      conversationId: 'c1',
      sessionId: 's1',
      profileId: 'p',
      model: 'm',
    };
    expect(JSON.parse(JSON.stringify(conversationUpdatedFromSessionFrame('c1', started, 42)))).toEqual({
      type: 'conversation_updated',
      conversationId: 'c1',
      ts: 42,
    });

    const done: ServerFrame = {
      type: 'event',
      conversationId: 'c1',
      event: {
        type: 'status',
        sessionId: 's1',
        seq: 3,
        ts: 1,
        payload: { status: 'done' },
      },
    };
    expect(JSON.parse(JSON.stringify(conversationUpdatedFromSessionFrame('c1', done, 42)))).toEqual({
      type: 'conversation_updated',
      conversationId: 'c1',
      ts: 42,
      status: 'done',
    });
  });
});

describe('holdTerminalFrame', () => {
  const frame: Extract<ServerFrame, { type: 'conversation_updated' }> = {
    type: 'conversation_updated', conversationId: 'c1', ts: 1, status: 'done',
  };

  it('holdTerminalFrame stamps interruptWorthy', async () => {
    const fan = vi.fn();
    const w = await holdTerminalFrame(frame, Promise.resolve(false), () => false, fan);
    expect(w).toBe(false);
    expect(fan).toHaveBeenCalledWith({ ...frame, interruptWorthy: false });
  });

  it('holdTerminalFrame fans plain frame on undefined', async () => {
    const fan = vi.fn();
    await holdTerminalFrame(frame, Promise.resolve(undefined), () => false, fan);
    expect(fan).toHaveBeenCalledWith(frame);
    expect('interruptWorthy' in (fan.mock.calls[0]![0] as object)).toBe(false);
  });

  it('holdTerminalFrame drops stale frame', async () => {
    const fan = vi.fn();
    const w = await holdTerminalFrame(frame, Promise.resolve(true), () => true, fan);
    expect(w).toBe(true);
    expect(fan).not.toHaveBeenCalled();
  });
});
