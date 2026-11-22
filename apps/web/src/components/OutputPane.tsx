import { copyText } from '../clipboard';
import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, memo, Fragment } from 'react';
import { formatElapsedMs, type NormalisedEvent, type PromptAttachment, type Handoff, type VoiceTtsSettings, type Checkpoint } from '@tierwyn/shared';
import { EventItem } from './EventItem.js';
import { FileModal } from './FileModal.js';
import { FilePreviewStrip } from './FilePreviewStrip.js';
import { ImageAnnotator } from './ImageAnnotator.js';
import { MarkdownBody } from './MarkdownBody.js';
import { TurnInfoModal } from './TurnInfoModal.js';
import { OpenFileContext } from '../OpenFileContext.js';
import { handoffMismatchHint } from './HandoffSummaryModal.js';
import { fileUrl } from '../api.js';
import {
  collectMessageChunksFromIndex,
  joinSpeakChunks,
  playWithMode,
  spawnResultSpeakText,
  speakChunks,
  type SpeakMeta,
  type SpeakMode,
  type SpeakScopeItem,
  ttsSupported,
} from '../speak.js';
import type { TtsRecordingSource } from '@tierwyn/shared';
import { SpeakChoiceModal } from './SpeakChoiceModal.js';
import { SpeakScopeModal, type SpeakScope } from './SpeakScopeModal.js';
import { TtsSpeakIcon } from './TtsSpeakIcon.js';
import {
  forceInterruptDividerAt,
  groupIntoTurns,
  mergeMessageChunks,
  type MergedItem,
  type PromptTurn,
} from '../groupTurns.js';
import { findOccurrences, findTargets, helperFocusById, nextIndex, pickFlashDomId, resolveFocusTarget, type FindMode, type FindOptions } from '../transcriptFind.js';
import { applyTranscriptHighlights, clearTranscriptHighlights, scrollRangeIntoPane, supportsCssHighlights } from '../domHighlight.js';
import { TranscriptFindBar } from './TranscriptFindBar.js';
import { shouldShowPendingShimmer } from '../pendingShimmer.js';
import {
  conversationSubagentTotalMs,
  cumulativeTurnElapsedMs,
  cumulativeTurnWaitingMs,
  turnElapsedMs,
  turnWaitingMs,
  turnSubagentElapsedMs,
  WAITING_DISPLAY_THRESHOLD_MS,
} from '../turnElapsed.js';
import { shouldPinOnContentResize } from '../transcriptScroll.js';
import { answeredInteractionRequestIds } from '../interactionResolve.js';
import { useSubtreeTime } from '../useSubtreeTime.js';
import { SubagentStatsModal } from './SubagentStatsModal.js';
import { RecalledMemoriesChip } from './RecalledMemoriesChip.js';
import { splitTurnRecall, hasStreamedTurnContent } from '../memories.js';
import { mainAgentEvents, type HelperRun } from '../subagents.js';

export interface TerminalSpawnInfo {
  durationMs?: number;
  endedAt: number;
  kind: string;
}

/** Operator `!` commands only. Agent CLIs (agy `run_command`, etc.) stay generic tool cards. */
function isShellToolName(name?: string): boolean {
  return name === 'shell';
}

function shellCommandFromInput(input?: Record<string, unknown>): string {
  if (!input) return '';
  const v = input.command;
  return v == null ? '' : String(v);
}

interface Props {
  events: NormalisedEvent[];
  agentStatus: string;
  /** In-flight session for this conversation (ws currentSessionId). */
  liveSessionId?: string | null;
  profileLabels?: Record<string, string>;
  allCollapsed?: boolean;
  onDeleteEvent?: (id: string | string[]) => void;
  /** When true, the trailing-suffix "Delete Conversation From This Point"
   *  button offers a Transcript+session option that fork-truncates the native
   *  session via rewind (reusing the existing rewind machinery, no checkpoint).
   *  Gated at App level on a v1-capable agent type AND a native session existing. */
  nativeSyncAvailable?: boolean;
  /** Fork-truncate the native session to keep events up to and including
   *  `anchorEventId`, then refetch. Anchor is the last surviving event of the
   *  turn BEFORE the one being deleted (rewind truncates strictly after anchor). */
  onDeleteFromPointNative?: (anchorEventId: string) => void;
  /** v2: surgically remove ONE turn from both the transcript and the native
   *  session (parentUuid rewired so the result is resumable). `turnIndex` is
   *  0-indexed over turns[] (the client's view); the route converts to the
   *  1-indexed helper counting. `eventIds` is the exact set of event ids that
   *  make up the turn (prompt + reply + any tool events). Gated at App level
   *  on a v2-capable agent type AND a native session existing — same gate as
   *  nativeSyncAvailable. */
  onDeleteOneNative?: (turnIndex: number, eventIds: string[], promptEventId?: string) => Promise<void> | void;
  autoScroll?: boolean;
  /** Active conversation id; forwarded to FileModal for relative-path resolution. */
  conversationId?: string;
  /** Active project — durable TTS even when conversation id is missing. */
  projectId?: string;
  lastResolveIndexByRequestId?: Map<string, number>;
  onRespond?: (requestId: string, sessionId: string, selection: string[], text?: string, answers?: { selection: string[]; text?: string }[]) => void;
  hideToolCalls?: boolean;
  onForkConversation?: (eventId: string) => void;
  onRepeatQuestion?: (text: string, eventIdsToDelete: string[], attachments?: PromptAttachment[]) => void;
  /** Map of event id → injected summary text, keyed by the last event a summary covered. */
  summaryByEventId?: Record<string, string>;
  /** Map of anchor event id → handoff row for cross-adapter switches. */
  handoffByAnchorId?: Record<string, Handoff>;
  /** Map of event id → checkpoint for inline transcript markers. */
  checkpointByEventId?: Record<string, Checkpoint>;
  /** Open the handoff summary modal with optional handoff metadata. */
  onViewSummary?: (text: string, handoff?: Handoff) => void;
  /** Open a memory in the Memories modal */
  onOpenMemory?: (id: string) => void;
  /** Open another conversation (used by spawn breadcrumb markers). */
  onOpenConversation?: (conversationId: string) => void;
  /** Pre-fill the input bar with the sub-agent's result text so the user
   *  can review/edit it before sending it to the parent agent. */
  onInjectText?: (text: string) => void;
  /** While a transcript fetch is in flight; suppresses the empty state so
   *  long conversations don't flash "empty" before events land. */
  isLoading?: boolean;
  /** Prompt event ids (or ts:session:ts fallback keys) of turns interrupted
   *  via Interrupt & Send this page session. Divider renders above the
   *  follow-up user message, not at the tail of that turn's tool stream. */
  forceInterruptedPromptIds?: ReadonlySet<string>;
  /** When set, images in the FileModal get an "Annotate" button; on save the
   *  rendered PNG is appended to the input bar as a new attachment. */
  onAddAttachment?: (att: { base64: string; mediaType: string; name: string }) => void;
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
  /** Settings → General → Enable file edits. Forwarded to FileModal. */
  fileEditsEnabled?: boolean;
  onCycleTtsProvider?: () => void;
  /** FW-12: events.id of a content-search hit to scroll to + flash, set by App
   *  immediately after the transcript lands. Consume-once via onFocusConsumed. */
  focusEventId?: string | null;
  /** Optional search string to pre-fill and open the Ctrl-F find bar when jumping via focusEventId. */
  focusQuery?: string | null;
  onFocusConsumed?: () => void;
  /** FW-12 follow-up: increment from the ⋮ menu to open the find bar (mobile has
   *  no Ctrl/Cmd+F). 0 is ignored so mount does not pop the bar. */
  findOpenTick?: number;
  /** Open sidebar navigation when in empty/no-selection state. */
  onOpenSidebar?: () => void;
  /** When true, older turns exist on the server. Shows "Load earlier messages" button at top. */
  hasMore?: boolean;
  /** Triggered when the operator requests the next older page of messages. */
  onLoadEarlier?: () => void;
  /** Triggered when the operator clicks "Load all" history. */
  onLoadAll?: () => void;
  /** True while older page request is in flight. */
  loadingEarlier?: boolean;
  /** True while full transcript request is in flight. */
  loadingAll?: boolean;
  /** Set when the conversation runs on a remote host; labels the file-modal chip. */
  remoteHostName?: string;
  activeConversationIds?: readonly string[];
  helpersByToolUseId?: ReadonlyMap<string, HelperRun>;
  onOpenHelper?: (key: string, highlightQuery?: string) => void;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return `${date} at ${time}`;
}

export function formatAgentHeader(label: string): string {
  // Support different kinds of dots used in profile labels (middle dot, bullet, etc.)
  const parts = label.split(/\s*[·•·]\s*/);
  if (parts.length >= 2) return `Agent: ${parts[0]} - Model: ${parts.slice(1).join(' · ')}`;
  if (label.includes(':')) {
    const colonParts = label.split(':');
    return `Agent: ${colonParts[0]} - Model: ${colonParts.slice(1).join(':')}`;
  }
  return `Agent: ${label}`;
}

export function splitAgentModel(label: string): { agent: string; model?: string } {
  if (!label) return { agent: '' };
  const matchAgentModel = /^Agent:\s*(.*?)\s*-\s*Model:\s*(.*)$/i.exec(label);
  if (matchAgentModel) {
    return { agent: matchAgentModel[1].trim(), model: matchAgentModel[2].trim() };
  }
  const parts = label.split(/\s*[·•·]\s*/);
  if (parts.length >= 2) {
    return { agent: parts[0].trim(), model: parts.slice(1).join(' · ').trim() };
  }
  if (label.includes(':')) {
    const colonParts = label.split(':');
    return { agent: colonParts[0].trim(), model: colonParts.slice(1).join(':').trim() };
  }
  return { agent: label.trim() };
}

export function AgentModelBadge({
  label,
  fallback = 'Agent Executions',
  className = '',
}: {
  label: string;
  fallback?: string;
  className?: string;
}) {
  const { agent, model } = splitAgentModel(label);
  if (!agent) return <span className={className}>{fallback}</span>;
  return (
    <span className={`agent-model-badge ${className}`.trim()}>
      <span className="agent-name">{agent}</span>
      {model && (
        <>
          <span className="agent-model-sep" aria-hidden>·</span>
          <span className="model-name">{model}</span>
        </>
      )}
    </span>
  );
}

/** Hide the response-header agent badge when the user echo already has Sent to. */
export function showTurnResponseAgentLabel(opts: {
  isHandoff: boolean;
  hasUserPrompt: boolean;
  hasRecipientLabel: boolean;
}): boolean {
  if (opts.isHandoff) return true;
  if (opts.hasUserPrompt && opts.hasRecipientLabel) return false;
  return true;
}

/** Determine whether the turn has any non-empty prose message or non-heartbeat spawn card. */
export function hasTurnVisibleMessageOrCard(
  events: readonly MergedItem[],
  getEditedText?: (eventKey: string) => string | undefined
): boolean {
  return events.some((m) => {
    if (m.event.type !== 'message') return false;
    const sm = (m.event.payload as { spawnMarker?: { kind?: string } })?.spawnMarker;
    if (sm) return sm.kind !== 'heartbeat';
    const eventKey = `event-${m.event.seq || m.event.ts}`;
    const edited = getEditedText?.(eventKey);
    const chunk = edited !== undefined ? edited : (m.event.payload as { chunk?: string })?.chunk;
    return typeof chunk === 'string' && chunk.trim().length > 0;
  });
}

/** Determine whether the turn contains any tool events (calls, results, or file changes). */
export function hasTurnTools(events: readonly MergedItem[]): boolean {
  return events.some(
    (m) =>
      m.event.type === 'tool_call' ||
      m.event.type === 'tool_result' ||
      m.event.type === 'file_change'
  );
}

/** Check if the response section has any visible body content (message, spawn card, or visible tools). */
export function hasTurnVisibleBody(opts: {
  hasVisibleMessageOrCard: boolean;
  hasTools: boolean;
  hideToolCalls: boolean;
}): boolean {
  if (opts.hasVisibleMessageOrCard) return true;
  return opts.hasTools && !opts.hideToolCalls;
}

/** Last-turn memo: only stream tokens force a re-render. An idle last turn
 *  with a large markdown image must not remount on every App heartbeat. */
export function lastTurnMustRerender(opts: { isLastTurn: boolean; agentStatus: string }): boolean {
  if (!opts.isLastTurn) return false;
  return opts.agentStatus === 'running' || opts.agentStatus === 'waiting';
}

function TurnElapsedText({
  turnMs,
  cumulativeMs,
  subagentMs,
  waitingMs,
}: {
  turnMs: number | null;
  cumulativeMs: number | null;
  subagentMs?: number | null;
  waitingMs?: number | null;
}) {
  if (turnMs == null && cumulativeMs == null) return null;
  return (
    <span className="turn-footer-elapsed" title="Turn duration">
      {turnMs != null && (
        <>
          Took {formatElapsedMs(turnMs)}
          {subagentMs != null && (
            <span className="turn-footer-subagents" title="Subagent wall-clock that finished in this turn (runs in parallel with the turn)">
              {' '}(subagents {formatElapsedMs(subagentMs)})
            </span>
          )}
        </>
      )}
      {waitingMs != null && waitingMs >= 1000 && (
        <span className="conversation-elapsed-waiting" title="Time a question/approval card waited on you (not counted in the turn time)">
          {' · '}Waited on you {formatElapsedMs(waitingMs)}
        </span>
      )}
      {cumulativeMs != null && (
        <span className="turn-footer-cumulative" title="Total elapsed across all turns so far">
          {turnMs != null ? ' · ' : ''}Total {formatElapsedMs(cumulativeMs)}
        </span>
      )}
    </span>
  );
}

export function TurnLiveTimer({
  turn,
  previousCumulativeMs = 0,
}: {
  turn: PromptTurn;
  previousCumulativeMs?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Pauses while a question/approval card is unresolved.
  const elapsedMs = turnElapsedMs(turn, now);
  if (elapsedMs == null) return null;
  return (
    <TurnElapsedText
      turnMs={elapsedMs}
      waitingMs={turnWaitingMs(turn, now)}
      cumulativeMs={previousCumulativeMs + elapsedMs}
    />
  );
}



/** Pull the agent profile id from a turn's events (first event carrying one).
 *  Used to detect when consecutive turns ran under different agents. */
function turnProfileId(turn: PromptTurn): string | undefined {
  return turn.events.find((m) => m.event.agentProfileId)?.event.agentProfileId
    ?? turn.prompt?.event.agentProfileId;
}

export function OutputPane({
  events,
  agentStatus,
  liveSessionId,
  profileLabels,
  allCollapsed = false,
  onDeleteEvent,
  nativeSyncAvailable = false,
  onDeleteFromPointNative,
  onDeleteOneNative,
  autoScroll = true,
  conversationId,
  projectId,
  lastResolveIndexByRequestId,
  onRespond,
  hideToolCalls = false,
  onForkConversation,
  onRepeatQuestion,
  summaryByEventId,
  handoffByAnchorId,
  checkpointByEventId,
  onViewSummary,
  onOpenMemory,
  onOpenConversation,
  onInjectText,
  isLoading = false,
  forceInterruptedPromptIds,
  onAddAttachment,
  tts,
  ttsSummarizeAvailable = false,
  fileEditsEnabled = false,
  onCycleTtsProvider,
  focusEventId,
  focusQuery,
  onFocusConsumed,
  findOpenTick = 0,
  onOpenSidebar,
  hasMore = false,
  onLoadEarlier,
  onLoadAll,
  loadingEarlier = false,
  loadingAll = false,
  remoteHostName,
  activeConversationIds,
  helpersByToolUseId,
  onOpenHelper,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollPaneRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const prevAgentStatusRef = useRef(agentStatus);

  const prependAnchorRef = useRef<{
    turnId: string;
    topBefore: number;
    until: number;
  } | null>(null);
  // Suppress auto-scroll-to-bottom (fresh-load timers + ResizeObserver sticky window)
  // while jumping to a search-matched event via focusEventId.
  const focusGuardUntilRef = useRef<number>(0);

  const handleLoadEarlier = useCallback(() => {
    const pane = scrollPaneRef.current;
    if (pane) {
      const firstTurnEl = pane.querySelector<HTMLElement>('[data-turn-id]');
      if (firstTurnEl) {
        const turnId = firstTurnEl.getAttribute('data-turn-id') || firstTurnEl.id;
        const paneTop = pane.getBoundingClientRect().top;
        const elTop = firstTurnEl.getBoundingClientRect().top;
        prependAnchorRef.current = {
          turnId,
          topBefore: elTop - paneTop,
          until: Date.now() + 1500,
        };
      }
    }
    onLoadEarlier?.();
  }, [onLoadEarlier]);

  const handleLoadAll = useCallback(() => {
    const pane = scrollPaneRef.current;
    if (pane) {
      const firstTurnEl = pane.querySelector<HTMLElement>('[data-turn-id]');
      if (firstTurnEl) {
        const turnId = firstTurnEl.getAttribute('data-turn-id') || firstTurnEl.id;
        const paneTop = pane.getBoundingClientRect().top;
        const elTop = firstTurnEl.getBoundingClientRect().top;
        prependAnchorRef.current = {
          turnId,
          topBefore: elTop - paneTop,
          until: Date.now() + 1500,
        };
      }
    }
    onLoadAll?.();
  }, [onLoadAll]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    const pane = scrollPaneRef.current;
    if (!pane) return;
    const el = pane.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.turnId)}"], #${CSS.escape(anchor.turnId)}`);
    if (el) {
      const paneTop = pane.getBoundingClientRect().top;
      const topNow = el.getBoundingClientRect().top - paneTop;
      const diff = topNow - anchor.topBefore;
      if (Math.abs(diff) > 0.5) {
        pane.scrollTop += diff;
      }
    }
  }, [events]);
  const [collapsedTurns, setCollapsedTurns] = useState<Record<string, boolean>>({});
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // Per-message-chunk edit overrides, keyed by `event-${seq|ts}`. Persisted
  // across renders because mergeMessageChunks rebuilds message event objects
  // (and their payloads) on every render, so mutating payload.chunk directly
  // is thrown away on the next pass.
  const [editedChunks, setEditedChunks] = useState<Record<string, string>>({});
  const [forceToolsState, setForceToolsState] = useState<Record<string, 'expand' | 'collapse' | null>>({});
  const [lightbox, setLightbox] = useState<PromptAttachment | null>(null);
  // File-modal path (image/markdown from agent output or preview strip).
  // Separate from `lightbox` because prompt-attachment thumbnails use base64
  // and don't go through the /files endpoint.
  const [openFile, setOpenFile] = useState<{ path: string; gallery?: string[]; displayName?: string } | null>(null);
  const handleOpenFile = useCallback((path: string, gallery?: string[], displayName?: string) => {
    setOpenFile({ path, gallery, displayName });
  }, []);
  const onOpenFile = handleOpenFile;

  // FW-12 find-in-transcript. Occurrence-level matches over prompt + message text.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIdx, setFindIdx] = useState(0);
  const [findMode, setFindMode] = useState<FindMode>('substring');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findJumpTick, setFindJumpTick] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const lastFindScrollTick = useRef(-1);
  const useCssHighlights = useMemo(() => supportsCssHighlights(), []);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [turnToolsExpanded, setTurnToolsExpanded] = useState<Record<string, boolean>>({});

  // Drop per-turn tool expand state on conversation switch so a prior
  // "Expand all tools" cannot force-full-render poison tool_results in the next chat.
  useEffect(() => {
    setTurnToolsExpanded({});
    setForceToolsState({});
  }, [conversationId]);
  const [deleteConfirmEventId, setDeleteConfirmEventId] = useState<string | string[] | null>(null);
  const [deleteTurnIndex, setDeleteTurnIndex] = useState<number | null>(null);
  /** Sub-step of the trailing-suffix delete modal: when the user picks
   *  "Delete Conversation From This Point" and native-sync is available, we
   *  show a Transcript-only vs Transcript+session choice before executing.
   *  Holds the anchor event id (last surviving event of the previous turn). */
  // v2: when the user picks a scope (suffix | single) from the Delete Message
  // modal, we route them through a second scope sub-modal that ALWAYS renders.
  // nativeSyncAvailable → offer transcript+session vs transcript-only.
  // Otherwise → prominent "session deletion not supported for this agent" notice
  // + transcript-only + Cancel (replaces v1's silent suppression). For the suffix
  // flow on the FIRST turn we cannot fork (nothing to keep) — native-sync is
  // disabled there too, so the notice is shown.
  const [deleteScopeChoice, setDeleteScopeChoice] = useState<'suffix' | 'single' | null>(null);

  const [repeatConfirmTurnIndex, setRepeatConfirmTurnIndex] = useState<number | null>(null);
  // ponytail: holds the FileModal image currently being annotated; null = editor closed
  const [annotateTarget, setAnnotateTarget] = useState<{ src: string; mediaType: string; name: string } | null>(null);

  // Clicked "Annotate" on a transcript file: fetch bytes → data URL → open editor.
  const handleAnnotateFile = useCallback(async (path: string) => {
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
    const mediaType = ext === 'png' ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : ext === 'bmp' ? 'image/bmp'
      : 'image/png';
    try {
      const r = await fetch(fileUrl(path, conversationId), { credentials: 'include' });
      if (!r.ok) throw new Error(`fetch -> ${r.status}`);
      const blob = await r.blob();
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] ?? '';
        setAnnotateTarget({ src: `data:${mediaType};base64,${base64}`, mediaType, name: path.split('/').pop() ?? 'image' });
      };
      reader.readAsDataURL(blob);
    } catch (e) {
      console.warn('annotate fetch failed', e);
    }
  }, [conversationId]);

  const toggleTools = (turnId: string) => {
    const nextState = !turnToolsExpanded[turnId];
    setTurnToolsExpanded(prev => ({ ...prev, [turnId]: nextState }));
    setForceToolsState(prev => ({ ...prev, [turnId]: nextState ? 'expand' : 'collapse' }));
    setTimeout(() => {
      setForceToolsState(prev => ({ ...prev, [turnId]: null }));
    }, 100);
  };

  const handlePrintTurn = (turnId: string) => {
    document.body.classList.add('printing-specific-turn');
    const turnEl = document.getElementById(turnId);
    if (turnEl) {
      turnEl.classList.add('printing-this');
    }
    window.print();
    document.body.classList.remove('printing-specific-turn');
    if (turnEl) {
      turnEl.classList.remove('printing-this');
    }
  };

  const handlePrintTurnTextOnly = (turnId: string) => {
    document.body.classList.add('printing-specific-turn');
    if (hideToolCalls) {
      document.body.classList.add('printing-prompt-and-response-only');
    }
    const turnEl = document.getElementById(turnId);
    if (turnEl) {
      turnEl.classList.add('printing-this');
    }
    window.print();
    document.body.classList.remove('printing-specific-turn');
    document.body.classList.remove('printing-prompt-and-response-only');
    if (turnEl) {
      turnEl.classList.remove('printing-this');
    }
  };

  const handlePrintEvent = (turnId: string, eventIdOrKey: string) => {
    document.body.classList.add('printing-specific-turn');
    document.body.classList.add('printing-specific-event');
    const turnEl = document.getElementById(turnId);
    const eventEl = document.getElementById(eventIdOrKey) || document.getElementById(`${turnId}-${eventIdOrKey}`);
    if (turnEl && eventEl) {
      turnEl.classList.add('printing-this-parent');
      eventEl.classList.add('printing-this');
    }
    void document.body.offsetHeight;
    window.print();
    document.body.classList.remove('printing-specific-turn');
    document.body.classList.remove('printing-specific-event');
    if (turnEl && eventEl) {
      turnEl.classList.remove('printing-this-parent');
      eventEl.classList.remove('printing-this');
    }
  };

  const handleDeleteEvent = (eventId: string | string[] | undefined) => {
    if (!eventId) return;
    setDeleteConfirmEventId(eventId);
  };

  const closeLightbox = useCallback(() => setLightbox(null), []);

  const prevEventsLengthRef = useRef(events.length);
  const prevConversationIdRef = useRef(conversationId);
  const prevIsLoadingRef = useRef(isLoading);
  const isInitialMountRef = useRef(true);

  // ponytail: mergeMessageChunks + groupIntoTurns are O(L) and ran on every
  // render (every streamed token). Memoise on [events] so only a new frame
  // pays the cost. lastEvent is the global streaming target (see TurnBlock).
  const { turns, lastEvent } = useMemo(() => {
    // Helper snapshots are dropped too: a trailing one would otherwise become
    // lastEvent (stealing the streaming cursor / fork target).
    const merged = mergeMessageChunks(mainAgentEvents(events));
    return { turns: groupIntoTurns(merged, forceInterruptedPromptIds), lastEvent: merged[merged.length - 1]?.event };
  }, [events, forceInterruptedPromptIds]);

  const helperById = useMemo(() => helperFocusById(events), [events]);

  const eventIndexByRef = useMemo(() => {
    const m = new Map<NormalisedEvent, number>();
    for (let i = 0; i < events.length; i++) m.set(events[i]!, i);
    return m;
  }, [events]);

  const answeredRequestIds = useMemo(() => answeredInteractionRequestIds(events), [events]);

  const previousCumulativeByIndex = useMemo(() => {
    const out: number[] = [];
    let sum = 0;
    for (const t of turns) {
      out.push(sum);
      const ms = turnElapsedMs(t);
      if (ms != null) sum += ms;
    }
    return out;
  }, [turns]);
  const conversationTotalMs = useMemo(
    () => (turns.length === 0 ? null : cumulativeTurnElapsedMs(turns, turns.length - 1)),
    [turns],
  );
  const conversationWaitingMs = useMemo(
    () => (turns.length === 0 ? null : cumulativeTurnWaitingMs(turns, turns.length - 1)),
    [turns],
  );
  const conversationSubagentMs = useMemo(() => conversationSubagentTotalMs(turns), [turns]);
  const lastTurnActive = agentStatus === 'running' || agentStatus === 'waiting';
  const { summary: subtreeSummary, runningCount: subtreeRunningCount } = useSubtreeTime(
    conversationId,
    !lastTurnActive,
    activeConversationIds ?? [],
  );
  // Paged transcript: older turns aren't loaded, so the client sum undercounts. The server
  // summary scans every session with the same worked-time rule; use it as the floor.
  const unloadedSelfMs = subtreeSummary && conversationTotalMs != null
    ? Math.max(0, subtreeSummary.selfMs - conversationTotalMs)
    : 0;
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const activeIdsSet = useMemo(() => new Set(activeConversationIds ?? []), [activeConversationIds]);

  const findOpts = useMemo<FindOptions>(
    () => ({ mode: findMode, caseSensitive: findCaseSensitive }),
    [findMode, findCaseSensitive],
  );
  // Only indexed while the bar is open — a closed find bar costs nothing during streaming.
  const findResults = useMemo(
    () => (findOpen ? findOccurrences(turns, findQuery, editedChunks, findOpts) : []),
    [findOpen, turns, findQuery, editedChunks, findOpts],
  );
  const clampedFindIdx = findResults.length === 0 ? 0 : (findIdx >= findResults.length ? 0 : findIdx);
  const activeOccurrence = findResults[clampedFindIdx] ?? null;

  // Stable across streaming tokens so memoized prior turns don't re-render until
  // a child actually finishes (result/stalled). Spawned cards live in earlier turns.
  const terminalSpawnMap = useMemo(() => {
    const map = new Map<string, TerminalSpawnInfo>();
    for (const e of events) {
      if (e.type !== 'message') continue;
      const sm = e.payload.spawnMarker;
      if ((sm?.kind === 'result' || sm?.kind === 'stalled' || sm?.kind === 'denied' || sm?.kind === 'expired' || sm?.kind === 'stopped') && sm.childConversationId) {
        map.set(sm.childConversationId, { durationMs: sm.durationMs, endedAt: e.ts, kind: sm.kind });
      }
    }
    return map;
  }, [events]);
  const terminalSpawnKey = useMemo(() => {
    const parts: string[] = [];
    for (const [id, info] of terminalSpawnMap) {
      parts.push(`${id}:${info.kind}:${info.durationMs ?? info.endedAt}`);
    }
    return parts.sort().join(',');
  }, [terminalSpawnMap]);

  // Flat speak-scope index across all turns (prompt then events per turn).
  // Ref so memoized prior TurnBlocks always read the latest transcript when
  // the user picks “from here to end”.
  // Speak-scope id is sessionId-scoped: seq is per-session and collides across sessions (transcriptFind.ts adversary B1).
  type SpeakScopeFlatItem = SpeakScopeItem & { id: string };
  const speakScopeItemsRef = useRef<SpeakScopeFlatItem[]>([]);
  speakScopeItemsRef.current = (() => {
    const items: SpeakScopeFlatItem[] = [];
    for (const turn of turns) {
      // User / parent_message prompts are speakable. subagent_notify is hidden
      // in the UI — Result card is the source of truth (do not double-count).
      if (turn.prompt?.event.type === 'prompt') {
        const p = turn.prompt.event;
        const source = p.payload.source;
        if (source !== 'subagent_notify') {
          const text = typeof p.payload.text === 'string' ? p.payload.text : '';
          items.push({
            type: 'prompt',
            chunk: text,
            role: 'user',
            id: `${p.sessionId}:${p.seq || p.ts}`,
          });
        }
      }
      for (const m of turn.events) {
        const seqOrTs = m.event.seq || m.event.ts;
        const id = `${m.event.sessionId}:${seqOrTs}`;
        const sm =
          m.event.type === 'message' ? m.event.payload.spawnMarker : undefined;
        if (sm) {
          // Only result markers are speakable; other spawn kinds are index
          // placeholders so “to end” can start mid-stream without shifting ids.
          if (sm.kind === 'result') {
            items.push({
              type: 'message',
              chunk: spawnResultSpeakText(sm.text ?? ''),
              isSpawnMarker: true,
              spawnKind: 'result',
              role: 'subagent',
              id,
            });
          } else {
            items.push({
              type: 'message',
              chunk: '',
              isSpawnMarker: true,
              spawnKind: sm.kind,
              id,
            });
          }
          continue;
        }
        let chunk = '';
        if (m.event.type === 'message') {
          if ((m.event.payload as { recalledMemories?: string[] })?.recalledMemories) {
            continue;
          }
          // Keys may be `event-${seqOrTs}` (getChunkText) or `gN-${seqOrTs}` (renderItem).
          const direct = editedChunks[`event-${seqOrTs}`];
          if (direct !== undefined) {
            chunk = direct;
          } else {
            let fromGroup: string | undefined;
            for (const [k, v] of Object.entries(editedChunks)) {
              if (k.endsWith(`-${seqOrTs}`)) {
                fromGroup = v;
                break;
              }
            }
            chunk = fromGroup !== undefined ? fromGroup : m.event.payload.chunk;
          }
        }
        items.push({
          type: m.event.type,
          chunk,
          role: m.event.type === 'message' ? 'agent' : undefined,
          id,
        });
      }
    }
    return items;
  })();

  const getSpeakTailForId = useCallback((id: string): string => {
    const items = speakScopeItemsRef.current;
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return '';
    return joinSpeakChunks(collectMessageChunksFromIndex(items, idx));
  }, []);

  // v2: hoisted helpers for the unified scope sub-modal. Defined here (after
  // `turns` is computed) and not as an IIFE inside JSX, because TSX chokes on
  // `&& (() => { ... return <div/> })()` — the closing braces of inner
  // ternaries get misread as JSX expression terminators.
  const closeDeleteScope = () => { setDeleteScopeChoice(null); setDeleteTurnIndex(null); };
  const computeSuffixIds = useCallback((fromIdx: number): string[] => {
    const ids: string[] = [];
    for (let i = fromIdx; i < turns.length; i++) {
      const t = turns[i];
      if (t.prompt?.event.id) ids.push(t.prompt.event.id);
      for (const m of t.events) {
        if (m.mergedIds && m.mergedIds.length > 0) ids.push(...m.mergedIds);
        else if (m.event.id) ids.push(m.event.id);
      }
    }
    return ids;
  }, [turns]);
  const computeSingleIds = useCallback((idx: number): string[] => {
    const ids: string[] = [];
    const t = turns[idx];
    if (!t) return ids;
    if (t.prompt?.event.id) ids.push(t.prompt.event.id);
    for (const m of t.events) {
      if (m.mergedIds && m.mergedIds.length > 0) ids.push(...m.mergedIds);
      else if (m.event.id) ids.push(m.event.id);
    }
    return ids;
  }, [turns]);

  // v2: derived values + handlers for the unified scope sub-modal. Only
  // meaningful while deleteScopeChoice !== null. nativeSyncAvailable gates the
  // transcript+session button; otherwise an explicit "not supported" notice
  // is shown (replaces v1's silent suppression).
  const deleteScopeIsSuffix = deleteScopeChoice === 'suffix';
  const deleteScopeCanNativeSync = deleteTurnIndex !== null && (
    deleteScopeIsSuffix
      ? !!nativeSyncAvailable && !!onDeleteFromPointNative && deleteTurnIndex > 0
      : !!nativeSyncAvailable && !!onDeleteOneNative && turns.length > 1
  );
  const handleDeleteScopeNative = () => {
    if (deleteTurnIndex === null) return;
    if (deleteScopeIsSuffix) {
      const prevTurn = turns[deleteTurnIndex - 1];
      let anchorEventId: string | undefined;
      if (prevTurn) {
        const lastMsg = prevTurn.events[prevTurn.events.length - 1];
        if (lastMsg) {
          anchorEventId = (lastMsg.mergedIds && lastMsg.mergedIds.length > 0
            ? lastMsg.mergedIds[lastMsg.mergedIds.length - 1]
            : lastMsg.event.id) ?? undefined;
        }
        if (!anchorEventId) anchorEventId = prevTurn.prompt?.event.id ?? undefined;
      }
      if (anchorEventId) onDeleteFromPointNative?.(anchorEventId);
    } else {
      const ids = computeSingleIds(deleteTurnIndex);
      const turn = turns[deleteTurnIndex];
      const promptEventId = turn?.prompt?.event.id;
      if (ids.length > 0) void onDeleteOneNative?.(deleteTurnIndex, ids, promptEventId);
    }
    closeDeleteScope();
  };
  const handleDeleteScopeTranscriptOnly = () => {
    if (deleteTurnIndex === null) return;
    const ids = deleteScopeIsSuffix
      ? computeSuffixIds(deleteTurnIndex)
      : computeSingleIds(deleteTurnIndex);
    if (ids.length > 0) onDeleteEvent?.(ids);
    closeDeleteScope();
  };

  useEffect(() => {
    const pane = scrollPaneRef.current;
    if (!pane) return;

    const isConversationSwitch = prevConversationIdRef.current !== conversationId;
    prevConversationIdRef.current = conversationId;
    if (isConversationSwitch) {
      prependAnchorRef.current = null;
      if (!focusEventId) {
        focusGuardUntilRef.current = 0;
      }
    }

    const wasLoading = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;
    const justFinishedLoading = wasLoading && !isLoading;

    const prevLen = prevEventsLengthRef.current;
    const is0ToN = prevLen === 0 && events.length > 0;
    prevEventsLengthRef.current = events.length;

    const isFreshLoad = isInitialMountRef.current || isConversationSwitch || (justFinishedLoading && events.length > 0) || is0ToN;
    isInitialMountRef.current = false;

    const now = Date.now();
    if (focusEventId) {
      focusGuardUntilRef.current = Math.max(focusGuardUntilRef.current, now + 1200);
    }
    const isFocusActive = Boolean(focusEventId) || now < focusGuardUntilRef.current;

    if (isFreshLoad) {
      if (isFocusActive) return;

      pane.scrollTop = pane.scrollHeight;

      let count = 0;
      const followUp = () => {
        if (Date.now() < focusGuardUntilRef.current) return;
        if (pane) pane.scrollTop = pane.scrollHeight;
        if (++count < 6) requestAnimationFrame(followUp);
      };
      requestAnimationFrame(followUp);

      const t1 = setTimeout(() => { if (pane && Date.now() >= focusGuardUntilRef.current) pane.scrollTop = pane.scrollHeight; }, 60);
      const t2 = setTimeout(() => { if (pane && Date.now() >= focusGuardUntilRef.current) pane.scrollTop = pane.scrollHeight; }, 180);
      const t3 = setTimeout(() => { if (pane && Date.now() >= focusGuardUntilRef.current) pane.scrollTop = pane.scrollHeight; }, 350);

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    }

    if (!autoScroll || isFocusActive) return;
    const isPrependActive = prependAnchorRef.current !== null && now < prependAnchorRef.current.until;
    if (isPrependActive) return;

    const isNewEventAdded = events.length > prevLen;
    const justFinishedTurn = prevAgentStatusRef.current === 'running' && agentStatus !== 'running';
    prevAgentStatusRef.current = agentStatus;
    if (isNewEventAdded || agentStatus === 'running' || justFinishedTurn) {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        if (pane && Date.now() >= focusGuardUntilRef.current) pane.scrollTop = pane.scrollHeight;
      });
    }
  }, [events, conversationId, isLoading, autoScroll, agentStatus, focusEventId]);

  // Synchronously pin scroll position to bottom during active running/streaming so text flow never jitters:
  useLayoutEffect(() => {
    if (!autoScroll || agentStatus !== 'running') return;
    const now = Date.now();
    if (focusEventId || now < focusGuardUntilRef.current) return;
    const isPrependActive = prependAnchorRef.current !== null && now < prependAnchorRef.current.until;
    if (isPrependActive) return;
    const pane = scrollPaneRef.current;
    if (pane) {
      pane.scrollTop = pane.scrollHeight;
    }
  }, [events, autoScroll, agentStatus, focusEventId]);

  // Watch the inner content (not the pane) for height growth: images, math,
  // highlight. Observing the pane itself + setting scrollTop fights the
  // scrollbar and oscillates on image-heavy turns.
  useEffect(() => {
    const pane = scrollPaneRef.current;
    const inner = pane?.firstElementChild;
    if (!pane || !inner || typeof ResizeObserver === 'undefined') return;

    let stickyUntil = Date.now() + 600;
    let lastHeight = inner.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      const heightGrew = h > lastHeight + 1;
      lastHeight = h;

      const now = Date.now();
      const anchor = prependAnchorRef.current;
      const isPrependActive = anchor !== null && now < anchor.until;

      if (isPrependActive && anchor) {
        const el = pane.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.turnId)}"], #${CSS.escape(anchor.turnId)}`);
        if (el) {
          const paneTop = pane.getBoundingClientRect().top;
          const topNow = el.getBoundingClientRect().top - paneTop;
          const diff = topNow - anchor.topBefore;
          if (Math.abs(diff) > 0.5) {
            pane.scrollTop += diff;
          }
        }
        return;
      }

      if (now < focusGuardUntilRef.current) return;

      if (!shouldPinOnContentResize({
        now,
        stickyUntil,
        autoScroll,
        agentStatus,
        heightGrew,
        prependGuard: isPrependActive,
      })) return;
      pane.scrollTop = pane.scrollHeight;
    });
    observer.observe(inner);

    return () => observer.disconnect();
  }, [conversationId, autoScroll, agentStatus]);

  /** Scroll a card into view and flash it. Falls back to the enclosing turn when the
   *  card itself is not in the DOM (collapsed turn, hideToolCalls, not yet mounted)
   *  OR when the card id is duplicated (B1: `event-${seq}` is per-session). */
  const flashTarget = useCallback((target: { domId: string; turnId: string }) => {
    const cardCount = document.querySelectorAll(`[id="${target.domId}"]`).length;
    const el = document.getElementById(pickFlashDomId(target, cardCount));
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('transcript-flash');
    // ponytail: plain timeout instead of an animationend listener — the class is
    // cosmetic and a missed removal costs nothing.
    setTimeout(() => el.classList.remove('transcript-flash'), 1500);
  }, []);

  // Reset in-conversation find bar whenever switching conversations so a find bar
  // opened by a prior search jump never bleeds into the next conversation.
  useEffect(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindIdx(0);
    clearTranscriptHighlights();
  }, [conversationId]);

  // FW-12: jump to the event a content-search hit pointed at. Declared AFTER the
  // autoscroll effect so it wins the frame on a fresh load. Consumed inside the rAF
  // (not before) so the parent's state flip cannot cancel the scroll.
  useEffect(() => {
    if (!focusEventId) return;
    focusGuardUntilRef.current = Math.max(focusGuardUntilRef.current, Date.now() + 1200);
    if (isLoading) return;
    const target = resolveFocusTarget(turns, focusEventId, helperById);
    const helperRef = helperById.get(focusEventId);
    const trimmedFocusQuery = focusQuery?.trim() ?? '';
    const raf = requestAnimationFrame(() => {
      if (helperRef) {
        const helperKey = (helperRef.toolUseId ? helpersByToolUseId?.get(helperRef.toolUseId)?.key : undefined)
          ?? helperRef.taskId
          ?? helperRef.toolUseId;
        if (helperKey) {
          onOpenHelper?.(helperKey, trimmedFocusQuery || undefined);
        }
      } else if (trimmedFocusQuery) {
        setFindQuery(trimmedFocusQuery);
        setFindOpen(true);
        if (target) {
          const occs = findOccurrences(turns, trimmedFocusQuery, editedChunks, findOpts);
          const matchIdx = occs.findIndex((o) => o.turnId === target.turnId);
          if (matchIdx >= 0) setFindIdx(matchIdx);
        }
      }
      if (target) {
        focusGuardUntilRef.current = Math.max(focusGuardUntilRef.current, Date.now() + 1200);
        flashTarget(target);
      }
      onFocusConsumed?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusEventId, focusQuery, isLoading, turns, helperById, helpersByToolUseId, onOpenHelper, editedChunks, findOpts, flashTarget, onFocusConsumed]);

  const jumpToOccurrence = useCallback((index: number) => {
    const occ = findResults[index];
    if (!occ) return;
    const collapsed = collapsedTurns[occ.turnId] ?? allCollapsed;
    if (collapsed) {
      setCollapsedTurns((prev) => ({ ...prev, [occ.turnId]: false }));
    }
    setFindIdx(index);
    setFindJumpTick((t) => t + 1);
  }, [findResults, collapsedTurns, allCollapsed]);

  const goToMatch = useCallback((dir: 1 | -1) => {
    if (findResults.length === 0) return;
    jumpToOccurrence(nextIndex(clampedFindIdx, findResults.length, dir));
  }, [findResults.length, clampedFindIdx, jumpToOccurrence]);

  const closeFindBar = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindIdx(0);
    clearTranscriptHighlights();
    onFocusConsumed?.();
  }, [onFocusConsumed]);

  const openFindBar = useCallback(() => {
    setFindOpen(true);
    // Focus after the bar mounts.
    setTimeout(() => { findInputRef.current?.focus(); findInputRef.current?.select(); }, 0);
  }, []);

  // Ctrl/Cmd+F opens the transcript find bar. OutputPane is only mounted in the
  // conversation view, so no extra "is the transcript active" check is needed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return;
      if (e.shiftKey || e.altKey) return;
      // ponytail: a modal owns the keyboard — let the browser's own find open.
      // Class probe rather than a modal registry; every modal shares .modal-overlay.
      if (document.querySelector('.modal-overlay')) return;
      e.preventDefault();
      openFindBar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openFindBar]);

  // ⋮ menu "Find in transcript" (mobile — no Ctrl/Cmd+F). Tick 0 is the mount default.
  useEffect(() => {
    if (!findOpenTick) return;
    openFindBar();
  }, [findOpenTick, openFindBar]);

  // Retyping restarts at the first match, like the browser's own find.
  useEffect(() => {
    if (!findOpen) return;
    setFindIdx(0);
    const first = findResults[0];
    if (first && (collapsedTurns[first.turnId] ?? allCollapsed)) {
      setCollapsedTurns((prev) => ({ ...prev, [first.turnId]: false }));
    }
    setFindJumpTick((t) => t + 1);
    // findResults identity changes with the transcript too; keying on the query text
    // keeps streaming tokens from re-jumping the operator mid-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, findOpen, findMode, findCaseSensitive]);

  useEffect(() => {
    lastFindScrollTick.current = -1;
    clearTranscriptHighlights();
  }, [conversationId]);

  useEffect(() => () => { clearTranscriptHighlights(); }, []);

  useEffect(() => {
    if (!findOpen || !findQuery.trim()) {
      clearTranscriptHighlights();
      return;
    }
    const pane = scrollPaneRef.current;
    const occ = findResults[clampedFindIdx] ?? null;
    const shouldScroll = findJumpTick !== lastFindScrollTick.current;
    const raf = requestAnimationFrame(() => {
      if (useCssHighlights && pane) {
        const { activeRange, activeCardEl } = applyTranscriptHighlights(
          pane,
          findQuery,
          occ ? { cardKey: occ.cardKey, matchIndexInCard: occ.matchIndexInCard } : null,
          findOpts,
        );
        if (shouldScroll) {
          lastFindScrollTick.current = findJumpTick;
          scrollRangeIntoPane(pane, activeRange, activeCardEl);
        }
        return;
      }
      if (!shouldScroll) return;
      lastFindScrollTick.current = findJumpTick;
      const mark = pane?.querySelector<HTMLElement>('mark[data-find-active="true"]');
      if (mark) {
        mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      const card = occ && pane
        ? pane.querySelector<HTMLElement>(`[data-find-card="${CSS.escape(occ.cardKey)}"]`)
        : null;
      if (card) {
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.classList.add('transcript-flash');
        setTimeout(() => card.classList.remove('transcript-flash'), 1500);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [findOpen, findQuery, findOpts, clampedFindIdx, findJumpTick, turns, collapsedTurns, allCollapsed, editedChunks, useCssHighlights, findResults]);

  // Reset individual overrides when the global state changes
  useEffect(() => {
    setCollapsedTurns({});
  }, [allCollapsed]);

  const toggleCollapse = (id: string) => {
    setCollapsedTurns(prev => {
      const currentVal = prev[id] !== undefined ? prev[id] : allCollapsed;
      return {
        ...prev,
        [id]: !currentVal
      };
    });
  };

  const handleCopy = (id: string, text: string) => {
    copyText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId(null);
      }, 2000);
    }).catch(() => {});
  };

  const handleEditStart = (id: string, text: string) => {
    setEditingTurnId(id);
    setEditText(text);
  };

  const handleSave = (id: string, promptItem: MergedItem) => {
    if (promptItem.event.payload) {
      (promptItem.event.payload as { text: string }).text = editText;
    }
    setEditingTurnId(null);
  };

  const handleEditEventStart = (eventId: string, text: string) => {
    setEditingEventId(eventId);
    setEditText(text);
  };

  const handleSaveEvent = (eventKey: string) => {
    setEditedChunks(prev => ({ ...prev, [eventKey]: editText }));
    setEditingEventId(null);
  };

  return (
    <OpenFileContext.Provider value={onOpenFile}>
      <div className="output-pane-wrap">
      <div className="output-pane" ref={scrollPaneRef} style={{ overflowAnchor: 'none' }}>
        <div className="output-pane-content">
        <div className="print-only-notice">
          Tool calls and results are included. To print only the prompt and response, use the Print icon on the user message card or check the 'Hide Tool Calls' setting at the top of the chat.
        </div>
        {isLoading && turns.length === 0 ? (
          <div className="conversation-loading-placeholder">
            <div className="placeholder-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            </div>
            <h3>Loading conversation…</h3>
            <p>Fetching transcript history.</p>
          </div>
        ) : turns.length === 0 ? (
          <div className="empty-conversation-placeholder">
            <div className="placeholder-icon">
              {!projectId ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              ) : !conversationId ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M7 8h10M7 12h10M7 16h6" />
                </svg>
              ) : (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </div>
            <h3>
              {!projectId
                ? 'No project selected'
                : !conversationId
                  ? 'No conversation selected'
                  : 'This conversation is empty'}
            </h3>
            <p>
              {!projectId
                ? 'Select a project or conversation from the sidebar to begin. An active project is required to interact with agents.'
                : !conversationId
                  ? 'Select an existing conversation from the sidebar or start a new chat to begin.'
                  : "Type a prompt, drag-and-drop a file, or use '/' slash commands below to start interacting with the agent."}
            </p>
            {(!projectId || !conversationId) && onOpenSidebar && (
              <button
                type="button"
                className="modal-btn"
                style={{ marginTop: 16 }}
                onClick={onOpenSidebar}
              >
                Open navigation
              </button>
            )}
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="load-earlier-container">
                <button
                  type="button"
                  className="load-earlier-btn"
                  onClick={handleLoadEarlier}
                  disabled={loadingEarlier || loadingAll}
                >
                  {loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}
                </button>
                {onLoadAll && (
                  <button
                    type="button"
                    className="load-all-btn"
                    onClick={handleLoadAll}
                    disabled={loadingEarlier || loadingAll}
                  >
                    {loadingAll ? 'Loading all…' : 'Load all'}
                  </button>
                )}
              </div>
            )}
            {turns.map((turn, idx) => {
            const isCollapsed = collapsedTurns[turn.id] !== undefined ? collapsedTurns[turn.id] : allCollapsed;
            // Only scan for an in-turn edit target when something is being
            // edited — keeps the per-render cost at O(1) during streaming.
            const isEditingEventInTurn = editingEventId !== null
              && turn.events.some((m) =>
                editingEventId === `event-${m.event.seq || m.event.ts}` ||
                editingEventId.endsWith(`-${m.event.seq || m.event.ts}`)
              );
            // Match the interrupted turn only. Soft-cancel reuses sessionId for
            // reinject + later turns, and server prompts always have seq:0 — so
            // we key on the prompt event id (ts fallback) snapshotted at force.
            const interruptDivider = forceInterruptDividerAt(turns, idx, forceInterruptedPromptIds);
            return (
              <TurnBlock
                key={turn.id}
                turn={turn}
                prevTurn={idx > 0 ? turns[idx - 1] : undefined}
                idx={idx}
                isLastTurn={idx === turns.length - 1}
                streamingLastEvent={lastEvent}
                agentStatus={agentStatus}
                liveSessionId={liveSessionId}
                profileLabels={profileLabels}
                isCollapsed={isCollapsed}
                allCollapsed={allCollapsed}
                isEditingThisTurn={editingTurnId === turn.id}
                isEditingEventInTurn={isEditingEventInTurn}
                editingEventId={editingEventId}
                editText={editText}
                editedChunks={editedChunks}
                forceTool={forceToolsState[turn.id] || null}
                isToolsExpanded={!!turnToolsExpanded[turn.id]}
                copiedId={copiedId}
                conversationId={conversationId}
                projectId={projectId}
                summaryByEventId={summaryByEventId}
                handoffByAnchorId={handoffByAnchorId}
                checkpointByEventId={checkpointByEventId}
                onViewSummary={onViewSummary}
                lastResolveIndexByRequestId={lastResolveIndexByRequestId}
                answeredRequestIds={answeredRequestIds}
                eventIndexByRef={eventIndexByRef}
                hideToolCalls={hideToolCalls}
                interruptDivider={interruptDivider}
                onToggleCollapse={toggleCollapse}
                onEditStart={handleEditStart}
                onSave={handleSave}
                onCopy={handleCopy}
                onPrintTurn={handlePrintTurn}
                onPrintTurnTextOnly={handlePrintTurnTextOnly}
                onPrintEvent={handlePrintEvent}
                onForkConversation={onForkConversation}
                onRepeatTurn={setRepeatConfirmTurnIndex}
                onDeleteTurn={setDeleteTurnIndex}
                onCancelTurnEdit={() => setEditingTurnId(null)}
                onEditTextChange={setEditText}
                onToggleTools={toggleTools}
                onDeleteEvent={handleDeleteEvent}
                onSaveEvent={handleSaveEvent}
                onEditEventStart={handleEditEventStart}
                onCancelEventEdit={() => setEditingEventId(null)}
                 onOpenFile={onOpenFile}
                onLightbox={setLightbox}
                onRespond={onRespond}
                onOpenConversation={onOpenConversation}
                onInjectText={onInjectText}
                onOpenMemory={onOpenMemory}
                tts={tts}
                ttsSummarizeAvailable={ttsSummarizeAvailable}
                onCycleTtsProvider={onCycleTtsProvider}
                getSpeakTailForId={getSpeakTailForId}
                terminalSpawnMap={terminalSpawnMap}
                highlightQuery={useCssHighlights ? '' : (findOpen ? findQuery : '')}
                highlightFindOpts={useCssHighlights || !findOpen ? undefined : findOpts}
                highlightCurrentDomId={
                  useCssHighlights || !findOpen || !findQuery.trim()
                    ? null
                    : (activeOccurrence?.domId ?? null)
                }
                highlightCurrentCardKey={
                  useCssHighlights || !findOpen || !findQuery.trim()
                    ? null
                    : (activeOccurrence?.cardKey ?? null)
                }
                highlightActiveMatchIdx={
                  useCssHighlights || !activeOccurrence
                    ? undefined
                    : turnContainsFindCard(turn, activeOccurrence.cardKey)
                      ? activeOccurrence.matchIndexInCard
                      : undefined
                }
                previousCumulativeMs={(previousCumulativeByIndex[idx] ?? 0) + unloadedSelfMs}
                helpersByToolUseId={helpersByToolUseId}
                onOpenHelper={onOpenHelper}
              />
            );
          })}
        </>
      )}
      {turns.length > 0 && !lastTurnActive && conversationTotalMs != null && (() => {
        const hasSummary = Boolean(subtreeSummary);
        const subMs = subtreeSummary ? subtreeSummary.descendantsMs : conversationSubagentMs;
        const hasSubagents = subtreeSummary ? subtreeSummary.descendantCount > 0 : conversationSubagentMs != null;
        return (
          <div className="conversation-elapsed-total" role="status">
            <span className="conversation-elapsed-segment conversation-elapsed-main">
              Conversation total {hasMore && !hasSummary ? '≥ ' : ''}{formatElapsedMs(conversationTotalMs + unloadedSelfMs)}
            </span>
            {conversationWaitingMs != null && conversationWaitingMs >= WAITING_DISPLAY_THRESHOLD_MS && (
              <>
                <span className="conversation-elapsed-sep" aria-hidden="true"> · </span>
                <span className="conversation-elapsed-segment conversation-elapsed-waiting">
                  Waiting for you {formatElapsedMs(conversationWaitingMs)}
                </span>
              </>
            )}
            {hasSubagents && subMs != null && (
              <>
                <span className="conversation-elapsed-sep" aria-hidden="true"> · </span>
                <span className="conversation-elapsed-segment conversation-elapsed-subagents">
                  Subagent tree {subtreeRunningCount > 0 ? '≥ ' : ''}{formatElapsedMs(subMs)}{subtreeRunningCount > 0 ? ` · ${subtreeRunningCount} running` : ''}
                </span>
                <span className="conversation-elapsed-segment conversation-elapsed-effort">
                  (total effort {hasSummary ? (subtreeRunningCount > 0 ? '≥ ' : '') : (hasMore ? '≥ ' : '')}{formatElapsedMs(hasSummary ? subtreeSummary!.totalMs : (conversationTotalMs + subMs))})
                </span>
              </>
            )}
            {subtreeSummary && subtreeSummary.descendantCount > 0 && (
              <div className="conversation-elapsed-breakdown">
                <button type="button" className="conversation-elapsed-stats-link" onClick={() => setBreakdownOpen(true)}>
                  Subagent stats ({subtreeSummary.descendantCount}{subtreeSummary.truncated ? '+' : ''})
                </button>
              </div>
            )}
            {breakdownOpen && subtreeSummary && (
              <SubagentStatsModal
                summary={subtreeSummary}
                runningIds={activeIdsSet}
                waitingMs={conversationWaitingMs}
                onOpenConversation={onOpenConversation}
                onClose={() => setBreakdownOpen(false)}
              />
            )}
          </div>
        );
      })()}
        <div ref={bottomRef} />
        </div>
      </div>
      {findOpen && (
        <TranscriptFindBar
          query={findQuery}
          onQueryChange={setFindQuery}
          results={findResults}
          activeIndex={clampedFindIdx}
          onSelectIndex={jumpToOccurrence}
          onStep={goToMatch}
          onClose={closeFindBar}
          inputRef={findInputRef}
          hasMore={hasMore}
          onLoadAll={onLoadAll ? handleLoadAll : undefined}
          loadingAll={loadingAll}
          loadingEarlier={loadingEarlier}
          mode={findMode}
          onModeChange={setFindMode}
          caseSensitive={findCaseSensitive}
          onCaseSensitiveChange={setFindCaseSensitive}
        />
      )}
      {lightbox && (
        <div className="modal-overlay" onClick={closeLightbox}>
          <div
            className="image-lightbox"
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <span>{lightbox.name ?? 'Attached image'}</span>
              <button
                type="button"
                className="image-lightbox-close"
                aria-label="Close"
                onClick={closeLightbox}
              >
                ×
              </button>
            </div>
            <img
              className="image-lightbox-img"
              src={`data:${lightbox.mediaType};base64,${lightbox.base64}`}
              alt={lightbox.name ?? 'attached image'}
            />
          </div>
        </div>
      )}

      {openFile && (
        <FileModal
          path={openFile.path}
          galleryPaths={openFile.gallery}
          displayName={openFile.displayName}
          remoteHostName={remoteHostName}
          onClose={() => setOpenFile(null)}
          onOpenFile={handleOpenFile}
          conversationId={conversationId}
          projectId={projectId}
          onAnnotate={onAddAttachment ? handleAnnotateFile : undefined}
          onAnnotateImage={onAddAttachment
            ? ({ src, name }) => setAnnotateTarget({ src, mediaType: 'image/png', name })
            : undefined}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
          agentRunning={agentStatus === 'running'}
          fileEditsEnabled={fileEditsEnabled}
        />
      )}

      {annotateTarget && (
        <ImageAnnotator
          src={annotateTarget.src}
          mediaType={annotateTarget.mediaType}
          name={annotateTarget.name}
          onSave={(att) => {
            onAddAttachment?.({ base64: att.base64, mediaType: att.mediaType, name: att.name ?? annotateTarget.name });
            setAnnotateTarget(null);
            setOpenFile(null);
          }}
          onClose={() => setAnnotateTarget(null)}
        />
      )}

      {deleteConfirmEventId && (
        <div className="modal-overlay" onClick={() => setDeleteConfirmEventId(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">Delete Message Block</div>
            <div className="modal-body" style={{ color: 'var(--text-1)', fontSize: '13px', lineHeight: '1.5' }}>
              Are you sure you want to delete this message block? This will permanently delete it from the database.
            </div>
            <div className="modal-footer">
              <button className="modal-btn" onClick={() => setDeleteConfirmEventId(null)}>
                Cancel
              </button>
              <button
                className="modal-btn danger"
                onClick={() => {
                  if (deleteConfirmEventId) {
                    onDeleteEvent?.(deleteConfirmEventId);
                    setDeleteConfirmEventId(null);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTurnIndex !== null && (
        <div className="modal-overlay" onClick={() => { setDeleteTurnIndex(null); setDeleteScopeChoice(null); }}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">Delete Message</div>
            <div className="modal-body" style={{ color: 'var(--text-1)', fontSize: '13px', lineHeight: '1.5' }}>
              Would you like to delete only this message and its response, or the entire conversation from this point on?
            </div>
            <div className="modal-footer" style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', marginTop: '12px' }}>
              <button
                className="modal-btn danger"
                style={{ backgroundColor: 'var(--red, #ef4444)', color: '#fff', border: 'none', width: '100%', padding: '10px 16px', fontSize: '13px' }}
                onClick={() => { setDeleteScopeChoice('suffix'); }}
              >
                Delete Conversation From This Point
              </button>
              <button
                className="modal-btn danger"
                style={{ width: '100%', padding: '10px 16px', fontSize: '13px' }}
                onClick={() => { setDeleteScopeChoice('single'); }}
              >
                Delete Just This Message
              </button>
              <button
                className="modal-btn"
                style={{ width: '100%', padding: '10px 16px', fontSize: '13px' }}
                onClick={() => { setDeleteTurnIndex(null); setDeleteScopeChoice(null); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteScopeChoice !== null && deleteTurnIndex !== null && (
        <div className="modal-overlay" onClick={closeDeleteScope}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">Delete Scope</div>
            <div className="modal-body" style={{ color: 'var(--text-1)', fontSize: '13px', lineHeight: '1.5' }}>
              {deleteScopeCanNativeSync ? (
                deleteScopeIsSuffix ? (
                  <span>This conversation has a live agent session file. Choose whether the trailing delete should also fork-truncate that native session so a resume does not restore the deleted turns.</span>
                ) : (
                  <span>This conversation has a live agent session file. Choose whether deleting this single turn should also remove it from the native session (parentUuid rewired so the result is resumable), or only from the transcript.</span>
                )
              ) : (
                <span style={{ color: 'var(--text-1)' }}>
                  <strong style={{ display: 'block', marginBottom: '6px', color: 'var(--amber, #f59e0b)' }}>
                    Session deletion is not supported for this agent.
                  </strong>
                  Deleting from the transcript only; the native session file will be left as-is and may restore the deleted turn on the next resume.
                </span>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', marginTop: '12px' }}>
              {deleteScopeCanNativeSync && (
                <button
                  className="modal-btn danger"
                  style={{ backgroundColor: 'var(--accent, #6366f1)', color: 'var(--send-btn-text, #fff)', border: 'none', width: '100%', padding: '10px 16px', fontSize: '13px' }}
                  onClick={handleDeleteScopeNative}
                >
                  Delete transcript + agent session
                </button>
              )}
              <button
                className="modal-btn danger"
                style={deleteScopeCanNativeSync ? { width: '100%', padding: '10px 16px', fontSize: '13px' } : { backgroundColor: 'var(--accent, #6366f1)', color: 'var(--send-btn-text, #fff)', border: 'none', width: '100%', padding: '10px 16px', fontSize: '13px' }}
                onClick={handleDeleteScopeTranscriptOnly}
              >
                Delete transcript only
              </button>
              <button
                className="modal-btn"
                style={{ width: '100%', padding: '10px 16px', fontSize: '13px' }}
                onClick={closeDeleteScope}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {repeatConfirmTurnIndex !== null && (
        <div className="modal-overlay" onClick={() => setRepeatConfirmTurnIndex(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">Repeat Question</div>
            <div className="modal-body" style={{ color: 'var(--text-1)', fontSize: '13px', lineHeight: '1.5' }}>
              Are you sure you want to repeat this question? This will permanently delete this message and all responses/turns after it, and load the question (and any attachments) back into the input field so you can edit or resubmit it.
            </div>
            <div className="modal-footer">
              <button className="modal-btn" onClick={() => setRepeatConfirmTurnIndex(null)}>
                Cancel
              </button>
              <button
                className="modal-btn danger"
                style={{ backgroundColor: 'var(--accent, #6366f1)', color: '#fff', border: 'none' }}
                onClick={() => {
                  const idx = repeatConfirmTurnIndex;
                  const targetTurn = turns[idx];
                  const payload = targetTurn.prompt?.event.payload as {
                    text?: string;
                    attachments?: PromptAttachment[];
                  } | undefined;
                  const promptText = payload?.text ?? '';
                  const promptAttachments = payload?.attachments ?? [];

                  const idsToDelete: string[] = [];
                  for (let i = idx; i < turns.length; i++) {
                    const turnItem = turns[i];
                    if (turnItem.prompt?.event.id) {
                      idsToDelete.push(turnItem.prompt.event.id);
                    }
                    for (const m of turnItem.events) {
                      if (m.mergedIds && m.mergedIds.length > 0) {
                        idsToDelete.push(...m.mergedIds);
                      } else if (m.event.id) {
                        idsToDelete.push(m.event.id);
                      }
                    }
                  }

                  onRepeatQuestion?.(promptText, idsToDelete, promptAttachments);
                  setRepeatConfirmTurnIndex(null);
                }}
              >
                Confirm & Repeat
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </OpenFileContext.Provider>
  );
}

interface TurnBlockProps {
  turn: PromptTurn;
  prevTurn?: PromptTurn;
  idx: number;
  /** The streaming target. True forces a re-render every token (see comparator). */
  isLastTurn: boolean;
  /** Global last event; only the last turn's events can reference-match it. */
  streamingLastEvent?: NormalisedEvent;
  agentStatus: string;
  liveSessionId?: string | null;
  profileLabels?: Record<string, string>;
  isCollapsed: boolean;
  allCollapsed: boolean;
  isEditingThisTurn: boolean;
  isEditingEventInTurn: boolean;
  editingEventId: string | null;
  editText: string;
  editedChunks: Record<string, string>;
  forceTool: 'expand' | 'collapse' | null;
  isToolsExpanded: boolean;
  copiedId: string | null;
  conversationId?: string;
  projectId?: string;
  summaryByEventId?: Record<string, string>;
  handoffByAnchorId?: Record<string, Handoff>;
  checkpointByEventId?: Record<string, Checkpoint>;
  onViewSummary?: (text: string, handoff?: Handoff) => void;
  lastResolveIndexByRequestId?: Map<string, number>;
  answeredRequestIds?: ReadonlySet<string>;
  eventIndexByRef?: Map<NormalisedEvent, number>;
  hideToolCalls: boolean;
  /** Live Interrupt & Send divider: above this turn's prompt, or after it
   *  while the follow-up message has not arrived yet. */
  interruptDivider?: 'before-prompt' | 'after-turn' | null;
  onToggleCollapse: (turnId: string) => void;
  onEditStart: (id: string, text: string) => void;
  onSave: (id: string, promptItem: MergedItem) => void;
  onCopy: (id: string, text: string) => void;
  onPrintTurn: (turnId: string) => void;
  onPrintTurnTextOnly: (turnId: string) => void;
  onPrintEvent: (turnId: string, eventKey: string) => void;
  onForkConversation?: (eventId: string) => void;
  onRepeatTurn: (idx: number) => void;
  onDeleteTurn: (idx: number) => void;
  onCancelTurnEdit: () => void;
  onEditTextChange: (text: string) => void;
  onToggleTools: (turnId: string) => void;
  onDeleteEvent: (eventId: string | string[] | undefined) => void;
  onSaveEvent: (eventKey: string) => void;
  onEditEventStart: (eventKey: string, text: string) => void;
  onCancelEventEdit: () => void;
  onOpenFile?: (path: string, gallery?: string[]) => void;
  onLightbox: (att: PromptAttachment) => void;
  onRespond?: (requestId: string, sessionId: string, selection: string[], text?: string, answers?: { selection: string[]; text?: string }[]) => void;
  onOpenConversation?: (conversationId: string) => void;
  onOpenMemory?: (id: string) => void;
  onInjectText?: (text: string) => void;
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
  onCycleTtsProvider?: () => void;
  /** Stable: reads latest flat transcript via ref; used by per-message TTS scope. */
  getSpeakTailForId?: (id: string) => string;
  /** Terminal status/duration map for child spawns anywhere in the transcript. */
  terminalSpawnMap: ReadonlyMap<string, TerminalSpawnInfo>;
  /** FW-12 Phase 1: in-text find highlight. Empty = no marks. */
  highlightQuery?: string;
  highlightFindOpts?: FindOptions;
  /** `FindTarget.domId` of the current 1/N card, or null. */
  highlightCurrentDomId?: string | null;
  highlightCurrentCardKey?: string | null;
  highlightActiveMatchIdx?: number;
  /** Sum of completed turn durations before this one (for the running total). */
  previousCumulativeMs: number;
  helpersByToolUseId?: ReadonlyMap<string, HelperRun>;
  onOpenHelper?: (key: string, highlightQuery?: string) => void;
}

function HelperLine({ run, onOpen, eventId }: { run: HelperRun; onOpen?: () => void; eventId?: string }) {
  const [, setTick] = useState(0);
  const running = run.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const elapsed = run.durationMs ?? ((run.endedAt ?? Date.now()) - (run.startedAt ?? Date.now()));
  const statusWord = run.status === 'completed' ? 'done' : run.status;
  const desc = run.description ? ` · "${run.description}"` : '';
  return (
    <button type="button" id={eventId} className="event-spawn-card helper-line" onClick={onOpen}>
      ⑂ {run.label}{desc} · {statusWord} {formatElapsedMs(Math.max(0, elapsed))} · {run.toolUses} tools ›
    </button>
  );
}

function turnContainsFindDomId(turn: PromptTurn, domId: string | null | undefined): boolean {
  if (!domId) return false;
  if (turn.id === domId) return true;
  return turn.events.some((m) => `event-${m.event.seq || m.event.ts}` === domId);
}

function turnContainsFindCard(turn: PromptTurn, cardKey: string | null | undefined): boolean {
  if (!cardKey) return false;
  if (cardKey === `${turn.id}:prompt`) return true;
  return turn.events.some((_, i) => `${turn.id}:g${i}` === cardKey);
}

// ponytail: turn-level memo boundary. Prior turns are byte-identical during
// streaming; only the last turn mutates. The comparator (turnPropsEqual) lets
// already-rendered turns skip the per-token render, dropping cost from O(L) to
// O(1). Callback props are intentionally NOT compared — for prior turns the
// fresh closures are behaviour-identical; the last turn always re-renders
// (isLastTurn) so it picks up fresh callbacks anyway.
function turnPropsEqual(prev: TurnBlockProps, next: TurnBlockProps): boolean {
  // Streaming last turn must re-render every token. Idle last turns memoize
  // like prior turns — otherwise a 677KB markdown image remounts on every
  // parent render and the pane jumps at the bottom.
  if (
    lastTurnMustRerender({ isLastTurn: prev.isLastTurn, agentStatus: prev.agentStatus })
    || lastTurnMustRerender({ isLastTurn: next.isLastTurn, agentStatus: next.agentStatus })
  ) return false;
  const editing = next.isEditingThisTurn || next.isEditingEventInTurn;
  return (
    prev.turn.id === next.turn.id &&
    prev.turn.events.length === next.turn.events.length &&
    prev.isLastTurn === next.isLastTurn &&
    prev.agentStatus === next.agentStatus &&
    prev.liveSessionId === next.liveSessionId &&
    prev.streamingLastEvent === next.streamingLastEvent &&
    prev.idx === next.idx &&
    prev.profileLabels === next.profileLabels &&
    prev.isCollapsed === next.isCollapsed &&
    prev.allCollapsed === next.allCollapsed &&
    prev.hideToolCalls === next.hideToolCalls &&
    prev.isToolsExpanded === next.isToolsExpanded &&
    prev.isEditingThisTurn === next.isEditingThisTurn &&
    prev.isEditingEventInTurn === next.isEditingEventInTurn &&
    prev.editingEventId === next.editingEventId &&
    prev.editedChunks === next.editedChunks &&
    prev.forceTool === next.forceTool &&
    prev.copiedId === next.copiedId &&
    prev.summaryByEventId === next.summaryByEventId &&
    prev.handoffByAnchorId === next.handoffByAnchorId &&
    prev.checkpointByEventId === next.checkpointByEventId &&
    // B/P/K cycle updates App tts state; without this, memoized prior turns
    // keep showing the old letter until a full refresh.
    prev.tts?.provider === next.tts?.provider &&
    prev.tts?.enabled === next.tts?.enabled &&
    prev.ttsSummarizeAvailable === next.ttsSummarizeAvailable &&
    prev.interruptDivider === next.interruptDivider &&
    prev.terminalSpawnMap === next.terminalSpawnMap &&
    prev.highlightQuery === next.highlightQuery &&
    prev.highlightFindOpts?.mode === next.highlightFindOpts?.mode &&
    prev.highlightFindOpts?.caseSensitive === next.highlightFindOpts?.caseSensitive &&
    prev.highlightActiveMatchIdx === next.highlightActiveMatchIdx &&
    prev.previousCumulativeMs === next.previousCumulativeMs &&
    prev.helpersByToolUseId === next.helpersByToolUseId &&
    // Next/prev only re-renders the turn that lost --current and the one that gained it.
    !(
      prev.highlightCurrentDomId !== next.highlightCurrentDomId &&
      (turnContainsFindDomId(prev.turn, prev.highlightCurrentDomId) ||
        turnContainsFindDomId(next.turn, next.highlightCurrentDomId))
    ) &&
    !(
      prev.highlightCurrentCardKey !== next.highlightCurrentCardKey &&
      (turnContainsFindCard(prev.turn, prev.highlightCurrentCardKey) ||
        turnContainsFindCard(next.turn, next.highlightCurrentCardKey))
    ) &&
    // editText only matters while THIS turn is the edit target.
    (!editing || prev.editText === next.editText)
  );
}

const TurnBlock = memo(function TurnBlock({
  turn,
  prevTurn,
  idx,
  isLastTurn,
  agentStatus,
  liveSessionId,
  profileLabels,
  isCollapsed,
  allCollapsed,
  isEditingThisTurn,
  isEditingEventInTurn,
  editingEventId,
  editText,
  editedChunks,
  forceTool,
  isToolsExpanded,
  copiedId,
  streamingLastEvent,
  conversationId,
  projectId,
  summaryByEventId,
  handoffByAnchorId,
  checkpointByEventId,
  onViewSummary,
  lastResolveIndexByRequestId,
  answeredRequestIds,
  eventIndexByRef,
  hideToolCalls,
  interruptDivider = null,
  onToggleCollapse,
  onEditStart,
  onSave,
  onCopy,
  onPrintTurn,
  onPrintTurnTextOnly,
  onPrintEvent,
  onForkConversation,
  onRepeatTurn,
  onDeleteTurn,
  onCancelTurnEdit,
  onEditTextChange,
  onToggleTools,
  onDeleteEvent,
  onSaveEvent,
  onEditEventStart,
  onCancelEventEdit,
  onOpenFile,
  onLightbox,
  onRespond,
  onOpenConversation,
  onOpenMemory,
  onInjectText,
  tts,
  ttsSummarizeAvailable = false,
  onCycleTtsProvider,
  getSpeakTailForId,
  terminalSpawnMap,
  highlightQuery,
  highlightFindOpts,
  highlightCurrentDomId,
  highlightCurrentCardKey,
  highlightActiveMatchIdx,
  previousCumulativeMs,
  helpersByToolUseId,
  onOpenHelper,
}: TurnBlockProps) {
  const getChunkText = (m: MergedItem): string => {
    const eventKey = `event-${m.event.seq || m.event.ts}`;
    const edited = editedChunks[eventKey];
    return edited !== undefined ? edited : (m.event.payload as { chunk: string }).chunk;
  };

  const getFullResponseText = (t: PromptTurn): string => {
    return t.events
      .filter(m => m.event.type === 'message' && !(m.event.payload as { recalledMemories?: string[] })?.recalledMemories)
      .map(m => getChunkText(m))
      .join('\n\n');
  };

  const hasResponse = turn.events.length > 0;
  // ponytail: content-only predicate — status/error events arrive before the
  // first token and would flip hasResponse true too early; only these four
  // types signal actual assistant output. Recall chips are excluded so the
  // shimmer stays active until assistant content actually streams.
  const hasStreamedContent = hasStreamedTurnContent(turn.events);
  const turnSessionId = turn.prompt?.event.sessionId ?? turn.events[0]?.event.sessionId;
  const showPendingShimmer = shouldShowPendingShimmer({
    isLastTurn,
    agentStatus,
    hasStreamedContent,
    turnSessionId,
    liveSessionId,
  });
  const [turnSpeaking, setTurnSpeaking] = useState(false);
  const [turnSpeakChoiceOpen, setTurnSpeakChoiceOpen] = useState(false);
  const [turnInfoOpen, setTurnInfoOpen] = useState(false);
  const { recalled, hoistedItem } = useMemo(() => splitTurnRecall(turn.events), [turn.events]);
  const canSpeakTurn = !!tts?.enabled && (ttsSupported || tts.provider === 'piper' || tts.provider === 'kokoro');
  const ttsProvider = tts?.provider ?? 'browser';
  const providerLabel = ttsProvider === 'browser' ? 'B' : ttsProvider === 'piper' ? 'P' : 'K';

  const runTurnSpeakMode = (mode: SpeakMode, opts?: { guidance?: string; targetMinutes?: number }) => {
    setTurnSpeakChoiceOpen(false);
    setTurnSpeaking(true);
    const chunks = turn.events
      .filter((m) => m.event.type === 'message' && !(m.event.payload as { recalledMemories?: string[] })?.recalledMemories)
      .map((m) => getChunkText(m));
    const meta: SpeakMeta | undefined = conversationId || projectId
      ? { conversationId: conversationId ?? undefined, projectId: projectId ?? undefined, source: 'scope', title: chunks[0]?.slice(0, 80) }
      : undefined;
    void speakChunks(chunks, () => setTurnSpeaking(false), tts?.provider, mode, meta, mode === 'summarize' ? opts : undefined);
  };

  // Per-card TTS scope→mode (user prompt + spawn Result). Selection wins.
  // `key` identifies which card is speaking / has an open modal.
  const [cardSpeak, setCardSpeak] = useState<{
    key: string;
    step: 'scope' | 'mode';
    thisText: string;
    speakId: string;
    source: TtsRecordingSource;
  } | null>(null);
  const [cardSpeakingKey, setCardSpeakingKey] = useState<string | null>(null);

  const openCardSpeakFlow = (
    key: string,
    thisText: string,
    speakId: string,
    baseSource: TtsRecordingSource = 'message',
  ) => {
    const selected = window.getSelection()?.toString()?.trim();
    if (selected) {
      setCardSpeak({ key, step: 'mode', thisText: selected, speakId, source: 'selection' });
      return;
    }
    setCardSpeak({ key, step: 'scope', thisText, speakId, source: baseSource });
  };

  const onCardScopeChoose = (scope: SpeakScope) => {
    if (!cardSpeak) return;
    const text =
      scope === 'this'
        ? cardSpeak.thisText
        : (getSpeakTailForId?.(cardSpeak.speakId) || cardSpeak.thisText);
    setCardSpeak({
      ...cardSpeak,
      step: 'mode',
      thisText: text,
      source: scope === 'this' ? cardSpeak.source : 'scope',
    });
  };

  const runCardSpeakMode = (mode: SpeakMode, opts?: { guidance?: string; targetMinutes?: number }) => {
    if (!cardSpeak) return;
    const { key, thisText, source } = cardSpeak;
    setCardSpeak(null);
    setCardSpeakingKey(key);
    const meta: SpeakMeta | undefined = conversationId || projectId
      ? { conversationId: conversationId ?? undefined, projectId: projectId ?? undefined, source, title: thisText.slice(0, 80) }
      : undefined;
    void playWithMode(thisText, mode, () => setCardSpeakingKey(null), ttsProvider, mode === 'summarize' ? opts : undefined, meta);
  };

  const closeCardSpeak = () => setCardSpeak(null);

  // spawn-result card expand state, keyed by child conversation id.
  // Local UI state — re-render on toggle is cheap and self-contained.
  const [spawnResultExpanded, setSpawnResultExpanded] = useState<Record<string, boolean>>({});

  // Per-turn agent: first event in the turn that carries agentProfileId.
  // (prompt events don't carry it; tool/message/error events do.)
  const currentProfileId = turnProfileId(turn);
  const isTurnActive = isLastTurn && (agentStatus === 'running' || agentStatus === 'waiting');
  const elapsedMs = turnElapsedMs(turn);
  const elapsedLabel = elapsedMs == null ? null : formatElapsedMs(elapsedMs);
  const subagentMs = turnSubagentElapsedMs(turn);
  const subagentLabel = subagentMs == null ? null : formatElapsedMs(subagentMs);
  const cumulativeMs = elapsedMs == null && previousCumulativeMs <= 0
    ? null
    : previousCumulativeMs + (elapsedMs ?? 0);
  const cumulativeLabel = cumulativeMs == null ? null : formatElapsedMs(cumulativeMs);
  const currentLabel = currentProfileId ? profileLabels?.[currentProfileId] : undefined;
  const currentLabelOrProfile = currentLabel || currentProfileId || '';
  const currentAgentModel = currentLabel
    ? formatAgentHeader(currentLabel)
    : (currentProfileId ? formatAgentHeader(currentProfileId) : undefined);
  const fallbackText = currentAgentModel ?? 'Agent Executions';

  // Previous turn's agent — only first-degree; we don't trace back
  // through multiple turns because the divider marks the immediate
  // switch point.
  const prevProfileId = prevTurn ? turnProfileId(prevTurn) : undefined;
  const prevLabel = prevProfileId ? profileLabels?.[prevProfileId] : undefined;

  // Handoff = both turns have an agent AND they differ.
  const isHandoff = !!currentProfileId && !!prevProfileId && currentProfileId !== prevProfileId;

  const anchorEventId = prevTurn?.events[prevTurn.events.length - 1]?.event.id;
  const handoff = anchorEventId ? handoffByAnchorId?.[anchorEventId] : undefined;
  const summaryText = anchorEventId ? summaryByEventId?.[anchorEventId] : undefined;
  const handoffContext = handoff?.priming_context ?? summaryText;
  const mismatchHint = handoff ? handoffMismatchHint(handoff) : null;
  // A recorded handoff row marks a boundary even on the same profile: New session
  // ('fresh') or an explicit same-profile Handover from the `+` menu.
  const isFreshSession = handoff?.requested_mode === 'fresh';
  const showDivider = isHandoff || !!handoff;

  // Shared view button — cross-agent handoff shows full priming context when
  // recorded; fork/summary-only dividers fall back to the summary artifact.
  const renderViewHandoffContext = () =>
    handoffContext && onViewSummary ? (
      <button
        type="button"
        className="handoff-view-summary-btn"
        onClick={() => onViewSummary(handoffContext, handoff)}
      >
        {handoff?.priming_context ? 'View context' : 'View summary'}
      </button>
    ) : null;

  const renderViewSummary = () =>
    summaryText && onViewSummary ? (
      <button
        type="button"
        className="handoff-view-summary-btn"
        onClick={() => onViewSummary(summaryText, handoff)}
      >
        View summary
      </button>
    ) : null;

  // Fork-summary case: a summary exists at the anchor but the two turns share
  // an agent, so it's not a cross-agent handoff. Show a leaner divider with
  // just the summary button — no from/to labels, no mode pills (none exist).
  const showForkSummary = !showDivider && !!summaryText;

  const turnCheckpoint = turn.events
    .map((m) => m.event.id && checkpointByEventId?.[m.event.id])
    .find(Boolean);

  return (
    <div key={turn.id} id={turn.id} data-turn-id={turn.id} className="prompt-turn">
      {showDivider && isFreshSession && (
        <div className="handoff-divider" role="separator" aria-label="New session">
          <span className="handoff-line" />
          <div className="handoff-divider-center">
            <span className="handoff-label">
              <span className="handoff-arrow">⟲</span>
              <span className="handoff-to">
                <strong>New session</strong> · {currentLabel ?? currentProfileId} · {formatTimestamp(handoff!.created_at)}
              </span>
            </span>
            <div className="handoff-divider-meta">
              <span className="handoff-from">Context reset; the agent does not see earlier turns.</span>
            </div>
          </div>
          <span className="handoff-line" />
        </div>
      )}
      {showDivider && !isFreshSession && (
        <div className="handoff-divider" role="separator" aria-label={isHandoff ? `Handed off from ${prevLabel} to ${currentLabel}` : 'Handover'}>
          <span className="handoff-line" />
          <div className="handoff-divider-center">
            <span className="handoff-label">
              <span className="handoff-arrow">↘</span>
              {isHandoff ? (
                <>
                  <span className="handoff-to">
                    Handed off to <strong>{currentLabel ?? currentProfileId}</strong>
                  </span>
                  <span className="handoff-from">
                    (from {prevLabel ?? prevProfileId})
                  </span>
                </>
              ) : (
                <span className="handoff-to">
                  <strong>Handover</strong> · {currentLabel ?? currentProfileId}
                </span>
              )}
            </span>
            {handoff && (
              <div className="handoff-divider-meta">
                <span className="handoff-mode-pill requested">
                  {handoff.requested_mode === 'summary' ? 'Summarize' : 'Transcript'}
                </span>
                <span className="handoff-mode-arrow" aria-hidden="true">→</span>
                <span className="handoff-mode-pill resolved">
                  {handoff.resolved_mode === 'compacted'
                    ? 'Compacted'
                    : handoff.resolved_mode === 'transcript'
                      ? 'Transcript'
                      : 'Fresh'}
                </span>
                {mismatchHint && (
                  <span className="handoff-mismatch-hint">{mismatchHint}</span>
                )}
              </div>
            )}
            {renderViewHandoffContext()}
          </div>
          <span className="handoff-line" />
        </div>
      )}
      {showForkSummary && (
        <div className="handoff-divider fork-summary-divider" role="separator" aria-label="Resumed from summary">
          <span className="handoff-line" />
          <div className="handoff-divider-center">
            <span className="handoff-label">
              <span className="handoff-arrow">↘</span>
              <span className="handoff-to">Resumed from summary</span>
            </span>
            {renderViewSummary()}
          </div>
          <span className="handoff-line" />
        </div>
      )}
      {interruptDivider === 'before-prompt' && <ForceInterruptDivider />}
      {recalled && recalled.length > 0 && (
        <RecalledMemoriesChip ids={recalled} onOpenMemory={onOpenMemory} />
      )}
      {turn.prompt && !(
        turn.prompt.event.type === 'prompt' &&
        (turn.prompt.event.payload as { source?: string }).source === 'subagent_notify'
      ) && (
        isEditingThisTurn ? (
          <div className="prompt-echo">
            <div className="prompt-edit-area">
              <div className="prompt-echo-header">
                <div className="prompt-echo-header-left">
                  <span className="prompt-echo-user" style={{ color: 'var(--accent)' }}>Editing Turn:</span>
                  {currentLabelOrProfile && (
                    <span className="prompt-echo-recipient" title={`Message sent to ${currentLabelOrProfile}`}>
                      <span className="prompt-echo-to-label">Sent to:</span>
                      <AgentModelBadge label={currentLabelOrProfile} />
                    </span>
                  )}
                </div>
              </div>
              <textarea
                className="edit-textarea"
                value={editText}
                onChange={(e) => onEditTextChange(e.target.value)}
              />
              <div className="edit-btn-row">
                <button className="btn-edit-cancel" onClick={() => onCancelTurnEdit()}>Cancel</button>
                <button className="btn-edit-save" onClick={() => onSave(turn.id, turn.prompt!)}>Save</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="prompt-block">
            <div className="card-actions">
                {hasResponse && (
                  <button
                    className="action-icon-btn"
                    title={isCollapsed ? "Expand response" : "Collapse response"}
                    onClick={() => onToggleCollapse(turn.id)}
                  >
                    {isCollapsed ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="18 15 12 9 6 15" />
                      </svg>
                    )}
                  </button>
                )}
                {canSpeakTurn && (() => {
                  const promptEv = turn.prompt!.event;
                  const promptText = (promptEv.payload as { text: string }).text ?? '';
                  const speakId = `${promptEv.sessionId}:${promptEv.seq || promptEv.ts}`;
                  const speakKey = `prompt-${turn.id}`;
                  const speaking = cardSpeakingKey === speakKey;
                  return (
                    <>
                      <button
                        className="action-icon-btn"
                        title={speaking ? 'Read aloud (replace current)' : 'Read aloud'}
                        aria-busy={speaking || undefined}
                        style={speaking ? { color: 'var(--accent)' } : undefined}
                        onClick={() => openCardSpeakFlow(speakKey, promptText, speakId, 'prompt')}
                      >
                        <TtsSpeakIcon speaking={speaking} size={12} />
                      </button>
                      <button
                        className="action-icon-btn tts-provider-cycle"
                        title={`TTS provider: ${ttsProvider} (click to cycle)`}
                        onClick={() => onCycleTtsProvider?.()}
                        style={{ fontSize: '9px', fontWeight: 700, fontFamily: 'var(--ui)', minWidth: '18px' }}
                      >
                        {providerLabel}
                      </button>
                      {cardSpeak?.key === speakKey && cardSpeak.step === 'scope' && (
                        <SpeakScopeModal onChoose={onCardScopeChoose} onClose={closeCardSpeak} />
                      )}
                      {cardSpeak?.key === speakKey && cardSpeak.step === 'mode' && (
                        <SpeakChoiceModal
                          summarizeAvailable={ttsSummarizeAvailable}
                          allowSummarizeGuidance
                          onChoose={runCardSpeakMode}
                          onClose={closeCardSpeak}
                        />
                      )}
                    </>
                  );
                })()}
                <button
                  className="action-icon-btn"
                  title="Edit message"
                  onClick={() => onEditStart(turn.id, (turn.prompt!.event.payload as { text: string }).text)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
                <button
                  className="action-icon-btn"
                  title={copiedId === `prompt-${turn.id}` ? 'Copied' : 'Copy message'}
                  onClick={() => onCopy(`prompt-${turn.id}`, (turn.prompt!.event.payload as { text: string }).text)}
                  style={copiedId === `prompt-${turn.id}` ? { color: 'var(--green, #10b981)' } : undefined}
                >
                  {copiedId === `prompt-${turn.id}` ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                    </svg>
                  )}
                </button>
                <button
                  className="action-icon-btn"
                  title="Print prompt and response text only"
                  onClick={() => onPrintTurnTextOnly(turn.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 6 2 18 2 18 9" />
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                    <rect x="6" y="14" width="12" height="8" />
                  </svg>
                </button>
                <button
                  className="action-icon-btn"
                  title="Fork conversation from this point"
                  onClick={() => turn.prompt?.event.id && onForkConversation?.(turn.prompt.event.id)}
                  style={{ color: 'var(--accent, #6366f1)' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                </button>
                <button
                  className="action-icon-btn"
                  title="Repeat/Re-run question from here (deletes everything after)"
                  onClick={() => onRepeatTurn(idx)}
                  style={{ color: 'var(--accent, #6366f1)' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                  </svg>
                </button>
                <button
                  className="action-icon-btn"
                  title="Delete message and response"
                  onClick={() => {
                    onDeleteTurn(idx);
                  }}
                  style={{ color: 'var(--red, #ef4444)' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                </button>
            </div>
            <div className="prompt-echo">
              <div className="prompt-echo-header">
                <div className="prompt-echo-header-left">
                  <div className="prompt-echo-meta">
                    <span className="prompt-echo-user">User:</span>
                    <span className="prompt-echo-time">{formatTimestamp(turn.prompt.event.ts)}</span>
                    {turn.prompt.event.type === 'prompt'
                      && (turn.prompt.event.payload as { schedule?: { jobName?: string } }).schedule?.jobName && (
                      <span
                        className="effort-audit-pill"
                        title={`Scheduled by ${(turn.prompt.event.payload as { schedule: { jobName: string } }).schedule.jobName}`}
                      >
                        ⏰ {(turn.prompt.event.payload as { schedule: { jobName: string } }).schedule.jobName}
                      </span>
                    )}
                  </div>
                  <div className="prompt-echo-header-right">
                    {currentLabelOrProfile && (
                      <span className="prompt-echo-recipient" title={`Message sent to ${currentLabelOrProfile}`}>
                        <span className="prompt-echo-to-label">Sent to:</span>
                        <AgentModelBadge label={currentLabelOrProfile} />
                      </span>
                    )}
                    {turn.prompt.event.type === 'prompt' && (turn.prompt.event.payload as { effort?: string }).effort && (
                      <span
                        className="effort-audit-pill"
                        title={`Effort level for this turn: ${(turn.prompt.event.payload as { effort: string }).effort}`}
                      >
                        {(turn.prompt.event.payload as { effort: string }).effort}
                      </span>
                    )}
                    {turn.prompt.event.type === 'prompt' && (turn.prompt.event.payload as { sandboxed?: boolean }).sandboxed && (
                      <span className="effort-audit-pill" title="This turn ran inside the bwrap sandbox">
                        🔒 sandbox
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div data-find-card={`${turn.id}:prompt`}>
              <MarkdownBody
                className="pe-msg event-message"
                onOpenFile={onOpenFile}
                conversationId={conversationId}
                projectId={projectId}
                highlightQuery={highlightQuery}
                highlightFindOpts={highlightFindOpts}
                highlightActive={highlightCurrentCardKey === `${turn.id}:prompt` || highlightCurrentDomId === turn.id}
                highlightActiveIdx={highlightCurrentCardKey === `${turn.id}:prompt` ? highlightActiveMatchIdx : undefined}
              >
                {(turn.prompt.event.payload as { text: string }).text}
              </MarkdownBody>
              </div>
              {(() => {
                const atts = (turn.prompt.event.payload as { attachments?: PromptAttachment[] }).attachments;
                if (!atts || atts.length === 0) return null;
                return (
                  <div className="pe-attachments">
                    {atts.map((a, i) => {
                      const isImage = a.mediaType.startsWith('image/');
                      if (isImage) {
                        return (
                          <button
                            key={i}
                            type="button"
                            className="pe-attachment-thumb"
                            title={a.name ?? 'View image'}
                            onClick={() => onLightbox(a)}
                          >
                            <img
                              src={`data:${a.mediaType};base64,${a.base64}`}
                              alt={a.name ?? 'attached image'}
                            />
                          </button>
                        );
                      }
                      return (
                        <span
                          key={i}
                          className="pe-attachment-file"
                          title={a.name ?? 'attachment'}
                        >
                          <span className="pe-attachment-file-icon">📄</span>
                          <span className="pe-attachment-file-name">{a.name ?? 'file'}</span>
                        </span>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        )
      )}

      {(!isCollapsed || !turn.prompt) && (() => {
        const fullResponseText = getFullResponseText(turn);
        const hasCopyableText = fullResponseText.trim().length > 0;
        const hasTools = hasTurnTools(turn.events);
        const hasVisibleMessageOrCard = hasTurnVisibleMessageOrCard(turn.events, (key) => editedChunks[key]);
        const hasVisibleBody = hasTurnVisibleBody({
          hasVisibleMessageOrCard,
          hasTools,
          hideToolCalls,
        });

        return (
        <div className={`prompt-turn-response${!hasVisibleBody ? ' prompt-turn-response--no-body' : ''}`}>
          {(() => {
            const lastEvent = turn.events[turn.events.length - 1]?.event;
            // Handoff: from → to pills. Otherwise omit the agent badge when
            // the user echo already shows Sent to (duplicate).
            const fromText = prevLabel ?? prevProfileId;
            const toText = currentLabel ?? currentProfileId;
            const fallbackText = currentAgentModel ?? 'Agent Executions';
            const showAgentLabel = showTurnResponseAgentLabel({
              isHandoff,
              hasUserPrompt: !!turn.prompt,
              hasRecipientLabel: !!currentLabelOrProfile,
            });
            return (
              <div
                className={`event-group-agent${!hasVisibleBody ? ' event-group-agent--no-body' : ''}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: hasVisibleBody ? 12 : 4,
                  borderBottom: hasVisibleBody ? '1px solid var(--border)' : 'none',
                  paddingBottom: '6px'
                }}
              >
                {isHandoff ? (
                  <div className="handoff-pills">
                    <span className="handoff-pill-from" title={fromText}>{fromText}</span>
                    <span className="handoff-pill-arrow" aria-hidden="true">➜</span>
                    <span className="handoff-pill-to" title={toText}>{toText}</span>
                  </div>
                ) : showAgentLabel ? (
                  <AgentModelBadge label={currentLabelOrProfile} fallback={fallbackText} />
                ) : (
                  <span className="event-group-agent-spacer" aria-hidden />
                )}
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginLeft: 'auto' }}>
                  {canSpeakTurn && hasCopyableText && (
                    <>
                    <button
                      className="action-icon-btn"
                      title={turnSpeaking ? 'Read whole turn (replace current)' : 'Read whole turn'}
                      aria-busy={turnSpeaking || undefined}
                      style={turnSpeaking ? { color: 'var(--accent)' } : undefined}
                      onClick={() => setTurnSpeakChoiceOpen(true)}
                    >
                      <TtsSpeakIcon speaking={turnSpeaking} size={12} />
                    </button>
                    {turnSpeakChoiceOpen && (
                      <SpeakChoiceModal
                        summarizeAvailable={ttsSummarizeAvailable}
                        allowSummarizeGuidance
                        onChoose={runTurnSpeakMode}
                        onClose={() => setTurnSpeakChoiceOpen(false)}
                      />
                    )}
                    <span style={{ color: 'var(--border-hi)', fontSize: '9px' }} className="toolbar-separator">/</span>
                    </>
                  )}
                  {hasCopyableText && (
                    <>
                    <button
                      onClick={() => onCopy(`full-${turn.id}`, fullResponseText)}
                      className="copy-btn-specific"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: copiedId === `full-${turn.id}` ? 'var(--green, #10b981)' : 'var(--text-3)',
                        fontSize: '10px',
                        cursor: 'pointer',
                        fontFamily: 'var(--ui)',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        transition: 'all 0.15s'
                      }}
                      title="Copy full agent response text"
                    >
                      {copiedId === `full-${turn.id}` ? (
                        <>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                          <span className="btn-text-label">Copy Response</span>
                        </>
                      ) : (
                        <>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                          </svg>
                          <span className="btn-text-label">Copy Response</span>
                        </>
                      )}
                    </button>
                    <span style={{ color: 'var(--border-hi)', fontSize: '9px' }} className="toolbar-separator">/</span>
                    </>
                  )}
                  <button
                    onClick={() => onPrintTurn(turn.id)}
                    className="print-btn-specific"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-3)',
                      fontSize: '10px',
                      cursor: 'pointer',
                      fontFamily: 'var(--ui)',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      transition: 'all 0.15s'
                    }}
                    title="Print this response turn"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 6 2 18 2 18 9" />
                      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                    </svg>
                    <span className="btn-text-label">Print</span>
                  </button>
                  <span style={{ color: 'var(--border-hi)', fontSize: '9px' }} className="toolbar-separator">/</span>
                  <button
                    onClick={() => {
                      if (lastEvent?.id) onForkConversation?.(lastEvent.id);
                    }}
                    className="fork-btn-specific"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-3)',
                      fontSize: '10px',
                      cursor: 'pointer',
                      fontFamily: 'var(--ui)',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      transition: 'all 0.15s'
                    }}
                    title="Fork conversation up to this response"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <span className="btn-text-label">Fork</span>
                  </button>
                  <span style={{ color: 'var(--border-hi)', fontSize: '9px' }} className="toolbar-separator">/</span>
                  <div className="turn-info-anchor">
                    <button
                      type="button"
                      onClick={() => setTurnInfoOpen((o) => !o)}
                      className={`turn-info-btn${turnInfoOpen ? ' active' : ''}`}
                      title="Turn details & tool calls info"
                      aria-label="Turn details & tool calls info"
                      aria-expanded={turnInfoOpen}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span className="btn-text-label">Info</span>
                    </button>
                    {turnInfoOpen && (
                      <TurnInfoModal
                        turn={turn}
                        agentModel={currentLabelOrProfile || fallbackText}
                        elapsedMs={elapsedMs}
                        cumulativeMs={cumulativeMs}
                        isTurnActive={isTurnActive}
                        onOpenFile={onOpenFile}
                        onClose={() => setTurnInfoOpen(false)}
                      />
                    )}
                  </div>
                  {hasTools && <span style={{ color: 'var(--border-hi)', fontSize: '9px' }} className="toolbar-separator">/</span>}
                  {hasTools && (
                    <button
                      onClick={() => onToggleTools(turn.id)}
                      className={`tools-toggle-btn ${isToolsExpanded ? 'expanded' : ''}`}
                      title={isToolsExpanded ? "Collapse all tools" : "Expand all tools"}
                    >
                      <span className="tools-toggle-text">Tools</span>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="tools-toggle-chevron"
                        style={{
                          transform: isToolsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                          transition: 'transform 0.2s ease'
                        }}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
          {showPendingShimmer && (
            <div className="pending-shimmer pending-shimmer--in-response" role="status" aria-label="Agent is thinking">
              <div className="pending-shimmer-track" />
            </div>
          )}
          {(() => {
            // ponytail: build toolUseId→input (and path→input) lookups so file_change cards can show diffs
            // even when adapters omit toolUseId on the file_change event (Cursor legacy).
            const toolInputByUseId = new Map<string, Record<string, unknown>>();
            const toolNameByUseId = new Map<string, string>();
            const toolInputByPath = new Map<string, Record<string, unknown>>();
            const shellUseIds = new Set<string>();
            for (const m of turn.events) {
              if (m.event.type === 'tool_call') {
                const input = (m.event.payload.input ?? {}) as Record<string, unknown>;
                const toolName = (m.event.payload as { name?: string }).name;
                if (m.event.payload.toolUseId) {
                  toolInputByUseId.set(m.event.payload.toolUseId, input);
                  if (toolName) toolNameByUseId.set(m.event.payload.toolUseId, toolName);
                  if (isShellToolName(toolName)) {
                    shellUseIds.add(m.event.payload.toolUseId);
                  }
                }
                const pathKeys = ['path', 'file_path', 'filePath', 'TargetFile', 'AbsolutePath', 'target_file', 'filename'] as const;
                for (const k of pathKeys) {
                  const v = input[k];
                  if (typeof v === 'string' && v.trim()) {
                    toolInputByPath.set(v.trim(), input);
                    break;
                  }
                }
              }
            }
            // Settled shell ids in this turn. Call + result share a turn (no
            // prompt between them), so turn-local pairing is enough for the
            // running → done transition.
            const shellResultIds = new Set<string>();
            for (const m of turn.events) {
              if (m.event.type === 'tool_result' && m.event.payload.toolUseId && shellUseIds.has(m.event.payload.toolUseId)) {
                shellResultIds.add(m.event.payload.toolUseId);
              }
            }
            const renderItem = (i: number, keyPrefix: string, domId?: string) => {
              const m = turn.events[i];
              const eventKey = `${keyPrefix}-${m.event.seq || m.event.ts}`;
              const targetDomId = domId ?? `${turn.id}-${keyPrefix}`;
              const eventToRender: NormalisedEvent = (() => {
                if (m.event.type !== 'message') return m.event;
                const edited = editedChunks[eventKey];
                if (edited === undefined) return m.event;
                return {
                  ...m.event,
                  payload: { ...m.event.payload, chunk: edited, final: m.event.payload.final }
                };
              })();

              if (eventToRender.type === 'helper') return null;
              if (eventToRender.type === 'tool_call') {
                const run = eventToRender.payload.toolUseId
                  ? helpersByToolUseId?.get(eventToRender.payload.toolUseId)
                  : undefined;
                if (run) return <HelperLine run={run} onOpen={() => onOpenHelper?.(run.key)} eventId={`event-${eventToRender.seq || eventToRender.ts}`} />;
              }
              if (eventToRender.type === 'tool_result' && helpersByToolUseId?.has(eventToRender.payload.toolUseId)) {
                return null;
              }

              // Cross-agent spawn breadcrumb: a system message carrying a
              // spawnMarker renders as a card, not prose.
              const sm = eventToRender.type === 'message' ? eventToRender.payload.spawnMarker : undefined;
              if (sm) {
                if (sm.kind === 'heartbeat') return null;
                const cardClass = sm.kind === 'result' ? ' spawn-result' : sm.kind === 'stalled' || sm.kind === 'stopped' ? ' spawn-stalled' : sm.kind === 'denied' ? ' spawn-denied' : sm.kind === 'expired' ? ' spawn-expired' : '';
                const icon = sm.kind === 'handover' ? '⇄' : sm.kind === 'spawned' ? '⇪' : sm.kind === 'result' ? '◀' : sm.kind === 'denied' ? '✗' : sm.kind === 'expired' ? '⌛' : sm.kind === 'stopped' ? '◼' : '⚠';
                const label = sm.kind === 'handover' ? 'Grok Bot moved' : sm.kind === 'spawned' ? 'Agent Spawn' : sm.kind === 'result' ? 'Result' : sm.kind === 'denied' ? 'Spawn Denied' : sm.kind === 'expired' ? 'Spawn Expired' : sm.kind === 'stopped' ? 'Stopped' : 'Stalled';
                const childLabel = sm.childTitle ?? sm.childConversationId;
                const speakId = `${eventToRender.sessionId}:${eventToRender.seq || eventToRender.ts}`;
                const resultSpeakKey = `result-${speakId}`;
                const resultText = sm.kind === 'result' ? spawnResultSpeakText(sm.text ?? '') : '';
                const resultSpeaking = cardSpeakingKey === resultSpeakKey;
                const terminal = sm.childConversationId ? terminalSpawnMap.get(sm.childConversationId) : undefined;
                const ranLabel = (sm.kind === 'result' || sm.kind === 'stalled') && sm.durationMs != null && Number.isFinite(sm.durationMs)
                  ? `ran ${formatElapsedMs(sm.durationMs)}`
                  : null;
                return (
                  <Fragment key={i}>
                  <div className={`event-spawn-card${cardClass}`}>
                    <div className="spawn-card-header" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>
                        {icon} {label}
                        {sm.role && <span className="spawn-card-role">· {sm.role}</span>}
                        {ranLabel && <span className="spawn-card-role">· {ranLabel}</span>}
                      </span>
                      {sm.kind === 'result' && canSpeakTurn && resultText && (
                        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <button
                            type="button"
                            className="action-icon-btn"
                            title={resultSpeaking ? 'Read aloud (replace current)' : 'Read aloud'}
                            aria-busy={resultSpeaking || undefined}
                            style={resultSpeaking ? { color: 'var(--accent)' } : undefined}
                            onClick={() => openCardSpeakFlow(resultSpeakKey, resultText, speakId, 'spawn_result')}
                          >
                            <TtsSpeakIcon speaking={resultSpeaking} size={12} />
                          </button>
                          <button
                            type="button"
                            className="action-icon-btn tts-provider-cycle"
                            title={`TTS provider: ${ttsProvider} (click to cycle)`}
                            onClick={() => onCycleTtsProvider?.()}
                            style={{ fontSize: '9px', fontWeight: 700, fontFamily: 'var(--ui)', minWidth: '18px' }}
                          >
                            {providerLabel}
                          </button>
                          {cardSpeak?.key === resultSpeakKey && cardSpeak.step === 'scope' && (
                            <SpeakScopeModal onChoose={onCardScopeChoose} onClose={closeCardSpeak} />
                          )}
                          {cardSpeak?.key === resultSpeakKey && cardSpeak.step === 'mode' && (
                            <SpeakChoiceModal
                              summarizeAvailable={ttsSummarizeAvailable}
                              allowSummarizeGuidance
                              onChoose={runCardSpeakMode}
                              onClose={closeCardSpeak}
                            />
                          )}
                        </span>
                      )}
                    </div>
                    <div className="spawn-card-body">
                      {sm.kind === 'handover' && sm.text && <div className="spawn-card-text" style={{ marginBottom: 4 }}>{sm.text}</div>}
                      {sm.childConversationId
                        ? <button className="spawn-card-link" onClick={() => onOpenConversation?.(sm.childConversationId)}>{childLabel}</button>
                        : <div className="spawn-card-text">{sm.text}</div>}
                      {sm.kind === 'result' && (() => {
                        // Collapse by rendered height (CSS max-height) instead of
                        // slicing the source at N lines — slicing breaks markdown
                        // lists/fences mid-structure.
                        const isLong = resultText.length > 480 || resultText.split('\n').length > 10;
                        const expanded = !!spawnResultExpanded[sm.childConversationId];
                        const toggle = () =>
                          setSpawnResultExpanded(m => ({ ...m, [sm.childConversationId]: !expanded }));
                        return (
                          <>
                            <MarkdownBody
                              className={`spawn-card-result event-message${isLong && !expanded ? ' spawn-card-result-collapsed' : ''}`}
                              onOpenFile={onOpenFile}
                              conversationId={conversationId}
                              projectId={projectId}
                            >
                              {resultText}
                            </MarkdownBody>
                            {isLong && (
                              <button
                                className="spawn-card-toggle"
                                onClick={toggle}
                              >
                                {expanded ? 'Show Less ▴' : 'Show More ▾'}
                              </button>
                            )}
                            {onInjectText && (
                              <button
                                className="spawn-card-inject"
                                onClick={() => onInjectText(`Sub-agent result (${sm.childTitle ?? sm.childConversationId}):\n\n${resultText}`)}
                              >
                                ↳ Inject into context
                              </button>
                            )}
                          </>
                        );
                      })()}
                      {sm.workdir && <div className="spawn-card-workdir">{sm.workdir}</div>}
                    </div>
                  </div>
                  {sm.kind === 'spawned' && !!sm.childConversationId && (
                    <SpawnElapsedTimer startedAt={eventToRender.ts} role={sm.role} terminal={terminal} />
                  )}
                  </Fragment>
                );
              }

              if (
                eventToRender.type === 'message' &&
                Array.isArray((eventToRender.payload as { recalledMemories?: string[] }).recalledMemories)
              ) {
                if (m === hoistedItem) return null;
                const memIds = (eventToRender.payload as { recalledMemories?: string[] }).recalledMemories!;
                return (
                  <Fragment key={eventToRender.id || eventKey}>
                    <RecalledMemoriesChip ids={memIds} onOpenMemory={onOpenMemory} />
                  </Fragment>
                );
              }

              if (eventToRender.type === 'message' && eventToRender.payload.chunk === '' && !eventToRender.payload.files?.length) {
                return null;
              }

              const linkedToolInput = (() => {
                if (eventToRender.type !== 'file_change') return undefined;
                const tuid = eventToRender.payload.toolUseId;
                if (tuid) {
                  const byId = toolInputByUseId.get(tuid);
                  if (byId) return byId;
                }
                return toolInputByPath.get(eventToRender.payload.path);
              })();

              const isShell =
                (eventToRender.type === 'tool_call' && isShellToolName((eventToRender.payload as { name?: string }).name)) ||
                (eventToRender.type === 'tool_result' && shellUseIds.has(eventToRender.payload.toolUseId));
              const shellCommand =
                eventToRender.type === 'tool_result' && shellUseIds.has(eventToRender.payload.toolUseId)
                  ? shellCommandFromInput(toolInputByUseId.get(eventToRender.payload.toolUseId))
                  : eventToRender.type === 'tool_call' && isShellToolName((eventToRender.payload as { name?: string }).name)
                    ? shellCommandFromInput(eventToRender.payload.input as Record<string, unknown> | undefined)
                    : undefined;
              const isShellRunning =
                eventToRender.type === 'tool_call'
                && isShellToolName((eventToRender.payload as { name?: string }).name)
                && !!eventToRender.payload.toolUseId
                && !shellResultIds.has(eventToRender.payload.toolUseId);

              const sharedProps = {
                event: eventToRender,
                isStreaming:
                  agentStatus === 'running' &&
                  m.event === streamingLastEvent &&
                  !(m.event.type === 'message' && m.event.payload.final),
                forceExpandCollapse: forceTool,
                isEditing: editingEventId === eventKey,
                editText,
                onEditTextChange,
                onSave: () => onSaveEvent(eventKey),
                onCancel: () => onCancelEventEdit(),
                onEditStart: (text: string) => onEditEventStart(eventKey, text),
                onCopy: (text: string) => onCopy(eventKey, text),
                copied: copiedId === eventKey,
                onDelete: () => onDeleteEvent(m.mergedIds && m.mergedIds.length > 0 ? m.mergedIds : m.event.id),
                onPrint: () => onPrintEvent(turn.id, targetDomId),
                onOpenFile,
                onLightbox,
                lastResolveIndexByRequestId,
                answeredRequestIds,
                eventIndex: eventIndexByRef?.get(eventToRender),
                onRespond,
                linkedToolInput,
                linkedToolName:
                  eventToRender.type === 'tool_result' && eventToRender.payload.toolUseId
                    ? toolNameByUseId.get(eventToRender.payload.toolUseId)
                    : undefined,
                ttsEnabled: tts?.enabled,
                ttsProvider: tts?.provider,
                ttsSummarizeAvailable,
                onCycleTtsProvider,
                conversationId,
                projectId,
                getSpeakTail:
                  eventToRender.type === 'message' && getSpeakTailForId
                    ? () => getSpeakTailForId(`${eventToRender.sessionId}:${eventToRender.seq || eventToRender.ts}`)
                    : undefined,
                isShell,
                shellCommand,
                isShellRunning,
                onInjectText,
                highlightQuery,
                highlightFindOpts,
                highlightActive: highlightCurrentCardKey === `${turn.id}:g${i}`
                  || highlightCurrentDomId === `event-${eventToRender.seq || eventToRender.ts}`,
                highlightActiveIdx: highlightCurrentCardKey === `${turn.id}:g${i}` ? highlightActiveMatchIdx : undefined,
                findCardKey: `${turn.id}:g${i}`,
              };
              return <EventItem {...sharedProps} />;
            };

            return turn.events.map((_, i) => {
              const keyPrefix = `g${i}`;
              const domId = `${turn.id}-${keyPrefix}`;
              const node = renderItem(i, keyPrefix, domId);
              if (!node) return null;
              return (
                <div key={`g${i}`} id={domId} className="event-group">
                  {node}
                </div>
              );
            });
          })()}
          {isTurnActive && (hasResponse || showPendingShimmer) && (
            <div className="event-group-agent-footer">
              <span className="turn-footer-agent">
                <AgentModelBadge label={currentLabelOrProfile} fallback={fallbackText} />
              </span>
              <TurnLiveTimer
                turn={turn}
                previousCumulativeMs={previousCumulativeMs}
              />
            </div>
          )}
          {!isTurnActive && !turnCheckpoint && (elapsedMs != null || cumulativeMs != null) && (
            <div className="event-group-agent-footer">
              <span className="turn-footer-agent" aria-hidden />
              <TurnElapsedText turnMs={elapsedMs} cumulativeMs={cumulativeMs} subagentMs={subagentMs} waitingMs={turnWaitingMs(turn)} />
            </div>
          )}
        </div>
        );
      })()}
      {turnCheckpoint && !isTurnActive && (
        <div className="handoff-divider checkpoint-divider" role="separator" aria-label="Checkpoint">
          <span className="handoff-line" />
          <div className="handoff-divider-center">
            <span className="handoff-label">
              <span className="handoff-arrow">◆</span>
              <span className="handoff-to">
                Checkpoint{turnCheckpoint.pinned ? ' (pinned)' : ''}
                {turnCheckpoint.label ? `: ${turnCheckpoint.label}` : turnCheckpoint.kind === 'auto' ? ' (auto)' : ''}
              </span>
              {turnCheckpoint.codeRef && <span className="handoff-mode-pill">Code</span>}
              {turnCheckpoint.turnIndex != null && (
                <span className="handoff-mode-pill">Turn {turnCheckpoint.turnIndex}</span>
              )}
            </span>
            {(elapsedLabel || cumulativeLabel) && (
              <div className="handoff-subtitle">
                {elapsedLabel && (
                  <>
                    Took {elapsedLabel}
                    {subagentLabel && <> (subagents {subagentLabel})</>}
                  </>
                )}
                {cumulativeLabel && <>{elapsedLabel ? ' · ' : ''}Total {cumulativeLabel}</>}
              </div>
            )}
            {currentLabelOrProfile && (
              <div className="checkpoint-agent-line">
                <AgentModelBadge label={currentLabelOrProfile} />
              </div>
            )}
            {turnCheckpoint.promptPreview && (
              <span className="handoff-preview">
                {turnCheckpoint.promptPreview.replace(/\s+/g, ' ').trim().slice(0, 80)}
                {turnCheckpoint.promptPreview.replace(/\s+/g, ' ').trim().length > 80 ? '…' : ''}
              </span>
            )}
          </div>
          <span className="handoff-line" />
        </div>
      )}
      <FilePreviewStrip text={getFullResponseText(turn)} onOpen={onOpenFile} conversationId={conversationId} />
      {interruptDivider === 'after-turn' && <ForceInterruptDivider />}
    </div>
  );
}, turnPropsEqual);

function ForceInterruptDivider() {
  return (
    <div className="force-interrupt-divider" role="separator" aria-label="Interrupted by operator">
      <span className="force-interrupt-divider-line" />
      <span className="force-interrupt-divider-label">⚡ Interrupted by operator</span>
      <span className="force-interrupt-divider-line" />
    </div>
  );
}

/** Wall-clock wait under a spawned card. Live interval while active; freezes at final duration once finished. */
function SpawnElapsedTimer({
  startedAt,
  role,
  terminal,
}: {
  startedAt: number;
  role?: string;
  terminal?: TerminalSpawnInfo;
}) {
  const isTerminal = !!terminal;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isTerminal]);

  const elapsedMs = terminal?.durationMs != null && Number.isFinite(terminal.durationMs)
    ? terminal.durationMs
    : terminal?.endedAt != null
      ? Math.max(0, terminal.endedAt - startedAt)
      : Math.max(0, now - startedAt);

  const statusLabel = isTerminal
    ? (terminal.kind === 'stalled' ? 'stalled' : 'completed')
    : 'still running';

  return (
    <div className="spawn-heartbeat">
      ⏱ {statusLabel}{role ? ` · ${role}` : ''} · {formatElapsedMs(elapsedMs)}
    </div>
  );
}
