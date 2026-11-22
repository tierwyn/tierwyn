import { basename, extname, resolve as resolvePath, sep } from 'node:path';
import { isOpenableExtension, isSecretPath } from '@tierwyn/shared';
import { withTrailingSep } from './listing.js';

/** mtimeMs is number | bigint in current @types/node; Math.floor wants a number. */
export function versionToken(info: { mtimeMs: number | bigint; size: number | bigint }): string {
  return `${Math.floor(Number(info.mtimeMs))}-${Number(info.size)}`;
}

export interface WriteAllowOptions {
  /** All project root paths. */
  projectRoots: string[];
  /** The requesting conversation's worktree, when it has one. */
  workdirRoot?: string;
}

/** Path segments never writable regardless of root. */
const WRITE_DENY_SEGMENTS = new Set(['.git']);

/**
 * Lexical write allow-list. Roots are project roots + the requesting
 * conversation's worktree only — never agent homes, media dirs, or tmp.
 * `absPath` should already be resolved (absolute, no `..`) — it is
 * normalised here as a belt-and-braces measure, but callers must still
 * realpath separately (`realpathWithinRoots`) to defeat symlinks.
 *
 * Node-safe (no hub imports): the remote `files.write` handler runs the
 * same policy on the node.
 */
export function isWritePathAllowed(rawPath: string, opts: WriteAllowOptions): boolean {
  const absPath = resolvePath(rawPath);
  if (!absPath || !absPath.startsWith('/')) return false;
  const segments = absPath.split(sep);
  if (segments.some((s) => WRITE_DENY_SEGMENTS.has(s))) return false;
  if (basename(absPath).startsWith('.')) return false;
  const ext = extname(absPath).slice(1).toLowerCase();
  if (!ext || !isOpenableExtension(ext)) return false;
  if (isSecretPath(absPath)) return false;

  const roots: string[] = [];
  for (const r of opts.projectRoots) roots.push(withTrailingSep(r));
  if (opts.workdirRoot) roots.push(withTrailingSep(opts.workdirRoot));

  const withSep = withTrailingSep(absPath);
  for (const root of roots) {
    if (withSep === root) continue; // exact dir match — not a file
    if (withSep.startsWith(root)) return true;
  }
  return false;
}
