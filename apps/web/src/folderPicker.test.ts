import { describe, it, expect } from 'vitest';
import { joinAbs, visibleDirs, rootLabel, initialBrowseLocation } from './folderPicker.js';

describe('joinAbs', () => {
  it('combines root, rel and name cleanly', () => {
    expect(joinAbs('/home/user', 'projects', 'my-app')).toBe('/home/user/projects/my-app');
    expect(joinAbs('/home/user', 'projects')).toBe('/home/user/projects');
    expect(joinAbs('/home/user', '')).toBe('/home/user');
    expect(joinAbs('/home/user', '', 'my-app')).toBe('/home/user/my-app');
  });

  it('normalises extra slashes', () => {
    expect(joinAbs('/home/user/', '/projects/', '/my-app/')).toBe('/home/user/projects/my-app');
    expect(joinAbs('//home///user//', '')).toBe('/home/user');
    expect(joinAbs('/', '')).toBe('/');
    expect(joinAbs('/', 'projects')).toBe('/projects');
    expect(joinAbs('/', '', 'new-app')).toBe('/new-app');
  });
});

describe('visibleDirs', () => {
  const dirs = [
    { name: 'projects' },
    { name: '.config' },
    { name: '.git' },
    { name: 'documents' },
    { name: 'downloads' },
  ];

  it('hides dot-prefixed directories unless showHidden is true', () => {
    expect(visibleDirs(dirs, false, '').map((d) => d.name)).toEqual(['projects', 'documents', 'downloads']);
    expect(visibleDirs(dirs, true, '').map((d) => d.name)).toEqual(['projects', '.config', '.git', 'documents', 'downloads']);
  });

  it('filters by query case-insensitively', () => {
    expect(visibleDirs(dirs, false, 'DOC').map((d) => d.name)).toEqual(['documents']);
    expect(visibleDirs(dirs, true, 'git').map((d) => d.name)).toEqual(['.git']);
    expect(visibleDirs(dirs, false, 'xyz').map((d) => d.name)).toEqual([]);
  });

  it('works with plain string arrays', () => {
    const stringDirs = ['src', '.cache', 'dist'];
    expect(visibleDirs(stringDirs, false, '')).toEqual(['src', 'dist']);
    expect(visibleDirs(stringDirs, true, 'ca')).toEqual(['.cache']);
  });
});

describe('rootLabel', () => {
  it('returns ~ when root equals homedir', () => {
    expect(rootLabel('/home/alice', '/home/alice')).toBe('~');
    expect(rootLabel('/home/bob', '/home/alice')).toBe('/home/bob');
    expect(rootLabel('/home/alice')).toBe('/home/alice');
  });
});

describe('initialBrowseLocation', () => {
  const roots = ['/home/alice', '/var/data'];

  it('returns parent directory when inside a root', () => {
    expect(initialBrowseLocation('/home/alice/projects/tierwyn', roots)).toEqual({
      root: '/home/alice',
      rel: 'projects',
    });
    expect(initialBrowseLocation('/home/alice/projects', roots)).toEqual({
      root: '/home/alice',
      rel: '',
    });
  });

  it('returns root itself with rel empty when path equals root', () => {
    expect(initialBrowseLocation('/home/alice', roots)).toEqual({
      root: '/home/alice',
      rel: '',
    });
  });

  it('returns first root when path is outside all roots', () => {
    expect(initialBrowseLocation('/tmp/foo', roots)).toEqual({
      root: '/home/alice',
      rel: '',
    });
    expect(initialBrowseLocation('relative/path', roots)).toEqual({
      root: '/home/alice',
      rel: '',
    });
  });

  it('enforces directory boundary (/home/a vs /home/ab)', () => {
    const boundaryRoots = ['/home/ab'];
    expect(initialBrowseLocation('/home/a', boundaryRoots)).toEqual({
      root: '/home/ab',
      rel: '',
    });
    expect(initialBrowseLocation('/home/ab/sub', boundaryRoots)).toEqual({
      root: '/home/ab',
      rel: '',
    });
    expect(initialBrowseLocation('/home/ab/sub/child', boundaryRoots)).toEqual({
      root: '/home/ab',
      rel: 'sub',
    });
  });

  it('handles empty roots gracefully', () => {
    expect(initialBrowseLocation('/some/path', [])).toEqual({
      root: '',
      rel: '',
    });
  });
});
