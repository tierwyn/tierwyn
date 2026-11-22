import { useState, useRef, useCallback, useEffect } from 'react';
import { getWhisperModel } from './voiceSettings.js';

/**
 * Local whisper.cpp STT — record → POST /transcribe → text. Mirrors the
 * signature of `useSpeechInput` so InputBar can swap between the two on the
 * `sttEngine` setting. Batch (not streaming): one transcription per toggle.
 *
 * Unlike the browser Web Speech API, this path works offline and supports
 * multiple languages. Server-side pipeline: ffmpeg → whisper-cli →
 * [optional cleanup LLM]. See `apps/server/src/adapters/whisper.ts`.
 */
export function useWhisperInput(
  onFinalText: (chunk: string, pinnedConversationId: string | null, autoSent: boolean) => void,
  getConversationId: () => string | null,
): {
  supported: boolean;
  listening: boolean;
  transcribing: boolean;
  /** Conversation id pinned at record-start; set while transcribing, else null. */
  transcribingConversationId: string | null;
  toggle: (opts?: {
    skipCleanup?: boolean;
    promptId?: string;
    enhanceContext?: boolean;
    enhanceProject?: boolean;
  }) => void;
  /** Stop recording, or abort an in-flight transcription upload.
   *  Server-side cancel is InputBar's job (POST /transcribe/cancel) so a click
   *  on a remote processing visual can abort a job this tab is not waiting on. */
  cancel: () => void;
  error: string | null;
  /** Returns 0..1 mic amplitude for visualisation, or null when no analyser
   *  is attached (e.g. before recording starts). Drives VoiceWave. */
  getMicLevel: (() => number) | null;
} {
  const supported = typeof window !== 'undefined'
    && 'MediaRecorder' in window
    && !!navigator.mediaDevices?.getUserMedia;

  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribingConversationId, setTranscribingConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs hold the live state so toggle() can read the latest values without
  // being rebuilt on every render.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Race guard: toggled off before getUserMedia resolved (matching the stop-before-start race guard).
  const stopRequestedRef = useRef(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  // Conversation id pinned at record-start (D7) — never re-read at result time.
  const pinnedCidRef = useRef<string | null>(null);
  // ponytail: the Fast/Slow choice for the *next* recording. Set by toggle(),
  // read by upload() when the recording stops.
  const modeRef = useRef<{
    skipCleanup: boolean;
    promptId?: string;
    enhanceContext: boolean;
    enhanceProject: boolean;
  }>({ skipCleanup: false, enhanceContext: false, enhanceProject: false });

  // Web Audio analyser tapping the same stream MediaRecorder captures. Owned
  // by the hook so the AudioContext lifecycle is bounded by the recording
  // cycle (created on start, closed on stop/unmount). Used by VoiceWave to
  // react to the user's actual voice loudness.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Constructed via ArrayBuffer so the inferred generic satisfies the strict
  // Uint8Array<ArrayBuffer> signature TS 5.9 lib.dom requires. Sized to a
  // conservative 512 bins; getByteTimeDomainData writes min(binCount, len).
  const levelBufRef = useRef<Uint8Array<ArrayBuffer>>(
    new Uint8Array(new ArrayBuffer(512)),
  );

  /** Pick the best mime the browser supports — Chrome/Edge give opus webm,
   *  Safari gives mp4, Firefox gives ogg. ffmpeg handles all of them. */
  function pickMime(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return ''; // default — let the browser pick
  }

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    // Close the AudioContext (best-effort — never throws on unmount).
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => { /* already closed */ });
    audioCtxRef.current = null;
  }, []);

  const upload = useCallback(async (blob: Blob) => {
    setError(null);
    setTranscribing(true);
    setTranscribingConversationId(pinnedCidRef.current);
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const model = getWhisperModel();
    const language = (navigator.language || 'auto').split('-')[0] || 'auto';
    const { skipCleanup, promptId, enhanceContext, enhanceProject } = modeRef.current;
    const params = new URLSearchParams({ model, language });
    if (skipCleanup) params.set('skipCleanup', '1');
    if (promptId) params.set('promptId', promptId);
    if (enhanceProject) params.set('enhanceProject', '1');
    else if (enhanceContext) params.set('enhanceContext', '1');
    if (pinnedCidRef.current) params.set('conversationId', pinnedCidRef.current);
    const fd = new FormData();
    const ext = blob.type.includes('mp4') ? 'm4a'
      : blob.type.includes('ogg') ? 'ogg'
      : 'webm';
    fd.append('audio', blob, `recording.${ext}`);
    try {
      const r = await fetch(`/transcribe?${params.toString()}`, {
        method: 'POST',
        body: fd,
        credentials: 'include',
        signal: controller.signal,
      });
      if (r.status === 401) {
        setError('Not authenticated — refresh and try again.');
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => null) as { error?: string; detail?: string } | null;
        setError(j?.error ?? `Transcription failed (HTTP ${r.status})`);
        return;
      }
      const j = await r.json() as { text: string; autoSent?: boolean; autoSendError?: string };
      if (j.autoSendError) setError(j.autoSendError);
      if (typeof j.text === 'string' && j.text.length > 0) {
        onFinalText(j.text, pinnedCidRef.current, j.autoSent === true);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTranscribing(false);
      setTranscribingConversationId(null);
      fetchAbortRef.current = null;
    }
  }, [onFinalText]);

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') {
      // Triggers `onstop` after the final dataavailable fires.
      try { mr.stop(); } catch { /* ignore */ }
    } else {
      // Recorder never started — clean up any half-acquired stream.
      cleanupStream();
      setListening(false);
    }
  }, [cleanupStream]);

  const start = useCallback(async () => {
    setError(null);
    stopRequestedRef.current = false;
    pinnedCidRef.current = getConversationId();
    chunksRef.current = [];
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setError(e instanceof Error ? `Mic permission denied: ${e.message}` : 'Mic permission denied');
      return;
    }
    // Race: user toggled off while the permission prompt was open.
    if (stopRequestedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      // Reset so the next toggle starts a fresh recording instead of
      // re-entering stop() (which would find no recorder to stop).
      stopRequestedRef.current = false;
      return;
    }
    streamRef.current = stream;
    // Tap the same stream for amplitude analysis. AudioContext must be
    // created in a user gesture — toggle() qualifies. Resume is a no-op if
    // already running. Failures are non-fatal: VoiceWave falls back to flat.
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        void ctx.resume();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 1024; // 512 bins — plenty for RMS loudness
        src.connect(an);  // do NOT connect to destination (no playback)
        audioCtxRef.current = ctx;
        analyserRef.current = an;
      }
    } catch { /* analyser optional */ }
    const mime = pickMime();
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.onstop = () => {
      // The final dataavailable event is dispatched before onstop per spec,
      // but several browser engines (Safari mp4, older Chrome) have shipped
      // bugs where it lands on a later microtask. Defer the blob assembly to
      // the next macrotask so the final chunk is appended first.
      setTimeout(() => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        cleanupStream();
        setListening(false);
        // Recording cycle complete — release the race guard so the next
        // toggle() starts a new recording instead of being routed to stop().
        stopRequestedRef.current = false;
        if (blob.size > 0) {
          // Fire-and-forget — setTranscribing drives the UI.
          void upload(blob);
        }
      }, 0);
    };
    mr.onerror = () => {
      setError('MediaRecorder error');
      cleanupStream();
      setListening(false);
    };
    // timeslice: emit dataavailable every ~250ms instead of buffering the
    // whole recording in the browser. Limits any stop/onstop race loss to the
    // final slice rather than the entire utterance.
    mr.start(250);
    setListening(true);
  }, [cleanupStream, upload, getConversationId]);

  /** Read the current mic amplitude (0..1) for the visualiser. Returns 0
   *  when no analyser is attached. Fast-attack/slow-release smoothing is
   *  applied by VoiceWave's draw loop, not here. */
  const getMicLevel = useCallback(() => {
    const an = analyserRef.current;
    if (!an) return 0;
    const buf = levelBufRef.current;
    const n = Math.min(an.frequencyBinCount, buf.length);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = (buf[i] - 128) / 128; // centred on 128 → -1..1
      sum += v * v;
    }
    const rms = Math.sqrt(sum / n);
    return Math.min(1, rms * 20); // ponytail: *20 boost — was *12; increase here first if too hot
  }, []);

  const toggle = useCallback((opts?: {
    skipCleanup?: boolean;
    promptId?: string;
    enhanceContext?: boolean;
    enhanceProject?: boolean;
  }) => {
    if (listening || stopRequestedRef.current) {
      stop();
    } else {
      modeRef.current = {
        skipCleanup: opts?.skipCleanup ?? false,
        promptId: opts?.promptId,
        enhanceContext: opts?.enhanceContext ?? false,
        enhanceProject: opts?.enhanceProject ?? false,
      };
      void start();
    }
  }, [listening, start, stop]);

  const cancel = useCallback(() => {
    if (listening || stopRequestedRef.current) {
      stop();
      return;
    }
    // User-initiated cancel stops the client from waiting; the server finishes
    // and the result arrives via the draft_updated broadcast.
    fetchAbortRef.current?.abort();
    setTranscribing(false);
    setTranscribingConversationId(null);
    fetchAbortRef.current = null;
  }, [listening, stop]);

  // Tear down everything on unmount.
  useEffect(() => {
    return () => {
      stopRequestedRef.current = true;
      // Abort only closes the socket; the server keeps working (D1 / D10).
      fetchAbortRef.current?.abort();
      try { mediaRecorderRef.current?.stop(); } catch { /* ignore */ }
      cleanupStream();
    };
  }, [cleanupStream]);

  return {
    supported,
    listening,
    transcribing,
    transcribingConversationId,
    toggle,
    cancel,
    error,
    getMicLevel,
  };
}
