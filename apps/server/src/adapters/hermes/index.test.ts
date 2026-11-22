import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import type { NormalisedEvent, ResolvedMcpServer } from '@tierwyn/shared';
import { HermesAdapter, autoAllow, normalizeHermesModelId } from './index.js';

/** A fake `hermes acp` that auto-answers initialize/session/new and lets the
 *  test push notifications, by parsing what the adapter writes to stdin. */
function fakeChild(opts: { loadSession?: boolean } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void;
  };
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr; proc.kill = () => {};
  // Respond to every request id with a canned result.
  stdin.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.id === undefined) continue;
      if (msg.method === 'initialize') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: Boolean(opts.loadSession) } } }) + '\n');
      } else if (msg.method === 'session/new') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'hermes-sess-1' } }) + '\n');
      } else if (msg.method === 'session/load' || msg.method === 'session/set_model') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
      } else if (msg.method === 'session/prompt') {
        // stream one message chunk, then resolve the prompt with a stopReason
        stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'hermes-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } } }) + '\n');
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'Completed' } }) + '\n');
      }
    }
  });
  return proc;
}

function collect(adapter: HermesAdapter): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return events;
}

describe('autoAllow', () => {
  it('selects an allow option for a permission request', () => {
    let result: unknown;
    autoAllow('session/request_permission', { options: [{ optionId: 'no', kind: 'reject_once' }, { optionId: 'yes', kind: 'allow_once' }] }, (r) => { result = r; });
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
  });
  it('replies with {} for other methods', () => {
    let result: unknown;
    autoAllow('fs/read_text_file', {}, (r) => { result = r; });
    expect(result).toEqual({});
  });
});

describe('normalizeHermesModelId', () => {
  it('converts provider:model to provider/model for ACP set_model', () => {
    expect(normalizeHermesModelId('zai:my-model')).toBe('zai/my-model');
    expect(normalizeHermesModelId('zai/my-model')).toBe('zai/my-model');
  });
});

describe('HermesAdapter', () => {
  it('initializes, creates a session (native id), streams a message, ends with done', async () => {
    const child = fakeChild();
    const adapter = new HermesAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'anthropic/claude-sonnet-4.6' });
    expect(adapter.nativeSessionId).toBe('hermes-sess-1');

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.sendPrompt('question');

    expect(events.some((e) => e.type === 'status' && e.payload.status === 'running')).toBe(true);
    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'answer')).toBe(true);
    const lastStatus = [...events].reverse().find((e) => e.type === 'status');
    expect(lastStatus && lastStatus.type === 'status' && lastStatus.payload.status).toBe('done');
    expect(ended).toBe(true);
  });

  it('calls session/set_model after session/load when resuming a native session', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = new EventEmitter() as EventEmitter & {
      stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void;
    };
    proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr; proc.kill = () => {};
    const writes: string[] = [];
    stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        if (msg.method === 'initialize') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\n');
        } else if (msg.method === 'session/load' || msg.method === 'session/set_model') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        }
      }
    });

    const adapter = new HermesAdapter({ spawnFn: () => proc as never });
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'zai:glm-5.2', nativeSessionId: 'saved-native-id',
    });

    const cmds = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(cmds.some((c) => c.method === 'session/load')).toBe(true);
    const setModel = cmds.find((c) => c.method === 'session/set_model');
    expect(setModel).toBeTruthy();
    expect(setModel?.params).toMatchObject({ sessionId: 'saved-native-id', modelId: 'zai/glm-5.2' });
    expect(adapter.nativeSessionId).toBe('saved-native-id');
  });

  it('appends @<tempPath> mentions on sendPrompt so pasted images reach the model', async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new HermesAdapter({ spawnFn: () => child as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'zai:glm-4.5' });

    const tempPath = '/tmp/tierwyn-attachments/shot.png';
    await adapter.sendPrompt('what is this', [{
      mediaType: 'image/png',
      base64: 'iVBOR',
      tempPath,
    }]);

    const cmds = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const promptCmd = cmds.find((c) => c.method === 'session/prompt');
    expect((promptCmd?.params as { prompt?: { text: string }[] }).prompt?.[0]?.text)
      .toBe(`what is this\n\n@${tempPath}`);
  });

  it('appends @<tempPath> mentions on steer and steer-loop follow-ups', async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new HermesAdapter({ spawnFn: () => child as never });

    const tempPath = '/tmp/tierwyn-attachments/loop.png';
    const att = { mediaType: 'image/png', base64: 'iVBOR', tempPath };
    const queue: ({ text: string; attachments?: typeof att[] } | null)[] = [
      { text: 'follow-up', attachments: [att] },
      null,
    ];
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'zai:glm-4.5', getNextSteer: async () => queue.shift() ?? null,
    });

    await adapter.steer('inject', [att]);
    await adapter.sendPrompt('initial');
    await new Promise((r) => setTimeout(r, 50));

    const cmds = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const promptTexts = cmds
      .filter((c) => c.method === 'session/prompt')
      .flatMap((c) => ((c.params as { prompt?: { text: string }[] }).prompt ?? []).map((p) => p.text));
    expect(promptTexts).toEqual([
      `inject\n\n@${tempPath}`,
      'initial',
      `follow-up\n\n@${tempPath}`,
    ]);
  });

  it('steer() sends a session/prompt request with the steer text', async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new HermesAdapter({ spawnFn: () => child as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'zai:glm-4.5' });

    await adapter.steer('inject text');

    const cmds = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const steerCmd = cmds.find(
      (c) =>
        c.method === 'session/prompt' &&
        (c.params as { prompt?: { text: string }[] }).prompt?.some((p) => p.text === 'inject text'),
    );
    expect(steerCmd).toBeTruthy();
    expect((steerCmd?.params as { sessionId?: string })?.sessionId).toBe('hermes-sess-1');
  });

  it('listModels returns models from models.json when present', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'hermes-test-'));
    try {
      writeFileSync(
        join(tmpHome, 'models.json'),
        JSON.stringify([
          { name: 'glm-5.1', provider: 'zai', model: 'glm-5.1' },
          { name: 'Claude Sonnet 4', provider: 'openrouter', model: 'anthropic/claude-sonnet-4-20250514' },
        ]),
      );
      const adapter = new HermesAdapter({ hermesHome: tmpHome });
      const models = await adapter.listModels();
      expect(models).toHaveLength(2);
      expect(models[0].name).toBe('zai/glm-5.1');
      expect(models[0].label).toBe('Hermes · glm-5.1');
      expect(models[1].name).toBe('anthropic/claude-sonnet-4-20250514');
      expect(models[1].label).toBe('Hermes · Claude Sonnet 4');
      expect(models[1].vision).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('listModels falls back to seeded profiles when models.json is absent', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'hermes-empty-'));
    try {
      const adapter = new HermesAdapter({ hermesHome: tmpHome });
      const models = await adapter.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.name === 'zai:glm-5.1')).toBe(true);
      expect(models.every((m) => m.provider === 'zai')).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('listCommands returns commands pushed via available_commands_update notification', async () => {
    const child = fakeChild();
    const adapter = new HermesAdapter({ spawnFn: () => child as never });

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'anthropic/claude-sonnet-4.6' });

    // Push an available_commands_update notification through stdout
    child.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'hermes-sess-1',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'review', description: 'Review diff' }],
          },
        },
      }) + '\n',
    );

    // Allow the event loop to process the notification
    await new Promise<void>((r) => setImmediate(r));

    const commands = await adapter.listCommands();
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'review', description: 'Review diff' }),
      ]),
    );
  });

  it('drains getNextSteer into follow-up session/prompt turns without emitting end between turns', async () => {
    // Reproduces the bug where the adapter did a single session/prompt and
    // never polled getNextSteer: steers queued by SessionManager during the
    // first turn sat undelivered, and steerSession reported 'injected' even
    // though nothing consumed the message. The fix is a long-running steer
    // loop entered after the first prompt resolves.
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (d: Buffer) => writes.push(d.toString()));
    const adapter = new HermesAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);

    // A queue the test controls: resolve with the next steer, or null to end.
    const queue: ({ text: string } | null)[] = [
      { text: 'first steer' }, { text: 'second steer' }, null,
    ];
    const getNextSteer = async () => queue.shift() ?? null;

    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'zai:glm-4.5', getNextSteer,
    });

    let endCount = 0;
    adapter.streamEvents().on('end', () => { endCount++; });
    await adapter.sendPrompt('initial question');

    // Allow the steer loop to drain both queued items + see the null sentinel.
    await new Promise((r) => setTimeout(r, 50));

    const cmds = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const promptTexts = cmds
      .filter((c) => c.method === 'session/prompt')
      .flatMap((c) => ((c.params as { prompt?: { text: string }[] }).prompt ?? []).map((p) => p.text));
    expect(promptTexts).toEqual(['initial question', 'first steer', 'second steer']);

    // Each follow-up turn re-emits running + done; the loop does NOT emit end
    // between turns (only once when the loop exits on the null sentinel).
    const runningCount = events.filter((e) => e.type === 'status' && e.payload.status === 'running').length;
    const doneCount = events.filter((e) => e.type === 'status' && e.payload.status === 'done').length;
    expect(runningCount).toBe(3); // initial + 2 steers
    expect(doneCount).toBe(3);
    expect(endCount).toBe(1); // loop exit, not per-turn
  });

  it('interruptTurn soft-cancels mid-prompt (status:done, not error) and drains force steer', async () => {
    // Controllable ACP: hold session/prompt open until session/cancel or
    // explicit resolve — mirrors grok-build soft-interrupt tests.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = new EventEmitter() as EventEmitter & {
      stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void;
    };
    proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
    let killed = false;
    proc.kill = () => { killed = true; };

    let lastPromptId: number | string | null = null;
    let cancelled = false;
    const promptTexts: string[] = [];
    const cancels: unknown[] = [];

    stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.id === undefined) {
          if (msg.method === 'session/cancel' && lastPromptId !== null) {
            cancelled = true;
            cancels.push(msg.params);
            stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: lastPromptId,
              error: { code: -32000, message: 'cancelled' },
            }) + '\n');
            lastPromptId = null;
          }
          continue;
        }
        if (msg.method === 'initialize') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } }) + '\n');
        } else if (msg.method === 'session/new') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'hermes-sess-1' } }) + '\n');
        } else if (msg.method === 'session/set_model') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        } else if (msg.method === 'session/prompt') {
          const text = ((msg.params?.prompt ?? []) as Array<{ text?: string }>)[0]?.text ?? '';
          promptTexts.push(text);
          lastPromptId = msg.id;
          // First (in-flight) prompt: leave open for interruptTurn.
          // Steer-loop follow-ups: stream a chunk then complete.
          if (promptTexts.length > 1) {
            stdout.write(JSON.stringify({
              jsonrpc: '2.0', method: 'session/update',
              params: { sessionId: 'hermes-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'force drained' } } },
            }) + '\n');
            stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'Completed' } }) + '\n');
            lastPromptId = null;
          }
        }
      }
    });

    let calls = 0;
    const getNextSteer = async () => {
      calls++;
      if (calls === 1) return { text: 'cut in force' };
      return null;
    };

    const adapter = new HermesAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'zai:glm-4.5', getNextSteer,
    });

    const promptP = adapter.sendPrompt('spawn and wait');
    await new Promise((r) => setTimeout(r, 20));
    adapter.interruptTurn();
    await promptP;

    expect(cancelled).toBe(true);
    expect(cancels[0]).toMatchObject({ sessionId: 'hermes-sess-1' });
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(false);
    expect(killed).toBe(false);

    // Steer loop drains the force-style follow-up as a fresh session/prompt.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(promptTexts).toEqual(['spawn and wait', 'cut in force']);
    expect(events.filter((e) => e.type === 'status' && e.payload.status === 'done').length).toBeGreaterThanOrEqual(2);
  });

  it('does not enter the steer loop after an errored first prompt', async () => {
    // If session/prompt rejects, the adapter emits error + status:error and
    // must NOT park on getNextSteer (which would hang the SessionRecord).
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = new EventEmitter() as EventEmitter & {
      stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void;
    };
    proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr; proc.kill = () => {};
    stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        if (msg.method === 'initialize') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } }) + '\n');
        } else if (msg.method === 'session/new') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'hermes-sess-1' } }) + '\n');
        } else if (msg.method === 'session/set_model') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        } else if (msg.method === 'session/prompt') {
          // Resolve the prompt with an ACP error — AcpClient.request rejects.
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'boom' } }) + '\n');
        }
      }
    });

    const adapter = new HermesAdapter({ spawnFn: () => proc as never });
    const events = collect(adapter);
    let steered = false;
    const getNextSteer = async () => { steered = true; return null; };

    await adapter.start({
      sessionId: 'sx', conversationId: 'cx', cwd: '/tmp',
      model: 'zai:glm-4.5', getNextSteer,
    });

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.sendPrompt('question');

    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(steered).toBe(false); // loop skipped on error
    expect(ended).toBe(true);    // emit('end') from the else branch
  });
});

describe('HermesAdapter.listSessions', () => {
  it('returns sessions from the SQLite store, newest first', async () => {
    const tmpPath = join(tmpdir(), `tierwyn-hermes-test-${Date.now()}.db`);
    const seed = new Database(tmpPath);
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        title TEXT,
        started_at REAL
      );
    `);
    seed.prepare(
      "INSERT INTO sessions (id, source, title, started_at) VALUES (?, ?, ?, ?)"
    ).run('ses_1', 'acp', 'older', 1782171307);
    seed.prepare(
      "INSERT INTO sessions (id, source, title, started_at) VALUES (?, ?, ?, ?)"
    ).run('ses_2', 'acp', 'newer', 1782171310);
    seed.prepare(
      "INSERT INTO sessions (id, source, title, started_at) VALUES (?, ?, ?, ?)"
    ).run('ses_3', 'cli', 'ignored', 1782171315);
    seed.close();

    const adapter = new HermesAdapter({ dbPath: tmpPath });
    const sessions = await adapter.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: 'ses_2', summary: 'newer', createdAt: 1782171310000 });
    expect(sessions[1]).toMatchObject({ id: 'ses_1', summary: 'older', createdAt: 1782171307000 });
  });

  it('returns [] when the DB file does not exist', async () => {
    const adapter = new HermesAdapter({ dbPath: '/nonexistent/hermes.db' });
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([]);
  });
});

describe('HermesAdapter.isNativeSessionAvailable', () => {
  it('returns true if the session exists with source=acp', async () => {
    const tmpPath = join(tmpdir(), `tierwyn-hermes-test-avail-${Date.now()}.db`);
    const seed = new Database(tmpPath);
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        title TEXT,
        started_at REAL
      );
    `);
    seed.prepare(
      "INSERT INTO sessions (id, source, title, started_at) VALUES (?, ?, ?, ?)"
    ).run('ses_acp', 'acp', 'title', 1782171307);
    seed.prepare(
      "INSERT INTO sessions (id, source, title, started_at) VALUES (?, ?, ?, ?)"
    ).run('ses_cli', 'cli', 'title', 1782171307);
    seed.close();

    const adapter = new HermesAdapter({ dbPath: tmpPath });
    expect(await adapter.isNativeSessionAvailable('ses_acp')).toBe(true);
    expect(await adapter.isNativeSessionAvailable('ses_cli')).toBe(false);
    expect(await adapter.isNativeSessionAvailable('nonexistent')).toBe(false);
    expect(await adapter.isNativeSessionAvailable('')).toBe(false);
  });
});

describe('HermesAdapter prompt options', () => {
  it('spawns hermes acp --accept-hooks without --yolo by default', async () => {
    const child = fakeChild();
    const spawnCalls: string[][] = [];
    const adapter = new HermesAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'zai/glm-5.2' });
    expect(spawnCalls[0]).toEqual(['acp', '--accept-hooks']);
  });

  it('respawns with top-level --yolo before acp when sendPrompt yolo is true', async () => {
    const child = fakeChild({ loadSession: true });
    const spawnCalls: string[][] = [];
    const adapter = new HermesAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'zai/glm-5.2' });
    await adapter.sendPrompt('question', undefined, undefined, undefined, { yolo: true });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]).toEqual(['--yolo', 'acp', '--accept-hooks']);
  });

  it('does not respawn when sendPrompt has no yolo option', async () => {
    const child = fakeChild();
    const spawnCalls: string[][] = [];
    const adapter = new HermesAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'zai/glm-5.2' });
    await adapter.sendPrompt('question');
    expect(spawnCalls).toHaveLength(1);
  });

  it('respawns back without --yolo on the next turn after a yolo override', async () => {
    const child = fakeChild({ loadSession: true });
    const spawnCalls: string[][] = [];
    const adapter = new HermesAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'zai/glm-5.2' });
    await adapter.sendPrompt('one', undefined, undefined, undefined, { yolo: true });
    await adapter.sendPrompt('two');
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[2]).toEqual(['acp', '--accept-hooks']);
  });

  it('runCommand forwards yolo into a respawn', async () => {
    const child = fakeChild({ loadSession: true });
    const spawnCalls: string[][] = [];
    const adapter = new HermesAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push(args);
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'zai/glm-5.2' });
    await adapter.runCommand('compact', undefined, { yolo: true });
    expect(spawnCalls.at(-1)).toEqual(['--yolo', 'acp', '--accept-hooks']);
  });
});

describe('HermesAdapter MCP injection (WP-2.5)', () => {
  const stdioServer: ResolvedMcpServer = {
    id: 'test-mcp',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    cwd: '/tmp',
    env: { KEY: 'val' },
    secretEnvKeys: [],
    headers: {},
    secretHeaderKeys: [],
  };

  const httpServer: ResolvedMcpServer = {
    id: 'web-mcp',
    transport: 'http',
    url: 'https://example.com/mcp',
    args: [],
    env: {},
    secretEnvKeys: [],
    headers: { Authorization: 'Bearer token' },
    secretHeaderKeys: [],
  };

  function captureRequests(opts: { loadSession?: boolean } = {}) {
    const child = fakeChild(opts);
    const writes: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    child.stdin.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        try {
          writes.push(JSON.parse(line));
        } catch {}
      }
    });
    return { child, writes };
  }

  it('session/new params carry the injected stdio server array when config.mcpServers is set', async () => {
    const { child, writes } = captureRequests();
    const adapter = new HermesAdapter({ spawnFn: () => child as never });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'zai:glm-5.2',
      mcpServers: [stdioServer],
    });
    const sessionNew = writes.find((w) => w.method === 'session/new');
    expect(sessionNew).toBeDefined();
    expect((sessionNew?.params as { mcpServers?: unknown }).mcpServers).toEqual([
      {
        name: 'test-mcp',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'KEY', value: 'val' }],
      },
    ]);
  });

  it('session/new params carry empty array when config.mcpServers is unset or textOnly', async () => {
    const { child, writes } = captureRequests();
    const adapter = new HermesAdapter({ spawnFn: () => child as never });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'zai:glm-5.2',
      textOnly: true,
      mcpServers: [stdioServer],
    });
    const sessionNew = writes.find((w) => w.method === 'session/new');
    expect(sessionNew).toBeDefined();
    expect((sessionNew?.params as { mcpServers?: unknown }).mcpServers).toEqual([]);
  });

  it('skips http/sse servers when caps are undefined (stdio only)', async () => {
    const { child, writes } = captureRequests();
    const adapter = new HermesAdapter({ spawnFn: () => child as never });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'zai:glm-5.2',
      mcpServers: [stdioServer, httpServer],
    });
    const sessionNew = writes.find((w) => w.method === 'session/new');
    expect(sessionNew).toBeDefined();
    // Only stdioServer should be passed; httpServer is dropped because hermes advertises no mcpCapabilities
    expect((sessionNew?.params as { mcpServers?: unknown }).mcpServers).toEqual([
      {
        name: 'test-mcp',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'KEY', value: 'val' }],
      },
    ]);
  });

  it('session/load params carry the injected stdio server array on resume', async () => {
    const { child, writes } = captureRequests({ loadSession: true });
    const adapter = new HermesAdapter({ spawnFn: () => child as never });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'zai:glm-5.2',
      nativeSessionId: 'saved-native-id',
      mcpServers: [stdioServer],
    });
    const sessionLoad = writes.find((w) => w.method === 'session/load');
    expect(sessionLoad).toBeDefined();
    expect((sessionLoad?.params as { mcpServers?: unknown }).mcpServers).toEqual([
      {
        name: 'test-mcp',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'KEY', value: 'val' }],
      },
    ]);
  });
});

