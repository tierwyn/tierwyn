/**
 * Map a HTMLMediaElement MediaError (or its code) to a human-readable message
 * for the file modal error state. Audio/video elements fail silently by
 * default — the modal listens to `onError` and surfaces this instead of a
 * dead player.
 * https://developer.mozilla.org/en-US/docs/Web/API/MediaError/code
 */
export function mediaErrorMessage(err: MediaError | number | null | undefined): string {
  const code = typeof err === 'number' ? err : err?.code;
  switch (code) {
    case 1:
      return 'Playback was aborted before it could start.';
    case 2:
      return 'A network error interrupted loading — the file may be outside the allowed locations or the server is unreachable.';
    case 3:
      return 'The file is corrupt or this browser could not decode it.';
    case 4:
      return 'This format is not supported by your browser (the file may also be missing or in a disallowed location).';
    default:
      return "The file couldn't be played.";
  }
}
