import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { CursorAdapter } from './index.js';

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killed: string[] = [];
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
    kill: (s?: string) => boolean; pid?: number; killed: string[];
  };
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
  proc.pid = 4242;
  proc.killed = killed;
  proc.kill = (s?: string) => { killed.push(s ?? ''); return true; };
  return proc;
}

describe('CursorAdapter.oneShot', () => {
  it('spawns argv with --mode ask and prompt last, extracts result text', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      bin: 'cursor-agent',
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({ type: 'result', result: '  hi  ', is_error: false }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const result = await adapter.oneShot('clean this', {
      systemPrompt: 'You polish.',
      model: 'composer-2.5',
    });

    expect(capturedArgs).toEqual([
      '-p', '--output-format', 'stream-json', '--mode', 'ask',
      '--model', 'composer-2.5',
      'You polish.\n\nclean this',
    ]);
    expect(result.text).toBe('hi');
  });

  it('kills the child and rejects on timeout', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({
      spawnFn: () => child as never,
    });

    await expect(adapter.oneShot('hang', { timeoutSecs: 0.05 })).rejects.toThrow(/timed out/);
    expect(child.killed).toContain('SIGTERM');
    expect(child.killed).not.toContain('SIGKILL');
    const started = Date.now();
    while (!child.killed.includes('SIGKILL') && Date.now() - started < 4000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(child.killed).toContain('SIGKILL');
  });

  it('throws when a tool_call frame arrives', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({ type: 'tool_call' }) + '\n');
          child.stdout.write(JSON.stringify({ type: 'result', result: 'hi', is_error: false }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await expect(adapter.oneShot('nope')).rejects.toThrow(/invoked a tool/);
  });

  it('treats a truthy is_error as failure', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({ type: 'result', result: 'oops', is_error: 1 }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await expect(adapter.oneShot('nope')).rejects.toThrow(/oops|cursor oneShot error/);
  });

  it('throws without spawning when allowTools is true', async () => {
    let spawned = false;
    const adapter = new CursorAdapter({
      spawnFn: () => {
        spawned = true;
        return fakeChild() as never;
      },
    });

    await expect(adapter.oneShot('nope', { allowTools: true }))
      .rejects.toThrow(/cursor oneShot refuses allowTools=true/);
    expect(spawned).toBe(false);
  });

  it('throws when stdout is empty after a 0 exit', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await expect(adapter.oneShot('empty')).rejects.toThrow(/cursor oneShot returned empty text/);
  });

  it('supports mode read_only with read tools and absolute cwd', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    let capturedOpts: { cwd?: string } = {};
    const adapter = new CursorAdapter({
      bin: 'cursor-agent',
      spawnFn: (_cmd, args, opts) => {
        capturedArgs = args;
        capturedOpts = opts;
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({
            type: 'tool_call',
            tool_call: { readToolCall: { args: { path: 'file.txt' } } },
          }) + '\n');
          child.stdout.write(JSON.stringify({ type: 'result', result: 'read ok', is_error: false }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const result = await adapter.oneShot('inspect', {
      mode: 'read_only',
      cwd: '/workspace/repo',
      trustRepoConfig: true,
    });

    expect(capturedArgs).toContain('--mode');
    expect(capturedArgs[capturedArgs.indexOf('--mode') + 1]).toBe('ask');
    expect(capturedArgs).toContain('--trust');
    expect(capturedArgs).toContain('--force');
    expect(capturedOpts.cwd).toBe('/workspace/repo');
    expect(result.text).toBe('read ok');
  });

  it('rejects in read_only mode when a disallowed tool is invoked', async () => {
    const child = fakeChild();
    const adapter = new CursorAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({
            type: 'tool_call',
            tool_call: { writeToolCall: { args: { path: 'file.txt' } } },
          }) + '\n');
          child.stdout.write(JSON.stringify({ type: 'result', result: 'bad', is_error: false }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await expect(adapter.oneShot('inspect', { mode: 'read_only', cwd: '/workspace/repo', trustRepoConfig: true }))
      .rejects.toThrow(/invoked disallowed tool "writeToolCall"/);
  });

  it('rejects read_only mode when repository is not trusted', async () => {
    const adapter = new CursorAdapter();
    await expect(adapter.oneShot('inspect', { mode: 'read_only', cwd: '/workspace/repo' }))
      .rejects.toThrow(/cursor oneShot requires repository trust/);
  });

  it('rejects read_only mode without an absolute cwd', async () => {
    const adapter = new CursorAdapter({ spawnFn: () => { throw new Error('should not spawn'); } });
    await expect(adapter.oneShot('nope', { mode: 'read_only' }))
      .rejects.toThrow(/cursor oneShot read_only requires an absolute cwd/);
    await expect(adapter.oneShot('nope', { mode: 'read_only', cwd: 'relative/path' }))
      .rejects.toThrow(/cursor oneShot read_only requires an absolute cwd/);
  });

  it('declares oneShotModes with none and read_only', () => {
    const adapter = new CursorAdapter({ spawnFn: () => { throw new Error('should not spawn'); } });
    expect(adapter.oneShotModes).toEqual(['none', 'read_only']);
  });
});
