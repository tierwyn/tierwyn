import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { AcpClient, permissionSelected, permissionCancelled } from './acp.js';

function fakeChild(pid?: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
    pid?: number; kill: (s?: string) => void;
  };
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
  if (pid !== undefined) proc.pid = pid;
  proc.kill = () => {};
  return proc;
}

function readWritten(stdin: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => stdin.once('data', (d: Buffer) => resolve(JSON.parse(d.toString()))));
}

describe('permission helpers', () => {
  it('permissionSelected / permissionCancelled use kiro outcome variants', () => {
    expect(permissionSelected('allow_once')).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(permissionCancelled()).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('AcpClient', () => {
  it('spawns kiro-cli acp and never writes an initialized notification', async () => {
    const child = fakeChild();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const written: string[] = [];
    child.stdin.on('data', (d: Buffer) => written.push(d.toString()));
    const client = new AcpClient({
      spawnFn: ((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return child as never;
      }) as never,
    });
    client.start({});
    expect(calls).toEqual([{ cmd: 'kiro-cli', args: ['acp'] }]);

    const reqP = client.request('initialize', { protocolVersion: 1 });
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n');
    await reqP;

    const msgs = written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method?: string });
    expect(msgs.some((m) => m.method === 'initialized')).toBe(false);
    expect(msgs.some((m) => m.method === 'initialize')).toBe(true);
  });

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
      onRequest: (method, _params, reply) => reply(method === 'session/request_permission' ? permissionSelected('allow') : {}),
    });
    client.start({});
    const writtenP = readWritten(child.stdin);
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { options: [{ optionId: 'allow', kind: 'allow_once' }] } }) + '\n');
    const written = await writtenP;
    expect(written).toMatchObject({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  });

  it('rejects pending requests when the process exits with a kiro-cli error string', async () => {
    const child = fakeChild();
    const client = new AcpClient({ spawnFn: () => child as never });
    client.start({});
    const reqP = client.request('session/new', {});
    child.emit('close', 1);
    await expect(reqP).rejects.toThrow(/kiro-cli acp exited/);
  });

  it('kill() signals the whole process group when the child has a pid', () => {
    const child = fakeChild(4242);
    const client = new AcpClient({ spawnFn: () => child as never });
    client.start({});
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      client.kill();
      // negative pid = process group — the orphan-prevention mechanism
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('kill() falls back to child.kill when process.kill throws ESRCH', () => {
    const child = fakeChild(4243);
    const kills: string[] = [];
    child.kill = (s?: string) => { kills.push(s ?? ''); };
    const client = new AcpClient({ spawnFn: () => child as never });
    client.start({});
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const e = new Error('kill ESRCH') as NodeJS.ErrnoException;
      e.code = 'ESRCH';
      throw e;
    });
    try {
      client.kill();
      expect(kills).toEqual(['SIGTERM']);
    } finally {
      killSpy.mockRestore();
    }
  });
});
