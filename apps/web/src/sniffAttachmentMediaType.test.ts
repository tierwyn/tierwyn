import { describe, it, expect } from 'vitest';
import { sniffAttachmentMediaType } from './sniffAttachmentMediaType.js';

describe('sniffAttachmentMediaType', () => {
  it('prefers a non-empty OS MIME over the filename', () => {
    expect(sniffAttachmentMediaType('audio/mpeg', 'clip.wav')).toBe('audio/mpeg');
    expect(sniffAttachmentMediaType('application/pdf', 'notes.txt')).toBe('application/pdf');
  });

  it('sniffs pdf and existing text/json extensions when OS MIME is empty', () => {
    expect(sniffAttachmentMediaType('', 'brief.pdf')).toBe('application/pdf');
    expect(sniffAttachmentMediaType('', 'notes.md')).toBe('text/markdown');
    expect(sniffAttachmentMediaType('', 'log.txt')).toBe('text/plain');
    expect(sniffAttachmentMediaType('', 'app.log')).toBe('text/plain');
    expect(sniffAttachmentMediaType('', 'data.json')).toBe('application/json');
  });

  it('sniffs listed audio extensions when OS MIME is empty', () => {
    expect(sniffAttachmentMediaType('', 'note.mp3')).toBe('audio/mpeg');
    expect(sniffAttachmentMediaType('', 'clip.wav')).toBe('audio/wav');
    expect(sniffAttachmentMediaType('', 'voice.m4a')).toBe('audio/m4a');
    expect(sniffAttachmentMediaType('', 'track.aac')).toBe('audio/aac');
    expect(sniffAttachmentMediaType('', 'talk.ogg')).toBe('audio/ogg');
    expect(sniffAttachmentMediaType('', 'song.flac')).toBe('audio/flac');
    expect(sniffAttachmentMediaType('', 'rec.opus')).toBe('audio/opus');
  });

  it('falls back to octet-stream for unknown empty-MIME files', () => {
    expect(sniffAttachmentMediaType('', 'blob.bin')).toBe('application/octet-stream');
    expect(sniffAttachmentMediaType('', 'noext')).toBe('application/octet-stream');
  });
});

describe('sniffAttachmentMediaType — video', () => {
  it('sniffs common video extensions when OS MIME is empty', () => {
    expect(sniffAttachmentMediaType('', 'clip.mp4')).toBe('video/mp4');
    expect(sniffAttachmentMediaType('', 'intro.webm')).toBe('video/webm');
    expect(sniffAttachmentMediaType('', 'holiday.mov')).toBe('video/quicktime');
    expect(sniffAttachmentMediaType('', 'film.mkv')).toBe('video/x-matroska');
    expect(sniffAttachmentMediaType('', 'show.m4v')).toBe('video/mp4');
    expect(sniffAttachmentMediaType('', 'old.avi')).toBe('video/x-msvideo');
  });
});
