/**
 * Copilot CLI JSONL → NormalisedEvent mapping.
 * Schema verified against @github/copilot@1.0.82 (`--output-format json --stream on`).
 *
 * PARSE vs EMIT allow-lists are explicit. Do NOT filter on `ephemeral`:
 * `assistant.message_delta` (live prose) and `model.model_call_success` (the
 * only token-count source) are both ephemeral, and dropping them would
 * silently lose the stream and the usage panel.
 *
 * Hard-ignore (do not "add for completeness"): session.skills_loaded (~50 KB),
 * model.messages_snapshot (system prompt + conversation), session.background_tasks_changed,
 * assistant.tool_call_delta, assistant.reasoning*, user.message, remaining model.*,
 * remaining session.*, prompt_cache_break.
 */
import type { ChangeKind, NormalisedEvent } from '@tierwyn/shared';

export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

const PARSE_TYPES = new Set([
  'model.model_call_success',
  'session.auto_mode_resolved',
]);

const EMIT_TYPES = new Set([
  'assistant.turn_start',
  'assistant.message_delta',
  'assistant.message',
  'tool.execution_start',
  'tool.execution_complete',
  'result',
]);

export interface CopilotStreamState {
  /** messageIds for which we already streamed assistant.message_delta. */
  sawStreamingDeltaByMessageId: Set<string>;
  turnStartEmitted: boolean;
  emittedFilePaths: Set<string>;
  /** A tool ran this turn. `result.filesModified` is session-cumulative, so a
   *  tool-less (reply-only) turn must not replay it as fresh file changes. */
  ranTool: boolean;
  /** Paths already reported by an earlier turn's cumulative `filesModified`
   *  (owned by the adapter, shared across turns). */
  priorResultFiles: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  maxPromptTokens: number;
  chosenModel: string;
}

export function createCopilotStreamState(priorResultFiles = new Set<string>()): CopilotStreamState {
  return {
    sawStreamingDeltaByMessageId: new Set(),
    turnStartEmitted: false,
    emittedFilePaths: new Set(),
    ranTool: false,
    priorResultFiles,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    maxPromptTokens: 0,
    chosenModel: '',
  };
}

export function usageFromState(state: CopilotStreamState): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  maxPromptTokens: number;
} {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheCreationTokens: state.cacheCreationTokens,
    maxPromptTokens: state.maxPromptTokens,
  };
}

/** `toolTelemetry.restrictedProperties.filePaths` is a JSON-encoded string, not an array. */
export function parseFilePaths(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((p): p is string => typeof p === 'string');
  }
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

export function changeKindFor(command: string | undefined): ChangeKind {
  if (command === 'create') return 'created';
  if (command === 'delete' || command === 'remove') return 'deleted';
  return 'modified';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function absorbUsage(state: CopilotStreamState, data: Record<string, unknown>): void {
  const ru = asRecord(data.responseUsage);
  const details = asRecord(ru.prompt_tokens_details);
  if (typeof ru.completion_tokens === 'number') state.outputTokens += ru.completion_tokens;
  const cached = typeof details.cached_tokens === 'number' ? details.cached_tokens : 0;
  const creation =
    typeof details.cache_creation_tokens === 'number' ? details.cache_creation_tokens : 0;
  // OpenAI shape: prompt_tokens INCLUDES cached + creation. Tierwyn's Anthropic-shaped
  // usage contract wants inputTokens = the uncached remainder; mapping 1:1 inflated
  // contextWindowPct ~2x (fixtures: 22666-22327-329, 22337-0-22327, 22713-22327-379).
  if (typeof ru.prompt_tokens === 'number') {
    state.inputTokens = Math.max(0, ru.prompt_tokens - cached - creation);
  }
  if (typeof details.cached_tokens === 'number') state.cacheReadTokens = details.cached_tokens;
  if (typeof details.cache_creation_tokens === 'number') {
    state.cacheCreationTokens = details.cache_creation_tokens;
  }
  if (typeof data.maxPromptTokens === 'number') state.maxPromptTokens = data.maxPromptTokens;
}

/**
 * Map one Copilot NDJSON envelope into zero or more partial NormalisedEvents.
 * Unknown types are ignored. The adapter owns sessionId/seq/ts and the
 * terminal status:done event.
 */
export function mapCopilotFrame(
  frame: Record<string, unknown>,
  state: CopilotStreamState = createCopilotStreamState(),
): PartialEvent[] {
  const type = frame.type as string | undefined;
  if (!type || (!PARSE_TYPES.has(type) && !EMIT_TYPES.has(type))) return [];

  const data = asRecord(frame.data);

  if (type === 'model.model_call_success') {
    absorbUsage(state, data);
    return [];
  }
  if (type === 'session.auto_mode_resolved') {
    if (typeof data.chosenModel === 'string') state.chosenModel = data.chosenModel;
    return [];
  }

  if (type === 'assistant.turn_start') {
    if (state.turnStartEmitted) return [];
    state.turnStartEmitted = true;
    return [{ type: 'status', payload: { status: 'running' } }];
  }

  if (type === 'assistant.message_delta') {
    const messageId = typeof data.messageId === 'string' ? data.messageId : '';
    const chunk = typeof data.deltaContent === 'string' ? data.deltaContent : '';
    if (messageId) state.sawStreamingDeltaByMessageId.add(messageId);
    if (!chunk) return [];
    return [{ type: 'message', payload: { chunk, final: false } }];
  }

  if (type === 'assistant.message') {
    const content = typeof data.content === 'string' ? data.content : '';
    if (!content) return [];
    const messageId = typeof data.messageId === 'string' ? data.messageId : '';
    if (messageId && state.sawStreamingDeltaByMessageId.has(messageId)) {
      return [{ type: 'message', payload: { chunk: '', final: true } }];
    }
    return [{ type: 'message', payload: { chunk: content, final: true } }];
  }

  if (type === 'tool.execution_start') {
    const toolUseId = String(data.toolCallId ?? '');
    const name = String(data.toolName ?? 'tool');
    const input = asRecord(data.arguments);
    if (typeof data.arguments === 'string' && data.arguments.trim()) {
      input.patch = data.arguments;
    }
    state.ranTool = true;
    return [{ type: 'tool_call', payload: { toolUseId, name, input } }];
  }

  if (type === 'tool.execution_complete') {
    const toolUseId = String(data.toolCallId ?? '');
    const result = asRecord(data.result);
    const error = asRecord(data.error);
    const content = String(result.content ?? error.message ?? '');
    const isError = data.success === false;
    const out: PartialEvent[] = [
      { type: 'tool_result', payload: { toolUseId, content, isError } },
    ];
    const telemetry = asRecord(data.toolTelemetry);
    const restricted = asRecord(telemetry.restrictedProperties);
    const properties = asRecord(telemetry.properties);
    const metrics = asRecord(telemetry.metrics);
    const command = typeof properties.command === 'string' ? properties.command : undefined;
    const kind = changeKindFor(command);
    const additions = typeof metrics.linesAdded === 'number' ? metrics.linesAdded : undefined;
    const deletions = typeof metrics.linesRemoved === 'number' ? metrics.linesRemoved : undefined;
    const detailedContent = typeof result.detailedContent === 'string' ? result.detailedContent : undefined;
    for (const path of parseFilePaths(restricted.filePaths)) {
      if (!path || state.emittedFilePaths.has(path)) continue;
      state.emittedFilePaths.add(path);
      out.push({
        type: 'file_change',
        payload: { path, kind, additions, deletions, toolUseId, ...(detailedContent ? { diff: detailedContent } : {}) },
      });
    }
    return out;
  }

  if (type === 'result') {
    const usage = asRecord(frame.usage);
    const codeChanges = asRecord(usage.codeChanges);
    const files = Array.isArray(codeChanges.filesModified)
      ? codeChanges.filesModified.filter((p): p is string => typeof p === 'string')
      : [];
    const out: PartialEvent[] = [];
    for (const path of files) {
      // ponytail: a shell-redirect rewrite of a file already reported earlier in
      // the session is missed; only per-turn telemetry could catch that.
      const seenBefore = state.priorResultFiles.has(path);
      state.priorResultFiles.add(path);
      if (!path || !state.ranTool || seenBefore || state.emittedFilePaths.has(path)) continue;
      state.emittedFilePaths.add(path);
      out.push({ type: 'file_change', payload: { path, kind: 'modified' } });
    }
    return out;
  }

  return [];
}
