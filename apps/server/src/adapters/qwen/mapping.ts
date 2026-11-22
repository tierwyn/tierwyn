import type { NormalisedEvent } from '@tierwyn/shared';

// Distributive Omit — preserves the discriminated union so narrowing on
// `partial.type` works. A bare `Omit<Union, K>` collapses the union and
// breaks discriminator narrowing at call sites.
export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

export interface QwenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/** ACP ToolCallUpdate.kind values that mutate files. */
const WRITE_KINDS = new Set(['edit', 'write', 'create', 'delete']);

function contentText(content: unknown): string {
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (c.type === 'text') return String(c.text ?? '');
  }
  return '';
}

/**
 * Flatten a Qwen ACP content value into display text.
 * Qwen wraps tool result content as an array of blocks which may be:
 *   - {type:'diff', path, oldText, newText}
 *   - {type:'content', content:{type:'text', text}}
 *   - {type:'text', text}
 *   - a raw string
 * rawOutput is ignored (fileDiff / diffStat — not display text).
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const c = item as Record<string, unknown>;
        if (c.type === 'content' && c.content) return contentText(c.content);
        if (c.type === 'diff') {
          const path = String(c.path ?? '');
          const newText = String(c.newText ?? '');
          return newText || (path ? `(edited ${path})` : '');
        }
        return contentText(c);
      })
      .filter(Boolean);
    return parts.join('') || (content.length ? JSON.stringify(content) : '');
  }
  if (content == null) return '';
  return contentText(content) || JSON.stringify(content);
}

function fileKind(toolKind: string): 'created' | 'modified' | 'deleted' {
  if (toolKind === 'create') return 'created';
  if (toolKind === 'delete') return 'deleted';
  return 'modified';
}

function isEmptyText(v: unknown): boolean {
  return v == null || v === '';
}

function diffKind(oldText: unknown, newText: unknown): 'created' | 'modified' | 'deleted' {
  if (isEmptyText(oldText)) return 'created';
  if (isEmptyText(newText)) return 'deleted';
  return 'modified';
}

function lineCount(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  if (text === '') return 0;
  return text.split('\n').length;
}

// Empty string is 0 lines so a created file with newText:"hello" reports additions:1
// (matches qwen's rawOutput.diffStat.model_added_lines). Non-empty strings keep
// split('\n').length like kiro.
function lineDelta(oldText: unknown, newText: unknown): { additions?: number; deletions?: number } {
  const oldLines = lineCount(oldText);
  const newLines = lineCount(newText);
  if (oldLines === undefined || newLines === undefined) return {};
  return {
    additions: Math.max(0, newLines - oldLines),
    deletions: Math.max(0, oldLines - newLines),
  };
}

function diffFileChanges(content: unknown, toolUseId: string): PartialEvent[] {
  if (!Array.isArray(content)) return [];
  const out: PartialEvent[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (c.type !== 'diff') continue;
    const path = typeof c.path === 'string' ? c.path : '';
    if (!path) continue;
    out.push({
      type: 'file_change',
      payload: {
        path,
        kind: diffKind(c.oldText, c.newText),
        toolUseId,
        ...lineDelta(c.oldText, c.newText),
      },
    });
  }
  return out;
}

function dedupeFileChanges(events: PartialEvent[]): PartialEvent[] {
  const idxByKey = new Map<string, number>();
  const out: PartialEvent[] = [];
  for (const e of events) {
    if (e.type !== 'file_change') {
      out.push(e);
      continue;
    }
    const key = `${e.payload.path}\0${e.payload.kind}`;
    const prevIdx = idxByKey.get(key);
    if (prevIdx === undefined) {
      idxByKey.set(key, out.length);
      out.push(e);
      continue;
    }
    const prev = out[prevIdx] as Extract<PartialEvent, { type: 'file_change' }>;
    if (e.payload.additions !== undefined) prev.payload.additions = e.payload.additions;
    if (e.payload.deletions !== undefined) prev.payload.deletions = e.payload.deletions;
  }
  return out;
}

/**
 * Map one ACP `session/update` payload's `update` object into partial
 * NormalisedEvents. Qwen puts toolCallId / kind / title / content / locations
 * / status directly on `update`, not nested under `update.toolCall`.
 */
export function mapQwenUpdate(update: Record<string, unknown>): PartialEvent[] {
  const kind = update.sessionUpdate as string | undefined;

  switch (kind) {
    case 'agent_message_chunk': {
      const chunk = contentText(update.content);
      if (!chunk) return [];
      return [{ type: 'message', payload: { chunk, final: false } }];
    }

    case 'agent_thought_chunk':
      // v1: drop — qwen streams the entire chain-of-thought token-by-token.
      return [];

    case 'user_message_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'plan':
    case 'usage_update':
      return [];

    case 'tool_call': {
      const id = String(update.toolCallId ?? '');
      const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
      const meta = (update._meta ?? {}) as Record<string, unknown>;
      const name = String(meta.toolName ?? update.title ?? update.toolCallId ?? 'tool');
      const out: PartialEvent[] = [];
      // qwen's pending frame carries rawInput:{} — real args only arrive on the
      // in_progress tool_call_update. Emitting the empty card here would render
      // a `{}` payload in the UI that the later frame can't overwrite (the UI
      // keeps one card per tool_call event). So: only emit when input is known;
      // file_change derivation below still runs either way.
      if (Object.keys(rawInput).length > 0) {
        out.push({ type: 'tool_call', payload: { toolUseId: id, name, input: { ...rawInput } } });
      }
      const toolKind = String(update.kind ?? '');
      if (WRITE_KINDS.has(toolKind)) {
        const locations = (update.locations ?? []) as Array<{ path?: string }>;
        for (const loc of locations) {
          if (loc.path) {
            out.push({ type: 'file_change', payload: { path: loc.path, kind: fileKind(toolKind), toolUseId: id } });
          }
        }
      }
      out.push(...diffFileChanges(update.content, id));
      return dedupeFileChanges(out);
    }

    case 'tool_call_update': {
      const status = String(update.status ?? '');
      const id = String(update.toolCallId ?? '');
      if (status === 'in_progress') {
        // First frame with the real arguments — emit the tool_call card here.
        const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
        const meta = (update._meta ?? {}) as Record<string, unknown>;
        const name = String(meta.toolName ?? update.title ?? id ?? 'tool');
        return [{ type: 'tool_call', payload: { toolUseId: id, name, input: { ...rawInput } } }];
      }
      if (status !== 'completed' && status !== 'failed') return [];
      const content = flattenContent(update.content);
      const out: PartialEvent[] = [
        { type: 'tool_result', payload: { toolUseId: id, content, isError: status === 'failed' } },
      ];
      out.push(...diffFileChanges(update.content, id));
      return dedupeFileChanges(out);
    }

    default:
      return [];
  }
}

/** `_meta.usage` on an agent_message_chunk — last-wins per turn, not summed. */
export function usageFromChunkMeta(update: Record<string, unknown>): QwenUsage | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const usage = (meta as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const out: QwenUsage = {};
  if (typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens)) out.inputTokens = u.inputTokens;
  if (typeof u.outputTokens === 'number' && Number.isFinite(u.outputTokens)) out.outputTokens = u.outputTokens;
  if (typeof u.cachedReadTokens === 'number' && Number.isFinite(u.cachedReadTokens)) {
    out.cacheReadTokens = u.cachedReadTokens;
  }
  return Object.keys(out).length ? out : undefined;
}

/** `usage_update { used, size }` → percent, clamped 0–100. */
export function contextPctFromUsageUpdate(update: Record<string, unknown>): number | undefined {
  const used = update.used;
  const size = update.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return undefined;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  return Math.min(100, Math.max(0, (used / size) * 100));
}
