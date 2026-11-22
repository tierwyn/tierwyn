import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation, Project } from '@tierwyn/shared';
import { api, searchConversationContent, type ConversationSearchHit } from '../api.js';
import { formatRelativeTime } from '../agentActivity.js';
import { lsGet, lsSet } from '../prefixedStorage.js';
import {
  filterPaletteItems,
  groupPaletteItems,
  groupMessageHits,
  wrapPaletteIndex,
  getRecentSearches,
  saveRecentSearch,
  parseMessagePrefix,
  resolveMessageScopeProjectId,
  highlightSegments,
  type PaletteActionType,
  type PaletteItem,
  type PaletteMode,
  type PaletteSection,
} from '../commandPalette.js';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Project[];
  conversations: Record<string, Conversation[]>;
  onSelectConversation: (project: Project, conversation: Conversation, focusEventId?: string, focusQuery?: string) => void;
  onSelectProject: (project: Project) => void;
  onExecuteAction: (actionType: PaletteActionType) => void;
  focusTick?: number;
  initialMode?: PaletteMode;
  activeProjectId?: string | null;
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((seg, i) =>
        seg.hit ? <mark key={i}>{seg.text}</mark> : <React.Fragment key={i}>{seg.text}</React.Fragment>,
      )}
    </>
  );
}

function senderLabel(sender?: 'user' | 'agent' | 'system' | 'helper'): string {
  if (sender === 'user') return 'You';
  if (sender === 'system') return 'System';
  if (sender === 'helper') return 'Helper';
  return 'Agent';
}

export function CommandPalette({
  isOpen,
  onClose,
  projects,
  conversations,
  onSelectConversation,
  onSelectProject,
  onExecuteAction,
  focusTick = 0,
  initialMode,
  activeProjectId,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<PaletteMode>('all');
  const [scope, setScope] = useState<'all' | 'project'>(() =>
    lsGet('tierwyn.commandPalette.messageScope') === 'project' ? 'project' : 'all',
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [contentHits, setContentHits] = useState<ConversationSearchHit[]>([]);
  const [isSearchingContent, setIsSearchingContent] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  const effectiveScope: 'all' | 'project' = activeProjectId ? scope : 'all';

  useEffect(() => {
    lsSet('tierwyn.commandPalette.messageScope', scope);
  }, [scope]);

  // Focus & select input whenever palette opens or focusTick updates (VS Code Ctrl+K behavior)
  useEffect(() => {
    if (isOpen) {
      setMode(initialMode ?? 'all');
      setRecentSearches(getRecentSearches());
      // Small timeout or rAF ensures portal is attached
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      });
    } else {
      setQuery('');
      setContentHits([]);
      setIsSearchingContent(false);
      setSelectedIndex(0);
      setMode('all');
    }
  }, [isOpen, focusTick, initialMode]);

  useEffect(() => {
    setContentHits([]);
  }, [mode, scope, activeProjectId]);

  // Debounced content search (300ms, query >= 2 chars)
  useEffect(() => {
    const q = query.trim();
    if (!isOpen || q.length < 2) {
      setContentHits([]);
      setIsSearchingContent(false);
      return;
    }

    setIsSearchingContent(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      const req = mode === 'messages'
        ? searchConversationContent(q, resolveMessageScopeProjectId(scope, activeProjectId), {
          matchesPerConversation: 5,
          limit: 20,
        })
        : searchConversationContent(q);
      req
        .then((hits) => {
          if (!cancelled) setContentHits(hits);
        })
        .catch(() => {
          if (!cancelled) setContentHits([]);
        })
        .finally(() => {
          if (!cancelled) setIsSearchingContent(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, isOpen, mode, scope, activeProjectId]);

  // Filter & group items
  const { sections, flatItems } = useMemo(() => {
    if (!isOpen) return { sections: [] as PaletteSection[], flatItems: [] as PaletteItem[] };
    if (mode === 'messages') {
      if (query.trim().length < 2) return { sections: [] as PaletteSection[], flatItems: [] as PaletteItem[] };
      return groupMessageHits(contentHits, projects);
    }
    const filtered = filterPaletteItems({
      query,
      projects,
      conversations,
      contentHits,
      recentSearches,
    });
    return groupPaletteItems({
      recentSearches: filtered.recentSearches,
      actions: filtered.actions,
      conversations: filtered.conversations,
      projects: filtered.projects,
      contentHits: filtered.contentHits,
      totalCap: 50,
    });
  }, [isOpen, query, projects, conversations, contentHits, recentSearches, mode]);

  // Reset selectedIndex whenever query/mode/scope changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, mode, scope]);

  // Clamp selectedIndex if flatItems shrinks
  useEffect(() => {
    if (selectedIndex >= flatItems.length && flatItems.length > 0) {
      setSelectedIndex(flatItems.length - 1);
    }
  }, [flatItems.length, selectedIndex]);

  const selectedItem = flatItems[selectedIndex] ?? null;

  // Scroll active item into view
  useEffect(() => {
    if (selectedItem) {
      const el = itemRefs.current.get(selectedItem.id);
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedItem]);

  const activateItem = useCallback((item: PaletteItem) => {
    if (item.kind === 'recent') {
      setQuery(item.query);
      inputRef.current?.focus();
      return;
    }

    if (query.trim()) {
      saveRecentSearch(query);
    }

    onClose();
    if (item.kind === 'action') {
      onExecuteAction(item.actionType);
    } else if (item.kind === 'conversation') {
      const p = projects.find((proj) => proj.id === item.projectId);
      const convList = conversations[item.projectId] ?? [];
      const c = convList.find((conv) => conv.id === item.conversationId);
      if (p && c) {
        onSelectConversation(p, c);
      }
    } else if (item.kind === 'project') {
      const p = projects.find((proj) => proj.id === item.projectId);
      if (p) {
        onSelectProject(p);
      }
    } else if (item.kind === 'content') {
      const p = projects.find((proj) => proj.id === item.projectId);
      const convList = conversations[item.projectId] ?? [];
      const c = convList.find((conv) => conv.id === item.conversationId);
      const q = query.trim() || undefined;
      if (p && c) {
        onSelectConversation(p, c, item.eventId, q);
      } else if (p) {
        api.getConversation(item.conversationId)
          .then((fetchedConv) => {
            onSelectConversation(p, fetchedConv, item.eventId, q);
          })
          .catch(() => {});
      }
    }
  }, [query, onClose, onExecuteAction, projects, conversations, onSelectConversation, onSelectProject]);

  const setModeAndFocus = (next: PaletteMode) => {
    setMode(next);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setSelectedIndex((prev) => wrapPaletteIndex(prev, 1, flatItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setSelectedIndex((prev) => wrapPaletteIndex(prev, -1, flatItems.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (selectedItem) {
        activateItem(selectedItem);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        setSelectedIndex((prev) => wrapPaletteIndex(prev, -1, flatItems.length));
      } else {
        setSelectedIndex((prev) => wrapPaletteIndex(prev, 1, flatItems.length));
      }
    } else if (e.key === 'Backspace' && mode === 'messages' && query === '') {
      e.preventDefault();
      setMode('all');
    }
  };

  if (!isOpen) return null;

  const emptyCopy = mode === 'messages'
    ? (query.trim().length < 2
      ? 'Type at least 2 characters to search messages.'
      : isSearchingContent
        ? 'Searching…'
        : 'No messages match.')
    : 'No matching actions, conversations, or projects.';

  return createPortal(
    <div
      className="command-palette-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'messages' ? 'Message search' : 'Command palette'}
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette-input-wrap">
          <svg
            className="command-palette-search-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder={mode === 'messages' ? 'Search messages…' : 'Type a command, conversation, or project...'}
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              const rest = parseMessagePrefix(v);
              if (rest !== null && mode === 'all') {
                setMode('messages');
                setQuery(rest);
              } else {
                setQuery(v);
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={selectedItem ? selectedItem.id : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          {isSearchingContent && (
            <span className="command-palette-spinner" title="Searching messages…" />
          )}
          <kbd className="command-palette-esc-hint" onClick={onClose}>esc</kbd>
        </div>

        <div className="command-palette-modes">
          <button
            type="button"
            className="command-palette-mode-pill"
            aria-pressed={mode === 'all'}
            onClick={() => setModeAndFocus('all')}
          >
            All
          </button>
          <button
            type="button"
            className="command-palette-mode-pill"
            aria-pressed={mode === 'messages'}
            onClick={() => setModeAndFocus('messages')}
          >
            Messages
          </button>
          {mode === 'messages' && (
            <div className="command-palette-scope">
              <button
                type="button"
                className="command-palette-mode-pill"
                aria-pressed={effectiveScope === 'all'}
                onClick={() => { setScope('all'); inputRef.current?.focus(); }}
              >
                All projects
              </button>
              <button
                type="button"
                className="command-palette-mode-pill"
                aria-pressed={effectiveScope === 'project'}
                disabled={!activeProjectId}
                title={!activeProjectId ? 'Select a project first' : undefined}
                onClick={() => { setScope('project'); inputRef.current?.focus(); }}
              >
                This project
              </button>
            </div>
          )}
        </div>

        <div
          id="command-palette-list"
          className={`command-palette-list${mode === 'messages' ? ' is-messages' : ''}`}
          role="listbox"
          aria-label="Suggestions"
        >
          {flatItems.length === 0 ? (
            <div className="command-palette-empty">
              {emptyCopy}
            </div>
          ) : (
            sections.map((section) => (
              <div
                key={section.conversationId ? `conv-${section.conversationId}` : section.title}
                className="command-palette-section"
                role="group"
                aria-label={section.title}
              >
                {mode === 'messages' ? (
                  <div className="command-palette-group-header">
                    <span>{section.title}</span>
                    {section.projectName && (
                      <span className="command-palette-item-badge">{section.projectName}</span>
                    )}
                    {section.updatedAt ? <span>{formatRelativeTime(section.updatedAt)}</span> : null}
                  </div>
                ) : (
                  <div className="command-palette-section-title">{section.title}</div>
                )}
                {section.items.map((item) => {
                  const itemIndex = flatItems.indexOf(item);
                  const isSelected = itemIndex === selectedIndex;

                  return (
                    <div
                      key={item.id}
                      id={item.id}
                      ref={(el) => {
                        if (el) itemRefs.current.set(item.id, el);
                        else itemRefs.current.delete(item.id);
                      }}
                      className={`command-palette-item${isSelected ? ' selected' : ''}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => activateItem(item)}
                      onMouseEnter={() => setSelectedIndex(itemIndex)}
                    >
                      {mode === 'messages' ? (
                        <>
                          <div className="command-palette-item-main">
                            <div className="command-palette-item-snippet">
                              <HighlightedSnippet text={item.kind === 'content' ? (item.snippet ?? '') : ''} query={query} />
                            </div>
                          </div>
                          <div className="command-palette-item-meta">
                            {item.kind === 'content' && (
                              <>
                                {senderLabel(item.sender)}
                                {item.ts ? ` ${formatRelativeTime(item.ts)}` : null}
                              </>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="command-palette-item-main">
                            <div className="command-palette-item-title-row">
                              {item.kind === 'recent' && (
                                <span className="command-palette-item-icon">
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                  </svg>
                                </span>
                              )}
                              {item.kind === 'action' && (
                                <span className="command-palette-item-icon">
                                  {item.actionType === 'new_chat' ? '+'
                                    : item.actionType === 'open_schedules' ? '⏱'
                                    : item.actionType.startsWith('settings_') || item.actionType === 'open_settings' ? '⚙'
                                    : item.actionType === 'open_recordings' ? '🎙'
                                    : item.actionType === 'open_markdown' || item.actionType === 'export_markdown' ? '📄'
                                    : '›'}
                                </span>
                              )}
                              <span className="command-palette-item-title">
                                {item.kind === 'recent'
                                  ? item.query
                                  : item.kind === 'action'
                                  ? item.label
                                  : item.kind === 'project'
                                  ? item.name
                                  : item.title}
                              </span>
                              {item.kind !== 'action' && item.kind !== 'recent' && item.kind !== 'project' && item.projectName && (
                                <span className="command-palette-item-badge">{item.projectName}</span>
                              )}
                            </div>

                            {item.kind === 'conversation' && item.description && (
                              <div className="command-palette-item-desc">{item.description}</div>
                            )}

                            {item.kind === 'content' && item.snippet && (
                              <div className="command-palette-item-snippet" title={item.snippet}>
                                "<HighlightedSnippet text={item.snippet} query={query} />"
                              </div>
                            )}
                          </div>

                          <div className="command-palette-item-kind-label">
                            {item.kind === 'recent'
                              ? 'Recent'
                              : item.kind === 'action'
                              ? 'Action'
                              : item.kind === 'project'
                              ? 'Project'
                              : item.kind === 'content'
                              ? 'Message'
                              : 'Chat'}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="command-palette-footer">
          <div className="command-palette-footer-hints">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> select</span>
            <span><kbd>esc</kbd> close</span>
          </div>
          <div className="command-palette-footer-count">
            {flatItems.length} {flatItems.length === 1 ? 'result' : 'results'}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
