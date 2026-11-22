import { describe, it, expect } from 'vitest';
import { mapAcpUpdate } from './mapping.js';

// All test shapes use the live Hermes ACP wire format verified 2026-06-19:
// toolCallId, kind, locations, status, content are directly on the update
// object — NOT nested under an update.toolCall sub-object.

describe('mapAcpUpdate', () => {
  it('maps agent_message_chunk to a message chunk', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }))
      .toEqual([{ type: 'message', payload: { chunk: 'hi', final: false } }]);
  });

  it('maps agent_thought_chunk to a message chunk (visible thinking)', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }))
      .toEqual([{ type: 'message', payload: { chunk: 'hmm', final: false } }]);
  });

  it('maps a tool_call with a write kind to tool_call + file_change', () => {
    // Live shape: kind, locations, toolCallId directly on update (no toolCall wrapper)
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'edit: /x.ts',
      kind: 'edit',
      locations: [{ path: '/x.ts' }],
    })).toEqual([
      { type: 'tool_call', payload: { toolUseId: 't1', name: 'edit: /x.ts', input: {} } },
      { type: 'file_change', payload: { path: '/x.ts', kind: 'modified', toolUseId: 't1' } },
    ]);
  });

  it('maps a non-write tool_call (read) to a single tool_call', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'read: /x.ts',
      kind: 'read',
      locations: [{ path: '/x.ts' }],
    })).toEqual([
      { type: 'tool_call', payload: { toolUseId: 't2', name: 'read: /x.ts', input: {} } },
    ]);
  });

  it('maps an execute tool_call (terminal) to a single tool_call with content', () => {
    const content = [{ type: 'content', content: { type: 'text', text: '$ ls /tmp' } }];
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'terminal: ls /tmp',
      kind: 'execute',
      locations: [],
      content,
    })).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'tc-1', name: 'terminal: ls /tmp', input: { content } } },
    ]);
  });

  it('maps a completed tool_call_update with wrapped content to a tool_result', () => {
    // Live shape: status, toolCallId, content directly on update;
    // content is Array<{type:"content", content:{type:"text",text}}>
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    })).toEqual([{ type: 'tool_result', payload: { toolUseId: 't1', content: 'ok', isError: false } }]);
  });

  it('maps a failed tool_call_update to an error tool_result', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
    })).toEqual([{ type: 'tool_result', payload: { toolUseId: 't1', content: 'boom', isError: true } }]);
  });

  it('maps a failed tool_call_update with string content', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'failed',
      content: 'boom',
    })).toEqual([{ type: 'tool_result', payload: { toolUseId: 't1', content: 'boom', isError: true } }]);
  });

  it('ignores in-progress tool updates, cost, commands, and unknown variants', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' })).toEqual([]);
    expect(mapAcpUpdate({ sessionUpdate: 'cost', cost: { totalCostUsd: 0.01 } })).toEqual([]);
    expect(mapAcpUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toEqual([]);
    expect(mapAcpUpdate({ sessionUpdate: 'plan' })).toEqual([]);
    expect(mapAcpUpdate({})).toEqual([]);
  });
});
