import { copyText } from '../clipboard';
import { type ReactNode, type ComponentPropsWithoutRef, type MouseEvent, createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, Children, isValidElement } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkSmartypants from 'remark-smartypants';
import remarkGithubBlockquoteAlert from 'remark-github-blockquote-alert';
import remarkDirective from 'remark-directive';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { MermaidBlock } from './MermaidBlock.js';
import { AbcBlock } from './AbcBlock.js';
import { FileImage } from './FileImage.js';
import { linkifyPaths } from '../remark/linkifyPaths.js';
import { remarkDirectives } from '../remark/directives.js';
import { rehypeHighlightMatches } from '../highlightMatches.js';
import type { FindOptions } from '../transcriptFind.js';
import { localMarkdownImagePath } from '../markdownPaths.js';
import { isOpenableExtension } from '@tierwyn/shared';
import { useOpenFile, type OpenFileHandler } from '../OpenFileContext.js';

const MdOpenFileContext = createContext<OpenFileHandler | undefined>(undefined);
const MdFileResolveContext = createContext<{ conversationId?: string; projectId?: string }>({});
const MdZoomContext = createContext<(e: MouseEvent<HTMLImageElement>) => void>(() => {});

/**
 * Recursively extract text from a React node tree. Needed because
 * rehype-highlight with `detect: true` tokenises the inside of every code
 * block (including language-mermaid / language-abc, which hljs has no
 * grammar for), turning a plain string child into a nested array of
 * <span> elements. Without this, `.join('')` on the array produces
 * "[object Object],..." and Mermaid/abcjs receive garbage source.
 */
function nodeToText(node: unknown): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return nodeToText(props?.children);
  }
  return '';
}

/**
 * Override <pre> to intercept fenced ```mermaid and ```abc code blocks and
 * render them through dedicated components instead of leaving them as
 * plain <pre><code> blocks. All other languages fall through to the default
 * <pre> so rehype-highlight can apply its spans.
 */
function CodeBlockPre({ children, ...rest }: ComponentPropsWithoutRef<'pre'>) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === 'object' && 'props' in child) {
    const className: string = (child as { props?: { className?: string } }).props?.className ?? '';
    const langMatch = /language-(\w+)/.exec(className);
    const lang = langMatch?.[1]?.toLowerCase();
    const source = nodeToText((child as { props?: { children?: unknown } }).props?.children);
    if (lang === 'mermaid') return <MermaidBlock source={source} />;
    if (lang === 'abc') return <AbcBlock source={source} />;
    return (
      <div className="code-block">
        <button
          type="button"
          className="code-copy-btn"
          aria-label="Copy code"
          onClick={async () => {
            try {
              await copyText(source);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard unavailable */
            }
          }}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green, #10b981)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          )}
        </button>
        <pre {...rest}>{children}</pre>
      </div>
    );
  }
  return <pre {...rest}>{children}</pre>;
}

function MarkdownLink({ href, children, ...rest }: ComponentPropsWithoutRef<'a'> & { 'data-tierwyn-file'?: string }) {
  const handleOpenFile = useContext(MdOpenFileContext);
  const { node: _node, ...cleanRest } = rest as Record<string, unknown>;

  const rawHref = typeof href === 'string' ? href : '';
  let cleanPath = rawHref.trim().replace(/^file:\/{1,3}/i, '/');
  cleanPath = cleanPath.replace(/^\/?localhost\//i, '/');
  cleanPath = cleanPath.split('#')[0].split('?')[0];
  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch {
    /* keep cleanPath */
  }

  const isFileLink =
    typeof href === 'string' && (
      cleanRest['data-tierwyn-file'] === 'true' ||
      /^file:/i.test(rawHref) ||
      /^\/|^~\/|^\.\.?\//.test(cleanPath)
    );

  const extMatch = /\.([a-z0-9]+)$/i.exec(cleanPath);
  const isSupportedExt = extMatch ? isOpenableExtension(extMatch[1].toLowerCase()) : false;

  const looksLikePath =
    typeof href === 'string' &&
    isSupportedExt && (
      /^([~/.]|\/).*$/i.test(cleanPath) ||
      !/^[a-z][a-z0-9+.-]*:|^\/\/|^#|^\//i.test(cleanPath)
    );

  if (isFileLink || looksLikePath) {
    return (
      <a
        {...cleanRest}
        href={href}
        data-tierwyn-file="true"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (handleOpenFile) handleOpenFile(cleanPath);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      {...cleanRest}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }}
    >
      {children}
    </a>
  );
}

function MarkdownImg({ src, alt, ...rest }: ComponentPropsWithoutRef<'img'>) {
  const onZoom = useContext(MdZoomContext);
  const { conversationId, projectId } = useContext(MdFileResolveContext);
  const local = localMarkdownImagePath(src ?? '');
  if (local) {
    return (
      <FileImage
        path={local}
        conversationId={conversationId}
        projectId={projectId}
        alt={alt ?? ''}
        className="md-img"
        onClick={onZoom}
      />
    );
  }
  if (src && /^https?:\/\//i.test(src)) {
    // Security (F6): Remote images are blocked by CSP to prevent data exfiltration. Render as safe link.
    return (
      <span className="md-remote-image-blocked" title="Remote images are blocked to prevent data exfiltration">
        <a href={src} target="_blank" rel="noreferrer noopener">
          🖼️ {alt || src}
        </a>
      </span>
    );
  }
  return (
    <img
      {...rest}
      src={src}
      alt={alt ?? ''}
      className="md-img"
      onClick={onZoom}
    />
  );
}

const BLOCK_TAGS = new Set(['ul', 'ol', 'p', 'div', 'pre', 'blockquote', 'table']);

function isBlockElement(el: unknown): boolean {
  if (!isValidElement(el)) return false;
  if (typeof el.type === 'string') return BLOCK_TAGS.has(el.type.toLowerCase());
  if (el.type === MarkdownUl || el.type === MarkdownOl || el.type === CodeBlockPre) return true;
  return false;
}

function MarkdownLi({ node: _node, children, ...rest }: ComponentPropsWithoutRef<'li'> & { node?: unknown }) {
  // react-markdown / mdast-util-to-hast injects whitespace-only text nodes
  // (like '\n') around block elements inside <li>. Under CSS white-space: pre-wrap,
  // that '\n' causes the list marker (e.g. "1.") to break onto its own line
  // above the item content, and trailing '\n' before/after nested <ul>/<ol>
  // creates empty blank lines. Cleaning newlines around block elements prevents this.
  const arr = Children.toArray(children);
  const cleanChildren: ReactNode[] = [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (typeof c === 'string') {
      const prev = arr[i - 1];
      const next = arr[i + 1];
      const isNextBlock = isBlockElement(next);
      const isPrevBlock = isBlockElement(prev);

      let val = c;
      if (isNextBlock) {
        val = val.replace(/\n+$/, '');
      }
      if (isPrevBlock) {
        val = val.replace(/^\n+/, '');
      }
      if (val.length > 0 && !((isNextBlock || isPrevBlock) && /^\s*$/.test(val))) {
        cleanChildren.push(val);
      }
    } else {
      cleanChildren.push(c);
    }
  }
  return <li {...rest}>{cleanChildren}</li>;
}

function MarkdownUl({ node: _node, children, ...rest }: ComponentPropsWithoutRef<'ul'> & { node?: unknown }) {
  const arr = Children.toArray(children);
  const cleanChildren = arr.filter((c) => !(typeof c === 'string' && /^\s*$/.test(c)));
  return <ul {...rest}>{cleanChildren}</ul>;
}

function MarkdownOl({ node: _node, children, ...rest }: ComponentPropsWithoutRef<'ol'> & { node?: unknown }) {
  const arr = Children.toArray(children);
  const cleanChildren = arr.filter((c) => !(typeof c === 'string' && /^\s*$/.test(c)));
  return <ol {...rest}>{cleanChildren}</ol>;
}

const MARKDOWN_COMPONENTS = { pre: CodeBlockPre, a: MarkdownLink, img: MarkdownImg, li: MarkdownLi, ul: MarkdownUl, ol: MarkdownOl };

interface MarkdownBodyProps {
  children: string;
  /** When provided, file-path links are intercepted and routed here. */
  onOpenFile?: (path: string) => void;
  /** Allow callers (e.g. EventItem) to scope the className of the wrapper. */
  className?: string;
  /** Skip expensive rehype-highlight during active streaming to reduce render churn. */
  isStreaming?: boolean;
  /**
   * FW-12 Phase 1: opt-in find highlight. Empty/whitespace = no plugin.
   * Other MarkdownBody call sites (Settings, BTW, FileModal, handoff) omit this.
   */
  highlightQuery?: string;
  highlightFindOpts?: FindOptions;
  /** Stronger `transcript-mark--current` when this card is the current 1/N hit. */
  highlightActive?: boolean;
  /** Fallback path: 0-based occurrence inside this card that should receive data-find-active. */
  highlightActiveIdx?: number;
  /** Resolve relative markdown images via GET /files. */
  conversationId?: string;
  projectId?: string;
}

/**
 * Shared react-markdown configuration used wherever we render agent-authored
 * text: chat events, the file modal, anywhere else later. Adding the
 * linkifyPaths plugin here means file paths light up as links everywhere.
 */
export function MarkdownBody({ children, onOpenFile, className, isStreaming, highlightQuery, highlightFindOpts, highlightActive, highlightActiveIdx, conversationId, projectId }: MarkdownBodyProps) {
  const contextOpenFile = useOpenFile();
  const handleOpenFile = onOpenFile ?? contextOpenFile;
  // ponytail: skip syntax highlighting while streaming — detect:true runs on every
  // chunk of the full accumulated text, causing render churn on plain prose
  const [zoom, setZoom] = useState<{ items: { src: string; alt: string }[]; i: number } | null>(null);
  const [copyLinkState, setCopyLinkState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [fullscreen, setFullscreen] = useState(false);
  const zoomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onFs = () => {
      setFullscreen(!!zoomRef.current && document.fullscreenElement === zoomRef.current);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = () => {
    const el = zoomRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen?.();
    else void el.requestFullscreen?.();
  };

  const handleCopyLink = async () => {
    if (!zoom) return;
    try {
      await copyText(zoom.items[zoom.i].src);
      setCopyLinkState('copied');
      window.setTimeout(() => setCopyLinkState('idle'), 2000);
    } catch {
      setCopyLinkState('failed');
      window.setTimeout(() => setCopyLinkState('idle'), 2000);
    }
  };

  const step = useCallback((d: number) => {
    setCopyLinkState('idle');
    setZoom((z) => (z ? { ...z, i: (z.i + d + z.items.length) % z.items.length } : z));
  }, []);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.fullscreenElement) return;
        setZoom(null);
      }
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom !== null, step]);
  const highlightPlugin = highlightQuery?.trim()
    ? [rehypeHighlightMatches(highlightQuery, !!highlightActive, highlightActiveIdx, highlightFindOpts)]
    : [];
  const rehypePlugins = (
    isStreaming
      ? [rehypeKatex, ...highlightPlugin]
      : [rehypeKatex, [rehypeHighlight, { detect: true }], ...highlightPlugin]
  ) as Parameters<typeof ReactMarkdown>[0]['rehypePlugins'];
  const onZoom = useCallback((e: MouseEvent<HTMLImageElement>) => {
    const all = [...document.querySelectorAll<HTMLImageElement>('img.md-img')];
    setZoom({
      items: all.map((el) => ({ src: el.src, alt: el.alt || 'image' })),
      i: Math.max(0, all.indexOf(e.currentTarget)),
    });
  }, []);
  const fileResolve = useMemo(() => ({ conversationId, projectId }), [conversationId, projectId]);
  return (
    <MdOpenFileContext.Provider value={handleOpenFile}>
    <MdFileResolveContext.Provider value={fileResolve}>
    <MdZoomContext.Provider value={onZoom}>
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath, remarkGithubBlockquoteAlert, remarkDirective, remarkDirectives, remarkSmartypants, linkifyPaths]}
        rehypePlugins={rehypePlugins}
        // Allow file: URLs through; react-markdown's default safe-protocol
        // list drops them, which leaves file:// links inert (<a href="">).
        urlTransform={(url) => {
          if (typeof url === 'string' && /^file:/i.test(url)) return url;
          // Grok Bot inlines computer-use screenshots as data: image URLs; the
          // default safe-protocol list drops them and the <img> renders empty.
          if (typeof url === 'string' && url.startsWith('data:image/')) return url;
          return defaultUrlTransform(url);
        }}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
      {/* Portalled: a transcript ancestor sets `transform`, which turns
          position:fixed into a containing block and clips the overlay to the pane. */}
      {zoom && createPortal(
        <div className="modal-overlay" onClick={() => setZoom(null)}>
          <div ref={zoomRef} className="image-lightbox" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
                <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {zoom.items[zoom.i].alt}
                  {zoom.items.length > 1 && ` (${zoom.i + 1}/${zoom.items.length})`}
                </span>
                <button
                  type="button"
                  className="action-icon-btn"
                  onClick={handleCopyLink}
                  title={copyLinkState === 'copied' ? 'Link copied!' : copyLinkState === 'failed' ? 'Copy link failed' : 'Copy link'}
                  aria-label={copyLinkState === 'copied' ? 'Link copied!' : 'Copy link'}
                  style={{ display: 'flex', alignItems: 'center' }}
                >
                  {copyLinkState === 'copied' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green, #10b981)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                  )}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  className="action-icon-btn file-modal-fullscreen-btn"
                  onClick={toggleFullscreen}
                  title={fullscreen ? 'Exit full screen' : 'Full screen'}
                  aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {fullscreen ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" />
                      <polyline points="20 10 14 10 14 4" />
                      <line x1="14" y1="10" x2="21" y2="3" />
                      <line x1="10" y1="14" x2="3" y2="21" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  )}
                </button>
                <button type="button" className="image-lightbox-close" aria-label="Close" onClick={() => setZoom(null)}>×</button>
              </div>
            </div>
            <div className="md-img-stage">
              {zoom.items.length > 1 && (
                <button type="button" className="md-img-nav md-img-nav--prev" aria-label="Previous image" onClick={() => step(-1)}>‹</button>
              )}
              <img className="image-lightbox-img" src={zoom.items[zoom.i].src} alt={zoom.items[zoom.i].alt} />
              {zoom.items.length > 1 && (
                <button type="button" className="md-img-nav md-img-nav--next" aria-label="Next image" onClick={() => step(1)}>›</button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
    </MdZoomContext.Provider>
    </MdFileResolveContext.Provider>
    </MdOpenFileContext.Provider>
  );
}
