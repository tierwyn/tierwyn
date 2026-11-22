import { readdir, realpath, stat } from 'fs/promises';
import {
  extname, isAbsolute, join, relative, resolve as resolvePath, sep,
} from 'path';
import {
  isImageExtension, isAudioExtension, isVideoExtension, isOpenableExtension,
  isMarkdownExtension, isSecretPath,
} from '@tierwyn/shared';
import type { FileBrowserEntry, FileBrowserListing } from '@tierwyn/shared';

export function withTrailingSep(abs: string): string {
  return abs.endsWith(sep) ? abs : abs + sep;
}

/**
 * Realpath `absPath` and every root, then prefix-match. Returns the real
 * target path on success, or null on ENOENT/ELOOP or escape outside roots.
 * Project roots and git worktrees are often themselves symlinks, so both
 * sides must be realpathed (assessment §2.2).
 */
export async function realpathWithinRoots(absPath: string, roots: string[]): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    return null;
  }
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => null)));
  const withSep = withTrailingSep(real);
  for (const realRoot of realRoots) {
    if (!realRoot) continue;
    const root = withTrailingSep(realRoot);
    if (withSep === root) continue;
    if (withSep.startsWith(root)) return real;
  }
  return null;
}

/** Deny-list: never list/read `<dataDir>/archive/**` (retention cold storage). */
export function isRetentionArchivePath(absPath: string, dataDir: string): boolean {
  if (!absPath || !dataDir) return false;
  const archiveRoot = withTrailingSep(resolvePath(dataDir, 'archive'));
  const resolved = withTrailingSep(resolvePath(absPath));
  return resolved.startsWith(archiveRoot);
}

const LIST_CAP = 2000;
const KIND_ORDER: Record<FileBrowserEntry['kind'], number> = { dir: 0, file: 1, other: 2 };

/**
 * Shared core of GET /files/list, also used by the node's `files.list` RPC.
 * `root` must be an already-resolved absolute directory; `relRaw` is the raw
 * client-supplied relative path (or undefined). Lexical + realpath
 * containment; the root itself is listable. `.git` and `<dataDir>/archive`
 * denied.
 */
export async function listUnderRoot(
  root: string,
  relRaw: unknown,
  dataDir?: string,
): Promise<{ status: number; body: FileBrowserListing | { error: string } }> {
  const err = (status: number, error: string) => ({ status, body: { error } });
  if (relRaw !== undefined && typeof relRaw !== 'string') return err(400, 'path must be a string');
  let rel = ((relRaw as string | undefined) ?? '').trim();
  if (rel === '.') rel = '';
  if (rel.includes('\0') || rel.startsWith('/') || rel.startsWith('~') || isAbsolute(rel)) {
    return err(400, 'path must be relative');
  }
  const target = resolvePath(root, rel);
  if (target !== root && !target.startsWith(withTrailingSep(root))) return err(403, 'path not allowed');
  let realRoot: string;
  let realTarget: string;
  try { realRoot = await realpath(root); } catch { return err(404, 'root not found'); }
  try { realTarget = await realpath(target); } catch { return err(404, 'not found'); }
  if (realTarget !== realRoot && !realTarget.startsWith(withTrailingSep(realRoot))) {
    return err(403, 'path not allowed');
  }
  if (relative(realRoot, realTarget).split(sep).includes('.git')) return err(403, 'path not allowed');
  if (dataDir && (isRetentionArchivePath(realTarget, dataDir) || isRetentionArchivePath(target, dataDir))) {
    return err(403, 'path not allowed');
  }
  const st = await stat(realTarget).catch(() => null);
  if (!st) return err(404, 'not found');
  if (!st.isDirectory()) return err(400, 'not a directory');

  const all = await readdir(realTarget, { withFileTypes: true }).catch(() => null);
  if (!all) return err(403, 'cannot read directory');
  const dirents = all.filter((d) => d.name !== '.git');
  // Every entry is statted before the 2000-entry cap is applied. Fine for v1;
  // revisit (cap before stat, or batch) for very large folders.
  const entries = await Promise.all(dirents.map(async (d): Promise<FileBrowserEntry> => {
    const abs = join(realTarget, d.name);
    const symlink = d.isSymbolicLink() ? { symlink: true as const } : {};
    const s = await stat(abs).catch(() => null);
    if (!s) return { name: d.name, kind: 'other', size: 0, mtimeMs: 0, ...symlink };
    const kind: FileBrowserEntry['kind'] = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
    const e: FileBrowserEntry = { name: d.name, kind, size: s.size, mtimeMs: s.mtimeMs, ...symlink };
    if (kind === 'file') {
      e.openable = isOpenableExtension(extname(d.name).slice(1).toLowerCase())
        && !isSecretPath(abs)
        && !(dataDir && isRetentionArchivePath(abs, dataDir));
    }
    return e;
  }));
  entries.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const truncated = entries.length > LIST_CAP;
  return {
    status: 200,
    body: {
      root,
      path: relative(root, target).split(sep).join('/'),
      entries: truncated ? entries.slice(0, LIST_CAP) : entries,
      truncated,
    },
  };
}
