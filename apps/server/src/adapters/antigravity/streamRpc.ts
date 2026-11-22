/**
 * agy stream-json stdin helpers.
 *
 * Envelope is the documented agy shape (`event: user`), not Claude Code's
 * `type: user`. Attachments stay as `@<tempPath>` in `content` — this pipe
 * has no Claude document/image blocks.
 *
 * `--print=` (empty) is required at spawn; this module only talks to stdin
 * after that. Never end stdin at spawn; closeStdin() is for idle stop / a
 * null getNextSteer.
 */
import type { Writable } from 'stream';
import type { Attachment } from '@tierwyn/shared';

export type StreamPipe = {
  stdinClosed: boolean;
};

export function createStreamPipe(): StreamPipe {
  return { stdinClosed: false };
}

/** Prompt text plus `@<tempPath>` lines for on-disk attachments. */
export function contentWithPathRefs(text: string, attachments: Attachment[] = []): string {
  const pathRefs = attachments
    .map((a) => a.tempPath)
    .filter((p): p is string => Boolean(p));
  if (pathRefs.length === 0) return text;
  return `${text}\n\n${pathRefs.map((p) => `@${p}`).join('\n')}`;
}

/** One NDJSON user turn. agy rejects a line missing `event` (ERROR + session risk). */
export function buildUserEnvelope(text: string, attachments: Attachment[] = []): string {
  return JSON.stringify({
    event: 'user',
    message: { content: contentWithPathRefs(text, attachments) },
  });
}

/** EPIPE lands async on the stdin socket — a try/catch around write() cannot catch it. */
export function attachStdinGuard(stdin: Writable | null | undefined, pipe: StreamPipe): void {
  if (!stdin) return;
  stdin.on('error', () => {
    pipe.stdinClosed = true;
  });
}

/** Write one user envelope + newline. Returns false if stdin is gone. */
export function writeUserTurn(
  stdin: Writable | null | undefined,
  pipe: StreamPipe,
  text: string,
  attachments: Attachment[] = [],
): boolean {
  if (pipe.stdinClosed) return false;
  if (!stdin || stdin.destroyed) {
    pipe.stdinClosed = true;
    return false;
  }
  try {
    stdin.write(buildUserEnvelope(text, attachments) + '\n');
    return true;
  } catch {
    pipe.stdinClosed = true;
    return false;
  }
}

/** Idempotent stdin EOF. Idle agy exits 0; do not call mid-turn (use SIGTERM). */
export function closeStdin(stdin: Writable | null | undefined, pipe: StreamPipe): void {
  if (pipe.stdinClosed) return;
  pipe.stdinClosed = true;
  try {
    stdin?.end();
  } catch {
    // already destroyed
  }
}
