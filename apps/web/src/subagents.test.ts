import { describe, expect, it } from 'vitest';
import type { HelperEvent, NormalisedEvent, ToolCallEvent, ToolResultEvent } from '@tierwyn/shared';
import {
  collectHelpers,
  helperThread,
  helpersSignature,
  isHelperInner,
  latestTodos,
  mainAgentEvents,
  runningHelperCount,
} from './subagents';

function base(partial: Partial<NormalisedEvent> & Pick<NormalisedEvent, 'type'>): NormalisedEvent {
  return {
    sessionId: 's',
    seq: 1,
    ts: 1000,
    sender: 'agent',
    ...partial,
  } as NormalisedEvent;
}

function helper(payload: HelperEvent['payload'], ts = 1000, seq = 1): HelperEvent {
  return base({ type: 'helper', ts, seq, payload }) as HelperEvent;
}

function toolCall(
  opts: { name: string; toolUseId: string; input?: Record<string, unknown>; parentToolUseId?: string; ts?: number; seq?: number },
): ToolCallEvent {
  return base({
    type: 'tool_call',
    ts: opts.ts ?? 1000,
    seq: opts.seq ?? 1,
    payload: {
      name: opts.name,
      toolUseId: opts.toolUseId,
      input: opts.input ?? {},
      ...(opts.parentToolUseId ? { parentToolUseId: opts.parentToolUseId } : {}),
    },
  }) as ToolCallEvent;
}

function toolResult(opts: { toolUseId: string; content: string; ts?: number; seq?: number }): ToolResultEvent {
  return base({
    type: 'tool_result',
    ts: opts.ts ?? 2000,
    seq: opts.seq ?? 2,
    payload: { toolUseId: opts.toolUseId, content: opts.content },
  }) as ToolResultEvent;
}

const runningPayload: HelperEvent['payload'] = {
  taskId: 't1',
  toolUseId: 'tu1',
  label: 'Explore',
  description: 'list files',
  status: 'running',
  startedAt: 1000,
};

describe('collectHelpers', () => {
  it('keeps the newest adapter snapshot per taskId', () => {
    const runs = collectHelpers([
      helper({ ...runningPayload, summary: 'old' }, 1000, 1),
      helper({ ...runningPayload, summary: 'new', lastToolName: 'Bash' }, 2000, 2),
    ], { live: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      key: 't1',
      toolUseId: 'tu1',
      label: 'Explore',
      status: 'running',
      summary: 'new',
      lastToolName: 'Bash',
      source: 'adapter',
    });
  });

  it('keeps completed when live', () => {
    const runs = collectHelpers([
      helper({ ...runningPayload, status: 'completed', summary: 'done' }, 3000, 3),
    ], { live: true });
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.endedAt).toBe(3000);
  });

  it('maps running to stopped when not live', () => {
    const runs = collectHelpers([helper(runningPayload)], { live: false });
    expect(runs[0]!.status).toBe('stopped');
  });

  it('detects an Agent call without subagent_type as helper', () => {
    const runs = collectHelpers([
      toolCall({ name: 'Agent', toolUseId: 'tu-a', input: { description: 'look around' } }),
    ], { live: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      key: 'tu-a',
      label: 'helper',
      status: 'running',
      source: 'transcript',
    });
  });

  it('never claims running for a snapshot-less async launch (legacy transcripts)', () => {
    const runs = collectHelpers([
      toolCall({ name: 'Agent', toolUseId: 'tu-a', input: { description: 'bg' } }),
      toolResult({ toolUseId: 'tu-a', content: 'Async agent launched successfully with id t1' }),
    ], { live: true });
    expect(runs[0]!.status).toBe('completed');
  });

  it('marks a Task call with a normal result completed', () => {
    const runs = collectHelpers([
      toolCall({ name: 'Task', toolUseId: 'tu-t', input: { subagent_type: 'Explore', description: 'files' } }),
      toolResult({ toolUseId: 'tu-t', content: 'listed two files' }),
    ], { live: true });
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.label).toBe('Explore');
  });

  it('does not duplicate a tool_call claimed by an adapter helper', () => {
    const runs = collectHelpers([
      toolCall({ name: 'Agent', toolUseId: 'tu1', input: { subagent_type: 'Explore', description: 'list files' } }),
      helper(runningPayload, 1500, 2),
    ], { live: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.source).toBe('adapter');
    expect(runs[0]!.key).toBe('t1');
  });

  it('nests via parentTaskId with depth 1 after the parent', () => {
    const parent: HelperEvent['payload'] = { ...runningPayload, taskId: 'parent', toolUseId: 'tu-p', startedAt: 1000 };
    const child: HelperEvent['payload'] = {
      ...runningPayload,
      taskId: 'child',
      toolUseId: 'tu-c',
      parentTaskId: 'parent',
      startedAt: 1100,
    };
    const runs = collectHelpers([helper(parent, 1000, 1), helper(child, 1100, 2)], { live: true });
    expect(runs.map((r) => r.key)).toEqual(['parent', 'child']);
    expect(runs[1]).toMatchObject({ parentKey: 'parent', depth: 1 });
  });

  it('falls back toolUses to counting child tool_calls', () => {
    const runs = collectHelpers([
      toolCall({ name: 'Task', toolUseId: 'tu-t', input: { subagent_type: 'Explore', description: 'x' }, seq: 1 }),
      toolCall({ name: 'Bash', toolUseId: 'tu-b', input: {}, parentToolUseId: 'tu-t', seq: 2 }),
      toolCall({ name: 'Read', toolUseId: 'tu-r', input: {}, parentToolUseId: 'tu-t', seq: 3 }),
    ], { live: true });
    expect(runs[0]!.toolUses).toBe(2);
  });
});

describe('helpersSignature / runningHelperCount / helperThread', () => {
  it('keeps the signature stable for the same state and changes when status changes', () => {
    const a = [helper(runningPayload)];
    const sig1 = helpersSignature(collectHelpers(a, { live: true }));
    const sig2 = helpersSignature(collectHelpers(a, { live: true }));
    expect(sig1).toBe(sig2);
    const sig3 = helpersSignature(collectHelpers(
      [helper({ ...runningPayload, status: 'completed' }, 2000, 2)],
      { live: true },
    ));
    expect(sig3).not.toBe(sig1);
  });

  it('counts running helpers after liveness', () => {
    const events = [helper(runningPayload), helper({ ...runningPayload, taskId: 't2', toolUseId: 'tu2', status: 'completed' })];
    expect(runningHelperCount(collectHelpers(events, { live: true }))).toBe(1);
    expect(runningHelperCount(collectHelpers(events, { live: false }))).toBe(0);
  });

  it('helperThread returns inner message/tool events for a toolUseId', () => {
    const events: NormalisedEvent[] = [
      toolCall({ name: 'Agent', toolUseId: 'tu1', input: { description: 'x' } }),
      base({ type: 'message', payload: { chunk: 'hi', final: true, parentToolUseId: 'tu1' } }),
      toolCall({ name: 'Bash', toolUseId: 'inner', parentToolUseId: 'tu1' }),
      base({ type: 'message', payload: { chunk: 'outer', final: true } }),
    ];
    const thread = helperThread(events, 'tu1');
    expect(thread).toHaveLength(2);
    expect(thread.map((e) => e.type)).toEqual(['message', 'tool_call']);
  });

  it('isHelperInner is true only for message/tool events with parentToolUseId', () => {
    expect(isHelperInner(toolCall({ name: 'Bash', toolUseId: 'inner', parentToolUseId: 'tu1' }))).toBe(true);
    expect(isHelperInner(toolCall({ name: 'Agent', toolUseId: 'tu1' }))).toBe(false);
    expect(isHelperInner(helper(runningPayload))).toBe(false);
  });
});

describe('mainAgentEvents', () => {
  it('drops helper snapshots and helper inner events; helper todos never replace the main list', () => {
    const evs = [
      toolCall({ name: 'TodoWrite', toolUseId: 'm1', input: { todos: [{ content: 'main', status: 'pending' }] } }),
      helper({ taskId: 't1', label: 'Explore', description: '', status: 'running', startedAt: 0 }),
      toolCall({ name: 'TodoWrite', toolUseId: 'h1', parentToolUseId: 'tu-x', input: { todos: [{ content: 'helper', status: 'pending' }] } }),
    ];
    expect(mainAgentEvents(evs).map((e) => e.type)).toEqual(['tool_call']);
    expect(latestTodos(evs)?.[0]?.content).toBe('main');
  });
});

describe('transcript-path helper summary', () => {
  it('uses the tool_result content as the result summary', () => {
    const [run] = collectHelpers([
      toolCall({ name: 'Agent', toolUseId: 'thr-1', input: { subagent_type: 'codex', prompt: 'hostname' } }),
      toolResult({ toolUseId: 'thr-1', content: 'dev-box' }),
    ], { live: true });
    expect(run.status).toBe('completed');
    expect(run.summary).toBe('dev-box');
  });
});
