import { describe, it, expect } from 'vitest';
import { mapQwenUpdate, usageFromChunkMeta, contextPctFromUsageUpdate } from './mapping.js';

// Verified ACP wire shapes from plan § 4 (qwen 0.22.3 live probes).
const AGENT_MESSAGE_CHUNK = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'done' },
  _meta: {
    usage: {
      inputTokens: 29345,
      outputTokens: 115,
      totalTokens: 29460,
      thoughtTokens: 90,
      cachedReadTokens: 3136,
    },
    durationMs: 8258,
  },
};

const AGENT_THOUGHT_CHUNK = {
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text: 'The' },
};

const USAGE_UPDATE = { sessionUpdate: 'usage_update', used: 29345, size: 1000000 };

const TOOL_CALL_PENDING = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_1b21…',
  status: 'pending',
  title: 'WriteFile',
  content: [],
  locations: [],
  kind: 'edit',
  rawInput: {},
  _meta: { toolName: 'write_file', provenance: 'builtin', phase: 'preparing' },
};

const TOOL_CALL_IN_PROGRESS = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_1b21…',
  status: 'in_progress',
  title: 'WriteFile: Writing to qwen_acp_probe.txt',
  locations: [{ path: '/tmp/qwen_acp_probe.txt', line: null }],
  kind: 'edit',
  rawInput: { content: 'hello', file_path: '/tmp/qwen_acp_probe.txt' },
  _meta: { toolName: 'write_file', provenance: 'builtin' },
};

const TOOL_CALL_COMPLETED = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_1b21…',
  status: 'completed',
  content: [{ type: 'diff', path: 'qwen_acp_probe.txt', oldText: '', newText: 'hello' }],
  rawOutput: {
    fileDiff: '…',
    fileName: 'qwen_acp_probe.txt',
    diffStat: { model_added_lines: 1 },
  },
  _meta: { toolName: 'write_file', provenance: 'builtin' },
};

describe('mapQwenUpdate', () => {
  it('maps agent_message_chunk to a message with final:false', () => {
    expect(mapQwenUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    })).toEqual([{ type: 'message', payload: { chunk: 'hi', final: false } }]);
  });

  it('returns [] for an empty agent_message_chunk', () => {
    expect(mapQwenUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
    })).toEqual([]);
  });

  it('drops agent_thought_chunk in v1', () => {
    expect(mapQwenUpdate(AGENT_THOUGHT_CHUNK)).toEqual([]);
  });

  it('suppresses the card on a pending tool_call with empty rawInput (args come on in_progress)', () => {
    expect(mapQwenUpdate(TOOL_CALL_PENDING)).toEqual([]);
  });

  it('maps a pending tool_call with locations to file_change only (no empty card)', () => {
    expect(mapQwenUpdate({
      ...TOOL_CALL_PENDING,
      locations: [{ path: '/tmp/qwen_acp_probe.txt' }],
    })).toEqual([
      { type: 'file_change', payload: { path: '/tmp/qwen_acp_probe.txt', kind: 'modified', toolUseId: 'call_1b21…' } },
    ]);
  });

  it('emits the tool_call card from the in_progress update with the real rawInput', () => {
    expect(mapQwenUpdate(TOOL_CALL_IN_PROGRESS)).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'call_1b21…', name: 'write_file', input: { content: 'hello', file_path: '/tmp/qwen_acp_probe.txt' } } },
    ]);
  });

  it('emits a card from in_progress even with empty rawInput (no worse than before)', () => {
    expect(mapQwenUpdate({
      ...TOOL_CALL_IN_PROGRESS,
      rawInput: {},
      _meta: {},
    })).toEqual([
      { type: 'tool_call', payload: { toolUseId: 'call_1b21…', name: 'WriteFile: Writing to qwen_acp_probe.txt', input: {} } },
    ]);
  });

  it('maps completed diff to tool_result + file_change created with additions:1', () => {
    expect(mapQwenUpdate(TOOL_CALL_COMPLETED)).toEqual([
      { type: 'tool_result', payload: { toolUseId: 'call_1b21…', content: 'hello', isError: false } },
      {
        type: 'file_change',
        payload: { path: 'qwen_acp_probe.txt', kind: 'created', toolUseId: 'call_1b21…', additions: 1, deletions: 0 },
      },
    ]);
  });

  it('maps tool_call_update failed to tool_result{isError:true}', () => {
    expect(mapQwenUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_fail',
      status: 'failed',
      content: 'boom',
    })).toEqual([{ type: 'tool_result', payload: { toolUseId: 'call_fail', content: 'boom', isError: true } }]);
  });

  it('returns [] for unknown sessionUpdate without throwing', () => {
    expect(mapQwenUpdate({ sessionUpdate: 'current_mode_update', mode: 'yolo' })).toEqual([]);
    expect(mapQwenUpdate({ sessionUpdate: 'plan' })).toEqual([]);
    expect(mapQwenUpdate({ sessionUpdate: 'available_commands_update' })).toEqual([]);
    expect(mapQwenUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } })).toEqual([]);
    expect(mapQwenUpdate(USAGE_UPDATE)).toEqual([]);
    expect(mapQwenUpdate({})).toEqual([]);
  });
});

describe('contextPctFromUsageUpdate', () => {
  it('computes used/size * 100 for the live usage_update fixture', () => {
    expect(contextPctFromUsageUpdate(USAGE_UPDATE)).toBeCloseTo(2.9345, 4);
  });

  it('returns undefined when size is missing or 0', () => {
    expect(contextPctFromUsageUpdate({ sessionUpdate: 'usage_update', used: 29345 })).toBeUndefined();
    expect(contextPctFromUsageUpdate({ sessionUpdate: 'usage_update', used: 10, size: 0 })).toBeUndefined();
  });
});

describe('usageFromChunkMeta', () => {
  it('maps the live _meta.usage to token fields (cachedReadTokens, not summed)', () => {
    expect(usageFromChunkMeta(AGENT_MESSAGE_CHUNK)).toEqual({
      inputTokens: 29345,
      outputTokens: 115,
      cacheReadTokens: 3136,
    });
  });

  it('returns undefined when _meta.usage is absent', () => {
    expect(usageFromChunkMeta({ sessionUpdate: 'agent_message_chunk' })).toBeUndefined();
  });
});
