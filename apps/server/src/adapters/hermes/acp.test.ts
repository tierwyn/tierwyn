import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { AcpClient } from './acp.js';

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void;
  };
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr; proc.kill = () => {};
  return proc;
}

function readWritten(stdin: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => stdin.once('data', (d: Buffer) => resolve(JSON.parse(d.toString()))));
}

describe('AcpClient', () => {
  it('sends a JSON-RPC request and resolves with the correlated result', async () => {
    const child = fakeChild();
    const client = new AcpClient({ spawnFn: () => child as never });
    client.start({});
    const writtenP = readWritten(child.stdin);
    const reqP = client.request('initialize', { protocolVersion: 1 });
    const written = await writtenP;
    expect(written).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
    await expect(reqP).resolves.toMatchObject({ protocolVersion: 1 });
  });

  it('emits a notification for id-less messages', async () => {
    const child = fakeChild();
    const client = new AcpClient({ spawnFn: () => child as never });
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    client.on('notification', (n) => seen.push(n));
    client.start({});
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } } }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('session/update');
  });

  it('auto-responds to an inbound agent request via onRequest', async () => {
    const child = fakeChild();
    const client = new AcpClient({
      spawnFn: () => child as never,
      onRequest: (method, _params, reply) => reply(method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'allow' } } : {}),
    });
    client.start({});
    const writtenP = readWritten(child.stdin);
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { options: [{ optionId: 'allow', kind: 'allow_once' }] } }) + '\n');
    const written = await writtenP;
    expect(written).toMatchObject({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  });

  it('rejects pending requests when the process exits', async () => {
    const child = fakeChild();
    const client = new AcpClient({ spawnFn: () => child as never });
    client.start({});
    const reqP = client.request('session/new', {});
    child.emit('close', 1);
    await expect(reqP).rejects.toThrow(/exited/);
  });
});
