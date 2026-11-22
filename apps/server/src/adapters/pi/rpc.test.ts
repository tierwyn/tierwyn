import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { PiRpc } from './rpc.js';

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

describe('PiRpc transport', () => {
  it('resolves ready on spawn even when no ready frame is sent (real pi --mode rpc behaviour)', async () => {
    // pi v0.79.3 in --mode rpc never emits {"type":"ready"}; it spawns and accepts
    // commands immediately. Readiness must therefore be driven by the spawn event.
    const child = fakeChild();
    const rpc = new PiRpc({ spawnFn: () => child as never });
    rpc.start({ cwd: '/tmp', args: [] });

    child.emit('spawn'); // no ready frame is ever written
    await rpc.ready();   // must resolve regardless

    const writes: string[] = [];
    child.stdin.on('data', (d) => writes.push(d.toString()));
    const pending = rpc.request({ type: 'get_available_models' });
    const sent = JSON.parse(writes[0]);
    child.stdout.write(JSON.stringify({ type: 'response', id: sent.id, command: 'get_available_models', success: true, data: { models: [] } }) + '\n');
    const res = await pending;
    expect(res.success).toBe(true);
  });

  it('resolves ready when the ready frame arrives, then correlates a response by id', async () => {
    const child = fakeChild();
    const rpc = new PiRpc({ spawnFn: () => child as never });
    rpc.start({ cwd: '/tmp', args: [] });

    child.stdout.write('{"type":"ready"}\n');
    await rpc.ready();

    const writes: string[] = [];
    child.stdin.on('data', (d) => writes.push(d.toString()));

    const pending = rpc.request({ type: 'get_available_models' });
    const sent = JSON.parse(writes[0]);
    expect(sent.type).toBe('get_available_models');
    expect(typeof sent.id).toBe('string');
    child.stdout.write(JSON.stringify({ type: 'response', id: sent.id, command: 'get_available_models', success: true, data: { models: [] } }) + '\n');

    const res = await pending;
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ models: [] });
  });

  it('emits id-less lines as events', async () => {
    const child = fakeChild();
    const rpc = new PiRpc({ spawnFn: () => child as never });
    rpc.start({ cwd: '/tmp', args: [] });
    child.stdout.write('{"type":"ready"}\n');
    await rpc.ready();

    const events: unknown[] = [];
    rpc.on('event', (e) => events.push(e));
    child.stdout.write('{"type":"agent_start"}\n');
    expect(events).toEqual([{ type: 'agent_start' }]);
  });

  it('handles CRLF and rejects pending requests on early exit', async () => {
    const child = fakeChild();
    const rpc = new PiRpc({ spawnFn: () => child as never });
    rpc.start({ cwd: '/tmp', args: [] });
    child.stdout.write('{"type":"ready"}\r\n');
    await rpc.ready();
    const p = rpc.request({ type: 'get_state' });
    child.emit('close', 1);
    await expect(p).rejects.toThrow(/exited/);
  });
});
