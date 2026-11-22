import { describe, it, expect } from 'vitest';
import { mapOpenCodeEvent, usageFromOpenCodeFrame } from './mapping.js';

describe('mapOpenCodeEvent', () => {
  it('maps a text frame to a message chunk', () => {
    const result = mapOpenCodeEvent({
      type: 'text',
      timestamp: 1000,
      sessionID: 'ses_abc',
      part: { type: 'text', text: 'hi', time: {} },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'message',
      payload: { chunk: 'hi', final: false },
    });
  });

  it('maps a step_start frame to []', () => {
    const result = mapOpenCodeEvent({
      type: 'step_start',
      timestamp: 1000,
      sessionID: 'ses_abc',
      part: { type: 'step-start' },
    });
    expect(result).toEqual([]);
  });

  it('maps an unknown type to []', () => {
    const result = mapOpenCodeEvent({
      type: 'some_future_event_type',
      payload: { foo: 'bar' },
    });
    expect(result).toEqual([]);
  });

  it('maps a synthetic tool event to tool_call', () => {
    const result = mapOpenCodeEvent({
      type: 'tool',
      sessionID: 'ses_abc',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_123',
        input: { command: 'ls -la' },
        state: 'pending',
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'tool_call',
      payload: {
        toolUseId: 'call_123',
        name: 'bash',
        input: { command: 'ls -la' },
      },
    });
  });

  it('maps a tool_result state to tool_result', () => {
    const result = mapOpenCodeEvent({
      type: 'tool',
      sessionID: 'ses_abc',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_123',
        state: 'result',
        output: 'file1.txt\nfile2.txt',
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'tool_result',
      payload: {
        toolUseId: 'call_123',
        content: 'file1.txt\nfile2.txt',
        isError: false,
      },
    });
  });

  it('maps a finish event to status done', () => {
    const result = mapOpenCodeEvent({ type: 'finish', sessionID: 'ses_abc', part: {} });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'status', payload: { status: 'done' } });
  });

  it('maps a step_finish event to [] (does not end turn prematurely)', () => {
    const result = mapOpenCodeEvent({ type: 'step_finish', sessionID: 'ses_abc', part: {} });
    expect(result).toEqual([]);
  });

  it('extracts token usage from step_finish / finish frame', () => {
    const usage = usageFromOpenCodeFrame({
      type: 'step_finish',
      sessionID: 'ses_abc',
      part: {
        reason: 'stop',
        cost: 0.001,
        tokens: { input: 671, output: 8, reasoning: 0, cache: { read: 21415, write: 0 } },
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 671,
      outputTokens: 8,
      cacheReadTokens: 21415,
      cacheCreationTokens: 0,
      costUsd: 0.001,
    });
  });

  it('emits a file_change alongside tool_call for a write tool', () => {
    const result = mapOpenCodeEvent({
      type: 'tool',
      sessionID: 'ses_abc',
      part: {
        type: 'tool',
        tool: 'write',
        callID: 'call_456',
        input: { path: '/tmp/out.txt', content: 'hello' },
        state: 'pending',
      },
    });
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('tool_call');
    expect(result[1]).toMatchObject({
      type: 'file_change',
      payload: { path: '/tmp/out.txt', kind: 'created', toolUseId: 'call_456' },
    });
  });

  it('maps a kilo-shaped tool_use frame (state.status=completed) to tool_call+tool_result', () => {
    // kilo emits ONE frame per tool with state={status, input, output} — not
    // separate call/result frames like opencode. Adapter must emit BOTH.
    const result = mapOpenCodeEvent({
      type: 'tool_use',
      timestamp: 1782667205664,
      sessionID: 'ses_x',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_abc',
        state: {
          status: 'completed',
          input: { command: 'echo hi', description: 'test' },
          output: '(no output)',
          metadata: { exit: 0 },
        },
        id: 'prt_1',
        messageID: 'msg_1',
      },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'tool_call',
      payload: {
        toolUseId: 'call_abc',
        name: 'bash',
        input: { command: 'echo hi', description: 'test' },
      },
    });
    expect(result[1]).toMatchObject({
      type: 'tool_result',
      payload: { toolUseId: 'call_abc', content: '(no output)', isError: false },
    });
  });

  it('maps kilo error state to tool_result with isError=true', () => {
    const result = mapOpenCodeEvent({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_err',
        state: { status: 'error', input: { command: 'bad' }, output: 'boom' },
      },
    });
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      type: 'tool_result',
      payload: { toolUseId: 'call_err', isError: true, content: 'boom' },
    });
  });

  it('emits file_change for kilo edit tool with camelCase filePath input', () => {
    // kilo's edit tool input is { filePath, oldString, newString } — the path
    // key is camelCase, unlike opencode's path / file_path.
    const result = mapOpenCodeEvent({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'edit',
        callID: 'call_edit_1',
        state: {
          status: 'completed',
          input: {
            filePath: '/home/u/proj/src/a.ts',
            oldString: 'foo()',
            newString: 'bar()',
          },
          output: 'Edited /home/u/proj/src/a.ts',
        },
      },
    });
    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({
      type: 'file_change',
      payload: { path: '/home/u/proj/src/a.ts', kind: 'modified', toolUseId: 'call_edit_1' },
    });
  });

  it('emits file_change (created) for kilo write tool with filePath input', () => {
    const result = mapOpenCodeEvent({
      type: 'tool',
      part: {
        type: 'tool',
        tool: 'write',
        callID: 'call_write_1',
        input: { filePath: '/tmp/new.txt', content: 'hello' },
        state: 'pending',
      },
    });
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      type: 'file_change',
      payload: { path: '/tmp/new.txt', kind: 'created', toolUseId: 'call_write_1' },
    });
  });

  it('handles missing fields defensively', () => {
    // Frame with no part and no recognized type
    expect(() => mapOpenCodeEvent({})).not.toThrow();
    expect(mapOpenCodeEvent({})).toEqual([]);

    // text type but missing text field
    const result = mapOpenCodeEvent({ type: 'text', part: { type: 'text' } });
    expect(result[0]).toMatchObject({ type: 'message', payload: { chunk: '', final: false } });
  });
});
