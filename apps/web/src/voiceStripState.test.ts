import { describe, it, expect } from 'vitest';
import { voiceStripState } from './voiceStripState.js';

const idle = { listening: false, localTranscribing: false, remoteProcessing: 'idle' as const };

describe('voiceStripState', () => {
  it('is hidden when nothing is happening', () => {
    expect(voiceStripState(idle)).toEqual({
      visible: false, mode: null, reactive: false, interactive: false,
    });
  });

  it('shows a reactive detection visual while this device records', () => {
    expect(voiceStripState({ ...idle, listening: true })).toEqual({
      visible: true, mode: 'detection', reactive: true, interactive: true,
    });
  });

  it('shows a non-reactive processing visual while this device uploads', () => {
    expect(voiceStripState({ ...idle, localTranscribing: true })).toEqual({
      visible: true, mode: 'processing', reactive: false, interactive: true,
    });
  });

  it('shows a clickable processing visual for a remote transcription (same operator, any device)', () => {
    expect(voiceStripState({ ...idle, remoteProcessing: 'transcribing' })).toEqual({
      visible: true, mode: 'processing', reactive: false, interactive: true,
    });
  });

  it('keeps the visual up and clickable when the local upload aborts but the server lock stands', () => {
    // Aborting the local fetch clears localTranscribing; the strip stays until
    // the server lock settles (or a click POSTs /transcribe/cancel).
    expect(voiceStripState({ ...idle, remoteProcessing: 'transcribing', localTranscribing: false }))
      .toEqual({ visible: true, mode: 'processing', reactive: false, interactive: true });
  });

  it('prefers the local detection visual when recording while a peer transcribes', () => {
    expect(voiceStripState({ listening: true, localTranscribing: false, remoteProcessing: 'transcribing' }))
      .toEqual({ visible: true, mode: 'detection', reactive: true, interactive: true });
  });

  it('shows nothing for an enhance lock — enhance greys the composer instead', () => {
    expect(voiceStripState({ ...idle, remoteProcessing: 'enhancing' })).toEqual({
      visible: false, mode: null, reactive: false, interactive: false,
    });
  });

  it('stays interactive for the initiator even while a remote lock is also set', () => {
    expect(voiceStripState({ ...idle, localTranscribing: true, remoteProcessing: 'transcribing' }))
      .toEqual({ visible: true, mode: 'processing', reactive: false, interactive: true });
  });
});
