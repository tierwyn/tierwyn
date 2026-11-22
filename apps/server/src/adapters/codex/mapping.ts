/**
 * mapping.ts — Pure functions: codex app-server notification → NormalisedEvent.
 *
 * No subprocess dependency: all functions are pure (input → output, or
 * input + mutable state → output). This keeps mapping.test.ts free of spawning.
 *
 * IMPORTANT: None of these functions must ever emit or return an `'end'` event
 * marker. `'end'` is a subprocess-lifecycle signal emitted only when the codex
 * subprocess exits — it is not a mapping concern (see §5 of the plan).
 */

import { computeContextWindowPct } from '@tierwyn/shared';
import type {
  ThreadItem,
  ThreadStatusChangedParams,
  TurnStartedParams,
  TurnCompletedParams,
  ItemStartedParams,
  ItemCompletedParams,
  AgentMessageDeltaParams,
  TokenUsageUpdatedParams,
  ErrorNotificationParams,
} from './protocol.js';

/** Mutable state bag maintained by the adapter across notifications. */
export interface MappingState {
  lastTokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    modelContextWindow: number | null;
  };
}

/** A NormalisedEvent stripped of the BaseEvent fields that the adapter adds. */
export type EventPayload =
  | { type: 'status'; payload: { status: 'running' | 'idle' | 'waiting' | 'error' | 'done'; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; contextWindowPct?: number } }
  | { type: 'message'; payload: { chunk: string; final: boolean } }
  | { type: 'tool_call'; payload: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { type: 'tool_result'; payload: { toolUseId: string; content: string; isError: boolean } }
  | { type: 'file_change'; payload: { path: string; kind: 'created' | 'modified' | 'deleted' } }
  | { type: 'error'; payload: { message: string } };

// ── Per-notification mappers ──────────────────────────────────────────────────

/** `thread/status/changed` → status:running (when active) or null */
export function mapThreadStatusChanged(
  params: ThreadStatusChangedParams,
): EventPayload | null {
  if (params.status?.type === 'active') {
    return { type: 'status', payload: { status: 'running' } };
  }
  // idle = turn winding down; let turn/completed carry the final status
  return null;
}

/** `turn/started` → status:running (belt-and-suspenders alongside thread/status/changed) */
export function mapTurnStarted(
  _params: TurnStartedParams,
): EventPayload {
  return { type: 'status', payload: { status: 'running' } };
}

/** `item/agentMessage/delta` → streaming message chunk */
export function mapAgentMessageDelta(
  params: AgentMessageDeltaParams,
): EventPayload {
  return { type: 'message', payload: { chunk: params.delta, final: false } };
}

/** `item/started` → tool_call (for tool-type items) or null (for userMessage/agentMessage) */
export function mapItemStarted(
  params: ItemStartedParams,
): EventPayload | null {
  const { item } = params;
  switch (item.type) {
    case 'commandExecution': {
      const it = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      return {
        type: 'tool_call',
        payload: {
          toolUseId: it.id,
          name: 'commandExecution',
          input: { command: it.command, cwd: it.cwd },
        },
      };
    }
    case 'mcpToolCall': {
      const it = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      return {
        type: 'tool_call',
        payload: {
          toolUseId: it.id,
          name: `${it.server}/${it.tool}`,
          input: (it.arguments as Record<string, unknown>) ?? {},
        },
      };
    }
    case 'dynamicToolCall': {
      const it = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
      return {
        type: 'tool_call',
        payload: {
          toolUseId: it.id,
          name: it.namespace ? `${it.namespace}/${it.tool}` : it.tool,
          input: (it.arguments as Record<string, unknown>) ?? {},
        },
      };
    }
    // webSearch: codex leaves `query` empty at item/started — the tool_call
    // is emitted at item/completed instead, when the query is known.
    // collabAgentToolCall: spawn completes instantly with receiver ids on
    // item/completed; emitting here would duplicate the helper row.
    // userMessage, agentMessage, fileChange, reasoning, etc. — no tool_call on start
    default:
      return null;
  }
}

/** `item/completed` → one or more events (tool_result, file_change, message final, …) */
export function mapItemCompleted(
  params: ItemCompletedParams,
): EventPayload[] {
  const { item } = params;
  switch (item.type) {
    case 'agentMessage':
      // Streaming already delivered the text as deltas; emit the final marker.
      return [{ type: 'message', payload: { chunk: '', final: true } }];

    case 'commandExecution': {
      const it = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      const out = it.aggregatedOutput ?? '';
      const isError = it.exitCode !== null && it.exitCode !== 0;
      return [{
        type: 'tool_result',
        payload: { toolUseId: it.id, content: out, isError },
      }];
    }

    case 'mcpToolCall': {
      const it = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      // ponytail: best-effort content extraction — MCP results can be any shape
      let content = '';
      if (it.error) {
        content = it.error.message ?? 'MCP tool error';
        return [{ type: 'tool_result', payload: { toolUseId: it.id, content, isError: true } }];
      }
      const resultContent = (it.result?.content as Record<string, unknown>[]) ?? [];
      if (Array.isArray(resultContent)) {
        content = resultContent.map((ci: Record<string, unknown>) =>
          ci.type === 'text' ? String(ci.text ?? '') : '',
        ).join('');
      }
      return [{ type: 'tool_result', payload: { toolUseId: it.id, content, isError: false } }];
    }

    case 'dynamicToolCall': {
      const it = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
      const isError = it.success === false;
      const textParts = (it.contentItems ?? [])
        .filter((ci) => ci.type === 'text')
        .map((ci) => ci.text ?? '');
      return [{ type: 'tool_result', payload: { toolUseId: it.id, content: textParts.join(''), isError } }];
    }

    case 'fileChange': {
      const it = item as Extract<ThreadItem, { type: 'fileChange' }>;
      const events: EventPayload[] = [];
      for (const change of it.changes ?? []) {
        const kind = normaliseChangeKind(change.kind);
        events.push({ type: 'file_change', payload: { path: change.path, kind } });
      }
      // Also emit tool_result so the UI has a result card for the file-change tool
      events.push({
        type: 'tool_result',
        payload: {
          toolUseId: it.id,
          content: `Applied ${it.changes?.length ?? 0} file change(s)`,
          isError: false,
        },
      });
      return events;
    }

    case 'webSearch': {
      // Query only becomes available here, so emit the tool_call now too
      // (item/started intentionally emits nothing for webSearch).
      const it = item as Extract<ThreadItem, { type: 'webSearch' }>;
      const query = it.query?.trim() ? it.query : '(empty web search query)';
      return [
        {
          type: 'tool_call',
          payload: { toolUseId: it.id, name: 'webSearch', input: { query } },
        },
        {
          type: 'tool_result',
          payload: { toolUseId: it.id, content: `Searched: ${query}`, isError: false },
        },
      ];
    }

    case 'collabAgentToolCall':
      return mapCollabAgentToolCall(item);

    // userMessage, reasoning, plan, etc. — no output event
    default:
      return [];
  }
}

/** `thread/tokenUsage/updated` → mutates state (returns null — no event yet) */
export function mapTokenUsageUpdated(
  params: TokenUsageUpdatedParams,
  state: MappingState,
): null {
  const { last, modelContextWindow } = params.tokenUsage;
  state.lastTokenUsage = {
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    cacheReadTokens: last.cachedInputTokens,
    modelContextWindow: modelContextWindow ?? null,
  };
  return null;
}

/** `turn/completed` → status:done with stashed token usage */
export function mapTurnCompleted(
  _params: TurnCompletedParams,
  state: MappingState,
): EventPayload {
  const u = state.lastTokenUsage;
  const contextWindowPct = u?.modelContextWindow
    ? computeContextWindowPct(
        (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0),
        u.modelContextWindow,
      )
    : undefined;
  return {
    type: 'status',
    payload: {
      status: 'done',
      inputTokens: u?.inputTokens,
      outputTokens: u?.outputTokens,
      cacheReadTokens: u?.cacheReadTokens,
      contextWindowPct,
    },
  };
}

/** `error` notification → error event + status:error (when not willRetry) */
export function mapError(
  params: ErrorNotificationParams,
): EventPayload[] {
  const message =
    typeof params.error === 'string'
      ? params.error
      : params.error?.message ?? JSON.stringify(params.error ?? null);
  const events: EventPayload[] = [
    { type: 'error', payload: { message: message || 'Unknown codex error' } },
  ];
  if (!params.willRetry) {
    events.push({ type: 'status', payload: { status: 'error' } });
  }
  return events;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseChangeKind(kind: string): 'created' | 'modified' | 'deleted' {
  switch (kind) {
    case 'created': return 'created';
    case 'deleted': return 'deleted';
    default: return 'modified';
  }
}

// ── collabAgentToolCall (Codex native subagents → Helpers modal) ─────────────
//
// Key helpers on the *receiver thread id*, not the collab item id, so spawn
// and a later wait/close share one row. Web collectHelpers treats `name: Agent`
// + `input.subagent_type` as a helper; any matching tool_result marks it done.
// Spawn therefore emits only tool_call (helper stays running). Terminal agent
// states emit tool_result. Duplicate waits: web last-wins by toolUseId.

const COLLAB_TERMINAL = new Set([
  'completed', 'errored', 'shutdown', 'interrupted', 'notFound', 'not_found',
]);

function mapCollabAgentToolCall(item: ThreadItem): EventPayload[] {
  const rec = item as unknown as Record<string, unknown>;
  const tool = String(rec.tool ?? '');
  const isSpawn = tool === 'spawnAgent' || tool === 'spawn_agent';
  const receiverIds = collabReceiverIds(rec);
  const prompt = collabPrompt(rec);
  const states = collabAgentsStates(rec);
  const events: EventPayload[] = [];

  if (isSpawn) {
    for (const id of receiverIds) {
      events.push({
        type: 'tool_call',
        payload: {
          toolUseId: id,
          name: 'Agent',
          input: {
            subagent_type: collabNickname(rec, id),
            description: collabDescription(prompt),
            prompt,
          },
        },
      });
    }
  }

  for (const id of receiverIds) {
    const info = collabStateInfo(states[id]);
    if (!info.terminal) continue;
    events.push({
      type: 'tool_result',
      payload: {
        toolUseId: id,
        content: info.output,
        isError: info.isError,
      },
    });
  }

  return events;
}

function collabReceiverIds(rec: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  const fromField = rec.receiverThreadIds ?? rec.receiver_thread_ids;
  if (Array.isArray(fromField)) {
    for (const id of fromField) add(id);
  }
  const agents = rec.receiverAgents ?? rec.receiver_agents;
  if (Array.isArray(agents)) {
    for (const a of agents) {
      if (a && typeof a === 'object') {
        const o = a as Record<string, unknown>;
        add(o.threadId ?? o.thread_id);
      }
    }
  }
  const states = rec.agentsStates ?? rec.agents_states;
  if (states && typeof states === 'object' && !Array.isArray(states)) {
    for (const id of Object.keys(states as object)) add(id);
  }
  return ids;
}

function collabPrompt(rec: Record<string, unknown>): string {
  return typeof rec.prompt === 'string' ? rec.prompt : '';
}

function collabDescription(prompt: string): string {
  const line = prompt.split(/\r?\n/, 1)[0] ?? '';
  return line.length > 80 ? line.slice(0, 80) : line;
}

function collabNickname(rec: Record<string, unknown>, threadId: string): string {
  const agents = rec.receiverAgents ?? rec.receiver_agents;
  if (Array.isArray(agents)) {
    for (const a of agents) {
      if (!a || typeof a !== 'object') continue;
      const o = a as Record<string, unknown>;
      const id = o.threadId ?? o.thread_id;
      if (id !== threadId) continue;
      const nick = o.agentNickname ?? o.agent_nickname;
      if (typeof nick === 'string' && nick.trim()) return nick.trim();
    }
  }
  return 'codex';
}

function collabAgentsStates(rec: Record<string, unknown>): Record<string, unknown> {
  const states = rec.agentsStates ?? rec.agents_states;
  if (states && typeof states === 'object' && !Array.isArray(states)) {
    return states as Record<string, unknown>;
  }
  return {};
}

function collabStateInfo(state: unknown): { terminal: boolean; isError: boolean; output: string } {
  if (state == null) return { terminal: false, isError: false, output: '' };
  if (typeof state === 'string') {
    const terminal = COLLAB_TERMINAL.has(state);
    return { terminal, isError: state === 'errored', output: terminal ? state : '' };
  }
  if (typeof state !== 'object') return { terminal: false, isError: false, output: '' };
  const o = state as Record<string, unknown>;
  if (typeof o.status === 'string') {
    const terminal = COLLAB_TERMINAL.has(o.status);
    const isError = o.status === 'errored';
    const message = typeof o.message === 'string' ? o.message : '';
    return { terminal, isError, output: message || (terminal ? o.status : '') };
  }
  if ('completed' in o) {
    const output = typeof o.completed === 'string' ? o.completed : '';
    return { terminal: true, isError: false, output };
  }
  if ('errored' in o) {
    const output = typeof o.errored === 'string' ? o.errored : 'errored';
    return { terminal: true, isError: true, output };
  }
  return { terminal: false, isError: false, output: '' };
}
