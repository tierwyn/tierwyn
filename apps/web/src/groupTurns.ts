import type { NormalisedEvent } from '@tierwyn/shared';

export interface MergedItem {
  event: NormalisedEvent;
  mergedIds?: string[];
}

export interface PromptTurn {
  id: string;
  prompt?: MergedItem;
  events: MergedItem[];
}

/** Stable key for a prompt event — id when present, else ts:session:ts. */
export function promptInterruptKey(ev: Pick<NormalisedEvent, 'id' | 'type' | 'sessionId' | 'ts'>): string | undefined {
  if (ev.type !== 'prompt') return undefined;
  return ev.id ?? `ts:${ev.sessionId}:${ev.ts}`;
}

/** Last prompt in `events` that belongs to `sessionId` (the live interrupted turn). */
export function lastPromptKeyForSession(
  events: ReadonlyArray<Pick<NormalisedEvent, 'id' | 'type' | 'sessionId' | 'ts'>>,
  sessionId: string,
): string | undefined {
  let key: string | undefined;
  for (const ev of events) {
    if (ev.sessionId !== sessionId) continue;
    const k = promptInterruptKey(ev);
    if (k) key = k;
  }
  return key;
}

function turnIsForceInterrupted(
  turn: PromptTurn,
  forceInterruptedPromptIds: ReadonlySet<string> | undefined,
): boolean {
  const pe = turn.prompt?.event;
  if (!pe || !forceInterruptedPromptIds) return false;
  const key = promptInterruptKey(pe);
  if (key && forceInterruptedPromptIds.has(key)) return true;
  return pe.id != null && forceInterruptedPromptIds.has(pe.id);
}

/**
 * Where to paint the ⚡ divider for `turns[idx]`.
 * - `before-prompt`: immediately above this turn's user message (the
 *   Interrupt & Send text). Used when the previous turn was interrupted.
 * - `after-turn`: at the end of this turn, only while it is still the last
 *   turn (the follow-up prompt has not arrived yet).
 */
export function forceInterruptDividerAt(
  turns: readonly PromptTurn[],
  idx: number,
  forceInterruptedPromptIds?: ReadonlySet<string>,
): 'before-prompt' | 'after-turn' | null {
  const turn = turns[idx];
  if (!turn) return null;
  if (idx > 0 && turnIsForceInterrupted(turns[idx - 1]!, forceInterruptedPromptIds)) {
    return 'before-prompt';
  }
  if (turnIsForceInterrupted(turn, forceInterruptedPromptIds) && idx === turns.length - 1) {
    return 'after-turn';
  }
  return null;
}

function eventToolUseId(event: NormalisedEvent): string | undefined {
  if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'file_change') {
    return event.payload.toolUseId;
  }
  return undefined;
}

function eventParentToolUseId(event: NormalisedEvent): string | undefined {
  if (event.type === 'message' || event.type === 'tool_call' || event.type === 'tool_result') {
    return event.payload.parentToolUseId;
  }
  return undefined;
}

function isStatusRunning(event: NormalisedEvent): boolean {
  return event.type === 'status' && event.payload.status === 'running';
}

/**
 * Group merged transcript items into user-prompt turns.
 *
 * Late events from an interrupted turn can arrive *after* the Interrupt &
 * Send prompt is persisted (adapter wind-down). Those must stay with the
 * previous turn so the new user message is not dragged through leftover
 * tool cards:
 *   - tool_result / parented events whose toolUseId was opened earlier
 *   - same-session leftovers that land before the next status:running
 *   - events whose sessionId matches an earlier turn, not the current prompt
 */
export function groupIntoTurns(
  items: MergedItem[],
  forceInterruptedPromptIds?: ReadonlySet<string>,
): PromptTurn[] {
  const turns: PromptTurn[] = [];
  let currentTurn: PromptTurn = { id: 'initial', events: [] };
  const toolOwner = new Map<string, PromptTurn>();
  const sessionOwner = new Map<string, PromptTurn>();
  // After Interrupt & Send, leftovers belong to the interrupted turn until
  // the follow-up emits status:running. Gated on the live interrupt set so
  // ordinary transcripts (no ⚡) keep receive-order grouping.
  let parkInPrevUntilRunning = false;
  let prevTurn: PromptTurn | undefined;

  const rememberOwners = (item: MergedItem, turn: PromptTurn) => {
    const id = eventToolUseId(item.event);
    if (id && item.event.type === 'tool_call') toolOwner.set(id, turn);
    if (turn.prompt?.event.sessionId) sessionOwner.set(turn.prompt.event.sessionId, turn);
  };

  const attach = (item: MergedItem, turn: PromptTurn) => {
    turn.events.push(item);
    rememberOwners(item, turn);
  };

  const resolveTarget = (item: MergedItem): PromptTurn => {
    const ev = item.event;
    const toolId = eventToolUseId(ev);
    if (ev.type === 'tool_result' && toolId && toolOwner.has(toolId)) {
      return toolOwner.get(toolId)!;
    }
    if (toolId && ev.type === 'tool_call' && toolOwner.has(toolId)) {
      return toolOwner.get(toolId)!;
    }
    if (ev.type === 'file_change' && toolId && toolOwner.has(toolId)) {
      return toolOwner.get(toolId)!;
    }
    const parentId = eventParentToolUseId(ev);
    if (parentId && toolOwner.has(parentId)) {
      return toolOwner.get(parentId)!;
    }

    const promptSid = currentTurn.prompt?.event.sessionId;
    if (promptSid && ev.sessionId && ev.sessionId !== promptSid) {
      return sessionOwner.get(ev.sessionId) ?? currentTurn;
    }

    if (parkInPrevUntilRunning && prevTurn && !isStatusRunning(ev)) {
      return prevTurn;
    }
    if (isStatusRunning(ev)) {
      parkInPrevUntilRunning = false;
    }
    return currentTurn;
  };

  for (const item of items) {
    if (item.event.type === 'prompt') {
      if (!currentTurn.prompt && currentTurn.events.length > 0) {
        const isChip = (m: MergedItem) =>
          m.event.type === 'message' &&
          Array.isArray((m.event.payload as { recalledMemories?: string[] })?.recalledMemories);
        const chips = currentTurn.events.filter(isChip);
        const nonChips = currentTurn.events.filter((m) => !isChip(m));
        if (nonChips.length > 0) {
          turns.push({ ...currentTurn, events: nonChips });
          prevTurn = currentTurn;
        }
        currentTurn = {
          id: `turn-${item.event.seq || item.event.ts}`,
          prompt: item,
          events: [...chips],
        };
        sessionOwner.set(item.event.sessionId, currentTurn);
        continue;
      }
      if (currentTurn.prompt || currentTurn.events.length > 0) {
        turns.push(currentTurn);
        prevTurn = currentTurn;
        parkInPrevUntilRunning = turnIsForceInterrupted(currentTurn, forceInterruptedPromptIds);
      }
      currentTurn = {
        id: `turn-${item.event.seq || item.event.ts}`,
        prompt: item,
        events: [],
      };
      sessionOwner.set(item.event.sessionId, currentTurn);
    } else {
      attach(item, resolveTarget(item));
    }
  }

  if (currentTurn.prompt || currentTurn.events.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

/** Rebuild a merged message payload without dropping non-chunk fields (e.g. `files`). */
function mergedMessagePayload(
  last: Extract<NormalisedEvent, { type: 'message' }>,
  chunk: string,
  final: boolean,
  files: NonNullable<Extract<NormalisedEvent, { type: 'message' }>['payload']['files']> | undefined,
): Extract<NormalisedEvent, { type: 'message' }>['payload'] {
  const { chunk: _c, final: _f, files: _files, ...rest } = last.payload;
  return {
    ...rest,
    chunk,
    final,
    ...(files && files.length > 0 ? { files } : {}),
  };
}

export function mergeMessageChunks(events: NormalisedEvent[]): MergedItem[] {
  const result: MergedItem[] = [];
  let currentText = '';
  let lastMsgEvent: Extract<NormalisedEvent, { type: 'message' }> | null = null;
  let currentIds: string[] = [];
  let currentFiles: NonNullable<Extract<NormalisedEvent, { type: 'message' }>['payload']['files']> = [];

  const flush = (final: boolean) => {
    if (!currentText && currentFiles.length === 0) return;
    if (!lastMsgEvent) return;
    result.push({
      event: {
        ...lastMsgEvent,
        payload: mergedMessagePayload(lastMsgEvent, currentText, final, currentFiles),
      },
      mergedIds: [...currentIds],
    });
    currentText = '';
    lastMsgEvent = null;
    currentIds = [];
    currentFiles = [];
  };

  for (const event of events) {
    if (event.type === 'message') {
      // Spawn markers and recall chips carry extra payload fields that must not be lost in
      // the chunk-accumulation merge. Treat them as atomic non-text events.
      if (event.payload.spawnMarker || event.payload.recalledMemories) {
        flush(false);
        result.push({ event, mergedIds: event.id ? [event.id] : [] });
        continue;
      }
      currentText += event.payload.chunk;
      lastMsgEvent = event;
      if (event.payload.files?.length) {
        currentFiles.push(...event.payload.files);
      }
      if (event.id) {
        currentIds.push(event.id);
      }
      if (event.payload.final) {
        flush(true);
      }
    } else {
      flush(false);
      result.push({ event, mergedIds: event.id ? [event.id] : [] });
    }
  }

  flush(false);

  return result;
}

/** Find the 0-based turn index of a prompt event id within a list of turns. Returns -1 if not found. */
export function findTurnIndexByPromptId(turns: readonly PromptTurn[], promptId: string): number {
  return turns.findIndex((t) => t.prompt?.event.id === promptId);
}

/** Recompute the global 0-based turn index of a prompt event id from the full events transcript. Returns -1 if not found. */
export function findGlobalTurnIndexByPromptId(
  events: NormalisedEvent[],
  promptId: string,
  forceInterruptedPromptIds?: ReadonlySet<string>,
): number {
  const turns = groupIntoTurns(mergeMessageChunks(events), forceInterruptedPromptIds);
  return findTurnIndexByPromptId(turns, promptId);
}
