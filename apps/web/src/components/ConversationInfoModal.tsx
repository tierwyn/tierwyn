import { copyText } from '../clipboard';
import { useState, useMemo, useCallback, useEffect } from 'react';
import { Modal } from './Modal.js';
import { DiffViewer } from './ToolInputDisplay.js';
import { formatElapsedMs } from '@tierwyn/shared';
import type { NormalisedEvent } from '@tierwyn/shared';
import { buildConversationInfo, formatCachedTokens } from '../conversationInfo.js';
import {
  LinkifiedPath,
  extractCommand,
  extractFileInfo,
  extractQuery,
  extractUrl,
  getToolCategory,
} from './TurnInfoModal.js';

export interface ConversationInfoModalProps {
  events: readonly NormalisedEvent[];
  conversationTitle?: string;
  agentModel?: string;
  isConversationActive?: boolean;
  forceInterruptedPromptIds?: ReadonlySet<string>;
  onOpenFile?: (path: string, gallery?: string[]) => void;
  onClose: () => void;
}

export function ConversationInfoModal({
  events,
  conversationTitle,
  agentModel,
  isConversationActive = false,
  forceInterruptedPromptIds,
  onOpenFile,
  onClose,
}: ConversationInfoModalProps) {
  const [activeTab, setActiveTab] = useState<'all' | 'overview' | 'turns' | 'tools' | 'files'>('all');
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [expandedFileDiffs, setExpandedFileDiffs] = useState<Record<string, boolean>>({});
  const [copiedCmdIndex, setCopiedCmdIndex] = useState<number | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isConversationActive) return;
    const id = window.setInterval(() => setLiveNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isConversationActive]);

  const info = useMemo(
    () => buildConversationInfo(events, {
      forceInterruptedPromptIds,
      isConversationActive,
      liveNow: isConversationActive ? liveNow : undefined,
    }),
    [events, forceInterruptedPromptIds, isConversationActive, liveNow],
  );

  const cachedTokensHint = useMemo(
    () => formatCachedTokens(info.totalCacheReadTokens, info.totalCacheCreationTokens),
    [info.totalCacheReadTokens, info.totalCacheCreationTokens],
  );

  const startedTimeStr = info.startedAt ? new Date(info.startedAt).toLocaleTimeString() : undefined;
  const startedDateStr = info.startedAt
    ? new Date(info.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : undefined;
  const lastTimeStr = info.lastActivityAt ? new Date(info.lastActivityAt).toLocaleTimeString() : undefined;
  const lastDateStr = info.lastActivityAt
    ? new Date(info.lastActivityAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : undefined;

  const toggleToolExpanded = useCallback((toolId: string) => {
    setExpandedTools((prev) => ({ ...prev, [toolId]: !prev[toolId] }));
  }, []);

  const toggleFileDiffExpanded = useCallback((fileKey: string) => {
    setExpandedFileDiffs((prev) => ({ ...prev, [fileKey]: !prev[fileKey] }));
  }, []);

  const handleCopyCommand = useCallback((cmd: string, idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    copyText(cmd);
    setCopiedCmdIndex(idx);
    setTimeout(() => setCopiedCmdIndex(null), 1600);
  }, []);

  const turnCount = info.turnSummaries.length;

  return (
    <Modal
      title={
        <span className="turn-modal-title">
          <svg
            className="turn-modal-title-icon"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <line x1="8" y1="6" x2="16" y2="6" />
            <line x1="8" y1="10" x2="16" y2="10" />
            <line x1="8" y1="14" x2="12" y2="14" />
          </svg>
          <span className="turn-modal-title-text">Conversation Overview</span>
        </span>
      }
      onClose={onClose}
      className="turn-info-modal conversation-info-modal"
      headerActions={
        <div className="turn-modal-header-badges">
          {conversationTitle && (
            <span className="turn-modal-badge turn-modal-badge--agent" title={conversationTitle}>
              <span className="turn-modal-badge-text">{conversationTitle}</span>
            </span>
          )}
          {isConversationActive ? (
            <span className="turn-modal-badge turn-modal-badge--running" title="Conversation has an active turn">
              <span className="turn-status-pulse" />
              <span>
                Running
                {info.totalElapsedMs != null ? ` ${formatElapsedMs(info.totalElapsedMs)}` : ''}
              </span>
            </span>
          ) : info.totalElapsedMs != null ? (
            <span className="turn-modal-badge turn-modal-badge--settled" title={`Total elapsed: ${formatElapsedMs(info.totalElapsedMs)}`}>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{formatElapsedMs(info.totalElapsedMs)}</span>
            </span>
          ) : null}
        </div>
      }
      subHeader={
        <div className="turn-modal-subnav">
          <div className="turn-modal-tab-bar" role="tablist" aria-label="Conversation overview sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'all'}
              className={`turn-modal-tab${activeTab === 'all' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              <span className="turn-tab-label">
                <span className="turn-tab-label--desktop">All Details</span>
                <span className="turn-tab-label--mobile">All</span>
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'overview'}
              className={`turn-modal-tab${activeTab === 'overview' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              <span className="turn-tab-label">Overview</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'turns'}
              className={`turn-modal-tab${activeTab === 'turns' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('turns')}
            >
              <span className="turn-tab-label">Turns</span>
              <span className="turn-tab-count" title={`${turnCount} turn${turnCount === 1 ? '' : 's'}`}>
                {turnCount}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'tools'}
              className={`turn-modal-tab${activeTab === 'tools' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('tools')}
            >
              <span className="turn-tab-label">Tools</span>
              <span className="turn-tab-count" title={`${info.totalToolCalls} tool execution${info.totalToolCalls === 1 ? '' : 's'}`}>
                {info.totalToolCalls}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'files'}
              className={`turn-modal-tab${activeTab === 'files' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('files')}
            >
              <span className="turn-tab-label">Files</span>
              <span className="turn-tab-count" title={`${info.uniqueFilePaths.length} unique file${info.uniqueFilePaths.length === 1 ? '' : 's'}`}>
                {info.uniqueFilePaths.length}
              </span>
            </button>
          </div>
        </div>
      }
    >
      {(activeTab === 'all' || activeTab === 'overview') && (
        <div className="turn-modal-section">
          <div className="turn-modal-section-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="21" x2="9" y2="9" />
            </svg>
            <span>Overview & Metrics</span>
          </div>

          <div className="turn-overview-grid">
            <div className="turn-overview-card turn-overview-card--agent">
              <span className="turn-stat-label">Agent / Model</span>
              <span className="turn-stat-value turn-stat-value--agent" title={agentModel || 'Unknown'}>
                {agentModel || 'Unknown'}
              </span>
              <span className="turn-stat-hint">
                {isConversationActive ? 'Active conversation' : 'Settled conversation'}
              </span>
            </div>

            <div className="turn-overview-card">
              <span className="turn-stat-label">Total Duration</span>
              <span className="turn-stat-value">
                {info.totalElapsedMs != null ? formatElapsedMs(info.totalElapsedMs) : '—'}
              </span>
              {info.subagentTotalMs != null && (
                <span className="turn-stat-hint">
                  Subagents: {formatElapsedMs(info.subagentTotalMs)}
                </span>
              )}
            </div>

            <div className="turn-overview-card">
              <span className="turn-stat-label">Turns</span>
              <span className="turn-stat-value">{turnCount}</span>
              <span className="turn-stat-hint">
                {turnCount === 0 ? 'No user prompts yet' : `${turnCount} user prompt${turnCount === 1 ? '' : 's'}`}
              </span>
            </div>

            <div className="turn-overview-card">
              <span className="turn-stat-label">Tools Executed</span>
              <span className="turn-stat-value">{info.totalToolCalls}</span>
              <span className="turn-stat-hint">
                {info.totalToolCalls === 0 ? 'No tools invoked' : `${info.totalToolCalls} total call${info.totalToolCalls === 1 ? '' : 's'}`}
              </span>
            </div>

            <div className="turn-overview-card">
              <span className="turn-stat-label">Files Modified</span>
              <span className="turn-stat-value">{info.uniqueFilePaths.length}</span>
              <span className="turn-stat-hint">
                {info.totalFileChanges > 0 ? (
                  <>
                    <span className="diff-stat-added">+{info.totalAdditions}</span>{' '}
                    <span className="diff-stat-removed">−{info.totalDeletions}</span>
                    {info.totalFileChanges !== info.uniqueFilePaths.length && (
                      <> · {info.totalFileChanges} change{info.totalFileChanges === 1 ? '' : 's'}</>
                    )}
                  </>
                ) : (
                  'No files touched'
                )}
              </span>
            </div>

            {startedTimeStr && (
              <div className="turn-overview-card">
                <span className="turn-stat-label">Started At</span>
                <span className="turn-stat-value">{startedTimeStr}</span>
                {startedDateStr && <span className="turn-stat-hint">{startedDateStr}</span>}
              </div>
            )}

            {lastTimeStr && (
              <div className="turn-overview-card">
                <span className="turn-stat-label">Last Activity</span>
                <span className="turn-stat-value">{lastTimeStr}</span>
                {lastDateStr && <span className="turn-stat-hint">{lastDateStr}</span>}
              </div>
            )}

            {(info.totalInputTokens > 0 || info.totalOutputTokens > 0 || cachedTokensHint != null) && (
              <div className="turn-overview-card">
                <span className="turn-stat-label">Tokens (In / Out)</span>
                <span className="turn-stat-value">
                  {info.totalInputTokens.toLocaleString()} / {info.totalOutputTokens.toLocaleString()}
                </span>
                {cachedTokensHint && (
                  <span className="turn-stat-hint">{cachedTokensHint}</span>
                )}
              </div>
            )}

            {info.totalCostUsd != null && (
              <div className="turn-overview-card">
                <span className="turn-stat-label">Estimated Cost</span>
                <span className="turn-stat-value">${info.totalCostUsd.toFixed(4)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {(activeTab === 'all' || activeTab === 'turns') && (
        <div className="turn-modal-section">
          <div className="turn-modal-section-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span>Turn Timeline ({turnCount})</span>
          </div>

          {info.turnSummaries.length === 0 ? (
            <div className="turn-modal-empty-card">No turns in this conversation yet.</div>
          ) : (
            <div className="conv-turn-timeline">
              {info.turnSummaries.map((turn) => (
                <div
                  key={turn.turnId}
                  className={`conv-turn-card${turn.isActive ? ' conv-turn-card--active' : ''}`}
                >
                  <div className="conv-turn-card-header">
                    <span className="conv-turn-index">#{turn.turnIndex + 1}</span>
                    {turn.isActive && <span className="conv-turn-active-pill">Active</span>}
                    {turn.elapsedMs != null && (
                      <span className="conv-turn-duration">{formatElapsedMs(turn.elapsedMs)}</span>
                    )}
                  </div>
                  <div className="conv-turn-prompt" title={turn.promptPreview}>{turn.promptPreview}</div>
                  <div className="conv-turn-stats">
                    <span>{turn.toolCount} tool{turn.toolCount === 1 ? '' : 's'}</span>
                    <span>{turn.fileCount} file{turn.fileCount === 1 ? '' : 's'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(activeTab === 'all' || activeTab === 'files') && (
        <div className="turn-modal-section">
          <div className="turn-modal-section-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>Files Modified ({info.fileRows.length})</span>
            {info.fileRows.length > 0 && (
              <span className="turn-modal-diff-summary">
                <span className="diff-stat-added">+{info.totalAdditions}</span>
                <span className="diff-stat-removed">−{info.totalDeletions}</span>
              </span>
            )}
          </div>

          {info.fileRows.length === 0 ? (
            <div className="turn-modal-empty-card">No files were modified in this conversation.</div>
          ) : (
            <div className="turn-files-card-list">
              {info.fileRows.map(({ payload: f, fileKey, diffPair, additions, deletions, turnIndex }) => {
                const kindBadge = f.kind === 'created' ? '+' : f.kind === 'deleted' ? 'D' : 'M';
                const kindTitle = f.kind === 'created' ? 'Created' : f.kind === 'deleted' ? 'Deleted' : 'Modified';
                const diffExpanded = !!expandedFileDiffs[fileKey];

                return (
                  <div key={fileKey} className="turn-file-card">
                    <div className="turn-file-card-row">
                      <span className="conv-file-turn-badge" title={`Turn ${turnIndex + 1}`}>
                        T{turnIndex + 1}
                      </span>
                      <span
                        className={`git-wt-badge git-wt-badge--${f.kind === 'created' ? 'new' : f.kind === 'deleted' ? 'deleted' : 'modified'}`}
                        title={kindTitle}
                      >
                        {kindBadge}
                      </span>
                      <div className="turn-file-path-col">
                        <LinkifiedPath
                          path={f.path}
                          onOpen={onOpenFile}
                          title={`Click to open ${f.path}`}
                          trailing={(
                            <div className="turn-file-stats-col">
                              {additions != null && <span className="diff-stat-added">+{additions}</span>}
                              {deletions != null && <span className="diff-stat-removed">−{deletions}</span>}
                              {diffPair && (
                                <button
                                  type="button"
                                  className="file-diff-toggle"
                                  onClick={() => toggleFileDiffExpanded(fileKey)}
                                  title={diffExpanded ? 'Collapse diff' : 'Show diff'}
                                >
                                  {diffExpanded ? 'diff ▴' : 'diff ▾'}
                                </button>
                              )}
                            </div>
                          )}
                        />
                      </div>
                    </div>
                    {diffExpanded && diffPair && (
                      <div className="turn-file-card-diff file-change-diff">
                        <DiffViewer target={diffPair.before} replacement={diffPair.after} foldUnchanged />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {(activeTab === 'all' || activeTab === 'tools') && (
        <div className="turn-modal-section">
          <div className="turn-modal-section-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span>Tool Executions ({info.totalToolCalls})</span>
          </div>

          {info.toolCalls.length === 0 ? (
            <div className="turn-modal-empty-card">No tool executions in this conversation.</div>
          ) : (
            <div className="turn-tools-detailed-list">
              {info.toolCalls.map((row, i) => {
                const { name, input, toolUseId } = row.event.payload;
                const toolKey = row.toolKey;
                const result = row.result;
                const isExpanded = !!expandedTools[toolKey];
                const category = getToolCategory(name);
                const cmd = extractCommand(input);
                const fileInfo = extractFileInfo(input);
                const queryInfo = extractQuery(input);
                const url = extractUrl(input);
                const isError = result?.isError;
                const isRunning = row.turnIndex === info.activeTurnIndex && !result;

                return (
                  <div key={toolKey} className={`turn-tool-entry${isError ? ' is-error' : ''}`}>
                    <div className="turn-tool-entry-header" onClick={() => toggleToolExpanded(toolKey)}>
                      <div className="turn-tool-header-left">
                        <span className="conv-tool-turn-badge" title={`Turn ${row.turnIndex + 1}`}>
                          T{row.turnIndex + 1}
                        </span>
                        <span className="turn-tool-seq">#{i + 1}</span>
                        <span className={`turn-tool-badge turn-tool-badge--${category}`}>
                          {category === 'command' && '💻'}
                          {category === 'file' && '📝'}
                          {category === 'search' && '🔍'}
                          {category === 'web' && '🌐'}
                          {category === 'generic' && '⚙️'}
                          <span className="turn-tool-badge-text">{name}</span>
                        </span>
                        {isRunning ? (
                          <span className="turn-tool-status turn-tool-status--running">Running...</span>
                        ) : isError ? (
                          <span className="turn-tool-status turn-tool-status--error">Failed</span>
                        ) : result ? (
                          <span className="turn-tool-status turn-tool-status--success">Success</span>
                        ) : null}
                      </div>
                      <div className="turn-tool-header-right">
                        <button
                          type="button"
                          className="turn-tool-expand-btn"
                          aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                        >
                          {isExpanded ? 'Hide Raw Details ▲' : 'Raw Details ▼'}
                        </button>
                      </div>
                    </div>

                    <div className="turn-tool-entry-body">
                      {cmd && (
                        <div className="turn-tool-cmd-box">
                          <pre className="turn-tool-cmd-text"><code>{cmd}</code></pre>
                          <button
                            type="button"
                            className="turn-file-action-btn turn-tool-cmd-copy"
                            onClick={(e) => handleCopyCommand(cmd, i, e)}
                            title="Copy command"
                          >
                            {copiedCmdIndex === i ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                      )}
                      {fileInfo && (
                        <div className="turn-tool-file-box">
                          <span className="turn-tool-file-label">Target File:</span>
                          <LinkifiedPath
                            path={fileInfo.path}
                            startLine={fileInfo.startLine}
                            endLine={fileInfo.endLine}
                            onOpen={onOpenFile}
                          />
                        </div>
                      )}
                      {queryInfo && (
                        <div className="turn-tool-query-box">
                          <span className="turn-tool-query-label">Search Query:</span>
                          <code className="turn-tool-query-pill">{queryInfo.query}</code>
                        </div>
                      )}
                      {url && (
                        <div className="turn-tool-url-box">
                          <span className="turn-tool-url-label">URL:</span>
                          <a href={url} target="_blank" rel="noopener noreferrer" className="turn-tool-url-link">
                            {url}
                          </a>
                        </div>
                      )}
                    </div>

                    {isExpanded && (
                      <div className="turn-tool-expanded-details">
                        {input && Object.keys(input).length > 0 && (
                          <div className="turn-tool-raw-section">
                            <span className="turn-tool-raw-title">Input Parameters</span>
                            <pre className="turn-tool-raw-code">
                              <code>{JSON.stringify(input, null, 2)}</code>
                            </pre>
                          </div>
                        )}
                        {result?.content && (
                          <div className="turn-tool-raw-section">
                            <span className="turn-tool-raw-title">Output Result</span>
                            <pre className="turn-tool-raw-code">
                              <code>
                                {result.content.slice(0, 2000)}
                                {result.content.length > 2000 ? '\n... [truncated]' : ''}
                              </code>
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
