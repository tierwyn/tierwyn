import { describe, it, expect } from 'vitest';
import { isExplicitImagePath, imagePathCandidatesFromClipboard } from './InputBar.js';

function mockDataTransfer(data: Record<string, string>): DataTransfer {
  return {
    getData: (format: string) => data[format] ?? '',
    types: Object.keys(data),
    items: [] as unknown as DataTransferItemList,
    files: [] as unknown as FileList,
    dropEffect: 'none',
    effectAllowed: 'none',
    clearData: () => {},
    setData: () => {},
    setDragImage: () => {},
  } as unknown as DataTransfer;
}

describe('isExplicitImagePath', () => {
  it('accepts absolute POSIX paths with image extensions', () => {
    expect(isExplicitImagePath('/home/user/Pictures/screenshot.png')).toBe(true);
    expect(isExplicitImagePath('/tmp/image.jpeg')).toBe(true);
    expect(isExplicitImagePath('/var/log/app/banner.webp')).toBe(true);
  });

  it('accepts paths with spaces in directories or filenames if explicitly path-prefixed', () => {
    expect(isExplicitImagePath('/home/user/My Photos/vacation 2026/beach.jpg')).toBe(true);
    expect(isExplicitImagePath('~/Pictures/Screenshots/Screenshot from 2026-05-01.png')).toBe(true);
  });

  it('accepts file:// URIs', () => {
    expect(isExplicitImagePath('file:///home/user/Pictures/screenshot.png')).toBe(true);
    expect(isExplicitImagePath('file://localhost/home/user/Pictures/screenshot.png')).toBe(true);
  });

  it('accepts home-relative and relative paths', () => {
    expect(isExplicitImagePath('~/Pictures/photo.png')).toBe(true);
    expect(isExplicitImagePath('./assets/logo.svg')).toBe(true);
    expect(isExplicitImagePath('../images/banner.bmp')).toBe(true);
  });

  it('accepts Windows drive letter paths', () => {
    expect(isExplicitImagePath('C:\\Users\\User\\Pictures\\cat.png')).toBe(true);
    expect(isExplicitImagePath('D:/assets/texture.gif')).toBe(true);
  });

  it('accepts quoted paths', () => {
    expect(isExplicitImagePath('"/home/user/Pictures/screenshot.png"')).toBe(true);
    expect(isExplicitImagePath("'~/Pictures/photo.png'")).toBe(true);
  });

  it('rejects bare filenames without path prefix to protect text paste', () => {
    expect(isExplicitImagePath('start_frame.jpg')).toBe(false);
    expect(isExplicitImagePath('photo.png')).toBe(false);
    expect(isExplicitImagePath('logo.svg')).toBe(false);
  });

  it('rejects prose text mentioning image filenames', () => {
    expect(isExplicitImagePath('In video generation, start_frame.jpg is used to define the first frame.')).toBe(false);
    expect(isExplicitImagePath('Use start_frame.jpg for the video')).toBe(false);
    expect(isExplicitImagePath('1. start_frame.jpg')).toBe(false);
    expect(isExplicitImagePath('- start_frame.jpg')).toBe(false);
  });

  it('rejects code snippets and comments', () => {
    expect(isExplicitImagePath("const file = 'start_frame.jpg';")).toBe(false);
    expect(isExplicitImagePath('// check /tmp/test.png')).toBe(false);
    expect(isExplicitImagePath('{"start_frame": "start_frame.jpg"}')).toBe(false);
  });

  it('rejects URLs', () => {
    expect(isExplicitImagePath('https://example.com/image.png')).toBe(false);
    expect(isExplicitImagePath('http://localhost:8788/image.jpg')).toBe(false);
  });

  it('rejects non-image extensions', () => {
    expect(isExplicitImagePath('/home/user/script.py')).toBe(false);
    expect(isExplicitImagePath('/tmp/document.pdf')).toBe(false);
    expect(isExplicitImagePath('~/notes.txt')).toBe(false);
  });
});

describe('imagePathCandidatesFromClipboard', () => {
  it('extracts candidate from structured file-manager clipboard formats', () => {
    const gnome = mockDataTransfer({
      'x-special/gnome-copied-files': 'copy\nfile:///home/user/Pictures/shot.png',
      'text/plain': 'file:///home/user/Pictures/shot.png',
    });
    expect(imagePathCandidatesFromClipboard(gnome)).toEqual(['file:///home/user/Pictures/shot.png']);

    const kde = mockDataTransfer({
      'text/x-kde-copied-files': 'file:///home/user/Pictures/shot.png',
      'text/plain': 'file:///home/user/Pictures/shot.png',
    });
    expect(imagePathCandidatesFromClipboard(kde)).toEqual(['file:///home/user/Pictures/shot.png']);

    const uriList = mockDataTransfer({
      'text/uri-list': '# comment\nfile:///home/user/Pictures/shot.png\r\n',
    });
    expect(imagePathCandidatesFromClipboard(uriList)).toEqual(['file:///home/user/Pictures/shot.png']);
  });

  it('extracts single explicit image path from text/plain', () => {
    const dt = mockDataTransfer({
      'text/plain': '/home/user/Pictures/shot.png',
    });
    expect(imagePathCandidatesFromClipboard(dt)).toEqual(['/home/user/Pictures/shot.png']);
  });

  it('extracts multiple explicit image paths from text/plain', () => {
    const dt = mockDataTransfer({
      'text/plain': '/tmp/img1.png\n/tmp/img2.jpg\n~/img3.webp',
    });
    expect(imagePathCandidatesFromClipboard(dt)).toEqual([
      '/tmp/img1.png',
      '/tmp/img2.jpg',
      '~/img3.webp',
    ]);
  });

  it('DOES NOT intercept Gemini response or technical documentation mentioning image filenames', () => {
    const geminiResponse = `In video generation with gemini-omni-1.1-flash:
1. start_frame.jpg provides the initial visual reference.
2. prompt contains the animation instructions.
Payload example:
{
  "start_frame": "start_frame.jpg",
  "prompt": "sunset over mountains"
}`;

    const dt = mockDataTransfer({
      'text/plain': geminiResponse,
    });
    // Must return empty array so handlePaste allows normal text paste to proceed!
    expect(imagePathCandidatesFromClipboard(dt)).toEqual([]);
  });

  it('DOES NOT intercept single-line prose mentioning start_frame.jpg', () => {
    const dt = mockDataTransfer({
      'text/plain': 'Pass start_frame.jpg to initialize the video generation model.',
    });
    expect(imagePathCandidatesFromClipboard(dt)).toEqual([]);
  });

  it('DOES NOT intercept bare filename copied as plain text', () => {
    const dt = mockDataTransfer({
      'text/plain': 'start_frame.jpg',
    });
    expect(imagePathCandidatesFromClipboard(dt)).toEqual([]);
  });

  it('DOES NOT intercept mixed text where some lines look like paths and others are prose', () => {
    const dt = mockDataTransfer({
      'text/plain': '/home/user/photo.png\nHere is an explanation of the photo\n/home/user/other.png',
    });
    expect(imagePathCandidatesFromClipboard(dt)).toEqual([]);
  });
});
