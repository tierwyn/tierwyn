import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ServerFrame } from '@tierwyn/shared';
import { sessionHub } from '../sessionHub.js';
import { watchChildResult, settleWatchersFor } from './watch.js';

/** Drive the watcher interval with a fake clock (no real waiting). */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function eventFrame(
  conversationId: string,
  event: {
    type: string;
    sessionId: string;
    seq: number;
    ts: number;
    sender: 'agent' | 'user' | 'system';
    payload: Record<string, unknown>;
  },
): ServerFrame {
  return { type: 'event', conversationId, event } as ServerFrame;
}

describe('watchChildResult', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resolve on operator-interrupt done; a later natural done does', async () => {
    const childId = 'child-operator-hold';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
    });

    let settled = false;
    void promise.then(() => { settled = true; });

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { chunk: 'mid-turn prose the operator cut off' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's', seq: 2, ts: 1, sender: 'agent',
      payload: { status: 'done', cause: 'operator_interrupt' },
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's2', seq: 3, ts: 2, sender: 'agent',
      payload: { status: 'running' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's2', seq: 4, ts: 3, sender: 'agent',
      payload: { chunk: '## Result\n\nFinished after the operator redirected.' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's2', seq: 5, ts: 4, sender: 'agent',
      payload: { status: 'done' },
    }));

    const result = await promise;
    expect(result.degenerate).toBe(false);
    expect(result.prose).toContain('## Result');
    cancel();
  });

  it('does not resolve on session_ended caused by operator interrupt', async () => {
    const childId = 'child-operator-hard-stop';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
    });

    let settled = false;
    void promise.then(() => { settled = true; });

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { chunk: 'partial' },
    }));
    sessionHub.broadcast(childId, {
      type: 'session_ended', conversationId: childId, sessionId: 's',
      cause: 'operator_interrupt',
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's2', seq: 2, ts: 2, sender: 'agent',
      payload: { status: 'running' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's2', seq: 3, ts: 3, sender: 'agent',
      payload: { chunk: '## Result\n\nRecovered after hard-stop force.' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's2', seq: 4, ts: 4, sender: 'agent',
      payload: { status: 'done' },
    }));

    const result = await promise;
    expect(result.prose).toContain('## Result');
    cancel();
  });

  it('still resolves on status:error even after an operator-interrupt hold', async () => {
    const childId = 'child-error-after-hold';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
    });

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { status: 'done', cause: 'operator_interrupt' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's', seq: 2, ts: 1, sender: 'agent',
      payload: { chunk: 'boom: provider 500' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's', seq: 3, ts: 2, sender: 'agent',
      payload: { status: 'error' },
    }));

    const result = await promise;
    expect(result.prose).toContain('boom');
    expect(result.errored).toBe(true);
    cancel();
  });

  it('settleOnStop resolves stopped:true on operator hard Stop (done hold + session_ended)', async () => {
    const childId = 'child-schedule-stop';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
      settleOnStop: true,
    });
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { status: 'done', cause: 'operator_interrupt' },
    }));
    sessionHub.broadcast(childId, { type: 'session_ended', conversationId: childId, sessionId: 's' });
    const result = await promise;
    expect(result.stopped).toBe(true);
    cancel();
  });

  it('marks errored:true and carries the adapter error message on status:error', async () => {
    const childId = 'child-error-flagged';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
    });

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { chunk: '' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'error', sessionId: 's', seq: 2, ts: 1, sender: 'agent',
      payload: { message: 'Grok Build credits exhausted (HTTP 402)' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's', seq: 3, ts: 2, sender: 'agent',
      payload: { status: 'error' },
    }));

    const result = await promise;
    expect(result.errored).toBe(true);
    expect(result.errorMessage).toBe('Grok Build credits exhausted (HTTP 402)');
    cancel();
  });

  it('a terse natural done is degenerate but NOT errored (success stays a success)', async () => {
    const childId = 'child-terse-success';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
    });

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { chunk: 'ok' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's', seq: 2, ts: 1, sender: 'agent',
      payload: { status: 'done' },
    }));

    const result = await promise;
    expect(result.errored).toBe(false);
    expect(result.degenerate).toBe(true);
    cancel();
  });

  it('resolves once on status:done; a late session_ended is a no-op', async () => {
    const clock = makeClock();
    vi.useFakeTimers();
    const childId = 'child-done-once';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
      now: clock.now,
      checkIntervalMs: 100,
      stallMs: 10_000,
    });

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { chunk: '## Result\n\nAll good, files touched: none.' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's', seq: 2, ts: 1, sender: 'agent',
      payload: { status: 'done' },
    }));

    const first = await promise;
    expect(first.degenerate).toBe(false);
    expect(first.prose).toContain('## Result');

    // Late session_ended must not double-resolve / throw.
    sessionHub.broadcast(childId, { type: 'session_ended', conversationId: childId, sessionId: 's' });
    await expect(promise).resolves.toEqual(first);
    cancel();
  });

  it('stall rejects before onStalled side-effects can resolve with partial prose', async () => {
    const clock = makeClock();
    vi.useFakeTimers();
    const childId = 'child-stall-race';
    let onStalledCalls = 0;

    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {
        onStalledCalls += 1;
        // Simulate stopSession → adapter.stop → session_ended synchronously,
        // which previously could resolve the promise with partial prose (R2).
        sessionHub.broadcast(childId, eventFrame(childId, {
          type: 'message', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
          payload: { chunk: 'mid-sentence partial prose that must NOT win' },
        }));
        sessionHub.broadcast(childId, {
          type: 'session_ended', conversationId: childId, sessionId: 's',
        });
      },
      now: clock.now,
      checkIntervalMs: 50,
      stallMs: 200,
    });

    // Attach rejection handler BEFORE advancing timers (avoids unhandled-rejection noise).
    const rejected = expect(promise).rejects.toThrow(/stalled: no output for/);

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's', seq: 0, ts: 0, sender: 'agent',
      payload: { chunk: 'earlier turn' },
    }));

    clock.advance(250);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(onStalledCalls).toBe(1);
    cancel();
  });

  it('any event resets the silence clock (status:running counts)', async () => {
    const clock = makeClock();
    vi.useFakeTimers();
    const childId = 'child-any-event';
    let stalled = false;

    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => { stalled = true; },
      now: clock.now,
      checkIntervalMs: 50,
      stallMs: 200,
    });

    // Over a wall span > stallMs, keep poking with status:running only
    // (no message / tool_call). Pre-fix this would stall.
    for (let i = 0; i < 6; i++) {
      clock.advance(100);
      sessionHub.broadcast(childId, eventFrame(childId, {
        type: 'status', sessionId: 's', seq: i, ts: clock.now(), sender: 'agent',
        payload: { status: 'running' },
      }));
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(stalled).toBe(false);

    const rejected = expect(promise).rejects.toThrow(/stalled/);
    clock.advance(250);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(stalled).toBe(true);
    cancel();
  });

  it('default stall budget is 15 min (14 min silence after tool_call does not stall)', async () => {
    const clock = makeClock();
    vi.useFakeTimers();
    const childId = 'child-15min';
    let stalled = false;

    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => { stalled = true; },
      now: clock.now,
      checkIntervalMs: 60_000, // tick once per simulated minute
      // stallMs omitted → default HEARTBEAT_STALL_MS (15 min)
    });

    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'tool_call', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { toolUseId: 't1', name: 'Bash', input: {} },
    }));

    // 14 minutes of silence — must not stall under the 15 min default.
    clock.advance(14 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stalled).toBe(false);

    // Cross 15 min total silence from last activity.
    const rejected = expect(promise).rejects.toThrow(/stalled/);
    clock.advance(2 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(stalled).toBe(true);
    cancel();
  });

  it('armOn: turn_start ignores terminal events before running/prompt', async () => {
    const childId = 'child-arm-on-turn-start';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
      armOn: 'turn_start',
    });

    let settled = false;
    void promise.then(() => { settled = true; });

    // Old turn / reap emits session_ended and status:done before any running event
    sessionHub.broadcast(childId, {
      type: 'session_ended', conversationId: childId, sessionId: 's-old',
    });
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's-old', seq: 1, ts: 1, sender: 'agent',
      payload: { status: 'done' },
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    // Now the new turn starts with status:running
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's-new', seq: 2, ts: 2, sender: 'agent',
      payload: { status: 'running' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's-new', seq: 3, ts: 3, sender: 'agent',
      payload: { chunk: 'hello from new turn' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's-new', seq: 4, ts: 4, sender: 'agent',
      payload: { status: 'done' },
    }));

    const result = await promise;
    expect(result.prose).toContain('hello from new turn');
    cancel();
  });

  it('armOn: turn_start is armed by a prompt event as well', async () => {
    const childId = 'child-arm-on-prompt';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
      armOn: 'turn_start',
    });

    let settled = false;
    void promise.then(() => { settled = true; });

    // Terminal event before prompt
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's-old', seq: 1, ts: 1, sender: 'agent',
      payload: { status: 'done' },
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    // Prompt event arrives
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'prompt', sessionId: 's-new', seq: 2, ts: 2, sender: 'user',
      payload: { text: 'do something' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's-new', seq: 3, ts: 3, sender: 'agent',
      payload: { chunk: 'hello from prompt turn' },
    }));
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's-new', seq: 4, ts: 4, sender: 'agent',
      payload: { status: 'done' },
    }));

    const result = await promise;
    expect(result.prose).toContain('hello from prompt turn');
    cancel();
  });

  it('S1-1: armOn: turn_start ignores session_ended from old session after arming', async () => {
    const childId = 'child-arm-ignore-old-session';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
      armOn: 'turn_start',
    });

    let settled = false;
    void promise.then(() => { settled = true; });

    // Send event prompt with sessionId: 's-new' -> watcher becomes armed.
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'prompt', sessionId: 's-new', seq: 1, ts: 1, sender: 'user',
      payload: { text: 'start new turn' },
    }));

    // Send session_ended with sessionId: 's-old' -> watcher does NOT resolve (promise remains pending).
    sessionHub.broadcast(childId, {
      type: 'session_ended', conversationId: childId, sessionId: 's-old',
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Send event with type: 'message', chunk 'hello from new turn', and sessionId: 's-new'.
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's-new', seq: 2, ts: 2, sender: 'agent',
      payload: { chunk: 'hello from new turn' },
    }));

    // Send status: done with sessionId: 's-new' -> watcher resolves with prose containing 'hello from new turn', degenerate: false.
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'status', sessionId: 's-new', seq: 3, ts: 3, sender: 'agent',
      payload: { status: 'done' },
    }));

    const result = await promise;
    expect(result.degenerate).toBe(false);
    expect(result.prose).toContain('hello from new turn');
    cancel();
  });

  it('settleWatchersFor resolves the pending watcher once and returns 1', async () => {
    const childId = 'child-force-settle';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
    });
    const n = settleWatchersFor(childId, {
      prose: '◼ stopped-by-parent (killed) by parent',
      degenerate: false,
      errored: false,
      stopped: true,
    });
    expect(n).toBe(1);
    const result = await promise;
    expect(result.stopped).toBe(true);
    expect(result.prose).toContain('◼ stopped-by-parent');
    expect(settleWatchersFor(childId, {
      prose: 'again', degenerate: false, errored: false, stopped: true,
    })).toBe(0);
    cancel();
  });

  it('settleWatchersFor is a no-op after a natural session_ended resolve', async () => {
    const childId = 'child-force-after-natural';
    const { promise, cancel } = watchChildResult(childId, {
      onHeartbeat: () => {},
      onStalled: () => {},
    });
    sessionHub.broadcast(childId, eventFrame(childId, {
      type: 'message', sessionId: 's', seq: 1, ts: 0, sender: 'agent',
      payload: { chunk: 'natural result' },
    }));
    sessionHub.broadcast(childId, {
      type: 'session_ended', conversationId: childId, sessionId: 's',
    });
    const first = await promise;
    expect(first.prose).toContain('natural result');
    expect(settleWatchersFor(childId, {
      prose: 'marker', degenerate: false, errored: false, stopped: true,
    })).toBe(0);
    await expect(promise).resolves.toEqual(first);
    cancel();
  });
});
