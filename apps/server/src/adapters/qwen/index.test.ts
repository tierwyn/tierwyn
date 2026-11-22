import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { QWEN_MODELS_TTL_MS } from './models.js';
import type { ChildProcess } from 'child_process';
import type { NormalisedEvent } from '@tierwyn/shared';
import { QwenAdapter } from './index.js';

type FakeProc = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (s?: string) => void;
};

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;

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
  spawnFn: SpawnFn;
  spawnCalls: Array<{ cmd: string; args: string[]; detached?: boolean }>;
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
  const spawnCalls: Array<{ cmd: string; args: string[]; detached?: boolean }> = [];

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
        reply(msg.id, {
          protocolVersion: 1,
          agentInfo: { name: 'qwen-code', title: 'Qwen Code', version: '0.22.3' },
          agentCapabilities: {
            loadSession: Boolean(opts.loadSession),
            promptCapabilities: { image: true, audio: true, embeddedContext: true },
            sessionCapabilities: { list: {}, resume: {} },
          },
        });
      } else if (msg.method === 'session/new') {
        reply(msg.id, {
          sessionId: 'qwen-sess-1',
          models: {
            currentModelId: 'GLM-5.3-Flash(openai)',
            availableModels: [{
              modelId: 'GLM-5.3-Flash(openai)',
              name: '[Z.AI] GLM-5.3-Flash',
              description: null,
              _meta: { contextLimit: 1000000 },
            }],
          },
        });
      } else if (
        msg.method === 'session/load'
        || msg.method === 'session/set_model'
        || msg.method === 'session/set_mode'
        || msg.method === 'session/list'
      ) {
        reply(msg.id, msg.method === 'session/list' ? { sessions: [] } : {});
      } else if (msg.method === 'session/prompt') {
        lastPromptId.value = msg.id as number;
        if (opts.holdPrompt) return;
        notify('session/update', {
          sessionId: 'qwen-sess-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
        });
        reply(msg.id, { stopReason: 'end_turn' });
      }
    }
  });

  const spawnFn: SpawnFn = (cmd, args, o) => {
    spawnCalls.push({ cmd, args, detached: o.detached });
    return proc as never;
  };

  return {
    proc,
    writes,
    killed,
    lastPromptId,
    spawnFn,
    spawnCalls,
    resolvePrompt: (id, result, error) => {
      if (error) fail(id, error);
      else reply(id, result ?? { stopReason: 'end_turn' });
    },
  };
}

function collect(adapter: QwenAdapter): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return events;
}

const PERMISSION_PARAMS = {
  sessionId: '43e2f7d3-…',
  options: [
    { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'proceed_once_and_switch_to_default', name: 'Switch to Default Mode and allow once (recommended)', kind: 'allow_once' },
    { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
  ],
  toolCall: {
    toolCallId: 'call_bb1f…',
    status: 'pending',
    kind: 'execute',
    title: 'echo hi > /tmp/qwen_acp_shell.txt (Write "hi" to /tmp/qwen_acp_shell.txt)',
  },
};

describe('QwenAdapter handshake', () => {
  it('spawns qwen --acp detached', async () => {
    const { spawnFn, spawnCalls } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    expect(spawnCalls[0]).toMatchObject({ cmd: 'qwen', args: ['--acp'], detached: true });
  });

  it('spawns qwen --acp -s when sandbox option is on', async () => {
    const { spawnFn, spawnCalls } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn });
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash',
      options: { sandbox: true },
    });
    expect(spawnCalls[0]).toMatchObject({ cmd: 'qwen', args: ['--acp', '-s'], detached: true });
  });

  it('sends initialize then session/new; set_model; set_mode yolo under bypass', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, interactionMode: 'bypass' });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });

    const methods = writes.map((w) => w.method);
    expect(methods[0]).toBe('initialize');
    expect(methods).toContain('session/new');
    const sessionNew = writes.find((w) => w.method === 'session/new');
    expect((sessionNew?.params as { mcpServers?: unknown }).mcpServers).toEqual([]);
    expect(writes.find((w) => w.method === 'session/set_model')?.params).toMatchObject({
      sessionId: 'qwen-sess-1', modelId: 'GLM-5.3-Flash',
    });
    expect(writes.find((w) => w.method === 'session/set_mode')?.params).toMatchObject({
      sessionId: 'qwen-sess-1', modeId: 'yolo',
    });
    expect(adapter.nativeSessionId).toBe('qwen-sess-1');
  });

  it('sends session/set_mode default under prompt', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, interactionMode: 'prompt' });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    expect(writes.find((w) => w.method === 'session/set_mode')?.params).toMatchObject({ modeId: 'default' });
  });

  it('resumes via session/load and does not send session/new', async () => {
    const { spawnFn, writes } = fakeChild({ loadSession: true });
    const adapter = new QwenAdapter({ spawnFn });
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'GLM-5.3-Flash', nativeSessionId: 'saved-native-id',
    });
    expect(writes.some((w) => w.method === 'session/load')).toBe(true);
    expect(writes.some((w) => w.method === 'session/new')).toBe(false);
    const load = writes.find((w) => w.method === 'session/load');
    expect(Array.isArray((load?.params as { mcpServers?: unknown }).mcpServers)).toBe(true);
    expect(adapter.nativeSessionId).toBe('saved-native-id');
  });

  it('does not emit session/load replay notifications that arrive before sendPrompt', async () => {
    const { proc, spawnFn } = fakeChild({ loadSession: true });
    const adapter = new QwenAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'GLM-5.3-Flash', nativeSessionId: 'saved-native-id',
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

  it('listModels strips (provider) suffix from session/new availableModels', async () => {
    const { spawnFn } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    const models = await adapter.listModels();
    expect(models).toEqual([{
      name: 'GLM-5.3-Flash',
      label: 'Qwen Code · GLM-5.3-Flash',
      provider: 'z.ai',
      vision: false,
      steer: true,
      contextWindow: 1000000,
    }]);
  });
});

describe('QwenAdapter turn', () => {
  it('emits status:running before session/prompt is written', async () => {
    const { spawnFn, writes, proc } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
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

  it('happy turn: running → chunks → tool_call/result → final message → done with usage + ctx%', async () => {
    const { proc, spawnFn, lastPromptId } = fakeChild({ holdPrompt: true });
    const adapter = new QwenAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    const promptP = adapter.sendPrompt('write a file');
    await new Promise((r) => setTimeout(r, 20));

    const notify = (update: Record<string, unknown>) => {
      proc.stdout.write(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'qwen-sess-1', update },
      }) + '\n');
    };
    notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
      _meta: {
        usage: { inputTokens: 29345, outputTokens: 115, totalTokens: 29460, thoughtTokens: 90, cachedReadTokens: 3136 },
        durationMs: 8258,
      },
    });
    notify({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1b21…',
      status: 'pending',
      title: 'WriteFile',
      content: [],
      locations: [],
      kind: 'edit',
      rawInput: {},
      _meta: { toolName: 'write_file', provenance: 'builtin', phase: 'preparing' },
    });
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1b21…',
      status: 'in_progress',
      title: 'WriteFile: Writing to qwen_acp_probe.txt',
      kind: 'edit',
      rawInput: { content: 'hello', file_path: '/tmp/qwen_acp_probe.txt' },
      _meta: { toolName: 'write_file', provenance: 'builtin' },
    });
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1b21…',
      status: 'completed',
      content: [{ type: 'diff', path: 'qwen_acp_probe.txt', oldText: '', newText: 'hello' }],
    });
    notify({ sessionUpdate: 'usage_update', used: 29345, size: 1000000 });
    await new Promise((r) => setImmediate(r));
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: lastPromptId.value, result: { stopReason: 'end_turn' },
    }) + '\n');
    await promptP;

    expect(events.some((e) => e.type === 'status' && e.payload.status === 'running')).toBe(true);
    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'done')).toBe(true);
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall && toolCall.type === 'tool_call' && toolCall.payload.name).toBe('write_file');
    expect(events.some((e) => e.type === 'tool_result' && e.payload.toolUseId === 'call_1b21…')).toBe(true);
    const finalIdx = events.findIndex((e) => e.type === 'message' && e.payload.final === true);
    const doneIdx = events.findIndex((e) => e.type === 'status' && e.payload.status === 'done');
    expect(finalIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(finalIdx);
    const done = events[doneIdx];
    expect(done && done.type === 'status' && done.payload.inputTokens).toBe(29345);
    expect(done && done.type === 'status' && done.payload.outputTokens).toBe(115);
    expect(done && done.type === 'status' && done.payload.cacheReadTokens).toBe(3136);
    expect(done && done.type === 'status' && done.payload.contextWindowPct).toBeCloseTo(2.9345, 4);
    expect(ended).toBe(true);
  });

  it('emits error + status:error when end_turn arrives with zero chunks', async () => {
    const { proc, spawnFn, lastPromptId } = fakeChild({ holdPrompt: true });
    const adapter = new QwenAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    const promptP = adapter.sendPrompt('question');
    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: lastPromptId.value, result: { stopReason: 'end_turn' },
    }) + '\n');
    await promptP;
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.payload.message).toMatch(/Qwen returned no output/);
  });

  it('yolo permissionMode emits session/set_mode yolo immediately before session/prompt', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, interactionMode: 'bypass' });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    const setModeAtStart = writes.filter((w) => w.method === 'session/set_mode').length;
    await adapter.sendPrompt('question', undefined, undefined, undefined, { permissionMode: 'yolo' });

    const methods = writes.map((w) => w.method);
    const promptIdx = methods.lastIndexOf('session/prompt');
    const lastSetModeIdx = methods.lastIndexOf('session/set_mode');
    expect(writes.filter((w) => w.method === 'session/set_mode').length).toBe(setModeAtStart + 1);
    expect(lastSetModeIdx).toBeGreaterThan(-1);
    expect(lastSetModeIdx).toBeLessThan(promptIdx);
    expect(writes[lastSetModeIdx]?.params).toMatchObject({
      sessionId: 'qwen-sess-1',
      modeId: 'yolo',
    });
  });

  it('default permissionMode does not emit extra set_mode (conversation setting)', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, interactionMode: 'bypass' });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    const setModeAtStart = writes.filter((w) => w.method === 'session/set_mode').length;
    await adapter.sendPrompt('question', undefined, undefined, undefined, { permissionMode: 'default' });
    expect(writes.filter((w) => w.method === 'session/set_mode').length).toBe(setModeAtStart);
    expect(writes.some((w) => w.method === 'session/prompt')).toBe(true);
  });

  it('default-strict permissionMode emits session/set_mode default before session/prompt', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, interactionMode: 'bypass' });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    const setModeAtStart = writes.filter((w) => w.method === 'session/set_mode').length;
    await adapter.sendPrompt('question', undefined, undefined, undefined, { permissionMode: 'default-strict' });

    const methods = writes.map((w) => w.method);
    const promptIdx = methods.lastIndexOf('session/prompt');
    const lastSetModeIdx = methods.lastIndexOf('session/set_mode');
    expect(writes.filter((w) => w.method === 'session/set_mode').length).toBe(setModeAtStart + 1);
    expect(lastSetModeIdx).toBeLessThan(promptIdx);
    expect(writes[lastSetModeIdx]?.params).toMatchObject({
      sessionId: 'qwen-sess-1',
      modeId: 'default',
    });
  });
});

describe('QwenAdapter permissions', () => {
  it('bypass mode auto-replies proceed_once and emits no interaction_request', async () => {
    const { proc, spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, interactionMode: 'bypass' });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: PERMISSION_PARAMS,
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    const reply = writes.find((w) => w.id === 7);
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'proceed_once' } } });
  });

  it('bypass auto-allow falls back to the first optionId when no kind contains allow', async () => {
    const { proc, spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, interactionMode: 'bypass' });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: 9, method: 'session/request_permission',
      params: {
        sessionId: 'qwen-sess-1',
        options: [
          { optionId: 'opt_first', name: 'Continue', kind: 'proceed' },
          { optionId: 'opt_second', name: 'Abort', kind: 'reject_once' },
        ],
        toolCall: { title: 'run something' },
      },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    const reply = writes.find((w) => w.id === 9);
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'opt_first' } } });
  });

  it('prompt mode emits interaction_request; respondToInteraction writes selected', async () => {
    const { proc, spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, interactionMode: 'prompt' });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: PERMISSION_PARAMS,
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'interaction_request');
    expect(req).toBeDefined();
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'waiting')).toBe(true);
    adapter.respondToInteraction(
      (req as Extract<NormalisedEvent, { type: 'interaction_request' }>).payload.requestId,
      { selection: ['proceed_once'] },
    );
    expect(events.some((e) => e.type === 'interaction_resolved')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'running')).toBe(true);
    const reply = writes.find((w) => w.id === 7);
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'proceed_once' } } });
  });

  it('unknown inbound request craft/drainMidTurnQueue is answered with {}', async () => {
    const { proc, spawnFn, writes } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'craft/drainMidTurnQueue', params: { sessionId: 'qwen-sess-1' },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    const reply = writes.find((w) => w.id === 8);
    expect(reply).toEqual({ jsonrpc: '2.0', id: 8, result: {} });
  });
});

describe('QwenAdapter lifecycle', () => {
  it('interruptTurn sends session/cancel and the turn ends done, not error', async () => {
    const { proc, spawnFn, writes, killed, lastPromptId } = fakeChild({ holdPrompt: true });
    const adapter = new QwenAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });

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
    expect(ended).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(false);
  });

  it('stop() writes session/cancel, emits status:idle then end, and kills the child', async () => {
    const { spawnFn, writes, killed } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.stop();
    expect(writes.some((w) => w.method === 'session/cancel')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'idle')).toBe(true);
    expect(ended).toBe(true);
    expect(killed.value).toBe(true);
  });

  it('listModels falls back to seed profiles when the probe fails', async () => {
    // Real child_process.spawn never throws synchronously on ENOENT — it
    // returns a ChildProcess and emits 'error' on a later tick. Drive that
    // shape so this test actually covers the production failure mode.
    const cacheDir = mkdtempSync(join(tmpdir(), 'qwen-models-'));
    const adapter = new QwenAdapter({
      spawnFn: () => {
        const p = new EventEmitter() as FakeProc;
        p.stdin = new PassThrough();
        p.stdout = new PassThrough();
        p.stderr = new PassThrough();
        p.kill = () => {};
        setImmediate(() => p.emit('error', new Error('spawn qwen ENOENT')));
        return p as never;
      },
      modelsCachePath: join(cacheDir, 'qwen-models.json'),
    });
    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.name === 'GLM-5.3-Flash')).toBe(true);
    expect(models.every((m) => !m.name.includes('('))).toBe(true);
    rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('QwenAdapter post-turn gate', () => {
  it('does not map session/update events after the turn ends', async () => {
    const { proc, spawnFn } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' });
    await adapter.sendPrompt('question');
    const before = events.filter((e) => e.type === 'message').length;
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'qwen-sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stray after done' } },
      },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    const after = events.filter((e) => e.type === 'message');
    expect(after.length).toBe(before);
    expect(after.some((e) => e.type === 'message' && e.payload.chunk === 'stray after done')).toBe(false);
  });

  it('session/load usage replay does not leak into turn-1 done; post-turn usage_update still updates', async () => {
    const { proc, spawnFn, lastPromptId } = fakeChild({ loadSession: true, holdPrompt: true });
    const adapter = new QwenAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'GLM-5.3-Flash', nativeSessionId: 'saved-native-id',
    });
    const notify = (update: Record<string, unknown>) => {
      proc.stdout.write(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'saved-native-id', update },
      }) + '\n');
    };
    notify({ sessionUpdate: 'usage_update', used: 500_000, size: 1_000_000 });
    notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'history' },
      _meta: { usage: { inputTokens: 111, outputTokens: 22 } },
    });
    await new Promise((r) => setImmediate(r));
    expect(adapter.getLiveContextWindowUsage().contextWindowPct).toBe(50);

    const promptP = adapter.sendPrompt('question');
    await new Promise((r) => setTimeout(r, 20));
    // sendPrompt resets context %; no new usage_update this turn.
    expect(adapter.getLiveContextWindowUsage().contextWindowPct).toBeUndefined();
    notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'fresh' },
    });
    await new Promise((r) => setImmediate(r));
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: lastPromptId.value, result: { stopReason: 'end_turn' },
    }) + '\n');
    await promptP;

    const done = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done && done.type === 'status' && done.payload.contextWindowPct).toBeUndefined();
    expect(done && done.type === 'status' && done.payload.inputTokens).toBeUndefined();

    // Gate is closed, but usage/context accounting still runs.
    notify({ sessionUpdate: 'usage_update', used: 250_000, size: 1_000_000 });
    await new Promise((r) => setImmediate(r));
    expect(adapter.getLiveContextWindowUsage().contextWindowPct).toBe(25);
  });
});

describe('QwenAdapter model disk cache', () => {
  let dir: string;
  let cachePath: string;

  function spawnErrorFn(): SpawnFn {
    return () => {
      const p = new EventEmitter() as FakeProc;
      p.stdin = new PassThrough();
      p.stdout = new PassThrough();
      p.stderr = new PassThrough();
      p.kill = () => {};
      setImmediate(() => p.emit('error', new Error('spawn qwen ENOENT')));
      return p as never;
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-models-'));
    cachePath = join(dir, 'qwen-models.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh cache skips the throwaway probe entirely', async () => {
    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: Date.now(),
      models: [{
        name: 'cached-glm',
        label: 'Qwen Code · cached-glm',
        provider: 'z.ai',
        vision: false,
        steer: true,
        contextWindow: 1_000_000,
      }],
    }));
    let spawns = 0;
    const adapter = new QwenAdapter({
      spawnFn: (...args) => {
        spawns++;
        return fakeChild().spawnFn(...args);
      },
      modelsCachePath: cachePath,
    });
    const models = await adapter.listModels();
    expect(spawns).toBe(0);
    expect(models[0].name).toBe('cached-glm');
  });

  it('successful probe writes the cache', async () => {
    const { spawnFn } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn, modelsCachePath: cachePath, now: () => 42 });
    const models = await adapter.listModels();
    expect(models[0].name).toBe('GLM-5.3-Flash');
    const written = JSON.parse(readFileSync(cachePath, 'utf-8')) as { fetchedAt: number; models: { name: string }[] };
    expect(written.fetchedAt).toBe(42);
    expect(written.models[0].name).toBe('GLM-5.3-Flash');
  });

  it('probe failure returns stale cache even when expired, then seed if none', async () => {
    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: 1,
      models: [{ name: 'stale-glm', label: 'stale', provider: 'z.ai' }],
    }));
    const staleAdapter = new QwenAdapter({
      spawnFn: spawnErrorFn(),
      modelsCachePath: cachePath,
      now: () => QWEN_MODELS_TTL_MS + 99,
    });
    expect((await staleAdapter.listModels())[0].name).toBe('stale-glm');

    const emptyPath = join(dir, 'empty', 'qwen-models.json');
    const seedAdapter = new QwenAdapter({
      spawnFn: spawnErrorFn(),
      modelsCachePath: emptyPath,
    });
    const seeded = await seedAdapter.listModels();
    expect(seeded.some((m) => m.name === 'GLM-5.3-Flash')).toBe(true);
  });
});

describe('QwenAdapter native session files', () => {
  it('isNativeSessionAvailable finds ~/.qwen/projects/*/chats/<id>.jsonl', async () => {
    const home = join(tmpdir(), `qwen-home-${Date.now()}`);
    mkdirSync(join(home, 'projects', '-tmp', 'chats'), { recursive: true });
    writeFileSync(join(home, 'projects', '-tmp', 'chats', 'abc.jsonl'), '{}');
    const adapter = new QwenAdapter({ spawnFn: fakeChild().spawnFn, qwenHome: home });
    expect(await adapter.isNativeSessionAvailable('abc')).toBe(true);
    expect(await adapter.isNativeSessionAvailable('nope')).toBe(false);
    expect(await adapter.isNativeSessionAvailable('')).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('QwenAdapter turn stall watchdog', () => {
  const STALL_CFG = { sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'GLM-5.3-Flash' };

  it('a silent turn errors out instead of hanging: error, status:error, end, session/cancel sent', async () => {
    const { spawnFn, writes } = fakeChild({ holdPrompt: true });
    const adapter = new QwenAdapter({ spawnFn, stallTimeoutMs: 200 });
    const events = collect(adapter);
    await adapter.start(STALL_CFG);
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.sendPrompt('write a file');
    await new Promise((r) => setImmediate(r));

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent && errEvent.type === 'error' && errEvent.payload.message).toContain('stalled');
    expect(errEvent && errEvent.type === 'error' && errEvent.payload.message).toContain('GLM-5.3-Flash');
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(writes.some((w) => w.method === 'session/cancel' && w.id === undefined)).toBe(true);
    expect(ended).toBe(true);
  }, 5_000);

  it('streaming traffic resets the watchdog: a turn with periodic updates never stalls', async () => {
    const { proc, spawnFn, lastPromptId, resolvePrompt } = fakeChild({ holdPrompt: true });
    const notifyUpdate = (update: Record<string, unknown>) => {
      proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update } }) + '\n');
    };
    const adapter = new QwenAdapter({ spawnFn, stallTimeoutMs: 200 });
    const events = collect(adapter);
    await adapter.start(STALL_CFG);
    const promptP = adapter.sendPrompt('write a file');
    const iv = setInterval(() => {
      notifyUpdate({ sessionUpdate: 'usage_update', used: 1000, size: 1_000_000 });
    }, 60);
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(iv);
    notifyUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } });
    resolvePrompt(lastPromptId.value as number);
    await promptP;

    expect(events.some((e) => e.type === 'error' && String(e.payload.message).includes('stalled'))).toBe(false);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
  }, 5_000);

  it('captured agent stderr is appended to the stall error', async () => {
    const { proc, spawnFn } = fakeChild({ holdPrompt: true });
    const adapter = new QwenAdapter({ spawnFn, stallTimeoutMs: 200 });
    const events = collect(adapter);
    await adapter.start(STALL_CFG);
    proc.stderr.write('ERROR model quota exhausted\n');
    await adapter.sendPrompt('write a file');

    const errEvent = events.find((e) => e.type === 'error');
    const msg = errEvent && errEvent.type === 'error' ? errEvent.payload.message : '';
    expect(msg).toContain('stalled');
    expect(msg).toContain('Agent stderr (tail)');
    expect(msg).toContain('quota exhausted');
  }, 5_000);

  it('appends @<tempPath> image references to session/prompt text', async () => {
    const { writes, spawnFn } = fakeChild();
    const adapter = new QwenAdapter({ spawnFn });
    await adapter.start(STALL_CFG);
    await adapter.sendPrompt('describe this', [{
      mediaType: 'image/png',
      base64: 'iVBORw0KGgo=',
      tempPath: '/tmp/qwen-img-1.png',
    }]);

    const promptReq = writes.find((w) => w.method === 'session/prompt');
    const promptBlocks = (promptReq?.params as { prompt?: Array<{ text?: string }> })?.prompt;
    expect(promptBlocks?.[0]?.text).toContain('describe this');
    expect(promptBlocks?.[0]?.text).toContain('@/tmp/qwen-img-1.png');
  });
});
