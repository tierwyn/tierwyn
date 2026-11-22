import { describe, it, expect } from 'vitest';
import { mapAcpUpdate } from './mapping.js';

describe('mapAcpUpdate', () => {
  it('maps agent_message_chunk → message event', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'hello', final: false } }]);
  });

  it('maps agent_thought_chunk → message event (renders as prose)', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking...' },
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('message');
    expect((out[0].payload as { chunk: string }).chunk).toBe('thinking...');
  });

  it('drops empty message chunks (no card)', () => {
    const out = mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } });
    expect(out).toEqual([]);
  });

  it('maps tool_call with edit kind → tool_call + file_change', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'edit',
      kind: 'edit',
      rawInput: { file_path: '/repo/a.ts' },
      locations: [{ path: '/repo/a.ts' }],
    });
    expect(out).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'tc1', name: 'edit', input: { file_path: '/repo/a.ts' } } },
      { type: 'file_change', payload: { path: '/repo/a.ts', kind: 'modified', toolUseId: 'tc1' } },
    ]);
  });

  it('maps tool_call create → created kind', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc2',
      title: 'write',
      kind: 'create',
      locations: [{ path: '/repo/new.ts' }],
    });
    expect(out.find((e) => e.type === 'file_change')).toEqual({
      type: 'file_change',
      payload: { path: '/repo/new.ts', kind: 'created', toolUseId: 'tc2' },
    });
  });

  it('maps harness search_replace (no ACP kind/locations) → file_change modified', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-sr',
      title: 'search_replace',
      rawInput: {
        file_path: '/repo/a.ts',
        old_string: 'foo',
        new_string: 'bar',
      },
    });
    expect(out).toEqual([
      {
        type: 'tool_call',
        payload: {
          toolUseId: 'tc-sr',
          name: 'search_replace',
          input: { file_path: '/repo/a.ts', old_string: 'foo', new_string: 'bar' },
        },
      },
      { type: 'file_change', payload: { path: '/repo/a.ts', kind: 'modified', toolUseId: 'tc-sr' } },
    ]);
  });

  it('maps harness write (no ACP kind/locations) → file_change created', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-w',
      title: 'write',
      rawInput: { file_path: '/repo/new.ts', content: 'hello\n' },
    });
    expect(out.find((e) => e.type === 'file_change')).toEqual({
      type: 'file_change',
      payload: { path: '/repo/new.ts', kind: 'created', toolUseId: 'tc-w' },
    });
  });

  it('does not emit file_change for read_file', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-r',
      title: 'read_file',
      rawInput: { target_file: '/repo/a.ts' },
    });
    expect(out.every((e) => e.type !== 'file_change')).toBe(true);
  });

  it('injects subagent_type on spawn_subagent so the web heuristic groups it', () => {
    const omitted = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'spawn-1',
      title: 'spawn_subagent',
      rawInput: { description: 'explore repo', prompt: 'list files', background: true },
    });
    expect(omitted[0]).toEqual({
      type: 'tool_call',
      payload: {
        toolUseId: 'spawn-1',
        name: 'spawn_subagent',
        input: {
          description: 'explore repo',
          prompt: 'list files',
          background: true,
          subagent_type: 'general-purpose',
        },
      },
    });

    const explicit = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'spawn-2',
      title: 'spawn_subagent',
      rawInput: { description: 'look around', subagent_type: 'explore' },
    });
    expect((explicit[0] as { payload: { input: Record<string, unknown> } }).payload.input.subagent_type).toBe('explore');
  });

  it('maps tool_call_update completed → tool_result', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    });
    expect(out).toEqual([{ type: 'tool_result', payload: { toolUseId: 'tc1', content: 'ok', isError: false } }]);
  });

  it('maps tool_call_update failed → tool_result isError', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'failed',
      content: 'boom',
    });
    expect(out).toEqual([{ type: 'tool_result', payload: { toolUseId: 'tc1', content: 'boom', isError: true } }]);
  });

  it('ignores non-completed tool_call_update (in-flight progress)', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'in_progress',
      content: 'partial',
    });
    expect(out).toEqual([]);
  });

  it('ignores out-of-band variants (cost, available_commands_update, user_message_chunk)', () => {
    for (const variant of ['cost', 'available_commands_update', 'user_message_chunk', 'model_changed']) {
      expect(mapAcpUpdate({ sessionUpdate: variant })).toEqual([]);
    }
  });

  it('ignores unknown variants', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'something_new' })).toEqual([]);
  });
});
