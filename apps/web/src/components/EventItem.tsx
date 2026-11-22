import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { MessageFile, NormalisedEvent, PromptAttachment } from '@tierwyn/shared';
import { fileFallbackText } from '@tierwyn/shared';
import { attachmentChipKind } from '../messageFiles.js';
import { fileDownloadUrl } from '../api.js';
import { MarkdownBody } from './MarkdownBody.js';
import { InteractionPrompt } from './InteractionPrompt.js';
import { DiffViewer, ToolInputDisplay, extractDiffPairFromToolInput } from './ToolInputDisplay.js';
import { isOpenableExtension, findOpenablePaths } from '@tierwyn/shared';
import { ttsSupported, playWithMode, type SpeakMeta, type SpeakMode } from '../speak.js';
import type { TtsProvider, TtsRecordingSource } from '@tierwyn/shared';
import { SpeakChoiceModal } from './SpeakChoiceModal.js';
import { SpeakScopeModal, type SpeakScope } from './SpeakScopeModal.js';
import { TtsSpeakIcon } from './TtsSpeakIcon.js';
import { isInteractionRequestResolved, isRedundantAutoResolve } from '../interactionResolve.js';
import type { FindOptions } from '../transcriptFind.js';

function isOpenableExt(p: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return !!m && isOpenableExtension(m[1].toLowerCase());
}

/** Collapsed tool_result preview budget. Line-only caps miss single-line base64
 *  dumps (e.g. image tool results) — those need a char budget too. */
const RESULT_PREVIEW_MAX_LINES = 6;
const RESULT_PREVIEW_MAX_CHARS = 480;

function buildResultPreview(content: string): {
  preview: string;
  truncated: boolean;
  fullChars: number;
} {
  const fullChars = content.length;
  if (fullChars === 0) return { preview: '', truncated: false, fullChars: 0 };
  let preview = content.split('\n').slice(0, RESULT_PREVIEW_MAX_LINES).join('\n');
  if (preview.length > RESULT_PREVIEW_MAX_CHARS) {
    preview = preview.slice(0, RESULT_PREVIEW_MAX_CHARS);
  }
  const truncated = preview.length < fullChars;
  if (truncated) preview = `${preview}…`;
  return { preview, truncated, fullChars };
}

function formatByteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function MessageFileChip({
  file,
  conversationId,
  projectId,
  onOpenFile,
}: {
  file: MessageFile;
  conversationId?: string;
  projectId?: string;
  onOpenFile?: (path: string, gallery?: string[], displayName?: string) => void;
}) {
  const kind = attachmentChipKind(file);
  const size = typeof file.size === 'number' ? formatByteSize(file.size) : null;
  const ctx = conversationId || projectId ? { conversationId, projectId } : undefined;
  const href = file.path ? fileDownloadUrl(file.path, file.name, ctx) : undefined;

  if (kind === 'too_large') {
    const mb = typeof file.size === 'number' ? `${(file.size / (1024 * 1024)).toFixed(0)} MB` : '';
    return (
      <span className="pe-attachment-file pe-attachment-file--too-large" title="too large">
        <span className="pe-attachment-file-icon">📎</span>
        <span className="pe-attachment-file-name">{file.name}</span>
        <span className="pe-attachment-file-meta">too large{mb ? ` (${mb})` : ''} — open in Grok Bot app</span>
      </span>
    );
  }
  if (kind === 'unavailable') {
    return (
      <span className="pe-attachment-file pe-attachment-file--unavailable" title="unavailable">
        <span className="pe-attachment-file-icon">📎</span>
        <span className="pe-attachment-file-name">{file.name}</span>
        <span className="pe-attachment-file-meta">unavailable</span>
      </span>
    );
  }

  const open = () => {
    if (!file.path) return;
    if (kind === 'preview') onOpenFile?.(file.path, undefined, file.name);
    else if (href) window.location.assign(href);
  };

  return (
    <span className={`pe-attachment-file pe-attachment-file--${kind}`}>
      <button type="button" className="pe-attachment-file-open" onClick={open} title={file.name}>
        <span className="pe-attachment-file-icon">📎</span>
        <span className="pe-attachment-file-name">{file.name}</span>
        {size && <span className="pe-attachment-file-meta">{size}</span>}
      </button>
      {href && (
        <a className="pe-attachment-file-dl" href={href} download title={`Download ${file.name}`}>⤓</a>
      )}
    </span>
  );
}

/**
 * Render a plain-text string (e.g. tool_result content) with any openable
 * path substrings turned into clickable buttons. Everything outside path
 * matches stays as raw text, preserving the original whitespace and line
 * breaks of the surrounding `<pre>`.
 */
function renderTextWithPaths(text: string, onOpenFile?: (p: string) => void): ReactNode {
  if (!text) return text;
  if (!onOpenFile) return text;

  type Match = { start: number; end: number; path: string };
  const unique: Match[] = findOpenablePaths(text).map((m) => {
    // Strip file:// scheme (and optional localhost/) and #L… line hash so
    // the value handed to onOpenFile is a bare path that GET /files accepts.
    let path = m.path;
    if (path.startsWith('file://')) {
      path = path.slice(7);
      if (path.startsWith('localhost/')) path = path.slice(9);
    }
    const hashIdx = path.indexOf('#');
    if (hashIdx >= 0) path = path.slice(0, hashIdx);
    return { start: m.start, end: m.end, path };
  });
  if (unique.length === 0) return text;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  unique.forEach((m, i) => {
    if (m.start > cursor) nodes.push(text.slice(cursor, m.start));
    nodes.push(
      <button
        key={`path-${i}-${m.start}`}
        type="button"
        className="file-path-link"
        title={`Open ${m.path}`}
        onClick={(e) => { e.stopPropagation(); onOpenFile(m.path); }}
      >
        {text.slice(m.start, m.end)}
      </button>,
    );
    cursor = m.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

// TODO: expose date format as a user setting
function formatEventTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  if (sameDay) return time;

  const date = d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
  return `${date} ${time}`;
}

// DiffViewer is re-exported from ToolInputDisplay for callers that import it from here.
export { DiffViewer };

interface Props {
  event: NormalisedEvent;
  isStreaming?: boolean;
  forceExpandCollapse?: 'expand' | 'collapse' | null;
  isEditing?: boolean;
  editText?: string;
  onEditTextChange?: (text: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onEditStart?: (text: string) => void;
  onCopy?: (text: string) => void;
  copied?: boolean;
  onDelete?: () => void;
  onPrint?: () => void;
  /** Routes a file-path click into the parent's modal state. */
  onOpenFile?: (path: string, gallery?: string[], displayName?: string) => void;
  /** Opens an attachment image in the parent's lightbox (same path as prompt echoes). */
  onLightbox?: (attachment: PromptAttachment) => void;
  lastResolveIndexByRequestId?: Map<string, number>;
  answeredRequestIds?: ReadonlySet<string>;
  eventIndex?: number;
  onRespond?: (requestId: string, sessionId: string, selection: string[], text?: string, answers?: { selection: string[]; text?: string }[]) => void;
  /** Tool input from the tool_call that produced this file_change, used to render a diff. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  linkedToolInput?: Record<string, any>;
  /** Tool name from the paired tool_call for tool_result rendering context. */
  linkedToolName?: string;
  ttsEnabled?: boolean;
  ttsProvider?: TtsProvider;
  ttsSummarizeAvailable?: boolean;
  onCycleTtsProvider?: () => void;
  /** Active conversation — tags Piper/Kokoro synth for the recordings library. */
  conversationId?: string;
  /** Active project — durable TTS even without a conversation id. */
  projectId?: string;
  /**
   * Snapshot “from here to end” message markdown (joined) at click time.
   * Only used for per-message speaker; turn-header / FileModal omit this.
   */
  getSpeakTail?: () => string;
  /** Operator !-shell card (tool_call name:'shell' or its paired tool_result). */
  isShell?: boolean;
  /** Command string from the paired shell tool_call, for the result-card inject button. */
  shellCommand?: string;
  /** Shell tool_call accepted but tool_result not yet on the wire (process still running). */
  isShellRunning?: boolean;
  /** Pre-fill InputBar (same path as sub-agent-result inject). */
  onInjectText?: (text: string) => void;
  /** FW-12: opt-in find highlight for message bodies only. */
  highlightQuery?: string;
  highlightFindOpts?: FindOptions;
  highlightActive?: boolean;
  highlightActiveIdx?: number;
  findCardKey?: string;
}

/** Placeholder for successful file edits whose tool_result carries no text (agy et al.). */
export const FILE_EDIT_EMPTY_RESULT = 'File edit applied — see the tool call / file change above';

// ponytail: name heuristic, not a per-adapter registry; read-only tools (read_file, view_file) excluded.
export function isFileEditToolName(name: string): boolean {
  return /write|replace|edit|delete|patch|create_file|sed_file/i.test(name) && !/read|view|search|grep|list/i.test(name);
}

export function EventItem({
  event,
  isStreaming,
  forceExpandCollapse,
  isEditing,
  editText,
  onEditTextChange,
  onSave,
  onCancel,
  onEditStart,
  onCopy,
  copied,
  onDelete,
  onPrint,
  onOpenFile,
  onLightbox,
  lastResolveIndexByRequestId,
  answeredRequestIds,
  eventIndex,
  onRespond,
  linkedToolInput,
  linkedToolName,
  ttsEnabled = false,
  ttsProvider = 'browser',
  ttsSummarizeAvailable = false,
  onCycleTtsProvider,
  conversationId,
  projectId,
  getSpeakTail,
  isShell = false,
  shellCommand,
  isShellRunning = false,
  onInjectText,
  highlightQuery,
  highlightFindOpts,
  highlightActive,
  highlightActiveIdx,
  findCardKey,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [isResultExpanded, setIsResultExpanded] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  /** closed → scope (optional) → mode → play */
  const [speakStep, setSpeakStep] = useState<'closed' | 'scope' | 'mode'>('closed');
  /** Markdown (or selection) captured before the mode modal; snapshot at choose time. */
  const [speakText, setSpeakText] = useState('');
  const [speakSource, setSpeakSource] = useState<TtsRecordingSource>('message');

  const canSpeak = ttsEnabled && (ttsSupported || ttsProvider === 'piper' || ttsProvider === 'kokoro');
  const providerLabel = ttsProvider === 'browser' ? 'B' : ttsProvider === 'piper' ? 'P' : 'K';

  useEffect(() => {
    if (forceExpandCollapse === 'expand') {
      setCollapsed(false);
      setIsResultExpanded(true);
    } else if (forceExpandCollapse === 'collapse') {
      setCollapsed(true);
      setIsResultExpanded(false);
    }
  }, [forceExpandCollapse]);

  if (event.type === 'message') {
    const isActivelyStreaming = !!isStreaming && !event.payload.final;
    const openSpeakFlow = () => {
      // Selection wins: skip scope modal and use selection as the mode-modal text.
      const selected = window.getSelection()?.toString()?.trim();
      if (selected) {
        setSpeakText(selected);
        setSpeakSource('selection');
        setSpeakStep('mode');
        return;
      }
      setSpeakStep('scope');
    };

    const onScopeChoose = (scope: SpeakScope) => {
      if (scope === 'this') {
        setSpeakText(event.payload.chunk);
        setSpeakSource('message');
      } else {
        // Snapshot at click — getSpeakTail must not follow later stream updates. (|| not ??: miss returns '', not undefined)
        setSpeakText(getSpeakTail?.() || event.payload.chunk);
        setSpeakSource('scope');
      }
      setSpeakStep('mode');
    };

    const runSpeakMode = (mode: SpeakMode, opts?: { guidance?: string; targetMinutes?: number }) => {
      setSpeakStep('closed');
      setSpeaking(true);
      const meta: SpeakMeta | undefined = conversationId || projectId
        ? {
            conversationId: conversationId ?? undefined,
            projectId: projectId ?? undefined,
            source: speakSource,
            title: speakText.slice(0, 80),
          }
        : undefined;
      void playWithMode(speakText, mode, () => setSpeaking(false), ttsProvider, mode === 'summarize' ? opts : undefined, meta);
    };

    const closeSpeakModals = () => setSpeakStep('closed');

    if (isEditing) {
      return (
        <div className="prompt-edit-area">
          <div className="prompt-echo-header">
            <div className="prompt-echo-header-left">
              <span className="prompt-echo-user" style={{ color: 'var(--accent)' }}>Editing Response Chunk:</span>
            </div>
          </div>
          <textarea
            className="edit-textarea"
            value={editText}
            onChange={(e) => onEditTextChange?.(e.target.value)}
          />
          <div className="edit-btn-row">
            <button className="btn-edit-cancel" onClick={onCancel}>Cancel</button>
            <button className="btn-edit-save" onClick={onSave}>Save</button>
          </div>
        </div>
      );
    }

    return (
      <div className="event-message-block" id={`event-${event.seq || event.ts}`}>
        <div className="event-message-meta">
          <span className="event-timestamp--message">{formatEventTimestamp(event.ts)}</span>
          {!isActivelyStreaming && (
          <div className="message-actions">
            {canSpeak && (
              <>
              <button
                className="action-icon-btn"
                title={speaking ? 'Read aloud (replace current)' : 'Read aloud'}
                aria-busy={speaking || undefined}
                style={speaking ? { color: 'var(--accent)' } : undefined}
                onClick={openSpeakFlow}
              >
                <TtsSpeakIcon speaking={speaking} size={12} />
              </button>
              {/* ponytail: 3-state cycle button — a full dropdown per message is overkill for a single-user A/B. */}
              <button
                className="action-icon-btn tts-provider-cycle"
                title={`TTS provider: ${ttsProvider} (click to cycle)`}
                onClick={() => onCycleTtsProvider?.()}
                style={{ fontSize: '9px', fontWeight: 700, fontFamily: 'var(--ui)', minWidth: '18px' }}
              >
                {providerLabel}
              </button>
              {speakStep === 'scope' && (
                <SpeakScopeModal
                  onChoose={onScopeChoose}
                  onClose={closeSpeakModals}
                />
              )}
              {speakStep === 'mode' && (
                <SpeakChoiceModal
                  summarizeAvailable={ttsSummarizeAvailable}
                  allowSummarizeGuidance
                  onChoose={runSpeakMode}
                  onClose={closeSpeakModals}
                />
              )}
              </>
            )}
            <button
              className="action-icon-btn"
              title="Edit message block"
              onClick={() => onEditStart?.(event.payload.chunk)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
            <button
              className="action-icon-btn"
              title={copied ? 'Copied' : 'Copy message block'}
              onClick={() => onCopy?.(event.payload.chunk)}
              style={copied ? { color: 'var(--green, #10b981)' } : undefined}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              )}
            </button>
            <button
              className="action-icon-btn"
              title="Print message block"
              onClick={onPrint}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </button>
            <button
              className="action-icon-btn"
              title="Delete message block"
              onClick={onDelete}
              style={{ color: 'var(--red, #ef4444)' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </button>
          </div>
          )}
        </div>
        <div className="event-message" data-find-card={findCardKey}>
          {!(event.payload.files?.length && event.payload.chunk.trim() === fileFallbackText(event.payload.files)) && (
          <MarkdownBody
            onOpenFile={onOpenFile}
            conversationId={conversationId}
            projectId={projectId}
            isStreaming={isActivelyStreaming}
            highlightQuery={highlightQuery}
            highlightFindOpts={highlightFindOpts}
            highlightActive={highlightActive}
            highlightActiveIdx={highlightActiveIdx}
          >{event.payload.chunk}</MarkdownBody>
          )}
          {event.payload.files && event.payload.files.length > 0 && (
            <div className="pe-attachments">
              {event.payload.files.map((f, i) => (
                <MessageFileChip
                  key={`${f.name}-${i}`}
                  file={f}
                  conversationId={conversationId}
                  projectId={projectId}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          )}
          {isActivelyStreaming && <span className="stream-cursor" />}
        </div>
      </div>
    );
  }

  if (event.type === 'tool_call') {
    if (event.payload.name === 'AskUserQuestion') return null;
    // ponytail: hide spawn-curl tool calls (token + parent conv id leak); agent still runs it, UI just doesn't render
    const input = event.payload.input;
    const cmd = typeof input === 'object' && input && 'command' in input ? String((input as Record<string, unknown>).command) : '';
    if (cmd.includes('/spawn') && /curl\b/.test(cmd)) return null;
    const isObject = input && typeof input === 'object';
    const keyCount = isObject ? Object.keys(input).length : 0;
    const isShortInput = !isObject || keyCount <= 1;

    return (
      <>
      <div className={`event-tool-call${isShell ? ' event-tool-call--shell' : ''}${isShellRunning ? ' event-tool-call--shell-running' : ''}`}>
        <div
          className="tool-call-header"
          style={{ cursor: isShortInput ? 'default' : 'pointer' }}
          onClick={() => { if (!isShortInput) setCollapsed(c => !c); }}
        >
          <div className="tool-call-label">
            {isShell ? 'operator shell' : 'tool call'}
            <span className="tool-name-chip">{event.payload.name}</span>
            {isShellRunning && (
              <span className="shell-running-chip" role="status" aria-live="polite">
                <span className="shell-running-spinner" aria-hidden />
                running
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="event-timestamp">{formatEventTimestamp(event.ts)}</span>
            {!isShortInput && <span className="tool-call-chevron">{collapsed ? '▸' : '▾'}</span>}
          </div>
        </div>
        {!isShortInput && (
          <div className={`tool-call-preview ${collapsed ? 'show-screen-only' : 'hide-always'}`}>
            {JSON.stringify(event.payload.input, null, 2)
              .split('\n')
              .slice(0, 3)
              .join('\n')}
          </div>
        )}
        <div className={`tool-call-body ${(!isShortInput && collapsed) ? 'hide-on-screen' : ''}`}>
          <ToolInputDisplay input={event.payload.input} onOpenFile={onOpenFile} />
        </div>
      </div>
      {isShellRunning && (
        <div className="event-tool-result event-tool-result--shell event-tool-result--shell-pending" role="status" aria-live="polite">
          <div className="tool-result-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="shell-running-spinner" aria-hidden />
              operator shell result
            </div>
            <span className="shell-running-chip">waiting for output…</span>
          </div>
          <div className="tool-result-body">
            <div className="shell-pending-shimmer" aria-hidden>
              <div className="shell-pending-shimmer-track" />
            </div>
            <p className="shell-pending-hint">
              Command accepted — still running on the host
              {shellCommand ? <> (<code>!{shellCommand}</code>)</> : null}.
            </p>
          </div>
        </div>
      )}
      </>
    );
  }

  if (event.type === 'tool_result') {
    const content = event.payload.content || '';
    const hasContent = content.trim().length > 0;
    const isSearchTool = !!linkedToolName && /^(search_web|websearch|web_search|webSearchToolCall|google_search|search_tool)$/i.test(linkedToolName);
    const isGroundedSearchEmpty = !hasContent && !event.payload.isError && isSearchTool;
    const isFileEditEmpty = !hasContent && !event.payload.isError && !!linkedToolName && isFileEditToolName(linkedToolName);
    const displayContent = hasContent
      ? content
      : isGroundedSearchEmpty
        ? 'Search results incorporated into model context'
        : isFileEditEmpty
          ? FILE_EDIT_EMPTY_RESULT
          : '(no output)';
    // ponytail: hide result of the hidden spawn-curl call above; matched by /spawn substring in stdout
    if (content.includes('"parentConversationId"') && /spawn/i.test(content)) return null;
    // Char + line budget: single-line base64 image dumps used to expand fully
    // because the old line-only check saw 1 line and skipped collapse.
    const { preview, truncated, fullChars } = buildResultPreview(displayContent);
    const showFull = !truncated || isResultExpanded;

    return (
      <div className={`event-tool-result${isShell ? ' event-tool-result--shell' : ''}`}>
        <div
          className="tool-result-header"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 5h6M6 3l2 2-2 2"/>
            </svg>
            {isShell ? 'operator shell result' : 'result'}
            {isGroundedSearchEmpty && (
              <span
                className="tool-result-badge-grounded"
                title="Search query was executed and results were grounded directly into the model context"
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: 0,
                  color: 'var(--accent, #6366f1)',
                  opacity: 0.9,
                }}
              >
                · grounded search
              </span>
            )}
            {truncated && !isResultExpanded && (
              <span
                className="tool-result-size-hint"
                title="Collapsed long output — expand to view all"
                style={{
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: 0,
                  textTransform: 'none',
                  color: isShell ? 'var(--shell-card-muted)' : 'var(--text-3)',
                  opacity: 0.9,
                }}
              >
                {formatByteSize(fullChars)}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="event-timestamp">{formatEventTimestamp(event.ts)}</span>
            {isShell && onInjectText && (
              <button
                type="button"
                className="shell-send-to-agent"
                onClick={() => onInjectText(
                  `I ran this shell command via Tierwyn:\n$ ${shellCommand ?? ''}\n\nOutput:\n${event.payload.content || '(no output)'}`
                )}
                title="Fill the message box with this shell result (draft only — edit, then send yourself). Syncs to other devices like a typed prompt."
              >
                Send to agent
              </button>
            )}
            {truncated && (
              <button
                type="button"
                onClick={() => setIsResultExpanded(prev => !prev)}
                title={isResultExpanded
                  ? 'Collapse result'
                  : `Show full result (${formatByteSize(fullChars)})`}
                style={{
                  background: 'none',
                  border: 'none',
                  color: isShell ? 'var(--shell-card-label)' : 'var(--tool-result-color)',
                  cursor: 'pointer',
                  fontFamily: 'var(--ui)',
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {isResultExpanded
                  ? 'Show less ▴'
                  : `Show full (${formatByteSize(fullChars)}) ▾`}
              </button>
            )}
          </div>
        </div>
        <div className="tool-result-body">
          {/* Only mount the full blob when expanded (or short). Keeps base64
              multi-KB image payloads out of the DOM + path-linkifier by default. */}
          {showFull ? (
            <pre
              className={`tool-result-full${hasContent ? '' : isGroundedSearchEmpty ? ' tool-result-grounded' : ' tool-result-empty'}`}
              style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
            >
              {renderTextWithPaths(displayContent, onOpenFile)}
            </pre>
          ) : (
            <pre className="tool-result-preview tool-result-preview--capped">
              {renderTextWithPaths(preview, onOpenFile)}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (event.type === 'file_change') {
    // Extract old/new strings from the linked tool_call input or event payload diff for diff rendering.
    const diffPair = extractDiffPairFromToolInput(linkedToolInput, event.payload.path)
      || (event.payload.diff ? extractDiffPairFromToolInput({ diff: event.payload.diff }, event.payload.path) : null);
    const hasDiff = !!diffPair;

    return (
      <div className="event-file-change">
        <div className="file-change-header">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="8" height="8" rx="1"/><path d="M3 5h4M5 3v4"/>
          </svg>
          file change
        </div>
        <div className="file-change-body">
          {isOpenableExt(event.payload.path) && onOpenFile ? (
            <button
              className="file-path file-path-link"
              title={`Open ${event.payload.path}`}
              onClick={() => onOpenFile(event.payload.path)}
            >
              {event.payload.path}
            </button>
          ) : (
            <span className="file-path">{event.payload.path}</span>
          )}
          <span className={`diff-badge ${event.payload.kind}`}>{event.payload.kind}</span>
          {event.payload.additions !== undefined && (
            <span style={{ color: 'var(--text-3)', fontSize: 10 }}>
              +{event.payload.additions} -{event.payload.deletions ?? 0}
            </span>
          )}
          {hasDiff && diffPair && (
            <button
              className="file-diff-toggle"
              onClick={() => setDiffExpanded(x => !x)}
              title={diffExpanded ? 'Collapse diff' : 'Show diff'}
            >
              {diffExpanded ? 'diff ▴' : 'diff ▾'}
            </button>
          )}
        </div>
        {diffExpanded && diffPair && (
          <div className="file-change-diff">
            <DiffViewer target={diffPair.before} replacement={diffPair.after} foldUnchanged />
          </div>
        )}
      </div>
    );
  }

  if (event.type === 'error') {
    // Persisted payloads are untrusted: a non-string message must never crash the render (React #31).
    const msg = typeof event.payload.message === 'string' ? event.payload.message : JSON.stringify(event.payload.message);
    const detail = event.payload.detail;
    return (
      <div className="event-error">
        x {msg}
        {detail != null && <div style={{ marginTop: 4, opacity: 0.7 }}>{typeof detail === 'string' ? detail : JSON.stringify(detail)}</div>}
      </div>
    );
  }

  if (event.type === 'steer') {
    return (
      <div className="event-steer">
        <div className="event-steer-header">
          <span className="event-steer-user">Steer / Injection:</span>
          <span className="event-timestamp">{formatEventTimestamp(event.ts)}</span>
        </div>
        <MarkdownBody className="event-steer-text event-message" onOpenFile={onOpenFile} conversationId={conversationId} projectId={projectId}>{event.payload.text}</MarkdownBody>
        {event.payload.attachments && event.payload.attachments.length > 0 && (
          <div className="pe-attachments">
            {event.payload.attachments.map((a, i) =>
              a.mediaType.startsWith('image/') ? (
                <button key={i} type="button" className="pe-attachment-thumb" title={a.name ?? 'View image'} onClick={() => onLightbox?.(a)}>
                  <img src={`data:${a.mediaType};base64,${a.base64}`} alt={a.name ?? 'attached image'} />
                </button>
              ) : (
                <span key={i} className="pe-attachment-file" title={a.name ?? 'attachment'}>
                  <span className="pe-attachment-file-icon">📄</span>
                  <span className="pe-attachment-file-name">{a.name ?? 'file'}</span>
                </span>
              ),
            )}
          </div>
        )}
      </div>
    );
  }

  if (event.type === 'interaction_request') {
    // Enabled whenever unanswered — no isLiveSession gate. After a page
    // reload currentSessionId may not be restored, but the event carries its
    // own sessionId; if that session is truly gone the server rejects the
    // response and ws.ts marks the card expired (self-healing).
    const resolved = eventIndex !== undefined && lastResolveIndexByRequestId
      ? isInteractionRequestResolved(event.payload.requestId, eventIndex, lastResolveIndexByRequestId)
      : false;
    return (
      <InteractionPrompt
        request={event.payload}
        disabled={!!resolved}
        onRespond={(selection, text, answers) => onRespond?.(event.payload.requestId, event.sessionId, selection, text, answers)}
      />
    );
  }

  if (event.type === 'interaction_resolved') {
    if (isRedundantAutoResolve(event, answeredRequestIds)) return null;
    return (
      <div className="interaction-resolved">
        {event.payload.resolution === 'answered'
          ? `Answered: ${event.payload.text || event.payload.selection.join(', ')}`
          : `Auto-resolved (${event.payload.resolution})`}
      </div>
    );
  }

  return null;
}
