import type { NormalisedEvent } from '@tierwyn/shared';

export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

export type UsagePartial = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
};

// ponytail: tool names unverified against dsh's built-in plugin set. Confirm with
// a live `write`/`edit` turn and correct; a wrong name only costs the file-change
// chip, never correctness of the tool_call/tool_result pair.
const DSH_FILE_TOOLS = new Set(['write', 'edit', 'create', 'str_replace', 'apply_patch']);

function fileChangeFromTool(toolName: string, args: Record<string, unknown> | undefined): PartialEvent | null {
  if (!DSH_FILE_TOOLS.has(toolName) || !args) return null;
  const path = (args.path ?? args.file_path ?? args.filename) as string | undefined;
  if (!path) return null;
  const kind = toolName === 'write' || toolName === 'create' ? 'created' : 'modified';
  return { type: 'file_change', payload: { path, kind } };
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { raw };
  } catch {
    return { raw };
  }
}

/**
 * SessionEvent on the SDK wire is `{ type, seq, time, data }`.
 * Flattened fixtures (and a hypothetical older runtime) put fields on `event`.
 */
export function sessionEventData(event: Record<string, unknown>): Record<string, unknown> {
  const data = event.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return event;
}

function joinContent(content: unknown, opts?: { excludeReasoning?: boolean }): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object') {
        const block = b as { type?: unknown; text?: unknown };
        if (opts?.excludeReasoning && block.type !== undefined && block.type !== 'text') return '';
        if ('text' in block) return String(block.text ?? '');
      }
      return '';
    }).join('');
  }
  return String(content ?? '');
}

/** Map one StreamChunk from an 'assistant/chunk' event. */
export function mapStreamChunk(chunk: Record<string, unknown>): PartialEvent[] {
  switch (chunk.type) {
    case 'text-delta':
      return [{ type: 'message', payload: { chunk: String(chunk.text ?? ''), final: false } }];
    case 'reasoning-delta':
      // ponytail: dropped. deepseek-reasoner streams the full chain-of-thought and
      // it would bury the answer in the transcript (same call qwen/kimi/codex made).
      // To surface it, return the same shape as text-delta — one line.
      return [];
    case 'tool-call-delta':
      return [];
    case 'usage':
    case 'finish':
    case 'block-start':
    case 'block-end':
      return [];
    default:
      return [];
  }
}

function toolResultFromEvent(event: Record<string, unknown>): PartialEvent[] {
  const msg = (event.message && typeof event.message === 'object')
    ? event.message as Record<string, unknown>
    : undefined;
  const source = (msg?.source && typeof msg.source === 'object')
    ? msg.source as Record<string, unknown>
    : undefined;
  const block = Array.isArray(msg?.content) && msg.content[0] && typeof msg.content[0] === 'object'
    ? msg.content[0] as Record<string, unknown>
    : undefined;

  const callId = String(event.callId ?? source?.callId ?? block?.toolCallId ?? '');
  const rawContent = event.content
    ?? (block && Array.isArray(block.content) ? block.content : undefined)
    ?? msg?.content;
  const isError = Boolean(event.isError ?? event.error ?? block?.isError);

  return [{
    type: 'tool_result',
    payload: { toolUseId: callId, content: joinContent(rawContent), isError },
  }];
}

/** Map one `session.event` params.event into normalised partials. */
export function mapDeepSeekEvent(
  event: Record<string, unknown>,
  opts?: { streamedText?: boolean },
): PartialEvent[] {
  const data = sessionEventData(event);
  switch (event.type) {
    case 'turn/start':
      return [{ type: 'status', payload: { status: 'running' } }];

    case 'assistant/chunk': {
      const chunk = (data.chunk && typeof data.chunk === 'object')
        ? data.chunk as Record<string, unknown>
        : data;
      return mapStreamChunk(chunk);
    }

    case 'assistant/message': {
      // When the reply streamed via text-delta chunks the terminator stays
      // empty so the client does not print the text twice. Some responses
      // arrive with no chunk stream at all (non-streamed / replayed provider
      // replies) — the complete message content is then the only copy of the
      // answer, so emit it instead of dropping it.
      if (opts?.streamedText) {
        return [{ type: 'message', payload: { chunk: '', final: true } }];
      }
      const msg = (data.message && typeof data.message === 'object')
        ? data.message as Record<string, unknown>
        : undefined;
      const text = joinContent(msg?.content ?? data.content, { excludeReasoning: true });
      return [{ type: 'message', payload: { chunk: text, final: true } }];
    }

    case 'tool/call': {
      const name = String(data.name ?? '');
      const input = parseToolArguments(data.arguments);
      const out: PartialEvent[] = [
        { type: 'tool_call', payload: { toolUseId: String(data.callId ?? ''), name, input } },
      ];
      const fc = fileChangeFromTool(name, input);
      if (fc) out.push(fc);
      return out;
    }

    case 'tool/result':
      return toolResultFromEvent(data);

    case 'turn/end': {
      const reason = data.reason;
      if (reason && typeof reason === 'object' && !Array.isArray(reason)) {
        const r = reason as { kind?: unknown; error?: { message?: unknown } };
        if (r.kind === 'error') {
          return [{ type: 'error', payload: { message: String(r.error?.message ?? 'dsh turn ended with error') } }];
        }
      }
      return [];
    }

    case 'error':
      return [{ type: 'error', payload: { message: String(event.message ?? event.error ?? data.message ?? 'dsh error') } }];

    default:
      return [];
  }
}

/** Usage extractor — returns the status-payload subset, or {} when absent. */
export function usageFromEvent(usage: Record<string, unknown> | undefined): UsagePartial {
  if (!usage) return {};
  const out: UsagePartial = {};
  if (typeof usage.inputTokens === 'number') out.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === 'number') out.outputTokens = usage.outputTokens;
  const cache = usage.cacheReadTokens ?? usage.cachedTokens;
  if (typeof cache === 'number') out.cacheReadTokens = cache;
  return out;
}
