import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { KimiAdapter } from './index.js';
import type { ChildProcess } from 'child_process';
import type { NormalisedEvent } from '@tierwyn/shared';

type FakeProc = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (s?: string) => void;
};

function parseLines(buf: Buffer): Record<string, unknown>[] {
  return buf.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function fakeChild(): {
  proc: FakeProc;
  writes: Record<string, unknown>[];
  spawnFn: (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as FakeProc;
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr; proc.kill = () => {};
  const writes: Record<string, unknown>[] = [];

  stdin.on('data', (d: Buffer) => {
    for (const msg of parseLines(d)) {
      writes.push(msg);
      if (msg.id === undefined) continue;
      if (msg.method === 'initialize') {
        stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: false } },
        }) + '\n');
      } else if (msg.method === 'session/new') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session_kimi-1' } }) + '\n');
      } else if (msg.method === 'session/set_model') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
      }
    }
  });

  return {
    proc,
    writes,
    spawnFn: () => proc as never,
  };
}

async function started(interactionMode: 'bypass' | 'questions' | 'prompt'): Promise<{
  adapter: KimiAdapter;
  events: NormalisedEvent[];
  proc: FakeProc;
  writes: Record<string, unknown>[];
}> {
  const { proc, writes, spawnFn } = fakeChild();
  const adapter = new KimiAdapter({ spawnFn, interactionMode });
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'm' });
  return { adapter, events, proc, writes };
}

function sendPermission(proc: FakeProc, id: number, params: Record<string, unknown>): void {
  proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params }) + '\n');
}

const ALLOW_OPTIONS = [
  { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
];

describe('KimiAdapter permission interaction', () => {
  it('bypass mode auto-answers the allow-kind option and emits no interaction_request', async () => {
    const { adapter, events, proc, writes } = await started('bypass');
    void adapter;
    sendPermission(proc, 7, { options: ALLOW_OPTIONS, toolCall: { title: 'Write' } });
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    expect(writes.find((w) => w.id === 7)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
  });

  it('questions mode auto-allows the same way', async () => {
    const { events, proc, writes } = await started('questions');
    sendPermission(proc, 8, { options: ALLOW_OPTIONS });
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    expect(writes.find((w) => w.id === 8)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
  });

  it('selects the first option when no kind contains allow', async () => {
    const { proc, writes } = await started('bypass');
    sendPermission(proc, 9, {
      options: [
        { optionId: 'opt_first', name: 'Continue', kind: 'proceed' },
        { optionId: 'opt_second', name: 'Abort', kind: 'reject_once' },
      ],
    });
    await new Promise((r) => setImmediate(r));
    expect(writes.find((w) => w.id === 9)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'opt_first' } },
    });
  });

  it('replies permissionCancelled when options is empty', async () => {
    const { proc, writes } = await started('bypass');
    sendPermission(proc, 10, { options: [] });
    await new Promise((r) => setImmediate(r));
    expect(writes.find((w) => w.id === 10)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    });
  });

  it('prompt mode emits interaction_request + waiting and writes nothing until respondToInteraction', async () => {
    const { adapter, events, proc, writes } = await started('prompt');
    const before = writes.length;
    sendPermission(proc, 11, { options: ALLOW_OPTIONS, description: 'Write to file?' });
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'interaction_request');
    expect(req).toBeDefined();
    expect(req && req.type === 'interaction_request' && req.payload.kind).toBe('permission');
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'waiting')).toBe(true);
    expect(writes.length).toBe(before);
    expect(writes.find((w) => w.id === 11)).toBeUndefined();

    adapter.respondToInteraction(
      (req as Extract<NormalisedEvent, { type: 'interaction_request' }>).payload.requestId,
      { selection: ['allow-once'] },
    );
    expect(events.some((e) => e.type === 'interaction_resolved' && e.payload.resolution === 'answered')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'running')).toBe(true);
    expect(writes.find((w) => w.id === 11)).toMatchObject({
      jsonrpc: '2.0',
      id: 11,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
  });

  it('prompt mode maps choices optionId→id and name/label/kind/optionId→label', async () => {
    const { events, proc } = await started('prompt');
    sendPermission(proc, 13, {
      options: [
        { optionId: 'from-name', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'from-label', kind: 'reject_once', label: 'Deny' },
      ],
      description: 'Write?',
    });
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'interaction_request');
    expect(req && req.type === 'interaction_request' && req.payload.choices).toEqual([
      { id: 'from-name', label: 'Allow once' },
      { id: 'from-label', label: 'Deny' },
    ]);
  });

  it('respondToInteraction with an unknown requestId is a no-op', async () => {
    const { adapter, proc, writes } = await started('prompt');
    sendPermission(proc, 12, { options: ALLOW_OPTIONS });
    await new Promise((r) => setImmediate(r));
    const before = writes.length;
    expect(() => adapter.respondToInteraction('no-such-id', { selection: ['allow-once'] })).not.toThrow();
    expect(writes.length).toBe(before);
    expect(writes.find((w) => w.id === 12)).toBeUndefined();
  });
});
