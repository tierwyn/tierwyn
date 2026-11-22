import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Project, Conversation, AgentStatus, SpawnTemplate, AgentProfile, ScheduleJob, ScheduleRun, Workdir, ScheduleKind, SchedulePack, CreateScheduleJobRequest, GrokBotLifecycleState, GrokBotLifecycleStatus, CapabilityProfile, RemoteHostView, ProjectBrowseRoots, SandboxPath, SandboxSetting, SandboxSettings, ExecutionMode, PendingHandoffMode } from '@tierwyn/shared';
import { formatDateTimeInTimezone, collectKnownTags, matchesTagQuery, suggestTags, validateSchedulePack, REMOTE_AGENTS_PROJECT_ID, BUILTIN_DESIGNATIONS, BUILTIN_CAPABILITY_PROFILES, normaliseTags, MAX_TAGS, MAX_TAG_LENGTH, isCloneUrlAllowed, SCHEDULE_INHERIT_PROFILE_ID } from '@tierwyn/shared';
import { remotePathHint, repoNameFromUrl, type PathHint } from '../remotePathHint.js';
import { remoteHostMatchesSearch, remoteHostSidebarLabel, remoteHostSidebarTooltip } from '../remoteHostSidebar.js';
import { PINNED_PROJECT_ID, pinnedPseudoProject, collectPinnedConversations, groupPinnedItems, type PinnedListItem } from '../pinned.js';
import { TouchHoldButton } from '../touchTap.js';
import {
  type SidebarGroupBy,
  type ProjectOrder,
  type StatusBucket,
  type SearchScope,
  type AggregateCounts,
  type FlatRow,
  STATUS_BUCKET_ORDER,
  parseGroupBy,
  parseProjectOrder,
  parseSearchScope,
  resolveSearchScopeProjectId,
  bucketFromDot,
  filterConversations,
  activityAt,
  subtreeActivity,
  orderProjects,
  groupProjectsByHost,
  layoutScheduleProjects,
  hostBadgedProjectOptions,
  projectScheduleDeleteNote,
  collectScheduleTreeConversations,
  buildRecentRows,
  buildStatusBuckets,
  aggregateCounts,
  clampSidebarWidth,
  SIDEBAR_W_MIN,
  SIDEBAR_W_MAX,
  SIDEBAR_W_DEFAULT,
  newlySpawnedParents,
} from '../sidebarViews.js';
import {
  SidebarConversationRow,
} from './SidebarConversationRow.js';
import { ConvOverflowMenu, type OverflowPos } from './ConvOverflowMenu.js';
import { formatRelativeTime } from '../agentActivity.js';
import { lsGet, lsSet } from '../prefixedStorage.js';
import { api, searchConversationContent, type ConversationSearchHit, type ScheduleTreeResponse, type ScheduleTreeJobEntry, type ScheduleTreeRunEntry, PackFileConflictError } from '../api.js';
import {
  DURATION_UNIT_OPTIONS,
  durationPartsToMs,
  msToDurationParts,
  type DurationUnit,
} from '../duration.js';
import {
  BLANK_JOB_PROMPT,
  cadenceToFormState,
  formStateToCreateBody,
  packApplyToastMessage,
  profileHasSpawnCapacity,
  spawnCapRemedy,
} from '../schedulePackForm.js';
import { forcedExecutionMode, isBarePromptProfile, scheduleProfilesFor } from '../scheduleProfiles.js';
import { TemplatePreviewModal } from './TemplatePreviewModal.js';
import { SelectDropdown } from './SelectDropdown.js';
import { ModelSelector } from './ModelSelector.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CronBuilderModal, describeCron } from './CronBuilderModal.js';
import { TimezoneField } from './TimezonePickerModal.js';
import { EditConversationModal } from './EditConversationModal.js';
import { EditProjectModal } from './EditProjectModal.js';
import { SandboxPathList } from './SandboxPathList.js';
import { projectSandboxInheritLabel } from '../sandboxControl.js';
import { FolderPickerModal } from './FolderPickerModal.js';
import { patchConversationInList } from '../conversationPatch.js';
import {
  shouldApplyRequestedMainTab,
  shouldAttemptSidebarReveal,
  shouldFollowSelectionToSchedules,
  shouldSyncScheduleTabForSelection,
  visibleOnProjectsTab,
  scheduleConversationIds,
  scheduleConversationIdsForJobs,
} from '../sidebarTabs.js';
import { findScheduleTreeConversation } from '../scheduleCalendar.js';
import { bulkCountLabel, canPin, summariseBulkResults, summariseScheduleBulkResults } from '../bulkSelect.js';
import { ShellAllowModal } from './ShellAllowModal.js';
import { isGrokBotProject, isRemoteAgentsProject } from '../remoteAgentsProfile.js';
import { filterGrokBotProject, statusDotColor } from '../grokBotStatus.js';
import { GrokBotIcon } from './GrokBotIcon.js';
import { PinnedFolderIcon } from './PinnedFolderIcon.js';
import { HubHostIcon } from './HubHostIcon.js';
import { RemoteHostIcon } from './RemoteHostIcon.js';
import { RemoteHostHeaderMeta } from './RemoteHostHeaderMeta.js';
import {
  type DotResult,
  resolveConversationDot,
  hasActiveDescendant,
  runFallbackStatus,
  resolveJobAggregateDot,
  effectiveLiveStatus,
} from '../statusDot.js';

interface Props {
  selectedProjectId: string | null;
  selectedConversationId: string | null;
  onSelectConversation: (project: Project, conversation: Conversation, focusEventId?: string, opts?: { keepSidebarOpen?: boolean; focusQuery?: string }) => void;
  /** Lightweight patch for the selected conversation after a rename / metadata
   *  edit. Updates App's selection.conversation IN PLACE — does NOT route
   *  through onSelectConversation (which clears events + refetches transcript).
   *  Called for any rename, only matters when the renamed conv is selected. */
  onConversationRenamed?: (updated: Conversation) => void;
  /** Live title/description/tags patch from conversation_updated metadata frames. */
  liveConversationMeta?: {
    conversationId: string; title?: string; description?: string; tags?: string[];
    designation?: string | null; pendingHandoffMode?: PendingHandoffMode | null;
    sandbox?: SandboxSetting | null;
  } | null;
  onConversationDeleted?: (conversationId: string | string[]) => void;
  /** After hard-delete of a schedule job from the tree. */
  onScheduleJobDeleted?: (jobId: string, deletedConversationIds: string[]) => void;
  /** After soft-archive of a schedule job from the tree. */
  onScheduleJobArchived?: (jobId: string) => void;
  /** Fired when a project is deleted server-side (after the undo window
   *  expires or the toast is flushed). Lets App.tsx clear selection if the
   *  deleted project was active. */
  onProjectDeleted?: (projectId: string) => void;
  activeConversationIds: string[];
  /** Live per-conversation agent status (running/idle/waiting/error/done).
   *  Conversations missing from this map are "never-active" → grey dot. */
  conversationStatuses: Record<string, AgentStatus>;
  /** Conversations whose stale REST `lastStatus: 'error'` has been superseded
   *  by later non-error activity — suppresses the sticky red dot. */
  errorRecoveredConversationIds: ReadonlySet<string>;
  /** Conversations the WS layer has touched — gates stale REST liveStatus. */
  wsObservedConversationIds: ReadonlySet<string>;
  /** Conversations whose native CLI helpers are still running (dashed ring). */
  helpersRunningIds?: ReadonlySet<string>;
  unreadConversationIds: string[];
  clearUnread: (conversationId: string) => void;
  /** Header-pill badge status for the currently-selected conversation.
   *  When supplied, the selected row's dot mirrors this exactly so the
   *  sidebar indicator never diverges from the in-chat header pill (e.g.
   *  stuck on 'running' while the header shows 'error' or 'grey'). */
  selectedBadgeStatus?: 'running' | 'waiting' | 'error' | 'done' | 'grey';
  /** Mobile-only: whether the off-canvas drawer is open. Desktop ignores this. */
  isOpen?: boolean;
  /** Mobile-only: callback to close the drawer (e.g. from a close button inside). */
  onClose?: () => void;
  /** Desktop: whether sidebar is pinned in grid layout (true) or collapsible overlay (false). */
  isPinned?: boolean;
  /** Toggle pinned state. */
  onTogglePin?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  refetchTrigger?: number;
  /** Conversation ids deleted on another device — drop them from bulk-select. */
  pruneConversationIds?: string[];
  profileLabels?: Record<string, string>;
  profilesLoaded?: boolean;
  /** Selected schedule job id (Schedule browser main pane). */
  selectedJobId?: string | null;
  /** Open Schedule browser for a job — never open the structural home as chat. */
  onSelectJob?: (project: Project, jobId: string, opts?: { keepSidebarOpen?: boolean }) => void;
  /** Latest loaded projects / conversations / schedule trees for notification lookup. */
  onDirectoryChange?: (dir: {
    projects: Project[];
    conversations: Record<string, Conversation[]>;
    scheduleTrees: Record<string, ScheduleTreeResponse>;
  }) => void;
  /** External trigger to open the New Conversation modal (e.g. from CommandPalette). */
  openNewConversationTick?: number;
  /** Target project ID for the New Conversation modal. */
  targetNewConversationProjectId?: string | null;
  /** External trigger to switch the Sidebar tab (e.g. to 'schedules' from CommandPalette). */
  requestedMainTab?: { tab: 'projects' | 'schedules'; tick: number } | null;
  /** Fired whenever the operator switches the top-level sidebar tab (D4). */
  onMainTabChange?: (tab: 'projects' | 'schedules') => void;
  /** "Calendar" tree row → full-window schedule calendar. */
  onOpenScheduleCalendar?: (opts?: { keepSidebarOpen?: boolean }) => void;
  /** Highlights the Calendar row when that pane is the current main selection. */
  scheduleCalendarSelected?: boolean;
  /** When true, shipped schedule packs are not listed in the schedule Pack picker. */
  hideShippedSchedulePacks?: boolean;
  /** Bump only to scroll the selected row into view (Active Agents Open). */
  revealSelectionTick?: number;
  /** Scroll/unfold the selected schedule-tree row after boot restore or tab sync. */
  onRevealSelection?: () => void;
  /** Open the git working-tree panel for a conversation's default tree. */
  onOpenGitPanel?: (conv: Conversation) => void;
  /** Open the git working-tree panel for a project's default tree. */
  onOpenGitPanelForProject?: (project: Project) => void;
  /** Open operator rules editor for a project. */
  onOpenProjectRules?: (project: Project) => void;
  /** Open operator rules editor for a conversation. */
  onOpenConversationRules?: (conversation: Conversation, project: Project) => void;
  /** Open Settings → Sandbox from the project editor inherit link. */
  onOpenSandboxSettings?: () => void;
  grokBotEnabled?: boolean;
  grokBotState?: GrokBotLifecycleState;
  /** When true, grok-bot profiles appear in the schedule modal for normal projects. */
  grokBotInProjectChats?: boolean;
  /** Full lifecycle snapshot for schedule-modal usability hints (D3). */
  grokBotStatus?: GrokBotLifecycleStatus | null;
  remoteHosts?: RemoteHostView[];
  sidebarWidth?: number;
  onSidebarWidthChange?: (newW: number) => void;
  shellRef?: React.RefObject<HTMLDivElement | null>;
  resizingRef?: React.MutableRefObject<boolean>;
  liveActivityAt?: Record<string, number>;
}

/** Progressive sidebar lists: initial slice + step per "Show more" click. */
const LIST_INITIAL_PAGE = 7;
const LIST_PAGE_STEP = 10;

function limitForListPage(page: number): number {
  return LIST_INITIAL_PAGE + (page - 1) * LIST_PAGE_STEP;
}

function HostChip({ project, hosts }: { project: Project; hosts: RemoteHostView[] }) {
  if (!project.remoteHostId) return null;
  const host = hosts.find((h) => h.id === project.remoteHostId);
  const name = host ? remoteHostSidebarLabel(host) : 'remote';
  const offline = host?.state !== 'connected';
  const tip = host ? remoteHostSidebarTooltip(host) : name;
  return (
    <span
      className={`host-chip${offline ? ' host-chip--offline' : ''}`}
      title={offline ? `${tip}\n(${host?.state ?? 'offline'})` : tip}
    >
      {name}
    </span>
  );
}

function AggregateBadge({ counts }: { counts: AggregateCounts }) {
  const hasAny = counts.waiting > 0 || counts.error > 0 || counts.running > 0 || counts.subagents > 0 || counts.unread > 0;
  if (!hasAny) return null;
  return (
    <span className="sidebar-agg">
      {counts.waiting > 0 && (
        <span className="sidebar-agg-item waiting" title={`${counts.waiting} waiting`}>
          <span className="sidebar-agg-dot" />
          {counts.waiting}
        </span>
      )}
      {counts.error > 0 && (
        <span className="sidebar-agg-item error" title={`${counts.error} error`}>
          <span className="sidebar-agg-dot" />
          {counts.error}
        </span>
      )}
      {counts.running > 0 && (
        <span className="sidebar-agg-item running" title={`${counts.running} running`}>
          <span className="sidebar-agg-dot" />
          {counts.running}
        </span>
      )}
      {counts.subagents > 0 && (
        <span className="sidebar-agg-item subagents" title={`${counts.subagents} subagents active`}>
          <span className="sidebar-agg-diamond" />
          {counts.subagents}
        </span>
      )}
      {counts.unread > 0 && (
        <span className="sidebar-agg-item unread" title={`${counts.unread} unread`}>
          <span className="sidebar-agg-dot" />
          {counts.unread}
        </span>
      )}
    </span>
  );
}

function ShowMoreButton({
  hiddenCount,
  total,
  onClick,
}: {
  hiddenCount: number;
  total?: number;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const step = Math.min(hiddenCount, LIST_PAGE_STEP);
  return (
    <button
      type="button"
      className="conversation-list-toggle"
      onClick={onClick}
      title={`Show ${step} more`}
      aria-expanded={false}
    >
      <span className="conversation-list-toggle-dots" aria-hidden>···</span>
      <span className="conversation-list-toggle-count">
        {total != null ? `Show ${step} more (${total} total)` : `Show ${step} more`}
      </span>
    </button>
  );
}

function posFromOverflowBtn(id: string, btn: HTMLElement): OverflowPos {
  const r = btn.getBoundingClientRect();
  return {
    id,
    triggerRect: {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    },
  };
}

function formatRunTitle(run: ScheduleRun, conv?: Conversation, timezone = 'UTC'): string {
  if (conv?.title?.trim()) return conv.title;
  try {
    return `run ${formatDateTimeInTimezone(run.firedAt, timezone, undefined)}`;
  } catch {
    return `run ${run.id.slice(0, 8)}`;
  }
}

/** Filter a schedule tree to runs (and their jobs) with activity within `days`.
 *  Activity = run.firedAt, run conversation updatedAt, or any descendant
 *  updatedAt inside the window. Always keeps runs containing the selected
 *  conversation so selecting a stale run never orphans it. days=0 returns the
 *  tree unfiltered.
 *  `keepIds` (run conversation id or descendant id) survives the window —
 *  same D7 rule as the projects list: a content hit must not vanish because
 *  its last activity is older than `recentDays`. */
function filterScheduleTreeByRecent(
  tree: ScheduleTreeResponse | undefined,
  days: number,
  selectedConversationId: string | null,
  keepIds?: Set<string>,
): ScheduleTreeResponse {
  if (!tree) return { jobs: [] };
  if (days === 0) return tree;
  const threshold = days * 86_400_000;
  const now = Date.now();
  const isRecent = (t: number) => now - t < threshold;
  const jobs: ScheduleTreeJobEntry[] = [];
  for (const job of tree.jobs) {
    const runs: ScheduleTreeRunEntry[] = [];
    for (const r of job.runs) {
      const sel = selectedConversationId != null && (
        r.conversation?.id === selectedConversationId
        || r.descendants.some((d) => d.id === selectedConversationId)
      );
      const recent =
        isRecent(r.run.firedAt)
        || (r.conversation ? isRecent(r.conversation.updatedAt) : false)
        || r.descendants.some((d) => isRecent(d.updatedAt));
      const contentKeep = keepIds != null && (
        (r.conversation?.id != null && keepIds.has(r.conversation.id))
        || r.descendants.some((d) => keepIds.has(d.id))
      );
      if (sel || recent || contentKeep) runs.push(r);
    }
    if (runs.length > 0) jobs.push({ job: job.job, runs });
  }
  return { jobs };
}

/** Nest flat descendants under a run conversation by parentConversationId. */
function orderRunDescendants(
  descendants: Conversation[],
  runConversationId: string,
): { c: Conversation; depth: number }[] {
  const byParent = new Map<string, Conversation[]>();
  for (const d of descendants) {
    const pid = d.parentConversationId ?? '';
    const arr = byParent.get(pid) ?? [];
    arr.push(d);
    byParent.set(pid, arr);
  }
  const result: { c: Conversation; depth: number }[] = [];
  const walk = (parentId: string, depth: number) => {
    const kids = byParent.get(parentId) ?? [];
    for (const k of kids) {
      result.push({ c: k, depth });
      walk(k.id, depth + 1);
    }
  };
  walk(runConversationId, 1);
  return result;
}

/** FW-15 — chips sit inside a conversation-item <button>, so they are
 *  role=button spans (same nested-interactive pattern as .fold-toggle).
 *  F12: Enter/Space toggle the filter; click already did. */
function DesignationChip({ designation }: { designation?: string }) {
  if (!designation) return null;
  return <span className="conversation-designation">{designation}</span>;
}

/** FW-15 — chips sit inside a conversation-item <button>, so they are
 *  role=button spans (same nested-interactive pattern as .fold-toggle).
 *  F12: Enter/Space toggle the filter; click already did. */
function ConversationTagChips({
  tags,
  activeTag,
  onToggle,
}: {
  tags: string[] | undefined;
  activeTag: string | null;
  onToggle: (tag: string) => void;
}) {
  const list = tags ?? [];
  if (list.length === 0) return null;
  return (
    <span className="conversation-tags">
      {list.map((t) => (
        <span
          key={t}
          role="button"
          tabIndex={0}
          className={`conversation-tag${activeTag === t ? ' conversation-tag--active' : ''}`}
          title={activeTag === t ? `Clear filter: ${t}` : `Filter by tag: ${t}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(t);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onToggle(t);
            }
          }}
        >
          {t}
        </span>
      ))}
    </span>
  );
}

export function Sidebar({
  selectedProjectId,
  selectedConversationId,
  onSelectConversation,
  onConversationRenamed,
  liveConversationMeta,
  onConversationDeleted,
  onScheduleJobDeleted,
  onScheduleJobArchived,
  onProjectDeleted,
  activeConversationIds,
  conversationStatuses,
  errorRecoveredConversationIds,
  wsObservedConversationIds,
  helpersRunningIds,
  unreadConversationIds,
  clearUnread,
  selectedBadgeStatus,
  isOpen,
  isPinned = true,
  onTogglePin,
  onMouseEnter,
  onMouseLeave,
  refetchTrigger,
  pruneConversationIds,
  profileLabels = {},
  profilesLoaded = false,
  selectedJobId = null,
  onSelectJob,
  onDirectoryChange,
  openNewConversationTick = 0,
  targetNewConversationProjectId = null,
  requestedMainTab = null,
  onMainTabChange,
  onOpenScheduleCalendar,
  scheduleCalendarSelected = false,
  hideShippedSchedulePacks = false,
  revealSelectionTick = 0,
  onRevealSelection,
  onOpenGitPanel,
  onOpenGitPanelForProject,
  onOpenProjectRules,
  onOpenConversationRules,
  onOpenSandboxSettings,
  grokBotEnabled = true,
  grokBotState,
  grokBotInProjectChats = false,
  grokBotStatus = null,
  remoteHosts = [],
  sidebarWidth,
  onSidebarWidthChange,
  shellRef,
  resizingRef,
  liveActivityAt,
}: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Record<string, Conversation[]>>({});
  const [scheduleTrees, setScheduleTrees] = useState<Record<string, ScheduleTreeResponse>>({});
  useEffect(() => {
    onDirectoryChange?.({ projects, conversations, scheduleTrees });
  }, [projects, conversations, scheduleTrees, onDirectoryChange]);

  const [groupBy, setGroupByState] = useState<SidebarGroupBy>(() =>
    parseGroupBy(lsGet('tierwyn:sidebar-group-by')),
  );
  const setGroupBy = (v: SidebarGroupBy) => {
    setGroupByState(v);
    lsSet('tierwyn:sidebar-group-by', v);
  };

  const [projectOrder, setProjectOrderState] = useState<ProjectOrder>(() =>
    parseProjectOrder(lsGet('tierwyn:sidebar-project-order')),
  );
  const setProjectOrder = (v: ProjectOrder) => {
    setProjectOrderState(v);
    lsSet('tierwyn:sidebar-project-order', v);
  };

  const [hostCollapsed, setHostCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const raw = lsGet('tierwyn:sidebar-host-collapsed');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const toggleHostCollapse = (key: string) => {
    setHostCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      lsSet('tierwyn:sidebar-host-collapsed', JSON.stringify(next));
      return next;
    });
  };

  const [statusCollapsed, setStatusCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const raw = lsGet('tierwyn:sidebar-status-collapsed');
      return raw ? JSON.parse(raw) : { idle: true };
    } catch {
      return { idle: true };
    }
  });
  const toggleStatusCollapse = (key: string) => {
    setStatusCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      lsSet('tierwyn:sidebar-status-collapsed', JSON.stringify(next));
      return next;
    });
  };

  const [statusFilter, setStatusFilter] = useState<Set<StatusBucket>>(() => new Set());
  const toggleStatusFilter = (b: StatusBucket) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  };

  const [viewPopoverOpen, setViewPopoverOpen] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  const [recentPage, setRecentPage] = useState(1);
  const [statusIdlePage, setStatusIdlePage] = useState(1);

  const stickySelectionRef = useRef<{ id: string; bucket: StatusBucket } | null>(null);
  const prevSelectedIdRef = useRef<string | null>(null);

  const isHoveringListRef = useRef(false);
  const frozenRecentOrderRef = useRef<string[] | null>(null);
  const frozenStatusOrderRef = useRef<Map<StatusBucket, string[]> | null>(null);
  const [, setHoverFreezeVersion] = useState(0);

  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('collapsedProjects') ?? '{}'); } catch { return {}; }
  });
  const [collapsedPinnedGroups, setCollapsedPinnedGroups] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('collapsedPinnedGroups') ?? '{}'); } catch { return {}; }
  });
  // Spawn children folded by default; remember per-parent fold state.
  // ponytail: a parent missing from localStorage defaults to folded (true) —
  // matches "should be folded when opened" without an explicit per-conv flag.
  const [foldedParents, setFoldedParents] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('foldedParents') ?? '{}'); } catch { return {}; }
  });
  // Schedule job rows: expanded by default so recent runs are visible.
  const [foldedScheduleJobs, setFoldedScheduleJobs] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('foldedScheduleJobs') ?? '{}'); } catch { return {}; }
  });
  // Top-level sidebar tab: Projects (chats) vs Schedules (schedule tree).
  const [sidebarMainTab, setSidebarMainTab] = useState<'projects' | 'schedules'>(() => {
    try {
      const v = localStorage.getItem('sidebarMainTab');
      return v === 'schedules' ? 'schedules' : 'projects';
    } catch {
      return 'projects';
    }
  });

  const projectsListRef = useRef<HTMLDivElement | null>(null);
  const schedulesListRef = useRef<HTMLDivElement | null>(null);
  const sidebarRootRef = useRef<HTMLElement | null>(null);
  const projectsScrollTopRef = useRef<number>(
    (() => {
      try { return Number(sessionStorage.getItem('sidebarProjectsScrollTop')) || 0; } catch { return 0; }
    })()
  );
  const schedulesScrollTopRef = useRef<number>(
    (() => {
      try { return Number(sessionStorage.getItem('sidebarSchedulesScrollTop')) || 0; } catch { return 0; }
    })()
  );

  // Ref-mirrored so setMainTab's identity never changes — the requestedMainTab
  // effect below depends on it, and a changing identity would re-fire it every
  // time App re-rendered from the setSelection this callback triggers (D13).
  const onMainTabChangeRef = useRef(onMainTabChange);
  useEffect(() => { onMainTabChangeRef.current = onMainTabChange; }, [onMainTabChange]);
  const sidebarMainTabRef = useRef(sidebarMainTab);
  useEffect(() => { sidebarMainTabRef.current = sidebarMainTab; }, [sidebarMainTab]);
  const lastRequestedMainTabTickRef = useRef(0);
  const lastRevealedSelectionTickRef = useRef(0);
  const lastExpandedSelectionTickRef = useRef(0);
  /** Operator explicitly chose Projects while a schedule run stays in the main pane. */
  const suppressScheduleTabFollowRef = useRef(false);
  const onRevealSelectionRef = useRef(onRevealSelection);
  useEffect(() => { onRevealSelectionRef.current = onRevealSelection; }, [onRevealSelection]);
  const scheduleRevealDoneForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!viewPopoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) {
        setViewPopoverOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setViewPopoverOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [viewPopoverOpen]);

  useEffect(() => {
    if (statusFilter.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setStatusFilter(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [statusFilter]);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !onSidebarWidthChange) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (resizingRef) resizingRef.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth ?? SIDEBAR_W_DEFAULT;
    document.body.classList.add('sidebar-resizing');

    let currentW = startW;
    let hasMoved = false;
    let rafId: number | null = null;

    const onPointerMove = (ev: PointerEvent) => {
      if (resizingRef && !resizingRef.current) return;
      if (Math.abs(ev.clientX - startX) > 2) {
        hasMoved = true;
      }
      const nextW = clampSidebarWidth(startW + (ev.clientX - startX), window.innerWidth);
      currentW = nextW;
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          if (shellRef?.current) {
            shellRef.current.style.setProperty('--sidebar-w', `${currentW}px`);
          }
          rafId = null;
        });
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      if (resizingRef) resizingRef.current = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.body.classList.remove('sidebar-resizing');
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerUp);

      if (hasMoved) {
        onSidebarWidthChange(currentW);
      } else if (shellRef?.current) {
        shellRef.current.style.setProperty('--sidebar-w', `${startW}px`);
      }
    };

    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerUp);
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSidebarWidthChange) return;
    const currentW = sidebarWidth ?? SIDEBAR_W_DEFAULT;
    let delta = 0;
    if (e.key === 'ArrowLeft') delta = e.shiftKey ? -48 : -16;
    else if (e.key === 'ArrowRight') delta = e.shiftKey ? 48 : 16;
    else if (e.key === 'Home') {
      e.preventDefault();
      onSidebarWidthChange(clampSidebarWidth(SIDEBAR_W_MIN, window.innerWidth));
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      onSidebarWidthChange(clampSidebarWidth(SIDEBAR_W_MAX, window.innerWidth));
      return;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSidebarWidthChange(clampSidebarWidth(SIDEBAR_W_DEFAULT, window.innerWidth));
      return;
    }

    if (delta !== 0) {
      e.preventDefault();
      onSidebarWidthChange(clampSidebarWidth(currentW + delta, window.innerWidth));
    }
  };

  const handleResizeDoubleClick = () => {
    onSidebarWidthChange?.(clampSidebarWidth(SIDEBAR_W_DEFAULT, window.innerWidth));
  };

  const requestScheduleSelectionReveal = useCallback((convId: string | null | undefined) => {
    if (!convId || scheduleRevealDoneForRef.current === convId) return;
    scheduleRevealDoneForRef.current = convId;
    // Defer until after App selection state commits (boot restore calls select
    // from inside a list updater).
    window.setTimeout(() => onRevealSelectionRef.current?.(), 0);
  }, []);

  const setMainTab = useCallback((tab: 'projects' | 'schedules', opts?: { userInitiated?: boolean }) => {
    if (opts?.userInitiated && tab === 'projects') {
      suppressScheduleTabFollowRef.current = true;
    } else if (opts?.userInitiated && tab === 'schedules') {
      suppressScheduleTabFollowRef.current = false;
    }
    const current = sidebarMainTabRef.current;
    if (current === 'projects' && projectsListRef.current) {
      const st = projectsListRef.current.scrollTop;
      projectsScrollTopRef.current = st;
      try { sessionStorage.setItem('sidebarProjectsScrollTop', String(st)); } catch { /* ignore */ }
    } else if (current === 'schedules' && schedulesListRef.current) {
      const st = schedulesListRef.current.scrollTop;
      schedulesScrollTopRef.current = st;
      try { sessionStorage.setItem('sidebarSchedulesScrollTop', String(st)); } catch { /* ignore */ }
    }
    setSidebarMainTab(tab);
    setSelecting(false);
    setSelectedIds(new Set());
    try { localStorage.setItem('sidebarMainTab', tab); } catch { /* ignore */ }
    onMainTabChangeRef.current?.(tab);
  }, []);

  useLayoutEffect(() => {
    if (sidebarMainTab === 'projects' && projectsListRef.current) {
      projectsListRef.current.scrollTop = projectsScrollTopRef.current;
    } else if (sidebarMainTab === 'schedules' && schedulesListRef.current) {
      schedulesListRef.current.scrollTop = schedulesScrollTopRef.current;
    }
  }, [sidebarMainTab, isOpen]);
  // Per-project progressive-load page count. 1 = initial slice; each
  // "Show more" click increments. Not persisted — resets on remount, which
  // matches the progressive-load intent (start shallow, expand on demand).
  const [convListPageSizes, setConvListPageSizes] = useState<Record<string, number>>({});
  const [scheduleJobListPageSizes, setScheduleJobListPageSizes] = useState<Record<string, number>>({});
  const [scheduleRunListPageSizes, setScheduleRunListPageSizes] = useState<Record<string, number>>({});
  /** Per-project runLimit last used for scheduleTree (server may have more). */
  const [scheduleTreeRunLimits, setScheduleTreeRunLimits] = useState<Record<string, number>>({});
  // Locally-tracked manual mark-as-unread. The selected row's dot reads
  // selectedBadgeStatus (from the header pill, derived from live events),
  // which doesn't know about the manual unread reset — without this set,
  // marking the currently-selected conversation unread would only surface
  // green after the user navigates away and back. Cleared on click/select.
  const [manuallyMarkedUnread, setManuallyMarkedUnread] = useState<Set<string>>(new Set());

  // Live refs for values that the initial-restore logic needs to read without
  // forcing refreshProjects (and therefore the whole sidebar list) to refetch
  // every time they change. Without this, clicking a conversation flipped
  // selectedConversationId → refreshProjects got a new identity → the mount
  // effect refired → projects+conversations refetched → sidebar jumped.
  const selectedConversationIdRef = useRef(selectedConversationId);
  const onSelectConversationRef = useRef(onSelectConversation);
  const onSelectJobRef = useRef(onSelectJob);
  const onOpenScheduleCalendarRef = useRef(onOpenScheduleCalendar);
  const activeConversationIdsRef = useRef(activeConversationIds);
  const didInitialRestoreRef = useRef(false);
  // Migration 114: refreshProjects (defined above the showArchived state)
  // reads the flag through this ref to swap the list endpoint.
  const showArchivedRef = useRef(false);
  useEffect(() => { selectedConversationIdRef.current = selectedConversationId; }, [selectedConversationId]);
  useEffect(() => { onSelectConversationRef.current = onSelectConversation; }, [onSelectConversation]);
  useEffect(() => { onSelectJobRef.current = onSelectJob; }, [onSelectJob]);
  useEffect(() => { onOpenScheduleCalendarRef.current = onOpenScheduleCalendar; }, [onOpenScheduleCalendar]);
  useEffect(() => { activeConversationIdsRef.current = activeConversationIds; }, [activeConversationIds]);

  useEffect(() => {
    if (!liveConversationMeta) return;
    const { conversationId, title, description, tags, designation, pendingHandoffMode, sandbox } = liveConversationMeta;
    const patch: Partial<Conversation> & { id: string } = { id: conversationId };
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    if (tags !== undefined) patch.tags = tags;
    if (designation !== undefined) patch.designation = designation ?? undefined;
    if (pendingHandoffMode !== undefined) patch.pendingHandoffMode = pendingHandoffMode ?? undefined;
    if (sandbox !== undefined) patch.sandbox = sandbox ?? undefined;

    setConversations((prev) => {
      let foundPid: string | undefined;
      for (const [pid, list] of Object.entries(prev)) {
        if (list.some((c) => c.id === conversationId)) {
          foundPid = pid;
          break;
        }
      }
      if (!foundPid) return prev;
      const nextList = patchConversationInList(prev[foundPid], patch);
      if (!nextList || nextList === prev[foundPid]) return prev;
      return { ...prev, [foundPid]: nextList };
    });

    setScheduleTrees((prev) => {
      let any = false;
      const next: Record<string, ScheduleTreeResponse> = {};
      for (const [pid, tree] of Object.entries(prev)) {
        let changed = false;
        const jobs = tree.jobs.map((entry) => ({
          ...entry,
          runs: entry.runs.map((runEntry) => {
            let conversation = runEntry.conversation;
            if (conversation?.id === conversationId) {
              conversation = { ...conversation, ...patch };
              changed = true;
            }
            const descendants = patchConversationInList(runEntry.descendants, patch);
            if (descendants !== runEntry.descendants) changed = true;
            return { ...runEntry, conversation, descendants: descendants ?? runEntry.descendants };
          }),
        }));
        next[pid] = changed ? { jobs } : tree;
        if (changed) any = true;
      }
      return any ? next : prev;
    });
  }, [liveConversationMeta]);

  const refreshProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    list.forEach((p) => {
      // Chat list + schedules tree in parallel (option A: tree feeds Schedules only).
      void Promise.all([
        api.listConversations(p.id, { includeArchived: showArchivedRef.current }),
        api.scheduleTree(p.id, LIST_INITIAL_PAGE, { includeArchived: showArchivedRef.current }).catch((): ScheduleTreeResponse => ({ jobs: [] })),
      ]).then(([convs, tree]) => {
        const mapped = visibleOnProjectsTab(convs, scheduleConversationIds(tree))
          .map((c) => ({
            ...c,
            isActive: c.isActive || activeConversationIdsRef.current.includes(c.id),
          }));
        setScheduleTrees((prev) => ({ ...prev, [p.id]: tree }));
        setScheduleTreeRunLimits((prev) => ({ ...prev, [p.id]: LIST_INITIAL_PAGE }));
        setConversations((prev) => {
          const next = { ...prev, [p.id]: mapped };
          // Restore last-selected conversation only on the very first refresh
          // and only if nothing is selected yet. After that, selection is
          // user-driven — never override it via a refetch.
          if (!didInitialRestoreRef.current && !selectedConversationIdRef.current) {
            try {
              const currentTab = localStorage.getItem('sidebarMainTab') ?? 'projects';
              if (currentTab === 'schedules') {
                const sType = localStorage.getItem('lastSchedulesType');
                const sPid = localStorage.getItem('lastSchedulesProjectId') ?? localStorage.getItem('lastProjectId');
                const sJobId = localStorage.getItem('lastSchedulesJobId') ?? localStorage.getItem('lastScheduleJobId');
                const sCid = localStorage.getItem('lastSchedulesConversationId') ?? localStorage.getItem('lastConversationId');
                if (sType === 'job' && sPid === p.id && sJobId) {
                  const found = tree.jobs.some((j) => j.job.id === sJobId);
                  if (found) {
                    didInitialRestoreRef.current = true;
                    onSelectJobRef.current?.(p, sJobId, { keepSidebarOpen: true });
                  } else {
                    didInitialRestoreRef.current = true;
                    onOpenScheduleCalendarRef.current?.({ keepSidebarOpen: true });
                  }
                } else if (sType === 'conversation' && sPid === p.id && sCid) {
                  // Schedule runs/descendants are absent from `mapped` (Projects
                  // tab + listConversations hide the schedule tree). Resolve
                  // from the schedule tree that just loaded for this project.
                  const found = findScheduleTreeConversation(tree, sCid);
                  if (found) {
                    didInitialRestoreRef.current = true;
                    onSelectConversationRef.current(p, found, undefined, { keepSidebarOpen: true });
                    requestScheduleSelectionReveal(found.id);
                  } else {
                    didInitialRestoreRef.current = true;
                    onOpenScheduleCalendarRef.current?.({ keepSidebarOpen: true });
                  }
                } else if (sType === 'calendar' || !sType) {
                  didInitialRestoreRef.current = true;
                  onOpenScheduleCalendarRef.current?.({ keepSidebarOpen: true });
                }
              } else {
                const savedProjectId = localStorage.getItem('lastProjectsProjectId') ?? localStorage.getItem('lastProjectId');
                const savedConversationId = localStorage.getItem('lastProjectsConversationId') ?? localStorage.getItem('lastConversationId');
                if (savedProjectId === p.id && savedConversationId) {
                  const found = mapped.find((c) => c.id === savedConversationId);
                  if (found) {
                    didInitialRestoreRef.current = true;
                    onSelectConversationRef.current(p, found, undefined, { keepSidebarOpen: true });
                  }
                }
              }
            } catch { /* ignore */ }
          }
          return next;
        });
      });
    });
  }, [requestScheduleSelectionReveal]);

  useEffect(() => { refreshProjects(); }, [refreshProjects, refetchTrigger]);

  // Locally clear lastStatus for a conversation when it becomes selected.
  // Subscribe is silent (no conversation_updated broadcast), so the cached
  // lastStatus='done' would otherwise linger and re-tint the dot green if the
  // user switches away before any refetch. The server side already records
  // last_viewed_at; this just keeps the client cache consistent until the
  // next refreshProjects() naturally returns undefined.
  useEffect(() => {
    if (!selectedConversationId) return;
    setConversations((prev) => {
      let changed = false;
      const next: Record<string, Conversation[]> = {};
      for (const pid of Object.keys(prev)) {
        const updated = prev[pid].map((c) => {
          if (c.id === selectedConversationId && c.lastStatus !== undefined) {
            changed = true;
            return { ...c, lastStatus: undefined };
          }
          return c;
        });
        next[pid] = updated;
      }
      return changed ? next : prev;
    });
  }, [selectedConversationId]);

  // Sync active states in real-time
  useEffect(() => {
    setConversations((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const projectId of Object.keys(next)) {
        const updated = next[projectId].map((c) => {
          const isActiveNow = activeConversationIds.includes(c.id);
          if (c.isActive !== isActiveNow) {
            changed = true;
            return { ...c, isActive: isActiveNow };
          }
          return c;
        });
        if (changed) {
          next[projectId] = updated;
        }
      }
      return changed ? next : prev;
    });
  }, [activeConversationIds]);

  const loadConversations = useCallback(async (projectId: string, opts?: { includeArchived?: boolean }) => {
    const list = await api.listConversations(projectId, opts);
    setConversations((prev) => ({
      ...prev,
      [projectId]: visibleOnProjectsTab(list)
        .map((c) => ({
          ...c,
          isActive: c.isActive || activeConversationIds.includes(c.id),
        })),
    }));
  }, [activeConversationIds]);

  const loadScheduleTree = useCallback(async (projectId: string, runLimit = LIST_INITIAL_PAGE) => {
    try {
      const tree = await api.scheduleTree(projectId, runLimit, { includeArchived: showArchivedRef.current });
      setScheduleTrees((prev) => ({ ...prev, [projectId]: tree }));
      setScheduleTreeRunLimits((prev) => ({ ...prev, [projectId]: runLimit }));
    } catch {
      setScheduleTrees((prev) => ({ ...prev, [projectId]: { jobs: [] } }));
    }
  }, []);

  const toggleProject = useCallback((projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] };
      try { localStorage.setItem('collapsedProjects', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const togglePinnedGroup = useCallback((projectId: string) => {
    setCollapsedPinnedGroups((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] };
      try { localStorage.setItem('collapsedPinnedGroups', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleParentFold = useCallback((convId: string) => {
    setFoldedParents((prev) => {
      const next = { ...prev, [convId]: !(prev[convId] ?? true) };
      try { localStorage.setItem('foldedParents', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // First spawn under a childless parent: unfold it so the new child is visible.
  // Only parents with no stored fold state, so an explicit operator fold sticks.
  const knownParentsRef = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    const fresh = newlySpawnedParents(knownParentsRef.current, conversations);
    if (fresh.length === 0) return;
    setFoldedParents((prev) => {
      const todo = fresh.filter((id) => prev[id] === undefined);
      if (todo.length === 0) return prev;
      const next = { ...prev };
      for (const id of todo) next[id] = false;
      try { localStorage.setItem('foldedParents', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [conversations]);

  // Project ⋯ menu: fold/unfold every conversation that has children in one go.
  const setProjectParentsFolded = useCallback((convIds: string[], folded: boolean) => {
    setFoldedParents((prev) => {
      const next = { ...prev };
      for (const id of convIds) next[id] = folded;
      try { localStorage.setItem('foldedParents', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleScheduleJobFold = useCallback((jobId: string) => {
    setFoldedScheduleJobs((prev) => {
      const next = { ...prev, [jobId]: !(prev[jobId] ?? false) };
      try { localStorage.setItem('foldedScheduleJobs', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleConvListExpand = useCallback((projectId: string, delta: number) => {
    setConvListPageSizes((prev) => {
      const cur = prev[projectId] ?? 1;
      const next = Math.max(1, cur + delta);
      return next === cur ? prev : { ...prev, [projectId]: next };
    });
  }, []);

  const toggleScheduleJobListExpand = useCallback((projectId: string, delta: number) => {
    setScheduleJobListPageSizes((prev) => {
      const cur = prev[projectId] ?? 1;
      const next = Math.max(1, cur + delta);
      return next === cur ? prev : { ...prev, [projectId]: next };
    });
  }, []);

  const toggleScheduleRunListExpand = useCallback((jobId: string, delta: number) => {
    setScheduleRunListPageSizes((prev) => {
      const cur = prev[jobId] ?? 1;
      const next = Math.max(1, cur + delta);
      return next === cur ? prev : { ...prev, [jobId]: next };
    });
  }, []);

  const convListRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const prevSelectedConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    suppressScheduleTabFollowRef.current = false;
    scheduleRevealDoneForRef.current = null;
  }, [selectedConversationId]);

  const selectedIsScheduleTreeConv = useMemo(() => {
    if (!selectedConversationId) return false;
    return Object.values(scheduleTrees).some((tree) =>
      scheduleConversationIds(tree).has(selectedConversationId),
    );
  }, [selectedConversationId, scheduleTrees]);

  // Auto-expand project, job, and parent conversation fold state ONLY on explicit reveal
  useEffect(() => {
    if (!shouldAttemptSidebarReveal(lastExpandedSelectionTickRef.current, revealSelectionTick)) return;
    if (!selectedConversationId && !selectedJobId && !selectedProjectId) return;

    let expandedAny = false;

    // 1. Projects tab conversations
    if (selectedConversationId) {
      for (const [pid, list] of Object.entries(conversations)) {
        const target = list.find((c) => c.id === selectedConversationId);
        if (target) {
          if (collapsedProjects[pid]) {
            setCollapsedProjects((prev) => {
              const next = { ...prev, [pid]: false };
              try { localStorage.setItem('collapsedProjects', JSON.stringify(next)); } catch { /* ignore */ }
              return next;
            });
          }
          const projectObj = projects.find((x) => x.id === pid);
          const hostKey = projectObj?.remoteHostId ?? 'hub';
          setHostCollapsed((prev) => {
            if (!prev[hostKey]) return prev;
            const next = { ...prev, [hostKey]: false };
            lsSet('tierwyn:sidebar-host-collapsed', JSON.stringify(next));
            return next;
          });
          const targetBucket = bucketOf(target);
          setStatusCollapsed((prev) => {
            if (!prev[targetBucket]) return prev;
            const next = { ...prev, [targetBucket]: false };
            lsSet('tierwyn:sidebar-status-collapsed', JSON.stringify(next));
            return next;
          });
          // Unfold all ancestors
          let cur = target;
          const ancestorsToUnfold: string[] = [];
          const seen = new Set<string>();
          while (cur.parentConversationId) {
            if (seen.has(cur.id)) break;
            seen.add(cur.id);
            const parent = list.find((x) => x.id === cur.parentConversationId);
            if (!parent) break;
            if (foldedParents[parent.id] ?? true) {
              ancestorsToUnfold.push(parent.id);
            }
            cur = parent;
          }
          if (ancestorsToUnfold.length > 0) {
            setFoldedParents((prev) => {
              const next = { ...prev };
              for (const aid of ancestorsToUnfold) next[aid] = false;
              try { localStorage.setItem('foldedParents', JSON.stringify(next)); } catch { /* ignore */ }
              return next;
            });
          }
          expandedAny = true;
          break;
        }
      }

      // 2. Schedules tab trees
      for (const [pid, tree] of Object.entries(scheduleTrees)) {
        for (const jobEntry of tree.jobs) {
          for (const runEntry of jobEntry.runs) {
            const isRun = runEntry.conversation?.id === selectedConversationId;
            const desc = runEntry.descendants.find((d) => d.id === selectedConversationId);
            if (isRun || desc) {
              if (collapsedProjects[pid]) {
                setCollapsedProjects((prev) => {
                  const next = { ...prev, [pid]: false };
                  try { localStorage.setItem('collapsedProjects', JSON.stringify(next)); } catch { /* ignore */ }
                  return next;
                });
              }
              if (foldedScheduleJobs[jobEntry.job.id]) {
                setFoldedScheduleJobs((prev) => {
                  const next = { ...prev, [jobEntry.job.id]: false };
                  try { localStorage.setItem('foldedScheduleJobs', JSON.stringify(next)); } catch { /* ignore */ }
                  return next;
                });
              }
              if (desc && runEntry.conversation) {
                const ancestorsToUnfold: string[] = [];
                if (foldedParents[runEntry.conversation.id] ?? true) {
                  ancestorsToUnfold.push(runEntry.conversation.id);
                }
                let cur = desc;
                const seen = new Set<string>();
                while (cur.parentConversationId) {
                  if (seen.has(cur.id)) break;
                  seen.add(cur.id);
                  const parent = runEntry.descendants.find((x) => x.id === cur.parentConversationId);
                  if (!parent) break;
                  if (foldedParents[parent.id] ?? true) {
                    ancestorsToUnfold.push(parent.id);
                  }
                  cur = parent;
                }
                if (ancestorsToUnfold.length > 0) {
                  setFoldedParents((prev) => {
                    const next = { ...prev };
                    for (const aid of ancestorsToUnfold) next[aid] = false;
                    try { localStorage.setItem('foldedParents', JSON.stringify(next)); } catch { /* ignore */ }
                    return next;
                  });
                }
              }
              expandedAny = true;
              break;
            }
          }
        }
      }
    } else if (selectedJobId && selectedProjectId) {
      if (collapsedProjects[selectedProjectId]) {
        setCollapsedProjects((prev) => {
          const next = { ...prev, [selectedProjectId]: false };
          try { localStorage.setItem('collapsedProjects', JSON.stringify(next)); } catch { /* ignore */ }
          return next;
        });
      }
      if (foldedScheduleJobs[selectedJobId]) {
        setFoldedScheduleJobs((prev) => {
          const next = { ...prev, [selectedJobId]: false };
          try { localStorage.setItem('foldedScheduleJobs', JSON.stringify(next)); } catch { /* ignore */ }
          return next;
        });
      }
      expandedAny = true;
    }

    if (expandedAny) {
      lastExpandedSelectionTickRef.current = revealSelectionTick;
    }
  }, [
    revealSelectionTick,
    selectedConversationId,
    selectedJobId,
    selectedProjectId,
    conversations,
    scheduleTrees,
    collapsedProjects,
    foldedParents,
    foldedScheduleJobs,
  ]);

  // Scroll the selected row into view only after an explicit reveal (Active
  // Agents Open). Folder expand changes collapsedProjects and must not jump.
  useEffect(() => {
    if (!shouldAttemptSidebarReveal(lastRevealedSelectionTickRef.current, revealSelectionTick)) return;
    if (!selectedConversationId && !selectedJobId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const maxAttempts = 10;

    const scroll = () => {
      const container = sidebarMainTab === 'projects' ? projectsListRef.current : schedulesListRef.current;
      if (!container) return false;
      const targetId = selectedConversationId;
      const row = targetId
        ? container.querySelector<HTMLElement>(`.conversation-row[data-conv-id="${targetId}"]`)
        : (selectedJobId ? container.querySelector<HTMLElement>(`.schedule-job-row[data-job-id="${selectedJobId}"]`) : null);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        lastRevealedSelectionTickRef.current = revealSelectionTick;
        return true;
      }
      return false;
    };

    const tryScroll = () => {
      if (scroll()) return;
      attempts++;
      if (attempts < maxAttempts) {
        timer = setTimeout(tryScroll, 50);
      }
    };

    tryScroll();

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [
    revealSelectionTick,
    selectedConversationId,
    selectedJobId,
    sidebarMainTab,
    collapsedProjects,
    foldedParents,
    foldedScheduleJobs,
    convListPageSizes,
    scheduleJobListPageSizes,
    scheduleRunListPageSizes,
    conversations,
    scheduleTrees,
  ]);

  // Modals state
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const projectNameAutoFilled = useRef(true);
  const [newProjectHostId, setNewProjectHostId] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectCloneUrl, setNewProjectCloneUrl] = useState('');
  const [newProjectTrustRepo, setNewProjectTrustRepo] = useState(false);
  const [newProjectSandbox, setNewProjectSandbox] = useState<SandboxSetting | null>(null);
  const [newProjectSandboxPaths, setNewProjectSandboxPaths] = useState<SandboxPath[]>([]);
  const [newProjectSandboxSettings, setNewProjectSandboxSettings] = useState<SandboxSettings | null>(null);
  const [pathHint, setPathHint] = useState<PathHint | undefined>(undefined);
  const [pathHintPending, setPathHintPending] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [browseRoots, setBrowseRoots] = useState<ProjectBrowseRoots | null>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);

  const [createConvProject, setCreateConvProject] = useState<Project | null>(null);
  const [newConvTitle, setNewConvTitle] = useState('');
  const [newConvTemplate, setNewConvTemplate] = useState('');
  /** '' = per-role (no pin); otherwise 'shared' | 'worktree'. */
  const [newConvSpawnWorkdir, setNewConvSpawnWorkdir] = useState<'' | Workdir>('');
  const [newConvDesignation, setNewConvDesignation] = useState('');
  const [newConvCapabilityProfile, setNewConvCapabilityProfile] = useState('');
  const [newConvTags, setNewConvTags] = useState<string[]>([]);
  const [newConvTagDraft, setNewConvTagDraft] = useState('');
  const [newConvTagSuggestOpen, setNewConvTagSuggestOpen] = useState(false);
  const [newConvTagSuggestIdx, setNewConvTagSuggestIdx] = useState(-1);
  // Creation target — defaults to the project whose Create button was used,
  // selectable to any other project from the modal.
  const [createConvTargetProject, setCreateConvTargetProject] = useState<Project | null>(null);
  const [createConvBusy, setCreateConvBusy] = useState(false);
  const [designationCatalogue, setDesignationCatalogue] = useState<string[]>([]);
  const [capabilityProfileOptions, setCapabilityProfileOptions] = useState<CapabilityProfile[]>([]);
  const [defaultCapabilityProfileId, setDefaultCapabilityProfileId] = useState<string>('all');
  const [templates, setTemplates] = useState<SpawnTemplate[]>([]);
  const [templatePreviewContext, setTemplatePreviewContext] = useState<'new' | null>(null);

  const [renameConvData, setRenameConvData] = useState<{ project: Project; conv: Conversation } | null>(null);
  const [duplicateConvData, setDuplicateConvData] = useState<{ project: Project; conv: Conversation } | null>(null);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [alertDialog, setAlertDialog] = useState<{ title?: string; message: ReactNode } | null>(null);
  const showAlert = useCallback((message: ReactNode, title = 'Notice') => {
    setAlertDialog({ message, title });
  }, []);

  const [deleteConvData, setDeleteConvData] = useState<{ project: Project; conv: Conversation } | null>(null);
  const [archiveScheduleData, setArchiveScheduleData] = useState<{
    project: Project; jobId: string; jobName: string;
  } | null>(null);
  const [deleteScheduleData, setDeleteScheduleData] = useState<{
    project: Project; jobId: string; jobName: string;
  } | null>(null);
  const [deleteScheduleRunData, setDeleteScheduleRunData] = useState<{
    project: Project; conv: Conversation;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [overflow, setOverflow] = useState<OverflowPos | null>(null);
  const toggleOverflow = useCallback((id: string, btn: HTMLElement) => {
    setOverflow((prev) => (prev?.id === id ? null : posFromOverflowBtn(id, btn)));
  }, []);
  const closeOverflow = useCallback(() => setOverflow(null), []);
  useEffect(() => {
    if (!overflow) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverflow(null); };
    // Dismiss only when the scroll occurs on the list container directly by user scroll.
    // Micro-scrolls or programmatic adjustments (e.g. scrollIntoView on agent status ticks)
    // or scrolling inside the open dropdown menu must not close the menu.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === projectsListRef.current || t === schedulesListRef.current) {
        setOverflow(null);
      }
    };
    const onResize = () => setOverflow(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [overflow]);

  // Create schedule job dialog (project picker required — Schedules tab entry point)
  const [createScheduleOpen, setCreateScheduleOpen] = useState(false);
  const [newScheduleProjectId, setNewScheduleProjectId] = useState('');
  const [newScheduleName, setNewScheduleName] = useState('');
  const [newScheduleKind, setNewScheduleKind] = useState<ScheduleKind>('interval');
  const [newScheduleEveryAmount, setNewScheduleEveryAmount] = useState('24');
  const [newScheduleEveryUnit, setNewScheduleEveryUnit] = useState<DurationUnit>('hours');
  const [newScheduleFireInAmount, setNewScheduleFireInAmount] = useState('60');
  const [newScheduleFireInUnit, setNewScheduleFireInUnit] = useState<DurationUnit>('minutes');
  const [newScheduleCron, setNewScheduleCron] = useState('0 9 * * *');
  const [cronBuilderOpen, setCronBuilderOpen] = useState(false);
  const [newScheduleProfileId, setNewScheduleProfileId] = useState('');
  const [newScheduleTimezone, setNewScheduleTimezone] = useState(
    () => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
    },
  );
  const [newSchedulePrompt, setNewSchedulePrompt] = useState(BLANK_JOB_PROMPT);
  const [newScheduleSteer, setNewScheduleSteer] = useState('');
  const [newScheduleWorkdir, setNewScheduleWorkdir] = useState<Workdir>('shared');
  const [newScheduleTemplate, setNewScheduleTemplate] = useState('');
  const [newSchedulePackSlug, setNewSchedulePackSlug] = useState('');
  const [newScheduleGoal, setNewScheduleGoal] = useState('');
  const [newSchedulePackVars, setNewSchedulePackVars] = useState<Record<string, string>>({});
  const [schedulePacks, setSchedulePacks] = useState<SchedulePack[]>([]);
  const [importPackOpen, setImportPackOpen] = useState(false);
  const [importPackText, setImportPackText] = useState('');
  const [importPackPreview, setImportPackPreview] = useState<SchedulePack | null>(null);
  const [importPackError, setImportPackError] = useState('');
  const [importPackBusy, setImportPackBusy] = useState(false);
  const [importPackFileName, setImportPackFileName] = useState('');
  const importPackFileInputRef = useRef<HTMLInputElement>(null);
  const packIoTriggerRef = useRef<HTMLButtonElement>(null);
  const [packIoMenuOpen, setPackIoMenuOpen] = useState(false);
  const [packIoMenuPos, setPackIoMenuPos] = useState<CSSProperties | null>(null);
  const [confirmDeletePack, setConfirmDeletePack] = useState<SchedulePack | null>(null);
  const [deletePackBusy, setDeletePackBusy] = useState(false);
  const [createScheduleProfiles, setCreateScheduleProfiles] = useState<AgentProfile[]>([]);
  const [newScheduleSourceConv, setNewScheduleSourceConv] = useState<Conversation | null>(null);
  const [newScheduleExecutionMode, setNewScheduleExecutionMode] = useState<ExecutionMode>('spawn_child');
  const [newScheduleBoundConversationId, setNewScheduleBoundConversationId] = useState('');
  const [createScheduleBusy, setCreateScheduleBusy] = useState(false);
  const [packConflict, setPackConflict] = useState<{
    projectId: string;
    conflicts: string[];
    body: CreateScheduleJobRequest;
  } | null>(null);
  const [packOverwriteBusy, setPackOverwriteBusy] = useState(false);
  const newScheduleNameRef = useRef<HTMLInputElement>(null);

  // Pending project-delete confirmation + optimistic undo state.
  // deleteProjectData: a confirm modal is open for this project.
  // pendingProjectDelete: server DELETE has been scheduled on a timer; the
  //   project is already removed from the local sidebar list. Undo cancels
  //   the timer and restores the project. If another delete is initiated
  //   while one is pending, the prior one is flushed (fired immediately).
  const [deleteProjectData, setDeleteProjectData] = useState<Project | null>(null);
  const [shellAllowProject, setShellAllowProject] = useState<Project | null>(null);
  const [pendingProjectDelete, setPendingProjectDelete] = useState<{
    project: Project;
    conversations: Conversation[];
    scheduleTree?: ScheduleTreeResponse;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [toast, setToast] = useState<{ message: string; action?: { label: string; onClick: () => void } } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearToastTimer = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);
  /** Show a sidebar toast. Pass `ttlMs` for auto-dismiss (pin/move info);
   *  omit for undo windows that clear themselves. */
  const showToast = useCallback((
    next: { message: string; action?: { label: string; onClick: () => void } },
    ttlMs?: number,
  ) => {
    clearToastTimer();
    setToast(next);
    if (ttlMs != null) {
      toastTimerRef.current = setTimeout(() => {
        toastTimerRef.current = null;
        setToast((cur) => (cur?.message === next.message ? null : cur));
      }, ttlMs);
    }
  }, [clearToastTimer]);
  const dismissToast = useCallback(() => {
    clearToastTimer();
    setToast(null);
  }, [clearToastTimer]);

  // ── FW-18 bulk select ──────────────────────────────────────────────────
  // Component state by design (D20): switching tab or reloading drops it;
  // nothing is persisted and nothing is in the URL.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!pruneConversationIds?.length) return;
    const gone = new Set(pruneConversationIds);
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of gone) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [pruneConversationIds]);
  const [bulkDeleteCount, setBulkDeleteCount] = useState<number | null>(null); // confirm dialog open for convs
  const [bulkScheduleDeleteCount, setBulkScheduleDeleteCount] = useState<number | null>(null); // confirm dialog open for schedules
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const BULK_UNDO_WINDOW_MS = 5_000;

  // Pending optimistic bulk delete. A REF, not state, on purpose: the unmount
  // cleanup and the "flush the previous one" path both need the live value, and
  // the sibling pendingProjectDelete effect shows what a []-dep closure over
  // state costs. Nothing here drives rendering — the toast does that.
  const pendingBulkDeleteRef = useRef<{
    ids: string[];
    snapshot: Record<string, Conversation[]>;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const pendingBulkScheduleDeleteRef = useRef<{
    /** Schedule job ids (deleted via /schedules/bulk). */
    jobIds: string[];
    /** Run/spawn conversation ids (deleted via /conversations/bulk). */
    convIds: string[];
    snapshot: Record<string, ScheduleTreeResponse>;
    /** Pre-delete `conversations` for projects that held any selected conv. */
    convSnapshot: Record<string, Conversation[]>;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  // Populated during the project map below and read by the bulk bar,
  // which renders after it in the same pass. Reset every render.
  const visibleConvIdsRef = useRef<Set<string>>(new Set());
  visibleConvIdsRef.current = new Set<string>();

  const visibleScheduleJobIdsRef = useRef<Set<string>>(new Set());
  visibleScheduleJobIdsRef.current = new Set<string>();

  // Run/spawn conversation rows rendered inside schedule trees, same contract:
  // reset every render, read by the bulk bar's hidden-count.
  const visibleScheduleConvIdsRef = useRef<Set<string>>(new Set());
  visibleScheduleConvIdsRef.current = new Set<string>();

  /** Every conversation currently loaded, flattened across projects. Selection
   *  can span projects, so lookups cannot be per-project. */
  const allLoadedConvs = useMemo(
    () => Object.values(conversations).flat(),
    [conversations],
  );
  const selectedConvs = useMemo(
    () => allLoadedConvs.filter((c) => selectedIds.has(c.id)),
    [allLoadedConvs, selectedIds],
  );

  // Schedules-tab selections mix schedule job rows with run/spawn conversation
  // rows. The project conversation list deliberately hides whole schedule trees
  // (listConversations filters them into the Schedules tab), so membership in
  // the loaded job-id set is the only reliable classifier: every selectable job
  // id comes from a rendered tree, and everything else is a conversation
  // (deleted via /conversations/bulk, which cascades descendants).
  const scheduleJobIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const tree of Object.values(scheduleTrees)) {
      for (const entry of tree.jobs) ids.add(entry.job.id);
    }
    return ids;
  }, [scheduleTrees]);
  const selectedScheduleConvIds = useMemo(
    () => Array.from(selectedIds).filter((id) => !scheduleJobIdSet.has(id)),
    [selectedIds, scheduleJobIdSet],
  );
  const selectedScheduleJobIds = useMemo(
    () => Array.from(selectedIds).filter((id) => scheduleJobIdSet.has(id)),
    [selectedIds, scheduleJobIdSet],
  );

  const exitSelect = useCallback(() => {
    setSelecting(false);
    setSelectedIds(new Set());
  }, []);

  /** Toggle one row. Unchecking the last row auto-exits select mode (D15). */
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (next.size === 0) setSelecting(false);
      return next;
    });
  }, []);

  /** Entry point (⋯ → Select…) lands here. In select mode row taps toggle
   *  selection directly — no checkbox affordance. */
  const enterSelectWith = useCallback((id: string) => {
    setSelecting(true);
    setSelectedIds((prev) => new Set(prev).add(id));
  }, []);

  /** Project-header tri-state: add all of that project's visible selectable
   *  rows, or remove them if they are already all selected. */
  const toggleSelectAllForProject = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allOn = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) { if (allOn) next.delete(id); else next.add(id); }
      if (next.size === 0) setSelecting(false);
      return next;
    });
    setSelecting(true);
  }, []);

  // Esc leaves select mode — unless a bulk modal is open, in which case that
  // Esc belongs to the modal.
  useEffect(() => {
    if (!selecting || bulkDeleteCount !== null || bulkScheduleDeleteCount !== null || bulkMoveOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitSelect(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, bulkDeleteCount, bulkScheduleDeleteCount, bulkMoveOpen, exitSelect]);

  const addProject = useCallback(() => {
    setNewProjectName('');
    projectNameAutoFilled.current = true;
    setNewProjectPath('');
    setNewProjectHostId('');
    setNewProjectCloneUrl('');
    setNewProjectTrustRepo(false);
    setNewProjectSandbox(null);
    setNewProjectSandboxPaths([]);
    api.getSandboxSettings().then(setNewProjectSandboxSettings).catch(() => { /* label falls back to global off */ });
    setPathHint(undefined);
    setPathHintPending(false);
    setCreatingProject(false);
    setBrowseRoots(null);
    setShowFolderPicker(false);
    setShowProjectModal(true);
  }, []);

  useEffect(() => {
    if (!showProjectModal) {
      setBrowseRoots(null);
      return;
    }
    let cancelled = false;
    api.projectBrowseRoots(newProjectHostId || undefined)
      .then((r) => { if (!cancelled) setBrowseRoots(r); })
      .catch(() => { if (!cancelled) setBrowseRoots(null); });
    return () => { cancelled = true; };
  }, [showProjectModal, newProjectHostId]);

  /** Clone-from-URL applies to local and remote hosts. */
  const cloneMode = newProjectCloneUrl.trim() !== '';

  // Live "exists on host?" hint — debounced stat-path probe against the
  // selected host (remote or local).
  useEffect(() => {
    const hostId = newProjectHostId;
    const rawPath = newProjectPath.trim();
    const p = rawPath === '/' ? '/' : rawPath.replace(/\/+$/, '');
    if (!p.startsWith('/')) {
      setPathHint(undefined);
      setPathHintPending(false);
      return;
    }
    setPathHintPending(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const probe = hostId
        ? api.statRemotePath(hostId, p, ctrl.signal)
        : api.statLocalPath(p, ctrl.signal);
      probe
        .then((r) => {
          if (!ctrl.signal.aborted) {
            setPathHint(remotePathHint(r, cloneMode, {
              allowCreate: browseRoots?.canCreate,
              requireRootsForExisting: !!hostId,
              nodeUpdateRequired: !!hostId && browseRoots?.nodeUpdateRequired,
            }));
          }
        })
        .catch(() => {
          if (!ctrl.signal.aborted) {
            setPathHint(remotePathHint('error', cloneMode, {
              allowCreate: browseRoots?.canCreate,
              requireRootsForExisting: !!hostId,
              nodeUpdateRequired: !!hostId && browseRoots?.nodeUpdateRequired,
            }));
          }
        })
        .finally(() => { if (!ctrl.signal.aborted) setPathHintPending(false); });
    }, 400);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [newProjectHostId, newProjectPath, cloneMode, browseRoots?.canCreate, browseRoots?.nodeUpdateRequired]);

  const submitProject = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newProjectName.trim();
    const rawPath = newProjectPath.trim();
    const rootPath = rawPath === '/' ? '/' : rawPath.replace(/\/+$/, '');
    if (!name || !rootPath || !rootPath.startsWith('/')) return;
    const cloneUrl = newProjectCloneUrl.trim() || undefined;
    if (cloneUrl && !isCloneUrlAllowed(cloneUrl)) return;
    setCreatingProject(true);
    try {
      const project = await api.createProject(name, rootPath, newProjectHostId || undefined, cloneUrl, !cloneUrl);
      // ponytail: create then PATCH, so POST /projects stays untouched; extend POST if atomicity matters
      if (newProjectTrustRepo || newProjectSandbox || newProjectSandboxPaths.length > 0) {
        await api.updateProject(project.id, {
          ...(newProjectTrustRepo ? { trustRepoConfig: true } : {}),
          ...(newProjectSandbox ? { sandbox: newProjectSandbox } : {}),
          ...(newProjectSandboxPaths.length > 0 ? { sandboxPaths: newProjectSandboxPaths } : {}),
        }).catch((err) => showAlert(`Project created, but settings failed to save: ${err instanceof Error ? err.message : String(err)}`, 'Error'));
      }
      await refreshProjects();
      setShowProjectModal(false);
    } catch (err) {
      showAlert(`Create project failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setCreatingProject(false);
    }
  };

  const addConversation = useCallback((project: Project) => {
    setCreateConvProject(project);
    setCreateConvTargetProject(project);
    setNewConvTitle('');
    setNewConvTemplate('');
    setNewConvSpawnWorkdir('');
    setNewConvDesignation('');
    setNewConvCapabilityProfile('');
    setNewConvTags([]);
    setNewConvTagDraft('');
    setNewConvTagSuggestOpen(false);
    setNewConvTagSuggestIdx(-1);
    api.getCapabilityProfilesSettings()
      .then((res) => {
        setCapabilityProfileOptions(res.profiles);
        if (res.defaultProfileId) setDefaultCapabilityProfileId(res.defaultProfileId);
      })
      .catch(() => {});
  }, []);

  // Tick is the only trigger. Including `projects` would re-open the create
  // form on every directory refetch after the first palette "New chat".
  useEffect(() => {
    if (!openNewConversationTick) return;
    const targetProject = (targetNewConversationProjectId
      ? projects.find((p) => p.id === targetNewConversationProjectId)
      : null) ?? (selectedProjectId ? projects.find((p) => p.id === selectedProjectId) : null) ?? projects[0];
    if (targetProject) {
      addConversation(targetProject);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on tick only
  }, [openNewConversationTick]);

  useEffect(() => {
    if (!shouldApplyRequestedMainTab(lastRequestedMainTabTickRef.current, requestedMainTab)) return;
    lastRequestedMainTabTickRef.current = requestedMainTab.tick;
    setMainTab(requestedMainTab.tab);
  }, [requestedMainTab, setMainTab]);

  // Follow schedule-tree selection onto the Schedules tab. Runs after external
  // tab requests so boot restore cannot snap back to Projects on a stale tick.
  useEffect(() => {
    const prevId = prevSelectedConversationIdRef.current;
    prevSelectedConversationIdRef.current = selectedConversationId;

    if (!selectedConversationId || !selectedIsScheduleTreeConv) return;

    const shouldFollow = shouldFollowSelectionToSchedules(
      prevId,
      selectedConversationId,
      true,
      sidebarMainTab,
    ) || shouldSyncScheduleTabForSelection(
      selectedConversationId,
      true,
      sidebarMainTab,
      suppressScheduleTabFollowRef.current,
    );
    if (!shouldFollow) return;

    setMainTab('schedules');
    requestScheduleSelectionReveal(selectedConversationId);
  }, [
    selectedConversationId,
    selectedIsScheduleTreeConv,
    sidebarMainTab,
    setMainTab,
    requestScheduleSelectionReveal,
  ]);

  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  // Designation + capability-profile options for the create-conversation form.
  useEffect(() => {
    let cancelled = false;
    api.listDesignations()
      .then((r) => { if (!cancelled) setDesignationCatalogue(r.catalogue); })
      .catch(() => {});
    api.getCapabilityProfilesSettings()
      .then((res) => {
        if (!cancelled) {
          setCapabilityProfileOptions(res.profiles);
          if (res.defaultProfileId) setDefaultCapabilityProfileId(res.defaultProfileId);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const openCreateSchedule = useCallback((project?: Project, opts?: { conversation?: Conversation }) => {
    const source = opts?.conversation ?? null;
    const targetProject = project ?? projects[0];
    const forceResume = Boolean(source) || isRemoteAgentsProject(targetProject?.id);
    setCreateScheduleOpen(true);
    setNewScheduleProjectId(targetProject?.id ?? '');
    setNewScheduleSourceConv(source);
    setNewScheduleExecutionMode(forceResume ? 'resume_conversation' : 'spawn_child');
    setNewScheduleBoundConversationId(source?.id ?? '');
    setNewScheduleName('');
    setNewScheduleKind('interval');
    setNewScheduleEveryAmount('24');
    setNewScheduleEveryUnit('hours');
    setNewScheduleFireInAmount('60');
    setNewScheduleFireInUnit('minutes');
    setNewScheduleCron('0 9 * * *');
    // Resume must not send the plan-step stub into an ordinary chat.
    setNewSchedulePrompt(source ? '' : BLANK_JOB_PROMPT);
    setNewScheduleSteer('');
    setNewScheduleWorkdir('shared');
    setNewScheduleTemplate('');
    setNewSchedulePackSlug('');
    setNewScheduleGoal('');
    setNewSchedulePackVars({});
    setImportPackOpen(false);
    setImportPackText('');
    setImportPackPreview(null);
    setImportPackError('');
    setImportPackBusy(false);
    setImportPackFileName('');
    setPackIoMenuOpen(false);
    setPackIoMenuPos(null);
    if (importPackFileInputRef.current) importPackFileInputRef.current.value = '';
    try {
      setNewScheduleTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    } catch {
      setNewScheduleTimezone('UTC');
    }
    // Resume / Remote Agents defaults to inherit; spawn waits for /profiles.
    setNewScheduleProfileId(forceResume ? SCHEDULE_INHERIT_PROFILE_ID : '');
    setCreateScheduleBusy(false);
    fetch('/profiles', { credentials: 'include' })
      .then((r) => r.ok ? r.json() as Promise<{ profiles: AgentProfile[] }> : { profiles: [] })
      .then((data) => {
        const enabled = (data.profiles ?? []).filter((p) => p.enabled !== false);
        setCreateScheduleProfiles(enabled);
      })
      .catch(() => setCreateScheduleProfiles([]));
    api.listSchedulePacks().then(setSchedulePacks).catch(() => setSchedulePacks([]));
  }, [projects]);

  const scheduleFromConversation = useCallback((project: Project, conversation: Conversation) => {
    openCreateSchedule(project, { conversation });
  }, [openCreateSchedule]);

  const scheduleProfileOffer = useMemo(() => scheduleProfilesFor({
    project: projects.find((p) => p.id === newScheduleProjectId),
    profiles: createScheduleProfiles,
    hosts: remoteHosts,
    grokBotInProjectChats,
    grokBotStatus,
  }), [projects, newScheduleProjectId, createScheduleProfiles, remoteHosts, grokBotInProjectChats, grokBotStatus]);

  const offeredScheduleProfiles = scheduleProfileOffer.profiles;
  const scheduleTargetProject = projects.find((p) => p.id === newScheduleProjectId);
  const scheduleProjectIsRemoteAgents = isRemoteAgentsProject(newScheduleProjectId);
  const selectedCreateProfileForOffer = offeredScheduleProfiles.find((p) => p.id === newScheduleProfileId)
    ?? createScheduleProfiles.find((p) => p.id === newScheduleProfileId);
  const forcedScheduleMode = forcedExecutionMode(scheduleTargetProject, selectedCreateProfileForOffer);
  const resumeScheduleMode = newScheduleExecutionMode === 'resume_conversation'
    || forcedScheduleMode === 'resume_conversation';
  const inheritScheduleProfile: AgentProfile = useMemo(() => ({
    id: SCHEDULE_INHERIT_PROFILE_ID,
    agentType: 'inherit',
    model: 'inherit',
    label: "Conversation's last agent",
    description: 'Use the bound conversation\'s last agent on each fire',
    vision: false,
    steer: false,
    enabled: true,
  }), []);
  const createModalProfiles = useMemo(
    () => (resumeScheduleMode ? [inheritScheduleProfile, ...offeredScheduleProfiles] : offeredScheduleProfiles),
    [resumeScheduleMode, inheritScheduleProfile, offeredScheduleProfiles],
  );

  // Lock mode when Remote Agents / grok-bot require resume (Task 10).
  useEffect(() => {
    if (!createScheduleOpen || !forcedScheduleMode) return;
    if (newScheduleExecutionMode === forcedScheduleMode) return;
    setNewScheduleExecutionMode(forcedScheduleMode);
    if (forcedScheduleMode === 'resume_conversation') {
      setNewSchedulePackSlug('');
      setNewScheduleGoal('');
      setNewSchedulePackVars({});
      setNewScheduleTemplate('');
      setNewScheduleWorkdir('shared');
      if (scheduleProjectIsRemoteAgents) {
        setNewScheduleProfileId(SCHEDULE_INHERIT_PROFILE_ID);
      }
      setNewSchedulePrompt((prev) => (prev === BLANK_JOB_PROMPT ? '' : prev));
    }
  }, [
    createScheduleOpen,
    forcedScheduleMode,
    newScheduleExecutionMode,
    scheduleProjectIsRemoteAgents,
  ]);

  useEffect(() => {
    if (!createScheduleOpen) return;
    if (scheduleProjectIsRemoteAgents) {
      if (newScheduleProfileId !== SCHEDULE_INHERIT_PROFILE_ID) {
        setNewScheduleProfileId(SCHEDULE_INHERIT_PROFILE_ID);
      }
      return;
    }
    const ids = new Set(createModalProfiles.map((p) => p.id));
    if (resumeScheduleMode && newScheduleProfileId === SCHEDULE_INHERIT_PROFILE_ID) return;
    if (!newScheduleProfileId || !ids.has(newScheduleProfileId)) {
      setNewScheduleProfileId(
        resumeScheduleMode
          ? SCHEDULE_INHERIT_PROFILE_ID
          : (offeredScheduleProfiles[0]?.id ?? ''),
      );
    }
  }, [
    createScheduleOpen,
    createModalProfiles,
    offeredScheduleProfiles,
    newScheduleProfileId,
    resumeScheduleMode,
    scheduleProjectIsRemoteAgents,
  ]);

  // Inherit is never a bare-prompt catalogue row — treat it like a normal profile for field visibility.
  const bareScheduleProfile = !resumeScheduleMode && isBarePromptProfile(selectedCreateProfileForOffer);

  useEffect(() => {
    if (!createScheduleOpen || !bareScheduleProfile) return;
    setNewSchedulePackSlug('');
    setNewScheduleTemplate('');
    setNewScheduleWorkdir('shared');
    setNewSchedulePrompt((prev) => (prev === BLANK_JOB_PROMPT ? '' : prev));
  }, [createScheduleOpen, bareScheduleProfile]);

  // Resume mode: drop the plan-step stub the same way bare-prompt does.
  useEffect(() => {
    if (!createScheduleOpen || !resumeScheduleMode) return;
    setNewSchedulePrompt((prev) => (prev === BLANK_JOB_PROMPT ? '' : prev));
  }, [createScheduleOpen, resumeScheduleMode]);

  useLayoutEffect(() => {
    if (!packIoMenuOpen) {
      setPackIoMenuPos(null);
      return;
    }
    const btn = packIoTriggerRef.current;
    if (!btn) return;
    const place = () => {
      const r = btn.getBoundingClientRect();
      const menuW = 180;
      const left = Math.max(8, Math.min(r.right - menuW, window.innerWidth - menuW - 8));
      setPackIoMenuPos({ position: 'fixed', top: r.bottom + 4, left, right: 'auto', zIndex: 1100, minWidth: menuW });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [packIoMenuOpen]);

  const applySchedulePack = (slug: string, packsOverride?: SchedulePack[]) => {
    const packs = packsOverride ?? schedulePacks;
    setNewSchedulePackSlug(slug);
    setNewScheduleGoal('');
    if (!slug) {
      setNewScheduleKind('interval');
      setNewScheduleEveryAmount('24');
      setNewScheduleEveryUnit('hours');
      setNewScheduleFireInAmount('60');
      setNewScheduleFireInUnit('minutes');
      setNewScheduleCron('0 9 * * *');
      setNewSchedulePrompt(BLANK_JOB_PROMPT);
      setNewScheduleSteer('');
      setNewScheduleWorkdir('shared');
      setNewScheduleTemplate('');
      setNewSchedulePackVars({});
      return;
    }
    const pack = packs.find((p) => p.slug === slug);
    if (!pack) return;
    const cadence = cadenceToFormState(pack.job.cadence);
    setNewScheduleKind(cadence.kind);
    const everyParts = msToDurationParts(cadence.everyMs, { amount: 24, unit: 'hours' });
    setNewScheduleEveryAmount(String(everyParts.amount));
    setNewScheduleEveryUnit(everyParts.unit);
    const fireParts = msToDurationParts(cadence.fireInMs, { amount: 60, unit: 'minutes' });
    setNewScheduleFireInAmount(String(fireParts.amount));
    setNewScheduleFireInUnit(fireParts.unit);
    setNewScheduleCron(cadence.cronExpr);
    setNewSchedulePrompt(pack.job.promptTemplate);
    setNewScheduleSteer(pack.job.steer ?? '');
    setNewScheduleWorkdir(pack.job.workdir ?? 'shared');
    let profileId = newScheduleProfileId;
    if (pack.profileAgentHint) {
      const match = createScheduleProfiles.find(
        (p) => p.agentType === pack.profileAgentHint && p.enabled !== false,
      );
      if (match) {
        profileId = match.id;
        setNewScheduleProfileId(match.id);
      }
    }
    const vars: Record<string, string> = {};
    for (const field of pack.applyFields ?? []) {
      const fromPack = pack.job.variables?.[field.key];
      if (typeof fromPack === 'string' && fromPack !== '') {
        vars[field.key] = fromPack;
      } else if (field.type === 'select' && field.options && field.options.length > 0) {
        vars[field.key] = field.options[0].value;
      } else if (field.type === 'select') {
        vars[field.key] = templates[0]?.name ?? '';
      } else {
        vars[field.key] = profileId || createScheduleProfiles[0]?.id || '';
      }
    }
    setNewSchedulePackVars(vars);
    if (pack.requiresTemplate && !newScheduleTemplate.trim() && templates.length > 0) {
      setNewScheduleTemplate(templates[0].name);
    }
  };

  const reviewImportPackText = (text: string) => {
    setImportPackText(text);
    if (!text.trim()) {
      setImportPackPreview(null);
      setImportPackError('');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      setImportPackPreview(null);
      setImportPackError('Not valid JSON');
      return;
    }
    const result = validateSchedulePack(raw);
    if (!result.ok) {
      setImportPackPreview(null);
      setImportPackError(result.error);
      return;
    }
    setImportPackPreview(result.pack);
    setImportPackError('');
  };

  const confirmImportPack = async () => {
    if (!importPackPreview) return;
    setImportPackBusy(true);
    try {
      const imported = await api.importSchedulePack(importPackPreview);
      const packs = await api.listSchedulePacks();
      setSchedulePacks(packs);
      setImportPackOpen(false);
      setImportPackText('');
      setImportPackPreview(null);
      setImportPackError('');
      setImportPackFileName('');
      if (importPackFileInputRef.current) importPackFileInputRef.current.value = '';
      applySchedulePack(imported.slug, packs);
    } catch (err) {
      setImportPackError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportPackBusy(false);
    }
  };

  /** Download the selected pack as an import-ready JSON document. */
  const exportSelectedSchedulePack = () => {
    if (!selectedSchedulePack) return;
    const blob = new Blob([JSON.stringify(selectedSchedulePack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedSchedulePack.slug}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const submitDeletePack = async () => {
    const pack = confirmDeletePack;
    if (!pack) return;
    setDeletePackBusy(true);
    try {
      await api.deleteSchedulePack(pack.slug);
      const packs = await api.listSchedulePacks();
      setSchedulePacks(packs);
      setConfirmDeletePack(null);
      if (newSchedulePackSlug === pack.slug) applySchedulePack('');
    } catch (err) {
      setConfirmDeletePack(null);
      showAlert(err instanceof Error ? err.message : String(err), 'Delete pack failed');
    } finally {
      setDeletePackBusy(false);
    }
  };

  const finishCreateSchedule = async (
    project: Project,
    res: Awaited<ReturnType<typeof api.createSchedule>>,
    packSlug: string,
    kind: ScheduleKind,
  ) => {
    await loadScheduleTree(project.id);
    setMainTab('schedules');
    onSelectJob?.(project, res.job.id);
    setCreateScheduleOpen(false);
    const toastMsg = packApplyToastMessage({
      warnings: res.warnings,
      intervalPackDisabled: Boolean(packSlug && kind === 'interval'),
    });
    if (toastMsg) setToast({ message: toastMsg });
  };

  const submitCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const project = projects.find((p) => p.id === newScheduleProjectId);
    if (!project || !newScheduleName.trim() || !newScheduleProfileId.trim()) return;
    let everyMs = 0;
    let fireInMs = 0;
    if (newScheduleKind === 'interval') {
      const amount = Number(newScheduleEveryAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        showAlert('Interval must be a positive number', 'Invalid Schedule');
        return;
      }
      everyMs = durationPartsToMs(amount, newScheduleEveryUnit);
      if (everyMs < 1000) {
        showAlert('Interval must be at least 1 second', 'Invalid Schedule');
        return;
      }
    } else if (newScheduleKind === 'once') {
      const amount = Number(newScheduleFireInAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        showAlert('Fire-in must be a positive number', 'Invalid Schedule');
        return;
      }
      fireInMs = durationPartsToMs(amount, newScheduleFireInUnit);
      if (fireInMs < 60_000) {
        showAlert('Once jobs must fire at least 1 minute from now', 'Invalid Schedule');
        return;
      }
    } else {
      if (!newScheduleCron.trim()) {
        showAlert('Cron expression required', 'Invalid Schedule');
        return;
      }
    }
    const body = formStateToCreateBody({
      name: newScheduleName,
      timezone: newScheduleTimezone,
      kind: newScheduleKind,
      everyMs,
      cronExpr: newScheduleCron.trim(),
      fireInMs,
      profileId: newScheduleProfileId,
      promptTemplate: newSchedulePrompt,
      steer: newScheduleSteer,
      workdir: newScheduleWorkdir,
      templateName: newScheduleTemplate,
      packSlug: newSchedulePackSlug,
      goal: newScheduleGoal,
      packVars: newSchedulePackVars,
      barePrompt: bareScheduleProfile,
      executionMode: newScheduleExecutionMode,
      boundConversationId: newScheduleBoundConversationId,
    });
    setCreateScheduleBusy(true);
    try {
      const res = await api.createSchedule(project.id, body);
      await finishCreateSchedule(project, res, newSchedulePackSlug, newScheduleKind);
    } catch (err) {
      if (err instanceof PackFileConflictError) {
        setPackConflict({ projectId: project.id, conflicts: err.conflicts, body });
        return;
      }
      showAlert(`Create schedule failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setCreateScheduleBusy(false);
    }
  };

  const confirmPackOverwrite = async () => {
    if (!packConflict) return;
    const project = projects.find((p) => p.id === packConflict.projectId);
    if (!project) { setPackConflict(null); return; }
    setPackOverwriteBusy(true);
    try {
      const res = await api.createSchedule(project.id, { ...packConflict.body, overwritePackFiles: true });
      setPackConflict(null);
      await finishCreateSchedule(project, res, packConflict.body.packSlug ?? '', packConflict.body.scheduleKind);
    } catch (err) {
      setPackConflict(null);
      showAlert(`Create schedule failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setPackOverwriteBusy(false);
    }
  };

  const cancelPackConflict = () => {
    setPackConflict(null);
    requestAnimationFrame(() => {
      newScheduleNameRef.current?.focus();
      newScheduleNameRef.current?.select();
    });
  };

  const selectedSchedulePack = newSchedulePackSlug
    ? schedulePacks.find((p) => p.slug === newSchedulePackSlug) ?? null
    : null;
  const selectedCreateProfile = selectedCreateProfileForOffer;
  const createRequiresTemplate = Boolean(selectedSchedulePack?.requiresTemplate);
  const createSpawnOk = profileHasSpawnCapacity(selectedCreateProfile?.maxConcurrentSpawns);
  const createScheduleBlocked =
    createScheduleBusy
    || packOverwriteBusy
    || !newScheduleProjectId
    || !newScheduleName.trim()
    || !newScheduleProfileId.trim()
    || (resumeScheduleMode && !newScheduleBoundConversationId.trim())
    || ((bareScheduleProfile || resumeScheduleMode) && !newSchedulePrompt.trim())
    || (!resumeScheduleMode && createRequiresTemplate && (!newScheduleTemplate.trim() || !createSpawnOk));
  const createScheduleSubmitTitle = (
    createScheduleBlocked && resumeScheduleMode && !newScheduleBoundConversationId.trim()
      ? 'Pick a conversation to send to'
      : createScheduleBlocked && resumeScheduleMode && !newSchedulePrompt.trim()
        ? 'Write the message to send on each fire'
        : createScheduleBlocked && bareScheduleProfile && !newSchedulePrompt.trim()
          ? 'Prompt is required for bare-prompt agents'
          : createScheduleBlocked && createRequiresTemplate && newScheduleProfileId.trim() && !createSpawnOk
            ? spawnCapRemedy(newScheduleProfileId.trim())
            : createScheduleBlocked && createRequiresTemplate && !newScheduleTemplate.trim()
              ? 'This pack requires a delegation template'
              : undefined
  );

  const resumeBoundOptions = useMemo(() => {
    const list = visibleOnProjectsTab(
      conversations[newScheduleProjectId] ?? [],
      scheduleConversationIds(scheduleTrees[newScheduleProjectId]),
    ).filter((c) => !c.archived);
    // Keep a preselected source even if it would otherwise be filtered out.
    if (
      newScheduleBoundConversationId
      && !list.some((c) => c.id === newScheduleBoundConversationId)
    ) {
      const orphan = (conversations[newScheduleProjectId] ?? [])
        .find((c) => c.id === newScheduleBoundConversationId)
        ?? newScheduleSourceConv;
      if (orphan && orphan.id === newScheduleBoundConversationId) {
        return [orphan, ...list];
      }
    }
    return list;
  }, [
    conversations,
    newScheduleProjectId,
    scheduleTrees,
    newScheduleBoundConversationId,
    newScheduleSourceConv,
  ]);

  const createSelectedTemplate = templates.find((t) => t.name === newScheduleTemplate);
  const createRosterProfiles = createSelectedTemplate?.roles ?? [];
  const createRosterProfileIds = createRosterProfiles.map((r) => r.profileId);
  const creatingRemoteBot = isRemoteAgentsProject((createConvTargetProject ?? createConvProject)?.id);

  // Commits the uncommitted tag chip input. Same normaliseTags the server runs,
  // so a tag accepted here can never 400 on create.
  const commitNewConvTag = (raw: string = newConvTagDraft) => {
    const candidate = normaliseTags([...newConvTags, raw]);
    // Modal already closed (delayed blur commit) — server has the folded tags; stay silent.
    if (!candidate.ok) { if (createConvProject) showAlert(candidate.error, 'Error'); return; }
    setNewConvTags(candidate.tags);
    setNewConvTagDraft('');
    setNewConvTagSuggestOpen(false);
    setNewConvTagSuggestIdx(-1);
  };

  const submitConversation = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetProject = createConvTargetProject ?? createConvProject;
    if (!targetProject || !newConvTitle.trim() || createConvBusy) return;
    const creatingBot = isRemoteAgentsProject(targetProject.id);
    // Fold an uncommitted chip input into the create so typing a tag and hitting
    // Create (without Enter) does not silently discard it.
    const pending = creatingBot ? { ok: true as const, tags: [] as string[] } : normaliseTags([...newConvTags, newConvTagDraft]);
    if (!pending.ok) { showAlert(pending.error, 'Error'); return; }
    setCreateConvBusy(true);
    try {
      const conv = creatingBot
        ? await api.createGrokBot(newConvTitle.trim())
        : await api.createConversation(
          targetProject.id,
          newConvTitle.trim(),
          newConvTemplate || undefined,
          newConvSpawnWorkdir || undefined,
          undefined,
          newConvDesignation || undefined,
          pending.tags.length ? pending.tags : undefined,
          newConvCapabilityProfile || undefined,
        );
      await loadConversations(targetProject.id);
      onSelectConversation(targetProject, conv);
      setCreateConvProject(null);
    } catch (err) {
      showAlert(`${creatingBot ? 'Create Bot' : 'Create conversation'} failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setCreateConvBusy(false);
    }
  };

  const togglePinConv = useCallback(async (project: Project, conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !conv.pinned;
    // Optimistic local flip for immediate visual feedback.
    setConversations((prev) => {
      const out: Record<string, Conversation[]> = {};
      for (const pid of Object.keys(prev)) {
        out[pid] = pid === project.id
          ? prev[pid].map((c) => c.id === conv.id ? { ...c, pinned: next ? true : undefined } : c)
          : prev[pid];
      }
      return out;
    });
    try {
      await api.updateConversation(conv.id, { pinned: next });
    } catch (err) {
      // Revert on failure.
      setConversations((prev) => {
        const out: Record<string, Conversation[]> = {};
        for (const pid of Object.keys(prev)) {
          out[pid] = pid === project.id
            ? prev[pid].map((c) => c.id === conv.id ? { ...c, pinned: next ? undefined : true } : c)
            : prev[pid];
        }
        return out;
      });
      showAlert(`Pin failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    }
  }, [showAlert]);

  const renameConv = useCallback((project: Project, conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameConvData({ project, conv });
  }, []);

  /** Migration 114 — soft-archive. Optimistic flip like togglePinConv, but no
   *  revert-on-failure list surgery: the row simply stays until the refetch,
   *  because in either view (normal / archived) the row is valid post-failure. */
  const toggleArchiveConv = useCallback(async (project: Project, conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !conv.archived;
    setConversations((prev) => {
      const out: Record<string, Conversation[]> = {};
      for (const pid of Object.keys(prev)) {
        out[pid] = pid === project.id
          ? prev[pid].map((c) => c.id === conv.id ? { ...c, archived: next ? true : undefined } : c)
          : prev[pid];
      }
      return out;
    });
    try {
      await api.updateConversation(conv.id, { archived: next });
      showToast({ message: next ? `Archived ${conv.title}` : `Unarchived ${conv.title}` }, 4_000);
    } catch (err) {
      showAlert(`Archive failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      // Either way the row's view membership changed — reload the project.
      // Keep the archived view populated: without includeArchived the refetch
      // would blank the list we're looking at until the next view toggle.
      try { await loadConversations(project.id, { includeArchived: showArchivedRef.current }); } catch { /* refetch race */ }
    }
  }, [showAlert, showToast, loadConversations]);

  const deleteConv = useCallback((project: Project, conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteConvData({ project, conv });
  }, []);

  const markConvUnread = useCallback(async (project: Project, conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.markConversationUnread(conv.id);
      // Track locally so the SELECTED row's dot turns green immediately —
      // the selected branch reads selectedBadgeStatus from the header pill,
      // which is derived from live events and doesn't reflect the manual
      // reset. The non-selected branch already honours c.lastStatus='done'
      // via the isUnread check below.
      setManuallyMarkedUnread((prev) => prev.has(conv.id) ? prev : new Set(prev).add(conv.id));
      // Refetch to pick up the server-derived lastStatus='done' that the
      // reset of last_viewed_at re-surfaces. We optimistically also force
      // the local c.lastStatus to 'done' for immediate feedback in case
      // the row is rendered before the refetch resolves.
      setConversations((prev) => {
        const next: Record<string, Conversation[]> = {};
        for (const pid of Object.keys(prev)) {
          next[pid] = pid === project.id
            ? prev[pid].map((c) => c.id === conv.id ? { ...c, lastStatus: 'done' } : c)
            : prev[pid];
        }
        return next;
      });
      await loadConversations(project.id);
    } catch (err) {
      showAlert(`Mark unread failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    }
  }, [loadConversations, showAlert]);

  const markConvRead = useCallback(async (project: Project, conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.markConversationRead(conv.id);
      clearUnread(conv.id);
      setManuallyMarkedUnread((prev) => {
        if (!prev.has(conv.id)) return prev;
        const next = new Set(prev);
        next.delete(conv.id);
        return next;
      });
      setConversations((prev) => {
        const next: Record<string, Conversation[]> = {};
        for (const pid of Object.keys(prev)) {
          next[pid] = pid === project.id
            ? prev[pid].map((c) => c.id === conv.id ? { ...c, lastStatus: undefined } : c)
            : prev[pid];
        }
        return next;
      });
      await loadConversations(project.id);
    } catch (err) {
      showAlert(`Mark read failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    }
  }, [clearUnread, loadConversations, showAlert]);

  // FW-13: in-app clone. Sidebar owns its own api calls + refetch (same shape
  // as markConvUnread / submitDelete), so no new prop is needed.
  const duplicateConv = useCallback((project: Project, conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setDuplicateConvData({ project, conv });
  }, []);

  const submitDuplicateConv = async () => {
    if (!duplicateConvData) return;
    setDuplicateBusy(true);
    try {
      const copy = await api.duplicateConversation(duplicateConvData.conv.id);
      await loadConversations(duplicateConvData.project.id);
      onSelectConversation(duplicateConvData.project, copy);
      setDuplicateConvData(null);
    } catch (err) {
      showAlert(`Duplicate failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setDuplicateBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteConvData) return;
    setDeleteBusy(true);
    try {
      const res = await api.deleteConversation(deleteConvData.conv.id);
      await loadConversations(deleteConvData.project.id);
      await loadScheduleTree(deleteConvData.project.id);
      onConversationDeleted?.(res.deletedIds ?? [deleteConvData.conv.id]);
      setDeleteConvData(null);
    } catch (err) {
      showAlert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setDeleteBusy(false);
    }
  };

  const toggleArchiveScheduleJob = useCallback(async (project: Project, job: ScheduleJob, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !job.archived;
    setScheduleTrees((prev) => {
      const out: Record<string, ScheduleTreeResponse> = {};
      for (const [pid, tree] of Object.entries(prev)) {
        out[pid] = pid === project.id
          ? {
              ...tree,
              jobs: tree.jobs.map((entry) =>
                entry.job.id === job.id
                  ? { ...entry, job: { ...entry.job, archived: next } }
                  : entry,
              ),
            }
          : tree;
      }
      return out;
    });
    try {
      if (next) {
        await api.archiveSchedule(project.id, job.id);
        onScheduleJobArchived?.(job.id);
      } else {
        await api.unarchiveSchedule(project.id, job.id);
      }
      showToast({ message: next ? `Archived ${job.name}` : `Unarchived ${job.name}` }, 4_000);
    } catch (err) {
      showAlert(`Archive failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      try { await loadScheduleTree(project.id); } catch { /* ignore */ }
    }
  }, [showAlert, showToast, loadScheduleTree, onScheduleJobArchived]);

  const openArchiveScheduleJob = (project: Project, jobId: string, jobName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setArchiveScheduleData({ project, jobId, jobName });
  };

  const submitArchiveScheduleJob = async () => {
    if (!archiveScheduleData) return;
    setDeleteBusy(true);
    try {
      await api.archiveSchedule(archiveScheduleData.project.id, archiveScheduleData.jobId);
      await loadScheduleTree(archiveScheduleData.project.id);
      onScheduleJobArchived?.(archiveScheduleData.jobId);
      setArchiveScheduleData(null);
    } catch (err) {
      showAlert(`Archive schedule failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setDeleteBusy(false);
    }
  };

  const openDeleteScheduleJob = (project: Project, jobId: string, jobName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteScheduleData({ project, jobId, jobName });
  };

  const submitDeleteScheduleJob = async () => {
    if (!deleteScheduleData) return;
    setDeleteBusy(true);
    try {
      const res = await api.deleteSchedule(deleteScheduleData.project.id, deleteScheduleData.jobId);
      await loadScheduleTree(deleteScheduleData.project.id);
      onScheduleJobDeleted?.(deleteScheduleData.jobId, res.deletedConversationIds ?? []);
      setDeleteScheduleData(null);
    } catch (err) {
      showAlert(`Delete schedule failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setDeleteBusy(false);
    }
  };

  const openDeleteScheduleRunConv = (project: Project, conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteScheduleRunData({ project, conv });
  };

  const submitDeleteScheduleRunConv = async () => {
    if (!deleteScheduleRunData) return;
    setDeleteBusy(true);
    try {
      const res = await api.deleteConversation(deleteScheduleRunData.conv.id);
      await loadScheduleTree(deleteScheduleRunData.project.id);
      onConversationDeleted?.(res.deletedIds ?? [deleteScheduleRunData.conv.id]);
      setDeleteScheduleRunData(null);
    } catch (err) {
      showAlert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setDeleteBusy(false);
    }
  };

  // Fire a pending project DELETE immediately (used when flushing a prior
  // pending delete, or when the undo window expires). Removes the project's
  // conversations from local state and notifies App.tsx.
  const flushProjectDelete = useCallback(async (project: Project) => {
    try {
      await api.deleteProject(project.id);
      onProjectDeleted?.(project.id);
    } catch (err) {
      // Server-side failure mid-flush: surface so the user knows the rows
      // may still exist. The local sidebar state will resync on next refresh.
      showAlert(`Delete project failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
      await refreshProjects();
    }
  }, [onProjectDeleted, refreshProjects, showAlert]);

  const UNDO_WINDOW_MS = 10_000;

  const submitDeleteProject = () => {
    const p = deleteProjectData;
    if (!p) return;
    setDeleteProjectData(null);
    void flushBulkDelete();
    void flushBulkScheduleDelete();
    // If a previous delete is still pending, flush it before starting a new one.
    setPendingProjectDelete((prev) => {
      if (prev) {
        clearTimeout(prev.timer);
        void flushProjectDelete(prev.project);
      }
      return null;
    });

    // Capture the project's conversations + schedule tree for undo restore,
    // then optimistically drop both from local sidebar state.
    const capturedConvs = conversations[p.id] ?? [];
    const capturedTree = scheduleTrees[p.id];
    setProjects((prev) => prev.filter((x) => x.id !== p.id));
    setConversations((prev) => {
      const next = { ...prev };
      delete next[p.id];
      return next;
    });
    setScheduleTrees((prev) => {
      const next = { ...prev };
      delete next[p.id];
      return next;
    });

    const timer = setTimeout(() => {
      setPendingProjectDelete((cur) => {
        if (cur?.project.id === p.id) {
          void flushProjectDelete(p);
        }
        return null;
      });
      setToast(null);
    }, UNDO_WINDOW_MS);

    setPendingProjectDelete({ project: p, conversations: capturedConvs, scheduleTree: capturedTree, timer });
    setToast({
      message: `Project '${p.name}' deleted.`,
      action: {
        label: 'Undo',
        onClick: () => {
          setPendingProjectDelete((cur) => {
            if (cur?.project.id === p.id) {
              clearTimeout(cur.timer);
              // Restore project row, conversations, and schedules tree.
              setProjects((prevList) => {
                if (prevList.some((x) => x.id === p.id)) return prevList;
                const withP = [...prevList, p];
                withP.sort((a, b) => b.createdAt - a.createdAt);
                return withP;
              });
              setConversations((prev) => ({ ...prev, [p.id]: cur.conversations }));
              if (cur.scheduleTree) {
                setScheduleTrees((prev) => ({ ...prev, [p.id]: cur.scheduleTree! }));
              }
            }
            return null;
          });
          setToast(null);
        },
      },
    });
  };

  /** Immediate (no undo) bulk action — matches today's single-row pin/move
   *  behaviour (D18). Refetches the affected projects because a move re-homes a
   *  whole subtree and pin changes sort order. Exit select as soon as the bulk
   *  API succeeds — do not wait on the reload — then show a short auto-dismiss
   *  toast (theme-aware). List refetch failures must not leave select mode on. */
  const runBulk = useCallback(async (
    action: 'move' | 'pin' | 'unpin' | 'archive' | 'unarchive',
    opts: { projectId?: string; toastVerb: string; destName?: string },
  ) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const affectedProjectIds = new Set(
      allLoadedConvs.filter((c) => selectedIds.has(c.id)).map((c) => c.projectId),
    );
    if (opts.projectId) affectedProjectIds.add(opts.projectId);

    setBulkBusy(true);
    try {
      const res = await api.bulkConversations({ action, ids, ...(opts.projectId ? { projectId: opts.projectId } : {}) });
      const { okCount, skipCount, failCount } = summariseBulkResults(res.results);

      // Exit select first so the bulk bar is gone before the toast mounts.
      exitSelect();
      let message = action === 'move'
        ? `Moved ${okCount} to ${opts.destName ?? 'project'}`
        : `${opts.toastVerb} ${okCount}`;
      if (skipCount > 0 && action !== 'move') {
        message += ` (skipped ${skipCount} ${skipCount === 1 ? 'child' : 'children'})`;
      }
      if (failCount > 0) message += `; ${failCount} failed`;
      showToast({ message }, 4_000);

      // If the open conversation was among the successful moves, rebind App's
      // selection.project so the next send uses the destination cwd (same fix
      // as EditConversationModal → onConversationRenamed for single-row move).
      if (action === 'move' && opts.projectId && selectedConversationId) {
        const movedOk = res.results.some(
          (r) => r.ok && !r.skipped && r.id === selectedConversationId,
        );
        if (movedOk) {
          const prior = allLoadedConvs.find((c) => c.id === selectedConversationId);
          if (prior) {
            onConversationRenamed?.({
              ...prior,
              projectId: opts.projectId,
              workdirPath: undefined,
            });
          }
        }
      }

      try {
        // includeArchived keeps the archived view populated after bulk
        // archive/unarchive; the normal view filter hides archived rows anyway.
        await Promise.all([...affectedProjectIds].map((pid) => loadConversations(pid, { includeArchived: showArchivedRef.current })));
      } catch {
        // Action already committed; list may look stale until the next expand.
      }
    } catch (err) {
      showAlert(`Bulk ${action} failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setBulkBusy(false);
      setBulkMoveOpen(false);
    }
  }, [selectedIds, allLoadedConvs, loadConversations, exitSelect, showToast, selectedConversationId, onConversationRenamed, showAlert]);

  /** Fire the pending bulk delete for real. Called by the timer, by a second
   *  destructive action, and on unmount. Idempotent via the ref. */
  const flushBulkDelete = useCallback(async () => {
    const pending = pendingBulkDeleteRef.current;
    if (!pending) return;
    pendingBulkDeleteRef.current = null;
    clearTimeout(pending.timer);
    try {
      const res = await api.bulkConversations({ action: 'delete', ids: pending.ids });
      const { failCount } = summariseBulkResults(res.results);
      const gone = res.deletedIds ?? pending.ids;
      onConversationDeleted?.(gone);
      if (failCount > 0) {
        setToast({ message: `${gone.length} conversations deleted; ${failCount} failed` });
      }
      await Promise.all(Object.keys(pending.snapshot).map(async (pid) => {
        await loadConversations(pid);
        await loadScheduleTree(pid);
      }));
    } catch (err) {
      // The rows were already dropped locally; resync rather than guess.
      showAlert(`Bulk delete failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
      await Promise.all(Object.keys(pending.snapshot).map((pid) => loadConversations(pid)));
    }
  }, [onConversationDeleted, loadConversations, loadScheduleTree, showAlert]);

  /** Confirm → hide locally → 5 s undo window → THEN call the server (D17).
   *  Undo never touches the server; there is no restore endpoint. */
  const startBulkDelete = useCallback(() => {
    // Defensive: the UI disables schedule_home checkboxes, but never trust a Set.
    const ids = selectedConvs.filter((c) => c.kind !== 'schedule_home').map((c) => c.id);
    setBulkDeleteCount(null);
    if (ids.length === 0) { exitSelect(); return; }

    // A second destructive action flushes the first, exactly like submitDeleteProject.
    void flushBulkDelete();

    const idSet = new Set(ids);
    const affected = new Set(selectedConvs.filter((c) => idSet.has(c.id)).map((c) => c.projectId));
    const snapshot: Record<string, Conversation[]> = {};
    for (const pid of affected) snapshot[pid] = conversations[pid] ?? [];

    setConversations((prev) => {
      const next = { ...prev };
      for (const pid of affected) {
        next[pid] = (prev[pid] ?? []).filter((c) => !idSet.has(c.id));
      }
      return next;
    });
    exitSelect();

    const timer = setTimeout(() => {
      setToast(null);
      void flushBulkDelete();
    }, BULK_UNDO_WINDOW_MS);
    pendingBulkDeleteRef.current = { ids, snapshot, timer };

    setToast({
      message: `${ids.length} ${ids.length === 1 ? 'conversation' : 'conversations'} deleted.`,
      action: {
        label: 'Undo',
        onClick: () => {
          const pending = pendingBulkDeleteRef.current;
          if (pending) {
            clearTimeout(pending.timer);
            pendingBulkDeleteRef.current = null;
            setConversations((prev) => ({ ...prev, ...pending.snapshot }));
          }
          setToast(null);
        },
      },
    });
  }, [selectedConvs, conversations, exitSelect, flushBulkDelete]);

  const runScheduleBulk = useCallback(async (action: 'enable' | 'disable' | 'archive' | 'unarchive') => {
    // Schedule actions only make sense for job rows — silently skip any run/
    // spawn conversation ids that share the selection.
    const ids = Array.from(selectedIds).filter((id) => scheduleJobIdSet.has(id));
    if (ids.length === 0) return;

    // Flush any pending deletes first.
    void flushBulkDelete();
    void flushBulkScheduleDelete();

    setBulkBusy(true);
    try {
      const res = await api.bulkSchedules({ action, ids });
      const { failCount } = summariseBulkResults(res.results);

      // Exit select first so the bulk bar is gone before the toast mounts.
      exitSelect();

      const idSet = new Set(ids);
      if (action === 'archive' || action === 'unarchive') {
        setScheduleTrees((prev) => {
          const next: Record<string, ScheduleTreeResponse> = {};
          for (const [projId, tree] of Object.entries(prev)) {
            next[projId] = {
              ...tree,
              jobs: tree.jobs.filter((entry) => !idSet.has(entry.job.id)),
            };
          }
          return next;
        });
        if (action === 'archive') {
          for (const id of ids) {
            if (selectedJobId === id) onScheduleJobArchived?.(id);
          }
        }
      } else {
        const enabled = action === 'enable';
        setScheduleTrees((prev) => {
          const next: Record<string, ScheduleTreeResponse> = {};
          for (const [projId, tree] of Object.entries(prev)) {
            next[projId] = {
              ...tree,
              jobs: tree.jobs.map((entry) =>
                idSet.has(entry.job.id)
                  ? { ...entry, job: { ...entry.job, enabled } }
                  : entry,
              ),
            };
          }
          return next;
        });
      }

      const message = summariseScheduleBulkResults(action, res.results);
      showToast({ message }, 4_000);
    } catch (err) {
      showAlert(`Bulk ${action} failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds, scheduleJobIdSet, exitSelect, selectedJobId, onScheduleJobArchived, showToast, flushBulkDelete, showAlert]);

  const flushBulkScheduleDelete = useCallback(async () => {
    const pending = pendingBulkScheduleDeleteRef.current;
    if (!pending) return;
    pendingBulkScheduleDeleteRef.current = null;
    clearTimeout(pending.timer);
    try {
      // Job delete cascades whole run trees — run that first so conv bulk does
      // not race already-gone rows when a mixed selection includes both.
      const schedRes = pending.jobIds.length > 0
        ? await api.bulkSchedules({ action: 'delete', ids: pending.jobIds })
        : null;
      const convRes = pending.convIds.length > 0
        ? await api.bulkConversations({ action: 'delete', ids: pending.convIds })
        : null;
      const { failCount, okCount } = summariseBulkResults([
        ...(schedRes?.results ?? []),
        ...(convRes?.results ?? []),
      ]);
      const deletedConvIds = [
        ...(schedRes?.deletedConversationIds ?? []),
        ...(convRes?.deletedIds ?? []),
      ];
      if (deletedConvIds.length > 0) {
        onConversationDeleted?.(deletedConvIds);
      }
      for (const id of pending.jobIds) {
        if (selectedJobId === id) {
          onScheduleJobDeleted?.(id, deletedConvIds);
        }
      }
      if (failCount > 0) {
        setToast({ message: `${okCount} ${okCount === 1 ? 'item' : 'items'} deleted; ${failCount} failed` });
      }
      await Promise.all([
        ...Object.keys(pending.snapshot).map(async (pid) => {
          await loadScheduleTree(pid);
        }),
        ...Object.keys(pending.convSnapshot).map(async (pid) => {
          await loadConversations(pid);
        }),
      ]);
    } catch (err) {
      showAlert(`Bulk schedule delete failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
      await Promise.all([
        ...Object.keys(pending.snapshot).map((pid) => loadScheduleTree(pid)),
        ...Object.keys(pending.convSnapshot).map((pid) => loadConversations(pid)),
      ]);
    }
  }, [onConversationDeleted, onScheduleJobDeleted, selectedJobId, loadScheduleTree, loadConversations, showAlert]);

  const startBulkScheduleDelete = useCallback(() => {
    const allIds = Array.from(selectedIds);
    setBulkScheduleDeleteCount(null);
    if (allIds.length === 0) { exitSelect(); return; }

    void flushBulkDelete();
    void flushBulkScheduleDelete();

    const snapshot = { ...scheduleTrees };
    const jobIdSet = new Set(allIds.filter((id) => scheduleJobIdSet.has(id)));
    let convIdSet = new Set(allIds.filter((id) => !scheduleJobIdSet.has(id)));
    if (jobIdSet.size > 0 && convIdSet.size > 0) {
      const coveredByJobs = scheduleConversationIdsForJobs(scheduleTrees, jobIdSet);
      convIdSet = new Set([...convIdSet].filter((id) => !coveredByJobs.has(id)));
    }

    setScheduleTrees((prev) => {
      const next: Record<string, ScheduleTreeResponse> = {};
      for (const [projId, tree] of Object.entries(prev)) {
        next[projId] = {
          ...tree,
          jobs: tree.jobs
            .filter((entry) => !jobIdSet.has(entry.job.id))
            .map((entry) => {
              if (convIdSet.size === 0) return entry;
              const runs = entry.runs
                .map((runEntry) => {
                  if (runEntry.conversation && convIdSet.has(runEntry.conversation.id)) {
                    return null;
                  }
                  const descendants = runEntry.descendants.filter((d) => !convIdSet.has(d.id));
                  if (descendants.length === runEntry.descendants.length) return runEntry;
                  return { ...runEntry, descendants };
                })
                .filter((runEntry): runEntry is NonNullable<typeof runEntry> => runEntry != null);
              return { ...entry, runs };
            }),
        };
      }
      return next;
    });
    // Run/spawn conversations live in `conversations[pid]` too — hide them
    // there optimistically and snapshot for undo.
    const convSnapshot: Record<string, Conversation[]> = {};
    const convProjects = new Set(
      allLoadedConvs.filter((c) => convIdSet.has(c.id)).map((c) => c.projectId),
    );
    if (convProjects.size > 0) {
      for (const pid of convProjects) convSnapshot[pid] = conversations[pid] ?? [];
      setConversations((prev) => {
        const next = { ...prev };
        for (const pid of convProjects) {
          next[pid] = (prev[pid] ?? []).filter((c) => !convIdSet.has(c.id));
        }
        return next;
      });
    }
    exitSelect();

    const timer = setTimeout(() => {
      setToast(null);
      void flushBulkScheduleDelete();
    }, BULK_UNDO_WINDOW_MS);
    pendingBulkScheduleDeleteRef.current = {
      jobIds: [...jobIdSet],
      convIds: [...convIdSet],
      snapshot,
      convSnapshot,
      timer,
    };

    setToast({
      message: convIdSet.size === 0
        ? `${allIds.length} ${allIds.length === 1 ? 'schedule' : 'schedules'} deleted.`
        : `${allIds.length} ${allIds.length === 1 ? 'item' : 'items'} deleted.`,
      action: {
        label: 'Undo',
        onClick: () => {
          const pending = pendingBulkScheduleDeleteRef.current;
          if (pending) {
            clearTimeout(pending.timer);
            pendingBulkScheduleDeleteRef.current = null;
            setScheduleTrees(pending.snapshot);
            if (Object.keys(pending.convSnapshot).length > 0) {
              setConversations((prev) => ({ ...prev, ...pending.convSnapshot }));
            }
          }
          setToast(null);
        },
      },
    });
  }, [selectedIds, scheduleJobIdSet, allLoadedConvs, scheduleTrees, conversations, exitSelect, flushBulkDelete, flushBulkScheduleDelete]);

  // Clean up any pending delete timer on unmount so it doesn't fire after
  // the component is gone (which would call setState on an unmounted component).
  useEffect(() => {
    return () => {
      if (pendingProjectDelete) clearTimeout(pendingProjectDelete.timer);
    };
    // Intentionally run only on unmount; pendingProjectDelete is captured via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // FW-18: a pending bulk delete must not be lost when the sidebar unmounts —
  // the operator already confirmed it. Ref (not state) is why this works.
  useEffect(() => () => {
    const pending = pendingBulkDeleteRef.current;
    if (pending) {
      clearTimeout(pending.timer);
      pendingBulkDeleteRef.current = null;
      void api.bulkConversations({ action: 'delete', ids: pending.ids });
    }
    const pendingSched = pendingBulkScheduleDeleteRef.current;
    if (pendingSched) {
      clearTimeout(pendingSched.timer);
      pendingBulkScheduleDeleteRef.current = null;
      if (pendingSched.jobIds.length > 0) {
        void api.bulkSchedules({ action: 'delete', ids: pendingSched.jobIds });
      }
      if (pendingSched.convIds.length > 0) {
        void api.bulkConversations({ action: 'delete', ids: pendingSched.convIds });
      }
    }
  }, []);

  const [searchQuery, setSearchQuery] = useState('');
  // Migration 114 — archived view toggle. Session-only like tagQuery: opening
  // the archived view is a deliberate act, not a persisted preference.
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);
  // Flip = re-list every project from the other endpoint. refreshProjects is
  // stable (useCallback []), so this effect only fires on genuine toggles.
  useEffect(() => {
    if (projects.length === 0) return;
    void refreshProjects();
  }, [showArchived]); // eslint-disable-line react-hooks/exhaustive-deps
  // Session-only tag search (typed query or a chip click). Empty = no tag filter.
  const [tagQuery, setTagQuery] = useState('');
  const [tagSuggestOpen, setTagSuggestOpen] = useState(false);
  const [tagSuggestIdx, setTagSuggestIdx] = useState(-1);
  const activeTag = tagQuery.trim() || null;
  const knownTags = useMemo(() => {
    const items: Array<{ tags?: string[] }> = [];
    for (const list of Object.values(conversations)) items.push(...list);
    for (const tree of Object.values(scheduleTrees)) {
      for (const job of tree.jobs) {
        for (const run of job.runs) {
          if (run.conversation) items.push(run.conversation);
          items.push(...run.descendants);
        }
      }
    }
    return collectKnownTags(items);
  }, [conversations, scheduleTrees]);
  const tagSuggestions = suggestTags(knownTags, tagQuery, [], 8);
  const newConvTagSuggestions = suggestTags(knownTags, newConvTagDraft, newConvTags, 12);
  const [contentHitIds, setContentHitIds] = useState<Set<string>>(new Set());
  // FW-12: the full hits, keyed by conversation id, so a click can carry the matched
  // eventId into App. A ref, not state — contentHitIds already drives every render that
  // cares, and this map is only read inside a click handler.
  const contentHitsRef = useRef<Map<string, ConversationSearchHit>>(new Map());
  const [contentSearchState, setContentSearchState] = useState<'idle' | 'loading' | 'error'>('idle');
  // FW-6 follow-up: content search is opt-in. Missing/invalid → off (pre-FW-6 title+desc only).
  const [contentSearch, setContentSearch] = useState<boolean>(() => {
    try {
      return localStorage.getItem('sidebarContentSearch') === 'true';
    } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('sidebarContentSearch', String(contentSearch)); } catch { /* ignore */ }
  }, [contentSearch]);
  // Sidebar search scope. 'all' = today's behaviour (default, D1). 'project' limits
  // title/desc/content search to the active project while a query is typed (D2).
  const [searchScope, setSearchScope] = useState<SearchScope>(() => {
    try { return parseSearchScope(localStorage.getItem('sidebarSearchScope')); } catch { return 'all'; }
  });
  useEffect(() => {
    try { localStorage.setItem('sidebarSearchScope', searchScope); } catch { /* ignore */ }
  }, [searchScope]);
  const scopeAvailable = !!selectedProjectId && selectedProjectId !== PINNED_PROJECT_ID;
  const scopeProjectId = resolveSearchScopeProjectId(searchScope, selectedProjectId, searchQuery);
  const scopeOn = searchScope === 'project' && scopeAvailable; // button state, query-independent
  useEffect(() => {
    const q = searchQuery.trim();
    // Skip 1-char prefix scans (N9). Toggle off restores title+desc-only
    // behaviour: no GET /conversations/search. Same fetch on projects and
    // schedules — schedule run conversations are kind:'chat' and already
    // included in the existing endpoint.
    if (!contentSearch || !q || q.length < 2) {
      contentHitsRef.current = new Map();
      setContentHitIds(new Set());
      setContentSearchState('idle');
      return;
    }
    setContentSearchState('loading');
    let cancelled = false;
    const timer = setTimeout(() => {
      searchConversationContent(q, scopeProjectId ?? undefined)
        .then((hits) => {
          if (cancelled) return;
          contentHitsRef.current = new Map(hits.map((h) => [h.id, h]));
          setContentHitIds(new Set(hits.map((h) => h.id)));
          setContentSearchState('idle');
        })
        .catch(() => {
          if (cancelled) return;
          contentHitsRef.current = new Map();
          setContentHitIds(new Set());
          setContentSearchState('error');
        });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery, contentSearch, scopeProjectId]);
  // ponytail: 0 = no filter; other values = days threshold
  const [recentDays, setRecentDays] = useState<number>(() => {
    try {
      const v = localStorage.getItem('sidebarRecentDays');
      return v !== null ? Number(v) || 0 : 0;
    } catch { return 0; }
  });
  useEffect(() => {
    try { localStorage.setItem('sidebarRecentDays', String(recentDays)); } catch { /* ignore */ }
  }, [recentDays]);
  const [recentOpen, setRecentOpen] = useState(false);
  const recentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!recentOpen) return;
    const handler = (e: MouseEvent) => {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) setRecentOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [recentOpen]);
  const RECENT_OPTIONS = [
    { label: 'All', value: 0 },
    { label: '24 h', value: 1 },
    { label: '3 days', value: 3 },
    { label: '1 week', value: 7 },
  ] as const;

  // Drop hover freeze snapshot whenever fold state, pagination, or filters change
  useEffect(() => {
    frozenRecentOrderRef.current = null;
    frozenStatusOrderRef.current = null;
  }, [
    foldedParents,
    recentPage,
    statusIdlePage,
    statusCollapsed,
    searchQuery,
    activeTag,
    statusFilter,
    recentDays,
    groupBy,
    scopeProjectId,
  ]);

  const displayedProjects = filterGrokBotProject(
    recentDays === 0
      ? projects
      : projects.filter((p) =>
          p.id === selectedProjectId ||
          (conversations[p.id] ?? []).some((c) => Date.now() - c.updatedAt < recentDays * 86_400_000)
        ),
    grokBotEnabled,
  );

  // Virtual "Pinned" folder — derived, never stored. Aggregates every pinned
  // ROOT conversation (plus its subtree) after re-filtering each project's
  // bucket with that project's scheduleTrees hide-set (load-time
  // visibleOnProjectsTab has no hide-set). Sits directly above the Grok Bots
  // system folder.
  const pinnedConvs = useMemo(() => {
    const filtered: Record<string, Conversation[]> = {};
    for (const [pid, bucket] of Object.entries(conversations)) {
      const scheduleConvIds = scheduleConversationIds(scheduleTrees[pid]);
      filtered[pid] = visibleOnProjectsTab(bucket, scheduleConvIds);
    }
    return collectPinnedConversations(filtered);
  }, [conversations, scheduleTrees]);
  const projectNameById = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of projects) out[p.id] = p.name;
    return out;
  }, [projects]);
  const globalChildrenByParent = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    const seen = new Set<string>();
    const addChild = (c: Conversation) => {
      if (!c.parentConversationId || seen.has(c.id)) return;
      seen.add(c.id);
      const arr = map.get(c.parentConversationId) ?? [];
      arr.push(c);
      map.set(c.parentConversationId, arr);
    };
    for (const bucket of Object.values(conversations)) {
      for (const c of bucket) addChild(c);
    }
    for (const tree of Object.values(scheduleTrees)) {
      for (const jobEntry of tree.jobs) {
        for (const runEntry of jobEntry.runs) {
          for (const d of runEntry.descendants) addChild(d);
        }
      }
    }
    return map;
  }, [conversations, scheduleTrees]);

  const scheduleRunStatusFallbackByConvId = useMemo(() => {
    const map = new Map<string, AgentStatus>();
    for (const tree of Object.values(scheduleTrees)) {
      for (const jobEntry of tree.jobs) {
        for (const runEntry of jobEntry.runs) {
          const cid = runEntry.run.conversationId ?? runEntry.conversation?.id;
          if (!cid) continue;
          const fb = runFallbackStatus(runEntry.run, runEntry.conversation);
          if (fb) map.set(cid, fb);
        }
      }
    }
    return map;
  }, [scheduleTrees]);

  const dotCacheRef = useRef<Map<string, DotResult>>(new Map());
  dotCacheRef.current.clear();

  const getDot = useCallback(
    (c: Conversation): DotResult => {
      let cached = dotCacheRef.current.get(c.id);
      if (!cached) {
        const isSelected = c.id === selectedConversationId;
        const lastStatus = c.lastStatus ?? scheduleRunStatusFallbackByConvId.get(c.id);
        cached = resolveConversationDot({
          isSelected,
          selectedBadgeStatus,
          manuallyMarkedUnread: manuallyMarkedUnread.has(c.id),
          liveStatus: effectiveLiveStatus(c.id, conversationStatuses, c, wsObservedConversationIds),
          lastStatus,
          isUnread: unreadConversationIds.includes(c.id) || c.lastStatus === 'done',
          descendantActive: hasActiveDescendant(
            c.id,
            globalChildrenByParent,
            conversationStatuses,
            wsObservedConversationIds,
          ),
          helpersActive: helpersRunningIds?.has(c.id),
          errorRecovered: errorRecoveredConversationIds.has(c.id),
        });
        dotCacheRef.current.set(c.id, cached);
      }
      return cached;
    },
    [
      selectedConversationId,
      selectedBadgeStatus,
      manuallyMarkedUnread,
      conversationStatuses,
      wsObservedConversationIds,
      unreadConversationIds,
      globalChildrenByParent,
      scheduleRunStatusFallbackByConvId,
      errorRecoveredConversationIds,
      helpersRunningIds,
    ],
  );

  const bucketOf = useCallback(
    (c: Conversation): StatusBucket => {
      return bucketFromDot(getDot(c), c);
    },
    [getDot],
  );

  useEffect(() => {
    if (selectedConversationId !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = selectedConversationId;
      if (!selectedConversationId) {
        stickySelectionRef.current = null;
      } else if (stickySelectionRef.current?.id !== selectedConversationId) {
        let foundConv: Conversation | undefined;
        for (const b of Object.values(conversations)) {
          const c = b.find((x) => x.id === selectedConversationId);
          if (c) {
            foundConv = c;
            break;
          }
        }
        if (foundConv) {
          stickySelectionRef.current = {
            id: selectedConversationId,
            bucket: bucketOf(foundConv),
          };
        } else {
          stickySelectionRef.current = null;
        }
      }
    }
  }, [selectedConversationId, conversations, bucketOf]);

  const attentionCounts = useMemo(() => {
    const allConvs: Conversation[] = [];
    const validProjects = filterGrokBotProject(projects, grokBotEnabled);
    const validPids = new Set(validProjects.map((p) => p.id));
    for (const [pid, bucket] of Object.entries(conversations)) {
      if (!validPids.has(pid)) continue;
      const scheduleConvIds = scheduleConversationIds(scheduleTrees[pid]);
      const visible = visibleOnProjectsTab(bucket, scheduleConvIds);
      for (const c of visible) {
        if (!c.archived) allConvs.push(c);
      }
    }
    return aggregateCounts(allConvs, bucketOf);
  }, [conversations, scheduleTrees, bucketOf, projects, grokBotEnabled]);

  const attentionStripVisible =
    attentionCounts.waiting > 0 ||
    attentionCounts.error > 0 ||
    attentionCounts.running > 0 ||
    attentionCounts.subagents > 0 ||
    attentionCounts.unread > 0;
  const showAttentionStrip = sidebarMainTab === 'projects' && !showArchived && attentionStripVisible;

  const orderedProjects = useMemo(() => {
    return orderProjects(displayedProjects, projectOrder, (pid) => {
      const bucket = conversations[pid] ?? [];
      let max = 0;
      for (const c of bucket) {
        const act = activityAt(c, liveActivityAt ?? {});
        if (act > max) max = act;
      }
      return max;
    });
  }, [displayedProjects, projectOrder, conversations, liveActivityAt]);

  const projectsWithPinned = useMemo(() => {
    if (pinnedConvs.length === 0) return orderedProjects;
    const grokIdx = orderedProjects.findIndex(
      (p) => p.id === REMOTE_AGENTS_PROJECT_ID || p.name === 'Grok Bots',
    );
    const at = grokIdx === -1 ? 0 : grokIdx;
    return [...orderedProjects.slice(0, at), pinnedPseudoProject(), ...orderedProjects.slice(at)];
  }, [orderedProjects, pinnedConvs.length]);
  const allProjectsCollapsed =
    projectsWithPinned.length > 0 && projectsWithPinned.every((p) => collapsedProjects[p.id] === true);

  // Schedules tab: only projects that have ≥1 job in the current view (active vs archived).
  // When the recent filter is active, drop projects whose schedule tree has no
  // recent run/conversation activity — keeps the Schedules list in sync with
  // the same dropdown the Projects tab uses.
  const scheduleKeepIds = contentSearch ? contentHitIds : undefined;
  const scheduleProjects = projects.filter((p) => {
    if (scopeProjectId && p.id !== scopeProjectId) return false; // D6
    const tree = scheduleTrees[p.id];
    if (!tree || tree.jobs.length === 0) return false;
    const matchingJobs = tree.jobs.filter((entry) => showArchived ? entry.job.archived : !entry.job.archived);
    if (matchingJobs.length === 0) return false;
    if (recentDays === 0) return true;
    return filterScheduleTreeByRecent({ jobs: matchingJobs }, recentDays, selectedConversationId, scheduleKeepIds).jobs.length > 0;
  });
  const scheduleLayout = layoutScheduleProjects(scheduleProjects, scheduleTrees, remoteHosts, groupBy, projectOrder);
  const allScheduleProjectsCollapsed =
    scheduleProjects.length > 0 && scheduleProjects.every((p) => collapsedProjects[p.id] === true);

  return (
    <aside
      ref={sidebarRootRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`sidebar${isOpen ? ' open' : ''}${selecting ? ' sidebar--selecting' : ''}`}
    >
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_W_MIN}
        aria-valuemax={clampSidebarWidth(SIDEBAR_W_MAX, typeof window !== 'undefined' ? window.innerWidth : 1200)}
        aria-valuenow={sidebarWidth ?? SIDEBAR_W_DEFAULT}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        onDoubleClick={handleResizeDoubleClick}
      />
      <div className="sidebar-label sidebar-label--tabs">
        <div className="sidebar-main-tabs" role="tablist" aria-label="Sidebar">
          <button
            type="button"
            role="tab"
            className={`sidebar-main-tab${sidebarMainTab === 'projects' ? ' active' : ''}`}
            aria-selected={sidebarMainTab === 'projects'}
            onClick={() => setMainTab('projects', { userInitiated: true })}
          >
            Projects
          </button>
          <button
            type="button"
            role="tab"
            className={`sidebar-main-tab${sidebarMainTab === 'schedules' ? ' active' : ''}`}
            aria-selected={sidebarMainTab === 'schedules'}
            onClick={() => setMainTab('schedules', { userInitiated: true })}
          >
            Schedules
          </button>
        </div>
        <div className="sidebar-header-actions">
          {sidebarMainTab === 'projects' && (
            <>
              <button className="sidebar-add" onClick={addProject} title="New project" aria-label="New project">+</button>
              <button
                className="sidebar-collapse-toggle"
                onClick={() => {
                  const next: Record<string, boolean> = { ...collapsedProjects };
                  if (allProjectsCollapsed) {
                    for (const p of projectsWithPinned) delete next[p.id];
                  } else {
                    for (const p of projectsWithPinned) next[p.id] = true;
                  }
                  setCollapsedProjects(next);
                  try { localStorage.setItem('collapsedProjects', JSON.stringify(next)); } catch { /* ignore */ }
                }}
                title={allProjectsCollapsed ? 'Expand all' : 'Collapse all'}
              >
                {allProjectsCollapsed ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="7 9 12 4 17 9" />
                    <polyline points="7 15 12 20 17 15" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="7 4 12 9 17 4" />
                    <polyline points="7 20 12 15 17 20" />
                  </svg>
                )}
              </button>
              <div ref={recentRef} style={{ position: 'relative' }}>
                <button
                  className={`sidebar-recent-trigger${recentDays !== 0 ? ' active' : ''}`}
                  onClick={() => setRecentOpen((v) => !v)}
                  title={recentDays !== 0 ? `Filtered: ${RECENT_OPTIONS.find(o => o.value === recentDays)?.label}` : 'Filter by recent activity'}
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
              <button
                type="button"
                className={`sidebar-recent-trigger${showArchived ? ' active' : ''}`}
                aria-pressed={showArchived}
                title={showArchived ? 'Showing archived conversations — click to show active' : 'Show archived conversations'}
                onClick={() => setShowArchived((v) => !v)}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
              </button>
              <div ref={viewMenuRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  className={`sidebar-recent-trigger${groupBy !== 'project' || projectOrder !== 'created' ? ' active' : ''}`}
                  onClick={() => setViewPopoverOpen((v) => !v)}
                  title={`View: ${groupBy === 'project' ? 'Projects' : groupBy === 'host' ? 'Hosts' : groupBy === 'recent' ? 'Recent' : 'Status'}${groupBy === 'project' || groupBy === 'host' ? ` (${projectOrder === 'created' ? 'Created' : projectOrder === 'activity' ? 'Activity' : 'Name'})` : ''}`}
                  aria-haspopup="menu"
                  aria-expanded={viewPopoverOpen}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="3" y1="9" x2="21" y2="9" />
                    <line x1="3" y1="15" x2="21" y2="15" />
                  </svg>
                  {(groupBy !== 'project' || projectOrder !== 'created') && <span className="sidebar-view-dot" />}
                </button>
                {viewPopoverOpen && (
                  <div className="sidebar-recent-panel sidebar-view-panel" role="menu">
                    <div className="sidebar-popover-heading">Group by</div>
                    <div
                      className={`sidebar-recent-item${groupBy === 'project' ? ' sidebar-recent-item--selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={groupBy === 'project'}
                      onClick={() => { setGroupBy('project'); setViewPopoverOpen(false); }}
                    >
                      <span className="check">{groupBy === 'project' ? '✓' : ''}</span>
                      Projects
                    </div>
                    <div
                      className={`sidebar-recent-item${groupBy === 'host' ? ' sidebar-recent-item--selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={groupBy === 'host'}
                      onClick={() => { setGroupBy('host'); setViewPopoverOpen(false); }}
                    >
                      <span className="check">{groupBy === 'host' ? '✓' : ''}</span>
                      Hosts
                    </div>
                    <div
                      className={`sidebar-recent-item${groupBy === 'recent' ? ' sidebar-recent-item--selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={groupBy === 'recent'}
                      onClick={() => { setGroupBy('recent'); setViewPopoverOpen(false); }}
                    >
                      <span className="check">{groupBy === 'recent' ? '✓' : ''}</span>
                      Recent
                    </div>
                    <div
                      className={`sidebar-recent-item${groupBy === 'status' ? ' sidebar-recent-item--selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={groupBy === 'status'}
                      onClick={() => { setGroupBy('status'); setViewPopoverOpen(false); }}
                    >
                      <span className="check">{groupBy === 'status' ? '✓' : ''}</span>
                      Status
                    </div>
                    {(groupBy === 'project' || groupBy === 'host') && (
                      <>
                        <div className="sidebar-popover-divider" />
                        <div className="sidebar-popover-heading">Order projects</div>
                        <div
                          className={`sidebar-recent-item${projectOrder === 'created' ? ' sidebar-recent-item--selected' : ''}`}
                          role="menuitemradio"
                          aria-checked={projectOrder === 'created'}
                          onClick={() => { setProjectOrder('created'); setViewPopoverOpen(false); }}
                        >
                          <span className="check">{projectOrder === 'created' ? '✓' : ''}</span>
                          Newest created
                        </div>
                        <div
                          className={`sidebar-recent-item${projectOrder === 'activity' ? ' sidebar-recent-item--selected' : ''}`}
                          role="menuitemradio"
                          aria-checked={projectOrder === 'activity'}
                          onClick={() => { setProjectOrder('activity'); setViewPopoverOpen(false); }}
                        >
                          <span className="check">{projectOrder === 'activity' ? '✓' : ''}</span>
                          Recent activity
                        </div>
                        <div
                          className={`sidebar-recent-item${projectOrder === 'name' ? ' sidebar-recent-item--selected' : ''}`}
                          role="menuitemradio"
                          aria-checked={projectOrder === 'name'}
                          onClick={() => { setProjectOrder('name'); setViewPopoverOpen(false); }}
                        >
                          <span className="check">{projectOrder === 'name' ? '✓' : ''}</span>
                          Name A–Z
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {sidebarMainTab === 'schedules' && (
            <>
              <button
                className="sidebar-add"
                onClick={() => openCreateSchedule()}
                title="New schedule"
                aria-label="New schedule"
              >
                +
              </button>
              {scheduleProjects.length > 0 && (
                <button
                  className="sidebar-collapse-toggle"
                  onClick={() => {
                    const next: Record<string, boolean> = { ...collapsedProjects };
                    if (allScheduleProjectsCollapsed) {
                      for (const p of scheduleProjects) delete next[p.id];
                    } else {
                      for (const p of scheduleProjects) next[p.id] = true;
                    }
                    setCollapsedProjects(next);
                    try { localStorage.setItem('collapsedProjects', JSON.stringify(next)); } catch { /* ignore */ }
                  }}
                  title={allScheduleProjectsCollapsed ? 'Expand all' : 'Collapse all'}
                >
                  {allScheduleProjectsCollapsed ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="7 9 12 4 17 9" />
                      <polyline points="7 15 12 20 17 15" />
                    </svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="7 4 12 9 17 4" />
                      <polyline points="7 20 12 15 17 20" />
                    </svg>
                  )}
                </button>
              )}
              <div ref={recentRef} style={{ position: 'relative' }}>
                <button
                  className={`sidebar-recent-trigger${recentDays !== 0 ? ' active' : ''}`}
                  onClick={() => setRecentOpen((v) => !v)}
                  title={recentDays !== 0 ? `Filtered: ${RECENT_OPTIONS.find(o => o.value === recentDays)?.label}` : 'Filter by recent activity'}
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
              <button
                type="button"
                className={`sidebar-recent-trigger${showArchived ? ' active' : ''}`}
                aria-pressed={showArchived}
                title={showArchived ? 'Showing archived schedules — click to show active' : 'Show archived schedules'}
                onClick={() => setShowArchived((v) => !v)}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
              </button>
              <div ref={viewMenuRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  className={`sidebar-recent-trigger${groupBy !== 'project' || projectOrder !== 'created' ? ' active' : ''}`}
                  onClick={() => setViewPopoverOpen((v) => !v)}
                  title={`View: ${groupBy === 'project' ? 'Projects' : groupBy === 'host' ? 'Hosts' : groupBy === 'recent' ? 'Recent' : 'Status'}${groupBy === 'project' || groupBy === 'host' ? ` (${projectOrder === 'created' ? 'Created' : projectOrder === 'activity' ? 'Activity' : 'Name'})` : ''}`}
                  aria-haspopup="menu"
                  aria-expanded={viewPopoverOpen}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="3" y1="9" x2="21" y2="9" />
                    <line x1="3" y1="15" x2="21" y2="15" />
                  </svg>
                  {(groupBy !== 'project' || projectOrder !== 'created') && <span className="sidebar-view-dot" />}
                </button>
                {viewPopoverOpen && (
                  <div className="sidebar-recent-panel sidebar-view-panel" role="menu">
                    <div className="sidebar-popover-heading">Group by</div>
                    <div
                      className={`sidebar-recent-item${groupBy === 'project' ? ' sidebar-recent-item--selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={groupBy === 'project'}
                      onClick={() => { setGroupBy('project'); setViewPopoverOpen(false); }}
                    >
                      <span className="check">{groupBy === 'project' ? '✓' : ''}</span>
                      Projects
                    </div>
                    <div
                      className={`sidebar-recent-item${groupBy === 'host' ? ' sidebar-recent-item--selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={groupBy === 'host'}
                      onClick={() => { setGroupBy('host'); setViewPopoverOpen(false); }}
                    >
                      <span className="check">{groupBy === 'host' ? '✓' : ''}</span>
                      Hosts
                    </div>
                    <div
                      className={`sidebar-recent-item${groupBy === 'recent' ? ' sidebar-recent-item--selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={groupBy === 'recent'}
                      onClick={() => { setGroupBy('recent'); setViewPopoverOpen(false); }}
                    >
                      <span className="check">{groupBy === 'recent' ? '✓' : ''}</span>
                      Recent
                    </div>
                    <div
                      className={`sidebar-recent-item${groupBy === 'status' ? ' sidebar-recent-item--selected' : ''}`}
                      role="menuitemradio"
                      aria-checked={groupBy === 'status'}
                      onClick={() => { setGroupBy('status'); setViewPopoverOpen(false); }}
                    >
                      <span className="check">{groupBy === 'status' ? '✓' : ''}</span>
                      Status
                    </div>
                    {(groupBy === 'project' || groupBy === 'host') && (
                      <>
                        <div className="sidebar-popover-divider" />
                        <div className="sidebar-popover-heading">Order projects</div>
                        <div
                          className={`sidebar-recent-item${projectOrder === 'created' ? ' sidebar-recent-item--selected' : ''}`}
                          role="menuitemradio"
                          aria-checked={projectOrder === 'created'}
                          onClick={() => { setProjectOrder('created'); setViewPopoverOpen(false); }}
                        >
                          <span className="check">{projectOrder === 'created' ? '✓' : ''}</span>
                          Newest created
                        </div>
                        <div
                          className={`sidebar-recent-item${projectOrder === 'activity' ? ' sidebar-recent-item--selected' : ''}`}
                          role="menuitemradio"
                          aria-checked={projectOrder === 'activity'}
                          onClick={() => { setProjectOrder('activity'); setViewPopoverOpen(false); }}
                        >
                          <span className="check">{projectOrder === 'activity' ? '✓' : ''}</span>
                          Recent activity
                        </div>
                        <div
                          className={`sidebar-recent-item${projectOrder === 'name' ? ' sidebar-recent-item--selected' : ''}`}
                          role="menuitemradio"
                          aria-checked={projectOrder === 'name'}
                          onClick={() => { setProjectOrder('name'); setViewPopoverOpen(false); }}
                        >
                          <span className="check">{projectOrder === 'name' ? '✓' : ''}</span>
                          Name A–Z
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {onTogglePin && (
            <button
              type="button"
              className={`sidebar-pin-toggle${isPinned ? ' active' : ''}`}
              onClick={onTogglePin}
              title={isPinned ? 'Unpin sidebar (full screen conversation)' : 'Pin sidebar to layout'}
              aria-label={isPinned ? 'Unpin sidebar' : 'Pin sidebar'}
              aria-pressed={isPinned}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-2l-3-3V4a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v8l-3 3v2z" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className={`sidebar-search-row${showAttentionStrip ? ' sidebar-search-row--with-attention' : ''}`}>
        <div className="sidebar-search-stack">
          <div className="sidebar-search-box">
            <svg className="sidebar-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              className="sidebar-search-input sidebar-search-input--with-text-toggle"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Filter by text"
            />
            <div className="sidebar-search-trailing">
              <button
                type="button"
                className={`sidebar-search-text-toggle sidebar-search-scope-toggle${scopeOn ? ' active' : ''}`}
                aria-pressed={scopeOn}
                disabled={!scopeAvailable}
                title={!scopeAvailable
                  ? 'Select a project to scope search'
                  : searchScope === 'project'
                    ? `Searching ${projectNameById[selectedProjectId!] ?? 'this project'} only — click to search all projects`
                    : 'Searching all projects — click to search this project only'}
                aria-label="Search this project only"
                onClick={() => setSearchScope((s) => (s === 'project' ? 'all' : 'project'))}
              >
                {scopeOn ? (
                  /* folder = this project */
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                ) : (
                  /* layers = all projects */
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className={`sidebar-search-text-toggle${contentSearch ? ' active' : ''}`}
                aria-pressed={contentSearch}
                title={contentSearch ? 'Message text search on' : 'Search message text'}
                onClick={() => setContentSearch((v) => !v)}
              >
                Aa
              </button>
              {searchQuery && (
                <button
                  type="button"
                  className="sidebar-search-clear"
                  onClick={() => setSearchQuery('')}
                  title="Clear text filter"
                  aria-label="Clear text filter"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              )}
            </div>
          </div>
          <div className={`sidebar-search-box sidebar-search-box--tag${tagQuery.trim() ? ' sidebar-search-box--filtering' : ''}`}>
            <span className="sidebar-search-tag-hash" aria-hidden>#</span>
            <input
              type="text"
              className="sidebar-search-input"
              placeholder={showArchived ? 'Tags (archived)' : 'Tags'}
              value={tagQuery}
              onChange={(e) => { setTagQuery(e.target.value); setTagSuggestOpen(true); setTagSuggestIdx(-1); }}
              onFocus={() => setTagSuggestOpen(true)}
              onBlur={() => { window.setTimeout(() => setTagSuggestOpen(false), 120); }}
              onKeyDown={(e) => {
                if (!tagSuggestOpen || tagSuggestions.length === 0) {
                  if (e.key === 'Escape' && tagQuery) { e.stopPropagation(); setTagQuery(''); }
                  return;
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setTagSuggestIdx((i) => (i + 1) % tagSuggestions.length);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setTagSuggestIdx((i) => (i <= 0 ? tagSuggestions.length - 1 : i - 1));
                } else if (e.key === 'Enter' && tagSuggestIdx >= 0) {
                  e.preventDefault();
                  setTagQuery(tagSuggestions[tagSuggestIdx]);
                  setTagSuggestOpen(false);
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setTagSuggestOpen(false);
                }
              }}
              aria-label="Filter by tag"
              autoComplete="off"
            />
            {tagQuery && (
              <button
                type="button"
                className="sidebar-search-clear sidebar-search-clear--tag"
                onClick={() => setTagQuery('')}
                title="Clear tag filter"
                aria-label="Clear tag filter"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            )}
            {tagSuggestOpen && tagSuggestions.length > 0 && (
              <ul className="tag-suggest" role="listbox">
                {tagSuggestions.map((t, i) => (
                  <li
                    key={t}
                    role="option"
                    aria-selected={i === tagSuggestIdx}
                    className={`tag-suggest-item${i === tagSuggestIdx ? ' tag-suggest-item--active' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); setTagQuery(t); setTagSuggestOpen(false); }}
                  >
                    {t}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      {contentSearch && searchQuery.trim() && contentSearchState !== 'idle' && (
        <div className="sidebar-search-hint">
          {contentSearchState === 'loading'
            ? (scopeProjectId ? 'Searching messages in this project…' : 'Searching messages…')
            : 'Content search unavailable'}
        </div>
      )}
      {showAttentionStrip && (
        <div className="sidebar-attention-strip" role="toolbar" aria-label="Filter by attention status">
          {attentionCounts.waiting > 0 && (
            <button
              type="button"
              className={`sidebar-attention-chip waiting${statusFilter.has('waiting') ? ' active' : ''}`}
              aria-pressed={statusFilter.has('waiting')}
              onClick={() => toggleStatusFilter('waiting')}
            >
              <span className="chip-symbol">◎</span>
              <span>{attentionCounts.waiting} waiting</span>
            </button>
          )}
          {attentionCounts.error > 0 && (
            <button
              type="button"
              className={`sidebar-attention-chip error${statusFilter.has('error') ? ' active' : ''}`}
              aria-pressed={statusFilter.has('error')}
              onClick={() => toggleStatusFilter('error')}
            >
              <span className="chip-symbol">✕</span>
              <span>{attentionCounts.error} error</span>
            </button>
          )}
          {attentionCounts.running > 0 && (
            <button
              type="button"
              className={`sidebar-attention-chip running${statusFilter.has('running') ? ' active' : ''}`}
              aria-pressed={statusFilter.has('running')}
              onClick={() => toggleStatusFilter('running')}
            >
              <span className="chip-symbol">●</span>
              <span>{attentionCounts.running} running</span>
            </button>
          )}
          {attentionCounts.subagents > 0 && (
            <button
              type="button"
              className={`sidebar-attention-chip subagents${statusFilter.has('subagents') ? ' active' : ''}`}
              aria-pressed={statusFilter.has('subagents')}
              onClick={() => toggleStatusFilter('subagents')}
            >
              <span className="sidebar-agg-diamond" />
              <span>{attentionCounts.subagents} subagents</span>
            </button>
          )}
          {attentionCounts.unread > 0 && (
            <button
              type="button"
              className={`sidebar-attention-chip unread${statusFilter.has('unread') ? ' active' : ''}`}
              aria-pressed={statusFilter.has('unread')}
              onClick={() => toggleStatusFilter('unread')}
            >
              <span className="chip-symbol">●</span>
              <span>{attentionCounts.unread} unread</span>
            </button>
          )}
        </div>
      )}
      {sidebarMainTab === 'schedules' && (
        <div className="sidebar-pinned-calendar">
          <button
            type="button"
            className={`schedule-calendar-row${scheduleCalendarSelected ? ' active' : ''}`}
            title="Upcoming fires across projects"
            onClick={() => onOpenScheduleCalendar?.()}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="3" y1="10" x2="21" y2="10" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="16" y1="2" x2="16" y2="6" />
            </svg>
            <span>Calendar</span>
          </button>
        </div>
      )}
      {(() => {
        const validProjects = filterGrokBotProject(projects, grokBotEnabled);
        const validPids = new Set(validProjects.map((p) => p.id));
        const allProjectsTabConvs = (() => {
          const result: Conversation[] = [];
          for (const [pid, bucket] of Object.entries(conversations)) {
            if (!validPids.has(pid)) continue;
            const tree = scheduleTrees[pid];
            const scheduleConvIds = scheduleConversationIds(tree);
            const visible = visibleOnProjectsTab(bucket, scheduleConvIds);
            for (const c of visible) {
              result.push(c);
            }
          }
          return result;
        })();

        const projectMap = new Map<string, Project>();
        for (const p of projects) {
          projectMap.set(p.id, p);
        }

        const projectFor = (c: Conversation): Project => {
          return projectMap.get(c.projectId) ?? pinnedPseudoProject();
        };

        const selectConversationRow = (c: Conversation) => {
          stickySelectionRef.current = { id: c.id, bucket: bucketOf(c) };
          const hitEventId = contentHitsRef.current.get(c.id)?.eventId;
          const q = searchQuery.trim();
          onSelectConversation(projectFor(c), c, hitEventId, hitEventId && q ? { focusQuery: q } : undefined);
          clearUnread(c.id);
          if (manuallyMarkedUnread.has(c.id)) {
            setManuallyMarkedUnread((prev) => {
              if (!prev.has(c.id)) return prev;
              const next = new Set(prev);
              next.delete(c.id);
              return next;
            });
          }
        };

        const parentTitleMap = new Map<string, string>();
        for (const bucket of Object.values(conversations)) {
          for (const c of bucket) {
            parentTitleMap.set(c.id, c.title);
          }
        }

        const parentTitle = (parentId: string): string | undefined => {
          return parentTitleMap.get(parentId);
        };

        const projectName = (pid: string): string => {
          return projectNameById[pid] || projectMap.get(pid)?.name || '';
        };

        const applyHoverFreezeRecent = (rows: FlatRow[]): FlatRow[] => {
          if (!isHoveringListRef.current) {
            frozenRecentOrderRef.current = null;
            return rows;
          }
          if (!frozenRecentOrderRef.current) {
            frozenRecentOrderRef.current = rows.map((r) => r.c.id);
            return rows;
          }
          const frozenPos = new Map<string, number>();
          frozenRecentOrderRef.current.forEach((id, idx) => frozenPos.set(id, idx));

          let lastKnownPos = -1;
          const positioned = rows.map((r, i) => {
            if (frozenPos.has(r.c.id)) {
              lastKnownPos = frozenPos.get(r.c.id)!;
              return { row: r, sortKey: lastKnownPos, origIndex: i };
            }
            return { row: r, sortKey: lastKnownPos + 0.0001 * (i + 1), origIndex: i };
          });

          positioned.sort((a, b) => a.sortKey - b.sortKey || a.origIndex - b.origIndex);
          return positioned.map((p) => p.row);
        };

        const applyHoverFreezeStatus = (bucket: StatusBucket, rows: FlatRow[]): FlatRow[] => {
          if (!isHoveringListRef.current) {
            if (frozenStatusOrderRef.current) frozenStatusOrderRef.current = null;
            return rows;
          }
          if (!frozenStatusOrderRef.current) {
            frozenStatusOrderRef.current = new Map();
          }
          const bucketFrozen = frozenStatusOrderRef.current.get(bucket);
          if (!bucketFrozen) {
            frozenStatusOrderRef.current.set(bucket, rows.map((r) => r.c.id));
            return rows;
          }
          const frozenPos = new Map<string, number>();
          bucketFrozen.forEach((id, idx) => frozenPos.set(id, idx));

          let lastKnownPos = -1;
          const positioned = rows.map((r, i) => {
            if (frozenPos.has(r.c.id)) {
              lastKnownPos = frozenPos.get(r.c.id)!;
              return { row: r, sortKey: lastKnownPos, origIndex: i };
            }
            return { row: r, sortKey: lastKnownPos + 0.0001 * (i + 1), origIndex: i };
          });

          positioned.sort((a, b) => a.sortKey - b.sortKey || a.origIndex - b.origIndex);
          return positioned.map((p) => p.row);
        };

        const renderProjectGroup = (p: Project, opts?: { hideHostChip?: boolean; hostSearchMatch?: boolean }) => {
          const isPinnedFolder = p.id === PINNED_PROJECT_ID;
          // D6: scoped search shows only the active project (Pinned folder is
          // filtered per-row by scopeProjectId instead).
          if (scopeProjectId && !isPinnedFolder && p.id !== scopeProjectId) return null;
          const tree = scheduleTrees[p.id];
          const scheduleConvIds = scheduleConversationIds(tree);
          const list = isPinnedFolder
            ? pinnedConvs
            : visibleOnProjectsTab(conversations[p.id] ?? [], scheduleConvIds);

          const filteredConvs = filterConversations(list, {
            recentDays,
            now: Date.now(),
            selectedConversationId,
            showArchived,
            activeTag,
            searchQuery,
            contentSearch,
            contentHitIds,
            statusFilter,
            bucketOf,
            isPinnedFolder,
            scopeProjectId,
          });

          const visibleIds = new Set(filteredConvs.map((c) => c.id));
          const childrenByParent = new Map<string, typeof filteredConvs>();
          for (const c of filteredConvs) {
            if (c.parentConversationId) {
              const arr = childrenByParent.get(c.parentConversationId) ?? [];
              arr.push(c);
              childrenByParent.set(c.parentConversationId, arr);
            }
          }

          const isParentFolded = (parentId: string): boolean => {
            if (searchQuery || activeTag || (statusFilter && statusFilter.size > 0)) return false;
            return foldedParents[parentId] ?? true;
          };

          const getDepth = (c: Conversation): number => {
            let depth = 0;
            let current = c;
            const visited = new Set<string>();
            while (current.parentConversationId && visibleIds.has(current.parentConversationId)) {
              if (visited.has(current.id)) break;
              visited.add(current.id);
              const parent = filteredConvs.find((x) => x.id === current.parentConversationId);
              if (!parent) break;
              depth++;
              current = parent;
            }
            return depth;
          };

          const getOrdered = (c: Conversation): { c: Conversation; depth: number }[] => {
            const depth = getDepth(c);
            const kids = childrenByParent.get(c.id) ?? [];
            if (kids.length === 0 || isParentFolded(c.id)) {
              return [{ c, depth }];
            }
            return [{ c, depth }, ...kids.flatMap(getOrdered)];
          };

          const roots = filteredConvs.filter((c) => !c.parentConversationId || !visibleIds.has(c.parentConversationId));
          const orderedConvs = roots.flatMap(getOrdered);

          const projectMatches = searchQuery ? p.name.toLowerCase().includes(searchQuery.toLowerCase()) : false;
          const boundHost = p.remoteHostId ? remoteHosts.find((h) => h.id === p.remoteHostId) : undefined;
          const hostMetaMatch = !!(boundHost && searchQuery && remoteHostMatchesSearch(boundHost, searchQuery));
          const hasActiveFilter = !!(searchQuery || activeTag || (statusFilter && statusFilter.size > 0));
          const showProject = (!hasActiveFilter) || (projectMatches && !hasActiveFilter) || filteredConvs.length > 0
            || !!opts?.hostSearchMatch || hostMetaMatch;

          if (!showProject) return null;
          if (isPinnedFolder && filteredConvs.length === 0) return null;

          const projectHasSelected = (selectedProjectId === p.id) || (conversations[p.id] ?? []).some((c) => c.id === selectedConversationId);
          const isCollapsed = hasActiveFilter ? false : (collapsedProjects[p.id] === true);

          const limitForPage = (page: number) => LIST_INITIAL_PAGE + (page - 1) * LIST_PAGE_STEP;
          const allPinnedItems = isPinnedFolder
            ? groupPinnedItems(orderedConvs, projectNameById, collapsedPinnedGroups)
            : null;
          const pageLength = allPinnedItems ? allPinnedItems.length : orderedConvs.length;

          const pageSize = hasActiveFilter
            ? pageLength
            : (() => {
                const cur = convListPageSizes[p.id] ?? 1;
                const limit = limitForPage(cur);
                if (!selectedConversationId) return limit;
                const selIdx = allPinnedItems
                  ? allPinnedItems.findIndex((item) => item.kind === 'row' && item.c.id === selectedConversationId)
                  : orderedConvs.findIndex(({ c }) => c.id === selectedConversationId);
                if (selIdx === -1 || selIdx < limit) return limit;
                const pagesNeeded = Math.ceil((selIdx + 1 - LIST_INITIAL_PAGE) / LIST_PAGE_STEP) + 1;
                return limitForPage(Math.max(cur, pagesNeeded));
              })();

          const renderItems: PinnedListItem[] = allPinnedItems
            ? allPinnedItems.slice(0, pageSize)
            : orderedConvs.slice(0, pageSize).map(({ c, depth }) => ({ kind: 'row' as const, c, depth }));
          const hiddenCount = Math.max(0, pageLength - renderItems.length);

          for (const item of renderItems) {
            if (item.kind === 'row') visibleConvIdsRef.current.add(item.c.id);
          }
          const selectableIds = renderItems
            .filter((item): item is Extract<PinnedListItem, { kind: 'row' }> => item.kind === 'row')
            .filter((item) => item.c.kind !== 'schedule_home')
            .map((item) => item.c.id);
          const selectedHere = selectableIds.filter((id) => selectedIds.has(id)).length;
          const projectCheckState = selectedHere === 0
            ? 'off'
            : selectedHere === selectableIds.length ? 'on' : 'mixed';

          const projectAggCounts = aggregateCounts(
            list.filter((c) => !c.archived),
            bucketOf,
          );

          return (
            <div key={p.id} className="project-group" data-expanded={isCollapsed ? 'false' : 'true'}>
              <div className="project-row">
                {selecting && (
                  <button
                    type="button"
                    className="project-select-all"
                    onClick={(e) => { e.stopPropagation(); toggleSelectAllForProject(selectableIds); }}
                    disabled={selectableIds.length === 0}
                    title={projectCheckState === 'on' ? `Clear selection in ${p.name}` : `Select all in ${p.name}`}
                    aria-pressed={projectCheckState === 'on'}
                  >
                    {projectCheckState === 'on' ? 'None' : 'All'}
                  </button>
                )}
                <button
                  className={`project-item ${projectHasSelected ? 'active' : ''}`}
                  onClick={() => toggleProject(p.id)}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      transition: 'transform 0.2s',
                      transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                      opacity: 0.5,
                      marginRight: '-2px',
                      flexShrink: 0,
                    }}
                  >
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                  {p.id === REMOTE_AGENTS_PROJECT_ID || p.name === 'Grok Bots' ? (
                    <>
                      <GrokBotIcon />
                      {grokBotState && (
                        <span
                          aria-hidden
                          title={grokBotState}
                          style={{
                            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                            background: statusDotColor(grokBotState),
                          }}
                        />
                      )}
                    </>
                  ) : isPinnedFolder ? (
                    <PinnedFolderIcon />
                  ) : (
                    <svg className="project-folder-icon" width="16" height="14" viewBox="0 0 16 14" fill="none" style={{ flexShrink: 0 }}>
                      <path d="M1.5 2C1.5 1.17157 2.17157 0.5 3 0.5H6L7.5 2.5H13C13.8284 2.5 14.5 3.17157 14.5 4V11.5C14.5 12.3284 13.8284 13 13 13H3C2.17157 13 1.5 12.3284 1.5 11.5V2Z" fill="var(--accent-dim)" fillOpacity="0.25" stroke="var(--accent)" strokeWidth="1.2" strokeLinejoin="round"/>
                    </svg>
                  )}
                  {p.name}
                  {!opts?.hideHostChip && <HostChip project={p} hosts={remoteHosts} />}
                  {p.system && !isPinnedFolder && <span className="project-system-badge">System</span>}
                  <AggregateBadge counts={projectAggCounts} />
                </button>
                <ConvOverflowMenu convId={`project:${p.id}`} pos={overflow} onToggle={toggleOverflow} onClose={closeOverflow}>
                  {!isPinnedFolder && (
                    <button type="button" className="dropdown-item" role="menuitem"
                      onClick={(e) => { e.stopPropagation(); addConversation(p); closeOverflow(); }}>New conversation</button>
                  )}
                  {!isPinnedFolder && (
                    <button type="button" className="dropdown-item" role="menuitem"
                      onClick={(e) => { e.stopPropagation(); openCreateSchedule(p); closeOverflow(); }}>New schedule…</button>
                  )}
                  {(() => {
                    const parentConvIds = Array.from(childrenByParent.keys());
                    if (parentConvIds.length === 0) return null;
                    const anyFolded = parentConvIds.some((id) => foldedParents[id] ?? true);
                    return anyFolded ? (
                      <button type="button" className="dropdown-item" role="menuitem"
                        onClick={(e) => { e.stopPropagation(); setProjectParentsFolded(parentConvIds, false); closeOverflow(); }}>
                        Expand all conversations
                      </button>
                    ) : (
                      <button type="button" className="dropdown-item" role="menuitem"
                        onClick={(e) => { e.stopPropagation(); setProjectParentsFolded(parentConvIds, true); closeOverflow(); }}>
                        Collapse all conversations
                      </button>
                    );
                  })()}
                  {!p.system && (
                    <button type="button" className="dropdown-item" role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditProject(p);
                        closeOverflow();
                      }}>Edit / Rename</button>
                  )}
                  {!p.system && onOpenProjectRules && (
                    <button type="button" className="dropdown-item" role="menuitem"
                      onClick={(e) => { e.stopPropagation(); onOpenProjectRules(p); closeOverflow(); }}>Rules…</button>
                  )}
                  {!isPinnedFolder && !isGrokBotProject(p) && (
                    <button type="button" className="dropdown-item" role="menuitem"
                      onClick={(e) => { e.stopPropagation(); setShellAllowProject(p); closeOverflow(); }}>Shell allow-list</button>
                  )}
                  {onOpenGitPanelForProject && (
                    <button type="button" className="dropdown-item" role="menuitem"
                      onClick={(e) => { e.stopPropagation(); onOpenGitPanelForProject(p); closeOverflow(); }}>Git working tree…</button>
                  )}
                  {!p.system && (
                    <button type="button" className="dropdown-item" role="menuitem"
                      onClick={(e) => { e.stopPropagation(); setDeleteProjectData(p); closeOverflow(); }}>Delete project</button>
                  )}
                </ConvOverflowMenu>
              </div>
              {!isCollapsed && (
                <>
                  {filteredConvs.length > 0 && (
                    <div
                      ref={(el) => { convListRefs.current[p.id] = el; }}
                      className="conversation-list"
                    >
                      {renderItems.map((item) => item.kind === 'group' ? (
                        <div
                          key={`pinned-group:${item.projectId}`}
                          className="pinned-group"
                          role="button"
                          tabIndex={0}
                          aria-expanded={!item.collapsed}
                          onClick={() => togglePinnedGroup(item.projectId)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              togglePinnedGroup(item.projectId);
                            }
                          }}
                          title={item.collapsed ? `Show ${item.count} pinned in ${item.projectName}` : `Hide ${item.count} pinned in ${item.projectName}`}
                        >
                          <span className={`pinned-group-chevron${item.collapsed ? ' pinned-group-chevron--collapsed' : ''}`} aria-hidden>▾</span>
                          <span className="pinned-group-name">{item.projectName}</span>
                          <span className="pinned-group-count">{item.count}</span>
                        </div>
                      ) : (() => {
                        const { c, depth } = item;
                        const kids = childrenByParent.get(c.id);
                        const hasKids = !!(kids && kids.length > 0);
                        const folded = isParentFolded(c.id);
                        const dot = getDot(c);
                        const isUnread = unreadConversationIds.includes(c.id) || c.lastStatus === 'done' || manuallyMarkedUnread.has(c.id);
                        const isAncestorContext = Boolean(statusFilter && statusFilter.size > 0 && !statusFilter.has(bucketOf(c)));

                        return (
                          <SidebarConversationRow
                            key={c.id}
                            c={c}
                            depth={depth}
                            selected={selectedConversationId === c.id}
                            selecting={selecting}
                            checked={selectedIds.has(c.id)}
                            hasKids={hasKids}
                            kidsCount={kids?.length ?? 0}
                            folded={folded}
                            dot={dot}
                            isAncestorContext={isAncestorContext}
                            projectLabel={item.projectLabel}
                            titleTooltip={contentHitsRef.current.get(c.id)?.snippet}
                            activeTag={activeTag}
                            overflowPos={overflow}
                            project={projectFor(c)}
                            isUnread={isUnread}
                            onToggleFold={toggleParentFold}
                            onToggleSelect={toggleSelect}
                            onSelectConversation={selectConversationRow}
                            onToggleTag={(t) => setTagQuery((prev) => (prev === t ? '' : t))}
                            onToggleOverflow={toggleOverflow}
                            onCloseOverflow={closeOverflow}
                            onEnterSelect={enterSelectWith}
                            onRename={renameConv}
                            onOpenConversationRules={onOpenConversationRules}
                            onTogglePin={togglePinConv}
                            onToggleArchive={toggleArchiveConv}
                            onMarkRead={markConvRead}
                            onMarkUnread={markConvUnread}
                            onDuplicate={duplicateConv}
                            onSchedule={scheduleFromConversation}
                            onOpenGitPanel={onOpenGitPanel}
                            onDelete={deleteConv}
                          />
                        );
                      })())}
                      {hiddenCount > 0 && (
                        <ShowMoreButton
                          hiddenCount={hiddenCount}
                          total={pageLength}
                          onClick={(e) => { e.stopPropagation(); toggleConvListExpand(p.id, 1); }}
                        />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        };

        const renderHostView = () => {
          const hostGroups = groupProjectsByHost(orderedProjects, remoteHosts);
          const hasActiveFilter = !!(searchQuery || activeTag || (statusFilter && statusFilter.size > 0));
          const renderedPinned = pinnedConvs.length > 0 ? renderProjectGroup(pinnedPseudoProject()) : null;
          const renderedGroups = hostGroups.map((group) => {
            const hostSearchMatch = !!(group.host && searchQuery && remoteHostMatchesSearch(group.host, searchQuery));
            const groupConvs: Conversation[] = [];
            for (const p of group.projects) {
              const tree = scheduleTrees[p.id];
              const scheduleConvIds = scheduleConversationIds(tree);
              const list = visibleOnProjectsTab(conversations[p.id] ?? [], scheduleConvIds);
              for (const c of list) {
                if (!c.archived) groupConvs.push(c);
              }
            }
            const hostAgg = aggregateCounts(groupConvs, bucketOf);

            const renderedProjects = group.projects
              .map((p) => renderProjectGroup(p, { hideHostChip: true, hostSearchMatch }))
              .filter(Boolean);

            if (renderedProjects.length === 0) return null;

            const isHostCollapsed = hostCollapsed[group.key] === true;
            const hostState = group.state;
            const isRemote = group.key !== 'hub' && group.key !== 'unknown';

            return (
              <div
                key={group.key}
                className={`host-group${hostState === 'disconnected' ? ' host-group--disconnected' : ''}`}
              >
                <div
                  className="host-header"
                  role="button"
                  tabIndex={0}
                  aria-expanded={!isHostCollapsed}
                  onClick={() => toggleHostCollapse(group.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleHostCollapse(group.key);
                    }
                  }}
                >
                  <span
                    className={`host-group-chevron${isHostCollapsed ? ' host-group-chevron--collapsed' : ''}`}
                    aria-hidden
                  >
                    ▾
                  </span>
                  <span className="host-header-icon" aria-hidden>
                    {group.key === 'hub' ? <HubHostIcon /> : <RemoteHostIcon />}
                  </span>
                  <div
                    className="host-header-body"
                    title={group.host ? remoteHostSidebarTooltip(group.host) : undefined}
                  >
                    <span className="host-header-name">{group.label}</span>
                    {isRemote ? <RemoteHostHeaderMeta host={group.host} /> : null}
                  </div>
                  {isRemote && hostState && (
                    <span
                      className={`host-header-dot ${hostState}`}
                      title={`Remote host: ${hostState}`}
                    />
                  )}
                  <AggregateBadge counts={hostAgg} />
                </div>
                {!isHostCollapsed && renderedProjects}
              </div>
            );
          }).filter(Boolean);

          if (!renderedPinned && renderedGroups.length === 0 && hasActiveFilter) {
            return (
              <div className="sidebar-search-hint" style={{ padding: '16px 12px', textAlign: 'center' }}>
                {scopeProjectId ? 'No conversations in this project match the current filter' : 'No conversations match the current filter'}
              </div>
            );
          }

          return (
            <>
              {renderedPinned}
              {renderedGroups}
            </>
          );
        };

        const renderRecentView = () => {
          const filteredAllConvs = filterConversations(allProjectsTabConvs, {
            recentDays,
            now: Date.now(),
            selectedConversationId,
            showArchived,
            activeTag,
            searchQuery,
            contentSearch,
            contentHitIds,
            statusFilter,
            bucketOf,
            isPinnedFolder: false,
            scopeProjectId,
          });

          const rawRows = buildRecentRows(filteredAllConvs, {
            folded: (id) => (searchQuery || activeTag || (statusFilter && statusFilter.size > 0)) ? false : (foldedParents[id] ?? true),
            live: liveActivityAt ?? {},
          });

          const rows = applyHoverFreezeRecent(rawRows);

          const hasActiveFilter = !!(searchQuery || activeTag || (statusFilter && statusFilter.size > 0));
          if (rows.length === 0 && hasActiveFilter) {
            return (
              <div className="sidebar-search-hint" style={{ padding: '16px 12px', textAlign: 'center' }}>
                {scopeProjectId ? 'No conversations in this project match the current filter' : 'No conversations match the current filter'}
              </div>
            );
          }

          const pageLength = rows.length;
          const limitForPage = (page: number) => LIST_INITIAL_PAGE + (page - 1) * LIST_PAGE_STEP;
          const pageSize = hasActiveFilter
            ? pageLength
            : (() => {
                const cur = recentPage;
                const limit = limitForPage(cur);
                if (!selectedConversationId) return limit;
                const selIdx = rows.findIndex((r) => r.c.id === selectedConversationId);
                if (selIdx === -1 || selIdx < limit) return limit;
                const pagesNeeded = Math.ceil((selIdx + 1 - LIST_INITIAL_PAGE) / LIST_PAGE_STEP) + 1;
                return limitForPage(Math.max(cur, pagesNeeded));
              })();

          const renderRows = rows.slice(0, pageSize);
          const hiddenCount = Math.max(0, pageLength - renderRows.length);

          for (const r of renderRows) {
            visibleConvIdsRef.current.add(r.c.id);
          }

          const selectableIds = renderRows
            .filter((r) => r.c.kind !== 'schedule_home')
            .map((r) => r.c.id);
          const selectedHere = selectableIds.filter((id) => selectedIds.has(id)).length;
          const selectCheckState = selectedHere === 0
            ? 'off'
            : selectedHere === selectableIds.length ? 'on' : 'mixed';

          const childrenByParent = new Map<string, Conversation[]>();
          for (const c of filteredAllConvs) {
            if (c.parentConversationId) {
              const arr = childrenByParent.get(c.parentConversationId) ?? [];
              arr.push(c);
              childrenByParent.set(c.parentConversationId, arr);
            }
          }

          return (
            <div className="conversation-list conversation-list--recent">
              {selecting && (
                <div className="recent-select-bar" style={{ padding: '4px 8px' }}>
                  <button
                    type="button"
                    className="project-select-all"
                    onClick={(e) => { e.stopPropagation(); toggleSelectAllForProject(selectableIds); }}
                    disabled={selectableIds.length === 0}
                    aria-pressed={selectCheckState === 'on'}
                  >
                    {selectCheckState === 'on' ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
              )}
              {renderRows.map((r) => {
                const { c, depth } = r;
                const kids = childrenByParent.get(c.id) ?? [];
                const hasKids = kids.length > 0;
                const folded = (searchQuery || activeTag || (statusFilter && statusFilter.size > 0)) ? false : (foldedParents[c.id] ?? true);
                const dot = getDot(c);
                const isUnread = unreadConversationIds.includes(c.id) || c.lastStatus === 'done' || manuallyMarkedUnread.has(c.id);
                const isAncestorContext = Boolean(statusFilter && statusFilter.size > 0 && !statusFilter.has(bucketOf(c)));

                const proj = projectFor(c);
                const host = proj.remoteHostId ? remoteHosts.find((h) => h.id === proj.remoteHostId) : undefined;
                const act = activityAt(c, liveActivityAt ?? {});
                const timeStr = act > 0 ? formatRelativeTime(act) : '';

                const meta = timeStr ? (
                  <span
                    className="conversation-time"
                    style={{
                      marginLeft: 'auto',
                      fontSize: '10px',
                      color: 'var(--text-3)',
                      fontFamily: 'var(--mono)',
                      fontVariantNumeric: 'tabular-nums',
                      flexShrink: 0,
                      opacity: 0.8,
                    }}
                    title={new Date(act).toLocaleString()}
                  >
                    {timeStr}
                  </span>
                ) : null;

                return (
                  <SidebarConversationRow
                    key={c.id}
                    c={c}
                    depth={depth}
                    selected={selectedConversationId === c.id}
                    selecting={selecting}
                    checked={selectedIds.has(c.id)}
                    hasKids={hasKids}
                    kidsCount={kids.length}
                    folded={folded}
                    dot={dot}
                    isAncestorContext={isAncestorContext}
                    projectLabel={host ? `${proj.name} · ${host.name}` : proj.name}
                    meta={meta}
                    titleTooltip={contentHitsRef.current.get(c.id)?.snippet}
                    activeTag={activeTag}
                    overflowPos={overflow}
                    project={proj}
                    isUnread={isUnread}
                    onToggleFold={toggleParentFold}
                    onToggleSelect={toggleSelect}
                    onSelectConversation={selectConversationRow}
                    onToggleTag={(t) => setTagQuery((prev) => (prev === t ? '' : t))}
                    onToggleOverflow={toggleOverflow}
                    onCloseOverflow={closeOverflow}
                    onEnterSelect={enterSelectWith}
                    onRename={renameConv}
                    onOpenConversationRules={onOpenConversationRules}
                    onTogglePin={togglePinConv}
                    onToggleArchive={toggleArchiveConv}
                    onMarkRead={markConvRead}
                    onMarkUnread={markConvUnread}
                    onDuplicate={duplicateConv}
                    onSchedule={scheduleFromConversation}
                    onOpenGitPanel={onOpenGitPanel}
                    onDelete={deleteConv}
                  />
                );
              })}
              {hiddenCount > 0 && (
                <ShowMoreButton
                  hiddenCount={hiddenCount}
                  total={pageLength}
                  onClick={(e) => { e.stopPropagation(); setRecentPage((p) => p + 1); }}
                />
              )}
            </div>
          );
        };

        const STATUS_BUCKET_LABELS: Record<StatusBucket, string> = {
          waiting: 'Waiting on you',
          error: 'Errored',
          running: 'Running',
          subagents: 'Subagents active',
          unread: 'Unread',
          idle: 'Idle',
        };

        const renderStatusView = () => {
          if (showArchived) {
            return (
              <>
                <div className="sidebar-search-hint" style={{ padding: '8px 12px' }}>
                  Status view is not applicable to archived conversations. Showing recent order.
                </div>
                {renderRecentView()}
              </>
            );
          }

          const filteredAllConvs = filterConversations(allProjectsTabConvs, {
            recentDays,
            now: Date.now(),
            selectedConversationId,
            showArchived: false,
            activeTag,
            searchQuery,
            contentSearch,
            contentHitIds,
            statusFilter,
            bucketOf,
            isPinnedFolder: false,
            scopeProjectId,
          });

          const buckets = buildStatusBuckets(filteredAllConvs, {
            bucketOf,
            live: liveActivityAt ?? {},
            sticky: stickySelectionRef.current,
            parentTitle,
            projectName,
          });

          const hasActiveFilter = !!(searchQuery || activeTag || (statusFilter && statusFilter.size > 0));

          if (buckets.length === 0 && hasActiveFilter) {
            return (
              <div className="sidebar-search-hint" style={{ padding: '16px 12px', textAlign: 'center' }}>
                {scopeProjectId ? 'No conversations in this project match the current filter' : 'No conversations match the current filter'}
              </div>
            );
          }

          return (
            <>
              {buckets.map(({ bucket, rows: rawRows }) => {
                const rows = applyHoverFreezeStatus(bucket, rawRows);
                const isBucketCollapsed = hasActiveFilter ? false : (statusCollapsed[bucket] === true);
                const limitForPage = (page: number) => LIST_INITIAL_PAGE + (page - 1) * LIST_PAGE_STEP;
                const pageLength = rows.length;

                const isIdle = bucket === 'idle';
                const pageSize = (!isIdle || hasActiveFilter)
                  ? pageLength
                  : (() => {
                      const cur = statusIdlePage;
                      const limit = limitForPage(cur);
                      if (!selectedConversationId) return limit;
                      const selIdx = rows.findIndex((r) => r.c.id === selectedConversationId);
                      if (selIdx === -1 || selIdx < limit) return limit;
                      const pagesNeeded = Math.ceil((selIdx + 1 - LIST_INITIAL_PAGE) / LIST_PAGE_STEP) + 1;
                      return limitForPage(Math.max(cur, pagesNeeded));
                    })();

                const renderRows = rows.slice(0, pageSize);
                const hiddenCount = Math.max(0, pageLength - renderRows.length);

                if (!isBucketCollapsed) {
                  for (const r of renderRows) {
                    visibleConvIdsRef.current.add(r.c.id);
                  }
                }

                const selectableIds = renderRows
                  .filter((r) => r.c.kind !== 'schedule_home')
                  .map((r) => r.c.id);
                const selectedHere = selectableIds.filter((id) => selectedIds.has(id)).length;
                const bucketCheckState = selectedHere === 0
                  ? 'off'
                  : selectedHere === selectableIds.length ? 'on' : 'mixed';

                return (
                  <div key={bucket} className="status-bucket-group">
                    <div
                      className="status-bucket-header"
                      role="button"
                      tabIndex={0}
                      aria-expanded={!isBucketCollapsed}
                      onClick={() => toggleStatusCollapse(bucket)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleStatusCollapse(bucket);
                        }
                      }}
                    >
                      <span
                        className={`status-bucket-chevron${isBucketCollapsed ? ' status-bucket-chevron--collapsed' : ''}`}
                        aria-hidden
                      >
                        ▾
                      </span>
                      <span className="status-bucket-title">{STATUS_BUCKET_LABELS[bucket]}</span>
                      <span className="status-bucket-count">({pageLength})</span>
                      {selecting && !isBucketCollapsed && (
                        <button
                          type="button"
                          className="project-select-all"
                          style={{ marginLeft: 'auto' }}
                          onClick={(e) => { e.stopPropagation(); toggleSelectAllForProject(selectableIds); }}
                          disabled={selectableIds.length === 0}
                          aria-pressed={bucketCheckState === 'on'}
                        >
                          {bucketCheckState === 'on' ? 'None' : 'All'}
                        </button>
                      )}
                    </div>
                    {!isBucketCollapsed && (
                      <div className="conversation-list">
                        {renderRows.map((r) => {
                          const { c, depth, breadcrumb } = r;
                          const dot = getDot(c);
                          const isUnread = unreadConversationIds.includes(c.id) || c.lastStatus === 'done' || manuallyMarkedUnread.has(c.id);

                          const proj = projectFor(c);
                          const host = proj.remoteHostId ? remoteHosts.find((h) => h.id === proj.remoteHostId) : undefined;
                          const act = activityAt(c, liveActivityAt ?? {});
                          const timeStr = act > 0 ? formatRelativeTime(act) : '';

                          const meta = timeStr ? (
                            <span
                              className="conversation-time"
                              style={{
                                marginLeft: 'auto',
                                fontSize: '10px',
                                color: 'var(--text-3)',
                                fontFamily: 'var(--mono)',
                                fontVariantNumeric: 'tabular-nums',
                                flexShrink: 0,
                                opacity: 0.8,
                              }}
                              title={new Date(act).toLocaleString()}
                            >
                              {timeStr}
                            </span>
                          ) : null;

                          return (
                            <SidebarConversationRow
                              key={c.id}
                              c={c}
                              depth={depth}
                              selected={selectedConversationId === c.id}
                              selecting={selecting}
                              checked={selectedIds.has(c.id)}
                              hasKids={false}
                              folded={false}
                              dot={dot}
                              isAncestorContext={false}
                              breadcrumb={breadcrumb}
                              meta={meta}
                              titleTooltip={contentHitsRef.current.get(c.id)?.snippet}
                              activeTag={activeTag}
                              overflowPos={overflow}
                              project={proj}
                              isUnread={isUnread}
                              onToggleFold={toggleParentFold}
                              onToggleSelect={toggleSelect}
                              onSelectConversation={selectConversationRow}
                              onToggleTag={(t) => setTagQuery((prev) => (prev === t ? '' : t))}
                              onToggleOverflow={toggleOverflow}
                              onCloseOverflow={closeOverflow}
                              onEnterSelect={enterSelectWith}
                              onRename={renameConv}
                              onOpenConversationRules={onOpenConversationRules}
                              onTogglePin={togglePinConv}
                              onToggleArchive={toggleArchiveConv}
                              onMarkRead={markConvRead}
                              onMarkUnread={markConvUnread}
                              onDuplicate={duplicateConv}
                              onSchedule={scheduleFromConversation}
                              onOpenGitPanel={onOpenGitPanel}
                              onDelete={deleteConv}
                            />
                          );
                        })}
                        {isIdle && hiddenCount > 0 && (
                          <ShowMoreButton
                            hiddenCount={hiddenCount}
                            total={pageLength}
                            onClick={(e) => { e.stopPropagation(); setStatusIdlePage((p) => p + 1); }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          );
        };

        return (
          <div
            ref={projectsListRef}
            className="project-list"
            style={{ display: sidebarMainTab === 'projects' ? undefined : 'none' }}
            onMouseEnter={() => {
              isHoveringListRef.current = true;
            }}
            onMouseLeave={() => {
              isHoveringListRef.current = false;
              if (frozenRecentOrderRef.current || frozenStatusOrderRef.current) {
                frozenRecentOrderRef.current = null;
                frozenStatusOrderRef.current = null;
                setHoverFreezeVersion((v) => v + 1);
              }
            }}
            onScroll={(e) => {
              const st = e.currentTarget.scrollTop;
              projectsScrollTopRef.current = st;
              try { sessionStorage.setItem('sidebarProjectsScrollTop', String(st)); } catch { /* ignore */ }
            }}
          >
            {groupBy === 'project' && (() => {
              const rendered = projectsWithPinned.map((p) => renderProjectGroup(p)).filter(Boolean);
              if (rendered.length === 0 && (searchQuery || activeTag || (statusFilter && statusFilter.size > 0))) {
                return (
                  <div className="sidebar-search-hint" style={{ padding: '16px 12px', textAlign: 'center' }}>
                    {scopeProjectId ? 'No conversations in this project match the current filter' : 'No conversations match the current filter'}
                  </div>
                );
              }
              return rendered;
            })()}
            {groupBy === 'host' && renderHostView()}
            {groupBy === 'recent' && renderRecentView()}
            {groupBy === 'status' && renderStatusView()}
          </div>
        );
      })()}

      <div
        ref={schedulesListRef}
        className="project-list schedules-tab-list"
        style={{ display: sidebarMainTab === 'schedules' ? undefined : 'none' }}
        onScroll={(e) => {
          const st = e.currentTarget.scrollTop;
          schedulesScrollTopRef.current = st;
          try { sessionStorage.setItem('sidebarSchedulesScrollTop', String(st)); } catch { /* ignore */ }
        }}
      >
        {scheduleProjects.length === 0 && (
            <div className="schedules-empty">
              <p>No schedules yet.</p>
              <button
                type="button"
                className="btn-add-conversation"
                onClick={() => openCreateSchedule()}
                disabled={projects.length === 0}
              >
                {projects.length === 0 ? 'Create a project first' : 'New schedule'}
              </button>
            </div>
          )}
          {(() => {
          const renderScheduleProject = (p: Project) => {
            const tree = scheduleTrees[p.id];
            const matchingJobs = (tree?.jobs ?? []).filter((entry) => showArchived ? entry.job.archived : !entry.job.archived);
            const recentTree = filterScheduleTreeByRecent({ jobs: matchingJobs }, recentDays, selectedConversationId, scheduleKeepIds);
            const scheduleJobs: ScheduleTreeJobEntry[] = recentTree.jobs;
            const scheduleSearch = searchQuery.toLowerCase();
            const runHasContentHit = (r: ScheduleTreeRunEntry) =>
              contentSearch && (
                (r.conversation?.id != null && contentHitIds.has(r.conversation.id))
                || r.descendants.some((d) => contentHitIds.has(d.id))
              );
            const runHasTag = (r: ScheduleTreeRunEntry) =>
              matchesTagQuery(r.conversation ?? {}, activeTag)
              || r.descendants.some((d) => matchesTagQuery(d, activeTag));
            let filteredScheduleJobs = scheduleJobs;
            // FW-15 F4: tag filter on the Schedules tab so chips there are not
            // dead and the Projects-tab pill is not inert here (F5).
            if (activeTag) {
              filteredScheduleJobs = filteredScheduleJobs
                .map((entry) => ({
                  ...entry,
                  runs: entry.runs.filter(runHasTag),
                }))
                .filter((entry) => entry.runs.length > 0);
            }
            if (scheduleSearch) {
              filteredScheduleJobs = filteredScheduleJobs.filter((entry) => {
                  if (entry.job.name.toLowerCase().includes(scheduleSearch)) return true;
                  if (p.name.toLowerCase().includes(scheduleSearch)) return true;
                  return entry.runs.some((r) => {
                    if (runHasContentHit(r)) return true;
                    if (activeTag && runHasTag(r)) return true;
                    const title = formatRunTitle(r.run, r.conversation, entry.job.timezone);
                    if (title.toLowerCase().includes(scheduleSearch)) return true;
                    if ((r.conversation?.description ?? '').toLowerCase().includes(scheduleSearch)) return true;
                    return r.descendants.some((d) =>
                      d.title.toLowerCase().includes(scheduleSearch)
                      || (d.description ?? '').toLowerCase().includes(scheduleSearch),
                    );
                  });
                });
            }
            const projectHasSelected = (selectedProjectId === p.id)
              || (selectedJobId != null && (tree?.jobs ?? []).some((j) => j.job.id === selectedJobId))
              || (selectedConversationId != null && (tree?.jobs ?? []).some((j) =>
                  j.runs.some((r) => r.conversation?.id === selectedConversationId || r.descendants.some((d) => d.id === selectedConversationId))
                 ));
            const isCollapsed = (searchQuery || activeTag) ? false : (collapsedProjects[p.id] === true);

            const selectConversationRow = (c: Conversation) => {
              const hitEventId = contentHitsRef.current.get(c.id)?.eventId;
              const q = searchQuery.trim();
              onSelectConversation(p, c, hitEventId, hitEventId && q ? { focusQuery: q } : undefined);
              clearUnread(c.id);
              if (manuallyMarkedUnread.has(c.id)) {
                setManuallyMarkedUnread((prev) => {
                  if (!prev.has(c.id)) return prev;
                  const next = new Set(prev);
                  next.delete(c.id);
                  return next;
                });
              }
            };

            const jobPage = scheduleJobListPageSizes[p.id] ?? 1;
            const jobPageSize = (scheduleSearch || activeTag)
              ? filteredScheduleJobs.length
              : (() => {
                  const cur = jobPage;
                  let limit = limitForListPage(cur);
                  if (selectedJobId) {
                    const selIdx = filteredScheduleJobs.findIndex((e) => e.job.id === selectedJobId);
                    if (selIdx !== -1 && selIdx >= limit) {
                      const pagesNeeded = Math.ceil((selIdx + 1 - LIST_INITIAL_PAGE) / LIST_PAGE_STEP) + 1;
                      limit = limitForListPage(Math.max(cur, pagesNeeded));
                    }
                  }
                  if (selectedConversationId) {
                    const selIdx = filteredScheduleJobs.findIndex((e) =>
                      e.runs.some((r) => r.conversation?.id === selectedConversationId || r.descendants.some((d) => d.id === selectedConversationId))
                    );
                    if (selIdx !== -1 && selIdx >= limit) {
                      const pagesNeeded = Math.ceil((selIdx + 1 - LIST_INITIAL_PAGE) / LIST_PAGE_STEP) + 1;
                      limit = limitForListPage(Math.max(cur, pagesNeeded));
                    }
                  }
                  return limit;
                })();
            const visibleScheduleJobs = filteredScheduleJobs.slice(0, jobPageSize);
            for (const { job } of visibleScheduleJobs) visibleScheduleJobIdsRef.current.add(job.id);
            const selectableScheduleIds = visibleScheduleJobs.map(({ job }) => job.id);
            const selectedHere = selectableScheduleIds.filter((id) => selectedIds.has(id)).length;
            const projectCheckState = selectedHere === 0
              ? 'off'
              : selectedHere === selectableScheduleIds.length ? 'on' : 'mixed';
            const hiddenJobCount = (scheduleSearch || activeTag) ? 0 : filteredScheduleJobs.length - visibleScheduleJobs.length;
            const treeRunLimit = scheduleTreeRunLimits[p.id] ?? LIST_INITIAL_PAGE;
            const scheduleProjectAggCounts = aggregateCounts(
              collectScheduleTreeConversations(matchingJobs),
              bucketOf,
            );

            return (
              <div key={p.id} className="project-group" data-expanded={isCollapsed ? 'false' : 'true'}>
                <div className="project-row">
                  {selecting && (
                    <button
                      type="button"
                      className="project-select-all"
                      onClick={(e) => { e.stopPropagation(); toggleSelectAllForProject(selectableScheduleIds); }}
                      disabled={selectableScheduleIds.length === 0}
                      title={projectCheckState === 'on' ? `Clear selection in ${p.name}` : `Select all in ${p.name}`}
                      aria-pressed={projectCheckState === 'on'}
                    >
                      {projectCheckState === 'on' ? 'None' : 'All'}
                    </button>
                  )}
                  <button
                    className={`project-item ${projectHasSelected ? 'active' : ''}`}
                    onClick={() => toggleProject(p.id)}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{
                        transition: 'transform 0.2s',
                        transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                        opacity: 0.5,
                        marginRight: '-2px',
                        flexShrink: 0,
                      }}
                    >
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                    {p.id === REMOTE_AGENTS_PROJECT_ID || p.name === 'Grok Bots' ? (
                      <>
                        <GrokBotIcon />
                        {grokBotState && (
                          <span
                            aria-hidden
                            title={grokBotState}
                            style={{
                              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                              background: statusDotColor(grokBotState),
                            }}
                          />
                        )}
                      </>
                    ) : (
                      <svg className="project-folder-icon" width="16" height="14" viewBox="0 0 16 14" fill="none" style={{ flexShrink: 0 }}>
                        <path d="M1.5 2C1.5 1.17157 2.17157 0.5 3 0.5H6L7.5 2.5H13C13.8284 2.5 14.5 3.17157 14.5 4V11.5C14.5 12.3284 13.8284 13 13 13H3C2.17157 13 1.5 12.3284 1.5 11.5V2Z" fill="var(--accent-dim)" fillOpacity="0.25" stroke="var(--accent)" strokeWidth="1.2" strokeLinejoin="round"/>
                      </svg>
                    )}
                    {p.name}
                    <HostChip project={p} hosts={remoteHosts} />
                    {p.system && <span className="project-system-badge">System</span>}
                    <AggregateBadge counts={scheduleProjectAggCounts} />
                  </button>
                  <ConvOverflowMenu convId={`schedule-project:${p.id}`} pos={overflow} onToggle={toggleOverflow} onClose={closeOverflow}>
                    <button type="button" className="dropdown-item" role="menuitem"
                      onClick={(e) => { e.stopPropagation(); openCreateSchedule(p); closeOverflow(); }}>New schedule in this project…</button>
                    {(() => {
                      const parentConvIds: string[] = [];
                      for (const entry of filteredScheduleJobs) {
                        for (const runEntry of entry.runs) {
                          if (runEntry.conversation && runEntry.descendants.length > 0) {
                            parentConvIds.push(runEntry.conversation.id);
                          }
                        }
                      }
                      if (parentConvIds.length === 0) return null;
                      const anyFolded = parentConvIds.some((id) => foldedParents[id] ?? true);
                      return anyFolded ? (
                        <button type="button" className="dropdown-item" role="menuitem"
                          onClick={(e) => { e.stopPropagation(); setProjectParentsFolded(parentConvIds, false); closeOverflow(); }}>
                          Expand all conversations
                        </button>
                      ) : (
                        <button type="button" className="dropdown-item" role="menuitem"
                          onClick={(e) => { e.stopPropagation(); setProjectParentsFolded(parentConvIds, true); closeOverflow(); }}>
                          Collapse all conversations
                        </button>
                      );
                    })()}
                    {/* Project management (rename, rules, shell allow-list, delete) lives on
                        the Projects tab — here the project is only a schedule grouping. */}
                  </ConvOverflowMenu>
                </div>
                {!isCollapsed && (
                  <div className="schedules-tree">
                    {visibleScheduleJobs.map((entry) => {
                      const job = entry.job;
                      const jobSelected = selectedJobId === job.id;
                      const isJobChecked = selectedIds.has(job.id);
                      // Jobs expanded by default (missing key → false = not folded).
                      const jobHasSelected = (selectedJobId === job.id)
                        || (selectedConversationId != null && entry.runs.some((r) =>
                            r.conversation?.id === selectedConversationId || r.descendants.some((d) => d.id === selectedConversationId)
                           ));
                      const jobFolded = (searchQuery || activeTag) ? false : (foldedScheduleJobs[job.id] ?? false);
                      const hasRuns = entry.runs.length > 0;
                      // Same attention counters the Projects tab badges onto
                      // project rows, aggregated over this job's run
                      // conversations + their spawn descendants.
                      const jobAggCounts = aggregateCounts(
                        collectScheduleTreeConversations([entry]),
                        bucketOf,
                      );
                      return (
                        <div key={job.id} className="schedule-job-group">
                          <div
                            className={`conversation-row schedule-job-row${jobSelected ? ' selected' : ''}${job.enabled ? '' : ' schedule-job-row--disabled'}${isJobChecked ? ' conversation-row--checked' : ''}`}
                            data-job-id={job.id}
                          >
                            <TouchHoldButton
                              type="button"
                              className={`conversation-item schedule-job-item${jobSelected ? ' active' : ''}`}
                              holdEnabled={hasRuns}
                              holdMs={1000}
                              onHold={() => toggleScheduleJobFold(job.id)}
                              onClick={() => {
                                if (selecting) {
                                  toggleSelect(job.id);
                                } else {
                                  onSelectJob?.(p, job.id);
                                }
                              }}
                              title={job.enabled ? job.name : `${job.name} (disabled)`}
                            >
                              <span className="conversation-item-line">
                              {(() => {
                                // Aggregate job-parent status from runs + live map + spawn descendants.
                                const jobDot = resolveJobAggregateDot({
                                  runs: entry.runs.map((r) => ({
                                    status: r.run.status,
                                    conversationId: r.run.conversationId ?? r.conversation?.id,
                                    liveStatus: r.conversation?.liveStatus,
                                  })),
                                  conversationStatuses,
                                  wsObservedConversationIds,
                                  isRunUnread: (conversationId, runStatus) => {
                                    // Runs without a conversation (e.g. deleted conversation):
                                    // do not keep parent job in error indefinitely.
                                    if (!conversationId) {
                                      return false;
                                    }
                                    const conv = entry.runs.find(
                                      (r) => (r.run.conversationId ?? r.conversation?.id) === conversationId,
                                    )?.conversation;
                                    // After the operator opens the run, unread + sticky lastStatus clear
                                    // so the job parent returns grey. Do not key only on runStatus or
                                    // historical failed runs keep the parent red forever.
                                    return unreadConversationIds.includes(conversationId)
                                      || conv?.lastStatus === 'done'
                                      || conv?.lastStatus === 'error';
                                  },
                                  isRunDescendantActive: (conversationId) => {
                                    if (!conversationId) return false;
                                    const runEntry = entry.runs.find(
                                      (r) => (r.run.conversationId ?? r.conversation?.id) === conversationId,
                                    );
                                    if (!runEntry) return false;
                                    const byParent = new Map<string, Conversation[]>();
                                    for (const d of runEntry.descendants) {
                                      const pid = d.parentConversationId ?? '';
                                      const arr = byParent.get(pid) ?? [];
                                      arr.push(d);
                                      byParent.set(pid, arr);
                                    }
                                    return hasActiveDescendant(conversationId, byParent, conversationStatuses, wsObservedConversationIds);
                                  },
                                  jobEnabled: job.enabled,
                                  isRunErrorRecovered: (conversationId) =>
                                    !!conversationId && errorRecoveredConversationIds.has(conversationId),
                                });
                                return (
                                  <span
                                    className={jobDot.dotClass}
                                    style={{ display: 'inline-block', flexShrink: 0 }}
                                    title={jobDot.title}
                                  />
                                );
                              })()}
                              {hasRuns && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  aria-expanded={!jobFolded}
                                  aria-label={jobFolded ? `Show ${entry.runs.length} runs` : 'Hide runs'}
                                  className={`fold-toggle${jobFolded ? ' fold-toggle--folded' : ''}`}
                                  title={jobFolded ? `Show ${entry.runs.length} run(s)` : 'Hide runs'}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleScheduleJobFold(job.id);
                                  }}
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      toggleScheduleJobFold(job.id);
                                    }
                                  }}
                                >
                                  <span className="fold-toggle-icon" aria-hidden>▾</span>
                                </span>
                              )}
                              <span className="schedule-job-icon" aria-hidden>⏱</span>
                              <span className="conversation-title-text">
                                {job.name}
                              </span>
                              {!job.enabled && (
                                <span className="schedule-job-badge" title="Disabled">off</span>
                              )}
                              <AggregateBadge counts={jobAggCounts} />
                              </span>
                            </TouchHoldButton>
                            <ConvOverflowMenu convId={job.id} pos={overflow} onToggle={toggleOverflow} onClose={closeOverflow}>
                              <button
                                type="button"
                                className="dropdown-item"
                                role="menuitem"
                                onClick={(e) => { e.stopPropagation(); enterSelectWith(job.id); closeOverflow(); }}
                              >
                                Select…
                              </button>
                              <button
                                type="button"
                                className="dropdown-item"
                                role="menuitem"
                                onClick={(e) => {
                                  if (job.archived) {
                                    void toggleArchiveScheduleJob(p, job, e);
                                  } else {
                                    openArchiveScheduleJob(p, job.id, job.name, e);
                                  }
                                  closeOverflow();
                                }}
                              >
                                {job.archived ? 'Unarchive' : 'Archive'}
                              </button>
                              <button
                                type="button"
                                className="dropdown-item"
                                role="menuitem"
                                title="Clear error states and delete failed/orphaned runs for this schedule"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  closeOverflow();
                                  try {
                                    const res = await api.clearScheduleErrors(p.id, job.id);
                                    await loadScheduleTree(p.id);
                                    showToast({ message: `Cleared errors (${res.deletedCount} run${res.deletedCount === 1 ? '' : 's'} removed)` }, 3000);
                                  } catch (err) {
                                    showAlert(`Clear errors failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
                                  }
                                }}
                              >
                                Clear errors
                              </button>
                              <button
                                type="button"
                                className="dropdown-item"
                                role="menuitem"
                                onClick={(e) => { openDeleteScheduleJob(p, job.id, job.name, e); closeOverflow(); }}
                              >
                                Delete
                              </button>
                            </ConvOverflowMenu>
                          </div>
                          {!jobFolded && (() => {
                            const runPage = scheduleRunListPageSizes[job.id] ?? 1;
                            const runPageSize = scheduleSearch
                              ? entry.runs.length
                              : (() => {
                                  const cur = runPage;
                                  let limit = limitForListPage(cur);
                                  if (selectedConversationId) {
                                    const selIdx = entry.runs.findIndex((r) =>
                                      r.conversation?.id === selectedConversationId
                                      || r.descendants.some((d) => d.id === selectedConversationId)
                                    );
                                    if (selIdx !== -1 && selIdx >= limit) {
                                      const pagesNeeded = Math.ceil((selIdx + 1 - LIST_INITIAL_PAGE) / LIST_PAGE_STEP) + 1;
                                      limit = limitForListPage(Math.max(cur, pagesNeeded));
                                    }
                                  }
                                  return limit;
                                })();
                            const visibleRuns = entry.runs.slice(0, runPageSize);
                            const hiddenInFetched = entry.runs.length - visibleRuns.length;
                            const atApiCap = entry.runs.length >= treeRunLimit;
                            const hiddenRunCount = scheduleSearch
                              ? 0
                              : (hiddenInFetched > 0 ? hiddenInFetched : (atApiCap ? LIST_PAGE_STEP : 0));
                            const showRunMore = !scheduleSearch && (hiddenInFetched > 0 || (atApiCap && visibleRuns.length === entry.runs.length));
                            return (
                              <>
                            {visibleRuns.map((runEntry) => {
                            const runConv = runEntry.conversation;
                            if (runConv) visibleScheduleConvIdsRef.current.add(runConv.id);
                            const runTitle = formatRunTitle(runEntry.run, runConv, job.timezone);
                            const runSelected = !!(runConv && selectedConversationId === runConv.id);
                            const runKids = runConv
                              ? orderRunDescendants(runEntry.descendants, runConv.id)
                              : [];
                            const scheduleChildrenByParent = new Map<string, Conversation[]>();
                            for (const d of runEntry.descendants) {
                              const pid = d.parentConversationId ?? '';
                              const arr = scheduleChildrenByParent.get(pid) ?? [];
                              arr.push(d);
                              scheduleChildrenByParent.set(pid, arr);
                            }
                            const runDescActive = runConv
                              ? hasActiveDescendant(runConv.id, scheduleChildrenByParent, conversationStatuses, wsObservedConversationIds)
                              : false;
                            const runHasSelectedDescendant = selectedConversationId != null && runKids.some(({ c: child }) => child.id === selectedConversationId);
                            const runFolded = runConv
                              ? ((searchQuery || activeTag) ? false : (foldedParents[runConv.id] ?? true))
                              : true;
                            const showKids = runConv && runKids.length > 0 && !runFolded;
                            const runLiveStatus = runConv
                              ? effectiveLiveStatus(runConv.id, conversationStatuses, runConv, wsObservedConversationIds)
                              : undefined;
                            const runLastStatus =
                              runConv?.lastStatus
                              ?? runFallbackStatus(runEntry.run, runConv);
                            const { dotClass: runDotClass, title: runDotTitle } = resolveConversationDot({
                              isSelected: runSelected,
                              selectedBadgeStatus: runSelected ? selectedBadgeStatus : undefined,
                              manuallyMarkedUnread: runConv ? manuallyMarkedUnread.has(runConv.id) : false,
                              liveStatus: runLiveStatus,
                              lastStatus: runLastStatus,
                              // Unviewed success → sky-blue unread (conversations; job parent stays green).
                              // Bare run.status === 'succeeded' would keep unread forever after open.
                              isUnread: runConv
                                ? (unreadConversationIds.includes(runConv.id) || runConv.lastStatus === 'done')
                                : runEntry.run.status === 'succeeded',
                              descendantActive: runDescActive,
                              errorRecovered: runConv
                                ? errorRecoveredConversationIds.has(runConv.id)
                                : false,
                            });
                            return (
                              <div key={runEntry.run.id}>
                                <div
                                  className={`conversation-row schedule-run-row${runSelected ? ' selected' : ''}${selecting && runConv && selectedIds.has(runConv.id) ? ' conversation-row--checked' : ''}`}
                                  style={{ paddingLeft: '1.25rem' }}
                                  data-conv-id={runConv?.id}
                                >
                                  <TouchHoldButton
                                    type="button"
                                    className={`conversation-item${runSelected ? ' active' : ''}`}
                                    disabled={!runConv}
                                    holdEnabled={!!(runConv && runKids.length > 0)}
                                    holdMs={1000}
                                    onHold={() => {
                                      if (runConv) toggleParentFold(runConv.id);
                                    }}
                                    title={runConv
                                      ? (contentHitsRef.current.get(runConv.id)?.snippet || (runConv.description ? `${runTitle}\n${runConv.description}` : runTitle))
                                      : `${runTitle} (no conversation yet)`}
                                    aria-pressed={selecting && runConv ? selectedIds.has(runConv.id) : undefined}
                                    aria-label={selecting && runConv
                                      ? (selectedIds.has(runConv.id) ? `Deselect ${runTitle}` : `Select ${runTitle}`)
                                      : undefined}
                                    onClick={() => {
                                      if (!runConv) return;
                                      // Same FW-18 contract as chat rows: in select
                                      // mode a click toggles instead of opening.
                                      if (selecting) { toggleSelect(runConv.id); return; }
                                      selectConversationRow(runConv);
                                    }}
                                    style={{ opacity: runConv ? 1 : 0.55 }}
                                  >
                                    <span className="conversation-item-line">
                                    <span
                                      className={runDotClass}
                                      style={{ display: 'inline-block', flexShrink: 0 }}
                                      title={runDotTitle}
                                    />
                                    {runConv && runKids.length > 0 && (
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        aria-expanded={!runFolded}
                                        aria-label={runFolded ? `Show ${runKids.length} spawn children` : 'Hide spawn children'}
                                        className={`fold-toggle${runFolded ? ' fold-toggle--folded' : ''}`}
                                        title={runFolded ? `Show ${runKids.length} spawn child(ren)` : 'Hide spawn children'}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleParentFold(runConv.id);
                                        }}
                                        onPointerDown={(e) => {
                                          e.stopPropagation();
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            toggleParentFold(runConv.id);
                                          }
                                        }}
                                      >
                                        <span className="fold-toggle-icon" aria-hidden>▾</span>
                                      </span>
                                    )}
                                    <span className="conversation-title-text">
                                      {runTitle}
                                    </span>
                                    <DesignationChip designation={runConv?.designation} />
                                    </span>
                                    {runConv?.description ? (
                                      <span className="conversation-desc">{runConv.description}</span>
                                    ) : null}
                                    <ConversationTagChips
                                      tags={runConv?.tags}
                                      activeTag={activeTag}
                                      onToggle={(t) => setTagQuery((prev) => (prev === t ? '' : t))}
                                    />
                                  </TouchHoldButton>
                                  {runConv ? (
                                    <ConvOverflowMenu convId={runConv.id} pos={overflow} onToggle={toggleOverflow} onClose={closeOverflow}>
                                      <button type="button" className="dropdown-item" role="menuitem"
                                        onClick={(e) => { e.stopPropagation(); enterSelectWith(runConv.id); closeOverflow(); }}>Select…</button>
                                      <button type="button" className="dropdown-item" role="menuitem"
                                        onClick={(e) => { renameConv(p, runConv, e); closeOverflow(); }}>Edit / Rename</button>
                                      {onOpenConversationRules && p.id !== REMOTE_AGENTS_PROJECT_ID && (
                                        <button type="button" className="dropdown-item" role="menuitem"
                                          onClick={(e) => { e.stopPropagation(); onOpenConversationRules(runConv, p); closeOverflow(); }}>Rules…</button>
                                      )}
                                      {unreadConversationIds.includes(runConv.id) || runConv.lastStatus === 'done' || manuallyMarkedUnread.has(runConv.id) ? (
                                        <button type="button" className="dropdown-item" role="menuitem"
                                          onClick={(e) => { void markConvRead(p, runConv, e); closeOverflow(); }}>Mark as read</button>
                                      ) : (
                                        <button type="button" className="dropdown-item" role="menuitem"
                                          onClick={(e) => { void markConvUnread(p, runConv, e); closeOverflow(); }}>Mark as unread</button>
                                      )}
                                      {onOpenGitPanel && (
                                        <button type="button" className="dropdown-item" role="menuitem"
                                          onClick={(e) => { e.stopPropagation(); onOpenGitPanel(runConv); closeOverflow(); }}>Git working tree…</button>
                                      )}
                                      <button type="button" className="dropdown-item" role="menuitem"
                                        title="Delete run conversation and spawn children"
                                        onClick={(e) => { openDeleteScheduleRunConv(p, runConv, e); closeOverflow(); }}>Delete</button>
                                    </ConvOverflowMenu>
                                  ) : (
                                    <ConvOverflowMenu convId={`run:${runEntry.run.id}`} pos={overflow} onToggle={toggleOverflow} onClose={closeOverflow}>
                                      <button
                                        type="button"
                                        className="dropdown-item"
                                        role="menuitem"
                                        title="Delete orphaned run record"
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          closeOverflow();
                                          try {
                                            await api.deleteScheduleRun(p.id, job.id, runEntry.run.id);
                                            await loadScheduleTree(p.id);
                                            showToast({ message: 'Deleted run' }, 3000);
                                          } catch (err) {
                                            showAlert(`Delete run failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
                                          }
                                        }}
                                      >
                                        Delete run
                                      </button>
                                    </ConvOverflowMenu>
                                  )}
                                </div>
                                {showKids && runKids.map(({ c: child, depth }) => {
                                  visibleScheduleConvIdsRef.current.add(child.id);
                                  const childSelected = selectedConversationId === child.id;
                                  const { dotClass, title: childDotTitle } = resolveConversationDot({
                                    isSelected: childSelected,
                                    selectedBadgeStatus: childSelected ? selectedBadgeStatus : undefined,
                                    manuallyMarkedUnread: manuallyMarkedUnread.has(child.id),
                                    liveStatus: effectiveLiveStatus(child.id, conversationStatuses, child, wsObservedConversationIds),
                                    lastStatus: child.lastStatus,
                                    isUnread: unreadConversationIds.includes(child.id) || child.lastStatus === 'done',
                                    errorRecovered: errorRecoveredConversationIds.has(child.id),
                                    descendantActive: hasActiveDescendant(child.id, scheduleChildrenByParent, conversationStatuses, wsObservedConversationIds),
                                  });
                                  return (
                                    <div
                                      key={child.id}
                                      data-conv-id={child.id}
                                      className={`conversation-row conversation-child schedule-spawn-row${childSelected ? ' selected' : ''}${selecting && selectedIds.has(child.id) ? ' conversation-row--checked' : ''}`}
                                      style={{ paddingLeft: `${(depth + 1) * 1.25}rem` }}
                                    >
                                      <TouchHoldButton
                                        type="button"
                                        className={`conversation-item${childSelected ? ' active' : ''}`}
                                        holdEnabled={false}
                                        aria-pressed={selecting ? selectedIds.has(child.id) : undefined}
                                        aria-label={selecting
                                          ? (selectedIds.has(child.id) ? `Deselect ${child.title}` : `Select ${child.title}`)
                                          : undefined}
                                        onClick={() => {
                                          if (selecting) { toggleSelect(child.id); return; }
                                          selectConversationRow(child);
                                        }}
                                        title={contentHitsRef.current.get(child.id)?.snippet || (child.description ? `${child.title}\n${child.description}` : child.title)}
                                      >
                                        <span className="conversation-item-line">
                                        <span
                                          className={`${dotClass} subagent-diamond`}
                                          style={{ display: 'inline-block', flexShrink: 0 }}
                                          title={childDotTitle}
                                        />
                                        <span className="conversation-title-text">
                                          {child.title}
                                        </span>
                                        <DesignationChip designation={child.designation} />
                                        </span>
                                        {child.description ? (
                                          <span className="conversation-desc">{child.description}</span>
                                        ) : null}
                                        <ConversationTagChips
                                          tags={child.tags}
                                          activeTag={activeTag}
                                          onToggle={(t) => setTagQuery((prev) => (prev === t ? '' : t))}
                                        />
                                      </TouchHoldButton>
                                      <ConvOverflowMenu convId={child.id} pos={overflow} onToggle={toggleOverflow} onClose={closeOverflow}>
                                        <button type="button" className="dropdown-item" role="menuitem"
                                          onClick={(e) => { e.stopPropagation(); enterSelectWith(child.id); closeOverflow(); }}>Select…</button>
                                        <button type="button" className="dropdown-item" role="menuitem"
                                          onClick={(e) => { renameConv(p, child, e); closeOverflow(); }}>Edit / Rename</button>
                                        {onOpenConversationRules && p.id !== REMOTE_AGENTS_PROJECT_ID && (
                                          <button type="button" className="dropdown-item" role="menuitem"
                                            onClick={(e) => { e.stopPropagation(); onOpenConversationRules(child, p); closeOverflow(); }}>Rules…</button>
                                        )}
                                        {unreadConversationIds.includes(child.id) || child.lastStatus === 'done' || manuallyMarkedUnread.has(child.id) ? (
                                          <button type="button" className="dropdown-item" role="menuitem"
                                            onClick={(e) => { void markConvRead(p, child, e); closeOverflow(); }}>Mark as read</button>
                                        ) : (
                                          <button type="button" className="dropdown-item" role="menuitem"
                                            onClick={(e) => { void markConvUnread(p, child, e); closeOverflow(); }}>Mark as unread</button>
                                        )}
                                        {onOpenGitPanel && (
                                          <button type="button" className="dropdown-item" role="menuitem"
                                            onClick={(e) => { e.stopPropagation(); onOpenGitPanel(child); closeOverflow(); }}>Git working tree…</button>
                                        )}
                                        <button type="button" className="dropdown-item" role="menuitem"
                                          title="Delete spawn conversation and its children"
                                          onClick={(e) => { openDeleteScheduleRunConv(p, child, e); closeOverflow(); }}>Delete</button>
                                      </ConvOverflowMenu>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                              {showRunMore && (
                                <ShowMoreButton
                                  hiddenCount={hiddenRunCount}
                                  total={hiddenInFetched > 0 ? entry.runs.length : undefined}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const curPage = scheduleRunListPageSizes[job.id] ?? 1;
                                    const curVisibleLimit = limitForListPage(curPage);
                                    const remaining = entry.runs.length - curVisibleLimit;
                                    if (remaining > 0) {
                                      toggleScheduleRunListExpand(job.id, 1);
                                    } else if (entry.runs.length >= treeRunLimit) {
                                      await loadScheduleTree(p.id, treeRunLimit + LIST_PAGE_STEP);
                                      toggleScheduleRunListExpand(job.id, 1);
                                    }
                                  }}
                                />
                              )}
                              </>
                            );
                          })()}
                        </div>
                      );
                    })}
                    {hiddenJobCount > 0 && (
                      <ShowMoreButton
                        hiddenCount={hiddenJobCount}
                        total={filteredScheduleJobs.length}
                        onClick={(e) => { e.stopPropagation(); toggleScheduleJobListExpand(p.id, 1); }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          };
          if (!scheduleLayout.groups) return scheduleLayout.ordered.map(renderScheduleProject);
          return scheduleLayout.groups.map((group) => {
            const isRemote = group.key !== 'hub' && group.key !== 'unknown' && group.key !== 'remote-agents';
            const groupJobs = group.projects.flatMap((proj) =>
              (scheduleTrees[proj.id]?.jobs ?? []).filter((entry) =>
                showArchived ? entry.job.archived : !entry.job.archived,
              ),
            );
            const scheduleHostAgg = aggregateCounts(
              collectScheduleTreeConversations(groupJobs),
              bucketOf,
            );
            return (
              <div
                key={group.key}
                className={`host-group${group.state === 'disconnected' ? ' host-group--disconnected' : ''}`}
              >
                <div className="host-header" style={{ cursor: 'default' }}>
                  <span className="host-header-icon" aria-hidden>
                    {group.key === 'hub' ? <HubHostIcon /> : <RemoteHostIcon />}
                  </span>
                  <div
                    className="host-header-body"
                    title={group.host ? remoteHostSidebarTooltip(group.host) : undefined}
                  >
                    <span className="host-header-name">{group.label}</span>
                    {isRemote ? <RemoteHostHeaderMeta host={group.host} /> : null}
                  </div>
                  {isRemote && group.state && (
                    <span className={`host-header-dot ${group.state}`} title={`Remote host: ${group.state}`} />
                  )}
                  <AggregateBadge counts={scheduleHostAgg} />
                </div>
                {group.projects.map(renderScheduleProject)}
              </div>
            );
          });
          })()}
        </div>

      {showProjectModal && (
        <div className="modal-overlay">
          <form className="modal-content modal-content--roomy" onSubmit={submitProject}>
            <div className="modal-header">Create New Project</div>
            <div className="modal-body">
              <div className="modal-field">
                <label className="modal-label">Project Name</label>
                <input
                  type="text"
                  className="modal-input"
                  placeholder="e.g. My Website"
                  value={newProjectName}
                  onChange={(e) => {
                    projectNameAutoFilled.current = false;
                    setNewProjectName(e.target.value);
                  }}
                  required
                  autoFocus
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Runs on</label>
                <select
                  className="modal-input"
                  value={newProjectHostId}
                  onChange={(e) => setNewProjectHostId(e.target.value)}
                  aria-label="Runs on"
                >
                  <option value="">This server</option>
                  {remoteHosts.filter((h) => h.state === 'connected').map((h) => (
                    <option key={h.id} value={h.id}>{h.name}</option>
                  ))}
                </select>
              </div>
              <div className="modal-field">
                <label className="modal-label">Clone from URL (optional)</label>
                <input
                  type="text"
                  className="modal-input"
                  placeholder="https://host/repo.git or git@host:owner/repo.git"
                  value={newProjectCloneUrl}
                  onChange={(e) => {
                    const v = e.target.value;
                    setNewProjectCloneUrl(v);
                    if (projectNameAutoFilled.current) {
                      setNewProjectName(repoNameFromUrl(v));
                    }
                  }}
                  spellCheck={false}
                />
                {newProjectCloneUrl.trim() && !isCloneUrlAllowed(newProjectCloneUrl.trim()) && (
                  <div className="modal-field-error">Use https (no credentials), ssh://, or git@host:path</div>
                )}
                {!newProjectHostId && cloneMode && browseRoots?.canClone === false && (
                  <div className="modal-field-error">Local clone disabled (TIERWYN_PROJECT_ROOTS is empty)</div>
                )}
              </div>
              <div className="modal-field">
                <label className="modal-label">Absolute Path</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    className="modal-input"
                    placeholder={newProjectHostId
                      ? `Remote path on ${remoteHosts.find((h) => h.id === newProjectHostId)?.name ?? 'host'}`
                      : '/absolute/path/to/project'}
                    value={newProjectPath}
                    onChange={(e) => setNewProjectPath(e.target.value)}
                    required
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="modal-btn"
                    disabled={!browseRoots || browseRoots.roots.length === 0}
                    onClick={() => setShowFolderPicker(true)}
                  >
                    Browse…
                  </button>
                </div>
                {newProjectPath.trim() && !newProjectPath.trim().startsWith('/') && (
                  <div className="modal-field-error">Path must be absolute (start with /)</div>
                )}
                {pathHintPending && (
                  <div className="modal-help-text" aria-live="polite">Checking…</div>
                )}
                {!pathHintPending && pathHint && (
                  <div
                    className={pathHint.ok ? 'modal-field-hint' : 'modal-field-error'}
                    aria-live="polite"
                  >{pathHint.ok ? '✓ ' : '✗ '}{pathHint.text}</div>
                )}
              </div>
              <div className="modal-field modal-field-row" style={{ marginTop: 12 }}>
                <div>
                  <span className="modal-label">Trust repository configuration</span>
                  <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                    Allows agents to execute repo-level config (.claude/settings.json hooks, .mcp.json, .cursor/mcp.json, OpenCode plugins). Leave disabled for untrusted repositories. When disabled, Cursor is refused, and Claude Code ignores project CLAUDE.md, .mcp.json, and repo hooks.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={newProjectTrustRepo}
                  aria-label="Trust repository configuration"
                  className={`toggle-switch${newProjectTrustRepo ? ' on' : ''}`}
                  onClick={() => setNewProjectTrustRepo((v) => !v)}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
              <div className="modal-field" style={{ marginTop: 12 }}>
                <span className="modal-label">Agent sandbox</span>
                <SelectDropdown<string>
                  options={[
                    { value: '', label: projectSandboxInheritLabel(newProjectSandboxSettings?.global === true, newProjectSandboxSettings?.defaults.length ?? 0) },
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' },
                  ]}
                  value={newProjectSandbox ?? ''}
                  onChange={(v) => setNewProjectSandbox(v === '' ? null : (v as SandboxSetting))}
                  placement="bottom"
                />
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Runs agents in a bubblewrap sandbox (own CLI config, project dir and caches only). Conversations can override.
                  {onOpenSandboxSettings && (
                    <>
                      {' '}
                      <button type="button" className="sandbox-inline-link" onClick={() => { setShowProjectModal(false); onOpenSandboxSettings(); }}>
                        Open Sandbox settings
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="modal-field" style={{ marginTop: 12 }}>
                <label>Project custom paths</label>
                <SandboxPathList
                  paths={newProjectSandboxPaths}
                  onChange={setNewProjectSandboxPaths}
                  note="Merged with host-level custom paths for the host this project runs on."
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={() => setShowProjectModal(false)}>Cancel</button>
              <button
                type="submit"
                className="modal-btn primary"
                disabled={
                  creatingProject ||
                  !newProjectName.trim() ||
                  !newProjectPath.trim().startsWith('/') ||
                  (pathHint !== undefined && !pathHint.ok) ||
                  (cloneMode && !isCloneUrlAllowed(newProjectCloneUrl.trim())) ||
                  (!newProjectHostId && cloneMode && browseRoots?.canClone === false)
                }
              >{creatingProject ? (cloneMode ? 'Cloning…' : 'Creating…') : 'Create'}</button>
            </div>
          </form>
        </div>
      )}

      {showFolderPicker && browseRoots && browseRoots.roots.length > 0 && (
        <FolderPickerModal
          remoteHostId={newProjectHostId || undefined}
          roots={browseRoots.roots}
          homedir={browseRoots.homedir}
          initialPath={newProjectPath}
          onPick={(pickedPath) => {
            setNewProjectPath(pickedPath);
            if (projectNameAutoFilled.current && !newProjectName.trim()) {
              const base = pickedPath.split('/').filter(Boolean).pop();
              if (base) setNewProjectName(base);
            }
          }}
          onClose={() => setShowFolderPicker(false)}
        />
      )}

      {editProject && (
        <EditProjectModal
          project={editProject}
          onClose={() => setEditProject(null)}
          onSaved={(updated) => {
            setProjects((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
            void refreshProjects();
          }}
          onOpenSandboxSettings={onOpenSandboxSettings ? () => {
            setEditProject(null);
            onOpenSandboxSettings();
          } : undefined}
        />
      )}

      {createConvProject && (
        <div className="modal-overlay">
          <form className="modal-content modal-content--roomy" onSubmit={submitConversation}>
            <div className="modal-header">{creatingRemoteBot ? 'New Bot in Remote Agents' : `New Conversation in ${(createConvTargetProject ?? createConvProject).name}`}</div>
            <div className="modal-body">
              <div className="modal-field">
                <label className="modal-label">{creatingRemoteBot ? 'Bot name' : 'Conversation Title'}</label>
                <input
                  type="text"
                  className="modal-input"
                  placeholder={creatingRemoteBot ? 'e.g. Inbox' : 'e.g. Refactor API routes'}
                  value={newConvTitle}
                  onChange={(e) => setNewConvTitle(e.target.value)}
                  required
                  autoFocus
                  maxLength={creatingRemoteBot ? 120 : undefined}
                />
              </div>
              {!creatingRemoteBot && templates.length > 0 && (
                <div className="modal-field">
                  <label className="modal-label">Delegation template (optional)</label>
                  <div className="template-dropdown-row">
                    <SelectDropdown
                      options={[
                        { value: '', label: 'None (no autonomous delegation)' },
                        ...templates.map((t) => ({ value: t.name, label: t.name })),
                      ]}
                      value={newConvTemplate}
                      onChange={setNewConvTemplate}
                      placement="bottom"
                      searchable
                    />
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => setTemplatePreviewContext('new')}
                    >
                      View details
                    </button>
                  </div>
                </div>
              )}
              {!creatingRemoteBot && (<>
              <div className="modal-field">
                <label className="modal-label">Delegate workdir</label>
                <SelectDropdown
                  options={[
                    { value: '', label: 'Per-role (roster defaults)' },
                    { value: 'shared', label: 'Pinned shared' },
                    { value: 'worktree', label: 'Pinned worktree' },
                  ]}
                  value={newConvSpawnWorkdir}
                  onChange={(val) => setNewConvSpawnWorkdir(val as '' | Workdir)}
                  placement="bottom"
                />
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Pin overrides per-role defaults for every spawn from this conversation.
                </div>
              </div>
              <div className="modal-field">
                <label className="modal-label">Designation</label>
                <SelectDropdown
                  options={[
                    { value: '', label: 'None' },
                    ...[...new Set([...(designationCatalogue.length ? designationCatalogue : BUILTIN_DESIGNATIONS), newConvDesignation].filter(Boolean))].map((d) => ({
                      value: d, label: d,
                    })),
                  ]}
                  value={newConvDesignation}
                  onChange={setNewConvDesignation}
                  placement="bottom"
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Tags</label>
                {newConvTags.length > 0 && (
                  <div className="modal-tag-chips">
                    {newConvTags.map((t) => (
                      <span key={t} className="modal-tag-chip">
                        {t}
                        <button
                          type="button"
                          className="modal-tag-remove"
                          aria-label={`Remove tag ${t}`}
                          onClick={() => setNewConvTags((prev) => prev.filter((x) => x !== t))}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="modal-tag-input-wrap">
                  <input
                    type="text"
                    className="modal-input"
                    value={newConvTagDraft}
                    onChange={(e) => { setNewConvTagDraft(e.target.value); setNewConvTagSuggestOpen(true); setNewConvTagSuggestIdx(-1); }}
                    maxLength={MAX_TAG_LENGTH}
                    disabled={newConvTags.length >= MAX_TAGS}
                    placeholder={
                      newConvTags.length >= MAX_TAGS
                        ? `Tag limit reached (${MAX_TAGS})`
                        : (knownTags.length > 0 ? 'Type or pick a tag' : 'Add a tag, then press Enter')
                    }
                    autoComplete="off"
                    onFocus={() => setNewConvTagSuggestOpen(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' && newConvTagSuggestions.length > 0) {
                        e.preventDefault();
                        setNewConvTagSuggestOpen(true);
                        setNewConvTagSuggestIdx((i) => (i + 1) % newConvTagSuggestions.length);
                        return;
                      }
                      if (e.key === 'ArrowUp' && newConvTagSuggestions.length > 0) {
                        e.preventDefault();
                        setNewConvTagSuggestIdx((i) => (i <= 0 ? newConvTagSuggestions.length - 1 : i - 1));
                        return;
                      }
                      // Enter must not submit the form — pick a suggestion or commit the draft.
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (newConvTagSuggestIdx >= 0 && newConvTagSuggestions[newConvTagSuggestIdx]) {
                          commitNewConvTag(newConvTagSuggestions[newConvTagSuggestIdx]);
                        } else {
                          commitNewConvTag();
                        }
                        return;
                      }
                      if (e.key === 'Backspace' && !newConvTagDraft && newConvTags.length > 0) {
                        setNewConvTags((prev) => prev.slice(0, -1));
                      }
                    }}
                    onBlur={() => { window.setTimeout(() => { setNewConvTagSuggestOpen(false); if (newConvTagDraft.trim()) commitNewConvTag(); }, 120); }}
                  />
                  {newConvTagSuggestOpen && newConvTagSuggestions.length > 0 && newConvTags.length < MAX_TAGS && (
                    <ul className="tag-suggest tag-suggest--modal" role="listbox">
                      {newConvTagSuggestions.map((t, i) => (
                        <li
                          key={t}
                          role="option"
                          aria-selected={i === newConvTagSuggestIdx}
                          className={`tag-suggest-item${i === newConvTagSuggestIdx ? ' tag-suggest-item--active' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); commitNewConvTag(t); }}
                        >
                          {t}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Up to {MAX_TAGS} tags, {MAX_TAG_LENGTH} characters each.
                </div>
              </div>
              <div className="modal-field">
                <label className="modal-label">Capability profile</label>
                {(() => {
                  const defProfile = capabilityProfileOptions.find((p) => p.id === defaultCapabilityProfileId);
                  const defLabel = defProfile ? `Default (${defProfile.label})` : 'Default (All)';
                  const defDesc = defProfile
                    ? (defProfile.plugins === '*'
                        ? 'All plugins (*)' + (defProfile.usage ? ' · usage & telemetry' : '')
                        : (defProfile.plugins.length ? `plugins: ${defProfile.plugins.join(', ')}` : 'no plugins') + (defProfile.usage ? ' · usage & telemetry' : ' · no telemetry'))
                    : 'All plugins (*), usage & telemetry';
                  return (
                    <SelectDropdown
                      options={[
                        { value: '', label: defLabel, description: defDesc },
                        ...(capabilityProfileOptions.length ? capabilityProfileOptions : BUILTIN_CAPABILITY_PROFILES)
                          .filter((p) => p.id !== defaultCapabilityProfileId)
                          .map((p) => ({
                            value: p.id,
                            label: `${p.label} (${p.id})`,
                            description: p.plugins === '*'
                              ? 'All plugins (*)' + (p.usage ? ' · usage & telemetry' : '')
                              : (p.plugins.length ? `plugins: ${p.plugins.join(', ')}` : 'no plugins') + (p.usage ? ' · usage & telemetry' : ' · no telemetry'),
                          })),
                      ]}
                      value={newConvCapabilityProfile}
                      onChange={setNewConvCapabilityProfile}
                      placement="bottom"
                      searchable
                    />
                  );
                })()}
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Restricts plugin capabilities and usage telemetry for this conversation and its delegates.
                </div>
              </div>
              <div className="modal-field">
                <label className="modal-label">Project</label>
                <SelectDropdown
                  options={hostBadgedProjectOptions(
                    projects.filter((p) => p.id !== REMOTE_AGENTS_PROJECT_ID), remoteHosts)}
                  value={(createConvTargetProject ?? createConvProject).id}
                  onChange={(pid) => {
                    const target = projects.find((p) => p.id === pid);
                    if (target) setCreateConvTargetProject(target);
                  }}
                  placement="bottom"
                  searchable
                />
                <div className="modal-hint" style={{ opacity: 0.7, fontStyle: 'italic', marginTop: 4 }}>
                  Creates the conversation in the selected project, regardless of where Create was clicked.
                </div>
              </div>
              </>)}
            </div>
            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={() => setCreateConvProject(null)} disabled={createConvBusy}>Cancel</button>
              <button type="submit" className="modal-btn primary" disabled={createConvBusy || !newConvTitle.trim()}>
                {createConvBusy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {renameConvData && (
        <EditConversationModal
          conversation={renameConvData.conv}
          profileLabels={profileLabels}
          knownTags={knownTags}
          onClose={() => setRenameConvData(null)}
          onSaved={(updated) => {
            const projectId = renameConvData.project.id;
            // FW-10: a move changes which project array owns this row. Drop it
            // from the source list and reload the target; the rest of this
            // callback then reconciles the source as before. Local-only by
            // design — the conversation_updated frame does not re-parent any
            // sidebar (see plan D6), so the acting tab must do it itself.
            const movedToProjectId =
              updated.projectId !== projectId ? updated.projectId : null;
            if (movedToProjectId) {
              setConversations((prev) => {
                const list = prev[projectId];
                if (!list) return prev;
                return { ...prev, [projectId]: list.filter((c) => c.id !== updated.id) };
              });
              void loadConversations(movedToProjectId);
            }
            // Projects tab: list lives in `conversations`. Patch immediately so the
            // row title updates without waiting on a full reload.
            setConversations((prev) => {
              const list = prev[projectId];
              if (!list) return prev;
              const next = patchConversationInList(list, updated);
              if (!next || next === list) return prev;
              return { ...prev, [projectId]: next };
            });

            // Schedules tab: run/spawn titles come from `scheduleTrees`, NOT from
            // `conversations`. The previous fix only reloaded conversations, so
            // schedule run rows (and the chat header via selection) stayed stale
            // until a full page refresh — exactly the "Feature test" bug.
            setScheduleTrees((prev) => {
              const tree = prev[projectId];
              if (!tree) return prev;
              let changed = false;
              const jobs = tree.jobs.map((entry) => ({
                ...entry,
                runs: entry.runs.map((runEntry) => {
                  let conversation = runEntry.conversation;
                  if (conversation?.id === updated.id) {
                    conversation = { ...conversation, ...updated };
                    changed = true;
                  }
                  const descendants = runEntry.descendants.map((d) => {
                    if (d.id !== updated.id) return d;
                    changed = true;
                    return { ...d, ...updated };
                  });
                  return { ...runEntry, conversation, descendants };
                }),
              }));
              return changed ? { ...prev, [projectId]: { jobs } } : prev;
            });

            // Chat header title reads selection.conversation in App — patch in place
            // (do NOT route through onSelectConversation: that clears events +
            // refetches the transcript just to update the title).
            onConversationRenamed?.(updated);

            // Background reconcile with server (keeps other fields fresh).
            void loadConversations(projectId);
            void loadScheduleTree(projectId, scheduleTreeRunLimits[projectId] ?? LIST_INITIAL_PAGE);
          }}
        />
      )}

      {templatePreviewContext && templates.length > 0 && (
        <TemplatePreviewModal
          templates={templates}
          profileLabels={profileLabels}
          selectedTemplateName={newConvTemplate}
          onClose={() => setTemplatePreviewContext(null)}
        />
      )}

      {duplicateConvData && (
        <ConfirmDialog
          title="Duplicate conversation"
          busy={duplicateBusy}
          confirmLabel="Duplicate"
          body={(
            <>
              Duplicate <code>{duplicateConvData.conv.title}</code>?
              <br /><br />
              A new chat titled “Copy of {duplicateConvData.conv.title}” will appear in the sidebar.
            </>
          )}
          onCancel={() => setDuplicateConvData(null)}
          onConfirm={() => { void submitDuplicateConv(); }}
        />
      )}

      {alertDialog && (
        <ConfirmDialog
          title={alertDialog.title ?? 'Notice'}
          body={alertDialog.message}
          confirmLabel="OK"
          onConfirm={() => setAlertDialog(null)}
        />
      )}

      {deleteConvData && (
        <ConfirmDialog
          title="Delete conversation"
          danger
          confirmLabel="Delete"
          body={(
            <>
              Delete <code>{deleteConvData.conv.title}</code>?
              <br /><br />
              This also removes all spawn sub-conversations and TTS recordings under it.
            </>
          )}
          onCancel={() => setDeleteConvData(null)}
          onConfirm={() => { void submitDelete(); }}
        />
      )}

      {bulkDeleteCount !== null && (
        <ConfirmDialog
          title={bulkDeleteCount === 1 ? 'Delete conversation?' : 'Delete conversations?'}
          danger
          confirmLabel="Delete"
          body={(
            <>
              Delete {bulkDeleteCount} {bulkDeleteCount === 1 ? 'conversation' : 'conversations'}?
              <br /><br />
              This also removes all spawn sub-conversations and TTS recordings under {bulkDeleteCount === 1 ? 'it' : 'them'}.
            </>
          )}
          onCancel={() => setBulkDeleteCount(null)}
          onConfirm={startBulkDelete}
        />
      )}

      {bulkScheduleDeleteCount !== null && (() => {
        // Mixed selection (schedules + their run/spawn conversations) says so;
        // the delete flow itself is the same either way.
        const jobCount = selectedScheduleJobIds.length;
        const convCount = selectedScheduleConvIds.length;
        const mixed = convCount > 0;
        return (
          <ConfirmDialog
            title={mixed
              ? (bulkScheduleDeleteCount === 1 ? 'Delete item?' : `Delete ${bulkScheduleDeleteCount} items?`)
              : (bulkScheduleDeleteCount === 1 ? 'Delete schedule?' : 'Delete schedules?')}
            danger
            confirmLabel="Delete"
            body={(
              <>
                {mixed
                  ? `Delete ${jobCount} ${jobCount === 1 ? 'schedule' : 'schedules'} and ${convCount} ${convCount === 1 ? 'conversation' : 'conversations'}?`
                  : `Delete ${bulkScheduleDeleteCount} ${bulkScheduleDeleteCount === 1 ? 'schedule' : 'schedules'}?`}
                <br /><br />
                This also removes all run conversations, spawn sub-conversations, and recordings under {bulkScheduleDeleteCount === 1 ? 'it' : 'them'}.
              </>
            )}
            onCancel={() => setBulkScheduleDeleteCount(null)}
            onConfirm={startBulkScheduleDelete}
          />
        );
      })()}

      {archiveScheduleData && (
        <ConfirmDialog
          title="Archive schedule"
          busy={deleteBusy}
          confirmLabel="Archive"
          body={(
            <>
              Hide schedule <code>{archiveScheduleData.jobName}</code> from the list?
              <br /><br />
              The job and its run history stay in the database. This frees an agent-create cap slot. Permanent delete is the trash icon.
            </>
          )}
          onCancel={() => setArchiveScheduleData(null)}
          onConfirm={() => { void submitArchiveScheduleJob(); }}
        />
      )}

      {deleteScheduleData && (
        <ConfirmDialog
          title="Delete schedule"
          danger
          busy={deleteBusy}
          confirmLabel="Delete permanently"
          body={(
            <>
              Permanently delete schedule <code>{deleteScheduleData.jobName}</code>?
              <br /><br />
              Removes the job, all run conversations and spawn children, and TTS recordings. This cannot be undone.
            </>
          )}
          onCancel={() => setDeleteScheduleData(null)}
          onConfirm={() => { void submitDeleteScheduleJob(); }}
        />
      )}

      {deleteScheduleRunData && (
        <ConfirmDialog
          title="Delete run conversation"
          danger
          busy={deleteBusy}
          confirmLabel="Delete"
          body={(
            <>
              Delete <code>{deleteScheduleRunData.conv.title}</code> and all of its spawn sub-conversations?
              <br /><br />
              TTS recordings for those chats are removed too.
            </>
          )}
          onCancel={() => setDeleteScheduleRunData(null)}
          onConfirm={() => { void submitDeleteScheduleRunConv(); }}
        />
      )}

      {deleteProjectData && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">Delete Project</div>
            <div className="modal-body">
              <p>Delete project <code>{deleteProjectData.name}</code>?</p>
              <p className="modal-help-text">
                All conversations and schedules under it will be deleted. The folder on disk (<code>{deleteProjectData.rootPath}</code>) is NOT touched.
              </p>
              {(() => {
                const note = projectScheduleDeleteNote(scheduleTrees[deleteProjectData.id]?.jobs);
                return note ? <p className="modal-help-text"><strong>{note}</strong></p> : null;
              })()}
            </div>
            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={() => setDeleteProjectData(null)}>Cancel</button>
              <button type="button" className="modal-btn danger" onClick={submitDeleteProject}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {bulkMoveOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              Move {selectedIds.size} {selectedIds.size === 1 ? 'conversation' : 'conversations'} to…
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {projects.map((proj) => {
                // "Source dimmed": only when EVERY selected row already lives
                // there. A cross-project selection dims nothing — that is the point.
                const isOnlySource = selectedConvs.length > 0
                  && selectedConvs.every((c) => c.projectId === proj.id);
                return (
                  <button
                    key={proj.id}
                    type="button"
                    className="modal-btn"
                    style={{ textAlign: 'left', opacity: isOnlySource ? 0.45 : 1 }}
                    disabled={isOnlySource || bulkBusy}
                    onClick={() => {
                      void runBulk('move', { projectId: proj.id, toastVerb: 'Moved', destName: proj.name });
                    }}
                  >
                    {proj.name}
                  </button>
                );
              })}
            </div>
            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={() => setBulkMoveOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {shellAllowProject && (
        <ShellAllowModal
          project={shellAllowProject}
          onClose={() => setShellAllowProject(null)}
        />
      )}

      {createScheduleOpen && (
        <div className="modal-overlay">
          <form className="modal-content" onSubmit={submitCreateSchedule}>
            <div className="modal-header">New Schedule</div>
            <div className="modal-body">
              <div className="modal-field">
                <label className="modal-label">Project</label>
                <SelectDropdown
                  options={
                    projects.length === 0
                      ? [{ value: '', label: 'No projects — create one first' }]
                      : hostBadgedProjectOptions(projects, remoteHosts)
                  }
                  value={newScheduleProjectId}
                  onChange={(pid) => {
                    setNewScheduleProjectId(pid);
                    // Bound chat must stay in the selected project.
                    if (resumeScheduleMode) setNewScheduleBoundConversationId('');
                  }}
                  placement="bottom"
                  searchable
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">Mode</label>
                <div
                  role="radiogroup"
                  aria-label="Schedule execution mode"
                  style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}
                >
                  <label
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      cursor: forcedScheduleMode ? 'not-allowed' : 'pointer',
                      opacity: forcedScheduleMode ? 0.55 : 1,
                    }}
                    title={forcedScheduleMode
                      ? "Grok Bots run in their own conversation — scheduling a new run each time would steal the Bot's reply lease."
                      : undefined}
                  >
                    <input
                      type="radio"
                      name="new-schedule-mode"
                      checked={newScheduleExecutionMode === 'spawn_child' && !forcedScheduleMode}
                      disabled={Boolean(forcedScheduleMode)}
                      title={forcedScheduleMode
                        ? "Grok Bots run in their own conversation — scheduling a new run each time would steal the Bot's reply lease."
                        : undefined}
                      onChange={() => {
                        if (forcedScheduleMode) return;
                        setNewScheduleExecutionMode('spawn_child');
                        setNewScheduleBoundConversationId('');
                        if (newScheduleProfileId === SCHEDULE_INHERIT_PROFILE_ID) {
                          setNewScheduleProfileId(offeredScheduleProfiles[0]?.id ?? '');
                        }
                        // Restore spawn_child blank-job stub when the box is empty.
                        setNewSchedulePrompt((prev) => (prev.trim() ? prev : BLANK_JOB_PROMPT));
                      }}
                    />
                    New run each time
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="new-schedule-mode"
                      checked={resumeScheduleMode}
                      onChange={() => {
                        setNewScheduleExecutionMode('resume_conversation');
                        setNewSchedulePackSlug('');
                        setNewScheduleGoal('');
                        setNewSchedulePackVars({});
                        setNewScheduleTemplate('');
                        setNewScheduleWorkdir('shared');
                        setNewScheduleProfileId(SCHEDULE_INHERIT_PROFILE_ID);
                        setNewSchedulePrompt((prev) => (prev === BLANK_JOB_PROMPT ? '' : prev));
                        if (newScheduleSourceConv?.projectId === newScheduleProjectId) {
                          setNewScheduleBoundConversationId(newScheduleSourceConv.id);
                        }
                      }}
                    />
                    Send to an existing conversation
                  </label>
                </div>
              </div>
              {resumeScheduleMode && (
                <div className="modal-field">
                  <label className="modal-label">Conversation</label>
                  <SelectDropdown
                    options={
                      resumeBoundOptions.length === 0
                        ? [{ value: '', label: 'No conversations in this project' }]
                        : resumeBoundOptions.map((c) => ({
                            value: c.id,
                            label: c.title?.trim() || c.id,
                          }))
                    }
                    value={newScheduleBoundConversationId}
                    onChange={setNewScheduleBoundConversationId}
                    placement="bottom"
                    searchable
                  />
                  <div className="modal-help-text">
                    Each fire prompts this chat in place. The conversation stays on the Projects tab.
                  </div>
                </div>
              )}
              {!resumeScheduleMode && !bareScheduleProfile && (
              <div className="modal-field">
                <label className="modal-label">Pack</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <SelectDropdown
                      options={[
                        { value: '', label: 'Blank job', description: 'Hand-assemble a schedule as today' },
                        ...schedulePacks
                          .filter((pack) => !hideShippedSchedulePacks || pack.origin === 'imported')
                          .map((pack) => ({
                            value: pack.slug,
                            label: pack.title,
                            description: pack.description,
                            badge: pack.origin === 'imported' ? 'custom' : 'built-in',
                          })),
                      ]}
                      value={newSchedulePackSlug}
                      onChange={(slug) => {
                        setPackIoMenuOpen(false);
                        applySchedulePack(slug);
                      }}
                      placement="bottom"
                      searchable
                    />
                  </div>
                  <div className="session-actions-dropdown-wrap pack-io-menu">
                    <button
                      ref={packIoTriggerRef}
                      type="button"
                      className={`modal-btn accent pack-io-trigger${packIoMenuOpen ? ' active' : ''}`}
                      aria-haspopup="menu"
                      aria-expanded={packIoMenuOpen}
                      disabled={createScheduleBusy}
                      title="Import or export schedule pack"
                      onClick={() => setPackIoMenuOpen((v) => !v)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      <span className="pack-io-chevron" aria-hidden>▾</span>
                    </button>
                    {packIoMenuOpen && packIoMenuPos && createPortal(
                      <>
                        <div
                          className="dropdown-backdrop"
                          style={{ zIndex: 1099 }}
                          onClick={() => setPackIoMenuOpen(false)}
                        />
                        <div
                          className="session-actions-dropdown pack-io-dropdown"
                          role="menu"
                          style={packIoMenuPos}
                        >
                          <button
                            type="button"
                            className="dropdown-item"
                            role="menuitem"
                            onClick={() => {
                              setPackIoMenuOpen(false);
                              setImportPackOpen(true);
                              setImportPackText('');
                              setImportPackPreview(null);
                              setImportPackError('');
                              setImportPackFileName('');
                              if (importPackFileInputRef.current) importPackFileInputRef.current.value = '';
                            }}
                          >
                            <span className="dropdown-icon" aria-hidden>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" y1="3" x2="12" y2="15" />
                              </svg>
                            </span>
                            Import…
                          </button>
                          <button
                            type="button"
                            className="dropdown-item"
                            role="menuitem"
                            disabled={!selectedSchedulePack}
                            title={selectedSchedulePack
                              ? 'Download this pack as an import-ready JSON document'
                              : 'Select a pack to export'}
                            onClick={() => {
                              if (!selectedSchedulePack) return;
                              setPackIoMenuOpen(false);
                              exportSelectedSchedulePack();
                            }}
                          >
                            <span className="dropdown-icon" aria-hidden>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                              </svg>
                            </span>
                            Export
                          </button>
                        </div>
                      </>,
                      document.body,
                    )}
                  </div>
                </div>
                {selectedSchedulePack?.origin === 'imported' && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <button
                      type="button"
                      className="modal-btn danger"
                      onClick={() => setConfirmDeletePack(selectedSchedulePack)}
                      disabled={createScheduleBusy}
                      title="Delete this custom pack (jobs created from it are not affected)"
                    >
                      Delete
                    </button>
                    <span className="modal-help-text">
                      Existing jobs keep running.
                    </span>
                  </div>
                )}
              </div>
              )}
              <div className="modal-field">
                <label className="modal-label">Name</label>
                <input
                  ref={newScheduleNameRef}
                  type="text"
                  className="modal-input"
                  placeholder="e.g. Nightly digest"
                  value={newScheduleName}
                  onChange={(e) => setNewScheduleName(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              {!bareScheduleProfile && selectedSchedulePack && (
                <div className="modal-field">
                  <label className="modal-label">Goal (optional)</label>
                  <textarea
                    className="modal-input"
                    rows={2}
                    value={newScheduleGoal}
                    onChange={(e) => setNewScheduleGoal(e.target.value)}
                    placeholder="One-line goal for this run — stored as pending context"
                  />
                </div>
              )}
              {!bareScheduleProfile && selectedSchedulePack?.applyFields?.map((field) => (
                <div className="modal-field" key={field.key}>
                  <label className="modal-label">{field.label}</label>
                  {field.type === 'profile' ? (
                    <ModelSelector
                      profiles={offeredScheduleProfiles}
                      profilesLoaded={profilesLoaded}
                      selectedProfileId={newSchedulePackVars[field.key] ?? ''}
                      onChange={(id) => setNewSchedulePackVars((prev) => ({ ...prev, [field.key]: id }))}
                      placement="bottom"
                      allowEmpty={offeredScheduleProfiles.length === 0}
                    />
                  ) : (
                    <SelectDropdown
                      options={
                        field.options && field.options.length > 0
                          ? field.options
                          : templates.length > 0
                            ? templates.map((t) => ({ value: t.name, label: t.name }))
                            : [{ value: '', label: 'No options' }]
                      }
                      value={newSchedulePackVars[field.key] ?? ''}
                      onChange={(val) => setNewSchedulePackVars((prev) => ({ ...prev, [field.key]: val }))}
                      placement="bottom"
                      searchable
                    />
                  )}
                  {field.help && <div className="modal-help-text">{field.help}</div>}
                </div>
              ))}
              <div className="modal-field">
                <label className="modal-label">Schedule type</label>
                <SelectDropdown
                  options={[
                    { value: 'interval', label: 'Interval' },
                    { value: 'cron', label: 'Cron' },
                    { value: 'once', label: 'Once' },
                  ]}
                  value={newScheduleKind}
                  onChange={(val) => setNewScheduleKind(val as ScheduleKind)}
                  placement="bottom"
                />
                {selectedSchedulePack && newScheduleKind === 'interval' && (
                  <div className="modal-help-text">
                    Interval pack jobs are created disabled. Enable them in the Schedule browser when ready.
                  </div>
                )}
              </div>
              {newScheduleKind === 'interval' ? (
                <div className="modal-field">
                  <label className="modal-label">Every</label>
                  <div className="settings-input-group">
                    <input
                      type="number"
                      className="modal-input timeout-input"
                      min={0.1}
                      step="any"
                      style={{ width: 96 }}
                      value={newScheduleEveryAmount}
                      onChange={(e) => setNewScheduleEveryAmount(e.target.value)}
                      required
                    />
                    <div className="timeout-unit-select">
                      <SelectDropdown
                        options={DURATION_UNIT_OPTIONS}
                        value={newScheduleEveryUnit}
                        onChange={(val) => setNewScheduleEveryUnit(val as DurationUnit)}
                        placement="bottom"
                      />
                    </div>
                  </div>
                </div>
              ) : newScheduleKind === 'once' ? (
                <div className="modal-field">
                  <label className="modal-label">Fire in</label>
                  <div className="settings-input-group">
                    <input
                      type="number"
                      className="modal-input timeout-input"
                      min={0.1}
                      step="any"
                      style={{ width: 96 }}
                      value={newScheduleFireInAmount}
                      onChange={(e) => setNewScheduleFireInAmount(e.target.value)}
                      required
                    />
                    <div className="timeout-unit-select">
                      <SelectDropdown
                        options={DURATION_UNIT_OPTIONS}
                        value={newScheduleFireInUnit}
                        onChange={(val) => setNewScheduleFireInUnit(val as DurationUnit)}
                        placement="bottom"
                      />
                    </div>
                  </div>
                  <div className="modal-help-text">Minimum 1 minute from now.</div>
                </div>
              ) : (
                <div className="modal-field">
                  <label className="modal-label">Cron expression</label>
                  <div className="cron-expr-row">
                    <input
                      type="text"
                      className="modal-input"
                      style={{ fontFamily: 'var(--mono)' }}
                      placeholder="0 9 * * *"
                      value={newScheduleCron}
                      onChange={(e) => setNewScheduleCron(e.target.value)}
                      required
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => setCronBuilderOpen(true)}
                      title="Open visual cron builder"
                    >
                      Design
                    </button>
                  </div>
                  {(() => {
                    const { text, valid } = describeCron(newScheduleCron);
                    return (
                      <div
                        className="modal-hint"
                        style={{
                          marginTop: 4,
                          color: valid ? undefined : 'var(--red)',
                        }}
                      >
                        {text}
                      </div>
                    );
                  })()}
                </div>
              )}
              <div className="modal-field">
                <label className="modal-label">Timezone</label>
                <TimezoneField
                  value={newScheduleTimezone}
                  onChange={setNewScheduleTimezone}
                  required
                />
              </div>
              {!resumeScheduleMode && !bareScheduleProfile && (templates.length > 0 || createRequiresTemplate) && (
                <div className="modal-field">
                  <label className="modal-label">
                    {createRequiresTemplate ? 'Roster / Delegation template' : 'Roster / Delegation template (optional)'}
                  </label>
                  <SelectDropdown
                    options={
                      createRequiresTemplate
                        ? (templates.length > 0
                          ? templates.map((t) => ({ value: t.name, label: t.name, badge: `${t.roles.length} roles` }))
                          : [{ value: '', label: 'No templates — add one in Settings' }])
                        : [
                            { value: '', label: 'None (no autonomous delegation)' },
                            ...templates.map((t) => ({ value: t.name, label: t.name, badge: `${t.roles.length} roles` })),
                          ]
                    }
                    value={newScheduleTemplate}
                    onChange={setNewScheduleTemplate}
                    placement="bottom"
                    searchable
                  />
                  <div className="modal-help-text">
                    Roster of available roles and models. Each tick inherits it so the agent can spawn delegates.
                  </div>
                </div>
              )}
              {scheduleProfileOffer.hostWarning && (
                <div className="modal-hint" style={{ marginBottom: 8 }}>
                  {scheduleProfileOffer.hostWarning}
                </div>
              )}
              {scheduleProjectIsRemoteAgents ? (
                <div className="modal-field">
                  <label className="modal-label">Bot</label>
                  <div className="modal-help-text" style={{ fontSize: 13, color: 'var(--text-1)' }}>
                    Bot:{' '}
                    {(resumeBoundOptions.find((c) => c.id === newScheduleBoundConversationId)?.title
                      ?? newScheduleSourceConv?.title
                      ?? '').trim()
                      || (newScheduleBoundConversationId
                        ? newScheduleBoundConversationId.slice(0, 8)
                        : 'select a conversation')}
                  </div>
                  <div className="modal-help-text">
                    The server pins the schedule to this conversation&apos;s Grok Bot. Profile is inherited.
                  </div>
                  {scheduleProfileOffer.grokBotWarning && (
                    <div className="modal-hint" style={{ marginTop: 6 }}>
                      {scheduleProfileOffer.grokBotWarning}
                    </div>
                  )}
                </div>
              ) : (
              <div className="modal-field">
                <label className="modal-label">Profile</label>
                <ModelSelector
                  profiles={createModalProfiles}
                  profilesLoaded={profilesLoaded}
                  selectedProfileId={newScheduleProfileId}
                  onChange={setNewScheduleProfileId}
                  placement="bottom"
                  allowEmpty={createModalProfiles.length === 0}
                  rosterProfileIds={bareScheduleProfile || resumeScheduleMode ? undefined : createRosterProfileIds}
                />
                {!resumeScheduleMode && !bareScheduleProfile && createRosterProfiles.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                      Roster models ({newScheduleTemplate}):
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {createRosterProfiles.map(({ role, profileId }) => (
                        <button
                          key={`${role}-${profileId}`}
                          type="button"
                          className={`schedule-roster-pill${newScheduleProfileId === profileId ? ' active' : ''}`}
                          onClick={() => setNewScheduleProfileId(profileId)}
                          title={`Set schedule profile to ${profileId} (${role})`}
                        >
                          <span style={{ fontWeight: 600 }}>{role}</span>
                          <span style={{ opacity: 0.7, fontFamily: 'var(--mono)', fontSize: 10 }}>{profileId}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {resumeScheduleMode && (
                  <div className="modal-help-text">
                    &quot;Conversation&apos;s last agent&quot; reuses whichever profile last ran in the bound chat.
                  </div>
                )}
                {!resumeScheduleMode && scheduleProfileOffer.hiddenForHost > 0 && (
                  <div className="modal-hint" style={{ marginTop: 6 }}>
                    {scheduleProfileOffer.hiddenForHost} agent(s) hidden — not installed on {scheduleProfileOffer.hostName}
                  </div>
                )}
                {scheduleProfileOffer.grokBotWarning && (
                  <div className="modal-hint" style={{ marginTop: 6 }}>
                    {scheduleProfileOffer.grokBotWarning}
                  </div>
                )}
              </div>
              )}
              {!resumeScheduleMode && !bareScheduleProfile && (
              <div className="modal-field">
                <label className="modal-label">Tick workdir</label>
                <SelectDropdown
                  options={[
                    { value: 'shared', label: 'Shared' },
                    { value: 'worktree', label: 'Worktree' },
                  ]}
                  value={newScheduleWorkdir}
                  onChange={(val) => setNewScheduleWorkdir(val as Workdir)}
                  placement="bottom"
                />
                <div className="modal-help-text">Shared runs in the project root; worktree creates a fresh git worktree per tick.</div>
              </div>
              )}
              <div className="modal-field">
                <label className="modal-label">Prompt template</label>
                <textarea
                  className="modal-input"
                  rows={3}
                  value={newSchedulePrompt}
                  onChange={(e) => setNewSchedulePrompt(e.target.value)}
                  required={bareScheduleProfile || resumeScheduleMode || !selectedSchedulePack}
                  placeholder={resumeScheduleMode ? 'Message sent to the conversation on each fire' : undefined}
                />
                <div className="modal-help-text">
                  {resumeScheduleMode
                    ? 'Message sent to the bound conversation when the job fires. Required.'
                    : bareScheduleProfile
                      ? 'Message sent to the Bot when the job fires. Required for bare-prompt agents.'
                      : selectedSchedulePack
                        ? 'Leave empty to keep the pack\'s prompt. Clearing this box does not send a fallback stub.'
                        : 'Standing workflow envelope. One default plan step is created; edit steps in the Schedule browser.'}
                </div>
              </div>
              <div className="modal-field">
                <label className="modal-label">Steer (optional)</label>
                <textarea
                  className="modal-input"
                  rows={2}
                  value={newScheduleSteer}
                  onChange={(e) => setNewScheduleSteer(e.target.value)}
                  placeholder="e.g. Prioritize high-value video and audio processing features"
                />
                <div className="modal-help-text">Durable focus on what to prioritize. Included every tick until you change it.</div>
              </div>
            </div>
            <div className="modal-footer" style={{ flexWrap: 'wrap' }}>
              {createScheduleSubmitTitle && (
                <div className="modal-help-text" style={{ flex: '1 1 100%', color: 'var(--amber)' }}>
                  {createScheduleSubmitTitle}
                </div>
              )}
              <button type="button" className="modal-btn" onClick={() => setCreateScheduleOpen(false)} disabled={createScheduleBusy}>
                Cancel
              </button>
              <button
                type="submit"
                className="modal-btn primary"
                disabled={createScheduleBlocked}
                title={createScheduleSubmitTitle}
              >
                {createScheduleBusy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {packConflict && (
        <ConfirmDialog
          title="Pack files already exist"
          overlayClassName="modal-overlay--stack-2"
          danger
          busy={packOverwriteBusy}
          confirmLabel="Overwrite files"
          cancelLabel="Change name"
          body={(
            <>
              Files from a previous schedule with this name already exist in the project:
              <ul className="pack-conflict-list">
                {packConflict.conflicts.map((c) => <li key={c}><code>{c}</code></li>)}
              </ul>
              Overwrite replaces them with fresh pack templates — any progress or roster
              state they hold is lost, including for a still-running schedule that uses them.
              Or change the schedule name to write new files.
            </>
          )}
          onCancel={cancelPackConflict}
          onConfirm={() => { void confirmPackOverwrite(); }}
        />
      )}

      {importPackOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">Import schedule pack</div>
            <div className="modal-body">
              <div className="modal-field">
                <label className="modal-label">JSON file</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    ref={importPackFileInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setImportPackFileName(file.name);
                      void file.text().then(reviewImportPackText);
                    }}
                  />
                  <button
                    type="button"
                    className="modal-btn accent"
                    onClick={() => importPackFileInputRef.current?.click()}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Choose file…
                  </button>
                  <span
                    style={{
                      fontSize: 12,
                      color: importPackFileName ? 'var(--text-1)' : 'var(--text-3)',
                      fontFamily: importPackFileName ? 'var(--mono)' : 'inherit',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {importPackFileName || 'No file chosen'}
                  </span>
                </div>
              </div>
              <div className="modal-field">
                <label className="modal-label">Or paste JSON</label>
                <textarea
                  className="modal-input"
                  rows={8}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11 }}
                  value={importPackText}
                  onChange={(e) => reviewImportPackText(e.target.value)}
                  placeholder="{ &quot;slug&quot;: &quot;…&quot;, &quot;title&quot;: &quot;…&quot;, &quot;job&quot;: { … } }"
                  spellCheck={false}
                />
              </div>
              {importPackError && (
                <div className="modal-help-text" style={{ color: 'var(--red)' }}>{importPackError}</div>
              )}
              {importPackPreview && (
                <div className="modal-field">
                  <label className="modal-label">Review before import</label>
                  <div className="modal-help-text">
                    <strong>{importPackPreview.title}</strong>
                    {importPackPreview.description ? ` — ${importPackPreview.description}` : ''}
                  </div>
                  <div className="modal-help-text">
                    Cadence:{' '}
                    {importPackPreview.job.cadence.kind === 'interval'
                      ? `interval · every ${importPackPreview.job.cadence.everyMs}ms`
                      : importPackPreview.job.cadence.kind === 'cron'
                        ? `cron · ${importPackPreview.job.cadence.expr}`
                        : `once · fire in ${importPackPreview.job.cadence.fireInMs}ms`}
                    {' · '}
                    requiresTemplate: {importPackPreview.requiresTemplate ? 'yes' : 'no'}
                  </div>
                  <div className="modal-help-text">promptTemplate</div>
                  <pre
                    style={{
                      margin: '4px 0 8px',
                      maxHeight: 180,
                      overflow: 'auto',
                      padding: 8,
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {importPackPreview.job.promptTemplate}
                  </pre>
                  {(importPackPreview.files ?? []).map((file) => (
                    <div key={file.kind} style={{ marginBottom: 8 }}>
                      <div className="modal-help-text">
                        {`<job-slug>-${file.kind}.md`}
                      </div>
                      <pre
                        style={{
                          margin: '4px 0 0',
                          maxHeight: 120,
                          overflow: 'auto',
                          padding: 8,
                          background: 'var(--surface-2)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          fontFamily: 'var(--mono)',
                          fontSize: 11,
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {file.body.split('\n').slice(0, 12).join('\n')}
                        {file.body.split('\n').length > 12 ? '\n…' : ''}
                      </pre>
                    </div>
                  ))}
                  <div className="modal-help-text">
                    Import stores the pack only. Files are written later, when you apply it to a project.
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn"
                onClick={() => {
                  setImportPackOpen(false);
                  setImportPackFileName('');
                  if (importPackFileInputRef.current) importPackFileInputRef.current.value = '';
                }}
                disabled={importPackBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn primary"
                onClick={() => { void confirmImportPack(); }}
                disabled={importPackBusy || !importPackPreview}
              >
                {importPackBusy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeletePack && (
        <ConfirmDialog
          title="Delete schedule pack"
          danger
          busy={deletePackBusy}
          confirmLabel="Delete"
          body={(
            <>
              Delete custom pack <code>{confirmDeletePack.title}</code>?
              <br /><br />
              Jobs already created from it keep running — only the pack template is removed.
            </>
          )}
          onCancel={() => setConfirmDeletePack(null)}
          onConfirm={() => { void submitDeletePack(); }}
        />
      )}

      <CronBuilderModal
        open={cronBuilderOpen}
        onClose={() => setCronBuilderOpen(false)}
        initialValue={newScheduleCron}
        onApply={(cronExpression) => {
          setNewScheduleKind('cron');
          setNewScheduleCron(cronExpression);
        }}
      />

      {selecting && (
        <div
          className="sidebar-bulk-bar"
          role="toolbar"
          aria-label={sidebarMainTab === 'schedules' ? 'Bulk schedule actions' : 'Bulk conversation actions'}
        >
          <span className="sidebar-bulk-count">
            {bulkCountLabel(
              selectedIds.size,
              sidebarMainTab === 'schedules'
                ? [...selectedIds].filter((id) => !visibleScheduleJobIdsRef.current.has(id)
                    && !visibleScheduleConvIdsRef.current.has(id)).length
                : [...selectedIds].filter((id) => !visibleConvIdsRef.current.has(id)).length,
            )}
          </span>
          <div className="sidebar-bulk-actions">
            {sidebarMainTab === 'schedules' ? (
              <>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy || selectedScheduleJobIds.length === 0}
                  title={selectedScheduleJobIds.length === 0 ? 'Select at least one schedule' : undefined}
                  onClick={() => { void runScheduleBulk('enable'); }}
                >
                  Enable
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy || selectedScheduleJobIds.length === 0}
                  title={selectedScheduleJobIds.length === 0 ? 'Select at least one schedule' : undefined}
                  onClick={() => { void runScheduleBulk('disable'); }}
                >
                  Disable
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy || selectedScheduleJobIds.length === 0}
                  title={selectedScheduleJobIds.length === 0 ? 'Select at least one schedule' : undefined}
                  onClick={() => { void runScheduleBulk('archive'); }}
                >
                  Archive
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy || selectedScheduleJobIds.length === 0}
                  title={selectedScheduleJobIds.length === 0 ? 'Select at least one schedule' : undefined}
                  onClick={() => { void runScheduleBulk('unarchive'); }}
                >
                  Unarchive
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn sidebar-bulk-btn--danger"
                  disabled={bulkBusy}
                  onClick={() => {
                    // Schedules tab: run/spawn rows are absent from the Projects
                    // conversation list — always route through the schedule delete
                    // flow (jobs + /conversations/bulk for standalone runs).
                    if (selectedScheduleJobIds.length > 0 || selectedScheduleConvIds.length > 0) {
                      setBulkScheduleDeleteCount(selectedIds.size);
                    } else {
                      setBulkDeleteCount(selectedIds.size);
                    }
                  }}
                >
                  Delete
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy}
                  onClick={() => setBulkMoveOpen(true)}
                >
                  Move to…
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy || !canPin(selectedConvs)}
                  onClick={() => { void runBulk('pin', { toastVerb: 'Pinned' }); }}
                >
                  Pin
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy || !canPin(selectedConvs)}
                  onClick={() => { void runBulk('unpin', { toastVerb: 'Unpinned' }); }}
                >
                  Unpin
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy || !canPin(selectedConvs)}
                  onClick={() => { void runBulk('archive', { toastVerb: 'Archived' }); }}
                >
                  Archive
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn"
                  disabled={bulkBusy || !canPin(selectedConvs)}
                  onClick={() => { void runBulk('unarchive', { toastVerb: 'Unarchived' }); }}
                >
                  Unarchive
                </button>
                <button
                  type="button"
                  className="sidebar-bulk-btn sidebar-bulk-btn--danger"
                  disabled={bulkBusy}
                  onClick={() => setBulkDeleteCount(selectedIds.size)}
                >
                  Delete
                </button>
              </>
            )}
            <button
              type="button"
              className="sidebar-bulk-btn sidebar-bulk-btn--done"
              disabled={bulkBusy}
              onClick={exitSelect}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="sidebar-toast" role="status">
          <span className="sidebar-toast-message">{toast.message}</span>
          {toast.action ? (
            <button type="button" className="sidebar-toast-action" onClick={toast.action.onClick}>
              {toast.action.label}
            </button>
          ) : (
            <button
              type="button"
              className="sidebar-toast-action"
              aria-label="Dismiss"
              onClick={dismissToast}
            >
              ✕
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
