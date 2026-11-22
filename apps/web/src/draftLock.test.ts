import { describe, it, expect } from 'vitest';
import { shouldDropDraftFrame, isClearedDraftFrame, remainingProcessingMs, shouldForwardProfile, shouldProtectLocalDraftFromClear, shouldIgnoreStaleDraftText, shouldApplyRemoteDraftText, PROCESSING_STALE_MS, focusedComposerIsIdle } from './draftLock.js';

describe('shouldDropDraftFrame', () => {
  it('drops the pre-enhance putDraft echo while the enhance POST is in flight', () => {
    expect(shouldDropDraftFrame(
      { enhanceInFlight: true, remoteProcessing: 'idle' },
      { processing: 'idle', canUndo: false },
    )).toBe(true);
  });

  it('drops the pre-enhance putDraft echo while the server lock says enhancing', () => {
    expect(shouldDropDraftFrame(
      { enhanceInFlight: false, remoteProcessing: 'enhancing' },
      { processing: 'idle', canUndo: false },
    )).toBe(true);
  });

  it('APPLIES a transcribe settle (idle, no error, no canUndo) — the bug this fixes', () => {
    expect(shouldDropDraftFrame(
      { enhanceInFlight: false, remoteProcessing: 'transcribing' },
      { processing: 'idle', canUndo: false },
    )).toBe(false);
  });

  it('applies a successful enhance settle (canUndo true)', () => {
    expect(shouldDropDraftFrame(
      { enhanceInFlight: false, remoteProcessing: 'enhancing' },
      { processing: 'idle', canUndo: true },
    )).toBe(false);
  });

  it('applies a failed enhance settle (error present)', () => {
    expect(shouldDropDraftFrame(
      { enhanceInFlight: false, remoteProcessing: 'enhancing' },
      { processing: 'idle', canUndo: false, error: 'upstream 500' },
    )).toBe(false);
  });

  it('never drops a non-idle frame, even while enhancing', () => {
    expect(shouldDropDraftFrame(
      { enhanceInFlight: true, remoteProcessing: 'enhancing' },
      { processing: 'transcribing', canUndo: false },
    )).toBe(false);
  });

  it('applies an ordinary peer edit when nothing is in flight', () => {
    expect(shouldDropDraftFrame(
      { enhanceInFlight: false, remoteProcessing: 'idle' },
      { processing: 'idle', canUndo: false },
    )).toBe(false);
  });
});

describe('isClearedDraftFrame', () => {
  it('is true for an idle empty auto-send/clear settle', () => {
    expect(isClearedDraftFrame({
      processing: 'idle',
      text: '',
      canUndo: false,
      hasAttachments: false,
    })).toBe(true);
  });

  it('is false for an image-only draft (empty text, attachments present)', () => {
    expect(isClearedDraftFrame({
      processing: 'idle',
      text: '',
      canUndo: false,
      hasAttachments: true,
    })).toBe(false);
  });

  it('is false when undo is still armed (enhance settle, not a send)', () => {
    expect(isClearedDraftFrame({
      processing: 'idle',
      text: '',
      canUndo: true,
      hasAttachments: false,
    })).toBe(false);
  });

  it('is false while transcribing', () => {
    expect(isClearedDraftFrame({
      processing: 'transcribing',
      text: '',
      canUndo: false,
      hasAttachments: false,
    })).toBe(false);
  });
});

describe('remainingProcessingMs', () => {
  it('returns the full TTL when the start time is unknown', () => {
    expect(remainingProcessingMs(null, 1_000_000)).toBe(PROCESSING_STALE_MS);
  });

  it('returns the time left before the server would call the lock stale', () => {
    expect(remainingProcessingMs(1_000_000, 1_000_000 + 30_000)).toBe(PROCESSING_STALE_MS - 30_000);
  });

  it('returns 0 for a lock already past the TTL', () => {
    expect(remainingProcessingMs(1_000_000, 1_000_000 + PROCESSING_STALE_MS + 1)).toBe(0);
  });

  it('never returns a negative value', () => {
    expect(remainingProcessingMs(1_000_000, 9_000_000)).toBe(0);
  });
});

describe('shouldForwardProfile', () => {
  it('forwards a genuinely new profile once, then stops (loop breaker)', () => {
    // Selection can never become 'x' (App substitutes profiles[0] when 'x' is
    // not in the catalogue) — the naive !== check would forward forever.
    expect(shouldForwardProfile('x', 'fallback', null)).toBe(true);
    expect(shouldForwardProfile('x', 'fallback', { id: 'x', selection: 'fallback' })).toBe(false);
  });

  it('ignores frames with no profile and echoes of the live selection', () => {
    expect(shouldForwardProfile(null, 'a', null)).toBe(false);
    expect(shouldForwardProfile(undefined, 'a', null)).toBe(false);
    expect(shouldForwardProfile('a', 'a', null)).toBe(false);
  });

  it('still forwards a peer device switching to a different profile', () => {
    expect(shouldForwardProfile('b', 'a', { id: 'x', selection: 'a' })).toBe(true);
  });

  it('forwards a return to a previously forwarded profile once the selection moved', () => {
    // Peer set X (forwarded under selection 'a'), operator then locally picked
    // 'y', peer sets X again. Suppressing on the id alone would strand the
    // picker on 'y' while the server row says X.
    expect(shouldForwardProfile('x', 'y', { id: 'x', selection: 'a' })).toBe(true);
  });
});

describe('shouldProtectLocalDraftFromClear', () => {
  it('protects focused non-empty text even after the debounce timer has fired', () => {
    // The previous saveTimer-only guard missed this: a profile-only PUT echo
    // (empty stored text) arrives ~1s after open, saveTimer is already null.
    expect(shouldProtectLocalDraftFromClear({
      focused: true,
      localText: 'hello',
      pendingSave: false,
    })).toBe(true);
  });

  it('protects the first keystroke before React has copied it into textRef', () => {
    expect(shouldProtectLocalDraftFromClear({
      focused: true,
      localText: '',
      pendingSave: true,
    })).toBe(true);
  });

  it('does not protect an unfocused composer (peer send / auto-send must clear)', () => {
    expect(shouldProtectLocalDraftFromClear({
      focused: false,
      localText: 'stale',
      pendingSave: false,
    })).toBe(false);
  });

  it('protects an unfocused composer while a keystroke is still unsaved', () => {
    // Blur before the 600ms debounce fires; an empty profile-echo or a late
    // deleteDraft from `!` must not cancel the pending PUT.
    expect(shouldProtectLocalDraftFromClear({
      focused: false,
      localText: 'hello',
      pendingSave: true,
    })).toBe(true);
  });

  it('protects an unfocused composer against a stale empty echo older than the local edit', () => {
    // `!` / send already DELETE'd; the WS clear lands after the operator
    // started a new draft and clicked away.
    expect(shouldProtectLocalDraftFromClear({
      focused: false,
      localText: 'follow-up',
      pendingSave: false,
      lastLocalEditAt: 2_000,
      frameUpdatedAt: 1_000,
    })).toBe(true);
  });

  it('does not protect when the empty frame is newer than the local edit (peer send)', () => {
    expect(shouldProtectLocalDraftFromClear({
      focused: false,
      localText: 'stale',
      pendingSave: false,
      lastLocalEditAt: 1_000,
      frameUpdatedAt: 2_000,
    })).toBe(false);
  });

  it('does not protect a focused empty composer with nothing pending', () => {
    expect(shouldProtectLocalDraftFromClear({
      focused: true,
      localText: '',
      pendingSave: false,
    })).toBe(false);
  });

  it('protects an unfocused image-only composer against a stale empty echo', () => {
    // Paste image → click the thumbnail (textarea blurs). Local text is still
    // '' so the old localText-only guard treated this as "nothing to keep".
    expect(shouldProtectLocalDraftFromClear({
      focused: false,
      localText: '',
      pendingSave: false,
      localHasAttachments: true,
      lastLocalEditAt: 2_000,
      frameUpdatedAt: 1_000,
    })).toBe(true);
  });

  it('protects a focused image-only composer after the debounce has fired', () => {
    expect(shouldProtectLocalDraftFromClear({
      focused: true,
      localText: '',
      pendingSave: false,
      localHasAttachments: true,
    })).toBe(true);
  });
});

describe('shouldApplyRemoteDraftText', () => {
  it('does not apply an image-only echo over typed text after blur', () => {
    // Type, paste image, click the thumbnail: the paste PUT echoes text:''
    // with hasAttachments, which is NOT isClearedDraftFrame, then setText('')
    // wiped the prompt.
    expect(shouldApplyRemoteDraftText({
      forceApply: false,
      focused: false,
      localText: 'hello',
      remoteText: '',
      hasRemoteAttachments: true,
      pendingSave: false,
      lastLocalEditAt: 1_000,
      frameUpdatedAt: 2_000,
    })).toBe(false);
  });

  it('still applies a true clear when the empty frame is newer (peer send)', () => {
    expect(shouldApplyRemoteDraftText({
      forceApply: false,
      focused: false,
      localText: 'stale',
      remoteText: '',
      hasRemoteAttachments: false,
      pendingSave: false,
      lastLocalEditAt: 1_000,
      frameUpdatedAt: 2_000,
    })).toBe(true);
  });

  it('does not apply remote text while the textarea is focused', () => {
    expect(shouldApplyRemoteDraftText({
      forceApply: false,
      focused: true,
      localText: 'hello',
      remoteText: 'peer',
      hasRemoteAttachments: false,
      pendingSave: false,
    })).toBe(false);
  });

  it('applies remote text on a busy→idle force-apply even if focused', () => {
    expect(shouldApplyRemoteDraftText({
      forceApply: true,
      focused: true,
      localText: 'raw stash',
      remoteText: 'enhanced',
      hasRemoteAttachments: false,
      pendingSave: false,
    })).toBe(true);
  });
});

describe('shouldIgnoreStaleDraftText', () => {
  it('ignores non-empty text while discarding after an intentional clear', () => {
    expect(shouldIgnoreStaleDraftText({ discardingRemoteText: true, text: 'sent prompt' })).toBe(true);
  });

  it('does not ignore empty text (server clear settle still applies locally)', () => {
    expect(shouldIgnoreStaleDraftText({ discardingRemoteText: true, text: '' })).toBe(false);
  });

  it('does not ignore when not discarding', () => {
    expect(shouldIgnoreStaleDraftText({ discardingRemoteText: false, text: 'peer edit' })).toBe(false);
  });

  it('does not ignore a dictation settle — transcript dictated right after a send must land', () => {
    // Send arms the discard window; no keystroke follows; the whisper settle
    // (busy→idle) carries the fresh transcript. Dropping it stranded the text.
    expect(shouldIgnoreStaleDraftText({
      discardingRemoteText: true,
      text: 'fresh transcript appended under the lock',
      dictationSettle: true,
    })).toBe(false);
  });
});

describe('focusedComposerIsIdle', () => {
  it('accepts peer text only after the typist has paused and nothing is unsaved', () => {
    expect(focusedComposerIsIdle({ pendingSave: false, lastLocalEditAt: 0, now: 10_000 })).toBe(true);
    expect(focusedComposerIsIdle({ pendingSave: false, lastLocalEditAt: 9_000, now: 10_000 })).toBe(false);
    expect(focusedComposerIsIdle({ pendingSave: true, lastLocalEditAt: 0, now: 10_000 })).toBe(false);
    expect(focusedComposerIsIdle({ pendingSave: false, lastLocalEditAt: 7_000, now: 10_000 })).toBe(true);
  });
});
