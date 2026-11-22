import { describe, expect, it } from 'vitest';
import {
  fileBasename,
  filterMarkdownList,
  markdownPreview,
} from './markdownListSearch.js';

const PATHS = [
  '/internal/docs/plans/fw-69-screen-lock.md',
  '/home/user/Projects/Tierwyn/README.md',
  'docs/architecture/scheduled-jobs.md',
];

describe('fileBasename', () => {
  it('returns the last path segment for posix and windows separators', () => {
    expect(fileBasename('/internal/docs/plans/fw-69-screen-lock.md')).toBe('fw-69-screen-lock.md');
    expect(fileBasename('C:\\docs\\notes.md')).toBe('notes.md');
    expect(fileBasename('README.md')).toBe('README.md');
  });
});

describe('filterMarkdownList', () => {
  it('returns every path when the query is empty or whitespace', () => {
    expect(filterMarkdownList(PATHS, '', {})).toEqual(PATHS);
    expect(filterMarkdownList(PATHS, '   ', {})).toEqual(PATHS);
  });

  it('filters by filename or full path, case-insensitively', () => {
    expect(filterMarkdownList(PATHS, 'SCREEN-LOCK', {})).toEqual([PATHS[0]]);
    expect(filterMarkdownList(PATHS, 'architecture', {})).toEqual([PATHS[2]]);
  });

  it('matches file body when contents are loaded', () => {
    const contents = {
      [PATHS[0]]: '# Screen lock\nIdle timeout after 5 minutes.',
      [PATHS[1]]: '# Tierwyn\nAgent command centre.',
      [PATHS[2]]: '# Scheduled jobs\nInterval and cron.',
    };
    expect(filterMarkdownList(PATHS, 'idle timeout', contents)).toEqual([PATHS[0]]);
    expect(filterMarkdownList(PATHS, 'command centre', contents)).toEqual([PATHS[1]]);
  });

  it('does not keep a path on content-only queries while that file is still loading', () => {
    expect(filterMarkdownList(PATHS, 'idle timeout', {})).toEqual([]);
  });

  it('still matches a path hit even when contents have not loaded', () => {
    expect(filterMarkdownList(PATHS, 'README', {})).toEqual([PATHS[1]]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterMarkdownList(PATHS, 'nonexistent-token', { [PATHS[0]]: 'hello' })).toEqual([]);
  });
});

describe('markdownPreview', () => {
  it('returns the first heading or prose line when there is no query', () => {
    expect(markdownPreview('# Screen lock\n\nIdle timeout after 5 minutes.', '')).toBe('Screen lock');
    expect(markdownPreview('Just a paragraph.', '')).toBe('Just a paragraph.');
    expect(markdownPreview('   \n\n', '')).toBeNull();
  });

  it('returns a snippet around the first case-insensitive content match', () => {
    const body = 'Alpha beta gamma idle timeout after five minutes omega';
    const snippet = markdownPreview(body, 'IDLE TIMEOUT');
    expect(snippet).toContain('idle timeout');
    expect(snippet!.toLowerCase()).toContain('idle timeout');
  });

  it('falls back to the opening line when the query is only a path hit', () => {
    expect(markdownPreview('# Notes\nBody text here.', 'README')).toBe('Notes');
  });
});
