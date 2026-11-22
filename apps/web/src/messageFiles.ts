import { isOpenableExtension, type MessageFile } from '@tierwyn/shared';

export type AttachmentChipKind = 'preview' | 'download' | 'too_large' | 'unavailable';

export function attachmentChipKind(file: Pick<MessageFile, 'name' | 'status' | 'path'>): AttachmentChipKind {
  if (file.status === 'too_large') return 'too_large';
  if (file.status === 'unavailable' || !file.path) return 'unavailable';
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase()
    ?? /\.([a-z0-9]+)$/i.exec(file.path)?.[1]?.toLowerCase()
    ?? '';
  return ext && isOpenableExtension(ext) ? 'preview' : 'download';
}
