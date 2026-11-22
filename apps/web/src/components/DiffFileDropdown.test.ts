import { describe, it, expect } from 'vitest';
import { filterDiffFiles } from './DiffFileDropdown.js';
import type { ParsedDiffFile } from '../diffParser.js';

const mockFiles: ParsedDiffFile[] = [
  {
    id: 'f-1',
    filePath: 'apps/server/src/adapters/deepseek/index.ts',
    displayDir: 'apps/server/src/adapters/deepseek/',
    displayName: 'index.ts',
    chipLabel: 'deepseek/index.ts',
    status: 'modified',
    additions: 53,
    deletions: 1,
    binary: false,
    lines: [],
  },
  {
    id: 'f-2',
    filePath: 'apps/server/src/index.ts',
    displayDir: 'apps/server/src/',
    displayName: 'index.ts',
    chipLabel: 'src/index.ts',
    status: 'modified',
    additions: 7,
    deletions: 1,
    binary: false,
    lines: [],
  },
  {
    id: 'f-3',
    filePath: 'packages/shared/src/domain.ts',
    displayDir: 'packages/shared/src/',
    displayName: 'domain.ts',
    chipLabel: 'domain.ts',
    status: 'modified',
    additions: 3,
    deletions: 0,
    binary: false,
    lines: [],
  },
  {
    id: 'f-4',
    filePath: 'apps/web/src/components/UsagePanel.tsx',
    displayDir: 'apps/web/src/components/',
    displayName: 'UsagePanel.tsx',
    chipLabel: 'UsagePanel.tsx',
    status: 'modified',
    additions: 18,
    deletions: 0,
    binary: false,
    lines: [],
  },
];

describe('DiffFileDropdown filterDiffFiles', () => {
  it('returns all files when query is empty or whitespace', () => {
    expect(filterDiffFiles(mockFiles, '')).toHaveLength(4);
    expect(filterDiffFiles(mockFiles, '   ')).toHaveLength(4);
  });

  it('filters by directory path case-insensitively', () => {
    const deepseek = filterDiffFiles(mockFiles, 'deepseek');
    expect(deepseek).toHaveLength(1);
    expect(deepseek[0].id).toBe('f-1');

    const server = filterDiffFiles(mockFiles, 'SERVER');
    expect(server).toHaveLength(2);
  });

  it('filters by basename case-insensitively', () => {
    const indexFiles = filterDiffFiles(mockFiles, 'index');
    expect(indexFiles).toHaveLength(2);

    const usage = filterDiffFiles(mockFiles, 'usagepanel');
    expect(usage).toHaveLength(1);
    expect(usage[0].id).toBe('f-4');
  });

  it('filters by extension', () => {
    const tsxFiles = filterDiffFiles(mockFiles, '.tsx');
    expect(tsxFiles).toHaveLength(1);
    expect(tsxFiles[0].displayName).toBe('UsagePanel.tsx');
  });

  it('returns empty array when no files match', () => {
    expect(filterDiffFiles(mockFiles, 'nonexistent')).toHaveLength(0);
  });
});
