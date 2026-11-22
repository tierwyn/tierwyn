import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { makeAdapterRunner } from './runner.js';
import type { AgentAdapter } from '@tierwyn/shared';

function fakeAdapterFactory(): AgentAdapter {
  const emitter = new EventEmitter();
  return {
    streamEvents: () => emitter,
    start: async () => {},
    sendPrompt: async () => {
      emitter.emit('event', { type: 'message', payload: { chunk: 'sum', final: false }, sessionId: '', seq: 1, ts: 1 });
      emitter.emit('event', { type: 'message', payload: { chunk: 'mary', final: true }, sessionId: '', seq: 2, ts: 2 });
      emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: 3 });
      emitter.emit('end');
    },
    stop: async () => {},
    listSessions: async () => [],
    loadSession: async () => {},
    listModels: async () => [],
  };
}

// hold-open: emits the summary + status:done but NEVER 'end' (keeps its
// subprocess alive between turns). The runner must resolve on 'done', not wait
// for 'end' — this is the handoff-slowness bug. `stopped` proves the runner
// stops the adapter so the subprocess doesn't leak.
function doneButNoEndAdapterFactory(): { adapter: AgentAdapter; wasStopped: () => boolean } {
  const emitter = new EventEmitter();
  let stopped = false;
  const adapter: AgentAdapter = {
    streamEvents: () => emitter,
    start: async () => {},
    sendPrompt: async () => {
      emitter.emit('event', { type: 'message', payload: { chunk: 'live summary', final: true }, sessionId: '', seq: 1, ts: 1 });
      emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 2, ts: 2 });
      // deliberately no 'end'
    },
    stop: async () => { stopped = true; },
    listSessions: async () => [],
    loadSession: async () => {},
    listModels: async () => [],
  };
  return { adapter, wasStopped: () => stopped };
}

// A summariser adapter that never emits anything — models a truly stuck /
// rate-limited compactor that would otherwise wedge buildResumePlan forever.
function hangingAdapterFactory(): AgentAdapter {
  const emitter = new EventEmitter();
  return {
    streamEvents: () => emitter,
    start: async () => {},
    sendPrompt: async () => { /* never emits anything */ },
    stop: async () => {},
    listSessions: async () => [],
    loadSession: async () => {},
    listModels: async () => [],
  };
}

describe('makeAdapterRunner', () => {
  it('collects streamed message chunks into a single summary string', async () => {
    const runner = makeAdapterRunner({
      createAdapter: () => fakeAdapterFactory(),
      resolveModel: () => 'claude-opus-4-8',
      cwd: '/tmp',
    });
    const out = await runner('claude-code:opus-4.8', 'summarise this');
    expect(out).toBe('summary');
  });

  it('resolves on status:done without waiting for end, and stops the adapter', async () => {
    const { adapter, wasStopped } = doneButNoEndAdapterFactory();
    const runner = makeAdapterRunner({
      createAdapter: () => adapter,
      resolveModel: () => 'glm-5-turbo',
      cwd: '/tmp',
      timeoutMs: 5000, // generous: must resolve via 'done', not via timeout
    });
    const out = await runner('claude-code:sonnet', 'summarise this');
    expect(out).toBe('live summary');
    expect(wasStopped()).toBe(true);
  });

  it('rejects on timeout instead of hanging when the summariser never ends', async () => {
    const runner = makeAdapterRunner({
      createAdapter: () => hangingAdapterFactory(),
      resolveModel: () => 'glm-5-turbo',
      cwd: '/tmp',
      timeoutMs: 50,
    });
    await expect(runner('claude-code:sonnet', 'summarise this')).rejects.toThrow(/timed out/);
  });

  it('always creates the summariser adapter in bypass mode', async () => {
    let capturedOpts: unknown;
    const runner = makeAdapterRunner({
      createAdapter: (_agentType, opts) => {
        capturedOpts = opts;
        return fakeAdapterFactory();
      },
      resolveModel: () => 'claude-opus-4-8',
      cwd: '/tmp',
    });
    await runner('claude-code:opus-4.8', 'summarise this');
    expect(capturedOpts).toEqual({ interactionMode: 'bypass' });
  });

  it('uses oneShot(none) when the adapter advertises it, and never starts a session', async () => {
    const start = vi.fn(async () => {});
    const sendPrompt = vi.fn(async () => {});
    const oneShot = vi.fn(async () => ({ text: 'oneshot summary' }));
    const runner = makeAdapterRunner({
      createAdapter: () => ({
        ...fakeAdapterFactory(),
        start,
        sendPrompt,
        oneShot,
        oneShotModes: ['none'] as const,
      }),
      resolveModel: () => 'glm-5.2',
      cwd: '/tmp/proj',
      timeoutMs: 30_000,
    });
    const out = await runner('claude-code:sonnet', 'summarise this');
    expect(out).toBe('oneshot summary');
    expect(oneShot).toHaveBeenCalledWith('summarise this', {
      mode: 'none',
      model: 'glm-5.2',
      cwd: '/tmp/proj',
      timeoutSecs: 30,
    });
    expect(start).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('falls back to the session path when the prompt exceeds 120 KB', async () => {
    const session = fakeAdapterFactory();
    const start = vi.fn(async () => session.start({
      sessionId: 's', conversationId: '', cwd: '/tmp', model: 'm',
    }));
    const sendPrompt = vi.fn(async (prompt: string) => session.sendPrompt(prompt));
    const oneShot = vi.fn(async () => ({ text: 'should not run' }));
    const runner = makeAdapterRunner({
      createAdapter: () => ({
        ...session,
        start,
        sendPrompt,
        oneShot,
        oneShotModes: ['none'] as const,
      }),
      resolveModel: () => 'glm-5.2',
      cwd: '/tmp',
    });
    const huge = 'x'.repeat(120_001);
    const out = await runner('claude-code:sonnet', huge);
    expect(out).toBe('summary');
    expect(oneShot).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalled();
  });

  it('cursor-like oneShot (post-hoc none) uses the session path, not oneShot', async () => {
    const session = fakeAdapterFactory();
    const start = vi.fn(async () => session.start({
      sessionId: 's', conversationId: '', cwd: '/tmp', model: 'm',
    }));
    const sendPrompt = vi.fn(async (prompt: string) => session.sendPrompt(prompt));
    const oneShot = vi.fn(async () => ({ text: 'should not run' }));
    const runner = makeAdapterRunner({
      createAdapter: () => ({
        ...session,
        start,
        sendPrompt,
        oneShot,
        oneShotModes: ['none'] as const,
      }),
      resolveModel: () => 'auto',
      cwd: '/tmp',
    });
    const out = await runner('cursor:auto', 'summarise this');
    expect(out).toBe('summary');
    expect(oneShot).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalled();
  });

  it('toolFreeOnly rejects an antigravity-like adapter without calling start', async () => {
    const start = vi.fn(async () => {});
    const sendPrompt = vi.fn(async () => {});
    const runner = makeAdapterRunner({
      createAdapter: () => ({
        ...fakeAdapterFactory(),
        start,
        sendPrompt,
      }),
      resolveModel: () => 'gemini-3.8-flash-low',
      cwd: '/tmp',
      toolFreeOnly: true,
    });
    await expect(runner('antigravity:gemini-3.8-flash-low', 'summarise this'))
      .rejects.toThrow(/tool-free/);
    expect(start).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('toolFreeOnly rejects a cursor-like oneShot adapter without calling start', async () => {
    const start = vi.fn(async () => {});
    const oneShot = vi.fn(async () => ({ text: 'should not run' }));
    const runner = makeAdapterRunner({
      createAdapter: () => ({
        ...fakeAdapterFactory(),
        start,
        oneShot,
        oneShotModes: ['none'] as const,
      }),
      resolveModel: () => 'auto',
      cwd: '/tmp',
      toolFreeOnly: true,
    });
    await expect(runner('cursor:auto', 'summarise this')).rejects.toThrow(/tool-free/);
    expect(start).not.toHaveBeenCalled();
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('toolFreeOnly still uses oneShot(none) for claude-code', async () => {
    const start = vi.fn(async () => {});
    const oneShot = vi.fn(async () => ({ text: 'oneshot summary' }));
    const runner = makeAdapterRunner({
      createAdapter: () => ({
        ...fakeAdapterFactory(),
        start,
        oneShot,
        oneShotModes: ['none'] as const,
      }),
      resolveModel: () => 'glm-5.2',
      cwd: '/tmp',
      toolFreeOnly: true,
    });
    await expect(runner('claude-code:sonnet', 'summarise this')).resolves.toBe('oneshot summary');
    expect(oneShot).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
