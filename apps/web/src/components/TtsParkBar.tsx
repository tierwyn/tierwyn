/**
 * Bottom mini-player for a parked TTS recording.
 * Survives modal close and conversation/project navigation.
 * Desktop (>900px): hidden via CSS — panel owns playback chrome.
 * Mobile (≤900px): always-reachable control when a recording is active.
 *
 * Statuses: loading | playing | paused | ready (autoplay blocked) | error.
 */
import {
  downloadTtsRecording,
  isPersistedTtsRecording,
  ttsParkDismiss,
  ttsParkMiniVisible,
  ttsParkPause,
  ttsParkPlay,
  ttsParkResume,
  ttsParkSeek,
  ttsParkStop,
  setTtsParkSeeking,
  useParkSnapshot,
} from '../ttsParkPlayer.js';
import { hasTtsSpeakRetry, retryLastSpeakRecord } from '../speak.js';
import { TtsSpeakIcon } from './TtsSpeakIcon.js';

function formatClock(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function providerLabel(p: string): string {
  if (p === 'piper') return 'Piper';
  if (p === 'kokoro') return 'Kokoro';
  return p;
}

export function TtsParkBar() {
  const snap = useParkSnapshot();

  if (!ttsParkMiniVisible(snap) || !snap.recording) return null;

  const rec = snap.recording;
  const paused = snap.status === 'paused';
  const loading = snap.status === 'loading';
  const ready = snap.status === 'ready';
  const errored = snap.status === 'error';
  const max = snap.duration > 0 ? snap.duration : 0;
  const title = rec.title || rec.spoken_text.slice(0, 80) || 'Recording';
  const titleFull = rec.title || rec.spoken_text || 'Recording';

  const togglePlay = () => {
    if (loading || errored) return;
    if (ready || paused) void ttsParkResume();
    else if (snap.status === 'playing') ttsParkPause();
    else if (snap.conversationId || rec.id) void ttsParkPlay(rec, snap.conversationId);
  };

  const onSeekInput = (value: number) => {
    setTtsParkSeeking(true);
    ttsParkSeek(value);
  };
  const onSeekCommit = () => setTtsParkSeeking(false);

  const canDownload = isPersistedTtsRecording(rec) && !loading && !errored;

  if (errored) {
    return (
      <div className="tts-park-bar tts-park-bar-error" role="region" aria-label="TTS error">
        <div className="tts-park-bar-controls">
          {hasTtsSpeakRetry() && (
            <button
              type="button"
              className="tts-park-btn"
              onClick={() => void retryLastSpeakRecord()}
              aria-label="Retry"
              title="Retry"
            >
              ⟳
            </button>
          )}
          <button
            type="button"
            className="tts-park-btn tts-park-btn-stop"
            onClick={() => ttsParkDismiss()}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
        <div className="tts-park-meta">
          <span className="tts-park-title" title={snap.error ?? 'TTS failed'}>
            {snap.error ?? 'TTS failed'}
          </span>
          <span className="tts-park-sub">
            <span className="tts-park-pill">{providerLabel(rec.provider)}</span>
            {' · '}
            {rec.mode}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="tts-park-bar" role="region" aria-label="Parked recording">
      <div className="tts-park-bar-controls">
        <button
          type="button"
          className="tts-park-btn"
          onClick={togglePlay}
          disabled={loading}
          aria-label={
            loading ? 'Preparing speech…'
              : ready ? 'Tap to play'
                : paused ? 'Resume'
                  : 'Pause'
          }
          title={
            loading ? 'Preparing speech…'
              : ready ? 'Tap to play'
                : paused ? 'Resume'
                  : 'Pause'
          }
        >
          {loading ? (
            <TtsSpeakIcon speaking preparing size={14} />
          ) : ready || paused ? (
            '▶'
          ) : (
            '❚❚'
          )}
        </button>
        <button
          type="button"
          className="tts-park-btn tts-park-btn-stop"
          onClick={() => ttsParkStop()}
          aria-label="Stop"
          title="Stop"
        >
          ■
        </button>
        {canDownload && (
          <button
            type="button"
            className="tts-park-btn tts-park-btn-dl"
            onClick={() => {
              void downloadTtsRecording(rec).catch((e) => {
                console.error('[tts] download failed', e);
              });
            }}
            aria-label={rec.provider === 'kokoro' ? 'Download MP3' : 'Download WAV'}
            title={
              rec.provider === 'kokoro'
                ? 'Download MP3 for offline listening'
                : 'Download WAV for offline listening'
            }
          >
            ↓
          </button>
        )}
      </div>
      <div className="tts-park-meta">
        <span className="tts-park-title" title={titleFull}>
          {ready ? `Tap to play · ${title}` : title}
        </span>
        <span className="tts-park-sub">
          <span className="tts-park-pill">{providerLabel(rec.provider)}</span>
          {' · '}
          {rec.mode}
          {' · '}
          {rec.source}
          {ready ? ' · ready' : ''}
          {snap.error ? ` · ${snap.error}` : ''}
        </span>
      </div>
      <div className="tts-park-scrubber">
        <span className="tts-rec-clock" aria-hidden="true">{formatClock(snap.currentTime)}</span>
        <input
          type="range"
          className="tts-rec-range"
          min={0}
          max={max || 1}
          step={0.1}
          value={Math.min(snap.currentTime, max || 1)}
          disabled={max <= 0 || loading || ready}
          aria-label="Seek in parked recording"
          onChange={(e) => onSeekInput(Number(e.target.value))}
          onMouseUp={onSeekCommit}
          onTouchEnd={onSeekCommit}
          onKeyUp={onSeekCommit}
        />
        <span className="tts-rec-clock" aria-hidden="true">{formatClock(snap.duration)}</span>
      </div>
    </div>
  );
}
