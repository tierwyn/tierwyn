import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { DeepSeekRpc } from './rpc.js';

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void;
  };
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
  proc.kill = () => proc.emit('close', 0);
  return proc;
}

describe('DeepSeekRpc transport', () => {
  it('resolves ready() on the spawn event (no ready frame is ever written)', async () => {
    const child = fakeChild();
    const rpc = new DeepSeekRpc({ spawnFn: () => child as never });
    rpc.start({ cwd: '/tmp' });

    child.emit('spawn');
    await rpc.ready();
  });

  it('correlates a response by id', async () => {
    const child = fakeChild();
    const rpc = new DeepSeekRpc({ spawnFn: () => child as never });
    rpc.start({});
    child.emit('spawn');
    await rpc.ready();

    const writes: string[] = [];
    child.stdin.on('data', (d) => writes.push(d.toString()));
    const pending = rpc.request('initialize', { cwd: '/tmp', provider: 'deepseek-official', model: 'deepseek-chat' });
    const sent = JSON.parse(writes[0]) as { id: number; method: string };
    expect(sent.method).toBe('initialize');
    expect(typeof sent.id).toBe('number');
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } }) + '\n');
    await expect(pending).resolves.toEqual({ serverInfo: { name: 'deepseek-harness-sdk-runtime' } });
  });

  it('rejects on a JSON-RPC error object', async () => {
    const child = fakeChild();
    const rpc = new DeepSeekRpc({ spawnFn: () => child as never });
    rpc.start({});
    child.emit('spawn');
    await rpc.ready();

    const writes: string[] = [];
    child.stdin.on('data', (d) => writes.push(d.toString()));
    const pending = rpc.request('session/prompt', { sessionId: 's1' });
    const sent = JSON.parse(writes[0]) as { id: number };
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'boom' } }) + '\n');
    await expect(pending).rejects.toThrow(/boom/);
  });

  it('emits id-less method frames as notification', async () => {
    const child = fakeChild();
    const rpc = new DeepSeekRpc({ spawnFn: () => child as never });
    rpc.start({});
    child.emit('spawn');
    await rpc.ready();

    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    rpc.on('notification', (n) => seen.push(n));
    child.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session.event',
      params: { sessionId: 's1', event: { type: 'turn/start', turn: 1 } },
    }) + '\n');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('session.event');
    expect(seen[0].params).toEqual({ sessionId: 's1', event: { type: 'turn/start', turn: 1 } });
  });

  it('answers an inbound server→client request with an empty result', async () => {
    const child = fakeChild();
    const rpc = new DeepSeekRpc({ spawnFn: () => child as never });
    rpc.start({});
    child.emit('spawn');
    await rpc.ready();

    const written = new Promise<Record<string, unknown>>((resolve) => {
      child.stdin.once('data', (d: Buffer) => resolve(JSON.parse(d.toString())));
    });
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'x', params: {} }) + '\n');
    await expect(written).resolves.toMatchObject({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('handles CRLF and rejects pending requests on early exit', async () => {
    const child = fakeChild();
    const rpc = new DeepSeekRpc({ spawnFn: () => child as never });
    rpc.start({});
    child.emit('spawn');
    await rpc.ready();

    const seen: unknown[] = [];
    rpc.on('notification', (n) => seen.push(n));
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'idle' } }) + '\r\n');
    expect(seen).toHaveLength(1);

    const pending = rpc.request('session/prompt', { sessionId: 's' });
    child.emit('close', 1);
    await expect(pending).rejects.toThrow(/exited/);
  });

  it('ignores non-JSON stdout lines', async () => {
    const child = fakeChild();
    const rpc = new DeepSeekRpc({ spawnFn: () => child as never });
    rpc.start({});
    child.emit('spawn');
    await rpc.ready();

    const seen: unknown[] = [];
    rpc.on('notification', (n) => seen.push(n));
    child.stdout.write('some banner text\n');
    expect(seen).toHaveLength(0);
  });

  it('captures child stderr in the rejection error on non-zero exit', async () => {
    const child = fakeChild();
    const rpc = new DeepSeekRpc({ spawnFn: () => child as never });
    rpc.start({});
    child.emit('spawn');
    await rpc.ready();

    const pending = rpc.request('initialize', {});
    child.stderr.write('Error: dsh: /some/path/.env sets "PATH"\n');
    child.emit('close', 1);

    await expect(pending).rejects.toThrow(/dsh exited \(code 1\): Error: dsh: \/some\/path\/\.env sets "PATH"/);
  });

  it('safeDshSpawnCwd falls back to homedir when .env sets PATH', async () => {
    const { safeDshSpawnCwd } = await import('./rpc.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { tmpdir, homedir } = await import('os');
    const { join } = await import('path');

    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-test-'));
    try {
      expect(safeDshSpawnCwd(tempDir)).toBe(tempDir);
      writeFileSync(join(tempDir, '.env'), 'PATH=/custom/bin\nFOO=bar\n');
      expect(safeDshSpawnCwd(tempDir)).toBe(process.env.DSH_HOME ?? homedir());
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('spawns with --profile sdk', () => {
    const child = fakeChild();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const rpc = new DeepSeekRpc({
      spawnFn: ((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return child as never;
      }) as never,
    });
    rpc.start({});
    expect(calls).toEqual([{ cmd: 'dsh', args: ['--profile', 'sdk'] }]);
  });
});
