import type { NormalisedEvent } from '@tierwyn/shared';
import {
  extractImagePaths,
  isImageExtension,
  isMarkdownExtension,
  isPlausibleFsAbsolute,
  findOpenablePaths,
  toProjectRelativePath,
} from '@tierwyn/shared';

/** Strip file:// / localhost / #L… so the path matches what FileModal / GET /files expect. */
export function normalizeOpenablePath(raw: string): string {
  let path = raw.trim().replace(/^file:\/{1,3}/i, '/');
  path = path.replace(/^\/?localhost\//i, '/');
  path = path.split('#')[0].split('?')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep path */
  }
  return path;
}

function extensionOf(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Local image `src` from agent markdown (`![alt](/home/…jpg)`, `file://`,
 * `./icons/foo.png`). Remote/data URLs stay as plain `<img>`. Returned path
 * is what GET /files (via FileImage) expects.
 */
export function localMarkdownImagePath(src: string): string | null {
  if (!src) return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (/^(https?:|data:|blob:)/i.test(trimmed) || trimmed.startsWith('//')) return null;
  let path = normalizeOpenablePath(trimmed);
  if (path.startsWith('@')) path = path.slice(1);
  if (!path) return null;
  const ext = extensionOf(path);
  if (!ext || !isImageExtension(ext)) return null;
  if (path.startsWith('/') && !isPlausibleFsAbsolute(path)) {
    return toProjectRelativePath(path);
  }
  return path;
}

/** `![alt](src)` / `![alt](src "title")` sources already rendered inline. */
function markdownImageSrcs(text: string): string[] {
  const out: string[] = [];
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const local = localMarkdownImagePath(m[1]);
    if (local) out.push(local);
  }
  return out;
}

/**
 * Paths the bottom preview strip may thumbnail. Skips bare prose names and
 * any file already shown as an inline markdown image (no duplicates).
 */
export function imagePathsForPreviewStrip(text: string): string[] {
  if (!text) return [];
  const inline = new Set(markdownImageSrcs(text));
  return extractImagePaths(text).filter((p) => !inline.has(p));
}

function isMarkdownPath(path: string): boolean {
  const ext = extensionOf(path);
  return !!ext && isMarkdownExtension(ext);
}

/** Extract openable path substrings from free text (same regex set + normalization as linkifyPaths / EventItem). */
export function extractPathsFromText(text: string): string[] {
  if (!text) return [];
  return findOpenablePaths(text).map((m) => normalizeOpenablePath(m.path));
}

function textsFromEvent(event: NormalisedEvent): string[] {
  switch (event.type) {
    case 'prompt':
    case 'steer':
      return [event.payload.text];
    case 'message': {
      const texts = [event.payload.chunk];
      if (event.payload.spawnMarker?.text) texts.push(event.payload.spawnMarker.text);
      return texts;
    }
    case 'tool_result':
      return [event.payload.content];
    case 'tool_call':
      try {
        return [JSON.stringify(event.payload.input)];
      } catch {
        return [];
      }
    case 'error': {
      const texts = [event.payload.message];
      if (event.payload.detail) texts.push(event.payload.detail);
      return texts;
    }
    case 'interaction_request':
      return [event.payload.prompt];
    default:
      return [];
  }
}

/**
 * Markdown paths mentioned in a conversation transcript (client-side).
 * First-seen order; de-duped by normalized path string.
 */
export function collectMarkdownPaths(events: NormalisedEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (path: string) => {
    if (!path || !isMarkdownPath(path) || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  for (const event of events) {
    if (event.type === 'file_change') {
      push(normalizeOpenablePath(event.payload.path));
    }
    for (const text of textsFromEvent(event)) {
      for (const path of extractPathsFromText(text)) {
        push(path);
      }
    }
  }

  return out;
}
