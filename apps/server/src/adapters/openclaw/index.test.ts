/**
 * index.test.ts — unit tests for OpenClawAdapter.
 *
 * Uses an injected spawnFn + execFileFn so no real openclaw binary is needed.
 *
 * Run with:
 *   npx vitest run apps/server/src/adapters/openclaw/index.test.ts
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { NormalisedEvent } from '@tierwyn/shared';
import { OpenClawAdapter, appendOpenClawPromptOptionArgs } from './index.js';

// Verified JSON shape from a real `openclaw agent --local --json` run
const HAPPY_RESULT = {
  payloads: [{ text: 'PONG', mediaUrl: null }],
  meta: {
    durationMs: 1234,
    agentMeta: {
      sessionId: 'tierwyn-test-session',
      provider: 'zai',
      model: 'glm-5-turbo',
      contextTokens: 202800,
      usage: { input: 100, output: 3, cacheRead: 50, total: 153 },
    },
    aborted: false,
    finalAssistantVisibleText: 'PONG',
    stopReason: 'stop',
  },
};

/** Build a minimal fake ChildProcess with controllable stdout/stderr/close. */
function makeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    stdout,
    stderr,
    stdin: null,
    kill: () => {},
    pid: undefined,
  });
}

type FakeChild = ReturnType<typeof makeChild>;

/** Default execFileFn stub: `agents add` resolves as if the agent already existed. */
type StubExecFileFn = (bin: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string }>;
const noopExecFileFn: StubExecFileFn = async () => ({ stdout: '{}' });

function makeAdapter(preloadedChild?: FakeChild, execFileFn?: StubExecFileFn) {
  let child = preloadedChild ?? makeChild();
  const capturedArgs: string[][] = [];

  const spawnFn = (_bin: string, args: string[], _opts: Record<string, unknown>) => {
    capturedArgs.push(args);
    return child as unknown as import('child_process').ChildProcess;
  };

  const adapter = new OpenClawAdapter({
    bin: 'openclaw',
    spawnFn: spawnFn as never,
    execFileFn: (execFileFn ?? noopExecFileFn) as never,
  });
  return { adapter, child, capturedArgs, replaceChild: (c: FakeChild) => { child = c; } };
}

async function runWith(
  adapter: OpenClawAdapter,
  child: FakeChild,
  stdout: string,
  exitCode = 0,
): Promise<NormalisedEvent[]> {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e) => events.push(e));

  const done = adapter.sendPrompt('ping');
  // Deliver stdout data then close
  setImmediate(() => {
    child.stdout.write(stdout);
    child.emit('close', exitCode);
  });
  await done;
  return events;
}

describe('appendOpenClawPromptOptionArgs', () => {
  it('leaves args unchanged when options are omitted', () => {
    const args = ['agent', '--local', '--json'];
    appendOpenClawPromptOptionArgs(args);
    expect(args).toEqual(['agent', '--local', '--json']);
  });

  it('leaves args unchanged for null or empty options', () => {
    const withNull = ['agent', '--local', '--json'];
    appendOpenClawPromptOptionArgs(withNull, null);
    expect(withNull).toEqual(['agent', '--local', '--json']);
    const withEmpty = ['agent', '--local', '--json'];
    appendOpenClawPromptOptionArgs(withEmpty, {});
    expect(withEmpty).toEqual(['agent', '--local', '--json']);
  });

  it('adds --thinking high for non-default thinking', () => {
    const args: string[] = [];
    appendOpenClawPromptOptionArgs(args, { thinking: 'high' });
    expect(args).toEqual(['--thinking', 'high']);
  });

  it('adds --timeout 300 for a non-default timeout select', () => {
    const args: string[] = [];
    appendOpenClawPromptOptionArgs(args, { timeout: '300' });
    expect(args).toEqual(['--timeout', '300']);
  });

  it('omits flags for default thinking and timeout', () => {
    const args: string[] = [];
    appendOpenClawPromptOptionArgs(args, { thinking: 'default', timeout: 'default' });
    expect(args).toEqual([]);
  });

  it('appends combined thinking then timeout after base flags', () => {
    const args = ['agent', '--local', '--json', '--session-id', 'sid', '-m', 'hi'];
    appendOpenClawPromptOptionArgs(args, { thinking: 'high', timeout: '300' });
    expect(args).toEqual([
      'agent', '--local', '--json', '--session-id', 'sid', '-m', 'hi',
      '--thinking', 'high',
      '--timeout', '300',
    ]);
  });

  it('omits unrecognized thinking and timeout values', () => {
    const args: string[] = [];
    appendOpenClawPromptOptionArgs(args, { thinking: 'xhigh', timeout: '60' });
    expect(args).toEqual([]);
  });
});

describe('OpenClawAdapter — happy path', () => {
  it('emits message(final) + status:done with usage tokens', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'zai/glm-5-turbo' });

    const events = await runWith(adapter, child, JSON.stringify(HAPPY_RESULT));

    const msg = events.find((e) => e.type === 'message');
    expect(msg).toBeDefined();
    expect(msg?.type === 'message' && msg.payload.chunk).toBe('PONG');
    expect(msg?.type === 'message' && msg.payload.final).toBe(true);

    const doneStatus = [...events].reverse().find((e) => e.type === 'status');
    expect(doneStatus?.type === 'status' && doneStatus.payload.status).toBe('done');
    expect(doneStatus?.type === 'status' && doneStatus.payload.inputTokens).toBe(100);
    expect(doneStatus?.type === 'status' && doneStatus.payload.outputTokens).toBe(3);
    expect(doneStatus?.type === 'status' && doneStatus.payload.cacheReadTokens).toBe(50);
  });

  it("stop() emits 'end' so hard Interrupt & Send can drain", async () => {
    const { adapter } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'zai/glm-5-turbo' });
    adapter.sendPrompt('in flight').catch(() => {});
    const ended = new Promise<void>((resolve) => adapter.streamEvents().once('end', () => resolve()));
    await adapter.stop();
    await ended;
  });
});

describe('OpenClawAdapter — session id handling', () => {
  it('nativeSessionId is updated from meta.agentMeta.sessionId in result', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'zai/glm-5-turbo' });
    await runWith(adapter, child, JSON.stringify(HAPPY_RESULT));
    expect(adapter.nativeSessionId).toBe('tierwyn-test-session');
  });

  it('resume: provided nativeSessionId is passed as --session-id arg', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'zai/glm-5-turbo', nativeSessionId: 'abc-existing' });
    await runWith(adapter, child, JSON.stringify(HAPPY_RESULT));
    expect(capturedArgs[0]).toContain('abc-existing');
  });

  it('fresh start: mints a tierwyn- session id when none provided', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's2', conversationId: 'c2', cwd: '/tmp', model: 'zai/glm-5-turbo' });
    await runWith(adapter, child, JSON.stringify(HAPPY_RESULT));
    const idx = capturedArgs[0]?.indexOf('--session-id') ?? -1;
    const sid = capturedArgs[0]?.[idx + 1] ?? '';
    expect(sid).toMatch(/^tierwyn-/);
  });
});

describe('OpenClawAdapter — image attachments', () => {
  it('appends @<tempPath> mentions to -m so the model can read pasted images', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'zai/glm-5-turbo' });
    const tempPath = '/tmp/tierwyn-attachments/shot.png';
    const done = adapter.sendPrompt('what is this', [{
      mediaType: 'image/png',
      base64: 'iVBOR',
      tempPath,
    }]);
    setImmediate(() => {
      child.stdout.write(JSON.stringify(HAPPY_RESULT));
      child.emit('close', 0);
    });
    await done;
    const mIdx = capturedArgs[0]?.indexOf('-m') ?? -1;
    expect(capturedArgs[0]?.[mIdx + 1]).toBe(`what is this\n\n@${tempPath}`);
  });

  it('leaves -m unchanged when attachments have no tempPath', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'zai/glm-5-turbo' });
    const done = adapter.sendPrompt('plain', [{ mediaType: 'image/png', base64: 'abc' }]);
    setImmediate(() => {
      child.stdout.write(JSON.stringify(HAPPY_RESULT));
      child.emit('close', 0);
    });
    await done;
    const mIdx = capturedArgs[0]?.indexOf('-m') ?? -1;
    expect(capturedArgs[0]?.[mIdx + 1]).toBe('plain');
  });
});

describe('OpenClawAdapter — error paths', () => {
  it('non-JSON stdout + close(0) → error + status:error', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's3', conversationId: 'c3', cwd: '/tmp', model: 'zai/glm-5-turbo' });

    const events = await runWith(adapter, child, 'not valid json garbage');

    expect(events.some((e) => e.type === 'error')).toBe(true);
    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last?.type === 'status' && last.payload.status).toBe('error');
  });

  it('non-zero exit → error event mentioning exit code', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's4', conversationId: 'c4', cwd: '/tmp', model: 'zai/glm-5-turbo' });

    const events = await runWith(adapter, child, '', 1);

    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.payload.message).toMatch(/code 1/);
  });

  it('aborted JSON → error + status:error', async () => {
    const { adapter, child } = makeAdapter();
    await adapter.start({ sessionId: 's5', conversationId: 'c5', cwd: '/tmp', model: 'zai/glm-5-turbo' });

    const aborted = { ...HAPPY_RESULT, meta: { ...HAPPY_RESULT.meta, aborted: true } };
    const events = await runWith(adapter, child, JSON.stringify(aborted));

    expect(events.some((e) => e.type === 'error')).toBe(true);
    const last = [...events].reverse().find((e) => e.type === 'status');
    expect(last?.type === 'status' && last.payload.status).toBe('error');
  });
});

describe('OpenClawAdapter — listModels', () => {
  it('maps CLI JSON to ModelDescriptors and filters unavailable', async () => {
    const cliResponse = {
      count: 2,
      models: [
        { key: 'zai/glm-5-turbo', name: 'GLM-5 Turbo', input: 'text', contextWindow: 202800, available: true, missing: false },
        { key: 'zai/broken', name: 'Broken', input: 'text', contextWindow: 1000, available: false, missing: true },
      ],
    };
    const execFileFn = async () => ({ stdout: JSON.stringify(cliResponse) });
    const adapter = new OpenClawAdapter({ bin: 'openclaw', execFileFn: execFileFn as never });

    const models = await adapter.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('zai/glm-5-turbo');
    expect(models[0].label).toBe('OpenClaw · GLM-5 Turbo');
    expect(models[0].provider).toBe('zai');
    expect(models[0].steer).toBe(false);
    expect(models[0].contextWindow).toBe(202800);
  });

  it('returns [] on CLI failure (timeout / ENOENT)', async () => {
    const execFileFn = async () => { throw new Error('ENOENT'); };
    const adapter = new OpenClawAdapter({ bin: 'openclaw', execFileFn: execFileFn as never });
    expect(await adapter.listModels()).toEqual([]);
  });
});

describe('OpenClawAdapter — listSessions', () => {
  it('maps CLI JSON to session list', async () => {
    const cliResponse = {
      sessions: [
        { sessionId: 'sess-abc', key: 'my-session', updatedAt: 1700000000000 },
      ],
    };
    const execFileFn = async () => ({ stdout: JSON.stringify(cliResponse) });
    const adapter = new OpenClawAdapter({ bin: 'openclaw', execFileFn: execFileFn as never });

    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-abc');
    expect(sessions[0].summary).toBe('my-session');
    expect(sessions[0].createdAt).toBe(1700000000000);
  });

  it('returns [] on CLI failure', async () => {
    const execFileFn = async () => { throw new Error('ENOENT'); };
    const adapter = new OpenClawAdapter({ bin: 'openclaw', execFileFn: execFileFn as never });
    expect(await adapter.listSessions()).toEqual([]);
  });
});

describe('OpenClawAdapter — project workspace scoping', () => {
  it('ensures a workspace-scoped agent and passes --agent on the run', async () => {
    const ensureCalls: string[][] = [];
    const execFileFn = async (_bin: string, args: string[]) => {
      ensureCalls.push(args);
      return { stdout: '{}' };
    };
    const { adapter, child, capturedArgs } = makeAdapter(undefined, execFileFn);

    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/home/user/my-project', model: 'zai/glm-5-turbo' });
    await runWith(adapter, child, JSON.stringify(HAPPY_RESULT));

    expect(ensureCalls[0]).toEqual(
      expect.arrayContaining(['agents', 'add', expect.stringMatching(/^tierwyn-[0-9a-f]{12}$/), '--workspace', '/home/user/my-project']),
    );
    const idx = capturedArgs[0]?.indexOf('--agent') ?? -1;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[0]?.[idx + 1]).toMatch(/^tierwyn-[0-9a-f]{12}$/);
  });

  it('treats "already exists" as success and still passes --agent', async () => {
    const execFileFn = async () => {
      const err = new Error('Command failed') as Error & { stderr: string };
      err.stderr = 'Agent "tierwyn-abc123" already exists.\n';
      throw err;
    };
    const { adapter, child, capturedArgs } = makeAdapter(undefined, execFileFn);

    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/proj-exists', model: 'zai/glm-5-turbo' });
    await runWith(adapter, child, JSON.stringify(HAPPY_RESULT));

    expect(capturedArgs[0]).toContain('--agent');
  });

  it('omits --agent when ensure fails for a real reason (soft-fail, falls back to default workspace)', async () => {
    const execFileFn = async () => { throw new Error('ENOENT'); };
    const { adapter, child, capturedArgs } = makeAdapter(undefined, execFileFn);

    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp/proj-fails', model: 'zai/glm-5-turbo' });
    await runWith(adapter, child, JSON.stringify(HAPPY_RESULT));

    expect(capturedArgs[0]).not.toContain('--agent');
  });

  it('omits --agent when no cwd is given', async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '', model: 'zai/glm-5-turbo' });
    await runWith(adapter, child, JSON.stringify(HAPPY_RESULT));
    expect(capturedArgs[0]).not.toContain('--agent');
  });
});

describe('OpenClawAdapter — per-message prompt options', () => {
  it("sendPrompt captures --thinking high after -m and before --model", async () => {
    const { adapter, child, capturedArgs } = makeAdapter();
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '', model: 'zai/glm-5-turbo' });
    const done = adapter.sendPrompt('hi', [], 'model', undefined, { thinking: 'high' });
    setImmediate(() => {
      child.stdout.write(JSON.stringify(HAPPY_RESULT));
      child.emit('close', 0);
    });
    await done;
    expect(capturedArgs[0]).toEqual([
      'agent', '--local', '--json', '--session-id', expect.any(String), '-m', 'hi',
      '--thinking', 'high',
      '--model', 'model',
    ]);
  });
});

describe('OpenClawAdapter — isNativeSessionAvailable', () => {
  it('returns false for an empty/missing session id without touching disk', async () => {
    const adapter = new OpenClawAdapter({ bin: 'openclaw' });
    expect(await adapter.isNativeSessionAvailable('')).toBe(false);
  });

  it('returns false when the session file does not exist on disk', async () => {
    const adapter = new OpenClawAdapter({ bin: 'openclaw' });
    expect(await adapter.isNativeSessionAvailable('nonexistent-session-id-xyz')).toBe(false);
  });
});
