// apps/server/src/adapters/cursor/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { NormalisedEvent } from '@tierwyn/shared';
import { CursorAdapter, parseCursorModels, cursorWorkspaceSlug, cursorTranscriptPath, appendCursorPromptOptionArgs } from './index.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
    kill: (s?: string) => void; pid?: number;
  };
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
  proc.pid = 4242;
  proc.kill = () => {};
  return proc;
}

function collect(adapter: CursorAdapter): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return events;
}

describe('appendCursorPromptOptionArgs', () => {
  it('leaves args unchanged when options are omitted', () => {
    const args = ['--trust', '--approve-mcps'];
    appendCursorPromptOptionArgs(args);
    expect(args).toEqual(['--trust', '--approve-mcps']);
  });

  it('leaves args unchanged for null or empty options', () => {
    const withNull = ['--trust'];
    appendCursorPromptOptionArgs(withNull, null);
    expect(withNull).toEqual(['--trust']);
    const withEmpty = ['--trust'];
    appendCursorPromptOptionArgs(withEmpty, {});
    expect(withEmpty).toEqual(['--trust']);
  });

  it("adds --mode plan", () => {
    const args: string[] = [];
    appendCursorPromptOptionArgs(args, { mode: 'plan' });
    expect(args).toEqual(['--mode', 'plan']);
  });

  it("adds --mode ask", () => {
    const args: string[] = [];
    appendCursorPromptOptionArgs(args, { mode: 'ask' });
    expect(args).toEqual(['--mode', 'ask']);
  });

  it("adds --sandbox enabled", () => {
    const args: string[] = [];
    appendCursorPromptOptionArgs(args, { sandbox: 'enabled' });
    expect(args).toEqual(['--sandbox', 'enabled']);
  });

  it("adds --sandbox disabled", () => {
    const args: string[] = [];
    appendCursorPromptOptionArgs(args, { sandbox: 'disabled' });
    expect(args).toEqual(['--sandbox', 'disabled']);
  });

  it('adds --auto-review when autoReview is true', () => {
    const args: string[] = [];
    appendCursorPromptOptionArgs(args, { autoReview: true });
    expect(args).toEqual(['--auto-review']);
  });

  it('appends combined options after base flags in mode → sandbox → auto-review order', () => {
    const args = ['-p', '--force', '--trust', '--approve-mcps'];
    appendCursorPromptOptionArgs(args, { mode: 'plan', sandbox: 'enabled', autoReview: true });
    expect(args).toEqual([
      '-p', '--force', '--trust', '--approve-mcps',
      '--mode', 'plan',
      '--sandbox', 'enabled',
      '--auto-review',
    ]);
  });

  it('omits flags for default or unrecognized values', () => {
    const args: string[] = [];
    appendCursorPromptOptionArgs(args, { mode: 'default', sandbox: 'default', autoReview: false });
    expect(args).toEqual([]);
  });
});

describe('CursorAdapter.sendPrompt', () => {
  it('refuses to send prompt when repository is not trusted and emits end', async () => {
    const adapter = new CursorAdapter();
    const events = collect(adapter);
    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: false });
    await adapter.sendPrompt('hello');
    expect(events.some((e) => e.type === 'error' && e.payload.message?.includes('Cursor requires repository trust'))).toBe(true);
    const lastStatus = [...events].reverse().find((e) => e.type === 'status');
    expect(lastStatus && lastStatus.type === 'status' && lastStatus.payload.status).toBe('error');
    expect(ended).toBe(true);
  });

  it('passes the right args, captures session_id, streams a message, ends with done', async () => {
    const child = fakeChild();
    let capturedCmd = ''; let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      spawnFn: (cmd, args) => { capturedCmd = cmd; capturedArgs = args; return child as never; },
    });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });

    let ended = false;
    adapter.streamEvents().once('end', () => { ended = true; });
    const done = adapter.sendPrompt('hello');

    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat_99' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, session_id: 'chat_99' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi' }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    expect(capturedCmd).toBe('cursor-agent');
    expect(capturedArgs).toEqual([
      '-p', '--output-format', 'stream-json', '--force', '--stream-partial-output',
      '--trust', '--approve-mcps',
      '--model', 'composer-2.5', 'hello',
    ]);
    expect(adapter.nativeSessionId).toBe('chat_99');
    expect(events.some((e) => e.type === 'message' && e.payload.chunk === 'hi')).toBe(true);
    const lastStatus = [...events].reverse().find((e) => e.type === 'status');
    expect(lastStatus && lastStatus.type === 'status' && lastStatus.payload.status).toBe('done');
    expect(ended).toBe(true);
  });

  it('appends --resume when resuming a native session', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({ spawnFn: (_c, a) => { capturedArgs = a; return child as never; } });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', nativeSessionId: 'chat_old', trustRepoConfig: true });
    const done = adapter.sendPrompt('again');
    child.stdout.end(); child.emit('close', 0);
    await done;
    expect(capturedArgs).toContain('--resume');
    expect(capturedArgs[capturedArgs.indexOf('--resume') + 1]).toBe('chat_old');
  });

  it('uses captured session_id as --resume arg on the second sendPrompt (no new start)', async () => {
    const spawnCalls: { args: string[] }[] = [];
    const adapter = new CursorAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push({ args: [...args] });
        const child = fakeChild();
        // Resolve immediately — the test controls stdout/close per call
        setImmediate(() => { child.stdout.end(); child.emit('close', 0); });
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });

    // First sendPrompt: fresh conversation, no --resume yet
    const firstChild = fakeChild();
    let firstSpawnResolve: () => void;
    const firstSpawnDone = new Promise<void>((r) => { firstSpawnResolve = r; });
    const adapter2 = new CursorAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push({ args: [...args] });
        if (spawnCalls.length === 1) return firstChild as never;
        const child = fakeChild();
        setImmediate(() => { child.stdout.end(); child.emit('close', 0); });
        return child as never;
      },
    });
    await adapter2.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });

    const done1 = adapter2.sendPrompt('first');
    firstChild.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat_new' }) + '\n');
    firstChild.stdout.end();
    firstChild.emit('close', 0);
    await done1;

    expect(adapter2.nativeSessionId).toBe('chat_new');

    // Second sendPrompt on SAME adapter instance — must include --resume chat_new
    const done2 = adapter2.sendPrompt('second');
    await done2;

    const secondCall = spawnCalls[1];
    expect(secondCall.args).toContain('--resume');
    expect(secondCall.args[secondCall.args.indexOf('--resume') + 1]).toBe('chat_new');
  });

  it('does not --resume a poisoned session_id from stdout', async () => {
    const spawnCalls: { args: string[] }[] = [];
    const firstChild = fakeChild();
    const adapter = new CursorAdapter({
      spawnFn: (_cmd, args) => {
        spawnCalls.push({ args: [...args] });
        if (spawnCalls.length === 1) return firstChild as never;
        const child = fakeChild();
        setImmediate(() => { child.stdout.end(); child.emit('close', 0); });
        return child as never;
      },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done1 = adapter.sendPrompt('first');
    firstChild.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: '/proc/self/environ' }) + '\n');
    firstChild.stdout.end();
    firstChild.emit('close', 0);
    await done1;
    const done2 = adapter.sendPrompt('second');
    await done2;
    expect(spawnCalls[1]!.args).not.toContain('--resume');
  });

  it('emits status:error and end on subprocess error', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('x');
    child.emit('error', new Error('spawn ENOENT'));
    await done;
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
  });

  it("stop() emits 'end' so hard Interrupt & Send can drain", async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({ spawnFn: () => child as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    adapter.sendPrompt('in flight').catch(() => {});
    const ended = new Promise<void>((resolve) => adapter.streamEvents().once('end', () => resolve()));
    await adapter.stop();
    await ended;
  });

  it('appends @<tempPath> mentions so the model can read pasted images', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      spawnFn: (_cmd, args) => { capturedArgs = args; return child as never; },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const tempPath = '/tmp/tierwyn-attachments/shot.png';
    const done = adapter.sendPrompt('what is this', [{
      mediaType: 'image/png',
      base64: 'iVBOR',
      tempPath,
    }]);
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs[capturedArgs.length - 1]).toBe(`what is this\n\n@${tempPath}`);
    expect(capturedArgs).toContain('--image');
    expect(capturedArgs[capturedArgs.indexOf('--image') + 1]).toBe(tempPath);
    expect(capturedArgs).toContain('--add-dir');
    expect(capturedArgs[capturedArgs.indexOf('--add-dir') + 1]).toBe('/tmp/tierwyn-attachments');
    // --image must come before --add-dir, and the prompt stays last
    expect(capturedArgs.indexOf('--image')).toBeLessThan(capturedArgs.indexOf('--add-dir'));
  });

  it('leaves prompt text unchanged when attachments have no tempPath', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      spawnFn: (_cmd, args) => { capturedArgs = args; return child as never; },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('plain', [{ mediaType: 'image/png', base64: 'abc' }]);
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(capturedArgs[capturedArgs.length - 1]).toBe('plain');
    expect(capturedArgs).not.toContain('--image');
  });

  it('caps oversized prompts so spawn argv stays under the OS limit', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      spawnFn: (_cmd, args) => { capturedArgs = args; return child as never; },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const tail = 'KEEP-THIS-TAIL';
    const done = adapter.sendPrompt('x'.repeat(500_000) + tail);
    child.stdout.end();
    child.emit('close', 0);
    await done;
    const promptArg = capturedArgs[capturedArgs.length - 1];
    expect(promptArg).toContain('truncated');
    expect(promptArg).toContain(tail);
    expect(Buffer.byteLength(promptArg, 'utf8')).toBeLessThanOrEqual(400_000);
  });

  it('streams partial deltas once and drops the buffered/final flush duplicates', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('hi');

    child.stdout.write(JSON.stringify({ type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'Hel' }] } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'assistant', timestamp_ms: 2, message: { content: [{ type: 'text', text: 'lo' }] } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'assistant', timestamp_ms: 3, model_call_id: 'mc_1', message: { content: [{ type: 'text', text: 'Hello' }] } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    const chunks = events
      .filter((e): e is Extract<NormalisedEvent, { type: 'message' }> => e.type === 'message')
      .map((e) => e.payload.chunk);
    expect(chunks.join('')).toBe('Hello');
  });

  it('starts a fresh stream state per spawned turn', async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const adapter = new CursorAdapter({
      spawnFn: () => { const c = fakeChild(); children.push(c); return c as never; },
    });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });

    const first = adapter.sendPrompt('one');
    children[0].stdout.write(JSON.stringify({ type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'A' }] } }) + '\n');
    children[0].stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
    children[0].stdout.end(); children[0].emit('close', 0);
    await first;

    // Second turn is legacy-shaped (no timestamp_ms) — must NOT be swallowed by
    // the previous turn's state.
    const second = adapter.sendPrompt('two');
    children[1].stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }) + '\n');
    children[1].stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
    children[1].stdout.end(); children[1].emit('close', 0);
    await second;

    const chunks = events
      .filter((e): e is Extract<NormalisedEvent, { type: 'message' }> => e.type === 'message')
      .map((e) => e.payload.chunk);
    expect(chunks.join('')).toBe('AB');
  });

  it('surfaces a fatal stderr line as an error event, once', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('x');

    child.stderr.write('Loading workspace index...\n');
    child.stderr.write('Error: You have hit your rate limit\n');
    child.stderr.write('Error: You have hit your rate limit\n');
    child.stderr.end();
    child.stdout.end();
    child.emit('close', 1);
    await done;

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].type === 'error' && errors[0].payload.message).toBe('Error: You have hit your rate limit');
  });

  // Regression: live capture 2026-08-19 (cursor-agent 2026.08.11-e8db854). When the
  // backend returns a retriable error, cursor-agent emits init + user, loops
  // connection/retry frames, then exits with NO `result` frame and a single stderr
  // line `RetriableError: [resource_exhausted] Error`. Before the fix that line was
  // unclassified, so the turn ended as an empty message + status:done — a silent
  // blank turn in the UI with no explanation.
  it('surfaces a resultless RetriableError exit instead of a silent empty turn', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('x');

    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'user', session_id: 'abc' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'connection', subtype: 'reconnecting' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'retry', subtype: 'starting' }) + '\n');
    child.stderr.write('RetriableError: [resource_exhausted] Error\n');
    child.stderr.end();
    child.stdout.end();
    child.emit('close', 1);
    await done;

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].type === 'error' && errors[0].payload.message)
      .toBe('RetriableError: [resource_exhausted] Error');
  });

  it('does not put ordinary stderr chatter in the transcript', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('x');
    child.stderr.write('Indexing 4213 files\nwarming cache\n');
    child.stderr.end();
    child.stdout.end();
    child.emit('close', 0);
    await done;
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('detects a permission block on stderr and emits it only once across both streams', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('x');

    child.stderr.write('tool "bash" requires approval\n');
    child.stderr.end();
    child.stdout.write('tool "bash" requires approval\n');
    child.stdout.end();
    child.emit('close', 1);
    await done;

    const approval = events.filter(
      (e) => e.type === 'error' && /needed approval/.test(e.payload.message),
    );
    expect(approval).toHaveLength(1);
  });

  it('does not emit an error when assistant stream frames contain approval or permission phrases', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({ spawnFn: () => child as never });
    const events = collect(adapter);
    await adapter.start({ sessionId: 'sx-2', conversationId: 'cx-2', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('how many are proposed?');

    child.stdout.write(JSON.stringify({
      type: 'assistant',
      timestamp_ms: 12345,
      message: { content: [{ type: 'text', text: 'There is 1 proposed feature awaiting approval' }] },
    }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
    await done;

    const approval = events.filter(
      (e) => e.type === 'error' && /needed approval/.test(e.payload.message),
    );
    expect(approval).toHaveLength(0);
  });

  it('passes one --image per attachment that has a tempPath', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      spawnFn: (_cmd, args) => { capturedArgs = args; return child as never; },
    });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('two shots', [
      { mediaType: 'image/png', base64: 'a', tempPath: '/tmp/tierwyn-attachments/a.png' },
      { mediaType: 'image/png', base64: 'b', tempPath: '/tmp/tierwyn-attachments/b.png' },
      { mediaType: 'image/png', base64: 'c' },
    ]);
    child.stdout.end(); child.emit('close', 0);
    await done;
    const images = capturedArgs.reduce<string[]>((acc, a, i) => (
      a === '--image' ? [...acc, capturedArgs[i + 1]] : acc
    ), []);
    expect(images).toEqual(['/tmp/tierwyn-attachments/a.png', '/tmp/tierwyn-attachments/b.png']);
    // Both live in the same dir — --add-dir stays deduped to one entry
    expect(capturedArgs.filter((a) => a === '--add-dir')).toHaveLength(1);
  });

  it("sendPrompt captures --mode ask from prompt options, after base flags and before --model", async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({ spawnFn: (_c, a) => { capturedArgs = a; return child as never; } });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.sendPrompt('hello', [], undefined, undefined, { mode: 'ask' });
    child.stdout.end(); child.emit('close', 0);
    await done;
    expect(capturedArgs).toContain('--mode');
    expect(capturedArgs[capturedArgs.indexOf('--mode') + 1]).toBe('ask');
    const baseIdx = capturedArgs.indexOf('--approve-mcps');
    const modeIdx = capturedArgs.indexOf('--mode');
    const modelIdx = capturedArgs.indexOf('--model');
    expect(baseIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeLessThan(modeIdx);
    expect(modeIdx).toBeLessThan(modelIdx);
  });
});

describe('CursorAdapter.runCommand', () => {
  it('dispatches a slash command as a prompt', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({ spawnFn: (_c, a) => { capturedArgs = a; return child as never; } });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.runCommand('review', 'the diff');
    child.stdout.end(); child.emit('close', 0);
    await done;
    expect(capturedArgs[capturedArgs.length - 1]).toBe('/review the diff');
  });

  it('forwards sandbox option onto argv', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({ spawnFn: (_c, a) => { capturedArgs = a; return child as never; } });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: '/tmp', model: 'composer-2.5', trustRepoConfig: true });
    const done = adapter.runCommand('foo', 'bar', { sandbox: 'enabled' });
    child.stdout.end(); child.emit('close', 0);
    await done;
    expect(capturedArgs).toContain('--sandbox');
    expect(capturedArgs[capturedArgs.indexOf('--sandbox') + 1]).toBe('enabled');
    expect(capturedArgs[capturedArgs.length - 1]).toBe('/foo bar');
  });
});

describe('parseCursorModels', () => {
  it('parses "name - Label" lines, skips the header, classifies vision', () => {
    const out = parseCursorModels('Available models\n\nauto - Auto\ncomposer-2.5 - Composer 2.5\nclaude-opus-4-8-low - Opus 4.8 Low\n');
    expect(out.map((m) => m.name)).toEqual(['auto', 'composer-2.5', 'claude-opus-4-8-low']);
    expect(out.find((m) => m.name === 'composer-2.5')!.vision).toBe(true);
    expect(out.find((m) => m.name === 'claude-opus-4-8-low')!.vision).toBe(true);
    expect(out.find((m) => m.name === 'auto')!.provider).toBe('cursor');
  });
});

describe('CursorAdapter.listModels', () => {
  it('spawns cursor-agent models and parses stdout into ModelDescriptors', async () => {
    const child = fakeChild();
    let capturedCmd = '';
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      spawnFn: (cmd, args) => {
        capturedCmd = cmd;
        capturedArgs = args;
        return child as never;
      },
    });

    const promise = adapter.listModels();
    child.stdout.write('Available models\n\ncomposer-2.5 - Composer 2.5\nclaude-opus-4-8-low - Opus 4.8 Low\n');
    child.emit('close', 0);

    const models = await promise;
    expect(capturedCmd).toBe('cursor-agent');
    expect(capturedArgs).toEqual(['models']);
    expect(models).toHaveLength(2);
    expect(models[0].name).toBe('composer-2.5');
    expect(models[0].label).toBe('Cursor · Composer 2.5');
    expect(models[0].vision).toBe(true);
    expect(models[1].name).toBe('claude-opus-4-8-low');
    expect(models[1].label).toBe('Cursor · Opus 4.8 Low');
  });
});

describe('CursorAdapter.listCommands', () => {
  let tmpHome = '';
  let tmpCwd = '';

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cursor-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'cursor-cwd-'));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  function writeSkill(dir: string, name: string, description: string) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
  }

  it('returns [] when no skill dirs exist', async () => {
    const adapter = new CursorAdapter({ cursorHome: tmpHome, cwd: tmpCwd });
    expect(await adapter.listCommands()).toEqual([]);
  });

  it('reads ~/.cursor/skills-cursor and ~/.cursor/skills', async () => {
    writeSkill(join(tmpHome, 'skills-cursor'), 'legacy', 'Legacy root');
    writeSkill(join(tmpHome, 'skills'), 'modern', 'Modern root');
    const adapter = new CursorAdapter({ cursorHome: tmpHome, cwd: tmpCwd });
    const names = (await adapter.listCommands()).map((c) => c.name).sort();
    expect(names).toEqual(['legacy', 'modern']);
  });

  it('reads project .cursor/.claude/.agents/.codex skills under cwd', async () => {
    writeSkill(join(tmpCwd, '.cursor', 'skills'), 'proj-cursor', 'a');
    writeSkill(join(tmpCwd, '.claude', 'skills'), 'proj-claude', 'b');
    writeSkill(join(tmpCwd, '.agents', 'skills'), 'proj-agents', 'c');
    writeSkill(join(tmpCwd, '.codex', 'skills'), 'proj-codex', 'd');
    const adapter = new CursorAdapter({ cursorHome: tmpHome, cwd: tmpCwd });
    const names = (await adapter.listCommands()).map((c) => c.name).sort();
    expect(names).toEqual(['proj-agents', 'proj-claude', 'proj-codex', 'proj-cursor']);
  });

  it('first root wins for duplicate skill names', async () => {
    writeSkill(join(tmpHome, 'skills-cursor'), 'dupe', 'From skills-cursor');
    writeSkill(join(tmpHome, 'skills'), 'dupe', 'From skills');
    writeSkill(join(tmpCwd, '.cursor', 'skills'), 'dupe', 'From project');
    const adapter = new CursorAdapter({ cursorHome: tmpHome, cwd: tmpCwd });
    const out = await adapter.listCommands();
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe('From skills-cursor');
  });

  it('skips project-relative roots when the adapter was never started (no cwd)', async () => {
    writeSkill(join(tmpCwd, '.cursor', 'skills'), 'proj-only', 'x');
    const adapter = new CursorAdapter({ cursorHome: tmpHome });
    expect(await adapter.listCommands()).toEqual([]);
  });

  it('picks up cwd from start() when not injected', async () => {
    writeSkill(join(tmpCwd, '.claude', 'skills'), 'after-start', 'y');
    const adapter = new CursorAdapter({ cursorHome: tmpHome, spawnFn: () => fakeChild() as never });
    await adapter.start({ sessionId: 'sx', conversationId: 'cx', cwd: tmpCwd, model: 'composer-2.5', trustRepoConfig: true });
    expect((await adapter.listCommands()).map((c) => c.name)).toEqual(['after-start']);
  });
});

describe('cursorWorkspaceSlug', () => {
  it('strips the leading slash and dashes the rest', () => {
    expect(cursorWorkspaceSlug('/home/user/Projects/Tierwyn')).toBe('home-user-Projects-Tierwyn');
  });
  it('handles a single-segment path', () => {
    expect(cursorWorkspaceSlug('/tmp')).toBe('tmp');
  });
  it('ignores a trailing slash', () => {
    expect(cursorWorkspaceSlug('/tmp/work/')).toBe('tmp-work');
  });
  it('returns empty string for an empty cwd', () => {
    expect(cursorWorkspaceSlug('')).toBe('');
  });
});

describe('cursorTranscriptPath', () => {
  it('builds <root>/<slug>/agent-transcripts/<id>/<id>.jsonl', () => {
    expect(cursorTranscriptPath('/r/projects', '/tmp/work', 'abc-123'))
      .toBe('/r/projects/tmp-work/agent-transcripts/abc-123/abc-123.jsonl');
  });
});

describe('CursorAdapter.isNativeSessionAvailable', () => {
  let tmpHome = '';

  beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'cursor-native-')); });
  afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

  function writeTranscript(slug: string, id: string) {
    const dir = join(tmpHome, 'projects', slug, 'agent-transcripts', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n');
  }

  it('returns false for an empty id', async () => {
    const adapter = new CursorAdapter({ cursorHome: tmpHome, cwd: '/tmp/work' });
    expect(await adapter.isNativeSessionAvailable('')).toBe(false);
  });

  it('returns true when the transcript file exists under the cwd slug', async () => {
    writeTranscript('tmp-work', 'sess-1');
    const adapter = new CursorAdapter({ cursorHome: tmpHome, cwd: '/tmp/work' });
    expect(await adapter.isNativeSessionAvailable('sess-1')).toBe(true);
  });

  it('returns false when the transcript file is missing', async () => {
    mkdirSync(join(tmpHome, 'projects', 'tmp-work', 'agent-transcripts'), { recursive: true });
    const adapter = new CursorAdapter({ cursorHome: tmpHome, cwd: '/tmp/work' });
    expect(await adapter.isNativeSessionAvailable('sess-missing')).toBe(false);
  });

  it('finds the transcript by scanning project slugs when the adapter has no cwd', async () => {
    writeTranscript('home-someone-Projects-Thing', 'sess-2');
    const adapter = new CursorAdapter({ cursorHome: tmpHome });
    expect(await adapter.isNativeSessionAvailable('sess-2')).toBe(true);
  });

  it('returns false when the projects root does not exist', async () => {
    const adapter = new CursorAdapter({ cursorHome: join(tmpHome, 'nope') });
    expect(await adapter.isNativeSessionAvailable('sess-3')).toBe(false);
  });
});
