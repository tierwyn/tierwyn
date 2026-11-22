import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { attachmentToContentBlocks } from './anthropicAttachment.js';
import type { Attachment } from '@tierwyn/shared';

const TMP = join(tmpdir(), 'tierwyn-attachment-test');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('attachmentToContentBlocks', () => {
  it('routes image/* to an image block', () => {
    const att: Attachment = { mediaType: 'image/png', base64: 'aGVsbG8=' };
    const out = attachmentToContentBlocks(att);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
  });

  it('routes application/pdf to a document block (not image)', () => {
    const att: Attachment = { mediaType: 'application/pdf', base64: 'JVBERi0=' };
    const out = attachmentToContentBlocks(att);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('document');
    expect((out[0] as { source: { media_type: string } }).source.media_type).toBe('application/pdf');
  });

  it('inlines text/markdown as a decoded text block (regression for the .md bug)', () => {
    const md = '# Title\n\nhello world';
    const att: Attachment = { mediaType: 'text/markdown', base64: b64(md), tempPath: '/tmp/foo.md' };
    const out = attachmentToContentBlocks(att);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('text');
    const text = (out[0] as { text: string }).text;
    expect(text).toContain('# Title');
    expect(text).toContain('hello world');
    expect(text).toContain('foo.md');
    // Should NOT be cast as an image.
    expect(out[0].type).not.toBe('image');
  });

  it('uses a markdown language tag for .md paths', () => {
    const att: Attachment = {
      mediaType: 'text/markdown',
      base64: b64('body'),
      tempPath: '/tmp/notes.md',
    };
    const out = attachmentToContentBlocks(att);
    expect((out[0] as { text: string }).text).toMatch(/```markdown/);
  });

  it('handles text/plain with no language tag', () => {
    const att: Attachment = { mediaType: 'text/plain', base64: b64('just text') };
    const out = attachmentToContentBlocks(att);
    expect(out[0].type).toBe('text');
    const text = (out[0] as { text: string }).text;
    expect(text).toContain('just text');
    expect(text).not.toMatch(/```plain/);
  });

  it('falls back to @<tempPath> mention for unknown binary types', () => {
    const path = join(TMP, 'thing.bin');
    writeFileSync(path, Buffer.from('bytes'));
    const att: Attachment = {
      mediaType: 'application/octet-stream',
      base64: Buffer.from('bytes').toString('base64'),
      tempPath: path,
    };
    const out = attachmentToContentBlocks(att);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('text');
    expect((out[0] as { text: string }).text).toMatch(new RegExp(`@${path}`));
  });

  it('returns [] when there is no base64 and no tempPath', () => {
    const att: Attachment = { mediaType: 'image/png', base64: '' };
    expect(attachmentToContentBlocks(att)).toEqual([]);
  });

  it('reads bytes from tempPath when base64 is empty (session-manager path)', () => {
    const path = join(TMP, 'img.png');
    writeFileSync(path, Buffer.from('pngbytes'));
    const att: Attachment = { mediaType: 'image/png', base64: '', tempPath: path };
    const out = attachmentToContentBlocks(att);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('image');
    expect((out[0] as { source: { data: string } }).source.data)
      .toBe(Buffer.from('pngbytes').toString('base64'));
  });
});
