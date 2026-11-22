import { copyText } from '../clipboard';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { MEMORY_LIMITS, type Project, type MemoryDto, type MemoryCounts, type ListMemoriesResponse } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';
import { api } from '../api.js';
import { MEMORY_FLAG_LABELS } from '../memories.js';

export interface MemoriesModalProps {
  onClose: () => void;
  projects: Project[];
  refreshKey: number;
  focusId?: string | null;
  onAddAsRule: (m: MemoryDto) => void;
  onJumpToConversation: (conversationId: string) => void;
}

type TabType = 'suggestions' | 'flagged' | 'all';

function formatDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MemoriesModal({
  onClose,
  projects,
  refreshKey,
  focusId,
  onAddAsRule,
  onJumpToConversation,
}: MemoriesModalProps) {
  const [tab, setTab] = useState<TabType>(focusId ? 'all' : 'suggestions');
  const [items, setItems] = useState<MemoryDto[]>([]);
  const [counts, setCounts] = useState<MemoryCounts>({ pendingSuggestions: 0, flagged: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters for 'all' tab
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [showSuperseded, setShowSuperseded] = useState(false);

  // Focus single memory
  const [prevFocusId, setPrevFocusId] = useState<string | null | undefined>(focusId);
  const [dismissedFocusId, setDismissedFocusId] = useState<string | null>(null);

  if (focusId !== prevFocusId) {
    setPrevFocusId(focusId);
    if (focusId) {
      setDismissedFocusId(null);
    }
  }

  const [focusMemory, setFocusMemory] = useState<MemoryDto | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);

  // Actions
  const [deleteConfirm, setDeleteConfirm] = useState<MemoryDto | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopyText = async (id: string, text: string) => {
    try {
      await copyText(text);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((cur) => (cur === id ? null : cur));
      }, 1500);
    } catch {
      // ignore
    }
  };

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const projectOptions: SelectDropdownOption[] = useMemo(() => [
    { value: '', label: 'All projects' },
    ...projects.map((p) => ({
      value: p.id,
      label: p.name,
    })),
  ], [projects]);

  // Load single focus memory if focusId provided
  useEffect(() => {
    if (!focusId || focusId === dismissedFocusId) {
      if (!focusId) setFocusMemory(null);
      return;
    }
    const controller = new AbortController();
    setFocusLoading(true);
    setTab('all');
    api.getMemory(focusId)
      .then((m) => {
        if (!controller.signal.aborted) setFocusMemory(m);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setFocusLoading(false);
      });
    return () => { controller.abort(); };
  }, [focusId, refreshKey, dismissedFocusId]);

  // Fetch list of memories and counts for current tab
  const fetchList = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      let res: ListMemoriesResponse;
      if (tab === 'suggestions') {
        res = await api.listMemories({ view: 'suggestions' }, signal);
      } else if (tab === 'flagged') {
        res = await api.listMemories({ view: 'flagged' }, signal);
      } else {
        res = await api.listMemories({
          view: 'all',
          projectId: selectedProjectId || undefined,
          q: searchQuery.trim() || undefined,
          includeSuperseded: showSuperseded,
        }, signal);
      }
      if (signal?.aborted) return;
      setItems(res.memories);
      setCounts(res.counts);
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError') || (err instanceof Error && err.name === 'AbortError')) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [tab, selectedProjectId, searchQuery, showSuperseded]);

  useEffect(() => {
    if (!focusMemory) {
      const controller = new AbortController();
      void fetchList(controller.signal);
      return () => {
        controller.abort();
      };
    }
  }, [fetchList, refreshKey, focusMemory]);

  const handleApprove = async (id: string) => {
    setActionBusy(true);
    try {
      await api.approveMemory(id);
      if (focusMemory && focusMemory.id === id) {
        setFocusMemory({ ...focusMemory, status: 'active', supersededBy: null, flagReason: null });
      }
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    setActionBusy(true);
    try {
      const saved = await api.editMemory(editing.id, editing.text);
      if (focusMemory && focusMemory.id === editing.id) setFocusMemory(saved);
      setEditing(null);
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleDiscard = async (id: string) => {
    setActionBusy(true);
    try {
      await api.dismissMemorySuggestion(id);
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setActionBusy(true);
    try {
      await api.deleteMemory(id);
      setDeleteConfirm(null);
      if ((focusMemory && focusMemory.id === id) || (focusId && focusId === id)) {
        if (focusId) setDismissedFocusId(focusId);
        setFocusMemory(null);
      }
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const hasFilterActive = Boolean(searchQuery.trim() || selectedProjectId || showSuperseded);
  const showFilters = tab === 'all' && !focusMemory && (hasFilterActive || items.length > 0 || loading);

  const displayedItems = focusMemory ? [focusMemory] : items;

  return (
    <Modal
      title="Project Memories"
      onClose={onClose}
      className="global-tasks-modal memories-modal"
      footer={
        <div className="gt-footer">
          Memories are reference notes saved by agents. Rule suggestions and flagged memories need operator review.
        </div>
      }
    >
      <div className="gt-tabbar">
        <div className="gt-tabs" role="tablist" aria-label="Memories tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'suggestions'}
            className={`gt-tab${tab === 'suggestions' ? ' active' : ''}`}
            onClick={() => {
              if (focusId) setDismissedFocusId(focusId);
              setFocusMemory(null);
              if (tab !== 'suggestions') setItems([]);
              setTab('suggestions');
            }}
          >
            Rule suggestions
            {counts.pendingSuggestions > 0 && (
              <span className="gt-tab-count">{counts.pendingSuggestions}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'flagged'}
            className={`gt-tab${tab === 'flagged' ? ' active' : ''}`}
            onClick={() => {
              if (focusId) setDismissedFocusId(focusId);
              setFocusMemory(null);
              if (tab !== 'flagged') setItems([]);
              setTab('flagged');
            }}
          >
            Flagged memories
            {counts.flagged > 0 && (
              <span className="gt-tab-count">{counts.flagged}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            className={`gt-tab${tab === 'all' ? ' active' : ''}`}
            onClick={() => {
              if (focusId) setDismissedFocusId(focusId);
              setFocusMemory(null);
              if (tab !== 'all') setItems([]);
              setTab('all');
            }}
          >
            All memories
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="mem-toolbar mem-filters">
          <div className="mem-search-wrap">
            <svg className="mem-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              className="gt-ctl mem-search-input"
              placeholder="Search memories…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search memories"
            />
            {searchQuery && (
              <button
                type="button"
                className="mem-search-clear"
                onClick={() => setSearchQuery('')}
                title="Clear search"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <SelectDropdown
            options={projectOptions}
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            placement="bottom"
            searchable
          />
          <div className="mem-toggle-wrap">
            <button
              type="button"
              className={`toggle-switch${showSuperseded ? ' on' : ''}`}
              onClick={() => setShowSuperseded((v) => !v)}
              role="switch"
              aria-checked={showSuperseded}
              aria-label="Show superseded memories"
            >
              <span className="toggle-knob" />
            </button>
            <span
              className="mem-toggle-label mem-checkbox-label"
              onClick={() => setShowSuperseded((v) => !v)}
            >
              Show superseded
            </span>
          </div>
        </div>
      )}

      {focusMemory && (
        <div className="mem-focus-banner">
          <span>Showing focused memory <strong>{focusMemory.id}</strong></span>
          <button
            type="button"
            className="gt-act"
            onClick={() => {
              if (focusId) setDismissedFocusId(focusId);
              setFocusMemory(null);
            }}
          >
            Show all memories
          </button>
        </div>
      )}

      {error && (
        <div className="template-error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="mem-modal-body">
        {!focusMemory && ((loading && items.length === 0) || focusLoading) ? (
          <div className="mem-empty">Loading memories…</div>
        ) : displayedItems.length === 0 ? (
          <div className="mem-empty">
            {tab === 'suggestions' ? (
              'No pending rule suggestions.'
            ) : tab === 'flagged' ? (
              'No flagged memories.'
            ) : hasFilterActive ? (
              <>
                <div>No memories match your query.</div>
                <button
                  type="button"
                  className="gt-act"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedProjectId('');
                    setShowSuperseded(false);
                  }}
                >
                  Clear filters
                </button>
              </>
            ) : (
              'No memories saved yet. Memories are reference notes saved by agents.'
            )}
          </div>
        ) : (
          displayedItems.map((m) => {
            const proj = projectMap.get(m.projectId);
            const projName = proj ? proj.name : m.projectId;
            const isLong = m.text.length > 240;
            const isExpanded = expandedIds.has(m.id) || Boolean(focusMemory);
            const displayText = isLong && !isExpanded ? `${m.text.slice(0, 240)}…` : m.text;
            return (
              <div key={m.id} className="gt-row mem-row">
                <div className="gt-row-main mem-row-main">
                  <div className="gt-row-body">
                    <div className="mem-header-pills">
                      <span className="mem-id-pill">{m.id}</span>
                      <span className={`mem-pill mem-pill--${m.kind}`}>{m.kind}</span>
                      {tab === 'suggestions' && (
                        <span className="mem-badge mem-badge--agent">Agent-written</span>
                      )}
                      {m.status === 'flagged' && (
                        <span className="mem-badge mem-badge--danger">
                          ⚠ Flagged: {m.flagReason ? MEMORY_FLAG_LABELS[m.flagReason] : 'flagged'}
                        </span>
                      )}
                      {m.status === 'superseded' && (
                        <span className="mem-pill mem-pill--superseded">
                          superseded{m.supersededBy ? ` by ${m.supersededBy}` : ''}
                        </span>
                      )}
                      {m.ruleSuggestion === 'promoted' && (
                        <span className="mem-pill mem-pill--promoted">promoted to rule</span>
                      )}
                      <span className="mem-date">{formatDate(m.createdAt)}</span>
                    </div>

                    {editing?.id === m.id ? (
                      <div className="mem-edit">
                        <textarea
                          className="mem-edit-input"
                          value={editing.text}
                          maxLength={MEMORY_LIMITS.text}
                          rows={4}
                          autoFocus
                          aria-label={`Edit ${m.id}`}
                          onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); }
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleSaveEdit();
                          }}
                        />
                        <div className="mem-edit-bar">
                          <span className="mem-edit-count">{editing.text.length}/{MEMORY_LIMITS.text}</span>
                          <span className="mem-edit-hint">Saves as a new memory; the original is kept as superseded.</span>
                          <button type="button" className="gt-act" onClick={() => setEditing(null)} disabled={actionBusy}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="gt-act gt-act--ok"
                            onClick={() => void handleSaveEdit()}
                            disabled={actionBusy || !editing.text.trim() || editing.text.trim() === m.text}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                    <div className="mem-text">
                      {displayText}
                      {isLong && (
                        <button
                          type="button"
                          className="mem-expand-btn"
                          onClick={() => toggleExpand(m.id)}
                          aria-label={isExpanded ? 'Show less' : 'Show more'}
                        >
                          {isExpanded ? 'Show less' : 'Show more'}
                        </button>
                      )}
                    </div>
                    )}

                    {m.ruleReason && (
                      <div className="mem-reason">
                        <span className="mem-reason-label">Reason: </span>
                        {m.ruleReason}
                      </div>
                    )}

                    <div className="gt-meta mem-meta">
                      <span className="mem-meta-proj">{projName}</span>
                      {m.createdByConversationTitle ? (
                        <button
                          type="button"
                          className="gt-conv-link"
                          onClick={() => {
                            if (m.createdByConversation) {
                              onJumpToConversation(m.createdByConversation);
                              onClose();
                            }
                          }}
                          title={m.createdByConversation ? `Jump to conversation ${m.createdByConversation}` : undefined}
                        >
                          <span className="gt-conv-link-title">
                            {m.createdByConversationTitle}
                          </span>
                          <span className="gt-conv-link-icon" aria-hidden="true">↗</span>
                        </button>
                      ) : (
                        <span className="gt-dead">{m.createdByConversation || 'Purged conversation'}</span>
                      )}
                      {m.createdByAgent && (
                        <span className="mem-meta-agent">by {m.createdByAgent}</span>
                      )}
                    </div>
                  </div>

                  <div className="gt-actions mem-actions">
                    <button
                      type="button"
                      className="gt-act"
                      onClick={() => void handleCopyText(m.id, m.text)}
                      title="Copy full text to clipboard"
                    >
                      {copiedId === m.id ? 'Copied' : 'Copy'}
                    </button>

                    {m.status === 'active' && editing?.id !== m.id && (
                      <button
                        type="button"
                        className="gt-act"
                        onClick={() => setEditing({ id: m.id, text: m.text })}
                        disabled={actionBusy}
                        title="Correct this memory (keeps the original as superseded)"
                      >
                        Edit
                      </button>
                    )}

                    {tab === 'suggestions' && (
                      <>
                        <button
                          type="button"
                          className="gt-act gt-act--ok"
                          onClick={() => onAddAsRule(m)}
                          disabled={actionBusy}
                        >
                          Add as rule
                        </button>
                        <button
                          type="button"
                          className="gt-act"
                          onClick={() => void handleDiscard(m.id)}
                          disabled={actionBusy}
                        >
                          Discard
                        </button>
                      </>
                    )}

                    {tab === 'flagged' && (
                      <>
                        <button
                          type="button"
                          className="gt-act gt-act--ok"
                          onClick={() => void handleApprove(m.id)}
                          disabled={actionBusy}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="gt-act gt-act--danger"
                          onClick={() => setDeleteConfirm(m)}
                          disabled={actionBusy}
                        >
                          Delete
                        </button>
                      </>
                    )}

                    {tab === 'all' && (
                      <>
                        {m.status === 'superseded' && (
                          <button
                            type="button"
                            className="gt-act gt-act--ok"
                            onClick={() => void handleApprove(m.id)}
                            disabled={actionBusy}
                          >
                            Restore
                          </button>
                        )}
                        <button
                          type="button"
                          className="gt-act gt-act--danger"
                          onClick={() => setDeleteConfirm(m)}
                          disabled={actionBusy}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete memory"
          body={
            <div>
              Are you sure you want to permanently delete <strong>{deleteConfirm.id}</strong>?
              <div style={{ marginTop: 8, fontStyle: 'italic', fontSize: 12, color: 'var(--text-2)' }}>
                "{deleteConfirm.text.slice(0, 100)}{deleteConfirm.text.length > 100 ? '…' : ''}"
              </div>
            </div>
          }
          confirmLabel="Delete"
          cancelLabel="Cancel"
          danger
          busy={actionBusy}
          onConfirm={() => void handleDelete(deleteConfirm.id)}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </Modal>
  );
}
