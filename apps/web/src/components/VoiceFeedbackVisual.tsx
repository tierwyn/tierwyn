import type { VoiceVisual, WaveStyle } from '../voiceSettings.js';
import { VoiceWave } from './VoiceWave.js';
import { VoiceNucleus } from './VoiceNucleus.js';
import { VoiceSpectrogram } from './VoiceSpectrogram.js';
import { VoiceMercuryThread } from './VoiceMercuryThread.js';
import { VoiceTypewriter } from './VoiceTypewriter.js';
import { VoicePrismScan } from './VoicePrismScan.js';
import { VoiceInterference } from './VoiceInterference.js';

interface Props {
  visual: VoiceVisual;
  waveStyle: WaveStyle;
  height?: number;
  /** When true, pass live mic level into the visual; when false, run synthetic motion. */
  reactive: boolean;
  getMicLevel: (() => number) | null;
}

/** Renders the selected voice-strip visual for detection or processing. */
export function VoiceFeedbackVisual({
  visual,
  waveStyle,
  height,
  reactive,
  getMicLevel,
}: Props) {
  const level = reactive ? getMicLevel : null;
  const label = reactive ? 'Listening' : 'Transcribing speech';
  const common = { waveStyle, height, ariaLabel: label };

  switch (visual) {
    case 'wave':
      return <VoiceWave getMicLevel={level} {...common} />;
    case 'nucleus':
      return <VoiceNucleus getMicLevel={level} {...common} />;
    case 'spectrogram':
      return <VoiceSpectrogram getMicLevel={level} {...common} />;
    case 'mercury':
      return <VoiceMercuryThread getMicLevel={level} {...common} />;
    case 'typewriter':
      return <VoiceTypewriter {...common} />;
    case 'prism':
      return <VoicePrismScan {...common} />;
    case 'interference':
      return <VoiceInterference {...common} />;
  }
}
