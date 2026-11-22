import { describe, it, expect } from 'vitest';
import { mapDeepSeekEvent, mapStreamChunk, usageFromEvent } from './mapping.js';

describe('mapDeepSeekEvent', () => {
  it('maps turn/start to status running', () => {
    expect(mapDeepSeekEvent({ type: 'turn/start', turn: 1 })).toEqual([
      { type: 'status', payload: { status: 'running' } },
    ]);
  });

  it('maps text-delta chunk to a streaming message', () => {
    const out = mapDeepSeekEvent({
      type: 'assistant/chunk',
      chunk: { type: 'text-delta', index: 0, text: 'hi' },
    });
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'hi', final: false } }]);
  });

  it('drops reasoning-delta', () => {
    expect(mapStreamChunk({ type: 'reasoning-delta', index: 0, text: 'thinking…' })).toEqual([]);
    expect(mapDeepSeekEvent({
      type: 'assistant/chunk',
      chunk: { type: 'reasoning-delta', index: 0, text: 'thinking…' },
    })).toEqual([]);
  });

  it('drops tool-call-delta', () => {
    expect(mapStreamChunk({ type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{' })).toEqual([]);
  });

  it('maps tool/call with parsed arguments', () => {
    const out = mapDeepSeekEvent({
      type: 'tool/call',
      callId: 'c1',
      name: 'bash',
      arguments: '{"cmd":"ls"}',
    });
    expect(out).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'c1', name: 'bash', input: { cmd: 'ls' } } },
    ]);
  });

  it('maps tool/call with malformed arguments to { raw } without throwing', () => {
    const out = mapDeepSeekEvent({
      type: 'tool/call',
      callId: 'c1',
      name: 'bash',
      arguments: 'not-json',
    });
    expect(out).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'c1', name: 'bash', input: { raw: 'not-json' } } },
    ]);
  });

  it('maps tool/call for a file tool followed by file_change', () => {
    const out = mapDeepSeekEvent({
      type: 'tool/call',
      callId: 'c1',
      name: 'write',
      arguments: '{"path":"/a.ts"}',
    });
    expect(out).toContainEqual({
      type: 'tool_call', payload: { toolUseId: 'c1', name: 'write', input: { path: '/a.ts' } },
    });
    expect(out).toContainEqual({ type: 'file_change', payload: { path: '/a.ts', kind: 'created' } });
  });

  it('maps tool/result', () => {
    expect(mapDeepSeekEvent({
      type: 'tool/result',
      callId: 'c1',
      content: 'ok',
      isError: false,
    })).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'c1', content: 'ok', isError: false } },
    ]);
  });

  it('maps tool/result with array content by joining blocks', () => {
    expect(mapDeepSeekEvent({
      type: 'tool/result',
      callId: 'c1',
      content: [{ text: 'a' }, { text: 'b' }],
      isError: false,
    })).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'c1', content: 'ab', isError: false } },
    ]);
  });

  it('unwraps SessionEvent.data for tool/call, tool/result, and text-delta', () => {
    expect(mapDeepSeekEvent({
      type: 'tool/call',
      seq: 3,
      time: 1,
      data: { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
    })).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'c1', name: 'bash', input: { cmd: 'ls' } } },
    ]);

    expect(mapDeepSeekEvent({
      type: 'assistant/chunk',
      seq: 4,
      time: 1,
      data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
    })).toEqual([{ type: 'message', payload: { chunk: 'hi', final: false } }]);

    expect(mapDeepSeekEvent({
      type: 'tool/result',
      seq: 5,
      time: 1,
      data: {
        turn: 1,
        step: 0,
        message: {
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
          source: { kind: 'tool', callId: 'c1' },
        },
      },
    })).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'c1', content: 'ok', isError: false } },
    ]);
  });

  it('emits assistant/message content as the final chunk when nothing streamed', () => {
    const out = mapDeepSeekEvent({
      type: 'assistant/message',
      message: { content: [{ type: 'text', text: 'the full reply' }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'the full reply', final: true } }]);
  });

  it('keeps assistant/message an empty terminator when text already streamed', () => {
    const out = mapDeepSeekEvent(
      {
        type: 'assistant/message',
        message: { content: [{ type: 'text', text: 'the full reply' }] },
      },
      { streamedText: true },
    );
    expect(out).toEqual([{ type: 'message', payload: { chunk: '', final: true } }]);
  });

  it('emits an empty final chunk when an unstreamed message has no text blocks', () => {
    const out = mapDeepSeekEvent({
      type: 'assistant/message',
      message: { content: [{ type: 'toolCall', callId: 'c1', tool: 'bash' }] },
    });
    expect(out).toEqual([{ type: 'message', payload: { chunk: '', final: true } }]);
  });

  it('excludes reasoning blocks when emitting unstreamed assistant/message content (dsh 0.2.x v4 format)', () => {
    const out = mapDeepSeekEvent({
      type: 'assistant/message',
      seq: 13,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'internal chain of thought' },
            { type: 'text', text: 'visible reply' },
          ],
        },
      },
    });
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'visible reply', final: true } }]);
  });

  it('maps turn/end error reasons to an error event', () => {
    expect(mapDeepSeekEvent({
      type: 'turn/end',
      seq: 6,
      time: 1,
      data: {
        turn: 1,
        reason: {
          kind: 'error',
          error: { message: 'session "x" already has a persisted log on disk that does not match this live session (id collision)', code: 'UNKNOWN' },
        },
      },
    })).toEqual([{
      type: 'error',
      payload: { message: 'session "x" already has a persisted log on disk that does not match this live session (id collision)' },
    }]);
  });

  it('ignores unknown event types', () => {
    expect(mapDeepSeekEvent({ type: 'turn/end', turn: 1 })).toEqual([]);
    expect(mapDeepSeekEvent({ type: 'step/start', turn: 1, step: 0 })).toEqual([]);
    expect(mapDeepSeekEvent({ type: 'nope' })).toEqual([]);
  });
});

describe('mapStreamChunk', () => {
  it('drops usage and finish chunks', () => {
    expect(mapStreamChunk({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } })).toEqual([]);
    expect(mapStreamChunk({ type: 'finish', reason: { kind: 'stop' } })).toEqual([]);
  });
});

describe('usageFromEvent', () => {
  it('maps inputTokens and outputTokens', () => {
    expect(usageFromEvent({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
    });
  });

  it('returns {} for undefined', () => {
    expect(usageFromEvent(undefined)).toEqual({});
  });
});
