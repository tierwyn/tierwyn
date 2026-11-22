import { describe, expect, it } from 'vitest';
import { fileFallbackText } from '@tierwyn/shared';
import { attachmentChipKind } from './messageFiles.js';

describe('attachmentChipKind', () => {
  it('md → preview, gz → download, too_large, unavailable', () => {
    expect(attachmentChipKind({ name: 'notes.md', status: 'ok', path: '/data/attachments/c/abc.md' })).toBe('preview');
    expect(attachmentChipKind({ name: 'archive.gz', status: 'ok', path: '/data/attachments/c/abc.gz' })).toBe('download');
    expect(attachmentChipKind({ name: 'big.bin', status: 'too_large' })).toBe('too_large');
    expect(attachmentChipKind({ name: 'gone.txt', status: 'unavailable' })).toBe('unavailable');
  });
});

describe('fileFallbackText equality', () => {
  it('matches the chunk the mapper emits for the same names', () => {
    const files = [{ name: 'test-file.txt' }, { name: 'notes.md' }];
    expect(fileFallbackText(files)).toBe('📎 test-file.txt\n📎 notes.md');
  });
});

describe('attachmentChipKind — media', () => {
  it('video and audio files get the preview (playable) chip', () => {
    expect(attachmentChipKind({ name: 'clip.mp4', status: 'ok', path: '/data/attachments/c/abc.mp4' })).toBe('preview');
    expect(attachmentChipKind({ name: 'film.mkv', status: 'ok', path: '/data/attachments/c/abc.mkv' })).toBe('preview');
    expect(attachmentChipKind({ name: 'note.mp3', status: 'ok', path: '/data/attachments/c/abc.mp3' })).toBe('preview');
  });
});
