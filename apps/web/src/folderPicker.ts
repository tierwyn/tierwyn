/** Pure helpers for the directory picker modal. */

export function joinAbs(root: string, rel: string, name?: string): string {
  const segments: string[] = [];
  for (const part of [root, rel, name]) {
    if (!part) continue;
    for (const seg of part.split('/')) {
      if (seg) segments.push(seg);
    }
  }
  return '/' + segments.join('/');
}

export function visibleDirs<T extends string | { name: string }>(
  dirs: T[],
  showHidden: boolean,
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return dirs.filter((d) => {
    const name = typeof d === 'string' ? d : d.name;
    if (!showHidden && name.startsWith('.')) return false;
    if (q && !name.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function rootLabel(root: string, homedir?: string): string {
  if (homedir && root === homedir) return '~';
  return root;
}

export function initialBrowseLocation(
  currentPath: string,
  roots: string[],
): { root: string; rel: string } {
  if (!roots || roots.length === 0) return { root: '', rel: '' };
  const trimmed = currentPath.trim();
  if (!trimmed.startsWith('/')) return { root: roots[0], rel: '' };

  const norm = trimmed.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';

  for (const r of roots) {
    const normRoot = r.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
    const isUnder = norm === normRoot || norm.startsWith(normRoot === '/' ? '/' : normRoot + '/');
    if (!isUnder) continue;

    if (norm === normRoot) {
      return { root: r, rel: '' };
    }
    const lastSlash = norm.lastIndexOf('/');
    const parentPath = lastSlash === 0 ? '/' : norm.slice(0, lastSlash);
    if (parentPath === normRoot || !(parentPath === normRoot || parentPath.startsWith(normRoot === '/' ? '/' : normRoot + '/'))) {
      return { root: r, rel: '' };
    }
    const rel = parentPath.slice(normRoot === '/' ? 1 : normRoot.length + 1);
    return { root: r, rel };
  }

  return { root: roots[0], rel: '' };
}
