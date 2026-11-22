import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type {
  GlobalTaskDto,
  GlobalTaskView,
  GlobalTaskCounts,
  GlobalTaskUpdatedFrame,
} from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { MarkdownBody } from './MarkdownBody.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { api, UnauthorizedError } from '../api.js';
import {
  groupTasksByProject,
  applyTaskFrame,
  taskBadges,
  relativeAge,
  tabLabel,
} from '../globalTasks.js';

interface Props {
  onClose: () => void;
  onJump: (conversationId: string) => void;
  onUnauthorized: () => void;
  onCountsChange: (c: GlobalTaskCounts) => void;
  frame: GlobalTaskUpdatedFrame | null;
}

export function GlobalTasksModal({
  onClose,
  onJump,
  onUnauthorized,
  onCountsChange,
  frame,
}: Props) {
  const [view, setView] = useState<GlobalTaskView>('in_progress');
  const [projectId, setProjectId] = useState<string>('');
  const [tasks, setTasks] = useState<GlobalTaskDto[]>([]);
  const [counts, setCounts] = useState<GlobalTaskCounts>({
    inProgress: 0,
    completedVisible: 0,
    hidden: 0,
  });
  const [staleAfterHours, setStaleAfterHours] = useState<number>(48);
  const [skew, setSkew] = useState<number>(0);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [openMenuTaskId, setOpenMenuTaskId] = useState<string | null>(null);

  // Confirm dialogs
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const [showHideAllConfirm, setShowHideAllConfirm] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  // Track settings fetched on mount
  useEffect(() => {
    let mounted = true;
    api
      .globalTasksSettings()
      .then((s) => {
        if (mounted && s) {
          setStaleAfterHours(s.staleAfterHours);
        }
      })
      .catch(() => {
        // default 48 on failure
      });
    return () => {
      mounted = false;
    };
  }, []);

  const [projectMap, setProjectMap] = useState<Map<string, string>>(() => new Map());
  const lastProcessedFrameIdRef = useRef<string | null>(null);

  // Clear tasks when view or projectId changes to avoid showing previous view's actions
  useEffect(() => {
    setTasks([]);
  }, [view, projectId]);

  // Fetch tasks on mount, view/projectId change, and poll every 15s
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ac = new AbortController();

    const fetchTasks = () => {
      api
        .globalTasks(view, projectId ? projectId : undefined, ac.signal)
        .then((res) => {
          if (!mounted) return;
          setTasks(res.tasks);
          setCounts(res.counts);
          onCountsChange(res.counts);
          setSkew(Date.now() - res.now);
          setProjectMap((prev) => {
            const next = new Map(prev);
            for (const t of res.tasks) {
              if (t.projectId && t.projectName) next.set(t.projectId, t.projectName);
            }
            return next;
          });
        })
        .catch((err: unknown) => {
          if (!mounted) return;
          if (err instanceof UnauthorizedError) {
            if (timer !== undefined) clearInterval(timer);
            onUnauthorized();
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') return;
        });
    };

    fetchTasks();
    timer = setInterval(fetchTasks, 15_000);

    return () => {
      mounted = false;
      if (timer !== undefined) clearInterval(timer);
      ac.abort();
    };
  }, [view, projectId, onUnauthorized, onCountsChange]);

  // Live frame updates from props (guarded to apply each unique frame once)
  useEffect(() => {
    if (!frame) return;
    const frameId = `${frame.type}:${frame.task?.id}:${frame.task?.updatedAt}:${frame.counts.inProgress}:${frame.counts.completedVisible}:${frame.counts.hidden}`;
    if (lastProcessedFrameIdRef.current === frameId) return;
    lastProcessedFrameIdRef.current = frameId;

    setTasks((prev) => applyTaskFrame(prev, frame, view, projectId ? projectId : undefined));
    setCounts(frame.counts);
    onCountsChange(frame.counts);

    if (frame.task?.projectId && frame.task?.projectName) {
      setProjectMap((prev) => {
        const next = new Map(prev);
        next.set(frame.task!.projectId!, frame.task!.projectName!);
        return next;
      });
    }
  }, [frame, view, projectId, onCountsChange]);

  // Close overflow menu on outside click or escape
  useEffect(() => {
    if (!openMenuTaskId) return;
    const onDocClick = () => setOpenMenuTaskId(null);
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [openMenuTaskId]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Derive unique projects seen in loaded tasks or cached project names
  const availableProjects = useMemo(() => {
    const map = new Map(projectMap);
    for (const t of tasks) {
      if (t.projectId) {
        map.set(t.projectId, t.projectName || map.get(t.projectId) || 'Unnamed Project');
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [tasks, projectMap]);

  const groups = useMemo(() => groupTasksByProject(tasks), [tasks]);

  const now = Date.now() - skew;

  // Actions
  const handleMarkCompleted = useCallback(async (id: string) => {
    try {
      await api.updateGlobalTask(id, { status: 'completed' });
    } catch (err) {
      console.error('Failed to mark task completed:', err);
    }
  }, []);

  const handleReopen = useCallback(async (id: string) => {
    try {
      await api.updateGlobalTask(id, { status: 'in_progress' });
    } catch (err) {
      console.error('Failed to reopen task:', err);
    }
  }, []);

  const handleHide = useCallback(async (id: string) => {
    try {
      await api.updateGlobalTask(id, { hidden: true });
    } catch (err) {
      console.error('Failed to hide task:', err);
    }
  }, []);

  const handleUnhide = useCallback(async (id: string) => {
    try {
      await api.updateGlobalTask(id, { hidden: false });
    } catch (err) {
      console.error('Failed to unhide task:', err);
    }
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTaskId || busyAction) return;
    setBusyAction(true);
    try {
      await api.deleteGlobalTask(deleteTaskId);
      setDeleteTaskId(null);
    } catch (err) {
      console.error('Failed to delete task:', err);
    } finally {
      setBusyAction(false);
    }
  }, [deleteTaskId, busyAction]);

  const handleConfirmHideAll = useCallback(async () => {
    if (busyAction) return;
    setBusyAction(true);
    try {
      await api.hideCompletedGlobalTasks();
      setShowHideAllConfirm(false);
    } catch (err) {
      console.error('Failed to hide all completed tasks:', err);
    } finally {
      setBusyAction(false);
    }
  }, [busyAction]);

  return (
    <Modal
      title="Global Tasks"
      onClose={onClose}
      className="global-tasks-modal"
      footer={
        <div className="gt-footer">
          Agents log task work here automatically. Stale = no update for {staleAfterHours}h (Settings → Global Tasks). Click a conversation name to jump to it.
        </div>
      }
    >
      <div className="gt-tabbar">
        <div className="gt-tabs" role="tablist" aria-label="Global tasks category">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'in_progress'}
            className={`gt-tab${view === 'in_progress' ? ' active' : ''}`}
            onClick={() => setView('in_progress')}
          >
            In progress <span className="gt-tab-count">{counts.inProgress}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'completed'}
            className={`gt-tab${view === 'completed' ? ' active' : ''}`}
            onClick={() => setView('completed')}
          >
            Completed <span className="gt-tab-count">{counts.completedVisible}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'hidden'}
            className={`gt-tab${view === 'hidden' ? ' active' : ''}`}
            onClick={() => setView('hidden')}
          >
            Hidden <span className="gt-tab-count">{counts.hidden}</span>
          </button>
        </div>

        <div className="gt-tabbar-actions">
          <select
            className="gt-ctl"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Filter by project"
          >
            <option value="">All projects</option>
            {availableProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {view === 'completed' && counts.completedVisible > 0 && (
            <button
              type="button"
              className="gt-act gt-act--ok"
              onClick={() => setShowHideAllConfirm(true)}
            >
              Hide all completed
            </button>
          )}
        </div>
      </div>

      <div className="list" style={{ flex: 1, minHeight: '120px' }}>
        {groups.length === 0 ? (
          <div className="aa-empty" style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-3)' }}>
            {view === 'in_progress' && 'No tasks in progress.'}
            {view === 'completed' && 'No completed tasks to review.'}
            {view === 'hidden' && 'Nothing hidden.'}
          </div>
        ) : (
          groups.map((group) => {
            const countLabel =
              view === 'in_progress'
                ? `${group.tasks.length} in progress`
                : view === 'completed'
                ? `${group.tasks.length} completed`
                : `${group.tasks.length} hidden`;

            return (
              <section key={group.projectId} className="gt-proj">
                <header className="gt-proj-head">
                  <span className="gt-proj-name">{group.projectName || 'Project'}</span>
                  <span className="gt-proj-count">{countLabel}</span>
                </header>

                {group.tasks.map((task) => {
                  const isExpanded = expandedIds.has(task.id);
                  const badges = taskBadges(task, now, staleAfterHours);
                  const updatedStr = relativeAge(task.updatedAt, now);
                  const startedStr = task.createdAt ? relativeAge(task.createdAt, now) : '';
                  const hasDetails = !!(task.description || task.testing || task.progress || task.sessionId);

                  return (
                    <div key={task.id} className="gt-row">
                      <div className="gt-row-main">
                        <button
                          type="button"
                          className="gt-chev"
                          aria-label={isExpanded ? 'Hide details' : 'Show details'}
                          aria-expanded={isExpanded}
                          onClick={() => toggleExpand(task.id)}
                        >
                          {isExpanded ? '▾' : '▸'}
                        </button>

                        <div className="gt-row-body">
                          <div
                            className="gt-row-title"
                            role="button"
                            tabIndex={0}
                            aria-expanded={isExpanded}
                            onClick={() => {
                              const selection = window.getSelection();
                              if (selection && selection.toString().length > 0) return;
                              toggleExpand(task.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleExpand(task.id);
                              }
                            }}
                          >
                            <span className="gt-title-text">{task.title}</span>
                            {badges.map((b, i) => (
                              <span key={i} className={`gt-pill gt-pill--${b.kind}`}>
                                {b.label}
                              </span>
                            ))}
                          </div>

                          <div className="gt-meta">
                            {task.conversationId ? (
                              <button
                                type="button"
                                className="gt-conv-link"
                                title="Open conversation"
                                onClick={() => {
                                  onJump(task.conversationId!);
                                  onClose();
                                }}
                              >
                                <span className="gt-conv-link-title">{task.conversationTitle || 'Conversation'}</span>
                                <span className="gt-conv-link-icon" aria-hidden="true">↗</span>
                              </button>
                            ) : (
                              <span className="gt-dead">
                                conversation deleted{task.conversationTitle ? ` · was “${task.conversationTitle}”` : ''}
                              </span>
                            )}

                            {task.parentConversationTitle && (
                              <span>
                                · {task.fromSchedule ? '⏱ schedule ' : 'child of '}
                                {task.parentConversationId ? (
                                  <button
                                    type="button"
                                    className="gt-conv-link"
                                    title={task.fromSchedule ? 'Open schedule run' : 'Open parent conversation'}
                                    onClick={() => {
                                      onJump(task.parentConversationId!);
                                      onClose();
                                    }}
                                  >
                                    <span className="gt-conv-link-title">{task.parentConversationTitle}</span>
                                    <span className="gt-conv-link-icon" aria-hidden="true">↗</span>
                                  </button>
                                ) : (
                                  task.parentConversationTitle
                                )}
                              </span>
                            )}

                            {task.status === 'completed' && task.completedAt ? (
                              <span>· completed {relativeAge(task.completedAt, now)}</span>
                            ) : (
                              <span>· updated {updatedStr}</span>
                            )}

                            {isExpanded && startedStr && (
                              <span>· started {startedStr}</span>
                            )}
                          </div>
                        </div>

                        <div className="gt-actions">
                          {view === 'in_progress' && (
                            <>
                              <button
                                type="button"
                                className="gt-act gt-act--ok"
                                onClick={() => handleMarkCompleted(task.id)}
                              >
                                ✓ Mark completed
                              </button>
                              <div style={{ position: 'relative' }}>
                                <button
                                  type="button"
                                  className="gt-more"
                                  aria-label="More actions"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMenuTaskId(openMenuTaskId === task.id ? null : task.id);
                                  }}
                                >
                                  ⋯
                                </button>
                                {openMenuTaskId === task.id && (
                                  <div className="gt-menu-dropdown">
                                    <button
                                      type="button"
                                      className="gt-act gt-act--danger"
                                      style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none' }}
                                      onClick={() => {
                                        setOpenMenuTaskId(null);
                                        setDeleteTaskId(task.id);
                                      }}
                                    >
                                      Delete…
                                    </button>
                                  </div>
                                )}
                              </div>
                            </>
                          )}

                          {view === 'completed' && (
                            <>
                              <button
                                type="button"
                                className="gt-act"
                                onClick={() => handleReopen(task.id)}
                              >
                                ↺ Reopen
                              </button>
                              <button
                                type="button"
                                className="gt-act"
                                onClick={() => handleHide(task.id)}
                              >
                                Hide
                              </button>
                              <div style={{ position: 'relative' }}>
                                <button
                                  type="button"
                                  className="gt-more"
                                  aria-label="More actions"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMenuTaskId(openMenuTaskId === task.id ? null : task.id);
                                  }}
                                >
                                  ⋯
                                </button>
                                {openMenuTaskId === task.id && (
                                  <div className="gt-menu-dropdown">
                                    <button
                                      type="button"
                                      className="gt-act gt-act--danger"
                                      style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none' }}
                                      onClick={() => {
                                        setOpenMenuTaskId(null);
                                        setDeleteTaskId(task.id);
                                      }}
                                    >
                                      Delete…
                                    </button>
                                  </div>
                                )}
                              </div>
                            </>
                          )}

                          {view === 'hidden' && (
                            <>
                              <button
                                type="button"
                                className="gt-act"
                                onClick={() => handleUnhide(task.id)}
                              >
                                Unhide
                              </button>
                              <button
                                type="button"
                                className="gt-act gt-act--danger"
                                onClick={() => setDeleteTaskId(task.id)}
                              >
                                🗑 Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {isExpanded && hasDetails && (
                        <div className="gt-detail">
                          {task.description ? (
                            <div>
                              <h4>Description</h4>
                              <MarkdownBody>{task.description}</MarkdownBody>
                            </div>
                          ) : null}

                          {task.testing ? (
                            <div>
                              <h4>Testing needed</h4>
                              <MarkdownBody>{task.testing}</MarkdownBody>
                            </div>
                          ) : null}

                          {task.progress ? (
                            <div>
                              <h4>Completed so far</h4>
                              <MarkdownBody>{task.progress}</MarkdownBody>
                            </div>
                          ) : null}

                          {task.sessionId ? (
                            <div className="gt-prov">
                              session {task.sessionId.slice(0, 8)}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          })
        )}
      </div>

      {deleteTaskId && (
        <ConfirmDialog
          title="Delete Global Task"
          body="Are you sure you want to permanently delete this task?"
          confirmLabel="Delete"
          danger
          busy={busyAction}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTaskId(null)}
        />
      )}

      {showHideAllConfirm && (
        <ConfirmDialog
          title="Hide All Completed Tasks"
          body="This will mark all visible completed tasks as reviewed and hide them from this tab."
          confirmLabel="Hide all"
          busy={busyAction}
          onConfirm={handleConfirmHideAll}
          onCancel={() => setShowHideAllConfirm(false)}
        />
      )}
    </Modal>
  );
}
