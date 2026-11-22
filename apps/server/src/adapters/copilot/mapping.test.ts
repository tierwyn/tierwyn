import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  mapCopilotFrame,
  createCopilotStreamState,
  parseFilePaths,
  changeKindFor,
  usageFromState,
  type CopilotStreamState,
} from './mapping.js';
import type { PartialEvent } from './mapping.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFrames(name: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function mapAll(name: string): { events: PartialEvent[]; state: CopilotStreamState } {
  const state = createCopilotStreamState();
  const events: PartialEvent[] = [];
  for (const frame of loadFrames(name)) {
    events.push(...mapCopilotFrame(frame, state));
  }
  return { events, state };
}

describe('parseFilePaths', () => {
  it('parses a JSON-encoded string of paths', () => {
    expect(parseFilePaths('["/a","/b"]')).toEqual(['/a', '/b']);
  });

  it('returns [] for non-JSON input', () => {
    expect(parseFilePaths('not json')).toEqual([]);
  });

  it('returns [] for null/undefined/non-string non-array', () => {
    expect(parseFilePaths(undefined)).toEqual([]);
    expect(parseFilePaths(null)).toEqual([]);
    expect(parseFilePaths(42)).toEqual([]);
  });

  it('passes through an already-parsed array', () => {
    expect(parseFilePaths(['/a', '/b'])).toEqual(['/a', '/b']);
  });
});

describe('changeKindFor', () => {
  it('maps create → created, delete/remove → deleted, else modified', () => {
    expect(changeKindFor('create')).toBe('created');
    expect(changeKindFor('delete')).toBe('deleted');
    expect(changeKindFor('remove')).toBe('deleted');
    expect(changeKindFor('edit')).toBe('modified');
    expect(changeKindFor(undefined)).toBe('modified');
  });
});

describe('mapCopilotFrame — text-turn fixture', () => {
  it('yields status:running, streamed deltas, flush marker; status:done is left to the adapter', () => {
    const { events } = mapAll('text-turn.v1.0.82.jsonl');
    expect(events.map((e) => e.type)).toEqual(['status', 'message', 'message']);
    expect(events[0]).toEqual({ type: 'status', payload: { status: 'running' } });
    expect(events[1]).toEqual({ type: 'message', payload: { chunk: 'pong', final: false } });
    // deltas were seen for this messageId → terminal assistant.message is a flush, not a replay
    expect(events[2]).toEqual({ type: 'message', payload: { chunk: '', final: true } });
    expect(events.every((e) => e.type !== 'status' || e.payload.status === 'running')).toBe(true);
  });

  it('session.skills_loaded and model.messages_snapshot yield zero events', () => {
    const frames = loadFrames('text-turn.v1.0.82.jsonl');
    const state = createCopilotStreamState();
    const ignored = frames.filter((f) =>
      f.type === 'session.skills_loaded' || f.type === 'model.messages_snapshot',
    );
    expect(ignored.length).toBe(2);
    for (const frame of ignored) {
      expect(mapCopilotFrame(frame, state)).toEqual([]);
    }
  });

  it('retains ephemeral assistant.message_delta (does not filter on ephemeral)', () => {
    const frames = loadFrames('text-turn.v1.0.82.jsonl');
    const delta = frames.find((f) => f.type === 'assistant.message_delta')!;
    expect(delta.ephemeral).toBe(true);
    const out = mapCopilotFrame(delta, createCopilotStreamState());
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'pong', final: false } }]);
  });
});

describe('mapCopilotFrame — tool-turn fixture', () => {
  it('maps tool.execution_start → tool_call with name bash and arguments intact', () => {
    const { events } = mapAll('tool-turn.v1.0.82.jsonl');
    const bash = events.find((e) => e.type === 'tool_call' && e.payload.name === 'bash');
    expect(bash).toEqual({
      type: 'tool_call',
      payload: {
        toolUseId: 'toolu_01KYKBm26kw4pS4pLSRRQoX1',
        name: 'bash',
        input: { command: 'echo hello-from-copilot', description: 'Echo hello-from-copilot' },
      },
    });
  });

  it('maps create-file tool.execution_complete to tool_result + file_change created', () => {
    const { events } = mapAll('tool-turn.v1.0.82.jsonl');
    const result = events.find((e) =>
      e.type === 'tool_result' && e.payload.toolUseId === 'toolu_01Qea9gh2mpemGm5tr8RfHjC',
    );
    expect(result).toMatchObject({
      type: 'tool_result',
      payload: {
        toolUseId: 'toolu_01Qea9gh2mpemGm5tr8RfHjC',
        content: 'Created file /tmp/fixture/probe.txt with 2 characters',
        isError: false,
      },
    });
    const change = events.find((e) => e.type === 'file_change');
    expect(change).toEqual({
      type: 'file_change',
      payload: {
        path: '/tmp/fixture/probe.txt',
        kind: 'created',
        additions: 1,
        deletions: 0,
        toolUseId: 'toolu_01Qea9gh2mpemGm5tr8RfHjC',
      },
    });
  });

  it('skips assistant.message with empty content (tool-request-only step)', () => {
    const frames = loadFrames('tool-turn.v1.0.82.jsonl');
    const empty = frames.find((f) => {
      const data = f.data as { content?: string } | undefined;
      return f.type === 'assistant.message' && data?.content === '';
    });
    expect(empty).toBeDefined();
    const out = mapCopilotFrame(empty!, createCopilotStreamState());
    expect(out.filter((e) => e.type === 'message')).toEqual([]);
  });

  it('emits status:running only once despite two assistant.turn_start frames', () => {
    const { events } = mapAll('tool-turn.v1.0.82.jsonl');
    const running = events.filter((e) => e.type === 'status' && e.payload.status === 'running');
    expect(running).toHaveLength(1);
  });

  it('accumulates tokens across two model.model_call_success frames', () => {
    const { state } = mapAll('tool-turn.v1.0.82.jsonl');
    const usage = usageFromState(state);
    // last cache figures; inputTokens = uncached remainder of the last call
    // (22713 − cached 22327 − creation 379), not the raw prompt_tokens
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(279 + 5);
    expect(usage.cacheReadTokens).toBe(22327);
    expect(usage.cacheCreationTokens).toBe(379);
    expect(usage.maxPromptTokens).toBe(128000);
  });

  it('does not re-emit file_change from result.filesModified when telemetry already did', () => {
    const { events } = mapAll('tool-turn.v1.0.82.jsonl');
    const changes = events.filter((e) => e.type === 'file_change');
    expect(changes).toHaveLength(1);
  });
});

describe('mapCopilotFrame — denied-tool fixture', () => {
  it('emits tool_result with isError and the denial message, not a turn-level error', () => {
    const { events } = mapAll('denied-tool.jsonl');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toEqual({
      type: 'tool_result',
      payload: {
        toolUseId: 'toolu_denied_1',
        content: 'Tool not allowed: shell(git push)',
        isError: true,
      },
    });
  });
});

describe('mapCopilotFrame — residual result files', () => {
  it('does not replay session-cumulative filesModified on a reply-only resume turn', () => {
    const { events } = mapAll('resume-turn.v1.0.82.jsonl');
    expect(events.some((e) => e.type === 'file_change')).toBe(false);
  });

  it('skips paths an earlier turn already reported', () => {
    const prior = new Set(['/tmp/a.txt']);
    const state = createCopilotStreamState(prior);
    state.ranTool = true;
    const events = mapCopilotFrame({
      type: 'result',
      usage: { codeChanges: { filesModified: ['/tmp/a.txt', '/tmp/b.txt'] } },
    }, state);
    expect(events).toEqual([
      { type: 'file_change', payload: { path: '/tmp/b.txt', kind: 'modified' } },
    ]);
    expect(prior.has('/tmp/b.txt')).toBe(true);
  });

  it('emits file_change for result.filesModified not already seen via telemetry', () => {
    const state = createCopilotStreamState();
    state.ranTool = true;
    const events = mapCopilotFrame({
      type: 'result',
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      exitCode: 0,
      usage: { codeChanges: { filesModified: ['/tmp/fixture/redir.txt'] } },
    }, state);
    expect(events).toEqual([
      { type: 'file_change', payload: { path: '/tmp/fixture/redir.txt', kind: 'modified' } },
    ]);
  });

  it('maps apply_patch execution_start with string arguments to tool_call input.patch', () => {
    const state = createCopilotStreamState();
    const patchStr = '*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch\n';
    const events = mapCopilotFrame({
      type: 'tool.execution_start',
      data: {
        toolCallId: 'call_patch_1',
        toolName: 'apply_patch',
        arguments: patchStr,
      },
    }, state);
    expect(events).toEqual([
      {
        type: 'tool_call',
        payload: {
          toolUseId: 'call_patch_1',
          name: 'apply_patch',
          input: { patch: patchStr },
        },
      },
    ]);
  });

  it('attaches detailedContent to file_change when tool.execution_complete includes detailed diff', () => {
    const state = createCopilotStreamState();
    const diffStr = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';
    const events = mapCopilotFrame({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'call_patch_1',
        success: true,
        result: {
          content: 'Modified 1 file(s)',
          detailedContent: diffStr,
        },
        toolTelemetry: {
          restrictedProperties: {
            filePaths: '["/path/to/file.txt"]',
          },
          metrics: {
            linesAdded: 1,
            linesRemoved: 1,
          },
        },
      },
    }, state);
    const fileChange = events.find((e) => e.type === 'file_change');
    expect(fileChange).toEqual({
      type: 'file_change',
      payload: {
        path: '/path/to/file.txt',
        kind: 'modified',
        additions: 1,
        deletions: 1,
        toolUseId: 'call_patch_1',
        diff: diffStr,
      },
    });
  });
});
