import { describe, it, expect } from 'vitest';
import type { Conversation, FileBrowserEntry, Project } from '@tierwyn/shared';
import {
  breadcrumbs, defaultBrowserRoot, filterEntries, joinRel, parentRel, rootOptions,
} from './fileBrowser.js';

const proj = (id: string, name: string) => ({ id, name, rootPath: `/p/${id}` }) as Project;
const convo = (id: string, projectId: string, title: string) => ({ id, projectId, title }) as Conversation;
const ent = (name: string): FileBrowserEntry => ({ name, kind: 'file', size: 0, mtimeMs: 0 });

describe('path helpers', () => {
  it('joinRel', () => {
    expect(joinRel('', 'a')).toBe('a');
    expect(joinRel('a', 'b')).toBe('a/b');
  });
  it('parentRel', () => {
    expect(parentRel('a/b')).toBe('a');
    expect(parentRel('a')).toBe('');
    expect(parentRel('')).toBe('');
  });
  it('breadcrumbs', () => {
    expect(breadcrumbs('', 'Root')).toEqual([{ label: 'Root', path: '' }]);
    expect(breadcrumbs('a/b', 'Root')).toEqual([
      { label: 'Root', path: '' },
      { label: 'a', path: 'a' },
      { label: 'b', path: 'a/b' },
    ]);
  });
});

describe('filterEntries', () => {
  const list = [ent('README.md'), ent('src'), ent('readme.txt')];
  it('is case-insensitive', () => {
    expect(filterEntries(list, 'ReadMe').map((e) => e.name)).toEqual(['README.md', 'readme.txt']);
  });
  it('returns all for an empty query', () => {
    expect(filterEntries(list, '')).toEqual(list);
    expect(filterEntries(list, '  ')).toEqual(list);
  });
});

describe('defaultBrowserRoot', () => {
  const projects = [proj('p1', 'One'), proj('p2', 'Two')];
  it('uses the selected conversation', () => {
    expect(defaultBrowserRoot(convo('c1', 'p2', 'Chat'), projects[1], projects)).toEqual({
      key: 'c:c1', label: 'Conversation: Chat', conversationId: 'c1', projectId: 'p2',
    });
  });
  it('uses the selected project', () => {
    expect(defaultBrowserRoot(null, projects[1], projects)).toEqual({
      key: 'p:p2', label: 'Project: Two', projectId: 'p2',
    });
  });
  it('falls back to the first project', () => {
    expect(defaultBrowserRoot(null, null, projects)?.key).toBe('p:p1');
  });
  it('returns null with nothing at all', () => {
    expect(defaultBrowserRoot(null, null, [])).toBeNull();
  });
});

describe('rootOptions', () => {
  it('puts the conversation first, then projects, with unique keys', () => {
    const opts = rootOptions(convo('c1', 'p1', 'Chat'), [proj('p1', 'One'), proj('p2', 'Two')]);
    expect(opts.map((o) => o.key)).toEqual(['c:c1', 'p:p1', 'p:p2']);
    expect(new Set(opts.map((o) => o.key)).size).toBe(opts.length);
  });
  it('omits the conversation when none is selected', () => {
    expect(rootOptions(null, [proj('p1', 'One')]).map((o) => o.label)).toEqual(['Project: One']);
  });
});
