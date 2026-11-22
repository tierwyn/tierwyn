/**
 * App-level TTS recording player. Survives Recordings modal close and
 * conversation/project navigation so the operator can keep listening.
 *
 * Ownership: one HTMLAudioElement + object URL. The modal is a controller
 * while open; when it closes mid-play, the mini-player bar takes over.
 *
 * Live speaker clicks hand off a durable jobId via ttsParkBeginJob; the park
 * polls GET /tts/recordings/:id until done/error, then fetches audio and plays.
 */
import { useEffect, useState } from 'react';
import type { TtsRecording } from '@tierwyn/shared';
import { api } from './api.js';
import { lsGet, lsSet, lsRemove } from './prefixedStorage.js';

export type TtsParkStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ready' | 'error';

export interface TtsParkSnapshot {
  /** Durable server job id — identity for every mutator guard. */
  jobId: string | null;
  recording: TtsRecording | null;
  conversationId: string | null;
  status: TtsParkStatus;
  currentTime: number;
  duration: number;
  error: string | null;
  /** True while the Recordings modal is mounted — hide mini-player chrome. */
  modalOpen: boolean;
}

type Listener = () => void;

const listeners = new Set<Listener>();

const JOB_STORAGE_KEY = 'tierwyn.tts.job';
const POLL_FAST_MS = 1000;
const POLL_SLOW_MS = 2500;
const POLL_FAST_COUNT = 3;
const POLL_HARD_STOP_MS = 5 * 60_000;
const ERROR_AUTO_DISMISS_MS = 20_000;

/** ~50 ms silent WAV — unlocks autoplay on the same HTMLAudioElement. */
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
/** Skip timeupdate jumps while the user is dragging a scrubber. */
let seeking = false;
/** Fired once when this load ends, errors, is stopped, or is replaced. */
let endedCb: (() => void) | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollGeneration = 0;
let errorDismissTimer: ReturnType<typeof setTimeout> | null = null;

let snapshot: TtsParkSnapshot = {
  jobId: null,
  recording: null,
  conversationId: null,
  status: 'idle',
  currentTime: 0,
  duration: 0,
  error: null,
  modalOpen: false,
};

/** Persisted library rows (non-ephemeral, done, with path) can be re-fetched / downloaded. */
export function isPersistedTtsRecording(rec: TtsRecording | null | undefined): boolean {
  if (!rec?.id) return false;
  if (rec.ephemeral) return false;
  if (rec.status && rec.status !== 'done') return false;
  if (!rec.path) return false;
  // Legacy client-fabricated ids (pre-job path).
  if (rec.id.startsWith('ephemeral-') || rec.id.startsWith('pending-')) return false;
  return true;
}

function persistJobId(jobId: string | null): void {
  try {
    if (jobId) lsSet(JOB_STORAGE_KEY, jobId);
    else lsRemove(JOB_STORAGE_KEY);
  } catch { /* private mode / quota */ }
}

export function readStoredTtsJobId(): string | null {
  try {
    return lsGet(JOB_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearStoredTtsJobId(): void {
  persistJobId(null);
}

function fireEnded(): void {
  const cb = endedCb;
  endedCb = null;
  try { cb?.(); } catch { /* UI hooks must not break player */ }
}

/** Avoid dual audio with live chat TTS (dynamic import — no cycle with speak.ts). */
function stopLiveSpeak(): void {
  void import('./speak.js').then((m) => m.stopSpeaking()).catch(() => { /* ignore */ });
}

function emit(): void {
  for (const l of listeners) l();
}

function setSnapshot(partial: Partial<TtsParkSnapshot>): void {
  snapshot = { ...snapshot, ...partial };
  emit();
}

export function getTtsParkState(): TtsParkSnapshot {
  return snapshot;
}

export function subscribeTtsPark(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Shared React subscription for park player chrome (panel + mini-bar + modal). */
export function useParkSnapshot(): TtsParkSnapshot {
  const [snap, setSnap] = useState(getTtsParkState);
  useEffect(() => subscribeTtsPark(() => setSnap(getTtsParkState())), []);
  return snap;
}

export function setTtsParkModalOpen(open: boolean): void {
  if (snapshot.modalOpen === open) return;
  setSnapshot({ modalOpen: open });
}

export function setTtsParkSeeking(active: boolean): void {
  seeking = active;
}

function clearPoll(): void {
  pollGeneration += 1;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function clearErrorDismiss(): void {
  if (errorDismissTimer) {
    clearTimeout(errorDismissTimer);
    errorDismissTimer = null;
  }
}

function clearMediaSession(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  } catch { /* older browsers */ }
}

function updateMediaSession(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const rec = snapshot.recording;
  if (!rec) {
    clearMediaSession();
    return;
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: rec.title || 'Recording',
      artist: 'Tierwyn',
      album: `${rec.provider} · ${rec.mode}`,
    });
    navigator.mediaSession.playbackState =
      snapshot.status === 'playing' ? 'playing'
        : snapshot.status === 'paused' || snapshot.status === 'ready' ? 'paused'
          : 'none';
    if (snapshot.duration > 0 && Number.isFinite(snapshot.currentTime)) {
      navigator.mediaSession.setPositionState?.({
        duration: snapshot.duration,
        playbackRate: 1,
        position: Math.min(snapshot.currentTime, snapshot.duration),
      });
    }
  } catch { /* MediaMetadata / setPositionState not fully supported */ }
}

function bindMediaSessionHandlers(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('play', () => { void ttsParkResume(); });
    navigator.mediaSession.setActionHandler('pause', () => { ttsParkPause(); });
    navigator.mediaSession.setActionHandler('stop', () => { ttsParkStop(); });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) ttsParkSeek(details.seekTime);
    });
  } catch { /* action not supported */ }
}

function teardownAudio(opts?: { keepMeta?: boolean; fireEnd?: boolean }): void {
  const keepMeta = opts?.keepMeta === true;
  const shouldFireEnd = opts?.fireEnd !== false;
  if (audio) {
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.removeAttribute('src');
    try { audio.load(); } catch { /* ignore */ }
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (!keepMeta) {
    clearPoll();
    clearErrorDismiss();
    setSnapshot({
      jobId: null,
      recording: null,
      conversationId: null,
      status: 'idle',
      currentTime: 0,
      duration: 0,
      error: null,
    });
    clearMediaSession();
  }
  if (shouldFireEnd) fireEnded();
  else endedCb = null;
}

function attachAudioEvents(el: HTMLAudioElement, jobId: string): void {
  el.addEventListener('loadedmetadata', () => {
    if (audio !== el || snapshot.jobId !== jobId) return;
    setSnapshot({
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    });
    updateMediaSession();
  });
  el.addEventListener('durationchange', () => {
    if (audio !== el || snapshot.jobId !== jobId) return;
    setSnapshot({
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    });
    updateMediaSession();
  });
  el.addEventListener('timeupdate', () => {
    if (audio !== el || seeking || snapshot.jobId !== jobId) return;
    setSnapshot({ currentTime: el.currentTime });
    updateMediaSession();
  });
  el.addEventListener('play', () => {
    if (audio !== el || snapshot.jobId !== jobId) return;
    setSnapshot({ status: 'playing' });
    updateMediaSession();
  });
  el.addEventListener('pause', () => {
    if (audio !== el || snapshot.jobId !== jobId) return;
    // ended also fires pause — onended handles idle
    if (el.ended) return;
    if (snapshot.status === 'ready') return;
    setSnapshot({ status: 'paused' });
    updateMediaSession();
  });
  el.onended = () => {
    if (audio !== el || snapshot.jobId !== jobId) return;
    teardownAudio();
    clearStoredTtsJobId();
  };
  el.onerror = () => {
    if (audio !== el || snapshot.jobId !== jobId) return;
    setParkError(jobId, 'Playback failed');
  };
}

function setParkError(jobId: string, message: string): void {
  if (snapshot.jobId !== jobId) return;
  clearPoll();
  clearErrorDismiss();
  // Keep meta for the bar; drop media.
  if (audio) {
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.removeAttribute('src');
    try { audio.load(); } catch { /* ignore */ }
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  setSnapshot({
    status: 'error',
    error: message,
    currentTime: 0,
    duration: 0,
  });
  clearMediaSession();
  fireEnded();
  errorDismissTimer = setTimeout(() => {
    if (snapshot.jobId === jobId && snapshot.status === 'error') {
      teardownAudio({ fireEnd: false });
      clearStoredTtsJobId();
    }
  }, ERROR_AUTO_DISMISS_MS);
}

/**
 * Ensure an HTMLAudioElement exists and try a silent play() to consume the
 * user-gesture autoplay grant. Same element is reused when real audio arrives.
 */
export function ensureUnlockedAudio(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio(SILENT_WAV_DATA_URI);
  audio = el;
  // Best-effort unlock — rejection still leaves us able to land in ready later.
  void el.play().then(() => {
    try {
      el.pause();
      el.currentTime = 0;
    } catch { /* ignore */ }
  }).catch(() => { /* autoplay blocked — ready path handles later */ });
  return el;
}

async function fetchAndPlayJobAudio(jobId: string, rec: TtsRecording): Promise<void> {
  if (snapshot.jobId !== jobId) return;
  try {
    const res = await fetch(api.ttsRecordingAudioUrl(rec.id), { credentials: 'include' });
    if (snapshot.jobId !== jobId) return;
    if (!res.ok) throw new Error(`audio ${res.status}`);
    const blob = await res.blob();
    if (snapshot.jobId !== jobId) return;

    const url = URL.createObjectURL(blob);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url;

    const el = audio ?? new Audio();
    audio = el;
    el.src = url;
    attachAudioEvents(el, jobId);
    bindMediaSessionHandlers();

    try {
      await el.play();
      if (snapshot.jobId !== jobId || audio !== el) return;
      setSnapshot({ status: 'playing', recording: rec, error: null });
      updateMediaSession();
    } catch {
      // Autoplay blocked — visible ready state, not silent idle.
      if (snapshot.jobId !== jobId) return;
      setSnapshot({ status: 'ready', recording: rec, error: null });
      updateMediaSession();
    }
  } catch (e) {
    if (snapshot.jobId !== jobId) return;
    setParkError(jobId, e instanceof Error ? e.message : String(e));
  }
}

function schedulePoll(
  jobId: string,
  attempt: number,
  startedAt: number,
): void {
  const gen = pollGeneration;
  const delay = attempt < POLL_FAST_COUNT ? POLL_FAST_MS : POLL_SLOW_MS;
  pollTimer = setTimeout(() => {
    void (async () => {
      if (gen !== pollGeneration || snapshot.jobId !== jobId) return;
      if (Date.now() - startedAt > POLL_HARD_STOP_MS) {
        setParkError(jobId, 'TTS job timed out');
        return;
      }

      try {
        const res = await fetch(`/tts/recordings/${jobId}`, { credentials: 'include' });
        if (gen !== pollGeneration || snapshot.jobId !== jobId) return;

        if (res.status === 404) {
          if (attempt >= 2) {
            setParkError(jobId, 'lost track of job');
            return;
          }
          schedulePoll(jobId, attempt + 1, startedAt);
          return;
        }
        if (!res.ok) {
          if (attempt >= 2) {
            setParkError(jobId, `lost track of job (${res.status})`);
            return;
          }
          schedulePoll(jobId, attempt + 1, startedAt);
          return;
        }

        const body = await res.json() as { recording?: TtsRecording };
        const rec = body.recording;
        if (!rec || snapshot.jobId !== jobId) return;

        setSnapshot({ recording: rec, conversationId: rec.conversation_id });

        if (rec.status === 'running') {
          schedulePoll(jobId, attempt + 1, startedAt);
          return;
        }
        if (rec.status === 'error') {
          setParkError(jobId, rec.error || 'TTS job failed');
          return;
        }
        if (rec.status === 'done') {
          clearPoll();
          // Keep job id in storage until user dismisses / play ends — rehydrate to ready.
          await fetchAndPlayJobAudio(jobId, rec);
          return;
        }
        schedulePoll(jobId, attempt + 1, startedAt);
      } catch {
        if (gen !== pollGeneration || snapshot.jobId !== jobId) return;
        if (attempt >= 2) {
          setParkError(jobId, 'lost track of job');
          return;
        }
        schedulePoll(jobId, attempt + 1, startedAt);
      }
    })();
  }, delay);
}

/**
 * Begin tracking a durable speak-record job. Call synchronously inside the
 * click handler so the silent-WAV unlock consumes the user gesture.
 */
export function ttsParkBeginJob(
  jobId: string,
  provisionalRec: TtsRecording,
  onEnd?: () => void,
): void {
  teardownAudio({ fireEnd: true });
  stopLiveSpeak();
  clearPoll();
  clearErrorDismiss();
  endedCb = onEnd ?? null;
  persistJobId(jobId);

  setSnapshot({
    jobId,
    recording: provisionalRec,
    conversationId: provisionalRec.conversation_id,
    status: 'loading',
    currentTime: 0,
    duration: 0,
    error: null,
  });

  ensureUnlockedAudio();
  schedulePoll(jobId, 0, Date.now());
}

/**
 * Resume polling / surface a terminal row after boot re-hydration.
 * `done` → ready (no autoplay without a gesture). `running` → loading + poll.
 * `error` → error chrome.
 */
export function ttsParkRehydrate(rec: TtsRecording, opts?: { resumePoll?: boolean }): void {
  teardownAudio({ fireEnd: false });
  clearPoll();
  clearErrorDismiss();
  endedCb = null;
  // Synthetic client-side error rows (`error-<ts>`, speak.ts handshake failures)
  // must not claim the stored job slot — that would drop a real running job's
  // re-hydration on the next page load.
  if (!rec.id.startsWith('error-')) persistJobId(rec.id);

  if (rec.status === 'running' || opts?.resumePoll) {
    setSnapshot({
      jobId: rec.id,
      recording: rec,
      conversationId: rec.conversation_id,
      status: 'loading',
      currentTime: 0,
      duration: 0,
      error: null,
    });
    schedulePoll(rec.id, 0, Date.now());
    return;
  }

  if (rec.status === 'error') {
    setSnapshot({
      jobId: rec.id,
      recording: rec,
      conversationId: rec.conversation_id,
      status: 'error',
      currentTime: 0,
      duration: 0,
      error: rec.error || 'TTS job failed',
    });
    errorDismissTimer = setTimeout(() => {
      if (snapshot.jobId === rec.id && snapshot.status === 'error') {
        teardownAudio({ fireEnd: false });
        clearStoredTtsJobId();
      }
    }, ERROR_AUTO_DISMISS_MS);
    return;
  }

  // done → ready, no autoplay
  setSnapshot({
    jobId: rec.id,
    recording: rec,
    conversationId: rec.conversation_id,
    status: 'ready',
    currentTime: 0,
    duration: 0,
    error: rec.error, // may hold summarize-fallback warning
  });
}

/** Play a recording, or toggle pause/resume if the same id is already loaded. */
export async function ttsParkPlay(
  rec: TtsRecording,
  conversationId: string | null,
): Promise<void> {
  setSnapshot({ error: null });

  if (snapshot.jobId === rec.id && audio && (snapshot.status === 'playing' || snapshot.status === 'paused' || snapshot.status === 'ready')) {
    if (audio.paused || snapshot.status === 'ready') {
      try {
        stopLiveSpeak();
        await audio.play();
        if (snapshot.jobId !== rec.id) return;
        setSnapshot({ status: 'playing' });
        updateMediaSession();
      } catch (e) {
        if (snapshot.jobId !== rec.id) return;
        setSnapshot({
          status: 'ready',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      audio.pause();
      setSnapshot({ status: 'paused' });
      updateMediaSession();
    }
    return;
  }

  // Library play of a done row — treat as a new session keyed by rec.id.
  teardownAudio({ fireEnd: true });
  stopLiveSpeak();
  clearPoll();
  const jobId = rec.id;
  endedCb = null;
  persistJobId(jobId);
  setSnapshot({
    jobId,
    recording: rec,
    conversationId: conversationId ?? rec.conversation_id,
    status: 'loading',
    currentTime: 0,
    duration: 0,
    error: null,
  });

  ensureUnlockedAudio();

  if (rec.status === 'running') {
    schedulePoll(jobId, 0, Date.now());
    return;
  }
  if (rec.status === 'error') {
    setParkError(jobId, rec.error || 'TTS job failed');
    return;
  }

  await fetchAndPlayJobAudio(jobId, rec);
}

export function ttsParkPause(): void {
  if (!audio || audio.paused) return;
  if (snapshot.jobId == null) return;
  audio.pause();
  setSnapshot({ status: 'paused' });
  updateMediaSession();
}

export async function ttsParkResume(): Promise<void> {
  if (!audio) {
    // ready without loaded element (boot rehydrate) — fetch then play.
    if (snapshot.status === 'ready' && snapshot.recording && snapshot.jobId) {
      ensureUnlockedAudio();
      const jobId = snapshot.jobId;
      const rec = snapshot.recording;
      setSnapshot({ status: 'loading', error: null });
      await fetchAndPlayJobAudio(jobId, rec);
    }
    return;
  }
  if (!audio.paused && snapshot.status === 'playing') return;
  const jobId = snapshot.jobId;
  try {
    stopLiveSpeak();
    await audio.play();
    if (snapshot.jobId !== jobId) return;
    setSnapshot({ status: 'playing', error: null });
    updateMediaSession();
  } catch (e) {
    if (snapshot.jobId !== jobId) return;
    setSnapshot({
      status: 'ready',
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export function ttsParkStop(): void {
  const jobId = snapshot.jobId;
  teardownAudio({ fireEnd: true });
  if (jobId) clearStoredTtsJobId();
}

/** Dismiss error/ready chrome without playing. */
export function ttsParkDismiss(): void {
  const jobId = snapshot.jobId;
  teardownAudio({ fireEnd: false });
  if (jobId) clearStoredTtsJobId();
}

export function ttsParkSeek(seconds: number): void {
  if (!audio || !Number.isFinite(seconds) || snapshot.jobId == null) return;
  audio.currentTime = Math.max(0, seconds);
  setSnapshot({ currentTime: audio.currentTime });
  updateMediaSession();
}

/**
 * Download a persisted recording for offline / system player.
 * Kokoro → MP3 (server converts with ffmpeg); Piper → WAV.
 */
export async function downloadTtsRecording(rec: TtsRecording): Promise<void> {
  if (!isPersistedTtsRecording(rec)) {
    throw new Error('Recording was not saved — enable Save recordings in Settings');
  }
  const res = await fetch(api.ttsRecordingAudioUrl(rec.id, { download: true }), {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const base = (rec.title || rec.source || 'recording')
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'recording';
  // Prefer server Content-Type; Kokoro download is audio/mpeg.
  const ct = res.headers.get('content-type') ?? '';
  const ext = ct.includes('mpeg') || ct.includes('mp3') || rec.provider === 'kokoro'
    ? 'mp3'
    : 'wav';
  // If server fell back to wav after convert failure, content-type is wav.
  const finalExt = ct.includes('wav') ? 'wav' : ext;
  a.download = `${base}-${rec.id.slice(0, 8)}.${finalExt}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Whether the mini-player chrome should render. */
export function ttsParkMiniVisible(s: TtsParkSnapshot = snapshot): boolean {
  return !s.modalOpen
    && s.recording != null
    && (
      s.status === 'playing'
      || s.status === 'paused'
      || s.status === 'loading'
      || s.status === 'ready'
      || s.status === 'error'
    );
}
