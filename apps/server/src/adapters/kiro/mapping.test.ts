import { describe, it, expect } from 'vitest';
import { mapAcpUpdate, diffFileChanges } from './mapping.js';

describe('mapAcpUpdate', () => {
  it('maps agent_message_chunk to a message with final:false', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    })).toEqual([{ type: 'message', payload: { chunk: 'hi', final: false } }]);
  });

  it('returns [] for an empty agent_message_chunk', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
    })).toEqual([]);
  });

  it('maps agent_thought_chunk to a message', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    })).toEqual([{ type: 'message', payload: { chunk: 'hmm', final: false } }]);
  });

  it('drops user_message_chunk and tool_call_chunk (no double-render)', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } })).toEqual([]);
    expect(mapAcpUpdate({ sessionUpdate: 'tool_call_chunk', title: 'write', toolCallId: 't0' })).toEqual([]);
  });

  it('maps a read tool_call to exactly one tool_call and no file_change', () => {
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

  it('maps a write tool_call with locations to tool_call + file_change{kind:modified, toolUseId}', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'write: /x.ts',
      kind: 'write',
      locations: [{ path: '/x.ts' }],
    })).toEqual([
      { type: 'tool_call', payload: { toolUseId: 't1', name: 'write: /x.ts', input: {} } },
      { type: 'file_change', payload: { path: '/x.ts', kind: 'modified', toolUseId: 't1' } },
    ]);
  });

  it('grafts diff line counts onto the locations-derived file_change for the same path+kind', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't9',
      title: 'edit: /x.ts',
      kind: 'edit',
      locations: [{ path: '/x.ts' }],
      content: [{ type: 'diff', path: '/x.ts', oldText: 'a\nb', newText: 'a\nb\nc' }],
    })).toEqual([
      { type: 'tool_call', payload: { toolUseId: 't9', name: 'edit: /x.ts', input: { content: [{ type: 'diff', path: '/x.ts', oldText: 'a\nb', newText: 'a\nb\nc' }] } } },
      { type: 'file_change', payload: { path: '/x.ts', kind: 'modified', toolUseId: 't9', additions: 1, deletions: 0 } },
    ]);
  });

  it('maps kind:create to file_change created and kind:delete to deleted', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc',
      title: 'create: /new.ts',
      kind: 'create',
      locations: [{ path: '/new.ts' }],
    }).find((e) => e.type === 'file_change')).toEqual({
      type: 'file_change',
      payload: { path: '/new.ts', kind: 'created', toolUseId: 'tc' },
    });
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'td',
      title: 'delete: /old.ts',
      kind: 'delete',
      locations: [{ path: '/old.ts' }],
    }).find((e) => e.type === 'file_change')).toEqual({
      type: 'file_change',
      payload: { path: '/old.ts', kind: 'deleted', toolUseId: 'td' },
    });
  });

  it('maps a diff block: empty oldText → created; empty newText → deleted; both present → modified with line counts', () => {
    expect(diffFileChanges(
      [{ type: 'diff', path: '/a.ts', oldText: '', newText: 'one\ntwo' }],
      't',
    )[0]).toMatchObject({
      type: 'file_change',
      payload: { path: '/a.ts', kind: 'created', toolUseId: 't' },
    });
    expect(diffFileChanges(
      [{ type: 'diff', path: '/b.ts', oldText: 'gone', newText: '' }],
      't',
    )[0]).toMatchObject({
      type: 'file_change',
      payload: { path: '/b.ts', kind: 'deleted', toolUseId: 't' },
    });
    expect(diffFileChanges(
      [{ type: 'diff', path: '/c.ts', oldText: 'a\nb', newText: 'a\nb\nc' }],
      't',
    )).toEqual([{
      type: 'file_change',
      payload: { path: '/c.ts', kind: 'modified', toolUseId: 't', additions: 1, deletions: 0 },
    }]);
  });

  it('dedupes locations + a diff for the same path into one file_change', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'write: /x.ts',
      kind: 'write',
      locations: [{ path: '/x.ts' }],
      content: [{ type: 'diff', path: '/x.ts', oldText: 'a', newText: 'b' }],
    });
    const changes = out.filter((e) => e.type === 'file_change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload).toMatchObject({ path: '/x.ts', toolUseId: 't1' });
  });

  it('dedupes even when locations-derived kind differs from diff-derived kind (e.g. create tool with diff)', () => {
    const out = mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't_create',
      title: 'create: /new.txt',
      kind: 'edit',
      locations: [{ path: '/new.txt' }],
      content: [{ type: 'diff', path: '/new.txt', oldText: null, newText: 'line 1\nline 2' }],
    });
    const changes = out.filter((e) => e.type === 'file_change');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload).toEqual({
      path: '/new.txt',
      kind: 'created',
      toolUseId: 't_create',
      additions: 2,
      deletions: 0,
    });
  });

  it('maps tool_call_update in_progress to []; completed to tool_result; failed to isError:true', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'in_progress',
    })).toEqual([]);
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    })).toEqual([{ type: 'tool_result', payload: { toolUseId: 't1', content: 'ok', isError: false } }]);
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'failed',
      content: 'boom',
    })).toEqual([{ type: 'tool_result', payload: { toolUseId: 't1', content: 'boom', isError: true } }]);
  });

  it('maps web_fetch-style rawOutput.items[].Text to tool_result content', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      title: 'Fetching web content',
      rawInput: { url: 'https://example.com' },
      rawOutput: { items: [{ Text: '# Example Domain\n\nThis domain is for use in documentation examples.' }] },
    })).toEqual([{
      type: 'tool_result',
      payload: { toolUseId: 't1', content: '# Example Domain\n\nThis domain is for use in documentation examples.', isError: false },
    }]);
  });

  it('joins multiple rawOutput items with a blank line', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'completed',
      rawOutput: { items: [{ Text: 'first' }, { Text: 'second' }] },
    })[0].payload.content).toBe('first\n\nsecond');
  });

  it('prefers content over rawOutput when both are present', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't3',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      rawOutput: { items: [{ Text: 'raw' }] },
    })).toEqual([{ type: 'tool_result', payload: { toolUseId: 't3', content: 'ok', isError: false } }]);
  });

  it('returns [] for unknown sessionUpdate without throwing', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'current_mode_update', mode: 'kiro_planner' })).toEqual([]);
    expect(mapAcpUpdate({ sessionUpdate: 'plan' })).toEqual([]);
    expect(mapAcpUpdate({})).toEqual([]);
  });
});
