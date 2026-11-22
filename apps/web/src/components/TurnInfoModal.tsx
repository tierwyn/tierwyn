import { copyText } from '../clipboard';
import { useState, useMemo, useCallback, type ReactNode } from 'react';
import { Modal } from './Modal.js';
import {
  DiffViewer,
  computeDiff,
  extractDiffPairFromToolInput,
  toolInputFilePath,
} from './ToolInputDisplay.js';
import { splitPath } from './gitStatusBadge.js';
import { formatElapsedMs } from '@tierwyn/shared';
import type { PromptTurn } from '../groupTurns.js';
import type { StatusEvent, ToolCallEvent, ToolResultEvent, FileChangeEvent, PromptEvent } from '@tierwyn/shared';
import { formatCachedTokens } from '../conversationInfo.js';
import { FILE_EDIT_EMPTY_RESULT, isFileEditToolName } from './EventItem.js';

export { extractDiffPairFromToolInput } from './ToolInputDisplay.js';

/**
 * Resolve the tool_call input for a file_change: prefer toolUseId, then fall
 * back to path match within the same turn (Cursor historically omits
 * toolUseId on file_change even though the sibling tool_call has one).
 */
export function resolveFileChangeToolInput(
  file: { path: string; toolUseId?: string },
  toolInputByUseId: Map<string, Record<string, unknown>>,
  toolInputByPath: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (file.toolUseId) {
    const byId = toolInputByUseId.get(file.toolUseId);
    if (byId) return byId;
  }
  return toolInputByPath.get(file.path);
}

export interface ExtractedFileInfo {
  path: string;
  startLine?: number;
  endLine?: number;
  instruction?: string;
  description?: string;
}

export function extractFileInfo(input: unknown): ExtractedFileInfo | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const rawPath = rec.TargetFile ?? rec.AbsolutePath ?? rec.path ?? rec.filePath ?? rec.file_path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;

  const startLine = typeof rec.StartLine === 'number' ? rec.StartLine : undefined;
  const endLine = typeof rec.EndLine === 'number' ? rec.EndLine : undefined;
  const instruction = typeof rec.Instruction === 'string' && rec.Instruction.trim() ? rec.Instruction.trim() : undefined;
  const description = typeof rec.Description === 'string' && rec.Description.trim() ? rec.Description.trim() : undefined;

  return {
    path: rawPath.trim(),
    startLine,
    endLine,
    instruction,
    description,
  };
}

export function extractCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const cmd = rec.CommandLine ?? rec.command ?? rec.cmd;
  if (typeof cmd === 'string' && cmd.trim()) return cmd.trim();
  return null;
}

export function extractQuery(input: unknown): { query: string; path?: string } | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const q = rec.Query ?? rec.query ?? rec.Pattern ?? rec.pattern;
  if (typeof q === 'string' && q.trim()) {
    const searchPath = rec.SearchPath ?? rec.SearchDirectory;
    return {
      query: q.trim(),
      path: typeof searchPath === 'string' ? searchPath.trim() : undefined,
    };
  }
  return null;
}

export function extractUrl(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const u = rec.Url ?? rec.url ?? rec.uri ?? rec.Uri;
  if (typeof u === 'string' && u.trim().startsWith('http')) return u.trim();
  return null;
}

export function summarizeToolInput(name?: string, input?: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const cmd = extractCommand(input);
  if (cmd) return cmd;
  const fileInfo = extractFileInfo(input);
  if (fileInfo) return fileInfo.path;
  const q = extractQuery(input);
  if (q) return q.query;
  const url = extractUrl(input);
  if (url) return url;
  const rec = input as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && v.trim()) {
      return `${k}: ${v.slice(0, 50)}`;
    }
  }
  return '';
}

export function getToolCategory(toolName: string): 'command' | 'file' | 'search' | 'web' | 'generic' {
  const lower = toolName.toLowerCase();
  if (lower.includes('command') || lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) {
    return 'command';
  }
  if (lower.includes('file') || lower.includes('write') || lower.includes('replace') || lower.includes('edit')) {
    return 'file';
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
    return 'search';
  }
  if (lower.includes('url') || lower.includes('web') || lower.includes('browser') || lower.includes('fetch')) {
    return 'web';
  }
  return 'generic';
}

interface LinkifiedPathProps {
  path: string;
  startLine?: number;
  endLine?: number;
  onOpen?: (path: string) => void;
  title?: string;
  /** Extra controls on the meta row under the filename (e.g. +/- and Show Diff). */
  trailing?: ReactNode;
}

export function LinkifiedPath({ path, startLine, endLine, onOpen, title, trailing }: LinkifiedPathProps) {
  const [copied, setCopied] = useState(false);
  const { dir, file } = splitPath(path);
  const lineSuffix = startLine != null
    ? endLine != null && endLine !== startLine
      ? `:${startLine}-${endLine}`
      : `:${startLine}`
    : '';

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    copyText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [path]);

  const handleOpen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen?.(path);
  }, [onOpen, path]);

  return (
    <div className="turn-file-link-group" title={title || path}>
      <button
        type="button"
        className="turn-file-link-btn"
        onClick={handleOpen}
        title={onOpen ? `Open ${path}${lineSuffix} in file reader` : path}
      >
        <svg className="turn-file-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span className="turn-file-path-text">
          {dir && <span className="turn-file-dir">{dir}</span>}
          <span className="turn-file-basename">{file}</span>
          {lineSuffix && <span className="turn-file-lines">{lineSuffix}</span>}
        </span>
      </button>
      <div className="turn-file-meta-row">
        <div className="turn-file-actions">
          {onOpen && (
            <button
              type="button"
              className="turn-file-action-btn"
              onClick={handleOpen}
              title={`Preview ${file}`}
              aria-label={`Open ${file}`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              <span>Open</span>
            </button>
          )}
          <button
            type="button"
            className="turn-file-action-btn"
            onClick={handleCopy}
            title={copied ? 'Copied path!' : 'Copy full file path'}
            aria-label="Copy file path"
          >
            {copied ? (
              <>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--green, #10b981)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span style={{ color: 'var(--green, #10b981)' }}>Copied</span>
              </>
            ) : (
              <>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        {trailing}
      </div>
    </div>
  );
}

export interface TurnInfoModalProps {
  turn: PromptTurn;
  agentModel?: string;
  elapsedMs?: number | null;
  cumulativeMs?: number | null;
  isTurnActive?: boolean;
  onOpenFile?: (path: string, gallery?: string[]) => void;
  onClose: () => void;
}

export function TurnInfoModal({
  turn,
  agentModel,
  elapsedMs,
  cumulativeMs,
  isTurnActive = false,
  onOpenFile,
  onClose,
}: TurnInfoModalProps) {
  const [activeTab, setActiveTab] = useState<'all' | 'tools' | 'files' | 'overview'>('all');
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [expandedFileDiffs, setExpandedFileDiffs] = useState<Record<string, boolean>>({});
  const [copiedCmdIndex, setCopiedCmdIndex] = useState<number | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Group tool calls & results; index tool inputs so file_change rows can show diffs
  const { toolCalls, toolResultsByUseId, toolInputByUseId, toolInputByPath, fileChanges, statusEvent } = useMemo(() => {
    const calls: { event: ToolCallEvent; index: number }[] = [];
    const results = new Map<string, ToolResultEvent['payload']>();
    const inputs = new Map<string, Record<string, unknown>>();
    const byPath = new Map<string, Record<string, unknown>>();
    const files: FileChangeEvent['payload'][] = [];
    let statusEv: StatusEvent | undefined;

    turn.events.forEach((m, idx) => {
      if (m.event.type === 'tool_call') {
        const tc = m.event as ToolCallEvent;
        calls.push({ event: tc, index: idx });
        const input = (tc.payload.input ?? {}) as Record<string, unknown>;
        if (tc.payload.toolUseId) {
          inputs.set(tc.payload.toolUseId, input);
        }
        const path = toolInputFilePath(input);
        if (path) byPath.set(path, input);
      } else if (m.event.type === 'tool_result') {
        const res = m.event as ToolResultEvent;
        if (res.payload.toolUseId) {
          results.set(res.payload.toolUseId, res.payload);
        }
      } else if (m.event.type === 'file_change') {
        const fc = m.event as FileChangeEvent;
        files.push(fc.payload);
      } else if (m.event.type === 'status') {
        const s = m.event as StatusEvent;
        if (
          !statusEv ||
          s.payload.inputTokens != null ||
          s.payload.cacheReadTokens != null ||
          s.payload.cacheCreationTokens != null ||
          s.payload.costUsd != null ||
          s.payload.status === 'done' ||
          s.payload.status === 'error'
        ) {
          statusEv = s;
        }
      }
    });

    return {
      toolCalls: calls,
      toolResultsByUseId: results,
      toolInputByUseId: inputs,
      toolInputByPath: byPath,
      fileChanges: files,
      statusEvent: statusEv,
    };
  }, [turn.events]);

  const fileRows = useMemo(() => {
    return fileChanges.map((f, idx) => {
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
      return { f, idx, fileKey: `${f.path}-${idx}`, linkedInput, diffPair, additions, deletions };
    });
  }, [fileChanges, toolInputByUseId, toolInputByPath]);

  const totalAdditions = useMemo(
    () => fileRows.reduce((sum, r) => sum + (r.additions || 0), 0),
    [fileRows]
  );
  const totalDeletions = useMemo(
    () => fileRows.reduce((sum, r) => sum + (r.deletions || 0), 0),
    [fileRows]
  );

  const cachedTurnHint = useMemo(() => {
    if (!statusEvent) return null;
    return formatCachedTokens(
      statusEvent.payload.cacheReadTokens,
      statusEvent.payload.cacheCreationTokens,
    );
  }, [statusEvent]);

  const startedAt = turn.prompt?.event.ts ?? turn.events[0]?.event.ts;
  const startedTimeStr = startedAt ? new Date(startedAt).toLocaleTimeString() : undefined;
  const startedDateStr = startedAt ? new Date(startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : undefined;

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

  const handleCopyPrompt = useCallback((text: string) => {
    copyText(text);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 1600);
  }, []);

  const promptText = (turn.prompt?.event as PromptEvent | undefined)?.payload?.text?.trim() || '';

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
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span className="turn-modal-title-text">Turn Information</span>
        </span>
      }
      onClose={onClose}
      className="turn-info-modal"
      headerActions={
        <div className="turn-modal-header-badges">
          {agentModel && (
            <span className="turn-modal-badge turn-modal-badge--agent" title={`Agent profile: ${agentModel}`}>
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
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <circle cx="12" cy="5" r="2" />
                <path d="M12 7v4" />
                <line x1="8" y1="16" x2="8" y2="16.01" />
                <line x1="16" y1="16" x2="16.01" y2="16.01" />
              </svg>
              <span className="turn-modal-badge-text">{agentModel}</span>
            </span>
          )}
          {isTurnActive ? (
            <span
              className="turn-modal-badge turn-modal-badge--running"
              title={elapsedMs != null ? `Active turn: running for ${formatElapsedMs(elapsedMs)}` : 'Active turn: running'}
            >
              <span className="turn-status-pulse" />
              <span>Running{elapsedMs != null ? ` ${formatElapsedMs(elapsedMs)}` : ''}</span>
            </span>
          ) : elapsedMs != null ? (
            <span className="turn-modal-badge turn-modal-badge--settled" title={`Turn duration: ${formatElapsedMs(elapsedMs)}`}>
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
              <span>{formatElapsedMs(elapsedMs)}</span>
            </span>
          ) : null}
        </div>
      }
      subHeader={
        <div className="turn-modal-subnav">
          <div className="turn-modal-tab-bar" role="tablist" aria-label="Turn information sections">
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
              aria-selected={activeTab === 'tools'}
              className={`turn-modal-tab${activeTab === 'tools' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('tools')}
            >
              <span className="turn-tab-label">Tools</span>
              <span
                className="turn-tab-count"
                title={`${toolCalls.length} tool execution${toolCalls.length === 1 ? '' : 's'}`}
              >
                {toolCalls.length}
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
              <span
                className="turn-tab-count"
                title={`${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'} modified`}
              >
                {fileChanges.length}
              </span>
            </button>
          </div>
        </div>
      }
    >

      {/* OVERVIEW SECTION */}
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
              <span className="turn-stat-hint">{isTurnActive ? 'Active Turn' : 'Settled Turn'}</span>
            </div>

            <div className="turn-overview-card">
              <span className="turn-stat-label">Duration</span>
              <span className="turn-stat-value">
                {elapsedMs != null ? formatElapsedMs(elapsedMs) : '—'}
              </span>
              {cumulativeMs != null && (
                <span className="turn-stat-hint">
                  Total session: {formatElapsedMs(cumulativeMs)}
                </span>
              )}
            </div>

            <div className="turn-overview-card">
              <span className="turn-stat-label">Tools Executed</span>
              <span className="turn-stat-value">
                {toolCalls.length}
              </span>
              <span className="turn-stat-hint">
                {toolCalls.length === 0 ? 'No tools invoked' : `${toolCalls.length} total call${toolCalls.length === 1 ? '' : 's'}`}
              </span>
            </div>

            <div className="turn-overview-card">
              <span className="turn-stat-label">Files Modified</span>
              <span className="turn-stat-value">
                {fileChanges.length}
              </span>
              <span className="turn-stat-hint">
                {fileChanges.length > 0 ? (
                  <>
                    <span className="diff-stat-added">+{totalAdditions}</span>{' '}
                    <span className="diff-stat-removed">−{totalDeletions}</span>
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

            {statusEvent && (
              <>
                {(statusEvent.payload.inputTokens != null || statusEvent.payload.outputTokens != null || cachedTurnHint != null) && (
                  <div className="turn-overview-card">
                    <span className="turn-stat-label">Tokens (In / Out)</span>
                    <span className="turn-stat-value">
                      {(statusEvent.payload.inputTokens ?? 0).toLocaleString()} / {(statusEvent.payload.outputTokens ?? 0).toLocaleString()}
                    </span>
                    {cachedTurnHint && (
                      <span className="turn-stat-hint">
                        {cachedTurnHint}
                      </span>
                    )}
                  </div>
                )}
                {statusEvent.payload.costUsd != null && (
                  <div className="turn-overview-card">
                    <span className="turn-stat-label">Estimated Cost</span>
                    <span className="turn-stat-value">
                      ${statusEvent.payload.costUsd.toFixed(4)}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {promptText && (
            <div className="turn-prompt-preview-card">
              <div className="turn-prompt-preview-header">
                <span className="turn-stat-label">User Prompt</span>
                <button
                  type="button"
                  className="turn-file-action-btn"
                  onClick={() => handleCopyPrompt(promptText)}
                >
                  {copiedPrompt ? 'Copied' : 'Copy Prompt'}
                </button>
              </div>
              <div className="turn-prompt-preview-body">{promptText}</div>
            </div>
          )}
        </div>
      )}

      {/* FILES CHANGED SECTION */}
      {(activeTab === 'all' || activeTab === 'files') && (
        <div className="turn-modal-section">
          <div className="turn-modal-section-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>Files Modified ({fileChanges.length})</span>
            {fileChanges.length > 0 && (
              <span className="turn-modal-diff-summary">
                <span className="diff-stat-added">+{totalAdditions}</span>
                <span className="diff-stat-removed">−{totalDeletions}</span>
              </span>
            )}
          </div>

          {fileRows.length === 0 ? (
            <div className="turn-modal-empty-card">
              No files were modified in this turn.
            </div>
          ) : (
            <div className="turn-files-card-list">
              {fileRows.map(({ f, fileKey, diffPair, additions, deletions }) => {
                const kindBadge = f.kind === 'created' ? '+' : f.kind === 'deleted' ? 'D' : 'M';
                const kindTitle = f.kind === 'created' ? 'Created' : f.kind === 'deleted' ? 'Deleted' : 'Modified';
                const diffExpanded = !!expandedFileDiffs[fileKey];

                return (
                  <div key={fileKey} className="turn-file-card">
                    <div className="turn-file-card-row">
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
                              {additions != null && (
                                <span className="diff-stat-added">+{additions}</span>
                              )}
                              {deletions != null && (
                                <span className="diff-stat-removed">−{deletions}</span>
                              )}
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

      {/* TOOL CALLS SECTION */}
      {(activeTab === 'all' || activeTab === 'tools') && (
        <div className="turn-modal-section">
          <div className="turn-modal-section-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span>Tool Executions ({toolCalls.length})</span>
          </div>

          {toolCalls.length === 0 ? (
            <div className="turn-modal-empty-card">
              No tool executions in this turn.
            </div>
          ) : (
            <div className="turn-tools-detailed-list">
              {toolCalls.map(({ event, index }, i) => {
                const { name, input, toolUseId } = event.payload;
                const toolKey = toolUseId || `tool-${index}-${i}`;
                const result = toolUseId ? toolResultsByUseId.get(toolUseId) : undefined;
                const isExpanded = !!expandedTools[toolKey];
                const category = getToolCategory(name);

                const cmd = extractCommand(input);
                const fileInfo = extractFileInfo(input);
                const queryInfo = extractQuery(input);
                const url = extractUrl(input);

                const isError = result?.isError;
                const isRunning = isTurnActive && !result;

                return (
                  <div key={toolKey} className={`turn-tool-entry${isError ? ' is-error' : ''}`}>
                    <div
                      className="turn-tool-entry-header"
                      onClick={() => toggleToolExpanded(toolKey)}
                    >
                      <div className="turn-tool-header-left">
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

                    {/* Primary visual argument area */}
                    <div className="turn-tool-entry-body">
                      {/* Command output */}
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

                      {/* File target */}
                      {fileInfo && (
                        <div className="turn-tool-file-box">
                          <span className="turn-tool-file-label">Target File:</span>
                          <LinkifiedPath
                            path={fileInfo.path}
                            startLine={fileInfo.startLine}
                            endLine={fileInfo.endLine}
                            onOpen={onOpenFile}
                          />
                          {(fileInfo.instruction || fileInfo.description) && (
                            <div className="turn-tool-instruction">
                              {fileInfo.instruction || fileInfo.description}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Search query */}
                      {queryInfo && (
                        <div className="turn-tool-query-box">
                          <span className="turn-tool-query-label">Search Query:</span>
                          <code className="turn-tool-query-pill">{queryInfo.query}</code>
                          {queryInfo.path && (
                            <span className="turn-tool-query-path">in {queryInfo.path}</span>
                          )}
                        </div>
                      )}

                      {/* Web URL */}
                      {url && (
                        <div className="turn-tool-url-box">
                          <span className="turn-tool-url-label">URL:</span>
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="turn-tool-url-link"
                          >
                            {url}
                          </a>
                        </div>
                      )}
                    </div>

                    {/* Collapsible raw parameters & output */}
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
                        {result && (result.content || (!result.isError && isFileEditToolName(name))) && (
                          <div className="turn-tool-raw-section">
                            <span className="turn-tool-raw-title">Output Result</span>
                            <pre className="turn-tool-raw-code">
                              <code>{result.content ? `${result.content.slice(0, 2000)}${result.content.length > 2000 ? '\n... [truncated]' : ''}` : FILE_EDIT_EMPTY_RESULT}</code>
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
