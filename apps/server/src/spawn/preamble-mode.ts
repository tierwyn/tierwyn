import { createHash } from 'crypto';
import type { ResumePlan } from '@tierwyn/shared';

/** Re-teach the full recipe at least this often even on an unbroken native
 *  session — guards against the agent's own context compaction silently
 *  dropping the original block.
 *  ponytail: heuristics for unobservable agent-side context loss; promote to
 *  compaction settings only if the operator asks. */
export const STUB_MAX_AGE_MS = 12 * 60 * 60_000;
export const MAX_CONSECUTIVE_STUBS = 20;

export type PreambleKind = 'spawn' | 'schedule';

/** `<kind>:<hash12>` — ts/count appended by encodeFp. */
export function makeFingerprint(kind: PreambleKind, payload: unknown): string {
  const hash = createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
  return `${kind}:${hash}`;
}

export function encodeFp(base: string, lastFullTs: number, stubCount: number): string {
  return `${base}:${lastFullTs}:${stubCount}`;
}

export function decodeFp(fp: string | undefined):
  { base: string; lastFullTs: number; stubCount: number } | undefined {
  if (!fp) return undefined;
  const p = fp.split(':');
  if (p.length < 4) return undefined; // malformed / pre-113 row ⇒ treat as unknown ⇒ full
  return { base: `${p[0]}:${p[1]}`, lastFullTs: Number(p[2]) || 0, stubCount: Number(p[3]) || 0 };
}

export function choosePreambleMode(args: {
  want: string;
  prev: string | undefined;
  resumeMode: ResumePlan['mode'];
  now?: number;
}): { mode: 'full' | 'stub'; nextFp: string } {
  const now = args.now ?? Date.now();
  const prev = decodeFp(args.prev);
  const full = { mode: 'full' as const, nextFp: encodeFp(args.want, now, 0) };

  if (!prev) return full;
  if (args.resumeMode !== 'native') return full;
  if (prev.base !== args.want) return full;
  if (now - prev.lastFullTs > STUB_MAX_AGE_MS) return full;
  if (prev.stubCount >= MAX_CONSECUTIVE_STUBS) return full;
  return { mode: 'stub', nextFp: encodeFp(args.want, prev.lastFullTs, prev.stubCount + 1) };
}
