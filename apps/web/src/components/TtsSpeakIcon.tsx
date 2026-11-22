/**
 * Speaker glyph, or a 3-dot pulse while TTS is preparing (summarize/synth).
 */
import { useEffect, useState } from 'react';
import {
  getTtsParkState,
  subscribeTtsPark,
} from '../ttsParkPlayer.js';

/** True while this UI considers speech "on" and the park player is still loading audio. */
export function useTtsSpeakPreparing(speaking: boolean): boolean {
  const [loading, setLoading] = useState(() => getTtsParkState().status === 'loading');
  useEffect(() => {
    return subscribeTtsPark(() => {
      setLoading(getTtsParkState().status === 'loading');
    });
  }, []);
  return speaking && loading;
}

interface Props {
  /** true while speak flow is active (preparing or playing). */
  speaking: boolean;
  /** Force 3-dot spinner (e.g. FileModal client-side summarize before park loads). */
  preparing?: boolean;
  size?: number;
}

/** Icon for the speaker action button — 3-dot spinner while audio is not ready yet. */
export function TtsSpeakIcon({ speaking, preparing: forcePreparing, size = 12 }: Props) {
  const parkPreparing = useTtsSpeakPreparing(speaking);
  const preparing = !!forcePreparing || parkPreparing;
  if (preparing) {
    return (
      <span
        className="tts-speak-dots"
        style={{ width: size, height: size }}
        aria-hidden="true"
        title="Preparing speech…"
      >
        <i /><i /><i />
      </span>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
    </svg>
  );
}
