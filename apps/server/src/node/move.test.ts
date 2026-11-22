import { describe, it, expect, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fsMove } from './move.js';

const homes: string[] = [];
function tmp(prefix = 'tierwyn-move-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  homes.push(d);
  return d;
}

afterAll(() => {
  for (const h of homes) {
    try { chmodSync(h, 0o700); } catch { /* ignore */ }
    try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('fsMove', () => {
  it('happy: moves a directory and contents when target parent exists', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);
    writeFileSync(join(from, 'x'), 'hello');

    const toParent = join(root, 'new');
    mkdirSync(toParent);
    const to = join(toParent, 'b');

    const res = fsMove([root], { from, to });
    expect(res.moved).toBe(true);
    expect(res.path).toBe(resolve(to));
    expect(existsSync(join(to, 'x'))).toBe(true);
    expect(readFileSync(join(to, 'x'), 'utf8')).toBe('hello');
    expect(existsSync(from)).toBe(false);
  });

  it('dryRun: reports would-be target path without moving', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);
    writeFileSync(join(from, 'x'), 'hello');

    const to = join(root, 'b');
    const res = fsMove([root], { from, to, dryRun: true });
    expect(res.moved).toBe(false);
    expect(res.path).toBe(resolve(to));
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
  });

  it('moves into an empty target directory (atomically replaced)', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);
    writeFileSync(join(from, 'x'), 'hello');

    const to = join(root, 'b');
    mkdirSync(to);

    const res = fsMove([root], { from, to });
    expect(res.moved).toBe(true);
    expect(existsSync(join(to, 'x'))).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it('rejects with exists if target directory is non-empty', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);
    writeFileSync(join(from, 'x'), 'hello');

    const to = join(root, 'b');
    mkdirSync(to);
    writeFileSync(join(to, 'existing'), 'occupied');

    expect(() => fsMove([root], { from, to }))
      .toThrowError(expect.objectContaining({ code: 'exists' }));
    expect(existsSync(from)).toBe(true);
  });

  it('rejects with exists if target is a file', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);

    const to = join(root, 'file.txt');
    writeFileSync(to, 'data');

    expect(() => fsMove([root], { from, to }))
      .toThrowError(expect.objectContaining({ code: 'exists' }));
  });

  it('Q1: creates missing parent chain inside roots and completes move', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);
    writeFileSync(join(from, 'file.txt'), 'content');

    const to = join(root, 'deep', 'parent', 'chain', 'target');
    const res = fsMove([root], { from, to });
    expect(res.moved).toBe(true);
    expect(existsSync(join(to, 'file.txt'))).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it('rejects with path_outside_roots if target parent ancestor is outside roots', () => {
    const root = tmp();
    const outside = tmp();
    const from = join(root, 'a');
    mkdirSync(from);

    const to = join(outside, 'nested', 'target');
    expect(() => fsMove([root], { from, to }))
      .toThrowError(expect.objectContaining({ code: 'path_outside_roots' }));
  });

  it('rejects with not_found if source does not exist', () => {
    const root = tmp();
    const from = join(root, 'nonexistent');
    const to = join(root, 'b');

    expect(() => fsMove([root], { from, to }))
      .toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('rejects with not_dir if source is a file', () => {
    const root = tmp();
    const from = join(root, 'file.txt');
    writeFileSync(from, 'hello');
    const to = join(root, 'b');

    expect(() => fsMove([root], { from, to }))
      .toThrowError(expect.objectContaining({ code: 'not_dir' }));
  });

  it('rejects with source_symlink if source is a symlink', () => {
    const root = tmp();
    const realDir = join(root, 'real');
    mkdirSync(realDir);
    const from = join(root, 'link');
    symlinkSync(realDir, from);
    const to = join(root, 'b');

    expect(() => fsMove([root], { from, to }))
      .toThrowError(expect.objectContaining({ code: 'source_symlink' }));
  });

  it('rejects with path_outside_roots if source is outside roots', () => {
    const root = tmp();
    const outside = tmp();
    const from = join(outside, 'a');
    mkdirSync(from);
    const to = join(root, 'b');

    expect(() => fsMove([root], { from, to }))
      .toThrowError(expect.objectContaining({ code: 'path_outside_roots' }));
  });

  it('rejects with source_is_root if source equals the root directory', () => {
    const root = tmp();
    const to = join(root, 'b');

    expect(() => fsMove([root], { from: root, to }))
      .toThrowError(expect.objectContaining({ code: 'source_is_root' }));
  });

  it('rejects with into_self if to is inside from', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);
    const to = join(from, 'nested');

    expect(() => fsMove([root], { from, to }))
      .toThrowError(expect.objectContaining({ code: 'into_self' }));
  });

  it('rejects with same_path if to === from', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);

    expect(() => fsMove([root], { from, to: from }))
      .toThrowError(expect.objectContaining({ code: 'same_path' }));
  });

  it('rejects with bad_path if to or from are relative or contain .. or .git', () => {
    const root = tmp();
    const from = join(root, 'a');
    mkdirSync(from);

    expect(() => fsMove([root], { from: 'relative/a', to: join(root, 'b') }))
      .toThrowError(expect.objectContaining({ code: 'bad_path' }));
    expect(() => fsMove([root], { from, to: 'relative/b' }))
      .toThrowError(expect.objectContaining({ code: 'bad_path' }));
    expect(() => fsMove([root], { from, to: `${root}/x/../y` }))
      .toThrowError(expect.objectContaining({ code: 'bad_path' }));
    expect(() => fsMove([root], { from, to: join(root, '.git') }))
      .toThrowError(expect.objectContaining({ code: 'bad_path' }));
    expect(() => fsMove([root], { from, to: join(root, 'a', '.git', 'b') }))
      .toThrowError(expect.objectContaining({ code: 'bad_path' }));
  });

  it('git: repairs sibling worktree links when git repo is moved', () => {
    const root = tmp();
    const from = join(root, 'repo');
    mkdirSync(from);
    execFileSync('git', ['init'], { cwd: from });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: from });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: from });
    writeFileSync(join(from, 'file.txt'), 'init');
    execFileSync('git', ['add', '.'], { cwd: from });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: from });

    const wt = join(root, 'repo-spawn-1');
    execFileSync('git', ['worktree', 'add', wt, '-b', 'branch-wt'], { cwd: from });
    expect(existsSync(wt)).toBe(true);

    const to = join(root, 'new-repo');
    const res = fsMove([root], { from, to });
    expect(res.moved).toBe(true);
    expect(res.repairError).toBeUndefined();

    // Verify git status in the worktree succeeds
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' });
    expect(status).toBeDefined();
  });

  it('git missing: sets repairError when git command fails or is missing', () => {
    const root = tmp();
    const from = join(root, 'repo');
    mkdirSync(from);
    execFileSync('git', ['init'], { cwd: from });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: from });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: from });
    writeFileSync(join(from, 'file.txt'), 'init');
    execFileSync('git', ['add', '.'], { cwd: from });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: from });

    const wt = join(root, 'repo-spawn-1');
    execFileSync('git', ['worktree', 'add', wt, '-b', 'branch-wt'], { cwd: from });

    const to = join(root, 'new-repo');
    const res = fsMove([root], { from, to }, { git: '/nonexistent-git' });
    expect(res.moved).toBe(true);
    expect(res.repairError).toBeDefined();
  });
});
