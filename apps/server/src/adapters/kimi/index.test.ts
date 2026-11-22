import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { rmSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChildProcess } from 'child_process';
import type { NormalisedEvent } from '@tierwyn/shared';
import { KimiAdapter, normalizeKimiModelId } from './index.js';

type FakeProc = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (s?: string) => void;
};

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;

const KIMI_MODEL_OPTIONS = [
  { value: 'zai-coding-plan/glm-4.7', name: 'GLM-4.7' },
  { value: 'zai-coding-plan/glm-5-turbo', name: 'GLM-5-Turbo' },
  { value: 'zai-coding-plan/glm-5.2', name: 'GLM-5.2' },
  { value: 'zai-coding-plan/glm-5.2-highspeed', name: 'GLM-5.2 Highspeed' },
  { value: 'zai-coding-plan/glm-5.3', name: 'GLM-5.3' },
  { value: 'zai-coding-plan/glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { value: 'zai-coding-plan/glm-5.3-highspeed', name: 'GLM-5.3 Highspeed' },
];

const DEFAULT_CONFIG_OPTIONS = [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: 'zai-coding-plan/glm-5.3-flash',
    options: KIMI_MODEL_OPTIONS,
  },
  { type: 'select', id: 'thinking', name: 'Thinking', category: 'thinking', options: [{ value: 'high' }] },
  { type: 'select', id: 'mode', name: 'Mode', category: 'mode', options: [{ value: 'default' }] },
];

const KIMI_COMMANDS = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'status', description: 'Show status' },
  { name: 'usage', description: 'Show usage' },
  { name: 'mcp', description: 'MCP' },
  { name: 'tasks', description: 'Tasks' },
  { name: 'help', description: 'Help' },
];

function parseLines(buf: Buffer): Record<string, unknown>[] {
  return buf.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function fakeChild(opts: {
  loadSession?: boolean;
  holdPrompt?: boolean;
  configOptions?: unknown;
  omitConfigOptions?: boolean;
  sessions?: unknown[];
} = {}): {
  proc: FakeProc;
  writes: Record<string, unknown>[];
  killed: { value: boolean };
  resolvePrompt: (id: number | string, result?: unknown, error?: unknown) => void;
  lastPromptId: { value: number | string | null };
  spawnFn: SpawnFn;
  spawnCalls: Array<{ cmd: string; args: string[]; detached?: boolean }>;
  notify: (update: Record<string, unknown>, sessionId?: string) => void;
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
  const notify = (update: Record<string, unknown>, sessionId = 'session_kimi-1') => {
    stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update', params: { sessionId, update },
    }) + '\n');
  };

  stdin.on('data', (d: Buffer) => {
    for (const msg of parseLines(d)) {
      writes.push(msg);
      if (msg.id === undefined) continue;
      if (msg.method === 'initialize') {
        reply(msg.id, {
          protocolVersion: 1,
          agentInfo: { name: 'Kimi Code CLI', version: '0.39.1' },
          agentCapabilities: {
            loadSession: Boolean(opts.loadSession),
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            sessionCapabilities: { list: {}, resume: {} },
          },
        });
      } else if (msg.method === 'session/new') {
        const result: Record<string, unknown> = {
          sessionId: 'session_kimi-1',
          // Live Kimi 0.39.1: modes.availableModes includes default, plan, auto, yolo.
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'plan', name: 'Plan' },
              { id: 'auto', name: 'Auto' },
              { id: 'yolo', name: 'Yolo' },
            ],
          },
        };
        if (!opts.omitConfigOptions) {
          result.configOptions = opts.configOptions !== undefined ? opts.configOptions : DEFAULT_CONFIG_OPTIONS;
        }
        reply(msg.id, result);
      } else if (
        msg.method === 'session/load'
        || msg.method === 'session/set_model'
        || msg.method === 'session/set_mode'
      ) {
        reply(msg.id, {});
      } else if (msg.method === 'session/list') {
        reply(msg.id, { sessions: opts.sessions ?? [] });
      } else if (msg.method === 'session/prompt') {
        lastPromptId.value = msg.id as number;
        if (opts.holdPrompt) return;
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } });
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
    notify,
    resolvePrompt: (id, result, error) => {
      if (error) fail(id, error);
      else reply(id, result ?? { stopReason: 'end_turn' });
    },
  };
}

function collect(adapter: KimiAdapter): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return events;
}

const CFG = {
  sessionId: 'sx',
  conversationId: 'cx',
  cwd: '/tmp',
  model: 'kimi:zai-coding-plan/glm-5.3',
};

describe('normalizeKimiModelId', () => {
  it('strips a leaked kimi: prefix, converts colon form, and leaves slash/bare/empty alone', () => {
    expect(normalizeKimiModelId('kimi:zai-coding-plan/glm-5.3')).toBe('zai-coding-plan/glm-5.3');
    expect(normalizeKimiModelId('zai-coding-plan:glm-5.3')).toBe('zai-coding-plan/glm-5.3');
    expect(normalizeKimiModelId('zai-coding-plan/glm-5.3')).toBe('zai-coding-plan/glm-5.3');
    expect(normalizeKimiModelId('glm-5.3')).toBe('glm-5.3');
    expect(normalizeKimiModelId('')).toBe('');
  });
});

describe('KimiAdapter handshake', () => {
  it('spawns kimi acp detached (subcommand, not --acp)', async () => {
    const { spawnFn, spawnCalls } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    expect(spawnCalls[0]).toMatchObject({ cmd: 'kimi', args: ['acp'], detached: true });
  });

  it('sends initialize then session/new then set_model with the normalised id', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);

    const methods = writes.map((w) => w.method);
    expect(methods[0]).toBe('initialize');
    expect(methods).toContain('session/new');
    const sessionNew = writes.find((w) => w.method === 'session/new');
    expect((sessionNew?.params as { mcpServers?: unknown }).mcpServers).toEqual([]);
    expect(writes.find((w) => w.method === 'session/set_model')?.params).toMatchObject({
      sessionId: 'session_kimi-1',
      modelId: 'zai-coding-plan/glm-5.3',
    });
    expect(adapter.nativeSessionId).toBe('session_kimi-1');
  });

  it('never sends session/set_mode in bypass or prompt', async () => {
    for (const interactionMode of ['bypass', 'prompt'] as const) {
      const { spawnFn, writes } = fakeChild();
      const adapter = new KimiAdapter({ spawnFn, interactionMode });
      await adapter.start(CFG);
      expect(writes.every((w) => w.method !== 'session/set_mode')).toBe(true);
    }
  });

  it('resumes via session/load, skips session/new, and still set_model', async () => {
    const { spawnFn, writes } = fakeChild({ loadSession: true });
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start({ ...CFG, nativeSessionId: 'saved-native-id' });
    expect(writes.some((w) => w.method === 'session/load')).toBe(true);
    expect(writes.some((w) => w.method === 'session/new')).toBe(false);
    expect(writes.find((w) => w.method === 'session/set_model')?.params).toMatchObject({
      sessionId: 'saved-native-id',
      modelId: 'zai-coding-plan/glm-5.3',
    });
    expect(adapter.nativeSessionId).toBe('saved-native-id');
  });

  it('falls back to session/new when loadSession is false', async () => {
    const { spawnFn, writes } = fakeChild({ loadSession: false });
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start({ ...CFG, nativeSessionId: 'saved-native-id' });
    expect(writes.some((w) => w.method === 'session/load')).toBe(false);
    expect(writes.some((w) => w.method === 'session/new')).toBe(true);
  });

  it('does not emit load-replay notifications; usage_update still updates live context %', async () => {
    const { proc, spawnFn, notify } = fakeChild({ loadSession: true });
    const adapter = new KimiAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({ ...CFG, nativeSessionId: 'saved-native-id' });
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'saved-native-id',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } },
      },
    }) + '\n');
    notify({ sessionUpdate: 'usage_update', used: 25076, size: 1_000_000 }, 'saved-native-id');
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'message')).toBe(false);
    expect(adapter.getLiveContextWindowUsage().contextWindowPct).toBeCloseTo(2.5076, 4);
  });

  it('has no steer() method', async () => {
    const { spawnFn } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    expect(typeof (adapter as unknown as { steer?: unknown }).steer).toBe('undefined');
  });
});

describe('KimiAdapter turn', () => {
  it('happy turn: thought + message + tool frames + usage → final message + done with contextWindowPct', async () => {
    const { spawnFn, lastPromptId, notify, resolvePrompt } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start(CFG);
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    const promptP = adapter.sendPrompt('write a file');
    await new Promise((r) => setTimeout(r, 20));

    notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I will write' } });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    notify({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_write_1',
      status: 'pending',
      title: 'Write',
      kind: 'edit',
      rawInput: {},
    });
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_write_1',
      status: 'in_progress',
      title: 'Writing /tmp/kimi-probe/acp.txt',
      rawInput: { file_path: '/tmp/kimi-probe/acp.txt', content: 'hello' },
      locations: [{ path: '/tmp/kimi-probe/acp.txt' }],
    });
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_write_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'wrote' } }],
    });
    notify({ sessionUpdate: 'usage_update', used: 25076, size: 1_000_000 });
    await new Promise((r) => setImmediate(r));
    resolvePrompt(lastPromptId.value ?? 0, { stopReason: 'end_turn' });
    await promptP;

    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'I will write')).toBe(true);
    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'done')).toBe(true);
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall && toolCall.type === 'tool_call' && toolCall.payload.name).toBe('Write');
    expect(events.some((e) => e.type === 'tool_result' && e.payload.toolUseId === 'call_write_1')).toBe(true);
    const finalIdx = events.findIndex((e) => e.type === 'message' && e.payload.final === true);
    const doneIdx = events.findIndex((e) => e.type === 'status' && e.payload.status === 'done');
    expect(finalIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(finalIdx);
    const done = events[doneIdx];
    expect(done && done.type === 'status' && done.payload.contextWindowPct).toBeCloseTo(2.5076, 4);
    expect(ended).toBe(true);
  });

  it('thought-only turn reaches status:done (thought satisfies _sawMessageChunk)', async () => {
    const { spawnFn, lastPromptId, notify, resolvePrompt } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start(CFG);
    const promptP = adapter.sendPrompt('think');
    await new Promise((r) => setTimeout(r, 20));
    notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning' } });
    await new Promise((r) => setImmediate(r));
    resolvePrompt(lastPromptId.value ?? 0, { stopReason: 'end_turn' });
    await promptP;
    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'reasoning')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'error' && e.payload.message.includes('Kimi returned no output'))).toBe(false);
  });

  it('emits error + status:error when end_turn arrives with zero chunks', async () => {
    const { spawnFn, lastPromptId, resolvePrompt } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start(CFG);
    const promptP = adapter.sendPrompt('question');
    await new Promise((r) => setTimeout(r, 20));
    resolvePrompt(lastPromptId.value ?? 0, { stopReason: 'end_turn' });
    await promptP;
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(false);
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.payload.message).toMatch(/Kimi returned no output/);
    expect(err && err.type === 'error' && err.payload.message).toMatch(/provider\/model/);
    expect(err && err.type === 'error' && err.payload.message).toMatch(/kimi:zai-coding-plan\/glm-5\.3/);
  });

  it('emits error + status:error when session/prompt is rejected, and closes _accepting', async () => {
    const { spawnFn, lastPromptId, resolvePrompt, notify } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start(CFG);
    const promptP = adapter.sendPrompt('question');
    await new Promise((r) => setTimeout(r, 20));
    resolvePrompt(lastPromptId.value ?? 0, undefined, { message: 'prompt failed' });
    await promptP;
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    const before = events.filter((e) => e.type === 'message').length;
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stray' } });
    await new Promise((r) => setImmediate(r));
    expect(events.filter((e) => e.type === 'message').length).toBe(before);
  });

  it('interruptTurn sends session/cancel; cancelled stopReason is done and enters the steer loop', async () => {
    let resolveSteer!: (v: { text: string } | null) => void;
    const parked = new Promise<{ text: string } | null>((resolve) => { resolveSteer = resolve; });
    const { spawnFn, writes, killed, lastPromptId, resolvePrompt } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({ ...CFG, getNextSteer: () => parked });

    let ended = false;
    adapter.streamEvents().on('end', () => { ended = true; });
    const promptP = adapter.sendPrompt('spawn and wait');
    await new Promise((r) => setTimeout(r, 20));
    adapter.interruptTurn();
    await new Promise((r) => setImmediate(r));
    expect(writes.some((w) => w.method === 'session/cancel' && w.id === undefined)).toBe(true);
    resolvePrompt(lastPromptId.value ?? 0, { stopReason: 'cancelled' });
    await promptP;

    expect(killed.value).toBe(false);
    expect(ended).toBe(false);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    resolveSteer(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toBe(true);
  });

  it('steer loop sends a second session/prompt, a second done, then end exactly once', async () => {
    const queued: Array<{ text: string } | null> = [{ text: 'follow-up' }, null];
    const { spawnFn, writes } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    const events = collect(adapter);
    await adapter.start({
      ...CFG,
      getNextSteer: async () => queued.shift() ?? null,
    });
    let endCount = 0;
    adapter.streamEvents().on('end', () => { endCount++; });
    await adapter.sendPrompt('question');
    await new Promise((r) => setTimeout(r, 40));
    expect(writes.filter((w) => w.method === 'session/prompt')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'status' && e.payload.status === 'done')).toHaveLength(2);
    expect(endCount).toBe(1);
  });
});

describe('KimiAdapter commands', () => {
  it('available_commands_update populates listCommands; runCommand sends /name', async () => {
    const { spawnFn, writes, notify } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    notify({ sessionUpdate: 'available_commands_update', availableCommands: KIMI_COMMANDS });
    await new Promise((r) => setImmediate(r));
    const cmds = await adapter.listCommands();
    expect(cmds.map((c) => c.name)).toEqual(['compact', 'status', 'usage', 'mcp', 'tasks', 'help']);

    await adapter.runCommand('compact');
    const first = writes.filter((w) => w.method === 'session/prompt').at(-1);
    const firstPrompt = (first?.params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text;
    expect(firstPrompt).toBe('/compact');

    await adapter.runCommand('compact', 'now');
    const second = writes.filter((w) => w.method === 'session/prompt').at(-1);
    const secondPrompt = (second?.params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text;
    expect(secondPrompt).toBe('/compact now');
  });

  it('runCommand forwards permissionMode options into session/set_mode before the slash prompt', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    const setModeAtStart = writes.filter((w) => w.method === 'session/set_mode').length;
    await adapter.runCommand('compact', undefined, { permissionMode: 'yolo' });
    const methods = writes.map((w) => w.method);
    const promptIdx = methods.lastIndexOf('session/prompt');
    const lastSetModeIdx = methods.lastIndexOf('session/set_mode');
    expect(writes.filter((w) => w.method === 'session/set_mode').length).toBe(setModeAtStart + 1);
    expect(lastSetModeIdx).toBeLessThan(promptIdx);
    expect(writes[lastSetModeIdx]?.params).toMatchObject({
      sessionId: 'session_kimi-1',
      modeId: 'yolo',
    });
  });
});

describe('KimiAdapter prompt options', () => {
  it('yolo permissionMode emits session/set_mode yolo immediately before session/prompt', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    const setModeAtStart = writes.filter((w) => w.method === 'session/set_mode').length;
    await adapter.sendPrompt('question', undefined, undefined, undefined, { permissionMode: 'yolo' });

    const methods = writes.map((w) => w.method);
    const promptIdx = methods.lastIndexOf('session/prompt');
    const lastSetModeIdx = methods.lastIndexOf('session/set_mode');
    expect(writes.filter((w) => w.method === 'session/set_mode').length).toBe(setModeAtStart + 1);
    expect(lastSetModeIdx).toBeLessThan(promptIdx);
    expect(writes[lastSetModeIdx]?.params).toMatchObject({
      sessionId: 'session_kimi-1',
      modeId: 'yolo',
    });
  });

  it('default permissionMode does not emit extra set_mode (conversation setting)', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    const setModeAtStart = writes.filter((w) => w.method === 'session/set_mode').length;
    await adapter.sendPrompt('question', undefined, undefined, undefined, { permissionMode: 'default' });
    expect(writes.filter((w) => w.method === 'session/set_mode').length).toBe(setModeAtStart);
    expect(writes.some((w) => w.method === 'session/prompt')).toBe(true);
  });

  it('default-strict permissionMode emits session/set_mode default before session/prompt', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    const setModeAtStart = writes.filter((w) => w.method === 'session/set_mode').length;
    await adapter.sendPrompt('question', undefined, undefined, undefined, { permissionMode: 'default-strict' });

    const methods = writes.map((w) => w.method);
    const promptIdx = methods.lastIndexOf('session/prompt');
    const lastSetModeIdx = methods.lastIndexOf('session/set_mode');
    expect(writes.filter((w) => w.method === 'session/set_mode').length).toBe(setModeAtStart + 1);
    expect(lastSetModeIdx).toBeLessThan(promptIdx);
    expect(writes[lastSetModeIdx]?.params).toMatchObject({
      sessionId: 'session_kimi-1',
      modeId: 'default',
    });
  });

  it('auto permissionMode emits session/set_mode auto (advertised by session/new availableModes)', async () => {
    const { spawnFn, writes } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    const created = writes.find((w) => w.method === 'session/new');
    expect(created).toBeTruthy();
    await adapter.sendPrompt('question', undefined, undefined, undefined, { permissionMode: 'auto' });

    const methods = writes.map((w) => w.method);
    const promptIdx = methods.lastIndexOf('session/prompt');
    const lastSetModeIdx = methods.lastIndexOf('session/set_mode');
    expect(lastSetModeIdx).toBeLessThan(promptIdx);
    expect(writes[lastSetModeIdx]?.params).toMatchObject({
      sessionId: 'session_kimi-1',
      modeId: 'auto',
    });
  });
});

describe('KimiAdapter models', () => {
  it('listModels after start returns configOptions models and performs no extra spawn', async () => {
    const { spawnFn, spawnCalls } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn });
    await adapter.start(CFG);
    const before = spawnCalls.length;
    const models = await adapter.listModels();
    expect(spawnCalls.length).toBe(before);
    const glm53 = models.find((m) => m.name === 'zai-coding-plan/glm-5.3');
    expect(glm53).toMatchObject({
      name: 'zai-coding-plan/glm-5.3',
      label: 'Kimi Code · GLM-5.3',
      provider: 'z.ai',
      vision: true,
      steer: true,
      contextWindow: 1_000_000,
    });
    const glm47 = models.find((m) => m.name === 'zai-coding-plan/glm-4.7');
    expect(glm47?.contextWindow).toBe(204_800);
    expect(models).toHaveLength(7);
  });

  it('parses configOptions defensively without throwing', async () => {
    const cases: Array<{ label: string; opts: Parameters<typeof fakeChild>[0]; expectNames: string[] }> = [
      { label: 'undefined', opts: { omitConfigOptions: true }, expectNames: [] },
      { label: 'object', opts: { configOptions: {} }, expectNames: [] },
      { label: 'no model entry', opts: { configOptions: [{ id: 'thinking', options: [{ value: 'high' }] }] }, expectNames: [] },
      {
        label: 'mixed values',
        opts: {
          configOptions: [{
            id: 'model',
            options: [
              { value: 'zai-coding-plan/glm-5.3', name: 'GLM-5.3' },
              { value: 123 },
              { name: 'no-value' },
              { value: '' },
            ],
          }],
        },
        expectNames: ['zai-coding-plan/glm-5.3'],
      },
    ];
    for (const c of cases) {
      const { spawnFn } = fakeChild(c.opts);
      const adapter = new KimiAdapter({ spawnFn });
      await adapter.start(CFG);
      const available = (adapter as unknown as { _availableModels: { name: string }[] })._availableModels;
      expect(available.map((m) => m.name), c.label).toEqual(c.expectNames);
    }
  });

  it('listModels probe path: throwaway spawn, initialize + session/new, cache written, child killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-models-'));
    const cachePath = join(dir, 'kimi-models.json');
    const { spawnFn, spawnCalls, writes, killed } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn, modelsCachePath: cachePath, now: () => 42 });
    const models = await adapter.listModels();
    expect(spawnCalls).toHaveLength(1);
    expect(writes.map((w) => w.method)).toEqual(expect.arrayContaining(['initialize', 'session/new']));
    expect(models.find((m) => m.name === 'zai-coding-plan/glm-5.3')).toBeTruthy();
    expect(killed.value).toBe(true);
    const written = JSON.parse(readFileSync(cachePath, 'utf-8')) as { fetchedAt: number; models: { name: string }[] };
    expect(written.fetchedAt).toBe(42);
    expect(written.models).toHaveLength(7);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('KimiAdapter sessions', () => {
  const listed = [
    { sessionId: 'session_present', cwd: '/tmp', title: 'hello', updatedAt: '2026-08-30T12:00:00.000Z' },
    { sessionId: 'session_untitled', cwd: '/tmp', title: null, updatedAt: '2026-08-30T13:00:00.000Z' },
  ];

  it('listSessions maps title:null to (untitled) and parses updatedAt', async () => {
    const { spawnFn } = fakeChild({ sessions: listed });
    const adapter = new KimiAdapter({ spawnFn });
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([
      { id: 'session_present', summary: 'hello', createdAt: Date.parse('2026-08-30T12:00:00.000Z') },
      { id: 'session_untitled', summary: '(untitled)', createdAt: Date.parse('2026-08-30T13:00:00.000Z') },
    ]);
  });

  it('isNativeSessionAvailable scans session_index.jsonl', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
    writeFileSync(join(home, 'session_index.jsonl'), [
      '{"sessionId":"session_present","sessionDir":"/tmp/a","workDir":"/tmp"}',
      'not-json',
      '',
      '{"sessionId":"session_other","sessionDir":"/tmp/b","workDir":"/tmp"}',
    ].join('\n'));
    const adapter = new KimiAdapter({ kimiHome: home });
    expect(await adapter.isNativeSessionAvailable('session_present')).toBe(true);
    expect(await adapter.isNativeSessionAvailable('nope')).toBe(false);
    expect(await adapter.isNativeSessionAvailable('')).toBe(false);

    const missingHome = mkdtempSync(join(tmpdir(), 'kimi-home-missing-'));
    const missing = new KimiAdapter({ kimiHome: missingHome });
    expect(await missing.isNativeSessionAvailable('session_present')).toBe(false);

    rmSync(home, { recursive: true, force: true });
    rmSync(missingHome, { recursive: true, force: true });
  });
});

describe('KimiAdapter lifecycle', () => {
  it('stop() sends session/cancel, idle, kills the child, end; pending interaction is cancelled with two L\'s', async () => {
    const { proc, spawnFn, writes, killed } = fakeChild();
    const adapter = new KimiAdapter({ spawnFn, interactionMode: 'prompt' });
    const events = collect(adapter);
    await adapter.start(CFG);
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: {
        options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }],
        toolCall: { title: 'Write' },
      },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'interaction_request')).toBe(true);

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.stop();
    expect(writes.some((w) => w.method === 'session/cancel')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'idle')).toBe(true);
    const resolved = events.find((e) => e.type === 'interaction_resolved');
    expect(resolved && resolved.type === 'interaction_resolved' && resolved.payload.resolution).toBe('auto');
    const cancelReply = writes.find((w) => w.id === 7);
    expect(cancelReply).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
    expect(ended).toBe(true);
    expect(killed.value).toBe(true);
  });
});

describe('KimiAdapter turn stall watchdog', () => {
  it('a silent turn errors out instead of hanging: error names the model, status:error, end, session/cancel sent', async () => {
    const { spawnFn, writes } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn, stallTimeoutMs: 200 });
    const events = collect(adapter);
    await adapter.start(CFG);
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.sendPrompt('write a file');
    await new Promise((r) => setImmediate(r));

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent && errEvent.type === 'error' && errEvent.payload.message).toContain('stalled');
    expect(errEvent && errEvent.type === 'error' && errEvent.payload.message).toContain('zai-coding-plan/glm-5.3');
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    // Only one error: the no-output guard must not double-fire after a stall.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(writes.some((w) => w.method === 'session/cancel' && w.id === undefined)).toBe(true);
    expect(ended).toBe(true);
  }, 5_000);

  it('streaming traffic resets the watchdog: a turn with periodic updates never stalls', async () => {
    const { spawnFn, lastPromptId, notify, resolvePrompt } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn, stallTimeoutMs: 200 });
    const events = collect(adapter);
    await adapter.start(CFG);
    const promptP = adapter.sendPrompt('write a file');
    const iv = setInterval(() => {
      notify({ sessionUpdate: 'usage_update', used: 1000, size: 1_000_000 });
    }, 60);
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(iv);
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } });
    resolvePrompt(lastPromptId.value as number);
    await promptP;

    expect(events.some((e) => e.type === 'error' && String(e.payload.message).includes('stalled'))).toBe(false);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
  }, 5_000);

  it('a pending operator permission pauses the watchdog; stall resumes after the reply', async () => {
    const { proc, spawnFn, writes } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn, interactionMode: 'prompt', stallTimeoutMs: 200 });
    const events = collect(adapter);
    await adapter.start(CFG);
    const promptP = adapter.sendPrompt('write a file');
    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: {
        options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }],
        toolCall: { title: 'Write' },
      },
    }) + '\n');
    await new Promise((r) => setImmediate(r));
    const interaction = events.find((e) => e.type === 'interaction_request');
    expect(interaction && interaction.type === 'interaction_request').toBe(true);
    const requestId = interaction && interaction.type === 'interaction_request' ? interaction.payload.requestId : '';

    // Parked on human input far past the stall bound — must stay quiet.
    await new Promise((r) => setTimeout(r, 450));
    expect(events.some((e) => e.type === 'error')).toBe(false);

    adapter.respondToInteraction(requestId, { selection: ['allow-once'] });
    await new Promise((r) => setImmediate(r));
    expect(writes.find((w) => w.id === 7)).toMatchObject({ result: { outcome: { outcome: 'selected' } } });

    // Traffic stops after the reply — the watchdog now fires.
    await promptP;
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent && errEvent.type === 'error' && errEvent.payload.message).toContain('stalled');
  }, 5_000);

  it('captured agent stderr is appended to the stall error', async () => {
    const { proc, spawnFn } = fakeChild({ holdPrompt: true });
    const adapter = new KimiAdapter({ spawnFn, stallTimeoutMs: 200 });
    const events = collect(adapter);
    await adapter.start(CFG);
    proc.stderr.write('ERROR quota exceeded for glm-5.3-highspeed\n');
    await adapter.sendPrompt('write a file');

    const errEvent = events.find((e) => e.type === 'error');
    const msg = errEvent && errEvent.type === 'error' ? errEvent.payload.message : '';
    expect(msg).toContain('stalled');
    expect(msg).toContain('Agent stderr (tail)');
    expect(msg).toContain('quota exceeded');
  }, 5_000);
});
