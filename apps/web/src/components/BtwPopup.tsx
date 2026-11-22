import { useEffect, useState } from 'react';
import type { BtwQuery, TtsProvider } from '@tierwyn/shared';
import { MarkdownBody } from './MarkdownBody.js';
import { ttsSupported, playWithMode, type SpeakMeta, type SpeakMode } from '../speak.js';
import { SpeakChoiceModal } from './SpeakChoiceModal.js';
import { TtsSpeakIcon } from './TtsSpeakIcon.js';

interface Props {
  query: BtwQuery | null;   // null = hidden
  onClose: () => void;
  onCopy?: (q: BtwQuery) => void;
  onFork?: (q: BtwQuery) => void;
  // Forwarded to MarkdownBody so file-path links in the answer open the
  // FileModal instead of navigating (which drops the SPA back to main view).
  onOpenFile?: (path: string) => void;
  /** TTS — same plumbing as message speakers. */
  conversationId?: string | null;
  projectId?: string | null;
  ttsEnabled?: boolean;
  ttsProvider?: TtsProvider;
  ttsSummarizeAvailable?: boolean;
  onCycleTtsProvider?: () => void;
}

export function BtwPopup({
  query,
  onClose,
  onCopy,
  onFork,
  onOpenFile,
  conversationId,
  projectId,
  ttsEnabled = false,
  ttsProvider = 'browser',
  ttsSummarizeAvailable = false,
  onCycleTtsProvider,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speakStep, setSpeakStep] = useState<'closed' | 'mode'>('closed');

  // Reset to collapsed whenever the displayed query changes.
  useEffect(() => {
    setExpanded(false);
    setCopied(false);
    setSpeaking(false);
    setSpeakStep('closed');
  }, [query?.id]);

  if (!query) return null;

  const canAct = query.status === 'done' && !!query.answer;
  const canSpeak = canAct
    && ttsEnabled
    && (ttsSupported || ttsProvider === 'piper' || ttsProvider === 'kokoro');
  const providerLabel = ttsProvider === 'browser' ? 'B' : ttsProvider === 'piper' ? 'P' : 'K';

  const openSpeak = () => {
    if (!query.answer) return;
    setSpeakStep('mode');
  };

  const runSpeakMode = (mode: SpeakMode, opts?: { guidance?: string; targetMinutes?: number }) => {
    setSpeakStep('closed');
    if (!query.answer) return;
    setSpeaking(true);
    const text = query.answer;
    const meta: SpeakMeta | undefined = conversationId || projectId
      ? {
          conversationId: conversationId ?? undefined,
          projectId: projectId ?? undefined,
          source: 'message',
          title: (query.question || text).slice(0, 80),
        }
      : undefined;
    void playWithMode(text, mode, () => setSpeaking(false), ttsProvider, mode === 'summarize' ? opts : undefined, meta);
  };

  return (
    <div className={`btw-popup${expanded ? ' expanded' : ''}`}>
      <div className="btw-popup-header">
        {/* Line 1 — title + window chrome (expand, ✕ top-right) */}
        <div className="btw-popup-title-row">
          <span className="btw-popup-label">BTW</span>
          <span className={`btw-dot btw-dot-${query.status}`} />
          <span className="btw-popup-question" title={query.question}>{query.question}</span>
          <button
            type="button"
            className="btw-popup-expand"
            onClick={() => setExpanded((e) => !e)}
            title={expanded ? 'Minimise' : 'Maximise'}
            aria-label={expanded ? 'Minimise' : 'Maximise'}
          >
            {expanded ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="21" y1="3" x2="10" y2="14" />
                <line x1="3" y1="21" x2="14" y2="10" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
          <button type="button" className="btw-popup-close" onClick={onClose} title="Dismiss" aria-label="Close">✕</button>
        </div>
        {/* Line 2 — content actions (speak / copy / fork) */}
        <div className="btw-popup-controls-row">
          {canSpeak && (
            <>
              <button
                type="button"
                className="btw-popup-action btw-popup-speak"
                onClick={openSpeak}
                title={speaking ? 'Read aloud (replace current)' : 'Read answer aloud'}
                aria-label={speaking ? 'Read aloud (replace current)' : 'Read answer aloud'}
                aria-busy={speaking || undefined}
                style={speaking ? { color: 'var(--accent)' } : undefined}
              >
                <TtsSpeakIcon speaking={speaking} size={12} />
              </button>
              <button
                type="button"
                className="btw-popup-action tts-provider-cycle"
                title={`TTS provider: ${ttsProvider} (click to cycle)`}
                onClick={() => onCycleTtsProvider?.()}
                style={{ fontSize: '9px', fontWeight: 700, fontFamily: 'var(--ui)', minWidth: '18px' }}
              >
                {providerLabel}
              </button>
              {speakStep === 'mode' && (
                <SpeakChoiceModal
                  summarizeAvailable={ttsSummarizeAvailable}
                  allowSummarizeGuidance
                  onChoose={runSpeakMode}
                  onClose={() => setSpeakStep('closed')}
                />
              )}
            </>
          )}
          {canAct && onCopy && (
            <button
              type="button"
              className="btw-popup-action btw-popup-copy"
              onClick={() => { onCopy(query); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
              title={copied ? 'Copied' : 'Copy answer'}
              aria-label={copied ? 'Copied' : 'Copy answer'}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
          {canAct && onFork && (
            <button
              type="button"
              className="btw-popup-action btw-popup-fork"
              onClick={() => onFork(query)}
              title="Fork into new conversation"
              aria-label="Fork into new conversation"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="2.5" />
                <circle cx="6" cy="18" r="2.5" />
                <circle cx="18" cy="6" r="2.5" />
                <path d="M6 8.5v7" />
                <path d="M6 6h12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="btw-popup-body">
        {query.status === 'asking' && (
          <div className="btw-spinner-row">
            <span className="btw-spinner" />
            <span className="btw-hint">thinking…</span>
          </div>
        )}
        {query.status === 'done' && (
          <div className="btw-popup-answer">
            {query.degenerate && <span className="btw-badge-thin">thin answer</span>}
            <MarkdownBody className="event-message" onOpenFile={onOpenFile}>{query.answer ?? ''}</MarkdownBody>
          </div>
        )}
        {query.status === 'error' && (
          <p className="btw-error">{query.errorMessage ?? 'An error occurred.'}</p>
        )}
      </div>
    </div>
  );
}
