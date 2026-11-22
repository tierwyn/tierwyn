import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { compileFindMatcher, type FindMode, type FindOccurrence } from '../transcriptFind.js';

const MAX_VISIBLE_RESULTS = 500;

export interface TranscriptFindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  results: readonly FindOccurrence[];
  activeIndex: number;
  onSelectIndex: (idx: number) => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
  inputRef: Ref<HTMLInputElement>;
  hasMore?: boolean;
  onLoadAll?: () => void;
  loadingAll?: boolean;
  loadingEarlier?: boolean;
  mode?: FindMode;
  onModeChange?: (mode: FindMode) => void;
  caseSensitive?: boolean;
  onCaseSensitiveChange?: (on: boolean) => void;
}

export function TranscriptFindBar({
  query,
  onQueryChange,
  results,
  activeIndex,
  onSelectIndex,
  onStep,
  onClose,
  inputRef,
  hasMore,
  onLoadAll,
  loadingAll,
  loadingEarlier,
  mode = 'substring',
  onModeChange,
  caseSensitive = false,
  onCaseSensitiveChange,
}: TranscriptFindBarProps) {
  const [listOpen, setListOpen] = useState(true);
  const prevQuery = useRef(query);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const matcher = useMemo(
    () => compileFindMatcher(query, { mode, caseSensitive }),
    [query, mode, caseSensitive],
  );
  const regexError = mode === 'regex' ? matcher.error : undefined;

  const toggleMode = (next: 'words' | 'regex') => {
    onModeChange?.(mode === next ? 'substring' : next);
  };

  useEffect(() => {
    if (!prevQuery.current.trim() && query.trim()) setListOpen(true);
    prevQuery.current = query;
  }, [query]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const showList = listOpen && query.trim().length > 0;
  const visible = results.slice(0, MAX_VISIBLE_RESULTS);

  return (
    <div className="transcript-find-wrap">
      <div className="transcript-find" role="search" aria-label="Find in transcript">
        <input
          ref={inputRef}
          className={`transcript-find-input${regexError ? ' is-error' : ''}`}
          type="text"
          placeholder="Find in transcript"
          value={query}
          aria-invalid={regexError ? true : undefined}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === 'ArrowDown' && results.length > 0) {
              e.preventDefault();
              onStep(1);
            } else if (e.key === 'ArrowUp' && results.length > 0) {
              e.preventDefault();
              onStep(-1);
            }
          }}
        />
        {onModeChange && (
          <button
            type="button"
            className={`transcript-find-toggle${mode === 'words' ? ' active' : ''}`}
            title="Match all words (space-separated)"
            aria-pressed={mode === 'words'}
            onClick={() => toggleMode('words')}
          >
            All
          </button>
        )}
        {onModeChange && (
          <button
            type="button"
            className={`transcript-find-toggle${mode === 'regex' ? ' active' : ''}`}
            title="Regular expression"
            aria-pressed={mode === 'regex'}
            onClick={() => toggleMode('regex')}
          >
            .*
          </button>
        )}
        {onCaseSensitiveChange && (
          <button
            type="button"
            className={`transcript-find-toggle${caseSensitive ? ' active' : ''}`}
            title="Match case"
            aria-pressed={caseSensitive}
            onClick={() => onCaseSensitiveChange(!caseSensitive)}
          >
            Aa
          </button>
        )}
        {regexError && (
          <span className="transcript-find-error" title={regexError}>!</span>
        )}
        <span className="transcript-find-count">
          {results.length === 0 ? '0/0' : `${activeIndex + 1}/${results.length}`}
        </span>
        {hasMore && onLoadAll && (
          <span className="transcript-find-hasmore">
            Searching loaded history —{' '}
            <button
              type="button"
              className="transcript-find-loadall-btn"
              onClick={onLoadAll}
              disabled={loadingEarlier || loadingAll}
            >
              {loadingAll ? 'Loading…' : 'Load all'}
            </button>
          </span>
        )}
        <button
          type="button"
          className="action-icon-btn"
          title={listOpen ? 'Hide matches' : 'Show matches'}
          aria-expanded={showList}
          onClick={() => setListOpen((v) => !v)}
        >
          {listOpen ? '▴' : '▾'}
        </button>
        <button type="button" className="action-icon-btn" title="Previous match (Shift+Enter)" onClick={() => onStep(-1)}>↑</button>
        <button type="button" className="action-icon-btn" title="Next match (Enter)" onClick={() => onStep(1)}>↓</button>
        <button type="button" className="action-icon-btn" title="Close (Esc)" onClick={onClose}>×</button>
      </div>
      {showList && (
        <div className="transcript-find-results" role="listbox" aria-label="Search matches">
          {results.length === 0 && (
            <div className="transcript-find-empty">
              {regexError ? (
                <span className="transcript-find-error">{regexError}</span>
              ) : (
                <>
                  No matches in loaded transcript
                  {hasMore && onLoadAll && (
                    <>
                      {' — '}
                      <button
                        type="button"
                        className="transcript-find-loadall-btn"
                        onClick={onLoadAll}
                        disabled={loadingEarlier || loadingAll}
                      >
                        {loadingAll ? 'Loading…' : 'Load all'}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          )}
          {visible.map((occ, i) => (
            <button
              key={occ.id}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              className={`transcript-find-row${i === activeIndex ? ' transcript-find-row--active' : ''}`}
              ref={i === activeIndex ? activeRowRef : undefined}
              onClick={() => {
                onSelectIndex(i);
                if (window.innerWidth <= 600) setListOpen(false);
              }}
            >
              <span className="transcript-find-row-meta">
                <span>#{i + 1}</span>
                <span className="transcript-find-role">{occ.role === 'user' ? 'You' : 'Agent'}</span>
                <span>Turn {occ.turnNumber}</span>
              </span>
              <span className="transcript-find-snippet">
                {occ.snippetBefore}
                <mark className="transcript-find-hit">{occ.matchText}</mark>
                {occ.snippetAfter}
              </span>
            </button>
          ))}
          {results.length > MAX_VISIBLE_RESULTS && (
            <div className="transcript-find-empty">
              Showing first {MAX_VISIBLE_RESULTS} of {results.length} matches — refine query to narrow
            </div>
          )}
        </div>
      )}
    </div>
  );
}
