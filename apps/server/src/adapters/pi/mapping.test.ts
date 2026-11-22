import { describe, it, expect } from 'vitest';
import { mapPiEvent, flattenActiveThread } from './mapping.js';

describe('mapPiEvent', () => {
  it('maps agent_start -> status running', () => {
    expect(mapPiEvent({ type: 'agent_start' })).toEqual([{ type: 'status', payload: { status: 'running' } }]);
  });

  it('maps a text_delta message_update -> streaming message chunk', () => {
    const out = mapPiEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hi' },
    });
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'Hi', final: false } }]);
  });

  it('closes the stream on assistant done', () => {
    const out = mapPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'stop' } });
    expect(out).toEqual([{ type: 'message', payload: { chunk: '', final: true } }]);
  });

  it('maps tool_execution_start -> tool_call (+ file_change for edit tools)', () => {
    const out = mapPiEvent({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: '/a.ts' } });
    expect(out).toContainEqual({ type: 'tool_call', payload: { toolUseId: 't1', name: 'edit', input: { path: '/a.ts' } } });
    expect(out).toContainEqual({ type: 'file_change', payload: { path: '/a.ts', kind: 'modified', toolUseId: 't1' } });
  });

  it('maps tool_execution_end -> tool_result joining text content', () => {
    const out = mapPiEvent({
      type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] }, isError: false,
    });
    expect(out).toEqual([{ type: 'tool_result', payload: { toolUseId: 't1', content: 'ok', isError: false } }]);
  });

  it('maps an error assistant event -> error + status error', () => {
    const out = mapPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error' } });
    expect(out).toContainEqual({ type: 'status', payload: { status: 'error' } });
    expect(out).toContainEqual({ type: 'error', payload: { message: 'assistant error' } });
  });

  it('maps extension_error -> error', () => {
    expect(mapPiEvent({ type: 'extension_error', error: 'boom' })).toEqual([{ type: 'error', payload: { message: 'boom' } }]);
  });

  it('maps message_end with stopReason=error -> error event', () => {
    const out = mapPiEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '429 subscription plan does not include access to GLM-5V-Turbo',
      },
    });
    expect(out).toEqual([
      { type: 'error', payload: { message: '429 subscription plan does not include access to GLM-5V-Turbo' } },
    ]);
  });

  it('maps turn_end with stopReason=error and no errorMessage -> generic error event', () => {
    const out = mapPiEvent({
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'error' },
    });
    expect(out).toEqual([{ type: 'error', payload: { message: 'pi turn ended with an error' } }]);
  });

  it('ignores successful message_end frames', () => {
    expect(mapPiEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })).toEqual([]);
  });

  it('ignores frames it does not model', () => {
    expect(mapPiEvent({ type: 'queue_update', steering: [], followUp: [] })).toEqual([]);
  });
});

describe('flattenActiveThread', () => {
  it('joins text blocks when a user message has array content', () => {
    const events = flattenActiveThread([
      { role: 'user', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
    ]);
    expect(events).toEqual([{ type: 'prompt', payload: { text: 'hello world' } }]);
  });

  it('flattens user/assistant/toolResult messages into ordered normalised events', () => {
    const events = flattenActiveThread([
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: '/x' } }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'edit', content: [{ type: 'text', text: 'ok' }], isError: false },
    ]);
    expect(events.map((e) => e.type)).toEqual(['prompt', 'message', 'tool_call', 'file_change', 'tool_result']);
  });
});
