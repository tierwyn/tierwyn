/** Pure helpers for the New Project modal's live remote-path hint. */

export interface RemotePathCheck {
  path: { exists?: boolean; isDir?: boolean; underRoots?: boolean; isGitRepo?: boolean };
  parent?: { exists?: boolean; isDir?: boolean; underRoots?: boolean };
}

export interface PathHint {
  ok: boolean;
  text: string;
}

export function remotePathHint(
  r: RemotePathCheck | 'error' | undefined,
  clone: boolean,
  opts: {
    allowCreate?: boolean;
    requireRootsForExisting?: boolean;
    nodeUpdateRequired?: boolean;
  } = {},
): PathHint | undefined {
  if (!r) return undefined;
  if (r === 'error') return { ok: false, text: 'Host unreachable' };
  const p = r.path;
  const requireRootsForExisting = opts.requireRootsForExisting ?? true;
  if (!clone) {
    if (!p.exists) {
      if (opts.allowCreate) {
        if (!r.parent?.exists || !r.parent.isDir) return { ok: false, text: 'Parent folder not found' };
        if (!r.parent.underRoots) return { ok: false, text: 'Parent outside allowed roots' };
        return { ok: true, text: 'Will create a new folder' };
      }
      if (opts.nodeUpdateRequired) {
        return { ok: false, text: 'Update the node on this host to create folders' };
      }
      return { ok: false, text: requireRootsForExisting ? 'Not found on host' : 'Not found' };
    }
    if (!p.isDir) return { ok: false, text: 'Not a folder' };
    if (requireRootsForExisting && !p.underRoots) return { ok: false, text: "Outside the host's allowed roots" };
    return p.isGitRepo ? { ok: true, text: 'Git repo' } : { ok: true, text: 'Folder (not a git repo)' };
  }
  if (p.exists) return { ok: false, text: 'Already exists' };
  if (!r.parent?.exists || !r.parent.isDir) return { ok: false, text: 'Parent folder not found' };
  if (!r.parent.underRoots) return { ok: false, text: 'Parent outside allowed roots' };
  return { ok: true, text: 'Will clone into a new folder' };
}

/** Last path segment minus a trailing .git — prefill for the project name. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '');
  const last = cleaned.split(/[/:]/).filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/i, '');
}
