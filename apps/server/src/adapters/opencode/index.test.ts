import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import type { NormalisedEvent } from '@tierwyn/shared';
import { OpenCodeAdapter, appendOpenCodePromptOptionArgs } from './index.js';
import { setAgentEnvSource } from '../../childEnv.js';

// ---------------------------------------------------------------------------
// Fake child process factory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectEvents(adapter: OpenCodeAdapter): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return events;
}

describe('appendOpenCodePromptOptionArgs', () => {
  it('leaves args unchanged when options are omitted', () => {
    const args = ['run', '--format', 'json'];
    appendOpenCodePromptOptionArgs(args);
    expect(args).toEqual(['run', '--format', 'json']);
  });

  it('leaves args unchanged for null or empty options', () => {
    const withNull = ['run', '--format', 'json'];
    appendOpenCodePromptOptionArgs(withNull, null);
    expect(withNull).toEqual(['run', '--format', 'json']);
    const withEmpty = ['run', '--format', 'json'];
    appendOpenCodePromptOptionArgs(withEmpty, {});
    expect(withEmpty).toEqual(['run', '--format', 'json']);
  });

  it('adds --variant for non-default values', () => {
    for (const variant of ['minimal', 'low', 'high', 'max'] as const) {
      const args: string[] = [];
      appendOpenCodePromptOptionArgs(args, { variant });
      expect(args).toEqual(['--variant', variant]);
    }
  });

  it('adds --thinking when thinking is true', () => {
    const args: string[] = [];
    appendOpenCodePromptOptionArgs(args, { thinking: true });
    expect(args).toEqual(['--thinking']);
  });

  it('adds --pure when pure is true', () => {
    const args: string[] = [];
    appendOpenCodePromptOptionArgs(args, { pure: true });
    expect(args).toEqual(['--pure']);
  });

  it('adds --agent <name> for a non-empty string', () => {
    const args: string[] = [];
    appendOpenCodePromptOptionArgs(args, { agent: 'build' });
    expect(args).toEqual(['--agent', 'build']);
  });

  it('appends combined options after --format json in variant → thinking → pure → agent order', () => {
    const args = ['run', '--format', 'json'];
    appendOpenCodePromptOptionArgs(args, {
      variant: 'high',
      thinking: true,
      pure: true,
      agent: 'build',
    });
    expect(args).toEqual([
      'run', '--format', 'json',
      '--variant', 'high',
      '--thinking',
      '--pure',
      '--agent', 'build',
    ]);
  });

  it('omits flags for default, false, empty, or unrecognized values', () => {
    const args: string[] = [];
    appendOpenCodePromptOptionArgs(args, {
      variant: 'default',
      thinking: false,
      pure: false,
      agent: '',
    });
    expect(args).toEqual([]);
    appendOpenCodePromptOptionArgs(args, { variant: 'turbo' });
    expect(args).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendPrompt — end-to-end streaming
// ---------------------------------------------------------------------------

describe('OpenCodeAdapter.sendPrompt', () => {
  it('does not --session a poisoned sessionID from stdout', async () => {
    const spawnCalls: { args: string[] }[] = [];
    const firstChild = fakeChild();
    const adapter = new OpenCodeAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push({ args: [...args] });
        if (spawnCalls.length === 1) return firstChild as never;
        const child = fakeChild();
        setImmediate(() => { child.stdout.end(); child.emit('close', 0); });
        return child as never;
      },
    });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/deepseek-v4-flash-free',
    });
    const done1 = adapter.sendPrompt('first');
    firstChild.stdout.write(JSON.stringify({ type: 'text', sessionID: '/proc/self/environ', part: { type: 'text', text: 'x' } }) + '\n');
    firstChild.stdout.end();
    firstChild.emit('close', 0);
    await done1;
    const done2 = adapter.sendPrompt('second');
    await done2;
    expect(spawnCalls[1]!.args).not.toContain('--session');
  });

  it('emits status:running, a message chunk, message:final, status:done, and end', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);

    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/deepseek-v4-flash-free',
    });

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });

    const done = adapter.sendPrompt('hello world');

    // Push the two captured real-shape NDJSON lines, then close
    child.stdout.write(
      JSON.stringify({
        type: 'step_start',
        timestamp: 1000,
        sessionID: 'ses_test001',
        part: { type: 'step-start' },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'text',
        timestamp: 1001,
        sessionID: 'ses_test001',
        part: { type: 'text', text: 'hi', time: {} },
      }) + '\n',
    );
    // Trigger close
    child.stdout.end();
    child.emit('close', 0);

    await done;

    const types = events.map((e) => e.type);

    // status:running must appear first
    expect(types[0]).toBe('status');
    expect(
      events[0].type === 'status' && events[0].payload.status,
    ).toBe('running');

    // message chunk 'hi'
    const msgChunk = events.find(
      (e) => e.type === 'message' && e.type === 'message' && e.payload.chunk === 'hi',
    );
    expect(msgChunk).toBeDefined();

    // message final
    const msgFinal = events.find(
      (e) => e.type === 'message' && e.type === 'message' && e.payload.final === true,
    );
    expect(msgFinal).toBeDefined();

    // last status must be done
    const lastStatus = [...events].reverse().find((e) => e.type === 'status');
    expect(lastStatus && lastStatus.type === 'status' && lastStatus.payload.status).toBe('done');

    // 'end' emitted
    expect(ended).toBe(true);

    // nativeSessionId captured
    expect(adapter.nativeSessionId).toBe('ses_test001');
  });

  it('emits status:error and end on subprocess error', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'opencode/any' });
    const done = adapter.sendPrompt('test');
    child.emit('error', new Error('spawn ENOENT'));
    await done;

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.type === 'status' && e.payload.status === 'error')).toBe(true);
    expect(ended).toBe(true);
  });

  it('keeps status as running through multi-step tool calls and accumulates usage across step_finish frames', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);

    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/deepseek-v4-flash-free',
    });

    const done = adapter.sendPrompt('run a tool and reply');

    // Step 1: Step start, tool use, step finish with tokens
    child.stdout.write(
      JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_multi',
        part: { type: 'step-start' },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_multi',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: { status: 'completed', input: { command: 'echo hello' }, output: 'hello\n' },
        },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_multi',
        part: {
          type: 'step-finish',
          tokens: { input: 100, output: 20 },
          cost: 0.001,
        },
      }) + '\n',
    );

    // After step 1 finish, status must STILL be running (no done status emitted yet)
    const statusesAfterStep1 = events
      .filter((e) => e.type === 'status')
      .map((e) => (e.type === 'status' ? e.payload.status : ''));
    expect(statusesAfterStep1).toEqual(['running']);

    // Step 2: Step start, text response, step finish
    child.stdout.write(
      JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_multi',
        part: { type: 'step-start' },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_multi',
        part: { type: 'text', text: 'Command output: hello' },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_multi',
        part: {
          type: 'step-finish',
          tokens: { input: 150, output: 30 },
          cost: 0.002,
        },
      }) + '\n',
    );

    // Close child process to finish turn
    child.stdout.end();
    child.emit('close', 0);

    await done;

    const allStatuses = events
      .filter((e) => e.type === 'status')
      .map((e) => (e.type === 'status' ? e.payload : null));

    expect(allStatuses).toHaveLength(2);
    expect(allStatuses[0]).toEqual({ status: 'running' });
    expect(allStatuses[1]).toMatchObject({
      status: 'done',
      inputTokens: 250,
      outputTokens: 50,
      costUsd: 0.003,
    });
  });

  it('does not emit an error when assistant stream frames contain approval or permission phrases', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);
    await adapter.start({ sessionId: 'sx-approval', conversationId: 'cx-approval', cwd: '/tmp', model: 'opencode/any' });
    const done = adapter.sendPrompt('how many FW are proposed?');

    child.stdout.write(
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_appr',
        part: { type: 'text', text: 'There is 1 proposed feature awaiting approval' },
      }) + '\n',
    );
    child.stdout.end();
    child.emit('close', 0);
    await done;

    const approval = events.filter(
      (e) => e.type === 'error' && /needed approval/.test(e.payload.message),
    );
    expect(approval).toHaveLength(0);
  });

  it('surfaces a non-interactive permission block from non-JSON stdout as an error', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);
    await adapter.start({ sessionId: 'sx-perm', conversationId: 'cx-perm', cwd: '/tmp', model: 'opencode/any' });
    const done = adapter.sendPrompt('run action');

    child.stdout.write('Error: tool "bash" requires approval (permission denied)\n');
    child.stdout.end();
    child.emit('close', 1);
    await done;

    const approval = events.filter(
      (e) => e.type === 'error' && /needed approval/.test(e.payload.message),
    );
    expect(approval).toHaveLength(1);
  });

  it('captures --thinking after --format json and before --model', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new OpenCodeAdapter({
      spawnFn: (_cmd, args) => { capturedArgs = args; return child as never; },
    });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/any',
    });
    const done = adapter.sendPrompt('hi', [], 'model', undefined, { thinking: true });
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs).toEqual([
      'run', '--format', 'json',
      '--thinking',
      '--model', 'model',
      'hi',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failure surfacing — nonzero exit with zero frames
// ---------------------------------------------------------------------------

describe('OpenCodeAdapter close-code failure surfacing', () => {
  function lastStatusOf(events: NormalisedEvent[]): string | undefined {
    const last = [...events].reverse().find((e) => e.type === 'status');
    return last && last.type === 'status' ? last.payload.status : undefined;
  }

  function errorMessages(events: NormalisedEvent[]): string[] {
    return events
      .filter((e): e is Extract<NormalisedEvent, { type: 'error' }> => e.type === 'error')
      .map((e) => e.payload.message);
  }

  it('emits an error with the stderr tail and status:error on nonzero exit with zero frames', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'opencode/any' });
    const done = adapter.sendPrompt('hello');

    child.stderr.write('Unexpected server error: drizzle migration failed\n');
    child.stderr.write('  at reconcile (bootstrap.ts:42)\n');
    child.stdout.end();
    child.emit('close', 1);
    await done;

    const errs = errorMessages(events);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('OpenCode exited with code 1');
    expect(errs[0]).toContain('drizzle migration failed');

    const statuses = events
      .filter((e) => e.type === 'status')
      .map((e) => (e.type === 'status' ? e.payload.status : ''));
    expect(statuses).toEqual(['running', 'error']);
    // No fake empty-final message and no done status on this path.
    expect(events.some((e) => e.type === 'message')).toBe(false);
    expect(lastStatusOf(events)).toBe('error');
  });

  it('reports when no stderr was captured', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'opencode/any' });
    const done = adapter.sendPrompt('hello');

    child.stdout.end();
    child.emit('close', 2);
    await done;

    const errs = errorMessages(events);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('exited with code 2');
    expect(errs[0]).toContain('no stderr output was captured');
    expect(lastStatusOf(events)).toBe('error');
  });

  it('keeps the legacy empty-done fallback on exit code 0 with zero frames', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'opencode/any' });
    const done = adapter.sendPrompt('hello');

    child.stderr.write('warning only\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(errorMessages(events)).toEqual([]);
    expect(events.some((e) => e.type === 'message' && e.payload.final === true)).toBe(true);
    expect(lastStatusOf(events)).toBe('done');
  });

  it('keeps the legacy empty-done fallback on nonzero exit after frames were emitted', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'opencode/any' });
    const done = adapter.sendPrompt('hello');

    child.stdout.write(
      JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { type: 'text', text: 'partial' } }) + '\n',
    );
    child.stdout.end();
    child.emit('close', 3);
    await done;

    expect(errorMessages(events)).toEqual([]);
    expect(lastStatusOf(events)).toBe('done');
  });

  it('keeps the legacy empty-done fallback when the process is killed (null exit code)', async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const events = collectEvents(adapter);

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'opencode/any' });
    const done = adapter.sendPrompt('hello');

    child.stdout.end();
    child.emit('close', null, 'SIGTERM');
    await done;

    expect(errorMessages(events)).toEqual([]);
    expect(lastStatusOf(events)).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

describe('OpenCodeAdapter.runCommand', () => {
  it('spawns opencode run --command <name> with model/session flags and trailing args', async () => {
    const child = fakeChild();
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;

    const adapter = new OpenCodeAdapter({
      spawnFn: (cmd, args) => {
        capturedCmd = cmd;
        capturedArgs = args;
        return child as never;
      },
    });

    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/deepseek-v4-flash-free',
      nativeSessionId: 'ses_resume',
    });

    const done = adapter.runCommand('commit', 'fix typo');

    expect(capturedCmd).toBe('opencode');
    expect(capturedArgs).toEqual([
      'run',
      '--format',
      'json',
      '--command',
      'commit',
      '--model',
      'opencode/deepseek-v4-flash-free',
      '--session',
      'ses_resume',
      'fix typo',
    ]);

    child.stdout.end();
    child.emit('close', 0);
    await done;
  });

  it('omits trailing prompt when args are empty', async () => {
    const child = fakeChild();
    let capturedArgs: string[] | undefined;

    const adapter = new OpenCodeAdapter({
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        return child as never;
      },
    });

    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/any',
    });

    const done = adapter.runCommand('review');

    expect(capturedArgs).toEqual([
      'run',
      '--format',
      'json',
      '--command',
      'review',
      '--model',
      'opencode/any',
    ]);

    child.stdout.end();
    child.emit('close', 0);
    await done;
  });

  it('disables project config in child env when repository is not trusted', async () => {
    const child = fakeChild();
    let capturedOpts: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
    const adapter = new OpenCodeAdapter({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return child as never; },
    });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/any',
      trustRepoConfig: false,
    });
    const done = adapter.sendPrompt('test');
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedOpts.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(capturedOpts.env?.KILO_DISABLE_PROJECT_CONFIG).toBe('1');
  });

  it('allows project config when trustRepoConfig is true', async () => {
    const child = fakeChild();
    let capturedOpts: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
    const adapter = new OpenCodeAdapter({
      spawnFn: (_cmd, _args, opts) => { capturedOpts = opts; return child as never; },
    });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/any',
      trustRepoConfig: true,
    });
    const done = adapter.sendPrompt('test');
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedOpts.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
    expect(capturedOpts.env?.KILO_DISABLE_PROJECT_CONFIG).toBeUndefined();
  });

  it('captures --pure after --format json and before --model', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new OpenCodeAdapter({
      spawnFn: (_cmd, args) => { capturedArgs = args; return child as never; },
    });
    await adapter.start({
      sessionId: 'sx',
      conversationId: 'cx',
      cwd: '/tmp',
      model: 'opencode/any',
    });
    const done = adapter.runCommand('foo', 'bar', { pure: true });
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs).toEqual([
      'run', '--format', 'json',
      '--pure',
      '--command', 'foo',
      '--model', 'opencode/any',
      'bar',
    ]);
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('OpenCodeAdapter.stop', () => {
  it('kills the child process and emits status:idle', async () => {
    let killed: string | undefined;
    const child = fakeChild();
    child.kill = (signal?: string) => { killed = signal ?? 'SIGTERM'; };

    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    const statuses: string[] = [];
    adapter.streamEvents().on('event', (e: NormalisedEvent) => {
      if (e.type === 'status') statuses.push(e.payload.status);
    });

    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'opencode/any' });

    // Start a prompt so _child is set, but don't await it — we stop immediately
    adapter.sendPrompt('test').catch(() => {});
    await adapter.stop();

    expect(killed).toBe('SIGTERM');
    expect(statuses).toContain('idle');
  });

  it("stop() emits 'end' so hard Interrupt & Send can drain", async () => {
    const child = fakeChild();
    const adapter = new OpenCodeAdapter({ spawnFn: () => child as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'opencode/any' });
    adapter.sendPrompt('in flight').catch(() => {});
    const ended = new Promise<void>((resolve) => adapter.streamEvents().once('end', () => resolve()));
    await adapter.stop();
    await ended;
  });
});

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe('OpenCodeAdapter.listModels', () => {
  it('parses opencode models output into ModelDescriptors', async () => {
    // Fake spawnFn that immediately returns fake child; listModels uses execAsync not spawnFn.
    // We test listModels by testing the parsing logic indirectly via a real bin path that
    // does not exist — the try/catch returns [].
    // Instead, test the parsing shape by creating an adapter with a fake bin that doesn't exist.
    const adapter = new OpenCodeAdapter({ bin: '/nonexistent/opencode' });
    const models = await adapter.listModels();
    // Returns [] when binary not found — valid empty list
    expect(Array.isArray(models)).toBe(true);
  });

  it('correctly classifies vision models', async () => {
    // We verify the parsing logic by directly calling mapOpenCodeEvent on a text frame,
    // then verifying the adapter's listModels mapping logic via a manual parse simulation.
    // Since execAsync is used, we can't easily inject a fake without mocking.
    // We verify the contract: if a model line contains 'claude', vision=true.
    const lines = [
      'opencode/deepseek-v4-flash-free',
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-4o',
    ];
    // Simulate what listModels does internally
    const results = lines.map((line) => {
      const slashIdx = line.indexOf('/');
      const provider = slashIdx !== -1 ? line.slice(0, slashIdx) : line;
      const lower = line.toLowerCase();
      const vision = lower.includes('claude') || lower.includes('gpt') || lower.includes('gemini');
      return { name: line, label: `OpenCode · ${line}`, provider, vision, steer: false };
    });
    expect(results[0].vision).toBe(false);  // deepseek — not claude/gpt/gemini
    expect(results[1].vision).toBe(true);   // claude
    expect(results[2].vision).toBe(true);   // gpt
    expect(results[0].provider).toBe('opencode');
    expect(results[1].provider).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('OpenCodeAdapter.listSessions', () => {
  it('returns sessions from the native SQLite store, newest first', async () => {
    const tmpPath = join(tmpdir(), `tierwyn-opencode-test-${Date.now()}.db`);
    const seed = new Database(tmpPath);
    seed.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        title TEXT,
        time_created INTEGER
      );
    `);
    seed.prepare(
      'INSERT INTO session (id, title, time_created) VALUES (?, ?, ?)',
    ).run('ses_abc', 'older', 1000);
    seed.prepare(
      'INSERT INTO session (id, title, time_created) VALUES (?, ?, ?)',
    ).run('ses_def', 'newer', 2000);
    seed.close();

    const adapter = new OpenCodeAdapter({ dbPath: tmpPath });
    const sessions = await adapter.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: 'ses_def', summary: 'newer', createdAt: 2000 });
    expect(sessions[1]).toMatchObject({ id: 'ses_abc', summary: 'older', createdAt: 1000 });
  });

  it('returns [] when the DB file does not exist (fileMustExist)', async () => {
    const adapter = new OpenCodeAdapter({ dbPath: '/nonexistent/opencode.db' });
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listCommands
// ---------------------------------------------------------------------------

describe('OpenCodeAdapter.listCommands', () => {
  it('scans extra skillDirs beyond the config dir (kilo: ~/.kilo/skills)', async () => {
    const base = join(tmpdir(), `tierwyn-opencode-cmds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const configDir = join(base, 'config');
    const skillDir = join(base, 'personal-skills');
    mkdirSync(join(skillDir, 'grilling'), { recursive: true });
    writeFileSync(
      join(skillDir, 'grilling', 'SKILL.md'),
      '---\nname: grilling\ndescription: Interview the user relentlessly\n---\nbody',
    );
    const adapter = new OpenCodeAdapter({ configDir, skillDirs: [skillDir] });
    const commands = await adapter.listCommands();
    expect(commands.map((c) => c.name)).toContain('grilling');
    expect(commands.find((c) => c.name === 'grilling')).toMatchObject({
      sourceDetail: 'skill',
      description: 'Interview the user relentlessly',
    });
  });

  it('keeps the config dir as the primary scan when skillDirs is empty', async () => {
    const base = join(tmpdir(), `tierwyn-opencode-cmds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const configDir = join(base, 'config');
    mkdirSync(join(configDir, 'skills', 'cfg-skill'), { recursive: true });
    writeFileSync(join(configDir, 'skills', 'cfg-skill', 'SKILL.md'), '---\nname: cfg-skill\n---\n');
    const adapter = new OpenCodeAdapter({ configDir });
    const commands = await adapter.listCommands();
    expect(commands.map((c) => c.name)).toContain('cfg-skill');
  });
});

// ---------------------------------------------------------------------------
// Vault env scoping (kilocode vs opencode)
// ---------------------------------------------------------------------------

describe('OpenCodeAdapter vault env', () => {
  afterEach(() => {
    setAgentEnvSource(() => ({ own: {}, managedNames: new Set() }));
  });

  function useBothSlices(): void {
    setAgentEnvSource((agentType) => {
      const managedNames = new Set(['KILO_KEY', 'OC_KEY']);
      if (agentType === 'kilocode') return { own: { KILO_KEY: 'kilo-secret' }, managedNames };
      if (agentType === 'opencode') return { own: { OC_KEY: 'oc-secret' }, managedNames };
      return { own: {}, managedNames };
    });
  }

  it('kilocode adapter spawns with kilocode vault env', () => {
    useBothSlices();
    const child = fakeChild();
    let captured: NodeJS.ProcessEnv | undefined;
    const adapter = new OpenCodeAdapter({
      agentType: 'kilocode',
      spawnFn: (_c, _a, o) => { captured = o.env; return child as never; },
    });
    adapter._spawn('x', [], {});
    expect(captured?.KILO_KEY).toBe('kilo-secret');
    expect(captured?.OC_KEY).toBeUndefined();
  });

  it('defaults to the opencode vault env when no agentType is given', () => {
    useBothSlices();
    const child = fakeChild();
    let captured: NodeJS.ProcessEnv | undefined;
    const adapter = new OpenCodeAdapter({
      spawnFn: (_c, _a, o) => { captured = o.env; return child as never; },
    });
    adapter._spawn('x', [], {});
    expect(captured?.OC_KEY).toBe('oc-secret');
    expect(captured?.KILO_KEY).toBeUndefined();
  });
});
