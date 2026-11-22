import { describe, it, expect } from 'vitest';
import { mapKimiUpdate, contextPctFromUsageUpdate, type ToolMeta } from './mapping.js';

const WRITE_PENDING = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_write_1',
  status: 'pending',
  title: 'Write',
  content: [],
  locations: [],
  kind: 'edit',
};

const WRITE_IN_PROGRESS = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_write_1',
  status: 'in_progress',
  title: 'Writing /tmp/kimi-probe/acp.txt',
  rawInput: { file_path: '/tmp/kimi-probe/acp.txt', content: 'hello' },
  locations: [{ path: '/tmp/kimi-probe/acp.txt' }],
};

function memoFromPending(frame: Record<string, unknown> = WRITE_PENDING): Map<string, ToolMeta> {
  const toolMeta = new Map<string, ToolMeta>();
  mapKimiUpdate(frame, toolMeta);
  return toolMeta;
}

describe('mapKimiUpdate', () => {
  it('maps agent_message_chunk to a message with final:false', () => {
    expect(mapKimiUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    }, new Map())).toEqual([{ type: 'message', payload: { chunk: 'hi', final: false } }]);
  });

  it('returns [] for an empty agent_message_chunk', () => {
    expect(mapKimiUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
    }, new Map())).toEqual([]);
  });

  it('maps agent_thought_chunk to a message chunk (unlike qwen, which drops it)', () => {
    expect(mapKimiUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'The' },
    }, new Map())).toEqual([{ type: 'message', payload: { chunk: 'The', final: false } }]);
  });

  it('memoes a pending Write tool_call and emits no card when rawInput is empty', () => {
    const toolMeta = new Map<string, ToolMeta>();
    expect(mapKimiUpdate(WRITE_PENDING, toolMeta)).toEqual([]);
    expect(toolMeta.get('call_write_1')).toEqual({ name: 'Write', kind: 'edit' });
  });

  it('emits a tool_call card from pending when rawInput is non-empty', () => {
    const toolMeta = new Map<string, ToolMeta>();
    expect(mapKimiUpdate({
      ...WRITE_PENDING,
      rawInput: { file_path: '/tmp/x.txt', content: 'hi' },
    }, toolMeta)).toEqual([
      {
        type: 'tool_call',
        payload: {
          toolUseId: 'call_write_1',
          name: 'Write',
          input: { file_path: '/tmp/x.txt', content: 'hi' },
        },
      },
    ]);
    expect(toolMeta.get('call_write_1')).toEqual({ name: 'Write', kind: 'edit' });
  });

  it('emits a Write card + file_change from in_progress using memo name/kind (no kind on update)', () => {
    const toolMeta = memoFromPending();
    expect(mapKimiUpdate(WRITE_IN_PROGRESS, toolMeta)).toEqual([
      {
        type: 'tool_call',
        payload: {
          toolUseId: 'call_write_1',
          name: 'Write',
          input: { file_path: '/tmp/kimi-probe/acp.txt', content: 'hello' },
        },
      },
      {
        type: 'file_change',
        payload: { path: '/tmp/kimi-probe/acp.txt', kind: 'modified', toolUseId: 'call_write_1' },
      },
    ]);
  });

  it('falls back to the verbose title and emits no file_change when the memo is empty', () => {
    expect(mapKimiUpdate(WRITE_IN_PROGRESS, new Map())).toEqual([
      {
        type: 'tool_call',
        payload: {
          toolUseId: 'call_write_1',
          name: 'Writing /tmp/kimi-probe/acp.txt',
          input: { file_path: '/tmp/kimi-probe/acp.txt', content: 'hello' },
        },
      },
    ]);
  });

  it('emits tool_call only (no file_change) for a read tool with locations', () => {
    const toolMeta = memoFromPending({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_read_1',
      title: 'Read',
      kind: 'read',
    });
    expect(mapKimiUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_read_1',
      status: 'in_progress',
      title: 'Reading /tmp/kimi-probe/acp.txt',
      rawInput: { file_path: '/tmp/kimi-probe/acp.txt' },
      locations: [{ path: '/tmp/kimi-probe/acp.txt' }],
    }, toolMeta)).toEqual([
      {
        type: 'tool_call',
        payload: {
          toolUseId: 'call_read_1',
          name: 'Read',
          input: { file_path: '/tmp/kimi-probe/acp.txt' },
        },
      },
    ]);
  });

  it('maps completed tool_call_update to tool_result with isError:false', () => {
    expect(mapKimiUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_write_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'wrote it' } }],
    }, new Map())).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'call_write_1', content: 'wrote it', isError: false } },
    ]);
  });

  it('maps failed tool_call_update to tool_result with isError:true', () => {
    expect(mapKimiUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_fail',
      status: 'failed',
      content: 'boom',
    }, new Map())).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'call_fail', content: 'boom', isError: true } },
    ]);
  });

  it('returns [] for tool_call_update pending', () => {
    expect(mapKimiUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_write_1',
      status: 'pending',
    }, new Map())).toEqual([]);
  });

  it('maps diff blocks to file_change with created/modified/deleted and collapses same-path duplicates preferring the diff-derived kind', () => {
    const toolMeta = memoFromPending();
    expect(mapKimiUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_write_1',
      status: 'completed',
      kind: 'edit',
      locations: [{ path: '/tmp/kimi-probe/acp.txt' }],
      content: [
        { type: 'diff', path: '/tmp/kimi-probe/acp.txt', oldText: '', newText: 'hello' },
        { type: 'diff', path: '/tmp/kimi-probe/acp.txt', oldText: '', newText: 'hello' },
        { type: 'diff', path: '/tmp/gone.txt', oldText: 'old', newText: '' },
        { type: 'diff', path: '/tmp/changed.txt', oldText: 'a\nb', newText: 'a\nb\nc' },
      ],
    }, toolMeta)).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'call_write_1', content: 'hellohello(edited /tmp/gone.txt)a\nb\nc', isError: false } },
      {
        type: 'file_change',
        payload: {
          path: '/tmp/kimi-probe/acp.txt',
          kind: 'created',
          toolUseId: 'call_write_1',
          additions: 1,
          deletions: 0,
        },
      },
      {
        type: 'file_change',
        payload: {
          path: '/tmp/gone.txt',
          kind: 'deleted',
          toolUseId: 'call_write_1',
          additions: 0,
          deletions: 1,
        },
      },
      {
        type: 'file_change',
        payload: {
          path: '/tmp/changed.txt',
          kind: 'modified',
          toolUseId: 'call_write_1',
          additions: 1,
          deletions: 0,
        },
      },
    ]);
  });

  it('returns [] for ignored and unknown sessionUpdate variants without throwing', () => {
    const toolMeta = new Map<string, ToolMeta>();
    expect(mapKimiUpdate({ sessionUpdate: 'session_info_update', title: 'x' }, toolMeta)).toEqual([]);
    expect(mapKimiUpdate({ sessionUpdate: 'config_option_update' }, toolMeta)).toEqual([]);
    expect(mapKimiUpdate({ sessionUpdate: 'available_commands_update' }, toolMeta)).toEqual([]);
    expect(mapKimiUpdate({ sessionUpdate: 'usage_update', used: 1, size: 10 }, toolMeta)).toEqual([]);
    expect(mapKimiUpdate({ sessionUpdate: 'current_mode_update' }, toolMeta)).toEqual([]);
    expect(mapKimiUpdate({ sessionUpdate: 'plan' }, toolMeta)).toEqual([]);
    expect(mapKimiUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }, toolMeta)).toEqual([]);
    expect(mapKimiUpdate({ sessionUpdate: 'totally_unknown' }, toolMeta)).toEqual([]);
  });
});

describe('contextPctFromUsageUpdate', () => {
  it('computes used/size * 100 for the live usage_update fixture', () => {
    expect(contextPctFromUsageUpdate({ used: 25076, size: 1_000_000 })).toBeCloseTo(2.5076, 4);
  });

  it('returns undefined when size is 0 or non-numeric', () => {
    expect(contextPctFromUsageUpdate({ used: 10, size: 0 })).toBeUndefined();
    expect(contextPctFromUsageUpdate({ used: 10, size: '1000000' })).toBeUndefined();
    expect(contextPctFromUsageUpdate({ used: 'x', size: 100 })).toBeUndefined();
  });

  it('clamps used > size to 100', () => {
    expect(contextPctFromUsageUpdate({ used: 200, size: 100 })).toBe(100);
  });
});
