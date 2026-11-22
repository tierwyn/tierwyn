import type { NormalisedEvent } from '@tierwyn/shared';

// Distributive Omit — preserves the discriminated union so narrowing on
// `partial.type` works. A bare `Omit<Union, K>` collapses the union and
// breaks discriminator narrowing at call sites.
export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

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
 * Flatten a Hermes ACP content value into display text.
 * Hermes wraps tool result content as `Array<{type:"content", content:{type:"text",text}}>`,
 * or as a plain `{type:"text", text}` ContentBlock (for message chunks), or a raw string.
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const c = item as Record<string, unknown>;
        // Outer wrapper: {type:"content", content: ContentBlock}
        if (c.type === 'content' && c.content) return contentText(c.content);
        // Plain ContentBlock: {type:"text", text}
        return contentText(c);
      })
      .filter(Boolean)
      .join('') || JSON.stringify(content);
  }
  if (content == null) return '';
  return contentText(content) || JSON.stringify(content);
}

function fileKind(toolKind: string): 'created' | 'modified' | 'deleted' {
  if (toolKind === 'create') return 'created';
  if (toolKind === 'delete') return 'deleted';
  return 'modified';
}

/**
 * Map one ACP `session/update` payload's `update` object into partial
 * NormalisedEvents. `cost` and `available_commands_update` are intentionally
 * dropped here — the adapter consumes those out-of-band. Defensive: unknown
 * variants fall through to [].
 *
 * Live protocol note: Hermes ACP places `toolCallId`,
 * `kind`, `locations`, `title`, `content`, and `status` directly on the
 * `update` object — NOT nested inside an `update.toolCall` sub-object.
 */
export function mapAcpUpdate(update: Record<string, unknown>): PartialEvent[] {
  const kind = update.sessionUpdate as string | undefined;

  switch (kind) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const chunk = contentText(update.content);
      if (!chunk) return [];
      return [{ type: 'message', payload: { chunk, final: false } }];
    }

    case 'tool_call': {
      const id = String(update.toolCallId ?? '');
      // title is shaped "kind: description" (e.g. "terminal: ls /tmp", "read: /x.ts")
      const name = String(update.title ?? update.toolCallId ?? 'tool');
      const input: Record<string, unknown> = {};
      if (update.content !== undefined) input.content = update.content;
      const out: PartialEvent[] = [{ type: 'tool_call', payload: { toolUseId: id, name, input } }];
      const toolKind = String(update.kind ?? '');
      if (WRITE_KINDS.has(toolKind)) {
        const locations = (update.locations ?? []) as Array<{ path?: string }>;
        for (const loc of locations) {
          if (loc.path) out.push({ type: 'file_change', payload: { path: loc.path, kind: fileKind(toolKind), toolUseId: id } });
        }
      }
      return out;
    }

    case 'tool_call_update': {
      const status = String(update.status ?? '');
      if (status !== 'completed' && status !== 'failed') return [];
      const id = String(update.toolCallId ?? '');
      const content = flattenContent(update.content);
      return [{ type: 'tool_result', payload: { toolUseId: id, content, isError: status === 'failed' } }];
    }

    default:
      return [];
  }
}
