import type { NormalisedEvent } from '@tierwyn/shared';

// Distributive Omit — preserves the discriminated union so narrowing on
// `partial.type` works. A bare `Omit<Union, K>` collapses the union and
// breaks discriminator narrowing at call sites.
export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

/** Per-turn memo of the `tool_call` frame's bare tool name + kind, keyed by
 *  toolCallId. Kimi's tool_call_update carries a *verbose* title
 *  ("Writing /tmp/x.txt") and may omit `kind`, so the card name and the
 *  write/read decision must come from the opening frame. Owned and cleared
 *  per turn by KimiAdapter. */
export interface ToolMeta { name?: string; kind?: string }

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
 * Flatten a Kimi ACP content value into display text.
 * Blocks may be:
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

function hasDiffEvidence(payload: { additions?: number; deletions?: number }): boolean {
  return payload.additions !== undefined || payload.deletions !== undefined;
}

function dedupeFileChanges(events: PartialEvent[]): PartialEvent[] {
  const idxByPath = new Map<string, number>();
  const out: PartialEvent[] = [];
  for (const e of events) {
    if (e.type !== 'file_change') {
      out.push(e);
      continue;
    }
    const prevIdx = idxByPath.get(e.payload.path);
    if (prevIdx === undefined) {
      idxByPath.set(e.payload.path, out.length);
      out.push(e);
      continue;
    }
    const prev = out[prevIdx] as Extract<PartialEvent, { type: 'file_change' }>;
    // Prefer the diff-derived kind (old/new text evidence → additions/deletions)
    // over the locations-derived kind (a coarse tool category, often 'edit').
    if (hasDiffEvidence(e.payload)) {
      prev.payload.kind = e.payload.kind;
      if (e.payload.additions !== undefined) prev.payload.additions = e.payload.additions;
      if (e.payload.deletions !== undefined) prev.payload.deletions = e.payload.deletions;
    }
  }
  return out;
}

function messageFromContent(update: Record<string, unknown>): PartialEvent[] {
  const chunk = contentText(update.content);
  if (!chunk) return [];
  return [{ type: 'message', payload: { chunk, final: false } }];
}

function locationFileChanges(
  update: Record<string, unknown>,
  kind: string,
  id: string,
): PartialEvent[] {
  if (!WRITE_KINDS.has(kind)) return [];
  const out: PartialEvent[] = [];
  const locations = (update.locations ?? []) as Array<{ path?: string }>;
  for (const loc of locations) {
    if (loc.path) {
      out.push({ type: 'file_change', payload: { path: loc.path, kind: fileKind(kind), toolUseId: id } });
    }
  }
  return out;
}

/**
 * Map one ACP `session/update` payload's `update` object into partial
 * NormalisedEvents. Kimi puts toolCallId / kind / title / content / locations
 * / status directly on `update`, not nested under `update.toolCall`.
 */
export function mapKimiUpdate(
  update: Record<string, unknown>,
  toolMeta: Map<string, ToolMeta>,
): PartialEvent[] {
  const kind = update.sessionUpdate as string | undefined;

  switch (kind) {
    case 'agent_message_chunk':
      return messageFromContent(update);

    case 'agent_thought_chunk':
      // Kept (unlike qwen): Kimi defaults to thinking:high and its reasoning
      // is the useful part of a turn. A thought-only turn still counts as
      // real output for _sawMessageChunk.
      return messageFromContent(update);

    case 'user_message_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
    case 'plan':
      return [];

    case 'tool_call': {
      const id = String(update.toolCallId ?? '');
      const title = String(update.title ?? '');
      const toolKind = String(update.kind ?? '');
      toolMeta.set(id, { name: title || undefined, kind: toolKind || undefined });
      const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
      const meta = (update._meta ?? {}) as Record<string, unknown>;
      const name = String(meta.toolName || title || id || 'tool');
      const out: PartialEvent[] = [];
      // Kimi's pending frame carries no real args. Emitting an empty card
      // here would render a `{}` payload the later frame can't overwrite
      // (the UI keeps one card per tool_call event). A completed tool with
      // no in_progress card then emits an orphan tool_result — benign.
      if (Object.keys(rawInput).length > 0) {
        out.push({ type: 'tool_call', payload: { toolUseId: id, name, input: { ...rawInput } } });
      }
      out.push(...locationFileChanges(update, toolKind, id));
      out.push(...diffFileChanges(update.content, id));
      return dedupeFileChanges(out);
    }

    case 'tool_call_update': {
      const status = String(update.status ?? '');
      const id = String(update.toolCallId ?? '');
      const memo = toolMeta.get(id) ?? {};
      // Prefer the update's kind, then the opening-frame memo. Do NOT default
      // to 'modified' — a missing kind on a Read/Grep update would mark
      // every target as an edit.
      const toolKind = String(update.kind ?? memo.kind ?? '');
      if (status === 'in_progress') {
        const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
        const name = memo.name ?? String(update.title ?? id);
        const out: PartialEvent[] = [
          { type: 'tool_call', payload: { toolUseId: id, name, input: { ...rawInput } } },
        ];
        out.push(...locationFileChanges(update, toolKind, id));
        return dedupeFileChanges(out);
      }
      if (status !== 'completed' && status !== 'failed') return [];
      const content = flattenContent(update.content);
      const out: PartialEvent[] = [
        { type: 'tool_result', payload: { toolUseId: id, content, isError: status === 'failed' } },
      ];
      out.push(...locationFileChanges(update, toolKind, id));
      out.push(...diffFileChanges(update.content, id));
      return dedupeFileChanges(out);
    }

    default:
      return [];
  }
}

/** `usage_update { used, size }` → percent, clamped 0–100. */
export function contextPctFromUsageUpdate(update: Record<string, unknown>): number | undefined {
  const used = update.used;
  const size = update.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return undefined;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  return Math.min(100, Math.max(0, (used / size) * 100));
}
