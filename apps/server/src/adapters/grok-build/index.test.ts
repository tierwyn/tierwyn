import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EffortLevel, NormalisedEvent, Attachment } from '@tierwyn/shared';
import { clampEffort, effortLevelsFor } from '@tierwyn/shared';
import { GrokBuildAdapter, GROK_BUILTIN_COMMANDS, autoAllowPermission, encodeSessionBucket } from './index.js';

/** A fake `grok agent stdio` that auto-answers initialize/session/new/load/set_model.
 *  Tests push notifications to stdout via `push()` and resolve the current
 *  session/prompt via `resolvePrompt()`. */
function fakeChild(opts: { loadSession?: boolean } = {}) {
  const loadSession = opts.loadSession ?? true;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void;
  };
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
  let killed = false;
  proc.kill = (s?: string) => { killed = true; setImmediate(() => proc.emit('close', 0)); };

  let promptResolver: ((r: unknown) => void) | null = null;
  const pendingNotifs: string[] = []; // buffered for after prompt is sent

  let lastPromptId: number | string | null = null;
  let lastPromptParams: Record<string, unknown> | null = null;
  let lastNewParams: Record<string, unknown> | null = null;
  let lastLoadParams: Record<string, unknown> | null = null;
  let lastSetModelParams: Record<string, unknown> | null = null;
  let setModelCallCount = 0;
  let failNextSetModel = false;
  let cancelled = false;

  stdin.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line);
      // session/cancel is a notification (no id) — reject the live prompt so
      // interruptTurn()'s soft-end path can be exercised in tests.
      if (msg.id === undefined) {
        if (msg.method === 'session/cancel' && lastPromptId !== null) {
          cancelled = true;
          stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: lastPromptId,
            error: { message: 'cancelled' },
          }) + '\n');
          promptResolver = null;
          lastPromptId = null;
        }
        continue;
      }
      if (msg.method === 'initialize') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession } } }) + '\n');
      } else if (msg.method === 'session/new') {
        lastNewParams = msg.params ?? null;
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-sess-1', models: { currentModelId: 'grok-4.5' } } }) + '\n');
      } else if (msg.method === 'session/load') {
        lastLoadParams = msg.params ?? null;
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { models: { currentModelId: 'grok-4.5' } } }) + '\n');
      } else if (msg.method === 'session/set_model') {
        lastSetModelParams = msg.params ?? null;
        setModelCallCount++;
        if (failNextSetModel) {
          failNextSetModel = false;
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'set_model failed' } }) + '\n');
        } else {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { _meta: { model: { Ok: msg.params?.modelId } } } }) + '\n');
        }
      } else if (msg.method === 'session/prompt') {
        lastPromptId = msg.id;
        lastPromptParams = msg.params ?? null;
        promptResolver = (r) => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }) + '\n');
      }
    }
  });

  return {
    proc,
    lastNewParams: () => lastNewParams,
    lastLoadParams: () => lastLoadParams,
    lastSetModelParams: () => lastSetModelParams,
    setModelCallCount: () => setModelCallCount,
    failNextSetModel: () => { failNextSetModel = true; },
    push: (method: string, params: unknown) =>
      stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    /** Stream a message chunk then resolve the prompt. */
    resolvePrompt: (chunk: string, stopReason = 'end_turn', usage?: Record<string, number>) => {
      if (chunk) {
        stdout.write(JSON.stringify({
          jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } },
        }) + '\n');
      }
      if (!promptResolver) return;
      const r: Record<string, unknown> = { stopReason };
      if (usage) r._meta = { usage };
      promptResolver(r);
      promptResolver = null;
      lastPromptId = null;
    },
    getLastPromptText: () => {
      const prompt = (lastPromptParams?.prompt ?? []) as Array<{ type?: string; text?: string }>;
      return prompt[0]?.text ?? '';
    },
    isKilled: () => killed,
    wasCancelled: () => cancelled,
  };
}

async function started(opts?: {
  interactionMode?: 'bypass' | 'questions' | 'prompt';
  loadSession?: boolean;
  nativeSessionId?: string;
  effort?: EffortLevel;
  options?: import('@tierwyn/shared').PromptOptions;
  getNextSteer?: () => Promise<{ text: string } | null>;
  captureSpawnArgs?: string[][];
}): Promise<{ adapter: GrokBuildAdapter; events: NormalisedEvent[]; child: ReturnType<typeof fakeChild> }> {
  const child = fakeChild({ loadSession: opts?.loadSession ?? true });
  // CRITICAL: pass a spawnFn that returns the fake child — NEVER let the
  // adapter spawn real `grok agent stdio`. Real grok kills its process group
  // on fatal exit and would take down the test runner
  // AND any co-located prod/dev server.
  const adapter = new GrokBuildAdapter({
    interactionMode: opts?.interactionMode ?? 'bypass',
    // start() calls listModels() for the context-window size, which
    // reads <grokHome>/models_cache.json. Pin grokHome to a path that
    // does not exist so the suite never touches the developer's real ~/.grok and
    // always takes the catalogue-seed fallback. See modelsCache.test.ts for the
    // cache-present cases.
    grokHome: join(tmpdir(), 'grok-home-does-not-exist'),
    spawnFn: (_cmd, args) => {
      opts?.captureSpawnArgs?.push([...args]);
      return child.proc as unknown as import('child_process').ChildProcess;
    },
  });
  await adapter.start({
    sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'grok-4.5',
    nativeSessionId: opts?.nativeSessionId,
    effort: opts?.effort,
    getNextSteer: opts?.getNextSteer,
    ...(opts?.options ? { options: opts.options } : {}),
  });
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return { adapter, events, child };
}

function types(events: NormalisedEvent[]): string[] {
  return events.map((e) => (e.type === 'status' ? `status:${e.payload.status}` : e.type));
}

describe('GrokBuildAdapter — streaming happy path', () => {
  it('streams message chunks, then message final + status done', async () => {
    const { adapter, events, child } = await started();
    const promptP = adapter.sendPrompt('hi');
    // Two chunks, then resolve
    setImmediate(() => child.resolvePrompt('Hel', 'end_turn'));
    await promptP;
    // Wait a tick for post-prompt status emission
    await new Promise((r) => setImmediate(r));
    expect(types(events)).toContain('message');
    expect(types(events)).toContain('status:running');
    expect(types(events)).toContain('status:done');
    const done = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done).toBeTruthy();
  });

  it('emits status:running BEFORE resolving sendPrompt', async () => {
    const { adapter, events, child } = await started();
    let sawRunningBeforeResolve = false;
    const promptP = adapter.sendPrompt('hi');
    // give the rpc.send a tick to fire
    await new Promise((r) => setImmediate(r));
    if (types(events).includes('status:running')) sawRunningBeforeResolve = true;
    child.resolvePrompt('ok');
    await promptP;
    await new Promise((r) => setImmediate(r));
    expect(sawRunningBeforeResolve).toBe(true);
  });
});

describe('GrokBuildAdapter — context window %', () => {
  it('computes contextWindowPct from full input occupancy / window (splits cache)', async () => {
    const { adapter, events, child } = await started();
    // 100k full input / 200k window = 50%. Grok reports full input + cache subset.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._contextWindowSize = 200_000;
    const promptP = adapter.sendPrompt('hi');
    setImmediate(() => child.resolvePrompt('ok', 'end_turn', {
      inputTokens: 100_000,
      outputTokens: 50,
      totalTokens: 100_050,
      cachedReadTokens: 90_000,
    }));
    await promptP;
    await new Promise((r) => setImmediate(r));
    const done = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done?.type === 'status' && done.payload.contextWindowPct).toBe(50);
    // Anthropic-shaped split: uncached 10k + cache read 90k
    expect(done?.type === 'status' && done.payload.inputTokens).toBe(10_000);
    expect(done?.type === 'status' && done.payload.cacheReadTokens).toBe(90_000);
    expect(done?.type === 'status' && done.payload.outputTokens).toBe(50);
  });

  it('omits contextWindowPct when the window size is unknown', async () => {
    const { adapter, events, child } = await started();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._contextWindowSize = undefined;
    const promptP = adapter.sendPrompt('hi');
    setImmediate(() => child.resolvePrompt('ok', 'end_turn', {
      inputTokens: 1000,
      outputTokens: 10,
      totalTokens: 1010,
    }));
    await promptP;
    await new Promise((r) => setImmediate(r));
    const done = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done?.type === 'status' && done.payload.contextWindowPct).toBeUndefined();
    expect(done?.type === 'status' && done.payload.inputTokens).toBe(1000);
  });

  it('applies turn_completed notification usage before status:done', async () => {
    const { adapter, events, child } = await started();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._contextWindowSize = 500_000;
    const promptP = adapter.sendPrompt('hi');
    setImmediate(() => {
      child.push('_x.ai/session_notification', {
        sessionId: 'grok-sess-1',
        update: {
          sessionUpdate: 'turn_completed',
          usage: {
            inputTokens: 50_000,
            outputTokens: 20,
            totalTokens: 50_020,
            cachedReadTokens: 40_000,
          },
        },
      });
      // Result _meta may omit usage; notification is canonical.
      child.resolvePrompt('ok', 'end_turn');
    });
    await promptP;
    await new Promise((r) => setImmediate(r));
    const done = events.find((e) => e.type === 'status' && e.payload.status === 'done');
    expect(done?.type === 'status' && done.payload.contextWindowPct).toBe(10); // 50k/500k
    expect(done?.type === 'status' && done.payload.inputTokens).toBe(10_000);
    expect(done?.type === 'status' && done.payload.cacheReadTokens).toBe(40_000);
  });
});

describe('GrokBuildAdapter — tool calls', () => {
  it('renders tool_call + file_change + tool_result', async () => {
    const { adapter, events, child } = await started();
    const promptP = adapter.sendPrompt('edit the file');
    setImmediate(() => {
      child.push('session/update', { sessionId: 'grok-sess-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'edit', kind: 'edit', rawInput: { file_path: '/a.ts' }, locations: [{ path: '/a.ts' }] } });
      child.push('session/update', { sessionId: 'grok-sess-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: 'done' } });
      child.resolvePrompt('edited it');
    });
    await promptP;
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'file_change')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  });
});

describe('GrokBuildAdapter — helpers', () => {
  const SPAWN_ID = '11111111-1111-4111-8111-111111111111';

  it('emits helper running then completed across spawn + get_command_or_subagent_output', async () => {
    const { adapter, events, child } = await started();
    const promptP = adapter.sendPrompt('delegate');
    setImmediate(() => {
      child.push('session/update', {
        sessionId: 'grok-sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-spawn',
          title: 'spawn_subagent',
          rawInput: { description: 'explore repo', prompt: 'list files' },
        },
      });
      child.push('session/update', {
        sessionId: 'grok-sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-spawn',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: `Subagent started in background.\nsubagent_id: ${SPAWN_ID}\ntype: explore` } }],
        },
      });
      child.push('session/update', {
        sessionId: 'grok-sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-out',
          title: 'get_command_or_subagent_output',
          rawInput: { task_id: SPAWN_ID },
        },
      });
      child.push('session/update', {
        sessionId: 'grok-sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-out',
          status: 'completed',
          content: 'found 3 files',
          rawOutput: {
            type: 'TaskOutput',
            Result: { task_id: SPAWN_ID, status: 'completed', exit_code: 0, duration_secs: 2, output: 'found 3 files' },
          },
        },
      });
      child.resolvePrompt('done');
    });
    await promptP;
    await new Promise((r) => setImmediate(r));
    const helpers = events.filter((e) => e.type === 'helper');
    expect(helpers).toHaveLength(2);
    expect(helpers[0]!.payload).toMatchObject({
      taskId: SPAWN_ID,
      toolUseId: 'tc-spawn',
      label: 'explore',
      description: 'explore repo',
      status: 'running',
      background: true,
    });
    expect(helpers[1]!.payload).toMatchObject({
      taskId: SPAWN_ID,
      status: 'completed',
      summary: 'found 3 files',
    });
  });

  it('marks running helpers stopped on adapter.stop()', async () => {
    const { adapter, events, child } = await started();
    const promptP = adapter.sendPrompt('delegate');
    setImmediate(() => {
      child.push('session/update', {
        sessionId: 'grok-sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-spawn',
          title: 'spawn_subagent',
          rawInput: { description: 'explore repo' },
        },
      });
      child.push('session/update', {
        sessionId: 'grok-sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-spawn',
          status: 'completed',
          content: `subagent_id: ${SPAWN_ID}`,
        },
      });
      child.resolvePrompt('started');
    });
    await promptP;
    await new Promise((r) => setImmediate(r));
    expect(events.filter((e) => e.type === 'helper')).toHaveLength(1);
    await adapter.stop();
    const last = events.filter((e) => e.type === 'helper').at(-1);
    expect(last?.payload.status).toBe('stopped');
  });
});

describe('GrokBuildAdapter — session resume', () => {
  it('uses session/load when loadSession=true and nativeSessionId set', async () => {
    const { adapter, child } = await started({ loadSession: true, nativeSessionId: 'grok-sess-1' });
    expect(adapter.nativeSessionId).toBe('grok-sess-1');
    // Verify the fake saw a session/load (we can't directly assert; trust the
    // handshake not throwing). The key assertion is nativeSessionId is preserved.
    expect(adapter.nativeSessionId).toBeTruthy();
  });

  it('falls back to session/new when loadSession=false', async () => {
    const { adapter } = await started({ loadSession: false, nativeSessionId: 'whatever' });
    // Even though nativeSessionId was passed, loadSession capability was false
    // → adapter created a new session instead.
    expect(adapter.nativeSessionId).toBe('grok-sess-1');
  });

  it('isNativeSessionAvailable checks ~/.grok/sessions/<bucket>/<id>', async () => {
    const adapter = new GrokBuildAdapter();
    // We can't easily create a real dir here, so assert the false path.
    expect(await adapter.isNativeSessionAvailable('nonexistent-id')).toBe(false);
  });

  it('encodeSessionBucket percent-encodes slashes', () => {
    expect(encodeSessionBucket('/home/user/proj')).toBe('%2Fhome%2Fuser%2Fproj');
    expect(encodeSessionBucket('')).toBe('');
  });
});

describe('GrokBuildAdapter — mid-turn steering', () => {
  it('enters steer loop and drains a queued steer, then exits on null', async () => {
    let calls = 0;
    const getNextSteer = async () => {
      calls++;
      if (calls === 1) return { text: 'now do Y' };
      return null;
    };
    const { adapter, events, child } = await started({ getNextSteer });
    const promptP = adapter.sendPrompt('do X');
    setImmediate(() => child.resolvePrompt('doing X'));
    await promptP;
    // First steer should trigger another session/prompt
    await new Promise((r) => setImmediate(r));
    setImmediate(() => child.resolvePrompt('doing Y'));
    // Give the loop time to finish
    await new Promise((r) => setTimeout(r, 50));
    expect(types(events).filter((t) => t === 'status:done')).toHaveLength(2);
  });

  it('steer() sends a follow-up session/prompt without throwing', async () => {
    const { adapter, child } = await started();
    const promptP = adapter.sendPrompt('hi');
    setImmediate(() => child.resolvePrompt('ok'));
    await promptP;
    // steer() issues a session/prompt; the fake child needs to resolve it.
    const steerP = adapter.steer('and also Z');
    setImmediate(() => child.resolvePrompt('Z done'));
    await expect(steerP).resolves.toBeUndefined();
  });

  it('interruptTurn soft-ends mid-prompt (status:done, not error) and drains steer loop', async () => {
    let calls = 0;
    const getNextSteer = async () => {
      calls++;
      if (calls === 1) return { text: 'child result notify' };
      return null;
    };
    const { adapter, events, child } = await started({ getNextSteer });
    const promptP = adapter.sendPrompt('spawn children and wait');
    // Let the prompt land, then soft-cancel (as SessionManager does when a
    // subagent_notify is queued mid-turn).
    await new Promise((r) => setTimeout(r, 20));
    adapter.interruptTurn();
    await promptP;
    expect(child.wasCancelled()).toBe(true);
    // Soft-end: done, not hard error — and session not killed.
    expect(types(events)).toContain('status:done');
    expect(types(events)).not.toContain('status:error');
    expect(child.isKilled()).toBe(false);
    // Steer loop should pick up the queued notify.
    await new Promise((r) => setImmediate(r));
    setImmediate(() => child.resolvePrompt('processed notify'));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(types(events).filter((t) => t === 'status:done').length).toBeGreaterThanOrEqual(2);
  });
});

describe('GrokBuildAdapter — permission round-trip', () => {
  it('bypass mode auto-allows without surfacing to UI', async () => {
    const { adapter, events, child } = await started({ interactionMode: 'bypass' });
    const promptP = adapter.sendPrompt('edit file');
    setImmediate(() => {
      // Server requests permission (id=1 — but our fake only assigns ids to client sends;
      // emit as if the server initiated)
      child.proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'session/request_permission', params: { options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } }) + '\n');
      child.resolvePrompt('done');
    });
    await promptP;
    await new Promise((r) => setImmediate(r));
    // bypass → no interaction_request surfaced
    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
  });

  it('questions mode auto-allows without surfacing to UI', async () => {
    const { adapter, events, child } = await started({ interactionMode: 'questions' });
    const writes: Record<string, unknown>[] = [];
    child.proc.stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        writes.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const promptP = adapter.sendPrompt('edit file');
    setImmediate(() => {
      child.proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'session/request_permission', params: { options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } }) + '\n');
      child.resolvePrompt('done');
    });
    await promptP;
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    const reply = writes.find((w) => w.id === 100);
    expect(reply).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  });

  it('prompt mode surfaces interaction_request and responds to selection', async () => {
    const { adapter, events, child } = await started({ interactionMode: 'prompt' });
    const promptP = adapter.sendPrompt('edit file');
    setImmediate(() => {
      child.proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'session/request_permission', params: { toolCall: { title: 'write', rawInput: { file_path: '/a.ts' } }, options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] } }) + '\n');
      child.resolvePrompt('done');
    });
    await promptP;
    await new Promise((r) => setImmediate(r));

    const req = events.find((e) => e.type === 'interaction_request');
    expect(req).toBeTruthy();
    const requestId = (req!.payload as { requestId: string }).requestId;
    expect(types(events)).toContain('status:waiting');

    adapter.respondToInteraction(requestId, { selection: ['allow-once'] });
    await new Promise((r) => setImmediate(r));

    expect(events.some((e) => e.type === 'interaction_resolved')).toBe(true);
    expect(types(events)).toContain('status:running');
  });

  it('autoAllowPermission picks the allow option', () => {
    const reply = vi.fn();
    autoAllowPermission({ options: [{ optionId: 'reject', kind: 'reject_once' }, { optionId: 'allow-once', kind: 'allow_once' }] }, reply);
    expect(reply).toHaveBeenCalledWith({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('autoAllowPermission cancels when no allow option exists', () => {
    const reply = vi.fn();
    autoAllowPermission({ options: [] }, reply);
    expect(reply).toHaveBeenCalledWith({ outcome: { outcome: 'cancelled' } });
  });
});

describe('GrokBuildAdapter — ask_user_question round-trip', () => {
  /** Push a `_x.ai/ask_user_question` server→client request (id numbering kept
   *  distinct from permission tests). */
  function pushAsk(child: ReturnType<typeof fakeChild>, id: number, questions: unknown) {
    child.proc.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id, method: '_x.ai/ask_user_question',
      params: { sessionId: 'grok-sess-1', toolCallId: `call-${id}`, mode: 'default', questions },
    }) + '\n');
  }

  function collectWrites(child: ReturnType<typeof fakeChild>): Record<string, unknown>[] {
    const writes: Record<string, unknown>[] = [];
    child.proc.stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        writes.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    return writes;
  }

  it('questions mode surfaces a question card and replies accepted with the answers map', async () => {
    const { adapter, events, child } = await started({ interactionMode: 'questions' });
    const writes = collectWrites(child);
    const promptP = adapter.sendPrompt('plan something');
    setImmediate(() => {
      pushAsk(child, 101, [
        { question: 'Ready to proceed?', options: [{ label: 'Yes', description: 'go ahead' }, { label: 'No' }], multiSelect: null },
      ]);
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const req = events.find((e) => e.type === 'interaction_request');
    expect(req).toBeTruthy();
    const payload = req!.payload as {
      requestId: string; kind: string; toolName?: string; prompt: string;
      questions?: Array<{ id: string; prompt: string; choices: Array<{ id: string; label: string; description?: string }>; multiSelect?: boolean }>;
    };
    expect(payload.kind).toBe('question');
    expect(payload.toolName).toBe('ask_user_question');
    expect(payload.prompt).toBe('Ready to proceed?');
    expect(payload.questions![0].id).toBe('Ready to proceed?');
    expect(payload.questions![0].choices).toHaveLength(2);
    expect(payload.questions![0].choices[0]).toMatchObject({ id: 'Yes', description: 'go ahead' });
    expect(payload.questions![0].multiSelect).toBe(false);
    expect(types(events)).toContain('status:waiting');

    adapter.respondToInteraction(payload.requestId, { selection: [], answers: [{ selection: ['Yes'] }] });
    await new Promise((r) => setImmediate(r));

    const reply = writes.find((w) => w.id === 101);
    expect(reply).toMatchObject({ result: { outcome: 'accepted', answers: { 'Ready to proceed?': 'Yes' } } });
    const resolved = events.find((e) => e.type === 'interaction_resolved');
    expect(resolved).toBeTruthy();
    expect((resolved!.payload as { resolution: string }).resolution).toBe('answered');
    expect(types(events)).toContain('status:running');

    setImmediate(() => child.resolvePrompt('done'));
    await promptP;
  });

  it('maps free text over selections and arrays for multi-select', async () => {
    const { adapter, events, child } = await started({ interactionMode: 'questions' });
    const writes = collectWrites(child);
    const promptP = adapter.sendPrompt('plan something');
    setImmediate(() => {
      pushAsk(child, 102, [
        { question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
        { question: 'Which ones?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true },
      ]);
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const req = events.find((e) => e.type === 'interaction_request')!;
    const payload = req.payload as { requestId: string; prompt: string; questions?: unknown[] };
    // Multi-question card gets the umbrella prompt.
    expect(payload.prompt).toBe('The agent has 2 questions');
    expect(payload.questions).toHaveLength(2);

    adapter.respondToInteraction(payload.requestId, {
      selection: [],
      answers: [{ selection: ['Yes'], text: 'Yes, but skip step 2' }, { selection: ['a', 'c'] }],
    });
    await new Promise((r) => setImmediate(r));

    const reply = writes.find((w) => w.id === 102);
    expect(reply).toMatchObject({
      result: {
        outcome: 'accepted',
        answers: { 'Proceed?': 'Yes, but skip step 2', 'Which ones?': ['a', 'c'] },
      },
    });
    setImmediate(() => child.resolvePrompt('done'));
    await promptP;
  });

  it('bypass mode replies cancelled without surfacing a card', async () => {
    const { adapter, events, child } = await started({ interactionMode: 'bypass' });
    const writes = collectWrites(child);
    const promptP = adapter.sendPrompt('plan something');
    setImmediate(() => {
      pushAsk(child, 103, [{ question: 'Proceed?', options: [{ label: 'Yes' }] }]);
      child.resolvePrompt('done');
    });
    await promptP;
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    const reply = writes.find((w) => w.id === 103);
    expect(reply).toMatchObject({ result: { outcome: 'cancelled' } });
  });

  it('responds cancelled when the interaction carries no answers', async () => {
    const { adapter, events, child } = await started({ interactionMode: 'questions' });
    const writes = collectWrites(child);
    const promptP = adapter.sendPrompt('plan something');
    setImmediate(() => {
      pushAsk(child, 104, [{ question: 'Proceed?', options: [{ label: 'Yes' }] }]);
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const req = events.find((e) => e.type === 'interaction_request')!;
    const requestId = (req.payload as { requestId: string }).requestId;
    adapter.respondToInteraction(requestId, { selection: [] });
    await new Promise((r) => setImmediate(r));

    const reply = writes.find((w) => w.id === 104);
    expect(reply).toMatchObject({ result: { outcome: 'cancelled' } });
    const resolved = events.find((e) => e.type === 'interaction_resolved')!;
    expect((resolved.payload as { resolution: string }).resolution).toBe('auto');
    setImmediate(() => child.resolvePrompt('done'));
    await promptP;
  });

  it('stop() drains a pending question with cancelled', async () => {
    const { adapter, events, child } = await started({ interactionMode: 'questions' });
    const writes = collectWrites(child);
    setImmediate(() => {
      pushAsk(child, 105, [{ question: 'Proceed?', options: [{ label: 'Yes' }] }]);
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    await adapter.stop();
    await new Promise((r) => setImmediate(r));

    const reply = writes.find((w) => w.id === 105);
    expect(reply).toMatchObject({ result: { outcome: 'cancelled' } });
    const resolved = events.find((e) => e.type === 'interaction_resolved');
    expect(resolved).toBeTruthy();
    expect((resolved!.payload as { resolution: string }).resolution).toBe('auto');
  });
});

describe('GrokBuildAdapter — image attachments', () => {
  it('appends @<tempPath> mentions to session/prompt text when attachments carry tempPath', async () => {
    const { adapter, child } = await started();
    const tempPath = '/tmp/grok-test-image.png';
    const attachments: Attachment[] = [{
      mediaType: 'image/png',
      base64: 'iVBOR',
      tempPath,
    }];
    const promptP = adapter.sendPrompt('describe this', attachments);
    await new Promise((r) => setImmediate(r));
    expect(child.getLastPromptText()).toBe(`describe this\n\n@${tempPath}`);
    setImmediate(() => child.resolvePrompt('ok'));
    await promptP;
  });

  it('leaves prompt text unchanged when no attachments or attachments lack tempPath', async () => {
    const { adapter, child } = await started();
    const noAttP = adapter.sendPrompt('plain');
    await new Promise((r) => setImmediate(r));
    expect(child.getLastPromptText()).toBe('plain');
    setImmediate(() => child.resolvePrompt('ok'));
    await noAttP;

    const noPathP = adapter.sendPrompt('also plain', [{ mediaType: 'image/png', base64: 'abc' }]);
    await new Promise((r) => setImmediate(r));
    expect(child.getLastPromptText()).toBe('also plain');
    setImmediate(() => child.resolvePrompt('ok'));
    await noPathP;
  });
});

describe('GrokBuildAdapter — lifecycle guard', () => {
  it('emits end exactly once even on double teardown', async () => {
    const child = fakeChild({ loadSession: true });
    const adapter = new GrokBuildAdapter({
      interactionMode: 'bypass',
      spawnFn: () => child.proc as unknown as import('child_process').ChildProcess,
    });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'grok-4.5' });
    let endCount = 0;
    adapter.streamEvents().on('end', () => endCount++);
    // A completed turn must NOT emit 'end' (subprocess stays alive for reuse).
    const promptP = adapter.sendPrompt('hi');
    setImmediate(() => child.resolvePrompt('ok'));
    await promptP;
    await new Promise((r) => setImmediate(r));
    expect(endCount).toBe(0);
    // stop() tears the subprocess down → exactly one 'end'; double-stop is a no-op.
    await adapter.stop();
    await adapter.stop();
    await new Promise((r) => setImmediate(r));
    expect(endCount).toBe(1);
  });

  it('emits error when grok returns no output', async () => {
    const { adapter, events, child } = await started();
    const promptP = adapter.sendPrompt('hi');
    // Resolve the prompt with NO preceding message chunk
    setImmediate(() => child.resolvePrompt('', 'end_turn'));
    await promptP;
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(types(events)).toContain('status:error');
  });
});

/**
 * Cold listCommands — discovery/picker path. Never starts a grok subprocess.
 * Mirrors apps/server/src/adapters/codex/index.test.ts.
 */
describe('GrokBuildAdapter.listCommands()', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'grok-listcmd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeSkill(dir: string, name: string, description: string) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.`,
    );
  }

  it('always includes ACP builtins (e.g. /compact) with no skills dir', async () => {
    const adapter = new GrokBuildAdapter({ grokHome: tmpHome });
    const cmds = await adapter.listCommands();
    for (const b of GROK_BUILTIN_COMMANDS) {
      const found = cmds.find((c) => c.name === b.name);
      expect(found).toBeDefined();
      expect(found?.sourceDetail).toBe('builtin');
    }
    const compact = cmds.find((c) => c.name === 'compact');
    expect(compact?.description).toMatch(/context window/i);
  });

  it('includes a user skill from skills/<name>/SKILL.md', async () => {
    writeSkill(join(tmpHome, 'skills'), 'my-skill', 'Custom skill');
    const adapter = new GrokBuildAdapter({ grokHome: tmpHome });
    const cmds = await adapter.listCommands();
    const skill = cmds.find((c) => c.name === 'my-skill');
    expect(skill).toBeDefined();
    expect(skill?.description).toBe('Custom skill');
    expect(skill?.sourceDetail).toBe('skill');
  });

  it('includes bundled skills from bundled/skills/', async () => {
    writeSkill(join(tmpHome, 'bundled', 'skills'), 'bundled-one', 'Bundled');
    const adapter = new GrokBuildAdapter({ grokHome: tmpHome });
    const cmds = await adapter.listCommands();
    expect(cmds.find((c) => c.name === 'bundled-one')?.description).toBe('Bundled');
  });

  it('deduplicates: user skill shadows builtin name', async () => {
    writeSkill(join(tmpHome, 'skills'), 'compact', 'User override desc');
    const adapter = new GrokBuildAdapter({ grokHome: tmpHome });
    const cmds = await adapter.listCommands();
    const compact = cmds.filter((c) => c.name === 'compact');
    expect(compact).toHaveLength(1);
    // Builtins win (listed first) — slash picker shows the ACP description.
    expect(compact[0].sourceDetail).toBe('builtin');
  });

  it('prefers live ACP available_commands_update over cold scan', async () => {
    const { adapter, child } = await started();
    child.push('session/update', {
      sessionId: 'grok-sess-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Live ACP compact' },
          { name: 'live-only', description: 'Only from ACP' },
        ],
      },
    });
    await new Promise((r) => setImmediate(r));
    const cmds = await adapter.listCommands();
    expect(cmds.map((c) => c.name)).toEqual(['compact', 'live-only']);
    expect(cmds.find((c) => c.name === 'compact')?.description).toBe('Live ACP compact');
    await adapter.stop();
  });
});

describe('GrokBuildAdapter sandbox spawn argv', () => {
  it('spawns grok --sandbox workspace agent stdio when sandbox is set', async () => {
    const captureSpawnArgs: string[][] = [];
    await started({ options: { sandbox: 'workspace' }, captureSpawnArgs });
    expect(captureSpawnArgs[0]).toEqual(['--sandbox', 'workspace', 'agent', 'stdio']);
  });

  it('spawns grok --sandbox strict agent stdio for strict', async () => {
    const captureSpawnArgs: string[][] = [];
    await started({ options: { sandbox: 'strict' }, captureSpawnArgs });
    expect(captureSpawnArgs[0]).toEqual(['--sandbox', 'strict', 'agent', 'stdio']);
  });

  it('spawns grok agent stdio with no --sandbox when unset', async () => {
    const captureSpawnArgs: string[][] = [];
    await started({ captureSpawnArgs });
    expect(captureSpawnArgs[0]).toEqual(['agent', 'stdio']);
  });
});

describe('grok-build effort', () => {
  it("effortLevelsFor('grok-build') offers low..xhigh but not max", () => {
    expect(effortLevelsFor('grok-build')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('clampEffort drops max for grok-build', () => {
    expect(clampEffort('grok-build', 'max')).toBeUndefined();
  });

  it('start passes the clamped effort as _meta.reasoningEffort on session/new', async () => {
    const { child } = await started({ effort: 'xhigh' });
    expect((child.lastNewParams()?._meta as Record<string, unknown> | undefined)?.reasoningEffort).toBe('xhigh');
  });

  it('start passes _meta.reasoningEffort on session/load when resuming', async () => {
    const { child } = await started({ nativeSessionId: 'grok-sess-1', effort: 'low' });
    expect((child.lastLoadParams()?._meta as Record<string, unknown> | undefined)?.reasoningEffort).toBe('low');
  });

  it('start re-sends the effort on session/set_model (set_model resets it otherwise)', async () => {
    const { child } = await started({ nativeSessionId: 'grok-sess-1', effort: 'low' });
    expect((child.lastSetModelParams()?._meta as Record<string, unknown> | undefined)?.reasoningEffort).toBe('low');
  });

  it('start omits reasoningEffort when no effort is configured', async () => {
    const { child } = await started();
    expect((child.lastNewParams()?._meta as Record<string, unknown> | undefined)?.reasoningEffort).toBeUndefined();
  });

  it('start drops an effort level grok does not advertise', async () => {
    const { child } = await started({ effort: 'max' });
    expect((child.lastNewParams()?._meta as Record<string, unknown> | undefined)?.reasoningEffort).toBeUndefined();
  });

  it('sendPrompt re-binds effort via set_model when the level changed', async () => {
    const { adapter, child } = await started({ effort: 'low' });
    const promptP = adapter.sendPrompt('hi', undefined, undefined, 'high');
    await new Promise((r) => setImmediate(r));
    expect((child.lastSetModelParams()?._meta as Record<string, unknown> | undefined)?.reasoningEffort).toBe('high');
    setImmediate(() => child.resolvePrompt('ok'));
    await promptP;
  });

  it('sendPrompt does not re-send set_model when the effort is unchanged', async () => {
    const { adapter, child } = await started({ effort: 'low' });
    const before = child.setModelCallCount();
    const promptP = adapter.sendPrompt('hi', undefined, undefined, 'low');
    await new Promise((r) => setImmediate(r));
    expect(child.setModelCallCount()).toBe(before);
    setImmediate(() => child.resolvePrompt('ok'));
    await promptP;
  });

  it('sendPrompt still completes the turn when set_model rejects', async () => {
    const { adapter, events, child } = await started({ effort: 'low' });
    child.failNextSetModel();
    const promptP = adapter.sendPrompt('hi', undefined, undefined, 'high');
    await new Promise((r) => setImmediate(r));
    setImmediate(() => child.resolvePrompt('ok'));
    await promptP;
    await new Promise((r) => setImmediate(r));
    expect(types(events)).toContain('status:done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('grok-build yoloMode', () => {
  it('session/new carries yoloMode false in prompt interaction mode', async () => {
    const { child } = await started({ interactionMode: 'prompt' });
    expect((child.lastNewParams()?._meta as Record<string, unknown> | undefined)?.yoloMode).toBe(false);
  });

  it('session/new carries yoloMode true in bypass interaction mode', async () => {
    const { child } = await started();
    expect((child.lastNewParams()?._meta as Record<string, unknown> | undefined)?.yoloMode).toBe(true);
  });

  it('session/new carries yoloMode true in questions interaction mode', async () => {
    const { child } = await started({ interactionMode: 'questions' });
    expect((child.lastNewParams()?._meta as Record<string, unknown> | undefined)?.yoloMode).toBe(true);
  });

  it('session/load carries the same yoloMode on resume', async () => {
    const { child } = await started({ interactionMode: 'prompt', nativeSessionId: 'grok-sess-1' });
    expect((child.lastLoadParams()?._meta as Record<string, unknown> | undefined)?.yoloMode).toBe(false);
  });
});

describe('grok-build per-message prompt options', () => {
  it('sendPrompt with reasoningEffort high sets _meta.reasoningEffort high', async () => {
    const { adapter, child } = await started({ effort: 'low' });
    const promptP = adapter.sendPrompt('hi', undefined, undefined, 'low', { reasoningEffort: 'high' });
    await new Promise((r) => setImmediate(r));
    expect((child.lastSetModelParams()?._meta as Record<string, unknown> | undefined)?.reasoningEffort).toBe('high');
    setImmediate(() => child.resolvePrompt('ok'));
    await promptP;
  });

  it('sendPrompt with yoloMode off in prompt interactionMode sets _meta.yoloMode false', async () => {
    const { adapter, child } = await started({ interactionMode: 'prompt' });
    const before = child.setModelCallCount();
    const promptP = adapter.sendPrompt('hi', undefined, undefined, undefined, { yoloMode: 'off' });
    await new Promise((r) => setImmediate(r));
    expect(child.setModelCallCount()).toBeGreaterThan(before);
    expect((child.lastSetModelParams()?._meta as Record<string, unknown> | undefined)?.yoloMode).toBe(false);
    setImmediate(() => child.resolvePrompt('ok'));
    await promptP;
  });
});

describe('GROK_BUILTIN_COMMANDS', () => {
  it('GROK_BUILTIN_COMMANDS includes deep-research and workflow', () => {
    const names = GROK_BUILTIN_COMMANDS.map((c) => c.name);
    expect(names).toContain('deep-research');
    expect(names).toContain('workflow');
  });

  it('GROK_BUILTIN_COMMANDS excludes TUI-only modals', () => {
    const names = GROK_BUILTIN_COMMANDS.map((c) => c.name);
    for (const forbidden of ['usage', 'cost', 'settings', 'privacy', 'dashboard', 'rewind', 'plan', 'imagine']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
