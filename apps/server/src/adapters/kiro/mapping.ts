import type { CommandDescriptor, NormalisedEvent } from '@tierwyn/shared';

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
 * Flatten a Kiro ACP content value into display text.
 * Kiro wraps tool result content as an array of blocks which may be:
 *   - {type:'diff', path, oldText, newText}
 *   - {type:'content', content:{type:'text', text}}
 *   - {type:'text', text}
 *   - a raw string
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

/**
 * Flatten a Kiro `rawOutput` value. Some builtin tools (web_fetch, live probe
 * kiro-cli 2.19.2) deliver results here instead of `content`:
 *   rawOutput: { items: [{ Text: '...' }, ...] }
 * Note the capitalized Rust-style `Text` field.
 */
function flattenRawOutput(rawOutput: unknown): string {
  if (!rawOutput || typeof rawOutput !== 'object') return '';
  const items = (rawOutput as Record<string, unknown>).items;
  if (!Array.isArray(items)) return '';
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (typeof it.Text === 'string' && it.Text) {
      parts.push(it.Text);
      continue;
    }
    const flat = flattenContent(item);
    if (flat) parts.push(flat);
  }
  return parts.join('\n\n');
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

// ponytail: line-count delta, not a real LCS diff. Upgrade to a proper hunk count only if the UI starts showing per-hunk stats.
function lineDelta(oldText: unknown, newText: unknown): { additions?: number; deletions?: number } {
  const oldStr = typeof oldText === 'string' ? oldText : '';
  const newStr = typeof newText === 'string' ? newText : '';
  if (!oldStr && !newStr) return {};
  const newLines = newStr ? newStr.split('\n').length : 0;
  const oldLines = oldStr ? oldStr.split('\n').length : 0;
  return {
    additions: Math.max(0, newLines - oldLines),
    deletions: Math.max(0, oldLines - newLines),
  };
}

export function diffFileChanges(content: unknown, toolUseId: string): PartialEvent[] {
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
    const key = `${e.payload.toolUseId ?? ''}\0${e.payload.path}`;
    const prevIdx = idxByKey.get(key);
    if (prevIdx === undefined) {
      idxByKey.set(key, out.length);
      out.push(e);
      continue;
    }
    // A tool call targeting a file might yield a generic locations-derived event
    // and a richer diff-derived event (or vice-versa). A diff-derived event knows
    // the exact kind (created vs modified vs deleted) and carries line counts.
    // Prefer the more specific kind and graft additions/deletions.
    const prev = out[prevIdx] as Extract<PartialEvent, { type: 'file_change' }>;
    if (prev.payload.kind === 'modified' && (e.payload.kind === 'created' || e.payload.kind === 'deleted')) {
      prev.payload.kind = e.payload.kind;
    }
    if (e.payload.additions !== undefined) prev.payload.additions = e.payload.additions;
    if (e.payload.deletions !== undefined) prev.payload.deletions = e.payload.deletions;
  }
  return out;
}

/**
 * Map one ACP `session/update` payload's `update` object into partial
 * NormalisedEvents. Kiro puts toolCallId / kind / title / content / locations
 * / status directly on `update`, not nested under `update.toolCall`.
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

    case 'user_message_chunk':
    case 'tool_call_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
      return [];

    case 'tool_call': {
      const id = String(update.toolCallId ?? '');
      const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
      const name = String(update.title ?? rawInput.variant ?? update.toolCallId ?? 'tool');
      const input: Record<string, unknown> = { ...rawInput };
      if (update.content !== undefined) input.content = update.content;
      const out: PartialEvent[] = [{ type: 'tool_call', payload: { toolUseId: id, name, input } }];
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
      if (status !== 'completed' && status !== 'failed') return [];
      const id = String(update.toolCallId ?? '');
      // File tools report via `content`; web_fetch & co. report via `rawOutput`.
      const content = flattenContent(update.content) || flattenRawOutput(update.rawOutput);
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

function clampPct(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(100, Math.max(0, n));
}

/**
 * Map `_kiro.dev/*` vendor notifications. Pure — no adapter state.
 * Metadata is accumulated onto the eventual status:done, not emitted mid-turn.
 */
export function mapKiroVendor(
  method: string,
  params: Record<string, unknown>,
): { status?: PartialEvent; commands?: CommandDescriptor[]; contextPct?: number } {
  if (method === '_kiro.dev/metadata') {
    const out: { status?: PartialEvent; contextPct?: number } = {};
    const pct = clampPct(params.contextUsagePercentage);
    if (pct !== undefined) out.contextPct = pct;
    const metering = params.meteringUsage as Record<string, unknown> | undefined;
    // ponytail: credits ≠ USD; the UsagePanel just needs a monotonic per-turn
    // cost signal. Add a unit field to StatusEvent only if a second credit-billed
    // agent shows up.
    if (metering && typeof metering.credits === 'number' && Number.isFinite(metering.credits)) {
      out.status = { type: 'status', payload: { status: 'done', costUsd: metering.credits } };
    }
    return out;
  }

  if (method === '_kiro.dev/commands/available') {
    const raw = Array.isArray(params.commands) ? params.commands : [];
    const commands: CommandDescriptor[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const rawName = typeof rec.name === 'string' ? rec.name : '';
      const name = rawName.replace(/^\//, '');
      if (!name) continue;
      commands.push({
        name,
        label: name,
        description: typeof rec.description === 'string' ? rec.description : '',
        sourceDetail: 'builtin',
      });
    }
    return { commands };
  }

  return {};
}
