import type { NormalisedEvent, StatusEvent } from '@tierwyn/shared';

// Distributive Omit — a bare Omit<Union, K> collapses HelperEvent.status into
// StatusEvent.payload and rejects AgentStatus values like 'error' | 'done'.
export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

/**
 * Per-turn state for `--stream-partial-output`. With that flag cursor-agent
 * re-sends the whole answer as a "flush" frame before each tool call and once at
 * end of turn; only frames carrying `timestamp_ms` without `model_call_id` hold
 * new text. A bare frame (neither field) is ambiguous: it is the final flush when
 * deltas were seen this turn, and a complete legacy segment otherwise.
 * The caller owns one state object per spawned turn.
 */
export interface CursorStreamState {
  sawStreamingDelta: boolean;
}

export function createCursorStreamState(): CursorStreamState {
  return { sawStreamingDelta: false };
}

/** Extract token usage fields from a cursor-agent result frame usage object. */
function usageFromCursorFrame(frame: Record<string, unknown>): Partial<StatusEvent['payload']> {
  const usage = frame.usage as Record<string, unknown> | undefined;
  if (!usage) return {};

  const inputTokens = (usage.inputTokens ?? usage.input_tokens) as number | undefined;
  const outputTokens = (usage.outputTokens ?? usage.output_tokens) as number | undefined;
  const cacheReadTokens = (usage.cacheReadTokens ?? usage.cache_read_tokens) as number | undefined;
  const cacheCreationTokens = (
    usage.cacheWriteTokens ?? usage.cache_write_tokens ??
    usage.cacheCreationTokens ?? usage.cache_creation_tokens
  ) as number | undefined;
  const costUsd = (frame.total_cost_usd ?? frame.totalCostUsd ?? usage.costUsd ?? usage.cost) as number | undefined;

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** Cursor tool_call keys that mutate files. The tool_call object is shaped
 *  `{ <toolKey>: { args, result? } }` with exactly one key. */
const FILE_WRITE_TOOLS = new Set(['writeToolCall', 'editToolCall', 'createToolCall', 'deleteToolCall']);

// ANSI escape code pattern (CSI sequences and simple codes).
const ANSI_RE = /\x1b\[[0-9|]*[A-Za-z]/g;

/**
 * Unpack a cursor-agent tool result into a human-readable string.
 * readToolCall:    { success: { content, ... } }
 * Terminal results: { success: { interleavedOutput|stdout, exitCode, ... }, isBackground }
 * Error results:   { error: { message, ... } }
 * Fallback:        JSON.stringify for unknown shapes.
 */
function extractToolOutput(result: unknown): string {
  if (typeof result === 'string') return result.replace(ANSI_RE, '');
  if (result == null) return '';
  const r = result as Record<string, unknown>;
  const success = r.success as Record<string, unknown> | undefined;
  if (success) {
    const text = String(
      success.interleavedOutput ??
      success.stdout ??
      success.content ??
      success.contents ??
      '',
    ).replace(ANSI_RE, '');
    const exit = success.exitCode;
    const suffix = typeof exit === 'number' && exit !== 0 ? `\n[exit ${exit}]` : '';
    if (text) return text + suffix;
    // grepToolCall and other tools: nested success payload, no flat text field
    return JSON.stringify(success, null, 2) + suffix;
  }
  const error = r.error as Record<string, unknown> | undefined;
  if (error) return String(error.message ?? JSON.stringify(error));
  return JSON.stringify(result);
}

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
        ? String((b as Record<string, unknown>).text ?? '')
        : '',
    )
    .join('');
}

function fileKind(toolName: string): 'created' | 'modified' | 'deleted' {
  if (toolName === 'createToolCall') return 'created';
  if (toolName === 'deleteToolCall') return 'deleted';
  return 'modified';
}

/**
 * Map one NDJSON frame from `cursor-agent -p --output-format stream-json` into
 * zero or more partial NormalisedEvents. The init frame's session_id is captured
 * by the adapter, not here. Defensive: malformed frames fall through to [].
 */
export function mapCursorEvent(
  frame: Record<string, unknown>,
  state: CursorStreamState = createCursorStreamState(),
): PartialEvent[] {
  const type = frame.type as string | undefined;

  if (type === 'assistant') {
    const hasTimestamp = frame.timestamp_ms !== undefined && frame.timestamp_ms !== null;
    const hasModelCallId = frame.model_call_id !== undefined && frame.model_call_id !== null;
    if (hasModelCallId) return [];                    // buffered flush before a tool call
    if (hasTimestamp) state.sawStreamingDelta = true; // streaming delta — new text
    else if (state.sawStreamingDelta) return [];      // final flush — already streamed
    const message = frame.message as { content?: unknown } | undefined;
    const chunk = textFromContent(message?.content);
    if (!chunk) return [];
    return [{ type: 'message', payload: { chunk, final: false } }];
  }

  if (type === 'tool_call') {
    const subtype = frame.subtype as string | undefined;
    const callId = String(frame.call_id ?? '');
    const toolCall = (frame.tool_call ?? {}) as Record<string, unknown>;
    const toolName = Object.keys(toolCall)[0] ?? 'tool';
    const detail = (toolCall[toolName] ?? {}) as Record<string, unknown>;
    const args = (detail.args ?? {}) as Record<string, unknown>;

    if (subtype === 'completed') {
      const content = extractToolOutput(detail.result);
      const isError = (detail.result as Record<string, unknown> | null)?.error != null;
      return [{ type: 'tool_result', payload: { toolUseId: callId, content, isError } }];
    }

    const name = toolName === 'taskToolCall' ? 'Task' : toolName;
    const input: Record<string, unknown> = { ...args };
    if (toolName === 'taskToolCall') {
      // Web heuristic groups Task / Agent / input.subagent_type. Cursor's Task
      // tool arrives as `taskToolCall` with optional camelCase subagentType.
      const sub = input.subagent_type ?? input.subagentType;
      input.subagent_type = typeof sub === 'string' && sub.trim() ? sub : 'helper';
    }
    const out: PartialEvent[] = [
      { type: 'tool_call', payload: { toolUseId: callId, name, input } },
    ];
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const path = (args.path ?? args.file_path ?? args.filename) as string | undefined;
      if (path) out.push({ type: 'file_change', payload: { path, kind: fileKind(toolName), toolUseId: callId } });
    }
    return out;
  }

  if (type === 'result') {
    const isError = frame.is_error === true;
    const usageFields = usageFromCursorFrame(frame);
    return [{
      type: 'status',
      payload: { status: isError ? 'error' : 'done', ...usageFields },
    }];
  }

  return [];
}
