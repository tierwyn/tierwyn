import { copyText } from '../clipboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitCommitDiffResponse,
  GitCommitFileResponse,
  GitCommitFileStatus,
  TtsProvider,
  VoiceTtsSettings,
} from '@tierwyn/shared';
import { fetchGitCommitDiff, fetchGitCommitFile, fetchGitBranchFileDiff, UnauthorizedError } from '../api.js';
import { parseGitDiff, type DiffLine } from '../diffParser.js';
import {
  codeSpeakNotice,
  countLines,
  explainDiffAvailable,
  playWithMode,
  ttsSupported,
  type SpeakMode,
} from '../speak.js';
import { getTtsParkState, subscribeTtsPark } from '../ttsParkPlayer.js';
import { renderStatusBadge, splitPath } from './gitStatusBadge.js';
import { Modal } from './Modal.js';
import { CodeView } from './FileModal.js';
import { SpeakChoiceModal } from './SpeakChoiceModal.js';
import { TtsSpeakIcon } from './TtsSpeakIcon.js';

interface Props {
  cwd: string;
  conversationId?: string;
  projectId?: string;
  sha: string;
  shortSha: string;
  path: string;
  status?: GitCommitFileStatus;
  compareFromSha?: string;
  onClose: () => void;
  onUnauthorized?: () => void;
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
}

const GIT_DIFF_INDICATOR: Record<DiffLine['kind'], string> = {
  insert: '+',
  delete: '−',
  unchanged: ' ',
  hunk: '@',
  meta: ' ',
};

export function GitCommitFileModal({
  cwd,
  conversationId,
  projectId,
  sha,
  shortSha,
  path,
  status,
  compareFromSha,
  onClose,
  onUnauthorized,
  tts,
  ttsSummarizeAvailable = false,
}: Props) {
  const ctx = { cwd, conversationId, projectId };
  const { dir, file: filename } = splitPath(path);
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';

  const [view, setView] = useState<'diff' | 'code'>('diff');
  const [diff, setDiff] = useState<GitCommitDiffResponse | null>(null);
  const [file, setFile] = useState<GitCommitFileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [diffCopied, setDiffCopied] = useState(false);
  const loadedKey = useRef<string | null>(null);

  const [speaking, setSpeaking] = useState(false);
  const [speakChoiceOpen, setSpeakChoiceOpen] = useState(false);
  const [summarizeBusy, setSummarizeBusy] = useState(false);
  const [speakError, setSpeakError] = useState<string | null>(null);

  const ttsProvider: TtsProvider = tts?.provider ?? 'browser';
  const canSpeakBase = !!tts?.enabled && (ttsSupported || ttsProvider === 'piper' || ttsProvider === 'kokoro');
  const canExplainDiff = canSpeakBase && view === 'diff' && explainDiffAvailable({
    diff: diff?.diff,
    summarizeConfigured: ttsSummarizeAvailable,
  });
  const canSpeakAsIs = canSpeakBase && view === 'code' && !!file && !file.binary;
  const canSummarize = canSpeakBase && view === 'code' && !!file && !file.binary && ttsSummarizeAvailable;
  const showSpeaker = canSpeakBase && (
    (view === 'diff' && !!diff)
    || (view === 'code' && !!file && !file.binary)
  );

  useEffect(() => {
    let cancelled = false;
    const reqKey = `${compareFromSha ?? ''}:${sha}:${path}:${view}`;
    if (loadedKey.current === reqKey) return;
    if (view === 'code' && status === 'deleted') return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (view === 'diff') {
          const res = compareFromSha
            ? await fetchGitBranchFileDiff(ctx, compareFromSha, sha, path)
            : await fetchGitCommitDiff(ctx, sha, path);
          if (!cancelled) {
            loadedKey.current = reqKey;
            setDiff(res);
          }
        } else {
          const res = await fetchGitCommitFile(ctx, sha, path);
          if (!cancelled) {
            loadedKey.current = reqKey;
            setFile(res);
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [view, status, sha, compareFromSha, path, cwd, conversationId, projectId, onUnauthorized]);

  useEffect(() => {
    setSpeakChoiceOpen(false);
    setSpeaking(false);
    setSpeakError(null);
    setSummarizeBusy(false);
  }, [view, sha, path]);

  const parsed = useMemo(() => (diff ? parseGitDiff(diff.diff) : null), [diff]);
  const parsedFile = parsed?.files[0];

  const copyContent = async () => {
    if (!file?.content) return;
    try {
      await copyText(file.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  const copyDiff = async () => {
    if (!diff?.diff) return;
    try {
      await copyText(diff.diff);
      setDiffCopied(true);
      window.setTimeout(() => setDiffCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  const runSpeakMode = (mode: SpeakMode, opts?: { guidance?: string; targetMinutes?: number }) => {
    setSpeakChoiceOpen(false);
    setSpeakError(null);
    const meta = (conversationId || projectId)
      ? {
          conversationId,
          projectId,
          source: 'file' as const,
          title: `Diff: ${filename} @ ${shortSha}`,
        }
      : undefined;
    const onEnd = () => { setSpeaking(false); setSummarizeBusy(false); };
    setSpeaking(true);

    const watchPark = () => subscribeTtsPark(() => {
      const s = getTtsParkState();
      if (s.status === 'error' && s.error) {
        setSpeakError(s.error);
        setSummarizeBusy(false);
        setSpeaking(false);
      } else if (s.status === 'playing' || s.status === 'ready' || s.status === 'idle') {
        setSummarizeBusy(false);
      }
    });

    if (mode === 'explain-diff') {
      if (!diff?.diff.trim()) { setSpeaking(false); return; }
      setSummarizeBusy(true);
      const unsub = watchPark();
      void playWithMode(diff.diff, 'explain-diff', () => { unsub(); onEnd(); }, ttsProvider, {
        diff: diff.diff,
        filename,
        lang: ext,
        fileContext: file?.content,
        diffSource: 'commit' as const,
        sha,
        truncated: diff.truncated,
      }, meta);
      return;
    }

    // 'summarize' / 'as-is' over the blob — only reachable in Full-file view.
    if (!file || file.binary || !file.content) { setSpeaking(false); return; }
    if (mode === 'summarize') {
      setSummarizeBusy(true);
      const unsub = watchPark();
      void playWithMode(
        file.content,
        'summarize',
        () => { unsub(); onEnd(); },
        ttsProvider,
        { kind: 'code', filename, lang: ext, ...opts },
        { ...(meta ?? {}), title: `${filename} @ ${shortSha}` },
      );
      return;
    }

    void (async () => {
      const notice = codeSpeakNotice(ext, countLines(file.content));
      await playWithMode(
        notice,
        'as-is',
        onEnd,
        ttsProvider,
        undefined,
        { ...(meta ?? {}), title: `${filename} @ ${shortSha}` },
      );
    })();
  };

  return (
    <Modal
      title={`${filename} @ ${shortSha}`}
      onClose={onClose}
      className="git-commit-file-modal"
      overlayClassName="modal-overlay--stack-3"
      headerActions={(
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {showSpeaker && (
            <button
              type="button"
              className="git-file-speaker-btn"
              title={
                summarizeBusy
                  ? 'Preparing speech…'
                  : speaking
                    ? 'Read aloud (replace current)'
                    : 'Read aloud'
              }
              aria-label={speaking ? 'Read aloud (replace current)' : 'Read aloud'}
              aria-busy={speaking || summarizeBusy || undefined}
              style={speaking || summarizeBusy ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
              onClick={() => setSpeakChoiceOpen(true)}
            >
              <TtsSpeakIcon
                speaking={speaking || summarizeBusy}
                preparing={summarizeBusy}
                size={14}
              />
            </button>
          )}
          <div className="git-file-view-toggle" role="tablist" aria-label="File view mode">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'diff'}
              className={`git-file-view-tab${view === 'diff' ? ' is-active' : ''}`}
              onClick={() => setView('diff')}
            >
              Diff
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'code'}
              className={`git-file-view-tab${view === 'code' ? ' is-active' : ''}`}
              onClick={() => setView('code')}
            >
              Full file
            </button>
          </div>
        </div>
      )}
    >
      <div className="git-commit-file-path-bar">
        {status && renderStatusBadge(status)}
        <span className="git-wt-path" title={path}>
          {dir && <span className="git-wt-dir">{dir}</span>}
          <span className="git-wt-file">{filename}</span>
        </span>
        <span className="git-file-snapshot-pill">
          commit <span className="git-history-sha">{shortSha}</span>
        </span>
      </div>
      {error && <div className="git-wt-feedback git-wt-feedback--error">{error}</div>}
      {speakError && (
        <div className="voice-warning-chip" style={{ margin: '0 0 8px', fontSize: 12 }} role="alert">
          Speak failed: {speakError}
        </div>
      )}
      {summarizeBusy && (
        <div style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-3)' }}>
          Preparing speech…
        </div>
      )}
      {loading && <p className="git-wt-empty">Loading…</p>}

      {!loading && view === 'diff' && diff && (
        parsedFile ? (
          <div className="diff-container git-file-diff-container" style={{ minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div className="diff-header-bar">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="git-file-diff-filename">{filename}</span>
                <span className="diff-stats-badge">
                  <span className="diff-stat-added">+{parsedFile.additions}</span>
                  <span className="diff-stat-removed">−{parsedFile.deletions}</span>
                </span>
                {diff.truncated && (
                  <span className="git-history-truncated">Truncated at 1 MB.</span>
                )}
              </div>
              <button
                type="button"
                className="git-file-action-btn"
                onClick={() => void copyDiff()}
                title="Copy diff text"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {diffCopied ? (
                    <polyline points="20 6 9 17 4 12" />
                  ) : (
                    <>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </>
                  )}
                </svg>
                <span>{diffCopied ? 'Copied' : 'Copy diff'}</span>
              </button>
            </div>
            <pre className="diff-pre" style={{ flex: 1, overflow: 'auto', maxHeight: 'none' }}>
              <div className="diff-lines-container">
                {parsedFile.lines.map((l, i) => (
                  <div key={i} className={`diff-line diff-line-${l.kind}`}>
                    <span className="diff-indicator">{GIT_DIFF_INDICATOR[l.kind]}</span>
                    <span className="diff-text">{l.text || '\u00A0'}</span>
                  </div>
                ))}
              </div>
            </pre>
          </div>
        ) : (
          <p className="git-wt-empty">No textual changes for this file in this commit (binary or mode-only change).</p>
        )
      )}
      {!loading && view === 'code' && status === 'deleted' && (
        <p className="git-wt-empty">File was deleted in this commit — no snapshot available.</p>
      )}

      {!loading && view === 'code' && status !== 'deleted' && file && (
        <div className="git-file-reader-card">
          <div className="git-file-reader-toolbar">
            <div className="git-file-reader-toolbar-left">
              <span className="git-file-readonly-chip">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Historical snapshot</span>
              </span>
              <span className="git-file-line-count">
                {countLines(file.content)} {countLines(file.content) === 1 ? 'line' : 'lines'}
              </span>
              {ext && (
                <span className="git-file-lang-pill">{ext.toUpperCase()}</span>
              )}
              {file.truncated && (
                <span className="git-history-truncated">Truncated at 1 MB.</span>
              )}
            </div>
            <div className="git-file-reader-toolbar-right">
              {!file.binary && (
                <button
                  type="button"
                  className="git-file-action-btn"
                  onClick={() => void copyContent()}
                  title="Copy file contents"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {copied ? (
                      <polyline points="20 6 9 17 4 12" />
                    ) : (
                      <>
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </>
                    )}
                  </svg>
                  <span>{copied ? 'Copied' : 'Copy file'}</span>
                </button>
              )}
            </div>
          </div>
          {file.binary ? (
            <p className="git-wt-empty">Binary file — no preview.</p>
          ) : (
            <CodeView text={file.content} lang={ext} showLineNumbers={true} />
          )}
        </div>
      )}

      {speakChoiceOpen && (
        <SpeakChoiceModal
          summarizeAvailable={canSummarize}
          allowSummarizeGuidance
          asIsAvailable={canSpeakAsIs}
          explainDiffAvailable={canExplainDiff}
          summarizeHint={
            ttsSummarizeAvailable
              ? 'LLM explanation of what this file does'
              : 'Configure Voice → Transcript cleanup provider/model first'
          }
          explainDiffHint={
            ttsSummarizeAvailable
              ? 'What this diff changes, in plain English'
              : 'Configure the TTS summarize LLM first'
          }
          busy={summarizeBusy}
          onChoose={runSpeakMode}
          onClose={() => setSpeakChoiceOpen(false)}
        />
      )}
    </Modal>
  );
}
