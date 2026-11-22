import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeAdapter } from './index.js';

function resultIterable(msg: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield msg;
    },
  };
}

describe('ClaudeCodeAdapter.oneShot', () => {
  it('calls queryFn with tools-off options and returns result text', async () => {
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result',
      is_error: false,
      result: '  polished  ',
    }));
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never });

    const out = await adapter.oneShot('clean this', {
      systemPrompt: 'You polish transcripts.',
      model: 'claude-sonnet-4-6',
    });

    expect(out.text).toBe('polished');
    expect(queryFn).toHaveBeenCalledTimes(1);
    const arg = queryFn.mock.calls[0]![0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    expect(arg.prompt).toBe('clean this');
    expect(arg.options.tools).toEqual([]);
    expect(arg.options.allowedTools).toEqual([]);
    expect(arg.options.maxTurns).toBe(1);
    expect(arg.options.settingSources).toEqual([]);
    expect(arg.options.systemPrompt).toBe('You polish transcripts.');
    expect(arg.options.model).toBe('claude-sonnet-4-6');
  });

  it('oneShotModes advertises none and read_only', () => {
    const adapter = new ClaudeCodeAdapter({ queryFn: vi.fn() as never });
    expect(adapter.oneShotModes).toEqual(['none', 'read_only']);
  });

  it('mode none matches default tools-off options', async () => {
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result', is_error: false, result: 'ok',
    }));
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never });
    await adapter.oneShot('p', { mode: 'none' });
    const opts = (queryFn.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.maxTurns).toBe(1);
  });

  it('read_only mode uses Read/Glob/Grep allow-list and deny list', async () => {
    const queryFn = vi.fn((_args: unknown) => resultIterable({
      type: 'result', is_error: false, result: 'from-reads',
    }));
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never });
    const out = await adapter.oneShot('inspect', {
      mode: 'read_only',
      cwd: '/tmp/x',
    });
    expect(out.text).toBe('from-reads');
    const opts = (queryFn.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(opts.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(opts.allowedTools).toEqual(['Read(/tmp/x/**)', 'Glob(/tmp/x/**)', 'Grep(/tmp/x/**)']);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write']));
    expect(opts.maxTurns).toBeGreaterThan(1);
    expect(opts.permissionMode).not.toBe('bypassPermissions');
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.mcpServers).toEqual({});
    expect(opts.cwd).toBe('/tmp/x');
  });

  it('read_only rejects when cwd is omitted or not absolute', async () => {
    const queryFn = vi.fn();
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never });
    await expect(adapter.oneShot('p', { mode: 'read_only' }))
      .rejects.toThrow(/claude-code oneShot read_only requires an absolute cwd/);
    await expect(adapter.oneShot('p', { mode: 'read_only', cwd: 'relative/path' }))
      .rejects.toThrow(/claude-code oneShot read_only requires an absolute cwd/);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('read_only defaults timeout to 120s', async () => {
    let capturedAc: AbortController | undefined;
    const queryFn = vi.fn(({ options }: { options: { abortController: AbortController } }) => {
      capturedAc = options.abortController;
      return resultIterable({ type: 'result', is_error: false, result: 'ok' });
    });
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never });
    await adapter.oneShot('p', { mode: 'read_only', cwd: '/tmp/x' });
    expect(capturedAc).toBeDefined();
    expect(queryFn).toHaveBeenCalled();
  });

  it('aborts the AbortController and rejects on timeout', async () => {
    let capturedAc: AbortController | undefined;
    const queryFn = vi.fn(({ options }: { options: { abortController: AbortController } }) => {
      capturedAc = options.abortController;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<never>((_, reject) => {
            options.abortController.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        },
      };
    });
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never });

    await expect(adapter.oneShot('hang', { timeoutSecs: 0.05 }))
      .rejects.toThrow(/timed out/);
    expect(capturedAc?.signal.aborted).toBe(true);
  });

  it('throws without calling queryFn when allowTools is true', async () => {
    const queryFn = vi.fn();
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never });

    await expect(adapter.oneShot('nope', { allowTools: true }))
      .rejects.toThrow(/claude-code oneShot refuses allowTools=true/);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('throws when the result is_error', async () => {
    const adapter = new ClaudeCodeAdapter({
      queryFn: (() => resultIterable({
        type: 'result',
        is_error: true,
        errors: ['boom', 'more'],
        result: '',
      })) as never,
    });

    await expect(adapter.oneShot('fail')).rejects.toThrow(/boom; more/);
  });
});
