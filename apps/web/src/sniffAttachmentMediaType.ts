/**
 * Best-effort MIME when the OS leaves file.type empty (common for audio).
 * Known file.type always wins so we never override a real OS value.
 */
const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/m4a',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
};

export function sniffAttachmentMediaType(fileType: string, fileName: string): string {
  if (fileType) return fileType;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}
