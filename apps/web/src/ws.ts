import { useEffect, useRef, useState, useCallback } from 'react';
import type { NormalisedEvent, ServerFrame, ClientFrame, ProfilesResponse, AgentProfile, AgentStatus, QueuedMessage, BtwUpdatedFrame, SpawnRequestUpdatedFrame, CheckpointsUpdatedFrame, DraftUpdatedFrame, GitCommitDraftUpdatedFrame, ScheduleUpdatedFrame, ConversationUpdatedFrame, ConversationsChangedFrame, GrokBotStatusFrame, RemoteHostStatusFrame, GlobalTaskUpdatedFrame, CatalogueUpdatedFrame, MemoryUpdatedFrame, EffortLevel, PromptOptions, HandoffOverride, PendingHandoffMode, SandboxSetting } from '@tierwyn/shared';
import { applyRecovery } from './statusRecovery.js';
import { lastPromptKeyForSession } from './groupTurns.js';
import { terminalAppliesToTrackedSession, sessionEndedApplies } from './liveSession.js';
import { reduceConversationUpdated, reduceSubscribe } from './wsUnread.js';
import { HEARTBEAT_STALE_MS, isHeartbeatStale, reconnectDelayMs } from './wsLiveness.js';

export type ConnState = 'connecting' | 'connected' | 'disconnected';

export interface UseWsResult {
  connState: ConnState;
  profiles: AgentProfile[];
  /** True after GET /profiles successfully applied `d.profiles` (including []).
   *  False on initial mount and when profiles are cleared on disable/disconnect. */
  profilesLoaded: boolean;
  events: NormalisedEvent[];
  currentSessionId: string | null;
  /** Per-conversation count of steer messages queued behind the running turn.
   *  Reset to 0 when the session ends (the queue drains into a follow-up turn). */
  steerQueueLengths: Record<string, number>;
  steerQueues: Record<string, QueuedMessage[]>;
  cancelSteer: (params: { conversationId: string; sessionId: string; messageId: string }) => void;
  editSteer: (params: {
    conversationId: string; sessionId: string; messageId: string; text: string;
    attachments?: { base64: string; mediaType: string; name?: string }[];
    commandName?: string;
    commandArgs?: string;
  }) => void;
  activeConversationIds: string[];
  /** Most recent activity timestamp observed via WebSocket (status changes, started/ended). */
  liveActivityAt: Record<string, number>;
  /** Live per-conversation agent status (running/idle/waiting/error/done).
   *  Populated from session_started/session_ended and status-bearing
   *  conversation_updated frames. A conversation absent from this map has
   *  never been seen by this client (sidebar renders the grey dot). */
  conversationStatuses: Record<string, AgentStatus>;
  /** Conversations whose sticky/REST error has been superseded by later
   *  non-error activity. Consumers pass `has(id)` as `errorRecovered` into
   *  resolveConversationDot so a resumed conversation stops showing red.
   *  Deliberately NOT cleared on reconnect — surviving a socket flap is the
   *  point (plan RC3). */
  errorRecoveredConversationIds: ReadonlySet<string>;
  /** Conversations the WS layer has touched this page session. Once observed,
   *  an empty conversationStatuses entry means not-live — ignore stale REST
   *  liveStatus (parked hold-open after status:done). */
  wsObservedConversationIds: ReadonlySet<string>;
  unreadConversationIds: string[];
  clearUnread: (conversationId: string) => void;
  /** Drop a sticky terminal error/done status and mark the conversation recovered,
   *  matching subscribe's acknowledgement without opening the conversation. */
  acknowledgeConversationError: (conversationId: string) => void;
  setEvents: (events: NormalisedEvent[] | ((prev: NormalisedEvent[]) => NormalisedEvent[])) => void;
  flushEvents: () => void;
  isSocketOpen: () => boolean;
  /** Re-fetch /profiles (e.g. after catalogue edits) so the selector updates. */
  refreshProfiles: () => void;
  subscribe: (conversationId: string) => void;
  sendPrompt: (params: {
    projectId: string; conversationId: string; profileId: string;
    agent: string; model: string; text: string;
    attachments?: { base64: string; mediaType: string }[];
    /** One-shot resume-plan override, honoured directly server-side regardless
     *  of global handoffMode: skips native resume; 'fresh' resets context. */
    handoffOverride?: HandoffOverride;
    /** Effective (client-clamped) effort level for this turn. */
    effort?: EffortLevel;
    /** One-shot per-turn adapter options (client-sanitised; server re-sanitises). */
    options?: PromptOptions;
  }) => boolean;
  sendCommand: (params: {
    projectId: string; conversationId: string; profileId: string;
    agent: string; model: string; name: string; args?: string;
    attachments?: { base64: string; mediaType: string; name?: string }[];
    handoffOverride?: HandoffOverride;
    /** Effective (client-clamped) effort level for this turn. */
    effort?: EffortLevel;
    /** One-shot per-turn adapter options (client-sanitised; server re-sanitises). */
    options?: PromptOptions;
  }) => boolean;
  /** Send an additional message into a live turn. The server decides whether to
   *  inject it mid-turn or queue it for a follow-up turn.
   *  `intent` selects Queue vs Interrupt & Send vs auto (live-inject). */
  sendSteer: (params: {
    conversationId: string; sessionId: string; text: string;
    attachments?: { base64: string; mediaType: string; name?: string }[];
    intent?: 'auto' | 'queue' | 'force';
    commandName?: string;
    commandArgs?: string;
    handoffOverride?: HandoffOverride;
  }) => boolean;
  /** Prompt event ids of turns that received Interrupt & Send this page
   *  session — drives the live "Interrupted by operator" divider
   *  (render-time only). Snapshotted at sendSteer(intent:'force') so a
   *  late force_steered cannot retarget the line onto the follow-up turn.
   *  Keyed on prompt *id* (not seq): server-written prompts persist as
   *  seq:0, so seq-matching would paint ⚡ on every later soft-cancel turn. */
  forceInterruptedPromptIds: ReadonlySet<string>;
  /** Ephemeral toast after Interrupt & Send. */
  forceSteerToast: string | null;
  clearForceSteerToast: () => void;
  /** Stop the agent for the given conversation. Sends immediately if a
   *  session id is known; otherwise queues the stop to fire when the
   *  pending `session_started` frame arrives. If there is nothing to stop,
   *  surfaces a synthetic `stop_result` so the UI can react. */
  requestStop: (conversationId: string) => void;
  /** Stop an arbitrary session by id (Active Agents modal). Unlike
   *  requestStop, this does not depend on the subscribed conversation —
   *  the server's `stop` handler is already keyed by sessionId alone. */
  stopSessionById: (sessionId: string) => void;
  /** Conversation id of an in-flight prompt awaiting its `session_started`
   *  frame. Drives the optimistic Stop-button visibility in the header. */
  pendingPromptConversationId: string | null;
  /** Last `stop_result` received from the server (or synthetic). Auto-cleared
   *  after 8s. UI surfaces failures via alert(). */
  stopResult: { sessionId: string; success: boolean; message?: string; reason?: string } | null;
  clearStopResult: () => void;
  sendInteractionResponse: (params: {
    conversationId: string; sessionId: string; requestId: string;
    selection: string[]; text?: string; answers?: { selection: string[]; text?: string }[];
  }) => void;
  /** One-shot latency probe over the live socket. Resolves with RTT in ms, or
   *  rejects on timeout / socket not open (counted as a lost sample).
   *  On-demand only — nothing calls this on a timer. */
  pingOnce: (options?: number | { timeoutMs?: number }) => Promise<number>;
  /** Conversations whose native CLI helpers are still running (sidebar ring). */
  helpersRunningIds: ReadonlySet<string>;
  stopHelper: (conversationId: string, taskId: string) => void;
}

// ponytail: route WS through the same host that served the page. Dev = Vite
// proxy on :5173; prod = NPM on :443. Cookie rides on the upgrade either way.
export const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

interface UseWsOptions {
  /** When false the hook will not open a WebSocket or fetch /profiles. */
  enabled: boolean;
  /** Called when the server rejects the WS upgrade with 401 (session expired). */
  onUnauthorized?: () => void;
  /** Called when session_started fires for a conversation other than the
   *  currently-subscribed one — e.g. a spawned child starting its agent.
   *  Use to trigger sidebar refetches so new conversations appear immediately. */
  onExternalSessionStarted?: () => void;
  /** Called when a /btw answer completes (or errors). Client refetches the btw
   *  list. Only fires for the currently-subscribed conversation. */
  onBtwUpdated?: (frame: BtwUpdatedFrame) => void;
  /** Called when a spawn request is created/approved/denied/expired. Client
   *  refetches GET /spawn/requests (unscoped — the queue is operator-global).
   *  Fires regardless of which conversation is currently subscribed. */
  onSpawnRequestUpdated?: (frame: SpawnRequestUpdatedFrame) => void;
  /** Called when checkpoints change for the subscribed conversation. */
  onCheckpointsUpdated?: (frame: CheckpointsUpdatedFrame) => void;
  /** Called when another device updates the draft for the subscribed conversation. */
  onDraftUpdated?: (frame: DraftUpdatedFrame) => void;
  /** Called when a background commit-message generation settles. Operator-global
   *  broadcast — the Git modal filters by cwd. */
  onGitCommitDraftUpdated?: (frame: GitCommitDraftUpdatedFrame) => void;
  /** Called when a schedule job/run/step changes (operator-global broadcast). */
  onScheduleUpdated?: (frame: ScheduleUpdatedFrame) => void;
  /** Called when conversation_updated carries title and/or description
   *  and/or tags and/or archived and/or sandbox (metadata-change broadcasts only).
   *  Absence of a field = unchanged. */
  onConversationMeta?: (meta: {
    conversationId: string; title?: string; description?: string; tags?: string[];
    designation?: string | null; archived?: boolean;
    pendingHandoffMode?: PendingHandoffMode | null;
    sandbox?: SandboxSetting | null;
  }) => void;
  /** Called for every conversation_updated frame (status, meta, or activity). */
  onConversationUpdated?: (frame: ConversationUpdatedFrame) => void;
  /** Grok Bot supervisor transitions (operator-global). */
  onGrokBotStatus?: (frame: GrokBotStatusFrame) => void;
  /** Remote host connect/disconnect (operator-global). */
  onRemoteHostStatus?: (frame: RemoteHostStatusFrame) => void;
  /** Global Tasks updates (operator-global). */
  onGlobalTaskUpdated?: (frame: GlobalTaskUpdatedFrame) => void;
  /** Agent catalogue / models updated (operator-global). */
  onCatalogueUpdated?: (frame: CatalogueUpdatedFrame) => void;
  /** Memory saved, superseded, flagged or reviewed (operator-global). */
  onMemoryUpdated?: (frame: MemoryUpdatedFrame) => void;
  /** Operator-global: conversation rows created, deleted or moved. */
  onConversationsChanged?: (frame: ConversationsChangedFrame) => void;
}

export function useWs({ enabled, onUnauthorized, onExternalSessionStarted, onBtwUpdated, onSpawnRequestUpdated, onCheckpointsUpdated, onDraftUpdated, onGitCommitDraftUpdated, onScheduleUpdated, onConversationMeta, onConversationUpdated, onGrokBotStatus, onRemoteHostStatus, onGlobalTaskUpdated, onCatalogueUpdated, onMemoryUpdated, onConversationsChanged }: UseWsOptions): UseWsResult {
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [events, setEvents] = useState<NormalisedEvent[]>([]);
  const [currentSessionId, setCurrentSessionIdState] = useState<string | null>(null);
  // Ref mirrors currentSessionId so onmessage can compare without being a dep of connect.
  // Written synchronously with the state: a useEffect mirror lags a render, so a
  // reaped hold-open's late idle/session_ended arriving right after the new
  // session_started was matched against the OLD id and wiped the new turn's
  // running state (thinking bar vanished before the first token).
  const currentSessionIdRef = useRef<string | null>(null);
  const setCurrentSessionId = useCallback((id: string | null) => {
    currentSessionIdRef.current = id;
    setCurrentSessionIdState(id);
  }, []);
  const [activeConversationIds, setActiveConversationIds] = useState<string[]>([]);
  const [conversationStatuses, setConversationStatuses] = useState<Record<string, AgentStatus>>({});
  const [liveActivityAt, setLiveActivityAt] = useState<Record<string, number>>({});
  const recordLiveActivity = useCallback((cid: string, ts?: number) => {
    if (!cid) return;
    const time = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : Date.now();
    setLiveActivityAt((prev) => {
      if (prev[cid] === time) return prev;
      return { ...prev, [cid]: time };
    });
  }, []);
  const [errorRecoveredIds, setErrorRecoveredIds] = useState<ReadonlySet<string>>(() => new Set());
  const [wsObservedIds, setWsObservedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [helpersRunningIds, setHelpersRunningIds] = useState<ReadonlySet<string>>(() => new Set());
  const markWsObserved = useCallback((...ids: string[]) => {
    if (ids.length === 0) return;
    setWsObservedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ids) {
        if (!id || next.has(id)) continue;
        next.add(id);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);
  const [steerQueueLengths, setSteerQueueLengths] = useState<Record<string, number>>({});
  const [steerQueues, setSteerQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [forceInterruptedPromptIds, setForceInterruptedPromptIds] = useState<ReadonlySet<string>>(() => new Set());
  const [forceSteerToast, setForceSteerToast] = useState<string | null>(null);
  const forceSteerToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `events` so steer_result can snapshot the live turn's prompt id
  // without waiting for a re-render (onmessage closes over a stale render).
  const eventsRef = useRef<NormalisedEvent[]>([]);
  const [unreadConversationIds, setUnreadConversationIds] = useState<string[]>([]);
  const unreadConversationIdsRef = useRef<string[]>([]);
  useEffect(() => { unreadConversationIdsRef.current = unreadConversationIds; }, [unreadConversationIds]);
  // Terminal done/error observed while this client was subscribed. Promoted
  // to unread when the operator leaves (parked hold-open must not suppress blue).
  const pendingLeaveUnreadRef = useRef<ReadonlySet<string>>(new Set());
  // Conversation id of an in-flight prompt — set on sendPrompt, cleared on
  // session_started/session_ended/onclose. Drives the optimistic Stop-button.
  const [pendingPromptConversationId, setPendingPromptConversationId] = useState<string | null>(null);
  // Last stop_result received from the server (or synthetic). Auto-cleared
  // after 8s. UI surfaces failures via alert() in App.tsx.
  const [stopResult, setStopResult] = useState<{ sessionId: string; success: boolean; message?: string; reason?: string } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Correlation map for in-flight latency probes. Entries are removed on pong,
  // timeout, or close/error — it is empty whenever the modal is closed.
  const pendingPingsRef = useRef<Map<string, {
    resolve: (rtt: number) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>(new Map());
  const subscribedRef = useRef<string | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastHeartbeatRef = useRef<number>(Date.now());
  const stalenessRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Ref mirrors pendingPromptConversationId so requestStop/sendPrompt can
  // read/write without being a dep of connect.
  const pendingPromptRef = useRef<string | null>(null);
  // Set when the user clicks Stop during the pending window. Drained when
  // session_started arrives so the actual stop fires the instant the server
  // assigns a session id.
  const queuedStopRef = useRef<string | null>(null);
  // Timer for the stopResult auto-clear. Stored so clearStopResult can cancel.
  const stopResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set before intentional close to prevent onclose from scheduling a reconnect
  const closingRef = useRef(false);
  // ponytail: rAF-batch incoming `event` frames so a burst of N token frames
  // becomes one setEvents append per animation frame instead of N array copies.
  const eventBufferRef = useRef<NormalisedEvent[]>([]);
  const flushScheduledRef = useRef(false);
  const flushRafRef = useRef<number | null>(null);
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { eventsRef.current = events; }, [events]);

  // Append buffered events in one shot and clear the schedule. Stable identity
  // ([] deps: setEvents and refs are stable) so connect() can depend on it
  // without churning.
  const flushEvents = useCallback(() => {
    if (flushRafRef.current !== null) { cancelAnimationFrame(flushRafRef.current); flushRafRef.current = null; }
    if (flushTimeoutRef.current !== null) { clearTimeout(flushTimeoutRef.current); flushTimeoutRef.current = null; }
    flushScheduledRef.current = false;
    if (eventBufferRef.current.length === 0) return;
    const batch = eventBufferRef.current;
    eventBufferRef.current = [];
    setEvents((prev) => {
      const next = [...prev, ...batch];
      eventsRef.current = next;
      return next;
    });
    // Keep conversationStatuses aligned with the subscribed conversation's
    // status stream so a recovery turn (done/idle) clears a sticky error that
    // session_ended preserved — even if conversation_updated ordering lags.
    const lastStatus = [...batch].reverse().find((e) => e.type === 'status');
    const cid = subscribedRef.current;
    if (lastStatus?.type === 'status' && cid) {
      const s = lastStatus.payload.status;
      if ((s === 'done' || s === 'idle' || s === 'error') && pendingPromptRef.current === cid) {
        pendingPromptRef.current = null;
        setPendingPromptConversationId(null);
      }
      markWsObserved(cid);
      recordLiveActivity(cid);
      setConversationStatuses((prev) => {
        if (s === 'running' || s === 'waiting' || s === 'error') {
          return { ...prev, [cid]: s };
        }
        if (s === 'done' || s === 'idle') {
          if (!terminalAppliesToTrackedSession(currentSessionIdRef.current, lastStatus.sessionId)) {
            return prev;
          }
          if (!(cid in prev)) return prev;
          const next = { ...prev };
          delete next[cid];
          return next;
        }
        return prev;
      });
      setErrorRecoveredIds((prev) => applyRecovery(prev, cid, s));
    }
  }, [markWsObserved]);

  // Drop any pending flush (and buffered events) on teardown/reconnect so a
  // stale rAF/timeout doesn't append into a different conversation's stream.
  const cancelFlush = useCallback(() => {
    if (flushRafRef.current !== null) { cancelAnimationFrame(flushRafRef.current); flushRafRef.current = null; }
    if (flushTimeoutRef.current !== null) { clearTimeout(flushTimeoutRef.current); flushTimeoutRef.current = null; }
    flushScheduledRef.current = false;
    eventBufferRef.current = [];
  }, []);

  const sendFrame = useCallback((frame: ClientFrame): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  const isSocketOpen = useCallback(() => wsRef.current?.readyState === WebSocket.OPEN, []);

  const subscribe = useCallback((conversationId: string) => {
    // ponytail: drain any in-flight event buffer for the previous conversation
    // so a sub-16ms race between buffer-push and flush doesn't leak old events
    // into the new conversation's state. Transcript refetch merges
    // (transcriptMerge.ts), and this keeps the race window zero.
    cancelFlush();
    const next = reduceSubscribe({
      subscribedId: subscribedRef.current,
      unreadIds: unreadConversationIdsRef.current,
      pendingLeaveUnread: pendingLeaveUnreadRef.current,
    }, conversationId);
    subscribedRef.current = conversationId;
    pendingLeaveUnreadRef.current = next.pendingLeaveUnread;
    unreadConversationIdsRef.current = [...next.unreadIds];
    sendFrame({ type: 'subscribe', conversationId });
    setUnreadConversationIds([...next.unreadIds]);
    // Server-side markConversationViewed() runs on the subscribe frame; this
    // mirrors it client-side so the dot drops to grey immediately, without
    // waiting for a listConversations refetch. Only terminal states (the
    // ones session_ended deliberately preserves at ws.ts:192-198) are
    // cleared — running/waiting stay so opening an active conversation
    // doesn't momentarily drop the amber dot.
    setConversationStatuses((prev) => {
      const s = prev[conversationId];
      if (s !== 'error' && s !== 'done') return prev;
      const nextStatuses = { ...prev };
      delete nextStatuses[conversationId];
      return nextStatuses;
    });
    // Opening the conversation acknowledges prior errors (mirrors markConversationViewed).
    setErrorRecoveredIds((prev) => applyRecovery(prev, conversationId, 'activity'));
  }, [sendFrame, cancelFlush]);

  const clearUnread = useCallback((conversationId: string) => {
    setUnreadConversationIds((prev) => {
      const next = prev.filter((id) => id !== conversationId);
      unreadConversationIdsRef.current = next;
      return next;
    });
  }, []);

  const acknowledgeConversationError = useCallback((conversationId: string) => {
    setConversationStatuses((prev) => {
      if (prev[conversationId] !== 'error' && prev[conversationId] !== 'done') return prev;
      const nextStatuses = { ...prev };
      delete nextStatuses[conversationId];
      return nextStatuses;
    });
    setErrorRecoveredIds((prev) => applyRecovery(prev, conversationId, 'activity'));
  }, []);

  // Refs to callbacks so connect() doesn't need them as deps
  const onUnauthorizedRef = useRef(onUnauthorized);
  useEffect(() => { onUnauthorizedRef.current = onUnauthorized; }, [onUnauthorized]);
  const onExternalSessionStartedRef = useRef(onExternalSessionStarted);
  useEffect(() => { onExternalSessionStartedRef.current = onExternalSessionStarted; }, [onExternalSessionStarted]);
  const onBtwUpdatedRef = useRef(onBtwUpdated);
  useEffect(() => { onBtwUpdatedRef.current = onBtwUpdated; }, [onBtwUpdated]);
  const onSpawnRequestUpdatedRef = useRef(onSpawnRequestUpdated);
  useEffect(() => { onSpawnRequestUpdatedRef.current = onSpawnRequestUpdated; }, [onSpawnRequestUpdated]);
  const onCheckpointsUpdatedRef = useRef(onCheckpointsUpdated);
  useEffect(() => { onCheckpointsUpdatedRef.current = onCheckpointsUpdated; }, [onCheckpointsUpdated]);
  const onDraftUpdatedRef = useRef(onDraftUpdated);
  useEffect(() => { onDraftUpdatedRef.current = onDraftUpdated; }, [onDraftUpdated]);
  const onGitCommitDraftUpdatedRef = useRef(onGitCommitDraftUpdated);
  useEffect(() => { onGitCommitDraftUpdatedRef.current = onGitCommitDraftUpdated; }, [onGitCommitDraftUpdated]);
  const onScheduleUpdatedRef = useRef(onScheduleUpdated);
  useEffect(() => { onScheduleUpdatedRef.current = onScheduleUpdated; }, [onScheduleUpdated]);
  const onConversationMetaRef = useRef(onConversationMeta);
  useEffect(() => { onConversationMetaRef.current = onConversationMeta; }, [onConversationMeta]);
  const onConversationUpdatedRef = useRef(onConversationUpdated);
  useEffect(() => { onConversationUpdatedRef.current = onConversationUpdated; }, [onConversationUpdated]);
  const onGrokBotStatusRef = useRef(onGrokBotStatus);
  useEffect(() => { onGrokBotStatusRef.current = onGrokBotStatus; }, [onGrokBotStatus]);
  const onRemoteHostStatusRef = useRef(onRemoteHostStatus);
  useEffect(() => { onRemoteHostStatusRef.current = onRemoteHostStatus; }, [onRemoteHostStatus]);
  const onGlobalTaskUpdatedRef = useRef(onGlobalTaskUpdated);
  useEffect(() => { onGlobalTaskUpdatedRef.current = onGlobalTaskUpdated; }, [onGlobalTaskUpdated]);
  const onCatalogueUpdatedRef = useRef(onCatalogueUpdated);
  useEffect(() => { onCatalogueUpdatedRef.current = onCatalogueUpdated; }, [onCatalogueUpdated]);
  const onMemoryUpdatedRef = useRef(onMemoryUpdated);
  useEffect(() => { onMemoryUpdatedRef.current = onMemoryUpdated; }, [onMemoryUpdated]);
  const onConversationsChangedRef = useRef(onConversationsChanged);
  useEffect(() => { onConversationsChangedRef.current = onConversationsChanged; }, [onConversationsChanged]);

  const connect = useCallback(() => {
    closingRef.current = false;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    // Track whether the handshake succeeded so we can distinguish a rejected
    // upgrade (401) from a normal mid-session disconnect.
    let handshakeCompleted = false;

    ws.onopen = () => {
      handshakeCompleted = true;
      reconnectAttemptRef.current = 0;
      lastHeartbeatRef.current = Date.now();
      setConnState('connected');
      if (subscribedRef.current) sendFrame({ type: 'subscribe', conversationId: subscribedRef.current });
      if (stalenessRef.current) clearInterval(stalenessRef.current);
      stalenessRef.current = setInterval(() => {
        if (isHeartbeatStale(lastHeartbeatRef.current, Date.now(), HEARTBEAT_STALE_MS)) ws.close();
      }, 15_000);
    };

    ws.onmessage = (e) => {
      lastHeartbeatRef.current = Date.now();
      try {
        const frame: ServerFrame = JSON.parse(e.data as string);
        if (frame.type === 'heartbeat') { /* liveness recorded above */ }
        else if (frame.type === 'pong') {
          const pending = pendingPingsRef.current.get(frame.id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingPingsRef.current.delete(frame.id);
            pending.resolve(Date.now() - frame.clientTs);
          }
        }
        else if (frame.type === 'active_sessions') {
          const ids: string[] = [];
          const statuses: Record<string, AgentStatus> = {};
          const helperIds = new Set<string>();
          for (const s of frame.sessions) {
            ids.push(s.conversationId);
            statuses[s.conversationId] = s.status;
            recordLiveActivity(s.conversationId);
            if ((s.helpersRunning ?? 0) > 0) helperIds.add(s.conversationId);
            if (s.conversationId === subscribedRef.current) {
              setCurrentSessionId(s.sessionId);
            }
          }
          setHelpersRunningIds(helperIds);
          setActiveConversationIds((prev) => {
            const merged = new Set([...prev, ...ids]);
            return merged.size === prev.length ? prev : [...merged];
          });
          setConversationStatuses((prev) => ({ ...prev, ...statuses }));
          markWsObserved(...Object.keys(statuses));
          // Reconnect re-advertise: treat live session statuses as recovery
          // signals (running/waiting clear sticky error; error un-recovers).
          setErrorRecoveredIds((prev) => {
            let next = prev;
            for (const [cid, status] of Object.entries(statuses)) {
              next = applyRecovery(next, cid, status);
            }
            return next;
          });
        }
        else if (frame.type === 'event' && frame.conversationId === subscribedRef.current) {
          // Buffer + flush once per frame. setTimeout(250ms) is a fallback for
          // backgrounded tabs where rAF is parked — worst case a delayed flush
          // on refocus; events also persist server-side. Whichever fires first
          // wins; flushEvents clears both and the scheduled flag.
          eventBufferRef.current.push(frame.event);
          // Status must not wait on rAF: after hold-open done, conversation_updated
          // clears the WS map immediately while a buffered `running` tail keeps
          // the composer in steer mode. Flush now so eventsStatus matches.
          if (frame.event.type === 'status') {
            flushEvents();
            return;
          }
          if (!flushScheduledRef.current) {
            flushScheduledRef.current = true;
            flushRafRef.current = requestAnimationFrame(flushEvents);
            flushTimeoutRef.current = setTimeout(flushEvents, 250);
          }
        }
        else if (frame.type === 'session_started') {
          if (frame.conversationId === subscribedRef.current) {
            setCurrentSessionId(frame.sessionId);
          } else {
            // A session started for a conversation we're not subscribed to
            // (e.g. a spawned child). Trigger a sidebar refetch so it appears.
            onExternalSessionStartedRef.current?.();
          }
          setActiveConversationIds((prev) =>
            prev.includes(frame.conversationId) ? prev : [...prev, frame.conversationId]
          );
          // New session starts running immediately; sidebar mirrors amber dot.
          setConversationStatuses((prev) => ({ ...prev, [frame.conversationId]: 'running' }));
          recordLiveActivity(frame.conversationId);
          markWsObserved(frame.conversationId);
          setErrorRecoveredIds((prev) => applyRecovery(prev, frame.conversationId, 'activity'));
          // Drain queued stop: if the user clicked Stop during the pending
          // window (before session_started arrived), fire the actual stop now
          // that the server has assigned a session id.
          if (queuedStopRef.current === frame.conversationId) {
            const stopSessionId = frame.sessionId;
            queuedStopRef.current = null;
            sendFrame({ type: 'stop', sessionId: stopSessionId });
          }
          // Clear pending state for this conversation — the session is now live.
          if (pendingPromptRef.current === frame.conversationId) {
            pendingPromptRef.current = null;
            setPendingPromptConversationId(null);
          }
        } else if (frame.type === 'session_ended') {
          const endedCurrent = sessionEndedApplies(
            subscribedRef.current,
            frame.conversationId,
            currentSessionIdRef.current,
            frame.sessionId,
          );
          if (frame.sessionId === currentSessionIdRef.current) {
            setCurrentSessionId(null);
          }
          // A late session_ended from a reaped hold-open or overlapping mesh
          // wake must not tear down the live session's Stop/dot/steer state.
          setHelpersRunningIds((prev) => {
            if (!prev.has(frame.conversationId)) return prev;
            const next = new Set(prev);
            next.delete(frame.conversationId);
            return next;
          });
          if (endedCurrent) {
          setActiveConversationIds((prev) => prev.filter((id) => id !== frame.conversationId));
          // Preserve 'error' across session end so a failed turn keeps showing
          // red — matching the chat-title badge, which derives from events[].
          // All other statuses (running, waiting, done) get cleared so the
          // sidebar falls back to: green via isUnread (non-subscribed convs
          // with a fresh response), or grey default (subscribed conv the user
          // is already viewing). The header pill handles the brief green pulse
          // for the just-completed turn via `recentlyCompleted` in App.tsx.
          markWsObserved(frame.conversationId);
          recordLiveActivity(frame.conversationId);
          setConversationStatuses((prev) => {
            if (prev[frame.conversationId] === 'error') return prev;
            if (!(frame.conversationId in prev)) return prev;
            const next = { ...prev };
            delete next[frame.conversationId];
            return next;
          });
          setSteerQueueLengths((prev) => {
            if (!(frame.conversationId in prev)) return prev;
            const next = { ...prev };
            delete next[frame.conversationId];
            return next;
          });
          setSteerQueues((prev) => {
            if (!(frame.conversationId in prev)) return prev;
            const next = { ...prev };
            delete next[frame.conversationId];
            return next;
          });
          // Clear pending state — the run is over, no more session to stop.
          if (pendingPromptRef.current === frame.conversationId) {
            pendingPromptRef.current = null;
            setPendingPromptConversationId(null);
          }
          // Bail any queued stop for this conversation; there is no session to
          // stop anymore (the server already ended it).
          if (queuedStopRef.current === frame.conversationId) {
            queuedStopRef.current = null;
          }
          }
        } else if (frame.type === 'stop_result') {
          // Server reply to our stop frame. Auto-clear after 8s; UI alerts on
          // failure. Synthetic results (sessionId='') use the same path.
          if (stopResultTimerRef.current) clearTimeout(stopResultTimerRef.current);
          setStopResult({
            sessionId: frame.sessionId,
            success: frame.success,
            message: frame.message,
            reason: frame.reason,
          });
          stopResultTimerRef.current = setTimeout(() => {
            setStopResult(null);
            stopResultTimerRef.current = null;
          }, 8_000);
        } else if (frame.type === 'steer_queued') {
          setSteerQueueLengths((prev) => ({ ...prev, [frame.conversationId]: frame.queueLength }));
        } else if (frame.type === 'steer_queue') {
          setSteerQueues((prev) => ({ ...prev, [frame.conversationId]: frame.queue }));
          setSteerQueueLengths((prev) => ({ ...prev, [frame.conversationId]: frame.queue.length }));
        } else if (frame.type === 'steer_result') {
          // Failure surfaces via App's alert path; queued count comes from
          // steer_queued broadcasts. Nothing to track here for the happy path,
          // but surface a hard failure so the user isn't left guessing.
          if (frame.mode === 'not_found' || frame.mode === 'error') {
            // eslint-disable-next-line no-console
            console.warn('steer failed:', frame.mode, frame.message);
          } else if (frame.mode === 'force_steered') {
            // Divider key is snapshotted at sendSteer(intent:'force') so a
            // late force_steered (after the follow-up prompt is already in
            // the buffer) cannot retarget the ⚡ line onto the new turn.
            if (forceSteerToastTimerRef.current) clearTimeout(forceSteerToastTimerRef.current);
            setForceSteerToast('Turn interrupted — sending now');
            forceSteerToastTimerRef.current = setTimeout(() => {
              setForceSteerToast(null);
              forceSteerToastTimerRef.current = null;
            }, 4_000);
          }
        } else if (frame.type === 'interaction_result') {
          if (!frame.accepted) {
            // ponytail: emit interaction_resolved so the UI disables the prompt
            // instead of silently failing. Reuses the existing payload shape.
            const conversationId = subscribedRef.current;
            if (conversationId) {
              flushEvents();  // flush any pending events first
              eventBufferRef.current.push({
                type: 'interaction_resolved',
                sessionId: frame.sessionId,
                seq: 0,
                ts: Date.now(),
                sender: 'system',
                payload: {
                  requestId: frame.requestId,
                  selection: ['deny'],
                  resolution: 'expired' as const,
                },
              } as any);
              flushEvents();
            }
            // eslint-disable-next-line no-console
            console.warn('interaction rejected', frame.reason, frame.message);
          }
        } else if (frame.type === 'btw_updated') {
          // ponytail: carries no answer text — client refetches the btw list on receipt.
          if (frame.conversationId === subscribedRef.current) {
            onBtwUpdatedRef.current?.(frame);
          }
        } else if (frame.type === 'spawn_request_updated') {
          // Operator-global signal: the approval queue lives across ALL
          // conversations, so this frame is delivered regardless of which
          // conversation (if any) is currently subscribed. Client refetches
          // GET /spawn/requests (unscoped) on receipt.
          onSpawnRequestUpdatedRef.current?.(frame);
        } else if (frame.type === 'checkpoints_updated') {
          if (frame.conversationId === subscribedRef.current) {
            onCheckpointsUpdatedRef.current?.(frame);
          }
        } else if (frame.type === 'draft_updated') {
          if (frame.conversationId === subscribedRef.current) {
            onDraftUpdatedRef.current?.(frame);
          }
        } else if (frame.type === 'git_commit_draft_updated') {
          onGitCommitDraftUpdatedRef.current?.(frame);
        } else if (frame.type === 'schedule_updated') {
          // Mid-run agent status: keep conversationStatuses authoritative so
          // Schedules tree / ScheduleBrowser dots update without a full REST refetch.
          // Same set/clear rules as conversation_updated status.
          if (frame.conversationId && frame.agentStatus !== undefined) {
            const cid = frame.conversationId;
            const s = frame.agentStatus;
            markWsObserved(cid);
            recordLiveActivity(cid);
            setConversationStatuses((prev) => {
              if (s === 'done' || s === 'idle') {
                if (!(cid in prev)) return prev;
                const next = { ...prev };
                delete next[cid];
                return next;
              }
              if (s === 'running' || s === 'waiting' || s === 'error') {
                return { ...prev, [cid]: s };
              }
              return prev;
            });
            setErrorRecoveredIds((prev) => applyRecovery(prev, cid, s));
          }
          // Operator-global: delivered regardless of conversation subscription.
          onScheduleUpdatedRef.current?.(frame);
        } else if (frame.type === 'grokbot_status') {
          onGrokBotStatusRef.current?.(frame);
        } else if (frame.type === 'remote_host_status') {
          onRemoteHostStatusRef.current?.(frame);
        } else if (frame.type === 'global_task_updated') {
          onGlobalTaskUpdatedRef.current?.(frame);
        } else if (frame.type === 'catalogue_updated') {
          refreshProfiles();
          onCatalogueUpdatedRef.current?.(frame);
        } else if (frame.type === 'memory_updated') {
          onMemoryUpdatedRef.current?.(frame);
        } else if (frame.type === 'conversations_changed') {
          if (frame.deletedIds?.length) {
            const gone = new Set(frame.deletedIds);
            setConversationStatuses((prev) => {
              let changed = false;
              const next = { ...prev };
              for (const id of gone) {
                if (id in next) { delete next[id]; changed = true; }
              }
              return changed ? next : prev;
            });
            setErrorRecoveredIds((prev) => {
              let changed = false;
              const next = new Set(prev);
              for (const id of gone) {
                if (next.delete(id)) changed = true;
              }
              return changed ? next : prev;
            });
            setUnreadConversationIds((prev) => {
              const next = prev.filter((id) => !gone.has(id));
              if (next.length === prev.length) return prev;
              unreadConversationIdsRef.current = next;
              return next;
            });
          }
          onConversationsChangedRef.current?.(frame);
        } else if (frame.type === 'timers_changed') {
          // Same window event the local create/cancel paths fire — the composer
          // chip row and other listeners refetch for their conversation.
          for (const conversationId of frame.conversationIds) {
            window.dispatchEvent(new CustomEvent('conversation-timers-changed', { detail: { conversationId } }));
          }
        } else if (frame.type === 'conversation_updated') {
          onConversationUpdatedRef.current?.(frame);
          if (frame.title !== undefined || frame.description !== undefined || frame.tags !== undefined || frame.archived !== undefined || frame.designation !== undefined || frame.pendingHandoffMode !== undefined || frame.sandbox !== undefined) {
            onConversationMetaRef.current?.({
              conversationId: frame.conversationId,
              title: frame.title, description: frame.description, tags: frame.tags,
              designation: frame.designation, archived: frame.archived,
              pendingHandoffMode: frame.pendingHandoffMode,
              sandbox: frame.sandbox,
            });
          }
          {
            const next = reduceConversationUpdated({
              subscribedId: subscribedRef.current,
              unreadIds: unreadConversationIdsRef.current,
              pendingLeaveUnread: pendingLeaveUnreadRef.current,
            }, frame);
            pendingLeaveUnreadRef.current = next.pendingLeaveUnread;
            const prevUnread = unreadConversationIdsRef.current;
            if (next.unreadIds.length !== prevUnread.length
              || next.unreadIds.some((id, i) => id !== prevUnread[i])) {
              unreadConversationIdsRef.current = [...next.unreadIds];
              setUnreadConversationIds([...next.unreadIds]);
            }
          }
          if (frame.helpersRunning !== undefined) {
            const n = frame.helpersRunning;
            const cid = frame.conversationId;
            setHelpersRunningIds((prev) => {
              const has = prev.has(cid);
              if (n > 0 && has) return prev;
              if (n <= 0 && !has) return prev;
              const next = new Set(prev);
              if (n > 0) next.add(cid);
              else next.delete(cid);
              return next;
            });
          }
          // Only update tracked status when the server actually sent one
          // (non-status broadcasts must not erase the last known value).
          if (frame.status !== undefined) {
            const s = frame.status;
            markWsObserved(frame.conversationId);
            recordLiveActivity(frame.conversationId);
            setConversationStatuses((prev) => {
              // Recovery path: a later non-error status supersedes sticky error.
              if (s === 'done' || s === 'idle') {
                const next = { ...prev };
                delete next[frame.conversationId];
                return next;
              }
              return { ...prev, [frame.conversationId]: s };
            });
            setErrorRecoveredIds((prev) => applyRecovery(prev, frame.conversationId, s));
          }
        }
      } catch { /* ignore */ }
    };

    ws.onclose = (ev) => {
      if (stalenessRef.current) { clearInterval(stalenessRef.current); stalenessRef.current = null; }
      // Orphaned WS — StrictMode remount or explicit reconnect replaced this one
      // before its async close handshake fired. Bail silently so we don't (a) flip
      // connState to 'disconnected' for a WS that's already been replaced, or
      // (b) schedule a phantom reconnect that opens a second live WS alongside
      // the replacement. Both leave the server with two subscribed sendables and
      // double every broadcast.
      if (wsRef.current !== ws) return;
      cancelFlush();
      for (const [, pending] of pendingPingsRef.current.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebSocket closed'));
      }
      pendingPingsRef.current.clear();
      setConnState('disconnected');
      // Clear any in-flight session so the UI doesn't stay stuck on "running"
      // after a server restart or unexpected disconnect. Also clear the
      // pending-prompt and queued-stop state — without a live socket neither
      // will ever resolve, and leaving them set would wedge the Stop button.
      setCurrentSessionId(null);
      pendingPromptRef.current = null;
      queuedStopRef.current = null;
      setPendingPromptConversationId(null);
      // Drop live "in flight" bookkeeping. After a server restart there is no
      // active session to re-advertise on subscribe, so leaving running/waiting
      // (or activeConversationIds) sticky would amber the UI forever.
      // Preserve sticky `error` (and any non-live statuses) so error dots still
      // behave across reconnect; session_started re-hydrates truly live sessions.
      setActiveConversationIds([]);
      setConversationStatuses((prev) => {
        let changed = false;
        const next: Record<string, AgentStatus> = {};
        for (const [id, status] of Object.entries(prev)) {
          if (status === 'running' || status === 'waiting') {
            changed = true;
            continue;
          }
          next[id] = status;
        }
        return changed ? next : prev;
      });
      if (closingRef.current) return;
      // Guarded retry: never open a second socket while one is OPEN/CONNECTING
      // (two live sockets double every broadcast — see onclose comment).
      const retryNow = () => {
        if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
        if (closingRef.current) return;
        const cur = wsRef.current;
        if (cur && cur !== ws && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) return;
        setConnState('connecting');
        connect();
      };
      const scheduleReconnect = () => {
        if (closingRef.current) return;
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        const delay = reconnectDelayMs(reconnectAttemptRef.current++);
        reconnectRef.current = setTimeout(retryNow, delay);
      };
      // A failed handshake is NOT proof of logout: an API/web restart (Vite proxy
      // ECONNREFUSED) or a not-yet-ready mobile network fails the upgrade too.
      // Mirror App.checkSession: only a definitive {authenticated:false} logs out.
      if (!handshakeCompleted || ev.code === 4401) {
        fetch('/auth/session', { credentials: 'include', cache: 'no-store' })
          .then(async (r) => (r.ok ? ((await r.json()) as { authenticated?: boolean }) : null))
          .then((s) => {
            if (closingRef.current || wsRef.current !== ws) return; // torn down or replaced meanwhile
            if (s && s.authenticated === false) onUnauthorizedRef.current?.();
            else scheduleReconnect();
          })
          .catch(() => { if (!closingRef.current && wsRef.current === ws) scheduleReconnect(); });
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }, [sendFrame, flushEvents, cancelFlush]); // currentSessionId and onUnauthorized intentionally excluded — use refs

  useEffect(() => {
    if (!enabled) {
      // Ensure any previously open socket is torn down when auth is revoked.
      closingRef.current = true;
      cancelFlush();
      for (const [, pending] of pendingPingsRef.current.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebSocket disabled'));
      }
      pendingPingsRef.current.clear();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (stalenessRef.current) clearInterval(stalenessRef.current);
      wsRef.current?.close();
      wsRef.current = null;
      setConnState('disconnected');
      setProfiles([]);
      setProfilesLoaded(false);
      return;
    }
    closingRef.current = false;
    connect();
    fetch('/profiles', { credentials: 'include', cache: 'no-store' })
      .then((r) => {
        if (r.status === 401) {
          onUnauthorized?.();
          setProfilesLoaded(false);
          return;
        }
        return r.json();
      })
      .then((d: ProfilesResponse | undefined) => {
        if (d) {
          setProfiles(d.profiles);
          setProfilesLoaded(true);
        }
      })
      .catch(() => {});
    return () => {
      closingRef.current = true;
      cancelFlush();
      for (const [, pending] of pendingPingsRef.current.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebSocket closed'));
      }
      pendingPingsRef.current.clear();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (stalenessRef.current) clearInterval(stalenessRef.current);
      wsRef.current?.close();
    };
  }, [connect, enabled, onUnauthorized, cancelFlush]);

  const refreshProfiles = useCallback(() => {
    fetch('/profiles', { credentials: 'include', cache: 'no-store' })
      .then((r) => {
        if (r.status === 401) {
          onUnauthorizedRef.current?.();
          setProfilesLoaded(false);
          return;
        }
        return r.json();
      })
      .then((d: ProfilesResponse | undefined) => {
        if (d) {
          setProfiles(d.profiles);
          setProfilesLoaded(true);
        }
      })
      .catch(() => {});
  }, []);

  const sendPrompt = useCallback((params: Parameters<UseWsResult['sendPrompt']>[0]): boolean => {
    if (!isSocketOpen()) return false;
    // Optimistic state: mark the conversation as 'running' immediately so the
    // header pill + sidebar dot converge on amber the moment the user presses
    // Enter, before the server's session_started frame arrives. The
    // session_started handler overwrites with the same value — fine.
    pendingPromptRef.current = params.conversationId;
    setPendingPromptConversationId(params.conversationId);
    recordLiveActivity(params.conversationId);
    setConversationStatuses((prev) => ({ ...prev, [params.conversationId]: 'running' }));
    markWsObserved(params.conversationId);
    setErrorRecoveredIds((prev) => applyRecovery(prev, params.conversationId, 'activity'));
    setActiveConversationIds((prev) =>
      prev.includes(params.conversationId) ? prev : [...prev, params.conversationId]
    );
    return sendFrame({
      type: 'prompt', projectId: params.projectId, conversationId: params.conversationId,
      agent: params.agent, model: params.model, profileId: params.profileId,
      text: params.text, attachments: params.attachments,
      handoffOverride: params.handoffOverride,
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.options ? { options: params.options } : {}),
    });
  }, [sendFrame, isSocketOpen]);

  const sendCommand = useCallback((params: Parameters<UseWsResult['sendCommand']>[0]): boolean => {
    if (!isSocketOpen()) return false;
    // Keep command dispatch aligned with prompt dispatch: status turns running
    // immediately and Stop becomes available before session_started arrives.
    pendingPromptRef.current = params.conversationId;
    setPendingPromptConversationId(params.conversationId);
    recordLiveActivity(params.conversationId);
    setConversationStatuses((prev) => ({ ...prev, [params.conversationId]: 'running' }));
    markWsObserved(params.conversationId);
    setErrorRecoveredIds((prev) => applyRecovery(prev, params.conversationId, 'activity'));
    setActiveConversationIds((prev) =>
      prev.includes(params.conversationId) ? prev : [...prev, params.conversationId]
    );
    return sendFrame({
      type: 'command',
      projectId: params.projectId,
      conversationId: params.conversationId,
      agent: params.agent,
      model: params.model,
      profileId: params.profileId,
      name: params.name,
      args: params.args,
      attachments: params.attachments,
      handoffOverride: params.handoffOverride,
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.options ? { options: params.options } : {}),
    });
  }, [sendFrame, isSocketOpen]);

  const sendSteer = useCallback((params: Parameters<UseWsResult['sendSteer']>[0]): boolean => {
    if (!isSocketOpen()) return false;
    if (params.intent === 'force') {
      // Snapshot the interrupted turn *before* the follow-up prompt can
      // land in the buffer. Soft-cancel reuses sessionId; prompt.seq is
      // always 0, so only the persisted event id (ts fallback) is unique.
      const snapshot = [...eventsRef.current, ...eventBufferRef.current];
      const key = lastPromptKeyForSession(snapshot, params.sessionId);
      if (key) {
        setForceInterruptedPromptIds((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }
    }
    return sendFrame({
      type: 'steer',
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      text: params.text,
      attachments: params.attachments,
      ...(params.intent ? { intent: params.intent } : {}),
      ...(params.commandName ? { commandName: params.commandName } : {}),
      ...(params.commandArgs !== undefined ? { commandArgs: params.commandArgs } : {}),
      ...(params.handoffOverride ? { handoffOverride: params.handoffOverride } : {}),
    });
  }, [sendFrame, isSocketOpen]);

  const clearForceSteerToast = useCallback(() => {
    if (forceSteerToastTimerRef.current) {
      clearTimeout(forceSteerToastTimerRef.current);
      forceSteerToastTimerRef.current = null;
    }
    setForceSteerToast(null);
  }, []);

  const stopHelper = useCallback((conversationId: string, taskId: string) => {
    sendFrame({ type: 'stop_helper', conversationId, taskId });
  }, [sendFrame]);

  const cancelSteer = useCallback((params: Parameters<UseWsResult['cancelSteer']>[0]) => {
    sendFrame({
      type: 'cancel_steer',
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      messageId: params.messageId,
    });
  }, [sendFrame]);

  const editSteer = useCallback((params: Parameters<UseWsResult['editSteer']>[0]) => {
    sendFrame({
      type: 'edit_steer',
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      messageId: params.messageId,
      text: params.text,
      attachments: params.attachments,
      ...(params.commandName ? { commandName: params.commandName } : {}),
      ...(params.commandArgs !== undefined ? { commandArgs: params.commandArgs } : {}),
    });
  }, [sendFrame]);

  const requestStop = useCallback((conversationId: string) => {
    // If we already have a session id, send stop immediately.
    if (currentSessionIdRef.current) {
      sendFrame({ type: 'stop', sessionId: currentSessionIdRef.current });
      return;
    }
    // No session id yet — either pending (queue for when session_started
    // arrives) or nothing to stop (surface a synthetic stop_result).
    if (pendingPromptRef.current === conversationId) {
      queuedStopRef.current = conversationId;
      return;
    }
    if (stopResultTimerRef.current) clearTimeout(stopResultTimerRef.current);
    setStopResult({ sessionId: '', success: false, message: 'No active session to stop' });
    stopResultTimerRef.current = setTimeout(() => {
      setStopResult(null);
      stopResultTimerRef.current = null;
    }, 8_000);
  }, [sendFrame]);

  /** Stop an arbitrary session by id (Active Agents modal). Unlike
   *  requestStop, this does not depend on the subscribed conversation —
   *  the server's `stop` handler is already keyed by sessionId alone. */
  const stopSessionById = useCallback((sessionId: string) => {
    sendFrame({ type: 'stop', sessionId });
  }, [sendFrame]);

  const clearStopResult = useCallback(() => {
    if (stopResultTimerRef.current) {
      clearTimeout(stopResultTimerRef.current);
      stopResultTimerRef.current = null;
    }
    setStopResult(null);
  }, []);

  const sendInteractionResponse = useCallback((params: Parameters<UseWsResult['sendInteractionResponse']>[0]) => {
    sendFrame({
      type: 'interaction_response',
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      requestId: params.requestId,
      selection: params.selection,
      text: params.text,
      answers: params.answers,
    } as ClientFrame);
  }, [sendFrame]);

  const pingOnce = useCallback((options?: number | { timeoutMs?: number }): Promise<number> => {
    const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? 3000);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not connected'));
    }
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<number>((resolve, reject) => {
      // ponytail: one-shot guard, not a poll — cleared the moment the pong lands.
      const timer = setTimeout(() => {
        pendingPingsRef.current.delete(id);
        reject(new Error('Ping timed out'));
      }, timeoutMs);
      pendingPingsRef.current.set(id, { resolve, reject, timer });
      sendFrame({ type: 'ping', id, clientTs: Date.now() });
    });
  }, [sendFrame]);

  // Android PWAs / background tabs freeze timers: on foreground or network
  // return, reconnect a dead socket now and probe an OPEN one (stale green).
  useEffect(() => {
    if (!enabled) return;
    let probing = false;
    const wake = () => {
      if (document.visibilityState !== 'visible' || closingRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
        reconnectAttemptRef.current = 0;
        setConnState('connecting');
        connect();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN || probing) return; // CONNECTING: let it land
      probing = true;
      pingOnce(5000)
        .catch(() => { if (wsRef.current === ws) ws.close(); }) // onclose → scheduleReconnect (1 s)
        .finally(() => { probing = false; });
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('online', wake);
    };
  }, [enabled, connect, pingOnce]);

  return {
    connState, profiles, profilesLoaded, events, currentSessionId,
    activeConversationIds, conversationStatuses, liveActivityAt,
    errorRecoveredConversationIds: errorRecoveredIds,
    wsObservedConversationIds: wsObservedIds,
    unreadConversationIds,
    clearUnread, acknowledgeConversationError, setEvents, flushEvents, isSocketOpen, refreshProfiles, subscribe, sendPrompt, sendCommand,
    sendSteer, steerQueueLengths, steerQueues, cancelSteer, editSteer,
    forceInterruptedPromptIds, forceSteerToast, clearForceSteerToast,
    requestStop, stopSessionById, pendingPromptConversationId, stopResult, clearStopResult,
    sendInteractionResponse, pingOnce,
    helpersRunningIds, stopHelper,
  };
}
