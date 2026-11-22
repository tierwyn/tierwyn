import { copyText } from '../clipboard';
import type { Handoff, HandoffRequestedMode, HandoffResolvedMode, TtsProvider } from '@tierwyn/shared';
import { useCallback, useEffect, useState } from 'react';
import { MarkdownBody } from './MarkdownBody.js';
import { SpeakChoiceModal } from './SpeakChoiceModal.js';
import { TtsSpeakIcon } from './TtsSpeakIcon.js';
import {
  playWithMode,
  stopSpeaking,
  ttsSupported,
  type SpeakMode,
} from '../speak.js';
import { getTtsParkState, subscribeTtsPark } from '../ttsParkPlayer.js';

interface Props {
  text: string;
  handoff?: Handoff;
  profileLabels?: Record<string, string>;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
  ttsEnabled?: boolean;
  ttsProvider?: TtsProvider;
  /** Whether the Voice → Transcript cleanup provider/model is configured. */
  ttsSummarizeAvailable?: boolean;
}

function formatRequestedMode(mode: HandoffRequestedMode): string {
  if (mode === 'fresh') return 'New session';
  return mode === 'summary' ? 'Summarize' : 'Pass full transcript';
}

function formatResolvedMode(mode: HandoffResolvedMode): string {
  if (mode === 'compacted') return 'Compacted summary';
  if (mode === 'transcript') return 'Full transcript';
  return 'Fresh start';
}

/** Mismatch hint when requested mode and resolved outcome diverged. */
export function handoffMismatchHint(handoff: Handoff): string | null {
  if (handoff.requested_mode === 'transcript' && handoff.resolved_mode === 'compacted') {
    return 'Transcript was too large; summarized instead.';
  }
  if (handoff.requested_mode === 'summary' && handoff.resolved_mode === 'transcript') {
    return 'Short history passed verbatim (no summarizer run).';
  }
  return null;
}

export function HandoffSummaryModal({
  text,
  handoff,
  profileLabels,
  onClose,
  onOpenFile,
  ttsEnabled = false,
  ttsProvider = 'browser',
  ttsSummarizeAvailable = false,
}: Props) {
  const mismatch = handoff ? handoffMismatchHint(handoff) : null;
  const fromLabel = handoff ? (profileLabels?.[handoff.from_profile_id] ?? handoff.from_profile_id) : undefined;
  const toLabel = handoff ? (profileLabels?.[handoff.to_profile_id] ?? handoff.to_profile_id) : undefined;

  const isAgentContext = !!(handoff?.priming_context);
  const bodyText = handoff?.priming_context ?? text;
  const title = isAgentContext ? 'Handoff context' : 'Handoff summary';

  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speakChoiceOpen, setSpeakChoiceOpen] = useState(false);
  const [speakError, setSpeakError] = useState<string | null>(null);
  const [summarizeBusy, setSummarizeBusy] = useState(false);

  useEffect(() => { setCopied(false); }, [bodyText]);
  // Reset speak UI when the underlying content changes (different handoff opened).
  useEffect(() => {
    setSpeakChoiceOpen(false);
    setSpeakError(null);
    setSpeaking(false);
    setSummarizeBusy(false);
    stopSpeaking();
  }, [bodyText]);

  // Stop any TTS playback when the modal closes.
  useEffect(() => {
    return () => { stopSpeaking(); };
  }, []);

  const canSpeak =
    ttsEnabled && bodyText.trim().length > 0 && (ttsSupported || ttsProvider === 'piper' || ttsProvider === 'kokoro');

  const runSpeakMode = (mode: SpeakMode, opts?: { guidance?: string; targetMinutes?: number }) => {
    setSpeakChoiceOpen(false);
    if (!bodyText.trim()) return;
    setSpeakError(null);
    setSpeaking(true);
    const onEnd = () => { setSpeaking(false); setSummarizeBusy(false); };
    const speakMeta = handoff?.conversation_id
      ? { conversationId: handoff.conversation_id, source: 'other' as const, title: title.slice(0, 80) }
      : undefined;

    // Summarize is server-owned via speak-record (park bar shows loading for the
    // whole LLM leg). Errors surface on the park snapshot — subscribe while speaking.
    if (mode === 'summarize') {
      setSummarizeBusy(true);
      const unsub = subscribeTtsPark(() => {
        const s = getTtsParkState();
        if (s.status === 'error' && s.error) {
          setSpeakError(s.error);
          setSummarizeBusy(false);
          setSpeaking(false);
        } else if (s.status === 'playing' || s.status === 'ready' || s.status === 'idle') {
          setSummarizeBusy(false);
        }
      });
      void playWithMode(
        bodyText,
        'summarize',
        () => { unsub(); onEnd(); },
        ttsProvider,
        { kind: 'prose' as const, ...opts },
        speakMeta,
      );
      return;
    }

    // As-is.
    void playWithMode(bodyText, 'as-is', onEnd, ttsProvider, undefined, speakMeta);
  };

  const handleSpeakClick = useCallback(() => {
    // Clicking while playing still opens the chooser — picking a mode replaces
    // the current playback (matches FileModal semantics).
    setSpeakChoiceOpen(true);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await copyText(bodyText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [bodyText]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content handoff-summary-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>{title}</span>
            <button
              type="button"
              className="action-icon-btn"
              onClick={handleCopy}
              title={copied ? 'Copied!' : 'Copy context'}
              aria-label={copied ? 'Copied!' : 'Copy context'}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
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
            {canSpeak && (
              <button
                type="button"
                className="action-icon-btn"
                title={
                  summarizeBusy
                    ? 'Preparing speech…'
                    : speaking
                      ? 'Read aloud (replace current)'
                      : 'Read aloud'
                }
                aria-label={speaking ? 'Read aloud (replace current)' : 'Read aloud'}
                aria-busy={speaking || summarizeBusy || undefined}
                style={speaking || summarizeBusy ? { color: 'var(--accent)' } : undefined}
                onClick={handleSpeakClick}
              >
                <TtsSpeakIcon speaking={speaking || summarizeBusy} preparing={summarizeBusy} size={14} />
              </button>
            )}
          </div>
          <button type="button" className="usage-close" onClick={onClose} style={{ fontSize: '18px' }} aria-label="Close">×</button>
        </div>
        {speakChoiceOpen && (
          <SpeakChoiceModal
            summarizeAvailable={ttsSummarizeAvailable}
            asIsAvailable={true}
            allowSummarizeGuidance
            summarizeHint={
              ttsSummarizeAvailable
                ? 'LLM rewrite of the handoff block, optimised for speech'
                : 'Configure Voice → Transcript cleanup provider/model first'
            }
            busy={summarizeBusy}
            onChoose={runSpeakMode}
            onClose={() => setSpeakChoiceOpen(false)}
          />
        )}
        {speakError && (
          <div className="voice-warning-chip" style={{ margin: '8px 16px 0', fontSize: 12 }} role="alert">
            Summarize failed: {speakError}
          </div>
        )}
        {summarizeBusy && (
          <div style={{ margin: '8px 16px 0', fontSize: 12, color: 'var(--text-3)' }}>
            Summarizing for speech…
          </div>
        )}
        {isAgentContext ? (
          <p className="handoff-summary-lede">
            What the resumed agent received before your message. Delegation preamble and your prompt are not included.
          </p>
        ) : handoff ? (
          <p className="handoff-summary-lede handoff-summary-lede-legacy">
            Summary artifact only — full handoff context was not recorded for this switch.
          </p>
        ) : null}
        <div className="handoff-summary-body">
          <MarkdownBody className="handoff-summary-markdown" onOpenFile={onOpenFile}>{bodyText}</MarkdownBody>
        </div>
        {handoff && (
          <div className="handoff-summary-footer">
            <div className="handoff-summary-route">
              <span>{fromLabel}</span>
              <span className="handoff-summary-route-arrow">→</span>
              <span>{toLabel}</span>
            </div>
            <div className="handoff-summary-modes">
              Requested: {formatRequestedMode(handoff.requested_mode)}
              {' · '}
              Resolved: {formatResolvedMode(handoff.resolved_mode)}
            </div>
            {mismatch && <div className="handoff-summary-mismatch">{mismatch}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
