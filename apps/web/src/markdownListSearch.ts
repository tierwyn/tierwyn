/** Last path segment, posix or windows. */
export function fileBasename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

export type MarkdownContentMap = Record<string, string | undefined>;

/**
 * Filter markdown paths by filename/path substring, or by loaded file body.
 * Unloaded contents do not match content-only queries (avoids flashing every
 * row while fetches are in flight).
 */
export function filterMarkdownList(
  paths: string[],
  query: string,
  contents: MarkdownContentMap,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths;
  return paths.filter((path) => {
    if (path.toLowerCase().includes(q)) return true;
    const text = contents[path];
    return typeof text === 'string' && text.toLowerCase().includes(q);
  });
}

function firstPreviewLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^#+\s+/, '');
    if (line) return line;
  }
  return '';
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * One-line preview: opening heading/prose, or a snippet around the first
 * content match when `query` hits the body.
 */
export function markdownPreview(text: string, query: string, radius = 52): string | null {
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return null;

  const q = query.trim();
  if (q) {
    const idx = trimmed.toLowerCase().indexOf(q.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - radius);
      const end = Math.min(trimmed.length, idx + q.length + radius);
      const slice = collapseWs(trimmed.slice(start, end));
      const prefix = start > 0 ? '…' : '';
      const suffix = end < trimmed.length ? '…' : '';
      return `${prefix}${slice}${suffix}`;
    }
  }

  const line = firstPreviewLine(trimmed);
  if (!line) return null;
  return clip(line, 140);
}
