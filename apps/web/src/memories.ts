import type { MemoryCounts, MemoryFlagCategory, NormalisedEvent } from '@tierwyn/shared';

export function memoryBadgeCount(c: MemoryCounts): number {
  return (c.pendingSuggestions || 0) + (c.flagged || 0);
}

export function recalledChipLabel(ids: string[]): string {
  const n = ids.length;
  if (n === 1) {
    return `Recalled 1 memory: ${ids[0]}`;
  }
  return `Recalled ${n} memories: ${ids.join(', ')}`;
}

export const MEMORY_FLAG_LABELS: Record<MemoryFlagCategory, string> = {
  addressed_to_agents: 'Addressed to agents',
  task_chatter: 'Task chatter',
  secret_like: 'Secret-like',
  irrelevant_recall: 'Irrelevant recall',
};

export function isRecallChipEvent(event: NormalisedEvent): boolean {
  return (
    event.type === 'message' &&
    Array.isArray((event.payload as { recalledMemories?: string[] }).recalledMemories)
  );
}

function isAgentOutput(event: NormalisedEvent): boolean {
  if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'file_change') {
    return true;
  }
  if (event.type === 'message') {
    if (isRecallChipEvent(event)) return false;
    if (event.sender === 'agent') return true;
    const chunk = (event.payload as { chunk?: string }).chunk;
    return typeof chunk === 'string' && chunk.length > 0;
  }
  return false;
}

function extractEvent<T extends NormalisedEvent | { event: NormalisedEvent }>(item: T): NormalisedEvent {
  return 'event' in item ? item.event : (item as NormalisedEvent);
}

export const CONTENT_TYPES = ['message', 'tool_call', 'tool_result', 'file_change'] as const;

export function hasStreamedTurnContent(
  events: ReadonlyArray<NormalisedEvent | { event: NormalisedEvent }>
): boolean {
  return events.some((item) => {
    const ev = extractEvent(item);
    return (CONTENT_TYPES as readonly string[]).includes(ev.type) && !isRecallChipEvent(ev);
  });
}

export function splitTurnRecall<T extends NormalisedEvent | { event: NormalisedEvent }>(
  items: T[],
): { recalled: string[] | undefined; hoistedItem?: T } {
  let recalled: string[] | undefined;
  let hoistedItem: T | undefined;
  let seenAgentOutput = false;

  for (const item of items) {
    const ev = extractEvent(item);
    if (!seenAgentOutput && !recalled && isRecallChipEvent(ev)) {
      const ids = (ev.payload as { recalledMemories?: string[] }).recalledMemories;
      if (ids && ids.length > 0) {
        recalled = ids;
        hoistedItem = item;
        continue;
      }
    }
    if (isAgentOutput(ev)) {
      seenAgentOutput = true;
    }
  }

  return { recalled, hoistedItem };
}

export function shouldShowMemoriesLoading(opts: {
  focusMemory: unknown;
  loading: boolean;
  itemCount: number;
  focusLoading: boolean;
}): boolean {
  return !opts.focusMemory && ((opts.loading && opts.itemCount === 0) || opts.focusLoading);
}

export function shouldRunFocusFetch(
  focusId?: string | null,
  dismissedFocusId?: string | null,
): boolean {
  if (!focusId) return false;
  return focusId !== dismissedFocusId;
}

export function isMemoryNotFound(err: unknown): boolean {
  return (err as any)?.status === 404;
}
