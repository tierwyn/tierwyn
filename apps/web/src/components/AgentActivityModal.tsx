import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ActiveSessionsResponse, AgentProfile, AgentStatus, Conversation,
  ConversationTimer, PendingTimerSummary, PendingTimersResponse, SpawnRequestRow,
} from '@tierwyn/shared';
import { formatHms, REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { PromptTimerModal, type PromptTimerSchedulePayload } from './PromptTimerModal.js';
import { api, UnauthorizedError } from '../api.js';
import {
  activeAgentDotClass, agentGuideX, buildAgentTree, flattenProjectRootTrees,
  groupAgentForest, sessionMetaParts, activityAgentLabel, subtreeSessionCount, buildCompletedAgentTree,
  groupCompletedAgentForest, subtreeCompletedCount, collectUnreadConversationIds, formatRelativeTime,
  RECENT_OPTIONS, type AgentTreeRow, type SessionMetaParts,
  groupPendingTimers, timedRowTimeLabel,
  buildAttentionItems, groupAttentionItems, attentionDotStatus, attentionReasonLabel,
} from '../agentActivity.js';
import { timerOriginBadge, fireAtLabel } from '../promptTimer.js';


interface Props {
  profiles: AgentProfile[];
  stopResult: { sessionId: string; success: boolean; message?: string; reason?: string } | null;
  onStop: (sessionId: string) => void;
  onJump: (conversationId: string) => void;
  onUnauthorized: () => void;
  onClose: () => void;
  onActiveCountChange?: (count: number) => void;
  onTimedCountChange?: (count: number) => void;
  unreadConversationIds?: string[];
  conversations?: Record<string, Conversation[]>;
  projects?: { id: string; name: string }[];
  onClearAllUnread?: (ids?: string[]) => Promise<void> | void;
  onMarkSingleRead?: (conversationId: string) => Promise<void> | void;
  conversationStatuses?: Record<string, AgentStatus>;
  errorRecoveredConversationIds?: ReadonlySet<string>;
  spawnRequests?: SpawnRequestRow[];
  onOpenSpawnApprovals?: () => void;
}

const EMPTY: ActiveSessionsResponse = {
  sessions: [],
  conversations: [],
  projects: [],
  now: 0,
};

const STOPPING_TTL_MS = 15_000;
const POLL_MS = 2_000;
const TIMED_POLL_MS = 5_000;
const EMPTY_STATUSES: Record<string, AgentStatus> = {};
const EMPTY_RECOVERED: ReadonlySet<string> = new Set();
const EMPTY_SPAWN: SpawnRequestRow[] = [];

export type Tab = 'active' | 'completed' | 'timed' | 'attention';

function profileLabel(profiles: AgentProfile[], agentType: string | undefined, profileId: string | undefined): string {
  const p = profileId ? profiles.find((x) => x.id === profileId) : undefined;
  return activityAgentLabel(p?.label, agentType ?? p?.agentType ?? '');
}

function SessionMetaLine({
  parts,
  extra,
}: {
  parts: SessionMetaParts;
  extra?: string;
}) {
  const nodes: ReactNode[] = [];
  const push = (key: string, className: string, text: string) => {
    if (!text) return;
    if (nodes.length > 0) {
      nodes.push(
        <span key={`sep-${key}`} className="aa-meta-sep" aria-hidden>·</span>,
      );
    }
    nodes.push(
      <span key={key} className={className}>{text}</span>,
    );
  };
  push('agent', 'aa-meta-agent', parts.agent);
  push('model', 'aa-meta-model', parts.model);
  push('project', 'aa-meta-project', parts.project);
  if (extra) push('extra', 'aa-meta-extra', extra);
  if (nodes.length === 0) return null;
  return <div className="aa-row-meta">{nodes}</div>;
}

interface StopTarget {
  sessionId: string;
  title: string;
  agentLabel: string;
  model?: string;
  warnStopSeversParent?: boolean;
}

interface DeleteTimerTarget {
  timerId: string;
  conversationId: string;
  conversationTitle: string;
  promptPreview: string;
}

interface EditingTimerState {
  timer: ConversationTimer;
  conversationTitle: string;
  projectId: string;
}

export function AgentActivityModal({
  profiles, stopResult, onStop, onJump, onUnauthorized, onClose, onActiveCountChange,
  onTimedCountChange,
  unreadConversationIds: propsUnreadConversationIds,
  conversations: propsConversations,
  projects: propsProjects,
  onClearAllUnread: propsOnClearAllUnread,
  onMarkSingleRead: propsOnMarkSingleRead,
  conversationStatuses = EMPTY_STATUSES,
  errorRecoveredConversationIds = EMPTY_RECOVERED,
  spawnRequests = EMPTY_SPAWN,
  onOpenSpawnApprovals,
}: Props) {
  const [tab, setTab] = useState<Tab>('active');
  const [timed, setTimed] = useState<PendingTimersResponse | null>(null);
  const [timedSkew, setTimedSkew] = useState(0);
  const [payload, setPayload] = useState<ActiveSessionsResponse | null>(null);
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [stopping, setStopping] = useState<Record<string, number>>({});
  const [stale, setStale] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [markingReadIds, setMarkingReadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [cancellingTimerIds, setCancellingTimerIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null);
  const [deleteTimerTarget, setDeleteTimerTarget] = useState<DeleteTimerTarget | null>(null);
  const [editingTimer, setEditingTimer] = useState<EditingTimerState | null>(null);
  const [loadingTimerId, setLoadingTimerId] = useState<string | null>(null);

  const handleTabChange = useCallback((nextTab: Tab) => {
    setTab(nextTab);
    setSelectedIds(new Set());
    setStopTarget(null);
    setDeleteTimerTarget(null);
    setEditingTimer(null);
  }, []);


  const [recentDays, setRecentDays] = useState<number>(() => {
    try {
      const v = localStorage.getItem('agentActivityRecentDays') ?? localStorage.getItem('activeAgentsRecentDays');
      if (v !== null) {
        const n = Number(v);
        if ([0, 1, 3, 7].includes(n)) return n;
      }
    } catch { /* ignore */ }
    return 0;
  });

  useEffect(() => {
    try { localStorage.setItem('agentActivityRecentDays', String(recentDays)); } catch { /* ignore */ }
  }, [recentDays]);

  const [recentOpen, setRecentOpen] = useState(false);
  const recentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recentOpen) return;
    const handler = (e: MouseEvent) => {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setRecentOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [recentOpen]);

  const [fetchedProjects, setFetchedProjects] = useState<{ id: string; name: string }[]>([]);
  const [fetchedConversations, setFetchedConversations] = useState<Record<string, Conversation[]>>({});

  useEffect(() => {
    if (propsConversations && Object.keys(propsConversations).length > 0) return;
    let mounted = true;
    api.listProjects()
      .then(async (projs) => {
        if (!mounted) return;
        setFetchedProjects(projs);
        const entries = await Promise.all(
          projs.map((p) =>
            api.listConversations(p.id)
              .then((convs) => [p.id, convs] as const)
              .catch(() => [p.id, [] as Conversation[]] as const)
          )
        );
        if (!mounted) return;
        setFetchedConversations(Object.fromEntries(entries));
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [propsConversations]);

  const effectiveProjects = useMemo(() => {
    if (propsProjects && propsProjects.length > 0) return propsProjects;
    if (payload?.projects && payload.projects.length > 0) return payload.projects;
    return fetchedProjects;
  }, [propsProjects, payload?.projects, fetchedProjects]);

  const effectiveConversations = useMemo(() => {
    if (propsConversations && Object.keys(propsConversations).length > 0) return propsConversations;
    return fetchedConversations;
  }, [propsConversations, fetchedConversations]);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ac = new AbortController();

    const fetchOnce = () => {
      api.activeSessions(ac.signal)
        .then((p) => {
          if (!mounted) return;
          setPayload(p);
          setSkew(Date.now() - p.now);
          setStale(false);
          onActiveCountChange?.(p.sessions.length);
        })
        .catch((err: unknown) => {
          if (!mounted) return;
          if (err instanceof UnauthorizedError) {
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
            onUnauthorized();
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') return;
          setStale(true);
        });
    };

    fetchOnce();
    timer = setInterval(fetchOnce, POLL_MS);
    return () => {
      mounted = false;
      if (timer !== undefined) clearInterval(timer);
      ac.abort();
    };
  }, []);

  const fetchTimedRef = useRef<() => void>(() => {});

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ac = new AbortController();

    const fetchOnce = () => {
      api.pendingTimers(ac.signal)
        .then((p) => {
          if (!mounted) return;
          setTimed(p);
          setTimedSkew(Date.now() - p.now);
          setStale(false);
          onTimedCountChange?.(p.timers.length);
        })
        .catch((err: unknown) => {
          if (!mounted) return;
          if (err instanceof UnauthorizedError) {
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
            onUnauthorized();
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') return;
          setStale(true);
        });
    };

    fetchTimedRef.current = fetchOnce;
    fetchOnce();
    timer = setInterval(fetchOnce, TIMED_POLL_MS);
    // timers_changed (any device) → refresh now instead of waiting for the poll.
    window.addEventListener('conversation-timers-changed', fetchOnce);
    return () => {
      mounted = false;
      if (timer !== undefined) clearInterval(timer);
      window.removeEventListener('conversation-timers-changed', fetchOnce);
      ac.abort();
    };
  }, []);

  useEffect(() => {
    if (tab === 'timed') fetchTimedRef.current();
  }, [tab]);


  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const cutoff = t - STOPPING_TTL_MS;
      setStopping((prev) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [sid, at] of Object.entries(prev)) {
          if (at < cutoff) {
            changed = true;
            continue;
          }
          next[sid] = at;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!payload) return;
    const present = new Set(payload.sessions.map((s) => s.sessionId));
    const cutoff = Date.now() - STOPPING_TTL_MS;
    setStopping((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [sid, at] of Object.entries(prev)) {
        if (!present.has(sid) || at < cutoff) {
          changed = true;
          continue;
        }
        next[sid] = at;
      }
      return changed ? next : prev;
    });
  }, [payload]);

  useEffect(() => {
    if (!stopResult || stopResult.success) return;
    setStopping((prev) => {
      if (!(stopResult.sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[stopResult.sessionId];
      return next;
    });
  }, [stopResult]);

  const groups = useMemo(
    () =>
      groupAgentForest(buildAgentTree(payload ?? EMPTY)).map((g) => ({
        ...g,
        rootTrees: flattenProjectRootTrees(g, collapsed),
      })),
    [payload, collapsed],
  );

  const runningConversationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of (payload?.sessions ?? [])) {
      ids.add(s.conversationId);
    }
    return ids;
  }, [payload]);

  const effectiveUnreadIds = useMemo(
    () => new Set(propsUnreadConversationIds ?? []),
    [propsUnreadConversationIds],
  );

  const completedGroups = useMemo(() => {
    const roots = buildCompletedAgentTree({
      conversations: effectiveConversations,
      projects: effectiveProjects,
      runningConversationIds,
      unreadConversationIds: effectiveUnreadIds,
      recentDays,
      now,
    });
    return groupCompletedAgentForest(roots).map((g) => ({
      ...g,
      rootTrees: flattenProjectRootTrees(g, collapsed),
    }));
  }, [effectiveConversations, effectiveProjects, runningConversationIds, effectiveUnreadIds, recentDays, now, collapsed]);

  const completedCount = useMemo(() => {
    let total = 0;
    for (const g of completedGroups) {
      total += g.completed;
    }
    return total;
  }, [completedGroups]);

  const attentionItems = useMemo(() => buildAttentionItems({
    sessions: payload?.sessions ?? [],
    payloadConversations: payload?.conversations ?? [],
    payloadProjects: payload?.projects ?? [],
    conversations: effectiveConversations,
    projects: effectiveProjects,
    conversationStatuses,
    errorRecoveredIds: errorRecoveredConversationIds,
    spawnRequests,
  }), [payload, effectiveConversations, effectiveProjects, conversationStatuses, errorRecoveredConversationIds, spawnRequests]);
  const attentionGroups = useMemo(() => groupAttentionItems(attentionItems), [attentionItems]);

  const unreadConversationIdsInView = useMemo(
    () => collectUnreadConversationIds(completedGroups),
    [completedGroups],
  );

  const validSelectedIds = useMemo(() => {
    const valid = new Set(unreadConversationIdsInView);
    const set = new Set<string>();
    for (const id of selectedIds) {
      if (valid.has(id)) set.add(id);
    }
    return set;
  }, [selectedIds, unreadConversationIdsInView]);

  const selectedCount = validSelectedIds.size;

  const handleToggleSelect = useCallback((conversationId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (validSelectedIds.size === unreadConversationIdsInView.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(unreadConversationIdsInView));
    }
  }, [validSelectedIds.size, unreadConversationIdsInView]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleConfirmClear = useCallback(async () => {
    const idsToMark = validSelectedIds.size > 0
      ? Array.from(validSelectedIds)
      : unreadConversationIdsInView;
    if (clearing || idsToMark.length === 0) return;
    setClearing(true);
    try {
      if (propsOnClearAllUnread) {
        await propsOnClearAllUnread(idsToMark);
      } else {
        await api.markConversationsRead(idsToMark);
      }
      const clearedSet = new Set(idsToMark);
      setFetchedConversations((prev) => {
        const next: Record<string, Conversation[]> = {};
        for (const [pid, list] of Object.entries(prev)) {
          next[pid] = list.map((c) => clearedSet.has(c.id) ? { ...c, lastStatus: undefined } : c);
        }
        return next;
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of idsToMark) next.delete(id);
        return next;
      });
      setShowClearConfirm(false);
    } catch (err) {
      console.error('Failed to mark conversations read:', err);
    } finally {
      setClearing(false);
    }
  }, [clearing, validSelectedIds, unreadConversationIdsInView, propsOnClearAllUnread]);

  const handleMarkSingleRead = useCallback(async (conversationId: string) => {
    if (markingReadIds.has(conversationId)) return;
    setMarkingReadIds((prev) => new Set(prev).add(conversationId));
    try {
      if (propsOnMarkSingleRead) {
        await propsOnMarkSingleRead(conversationId);
      } else {
        await api.markConversationRead(conversationId);
      }
      setFetchedConversations((prev) => {
        const next: Record<string, Conversation[]> = {};
        for (const [pid, list] of Object.entries(prev)) {
          next[pid] = list.map((c) => c.id === conversationId ? { ...c, lastStatus: undefined } : c);
        }
        return next;
      });
      setSelectedIds((prev) => {
        if (!prev.has(conversationId)) return prev;
        const next = new Set(prev);
        next.delete(conversationId);
        return next;
      });
    } catch (err) {
      console.error('Failed to mark conversation read:', err);
    } finally {
      setMarkingReadIds((prev) => {
        const next = new Set(prev);
        next.delete(conversationId);
        return next;
      });
    }
  }, [markingReadIds, propsOnMarkSingleRead]);

  const hasParentByConversation = useMemo(() => {
    const ids = new Set<string>();
    for (const c of (payload ?? EMPTY).conversations) {
      if (c.parentConversationId) ids.add(c.id);
    }
    return ids;
  }, [payload]);

  const toggleCollapsed = useCallback((conversationId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }, []);

  const handleRequestStop = useCallback((target: StopTarget) => {
    setStopTarget(target);
  }, []);

  const handleConfirmStop = useCallback(() => {
    if (!stopTarget) return;
    const { sessionId } = stopTarget;
    setStopping((prev) => ({ ...prev, [sessionId]: Date.now() }));
    onStop(sessionId);
    setStopTarget(null);
  }, [stopTarget, onStop]);

  const handleCancelStop = useCallback(() => {
    setStopTarget(null);
  }, []);

  const handleDeleteTimer = useCallback(async (conversationId: string, timerId: string) => {
    if (cancellingTimerIds.has(timerId)) return;
    setCancellingTimerIds((prev) => new Set(prev).add(timerId));
    setTimed((prev) => {
      if (!prev) return prev;
      const nextTimers = prev.timers.filter((t) => t.id !== timerId);
      onTimedCountChange?.(nextTimers.length);
      return { ...prev, timers: nextTimers };
    });
    window.dispatchEvent(new CustomEvent('conversation-timers-changed', {
      detail: { conversationId, timerId, action: 'cancelled' },
    }));
    try {
      await api.cancelConversationTimer(conversationId, timerId);
    } catch (err) {
      console.error('Failed to cancel timer:', err);
      fetchTimedRef.current();
      window.dispatchEvent(new CustomEvent('conversation-timers-changed', {
        detail: { conversationId, timerId, action: 'rollback' },
      }));
    } finally {
      setCancellingTimerIds((prev) => {
        const next = new Set(prev);
        next.delete(timerId);
        return next;
      });
    }
  }, [cancellingTimerIds, onTimedCountChange]);

  const handleConfirmDeleteTimer = useCallback(() => {
    if (!deleteTimerTarget) return;
    const { conversationId, timerId } = deleteTimerTarget;
    setDeleteTimerTarget(null);
    void handleDeleteTimer(conversationId, timerId);
  }, [deleteTimerTarget, handleDeleteTimer]);

  const handleCancelDeleteTimer = useCallback(() => {
    setDeleteTimerTarget(null);
  }, []);

  const handleOpenTimerEdit = useCallback(async (t: PendingTimerSummary) => {
    if (loadingTimerId) return;
    setLoadingTimerId(t.id);
    try {
      const timers = await api.listConversationTimers(t.conversationId);
      const fullTimer = timers.find((x) => x.id === t.id);
      if (!fullTimer) {
        fetchTimedRef.current();
        return;
      }
      setEditingTimer({
        timer: fullTimer,
        conversationTitle: t.conversationTitle,
        projectId: t.projectId,
      });
    } catch (err) {
      console.error('Failed to load timer for editing:', err);
    } finally {
      setLoadingTimerId(null);
    }
  }, [loadingTimerId]);

  const handleUpdateTimer = useCallback(async (payload: PromptTimerSchedulePayload) => {
    if (!editingTimer) throw new Error('No timer selected');
    await api.updateConversationTimer(editingTimer.timer.conversationId, editingTimer.timer.id, {
      prompt: payload.prompt.trim(),
      profileId: payload.profileId,
      ...(payload.when ?? {}),
      effort: payload.effort,
      options: payload.options,
      handoffOverride: payload.handoffOverride,
    });
    fetchTimedRef.current();
    setEditingTimer(null);
  }, [editingTimer]);

  const handleJump = useCallback((conversationId: string) => {
    onJump(conversationId);
    onClose();
  }, [onJump, onClose]);

  const count = payload?.sessions.length ?? 0;
  const title = `Agent Activity${stale ? ' · reconnecting…' : ''}`;

  return (
    <Modal title={title} onClose={onClose} className="agent-activity-modal active-agents-modal">
      <div className="aa-tab-bar">
        <div className="aa-tabs-row">
          <div className="aa-tabs" role="tablist" aria-label="Session category">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'active'}
              className={`aa-tab${tab === 'active' ? ' active' : ''}`}
              onClick={() => handleTabChange('active')}
            >
              Active ({count})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'completed'}
              className={`aa-tab${tab === 'completed' ? ' active' : ''}`}
              onClick={() => handleTabChange('completed')}
            >
              Completed ({completedCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'timed'}
              className={`aa-tab${tab === 'timed' ? ' active' : ''}`}
              onClick={() => handleTabChange('timed')}
            >
              Timed ({timed?.timers.length ?? 0}{timed?.truncated ? '+' : ''})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'attention'}
              className={`aa-tab${tab === 'attention' ? ' active' : ''}${attentionItems.length > 0 ? ' aa-tab--alert' : ''}`}
              onClick={() => handleTabChange('attention')}
            >
              Attention ({attentionItems.length})
            </button>
          </div>
        </div>

        {tab === 'completed' && (
          <div className="aa-tab-actions">
            <div className="aa-tab-actions-left">
              {unreadConversationIdsInView.length > 0 && (
                <button
                  type="button"
                  className="aa-select-all-btn"
                  onClick={handleSelectAll}
                  title={validSelectedIds.size === unreadConversationIdsInView.length ? 'Deselect all unread conversations' : 'Select all unread conversations'}
                  aria-label={validSelectedIds.size === unreadConversationIdsInView.length ? 'Deselect all unread conversations' : 'Select all unread conversations'}
                >
                  {validSelectedIds.size === unreadConversationIdsInView.length ? 'Deselect all' : 'Select all'}
                </button>
              )}
              {selectedCount > 0 ? (
                <>
                  <button
                    type="button"
                    className="aa-clear-read-btn aa-clear-read-btn--selected"
                    disabled={clearing}
                    onClick={() => setShowClearConfirm(true)}
                    title={`Mark ${selectedCount} selected conversation${selectedCount === 1 ? '' : 's'} as read`}
                    aria-label={`Mark ${selectedCount} selected conversation${selectedCount === 1 ? '' : 's'} as read`}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>Mark selected read ({selectedCount})</span>
                  </button>
                  <button
                    type="button"
                    className="aa-deselect-btn"
                    onClick={handleClearSelection}
                    title="Clear selection"
                    aria-label="Clear selection"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="aa-clear-read-btn"
                  disabled={completedCount === 0 || clearing}
                  onClick={() => setShowClearConfirm(true)}
                  title={completedCount === 0 ? 'No unread conversations to clear' : 'Mark all completed conversations as read'}
                  aria-label="Mark all completed conversations as read"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Mark all read</span>
                </button>
              )}
            </div>
            <div ref={recentRef} style={{ position: 'relative' }}>
              <button
                type="button"
                className={`sidebar-recent-trigger${recentDays !== 0 ? ' active' : ''}`}
                onClick={() => setRecentOpen((v) => !v)}
                title={recentDays !== 0 ? `Filtered: ${RECENT_OPTIONS.find((o) => o.value === recentDays)?.label}` : 'Filter by recent activity'}
                aria-label={recentDays !== 0 ? `Filtered: ${RECENT_OPTIONS.find((o) => o.value === recentDays)?.label}` : 'Filter by recent activity'}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </button>
              {recentOpen && (
                <div className="sidebar-recent-panel">
                  {RECENT_OPTIONS.map((o) => (
                    <div
                      key={o.value}
                      className={`sidebar-recent-item${o.value === recentDays ? ' sidebar-recent-item--selected' : ''}`}
                      onClick={() => { setRecentDays(o.value); setRecentOpen(false); }}
                    >
                      <span className="check">{o.value === recentDays ? '✓' : ''}</span>
                      {o.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {tab === 'active' && (
        <>
          {payload === null && (
            <div className="aa-empty">Loading…</div>
          )}
          {payload && payload.sessions.length === 0 && (
            <div className="aa-empty">No agents are running.</div>
          )}
          {payload !== null && payload.sessions.length > 0 && (
            <div className="aa-list">
              {groups.map((group) => (
                <section key={group.projectId || '__unknown__'} className="aa-project">
                  <header className="aa-project-head">
                    <span className="aa-project-name">{group.projectName ?? 'Unknown project'}</span>
                    <span className="aa-project-count">{group.running} running</span>
                  </header>
                  <div className="aa-project-body">
                    {group.rootTrees.map((tree) => (
                      <div key={tree.root.conversationId} className="aa-root-tree">
                        {tree.rows.map((row) => (
                          <AgentNodeRows
                            key={row.node.conversationId}
                            row={row}
                            profiles={profiles}
                            now={now}
                            skew={skew}
                            collapsed={collapsed}
                            stopping={stopping}
                            warnStopSeversParent={hasParentByConversation.has(row.node.conversationId)}
                            onToggle={toggleCollapsed}
                            onStop={handleRequestStop}
                            onJump={handleJump}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'completed' && (
        <>
          {completedGroups.length === 0 && (
            <div className="aa-empty">No completed unread conversations.</div>
          )}
          {completedGroups.length > 0 && (
            <div className="aa-list">
              {completedGroups.map((group) => (
                <section key={group.projectId || '__unknown__'} className="aa-project">
                  <header className="aa-project-head">
                    <span className="aa-project-name">{group.projectName ?? 'Unknown project'}</span>
                    <span className="aa-project-count">{group.completed} unread</span>
                  </header>
                  <div className="aa-project-body">
                    {group.rootTrees.map((tree) => (
                      <div key={tree.root.conversationId} className="aa-root-tree">
                        {tree.rows.map((row) => (
                          <CompletedNodeRows
                            key={row.node.conversationId}
                            row={row}
                            profiles={profiles}
                            now={now}
                            collapsed={collapsed}
                            markingReadIds={markingReadIds}
                            selectedIds={selectedIds}
                            onToggle={toggleCollapsed}
                            onJump={handleJump}
                            onMarkRead={handleMarkSingleRead}
                            onToggleSelect={handleToggleSelect}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'timed' && (
        <>
          {!timed ? (
            <div className="aa-empty">Loading…</div>
          ) : timed.timers.length === 0 ? (
            <div className="aa-empty">No timed messages are pending.</div>
          ) : (
            <div className="aa-list">
              {groupPendingTimers(timed.timers).map((group) => (
                <section key={group.projectId || '__unknown__'} className="aa-project">
                  <header className="aa-project-head">
                    <span className="aa-project-name">{group.projectName ?? 'Unknown project'}</span>
                    <span className="aa-project-count">{group.timers.length} pending</span>
                  </header>
                  <div className="aa-project-body">
                    {group.timers.map((t) => {
                      const badge = timerOriginBadge(t.origin);
                      return (
                        <div
                          key={t.id}
                          className="aa-row"
                          role="button"
                          tabIndex={0}
                          onClick={() => handleJump(t.conversationId)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleJump(t.conversationId); }}
                        >
                          <div className="aa-row-main">
                            <div className="aa-row-title-line">
                              <div className="aa-row-title">
                                {badge && <span className="timer-chip-origin" title={badge.title}>{badge.label}</span>}{' '}
                                {t.conversationTitle}
                              </div>
                              <div className="aa-row-time" title={fireAtLabel(t.fireAtMs)}>
                                {timedRowTimeLabel(t.fireAtMs, now - timedSkew)}
                              </div>
                            </div>
                            <SessionMetaLine parts={sessionMetaParts(profileLabel(profiles, undefined, t.profileId))} />
                            <div className="aa-row-desc" title={t.promptPreview}>
                              {t.promptPreview}{t.promptTruncated ? '…' : ''}
                            </div>
                            <div className="aa-row-actions">
                              <OpenButton onClick={() => handleJump(t.conversationId)} />
                              <button
                                type="button"
                                className="icon-btn aa-action aa-action--timer"
                                disabled={cancellingTimerIds.has(t.id) || loadingTimerId === t.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleOpenTimerEdit(t);
                                }}
                                title="Change timer"
                                aria-label="Change timer"
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <circle cx="12" cy="12" r="10" />
                                  <polyline points="12 6 12 12 16 14" />
                                </svg>
                                <span>{loadingTimerId === t.id ? 'Loading…' : 'Timer'}</span>
                              </button>
                              <button
                                type="button"
                                className="icon-btn aa-action aa-action--stop"
                                disabled={cancellingTimerIds.has(t.id)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteTimerTarget({
                                    timerId: t.id,
                                    conversationId: t.conversationId,
                                    conversationTitle: t.conversationTitle,
                                    promptPreview: `${t.promptPreview}${t.promptTruncated ? '…' : ''}`,
                                  });
                                }}
                                title="Delete timer"
                                aria-label="Delete timer"
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                                <span>{cancellingTimerIds.has(t.id) ? 'Deleting…' : 'Delete'}</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
              {timed.truncated && <div className="aa-empty">Showing the first {timed.timers.length} timers.</div>}
            </div>
          )}
        </>
      )}

      {tab === 'attention' && (
        <>
          {payload === null ? (
            <div className="aa-empty">Loading…</div>
          ) : attentionItems.length === 0 ? (
            <div className="aa-empty">Nothing needs your attention.</div>
          ) : (
            <div className="aa-list">
              {attentionGroups.map((group) => (
                <section key={group.projectId || '__unknown__'} className="aa-project">
                  <header className="aa-project-head">
                    <span className="aa-project-name">{group.projectName ?? 'Unknown project'}</span>
                    <span className="aa-project-count">{group.items.length} need attention</span>
                  </header>
                  <div className="aa-project-body">
                    {group.items.map((item) => (
                      <div
                        key={item.conversationId}
                        className="aa-row"
                        role="button"
                        tabIndex={0}
                        onClick={() => handleJump(item.conversationId)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleJump(item.conversationId); }}
                      >
                        <span className={activeAgentDotClass(attentionDotStatus(item), item.isChild ? 1 : 0)} />
                        <div className="aa-row-main">
                          <div className="aa-row-title-line">
                            <div className="aa-row-title">{item.title}</div>
                            {item.reasons.map((reason) => (
                              <span key={reason} className="timer-chip-origin">
                                {attentionReasonLabel(reason, item.pendingSpawnRequests)}
                              </span>
                            ))}
                          </div>
                          <SessionMetaLine
                            parts={sessionMetaParts(profileLabel(profiles, item.agentType, item.profileId), undefined, item.projectName)}
                            extra={formatRelativeTime(item.at, now)}
                          />
                          {(item.reasons.includes('error') || item.reasons.includes('spawn_approval')) && (
                            <div className="aa-row-actions">
                              {item.reasons.includes('error') && (
                                <button
                                  type="button"
                                  className="icon-btn aa-action aa-action--mark-read"
                                  disabled={markingReadIds.has(item.conversationId)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleMarkSingleRead(item.conversationId);
                                  }}
                                  title="Mark conversation as read"
                                  aria-label="Mark conversation as read"
                                >
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12" />
                                  </svg>
                                  <span>{markingReadIds.has(item.conversationId) ? 'Marking…' : 'Mark read'}</span>
                                </button>
                              )}
                              {item.reasons.includes('spawn_approval') && (
                                <button
                                  type="button"
                                  className="icon-btn aa-action aa-action--open"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenSpawnApprovals?.();
                                  }}
                                  title="Review spawn approvals"
                                  aria-label="Review spawn approvals"
                                >
                                  <span>Review</span>
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}


      {showClearConfirm && (
        <ConfirmDialog
          title={selectedCount > 0 ? 'Mark selected as read?' : 'Mark all as read?'}
          busy={clearing}
          confirmLabel={selectedCount > 0 ? `Mark selected read (${selectedCount})` : 'Mark all read'}
          cancelLabel="Cancel"
          danger={false}
          body={
            selectedCount > 0 ? (
              <>
                Mark <strong>{selectedCount}</strong> selected {selectedCount === 1 ? 'conversation' : 'conversations'} as read?
                <br /><br />
                This will clear unread status indicators for the selected {selectedCount === 1 ? 'conversation' : 'conversations'}.
              </>
            ) : recentDays === 0 ? (
              <>
                Mark all <strong>{completedCount}</strong> completed {completedCount === 1 ? 'conversation' : 'conversations'} as read?
                <br /><br />
                This will clear unread status indicators across all projects.
              </>
            ) : (
              <>
                Mark <strong>{completedCount}</strong> completed {completedCount === 1 ? 'conversation' : 'conversations'} (filtered by past {RECENT_OPTIONS.find((o) => o.value === recentDays)?.label}) as read?
                <br /><br />
                This will clear unread status indicators for these conversations. Older unread conversations outside this window will remain unread.
              </>
            )
          }
          onCancel={() => setShowClearConfirm(false)}
          onConfirm={() => { void handleConfirmClear(); }}
        />
      )}

      {stopTarget && (
        <ConfirmDialog
          title="Stop agent session?"
          confirmLabel="Stop agent"
          cancelLabel="Cancel"
          danger={true}
          body={
            <>
              Stop the running agent session for <strong>{stopTarget.title}</strong>?
              <br /><br />
              <div style={{ fontSize: '12px', color: 'var(--text-3)', fontFamily: 'var(--mono)', background: 'var(--surface-2)', padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border)' }}>
                {stopTarget.agentLabel}{stopTarget.model ? ` · ${stopTarget.model}` : ''}
              </div>
              {stopTarget.warnStopSeversParent && (
                <div style={{ marginTop: '10px', color: 'var(--amber)', fontSize: '12px', lineHeight: 1.4 }}>
                  ⚠️ This agent was spawned by a parent conversation. Stopping it will sever the link, and the parent will not receive a result.
                </div>
              )}
            </>
          }
          onCancel={handleCancelStop}
          onConfirm={handleConfirmStop}
        />
      )}

      {deleteTimerTarget && (
        <ConfirmDialog
          title="Delete timer?"
          confirmLabel="Delete timer"
          cancelLabel="Cancel"
          danger={true}
          body={
            <>
              Delete the scheduled timer for <strong>{deleteTimerTarget.conversationTitle}</strong>?
              {deleteTimerTarget.promptPreview && (
                <>
                  <br /><br />
                  <div style={{ fontSize: '12px', color: 'var(--text-3)', fontFamily: 'var(--mono)', background: 'var(--surface-2)', padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border)', maxHeight: '100px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {deleteTimerTarget.promptPreview}
                  </div>
                </>
              )}
            </>
          }
          onCancel={handleCancelDeleteTimer}
          onConfirm={handleConfirmDeleteTimer}
        />
      )}

      {editingTimer && (
        <PromptTimerModal
          key={editingTimer.timer.id}
          mode="edit"
          initialTimer={editingTimer.timer}
          conversationTitle={editingTimer.conversationTitle}
          prompt={editingTimer.timer.prompt}
          profiles={profiles}
          composerProfileId={editingTimer.timer.profileId}
          composerEffort={editingTimer.timer.effort}
          composerOptions={editingTimer.timer.options ?? {}}
          attachments={[]}
          isRemoteAgents={editingTimer.projectId === REMOTE_AGENTS_PROJECT_ID}
          overlayClassName="modal-overlay--stack-2"
          onClose={() => setEditingTimer(null)}
          onSchedule={handleUpdateTimer}
        />
      )}
    </Modal>
  );
}

interface CompletedNodeRowsProps {
  row: AgentTreeRow;
  profiles: AgentProfile[];
  now: number;
  collapsed: ReadonlySet<string>;
  markingReadIds: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  onToggle: (conversationId: string) => void;
  onJump: (conversationId: string) => void;
  onMarkRead: (conversationId: string) => void;
  onToggleSelect: (conversationId: string) => void;
}

function CompletedNodeRows({
  row, profiles, now, collapsed, markingReadIds, selectedIds, onToggle, onJump, onMarkRead, onToggleSelect,
}: CompletedNodeRowsProps) {
  const { node, guides } = row;
  const indent = Math.min(node.depth, 6) * 14;
  const hasChildren = node.children.length > 0;
  const expanded = !collapsed.has(node.conversationId);
  const unreadCount = subtreeCompletedCount(node);
  const isScheduleHome = node.kind === 'schedule_home';
  const title = isScheduleHome ? node.title.replace(/^⏱\s*/, '') : node.title;
  const unreadChildren = unreadCount - (node.isUnread ? 1 : 0);
  const elapsed = node.updatedAt ? formatRelativeTime(node.updatedAt, now) : '';
  const isSelected = selectedIds.has(node.conversationId);

  return (
    <div
      className={`aa-row aa-row--completed${isScheduleHome ? ' aa-row--schedule' : ''}${node.isUnread ? ' is-unread' : ''}${isSelected ? ' is-selected' : ''}`}
      style={{ paddingLeft: 8 + indent }}
      onClick={() => {
        if (!isScheduleHome && node.isUnread) {
          onToggleSelect(node.conversationId);
        }
      }}
    >
      <GuideLines guides={guides} endX={dotCenterX(indent)} />
      <Chevron hasChildren={hasChildren} expanded={expanded} onToggle={() => onToggle(node.conversationId)} />
      {isScheduleHome ? (
        <span className="aa-schedule-icon" aria-hidden>⏱</span>
      ) : (
        <span
          className={activeAgentDotClass(
            undefined,
            node.depth,
            !node.isUnread && unreadCount > 0,
            Boolean(node.isUnread),
          )}
          title={node.isUnread ? 'unread' : unreadCount > 0 ? 'subagent unread' : 'idle'}
        />
      )}
      {!isScheduleHome && node.isUnread ? (
        <span className="aa-checkbox-wrap" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="aa-checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(node.conversationId)}
            title={isSelected ? 'Deselect conversation' : 'Select conversation'}
            aria-label={isSelected ? `Deselect ${title}` : `Select ${title}`}
          />
        </span>
      ) : (
        <span className="aa-checkbox-spacer" aria-hidden />
      )}
      <div className="aa-row-main">
        <div className="aa-row-title-line">
          <div className="aa-row-title">{title}</div>
          {!expanded && unreadChildren > 0 && (
            <SessionMetaLine
              parts={{ agent: '', model: '', project: '' }}
              extra={`${unreadChildren} unread`}
            />
          )}
          {elapsed && <div className="aa-row-time">{elapsed}</div>}
        </div>
        {!isScheduleHome && (
          <SessionMetaLine parts={sessionMetaParts(profileLabel(profiles, node.lastAgentType, node.lastProfileId))} />
        )}
        {node.description && <div className="aa-row-desc" title={node.description}>{node.description}</div>}
        {node.tags && node.tags.length > 0 && (
          <div className="aa-row-tags">
            {node.tags.map((t) => (
              <span key={t} className="conversation-tag" title={t}>{t}</span>
            ))}
          </div>
        )}
        <div className="aa-row-actions">
          {!isScheduleHome && node.isUnread && (
            <button
              type="button"
              className="icon-btn aa-action aa-action--mark-read"
              disabled={markingReadIds.has(node.conversationId)}
              onClick={(e) => {
                e.stopPropagation();
                onMarkRead(node.conversationId);
              }}
              title="Mark conversation as read"
              aria-label="Mark conversation as read"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{markingReadIds.has(node.conversationId) ? 'Marking…' : 'Mark read'}</span>
            </button>
          )}
          {!isScheduleHome && <OpenButton onClick={() => onJump(node.conversationId)} />}
        </div>
      </div>
    </div>
  );
}

interface NodeRowsProps {
  row: AgentTreeRow;
  profiles: AgentProfile[];
  now: number;
  skew: number;
  collapsed: ReadonlySet<string>;
  stopping: Record<string, number>;
  warnStopSeversParent: boolean;
  onToggle: (conversationId: string) => void;
  onStop: (target: StopTarget) => void;
  onJump: (conversationId: string) => void;
}

/** Vertical rail segments behind a row. `endX` is where the elbow's horizontal
 *  run stops (the row's dot/chevron centre). */
function GuideLines({ guides, endX }: { guides: AgentTreeRow['guides']; endX: number }) {
  if (guides.length === 0) return null;
  return (
    <>
      {guides.map((g, i) => (
        <span
          key={i}
          className={`aa-guide${g.last ? ' aa-guide--leaf' : ''}`}
          style={g.last ? { left: g.x, width: Math.max(1, endX - g.x) } : { left: g.x }}
          aria-hidden
        />
      ))}
    </>
  );
}

/** Centre x of the status dot for a row indented at `indent`:
 *  8 padding + 16 chevron/spacer + 8 gap + ~3.5 half-dot. */
function dotCenterX(indent: number): number {
  return indent + 35;
}

function AgentNodeRows({
  row, profiles, now, skew, collapsed, stopping, warnStopSeversParent, onToggle, onStop, onJump,
}: NodeRowsProps) {
  const { node, guides } = row;
  const indent = Math.min(node.depth, 6) * 14;
  const hasChildren = node.children.length > 0;
  const expanded = !collapsed.has(node.conversationId);
  const runningCount = subtreeSessionCount(node);
  const isScheduleHome = node.kind === 'schedule_home';
  const isPlaceholder = node.sessions.length === 0;
  const multi = node.sessions.length > 1;

  if (isPlaceholder) {
    const title = isScheduleHome ? node.title.replace(/^⏱\s*/, '') : node.title;
    return (
      <div
        className={`aa-row${isScheduleHome ? ' aa-row--schedule' : ' aa-row--inactive'}`}
        style={{ paddingLeft: 8 + indent }}
      >
        <GuideLines guides={guides} endX={dotCenterX(indent)} />
        <Chevron hasChildren={hasChildren} expanded={expanded} onToggle={() => onToggle(node.conversationId)} />
        {isScheduleHome && <span className="aa-schedule-icon" aria-hidden>⏱</span>}
        {!isScheduleHome && (
          <span
            className={activeAgentDotClass(undefined, node.depth, runningCount > 0)}
            title={runningCount > 0 ? 'subagent active' : 'idle'}
          />
        )}
        <div className="aa-row-main">
          <div className="aa-row-title-line">
            <div className="aa-row-title">{title}</div>
            <SessionMetaLine
              parts={{ agent: '', model: '', project: '' }}
              extra={`${runningCount} running`}
            />
          </div>
          {node.description && <div className="aa-row-desc" title={node.description}>{node.description}</div>}
          {node.tags && node.tags.length > 0 && (
            <div className="aa-row-tags">
              {node.tags.map((t) => (
                <span key={t} className="conversation-tag" title={t}>{t}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (multi) {
    return (
      <>
        <div className="aa-row" style={{ paddingLeft: 8 + indent }}>
          <GuideLines guides={guides} endX={indent + 16} />
          <Chevron hasChildren={hasChildren} expanded={expanded} onToggle={() => onToggle(node.conversationId)} />
          <div className="aa-row-main">
            <div className="aa-row-title-line">
              <div className="aa-row-title">{node.title}</div>
              <SessionMetaLine
                parts={{ agent: '', model: '', project: '' }}
                extra={!expanded ? `${runningCount} running` : undefined}
              />
            </div>
            {node.description && <div className="aa-row-desc" title={node.description}>{node.description}</div>}
            {node.tags && node.tags.length > 0 && (
              <div className="aa-row-tags">
                {node.tags.map((t) => (
                  <span key={t} className="conversation-tag" title={t}>{t}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        {node.sessions.map((s) => {
          const agentLabel = profileLabel(profiles, s.agentType, s.profileId);
          return (
            <SessionLine
              key={s.sessionId}
              indent={indent + 14}
              depth={node.depth}
              title={node.title}
              showTitle={false}
              guides={[...guides, { x: agentGuideX(node.depth), last: true }]}
              label={agentLabel}
              model={s.model}
              effort={s.effort}
              status={s.status}
              elapsed={formatHms(Math.max(0, now - skew - s.startedAt))}
              stopping={s.sessionId in stopping}
              showOpen
              warnStopSeversParent={warnStopSeversParent}
              onStop={() => onStop({
                sessionId: s.sessionId,
                title: node.title,
                agentLabel,
                model: s.model,
                warnStopSeversParent,
              })}
              onJump={() => onJump(node.conversationId)}
            />
          );
        })}
      </>
    );
  }

  const s = node.sessions[0]!;
  const agentLabel = profileLabel(profiles, s.agentType, s.profileId);
  return (
    <SessionLine
      indent={indent}
      depth={node.depth}
      chevron={<Chevron hasChildren={hasChildren} expanded={expanded} onToggle={() => onToggle(node.conversationId)} />}
      title={node.title}
      description={node.description}
      tags={node.tags}
      guides={guides}
      label={agentLabel}
      model={s.model}
      effort={s.effort}
      status={s.status}
      elapsed={formatHms(Math.max(0, now - skew - s.startedAt))}
      stopping={s.sessionId in stopping}
      showOpen
      collapsedHint={!expanded && hasChildren ? runningCount : undefined}
      warnStopSeversParent={warnStopSeversParent}
      onStop={() => onStop({
        sessionId: s.sessionId,
        title: node.title,
        agentLabel,
        model: s.model,
        warnStopSeversParent,
      })}
      onJump={() => onJump(node.conversationId)}
    />
  );
}

interface ChevronProps {
  hasChildren: boolean;
  expanded: boolean;
  onToggle: () => void;
}

function Chevron({ hasChildren, expanded, onToggle }: ChevronProps) {
  if (!hasChildren) return <span className="aa-chevron-spacer" />;
  return (
    <button
      type="button"
      className={`aa-chevron${expanded ? ' is-expanded' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={expanded ? 'Collapse' : 'Expand'}
      aria-label={expanded ? 'Collapse' : 'Expand'}
      aria-expanded={expanded}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </button>
  );
}

interface SessionLineProps {
  indent: number;
  depth: number;
  chevron?: ReactNode;
  title: string;
  description?: string;
  tags?: string[];
  showTitle?: boolean;
  /** Tree rails: the node's ancestor rails plus, for multi-session sub-rows,
   *  an elbow dropping from the node header. */
  guides?: AgentTreeRow['guides'];
  label: string;
  model: string;
  effort?: string;
  status: AgentStatus;
  elapsed: string;
  stopping: boolean;
  showOpen: boolean;
  collapsedHint?: number;
  warnStopSeversParent?: boolean;
  onStop: () => void;
  onJump: () => void;
}

function SessionLine({
  indent, depth, chevron, title, description, tags, showTitle = true, guides, label, model, effort, status,
  elapsed, stopping, showOpen, collapsedHint, warnStopSeversParent, onStop, onJump,
}: SessionLineProps) {
  const parts = sessionMetaParts(label, model);
  const stopLabel = stopping
    ? 'Stopping…'
    : warnStopSeversParent
      ? 'Stop (parent will not receive a result)'
      : 'Stop';
  return (
    <div
      className={`aa-row aa-row--active${chevron ? '' : ' aa-row-session'}`}
      style={{ paddingLeft: 8 + indent }}
    >
      {guides && guides.length > 0 && (
        <GuideLines guides={guides} endX={dotCenterX(indent)} />
      )}
      {chevron ?? <span className="aa-chevron-spacer" />}
      <span className={activeAgentDotClass(status, depth)} title={status} />
      <div className="aa-row-main">
        <div className="aa-row-title-line">
          {showTitle && <div className="aa-row-title">{title}</div>}
          <SessionMetaLine
            parts={parts}
            extra={collapsedHint !== undefined ? `${collapsedHint} running` : undefined}
          />
          {effort && <span className="aa-row-effort">effort: {effort}</span>}
          {elapsed && <div className="aa-row-time">{elapsed}</div>}
        </div>
        {showTitle && description && <div className="aa-row-desc" title={description}>{description}</div>}
        {showTitle && tags && tags.length > 0 && (
          <div className="aa-row-tags">
            {tags.map((t) => (
              <span key={t} className="conversation-tag" title={t}>{t}</span>
            ))}
          </div>
        )}
        <div className="aa-row-actions">
          <button
            type="button"
            className="icon-btn aa-action aa-action--stop"
            disabled={stopping}
            onClick={onStop}
            title={stopLabel}
            aria-label={stopLabel}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
            <span>{stopping ? 'Stopping…' : 'Stop'}</span>
          </button>
          {showOpen && <OpenButton onClick={onJump} />}
        </div>
      </div>
    </div>
  );
}

function OpenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn aa-action aa-action--open"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="Open conversation"
      aria-label="Open conversation"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
      <span>Open</span>
    </button>
  );
}

export { AgentActivityModal as ActiveAgentsModal };
