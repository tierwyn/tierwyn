import { describe, it, expect } from 'vitest';
import { isDefaultBranchName } from './gitWorkingTree.js';

describe('isDefaultBranchName', () => {
  it('returns true for main and master when not detached', () => {
    expect(isDefaultBranchName('main', false)).toBe(true);
    expect(isDefaultBranchName('master', false)).toBe(true);
  });

  it('returns false for feature branches', () => {
    expect(isDefaultBranchName('tierwyn/spawn-abcd', false)).toBe(false);
  });

  it('returns false when detached even on main', () => {
    expect(isDefaultBranchName('main', true)).toBe(false);
  });

  it('returns false for HEAD abbrev', () => {
    expect(isDefaultBranchName('HEAD', false)).toBe(false);
  });
});
