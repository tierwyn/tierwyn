import { describe, it, expect } from 'vitest';
import { mapCursorEvent, createCursorStreamState } from './mapping.js';

describe('mapCursorEvent', () => {
  it('maps an assistant frame to a message chunk', () => {
    const out = mapCursorEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      session_id: 's1',
    });
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'hello', final: false } }]);
  });

  it('maps a started writeToolCall to tool_call + file_change', () => {
    const out = mapCursorEvent({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c1',
      tool_call: { writeToolCall: { args: { path: '/tmp/a.ts' } } },
    });
    expect(out).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'c1', name: 'writeToolCall', input: { path: '/tmp/a.ts' } } },
      { type: 'file_change', payload: { path: '/tmp/a.ts', kind: 'modified', toolUseId: 'c1' } },
    ]);
  });

  it('maps a started taskToolCall to Task with subagent_type so the web heuristic catches it', () => {
    const out = mapCursorEvent({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c-task',
      tool_call: {
        taskToolCall: {
          args: { description: 'explore repo', prompt: 'list files' },
        },
      },
    });
    expect(out).toEqual([{
      type: 'tool_call',
      payload: {
        toolUseId: 'c-task',
        name: 'Task',
        input: {
          description: 'explore repo',
          prompt: 'list files',
          subagent_type: 'helper',
        },
      },
    }]);
  });

  it('keeps an explicit subagent_type (or camelCase subagentType) on taskToolCall', () => {
    const snake = mapCursorEvent({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c-snake',
      tool_call: { taskToolCall: { args: { description: 'd', subagent_type: 'explore' } } },
    });
    expect((snake[0] as { payload: { input: Record<string, unknown> } }).payload.input.subagent_type).toBe('explore');

    const camel = mapCursorEvent({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c-camel',
      tool_call: { taskToolCall: { args: { description: 'd', subagentType: 'explore' } } },
    });
    expect((camel[0] as { payload: { input: Record<string, unknown> } }).payload.input.subagent_type).toBe('explore');
  });

  it('maps a started readToolCall to a single tool_call (no file_change)', () => {
    const out = mapCursorEvent({
      type: 'tool_call', subtype: 'started', call_id: 'c2',
      tool_call: { readToolCall: { args: { path: '/tmp/a.ts' } } },
    });
    expect(out).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'c2', name: 'readToolCall', input: { path: '/tmp/a.ts' } } },
    ]);
  });

  it('maps a completed tool_call to a tool_result (legacy contents shape)', () => {
    const out = mapCursorEvent({
      type: 'tool_call', subtype: 'completed', call_id: 'c1',
      tool_call: { readToolCall: { args: {}, result: { contents: 'file body' } } },
    });
    expect(out).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'c1', content: JSON.stringify({ contents: 'file body' }), isError: false } },
    ]);
  });

  it('extracts content from readToolCall success wrapper (live wire format)', () => {
    const out = mapCursorEvent({
      type: 'tool_call', subtype: 'completed', call_id: 'c1',
      tool_call: {
        readToolCall: {
          args: { path: '/etc/hostname' },
          result: {
            success: {
              content: 'dev-box\n',
              isEmpty: false,
              path: '/etc/hostname',
            },
          },
        },
      },
    });
    expect(out).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'c1', content: 'dev-box\n', isError: false } },
    ]);
  });

  it('extracts stdout from a terminal tool result and strips ANSI codes', () => {
    const out = mapCursorEvent({
      type: 'tool_call', subtype: 'completed', call_id: 't1',
      tool_call: {
        terminalToolCall: {
          args: { command: 'echo hi' },
          result: {
            success: { command: 'echo hi', exitCode: 0, stdout: '[32mhi[0m\n', stderr: '', interleavedOutput: '[32mhi[0m\n' },
            isBackground: false,
          },
        },
      },
    });
    expect(out).toEqual([
      { type: 'tool_result', payload: { toolUseId: 't1', content: 'hi\n', isError: false } },
    ]);
  });

  it('maps a successful result to status:done', () => {
    expect(mapCursorEvent({ type: 'result', subtype: 'success', is_error: false, result: 'done' }))
      .toEqual([{ type: 'status', payload: { status: 'done' } }]);
  });

  it('maps a result frame with usage to status:done carrying token fields', () => {
    const out = mapCursorEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 },
    });
    expect(out).toEqual([{
      type: 'status',
      payload: {
        status: 'done',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
      },
    }]);
  });

  it('maps an error result to status:error', () => {
    expect(mapCursorEvent({ type: 'result', subtype: 'error', is_error: true }))
      .toEqual([{ type: 'status', payload: { status: 'error' } }]);
  });

  it('ignores the system/init frame and unknown frames', () => {
    expect(mapCursorEvent({ type: 'system', subtype: 'init', session_id: 's1' })).toEqual([]);
    expect(mapCursorEvent({ type: 'whatever' })).toEqual([]);
  });

  it('handles live wire format with hookAdditionalContexts/toolCallId/startedAtMs extra keys', () => {
    // Verified 2026-06-19: actual cursor-agent stream-json output has these extra keys
    // alongside the tool name key. Object.keys preserves insertion order so the
    // tool name remains the first key.
    const out = mapCursorEvent({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c3',
      tool_call: {
        readToolCall: { args: { path: '/tmp/x.ts', limit: 5 } },
        hookAdditionalContexts: [],
        toolCallId: 'tool_c3',
        startedAtMs: '1781829670672',
      },
    });
    expect(out).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'c3', name: 'readToolCall', input: { path: '/tmp/x.ts', limit: 5 } } },
    ]);
  });

  it('uses a streaming delta frame (timestamp_ms, no model_call_id)', () => {
    const state = createCursorStreamState();
    const out = mapCursorEvent({
      type: 'assistant',
      timestamp_ms: 1781829670672,
      message: { role: 'assistant', content: [{ type: 'text', text: 'par' }] },
      session_id: 's1',
    }, state);
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'par', final: false } }]);
    expect(state.sawStreamingDelta).toBe(true);
  });

  it('skips a buffered flush frame (timestamp_ms + model_call_id)', () => {
    const state = createCursorStreamState();
    const out = mapCursorEvent({
      type: 'assistant',
      timestamp_ms: 1781829670999,
      model_call_id: 'mc_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
    }, state);
    expect(out).toEqual([]);
  });

  it('skips the final flush frame once streaming deltas were seen this turn', () => {
    const state = createCursorStreamState();
    mapCursorEvent({
      type: 'assistant',
      timestamp_ms: 1781829670672,
      message: { content: [{ type: 'text', text: 'par' }] },
    }, state);
    mapCursorEvent({
      type: 'assistant',
      timestamp_ms: 1781829670680,
      message: { content: [{ type: 'text', text: 'tial' }] },
    }, state);
    const out = mapCursorEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'partial' }] },
    }, state);
    expect(out).toEqual([]);
  });

  it('still uses a bare assistant frame when no streaming delta was seen (legacy stream-json)', () => {
    const state = createCursorStreamState();
    const out = mapCursorEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'complete' }] },
    }, state);
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'complete', final: false } }]);
  });
});
