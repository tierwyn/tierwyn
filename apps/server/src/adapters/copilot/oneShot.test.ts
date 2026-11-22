import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { CopilotAdapter, DENY_TOOLS } from './index.js';

function makeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const killed: string[] = [];
  return Object.assign(emitter, {
    stdout,
    stderr,
    stdin: null as PassThrough | null,
    pid: 4242,
    kill: (sig?: string) => { killed.push(sig ?? ''); },
    killed,
  });
}

describe('CopilotAdapter.oneShot', () => {
  it('spawns argv without session/resume/allow-all-tools and extracts assistant.message content', async () => {
    const child = makeChild();
    let capturedArgs: string[] = [];
    const adapter = new CopilotAdapter({
      bin: 'copilot',
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({
            type: 'assistant.message_delta',
            data: { content: 'NO', deltaContent: 'NO' },
          }) + '\n');
          child.stdout.write(JSON.stringify({
            type: 'assistant.message',
            data: { content: '  hello from copilot  ' },
          }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const result = await adapter.oneShot('clean this', {
      systemPrompt: 'You polish.',
      model: 'gpt-5',
    });

    expect(capturedArgs.slice(0, 8)).toEqual([
      '-p', 'You polish.\n\nclean this',
      '--output-format', 'json',
      '--stream', 'on',
      '--available-tools', '',
    ]);
    expect(capturedArgs).toContain('--no-ask-user');
    expect(capturedArgs).not.toContain('--session-id');
    expect(capturedArgs.some((a) => a.startsWith('--resume'))).toBe(false);
    expect(capturedArgs).not.toContain('--allow-all-tools');
    for (const deny of DENY_TOOLS) {
      expect(capturedArgs).toContain(`--deny-tool=${deny}`);
    }
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs[capturedArgs.indexOf('--model') + 1]).toBe('gpt-5');
    expect(result.text).toBe('hello from copilot');
  });

  it('kills the child and rejects on timeout', async () => {
    const child = makeChild();
    const adapter = new CopilotAdapter({
      bin: 'copilot',
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

  it('throws when a tool.execution_start frame arrives', async () => {
    const child = makeChild();
    const adapter = new CopilotAdapter({
      bin: 'copilot',
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({ type: 'tool.execution_start' }) + '\n');
          child.stdout.write(JSON.stringify({
            type: 'assistant.message',
            data: { content: 'should not count' },
          }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await expect(adapter.oneShot('nope')).rejects.toThrow(/invoked a tool/);
  });

  it('throws without spawning when allowTools is true', async () => {
    let spawned = false;
    const adapter = new CopilotAdapter({
      bin: 'copilot',
      spawnFn: () => {
        spawned = true;
        return makeChild() as never;
      },
    });

    await expect(adapter.oneShot('nope', { allowTools: true }))
      .rejects.toThrow(/copilot oneShot refuses allowTools=true/);
    expect(spawned).toBe(false);
  });

  it('throws when stdout is empty after a 0 exit', async () => {
    const child = makeChild();
    const adapter = new CopilotAdapter({
      bin: 'copilot',
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await expect(adapter.oneShot('empty')).rejects.toThrow(/copilot oneShot returned empty text/);
  });

  it('supports mode read_only with tools view,grep,glob, deny tools, and absolute cwd', async () => {
    const child = makeChild();
    let capturedArgs: string[] = [];
    let capturedOpts: { cwd?: string } = {};
    const adapter = new CopilotAdapter({
      bin: 'copilot',
      spawnFn: (_cmd, args, opts) => {
        capturedArgs = args;
        capturedOpts = opts;
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({
            type: 'tool.execution_start',
            data: { toolName: 'view' },
          }) + '\n');
          child.stdout.write(JSON.stringify({
            type: 'assistant.message',
            data: { content: 'read output' },
          }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const result = await adapter.oneShot('inspect', {
      mode: 'read_only',
      cwd: '/workspace/repo',
    });

    expect(capturedArgs).toContain('--available-tools');
    expect(capturedArgs[capturedArgs.indexOf('--available-tools') + 1]).toBe('view,grep,glob');
    expect(capturedArgs).toContain('--deny-tool=shell(*)');
    expect(capturedArgs).toContain('--deny-tool=write');
    expect(capturedArgs).toContain('-C');
    expect(capturedArgs[capturedArgs.indexOf('-C') + 1]).toBe('/workspace/repo');
    expect(capturedOpts.cwd).toBe('/workspace/repo');
    expect(result.text).toBe('read output');
  });

  it('rejects in read_only mode when a disallowed tool is invoked', async () => {
    const child = makeChild();
    const adapter = new CopilotAdapter({
      bin: 'copilot',
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(JSON.stringify({
            type: 'tool.execution_start',
            data: { toolName: 'bash' },
          }) + '\n');
          child.stdout.write(JSON.stringify({
            type: 'assistant.message',
            data: { content: 'bad' },
          }) + '\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    await expect(adapter.oneShot('inspect', { mode: 'read_only', cwd: '/workspace/repo' }))
      .rejects.toThrow(/invoked disallowed tool "bash"/);
  });

  it('rejects read_only mode without an absolute cwd', async () => {
    const adapter = new CopilotAdapter({ bin: 'copilot', spawnFn: () => { throw new Error('should not spawn'); } });
    await expect(adapter.oneShot('nope', { mode: 'read_only' }))
      .rejects.toThrow(/copilot oneShot read_only requires an absolute cwd/);
    await expect(adapter.oneShot('nope', { mode: 'read_only', cwd: 'relative/path' }))
      .rejects.toThrow(/copilot oneShot read_only requires an absolute cwd/);
  });

  it('declares oneShotModes with none and read_only', () => {
    const adapter = new CopilotAdapter({ bin: 'copilot', spawnFn: () => { throw new Error('should not spawn'); } });
    expect(adapter.oneShotModes).toEqual(['none', 'read_only']);
  });
});
