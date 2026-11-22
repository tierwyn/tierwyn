export type FileBrowserEntryKind = 'dir' | 'file' | 'other';

export interface FileBrowserEntry {
  name: string;
  kind: FileBrowserEntryKind;
  size: number;
  mtimeMs: number;
  /** Present on symlinks only; kind/size describe the target. */
  symlink?: true;
  /** Files only: GET /files will serve it (openable ext, not secret, not archive). */
  openable?: boolean;
}

export interface FileBrowserListing {
  /** Absolute root (DB value: conversation workdir or project root). */
  root: string;
  /** Normalised path relative to root, '' for root, '/'-separated. */
  path: string;
  entries: FileBrowserEntry[];
  truncated: boolean;
}
