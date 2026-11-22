import type {
  FileChangeEvent,
  NormalisedEvent,
  PromptEvent,
  StatusEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '@tierwyn/shared';
import { groupIntoTurns, mergeMessageChunks, type PromptTurn } from './groupTurns.js';
import { toolInputFilePath } from './components/ToolInputDisplay.js';
import { resolveFileChangeToolInput, extractDiffPairFromToolInput } from './components/TurnInfoModal.js';
import { computeDiff } from './components/ToolInputDisplay.js';
import { turnElapsedMs, conversationSubagentTotalMs, cumulativeTurnElapsedMs } from './turnElapsed.js';
import { mainAgentEvents } from './subagents.js';

export interface ConversationTurnSummary {
  turnId: string;
  turnIndex: number;
  promptPreview: string;
  elapsedMs: number | null;
  toolCount: number;
  fileCount: number;
  startedAt?: number;
  isActive: boolean;
}

export interface AggregatedToolCall {
  turnIndex: number;
  turnId: string;
  event: ToolCallEvent;
  eventIndex: number;
  toolKey: string;
  result?: ToolResultEvent['payload'];
}

export interface AggregatedFileRow {
  turnIndex: number;
  turnId: string;
  fileKey: string;
  payload: FileChangeEvent['payload'];
  linkedInput?: Record<string, unknown>;
  diffPair: ReturnType<typeof extractDiffPairFromToolInput>;
  additions?: number;
  deletions?: number;
}

export interface ConversationInfoSnapshot {
  turns: PromptTurn[];
  turnSummaries: ConversationTurnSummary[];
  toolCalls: AggregatedToolCall[];
  fileRows: AggregatedFileRow[];
  uniqueFilePaths: string[];
  totalToolCalls: number;
  totalFileChanges: number;
  totalAdditions: number;
  totalDeletions: number;
  totalElapsedMs: number | null;
  subagentTotalMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number | null;
  totalCacheReadTokens: number | null;
  totalCacheCreationTokens: number | null;
  startedAt?: number;
  lastActivityAt?: number;
  activeTurnIndex: number | null;
}

function collectTurnToolData(turn: PromptTurn) {
  const calls: { event: ToolCallEvent; index: number }[] = [];
  const results = new Map<string, ToolResultEvent['payload']>();
  const inputs = new Map<string, Record<string, unknown>>();
  const byPath = new Map<string, Record<string, unknown>>();
  const files: FileChangeEvent['payload'][] = [];

  turn.events.forEach((m, idx) => {
    if (m.event.type === 'tool_call') {
      const tc = m.event as ToolCallEvent;
      calls.push({ event: tc, index: idx });
      const input = (tc.payload.input ?? {}) as Record<string, unknown>;
      if (tc.payload.toolUseId) inputs.set(tc.payload.toolUseId, input);
      const path = toolInputFilePath(input);
      if (path) byPath.set(path, input);
    } else if (m.event.type === 'tool_result') {
      const res = m.event as ToolResultEvent;
      if (res.payload.toolUseId) results.set(res.payload.toolUseId, res.payload);
    } else if (m.event.type === 'file_change') {
      files.push((m.event as FileChangeEvent).payload);
    }
  });

  return { calls, results, inputs, byPath, files };
}

function buildFileRows(
  turnIndex: number,
  turnId: string,
  files: FileChangeEvent['payload'][],
  toolInputByUseId: Map<string, Record<string, unknown>>,
  toolInputByPath: Map<string, Record<string, unknown>>,
): AggregatedFileRow[] {
  return files.map((f, idx) => {
    const linkedInput = resolveFileChangeToolInput(f, toolInputByUseId, toolInputByPath);
    const diffPair = (linkedInput ? extractDiffPairFromToolInput(linkedInput, f.path) : null)
      || (f.diff ? extractDiffPairFromToolInput({ diff: f.diff }, f.path) : null);
    let additions = f.additions;
    let deletions = f.deletions;
    if (diffPair && (additions == null || deletions == null)) {
      const stats = computeDiff(diffPair.before, diffPair.after);
      if (additions == null) additions = stats.addedCount;
      if (deletions == null) deletions = stats.removedCount;
    }
    return {
      turnIndex,
      turnId,
      fileKey: `${turnId}-${f.path}-${idx}`,
      payload: f,
      linkedInput,
      diffPair,
      additions,
      deletions,
    };
  });
}

function sumStatusTotals(events: readonly NormalisedEvent[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let hasCost = false;
  let cacheReadTokens = 0;
  let hasCacheRead = false;
  let cacheCreationTokens = 0;
  let hasCacheCreation = false;
  for (const ev of events) {
    if (ev.type !== 'status') continue;
    const p = (ev as StatusEvent).payload;
    if (p.inputTokens != null) inputTokens += p.inputTokens;
    if (p.outputTokens != null) outputTokens += p.outputTokens;
    if (p.cacheReadTokens != null) {
      cacheReadTokens += p.cacheReadTokens;
      hasCacheRead = true;
    }
    if (p.cacheCreationTokens != null) {
      cacheCreationTokens += p.cacheCreationTokens;
      hasCacheCreation = true;
    }
    if (p.costUsd != null) {
      costUsd += p.costUsd;
      hasCost = true;
    }
  }
  return {
    inputTokens,
    outputTokens,
    costUsd: hasCost ? costUsd : null,
    totalCacheReadTokens: hasCacheRead ? cacheReadTokens : null,
    totalCacheCreationTokens: hasCacheCreation ? cacheCreationTokens : null,
  };
}

export function formatCachedTokens(
  cacheReadTokens?: number | null,
  cacheCreationTokens?: number | null,
): string | null {
  const hasRead = cacheReadTokens != null;
  const hasCreation = cacheCreationTokens != null;
  if (!hasRead && !hasCreation) return null;

  if (hasRead && hasCreation) {
    return `Cache read: ${cacheReadTokens.toLocaleString()} · write: ${cacheCreationTokens.toLocaleString()}`;
  }
  if (hasRead) {
    return `Cache read: ${cacheReadTokens.toLocaleString()}`;
  }
  return `Cache write: ${cacheCreationTokens!.toLocaleString()}`;
}

export function buildConversationInfo(
  events: readonly NormalisedEvent[],
  opts?: {
    forceInterruptedPromptIds?: ReadonlySet<string>;
    isConversationActive?: boolean;
    liveNow?: number;
  },
): ConversationInfoSnapshot {
  const merged = mergeMessageChunks(mainAgentEvents(events));
  const turns = groupIntoTurns(merged, opts?.forceInterruptedPromptIds);
  const liveNow = opts?.liveNow;
  const isActive = !!opts?.isConversationActive;

  const toolCalls: AggregatedToolCall[] = [];
  const fileRows: AggregatedFileRow[] = [];
  const turnSummaries: ConversationTurnSummary[] = [];
  const uniquePaths = new Set<string>();
  let activeTurnIndex: number | null = null;

  turns.forEach((turn, turnIndex) => {
    const { calls, results, inputs, byPath, files } = collectTurnToolData(turn);
    const isTurnActive = isActive && turnIndex === turns.length - 1;
    if (isTurnActive) activeTurnIndex = turnIndex;

    const promptText = (turn.prompt?.event as PromptEvent | undefined)?.payload?.text?.trim() ?? '';
    const promptPreview = promptText
      ? (promptText.length > 120 ? `${promptText.slice(0, 117)}…` : promptText)
      : '(no prompt)';

    turnSummaries.push({
      turnId: turn.id,
      turnIndex,
      promptPreview,
      elapsedMs: turnElapsedMs(turn, isTurnActive ? liveNow : undefined),
      toolCount: calls.length,
      fileCount: files.length,
      startedAt: turn.prompt?.event.ts ?? turn.events[0]?.event.ts,
      isActive: isTurnActive,
    });

    calls.forEach(({ event, index }, i) => {
      const toolUseId = event.payload.toolUseId;
      toolCalls.push({
        turnIndex,
        turnId: turn.id,
        event,
        eventIndex: index,
        toolKey: toolUseId || `${turn.id}-tool-${index}-${i}`,
        result: toolUseId ? results.get(toolUseId) : undefined,
      });
    });

    for (const row of buildFileRows(turnIndex, turn.id, files, inputs, byPath)) {
      fileRows.push(row);
      uniquePaths.add(row.payload.path);
    }
  });

  const totalAdditions = fileRows.reduce((sum, r) => sum + (r.additions || 0), 0);
  const totalDeletions = fileRows.reduce((sum, r) => sum + (r.deletions || 0), 0);
  const tokenTotals = sumStatusTotals(events);

  const startedAt = turnSummaries[0]?.startedAt;
  const lastActivityAt = events.reduce<number | undefined>((latest, ev) => {
    if (!Number.isFinite(ev.ts)) return latest;
    return latest == null ? ev.ts : Math.max(latest, ev.ts);
  }, undefined);

  return {
    turns,
    turnSummaries,
    toolCalls,
    fileRows,
    uniqueFilePaths: [...uniquePaths],
    totalToolCalls: toolCalls.length,
    totalFileChanges: fileRows.length,
    totalAdditions,
    totalDeletions,
    totalElapsedMs: turns.length === 0
      ? null
      : cumulativeTurnElapsedMs(turns, turns.length - 1, isActive ? liveNow : undefined),
    subagentTotalMs: conversationSubagentTotalMs(turns),
    totalInputTokens: tokenTotals.inputTokens,
    totalOutputTokens: tokenTotals.outputTokens,
    totalCostUsd: tokenTotals.costUsd,
    totalCacheReadTokens: tokenTotals.totalCacheReadTokens,
    totalCacheCreationTokens: tokenTotals.totalCacheCreationTokens,
    startedAt,
    lastActivityAt,
    activeTurnIndex,
  };
}
