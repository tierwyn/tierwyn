import { useEffect, useState, useMemo } from 'react';
import type { Checkpoint } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { api } from '../api.js';
import { parseGitDiff, type DiffLine } from '../diffParser.js';
import { DiffFileDropdown } from './DiffFileDropdown.js';

interface Props {
  conversationId: string;
  checkpoint: Checkpoint;
  onClose: () => void;
}

const INDICATOR: Record<DiffLine['kind'], string> = {
  insert: '+',
  delete: '−',
  unchanged: ' ',
  hunk: ' ',
  meta: ' ',
};

/** Modal that shows a checkpoint's code diff with clear per-file separation and navigation. */
export function CheckpointDiffModal({ conversationId, checkpoint: cp, onClose }: Props) {
  const [diff, setDiff] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(undefined);
    setError(null);
    void api.checkpointCodeDiff(conversationId, cp.id, 'captured')
      .then((d) => { if (!cancelled) setDiff(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [conversationId, cp.id]);

  const parsed = useMemo(() => parseGitDiff(diff), [diff]);
  const { files, totalAdditions, totalDeletions } = parsed;

  const previewText = cp.promptPreview ? cp.promptPreview.replace(/\s+/g, ' ').trim() : '';
  const titleHint = previewText.slice(0, 60)
    || cp.label
    || (cp.turnIndex != null ? `Turn ${cp.turnIndex}` : '');
  const title = titleHint ? `Checkpoint diff — ${titleHint}` : 'Checkpoint diff (captured)';

  const allCollapsed = files.length > 0 && files.every((f) => collapsedFiles[f.id]);

  const toggleAll = () => {
    if (allCollapsed) {
      setCollapsedFiles({});
    } else {
      const next: Record<string, boolean> = {};
      for (const f of files) next[f.id] = true;
      setCollapsedFiles(next);
    }
  };

  const toggleFile = (id: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const scrollToFile = (fileId: string) => {
    if (fileId === '__top__') {
      setSelectedFileId(null);
      const container = document.querySelector('.diff-files-container');
      container?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (collapsedFiles[fileId]) {
      setCollapsedFiles((prev) => ({ ...prev, [fileId]: false }));
    }
    setSelectedFileId(fileId);
    requestAnimationFrame(() => {
      const el = document.getElementById(`diff-file-${fileId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <Modal title={title} onClose={onClose} className="checkpoint-diff-modal">
      <div className="checkpoint-diff-viewer">
        {diff === undefined && !error && (
          <div className="checkpoint-diff-state">Loading diff…</div>
        )}
        {error && (
          <div className="checkpoint-diff-state checkpoint-diff-state--error">
            Failed to load diff: {error}
          </div>
        )}
        {diff !== undefined && diff !== null && files.length === 0 && !error && (
          <div className="checkpoint-diff-state">No code changes in this checkpoint.</div>
        )}
        {diff === null && !error && (
          <div className="checkpoint-diff-state">This checkpoint has no code snapshot.</div>
        )}

        {files.length > 0 && (
          <>
            <div className="diff-summary-bar">
              <div className="diff-summary-left">
                <span className="diff-checkpoint-tag">
                  {cp.label ?? (cp.kind === 'auto' ? 'Auto checkpoint' : 'Manual checkpoint')}
                </span>
                <span className="diff-summary-file-count">
                  {files.length} {files.length === 1 ? 'file' : 'files'} changed
                </span>
              </div>
              <div className="diff-summary-right">
                {files.length > 1 && (
                  <button
                    type="button"
                    className="diff-fold-toggle-btn"
                    onClick={toggleAll}
                  >
                    {allCollapsed ? 'Expand all' : 'Collapse all'}
                  </button>
                )}
                <span className="diff-stats-badge">
                  <span className="diff-stat-added">+{totalAdditions}</span>
                  <span className="diff-stat-removed">−{totalDeletions}</span>
                </span>
              </div>
            </div>

            {files.length > 1 && (
              <DiffFileDropdown
                files={files}
                selectedFileId={selectedFileId}
                onSelectFile={scrollToFile}
                collapsedFiles={collapsedFiles}
              />
            )}

            <div className="diff-files-container">
              {files.map((file) => {
                const isCollapsed = !!collapsedFiles[file.id];
                const isSelected = file.id === selectedFileId;
                return (
                  <div
                    key={file.id}
                    id={`diff-file-${file.id}`}
                    className={`diff-file-section ${isCollapsed ? 'is-collapsed' : ''} ${isSelected ? 'is-selected-focus' : ''}`}
                  >
                    <div
                      className="diff-file-header-bar"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        toggleFile(file.id);
                        setSelectedFileId(file.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleFile(file.id);
                          setSelectedFileId(file.id);
                        }
                      }}
                      title={isCollapsed ? 'Click to expand file diff' : 'Click to collapse file diff'}
                    >
                      <div className="diff-file-header-left">
                        <span className={`diff-file-chevron ${isCollapsed ? 'is-collapsed' : ''}`}>
                          {isCollapsed ? '▸' : '▾'}
                        </span>
                        <svg className="diff-file-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="16" y1="13" x2="8" y2="13" />
                          <line x1="16" y1="17" x2="8" y2="17" />
                          <polyline points="10 9 9 9 8 9" />
                        </svg>
                        <span className="diff-file-path-wrapper">
                          {file.displayDir && <span className="diff-file-dir">{file.displayDir}</span>}
                          <span className="diff-file-basename">{file.displayName}</span>
                        </span>
                        <span className={`diff-badge ${file.status}`}>{file.status}</span>
                      </div>
                      <div className="diff-file-header-right">
                        <span className="diff-stats-badge">
                          <span className="diff-stat-added">+{file.additions}</span>
                          <span className="diff-stat-removed">−{file.deletions}</span>
                        </span>
                        <span className="diff-file-toggle-hint">
                          {isCollapsed ? 'Expand' : 'Collapse'}
                        </span>
                      </div>
                    </div>

                    {!isCollapsed && (
                      <div className="diff-file-body">
                        {file.metaNotes && file.metaNotes.length > 0 && (
                          <div className="diff-file-meta-bar">
                            {file.metaNotes.map((note, idx) => (
                              <span key={idx} className="diff-file-meta-note">{note}</span>
                            ))}
                          </div>
                        )}
                        {file.binary ? (
                          <div className="diff-file-notice">Binary file — diff not available</div>
                        ) : file.lines.length === 0 ? (
                          <div className="diff-file-notice">
                            {file.status === 'created'
                              ? 'Empty file created'
                              : file.status === 'deleted'
                                ? 'Empty file deleted'
                                : 'No text content changes'}
                          </div>
                        ) : (
                          <pre className="diff-pre">
                            <div className="diff-lines-container">
                              {file.lines.map((l, i) => (
                                <div key={i} className={`diff-line diff-line-${l.kind}`}>
                                  <span className="diff-indicator">{INDICATOR[l.kind]}</span>
                                  <span className="diff-text">{l.text || '\u00A0'}</span>
                                </div>
                              ))}
                            </div>
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
