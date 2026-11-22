import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { PiAdapter } from './index.js';

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killed: string[] = [];
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
    killed: string[];
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = killed;
  proc.kill = (sig?: string) => {
    killed.push(sig ?? '');
    return true;
  };
  return proc;
}

describe('PiAdapter.oneShot', () => {
  it('spawns argv with -p, --no-tools, --no-session, system-prompt, provider/model', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    const adapter = new PiAdapter({
      bin: 'pi',
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        Promise.resolve().then(() => {
          child.stdout.write('  hello from pi  \n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const result = await adapter.oneShot('clean this', {
      systemPrompt: 'You polish transcripts.',
      model: 'zai/glm-5.3',
    });

    expect(capturedArgs).toEqual([
      '-p', 'clean this',
      '--no-tools', '--no-session',
      '--no-extensions', '--no-skills', '--no-themes',
      '--no-prompt-templates', '--no-context-files',
      '--system-prompt', 'You polish transcripts.',
      '--provider', 'zai',
      '--model', 'glm-5.3',
    ]);
    expect(result.text).toBe('hello from pi');
  });

  it('kills the child and rejects on timeout', async () => {
    const child = fakeChild();
    const adapter = new PiAdapter({
      bin: 'pi',
      spawnFn: () => child as never,
    });

    const p = adapter.oneShot('hang', { timeoutSecs: 0.05 });
    await expect(p).rejects.toThrow(/timed out/);
    expect(child.killed).toContain('SIGTERM');
    expect(child.killed).not.toContain('SIGKILL');
    const started = Date.now();
    while (!child.killed.includes('SIGKILL') && Date.now() - started < 4000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(child.killed).toContain('SIGKILL');
  });

  it('throws without spawning when allowTools is true', async () => {
    let spawned = false;
    const adapter = new PiAdapter({
      bin: 'pi',
      spawnFn: () => {
        spawned = true;
        return fakeChild() as never;
      },
    });

    await expect(adapter.oneShot('nope', { allowTools: true }))
      .rejects.toThrow(/pi oneShot refuses allowTools=true/);
    expect(spawned).toBe(false);
  });

  it('throws when stdout is empty after a 0 exit', async () => {
    const child = fakeChild();
    const adapter = new PiAdapter({
      bin: 'pi',
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await expect(adapter.oneShot('empty')).rejects.toThrow(/pi oneShot returned empty text/);
  });

  it('supports mode read_only with tools read,grep,find,ls and absolute cwd', async () => {
    const child = fakeChild();
    let capturedArgs: string[] = [];
    let capturedOpts: { cwd?: string } = {};
    const adapter = new PiAdapter({
      bin: 'pi',
      spawnFn: (_cmd, args, opts) => {
        capturedArgs = args;
        capturedOpts = opts;
        Promise.resolve().then(() => {
          child.stdout.write('clean transcript');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const result = await adapter.oneShot('inspect', {
      mode: 'read_only',
      cwd: '/workspace/project',
    });

    expect(capturedArgs).toContain('--tools');
    expect(capturedArgs[capturedArgs.indexOf('--tools') + 1]).toBe('read,grep,find,ls');
    expect(capturedArgs).not.toContain('--no-tools');
    expect(capturedOpts.cwd).toBe('/workspace/project');
    expect(result.text).toBe('clean transcript');
  });

  it('rejects read_only mode without an absolute cwd', async () => {
    const adapter = new PiAdapter({ bin: 'pi', spawnFn: () => { throw new Error('should not spawn'); } });
    await expect(adapter.oneShot('nope', { mode: 'read_only' }))
      .rejects.toThrow(/pi oneShot read_only requires an absolute cwd/);
    await expect(adapter.oneShot('nope', { mode: 'read_only', cwd: 'relative/path' }))
      .rejects.toThrow(/pi oneShot read_only requires an absolute cwd/);
  });

  it('declares oneShotModes with none and read_only', () => {
    const adapter = new PiAdapter({ bin: 'pi', spawnFn: () => { throw new Error('should not spawn'); } });
    expect(adapter.oneShotModes).toEqual(['none', 'read_only']);
  });
});
