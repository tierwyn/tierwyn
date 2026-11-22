import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import type { NormalisedEvent } from '@tierwyn/shared';
import { DeepSeekAdapter, ensurePiAiProviderPatch, resolveDeepSeekReasoningEffort } from './index.js';
import { toDeepSeekMcpPatch } from '../../mcp/inject.js';

type Scripted = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => void;
};

function scriptedChild(opts: { holdPrompt?: boolean } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as Scripted;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = () => {};

  let promptAck: (() => void) | null = null;
  const promptWaiters: Array<(cmd: Record<string, unknown>) => void> = [];
  const queuedPrompts: Record<string, unknown>[] = [];

  function waitForPrompt(): Promise<Record<string, unknown>> {
    const queued = queuedPrompts.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((res) => { promptWaiters.push(res); });
  }

  stdin.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      let cmd: Record<string, unknown>;
      try { cmd = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (cmd.id === undefined || cmd.id === null) continue;
      if (cmd.method === 'initialize') {
        stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: cmd.id,
          result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } },
        }) + '\n');
      } else if (cmd.method === 'session/prompt') {
        const waiter = promptWaiters.shift();
        if (waiter) waiter(cmd);
        else queuedPrompts.push(cmd);
        const ack = () => {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: cmd.id, result: { messageId: 'm1' } }) + '\n');
        };
        if (opts.holdPrompt) promptAck = ack;
        else ack();
      } else {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: cmd.id, result: {} }) + '\n');
      }
    }
  });

  return { proc, promptPromise: waitForPrompt(), ackPrompt: () => promptAck?.(), waitForPrompt };
}

function emitNotification(stdout: PassThrough, method: string, params: Record<string, unknown>): void {
  stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function emitEvent(stdout: PassThrough, sessionId: string, event: Record<string, unknown>): void {
  emitNotification(stdout, 'session.event', { sessionId, event });
}

const CFG = {
  sessionId: 'sx',
  conversationId: 'c',
  cwd: '/tmp',
  model: 'deepseek-official/deepseek-chat',
};

async function boot(adapter: DeepSeekAdapter, child: Scripted): Promise<void> {
  await adapter.start(CFG);
  child.emit('spawn');
}

describe('DeepSeekAdapter', () => {
  it('resolves sendPrompt when turn/end arrives before the session/prompt ack', async () => {
    const { proc: child, promptPromise, ackPrompt } = scriptedChild({ holdPrompt: true });
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    ackPrompt();
    await done;
  });

  it('streams a full turn and emits done with usage', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await boot(adapter, child);

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/start', turn: 1 });
    emitEvent(child.stdout, 'sx', { type: 'assistant/chunk', chunk: { type: 'text-delta', index: 0, text: 'hi' } });
    emitEvent(child.stdout, 'sx', {
      type: 'assistant/message',
      message: { content: [{ type: 'text', text: 'hi' }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const statuses = events.filter((e) => e.type === 'status').map((e) => e.type === 'status' ? e.payload.status : '');
    expect(statuses[0]).toBe('running');
    expect(statuses[statuses.length - 1]).toBe('done');
    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'hi')).toBe(true);
    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last && last.type === 'status' && last.payload.inputTokens).toBe(10);
    expect(last && last.type === 'status' && last.payload.contextWindowPct).toBe(0);
    expect(ended).toBe(true);
  });

  it('emits the complete message text when a turn streams no text-delta chunks', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/start', turn: 1 });
    emitEvent(child.stdout, 'sx', {
      type: 'assistant/message',
      message: { content: [{ type: 'text', text: 'pong' }] },
      usage: { inputTokens: 10, outputTokens: 3 },
    });
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const messages = events.filter((e) => e.type === 'message')
      .map((e) => (e.type === 'message' ? e.payload : null));
    expect(messages).toEqual([{ chunk: 'pong', final: true }]);
  });

  it('re-arms content capture after a streamed step so an unstreamed later step still shows', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/start', turn: 1 });
    emitEvent(child.stdout, 'sx', { type: 'assistant/chunk', chunk: { type: 'text-delta', index: 0, text: 'hi' } });
    emitEvent(child.stdout, 'sx', {
      type: 'assistant/message',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    emitEvent(child.stdout, 'sx', {
      type: 'assistant/message',
      message: { content: [{ type: 'text', text: 'done now' }] },
    });
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const chunks = events.filter((e) => e.type === 'message')
      .map((e) => (e.type === 'message' ? e.payload.chunk : ''));
    expect(chunks).toEqual(['hi', '', 'done now']);
  });

  it('computes contextWindowPct and surfaces getLiveContextWindowUsage', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'c',
      cwd: '/tmp',
      model: 'z.ai/GLM-5.3',
    });
    child.emit('spawn');

    expect(adapter.getLiveContextWindowUsage()).toEqual({});

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/start', turn: 1 });
    emitEvent(child.stdout, 'sx', {
      type: 'assistant/message',
      message: { content: [{ type: 'text', text: 'hi' }] },
      usage: { inputTokens: 250_000, outputTokens: 1000, cacheReadTokens: 50_000 },
    });

    // Mid-turn occupancy: 300,000 / 1,000,000 = 30%
    expect(adapter.getLiveContextWindowUsage()).toEqual({
      contextWindowPct: 30,
      contextWindowSize: 1_000_000,
    });

    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last && last.type === 'status' && last.payload.contextWindowPct).toBe(30);
  });

  it('maps live SessionEvent envelopes (data.*) into named tools and prose', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } });
    emitEvent(child.stdout, 'sx', {
      type: 'assistant/chunk', seq: 2, time: 1,
      data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
    });
    emitEvent(child.stdout, 'sx', {
      type: 'tool/call', seq: 3, time: 1,
      data: { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
    });
    emitEvent(child.stdout, 'sx', {
      type: 'tool/result', seq: 4, time: 1,
      data: {
        turn: 1, step: 0,
        message: {
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'tool', callId: 'c1' },
        },
      },
    });
    emitEvent(child.stdout, 'sx', { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: 'completed' } });
    await done;

    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'hi')).toBe(true);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call && call.type === 'tool_call' && call.payload).toMatchObject({
      toolUseId: 'c1', name: 'bash', input: { cmd: 'ls' },
    });
    const result = events.find((e) => e.type === 'tool_result');
    expect(result && result.type === 'tool_result' && result.payload).toMatchObject({
      toolUseId: 'c1', content: 'ok',
    });
  });

  it('sends initialize before the first prompt, carrying cwd and model', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const writes: string[] = [];
    child.stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const cmds = writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const initIdx = cmds.findIndex((c) => c.method === 'initialize');
    const promptIdx = cmds.findIndex((c) => c.method === 'session/prompt');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThan(initIdx);
    expect(cmds[initIdx].params).toMatchObject({ cwd: '/tmp', model: 'deepseek-chat', provider: 'deepseek-official' });
  });

  it('maps catalogue z.ai/GLM-* ids onto dsh pi-ai provider zai and lowercase models', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const writes: string[] = [];
    child.stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await adapter.start({ ...CFG, model: 'z.ai/GLM-5.3-Flash' });
    child.emit('spawn');

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const cmds = writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const init = cmds.find((c) => c.method === 'initialize');
    expect(init?.params).toMatchObject({ cwd: '/tmp', provider: 'zai', model: 'glm-5.3-flash' });
  });

  it('terminates the turn on session.status idle when turn/end is absent', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitNotification(child.stdout, 'session.status', { sessionId: 'sx', status: 'idle' });
    await done;
  });

  it('ignores session.event frames for a foreign sessionId', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'other-session', { type: 'turn/start', turn: 1 });
    emitEvent(child.stdout, 'other-session', { type: 'assistant/chunk', chunk: { type: 'text-delta', index: 0, text: 'nope' } });
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    expect(events.filter((e) => e.type === 'message')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'status' && e.payload.status === 'running')).toHaveLength(0);
  });

  it('does not hang when the child exits mid-turn', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    let ended = false;
    adapter.streamEvents().on('end', () => { ended = true; });
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    child.emit('close', 1);
    await done;
    expect(ended).toBe(true);
  });

  it('suppresses terminal status:done when an error partial fires during the turn', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await boot(adapter, child);

    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'error', message: 'boom' });
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const statuses = events.filter((e) => e.type === 'status').map((e) => e.type === 'status' ? e.payload.status : '');
    expect(statuses).toContain('error');
    expect(statuses[statuses.length - 1]).not.toBe('done');
  });

  it('stop() sends shutdown and emits idle', async () => {
    const { proc: child } = scriptedChild();
    const writes: string[] = [];
    child.stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const statuses: string[] = [];
    adapter.streamEvents().on('event', (e) => { if (e.type === 'status') statuses.push(e.payload.status); });
    let ended = false;
    adapter.streamEvents().on('end', () => { ended = true; });
    await boot(adapter, child);
    await adapter.stop();
    expect(writes.join('')).toContain('"method":"shutdown"');
    expect(statuses).toContain('idle');
    expect(ended).toBe(true);
  });

  it('sendPrompt before start() rejects with the guard message', async () => {
    const adapter = new DeepSeekAdapter({ spawnFn: () => scriptedChild().proc as never });
    await expect(adapter.sendPrompt('hello')).rejects.toThrow(/before start\(\)/);
  });

  it('forwards base64 attachments as image content blocks', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await boot(adapter, child);

    const done = adapter.sendPrompt('see this', [{ mediaType: 'image/png', base64: 'abc123' }]);
    const prompt = await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const blocks = (prompt.params as { contentBlocks: unknown[] }).contentBlocks;
    expect(blocks[1]).toEqual({ type: 'image', data: 'abc123', mimeType: 'image/png' });
  });

  it('does not settle turn 2 on stale _turnEnded after turn 1 receives both turn/end and idle', async () => {
    const { proc: child, promptPromise, ackPrompt, waitForPrompt } = scriptedChild({ holdPrompt: true });
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await boot(adapter, child);

    const turn1 = adapter.sendPrompt('first');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    emitNotification(child.stdout, 'session.status', { sessionId: 'sx', status: 'idle' });
    ackPrompt();
    await turn1;

    let turn2Settled = false;
    const turn2 = adapter.sendPrompt('second').then(() => { turn2Settled = true; });
    await waitForPrompt();
    ackPrompt();

    const premature = await Promise.race([
      turn2.then(() => 'settled' as const),
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 50)),
    ]);
    expect(premature).toBe('waiting');
    expect(turn2Settled).toBe(false);
    const doneBeforeTurn2End = events.filter((e) => e.type === 'status' && e.payload.status === 'done');
    expect(doneBeforeTurn2End).toHaveLength(1);

    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 2 });
    await turn2;
    expect(turn2Settled).toBe(true);
    const doneAfterTurn2 = events.filter((e) => e.type === 'status' && e.payload.status === 'done');
    expect(doneAfterTurn2).toHaveLength(2);
  });
});

describe('DeepSeekAdapter.isNativeSessionAvailable & deleteNativeSession', () => {
  it('is true while dsh subprocess is open OR when persisted session log exists on disk, and deleteNativeSession removes it', async () => {
    const tmpDsh = join(tmpdir(), `dsh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const sessDir = join(tmpDsh, 'sessions', '--tmp--', 'persisted-sid');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, 'session.v4.jsonl.zstd'), 'dummy');

    try {
      const { proc: child } = scriptedChild();
      const adapter = new DeepSeekAdapter({ spawnFn: () => child as never, dshHome: tmpDsh });
      expect(await adapter.isNativeSessionAvailable('unknown-sid')).toBe(false);
      expect(await adapter.isNativeSessionAvailable('persisted-sid')).toBe(true);

      await adapter.start(CFG);
      expect(await adapter.isNativeSessionAvailable('unknown-sid')).toBe(true);
      await adapter.stop();
      expect(await adapter.isNativeSessionAvailable('unknown-sid')).toBe(false);
      expect(await adapter.isNativeSessionAvailable('persisted-sid')).toBe(true);

      await adapter.deleteNativeSession('persisted-sid');
      expect(existsSync(sessDir)).toBe(false);
      expect(await adapter.isNativeSessionAvailable('persisted-sid')).toBe(false);
    } finally {
      rmSync(tmpDsh, { recursive: true, force: true });
    }
  });

  it('sends session/resume before session/prompt when started with nativeSessionId', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const writes: string[] = [];
    child.stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await adapter.start({ ...CFG, nativeSessionId: 'resumed-sid' });
    child.emit('spawn');

    const done = adapter.sendPrompt('continue');
    await promptPromise;
    emitEvent(child.stdout, 'resumed-sid', { type: 'turn/end', turn: 2 });
    await done;

    const cmds = writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const methods = cmds.map((c) => c.method);
    expect(methods).toEqual(['initialize', 'session/resume', 'session/prompt']);
    const resumeCmd = cmds.find((c) => c.method === 'session/resume');
    expect(resumeCmd?.params).toEqual({ sessionId: 'resumed-sid' });
  });
});

describe('DeepSeekAdapter hold-open follow-up', () => {
  it('does not emit end after the first turn when getNextSteer is set', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const getNextSteer = () => new Promise<{ text: string } | null>(() => { /* parked */ });
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await adapter.start({ ...CFG, getNextSteer });
    child.emit('spawn');

    let ended = false;
    adapter.streamEvents().on('end', () => { ended = true; });

    const first = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await first;
    expect(ended).toBe(false);

    await adapter.stop();
    expect(ended).toBe(true);
  });

  it('delivers consecutive prompts via getNextSteer and emits done for each', async () => {
    const { proc: child, promptPromise, waitForPrompt } = scriptedChild();
    let steerResolver: ((val: { text: string } | null) => void) | null = null;
    const getNextSteer = () => new Promise<{ text: string } | null>((res) => {
      steerResolver = res;
    });

    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await adapter.start({ ...CFG, getNextSteer });
    child.emit('spawn');

    const statuses: string[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => {
      if (e.type === 'status' && typeof e.payload.status === 'string') {
        statuses.push(e.payload.status);
      }
    });

    // Turn 1
    const first = adapter.sendPrompt('first prompt');
    const prompt1 = await promptPromise;
    expect((prompt1.params as any).contentBlocks).toEqual([{ type: 'text', text: 'first prompt' }]);
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await first;

    expect(statuses).toContain('done');
    statuses.length = 0;

    // Turn 2 via steer loop
    expect(steerResolver).not.toBeNull();
    const p2 = waitForPrompt();
    steerResolver!({ text: 'second prompt' });
    const prompt2 = await p2;
    expect((prompt2.params as any).contentBlocks).toEqual([{ type: 'text', text: 'second prompt' }]);
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 2 });

    // Wait a tick for turn 2 done to emit
    await new Promise((r) => setTimeout(r, 20));
    expect(statuses).toContain('done');

    await adapter.stop();
  });

  it('emits error and status:error when session/prompt request fails', async () => {
    const { proc: child, promptPromise } = scriptedChild({ holdPrompt: true });
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await adapter.start(CFG);
    child.emit('spawn');

    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));

    const promptRun = adapter.sendPrompt('fail prompt');
    await promptPromise;
    child.stderr.write('Error: fatal crash in dsh\n');
    child.emit('close', 1);

    await promptRun;
    expect(events.some((e) => e.type === 'error' && String(e.payload.message).includes('fatal crash in dsh'))).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(false);
  });
});

describe('DeepSeekAdapter commands', () => {
  it('listCommands scans skills directories without throwing', async () => {
    const adapter = new DeepSeekAdapter();
    const cmds = await adapter.listCommands();
    expect(Array.isArray(cmds)).toBe(true);
  });

  it('runCommand sends the formatted slash command to session/prompt', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await adapter.start(CFG);
    child.emit('spawn');

    const done = adapter.runCommand('export', '--json');
    const prompt = await promptPromise;
    expect(prompt.method).toBe('session/prompt');
    const params = prompt.params as Record<string, unknown>;
    expect(params.contentBlocks).toEqual([{ type: 'text', text: '/export --json' }]);
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;
  });

  it('forwards prompt options from runCommand to sendPrompt', async () => {
    const { proc: child } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    await adapter.start(CFG);
    child.emit('spawn');
    const send = vi.spyOn(adapter, 'sendPrompt').mockResolvedValue();
    await adapter.runCommand('export', undefined, { reasoningEffort: 'high' });
    expect(send).toHaveBeenCalledWith('/export', [], undefined, undefined, { reasoningEffort: 'high' });
  });
});

describe('resolveDeepSeekReasoningEffort', () => {
  it('returns low/high/max from options', () => {
    expect(resolveDeepSeekReasoningEffort({ reasoningEffort: 'low' })).toBe('low');
    expect(resolveDeepSeekReasoningEffort({ reasoningEffort: 'high' })).toBe('high');
    expect(resolveDeepSeekReasoningEffort({ reasoningEffort: 'max' })).toBe('max');
    expect(resolveDeepSeekReasoningEffort({ reasoningEffort: 'medium' })).toBeUndefined();
  });

  it('falls back when options omit or use default/invalid effort', () => {
    expect(resolveDeepSeekReasoningEffort(undefined, 'medium')).toBe('medium');
    expect(resolveDeepSeekReasoningEffort({}, 'low')).toBe('low');
    expect(resolveDeepSeekReasoningEffort({ reasoningEffort: 'default' }, 'high')).toBe('high');
    expect(resolveDeepSeekReasoningEffort({ reasoningEffort: 'xhigh' }, 'low')).toBe('low');
    expect(resolveDeepSeekReasoningEffort(null)).toBeUndefined();
  });
});

describe('DeepSeekAdapter prompt options', () => {
  it('respawns dsh and re-initializes when reasoningEffort differs from the live RPC', async () => {
    const children: ReturnType<typeof scriptedChild>[] = [];
    let resolveSecond: (c: ReturnType<typeof scriptedChild>) => void;
    const secondChild = new Promise<ReturnType<typeof scriptedChild>>((resolve) => {
      resolveSecond = resolve;
    });
    const adapter = new DeepSeekAdapter({
      spawnFn: () => {
        const child = scriptedChild();
        children.push(child);
        if (children.length === 2) resolveSecond(child);
        return child.proc as never;
      },
    });

    await adapter.start(CFG);
    children[0].proc.emit('spawn');

    const secondWrites: string[] = [];
    const done = adapter.sendPrompt('hello', [], undefined, undefined, { reasoningEffort: 'high' });
    const child2 = await secondChild;
    child2.proc.stdin.on('data', (d: Buffer) => secondWrites.push(d.toString()));
    child2.proc.emit('spawn');
    const prompt = await child2.promptPromise;
    emitEvent(child2.proc.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    expect(children).toHaveLength(2);
    expect(prompt.method).toBe('session/prompt');
    const cmds = secondWrites.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const init = cmds.find((c) => c.method === 'initialize');
    expect(init?.params).toMatchObject({
      cwd: '/tmp',
      model: 'deepseek-chat',
      provider: 'deepseek-official',
      reasoningEffort: 'high',
    });
  });

  it('does not respawn when sendPrompt has no options', async () => {
    let spawnCount = 0;
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({
      spawnFn: () => {
        spawnCount++;
        return child as never;
      },
    });
    await boot(adapter, child);
    const done = adapter.sendPrompt('hello');
    await promptPromise;
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;
    expect(spawnCount).toBe(1);
  });

  it('kills dsh and ends the stream when initialize is rejected, so the node reclaims the slot', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as Scripted & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    let killed = false;
    child.kill = () => {
      killed = true;
      child.emit('exit', null);
    };
    stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        let cmd: Record<string, unknown>;
        try { cmd = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (cmd.method === 'initialize') {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: cmd.id,
            error: { code: -32603, message: 'no adapter registered for provider "zai"' },
          }) + '\n');
        }
      }
    });

    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await boot(adapter, child);

    await expect(adapter.sendPrompt('hello')).rejects.toThrow(/no adapter registered/);
    await vi.waitFor(() => expect(ended).toBe(true));
    expect(killed).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
  });

  it('maps subagent.started and subagent.finished notifications to path-A helper events', async () => {
    const { proc: child, promptPromise } = scriptedChild();
    const adapter = new DeepSeekAdapter({ spawnFn: () => child as never });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));
    await boot(adapter, child);

    const done = adapter.sendPrompt('delegate this');
    await promptPromise;
    emitNotification(child.stdout, 'subagent.started', {
      parentSessionId: 'sx',
      childSessionId: 'sub-1',
    });
    // Foreign parentSessionId is ignored
    emitNotification(child.stdout, 'subagent.started', {
      parentSessionId: 'other-session',
      childSessionId: 'sub-foreign',
    });
    emitNotification(child.stdout, 'subagent.finished', {
      provider: 'local',
      agentId: 'sub-1',
      parentSessionId: 'sx',
      childSessionId: 'sub-1',
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'Subagent finished cleanly.' }],
    });
    emitNotification(child.stdout, 'subagent.started', {
      parentSessionId: 'sx',
      childSessionId: 'sub-2',
    });
    emitNotification(child.stdout, 'subagent.finished', {
      provider: 'local',
      agentId: 'sub-2',
      parentSessionId: 'sx',
      childSessionId: 'sub-2',
      status: 'error',
      stopReason: 'cancelled',
    });
    emitEvent(child.stdout, 'sx', { type: 'turn/end', turn: 1 });
    await done;

    const helpers = events.filter((e) => e.type === 'helper');
    expect(helpers).toHaveLength(4);
    expect(helpers[0].payload).toMatchObject({ taskId: 'sub-1', status: 'running', label: 'subagent' });
    expect(helpers[1].payload).toMatchObject({
      taskId: 'sub-1',
      status: 'completed',
      label: 'local',
      summary: 'Subagent finished cleanly.',
    });
    expect(helpers[1].payload.startedAt).toBe(helpers[0].payload.startedAt);
    expect(helpers[2].payload).toMatchObject({ taskId: 'sub-2', status: 'running' });
    expect(helpers[3].payload).toMatchObject({ taskId: 'sub-2', status: 'stopped', label: 'local' });
  });

  it('auto-generates a --patch file for non-deepseek-official pi-ai providers unless user patch defines it', () => {
    const tmp = join(tmpdir(), `dsh-patch-test-${Date.now()}`);
    try {
      expect(ensurePiAiProviderPatch(tmp, 'deepseek-official')).toBeNull();
      expect(ensurePiAiProviderPatch(tmp, undefined)).toBeNull();
      expect(ensurePiAiProviderPatch(tmp, '../bad')).toBeNull();

      const patchPath = ensurePiAiProviderPatch(tmp, 'zai');
      expect(patchPath).toBe(join(tmp, '.tierwyn-patches', 'pi-ai-zai.yml'));
      expect(existsSync(patchPath!)).toBe(true);

      // If user cordis.patch.yml already configures zai, do not generate a patch
      const sdkDir = join(tmp, 'profiles', 'sdk');
      mkdirSync(sdkDir, { recursive: true });
      writeFileSync(join(sdkDir, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      zai:\n        baseURL: https://custom.example\n');
      expect(ensurePiAiProviderPatch(tmp, 'zai')).toBeNull();
      // Other providers still get auto-patched
      expect(ensurePiAiProviderPatch(tmp, 'openrouter')).toBe(join(tmp, '.tierwyn-patches', 'pi-ai-openrouter.yml'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('builds a dsh-mcp-client --patch YAML for stdio and http servers with secret env indirection', () => {
    const { yaml, env } = toDeepSeekMcpPatch([
      {
        id: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_secret123', MODE: 'ro' },
        secretEnvKeys: ['GITHUB_TOKEN'],
        headers: {},
        secretHeaderKeys: [],
      },
      {
        id: 'docs',
        transport: 'http',
        args: [],
        url: 'https://mcp.example.com/mcp',
        env: {},
        secretEnvKeys: [],
        headers: { Authorization: 'Bearer tok_999', 'X-App': 'tierwyn' },
        secretHeaderKeys: ['Authorization'],
      },
      {
        id: 'legacy-sse',
        transport: 'sse',
        args: [],
        url: 'https://sse.example.com',
        env: {},
        secretEnvKeys: [],
        headers: {},
        secretHeaderKeys: [],
      },
    ]);

    expect(yaml).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(yaml).toContain('transport: stdio');
    expect(yaml).toContain('transport: streamable-http');
    expect(yaml).not.toContain('ghp_secret123');
    expect(yaml).not.toContain('tok_999');
    expect(yaml).not.toContain('legacy-sse');
    expect(yaml).toContain('!!js process.env.TIERWYN_MCPV_0');
    expect(yaml).toContain('!!js process.env.TIERWYN_MCPV_1');
    expect(env).toEqual({
      TIERWYN_MCPV_0: 'ghp_secret123',
      TIERWYN_MCPV_1: 'Bearer tok_999',
    });
  });
});
