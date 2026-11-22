import type { DraftProcessing, DraftUpdatedFrame } from '@tierwyn/shared';

/** Mirror of the server's lazy lock TTL (`PROCESSING_STALE_MS` in
 *  `apps/server/src/repositories/drafts.ts`). Kept as a local constant rather
 *  than exported from shared because it is a policy number, not a protocol
 *  field — if the two ever diverge the client is merely optimistic by the
 *  difference, never wrong about a settled job. */
export const PROCESSING_STALE_MS = 180_000;

/** What this device knows about its own enhance attempt and the server lock. */
export interface DraftLockGate {
  /** True between the ✨ click and the POST /enhance response, before any frame
   *  has confirmed the lock. Set by `handleEnhancePick`. */
  enhanceInFlight: boolean;
  /** Last server-authoritative lock this device applied for the rendered conversation. */
  remoteProcessing: DraftProcessing;
}

/**
 * Should this `draft_updated` frame be ignored?
 *
 * Exactly one frame must be dropped: the **pre-enhance `putDraft` echo**. That
 * PUT is issued by `handleEnhancePick` to flush the debounce before POST
 * /enhance, and its broadcast (`idle`, original text, no canUndo, no error) can
 * land after the optimistic freeze because WS and HTTP race. Applying it would
 * unfreeze the composer with the pre-enhance text.
 *
 * A whisper transcribe settle has the identical flag signature (`transcribe.ts`
 * releases the lock without text, which NULLs `pre_text`, so `canUndo` is false;
 * the append-only branch sets no `error`). The discriminator therefore cannot be
 * "am I busy?" — it must be "am I enhancing?". Gating on any busy state is the
 * bug this function exists to prevent: it wedged `remoteProcessing` at
 * 'transcribing' forever and made ✨ a silent no-op.
 *
 * // ponytail: a stale-lock steal that settles someone else's enhance with
 * // neither flag is still dropped while we think we are enhancing. Bounded by
 * // `remainingProcessingMs` on the transcribe path; the enhance path greys the
 * // box, which the operator will notice. No watchdog for enhance.
 */
/** Idle empty draft with no undo and no attachments — auto-send or explicit
 *  clear. Image-only drafts (empty text, hasAttachments) are NOT a clear: the
 *  paste debounce PUT echoes with text:'' and would otherwise wipe the thumbnail.
 *  Callers must still consult `shouldProtectLocalDraftFromClear` before applying
 *  so a focused in-progress composer is not wiped by a profile-only PUT echo. */
export function isClearedDraftFrame(
  frame: Pick<DraftUpdatedFrame, 'processing' | 'text' | 'canUndo' | 'hasAttachments'> & { error?: string },
): boolean {
  return frame.processing === 'idle'
    && frame.text === ''
    && !frame.canUndo
    && !frame.error
    && !frame.hasAttachments;
}

/**
 * Should a `draft_updated` frame's `profileId` be pushed back up to the picker?
 *
 * Only when it is genuinely new. The naive check ("differs from the live
 * selection") loops forever whenever the selection can never become the frame's
 * value — App passes `profiles.find(...) ?? profiles[0]` down, so a draft row
 * holding a profile that is disabled, deleted, or not fetched yet substitutes a
 * different id, the guard never satisfies, and each forward triggers a
 * profile-only PUT whose broadcast (carrying the same profileId, and the stored
 * text — empty on a fresh draft) forwards again. The composer was cleared on
 * every lap.
 *
 * `last` records both the id we forwarded AND the selection we saw at the time.
 * Suppressing on the id alone would break a legitimate return to a previously
 * forwarded profile (peer sets X, operator locally picks Y, peer sets X again).
 * Pairing it with the selection means we only suppress a repeat that arrives
 * with nothing having moved — which is exactly the loop, and nothing else.
 */
export function shouldForwardProfile(
  frameProfileId: string | null | undefined,
  selected: string,
  last: { id: string; selection: string } | null,
): boolean {
  if (!frameProfileId) return false;
  if (frameProfileId === selected) return false;
  return !(last !== null && last.id === frameProfileId && last.selection === selected);
}

/**
 * Should an empty idle server draft be ignored instead of clearing the composer?
 *
 * The old guard (`focused && pendingSave`) missed the hole that still wipes
 * particular conversations: opening one whose persisted draft profile differs
 * from the live picker (schedule runs, spawn children) forwards that profile
 * via a profile-only PUT. That PUT rebroadcasts the *stored* text — empty —
 * after the 600ms debounce has already fired, so `pendingSave` is false while
 * the operator is mid-word. Protect whenever the textarea is focused AND
 * either a keystroke is unsaved or local text is already non-empty.
 *
 * Unfocused composers still accept a *newer* clear (peer send / auto-send).
 * They keep local text when a save is in flight, or when the empty frame is
 * older than the last local edit (late `!` / send deleteDraft echo).
 */
export function shouldProtectLocalDraftFromClear(opts: {
  focused: boolean;
  localText: string;
  pendingSave: boolean;
  /** Epoch ms of the last local keystroke / commit. Compared to `frameUpdatedAt`
   *  so a late empty echo (deleteDraft from `!` / send) cannot wipe a newer draft
   *  after blur. */
  lastLocalEditAt?: number;
  /** Epoch ms on the incoming empty GET/frame. Missing/zero is treated as older
   *  than any real edit. */
  frameUpdatedAt?: number;
  /** Image-only drafts have empty text; without this, clicking the thumbnail
   *  (textarea blur) lets a stale empty GET/frame call clearComposerDraft. */
  localHasAttachments?: boolean;
}): boolean {
  // Debounce still pending (or PUT in flight) — including after blur. The old
  // focused-only guard cancelled that save when `!`'s deleteDraft echo arrived.
  if (opts.pendingSave) return true;
  const localHas = opts.localText !== '' || !!opts.localHasAttachments;
  if (opts.focused && localHas) return true;
  if (
    localHas
    && (opts.lastLocalEditAt ?? 0) > (opts.frameUpdatedAt ?? 0)
  ) return true;
  return false;
}

/**
 * Should this device replace composer text with the frame's text?
 *
 * Image-only PUT echoes (`text:''` + attachments) are not `isClearedDraftFrame`,
 * so the old path fell through to `setText('')` whenever the textarea was
 * unfocused — typing then clicking the thumbnail wiped the prompt.
 */
export function shouldApplyRemoteDraftText(opts: {
  forceApply: boolean;
  focused: boolean;
  localText: string;
  remoteText: string;
  hasRemoteAttachments: boolean;
  pendingSave: boolean;
  lastLocalEditAt?: number;
  frameUpdatedAt?: number;
  localHasAttachments?: boolean;
}): boolean {
  if (opts.forceApply) return true;
  if (opts.focused) return false;
  if (opts.remoteText === '' && opts.localText !== '' && opts.hasRemoteAttachments) {
    return false;
  }
  if (opts.remoteText === '' && opts.localText !== '') {
    return !shouldProtectLocalDraftFromClear({
      focused: opts.focused,
      localText: opts.localText,
      pendingSave: opts.pendingSave,
      lastLocalEditAt: opts.lastLocalEditAt,
      frameUpdatedAt: opts.frameUpdatedAt,
      localHasAttachments: opts.localHasAttachments,
    });
  }
  return true;
}

/**
 * After an intentional composer clear (send / handoff confirm / auto-send),
 * ignore non-empty `draft_updated` text until the operator types again (or
 * switches conversation).
 *
 * Clicking Send (or a handoff modal button) blurs the textarea first, which
 * flush-saves the draft; that PUT can finish *after* `deleteDraft`'s empty
 * settle. If we dropped the discard flag on empty, the stale PUT echo would
 * resurrect the sent prompt into an unfocused box.
 *
 * A dictation settle (`dictationSettle`: this device observed the draft lock
 * go busy→idle) is exempt: its text is a fresh transcript appended under the
 * lock, never a stale echo. Without the exemption, dictating right after a
 * send — with no keystroke in between to clear the flag — strands the
 * transcript: the whisper path skips the local append and waits for exactly
 * this frame.
 */
export function shouldIgnoreStaleDraftText(opts: {
  discardingRemoteText: boolean;
  text: string;
  /** True on a busy→idle draft-lock settle (whisper transcription). */
  dictationSettle?: boolean;
}): boolean {
  if (opts.dictationSettle) return false;
  return opts.discardingRemoteText && opts.text !== '';
}

export function shouldDropDraftFrame(
  gate: DraftLockGate,
  frame: Pick<DraftUpdatedFrame, 'processing' | 'canUndo'> & { error?: string },
): boolean {
  const enhancing = gate.enhanceInFlight || gate.remoteProcessing === 'enhancing';
  return enhancing && frame.processing === 'idle' && !frame.error && !frame.canUndo;
}

/**
 * Milliseconds this device may keep believing a non-idle lock, measured against
 * the server's own stale-expiry rule. Clamped to `[0, PROCESSING_STALE_MS]`.
 * `null` (a frame or GET that omitted the start time) is treated as "just
 * started" so the client never expires a lock early.
 */
export function remainingProcessingMs(processingStartedAt: number | null, now: number): number {
  if (processingStartedAt == null) return PROCESSING_STALE_MS;
  const elapsed = now - processingStartedAt;
  if (elapsed <= 0) return PROCESSING_STALE_MS;
  return Math.max(0, PROCESSING_STALE_MS - elapsed);
}

/** How long a focused composer must sit untouched before a peer's draft may
 *  replace it. Desktop keeps the textarea focused almost permanently, so a
 *  plain "focused → ignore" rule meant cross-device text never landed. */
export const FOCUSED_IDLE_MS = 3_000;

/**
 * May a focused composer accept a peer device's draft? Only when nothing local
 * is unsaved and the operator has not typed for FOCUSED_IDLE_MS. Uses the
 * client clock only (frame.updatedAt is server time — skew would bite).
 */
export function focusedComposerIsIdle(opts: {
  pendingSave: boolean;
  lastLocalEditAt: number;
  now: number;
}): boolean {
  return !opts.pendingSave && opts.now - opts.lastLocalEditAt >= FOCUSED_IDLE_MS;
}
