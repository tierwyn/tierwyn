import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function src(rel: string): string {
  return readFileSync(resolve(__dirname, rel), 'utf8');
}

describe('project create and handoff skip wiring', () => {
  it('Sidebar no longer gates Clone from URL on newProjectHostId', () => {
    const sidebar = src('./components/Sidebar.tsx');
    expect(sidebar).not.toMatch(/cloneMode\s*=\s*Boolean\(newProjectHostId\)/);
    expect(sidebar).toContain("cloneMode = newProjectCloneUrl.trim() !== ''");
  });

  it('Sidebar renders FolderPickerModal and calls projectBrowseRoots', () => {
    const sidebar = src('./components/Sidebar.tsx');
    expect(sidebar).toContain('<FolderPickerModal');
    expect(sidebar).toContain('api.projectBrowseRoots');
  });

  it('api has createIfMissing parameter in createProject', () => {
    const api = src('./api.ts');
    expect(api).toContain('...(createIfMissing ? { createIfMissing: true } : {})');
  });

  it('App.tsx calls stagedHandoffSkip in both the fork and cross-profile branch', () => {
    const app = src('./App.tsx');
    const matches = app.match(/stagedHandoffSkip\(/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(2);
  });
});
