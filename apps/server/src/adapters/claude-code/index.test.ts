import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { NormalisedEvent, ResolvedMcpServer } from '@tierwyn/shared';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from 'child_process';
import {
  ClaudeCodeAdapter as CCAdapter,
  buildClaudeCodeSdkOptionOverrides,
  buildClaudeCodeSdkPermissionOptions,
  buildClaudeCliArgs,
  lastStderrLine,
} from './index.js';

function fakeClaudeChild() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => true;
  Promise.resolve().then(() => proc.emit('close', 0));
  return proc;
}

describe('ClaudeCodeAdapter context-window-size resolution', () => {
  it('resolves the active model context window from listModels', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-size', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    // Stub listModels so the test does not depend on the seeded catalogue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).listModels = async () => [
      { name: 'claude-sonnet-4-6', label: 'Sonnet', contextWindow: 200000 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any)._resolveContextWindowSize('claude-sonnet-4-6');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any)._contextWindowSize).toBe(200000);
  });

  it('leaves the size undefined when the model is unknown and no fallback applies', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-size2', cwd: '/tmp', model: 'mystery' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).listModels = async () => [{ name: 'other', label: 'Other', contextWindow: 100 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any)._resolveContextWindowSize('mystery');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any)._contextWindowSize).toBeUndefined();
  });

  it('resolves opus-class models via naming fallback when absent from listModels', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-opus5', cwd: '/tmp', model: 'claude-opus-5' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).listModels = async () => [{ name: 'claude-sonnet-4-6', label: 'Sonnet', contextWindow: 200000 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any)._resolveContextWindowSize('claude-opus-5');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any)._contextWindowSize).toBe(1_000_000);
  });
});

describe('ClaudeCodeAdapter context-window % from usage', () => {
  it('computes contextWindowPct from the last assistant turn occupancy / window', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-pct', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._contextWindowSize = 200000;

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));

    // Assistant message carries per-step usage: 1000 + 90000 + 9000 = 100000 → 50%.
    // Include a text block so the turn is treated as having produced content
    // (the empty-reply guard in the result handler treats zero-content turns
    // as errors, which would mask the contextWindowPct assertion we're testing).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 9000 },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 1000, output_tokens: 50 },
      total_cost_usd: 0.01,
    });

    const done = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done).toBeDefined();
    expect(done!.type === 'status' && done!.payload.contextWindowPct).toBe(50);
  });

  it('getLiveContextWindowUsage reflects mid-turn occupancy before turn end', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._contextWindowSize = 200_000;
    expect(adapter.getLiveContextWindowUsage()).toEqual({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 9000 },
      },
    });

    expect(adapter.getLiveContextWindowUsage()).toEqual({
      contextWindowPct: 50,
      contextWindowSize: 200_000,
    });
  });

  it('omits contextWindowPct when the window size is unknown', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-pct2', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    // _contextWindowSize left undefined.
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1000, cache_read_input_tokens: 90000 } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({ type: 'result', is_error: false, usage: {}, total_cost_usd: 0 });
    const done = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done!.type === 'status' && done!.payload.contextWindowPct).toBeUndefined();
  });
});

describe('ClaudeCodeAdapter rate limits from usage', () => {
  it('converts utilization fraction to percentage and handles defaults', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-rl', cwd: '/tmp', model: 'claude-sonnet-4-6' });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));

    // Send five_hour rate limit event with 0.42 utilization
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'rate_limit_event',
      rate_limit_info: {
        rateLimitType: 'five_hour',
        utilization: 0.42,
        resetsAt: 1782147600,
      },
    });

    // Send seven_day rate limit event with undefined utilization (should default to 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'rate_limit_event',
      rate_limit_info: {
        rateLimitType: 'seven_day',
        resetsAt: 1782147600,
      },
    });

    // Send result to trigger status:done and emit the values.
    // Include output_tokens so the empty-reply guard (zero content + zero
    // output → status:error) doesn't fire — this test is about rate limits,
    // not empty turns.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'result',
      is_error: false,
      usage: { output_tokens: 10 },
      total_cost_usd: 0.01,
    });

    const done = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done).toBeDefined();
    expect(done!.type === 'status' && done!.payload.fiveHourPct).toBe(42);
    expect(done!.type === 'status' && done!.payload.fiveHourResetsAt).toBe(1782147600000);
    expect(done!.type === 'status' && done!.payload.sevenDayPct).toBe(0);
    expect(done!.type === 'status' && done!.payload.sevenDayResetsAt).toBe(1782147600000);
  });
});

describe('ClaudeCodeAdapter empty-reply detection', () => {
  it('surfaces status:error when a turn ends with no assistant text, no tool_use, and zero output tokens', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-empty', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));

    // Reproduce the "Unknown skill: grill-me" signature: the SDK returns a
    // result frame with is_error:false and zero output. Before the fix this
    // emitted status:done and the UI rendered nothing, reading as a silent
    // send failure. Now it must surface as a visible error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });

    const errStatus = events.find((e) => e.type === 'status' && e.payload.status === 'error');
    const errMsg = events.find((e) => e.type === 'error');
    const doneStatus = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(errStatus).toBeDefined();
    expect(errMsg).toBeDefined();
    expect(doneStatus).toBeUndefined();
  });

  it('still emits status:done when output_tokens > 0 even with no assistant content blocks', async () => {
    // Defense against false positives: a turn that the SDK reports as having
    // produced tokens (even if we didn't capture content blocks for some
    // reason) should not trigger the empty-reply guard.
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-tokens', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'result',
      is_error: false,
      usage: { output_tokens: 50 },
      total_cost_usd: 0.01,
    });

    const doneStatus = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    const errStatus = events.find((e) => e.type === 'status' && e.payload.status === 'error');
    expect(doneStatus).toBeDefined();
    expect(errStatus).toBeUndefined();
  });

  it('acknowledges /compact with status:done when the turn produces no output', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-compact', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
    // sendPrompt would spawn the SDK; set the flag the adapter sets for /compact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._silentSuccessAck = 'Context compacted successfully.';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._handleSdkMessage({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });

    const doneStatus = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    const errStatus = events.find((e) => e.type === 'status' && e.payload.status === 'error');
    const msg = events.find((e) => e.type === 'message');
    expect(doneStatus).toBeDefined();
    expect(errStatus).toBeUndefined();
    expect(msg?.payload.chunk).toMatch(/compacted successfully/i);
  });
});

describe('ClaudeCodeAdapter effort', () => {
  it('stores effort from start() and threads it into subprocess fallback args', async () => {
    const adapter = new CCAdapter();
    await adapter.start({
      sessionId: 's', conversationId: 'c-effort', cwd: '/tmp', model: 'claude-sonnet-4-6',
      effort: 'high',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any)._effort).toBe('high');

    // Force the subprocess path and capture argv by wrapping _subprocessFallback's
    // flag construction: stub _trySdk false, replace spawn via a thin spy on the
    // method that builds args the same way the real fallback does.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._trySdk = async () => false;
    let fallbackEffort: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._subprocessFallback = async function (this: any, _text: string, _model?: string) {
      const { clampEffort } = await import('@tierwyn/shared');
      const activeEffort = clampEffort('claude-code', this._effort);
      fallbackEffort = activeEffort;
      this._emit({ type: 'status', payload: { status: 'done' } });
    };

    await adapter.sendPrompt('think hard', [], 'claude-sonnet-4-6', 'xhigh');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any)._effort).toBe('xhigh');
    expect(fallbackEffort).toBe('xhigh');
  });

  it('clampEffort omits invalid levels before they reach the CLI', async () => {
    const { clampEffort } = await import('@tierwyn/shared');
    // Sanity: the same clamp the fallback uses rejects nothing for claude's 5-set,
    // and rejects xhigh for adapters that don't have it (covered in shared tests).
    expect(clampEffort('claude-code', 'xhigh')).toBe('xhigh');
    expect(clampEffort('claude-code', undefined)).toBeUndefined();
  });
});

describe('buildClaudeCodeSdkOptionOverrides', () => {
  it('returns empty object when options are omitted', () => {
    expect(buildClaudeCodeSdkOptionOverrides()).toEqual({});
    expect(buildClaudeCodeSdkOptionOverrides(null)).toEqual({});
    expect(buildClaudeCodeSdkOptionOverrides({})).toEqual({});
  });

  it('maps maxTurns select to a number', () => {
    expect(buildClaudeCodeSdkOptionOverrides({ maxTurns: '3' })).toEqual({ maxTurns: 3 });
    expect(buildClaudeCodeSdkOptionOverrides({ maxTurns: '10' })).toEqual({ maxTurns: 10 });
  });

  it('maps jsonSchema to outputFormat json_schema', () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } } };
    expect(buildClaudeCodeSdkOptionOverrides({ jsonSchema: JSON.stringify(schema) })).toEqual({
      outputFormat: { type: 'json_schema', schema },
    });
  });

  it('maps disableSlashCommands to empty skills (SDK analogue of --disable-slash-commands)', () => {
    expect(buildClaudeCodeSdkOptionOverrides({ disableSlashCommands: true })).toEqual({ skills: [] });
  });

  it('omits unrecognized or default values', () => {
    expect(buildClaudeCodeSdkOptionOverrides({
      maxTurns: 'default',
      jsonSchema: '',
      disableSlashCommands: false,
    })).toEqual({});
    expect(buildClaudeCodeSdkOptionOverrides({ maxTurns: '99' })).toEqual({});
  });

  it('maps permissionMode plan through and manual to SDK default', () => {
    expect(buildClaudeCodeSdkOptionOverrides({ permissionMode: 'plan' })).toEqual({ permissionMode: 'plan' });
    expect(buildClaudeCodeSdkOptionOverrides({ permissionMode: 'manual' })).toEqual({ permissionMode: 'default' });
    expect(buildClaudeCodeSdkOptionOverrides({ permissionMode: 'acceptEdits' })).toEqual({ permissionMode: 'acceptEdits' });
    expect(buildClaudeCodeSdkOptionOverrides({ permissionMode: 'dontAsk' })).toEqual({ permissionMode: 'dontAsk' });
  });
});

describe('ClaudeCodeAdapter prompt options', () => {
  function resultIterable(msg: Record<string, unknown>) {
    return {
      async *[Symbol.asyncIterator]() {
        yield msg;
      },
    };
  }

  it('passes maxTurns, jsonSchema, and disableSlashCommands into query options', async () => {
    const schema = { type: 'object', properties: { foo: { type: 'string' } } };
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result',
      is_error: false,
      result: 'ok',
      usage: { output_tokens: 4 },
    }));
    const adapter = new CCAdapter({ queryFn: queryFn as never });
    await adapter.start({ sessionId: 's', conversationId: 'c-opts', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    await adapter.sendPrompt('hi', [], undefined, undefined, {
      jsonSchema: JSON.stringify(schema),
      disableSlashCommands: true,
      maxTurns: '3',
    });
    expect(queryFn).toHaveBeenCalled();
    const opts = (queryFn.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts.maxTurns).toBe(3);
    expect(opts.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(opts.skills).toEqual([]);
  });

  it('threads options into subprocess fallback argv via appendClaudePromptOptionArgs', async () => {
    const adapter = new CCAdapter();
    await adapter.start({
      sessionId: 's', conversationId: 'c-fb', cwd: '/tmp', model: 'claude-sonnet-4-6',
      nativeSessionId: 'sess-resume',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._trySdk = async () => false;
    let capturedOptions: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._subprocessFallback = async function (this: any, _text: string, _model?: string, options?: unknown) {
      capturedOptions = options;
      this._emit({ type: 'status', payload: { status: 'done' } });
    };
    await adapter.sendPrompt('hi', [], undefined, undefined, { maxTurns: '5', disableSlashCommands: true });
    expect(capturedOptions).toEqual({ maxTurns: '5', disableSlashCommands: true });
  });

  it('forwards prompt options from runCommand to sendPrompt', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-cmd', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    const send = vi.spyOn(adapter, 'sendPrompt').mockResolvedValue();
    await adapter.runCommand('compact', undefined, { maxTurns: '1' });
    expect(send).toHaveBeenCalledWith('/compact', [], undefined, undefined, { maxTurns: '1' });
  });

  it('restricted / safeMode stay on the SDK path and map to extraArgs (no CLI fallback)', async () => {
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result', is_error: false, result: 'ok', usage: { output_tokens: 4 },
    }));
    const adapter = new CCAdapter({ queryFn: queryFn as never });
    await adapter.start({ sessionId: 's', conversationId: 'c-restricted', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fallback = vi.spyOn(adapter as any, '_subprocessFallback');
    await adapter.sendPrompt('hi', [], undefined, undefined, { restricted: true, safeMode: true });
    expect(fallback).not.toHaveBeenCalled();
    expect(queryFn).toHaveBeenCalledTimes(1);
    const opts = (queryFn.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts.extraArgs).toEqual({ restricted: null, 'safe-mode': null });
    // never bypassPermissions under restricted; canUseTool attached so gated tools show cards
    expect(opts.permissionMode).toBe('acceptEdits');
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('passes permissionMode into query options after the hardcoded default', async () => {
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result',
      is_error: false,
      result: 'ok',
      usage: { output_tokens: 4 },
    }));
    const adapter = new CCAdapter({ queryFn: queryFn as never });
    await adapter.start({ sessionId: 's', conversationId: 'c-pm', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    await adapter.sendPrompt('hi', [], undefined, undefined, { permissionMode: 'plan' });
    const opts = (queryFn.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts.permissionMode).toBe('plan');
  });

  it('bypass conversation + manual override attaches canUseTool (permission cards, not silent denials)', async () => {
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result', is_error: false, result: 'ok', usage: { output_tokens: 4 },
    }));
    const adapter = new CCAdapter({ queryFn: queryFn as never });
    await adapter.start({ sessionId: 's', conversationId: 'c-manual', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    await adapter.sendPrompt('hi', [], undefined, undefined, { permissionMode: 'manual' });
    const opts = (queryFn.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts.permissionMode).toBe('default');
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('plain bypass turn is unchanged: bypassPermissions, no canUseTool, no extraArgs', async () => {
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result', is_error: false, result: 'ok', usage: { output_tokens: 4 },
    }));
    const adapter = new CCAdapter({ queryFn: queryFn as never });
    await adapter.start({ sessionId: 's', conversationId: 'c-plain', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    await adapter.sendPrompt('hi');
    const opts = (queryFn.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.canUseTool).toBeUndefined();
    expect(opts.extraArgs).toBeUndefined();
  });

  it('refuses the CLI fallback (clear error) when interaction mode is not bypass and the SDK cannot start', async () => {
    const queryFn = vi.fn(() => { throw new Error('spawn claude ENOENT'); });
    const adapter = new CCAdapter({ queryFn: queryFn as never, interactionMode: 'prompt' });
    await adapter.start({ sessionId: 's', conversationId: 'c-nofallback', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockClear();
    await adapter.sendPrompt('hi');
    expect(spawnMock).not.toHaveBeenCalled();
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect((err!.payload as { message: string }).message).toMatch(/CLI fallback is disabled.*"prompt".*ENOENT/);
    expect(events.some((e) => e.type === 'status' && (e.payload as { status: string }).status === 'error')).toBe(true);
  });

  it('textOnly sessions may still use the CLI fallback in a non-bypass conversation (no tools)', async () => {
    const adapter = new CCAdapter({ interactionMode: 'prompt' });
    await adapter.start({ sessionId: 's', conversationId: 'c-textonly-prompt', cwd: '/tmp', model: 'claude-sonnet-4-6', textOnly: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._trySdk = async () => false;
    let capturedArgs: string[] = [];
    const actualSpawn = (await vi.importActual<typeof import('child_process')>('child_process')).spawn;
    vi.mocked(spawn).mockImplementationOnce(((_cmd: string, args: readonly string[]) => {
      capturedArgs = [...args];
      return fakeClaudeChild();
    }) as typeof spawn);
    await adapter.sendPrompt('summarise');
    vi.mocked(spawn).mockImplementation(actualSpawn);
    expect(capturedArgs).toContain('--tools');
    expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('CLI fallback reports the last stderr line in the exit-code error', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-stderr', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._trySdk = async () => false;
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
    const actualSpawn = (await vi.importActual<typeof import('child_process')>('child_process')).spawn;
    vi.mocked(spawn).mockImplementationOnce((() => {
      const proc = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => true;
      Promise.resolve().then(() => {
        proc.stderr.write('warming up\nError: something specific broke\n');
        setImmediate(() => proc.emit('close', 1));
      });
      return proc;
    }) as unknown as typeof spawn);
    await adapter.sendPrompt('hi');
    vi.mocked(spawn).mockImplementation(actualSpawn);
    const err = events.find((e) => e.type === 'error');
    expect((err!.payload as { message: string }).message).toBe('claude exited with code 1: Error: something specific broke');
  });

  it('textOnly SDK options include tools:[] and empty mcpServers', async () => {
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result',
      is_error: false,
      result: 'ok',
      usage: { output_tokens: 4 },
    }));
    const adapter = new CCAdapter({ queryFn: queryFn as never });
    await adapter.start({
      sessionId: 's', conversationId: 'c-textonly', cwd: '/tmp', model: 'claude-sonnet-4-6',
      textOnly: true,
    });
    await adapter.sendPrompt('summarise');
    const opts = (queryFn.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts.tools).toEqual([]);
    expect(opts.mcpServers).toEqual({});
    expect(opts.strictMcpConfig).toBe(true);
  });

  it('textOnly CLI fallback args include --strict-mcp-config and --max-turns 1', async () => {
    const adapter = new CCAdapter();
    await adapter.start({
      sessionId: 's', conversationId: 'c-textonly-cli', cwd: '/tmp', model: 'claude-sonnet-4-6',
      textOnly: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._trySdk = async () => false;
    let capturedArgs: string[] = [];
    const actualSpawn = (await vi.importActual<typeof import('child_process')>('child_process')).spawn;
    vi.mocked(spawn).mockImplementationOnce(((cmd: string, args: readonly string[]) => {
      capturedArgs = [...args];
      return fakeClaudeChild();
    }) as typeof spawn);
    await adapter.sendPrompt('summarise');
    vi.mocked(spawn).mockImplementation(actualSpawn);
    expect(capturedArgs).toEqual(expect.arrayContaining(['--tools', '', '--setting-sources', '']));
    expect(capturedArgs).toContain('--strict-mcp-config');
    expect(capturedArgs).toContain('--max-turns');
    expect(capturedArgs[capturedArgs.indexOf('--max-turns') + 1]).toBe('1');
  });
});

describe('ClaudeCodeAdapter stop() escalation', () => {
  it('SIGTERM then group SIGKILL after KILL_ESCALATION_MS', async () => {
    vi.useFakeTimers();
    const adapter = new CCAdapter();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 9991;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._subprocess = child;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await adapter.stop();
    expect(killSpy).toHaveBeenCalledWith(-9991, 'SIGTERM');
    const { KILL_ESCALATION_MS } = await import('../escalateKill.js');
    vi.advanceTimersByTime(KILL_ESCALATION_MS);
    expect(killSpy).toHaveBeenCalledWith(-9991, 'SIGKILL');
    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it('no SIGKILL on the ChildProcess after the leader exits (group SIGKILL still fires)', async () => {
    vi.useFakeTimers();
    const adapter = new CCAdapter();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 9992;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._subprocess = child;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await adapter.stop();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    const { KILL_ESCALATION_MS } = await import('../escalateKill.js');
    vi.advanceTimersByTime(KILL_ESCALATION_MS);
    expect(killSpy).toHaveBeenCalledWith(-9992, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    killSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe('buildClaudeCliArgs', () => {
  const base = { interactionMode: 'bypass' as const };

  it('bypass conversation, no override, not restricted: --dangerously-skip-permissions + untrusted setting-sources by default', () => {
    const args = buildClaudeCliArgs({ ...base });
    expect(args).toEqual(['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--dangerously-skip-permissions', '--setting-sources', 'user']);
  });

  it('trustRepoConfig: true omits --setting-sources user', () => {
    const args = buildClaudeCliArgs({ ...base, trustRepoConfig: true });
    expect(args).toEqual(['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--dangerously-skip-permissions']);
  });

  it('restricted never combines with --dangerously-skip-permissions; uses --permission-mode acceptEdits', () => {
    const args = buildClaudeCliArgs({ ...base, options: { restricted: true } });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--restricted');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).not.toContain('bypassPermissions');
  });

  it('restricted + safeMode: both flags, no bypass', () => {
    const args = buildClaudeCliArgs({ ...base, options: { restricted: true, safeMode: true } });
    expect(args).toEqual(expect.arrayContaining(['--restricted', '--safe-mode']));
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('safeMode alone in a bypass conversation keeps bypass', () => {
    const args = buildClaudeCliArgs({ ...base, options: { safeMode: true } });
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it.each(['manual', 'acceptEdits', 'plan', 'dontAsk'])('permission mode %s is honoured (flag omitted, mode passed once)', (mode) => {
    const args = buildClaudeCliArgs({ ...base, options: { permissionMode: mode } });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe(mode);
  });

  it('an explicit override wins over the restricted default', () => {
    const args = buildClaudeCliArgs({ ...base, options: { restricted: true, permissionMode: 'plan' } });
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('non-bypass conversations never get the bypass flag', () => {
    for (const mode of ['prompt', 'questions'] as const) {
      const args = buildClaudeCliArgs({ interactionMode: mode });
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual');
    }
  });

  it('threads model, effort, textOnly flags and resume', () => {
    const args = buildClaudeCliArgs({ ...base, textOnly: true, model: 'm', effort: 'high', resumeSessionId: 'sid' });
    expect(args).toEqual(expect.arrayContaining(['--tools', '', '--setting-sources', '', '--strict-mcp-config', '--max-turns', '1', '--model', 'm', '--effort', 'high', '--resume', 'sid']));
  });
});

describe('buildClaudeCodeSdkPermissionOptions', () => {
  it('bypass baseline', () => {
    expect(buildClaudeCodeSdkPermissionOptions('bypass', undefined)).toEqual({
      permissionMode: 'bypassPermissions', attachCanUseTool: false, promptForPermissions: false,
    });
  });
  it('non-bypass conversations use default + canUseTool', () => {
    expect(buildClaudeCodeSdkPermissionOptions('prompt', undefined)).toMatchObject({ permissionMode: 'default', attachCanUseTool: true });
    expect(buildClaudeCodeSdkPermissionOptions('questions', { restricted: true })).toMatchObject({ permissionMode: 'default', attachCanUseTool: true, extraArgs: { restricted: null } });
  });
  it('restricted in a bypass conversation never uses bypassPermissions', () => {
    const r = buildClaudeCodeSdkPermissionOptions('bypass', { restricted: true });
    expect(r.permissionMode).toBe('acceptEdits');
    expect(r.attachCanUseTool).toBe(true);
  });
  it('manual/plan override in bypass attaches canUseTool; dontAsk does not', () => {
    expect(buildClaudeCodeSdkPermissionOptions('bypass', { permissionMode: 'manual' })).toMatchObject({ permissionMode: 'default', attachCanUseTool: true, promptForPermissions: true });
    expect(buildClaudeCodeSdkPermissionOptions('bypass', { permissionMode: 'plan' })).toMatchObject({ permissionMode: 'plan', attachCanUseTool: true });
    expect(buildClaudeCodeSdkPermissionOptions('bypass', { permissionMode: 'dontAsk' })).toMatchObject({ permissionMode: 'dontAsk', attachCanUseTool: false });
  });
  it('safeMode maps to extraArgs only', () => {
    expect(buildClaudeCodeSdkPermissionOptions('bypass', { safeMode: true })).toEqual({
      permissionMode: 'bypassPermissions', attachCanUseTool: false, promptForPermissions: false, extraArgs: { 'safe-mode': null },
    });
  });
});

describe('lastStderrLine', () => {
  it('returns the last non-empty line, truncated', () => {
    expect(lastStderrLine('a\n\nb\n  \n')).toBe('b');
    expect(lastStderrLine('')).toBe('');
    expect(lastStderrLine('x'.repeat(400))).toHaveLength(300);
  });
});

describe('ClaudeCodeAdapter WP-2.4 live controls', () => {
  const SECRET_ONE = 'secret-val-one-12345';
  const SECRET_TWO = 'secret-val-two-67890';

  const srvOne: ResolvedMcpServer = {
    id: 'srv-one', transport: 'stdio', command: 'node', args: ['srv1.js'], cwd: '/tmp',
    env: { SECRET_KEY: SECRET_ONE, PLAIN: 'abc' }, secretEnvKeys: ['SECRET_KEY'],
    headers: {}, secretHeaderKeys: [],
  };

  const srvTwo: ResolvedMcpServer = {
    id: 'srv-two', transport: 'stdio', command: 'node', args: ['srv2.js'], cwd: '/tmp',
    env: { OTHER_KEY: SECRET_TWO }, secretEnvKeys: ['OTHER_KEY'],
    headers: {}, secretHeaderKeys: [],
  };

  const srvPlain: ResolvedMcpServer = {
    id: 'srv-plain', transport: 'stdio', command: 'node', args: ['plain.js'], cwd: '/tmp',
    env: { MODE: 'dev' }, secretEnvKeys: [],
    headers: {}, secretHeaderKeys: [],
  };

  it('setModelLive rejects with no_live_query when no live query exists or textOnly', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'sonnet' });
    // No query started yet
    await expect((adapter as any).setModelLive('opus')).rejects.toThrow('no_live_query');

    const textOnlyAdapter = new CCAdapter();
    await textOnlyAdapter.start({ sessionId: 's2', conversationId: 'c-live2', cwd: '/tmp', model: 'sonnet', textOnly: true });
    (textOnlyAdapter as any)._query = { setModel: vi.fn() };
    await expect((textOnlyAdapter as any).setModelLive('opus')).rejects.toThrow('no_live_query');
  });

  it('setModelLive calls query.setModel, updates _model, and recalculates context window (M1)', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    const mockQuery = {
      setModel: vi.fn().mockResolvedValue(undefined),
    };
    (adapter as any)._query = mockQuery;
    const resolveContextSpy = vi.spyOn(adapter as any, '_resolveContextWindowSize');

    await (adapter as any).setModelLive('claude-opus-5');
    expect(mockQuery.setModel).toHaveBeenCalledWith('claude-opus-5');
    expect((adapter as any)._model).toBe('claude-opus-5');
    expect(resolveContextSpy).toHaveBeenCalledWith('claude-opus-5');
  });

  it('setMcpServersLive returns false when no query exists or adapter is textOnly', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'sonnet' });
    expect(await (adapter as any).setMcpServersLive([srvPlain])).toBe(false);

    const textOnlyAdapter = new CCAdapter();
    await textOnlyAdapter.start({ sessionId: 's2', conversationId: 'c-live2', cwd: '/tmp', model: 'sonnet', textOnly: true });
    (textOnlyAdapter as any)._query = { setMcpServers: vi.fn() };
    expect(await (textOnlyAdapter as any).setMcpServersLive([srvPlain])).toBe(false);
  });

  const srvPlain2: ResolvedMcpServer = {
    id: 'srv-plain2', transport: 'stdio', command: 'node', args: ['plain2.js'], cwd: '/tmp',
    env: { EXTRA: 'yes' }, secretEnvKeys: [],
    headers: {}, secretHeaderKeys: [],
  };

  it('setMcpServersLive returns false when new set contains ANY secret (B1)', async () => {
    const adapter = new CCAdapter();
    // Started with srvPlain only (secret-free)
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'sonnet', mcpServers: [srvPlain] });
    const mockQuery = {
      setMcpServers: vi.fn().mockResolvedValue({ added: [], removed: [], updated: [] }),
    };
    (adapter as any)._query = mockQuery;

    // Trying to add srvOne (which has secrets) must return false
    const ok = await (adapter as any).setMcpServersLive([srvPlain, srvOne]);
    expect(ok).toBe(false);
    expect(mockQuery.setMcpServers).not.toHaveBeenCalled();

    // Even if started with srvOne, re-sending the same srvOne returns false because placeholders don't expand over control channel
    const adapterWithSecret = new CCAdapter();
    await adapterWithSecret.start({ sessionId: 's2', conversationId: 'c-live', cwd: '/tmp', model: 'sonnet', mcpServers: [srvOne] });
    (adapterWithSecret as any)._query = mockQuery;
    const okSame = await (adapterWithSecret as any).setMcpServersLive([srvOne]);
    expect(okSame).toBe(false);
    expect(mockQuery.setMcpServers).not.toHaveBeenCalled();
  });

  it('setMcpServersLive returns false when a spawn-time server is removed or altered (B1)', async () => {
    const adapter = new CCAdapter();
    // Started with srvPlain at spawn time
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'sonnet', mcpServers: [srvPlain] });
    const mockQuery = {
      setMcpServers: vi.fn().mockResolvedValue({ added: [], removed: [], updated: [] }),
    };
    (adapter as any)._query = mockQuery;

    // Removal of spawn-time server
    const okRemove = await (adapter as any).setMcpServersLive([]);
    expect(okRemove).toBe(false);
    expect(mockQuery.setMcpServers).not.toHaveBeenCalled();

    // Alteration of spawn-time server
    const okAlter = await (adapter as any).setMcpServersLive([{ ...srvPlain, args: ['changed.js'] }]);
    expect(okAlter).toBe(false);
    expect(mockQuery.setMcpServers).not.toHaveBeenCalled();
  });

  it('setMcpServersLive returns true when adding secret-free servers with spawn set intact (payload contains no placeholders)', async () => {
    const adapter = new CCAdapter();
    // Started with srvPlain
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'sonnet', mcpServers: [srvPlain] });
    const mockQuery = {
      setMcpServers: vi.fn().mockResolvedValue({ added: ['srv-plain2'], removed: [], updated: [] }),
    };
    (adapter as any)._query = mockQuery;

    const ok = await (adapter as any).setMcpServersLive([srvPlain, srvPlain2]);
    expect(ok).toBe(true);
    expect(mockQuery.setMcpServers).toHaveBeenCalledTimes(1);

    const passedServers = mockQuery.setMcpServers.mock.calls[0]![0];
    const jsonPassed = JSON.stringify(passedServers);
    expect(jsonPassed).not.toContain('${');
    expect(passedServers['srv-plain'].env.MODE).toBe('dev');
    expect(passedServers['srv-plain2'].env.EXTRA).toBe('yes');
  });

  it('setMcpServersLive returns true when removing a previously live-added server (spawn set intact)', async () => {
    const adapter = new CCAdapter();
    // Started with srvPlain at spawn
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'sonnet', mcpServers: [srvPlain] });
    const mockQuery = {
      setMcpServers: vi.fn().mockResolvedValue({ added: [], removed: [], updated: [] }),
    };
    (adapter as any)._query = mockQuery;

    // Add srvPlain2 live
    const okAdd = await (adapter as any).setMcpServersLive([srvPlain, srvPlain2]);
    expect(okAdd).toBe(true);

    // Now remove srvPlain2 (leaving spawn-time srvPlain intact)
    mockQuery.setMcpServers.mockClear();
    const okRemoveLive = await (adapter as any).setMcpServersLive([srvPlain]);
    expect(okRemoveLive).toBe(true);
    expect(mockQuery.setMcpServers).toHaveBeenCalledTimes(1);
    expect(mockQuery.setMcpServers.mock.calls[0]![0]).toEqual({
      'srv-plain': { type: 'stdio', command: 'node', args: ['plain.js'], env: { MODE: 'dev' } },
    });
  });

  it('setMcpServersLive surfaces per-server errors from query result (I3)', async () => {
    const adapter = new CCAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c-live', cwd: '/tmp', model: 'sonnet', mcpServers: [srvPlain] });
    const mockQuery = {
      setMcpServers: vi.fn().mockResolvedValue({
        added: ['srv-plain2'],
        removed: [],
        updated: [],
        errors: { 'srv-plain2': 'connection timed out after 30000ms' },
      }),
    };
    (adapter as any)._query = mockQuery;

    const emitted: any[] = [];
    adapter.streamEvents().on('event', (ev) => emitted.push(ev));

    const ok = await (adapter as any).setMcpServersLive([srvPlain, srvPlain2]);
    expect(ok).toBe(true);

    // Wait microtask for background settlement
    await new Promise((r) => setTimeout(r, 10));
    const msg = emitted.find((e) => e.type === 'message' && e.payload?.chunk?.includes('srv-plain2 failed to connect'));
    expect(msg).toBeDefined();
  });
});
