import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { HermesAdapter } from './index.js';
import type { NormalisedEvent } from '@tierwyn/shared';

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void;
  };
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr; proc.kill = () => {};
  stdin.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.id === undefined) continue;
      if (msg.method === 'initialize') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } }) + '\n');
      } else if (msg.method === 'session/new') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'h-1' } }) + '\n');
      } else if (msg.method === 'session/set_model') {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
      }
    }
  });
  return proc;
}

async function started(interactionMode: 'bypass' | 'questions' | 'prompt' = 'prompt'): Promise<{ adapter: HermesAdapter; events: NormalisedEvent[] }> {
  const child = fakeChild();
  const adapter = new HermesAdapter({ spawnFn: () => child as never, interactionMode });
  await adapter.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'm' });
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return { adapter, events };
}

describe('HermesAdapter permission interaction', () => {
  it('emits interaction_request when ACP asks for permission and resolves on response', async () => {
    const { adapter, events } = await started();

    let answered: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._onAcpPermissionRequest(
      { description: 'Write to file?', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', label: 'Deny' }] },
      (decision: unknown) => { answered = decision; },
    );

    const req = events.find((e) => e.type === 'interaction_request');
    expect(req).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).payload.kind).toBe('permission');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter.respondToInteraction((req as any).payload.requestId, { selection: ['allow'] });
    expect(answered).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((answered as any).outcome.outcome).toBe('selected');
  });

  it('auto-allows in bypass mode without emitting interaction_request', async () => {
    const { adapter, events } = await started('bypass');

    let answered: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._onAcpPermissionRequest(
      { description: 'Write to file?', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', label: 'Deny' }] },
      (decision: unknown) => { answered = decision; },
    );

    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((answered as any).outcome.outcome).toBe('selected');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((answered as any).outcome.optionId).toBe('allow');
  });

  it('auto-allows in questions mode without emitting interaction_request', async () => {
    const { adapter, events } = await started('questions');

    let answered: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._onAcpPermissionRequest(
      { description: 'Write to file?', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', label: 'Deny' }] },
      (decision: unknown) => { answered = decision; },
    );

    expect(events.some((e) => e.type === 'interaction_request')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((answered as any).outcome.outcome).toBe('selected');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((answered as any).outcome.optionId).toBe('allow');
  });

  it('auto-resolves pending interactions on stop', async () => {
    const { adapter, events } = await started();

    let answered: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._onAcpPermissionRequest(
      { description: 'Run shell?', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }] },
      (decision: unknown) => { answered = decision; },
    );

    await adapter.stop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((answered as any).outcome.outcome).toBe('cancelled');
    expect(events.some((e) => e.type === 'interaction_resolved')).toBe(true);
  });
});
