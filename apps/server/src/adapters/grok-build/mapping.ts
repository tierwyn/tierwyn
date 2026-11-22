import type { NormalisedEvent } from '@tierwyn/shared';

// Distributive Omit — preserves the discriminated union so narrowing on
// `partial.type` works. A bare `Omit<Union, K>` collapses the union and
// breaks discriminator narrowing at call sites.
export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

/** ACP ToolCallUpdate.kind values that mutate files (CONFIRMED Phase 0). */
const WRITE_KINDS = new Set(['edit', 'write', 'create', 'delete']);

/**
 * Grok Build harness tool titles that mutate files. Live ACP often omits
 * `kind` / `locations` for these; path lives on rawInput (`file_path`).
 */
const WRITE_TOOL_NAMES = new Set([
  'search_replace',
  'write',
  'write_file',
  'edit',
  'strreplace',
  'apply_patch',
  'delete',
  'delete_file',
]);

function contentText(content: unknown): string {
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (c.type === 'text') return String(c.text ?? '');
  }
  return '';
}

/**
 * Flatten a Grok ACP content value into display text.
 * Grok wraps tool result content as an array of blocks which may be:
 *   - {type:'diff', path, oldText, newText}            (tool_call_update)
 *   - {type:'content', content:{type:'text', text}}     (nested, hermes-style)
 *   - {type:'text', text}                               (plain ContentBlock)
 *   - a raw string
 * For text rendering we concatenate any text blocks; for diff blocks we fall
 * back to the file path (the tool_result card already shows the change).
 */
export function flattenContent(content: unknown): string {
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

function fileKindFromToolName(name: string): 'created' | 'modified' | 'deleted' | null {
  const n = name.toLowerCase();
  if (!WRITE_TOOL_NAMES.has(n)) return null;
  if (n === 'write' || n === 'write_file') return 'created';
  if (n === 'delete' || n === 'delete_file') return 'deleted';
  return 'modified';
}

function pathFromToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'target_file', 'TargetFile', 'filename']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Map one ACP `session/update` payload's `update` object into partial
 * NormalisedEvents. `cost`, `available_commands_update`, `model_changed`,
 * `pending_interaction`, `interaction_resolved` and `user_message_chunk` are
 * intentionally dropped here — the adapter consumes the commands out-of-band,
 * the user_message_chunk is the echoed operator prompt (don't re-render it),
 * and the interaction variants are handled via the server-request path.
 * Defensive: unknown variants fall through to [].
 *
 * Live protocol note (CONFIRMED Phase 0, acp-permission.jsonl lines 79/81/87):
 * Grok ACP places `toolCallId`, `kind`, `locations`, `title`, `content`,
 * `status`, and `rawInput` directly on the `update` object — NOT nested inside
 * an `update.toolCall` sub-object. Identical to Hermes.
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
      // Grok's title is the tool name (e.g. "write", "read", "terminal").
      const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
      const name = String(update.title ?? rawInput.variant ?? update.toolCallId ?? 'tool');
      const input: Record<string, unknown> = { ...rawInput };
      if (update.content !== undefined) input.content = update.content;
      // Path B: web groups Task/Agent/subagent_type. Grok's spawn_subagent
      // omits the field (default general-purpose), so inject it here.
      if (name === 'spawn_subagent' && typeof input.subagent_type !== 'string') {
        input.subagent_type = 'general-purpose';
      }
      const out: PartialEvent[] = [{ type: 'tool_call', payload: { toolUseId: id, name, input } }];
      const seenPaths = new Set<string>();
      const pushFileChange = (path: string, kind: 'created' | 'modified' | 'deleted') => {
        if (seenPaths.has(path)) return;
        seenPaths.add(path);
        out.push({ type: 'file_change', payload: { path, kind, toolUseId: id } });
      };
      const toolKind = String(update.kind ?? '');
      if (WRITE_KINDS.has(toolKind)) {
        const locations = (update.locations ?? []) as Array<{ path?: string }>;
        for (const loc of locations) {
          if (loc.path) pushFileChange(loc.path, fileKind(toolKind));
        }
      }
      // Harness tools (search_replace / write) often omit ACP kind+locations.
      const nameKind = fileKindFromToolName(name);
      const inputPath = pathFromToolInput(input);
      if (nameKind && inputPath) pushFileChange(inputPath, nameKind);
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
