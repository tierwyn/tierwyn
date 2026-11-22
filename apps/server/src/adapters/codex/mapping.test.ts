/**
 * mapping.test.ts — Vitest over the pure mapping functions.
 *
 * Fixtures are real notification lines captured from the codex-spike.mjs output
 * (codex-cli 0.142.5, 2026-07-08). Run with:
 *   npx vitest run apps/server/src/adapters/codex/mapping.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  mapThreadStatusChanged,
  mapTurnStarted,
  mapAgentMessageDelta,
  mapItemStarted,
  mapItemCompleted,
  mapTokenUsageUpdated,
  mapTurnCompleted,
  mapError,
} from './mapping.js';
import type { MappingState } from './mapping.js';

// ── Fixtures (real spike output) ──────────────────────────────────────────────

const THREAD_ID = '019f3edc-24ba-7602-bfca-3fc968f83647';
const TURN_ID   = '019f3edc-24f4-76f1-bcdd-4b0d26f81713';
const ITEM_ID   = 'msg_09054f1580d6b692016a4d884112108191b4471191659e91c2';

const FIXTURE_THREAD_STATUS_ACTIVE = {
  threadId: THREAD_ID,
  status: { type: 'active', activeFlags: [] },
};

const FIXTURE_THREAD_STATUS_IDLE = {
  threadId: THREAD_ID,
  status: { type: 'idle' },
};

const FIXTURE_TURN_STARTED = {
  threadId: THREAD_ID,
  turn: { id: TURN_ID, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1783466042, completedAt: null, durationMs: null },
};

const FIXTURE_AGENT_MSG_DELTA = {
  threadId: THREAD_ID,
  turnId: TURN_ID,
  itemId: ITEM_ID,
  delta: 'P',
};

const FIXTURE_AGENT_MSG_DELTA_REST = {
  threadId: THREAD_ID,
  turnId: TURN_ID,
  itemId: ITEM_ID,
  delta: 'ONG',
};

const FIXTURE_ITEM_STARTED_AGENT_MSG = {
  item: { type: 'agentMessage', id: ITEM_ID, text: '', phase: 'final_answer', memoryCitation: null },
  threadId: THREAD_ID,
  turnId: TURN_ID,
  startedAtMs: 1783466049326,
};

const FIXTURE_ITEM_COMPLETED_AGENT_MSG = {
  item: { type: 'agentMessage', id: ITEM_ID, text: 'PONG', phase: 'final_answer', memoryCitation: null },
  threadId: THREAD_ID,
  turnId: TURN_ID,
  completedAtMs: 1783466049495,
};

const FIXTURE_TOKEN_USAGE = {
  threadId: THREAD_ID,
  turnId: TURN_ID,
  tokenUsage: {
    total: { totalTokens: 14190, inputTokens: 14184, cachedInputTokens: 4480, outputTokens: 6, reasoningOutputTokens: 0 },
    last: { totalTokens: 14190, inputTokens: 14184, cachedInputTokens: 4480, outputTokens: 6, reasoningOutputTokens: 0 },
    modelContextWindow: 200000,
  },
};

const FIXTURE_TURN_COMPLETED = {
  threadId: THREAD_ID,
  turn: { id: TURN_ID, items: [], itemsView: 'notLoaded', status: 'completed', error: null, startedAt: 1783466042, completedAt: 1783466049, durationMs: 6909 },
};

const FIXTURE_ITEM_STARTED_CMD = {
  item: { type: 'commandExecution', id: 'cmd-1', command: 'ls /tmp', cwd: '/home/user', aggregatedOutput: null, exitCode: null, processId: null, source: 'model', status: 'running', commandActions: [] },
  threadId: THREAD_ID,
  turnId: TURN_ID,
  startedAtMs: 1783466050000,
};

const FIXTURE_ITEM_COMPLETED_CMD = {
  item: { type: 'commandExecution', id: 'cmd-1', command: 'ls /tmp', cwd: '/home/user', aggregatedOutput: 'file1.txt\nfile2.txt', exitCode: 0, processId: null, source: 'model', status: 'done', commandActions: [] },
  threadId: THREAD_ID,
  turnId: TURN_ID,
  completedAtMs: 1783466050500,
};

const FIXTURE_ITEM_COMPLETED_FILE_CHANGE = {
  item: {
    type: 'fileChange',
    id: 'fc-1',
    changes: [
      { path: '/tmp/codex-smoke.txt', kind: 'created', diff: '+HELLO' },
    ],
    status: 'applied',
  },
  threadId: THREAD_ID,
  turnId: TURN_ID,
  completedAtMs: 1783466051000,
};

// Real codex behaviour: query is EMPTY at item/started; it only arrives at item/completed.
const FIXTURE_ITEM_STARTED_WEB_SEARCH = {
  item: { type: 'webSearch', id: 'ws-1', query: '' },
  threadId: THREAD_ID,
  turnId: TURN_ID,
  startedAtMs: 1783466051500,
};

const FIXTURE_ITEM_COMPLETED_WEB_SEARCH = {
  item: { type: 'webSearch', id: 'ws-1', query: 'openai codex news' },
  threadId: THREAD_ID,
  turnId: TURN_ID,
  completedAtMs: 1783466052000,
};

const FIXTURE_ERROR_NO_RETRY = {
  error: 'Connection refused',
  willRetry: false,
  threadId: THREAD_ID,
  turnId: TURN_ID,
};

const FIXTURE_ERROR_WILL_RETRY = {
  error: 'Rate limit',
  willRetry: true,
  threadId: THREAD_ID,
  turnId: TURN_ID,
};

// Real prod payload: codex app-server sends error as an object, not a string.
const FIXTURE_ERROR_OBJECT = {
  error: {
    message: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
    codexErrorInfo: 'other',
    additionalDetails: null,
  },
  willRetry: false,
  threadId: THREAD_ID,
  turnId: TURN_ID,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

// ── Type-narrowing helpers for tests ─────────────────────────────────────────
type AnyPayload = Record<string, unknown>;
const p = (ev: { payload: unknown } | null | undefined) => ev?.payload as AnyPayload;

describe('mapThreadStatusChanged', () => {
  it('returns status:running when status type is active', () => {
    const ev = mapThreadStatusChanged(FIXTURE_THREAD_STATUS_ACTIVE);
    expect(ev).not.toBeNull();
    expect(ev?.type).toBe('status');
    expect(p(ev).status).toBe('running');
  });

  it('returns null when status type is idle', () => {
    const ev = mapThreadStatusChanged(FIXTURE_THREAD_STATUS_IDLE);
    expect(ev).toBeNull();
  });
});

describe('mapTurnStarted', () => {
  it('returns status:running', () => {
    const ev = mapTurnStarted(FIXTURE_TURN_STARTED as Parameters<typeof mapTurnStarted>[0]);
    expect(ev.type).toBe('status');
    expect(p(ev).status).toBe('running');
  });
});

describe('mapAgentMessageDelta', () => {
  it('returns message chunk with final:false', () => {
    const ev = mapAgentMessageDelta(FIXTURE_AGENT_MSG_DELTA);
    expect(ev.type).toBe('message');
    expect(p(ev).chunk).toBe('P');
    expect(p(ev).final).toBe(false);
  });

  it('handles multi-char delta', () => {
    const ev = mapAgentMessageDelta(FIXTURE_AGENT_MSG_DELTA_REST);
    expect(p(ev).chunk).toBe('ONG');
    expect(p(ev).final).toBe(false);
  });
});

describe('mapItemStarted', () => {
  it('returns null for agentMessage items', () => {
    const ev = mapItemStarted(FIXTURE_ITEM_STARTED_AGENT_MSG as Parameters<typeof mapItemStarted>[0]);
    expect(ev).toBeNull();
  });

  it('returns tool_call for commandExecution', () => {
    const ev = mapItemStarted(FIXTURE_ITEM_STARTED_CMD as Parameters<typeof mapItemStarted>[0]);
    expect(ev).not.toBeNull();
    expect(ev?.type).toBe('tool_call');
    expect(p(ev).toolUseId).toBe('cmd-1');
    expect(p(ev).name).toBe('commandExecution');
    expect((p(ev).input as Record<string, unknown>).command).toBe('ls /tmp');
  });

  it('returns null for webSearch (query only arrives at item/completed)', () => {
    const ev = mapItemStarted(FIXTURE_ITEM_STARTED_WEB_SEARCH as Parameters<typeof mapItemStarted>[0]);
    expect(ev).toBeNull();
  });
});

describe('mapItemCompleted', () => {
  it('agentMessage → message final:true with empty chunk', () => {
    const evs = mapItemCompleted(FIXTURE_ITEM_COMPLETED_AGENT_MSG as Parameters<typeof mapItemCompleted>[0]);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('message');
    expect(p(evs[0]).final).toBe(true);
    expect(p(evs[0]).chunk).toBe('');
  });

  it('commandExecution → tool_result', () => {
    const evs = mapItemCompleted(FIXTURE_ITEM_COMPLETED_CMD as Parameters<typeof mapItemCompleted>[0]);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('tool_result');
    expect(p(evs[0]).toolUseId).toBe('cmd-1');
    expect(p(evs[0]).content).toBe('file1.txt\nfile2.txt');
    expect(p(evs[0]).isError).toBe(false);
  });

  it('fileChange → file_change events + tool_result', () => {
    const evs = mapItemCompleted(FIXTURE_ITEM_COMPLETED_FILE_CHANGE as Parameters<typeof mapItemCompleted>[0]);
    const fileChangeEvs = evs.filter((e) => e.type === 'file_change');
    const toolResultEvs = evs.filter((e) => e.type === 'tool_result');
    expect(fileChangeEvs).toHaveLength(1);
    expect(p(fileChangeEvs[0]).path).toBe('/tmp/codex-smoke.txt');
    expect(p(fileChangeEvs[0]).kind).toBe('created');
    expect(toolResultEvs).toHaveLength(1);
  });

  it('webSearch → tool_call with real query + non-empty tool_result', () => {
    const evs = mapItemCompleted(FIXTURE_ITEM_COMPLETED_WEB_SEARCH as Parameters<typeof mapItemCompleted>[0]);
    expect(evs).toHaveLength(2);
    expect(evs[0].type).toBe('tool_call');
    expect(p(evs[0]).toolUseId).toBe('ws-1');
    expect(p(evs[0]).name).toBe('webSearch');
    expect((p(evs[0]).input as Record<string, unknown>).query).toBe('openai codex news');
    expect(evs[1].type).toBe('tool_result');
    expect(p(evs[1]).toolUseId).toBe('ws-1');
    expect(String(p(evs[1]).content).trim().length).toBeGreaterThan(0);
  });
});

describe('mapTokenUsageUpdated', () => {
  it('mutates state with token counts', () => {
    const state: MappingState = {};
    const result = mapTokenUsageUpdated(FIXTURE_TOKEN_USAGE, state);
    expect(result).toBeNull();
    expect(state.lastTokenUsage?.inputTokens).toBe(14184);
    expect(state.lastTokenUsage?.outputTokens).toBe(6);
    expect(state.lastTokenUsage?.cacheReadTokens).toBe(4480);
    expect(state.lastTokenUsage?.modelContextWindow).toBe(200000);
  });
});

describe('mapTurnCompleted', () => {
  it('returns status:done with token usage from state', () => {
    const state: MappingState = {};
    mapTokenUsageUpdated(FIXTURE_TOKEN_USAGE, state);
    const ev = mapTurnCompleted(FIXTURE_TURN_COMPLETED as Parameters<typeof mapTurnCompleted>[0], state);
    expect(ev.type).toBe('status');
    expect(p(ev).status).toBe('done');
    expect(p(ev).inputTokens).toBe(14184);
    expect(p(ev).outputTokens).toBe(6);
    expect(p(ev).cacheReadTokens).toBe(4480);
    // context % = (14184 + 4480) / 200000 * 100 = ~9
    expect(typeof p(ev).contextWindowPct).toBe('number');
    expect(p(ev).contextWindowPct as number).toBeGreaterThan(0);
    expect(p(ev).contextWindowPct as number).toBeLessThanOrEqual(100);
  });

  it('returns status:done even without token state', () => {
    const state: MappingState = {};
    const ev = mapTurnCompleted(FIXTURE_TURN_COMPLETED as Parameters<typeof mapTurnCompleted>[0], state);
    expect(ev.type).toBe('status');
    expect(p(ev).status).toBe('done');
  });
});

describe('mapError', () => {
  it('willRetry:false → error + status:error', () => {
    const evs = mapError(FIXTURE_ERROR_NO_RETRY);
    expect(evs).toHaveLength(2);
    expect(evs[0].type).toBe('error');
    expect(p(evs[0]).message).toBe('Connection refused');
    expect(evs[1].type).toBe('status');
    expect(p(evs[1]).status).toBe('error');
  });

  it('willRetry:true → only error event (no status:error)', () => {
    const evs = mapError(FIXTURE_ERROR_WILL_RETRY);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('error');
  });

  it('object-shaped error → message is the extracted string, never an object', () => {
    const evs = mapError(FIXTURE_ERROR_OBJECT);
    expect(typeof p(evs[0]).message).toBe('string');
    expect(p(evs[0]).message).toBe(
      "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
    );
  });
});

describe('review mode items (tripwire)', () => {
  // Inline review/start runs as a normal turn: findings arrive as agentMessage items.
  // enteredReviewMode / exitedReviewMode fall through the default branch → null / [].
  // If a future codex build emits structured review-finding items, this test still passes
  // but the operator smoke test (Task 8) will reveal unrendered findings → add mapping then.
  it('mapItemStarted returns null for enteredReviewMode', () => {
    const item = { type: 'enteredReviewMode', id: 'rev-1', review: {} };
    const ev = mapItemStarted({ item, threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 0 } as Parameters<typeof mapItemStarted>[0]);
    expect(ev).toBeNull();
  });

  it('mapItemCompleted returns [] for exitedReviewMode', () => {
    const item = { type: 'exitedReviewMode', id: 'rev-2', review: {} };
    const evs = mapItemCompleted({ item, threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 0 } as Parameters<typeof mapItemCompleted>[0]);
    expect(evs).toEqual([]);
  });
});

describe('collabAgentToolCall (Codex native subagents)', () => {
  const RECEIVER = '01a1f05a-1555-7000-8000-000000000001';
  const SENDER = '01a1f059-0000-7000-8000-000000000000';

  function collabItem(overrides: Record<string, unknown>) {
    return {
      type: 'collabAgentToolCall',
      id: 'exec-collab-1',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: SENDER,
      receiverThreadIds: [RECEIVER],
      prompt: 'Run the command `hostname` on the machine',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      agentsStates: { [RECEIVER]: { status: 'pendingInit', message: null } },
      receiverAgents: [{ threadId: RECEIVER, agentNickname: 'Halley' }],
      ...overrides,
    };
  }

  function completedParams(item: Record<string, unknown>) {
    return {
      item,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 0,
    } as Parameters<typeof mapItemCompleted>[0];
  }

  function startedParams(item: Record<string, unknown>) {
    return {
      item,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      startedAtMs: 0,
    } as Parameters<typeof mapItemStarted>[0];
  }

  it('spawn → tool_call with subagent_type keyed on receiver thread id', () => {
    const evs = mapItemCompleted(completedParams(collabItem({})));
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('tool_call');
    expect(p(evs[0]).toolUseId).toBe(RECEIVER);
    expect(p(evs[0]).name).toBe('Agent');
    const input = p(evs[0]).input as Record<string, unknown>;
    expect(input.subagent_type).toBe('Halley');
    expect(input.prompt).toBe('Run the command `hostname` on the machine');
    expect(input.description).toBe('Run the command `hostname` on the machine');
  });

  it('spawn without nickname falls back to subagent_type codex', () => {
    const evs = mapItemCompleted(completedParams(collabItem({ receiverAgents: undefined })));
    const input = p(evs[0]).input as Record<string, unknown>;
    expect(input.subagent_type).toBe('codex');
  });

  it('mapItemStarted emits nothing for spawn (avoid a duplicate helper row)', () => {
    const ev = mapItemStarted(startedParams(collabItem({})));
    expect(ev).toBeNull();
  });

  it('wait completed → tool_result with the same receiver id', () => {
    const evs = mapItemCompleted(completedParams(collabItem({
      id: 'exec-wait-1',
      tool: 'wait',
      agentsStates: { [RECEIVER]: { status: 'completed', message: '`dev-box`' } },
    })));
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('tool_result');
    expect(p(evs[0]).toolUseId).toBe(RECEIVER);
    expect(p(evs[0]).content).toBe('`dev-box`');
    expect(p(evs[0]).isError).toBe(false);
  });

  it('errored agent state → tool_result isError', () => {
    const evs = mapItemCompleted(completedParams(collabItem({
      id: 'exec-wait-err',
      tool: 'wait',
      agentsStates: { [RECEIVER]: { status: 'errored', message: 'child panicked' } },
    })));
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('tool_result');
    expect(p(evs[0]).toolUseId).toBe(RECEIVER);
    expect(p(evs[0]).content).toBe('child panicked');
    expect(p(evs[0]).isError).toBe(true);
  });

  it('non-terminal sendInput / running wait → nothing', () => {
    const send = mapItemCompleted(completedParams(collabItem({
      id: 'exec-send',
      tool: 'sendInput',
      prompt: 'keep going',
      agentsStates: { [RECEIVER]: { status: 'running', message: null } },
    })));
    expect(send).toEqual([]);

    const waitRunning = mapItemCompleted(completedParams(collabItem({
      id: 'exec-wait-timeout',
      tool: 'wait',
      agentsStates: { [RECEIVER]: { status: 'running', message: null } },
    })));
    expect(waitRunning).toEqual([]);
  });

  it('rollout {completed: text} agent state still maps to tool_result', () => {
    const evs = mapItemCompleted(completedParams(collabItem({
      tool: 'wait',
      agentsStates: { [RECEIVER]: { completed: '`dev-box`' } },
    })));
    expect(p(evs[0]).content).toBe('`dev-box`');
    expect(p(evs[0]).isError).toBe(false);
  });
});

describe('end semantics sanity check', () => {
  it('no mapping function returns an end-like event', () => {
    // None of the mapping functions should emit or return an 'end'-typed event.
    // 'end' is a subprocess lifecycle signal emitted on the EventEmitter, NOT a NormalisedEvent.
    const state: MappingState = {};
    mapTokenUsageUpdated(FIXTURE_TOKEN_USAGE, state);

    const allEvents = [
      mapThreadStatusChanged(FIXTURE_THREAD_STATUS_ACTIVE),
      mapTurnStarted(FIXTURE_TURN_STARTED as Parameters<typeof mapTurnStarted>[0]),
      mapAgentMessageDelta(FIXTURE_AGENT_MSG_DELTA),
      mapItemStarted(FIXTURE_ITEM_STARTED_AGENT_MSG as Parameters<typeof mapItemStarted>[0]),
      ...mapItemCompleted(FIXTURE_ITEM_COMPLETED_AGENT_MSG as Parameters<typeof mapItemCompleted>[0]),
      mapTurnCompleted(FIXTURE_TURN_COMPLETED as Parameters<typeof mapTurnCompleted>[0], state),
      ...mapError(FIXTURE_ERROR_NO_RETRY),
    ].filter(Boolean);

    for (const ev of allEvents) {
      expect((ev as { type: string }).type).not.toBe('end');
    }
  });
});
