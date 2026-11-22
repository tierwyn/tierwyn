import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { NormalisedEvent } from '@tierwyn/shared';
import { KiroAdapter } from './index.js';

type FakeProc = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (s?: string) => void;
};

function parseLines(buf: Buffer): Record<string, unknown>[] {
  return buf.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function fakeChild(opts: {
  loadSession?: boolean;
  /** If true, session/prompt is left open until the test resolves it. */
  holdPrompt?: boolean;
} = {}): {
  proc: FakeProc;
  writes: Record<string, unknown>[];
  killed: { value: boolean };
  resolvePrompt: (id: number | string, result?: unknown, error?: unknown) => void;
  lastPromptId: { value: number | string | null };
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killed = { value: false };
  const lastPromptId = { value: null as number | string | null };
  const proc = new EventEmitter() as FakeProc;
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
  proc.kill = () => { killed.value = true; };
  const writes: Record<string, unknown>[] = [];

  const reply = (id: unknown, result: unknown) => {
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  };
  const fail = (id: unknown, error: unknown) => {
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n');
  };
  const notify = (method: string, params: unknown) => {
    stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  stdin.on('data', (d: Buffer) => {
    for (const msg of parseLines(d)) {
      writes.push(msg);
      if (msg.id === undefined) continue;
      if (msg.method === 'initialize') {
        reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: Boolean(opts.loadSession) } });
      } else if (msg.method === 'session/new') {
        reply(msg.id, { sessionId: 'kiro-sess-1' });
      } else if (msg.method === 'session/load' || msg.method === 'session/set_model') {
        reply(msg.id, {});
      } else if (msg.method === 'session/prompt') {
        lastPromptId.value = msg.id as number;
        if (opts.holdPrompt) return;
        notify('session/update', {
          sessionId: 'kiro-sess-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
        });
        reply(msg.id, { stopReason: 'end_turn' });
      }
    }
  });

  return {
    proc,
    writes,
    killed,
    lastPromptId,
    resolvePrompt: (id, result, error) => {
      if (error) fail(id, error);
      else reply(id, result ?? { stopReason: 'end_turn' });
    },
  };
}

function collect(adapter: KiroAdapter): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return events;
}

describe('KiroAdapter handshake', () => {
  it('sends initialize then session/new with mcpServers as an array', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });

    const methods = writes.map((w) => w.method);
    expect(methods[0]).toBe('initialize');
    expect(methods).toContain('session/new');
    const sessionNew = writes.find((w) => w.method === 'session/new');
    const params = sessionNew?.params as { mcpServers?: unknown };
    expect(Array.isArray(params.mcpServers)).toBe(true);
    expect(params.mcpServers).toEqual([]);
  });

  it('sends no initialized notification', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    expect(writes.some((w) => w.method === 'initialized')).toBe(false);
  });

  it('merges commands from both delivery paths instead of last-writer-wins', async () => {
    const { proc } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });

    const notify = (method: string, params: unknown) => {
      proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    };
    notify('session/update', {
      sessionId: 'kiro-sess-1',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'plan', description: 'from session/update' }] },
    });
    notify('_kiro.dev/commands/available', {
      commands: [{ name: 'review', description: 'from vendor' }, { name: 'plan', description: 'vendor overrides' }],
    });
    await new Promise((r) => setImmediate(r));

    const cmds = await adapter.listCommands();
    const names = cmds.map((c) => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('review');
    const plan = cmds.find((c) => c.name === 'plan');
    expect(plan?.description).toBe('vendor overrides'); // later payload wins on conflict
  });

  it('sends session/set_model with the config model on the fresh path', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'claude-sonnet-4.5' });
    const setModel = writes.find((w) => w.method === 'session/set_model');
    expect(setModel?.params).toMatchObject({ sessionId: 'kiro-sess-1', modelId: 'claude-sonnet-4.5' });
  });

  it('resumes via session/load and still sends session/set_model', async () => {
    const { proc, writes } = fakeChild({ loadSession: true });
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'glm-5', nativeSessionId: 'saved-native-id',
    });
    expect(writes.some((w) => w.method === 'session/load')).toBe(true);
    expect(writes.some((w) => w.method === 'session/new')).toBe(false);
    const load = writes.find((w) => w.method === 'session/load');
    expect(Array.isArray((load?.params as { mcpServers?: unknown }).mcpServers)).toBe(true);
    const setModel = writes.find((w) => w.method === 'session/set_model');
    expect(setModel?.params).toMatchObject({ sessionId: 'saved-native-id', modelId: 'glm-5' });
    expect(adapter.nativeSessionId).toBe('saved-native-id');
  });

  it('does not emit session/load replay notifications that arrive before sendPrompt', async () => {
    const { proc } = fakeChild({ loadSession: true });
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'auto', nativeSessionId: 'saved-native-id',
    });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'saved-native-id',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } },
      },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'message')).toBe(false);
  });
});

describe('KiroAdapter turn', () => {
  it('emits status:running before session/prompt is written', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    const promptSeen = { runningBefore: false };
    proc.stdin.on('data', (d: Buffer) => {
      for (const msg of parseLines(d)) {
        if (msg.method === 'session/prompt') {
          promptSeen.runningBefore = events.some((e) => e.type === 'status' && e.payload.status === 'running');
        }
      }
    });
    await adapter.sendPrompt('question');
    expect(writes.some((w) => w.method === 'session/prompt')).toBe(true);
    expect(promptSeen.runningBefore).toBe(true);
  });

  it('emits message{final:true} then status:done after a chunk + end_turn', async () => {
    const { proc } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.sendPrompt('question');
    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'answer')).toBe(true);
    const types = events.map((e) => e.type === 'status' ? `status:${e.payload.status}` : e.type);
    const finalIdx = events.findIndex((e) => e.type === 'message' && e.payload.final === true);
    const doneIdx = events.findIndex((e) => e.type === 'status' && e.payload.status === 'done');
    expect(finalIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(finalIdx);
    expect(types).toContain('status:running');
    expect(ended).toBe(true);
  });

  it('folds _kiro.dev/metadata into the trailing status:done', async () => {
    const { proc, lastPromptId } = fakeChild({ holdPrompt: true });
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    const promptP = adapter.sendPrompt('question');
    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'kiro-sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      },
    }) + '\n');
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: '_kiro.dev/metadata',
      params: { contextUsagePercentage: 42, meteringUsage: { credits: 0.05 } },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: lastPromptId.value, result: { stopReason: 'end_turn' },
    }) + '\n');
    await promptP;
    const done = [...events].reverse().find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done && done.type === 'status' && done.payload.costUsd).toBe(0.05);
    expect(done && done.type === 'status' && done.payload.contextWindowPct).toBe(42);
  });

  it('emits error + status:error when end_turn arrives with zero chunks', async () => {
    const { proc, lastPromptId } = fakeChild({ holdPrompt: true });
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    const promptP = adapter.sendPrompt('question');
    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: lastPromptId.value, result: { stopReason: 'end_turn' },
    }) + '\n');
    await promptP;
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.payload.message).toMatch(/Kiro returned no output/);
  });

  it('getLiveContextWindowUsage returns contextWindowPct after metadata and {} before', async () => {
    const { proc, lastPromptId } = fakeChild({ holdPrompt: true });
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    expect(adapter.getLiveContextWindowUsage()).toEqual({});
    const promptP = adapter.sendPrompt('question');
    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: '_kiro.dev/metadata',
      params: { contextUsagePercentage: 17 },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(adapter.getLiveContextWindowUsage()).toEqual({ contextWindowPct: 17 });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'kiro-sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      },
    }) + '\n');
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: lastPromptId.value, result: { stopReason: 'end_turn' },
    }) + '\n');
    await promptP;
  });
});

describe('KiroAdapter permissions', () => {
  it('bypass mode answers session/request_permission without emitting interaction_request', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never, interactionMode: 'bypass' });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        description: 'Write?',
        options: [
          { optionId: 'reject_once', kind: 'reject_once' },
          { optionId: 'allow_once', kind: 'allow_once' },
        ],
      },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    const reply = writes.find((w) => w.id === 99);
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  });

  it('questions mode answers session/request_permission without emitting interaction_request', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never, interactionMode: 'questions' });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 98,
      method: 'session/request_permission',
      params: {
        description: 'Write?',
        options: [
          { optionId: 'reject_once', kind: 'reject_once' },
          { optionId: 'allow_once', kind: 'allow_once' },
        ],
      },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    const reply = writes.find((w) => w.id === 98);
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  });

  it('prompt mode emits interaction_request; respondToInteraction writes selected', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never, interactionMode: 'prompt' });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: {
        description: 'Write to file?',
        options: [
          { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', label: 'Deny' },
        ],
      },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'interaction_request');
    expect(req).toBeDefined();
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'waiting')).toBe(true);
    adapter.respondToInteraction(
      (req as Extract<NormalisedEvent, { type: 'interaction_request' }>).payload.requestId,
      { selection: ['allow_once'] },
    );
    expect(events.some((e) => e.type === 'interaction_resolved')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'running')).toBe(true);
    const reply = writes.find((w) => w.id === 77);
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  });

  it('stop() with a pending permission writes cancelled (double-L), never cancel', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never, interactionMode: 'prompt' });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 55,
      method: 'session/request_permission',
      params: { options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    await adapter.stop();
    const reply = writes.find((w) => w.id === 55);
    expect(JSON.stringify(reply)).not.toMatch(/"cancel"/);
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  });
});

describe('KiroAdapter lifecycle', () => {
  it('interruptTurn writes session/cancel, does not kill or emit end, and sendPrompt soft-ends', async () => {
    const { proc, writes, killed, lastPromptId } = fakeChild({ holdPrompt: true });
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });

    let ended = false;
    adapter.streamEvents().on('end', () => { ended = true; });
    const promptP = adapter.sendPrompt('spawn and wait');
    await new Promise((r) => setTimeout(r, 20));
    adapter.interruptTurn();
    await new Promise((r) => setImmediate(r));
    expect(writes.some((w) => w.method === 'session/cancel' && w.id === undefined)).toBe(true);
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: lastPromptId.value, result: { stopReason: 'cancelled' },
    }) + '\n');
    await promptP;

    expect(killed.value).toBe(false);
    expect(ended).toBe(true); // no getNextSteer → sendPrompt emits end on the soft path
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(false);
  });

  it('stop() writes session/cancel, emits status:idle then end, and kills the child', async () => {
    const { proc, writes, killed } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.stop();
    expect(writes.some((w) => w.method === 'session/cancel')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'idle')).toBe(true);
    expect(ended).toBe(true);
    expect(killed.value).toBe(true);
  });

  it('getNextSteer returning a value writes a second session/prompt; null emits end once', async () => {
    const { proc, writes } = fakeChild();
    const adapter = new KiroAdapter({ spawnFn: () => proc as never });
    const queue: ({ text: string } | null)[] = [{ text: 'follow-up' }, null];
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'auto', getNextSteer: async () => queue.shift() ?? null,
    });
    let endCount = 0;
    adapter.streamEvents().on('end', () => { endCount++; });
    await adapter.sendPrompt('initial');
    await new Promise((r) => setTimeout(r, 50));
    const promptTexts = writes
      .filter((c) => c.method === 'session/prompt')
      .flatMap((c) => ((c.params as { prompt?: { text: string }[] }).prompt ?? []).map((p) => p.text));
    expect(promptTexts).toEqual(['initial', 'follow-up']);
    expect(endCount).toBe(1);
  });
});

describe('KiroAdapter prompt options', () => {
  it('passes --effort high on start when session config has effort', async () => {
    const { proc } = fakeChild();
    const spawnCalls: string[][] = [];
    const adapter = new KiroAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return proc as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto', effort: 'high' });
    expect(spawnCalls[0]).toEqual(['acp', '--effort', 'high']);
  });

  it('passes --effort and --trust-all-tools when both are set', async () => {
    const { proc } = fakeChild();
    const spawnCalls: string[][] = [];
    const adapter = new KiroAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return proc as never;
      },
    });
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto',
      effort: 'high', options: { trustAllTools: true },
    });
    expect(spawnCalls[0]).toEqual(['acp', '--effort', 'high', '--trust-all-tools']);
  });

  it('preserves --trust-all-tools across effort respawn', async () => {
    const { proc } = fakeChild({ loadSession: true });
    const spawnCalls: string[][] = [];
    const adapter = new KiroAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return proc as never;
      },
    });
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto',
      effort: 'high', options: { trustAllTools: true },
    });
    await adapter.sendPrompt('question', undefined, undefined, undefined, { effort: 'max' });
    expect(spawnCalls[1]).toEqual(['acp', '--effort', 'max', '--trust-all-tools']);
  });

  it('omits --effort on start when session effort is unset', async () => {
    const { proc } = fakeChild();
    const spawnCalls: string[][] = [];
    const adapter = new KiroAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return proc as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    expect(spawnCalls[0]).toEqual(['acp']);
  });

  it('respawns ACP with --effort max when sendPrompt options.effort differs from session', async () => {
    const { proc } = fakeChild({ loadSession: true });
    const spawnCalls: string[][] = [];
    const adapter = new KiroAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return proc as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto', effort: 'high' });
    expect(spawnCalls).toHaveLength(1);
    await adapter.sendPrompt('question', undefined, undefined, undefined, { effort: 'max' });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]).toEqual(['acp', '--effort', 'max']);
  });

  it('does not respawn when sendPrompt has no options', async () => {
    const { proc } = fakeChild();
    const spawnCalls: string[][] = [];
    const adapter = new KiroAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return proc as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto', effort: 'high' });
    await adapter.sendPrompt('question');
    expect(spawnCalls).toHaveLength(1);
  });

  it('respawns back to session effort after a one-turn override', async () => {
    const { proc } = fakeChild({ loadSession: true });
    const spawnCalls: string[][] = [];
    const adapter = new KiroAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return proc as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto', effort: 'high' });
    await adapter.sendPrompt('one', undefined, undefined, undefined, { effort: 'max' });
    await adapter.sendPrompt('two');
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[2]).toEqual(['acp', '--effort', 'high']);
  });

  it('runCommand forwards effort options into a respawn', async () => {
    const { proc } = fakeChild({ loadSession: true });
    const spawnCalls: string[][] = [];
    const adapter = new KiroAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return proc as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'auto' });
    await adapter.runCommand('plan', undefined, { effort: 'low' });
    expect(spawnCalls.at(-1)).toEqual(['acp', '--effort', 'low']);
  });
});

describe('KiroAdapter native session files', () => {
  it('isNativeSessionAvailable is true only for ~/.kiro/sessions/cli/<id>.json', async () => {
    const home = join(tmpdir(), `kiro-home-${Date.now()}`);
    mkdirSync(join(home, 'sessions', 'cli'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'cli', 'abc.json'), '{}');
    const adapter = new KiroAdapter({ spawnFn: () => fakeChild().proc as never, kiroHome: home });
    expect(await adapter.isNativeSessionAvailable('abc')).toBe(true);
    expect(await adapter.isNativeSessionAvailable('nope')).toBe(false);
    expect(await adapter.isNativeSessionAvailable('')).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});
