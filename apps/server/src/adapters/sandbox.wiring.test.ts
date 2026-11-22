import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ClaudeCodeAdapter } from './claude-code/index.js';
import { CodexAdapter } from './codex/index.js';
import { QwenAdapter } from './qwen/index.js';

describe('sandbox adapter wiring', () => {
  it('claude-code passes spawnClaudeCodeProcess when sandboxed', async () => {
    const fakeSpawn = vi.fn(() => new EventEmitter() as never);
    const queryFn = vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }));
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never, spawn: fakeSpawn as never, sandboxed: true });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/w', model: 'm' });
    await adapter.sendPrompt('hi');
    const opts = queryFn.mock.calls.at(-1)?.[0]?.options as Record<string, unknown>;
    expect(opts.spawnClaudeCodeProcess).toBeTypeOf('function');
    (opts.spawnClaudeCodeProcess as (a: { command: string; args: string[]; cwd?: string; env?: object }) => void)(
      { command: 'claude', args: ['-p'], cwd: '/w', env: {} },
    );
    expect(fakeSpawn).toHaveBeenCalledWith('claude', ['-p'], expect.objectContaining({ cwd: '/w' }));
  });

  it('claude-code omits spawnClaudeCodeProcess when not sandboxed', async () => {
    const queryFn = vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }));
    const adapter = new ClaudeCodeAdapter({ queryFn: queryFn as never });
    await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/w', model: 'm' });
    await adapter.sendPrompt('hi');
    const opts = queryFn.mock.calls.at(-1)?.[0]?.options as Record<string, unknown>;
    expect(opts.spawnClaudeCodeProcess).toBeUndefined();
  });

  it('codex sandboxed sendPrompt uses danger-full-access', async () => {
    const adapter = new CodexAdapter({ sandboxed: true, codexHome: '/tmp/cx' });
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const a = adapter as any;
    a._rpc = {
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 't1' } };
        if (method === 'turn/start') return { turn: { id: 'u1' } };
        return {};
      },
    };
    a._model = 'gpt-5';
    a._cwd = '/tmp';
    a._sessionId = 's1';
    /* eslint-enable @typescript-eslint/no-explicit-any */
    await adapter.sendPrompt('hi', [], undefined, undefined, { sandbox: 'workspace-write' });
    const start = sent.find((s) => s.method === 'thread/start');
    expect(start?.params.sandbox).toBe('danger-full-access');
  });

  it('qwen routes injected spawn through env scrub wrapper', () => {
    const prevDb = process.env.TIERWYN_DB;
    process.env.TIERWYN_DB = '/secret/tierwyn.db';
    const fakeSpawn = vi.fn((_c, _a, opts: { env?: NodeJS.ProcessEnv }) => opts);
    const adapter = new QwenAdapter({ spawn: fakeSpawn as never });
    adapter._spawn('qwen', ['acp'], { cwd: '/tmp' });
    expect(fakeSpawn).toHaveBeenCalled();
    expect(fakeSpawn.mock.calls[0]?.[2]?.env?.TIERWYN_DB).toBeUndefined();
    if (prevDb === undefined) delete process.env.TIERWYN_DB;
    else process.env.TIERWYN_DB = prevDb;
  });
});
