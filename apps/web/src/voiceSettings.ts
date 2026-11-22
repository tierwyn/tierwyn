import type { SelectDropdownOption } from './components/SelectDropdown.js';
import { parseSlowEnhanceChoice, serialiseSlowEnhanceChoice, type SlowEnhanceChoice } from './dictationEnhance.js';
import { lsGet, lsSet } from './prefixedStorage.js';

// ponytail: localStorage, not the server DB — the voice engine is a per-device
// choice (iOS, Android and desktop expose different engines), so a DB migration
// + REST route would be pure overhead. Add new engines to the option lists
// below; when a 2nd option exists, branch on get*Engine() inside
// useSpeechInput.ts (STT) / speak.ts (TTS) to dispatch to it.

export type SttEngine = 'browser' | 'whisper';
export type TtsEngine = 'browser';
export type WhisperModel = 'base' | 'small' | 'medium';
export type WaveStyle = 'accent' | 'chromatic' | 'silver';
export type VoiceDetectionVisual = 'wave' | 'nucleus' | 'spectrogram' | 'mercury';
export type VoiceProcessingVisual = 'nucleus' | 'spectrogram' | 'mercury' | 'typewriter' | 'prism' | 'interference';
export type VoiceVisual = VoiceDetectionVisual | VoiceProcessingVisual;

export const voiceDetectionVisualOptions: SelectDropdownOption<VoiceDetectionVisual>[] = [
  { value: 'wave', label: 'Silk wave — flowing thread' },
  { value: 'nucleus', label: 'Particle nucleus — orbiting dots' },
  { value: 'spectrogram', label: 'Spectrogram — melting bars' },
  { value: 'mercury', label: 'Mercury thread — data packets' },
];

export const voiceProcessingVisualOptions: SelectDropdownOption<VoiceProcessingVisual>[] = [
  { value: 'nucleus', label: 'Particle nucleus — orbiting dots' },
  { value: 'spectrogram', label: 'Spectrogram — melting bars' },
  { value: 'mercury', label: 'Mercury thread — data packets' },
  { value: 'typewriter', label: 'Typewriter — dots resolve to text' },
  { value: 'prism', label: 'Prism scan — refracting sweep' },
  { value: 'interference', label: 'Interference — moiré rings' },
];

export const sttEngineOptions: SelectDropdownOption<SttEngine>[] = [
  { value: 'whisper', label: 'Whisper (local, on-device)' },
  { value: 'browser', label: 'Browser (on-device, free)' },
];

export const ttsEngineOptions: SelectDropdownOption<TtsEngine>[] = [
  { value: 'browser', label: 'Browser (on-device, free)' },
];

export const whisperModelOptions: SelectDropdownOption<WhisperModel>[] = [
  { value: 'base', label: 'Base — fastest, lower accuracy' },
  { value: 'small', label: 'Small — balanced' },
  { value: 'medium', label: 'Medium — most accurate, slowest' },
];

export const waveStyleOptions: SelectDropdownOption<WaveStyle>[] = [
  { value: 'accent', label: 'Accent — follows theme colour' },
  { value: 'chromatic', label: 'Chromatic — iridescent rainbow' },
  { value: 'silver', label: 'Silver — metallic shimmer' },
];

const STT_KEY = 'tierwyn.voice.sttEngine';
const TTS_KEY = 'tierwyn.voice.ttsEngine';
const WHISPER_MODEL_KEY = 'tierwyn.voice.whisperModel';
const WAVE_STYLE_KEY = 'tierwyn.voice.waveStyle';
const VOICE_DETECTION_VISUAL_KEY = 'tierwyn.voice.detectionVisual';
const VOICE_PROCESSING_VISUAL_KEY = 'tierwyn.voice.processingVisual';

/**
 * Dispatch after every setter so InputBar can re-read the engine choice when
 * the Settings modal saves without needing a remount (mirrors the voiceSettings
 * propagation pattern noted in CLAUDE.md).
 */
function notifyChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('voice-settings-changed'));
  }
}

/**
 * Default is 'whisper' (local whisper.cpp) on fresh clients; existing clients
 * keep their previously stored choice. The fallback default flips to 'whisper'
 * now that the engine is shipped — the browser path remains as a fallback.
 */
export function getSttEngine(): SttEngine {
  const stored = lsGet(STT_KEY);
  return (stored === 'browser' || stored === 'whisper') ? stored : 'whisper';
}

export function setSttEngine(v: SttEngine): void {
  lsSet(STT_KEY, v);
  notifyChange();
}

export function getTtsEngine(): TtsEngine {
  return (lsGet(TTS_KEY) as TtsEngine) || 'browser';
}

export function setTtsEngine(v: TtsEngine): void {
  lsSet(TTS_KEY, v);
  notifyChange();
}

export function getWhisperModel(): WhisperModel {
  const stored = lsGet(WHISPER_MODEL_KEY);
  return (stored === 'base' || stored === 'small' || stored === 'medium') ? stored : 'base';
}

export function setWhisperModel(v: WhisperModel): void {
  lsSet(WHISPER_MODEL_KEY, v);
  notifyChange();
}

export function getWaveStyle(): WaveStyle {
  const stored = lsGet(WAVE_STYLE_KEY);
  return (stored === 'chromatic' || stored === 'silver') ? stored : 'accent';
}

export function setWaveStyle(v: WaveStyle): void {
  lsSet(WAVE_STYLE_KEY, v);
  notifyChange();
}

const DETECTION_VISUALS: VoiceDetectionVisual[] = ['wave', 'nucleus', 'spectrogram', 'mercury'];
const PROCESSING_VISUALS: VoiceProcessingVisual[] = [
  'nucleus', 'spectrogram', 'mercury', 'typewriter', 'prism', 'interference',
];

export function getVoiceDetectionVisual(): VoiceDetectionVisual {
  const stored = lsGet(VOICE_DETECTION_VISUAL_KEY);
  if (DETECTION_VISUALS.includes(stored as VoiceDetectionVisual)) {
    return stored as VoiceDetectionVisual;
  }
  return 'wave';
}

export function setVoiceDetectionVisual(v: VoiceDetectionVisual): void {
  lsSet(VOICE_DETECTION_VISUAL_KEY, v);
  notifyChange();
}

export function getVoiceProcessingVisual(): VoiceProcessingVisual {
  const stored = lsGet(VOICE_PROCESSING_VISUAL_KEY);
  if (PROCESSING_VISUALS.includes(stored as VoiceProcessingVisual)) {
    return stored as VoiceProcessingVisual;
  }
  return 'spectrogram';
}

export function setVoiceProcessingVisual(v: VoiceProcessingVisual): void {
  lsSet(VOICE_PROCESSING_VISUAL_KEY, v);
  notifyChange();
}

export type DictationMode = 'fast' | 'slow';
const DICTATION_MODE_KEY = 'tierwyn.voice.dictationMode';

/** Remember the last Fast/Slow choice so the mic popup opens on it. Defaults
 *  to 'slow' (cleanup on) — the server still no-ops if cleanup is disabled. */
export function getDictationMode(): DictationMode {
  const v = lsGet(DICTATION_MODE_KEY);
  return v === 'fast' ? 'fast' : 'slow';
}

export function setDictationMode(m: DictationMode): void {
  lsSet(DICTATION_MODE_KEY, m);
}

const SLOW_ENHANCE_KEY = 'tierwyn.voice.slowEnhanceContext';

/** Remembered Slow dictation choice. Same key as the old boolean, so
 *  'true'/'false' written by older builds still read back. Default cleanup. */
export function getSlowEnhanceChoice(): SlowEnhanceChoice {
  return parseSlowEnhanceChoice(lsGet(SLOW_ENHANCE_KEY));
}

export function setSlowEnhanceChoice(c: SlowEnhanceChoice): void {
  lsSet(SLOW_ENHANCE_KEY, serialiseSlowEnhanceChoice(c));
}
