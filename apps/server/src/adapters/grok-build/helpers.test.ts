import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { HelperEvent } from '@tierwyn/shared';
import type { PartialEvent } from './mapping.js';
import {
  parseSpawnSubagentResult,
  parseSubagentTaskOutput,
  GrokHelperTracker,
} from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('parseSpawnSubagentResult', () => {
  it('extracts subagent_id and type from the launch ack', () => {
    const text = 'Subagent started in background.\nsubagent_id: 11111111-1111-4111-8111-111111111111\ntype: explore';
    expect(parseSpawnSubagentResult(text)).toEqual({
      subagentId: '11111111-1111-4111-8111-111111111111',
      type: 'explore',
    });
  });

  it('returns null when the ack has no subagent_id', () => {
    expect(parseSpawnSubagentResult('Subagent started in background.')).toBeNull();
  });
});

describe('parseSubagentTaskOutput', () => {
  it('maps TaskOutput completed with duration and summary', () => {
    expect(parseSubagentTaskOutput({
      type: 'TaskOutput',
      Result: {
        task_id: '11111111-1111-4111-8111-111111111111',
        status: 'completed',
        exit_code: 0,
        duration_secs: 12.5,
        output: 'found 3 files',
      },
    })).toEqual({
      taskId: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      durationMs: 12_500,
      summary: 'found 3 files',
    });
  });

  it('maps non-zero exit_code to failed', () => {
    expect(parseSubagentTaskOutput({
      type: 'TaskOutput',
      Result: { task_id: 't1', status: 'completed', exit_code: 1, output: 'boom' },
    })?.status).toBe('failed');
  });

  it('maps TaskNotFound to stopped', () => {
    expect(parseSubagentTaskOutput({ type: 'TaskNotFound' })).toEqual({ status: 'stopped' });
  });

  it('returns null for unrelated rawOutput', () => {
    expect(parseSubagentTaskOutput({ type: 'Text' })).toBeNull();
    expect(parseSubagentTaskOutput(null)).toBeNull();
  });
});

function helpersOf(events: PartialEvent[]): HelperEvent['payload'][] {
  return events
    .filter((e): e is Extract<PartialEvent, { type: 'helper' }> => e.type === 'helper')
    .map((e) => e.payload);
}

function spawnLaunch(toolCallId: string, input: Record<string, unknown> = {}) {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'spawn_subagent',
    rawInput: { description: 'explore repo', prompt: 'list files', ...input },
  };
}

function spawnAck(toolCallId: string, text: string) {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  };
}

describe('GrokHelperTracker', () => {
  it('emits a running helper when spawn_subagent completes with a subagent_id', () => {
    const events: PartialEvent[] = [];
    const tracker = new GrokHelperTracker({ emit: (e) => events.push(e), now: () => 1_700_000_000_000 });
    tracker.observe(spawnLaunch('tc-spawn', { subagent_type: 'explore' }));
    tracker.observe(spawnAck(
      'tc-spawn',
      'Subagent started in background.\nsubagent_id: 11111111-1111-4111-8111-111111111111\ntype: explore',
    ));

    expect(helpersOf(events)).toEqual([{
      taskId: '11111111-1111-4111-8111-111111111111',
      toolUseId: 'tc-spawn',
      label: 'explore',
      description: 'explore repo',
      status: 'running',
      startedAt: 1_700_000_000_000,
      background: true,
    }]);
  });

  it('defaults label to general-purpose and background true when omitted', () => {
    const events: PartialEvent[] = [];
    const tracker = new GrokHelperTracker({ emit: (e) => events.push(e), now: () => 1 });
    tracker.observe(spawnLaunch('tc-spawn'));
    tracker.observe(spawnAck('tc-spawn', 'subagent_id: 22222222-2222-4222-8222-222222222222'));
    expect(helpersOf(events)[0]).toMatchObject({
      label: 'general-purpose',
      background: true,
    });
  });

  it('emits completed when get_command_or_subagent_output returns TaskOutput', () => {
    const events: PartialEvent[] = [];
    const tracker = new GrokHelperTracker({ emit: (e) => events.push(e), now: () => 1 });
    tracker.observe(spawnLaunch('tc-spawn'));
    tracker.observe(spawnAck('tc-spawn', 'subagent_id: 11111111-1111-4111-8111-111111111111'));
    tracker.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-out',
      title: 'get_command_or_subagent_output',
      rawInput: { task_id: '11111111-1111-4111-8111-111111111111' },
    });
    tracker.observe({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-out',
      status: 'completed',
      content: 'found 3 files',
      rawOutput: {
        type: 'TaskOutput',
        Result: {
          task_id: '11111111-1111-4111-8111-111111111111',
          status: 'completed',
          exit_code: 0,
          duration_secs: 2,
          output: 'found 3 files',
        },
      },
    });

    const last = helpersOf(events).at(-1);
    expect(last).toMatchObject({
      taskId: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      usage: { totalTokens: 0, toolUses: 0, durationMs: 2000 },
      summary: 'found 3 files',
    });
  });

  it('emits stopped when kill_command_or_subagent finishes for a known id', () => {
    const events: PartialEvent[] = [];
    const tracker = new GrokHelperTracker({ emit: (e) => events.push(e), now: () => 1 });
    tracker.observe(spawnLaunch('tc-spawn'));
    tracker.observe(spawnAck('tc-spawn', 'subagent_id: 11111111-1111-4111-8111-111111111111'));
    tracker.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-kill',
      title: 'kill_command_or_subagent',
      rawInput: { task_id: '11111111-1111-4111-8111-111111111111' },
    });
    tracker.observe({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-kill',
      status: 'completed',
      content: 'killed',
    });
    expect(helpersOf(events).at(-1)?.status).toBe('stopped');
  });

  it('emits stopped on TaskNotFound', () => {
    const events: PartialEvent[] = [];
    const tracker = new GrokHelperTracker({ emit: (e) => events.push(e), now: () => 1 });
    tracker.observe(spawnLaunch('tc-spawn'));
    tracker.observe(spawnAck('tc-spawn', 'subagent_id: 11111111-1111-4111-8111-111111111111'));
    tracker.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-out',
      title: 'get_command_or_subagent_output',
      rawInput: { task_id: '11111111-1111-4111-8111-111111111111' },
    });
    tracker.observe({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-out',
      status: 'failed',
      content: 'TaskNotFound',
      rawOutput: { type: 'TaskNotFound' },
    });
    expect(helpersOf(events).at(-1)?.status).toBe('stopped');
  });

  it('does not emit a helper for a non-subagent tool', () => {
    const events: PartialEvent[] = [];
    const tracker = new GrokHelperTracker({ emit: (e) => events.push(e) });
    tracker.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-read',
      title: 'read_file',
      rawInput: { target_file: '/a.ts' },
    });
    tracker.observe({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-read',
      status: 'completed',
      content: 'ok',
    });
    expect(helpersOf(events)).toEqual([]);
  });

  it('close() marks remaining running helpers stopped', () => {
    const events: PartialEvent[] = [];
    const tracker = new GrokHelperTracker({ emit: (e) => events.push(e), now: () => 1 });
    tracker.observe(spawnLaunch('tc-spawn'));
    tracker.observe(spawnAck('tc-spawn', 'subagent_id: 11111111-1111-4111-8111-111111111111'));
    tracker.close();
    expect(helpersOf(events).at(-1)?.status).toBe('stopped');
  });

  it('polls output.json and completes the helper when the parent never fetches', () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'grok-helpers-'));
    const events: PartialEvent[] = [];
    try {
      const tracker = new GrokHelperTracker({
        emit: (e) => events.push(e),
        now: () => Date.now(),
        sessionDir: () => root,
        pollMs: 50,
      });
      tracker.observe(spawnLaunch('tc-spawn'));
      tracker.observe(spawnAck('tc-spawn', 'subagent_id: 11111111-1111-4111-8111-111111111111'));
      expect(helpersOf(events)[0]?.status).toBe('running');

      const outDir = join(root, 'subagents', '11111111-1111-4111-8111-111111111111');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'output.json'), JSON.stringify({
        status: 'completed',
        exit_code: 0,
        duration_secs: 3,
        output: 'from disk',
      }));

      vi.advanceTimersByTime(60);
      expect(helpersOf(events).at(-1)).toMatchObject({
        status: 'completed',
        summary: 'from disk',
        usage: { totalTokens: 0, toolUses: 0, durationMs: 3000 },
      });
      tracker.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
