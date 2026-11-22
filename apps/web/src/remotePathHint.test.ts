import { describe, it, expect } from 'vitest';
import { remotePathHint, repoNameFromUrl, type RemotePathCheck } from './remotePathHint.js';

const stat = (over: Record<string, boolean> = {}) => ({
  path: { exists: true, isDir: true, underRoots: true, isGitRepo: false, ...over },
  parent: { exists: true, isDir: true, underRoots: true },
});

describe('remotePathHint', () => {
  it('undefined stat → no hint', () => {
    expect(remotePathHint(undefined, false)).toBeUndefined();
  });

  it('error → host unreachable', () => {
    expect(remotePathHint('error', false)).toEqual({ ok: false, text: 'Host unreachable' });
  });

  it('not clone: missing path → not found', () => {
    expect(remotePathHint(stat({ exists: false }), false)).toEqual({
      ok: false, text: 'Not found on host',
    });
  });

  it('not clone: not a dir → not a folder', () => {
    expect(remotePathHint(stat({ isDir: false }), false))
      .toEqual({ ok: false, text: 'Not a folder' });
  });

  it('not clone: outside roots → outside', () => {
    expect(remotePathHint(stat({ underRoots: false }), false))
      .toEqual({ ok: false, text: "Outside the host's allowed roots" });
  });

  it('not clone: git repo → ok', () => {
    expect(remotePathHint(stat({ isGitRepo: true }), false))
      .toEqual({ ok: true, text: 'Git repo' });
  });

  it('not clone: plain folder → ok', () => {
    expect(remotePathHint(stat(), false))
      .toEqual({ ok: true, text: 'Folder (not a git repo)' });
  });

  it('clone: existing target → already exists', () => {
    expect(remotePathHint(stat(), true)).toEqual({ ok: false, text: 'Already exists' });
  });

  it('clone: parent missing → parent not found', () => {
    expect(remotePathHint({ ...stat({ exists: false }), parent: { exists: false, isDir: false, underRoots: true } }, true))
      .toEqual({ ok: false, text: 'Parent folder not found' });
  });

  it('clone: parent outside roots → outside', () => {
    expect(remotePathHint({ ...stat({ exists: false }), parent: { exists: true, isDir: true, underRoots: false } }, true))
      .toEqual({ ok: false, text: 'Parent outside allowed roots' });
  });

  it('clone: fresh target under a live parent → will clone', () => {
    expect(remotePathHint({ ...stat({ exists: false }), parent: { exists: true, isDir: true, underRoots: true } }, true))
      .toEqual({ ok: true, text: 'Will clone into a new folder' });
  });

  describe('allowCreate and requireRootsForExisting options', () => {
    it('not clone + missing path: parent missing → parent not found', () => {
      expect(remotePathHint({ ...stat({ exists: false }), parent: { exists: false, isDir: false, underRoots: true } }, false, { allowCreate: true }))
        .toEqual({ ok: false, text: 'Parent folder not found' });
    });

    it('not clone + missing path: parent outside roots → outside allowed roots', () => {
      expect(remotePathHint({ ...stat({ exists: false }), parent: { exists: true, isDir: true, underRoots: false } }, false, { allowCreate: true }))
        .toEqual({ ok: false, text: 'Parent outside allowed roots' });
    });

    it('not clone + missing path: parent valid → will create a new folder', () => {
      expect(remotePathHint({ ...stat({ exists: false }), parent: { exists: true, isDir: true, underRoots: true } }, false, { allowCreate: true }))
        .toEqual({ ok: true, text: 'Will create a new folder' });
    });

    it('not clone + existing path outside roots: requireRootsForExisting false → ok', () => {
      expect(remotePathHint(stat({ underRoots: false }), false, { requireRootsForExisting: false }))
        .toEqual({ ok: true, text: 'Folder (not a git repo)' });
    });

    it('not clone + missing path without allowCreate: requireRootsForExisting false → not found', () => {
      expect(remotePathHint(stat({ exists: false }), false, { requireRootsForExisting: false }))
        .toEqual({ ok: false, text: 'Not found' });
    });

    it('not clone + missing path + nodeUpdateRequired true → Update the node on this host to create folders', () => {
      expect(remotePathHint(stat({ exists: false }), false, { nodeUpdateRequired: true }))
        .toEqual({ ok: false, text: 'Update the node on this host to create folders' });
    });

    it('not clone + missing path + allowCreate true overrides nodeUpdateRequired', () => {
      expect(remotePathHint({ ...stat({ exists: false }), parent: { exists: true, isDir: true, underRoots: true } }, false, { allowCreate: true, nodeUpdateRequired: true }))
        .toEqual({ ok: true, text: 'Will create a new folder' });
    });
  });
});

describe('repoNameFromUrl', () => {
  it.each([
    ['https://example.com/x.git', 'x'],
    ['https://example.com/x', 'x'],
    ['git@github.com:foo/bar.git', 'bar'],
    ['ssh://git@host:2222/foo/bar.git', 'bar'],
    ['https://example.com/x.git/', 'x'],
    ['ssh://git@host:2222/foo/Bar.GIT', 'Bar'],
  ])('%s → %s', (url, want) => {
    expect(repoNameFromUrl(url)).toBe(want);
  });
});
