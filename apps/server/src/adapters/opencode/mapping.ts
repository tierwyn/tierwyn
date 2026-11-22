import type { NormalisedEvent } from '@tierwyn/shared';

export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

export type OpenCodeUsage = Partial<
  Pick<
    Extract<NormalisedEvent, { type: 'status' }>['payload'],
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'costUsd'
  >
>;

/** Extract token usage from an opencode finish/step_finish frame. */
export function usageFromOpenCodeFrame(frame: Record<string, unknown>): OpenCodeUsage {
  const part = frame.part as Record<string, unknown> | undefined;
  const usage = (frame.usage ?? part?.usage) as Record<string, unknown> | undefined;
  const tokens = (frame.tokens ?? part?.tokens ?? usage) as Record<string, unknown> | undefined;
  if (!tokens && !usage && part?.cost === undefined && frame.cost === undefined) return {};

  const cache = tokens?.cache as Record<string, unknown> | undefined;
  const inputTokens = (
    tokens?.input ?? tokens?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens
  ) as number | undefined;
  const outputRaw = (
    tokens?.output ?? tokens?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens
  ) as number | undefined;
  const reasoning = tokens?.reasoning as number | undefined;
  const outputTokens = outputRaw !== undefined
    ? outputRaw + (reasoning ?? 0)
    : undefined;
  const cacheReadTokens = (
    cache?.read ?? tokens?.cacheReadTokens ?? usage?.cacheReadTokens ?? usage?.cache_read_tokens
  ) as number | undefined;
  const cacheCreationTokens = (
    cache?.write ?? tokens?.cacheWriteTokens ?? usage?.cacheWriteTokens ??
    usage?.cache_write_tokens ?? usage?.cacheCreationTokens ?? usage?.cache_creation_tokens
  ) as number | undefined;
  const costUsd = (part?.cost ?? frame.cost ?? usage?.cost ?? usage?.costUsd) as number | undefined;

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

// OpenCode file-mutating tool names (best-effort; extend as the binary evolves).
const OPENCODE_FILE_TOOLS = new Set(['write', 'edit', 'create', 'str_replace', 'apply_patch', 'Write', 'Edit']);

function fileChangeFromTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  toolUseId?: string,
): PartialEvent | null {
  if (!OPENCODE_FILE_TOOLS.has(toolName) || !args) return null;
  // kilo tool inputs use camelCase (filePath, oldString, newString); opencode
  // and most other agents use path / file_path / filename.
  const path = (args.path ?? args.file_path ?? args.filePath ?? args.filename) as string | undefined;
  if (!path) return null;
  const kind = toolName === 'write' || toolName === 'create' || toolName === 'Write' ? 'created' : 'modified';
  return { type: 'file_change', payload: { path, kind, ...(toolUseId ? { toolUseId } : {}) } };
}

/**
 * Map a single NDJSON frame emitted by `opencode run --format json` into zero or
 * more partial NormalisedEvents (no sessionId/seq/ts — those are filled by the adapter).
 *
 * Be defensive: every field access uses `?? ''` / optional chaining so unknown
 * or malformed frames always fall through to the default `[]` return.
 */
export function mapOpenCodeEvent(frame: Record<string, unknown>): PartialEvent[] {
  const type = frame.type as string | undefined;
  const part = frame.part as Record<string, unknown> | undefined;
  const partType = part?.type as string | undefined;

  // ── text ─────────────────────────────────────────────────────────────────
  // Primary check: top-level type 'text' OR part.type 'text'
  if (type === 'text' || partType === 'text') {
    const chunk = String(part?.text ?? frame.text ?? '');
    return [{ type: 'message', payload: { chunk, final: false } }];
  }

  // ── step_start / step_finish ──────────────────────────────────────────────
  // Step boundaries within a multi-step turn do NOT end the turn; the adapter
  // accumulates token usage across steps and emits status:done when the full
  // session finishes (or the subprocess closes).
  if (
    type === 'step_start' ||
    partType === 'step-start' ||
    type === 'step_finish' ||
    partType === 'step-finish'
  ) {
    return [];
  }

  // ── tool call / tool result ───────────────────────────────────────────────
  // opencode emits part.type containing 'tool' for tool invocations.
  // Two state shapes seen:
  //   opencode: part.state === 'result' | 'error'  (string)
  //   kilo:     part.state === { status: 'completed'|'error', input, output }  (object)
  // A frame is a result when state is the literal 'result'/'error' OR
  // state.status is 'completed'/'error' (kilo only emits one completed frame
  // per tool, so we surface that as the result and skip emitting a tool_call
  // for it).
  if (partType !== undefined && partType.includes('tool')) {
    const state = part?.state as string | Record<string, unknown> | undefined;
    const stateIsStr = typeof state === 'string';
    const stateStatus = !stateIsStr && state && typeof state === 'object'
      ? (state as Record<string, unknown>).status as string | undefined
      : undefined;
    const isResult = (stateIsStr && (state === 'result' || state === 'error'))
      || (stateStatus === 'completed' || stateStatus === 'error');
    if (isResult) {
      const toolUseId = String(part?.callID ?? part?.id ?? frame.callID ?? '');
      const output = (stateIsStr ? part?.output : (state as Record<string, unknown>)?.output) as unknown;
      const content =
        typeof output === 'string'
          ? output
          : output != null
            ? JSON.stringify(output)
            : '';
      const resultEvent: PartialEvent = {
        type: 'tool_result',
        payload: {
          toolUseId,
          content,
          isError: stateIsStr ? state === 'error' : stateStatus === 'error',
        },
      };
      // kilo emits ONE frame per tool (status='completed' with both input and
      // output). opencode emits separate call/result frames. For kilo, also
      // emit the matching tool_call so the renderer has the call+input before
      // the result; otherwise the result appears orphaned with no tool name.
      if (!stateIsStr) {
        const toolName = String(part?.tool ?? part?.name ?? frame.tool ?? '');
        const rawInput = ((state as Record<string, unknown>).input ?? part?.input ?? {}) as Record<string, unknown>;
        const input: Record<string, unknown> = typeof rawInput === 'object' && rawInput !== null ? rawInput : {};
        const out: PartialEvent[] = [
          { type: 'tool_call', payload: { toolUseId, name: toolName, input } },
          resultEvent,
        ];
        const fc = fileChangeFromTool(toolName, input, toolUseId);
        if (fc) out.push(fc);
        return out;
      }
      return [resultEvent];
    }

    // Tool call (invocation)
    const toolName = String(part?.tool ?? part?.name ?? frame.tool ?? '');
    const callID = String(part?.callID ?? part?.id ?? frame.callID ?? '');
    const rawInput = (
      part?.input
      ?? part?.args
      ?? frame.input
      ?? (!stateIsStr && state ? (state as Record<string, unknown>).input : {})
      ?? {}
    ) as Record<string, unknown>;
    const input: Record<string, unknown> = typeof rawInput === 'object' && rawInput !== null ? rawInput : {};

    const out: PartialEvent[] = [
      { type: 'tool_call', payload: { toolUseId: callID, name: toolName, input } },
    ];
    const fc = fileChangeFromTool(toolName, input, callID);
    if (fc) out.push(fc);
    return out;
  }

  // ── finish / done ─────────────────────────────────────────────────────────
  if (
    type === 'finish' ||
    type === 'session_done' ||
    partType === 'finish'
  ) {
    const usageFields = usageFromOpenCodeFrame(frame);
    return [{ type: 'status', payload: { status: 'done', ...usageFields } }];
  }

  // ── fallthrough ───────────────────────────────────────────────────────────
  return [];
}
