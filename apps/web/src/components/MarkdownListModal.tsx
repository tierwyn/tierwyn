import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { fetchFileText } from '../api.js';
import { wrapPaletteIndex } from '../commandPalette.js';
import { highlightTextMatch } from './DiffFileDropdown.js';
import {
  fileBasename,
  filterMarkdownList,
  markdownPreview,
  type MarkdownContentMap,
} from '../markdownListSearch.js';

interface Props {
  paths: string[];
  conversationId?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/**
 * Lists markdown (.md / .markdown) paths mentioned in the current conversation.
 * Selecting a row opens the existing FileModal. Reachable from the options
 * dropdown next to Summaries / Recordings.
 */
export function MarkdownListModal({ paths, conversationId, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [contents, setContents] = useState<MarkdownContentMap>({});
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    if (paths.length === 0) return;
    void Promise.all(paths.map(async (path) => {
      try {
        const text = await fetchFileText(path, conversationId);
        if (!cancelled) setContents((prev) => (prev[path] === undefined ? { ...prev, [path]: text } : prev));
      } catch {
        if (!cancelled) setContents((prev) => (prev[path] === undefined ? { ...prev, [path]: '' } : prev));
      }
    }));
    return () => { cancelled = true; };
  }, [paths, conversationId]);

  const filtered = useMemo(
    () => filterMarkdownList(paths, query, contents),
    [paths, query, contents],
  );

  const contentsPending = paths.some((path) => contents[path] === undefined);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    setHighlighted((h) => {
      if (filtered.length === 0) return 0;
      if (h < 0) return 0;
      return Math.min(h, filtered.length - 1);
    });
  }, [filtered.length]);

  useEffect(() => {
    itemRefs.current[highlighted]?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, filtered]);

  const activate = useCallback((path: string) => {
    onSelect(path);
  }, [onSelect]);

  const onDialogKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setHighlighted((h) => wrapPaletteIndex(h, 1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setHighlighted((h) => wrapPaletteIndex(h, -1, filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const target = filtered[highlighted];
      if (target) activate(target);
    }
  };

  const emptyMessage = paths.length === 0
    ? 'No markdown files mentioned in this conversation yet.'
    : query.trim()
      ? `No files match “${query.trim()}”.`
      : 'No markdown files mentioned in this conversation yet.';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content summary-list-modal markdown-list-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Markdown files"
      >
        <div className="modal-header modal-header--with-close markdown-list-header">
          <div className="markdown-list-title">
            <span>Markdown</span>
            {paths.length > 0 && (
              <span className="markdown-list-count">
                {query.trim() ? `${filtered.length} / ${paths.length}` : paths.length}
              </span>
            )}
          </div>
          <div className="markdown-list-header-actions">
            <kbd className="command-palette-esc-hint" onClick={onClose} title="Close">esc</kbd>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="markdown-list-search">
          <svg
            className="markdown-list-search-icon"
            width="15"
            height="15"
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
            type="search"
            className="markdown-list-search-input"
            placeholder="Filter by name or contents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="markdown-list-results"
            aria-autocomplete="list"
            aria-activedescendant={filtered[highlighted] ? `markdown-list-opt-${highlighted}` : undefined}
            aria-label="Filter markdown files"
          />
          {contentsPending && query.trim() !== '' && (
            <span className="command-palette-spinner" title="Searching file contents…" />
          )}
          {query && (
            <button
              type="button"
              className="markdown-list-search-clear"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              aria-label="Clear filter"
              title="Clear filter"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        <div className="summary-list-body">
          {filtered.length === 0 ? (
            <div className="summary-list-empty">{emptyMessage}</div>
          ) : (
            <ul className="summary-list" id="markdown-list-results" role="listbox" aria-label="Markdown files">
              {filtered.map((path, i) => {
                const body = contents[path];
                const preview = typeof body === 'string' ? markdownPreview(body, query) : null;
                const isActive = i === highlighted;
                return (
                  <li key={path}>
                    <button
                      type="button"
                      id={`markdown-list-opt-${i}`}
                      ref={(el) => { itemRefs.current[i] = el; }}
                      className={`summary-list-row markdown-list-row${isActive ? ' is-active' : ''}`}
                      role="option"
                      aria-selected={isActive}
                      onClick={() => activate(path)}
                      onMouseEnter={() => setHighlighted(i)}
                    >
                      <div className="summary-list-row-head">
                        <span className="summary-list-route markdown-list-name">
                          {highlightTextMatch(fileBasename(path), query)}
                        </span>
                      </div>
                      <div className="summary-list-preview markdown-list-path">
                        {highlightTextMatch(path, query)}
                      </div>
                      {preview && (
                        <div className="markdown-list-excerpt">
                          {highlightTextMatch(preview, query)}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
