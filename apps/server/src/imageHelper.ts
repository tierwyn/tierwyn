import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const TEMP_DIR = join(tmpdir(), 'tierwyn-attachments');

function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }
}

export interface TempFile {
  path: string;
  mediaType: string;
  cleanup: () => void;
}

export function writeTempAttachment(base64: string, mediaType: string): TempFile {
  ensureTempDir();
  const rawExt = mediaType.split('/')[1] ?? 'bin';
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'bin';
  const filename = `${randomUUID()}.${ext}`;
  const filePath = join(TEMP_DIR, filename);
  const buffer = Buffer.from(base64, 'base64');
  writeFileSync(filePath, buffer);

  return {
    path: filePath,
    mediaType,
    cleanup: () => {
      try { unlinkSync(filePath); } catch { /* already removed */ }
    },
  };
}

export function writeTempAttachments(
  attachments: { base64: string; mediaType: string }[]
): TempFile[] {
  return attachments.map(a => writeTempAttachment(a.base64, a.mediaType));
}

/** Append `@<tempPath>` mentions so CLIs without native image flags still
 *  resolve pasted images from disk (cursor, hermes, openclaw, antigravity, grok). */
export function withImagePathRefs(
  text: string,
  attachments?: { tempPath?: string }[],
): string {
  const pathRefs = (attachments ?? [])
    .map(a => a.tempPath)
    .filter((p): p is string => Boolean(p));
  return pathRefs.length > 0
    ? `${text}\n\n${pathRefs.map(p => `@${p}`).join('\n')}`
    : text;
}
