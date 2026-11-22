import { useState, useRef, useEffect, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import type { ParsedDiffFile } from '../diffParser.js';

interface Props {
  files: ParsedDiffFile[];
  selectedFileId: string | null;
  onSelectFile: (fileId: string) => void;
  collapsedFiles?: Record<string, boolean>;
}

export function filterDiffFiles(files: ParsedDiffFile[], query: string): ParsedDiffFile[] {
  if (!query.trim()) return files;
  const q = query.trim().toLowerCase();
  return files.filter((f) => f.filePath.toLowerCase().includes(q));
}

export function highlightTextMatch(text: string, query: string): ReactNode {
  if (!query.trim()) return text;
  const q = query.trim().toLowerCase();
  const lowerText = text.toLowerCase();
  const matchIdx = lowerText.indexOf(q);
  if (matchIdx === -1) return text;

  const parts: ReactNode[] = [];
  let current = 0;
  let pos = matchIdx;

  while (pos !== -1) {
    if (pos > current) {
      parts.push(text.slice(current, pos));
    }
    parts.push(
      <mark key={pos} className="diff-search-match">
        {text.slice(pos, pos + q.length)}
      </mark>
    );
    current = pos + q.length;
    pos = lowerText.indexOf(q, current);
  }

  if (current < text.length) {
    parts.push(text.slice(current));
  }

  return <>{parts}</>;
}

export function DiffFileDropdown({ files, selectedFileId, onSelectFile, collapsedFiles }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const selectedFile = useMemo(
    () => files.find((f) => f.id === selectedFileId),
    [files, selectedFileId]
  );

  const filteredFiles = useMemo(
    () => filterDiffFiles(files, searchQuery),
    [files, searchQuery]
  );

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [isOpen]);

  // When opening: reset search query, focus input, pre-highlight selected file
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      const initialIdx = selectedFileId ? files.findIndex((f) => f.id === selectedFileId) : 0;
      setHighlightedIndex(initialIdx >= 0 ? initialIdx : 0);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen, files, selectedFileId]);

  // Keep highlighted item in view inside scrollable list
  useEffect(() => {
    if (isOpen && itemRefs.current[highlightedIndex]) {
      itemRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, highlightedIndex]);

  const handlePick = (fileId: string) => {
    setIsOpen(false);
    onSelectFile(fileId);
  };

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, filteredFiles.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filteredFiles[highlightedIndex];
      if (target) {
        handlePick(target.id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    }
  };

  const handleTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsOpen(true);
    }
  };

  return (
    <div className="diff-file-dropdown-container" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`diff-file-dropdown-trigger${isOpen ? ' is-open' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title="Search and jump to file in diff"
      >
        <div className="diff-file-dropdown-trigger-left">
          <svg className="diff-dropdown-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          {selectedFile ? (
            <span className="diff-dropdown-selected-file">
              <span className="diff-dropdown-prefix">Jump to:</span>
              {selectedFile.displayDir && <span className="diff-dropdown-dir">{selectedFile.displayDir}</span>}
              <span className="diff-dropdown-name">{selectedFile.displayName}</span>
              <span className={`diff-badge ${selectedFile.status}`}>{selectedFile.status}</span>
            </span>
          ) : (
            <span className="diff-dropdown-placeholder">
              Jump to file… ({files.length} changed {files.length === 1 ? 'file' : 'files'})
            </span>
          )}
        </div>
        <div className="diff-file-dropdown-trigger-right">
          {selectedFile ? (
            <span className="diff-stats-badge">
              <span className="diff-stat-added">+{selectedFile.additions}</span>
              <span className="diff-stat-removed">−{selectedFile.deletions}</span>
            </span>
          ) : (
            <span className="diff-dropdown-count-pill">{files.length} files</span>
          )}
          <span className="diff-dropdown-chevron" aria-hidden="true">▾</span>
        </div>
      </button>

      {isOpen && (
        <div className="diff-file-dropdown-panel" role="listbox">
          <div className="diff-dropdown-search-row">
            <span className="diff-dropdown-search-icon" aria-hidden="true">🔍</span>
            <input
              ref={searchInputRef}
              type="text"
              className="diff-dropdown-search-input"
              placeholder="Filter files by name or path…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setHighlightedIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
            />
            {searchQuery && (
              <button
                type="button"
                className="diff-dropdown-search-clear"
                onClick={() => {
                  setSearchQuery('');
                  setHighlightedIndex(0);
                  searchInputRef.current?.focus();
                }}
                title="Clear filter"
                aria-label="Clear filter"
              >
                ✕
              </button>
            )}
          </div>

          <div className="diff-dropdown-list">
            {!searchQuery.trim() && (
              <div
                className="diff-dropdown-item diff-dropdown-item--top"
                onClick={() => handlePick('__top__')}
              >
                <div className="diff-dropdown-item-left">
                  <span className="diff-dropdown-top-icon" aria-hidden="true">↑</span>
                  <span className="diff-dropdown-item-name">Top of diff (all files)</span>
                </div>
                <div className="diff-dropdown-item-right">
                  <span className="diff-dropdown-shortcuts">Scroll to top</span>
                </div>
              </div>
            )}

            {filteredFiles.length === 0 ? (
              <div className="diff-dropdown-empty">
                No files matching "{searchQuery}"
              </div>
            ) : (
              filteredFiles.map((file, idx) => {
                const isSelected = file.id === selectedFileId;
                const isHighlighted = idx === highlightedIndex;
                const isCollapsed = collapsedFiles ? !!collapsedFiles[file.id] : false;
                return (
                  <div
                    key={file.id}
                    ref={(el) => { itemRefs.current[idx] = el; }}
                    role="option"
                    aria-selected={isSelected}
                    className={`diff-dropdown-item${isHighlighted ? ' is-highlighted' : ''}${isSelected ? ' is-selected' : ''}`}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    onClick={() => handlePick(file.id)}
                  >
                    <div className="diff-dropdown-item-left">
                      <span className={`diff-badge ${file.status}`}>{file.status}</span>
                      <div className="diff-dropdown-item-path" title={file.filePath}>
                        {file.displayDir && (
                          <span className="diff-dropdown-item-dir">
                            {highlightTextMatch(file.displayDir, searchQuery)}
                          </span>
                        )}
                        <span className="diff-dropdown-item-name">
                          {highlightTextMatch(file.displayName, searchQuery)}
                        </span>
                      </div>
                    </div>
                    <div className="diff-dropdown-item-right">
                      {isCollapsed && (
                        <span className="diff-dropdown-item-folded" title="Diff is currently collapsed">
                          folded
                        </span>
                      )}
                      <span className="diff-stats-badge">
                        <span className="diff-stat-added">+{file.additions}</span>
                        <span className="diff-stat-removed">−{file.deletions}</span>
                      </span>
                      {isSelected && <span className="diff-dropdown-check" title="Currently viewed">✓</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="diff-dropdown-footer">
            <span>
              Showing {filteredFiles.length} of {files.length} {files.length === 1 ? 'file' : 'files'}
            </span>
            <span className="diff-dropdown-shortcuts">↑↓ navigate · Enter jump · Esc close</span>
          </div>
        </div>
      )}
    </div>
  );
}
