import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, writeFileSync, rmSync, utimesSync as fs_utimeSync, mkdirSync } from 'fs';
import * as osNode from 'os';
import * as pathNode from 'path';
import type { NormalisedEvent } from '@tierwyn/shared';
import { AntigravityAdapter, SpawnFn, modelNameBakesEffort, detectAgyFatalStderr } from './index.js';

/**
 * Build a fake ChildProcess that mirrors the shape the adapter expects:
 *   - stdin: a PassThrough we can inspect
 *   - stdout: a PassThrough we can push lines into
 *   - stderr: a PassThrough we can push lines into (agy logs the conversation
 *     id here via `Created conversation <uuid>`)
 *   - kill(): noop by default
 *   - EventEmitter for 'error' and 'close'
 */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => void;
  };

  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = (_signal?: string) => {};

  return proc;
}

/**
 * Path that is guaranteed not to exist (or is empty) so the adapter's
 * fallback conversations-dir scan returns null deterministically in tests
 * that don't care about session capture.
 */
const EMPTY_CONVERSATIONS_DIR = pathNode.join(osNode.tmpdir(), 'tierwyn-agy-test-empty-dir');

function setupAdapter(conversationsDir = EMPTY_CONVERSATIONS_DIR, customSpawnFn?: SpawnFn) {
  const child = fakeChild();
  let onSpawn: (() => void) | null = null;
  const spawned = new Promise<void>((resolve) => {
    onSpawn = resolve;
  });

  const spawnFn: SpawnFn = (cmd, args, opts) => {
    if (customSpawnFn) {
      const res = customSpawnFn(cmd, args, opts);
      onSpawn?.();
      return res;
    }
    onSpawn?.();
    return child as never;
  };

  const adapter = new AntigravityAdapter({
    conversationsDir,
    spawnFn,
    probeRateLimits: async () => ({}),
  });

  return { adapter, child, spawned };
}

function drainStdin(child: ReturnType<typeof fakeChild>): string {
  const chunks: Buffer[] = [];
  let buf: Buffer | null;
  while ((buf = child.stdin.read() as Buffer | null) !== null) {
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString();
}

function successResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c1',
      status: 'SUCCESS',
      response: 'ok',
      usage: {},
      ...overrides,
    },
  }) + '\n';
}

describe('AntigravityAdapter', () => {
  it('sendPrompt emits status:running, message chunks, message:final, status:done, and end', async () => {
    const { adapter, child, spawned } = setupAdapter();

    await adapter.start({
      sessionId: 'test-session',
      conversationId: 'conv-1',
      cwd: '/tmp',
      model: 'Claude Sonnet 4.6 (Thinking)',
    });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });

    const done = adapter.sendPrompt('Say hello');
    await spawned;

    // Write stdout lines then close the stream to trigger 'close'.
    child.stdout.write('Hello from Antigravity!\n');
    child.stdout.write('Hope you are well.\n');
    child.stdout.end();
    // Emit close manually (PassThrough end emits 'finish', not child 'close')
    child.emit('close', 0);

    await done;

    expect(ended).toBe(true);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('status'); // status:running first

    // Must contain at least one message chunk
    expect(types).toContain('message');

    // Last message event must be the final marker
    const messageEvents = events.filter((e) => e.type === 'message');
    const lastMsg = messageEvents[messageEvents.length - 1];
    expect(lastMsg.type === 'message' && lastMsg.payload.final).toBe(true);
    expect(lastMsg.type === 'message' && lastMsg.payload.chunk).toBe('');

    // Last status must be done
    const statusEvents = events.filter((e) => e.type === 'status');
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus.type === 'status' && lastStatus.payload.status).toBe('done');

    // First status must be running
    expect(statusEvents[0].type === 'status' && statusEvents[0].payload.status).toBe('running');
  });

  it('sendPrompt uses stream-json stdin and empty --print= (not a positional prompt)', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];

    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        Promise.resolve().then(() => {
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'GPT-OSS 120B (Medium)' });

    adapter.streamEvents().on('event', () => {});
    await adapter.sendPrompt('Hello agy!');

    expect(capturedArgs).toContain('--input-format');
    expect(capturedArgs[capturedArgs.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(capturedArgs).toContain('--output-format');
    expect(capturedArgs[capturedArgs.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(capturedArgs).toContain('--print=');
    expect(capturedArgs).not.toContain('--print');
    expect(capturedArgs).not.toContain('Hello agy!');
    expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
    expect(capturedArgs).toContain('--add-dir=/tmp');
    const printIdx = capturedArgs.indexOf('--print=');
    expect(capturedArgs[printIdx + 1]).not.toBe('Hello agy!');
  });

  it('sendPrompt raises agy print-mode wait above the 5m default', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];

    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        Promise.resolve().then(() => {
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'GPT-OSS 120B (Medium)' });

    adapter.streamEvents().on('event', () => {});
    await adapter.sendPrompt('Hello agy!');

    const idx = capturedArgs.indexOf('--print-timeout');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs[idx + 1]).toBe('30m');
  });

  it('sendPrompt requests stream-json output', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];

    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        Promise.resolve().then(() => {
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'GPT-OSS 120B (Medium)' });

    adapter.streamEvents().on('event', () => {});
    await adapter.sendPrompt('Hello agy!');

    const idx = capturedArgs.indexOf('--output-format');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs[idx + 1]).toBe('stream-json');
  });

  it('maps stream-json tool frames to tool_call + tool_result and captures conversation id', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    const done = adapter.sendPrompt('echo probe');
    await spawned;

    const conv = 'db192107-47ee-4c72-9f68-dabcca03d531';
    child.stdout.write(JSON.stringify({
      event: 'init',
      conversation_id: conv,
      init: { cwd: '/tmp', tools: ['run_command'], permission_mode: 'always-proceed' },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: conv,
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
      },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: conv,
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'echo hi' },
          output: 'hi\n',
        },
      },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: conv,
        step_index: 4,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'OK\n',
      },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: conv,
        status: 'SUCCESS',
        response: 'OK\n',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0 },
      },
    }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(adapter.nativeSessionId).toBe(conv);

    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].type === 'tool_call' && calls[0].payload.name).toBe('run_command');
    expect(calls[0].type === 'tool_call' && calls[0].payload.input).toEqual({ CommandLine: 'echo hi' });

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].type === 'tool_result' && results[0].payload.content).toBe('hi\n');

    const messages = events.filter((e) => e.type === 'message');
    expect(messages.some((e) => e.type === 'message' && e.payload.chunk === 'OK\n')).toBe(true);

    const lastStatus = events.filter((e) => e.type === 'status').at(-1);
    expect(lastStatus?.type === 'status' && lastStatus.payload.status).toBe('done');
    expect(lastStatus?.type === 'status' && lastStatus.payload.inputTokens).toBe(10);
  });

  it('maps invoke_subagent frames and tails the subagent transcript into nested events', async () => {
    const tmp = mkdtempSync(pathNode.join(osNode.tmpdir(), 'tierwyn-agy-idx-sub-'));
    const subConv = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const parentConv = 'db192107-47ee-4c72-9f68-dabcca03d531';
    const convDir = pathNode.join(tmp, subConv);
    mkdirSync(convDir);
    const logPath = pathNode.join(convDir, 'transcript.jsonl');
    writeFileSync(logPath, [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"' } }],
      }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'a.txt  b.txt',
      }),
      '',
    ].join('\n'));

    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      subagentPollMs: 40,
      spawnFn: () => {
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    const done = adapter.sendPrompt('launch a subagent');
    await spawned;

    child.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: parentConv,
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'subagent',
        tool_name: 'invoke_subagent',
        subagent_info: {
          subagents: [{
            type_name: 'research',
            role: 'Lister',
            initial_prompt: 'run ls',
            conversation_id: subConv,
            log_uri: `file://${logPath}`,
          }],
        },
      },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: parentConv,
        step_index: 4,
        state: 'DONE',
        step_type: 'subagent',
        tool_name: 'invoke_subagent',
        duration_seconds: 1.2,
        subagent_info: {
          subagents: [{
            type_name: 'research',
            role: 'Lister',
            initial_prompt: 'run ls',
            conversation_id: subConv,
            log_uri: `file://${logPath}`,
          }],
        },
      },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'result',
      result: { conversation_id: parentConv, status: 'SUCCESS', response: 'ok', usage: {} },
    }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;
    rmSync(tmp, { recursive: true, force: true });

    const parentCall = events.find((e) => e.type === 'tool_call' && e.payload.name === 'invoke_subagent');
    expect(parentCall).toBeTruthy();
    expect(parentCall?.type === 'tool_call' && parentCall.payload.toolUseId).toBe(`agy:${parentConv}:4`);

    const nestedCall = events.find((e) => e.type === 'tool_call' && e.payload.name === 'run_command');
    expect(nestedCall?.type === 'tool_call' && nestedCall.payload.parentToolUseId).toBe(`agy:${parentConv}:4`);

    const nestedMsg = events.find((e) => e.type === 'message' && e.payload.chunk === 'a.txt  b.txt');
    expect(nestedMsg?.type === 'message' && nestedMsg.payload.parentToolUseId).toBe(`agy:${parentConv}:4`);

    const parentResult = events.find((e) => e.type === 'tool_result' && e.payload.toolUseId === `agy:${parentConv}:4`);
    expect(parentResult?.type === 'tool_result' && parentResult.payload.content).toMatch(/subagent Lister finished/);

    // Nested events and the closing tool_result must all precede the parent's
    // final message — the tailer flushes on the result frame BEFORE the
    // final message is emitted (the original bug: they landed after).
    const finalMsg = events.find((e) => e.type === 'message' && e.payload.final === true);
    expect(finalMsg).toBeTruthy();

    const iCall = events.indexOf(parentCall!);
    const iNested = events.indexOf(nestedCall!);
    const iResult = events.indexOf(parentResult!);
    const iFinal = events.indexOf(finalMsg!);
    expect(iCall).toBeLessThan(iNested);
    expect(iNested).toBeLessThan(iResult);
    expect(iResult).toBeLessThan(iFinal);
  });

  it('overlays probed 5h/7d used-percent on the terminal status:done without dropping tokens', async () => {
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      spawnFn: () => {
        onSpawn?.();
        return child as never;
      },
      probeRateLimits: async ({ model }) => {
        expect(model).toBe('gemini-3.6-flash-medium');
        return {
          fiveHourPct: 21.4,
          fiveHourResetsAt: Date.parse('2026-01-01T01:00:00Z'),
          sevenDayPct: 6.5,
          sevenDayResetsAt: Date.parse('2026-01-05T00:00:00Z'),
        };
      },
    });
    await adapter.start({
      sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'gemini-3.6-flash-medium',
    });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    const done = adapter.sendPrompt('echo probe');
    await spawned;
    child.stdout.write(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'c1',
        status: 'SUCCESS',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 4 },
      },
    }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    const lastStatus = events.filter((e) => e.type === 'status').at(-1);
    expect(lastStatus?.type === 'status' && lastStatus.payload).toMatchObject({
      status: 'done',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 4,
      fiveHourPct: 21.4,
      fiveHourResetsAt: Date.parse('2026-01-01T01:00:00Z'),
      sevenDayPct: 6.5,
      sevenDayResetsAt: Date.parse('2026-01-05T00:00:00Z'),
    });
    // Exactly ONE terminal done per clean turn: sessionManager fires
    // recordAutoCheckpoint per status:done (deduped by eventId only), so a
    // second done would double checkpoints + code snapshots.
    const doneCount = events.filter(
      (e) => e.type === 'status' && (e.payload as { status?: string }).status === 'done',
    ).length;
    expect(doneCount).toBe(1);
  });

  it('does not overlay a status:done onto an errored turn that still exited 0', async () => {
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    let probes = 0;
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      spawnFn: () => { onSpawn?.(); return child as never; },
      probeRateLimits: async () => { probes += 1; return { fiveHourPct: 21.4 }; },
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'gemini-3.6-flash' });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    const done = adapter.sendPrompt('boom');
    await spawned;
    // ERROR result with no recoverable response, but agy still exits 0.
    child.stdout.write(JSON.stringify({
      event: 'result',
      result: { conversation_id: 'c1', status: 'ERROR', error: 'model refused' },
    }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(probes).toBe(0);
    const lastStatus = events.filter((e) => e.type === 'status').at(-1);
    expect(lastStatus?.type === 'status' && lastStatus.payload.status).toBe('error');
  });

  it('does not mark the turn error when stream-json result is ERROR after a recovered write_to_file', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    const done = adapter.sendPrompt('write a file');
    await spawned;
    const conv = '9ee56cfe-1a5a-463b-a0f0-be063bbda446';
    child.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: conv,
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { name: 'write_to_file', parameters: { TargetFile: '/home/user/Projects/Test/mock_test_file.txt' } },
      },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: conv,
        step_index: 4,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'The test operations have been completed:\n',
      },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: conv,
        status: 'ERROR',
        response: 'The test operations have been completed:\n',
        error: 'declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) /home/user/Projects/Test/mock_test_file.txt is not a valid artifact path; artifacts must be in /home/user/.gemini/antigravity-cli/brain/9ee56cfe-1a5a-463b-a0f0-be063bbda446/',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0 },
      },
    }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const lastStatus = events.filter((e) => e.type === 'status').at(-1);
    expect(lastStatus?.type === 'status' && lastStatus.payload.status).toBe('done');
    const failed = events.filter((e) => e.type === 'tool_result' && e.payload.isError);
    expect(failed).toHaveLength(1);
    expect(failed[0].type === 'tool_result' && failed[0].payload.content).toMatch(/not a valid artifact path/);
  });

  it('emits error + status:error on child error event', async () => {
        const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });

    const done = adapter.sendPrompt('oops');
    await spawned;
    child.emit('error', new Error('spawn failed'));
    await done;

    expect(ended).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    const errorEvt = events.find((e) => e.type === 'error');
    expect(errorEvt?.type === 'error' && errorEvt.payload.message).toContain('spawn failed');
    const statusEvts = events.filter((e) => e.type === 'status');
    const lastStatus = statusEvts[statusEvts.length - 1];
    expect(lastStatus?.type === 'status' && lastStatus.payload.status).toBe('error');
  });

  it('stop() kills the child and emits status:idle', async () => {
    let killed: string | undefined;
    const child = fakeChild();
    child.kill = (sig) => {
      killed = sig ?? 'SIGTERM';
      child.emit('close', 0);
    };

    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve;
    });

    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => {
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const statuses: string[] = [];
    adapter.streamEvents().on('event', (e) => {
      if (e.type === 'status') statuses.push(e.payload.status);
    });

    // Start a prompt so _child is set.
    const promptPromise = adapter.sendPrompt('hi');
    await spawned;

    await adapter.stop();
    await promptPromise.catch(() => {});

    expect(killed).toBe('SIGTERM');
    expect(statuses).toContain('idle');
  });

  it("stop() emits 'end' so hard Interrupt & Send can drain", async () => {
    const child = fakeChild();
    child.kill = () => { child.emit('close', 0); };
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => child as never,
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });
    adapter.sendPrompt('hi').catch(() => {});
    const ended = new Promise<void>((resolve) => adapter.streamEvents().once('end', () => resolve()));
    await adapter.stop();
    await ended;
  });

  it('listModels() parses agy models stdout into ModelDescriptors', async () => {
    const modelLines = [
      'Gemini 3.5 Flash (High)',
      'Claude Sonnet 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
    ];

    const child = fakeChild();
    const adapter = new AntigravityAdapter({
      spawnFn: (_cmd, args) => {
        if (args[0] === 'models') {
          // Schedule the write after current tick so listeners are attached.
          Promise.resolve().then(() => {
            child.stdout.write(modelLines.join('\n') + '\n');
            child.stdout.end();
            child.emit('close', 0);
          });
        }
        return child as never;
      },
    });

    const models = await adapter.listModels();

    expect(models).toHaveLength(3);

    expect(models[0]).toMatchObject({
      name: 'Gemini 3.5 Flash (High)',
      label: 'Antigravity · Gemini 3.5 Flash (High)',
      provider: 'antigravity',
      vision: true,
      steer: true,
    });

    expect(models[1]).toMatchObject({
      name: 'Claude Sonnet 4.6 (Thinking)',
      label: 'Antigravity · Claude Sonnet 4.6 (Thinking)',
      provider: 'antigravity',
      vision: true,
      steer: true,
    });

    expect(models[2]).toMatchObject({
      name: 'GPT-OSS 120B (Medium)',
      label: 'Antigravity · GPT-OSS 120B (Medium)',
      provider: 'antigravity',
      vision: false,
      steer: true,
    });
  });

  it('listModels() filters blank lines from agy models output', async () => {
    const child = fakeChild();
    const adapter = new AntigravityAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write('\nGemini 3.5 Flash (High)\n\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const models = await adapter.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Gemini 3.5 Flash (High)');
  });

  it('listModels() strips "Error: Please Sign in" auth noise from agy stdout', async () => {
    // Mirrors the real failure mode: when agy is unauthenticated, `agy models`
    // emits an "Error: Please Sign in to view available models" line to stdout
    // which previously became a fake model row. The filter must strip it while
    // keeping the legitimate entries.
    const child = fakeChild();
    const adapter = new AntigravityAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(
            'Error: Please Sign in to view available models\n' +
            'Gemini 3.5 Flash (High)\n' +
            'Claude Sonnet 4.6 (Thinking)\n',
          );
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const models = await adapter.listModels();
    expect(models).toHaveLength(2);
    const names = models.map((m) => m.name);
    expect(names).toContain('Gemini 3.5 Flash (High)');
    expect(names).toContain('Claude Sonnet 4.6 (Thinking)');
    for (const m of models) {
      expect(m.name).not.toMatch(/sign[\s-]?in/i);
      expect(m.name).not.toMatch(/^error\b/i);
    }
  });

  it('listModels() splits "slug\\tdisplay" lines from agy models output', async () => {
    // agy 1.1.x changed `agy models` to emit "<slug>\t<display label>" per
    // line. The slug must land in `name` (it is what --model accepts) and the
    // display label must land in `label` (picker text). Passing the whole line
    // as `name` reproduces the original bug: agy rejects the contaminated id.
    const child = fakeChild();
    const adapter = new AntigravityAdapter({
      spawnFn: (_cmd, args) => {
        if (args[0] === 'models') {
          Promise.resolve().then(() => {
            child.stdout.write(
              'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)\n' +
              'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n' +
              'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n',
            );
            child.stdout.end();
            child.emit('close', 0);
          });
        }
        return child as never;
      },
    });

    const models = await adapter.listModels();

    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      name: 'gemini-3.6-flash-medium',
      label: 'Antigravity · Gemini 3.6 Flash (Medium)',
      provider: 'antigravity',
      vision: true,
      steer: true,
    });
    expect(models[1]).toMatchObject({
      name: 'claude-sonnet-4-6',
      label: 'Antigravity · Claude Sonnet 4.6 (Thinking)',
      provider: 'antigravity',
      vision: true,
      steer: true,
    });
    expect(models[2]).toMatchObject({
      name: 'gpt-oss-120b-medium',
      label: 'Antigravity · GPT-OSS 120B (Medium)',
      provider: 'antigravity',
      vision: false,
      steer: true,
    });
    // FW-7 D6: descriptors must NOT advertise contextWindow — the handoff
    // compaction path (sessionManager.getTargetContextWindow) reads listModels()
    // windows and must keep seeing none for agy. Windows stay adapter-local.
    for (const m of models) {
      expect(m.contextWindow).toBeUndefined();
    }
  });

  it('listModels() never stamps contextWindow, even for known models (FW-7 D6)', async () => {
    const child = fakeChild();
    const adapter = new AntigravityAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write('Gemini 3.5 Flash (High)\nUnknown Vendor Model\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });
    const models = await adapter.listModels();
    expect(models[0].contextWindow).toBeUndefined();
    expect(models[1].contextWindow).toBeUndefined();
  });

  it('listSessions() enumerates .db files in the conversations dir, newest first', async () => {
    const dir = mkdtempSync(pathNode.join(osNode.tmpdir(), 'tierwyn-agy-listsessions-'));
    try {
      // Older file (created first so earlier mtime).
      const oldId = '11111111-1111-1111-1111-111111111111';
      const oldPath = pathNode.join(dir, `${oldId}.db`);
      writeFileSync(oldPath, '');
      // Force a slightly older mtime so the sort can't be flaky.
      const oldTime = new Date(Date.now() - 60_000);
      fs_utimeSync(oldPath, oldTime, oldTime);

      // Newer file.
      const newId = '22222222-2222-2222-2222-222222222222';
      writeFileSync(pathNode.join(dir, `${newId}.db`), '');

      // Unrelated file (no .db extension) should be ignored.
      writeFileSync(pathNode.join(dir, 'README.txt'), '');

      const adapter = new AntigravityAdapter({ conversationsDir: dir });
      const sessions = await adapter.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe(newId);
      expect(sessions[1].id).toBe(oldId);
      expect(typeof sessions[0].createdAt).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listSessions() returns [] when the conversations dir does not exist', async () => {
    const adapter = new AntigravityAdapter({ conversationsDir: EMPTY_CONVERSATIONS_DIR });
    expect(await adapter.listSessions()).toEqual([]);
  });

  it('isNativeSessionAvailable() returns true when the .db file exists, false otherwise', async () => {
    const dir = mkdtempSync(pathNode.join(osNode.tmpdir(), 'tierwyn-agy-isavail-'));
    try {
      const id = '33333333-3333-3333-3333-333333333333';
      writeFileSync(pathNode.join(dir, `${id}.db`), '');

      const adapter = new AntigravityAdapter({ conversationsDir: dir });
      expect(await adapter.isNativeSessionAvailable(id)).toBe(true);
      expect(await adapter.isNativeSessionAvailable('missing-id-99999999-9999-9999-9999-999999999999')).toBe(false);
      expect(await adapter.isNativeSessionAvailable('')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sendPrompt captures nativeSessionId from stderr "Created conversation <uuid>" and re-emits running', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const statuses: string[] = [];
    adapter.streamEvents().on('event', (e) => {
      if (e.type === 'status') statuses.push(e.payload.status);
    });

    const done = adapter.sendPrompt('hi');
    await spawned;
    // agy emits the conversation id line on stderr at startup.
    child.stderr.write('Print mode: starting (promptLength=2)\n');
    child.stderr.write('Created conversation 44444444-4444-4444-4444-444444444444\n');
    child.stderr.end();

    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(adapter.nativeSessionId).toBe('44444444-4444-4444-4444-444444444444');
    // Expect at least two running events: initial emit + re-emit after capture.
    const runningCount = statuses.filter((s) => s === 'running').length;
    expect(runningCount).toBeGreaterThanOrEqual(2);
  });

  it('sendPrompt falls back to most-recent .db file when stderr has no conversation id', async () => {
    const dir = mkdtempSync(pathNode.join(osNode.tmpdir(), 'tierwyn-agy-fallback-'));
    try {
      // Pre-existing older file (must NOT be picked).
      const oldId = '55555555-5555-5555-5555-555555555555';
      const oldPath = pathNode.join(dir, `${oldId}.db`);
      writeFileSync(oldPath, '');
      const oldTime = new Date(Date.now() - 120_000);
      fs_utimeSync(oldPath, oldTime, oldTime);

      const child = fakeChild();
      let onSpawn: (() => void) | null = null;
      const spawned = new Promise<void>((resolve) => {
        onSpawn = resolve;
      });
      const adapter = new AntigravityAdapter({
        conversationsDir: dir,
        probeRateLimits: async () => ({}),
        spawnFn: () => {
          onSpawn?.();
          return child as never;
        }
      });
      await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

      // Do NOT emit anything on stderr — fallback path must run.
      const done = adapter.sendPrompt('hi');
      await spawned;

      // Create a NEW conversation file mid-flight, with mtime after spawn.
      const newId = '66666666-6666-6666-6666-666666666666';
      writeFileSync(pathNode.join(dir, `${newId}.db`), '');

      child.stderr.end();
      child.stdout.end();
      child.emit('close', 0);
      await done;

      expect(adapter.nativeSessionId).toBe(newId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sendPrompt preserves resume id and does not overwrite it from stderr capture', async () => {
    const { adapter, child, spawned } = setupAdapter();
    const resumeId = '77777777-7777-7777-7777-777777777777';
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '', nativeSessionId: resumeId });
    await adapter.loadSession(resumeId);

    adapter.streamEvents().on('event', () => {});
    const done = adapter.sendPrompt('continue');
    await spawned;
    // agy emits a new conversation id line for the resumed session — must NOT
    // overwrite the resume id (resume keeps the same conversation id; agy
    // may or may not echo it but we must not switch mid-stream).
    child.stderr.write('Created conversation 88888888-8888-8888-8888-888888888888\n');
    child.stderr.end();
    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(adapter.nativeSessionId).toBe(resumeId);
  });

  it('loadSession() stores the id for resumption', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];

    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        Promise.resolve().then(() => {
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });
    await adapter.loadSession('conv-abc-123');

    adapter.streamEvents().on('event', () => {});
    await adapter.sendPrompt('resume me');

    expect(capturedArgs).toContain('--conversation');
    expect(capturedArgs).toContain('conv-abc-123');
  });

  it('assigns monotonically increasing seq numbers to emitted events', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 'seq-test', conversationId: 'c', cwd: '/tmp', model: '' });

    const seqs: number[] = [];
    adapter.streamEvents().on('event', (e) => seqs.push(e.seq));

    const done = adapter.sendPrompt('go');
    await spawned;
    child.stdout.write('line one\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('appends @<tempPath> for image, PDF, and audio attachments on sendPrompt', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'att1', conversationId: 'c', cwd: '/tmp', model: 'Claude Sonnet 4.6' });
    const pngPath = '/tmp/tierwyn-attachments/shot.png';
    const pdfPath = '/tmp/tierwyn-attachments/brief.pdf';
    const mp3Path = '/tmp/tierwyn-attachments/note.mp3';
    const done = adapter.sendPrompt('describe these', [
      { mediaType: 'image/png', base64: 'iVBOR', tempPath: pngPath },
      { mediaType: 'application/pdf', base64: 'JVBERi0', tempPath: pdfPath },
      { mediaType: 'audio/mpeg', base64: '//uQx', tempPath: mp3Path },
    ]);
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    const written = drainStdin(child);
    expect(capturedArgs).toContain('--print=');
    expect(capturedArgs).not.toContain('--print');
    expect(written).toContain(`@${pngPath}`);
    expect(written).toContain(`@${pdfPath}`);
    expect(written).toContain(`@${mp3Path}`);
    expect(JSON.parse(written.trim()).event).toBe('user');
  });

  it('appends @<tempPath> for listed audio MIME types', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'att2', conversationId: 'c', cwd: '/tmp', model: 'Claude Sonnet 4.6' });
    const wavPath = '/tmp/tierwyn-attachments/clip.wav';
    const done = adapter.sendPrompt('transcribe', [
      { mediaType: 'audio/wav', base64: 'UklGR', tempPath: wavPath },
    ]);
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    const written = drainStdin(child);
    expect(capturedArgs).toContain('--print=');
    expect(written).toContain(`@${wavPath}`);
  });

  it('leaves prompt text unchanged when attachments have no tempPath', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'att3', conversationId: 'c', cwd: '/tmp', model: 'Claude Sonnet 4.6' });
    const done = adapter.sendPrompt('no files', [
      { mediaType: 'application/pdf', base64: 'JVBERi0' },
    ]);
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    const written = drainStdin(child);
    expect(capturedArgs).toContain('--print=');
    expect(JSON.parse(written.trim()).message.content).toBe('no files');
  });

  it('passes --effort high for a plain model when effort is specified', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'e1', conversationId: 'c', cwd: '/tmp', model: 'Claude Sonnet 4.6' });
    const done = adapter.sendPrompt('hi', [], undefined, 'high');
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs).toContain('--effort');
    expect(capturedArgs[capturedArgs.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort when sendPrompt receives max (clamped out for agy)', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'e2', conversationId: 'c', cwd: '/tmp', model: 'm' });
    const done = adapter.sendPrompt('hi', [], undefined, 'max');
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs).not.toContain('--effort');
  });

  it('omits --effort when model name already bakes in the level (legacy display)', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    // This is the exact combo that agy 1.1.9 rejects with "invalid model selection".
    await adapter.start({
      sessionId: 'e3',
      conversationId: 'c',
      cwd: '/tmp',
      model: 'Gemini 3.5 Flash (Medium)',
    });
    const done = adapter.sendPrompt('hi', [], undefined, 'medium');
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).toContain('Gemini 3.5 Flash (Medium)');
    expect(capturedArgs).not.toContain('--effort');
  });

  it('omits --effort when model slug ends with -medium/-high/-low', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({
      sessionId: 'e4',
      conversationId: 'c',
      cwd: '/tmp',
      model: 'gemini-3.5-flash-medium',
    });
    const done = adapter.sendPrompt('hi', [], undefined, 'medium');
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs).not.toContain('--effort');
  });

  it('omits --effort for Claude Thinking models (agy rejects the flag outright)', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    // Repro: invalid model selection (--model "claude-opus-4-6-thinking"
    // --effort "medium"): --effort is not supported for this model.
    await adapter.start({
      sessionId: 'e4b',
      conversationId: 'c',
      cwd: '/tmp',
      model: 'claude-opus-4-6-thinking',
    });
    const done = adapter.sendPrompt('hi', [], undefined, 'high');
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs[capturedArgs.indexOf('--model') + 1]).toBe('claude-opus-4-6-thinking');
    expect(capturedArgs).not.toContain('--effort');
  });

  it('maps prompt options into CLI flags in correct slot order', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({
      sessionId: 'opt1',
      conversationId: 'c',
      cwd: '/tmp',
      model: 'gemini-pro',
      nativeSessionId: 'prev-conv-uuid',
    });
    const schema = JSON.stringify({ type: 'object' });
    const done = adapter.sendPrompt('hi', [], undefined, 'high', {
      mode: 'plan',
      sandbox: true,
      disableSlashCommands: true,
      jsonSchema: schema,
    });
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(capturedArgs).toContain('--effort');
    expect(capturedArgs).toContain('--mode');
    expect(capturedArgs[capturedArgs.indexOf('--mode') + 1]).toBe('plan');
    expect(capturedArgs).toContain('--sandbox');
    expect(capturedArgs).toContain('--disable-slash-commands');
    expect(capturedArgs).toContain('--json-schema');
    expect(capturedArgs[capturedArgs.indexOf('--json-schema') + 1]).toBe(schema);

    // Slot ordering check:
    // model -> effort -> options -> conversation -> --print=
    const modelIdx = capturedArgs.indexOf('--model');
    const effortIdx = capturedArgs.indexOf('--effort');
    const modeIdx = capturedArgs.indexOf('--mode');
    const sandboxIdx = capturedArgs.indexOf('--sandbox');
    const slashIdx = capturedArgs.indexOf('--disable-slash-commands');
    const schemaIdx = capturedArgs.indexOf('--json-schema');
    const convIdx = capturedArgs.indexOf('--conversation');
    const printIdx = capturedArgs.indexOf('--print=');

    expect(modelIdx).toBeLessThan(effortIdx);
    expect(effortIdx).toBeLessThan(modeIdx);
    expect(modeIdx).toBeLessThan(sandboxIdx);
    expect(sandboxIdx).toBeLessThan(slashIdx);
    expect(slashIdx).toBeLessThan(schemaIdx);
    expect(schemaIdx).toBeLessThan(convIdx);
    expect(convIdx).toBeLessThan(printIdx);
    expect(printIdx).toBe(capturedArgs.length - 1);
  });

  it('omits --mode when mode is default or unrecognized', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'opt2', conversationId: 'c', cwd: '/tmp', model: 'm' });
    const done = adapter.sendPrompt('hi', [], undefined, undefined, { mode: 'default' as any });
    await spawned;
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs).not.toContain('--mode');
  });

  it('produces byte-identical argv when options are omitted vs empty object', async () => {
    let argsWithout: string[] = [];
    let argsWithEmpty: string[] = [];

    const spawn1 = fakeChild();
    let onSpawn1: (() => void) | null = null;
    const s1 = new Promise<void>((r) => { onSpawn1 = r; });
    const a1 = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => { argsWithout = args; onSpawn1?.(); return spawn1 as never; },
    });
    await a1.start({ sessionId: 'cmp1', conversationId: 'c', cwd: '/tmp', model: 'm' });
    const d1 = a1.sendPrompt('hi');
    await s1;
    spawn1.stdout.end();
    spawn1.emit('close', 0);
    await d1;

    const spawn2 = fakeChild();
    let onSpawn2: (() => void) | null = null;
    const s2 = new Promise<void>((r) => { onSpawn2 = r; });
    const a2 = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => { argsWithEmpty = args; onSpawn2?.(); return spawn2 as never; },
    });
    await a2.start({ sessionId: 'cmp2', conversationId: 'c', cwd: '/tmp', model: 'm' });
    const d2 = a2.sendPrompt('hi', [], undefined, undefined, {});
    await s2;
    spawn2.stdout.end();
    spawn2.emit('close', 0);
    await d2;

    expect(argsWithEmpty).toEqual(argsWithout);
  });

  it('emits error event on live child follow-up when prompt options are present', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 'live-opt', conversationId: 'c', cwd: '/tmp', model: 'm' });
    const firstTurn = adapter.sendPrompt('first');
    await spawned;
    // Emit result to finish first turn
    child.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }) + '\n');
    await firstTurn;

    const events: any[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    // Follow-up on the live child with options
    const secondTurn = adapter.sendPrompt('second', [], undefined, undefined, { sandbox: true });
    expect(events.some((e) => e.type === 'error' && e.payload?.message?.includes('Prompt options could not be applied'))).toBe(true);

    // Complete the second turn
    child.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'second ok' } }) + '\n');
    await secondTurn;
    child.stdout.end();
    child.emit('close', 0);
  });

  it('runCommand delegates to sendPrompt with options passed through to argv', async () => {
    let capturedArgs: string[] = [];
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'cmd-opt', conversationId: 'c', cwd: '/tmp', model: 'gemini-3.8-flash' });
    const done = adapter.runCommand('test', 'my args', { sandbox: true });
    await spawned;
    child.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(capturedArgs).toContain('--sandbox');
  });

  it('surfaces fatal stderr Error: lines as error events (no silent empty turn)', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({
      sessionId: 'e5',
      conversationId: 'c',
      cwd: '/tmp',
      model: 'Gemini 3.5 Flash (Medium)',
    });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    const done = adapter.sendPrompt('hi', [], undefined, 'medium');
    await spawned;
    child.stderr.write(
      'Error: invalid model selection (--model "Gemini 3.5 Flash (Medium)" --effort "medium"): --effort is not supported for model "Gemini 3.5 Flash (Medium)"\n',
    );
    child.stdout.end();
    child.emit('close', 1);
    await done;
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0].payload as { message: string }).message).toMatch(/invalid model selection/i);
    expect(events.some((e) => e.type === 'status' && (e.payload as { status: string }).status === 'error')).toBe(true);
  });

  it('does not end stdin at spawn and writes the {event:user} envelope', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });
    const done = adapter.sendPrompt('PING');
    await spawned;
    expect(child.stdin.writableEnded).toBe(false);
    const written = drainStdin(child);
    expect(written).toBe('{"event":"user","message":{"content":"PING"}}\n');
    child.stdout.write(successResult({ response: 'PING' }));
    await done;
    expect(child.stdin.writableEnded).toBe(false);
    child.emit('close', 0);
  });

  it('emits status:done on result and does not emit end until child close', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });

    const done = adapter.sendPrompt('PING');
    await spawned;
    child.stdout.write(successResult({
      response: 'PING',
      usage: { input_tokens: 3, output_tokens: 1, cache_read_tokens: 0 },
    }));
    await done;

    expect(ended).toBe(false);
    const lastStatus = events.filter((e) => e.type === 'status').at(-1);
    expect(lastStatus?.type === 'status' && lastStatus.payload.status).toBe('done');
    expect(lastStatus?.type === 'status' && lastStatus.payload.inputTokens).toBe(3);

    const endedP = ended
      ? Promise.resolve()
      : new Promise<void>((resolve) => adapter.streamEvents().once('end', () => resolve()));
    child.emit('close', 0);
    await endedP;
    expect(ended).toBe(true);
  });

  it('second sendPrompt writes another envelope on the same child without spawning', async () => {
    const child = fakeChild();
    let spawnCount = 0;
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => {
        spawnCount += 1;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const first = adapter.sendPrompt('PING');
    await spawned;
    child.stdout.write(successResult({ response: 'PING', num_turns: 1 }));
    await first;
    expect(spawnCount).toBe(1);
    drainStdin(child);

    const second = adapter.sendPrompt('PONG');
    const written = drainStdin(child);
    expect(written).toBe('{"event":"user","message":{"content":"PONG"}}\n');
    expect(spawnCount).toBe(1);
    child.stdout.write(successResult({ response: 'PONG', num_turns: 2 }));
    await second;
    expect(spawnCount).toBe(1);
    child.emit('close', 0);
  });

  it('steer loop writes a follow-up envelope after result, not at first stdin write', async () => {
    const child = fakeChild();
    let spawnCount = 0;
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    const queued: Array<{ text: string } | null> = [{ text: 'PONG' }];
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => {
        spawnCount += 1;
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({
      sessionId: 's',
      conversationId: 'c',
      cwd: '/tmp',
      model: '',
      getNextSteer: async () => queued.shift() ?? null,
    });

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });

    const first = adapter.sendPrompt('PING');
    await spawned;
    expect(drainStdin(child)).toContain('PING');
    expect(spawnCount).toBe(1);

    child.stdout.write(successResult({ response: 'PING', num_turns: 1 }));
    await first;
    expect(ended).toBe(false);

    await new Promise((r) => setTimeout(r, 20));
    const follow = drainStdin(child);
    expect(follow).toContain('PONG');
    expect(spawnCount).toBe(1);

    child.stdout.write(successResult({ response: 'PONG', num_turns: 2 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(ended).toBe(false);
    const runningAfterSteer = events.filter(
      (e) => e.type === 'status' && e.payload.status === 'running',
    );
    expect(runningAfterSteer.length).toBeGreaterThanOrEqual(2);
    child.emit('close', 0);
  });

  it('stop() closes stdin when idle and SIGTERMs mid-turn', async () => {
    const idleChild = fakeChild();
    idleChild.stdin.on('finish', () => idleChild.emit('close', 0));
    let idleKilled: string | undefined;
    idleChild.kill = (sig) => { idleKilled = sig ?? 'SIGTERM'; idleChild.emit('close', 0); };
    let idleSpawned: () => void = () => {};
    const idleReady = new Promise<void>((resolve) => { idleSpawned = resolve; });
    const idleAdapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => { idleSpawned(); return idleChild as never; },
    });
    await idleAdapter.start({ sessionId: 'idle', conversationId: 'c', cwd: '/tmp', model: '' });
    const idleTurn = idleAdapter.sendPrompt('hi');
    await idleReady;
    idleChild.stdout.write(successResult());
    await idleTurn;
    await idleAdapter.stop();
    expect(idleChild.stdin.writableEnded).toBe(true);
    expect(idleKilled).toBeUndefined();

    const hotChild = fakeChild();
    let hotKilled: string | undefined;
    hotChild.kill = (sig) => { hotKilled = sig ?? 'SIGTERM'; hotChild.emit('close', 1); };
    let hotSpawned: () => void = () => {};
    const hotReady = new Promise<void>((resolve) => { hotSpawned = resolve; });
    const hotAdapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => { hotSpawned(); return hotChild as never; },
    });
    await hotAdapter.start({ sessionId: 'hot', conversationId: 'c', cwd: '/tmp', model: '' });
    const hotTurn = hotAdapter.sendPrompt('hi');
    await hotReady;
    await hotAdapter.stop();
    await hotTurn.catch(() => {});
    expect(hotKilled).toBe('SIGTERM');
  });

  it('stop() mid-turn escalates SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    (child as { exitCode: number | null }).exitCode = null;
    (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
    const signals: string[] = [];
    child.kill = (sig) => { signals.push(sig ?? 'SIGTERM'); };
    let hotSpawned: () => void = () => {};
    const hotReady = new Promise<void>((resolve) => { hotSpawned = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => { hotSpawned(); return child as never; },
    });
    await adapter.start({ sessionId: 'hot-esc', conversationId: 'c', cwd: '/tmp', model: '' });
    const hotTurn = adapter.sendPrompt('hi');
    await hotReady;
    const { KILL_ESCALATION_MS } = await import('../escalateKill.js');
    const stopP = adapter.stop();
    await vi.advanceTimersByTimeAsync(KILL_ESCALATION_MS);
    await stopP;
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
    vi.useRealTimers();
    await hotTurn.catch(() => {});
  });

  it('stop() sends no SIGKILL when the child already exited', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    (child as { exitCode: number | null }).exitCode = null;
    (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
    const signals: string[] = [];
    child.kill = (sig) => {
      signals.push(sig ?? 'SIGTERM');
      (child as { exitCode: number | null }).exitCode = 1;
      child.emit('exit', 1, null);
      child.emit('close', 1);
    };
    let hotSpawned: () => void = () => {};
    const hotReady = new Promise<void>((resolve) => { hotSpawned = resolve; });
    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => { hotSpawned(); return child as never; },
    });
    await adapter.start({ sessionId: 'hot-exit', conversationId: 'c', cwd: '/tmp', model: '' });
    const hotTurn = adapter.sendPrompt('hi');
    await hotReady;
    const { KILL_ESCALATION_MS } = await import('../escalateKill.js');
    const stopP = adapter.stop();
    await vi.advanceTimersByTimeAsync(KILL_ESCALATION_MS);
    await stopP;
    expect(signals).toEqual(['SIGTERM']);
    vi.useRealTimers();
    await hotTurn.catch(() => {});
  });

  it('exposes steer() so parked Queue items are injectable', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });
    const first = adapter.sendPrompt('PING');
    await spawned;
    child.stdout.write(successResult());
    await first;
    drainStdin(child);
    expect(typeof adapter.steer).toBe('function');
    await adapter.steer('PONG');
    expect(drainStdin(child)).toContain('PONG');
    child.emit('close', 0);
  });

  it('stop() suppresses fatal stderr lines, stdout errors, and nonzero exit codes during child teardown', async () => {
    const child = fakeChild();
    let onSpawn: (() => void) | null = null;
    const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
    child.kill = () => {
      // Child dying writes fatal stderr, stdout error frame, and exits with code 143 (SIGTERM)
      child.stderr.write('error: interrupted\n');
      child.stderr.write('Error: API error (attempt 8): RESOURCE_EXHAUSTED\n');
      child.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'context canceled' } }) + '\n');
      child.emit('close', 143);
    };

    const adapter = new AntigravityAdapter({
      conversationsDir: EMPTY_CONVERSATIONS_DIR,
      probeRateLimits: async () => ({}),
      spawnFn: () => {
        onSpawn?.();
        return child as never;
      },
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const errors: string[] = [];
    const statuses: string[] = [];
    adapter.streamEvents().on('event', (e) => {
      if (e.type === 'error') errors.push(e.payload.message);
      if (e.type === 'status') statuses.push(e.payload.status);
    });

    const prompt = adapter.sendPrompt('hi');
    await spawned;
    await adapter.stop();
    await prompt.catch(() => {});

    expect(errors).toEqual([]);
    expect(statuses).not.toContain('error');
    expect(statuses).toContain('idle');
  });

  it('suppresses replayed result error when interrupt is observed on stderr', async () => {
    const { adapter, child, spawned } = setupAdapter();
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: '' });

    const errors: string[] = [];
    const statuses: string[] = [];
    adapter.streamEvents().on('event', (e) => {
      if (e.type === 'error') errors.push(e.payload.message);
      if (e.type === 'status') statuses.push(e.payload.status);
    });

    const prompt = adapter.sendPrompt('hi');
    await spawned;

    // Stderr sees interrupt line
    child.stderr.write('error: stream input cancelled: context canceled\n');
    // Followed by agy result frame carrying the replayed error
    child.stdout.write(JSON.stringify({
      event: 'result',
      result: {
        status: 'ERROR',
        error: 'API error (attempt 8): RESOURCE_EXHAUSTED (code 429): Individual quota reached.',
      },
    }) + '\n');
    await prompt;

    expect(errors).toEqual([]);
    expect(statuses).not.toContain('error');
    expect(statuses).toContain('done');
  });
});

describe('modelNameBakesEffort / detectAgyFatalStderr', () => {
  it('detects parenthetical and slug effort encodings', () => {
    expect(modelNameBakesEffort('Gemini 3.5 Flash (Medium)')).toBe(true);
    expect(modelNameBakesEffort('Gemini 3.5 Flash (High)')).toBe(true);
    expect(modelNameBakesEffort('gemini-3.5-flash-medium')).toBe(true);
    expect(modelNameBakesEffort('claude-sonnet-4-6')).toBe(false);
    expect(modelNameBakesEffort('claude-opus-4-6-thinking')).toBe(false);
  });

  it('detects fatal stderr shapes', () => {
    expect(detectAgyFatalStderr('Error: invalid model selection')).toMatch(/Error:/);
    expect(detectAgyFatalStderr('print mode: invalid model selection foo')).toMatch(/invalid model selection/i);
    expect(detectAgyFatalStderr('I0801 14:34 info only')).toBeNull();
  });

  it('detectAgyFatalStderr ignores benign interrupt lines', () => {
    expect(detectAgyFatalStderr('error: interrupted')).toBeNull();
    expect(detectAgyFatalStderr('Error: context canceled')).toBeNull();
    expect(detectAgyFatalStderr('Error: aborted by user')).toBeNull();
  });
});

describe('AntigravityAdapter permission block handling', () => {
  it('does not emit an error when assistant stream-json frames contain "awaiting approval"', async () => {
    const { adapter, child, spawned } = setupAdapter();
    const errors: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (ev: NormalisedEvent) => {
      if (ev.type === 'error') errors.push(ev);
    });

    await adapter.start({
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      cwd: '/tmp',
      model: 'gemini-3.8-flash-medium',
    });
    const prompt = adapter.sendPrompt('how many FW are proposed?');
    await spawned;

    const conv = 'db192107-47ee-4c72-9f68-dabcca03d531';
    child.stdout.write(JSON.stringify({
      event: 'init',
      conversation_id: conv,
      init: { cwd: '/tmp' },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: conv,
        step_index: 1,
        state: 'DONE',
        step_type: 'message',
        content: 'There is 1 proposed feature awaiting approval',
      },
    }) + '\n');
    child.stdout.write(JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS' },
    }) + '\n');
    await prompt;

    expect(errors).toEqual([]);
  });

  it('surfaces plain text approval prompts on stdout as an error', async () => {
    const { adapter, child, spawned } = setupAdapter();
    const errors: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (ev: NormalisedEvent) => {
      if (ev.type === 'error') errors.push(ev);
    });

    await adapter.start({
      sessionId: 'sess-2',
      conversationId: 'conv-2',
      cwd: '/tmp',
      model: 'gemini-3.8-flash-medium',
    });
    const prompt = adapter.sendPrompt('run something');
    await spawned;

    child.stdout.write('Error: tool "bash" requires approval (permission denied)\n');
    child.stdout.end();
    child.emit('close', 1);
    await prompt;

    expect(errors.some((e) => /needed approval/.test(e.payload.message as string))).toBe(true);
  });

  it('surfaces approval prompts on stderr as an error', async () => {
    const { adapter, child, spawned } = setupAdapter();
    const errors: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (ev: NormalisedEvent) => {
      if (ev.type === 'error') errors.push(ev);
    });

    await adapter.start({
      sessionId: 'sess-3',
      conversationId: 'conv-3',
      cwd: '/tmp',
      model: 'gemini-3.8-flash-medium',
    });
    const prompt = adapter.sendPrompt('run something');
    await spawned;

    child.stderr.write('tool "bash" requires approval\n');
    child.stdout.end();
    child.emit('close', 1);
    await prompt;

    expect(errors.some((e) => /needed approval/.test(e.payload.message as string))).toBe(true);
  });
});
