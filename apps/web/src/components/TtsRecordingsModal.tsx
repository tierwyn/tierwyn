import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { TtsRecording } from '@tierwyn/shared';
import { api } from '../api.js';
import {
  downloadTtsRecording,
  isPersistedTtsRecording,
  setTtsParkModalOpen,
  setTtsParkSeeking,
  ttsParkPlay,
  ttsParkSeek,
  ttsParkStop,
  useParkSnapshot,
} from '../ttsParkPlayer.js';

type ScopeFilter = 'project' | 'chat' | 'tree';

interface Props {
  projectId: string;
  /** Active chat when any — enables "This chat" / "Tree" scope chips. */
  conversationId?: string | null;
  recordings: TtsRecording[];
  /** conversation_id → title for source labels (from project list response). */
  convTitles?: Record<string, string>;
  onClose: () => void;
  /** Called after a successful delete so the parent can refresh its list. */
  onDeleted?: (id: string) => void;
}

function relativeTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function providerLabel(p: string): string {
  if (p === 'piper') return 'Piper';
  if (p === 'kokoro') return 'Kokoro';
  return p;
}

function modeLabel(m: string): string {
  if (m === 'summarize') return 'Summarize';
  if (m === 'explain-diff') return 'Explain changes';
  return 'As-is';
}

/** Format seconds as m:ss (or h:mm:ss if needed). */
function formatClock(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Project-scoped Piper/Kokoro WAV library.
 * Playback is owned by ttsParkPlayer — closing this modal while audio is
 * playing parks it into the app-level mini-player bar.
 */
export function TtsRecordingsModal({
  projectId: _projectId,
  conversationId,
  recordings,
  convTitles,
  onClose,
  onDeleted,
}: Props) {
  const park = useParkSnapshot();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Row ids with the full spoken transcript expanded (also auto-open while playing). */
  const [transcriptOpen, setTranscriptOpen] = useState<Record<string, boolean>>({});

  // Scope chips: Project (default) · This chat · Tree. Chat/Tree only when a
  // conversation is active. Tree fetch is modal-local (same as the old toggle).
  const [scope, setScope] = useState<ScopeFilter>('project');
  const [treeRecordings, setTreeRecordings] = useState<TtsRecording[] | null>(null);
  /** id→title map for tree mode (from ?tree=1 response). */
  const [titleByConvId, setTitleByConvId] = useState<Record<string, string> | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  // Modal owns chrome while open; unmount parks (does not stop) active audio.
  useEffect(() => {
    setTtsParkModalOpen(true);
    return () => setTtsParkModalOpen(false);
  }, []);

  // If conversation goes away while on chat/tree scope, fall back to project.
  useEffect(() => {
    if (!conversationId && (scope === 'chat' || scope === 'tree')) {
      setScope('project');
      setTreeRecordings(null);
      setTitleByConvId(null);
    }
  }, [conversationId, scope]);

  const toggleTranscript = (id: string) => {
    setTranscriptOpen((m) => ({ ...m, [id]: !m[id] }));
  };

  const selectScope = async (next: ScopeFilter) => {
    if (next === scope) return;
    setError(null);
    if (next === 'tree') {
      if (!conversationId) return;
      setScope('tree');
      setTreeLoading(true);
      try {
        const r = await api.listTtsRecordings(conversationId, { tree: true });
        setTreeRecordings(r.recordings);
        const map: Record<string, string> = {};
        for (const c of r.conversations ?? []) map[c.id] = c.title;
        setTitleByConvId(map);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setScope('project');
        setTreeRecordings(null);
        setTitleByConvId(null);
      } finally {
        setTreeLoading(false);
      }
      return;
    }
    setScope(next);
    setTreeRecordings(null);
    setTitleByConvId(null);
  };

  const effective = useMemo(() => {
    if (scope === 'tree') return treeRecordings ?? [];
    if (scope === 'chat' && conversationId) {
      return recordings.filter((r) => r.conversation_id === conversationId);
    }
    return recordings;
  }, [scope, treeRecordings, recordings, conversationId]);

  const sourceLabel = (r: TtsRecording): string => {
    if (!r.conversation_id) return 'Schedule / project';
    const fromTree = titleByConvId?.[r.conversation_id];
    if (fromTree) return fromTree;
    const fromProject = convTitles?.[r.conversation_id];
    if (fromProject) return fromProject;
    return r.conversation_id.slice(0, 8);
  };

  const playingId =
    park.recording && (park.status === 'playing' || park.status === 'paused' || park.status === 'loading' || park.status === 'ready')
      ? park.recording.id
      : null;
  const paused = park.status === 'paused';
  const currentTime = park.currentTime;
  const duration = park.duration;
  const parkError = park.error;

  const play = useCallback(async (rec: TtsRecording) => {
    setError(null);
    try {
      await ttsParkPlay(rec, rec.conversation_id);
      setTranscriptOpen((m) => ({ ...m, [rec.id]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onSeekInput = (value: number) => {
    setTtsParkSeeking(true);
    ttsParkSeek(value);
  };

  const onSeekCommit = () => {
    setTtsParkSeeking(false);
  };

  const remove = async (id: string) => {
    setError(null);
    setDeletingId(id);
    if (playingId === id) ttsParkStop();
    try {
      await api.deleteTtsRecording(id);
      onDeleted?.(id);
      // Tree mode holds its own snapshot — keep it in sync locally.
      if (scope === 'tree') {
        setTreeRecordings((list) => (list ? list.filter((r) => r.id !== id) : list));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  };

  const download = async (rec: TtsRecording) => {
    setError(null);
    setDownloadingId(rec.id);
    try {
      await downloadTtsRecording(rec);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const chipStyle = (active: boolean): CSSProperties => ({
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    background: active ? 'var(--accent, #6366f1)' : 'transparent',
    color: active ? '#fff' : 'var(--text-2)',
    cursor: 'pointer',
  });

  const emptyMessage = (): string => {
    if (scope === 'tree') return 'No recordings anywhere in this spawn tree.';
    if (scope === 'chat') {
      return 'No Piper/Kokoro recordings yet for this conversation. Speak with P or K while save-recordings is on.';
    }
    return 'No Piper/Kokoro recordings yet for this project. Speak with P or K while save-recordings is on (from chat or schedule files).';
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content summary-list-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Project recordings</span>
          <button type="button" className="usage-close" onClick={onClose} style={{ fontSize: '18px' }} aria-label="Close">×</button>
        </div>
        {conversationId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <button type="button" style={chipStyle(scope === 'project')} onClick={() => { void selectScope('project'); }}>
              Project
            </button>
            <button type="button" style={chipStyle(scope === 'chat')} onClick={() => { void selectScope('chat'); }}>
              This chat
            </button>
            <button
              type="button"
              style={chipStyle(scope === 'tree')}
              disabled={treeLoading}
              onClick={() => { void selectScope('tree'); }}
            >
              {treeLoading ? 'Tree…' : 'Tree'}
            </button>
          </div>
        )}
        <div className="summary-list-body">
          {(error || parkError) && (
            <div className="summary-list-empty" style={{ color: 'var(--danger, #ef4444)' }}>
              {error || parkError}
            </div>
          )}
          {effective.length === 0 && !(scope === 'tree' && treeLoading) ? (
            <div className="summary-list-empty">
              {emptyMessage()}
            </div>
          ) : (
            <ul className="summary-list">
              {effective.map((r) => {
                const preview = r.spoken_text.slice(0, 140);
                const isActive = playingId === r.id;
                const showTranscript = !!transcriptOpen[r.id];
                const max = duration > 0 ? duration : 0;
                const isRunning = r.status === 'running';
                const isError = r.status === 'error';
                return (
                  <li key={r.id}>
                    <div
                      className="summary-list-row"
                      style={{
                        cursor: 'default',
                        flexDirection: 'column',
                        alignItems: 'stretch',
                        gap: '8px',
                        ...(isError ? { borderColor: 'var(--danger, #ef4444)', opacity: 0.95 } : {}),
                      }}
                    >
                      <div className="summary-list-row-head">
                        <span className="summary-list-route">
                          <span>{r.title || 'Recording'}</span>
                          <span className="summary-list-mode-pill">{providerLabel(r.provider)}</span>
                          <span className="summary-list-mode-pill">{modeLabel(r.mode)}</span>
                          <span className="summary-list-mode-pill">{r.source}</span>
                          {isRunning && (
                            <span className="summary-list-mode-pill">Preparing…</span>
                          )}
                          {isError && (
                            <span className="summary-list-mode-pill" style={{ color: 'var(--danger, #ef4444)' }}>
                              Error
                            </span>
                          )}
                        </span>
                        <span className="summary-list-time">{relativeTime(r.created_at)}</span>
                      </div>
                      <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: -2 }}>
                        {sourceLabel(r)}
                      </div>
                      {isError && r.error && (
                        <div style={{ color: 'var(--danger, #ef4444)', fontSize: 12 }}>
                          {r.error}
                        </div>
                      )}
                      {!showTranscript && !isError && (
                        <div className="summary-list-preview">
                          {isRunning
                            ? 'Preparing speech…'
                            : `${preview}${r.spoken_text.length > 140 ? '…' : ''}`}
                        </div>
                      )}
                      {isActive && !isRunning && !isError && (
                        <div className="tts-rec-scrubber">
                          <span className="tts-rec-clock" aria-hidden="true">{formatClock(currentTime)}</span>
                          <input
                            type="range"
                            className="tts-rec-range"
                            min={0}
                            max={max || 1}
                            step={0.1}
                            value={Math.min(currentTime, max || 1)}
                            disabled={max <= 0}
                            aria-label="Seek in recording"
                            onChange={(e) => onSeekInput(Number(e.target.value))}
                            onMouseUp={onSeekCommit}
                            onTouchEnd={onSeekCommit}
                            onKeyUp={onSeekCommit}
                          />
                          <span className="tts-rec-clock" aria-hidden="true">{formatClock(duration)}</span>
                        </div>
                      )}
                      {showTranscript && (
                        <div className="tts-rec-transcript">
                          <div className="tts-rec-transcript-label">
                            Spoken transcript
                            {r.mode === 'summarize' ? ' (summarized for speech)' : r.mode === 'explain-diff' ? ' (diff explanation)' : ''}
                          </div>
                          <pre className="tts-rec-transcript-body">{r.spoken_text || '(empty)'}</pre>
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="modal-btn"
                          disabled={deletingId === r.id || isRunning || isError}
                          onClick={() => { void play(r); }}
                        >
                          {isRunning
                            ? 'Preparing…'
                            : isError
                              ? 'Unavailable'
                              : isActive
                                ? (paused || park.status === 'ready' ? 'Resume' : park.status === 'loading' ? 'Loading…' : 'Pause')
                                : 'Play'}
                        </button>
                        {isActive && (
                          <button
                            type="button"
                            className="modal-btn"
                            onClick={() => ttsParkStop()}
                          >
                            Stop
                          </button>
                        )}
                        <button
                          type="button"
                          className="modal-btn"
                          onClick={() => toggleTranscript(r.id)}
                        >
                          {showTranscript ? 'Hide transcript' : 'Show transcript'}
                        </button>
                        {isPersistedTtsRecording(r) && (
                          <button
                            type="button"
                            className="modal-btn"
                            disabled={downloadingId === r.id}
                            onClick={() => { void download(r); }}
                            title={
                              r.provider === 'kokoro'
                                ? 'Save MP3 for offline / system player'
                                : 'Save WAV for offline / system player'
                            }
                          >
                            {downloadingId === r.id
                              ? 'Downloading…'
                              : r.provider === 'kokoro'
                                ? 'Download MP3'
                                : 'Download WAV'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="modal-btn"
                          disabled={deletingId === r.id}
                          onClick={() => { void remove(r.id); }}
                        >
                          {deletingId === r.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </div>
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
