import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileGitDiffUrl, fileUrl, fetchFileGitDiff, restoreFileGit } from './api.js';

describe('fileGitDiffUrl', () => {
  it('constructs url for absolute path', () => {
    expect(fileGitDiffUrl('/home/user/file.ts')).toBe('/files/git-diff?path=%2Fhome%2Fuser%2Ffile.ts');
  });

  it('constructs url for tilde path', () => {
    expect(fileGitDiffUrl('~/file.ts')).toBe('/files/git-diff?path=~%2Ffile.ts');
  });

  it('preserves conversationId for absolute path', () => {
    expect(fileGitDiffUrl('/home/user/file.ts', { conversationId: 'c1' })).toBe(
      '/files/git-diff?path=%2Fhome%2Fuser%2Ffile.ts&conversationId=c1',
    );
  });

  it('preserves projectId for absolute path', () => {
    expect(fileGitDiffUrl('/home/user/file.ts', { projectId: 'p1' })).toBe(
      '/files/git-diff?path=%2Fhome%2Fuser%2Ffile.ts&projectId=p1',
    );
  });

  it('constructs url with conversationId for relative path', () => {
    expect(fileGitDiffUrl('src/index.ts', { conversationId: 'c1' })).toBe(
      '/files/git-diff?path=src%2Findex.ts&conversationId=c1',
    );
  });

  it('constructs url with projectId for relative path without conversationId', () => {
    expect(fileGitDiffUrl('src/index.ts', { projectId: 'p1' })).toBe(
      '/files/git-diff?path=src%2Findex.ts&projectId=p1',
    );
  });
});

describe('fileUrl', () => {
  it('constructs url for absolute path without ctx', () => {
    expect(fileUrl('/home/user/file.png')).toBe('/files?path=%2Fhome%2Fuser%2Ffile.png');
  });

  it('constructs url for tilde path without ctx', () => {
    expect(fileUrl('~/file.png')).toBe('/files?path=~%2Ffile.png');
  });

  it('preserves conversationId for absolute path (remote host artifact)', () => {
    expect(fileUrl('/home/tierwynhost/.config/tierwyn/node/artifacts/c1/owl.jpg', { conversationId: 'c1' })).toBe(
      '/files?path=%2Fhome%2Ftierwynhost%2F.config%2Ftierwyn%2Fnode%2Fartifacts%2Fc1%2Fowl.jpg&conversationId=c1',
    );
  });

  it('preserves projectId for absolute path', () => {
    expect(fileUrl('/home/tierwynhost/project/image.png', { projectId: 'p1' })).toBe(
      '/files?path=%2Fhome%2Ftierwynhost%2Fproject%2Fimage.png&projectId=p1',
    );
  });

  it('accepts string conversationId shorthand for absolute path', () => {
    expect(fileUrl('/home/user/file.png', 'c1')).toBe(
      '/files?path=%2Fhome%2Fuser%2Ffile.png&conversationId=c1',
    );
  });

  it('constructs url with conversationId for relative path', () => {
    expect(fileUrl('images/logo.png', { conversationId: 'c1' })).toBe(
      '/files?path=images%2Flogo.png&conversationId=c1',
    );
  });

  it('constructs url with projectId for relative path', () => {
    expect(fileUrl('images/logo.png', { projectId: 'p1' })).toBe(
      '/files?path=images%2Flogo.png&projectId=p1',
    );
  });
});

describe('fetchFileGitDiff', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns json result on successful fetch', async () => {
    const mockResponse = { modified: true, diff: 'diff --git a/a.ts b/a.ts\n+added', isTracked: true };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const result = await fetchFileGitDiff('/a.ts');
    expect(result).toEqual(mockResponse);
  });

  it('throws on non-ok status', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'git failed' }),
    });

    await expect(fetchFileGitDiff('/a.ts')).rejects.toThrow('git diff /a.ts -> 500 git failed');
  });
});

describe('restoreFileGit', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns restored action on successful restore', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ action: 'restored', path: '/a.ts' }),
    });

    const res = await restoreFileGit('/a.ts');
    expect(res).toEqual({ action: 'restored', path: '/a.ts' });
  });

  it('returns deleted action when untracked file deleted', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ action: 'deleted', path: '/a.ts' }),
    });

    const res = await restoreFileGit('/a.ts');
    expect(res).toEqual({ action: 'deleted', path: '/a.ts' });
  });

  it('throws on non-ok status', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'not in git' }),
    });

    await expect(restoreFileGit('/a.ts')).rejects.toThrow('git restore /a.ts -> 400 not in git');
  });
});
