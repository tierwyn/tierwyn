import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HelperEvent, NormalisedEvent } from '@tierwyn/shared';
import { ClaudeCodeAdapter as CCAdapter } from './index.js';

async function startedAdapter() {
  const adapter = new CCAdapter();
  await adapter.start({ sessionId: 's', conversationId: 'c-helpers', cwd: '/tmp', model: 'claude-haiku-4-5' });
  const events: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  return { adapter, events };
}

function helpersOf(events: NormalisedEvent[]): HelperEvent[] {
  return events.filter((e): e is HelperEvent => e.type === 'helper');
}

function handle(adapter: CCAdapter, msg: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any)._handleSdkMessage(msg);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ClaudeCodeAdapter helper mapping', () => {
  it('emits a running helper from task_started local_agent Explore', async () => {
    const { adapter, events } = await startedAdapter();
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    handle(adapter, {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      tool_use_id: 'tu1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'list files',
      is_backgrounded: true,
    });

    const h = helpersOf(events);
    expect(h).toHaveLength(1);
    expect(h[0]!.payload).toMatchObject({
      taskId: 't1',
      toolUseId: 'tu1',
      label: 'Explore',
      description: 'list files',
      status: 'running',
      startedAt: now,
      background: true,
    });
  });

  it('ignores local_bash, ambient, and main-session task_started', async () => {
    const { adapter, events } = await startedAdapter();
    handle(adapter, {
      type: 'system',
      subtype: 'task_started',
      task_id: 'bash1',
      task_type: 'local_bash',
      description: 'ls',
    });
    handle(adapter, {
      type: 'system',
      subtype: 'task_started',
      task_id: 'amb1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'watch',
      ambient: true,
    });
    handle(adapter, {
      type: 'system',
      subtype: 'task_started',
      task_id: 'main1',
      task_type: 'local_agent',
      subagent_type: 'main-session',
      description: 'bg main',
    });
    expect(helpersOf(events)).toHaveLength(0);
  });

  it('throttles task_progress to one emit per 15s and maps usage', async () => {
    const { adapter, events } = await startedAdapter();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    handle(adapter, {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      tool_use_id: 'tu1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'list files',
    });
    expect(helpersOf(events)).toHaveLength(1);

    handle(adapter, {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      usage: { total_tokens: 10, tool_uses: 2, duration_ms: 500 },
      last_tool_name: 'Bash',
      summary: 'listing',
    });
    expect(helpersOf(events)).toHaveLength(2);
    expect(helpersOf(events)[1]!.payload).toMatchObject({
      usage: { totalTokens: 10, toolUses: 2, durationMs: 500 },
      lastToolName: 'Bash',
      summary: 'listing',
    });

    vi.setSystemTime(10_000);
    handle(adapter, {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      usage: { total_tokens: 20, tool_uses: 3, duration_ms: 900 },
      last_tool_name: 'Glob',
      summary: 'still listing',
    });
    expect(helpersOf(events)).toHaveLength(2);

    vi.setSystemTime(16_000);
    handle(adapter, {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      usage: { total_tokens: 30, tool_uses: 4, duration_ms: 1500 },
      last_tool_name: 'Read',
      summary: 'done listing',
    });
    expect(helpersOf(events)).toHaveLength(3);
    expect(helpersOf(events)[2]!.payload.lastToolName).toBe('Read');
  });

  it('emits task_notification completed even inside the throttle window', async () => {
    const { adapter, events } = await startedAdapter();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    handle(adapter, {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      tool_use_id: 'tu1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'list files',
    });
    handle(adapter, {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
    });
    expect(helpersOf(events)).toHaveLength(2);

    vi.setSystemTime(2_000);
    handle(adapter, {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'found two files',
      usage: { total_tokens: 20, tool_uses: 1, duration_ms: 400 },
    });
    const last = helpersOf(events).at(-1)!;
    expect(helpersOf(events).length).toBe(3);
    expect(last.payload.status).toBe('completed');
    expect(last.payload.summary).toBe('found two files');
    expect(last.payload.usage).toEqual({ totalTokens: 20, toolUses: 1, durationMs: 400 });
  });

  it('maps task_updated status and background flag; ignores running/pending/paused', async () => {
    const { adapter, events } = await startedAdapter();
    handle(adapter, {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'work',
    });
    const afterStart = helpersOf(events).length;

    handle(adapter, {
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'running' },
    });
    handle(adapter, {
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'pending' },
    });
    handle(adapter, {
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'paused' },
    });
    expect(helpersOf(events)).toHaveLength(afterStart);

    handle(adapter, {
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { is_backgrounded: true },
    });
    expect(helpersOf(events).at(-1)!.payload.background).toBe(true);

    handle(adapter, {
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'killed' },
    });
    expect(helpersOf(events).at(-1)!.payload.status).toBe('stopped');

    const { adapter: a2, events: e2 } = await startedAdapter();
    handle(a2, {
      type: 'system',
      subtype: 'task_started',
      task_id: 't2',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'work',
    });
    handle(a2, {
      type: 'system',
      subtype: 'task_updated',
      task_id: 't2',
      patch: { status: 'failed' },
    });
    expect(helpersOf(e2).at(-1)!.payload.status).toBe('failed');

    const { adapter: a3, events: e3 } = await startedAdapter();
    handle(a3, {
      type: 'system',
      subtype: 'task_started',
      task_id: 't3',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'work',
    });
    handle(a3, {
      type: 'system',
      subtype: 'task_updated',
      task_id: 't3',
      patch: { status: 'completed' },
    });
    expect(helpersOf(e3).at(-1)!.payload.status).toBe('completed');
  });

  it('registers unknown local_agent from background_tasks_changed and completes missing running helpers', async () => {
    const { adapter, events } = await startedAdapter();
    handle(adapter, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{
        task_id: 't-unknown',
        task_type: 'local_agent',
        subagent_type: 'Explore',
        description: 'recovered',
      }],
    });
    expect(helpersOf(events)).toHaveLength(1);
    expect(helpersOf(events)[0]!.payload).toMatchObject({
      taskId: 't-unknown',
      label: 'Explore',
      description: 'recovered',
      status: 'running',
    });

    handle(adapter, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
    });
    expect(helpersOf(events).at(-1)!.payload.status).toBe('completed');
  });

  it('ignores task_progress for an unknown task', async () => {
    const { adapter, events } = await startedAdapter();
    handle(adapter, {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'nope',
      usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
    });
    expect(helpersOf(events)).toHaveLength(0);
  });

  it('stop() emits stopped for running helpers before end', async () => {
    const { adapter, events } = await startedAdapter();
    const ended: string[] = [];
    adapter.streamEvents().on('end', () => ended.push('end'));

    handle(adapter, {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'work',
    });
    await adapter.stop();

    const helperIdx = events.findIndex((e) => e.type === 'helper' && e.payload.status === 'stopped');
    const idleIdx = events.findIndex((e) => e.type === 'status' && e.payload.status === 'idle');
    expect(helperIdx).toBeGreaterThanOrEqual(0);
    expect(idleIdx).toBeGreaterThan(helperIdx);
    expect(ended).toEqual(['end']);
  });

  it('stopHelper calls query.stopTask and throws no_live_query without a query', async () => {
    const { adapter } = await startedAdapter();
    const stopTask = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._query = { stopTask };
    await adapter.stopHelper('t1');
    expect(stopTask).toHaveBeenCalledWith('t1');

    const { adapter: dead } = await startedAdapter();
    await expect(dead.stopHelper('t1')).rejects.toThrow('no_live_query');
  });
});
