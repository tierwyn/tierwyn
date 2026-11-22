import { readFileSync } from 'fs';
import type { Attachment } from '@tierwyn/shared';

/**
 * Anthropic Messages API content block shape — the subset claude-code and
 * claude-code adapters emit. The SDK / stream-json wire format accepts the same
 * union for user-message content.
 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Convert a Tierwyn Attachment into one or more Anthropic-compatible content
 * blocks. Non-image attachments were previously force-cast to `type: 'image'`,
 * which caused the Anthropic backend to silently drop them (the symptom:
 * ".md file attached but never sent to the model").
 *
 * Routing:
 *  - image/*            → image content block
 *  - application/pdf    → document content block
 *  - text/*, application/json, etc. → decoded and inlined as a text block
 *    (the model reads the contents directly; no round-trip through a tool)
 *
 * If `tempPath` is present we always have the raw bytes on disk; for unknown
 * media types we fall back to that path via an `@<tempPath>` text mention,
 * matching the antigravity/opencode adapter pattern — the model resolves the
 * path against the local fs itself.
 */
export function attachmentToContentBlocks(att: Attachment): AnthropicContentBlock[] {
  const mediaType = (att.mediaType || '').toLowerCase();
  const isImage = mediaType.startsWith('image/');
  const isPdf = mediaType === 'application/pdf';

  // Prefer in-memory base64; fall back to reading the temp file the session
  // manager writes for every attachment.
  let base64 = att.base64;
  if (!base64 && att.tempPath) {
    try { base64 = readFileSync(att.tempPath).toString('base64'); } catch { /* ignore */ }
  }

  if (isImage && base64) {
    return [{
      type: 'image',
      source: { type: 'base64', media_type: mediaType || 'image/png', data: base64 },
    }];
  }

  if (isPdf && base64) {
    return [{
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64 },
    }];
  }

  // Text-family types: decode and inline as a text block. Includes markdown,
  // plain text, CSV, JSON, YAML (via text/yaml), source code (text/javascript,
  // text/x-python, etc.) — anything the model can usefully read inline.
  const isTextLike =
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/x-yaml' ||
    mediaType === 'application/yaml';

  if (isTextLike && base64) {
    try {
      const decoded = Buffer.from(base64, 'base64').toString('utf8');
      if (decoded) {
        const lang = inferLang(mediaType, att.tempPath);
        const name = att.tempPath ? att.tempPath.split('/').pop() : 'attachment';
        const fence = lang ? `\n\n\`\`\`${lang}` : '\n\n```';
        return [{ type: 'text', text: `Attached: ${name}${fence}\n${decoded}\n\`\`\`` }];
      }
    } catch { /* fall through to path-mention */ }
  }

  // Last resort: anything else (binary, octet-stream, unknown). Reference the
  // temp path so the model can read the file itself — matches antigravity.
  if (att.tempPath) {
    return [{ type: 'text', text: `\n\n@${att.tempPath}` }];
  }

  // No base64, no tempPath — nothing to emit. Dropping is the only safe option.
  return [];
}

/** Suggest a fenced-code language tag from media type or extension. */
function inferLang(mediaType: string, path?: string): string {
  if (mediaType === 'application/json') return 'json';
  if (mediaType === 'application/xml') return 'xml';
  const mtLang = mediaType.startsWith('text/') ? mediaType.slice(5) : '';
  if (mtLang && !mtLang.startsWith('x-')) return mtLang === 'plain' ? '' : mtLang;
  if (path) {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const known: Record<string, string> = {
      md: 'markdown', markdown: 'markdown',
      json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml',
      js: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
      py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java',
      c: 'c', cpp: 'cpp', sh: 'bash', bash: 'bash',
      html: 'html', css: 'css', sql: 'sql',
    };
    if (known[ext]) return known[ext];
  }
  return '';
}
