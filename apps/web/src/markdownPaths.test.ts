import { describe, it, expect } from 'vitest';
import { imagePathsForPreviewStrip, localMarkdownImagePath } from './markdownPaths.js';

describe('localMarkdownImagePath', () => {
  it('returns filesystem absolute image paths so markdown imgs use /files not a site URL', () => {
    expect(localMarkdownImagePath(
      '/home/user/.gemini/antigravity-cli/brain/x/concept_icons_grid.jpg',
    )).toBe('/home/user/.gemini/antigravity-cli/brain/x/concept_icons_grid.jpg');
  });

  it('normalizes file:// image URLs', () => {
    expect(localMarkdownImagePath('file:///tmp/shot.png')).toBe('/tmp/shot.png');
  });

  it('rewrites web-root image paths to project-relative targets', () => {
    expect(localMarkdownImagePath('/icons/icon-192.png')).toBe('icons/icon-192.png');
  });

  it('keeps relative image paths', () => {
    expect(localMarkdownImagePath('./assets/logo.png')).toBe('./assets/logo.png');
    expect(localMarkdownImagePath('icons/maskable.svg')).toBe('icons/maskable.svg');
  });

  it('ignores remote and data URLs', () => {
    expect(localMarkdownImagePath('https://cdn.example.com/x.png')).toBeNull();
    expect(localMarkdownImagePath('data:image/png;base64,abc')).toBeNull();
    expect(localMarkdownImagePath('')).toBeNull();
  });

  it('ignores non-image local files', () => {
    expect(localMarkdownImagePath('/home/user/Projects/Tierwyn/README.md')).toBeNull();
  });

  it('strips a leading @ from adapter image mentions', () => {
    expect(localMarkdownImagePath('@/tmp/shot.png')).toBe('/tmp/shot.png');
  });
});

describe('imagePathsForPreviewStrip', () => {
  it('omits paths already shown as markdown images so the strip does not duplicate', () => {
    expect(imagePathsForPreviewStrip('![shot](/tmp/a.png)\n\nSee /tmp/a.png')).toEqual([]);
  });

  it('keeps a prose path that is not an inline image', () => {
    expect(imagePathsForPreviewStrip('Wrote /tmp/a.png')).toEqual(['/tmp/a.png']);
  });

  it('keeps a second file mentioned only in prose', () => {
    expect(imagePathsForPreviewStrip('![a](/tmp/a.png) and /tmp/b.png')).toEqual(['/tmp/b.png']);
  });

  it('returns nothing for bare filenames with no real path', () => {
    expect(imagePathsForPreviewStrip('missing agent-activity.png and model-picker.png')).toEqual([]);
  });

  it('treats markdown title syntax as an inline image', () => {
    expect(imagePathsForPreviewStrip('![x](/tmp/a.png "caption") also /tmp/a.png')).toEqual([]);
  });
});
