import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NormalisedEvent } from '@tierwyn/shared';
import { PiAdapter, appendPiPromptOptionArgs } from './index.js';

function scriptedChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as never as {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void; on: (...a: never[]) => void; emit: (...a: never[]) => boolean;
  };
  (proc as unknown as EventEmitter & { stdin: PassThrough }).stdin = stdin;
  (proc as unknown as EventEmitter & { stdout: PassThrough }).stdout = stdout;
  (proc as unknown as EventEmitter & { stderr: PassThrough }).stderr = stderr;
  (proc as { kill: () => void }).kill = () => {};
  stdin.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      const cmd = JSON.parse(line);
      if (!cmd.id) continue;
      if (cmd.type === 'get_state') {
        stdout.write(JSON.stringify({ type: 'response', id: cmd.id, command: 'get_state', success: true, data: { sessionId: 's1', sessionFile: '/sess/s1.jsonl' } }) + '\n');
      } else if (cmd.type === 'get_session_stats') {
        stdout.write(JSON.stringify({ type: 'response', id: cmd.id, command: 'get_session_stats', success: true, data: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01, contextUsage: { percent: 12 } } }) + '\n');
      } else {
        stdout.write(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} }) + '\n');
      }
    }
  });
  return proc as never;
}

describe('PiAdapter', () => {
  it('streams a prompt end to end and emits done with usage', async () => {
    const child = scriptedChild();
    const adapter = new PiAdapter({ spawnFn: () => child });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    await adapter.start({ sessionId: 'sx', conversationId: 'c', cwd: '/tmp', model: 'anthropic/claude-sonnet-4-6' });
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    const done = adapter.sendPrompt('hello');
    const out = (child as unknown as { stdout: PassThrough }).stdout;
    out.write('{"type":"agent_start"}\n');
    out.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }) + '\n');
    out.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'stop' } }) + '\n');
    out.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\n');
    await done;

    const types = events.map((e) => e.type);
    expect(types).toContain('status'); // running
    expect(types).toContain('message');
    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last && last.type === 'status' && last.payload.status).toBe('done');
    expect(last && last.type === 'status' && last.payload.inputTokens).toBe(10);
    expect(adapter.nativeSessionId).toBe('/sess/s1.jsonl');

    const statuses = events.filter((e) => e.type === 'status').map((e) => e.type === 'status' ? e.payload.status : '');
    expect(statuses[0]).toBe('running');
    expect(statuses[statuses.length - 1]).toBe('done');
    expect(ended).toBe(true);
  });

  it('steer() sends a mid-turn steer prompt command over the live rpc', async () => {
    const child = scriptedChild();
    const writes: string[] = [];
    (child as unknown as { stdin: PassThrough }).stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new PiAdapter({ spawnFn: () => child });
    await adapter.start({ sessionId: 'sx', conversationId: 'c', cwd: '/tmp', model: 'zai/glm-4.5-air' });
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');

    const done = adapter.sendPrompt('hello');
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"agent_start"}\n');

    await adapter.steer('follow-up text');

    const cmds = writes
      .join('')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const steerCmd = cmds.find((c) => c.type === 'prompt' && c.message === 'follow-up text');
    expect(steerCmd).toBeTruthy();
    expect(steerCmd?.streamingBehavior).toBe('steer');

    (child as unknown as { stdout: PassThrough }).stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\n');
    await done;
  });

  it('stop() writes an abort command and emits status idle', async () => {
    const child = scriptedChild();
    const writes: string[] = [];
    (child as unknown as { stdin: PassThrough }).stdin.on('data', (d) => writes.push(d.toString()));
    const adapter = new PiAdapter({ spawnFn: () => child });
    const statuses: string[] = [];
    adapter.streamEvents().on('event', (e) => { if (e.type === 'status') statuses.push(e.payload.status); });
    await adapter.start({ sessionId: 'sx', conversationId: 'c', cwd: '/tmp', model: 'anthropic/claude-sonnet-4-6' });
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');
    await adapter.stop();
    expect(writes.join('')).toContain('"type":"abort"');
    expect(statuses).toContain('idle');
  });

  it('interruptTurn soft-aborts without emitting end or killing the process', async () => {
    const child = scriptedChild();
    const writes: string[] = [];
    (child as unknown as { stdin: PassThrough }).stdin.on('data', (d) => writes.push(d.toString()));
    const adapter = new PiAdapter({ spawnFn: () => child });
    let ended = false;
    adapter.streamEvents().on('end', () => { ended = true; });
    await adapter.start({ sessionId: 'sx', conversationId: 'c', cwd: '/tmp', model: 'anthropic/claude-sonnet-4-6' });
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');
    await new Promise((r) => setTimeout(r, 20));
    adapter.interruptTurn();
    await new Promise((r) => setTimeout(r, 20));
    expect(writes.join('')).toContain('"type":"abort"');
    expect(ended).toBe(false);
  });

  it('surfaces message_end errors immediately and dedupes pi retries', async () => {
    const child = scriptedChild();
    const adapter = new PiAdapter({ spawnFn: () => child });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    // Hook stdin so we can detect when sendPrompt's `prompt` command actually
    // arrives — only then do we drive the agent frames. Without this gate the
    // PassThrough buffer would deliver our frames before sendPrompt has reset
    // _turnErrored/_emittedErrorMessages, defeating the test.
    const stdin = (child as unknown as { stdin: PassThrough }).stdin;
    let promptSeen: () => void = () => {};
    const onPrompt = new Promise<void>((res) => { promptSeen = res; });
    stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const cmd = JSON.parse(line);
          if (cmd.type === 'prompt') promptSeen();
        } catch { /* ignore */ }
      }
    });

    await adapter.start({ sessionId: 'sx', conversationId: 'c', cwd: '/tmp', model: 'zai/glm-5v-turbo' });
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');

    const done = adapter.sendPrompt('hello');
    // Wait for sendPrompt to actually issue the prompt command — at this point
    // _turnErrored has been reset and we're in the real timing window.
    await onPrompt;
    const out = (child as unknown as { stdout: PassThrough }).stdout;

    // Attempt 1: agent_start → message_end (error) → turn_end (error) → agent_end (retry)
    out.write('{"type":"agent_start"}\n');
    out.write(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '429 not available' },
    }) + '\n');
    out.write(JSON.stringify({
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '429 not available' },
    }) + '\n');
    out.write(JSON.stringify({ type: 'agent_end', willRetry: true, messages: [] }) + '\n');
    await done;

    // Pi would retry in the background (we don't drive those frames here because
    // sendPrompt has already returned — see index.ts comment about endPromise
    // resolving on the first agent_end). What matters for UX is that:
    //  1. Exactly one error event was surfaced (deduped across message_end + turn_end).
    //  2. status:error fired so the spinner flips immediately.
    //  3. The terminal status is NOT 'done' — _turnErrored gates the emit.
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].type === 'error' && errors[0].payload.message).toBe('429 not available');

    const statuses = events.filter((e) => e.type === 'status').map((e) => e.type === 'status' ? e.payload.status : '');
    expect(statuses).toContain('error');
    expect(statuses[statuses.length - 1]).not.toBe('done');
  });

  it('emits at most one status:error per turn across legacy + message_end paths', async () => {
    const child = scriptedChild();
    const adapter = new PiAdapter({ spawnFn: () => child });
    const events: NormalisedEvent[] = [];
    adapter.streamEvents().on('event', (e) => events.push(e));

    const stdin = (child as unknown as { stdin: PassThrough }).stdin;
    let promptSeen: () => void = () => {};
    const onPrompt = new Promise<void>((res) => { promptSeen = res; });
    stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const cmd = JSON.parse(line);
          if (cmd.type === 'prompt') promptSeen();
        } catch { /* ignore */ }
      }
    });

    await adapter.start({ sessionId: 'sx', conversationId: 'c', cwd: '/tmp', model: 'zai/glm-5v-turbo' });
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');

    const done = adapter.sendPrompt('hello');
    await onPrompt;
    const out = (child as unknown as { stdout: PassThrough }).stdout;

    // Legacy path (message_update k=error) emits BOTH {error} AND {status:error}
    // from the mapping. Then message_end emits a distinct error text. Without
    // the wrapper's status:error suppression, the legacy pass-through would
    // stack a second status:error on top of the wrapper's emit.
    out.write('{"type":"agent_start"}\n');
    out.write(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'error', reason: 'stream oops' },
    }) + '\n');
    out.write(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '429 different text' },
    }) + '\n');
    out.write(JSON.stringify({ type: 'agent_end', willRetry: false, messages: [] }) + '\n');
    await done;

    const statusErrors = events.filter((e) =>
      e.type === 'status' && (e.payload as { status?: string }).status === 'error'
    );
    expect(statusErrors).toHaveLength(1);

    const errorMessages = events
      .filter((e) => e.type === 'error')
      .map((e) => (e.payload as { message?: string }).message);
    expect(errorMessages).toContain('assistant stream oops');
    expect(errorMessages).toContain('429 different text');
  });
});

describe('appendPiPromptOptionArgs', () => {
  it('leaves args unchanged when options are omitted', () => {
    const args = ['--session-dir', '/tmp/pi'];
    appendPiPromptOptionArgs(args);
    expect(args).toEqual(['--session-dir', '/tmp/pi']);
  });

  it('leaves args unchanged for null or empty options', () => {
    const withNull = ['--session-dir', '/tmp/pi'];
    appendPiPromptOptionArgs(withNull, null);
    expect(withNull).toEqual(['--session-dir', '/tmp/pi']);
    const withEmpty = ['--session-dir', '/tmp/pi'];
    appendPiPromptOptionArgs(withEmpty, {});
    expect(withEmpty).toEqual(['--session-dir', '/tmp/pi']);
  });

  it('adds --thinking high for non-default thinking', () => {
    const args: string[] = [];
    appendPiPromptOptionArgs(args, { thinking: 'high' });
    expect(args).toEqual(['--thinking', 'high']);
  });

  it('adds --tools read,grep,find,ls for toolsProfile readOnly', () => {
    const args: string[] = [];
    appendPiPromptOptionArgs(args, { toolsProfile: 'readOnly' });
    expect(args).toEqual(['--tools', 'read,grep,find,ls']);
  });

  it('adds --no-tools for toolsProfile none', () => {
    const args: string[] = [];
    appendPiPromptOptionArgs(args, { toolsProfile: 'none' });
    expect(args).toEqual(['--no-tools']);
  });

  it('omits flags for default thinking and toolsProfile', () => {
    const args: string[] = [];
    appendPiPromptOptionArgs(args, { thinking: 'default', toolsProfile: 'default' });
    expect(args).toEqual([]);
  });

  it('appends thinking then toolsProfile after base flags', () => {
    const args = ['--session-dir', '/tmp/pi', '--provider', 'anthropic', '--model', 'claude'];
    appendPiPromptOptionArgs(args, { thinking: 'high', toolsProfile: 'readOnly' });
    expect(args).toEqual([
      '--session-dir', '/tmp/pi', '--provider', 'anthropic', '--model', 'claude',
      '--thinking', 'high',
      '--tools', 'read,grep,find,ls',
    ]);
  });

  it('accepts xhigh thinking', () => {
    const args: string[] = [];
    appendPiPromptOptionArgs(args, { thinking: 'xhigh' });
    expect(args).toEqual(['--thinking', 'xhigh']);
  });

  it('omits unrecognized thinking and toolsProfile values', () => {
    const args: string[] = [];
    appendPiPromptOptionArgs(args, { thinking: 'turbo', toolsProfile: 'write' });
    expect(args).toEqual([]);
  });
});

describe('PiAdapter — prompt options spawn argv', () => {
  it('respawns pi with --thinking high when sendPrompt receives thinking options', async () => {
    const children: ReturnType<typeof scriptedChild>[] = [];
    let lastArgs: string[] = [];
    let resolveSecond: (child: ReturnType<typeof scriptedChild>) => void;
    const secondChild = new Promise<ReturnType<typeof scriptedChild>>((resolve) => {
      resolveSecond = resolve;
    });
    const adapter = new PiAdapter({
      spawnFn: (_cmd, args) => {
        lastArgs = args;
        const child = scriptedChild();
        children.push(child);
        if (children.length === 2) resolveSecond(child);
        return child as never;
      },
    });

    await adapter.start({
      sessionId: 'sx',
      conversationId: 'c',
      cwd: '/tmp',
      model: 'anthropic/claude-sonnet-4-6',
    });
    (children[0] as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');

    const done = adapter.sendPrompt('hello', [], undefined, undefined, { thinking: 'high' });
    const child2 = await secondChild;
    (child2 as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');
    (child2 as unknown as { stdout: PassThrough }).stdout.write('{"type":"agent_start"}\n');
    (child2 as unknown as { stdout: PassThrough }).stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\n');
    await done;

    expect(children).toHaveLength(2);
    expect(lastArgs).toContain('--thinking');
    expect(lastArgs[lastArgs.indexOf('--thinking') + 1]).toBe('high');
  });

  it('does not respawn when sendPrompt has no options', async () => {
    let spawnCount = 0;
    const child = scriptedChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        spawnCount++;
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'c', cwd: '/tmp', model: 'anthropic/claude-sonnet-4-6' });
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"ready"}\n');
    const done = adapter.sendPrompt('hello');
    (child as unknown as { stdout: PassThrough }).stdout.write('{"type":"agent_start"}\n');
    (child as unknown as { stdout: PassThrough }).stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\n');
    await done;
    expect(spawnCount).toBe(1);
  });
});

describe('PiAdapter.deleteNativeSession', () => {
  it('unlinks the file at the absolute path (native_session_id IS the path for pi)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-sessions-'));
    const file = join(dir, 'sess.jsonl');
    writeFileSync(file, '{}');
    const adapter = new PiAdapter();
    await adapter.deleteNativeSession!(file);
    expect(existsSync(file)).toBe(false);
  });

  it('swallows ENOENT when the file is already gone', async () => {
    const adapter = new PiAdapter();
    await expect(adapter.deleteNativeSession!(join(tmpdir(), 'never-existed.jsonl'))).resolves.toBeUndefined();
  });

  it('is a no-op for an empty native session id', async () => {
    const adapter = new PiAdapter();
    await expect(adapter.deleteNativeSession!('')).resolves.toBeUndefined();
  });
});
