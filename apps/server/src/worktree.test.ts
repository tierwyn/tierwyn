import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isGitRepo, createWorktree } from './worktree.js';

let root: string;
const createdWorktreePaths: string[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tierwyn-wt-')); });
afterEach(() => {
  for (const p of createdWorktreePaths.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
});

describe('worktree', () => {
  it('isGitRepo false for a plain dir, true after git init+commit', () => {
    expect(isGitRepo(root)).toBe(false);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'f.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    expect(isGitRepo(root)).toBe(true);
  });

  it('createWorktree makes a new working dir + branch', () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'f.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    const wt = createWorktree(root, 'abc12345');
    createdWorktreePaths.push(wt.path);
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.branch).toContain('abc12345');
    const branches = execFileSync('git', ['worktree', 'list'], { cwd: root }).toString();
    expect(branches).toContain(wt.path);
  });
});
