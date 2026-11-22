import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from './index.js';
import type { NormalisedEvent } from '@tierwyn/shared';

function capture(adapter: ClaudeCodeAdapter): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return events;
}

async function started(): Promise<ClaudeCodeAdapter> {
  const a = new ClaudeCodeAdapter({ interactionMode: 'prompt' });
  await a.start({ sessionId: 's', conversationId: 'c', cwd: '/tmp', model: 'm' });
  return a;
}

describe('ClaudeCodeAdapter permission interaction', () => {
  it('emits interaction_request + status:waiting and resolves allow', async () => {
    const a = await started();
    const events = capture(a);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = (a as any)._canUseTool('Bash', { command: 'ls' }, { suggestions: undefined });

    const req = events.find((e) => e.type === 'interaction_request');
    expect(req).toBeDefined();
    expect(req!.payload).toMatchObject({ kind: 'permission', toolName: 'Bash' });
    expect(events.some((e) => e.type === 'status' && e.payload.status === 'waiting')).toBe(true);

    const requestId = (req as Extract<NormalisedEvent, { type: 'interaction_request' }>).payload.requestId;
    a.respondToInteraction(requestId, { selection: ['allow'] });

    const result = await promise;
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(events.some((e) => e.type === 'interaction_resolved')).toBe(true);
  });

  it('resolves deny with the operator reason', async () => {
    const a = await started();
    const events = capture(a);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = (a as any)._canUseTool('Bash', { command: 'rm -rf /' }, {});
    const req = events.find((e) => e.type === 'interaction_request')!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestId = (req as any).payload.requestId;
    a.respondToInteraction(requestId, { selection: ['deny'], text: 'too risky' });
    const result = await promise;
    expect(result).toMatchObject({ behavior: 'deny', message: 'too risky' });
  });

  it('auto-denies pending interactions on stop (hang-safety)', async () => {
    const a = await started();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = (a as any)._canUseTool('Bash', { command: 'ls' }, {});
    await a.stop();
    const result = await promise;
    expect(result).toMatchObject({ behavior: 'deny' });
  });
});

describe('ClaudeCodeAdapter question interaction', () => {
  it('emits a question interaction_request via canUseTool', async () => {
    const a = await started();
    const events = capture(a);
    // canUseTool is the SDK permission callback that surfaces AskUserQuestion.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (a as any)._canUseTool('AskUserQuestion', { questions: [{ question: 'Pick a DB', header: 'DB',
      multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }, {});
    const req = events.find((e) => e.type === 'interaction_request');
    expect(req).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).payload.kind).toBe('question');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).payload.choices.map((c: any) => c.label)).toEqual(['Postgres', 'SQLite']);
  });

  it('resolves canUseTool with the answer in updatedInput', async () => {
    const a = await started();
    const events = capture(a);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = (a as any)._canUseTool('AskUserQuestion',
      { questions: [{ question: 'Pick', header: 'H', options: [{ label: 'A' }, { label: 'B' }] }] }, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestId = (events.find((e) => e.type === 'interaction_request') as any).payload.requestId;
    a.respondToInteraction(requestId, { selection: ['B'] });
    const result = await promise;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toMatchObject({ Pick: 'B' });
  });
});
