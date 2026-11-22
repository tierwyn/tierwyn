import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { AbcElem, CursorControl, ProgressUnit, TuneObject } from 'abcjs';
import {
  INSTRUMENTS,
  initialProgramForTune,
  makeAudioParams,
  midiFileName,
  tuneMidiProgram,
} from './abcInstruments.js';
import {
  clearPlaybackVisuals,
  schedulePlaybackCursor,
  updatePlaybackVisuals,
  type PlaybackCursorPosition,
} from './abcPlaybackCursor.js';

const WARP_PRESETS = [50, 75, 100, 125, 150, 200] as const;

const WARP_LABELS: Record<(typeof WARP_PRESETS)[number], string> = {
  50: '½×', 75: '¾×', 100: '1×', 125: '1¼×', 150: '1½×', 200: '2×',
};
const REWIND_MS = 5000;
const THUMB_PX = 14;

/** abcjs exposes seek() at runtime but types may omit or differ across controller instances. */
type SeekableSynth = import('abcjs').SynthObjectController & {
  seek(position: number, units?: ProgressUnit): void;
};

function seekSynth(
  ctl: import('abcjs').SynthObjectController | null,
  position: number,
  units?: ProgressUnit,
): void {
  (ctl as SeekableSynth | null)?.seek?.(position, units);
}

type AbcElemWithTiming = AbcElem & {
  currentTrackMilliseconds?: number | number[];
};

export interface AbcAudioHandle {
  seekToNote(abcElem: AbcElem): Promise<void>;
  isPlaying(): boolean;
}

interface Props {
  source: string;
  visualObj: TuneObject;
  scoreRef: RefObject<HTMLDivElement | null>;
  tablature?: boolean;
  onToggleTablature?: () => void;
  showKeyboard?: boolean;
  onToggleKeyboard?: () => void;
  onActivePitchesChange?: (pitches: readonly number[]) => void;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function noteStartMs(abcElem: AbcElemWithTiming): number | undefined {
  const ms = abcElem.currentTrackMilliseconds;
  if (ms === undefined) return undefined;
  return Array.isArray(ms) ? ms[0] : ms;
}

/** playEvent() assumes meter size 1; scale ms/measure so 3/8 etc. get correct note length. */
function playEventMsPerMeasure(visualObj: TuneObject, warpPct: number): number {
  const meter = visualObj.getMeterFraction?.() ?? { num: 4, den: 4 };
  const meterSize = meter.den ? meter.num / meter.den : 1;
  return (visualObj.millisecondsPerMeasure() * 100 / warpPct) / meterSize;
}

export const AbcAudioControls = forwardRef<AbcAudioHandle, Props>(function AbcAudioControls(
  {
    source,
    visualObj,
    scoreRef,
    tablature,
    onToggleTablature,
    showKeyboard,
    onToggleKeyboard,
    onActivePitchesChange,
  },
  ref,
): ReactNode {
  const synthRef = useRef<import('abcjs').SynthObjectController | null>(null);
  const hiddenRef = useRef<HTMLDivElement>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const warpingRef = useRef(false);
  const warpingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWarpRef = useRef(100);
  const playingRef = useRef(false);
  const progressPctRef = useRef(0);
  const lastProgressUiSyncRef = useRef(0);
  const midiReadyRef = useRef(false);
  const programRef = useRef(0);
  const genRef = useRef(0);

  const [status, setStatus] = useState<Status>('idle');
  const [playing, setPlaying] = useState(false);
  const [program, setProgram] = useState(() => initialProgramForTune(visualObj, undefined));
  const [tuneHasProgram, setTuneHasProgram] = useState(false);
  const [errMsg, setErrMsg] = useState<string>('');
  const [progressPct, setProgressPct] = useState(0);
  const [scrubPct, setScrubPct] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [currentBeat, setCurrentBeat] = useState(0);
  const [totalBeats, setTotalBeats] = useState(0);
  const [warp, setWarp] = useState(100);
  const [scrubbing, setScrubbing] = useState(false);

  const baseBpm = visualObj.getBpm?.() || 120;
  const minBpm = Math.round(baseBpm * 0.5);
  const maxBpm = Math.round(baseBpm * 2);
  const [bpm, setBpm] = useState(baseBpm);
  const [bpmDraft, setBpmDraft] = useState(String(baseBpm));
  const beatsPerMeasure = visualObj.getBeatsPerMeasure?.() || 4;
  const estimatedBeats = Math.max(1, Math.round(visualObj.getTotalBeats?.() || 0));
  const totalMeasures = Math.max(1, Math.ceil(estimatedBeats / beatsPerMeasure));
  const isPresetWarp = (WARP_PRESETS as readonly number[]).includes(warp);
  const currentMeasure = totalBeats > 0
    ? Math.min(totalMeasures, Math.floor(currentBeat / beatsPerMeasure) + 1)
    : 0;

  playingRef.current = playing;
  progressPctRef.current = progressPct;
  programRef.current = program;

  const audioParams = useMemo(() => makeAudioParams(program), [program]);

  const syncProgressFromMs = (targetMs: number, durationMs: number) => {
    const total = durationMs > 0 ? durationMs : totalMs;
    if (total <= 0) return;
    const pct = Math.max(0, Math.min(1, targetMs / total));
    setProgressPct(pct);
    setScrubPct(pct);
    if (totalBeats > 0) setCurrentBeat(Math.floor(pct * totalBeats));
  };

  const cursorControl = useMemo<CursorControl>(() => ({
    onBeat: (beat, beats, durationMs, ...rest: unknown[]) => {
      if (scrubbingRef.current || warpingRef.current) return;
      // abcjs passes interpolated cursor position as a 4th arg (omitted from published types).
      const pos = rest[0] as PlaybackCursorPosition | undefined;
      if (pos?.left != null && pos.top != null && pos.height != null) {
        schedulePlaybackCursor(scoreRef.current, pos);
      }
      // Throttle React progress UI — full setState every beat fights the cursor rAF.
      const now = performance.now();
      if (now - lastProgressUiSyncRef.current < 80) return;
      lastProgressUiSyncRef.current = now;
      const pct = beats > 0 ? beat / beats : 0;
      setProgressPct(pct);
      setScrubPct(pct);
      setTotalMs(durationMs);
      setCurrentBeat(Math.floor(beat));
      setTotalBeats(Math.floor(beats));
    },
    onEvent: (ev) => {
      if (warpingRef.current) return;
      updatePlaybackVisuals(scoreRef.current, ev);
      if (onActivePitchesChange) {
        const pitches = ev.midiPitches?.map((p) => p.pitch) ?? [];
        onActivePitchesChange(pitches);
      }
    },
    onFinished: () => {
      if (warpingRef.current) return;
      lastProgressUiSyncRef.current = 0;
      playingRef.current = false;
      setPlaying(false);
      setProgressPct(0);
      setScrubPct(0);
      setCurrentBeat(0);
      clearPlaybackVisuals(scoreRef.current);
      onActivePitchesChange?.([]);
    },
  }), [scoreRef]);

  const ensureSynth = async (): Promise<import('abcjs').SynthObjectController | null> => {
    if (synthRef.current) return synthRef.current;
    const currentGen = ++genRef.current;
    setStatus('loading');
    const abcjs = (await import('abcjs')).default;
    if (currentGen !== genRef.current) return null;
    if (!abcjs.synth.supportsAudio()) {
      setErrMsg('Audio playback is not supported in this browser.');
      setStatus('error');
      throw new Error('no audio');
    }
    const ctl = new abcjs.synth.SynthController();
    ctl.load(hiddenRef.current!, cursorControl, {
      displayLoop: false, displayRestart: false, displayPlay: false,
      displayProgress: false,
      // abcjs setWarp() writes to .abcjs-midi-tempo; element only exists when displayWarp is on.
      displayWarp: true,
    } as never);
    const fmt = (visualObj as any).formatting?.midi;
    if (fmt && Array.isArray(fmt.program)) {
      fmt.program = [programRef.current];
    }
    await ctl.setTune(visualObj, true, audioParams);
    if (currentGen !== genRef.current) {
      ctl.pause();
      return null;
    }
    synthRef.current = ctl;
    setStatus('ready');
    return ctl;
  };

  const seekToNote = async (abcElem: AbcElem) => {
    if (abcElem.el_type !== 'note' || !abcElem.pitches?.length) return;
    try {
      const abcjs = (await import('abcjs')).default;
      const warpPct = pendingWarpRef.current;

      const ensureMidiPitches = () => {
        if (midiReadyRef.current) return;
        const fmt = (visualObj as any).formatting?.midi;
        if (fmt && Array.isArray(fmt.program)) {
          fmt.program = [programRef.current];
        }
        visualObj.setUpAudio?.({ program: programRef.current });
        midiReadyRef.current = true;
      };

      const previewNote = async () => {
        ensureMidiPitches();
        const pitches = abcElem.midiPitches;
        if (!pitches?.length) return;
        await abcjs.synth.playEvent(
          pitches,
          abcElem.midiGraceNotePitches,
          playEventMsPerMeasure(visualObj, warpPct),
        );
      };

      if (!playingRef.current) {
        await previewNote();
        return;
      }

      const ctl = await ensureSynth();
      if (!ctl) return;
      const elem = abcElem as AbcElemWithTiming;
      const startMs = noteStartMs(elem);
      const durationMs = totalMs > 0 ? totalMs : (visualObj.getTotalTime?.() ?? 0) * 1000;

      if (startMs !== undefined && durationMs > 0) {
        seekSynth(ctl, startMs / 1000, 'seconds');
        syncProgressFromMs(startMs, durationMs);
        return;
      }

      await previewNote();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      console.error('[abcjs audio]', e);
      setStatus('error');
    }
  };

  useImperativeHandle(ref, () => ({
    seekToNote,
    isPlaying: () => playing,
  }), [visualObj, totalMs, totalBeats, playing]);

  useEffect(() => {
    genRef.current += 1;
    synthRef.current?.pause();
    synthRef.current = null;
    midiReadyRef.current = false;
    clearPlaybackVisuals(scoreRef.current);
    const fromTune = tuneMidiProgram(visualObj);
    setTuneHasProgram(fromTune != null);
    setProgram(initialProgramForTune(visualObj, undefined));
    setStatus('idle');
    setPlaying(false);
    setProgressPct(0);
    setScrubPct(0);
    setCurrentBeat(0);
    setTotalMs(0);
    setWarp(100);
    pendingWarpRef.current = 100;
    setBpm(baseBpm);
    setBpmDraft(String(baseBpm));
  }, [visualObj, baseBpm, scoreRef]);

  const onInstrumentChange = async (nextRaw: number) => {
    const next = Number(nextRaw);
    if (!Number.isFinite(next) || next === program) return;
    genRef.current += 1;
    programRef.current = next;
    const fmt = (visualObj as any).formatting?.midi;
    if (fmt && Array.isArray(fmt.program)) {
      fmt.program = [next];
    }
    setProgram(next);
    synthRef.current?.pause();
    synthRef.current = null;
    midiReadyRef.current = false;
    // The gen bump makes an in-flight ensureSynth return null, so 'loading' must reset here too.
    setStatus((s) => (s === 'error' ? s : 'idle'));
    setPlaying(false);
    playingRef.current = false;
  };

  const onPlayPause = async () => {
    try {
      const ctl = await ensureSynth();
      if (!ctl) return;
      await ctl.play();
      setPlaying((p) => !p);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      console.error('[abcjs audio]', e);
      setStatus('error');
    }
  };

  const onRestart = () => {
    synthRef.current?.restart();
    setProgressPct(0);
    setScrubPct(0);
    setCurrentBeat(0);
    clearPlaybackVisuals(scoreRef.current);
  };

  const onRewind = () => {
    if (totalMs <= 0) return;
    const pct = Math.max(0, progressPct - REWIND_MS / totalMs);
    seekSynth(synthRef.current, pct);
    setProgressPct(pct);
    setScrubPct(pct);
    if (totalBeats > 0) setCurrentBeat(Math.floor(pct * totalBeats));
  };

  const beginWarp = () => {
    if (warpingTimerRef.current) clearTimeout(warpingTimerRef.current);
    warpingRef.current = true;
  };

  const endWarpSoon = () => {
    if (warpingTimerRef.current) clearTimeout(warpingTimerRef.current);
    // Stale timer callbacks from the pre-warp synth can arrive after setWarp resolves.
    warpingTimerRef.current = setTimeout(() => {
      warpingRef.current = false;
      warpingTimerRef.current = null;
    }, 400);
  };

  const applyWarp = async (target: number, nextBpm: number) => {
    setWarp(target);
    setBpm(nextBpm);
    setBpmDraft(String(nextBpm));
    pendingWarpRef.current = target;

    beginWarp();
    const wasPlaying = playingRef.current;
    const startPct = progressPctRef.current;

    try {
      const ctl = await ensureSynth();
      if (!ctl) return;
      await ctl.setWarp(target);
      if (wasPlaying) {
        playingRef.current = true;
        setPlaying(true);
        setProgressPct(startPct);
        setScrubPct(startPct);
        if (totalBeats > 0) setCurrentBeat(Math.floor(startPct * totalBeats));
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      console.error('[abcjs audio]', e);
      setStatus('error');
    } finally {
      endWarpSoon();
    }
  };

  const onWarp = (target: number) => {
    void applyWarp(target, Math.round(baseBpm * target / 100));
  };

  const applyBpm = (target: number) => {
    const next = Math.max(minBpm, Math.min(maxBpm, Math.round(target)));
    const warpPct = Math.max(1, Math.round((next / baseBpm) * 100));
    void applyWarp(warpPct, next);
  };

  const nudgeBpm = (delta: number) => {
    void applyBpm(bpm + delta);
  };

  const commitBpmDraft = () => {
    const trimmed = bpmDraft.trim();
    const parsed = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(parsed)) {
      setBpmDraft(String(bpm));
      return;
    }
    void applyBpm(parsed);
  };

  const ratioFromPointer = (clientX: number): number => {
    const el = scrubberRef.current;
    if (!el) return 0;
    const { left, width } = el.getBoundingClientRect();
    const usable = Math.max(1, width - THUMB_PX);
    return Math.max(0, Math.min(1, (clientX - left - THUMB_PX / 2) / usable));
  };

  const applyScrubPct = (pct: number) => {
    setScrubPct(pct);
    if (totalBeats > 0) setCurrentBeat(Math.floor(pct * totalBeats));
  };

  const finishScrub = (pct: number) => {
    scrubbingRef.current = false;
    setScrubbing(false);
    seekSynth(synthRef.current, pct);
    setProgressPct(pct);
    setScrubPct(pct);
  };

  const onScrubPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbingRef.current = true;
    setScrubbing(true);
    applyScrubPct(ratioFromPointer(e.clientX));
  };

  const onScrubPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    applyScrubPct(ratioFromPointer(e.clientX));
  };

  const onScrubPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    finishScrub(ratioFromPointer(e.clientX));
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onScrubKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    let next = progressPct;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(1, scrubPct + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, scrubPct - step);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    else return;
    e.preventDefault();
    applyScrubPct(next);
    finishScrub(next);
  };

  const onDownloadMidi = async () => {
    try {
      const abcjs = (await import('abcjs')).default;
      // getMidiFile(binary) returns [Uint8Array] (one per tune); export the first tune.
      const midi = abcjs.synth.getMidiFile(source, { midiOutputType: 'binary' }) as unknown;
      const bytes = (Array.isArray(midi) ? midi[0] : midi) as Uint8Array;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/midi' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: midiFileName(source) });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error('[abcjs midi]', e);
    }
  };

  useEffect(() => () => {
    genRef.current += 1;
    if (warpingTimerRef.current) clearTimeout(warpingTimerRef.current);
    synthRef.current?.pause();
    synthRef.current = null;
    clearPlaybackVisuals(scoreRef.current);
  }, [scoreRef]);

  if (status === 'error') return (
    <div className="abc-audio-error" role="alert">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>Audio unavailable{errMsg ? `: ${errMsg}` : ''}</span>
    </div>
  );

  const loading = status === 'loading';
  const displayPct = scrubbing ? scrubPct : progressPct;
  const elapsedMs = totalMs * displayPct;
  const progressStyle = {
    '--abc-progress-ratio': String(displayPct),
    '--abc-measures': String(totalMeasures),
    '--abc-thumb': `${THUMB_PX}px`,
  } as CSSProperties;

  return (
    <div className="abc-audio" data-state={status} data-playing={playing || undefined}
         data-scrubbing={scrubbing || undefined}>
      <div ref={hiddenRef} hidden />
      <div className="abc-audio-main">
        <div className="abc-audio-transport-row">
          <div className="abc-audio-transport">
            <button
              type="button"
              className="abc-audio-btn abc-audio-btn-primary"
              onClick={onPlayPause}
              disabled={loading}
              aria-label={playing ? 'Pause' : 'Play'}
              aria-pressed={playing}
            >
              {loading ? (
                <svg className="abc-audio-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z" />
                </svg>
              )}
            </button>
            {status === 'ready' && (
              <>
                <button type="button" className="abc-audio-btn" onClick={onRewind}
                        aria-label="Rewind 5 seconds" title="Rewind 5 seconds">
                  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 7v2.2A4.8 4.8 0 1 0 16.8 14" fill="none" stroke="currentColor"
                          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M9.5 8.5 12 6l2.5 2.5" fill="none" stroke="currentColor"
                          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <text x="12" y="20" textAnchor="middle" fill="currentColor" stroke="none"
                          fontSize="8" fontWeight="700" fontFamily="system-ui, sans-serif">5</text>
                  </svg>
                </button>
                <button type="button" className="abc-audio-btn" onClick={onRestart}
                        aria-label="Restart from beginning" title="Restart from beginning">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="5" y="5" width="2.5" height="14" rx="0.5" />
                    <path d="M9.5 12 19 6.5v11L9.5 12Z" />
                  </svg>
                </button>
              </>
            )}
            {status === 'idle' && !loading && (
              <span className="abc-audio-hint">Click play or a note to hear</span>
            )}
          </div>

          {onToggleTablature && (
            <button
              type="button"
              className={`abc-audio-btn abc-audio-btn-tab${tablature ? ' abc-audio-btn-active' : ''}`}
              onClick={onToggleTablature}
              aria-label={tablature ? 'Hide guitar tablature' : 'Show guitar tablature'}
              title={tablature ? 'Hide guitar tablature' : 'Show guitar tablature'}
              aria-pressed={tablature}
            >
              TAB
            </button>
          )}

          {onToggleKeyboard && (
            <button
              type="button"
              className={`abc-audio-btn abc-audio-btn-keys${showKeyboard ? ' abc-audio-btn-active' : ''}`}
              onClick={onToggleKeyboard}
              aria-label={showKeyboard ? 'Hide piano keyboard' : 'Show piano keyboard'}
              title={showKeyboard ? 'Hide piano keyboard' : 'Show piano keyboard'}
              aria-pressed={showKeyboard}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 11h-1.5V5h1.5v9zm-3 0H9.5V5H11v9zM5 5h3v9H6.5v5H5V5zm9.5 14v-5H16V5h3v14h-4.5zM8 19v-3.5h1.5V19H8zm3 0v-3.5h1.5V19H11zm3 0v-3.5h1.5V19H14z" />
              </svg>
            </button>
          )}

          <button
            type="button"
            className="abc-audio-btn abc-audio-btn-midi"
            onClick={() => void onDownloadMidi()}
            aria-label="Download MIDI"
            title="Download MIDI"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <label
            className="abc-audio-instrument"
            data-from-tune={tuneHasProgram || undefined}
            title={tuneHasProgram ? "Instrument set by the tune's %%MIDI program — change to override" : undefined}
          >
            <span className="abc-audio-instrument-label">Sound</span>
            <select
              className="abc-audio-instrument-select"
              value={program}
              onChange={(e) => void onInstrumentChange(Number(e.target.value))}
              aria-label="Playback instrument"
            >
              {INSTRUMENTS.map((i) => (
                <option key={i.program} value={i.program}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {status === 'ready' && (
          <div className="abc-audio-progress-wrap">
            <div
              ref={scrubberRef}
              className="abc-audio-scrubber"
              style={progressStyle}
              role="slider"
              tabIndex={0}
              aria-label="Playback position"
              aria-valuemin={0}
              aria-valuemax={1000}
              aria-valuenow={Math.round(displayPct * 1000)}
              aria-valuetext={`${formatTime(elapsedMs)} of ${formatTime(totalMs)}`}
              onPointerDown={onScrubPointerDown}
              onPointerMove={onScrubPointerMove}
              onPointerUp={onScrubPointerUp}
              onPointerCancel={onScrubPointerUp}
              onKeyDown={onScrubKeyDown}
            >
              <div className="abc-audio-progress-rail" aria-hidden="true">
                <div className="abc-audio-progress-fill" />
                <div className="abc-audio-progress-ticks" />
              </div>
              <div className="abc-audio-progress-thumb" aria-hidden="true" />
            </div>
            <div className="abc-audio-counter" aria-live="polite">
              <span className="abc-audio-time">{formatTime(elapsedMs)}</span>
              <span className="abc-audio-counter-sep" aria-hidden="true">/</span>
              <span className="abc-audio-time abc-audio-time-total">{formatTime(totalMs)}</span>
              {totalBeats > 0 && (
                <span className="abc-audio-beat">
                  Bar {currentMeasure}/{totalMeasures}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {status === 'ready' && (
        <div className="abc-audio-speed" role="group" aria-label="Playback speed and tempo">
          <span className="abc-audio-speed-label">Speed</span>
          <div className="abc-audio-speed-presets">
            {WARP_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="abc-audio-speed-btn"
                data-active={warp === preset || undefined}
                aria-pressed={warp === preset}
                onClick={() => onWarp(preset)}
              >
                {WARP_LABELS[preset]}
              </button>
            ))}
          </div>
          <div className="abc-audio-tempo" aria-label="Custom tempo">
            <button
              type="button"
              className="abc-audio-tempo-step"
              onClick={() => nudgeBpm(-1)}
              aria-label="Decrease tempo"
            >
              −
            </button>
            <label className="abc-audio-tempo-field">
              <span className="abc-audio-tempo-field-label">Tempo</span>
              <input
                type="number"
                className="abc-audio-tempo-input"
                min={minBpm}
                max={maxBpm}
                step={1}
                value={bpmDraft}
                onChange={(e) => setBpmDraft(e.target.value)}
                onBlur={commitBpmDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="Tempo in BPM"
              />
              <span className="abc-audio-tempo-unit">BPM</span>
            </label>
            <button
              type="button"
              className="abc-audio-tempo-step"
              onClick={() => nudgeBpm(1)}
              aria-label="Increase tempo"
            >
              +
            </button>
          </div>
          {!isPresetWarp && (
            <span className="abc-audio-speed-custom" title="Custom tempo">
              {Math.round((bpm / baseBpm) * 100)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
});
