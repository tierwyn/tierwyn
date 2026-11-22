import type { Conversation, Project } from '@tierwyn/shared';
import type { ConversationSearchHit } from './api.js';
import { lsGet, lsSet, lsRemove } from './prefixedStorage.js';

export type PaletteItemKind = 'recent' | 'action' | 'conversation' | 'project' | 'content';

export type PaletteActionType =
  | 'new_chat'
  | 'open_schedules'
  | 'open_schedule_calendar'
  | 'open_settings'
  | 'settings_voice'
  | 'settings_directLlm'
  | 'settings_compaction'
  | 'settings_sandbox'
  | 'settings_btw'
  | 'settings_agents'
  | 'open_agent_usage'
  | 'settings_templates'
  | 'edit_conversation'
  | 'find_in_transcript'
  | 'spawn_subagent'
  | 'open_helpers'
  | 'open_tasks'
  | 'open_summaries'
  | 'open_markdown'
  | 'open_recordings'
  | 'open_checkpoints'
  | 'open_git_panel'
  | 'open_file_browser'
  | 'open_btw'
  | 'open_usage'
  | 'copy_conversation'
  | 'duplicate_conversation'
  | 'export_markdown'
  | 'print_conversation'
  | 'approve_spawns';

export interface PaletteRecentSearchItem {
  kind: 'recent';
  id: string;
  query: string;
}

export interface PaletteActionItem {
  kind: 'action';
  id: string;
  actionType: PaletteActionType;
  label: string;
  /** Extra searchable tokens (not shown). */
  keywords?: string;
}

export interface PaletteConversationItem {
  kind: 'conversation';
  id: string;
  conversationId: string;
  projectId: string;
  title: string;
  description?: string;
  projectName?: string;
  updatedAt: number;
}

export interface PaletteProjectItem {
  kind: 'project';
  id: string;
  projectId: string;
  name: string;
}

export interface PaletteContentItem {
  kind: 'content';
  id: string;
  conversationId: string;
  projectId: string;
  title: string;
  projectName?: string;
  updatedAt: number;
  eventId?: string;
  snippet?: string;
  ts?: number;
  sender?: 'user' | 'agent' | 'system' | 'helper';
}

export type PaletteItem =
  | PaletteRecentSearchItem
  | PaletteActionItem
  | PaletteConversationItem
  | PaletteProjectItem
  | PaletteContentItem;

export interface PaletteSection {
  title: string;
  kind: PaletteItemKind;
  items: PaletteItem[];
  projectName?: string;
  updatedAt?: number;
  conversationId?: string;
}

export type PaletteMode = 'all' | 'messages';

export const RECENT_SEARCHES_STORAGE_KEY = 'tierwyn.commandPalette.recentSearches';
export const MAX_RECENT_SEARCHES = 5;
let _memoryRecentSearches: string[] = [];

export function getRecentSearches(): string[] {
  try {
    const raw = lsGet(RECENT_SEARCHES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, MAX_RECENT_SEARCHES);
      }
    }
  } catch { /* ignore */ }
  return [..._memoryRecentSearches];
}

export function saveRecentSearch(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getRecentSearches();
  const existing = getRecentSearches();
  const next = [trimmed, ...existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase())].slice(0, MAX_RECENT_SEARCHES);
  _memoryRecentSearches = [...next];
  try {
    lsSet(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}

export function removeRecentSearch(query: string): string[] {
  const trimmed = query.trim();
  const existing = getRecentSearches();
  const next = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  _memoryRecentSearches = [...next];
  try {
    lsSet(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}

export function clearRecentSearches(): void {
  _memoryRecentSearches = [];
  try {
    lsRemove(RECENT_SEARCHES_STORAGE_KEY);
  } catch { /* ignore */ }
}

/** Shown when the query is empty — keep this short so conversations stay visible. */
export const CORE_ACTIONS: readonly PaletteActionItem[] = [
  { kind: 'action', id: 'action-new-chat', actionType: 'new_chat', label: 'New chat' },
  { kind: 'action', id: 'action-open-schedules', actionType: 'open_schedules', label: 'Open schedules' },
  { kind: 'action', id: 'action-open-settings', actionType: 'open_settings', label: 'Open settings', keywords: 'general preferences' },
];

/** Full roster: settings tabs + conversation ⋮ menu. Matched when the query is non-empty. */
export const EXTRA_ACTIONS: readonly PaletteActionItem[] = [
  { kind: 'action', id: 'action-open-schedule-calendar', actionType: 'open_schedule_calendar', label: 'Open schedule calendar', keywords: 'month grid upcoming fires schedule' },
  { kind: 'action', id: 'action-settings-voice', actionType: 'settings_voice', label: 'Settings: Voice', keywords: 'tts whisper dictation piper kokoro' },
  { kind: 'action', id: 'action-settings-direct-llm', actionType: 'settings_directLlm', label: 'Settings: Sidecar LLMs', keywords: 'gemini enhancer cleanup profile sidecar connection' },
  { kind: 'action', id: 'action-settings-compaction', actionType: 'settings_compaction', label: 'Settings: Compaction', keywords: 'handoff context' },
  { kind: 'action', id: 'action-settings-sandbox', actionType: 'settings_sandbox', label: 'Settings: Sandbox', keywords: 'bwrap bubblewrap agent jail isolation' },
  { kind: 'action', id: 'action-settings-btw', actionType: 'settings_btw', label: 'Settings: BTW side question', keywords: 'sidecar llm priming side question' },
  { kind: 'action', id: 'action-settings-agents', actionType: 'settings_agents', label: 'Settings: Agents', keywords: 'catalogue models' },
  { kind: 'action', id: 'action-agent-usage', actionType: 'open_agent_usage', label: 'Usage credits', keywords: 'quota rate limit credits agent usage' },
  { kind: 'action', id: 'action-settings-templates', actionType: 'settings_templates', label: 'Settings: Templates', keywords: 'spawn roster' },
  { kind: 'action', id: 'action-edit-conversation', actionType: 'edit_conversation', label: 'Edit conversation', keywords: 'rename tags pin move' },
  { kind: 'action', id: 'action-find-transcript', actionType: 'find_in_transcript', label: 'Find in transcript', keywords: 'search ctrl+f' },
  { kind: 'action', id: 'action-spawn', actionType: 'spawn_subagent', label: 'Add subagent', keywords: 'delegate child subagent add' },
  { kind: 'action', id: 'action-helpers', actionType: 'open_helpers', label: 'Helpers', keywords: 'subagent native helper task agent' },
  { kind: 'action', id: 'action-tasks', actionType: 'open_tasks', label: 'Tasks', keywords: 'todo' },
  { kind: 'action', id: 'action-summaries', actionType: 'open_summaries', label: 'Summaries' },
  { kind: 'action', id: 'action-markdown', actionType: 'open_markdown', label: 'Markdown', keywords: 'files docs' },
  { kind: 'action', id: 'action-recordings', actionType: 'open_recordings', label: 'Recordings', keywords: 'tts audio wav speak' },
  { kind: 'action', id: 'action-checkpoints', actionType: 'open_checkpoints', label: 'Checkpoints', keywords: 'restore git' },
  { kind: 'action', id: 'action-git-panel', actionType: 'open_git_panel', label: 'Git working tree', keywords: 'git commit stage working tree status' },
  { kind: 'action', id: 'action-file-browser', actionType: 'open_file_browser', label: 'File browser', keywords: 'files folder browse explorer tree open' },
  { kind: 'action', id: 'action-btw', actionType: 'open_btw', label: 'BTW', keywords: 'side questions' },
  { kind: 'action', id: 'action-usage', actionType: 'open_usage', label: 'Usage statistics', keywords: 'tokens cost' },
  { kind: 'action', id: 'action-copy', actionType: 'copy_conversation', label: 'Copy conversation', keywords: 'clipboard' },
  { kind: 'action', id: 'action-duplicate', actionType: 'duplicate_conversation', label: 'Duplicate conversation' },
  { kind: 'action', id: 'action-export', actionType: 'export_markdown', label: 'Export as Markdown', keywords: 'download' },
  { kind: 'action', id: 'action-print', actionType: 'print_conversation', label: 'Print conversation' },
  { kind: 'action', id: 'action-approve-spawns', actionType: 'approve_spawns', label: 'Approve spawns', keywords: 'pending requests' },
];

export const STATIC_ACTIONS: readonly PaletteActionItem[] = [...CORE_ACTIONS, ...EXTRA_ACTIONS];

/**
 * Checks if a key event matches Ctrl+K / Cmd+K without Shift / Alt modifiers,
 * ignoring IME composition.
 */
export function isPaletteHotkey(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}): boolean {
  if (event.isComposing) return false;
  const isK = event.key === 'k' || event.key === 'K';
  const hasMod = Boolean(event.ctrlKey || event.metaKey);
  const hasDisallowed = Boolean(event.shiftKey || event.altKey);
  return isK && hasMod && !hasDisallowed;
}

export function isMessageSearchHotkey(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}): boolean {
  if (e.isComposing) return false;
  const isF = e.key === 'f' || e.key === 'F';
  const hasMod = Boolean(e.ctrlKey || e.metaKey);
  return isF && hasMod && Boolean(e.shiftKey) && !e.altKey;
}

export function parseMessagePrefix(value: string): string | null {
  return value.startsWith('? ') ? value.slice(2) : null;
}

export function resolveMessageScopeProjectId(
  scope: 'all' | 'project',
  activeProjectId: string | null | undefined,
): string | undefined {
  if (scope === 'project' && activeProjectId) return activeProjectId;
  return undefined;
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

export function highlightSegments(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const t = raw.replace(/[^\p{L}\p{N}_]+/gu, '');
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(t);
  }
  if (tokens.length === 0) return [{ text, hit: false }];
  tokens.sort((a, b) => b.length - a.length);
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?:${escaped.join('|')})`, 'giu');
  const segs: HighlightSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) segs.push({ text: text.slice(last, m.index), hit: false });
    segs.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), hit: false });
  return segs.length > 0 ? segs : [{ text, hit: false }];
}

export function groupMessageHits(
  hits: ConversationSearchHit[],
  projects: Project[],
): { sections: PaletteSection[]; flatItems: PaletteItem[] } {
  const projectMap = new Map<string, Project>();
  for (const p of projects) projectMap.set(p.id, p);

  const sections: PaletteSection[] = [];
  const flatItems: PaletteItem[] = [];
  for (const hit of hits) {
    const projectName = projectMap.get(hit.projectId)?.name;
    const matches = hit.matches ?? [{
      eventId: hit.eventId ?? '',
      snippet: hit.snippet ?? '',
      ts: hit.updatedAt,
      sender: 'agent' as const,
    }];
    const items: PaletteContentItem[] = matches.map((m) => ({
      kind: 'content' as const,
      id: `msg-${hit.id}-${m.eventId}`,
      eventId: m.eventId,
      conversationId: hit.id,
      projectId: hit.projectId,
      title: hit.title,
      projectName,
      updatedAt: hit.updatedAt,
      snippet: m.snippet,
      ts: m.ts,
      sender: m.sender,
    }));
    sections.push({
      title: hit.title,
      kind: 'content',
      items,
      projectName,
      updatedAt: hit.updatedAt,
      conversationId: hit.id,
    });
    flatItems.push(...items);
  }
  return { sections, flatItems };
}

/**
 * Checks if the currently focused target is an editable input inside an active modal overlay.
 * If so, the global palette hotkey should be ignored so modal typing isn't interrupted.
 * Note: If the target is inside the command palette overlay itself, returns false so
 * pressing Ctrl+K again can refocus/reselect the search input.
 */
export function shouldIgnoreHotkeyTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (attr: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  if (typeof el.closest !== 'function') return false;

  const tag = (el.tagName || '').toUpperCase();
  const isInputLike =
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    Boolean(el.isContentEditable) ||
    el.getAttribute?.('contenteditable') === 'true';

  if (!isInputLike) return false;

  const isInsidePalette = Boolean(el.closest('.command-palette-overlay'));
  if (isInsidePalette) return false;

  const modalOverlay = el.closest('.modal-overlay');
  return Boolean(modalOverlay);
}

/**
 * Scores a conversation against a query string:
 * - Starts with (tier 3)
 * - Title includes (tier 2)
 * - Description includes (tier 1)
 * - No match (0)
 */
export function scoreConversation(conv: Conversation, queryLower: string): number {
  const title = conv.title.toLowerCase();
  const desc = (conv.description || '').toLowerCase();
  if (title.startsWith(queryLower)) return 3;
  if (title.includes(queryLower)) return 2;
  if (desc.includes(queryLower)) return 1;
  return 0;
}

/**
 * Scores an action:
 * - Starts with (tier 2)
 * - Label includes (tier 1)
 * - No match (0)
 */
export function scoreAction(action: PaletteActionItem, queryLower: string): number {
  const label = action.label.toLowerCase();
  const keywords = (action.keywords || '').toLowerCase();
  if (label.startsWith(queryLower)) return 2;
  if (label.includes(queryLower) || keywords.includes(queryLower)) return 1;
  return 0;
}

/**
 * Scores a project:
 * - Starts with (tier 2)
 * - Name includes (tier 1)
 * - No match (0)
 */
export function scoreProject(project: Project, queryLower: string): number {
  const name = project.name.toLowerCase();
  if (name.startsWith(queryLower)) return 2;
  if (name.includes(queryLower)) return 1;
  return 0;
}

const EMPTY_QUERY_CONV_LIMIT = 8;

export interface FilterPaletteParams {
  query: string;
  projects: Project[];
  conversations: Conversation[] | Record<string, Conversation[]>;
  contentHits?: ConversationSearchHit[];
  recentSearches?: string[];
}

export interface FilteredPaletteResult {
  recentSearches: PaletteRecentSearchItem[];
  actions: PaletteActionItem[];
  conversations: PaletteConversationItem[];
  projects: PaletteProjectItem[];
  contentHits: PaletteContentItem[];
}

/**
 * Filters and ranks actions, conversations, projects, content search hits, and recent searches.
 */
export function filterPaletteItems(params: {
  query: string;
  projects: Project[];
  conversations: Conversation[] | Record<string, Conversation[]>;
  contentHits?: ConversationSearchHit[];
  recentSearches?: string[];
}): FilteredPaletteResult {
  const q = params.query.trim().toLowerCase();

  const projectMap = new Map<string, Project>();
  for (const p of params.projects) {
    projectMap.set(p.id, p);
  }

  const allConvs: Conversation[] = Array.isArray(params.conversations)
    ? params.conversations
    : Object.values(params.conversations).flat();

  // 0. Recent searches — only surfaced on empty query
  const recentSearches: PaletteRecentSearchItem[] = (!q && params.recentSearches)
    ? params.recentSearches.map((queryText) => ({
        kind: 'recent' as const,
        id: `recent-${queryText}`,
        query: queryText,
      }))
    : [];

  // 1. Actions — empty query keeps the 3 core items so conversations stay visible.
  let filteredActions: PaletteActionItem[] = [];
  if (!q) {
    filteredActions = [...CORE_ACTIONS];
  } else {
    filteredActions = STATIC_ACTIONS
      .map((action) => ({ action, score: scoreAction(action, q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.action.label.localeCompare(b.action.label);
      })
      .map((entry) => entry.action);
  }

  // 2. Conversations
  let filteredConvs: PaletteConversationItem[] = [];
  if (!q) {
    const sorted = [...allConvs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    filteredConvs = sorted.slice(0, EMPTY_QUERY_CONV_LIMIT).map((c) => ({
      kind: 'conversation' as const,
      id: c.id,
      conversationId: c.id,
      projectId: c.projectId,
      title: c.title,
      description: c.description,
      projectName: projectMap.get(c.projectId)?.name,
      updatedAt: c.updatedAt || 0,
    }));
  } else {
    filteredConvs = allConvs
      .map((c) => ({ conv: c, score: scoreConversation(c, q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.conv.updatedAt || 0) - (a.conv.updatedAt || 0);
      })
      .map(({ conv }) => ({
        kind: 'conversation' as const,
        id: conv.id,
        conversationId: conv.id,
        projectId: conv.projectId,
        title: conv.title,
        description: conv.description,
        projectName: projectMap.get(conv.projectId)?.name,
        updatedAt: conv.updatedAt || 0,
      }));
  }

  // 3. Projects
  let filteredProjects: PaletteProjectItem[] = [];
  if (!q) {
    filteredProjects = params.projects.map((p) => ({
      kind: 'project' as const,
      id: p.id,
      projectId: p.id,
      name: p.name,
    }));
  } else {
    filteredProjects = params.projects
      .map((p) => ({ project: p, score: scoreProject(p, q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.project.name.localeCompare(b.project.name);
      })
      .map(({ project }) => ({
        kind: 'project' as const,
        id: project.id,
        projectId: project.id,
        name: project.name,
      }));
  }

  // 4. Content Hits (deduped against conversations already matched)
  const matchedConvIds = new Set(filteredConvs.map((c) => c.conversationId));
  const dedupedContentHits: PaletteContentItem[] = [];
  if (params.contentHits && params.contentHits.length > 0) {
    for (const hit of params.contentHits) {
      if (!matchedConvIds.has(hit.id)) {
        const top = hit.matches?.[0];
        dedupedContentHits.push({
          kind: 'content' as const,
          id: `content-${hit.id}-${hit.eventId || 'top'}`,
          conversationId: hit.id,
          projectId: hit.projectId,
          title: hit.title,
          projectName: projectMap.get(hit.projectId)?.name,
          updatedAt: hit.updatedAt || 0,
          eventId: hit.eventId,
          snippet: hit.snippet,
          ts: top?.ts,
          sender: top?.sender,
        });
      }
    }
  }

  return {
    recentSearches,
    actions: filteredActions,
    conversations: filteredConvs,
    projects: filteredProjects,
    contentHits: dedupedContentHits,
  };
}

/**
 * Groups filtered items into sections and builds a flat list capped at totalCap (~50).
 */
export function groupPaletteItems(params: {
  recentSearches?: PaletteRecentSearchItem[];
  actions: PaletteActionItem[];
  conversations: PaletteConversationItem[];
  projects: PaletteProjectItem[];
  contentHits?: PaletteContentItem[];
  totalCap?: number;
}): { sections: PaletteSection[]; flatItems: PaletteItem[] } {
  const totalCap = params.totalCap ?? 50;
  const sections: PaletteSection[] = [];
  const flatItems: PaletteItem[] = [];

  const tryAddSection = (title: string, kind: PaletteItemKind, items: PaletteItem[]) => {
    if (items.length === 0 || flatItems.length >= totalCap) return;
    const remaining = totalCap - flatItems.length;
    const sliced = items.slice(0, remaining);
    sections.push({ title, kind, items: sliced });
    flatItems.push(...sliced);
  };

  if (params.recentSearches && params.recentSearches.length > 0) {
    tryAddSection('Recent Searches', 'recent', params.recentSearches);
  }
  tryAddSection('Actions', 'action', params.actions);
  tryAddSection('Conversations', 'conversation', params.conversations);
  tryAddSection('Projects', 'project', params.projects);
  if (params.contentHits && params.contentHits.length > 0) {
    tryAddSection('In messages', 'content', params.contentHits);
  }

  return { sections, flatItems };
}

/**
 * Wraps index forward or backward across totalCount items.
 */
export function wrapPaletteIndex(currentIndex: number, delta: number, totalCount: number): number {
  if (totalCount <= 0) return -1;
  if (currentIndex < 0) return delta >= 0 ? 0 : totalCount - 1;
  return (currentIndex + delta + totalCount) % totalCount;
}
