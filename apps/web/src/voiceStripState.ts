import type { DraftProcessing } from '@tierwyn/shared';

/** `detection` = live mic feedback; `processing` = server is working on the clip. */
export type VoiceStripMode = 'detection' | 'processing';

export interface VoiceStripInputs {
  /** This device's mic is open (local hook). */
  listening: boolean;
  /** This device is waiting on its own POST /transcribe (local hook). Cleared by
   *  cancel/unmount even though the server keeps working. */
  localTranscribing: boolean;
  /** Server-authoritative composer lock for the rendered conversation. */
  remoteProcessing: DraftProcessing;
}

export interface VoiceStripState {
  /** Mount the voice lane at all. */
  visible: boolean;
  /** Which visual family to render; null when hidden. */
  mode: VoiceStripMode | null;
  /** Feed live mic amplitude into the visual. Only ever true for this device's mic. */
  reactive: boolean;
  /** Tap/Enter stops the mic or POSTs /transcribe/cancel. True whenever this
   *  strip represents a live dictation — including a remote transcribe lock,
   *  so the operator can abort from any subscribed device. */
  interactive: boolean;
}

/**
 * Decides what the voice lane shows. The processing visual is driven by the
 * **server lock**, not by the local fetch, so it survives an aborted upload, a
 * closed tab, and a device switch — and appears on a device that never recorded.
 *
 * `enhancing` deliberately renders nothing: enhance greys the composer
 * (`inputLocked`) and has no voice semantics.
 */
export function voiceStripState({
  listening,
  localTranscribing,
  remoteProcessing,
}: VoiceStripInputs): VoiceStripState {
  const remoteTranscribing = remoteProcessing === 'transcribing';
  const visible = listening || localTranscribing || remoteTranscribing;
  if (!visible) return { visible: false, mode: null, reactive: false, interactive: false };
  return {
    visible: true,
    mode: listening ? 'detection' : 'processing',
    reactive: listening,
    interactive: listening || localTranscribing || remoteTranscribing,
  };
}
