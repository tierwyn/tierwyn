import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, unlinkSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  gitExec, GitCommandError, parsePorcelainStatus, groupXy, validatePathspec,
  readWorkingTree, stagePath, unstagePath, commitStaged, countFileLines, deleteUntrackedPath,
  stagedDiff, stagedDiffStat, recentSubjects, listNestedGitRepos,
  discardWorktreePath, assertSha, parseCommitLog, parseNameStatusZ, parseNumstatZ,
  headRef, refExists, fileHeadDiff, restoreFileToHead,
} from './workingTree.js';

describe('parsePorcelainStatus', () => {
  it('parses unstaged modified', () => {
    const { files } = parsePorcelainStatus('## main\0 M src/a.ts\0');
    expect(files).toEqual([{ x: ' ', y: 'M', path: 'src/a.ts' }]);
  });

  it('parses staged modified', () => {
    const { files } = parsePorcelainStatus('M  src/a.ts\0');
    expect(files).toEqual([{ x: 'M', y: ' ', path: 'src/a.ts' }]);
  });

  it('parses both groups for MM', () => {
    const { staged, unstaged } = groupXy(
      parsePorcelainStatus('MM src/a.ts\0').files,
      '/repo',
    );
    expect(staged.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(unstaged.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('parses untracked new', () => {
    const { unstaged, staged } = groupXy(
      parsePorcelainStatus('?? new.txt\0').files,
      '/repo',
    );
    expect(unstaged).toHaveLength(1);
    expect(unstaged[0].status).toBe('new');
    expect(staged).toHaveLength(0);
  });

  it('parses staged deleted', () => {
    const { staged } = groupXy(parsePorcelainStatus('D  gone.ts\0').files, '/repo');
    expect(staged[0].status).toBe('deleted');
  });

  it('parses unstaged deleted', () => {
    const { unstaged } = groupXy(parsePorcelainStatus(' D gone.ts\0').files, '/repo');
    expect(unstaged[0].status).toBe('deleted');
  });

  it('parses rename with orig path (RM)', () => {
    const { files } = parsePorcelainStatus('RM new.txt\0old.txt\0');
    expect(files[0]).toEqual({ x: 'R', y: 'M', path: 'new.txt', origPath: 'old.txt' });
    const { staged, unstaged } = groupXy(files, '/repo');
    expect(staged[0].status).toBe('renamed');
    expect(unstaged[0].status).toBe('modified');
  });

  it('detects conflicts (UU)', () => {
    const { unstaged, hasConflicts } = groupXy(
      parsePorcelainStatus('UU conflict.ts\0').files,
      '/repo',
    );
    expect(hasConflicts).toBe(true);
    expect(unstaged[0].status).toBe('conflicted');
  });

  it('returns empty for empty string', () => {
    const { files, branchHeader } = parsePorcelainStatus('');
    expect(files).toEqual([]);
    expect(branchHeader).toBeNull();
  });

  it('captures branch header', () => {
    const { branchHeader } = parsePorcelainStatus('## HEAD (no branch)\0');
    expect(branchHeader).toBe('## HEAD (no branch)');
  });
});

describe('validatePathspec', () => {
  let tree: string;

  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'tierwyn-wt-pathspec-'));
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, 'src', 'a.ts'), 'x');
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  it('accepts src/a.ts', async () => {
    await expect(validatePathspec(tree, 'src/a.ts')).resolves.toBe('src/a.ts');
  });

  it('rejects ../escape.ts', async () => {
    await expect(validatePathspec(tree, '../escape.ts')).rejects.toThrow();
  });

  it('rejects absolute paths outside tree', async () => {
    await expect(validatePathspec(tree, '/etc/passwd')).rejects.toThrow('absolute');
  });

  it('rejects .git/HEAD', async () => {
    await expect(validatePathspec(tree, '.git/HEAD')).rejects.toThrow();
  });

  it('rejects foo/.git/config', async () => {
    await expect(validatePathspec(tree, 'foo/.git/config')).rejects.toThrow();
  });

  it('rejects absolute path inside tree', async () => {
    await expect(validatePathspec(tree, join(tree, 'src', 'a.ts'))).rejects.toThrow('absolute');
  });

  it('rejects symlink escape', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'tierwyn-wt-outside-'));
    try {
      const link = join(tree, 'escape');
      symlinkSync(outside, link);
      await expect(validatePathspec(tree, 'escape')).rejects.toThrow('escapes tree via symlink');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts in-tree symlink to directory and returns the link path', async () => {
    mkdirSync(join(tree, 'real-skill'), { recursive: true });
    writeFileSync(join(tree, 'real-skill', 'SKILL.md'), 'x');
    symlinkSync(join(tree, 'real-skill'), join(tree, 'skill-link'));
    await expect(validatePathspec(tree, 'skill-link')).resolves.toBe('skill-link');
  });

  it('rejects directory pathspec', async () => {
    await expect(validatePathspec(tree, 'src')).rejects.toThrow('directory pathspec rejected');
  });

  it('rejects . pathspec', async () => {
    await expect(validatePathspec(tree, '.')).rejects.toThrow('directory pathspec rejected');
  });

  it('accepts non-existent path under symlink lexically only', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'tierwyn-wt-outside-'));
    try {
      const link = join(tree, 'escape');
      symlinkSync(outside, link);
      await expect(validatePathspec(tree, 'escape/newfile')).resolves.toBe('escape/newfile');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('literal pathspec in stage/unstage', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tierwyn-wt-literal-'));
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'base.txt'), 'base');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.txt'), 'a');
    execFileSync('git', ['add', 'base.txt', 'src/a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function stagedPaths(): string[] {
    const raw = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' });
    return raw.trim() ? raw.trim().split('\n') : [];
  }

  it('rejects glob * without staging other files', () => {
    expect(() => stagePath(repo, '*')).toThrow(GitCommandError);
    expect(stagedPaths()).toEqual([]);
  });

  it('rejects magic :(top) without staging other files', () => {
    expect(() => stagePath(repo, ':(top)')).toThrow(GitCommandError);
    expect(stagedPaths()).toEqual([]);
  });

  it('rejects negation :!base.txt without staging other files', () => {
    expect(() => stagePath(repo, ':!base.txt')).toThrow(GitCommandError);
    expect(stagedPaths()).toEqual([]);
  });
});

describe('gitExec', () => {
  it('wraps failures in GitCommandError with stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-wt-nogit-'));
    try {
      expect(() => gitExec(dir, ['rev-parse', '--is-inside-work-tree'])).toThrow(GitCommandError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('git mutations on real repos', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tierwyn-wt-mut-'));
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'v1');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('stage/unstage roundtrip keeps file on disk', () => {
    writeFileSync(join(repo, 'new.txt'), 'hello');
    const before = readWorkingTree(repo);
    expect(before.unstaged.some((f) => f.path === 'new.txt')).toBe(true);
    stagePath(repo, 'new.txt');
    const staged = readWorkingTree(repo);
    expect(staged.staged.some((f) => f.path === 'new.txt')).toBe(true);
    unstagePath(repo, 'new.txt');
    const after = readWorkingTree(repo);
    expect(after.unstaged.some((f) => f.path === 'new.txt')).toBe(true);
    expect(existsSync(join(repo, 'new.txt'))).toBe(true);
  });

  it('stages an untracked symlink-to-directory as the link itself', async () => {
    const target = join(repo, 'skill-target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'x');
    symlinkSync(target, join(repo, 'skill-link'));
    const rel = await validatePathspec(repo, 'skill-link');
    expect(rel).toBe('skill-link');
    stagePath(repo, rel);
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' });
    expect(staged.trim()).toBe('skill-link');
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
  });

  it('deletes an untracked symlink without touching its target', async () => {
    const target = join(repo, 'skill-target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'x');
    symlinkSync(target, join(repo, 'skill-link'));
    await expect(deleteUntrackedPath(repo, 'skill-link')).resolves.toBeUndefined();
    expect(existsSync(join(repo, 'skill-link'))).toBe(false);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
  });

  it('still refuses to delete a real directory or tracked file', async () => {
    mkdirSync(join(repo, 'real-dir'));
    await expect(deleteUntrackedPath(repo, 'real-dir')).rejects.toThrow('cannot delete directory');
    await expect(deleteUntrackedPath(repo, 'tracked.txt')).rejects.toThrow('cannot delete tracked file');
    expect(existsSync(join(repo, 'real-dir'))).toBe(true);
    expect(existsSync(join(repo, 'tracked.txt'))).toBe(true);
  });

  it('readWorkingTree calculates addedLines and deletedLines for staged, unstaged, and untracked files', () => {
    // 1. Untracked file (status: 'new') with 3 lines
    writeFileSync(join(repo, 'untracked.txt'), 'line1\nline2\nline3\n');
    // 2. Modify existing tracked file (tracked.txt has 'v1' without newline)
    // Replacing it with 3 lines means deleting the old line and adding 3 lines.
    writeFileSync(join(repo, 'tracked.txt'), 'v1\nadded1\nadded2\n');
    // 3. Staged file with additions and deletions
    writeFileSync(join(repo, 'staged-file.txt'), 'alpha\nbeta\n');
    stagePath(repo, 'staged-file.txt');

    const wt = readWorkingTree(repo);

    const stagedItem = wt.staged.find((f) => f.path === 'staged-file.txt');
    expect(stagedItem).toBeDefined();
    expect(stagedItem?.addedLines).toBe(2);
    expect(stagedItem?.deletedLines).toBe(0);
    expect(stagedItem?.binary).toBe(false);

    const trackedUnstaged = wt.unstaged.find((f) => f.path === 'tracked.txt');
    expect(trackedUnstaged).toBeDefined();
    expect(trackedUnstaged?.addedLines).toBe(3);
    expect(trackedUnstaged?.deletedLines).toBe(1);
    expect(trackedUnstaged?.binary).toBe(false);

    const untrackedItem = wt.unstaged.find((f) => f.path === 'untracked.txt');
    expect(untrackedItem).toBeDefined();
    expect(untrackedItem?.addedLines).toBe(3);
    expect(untrackedItem?.deletedLines).toBe(0);
    expect(untrackedItem?.binary).toBe(false);
  });

  it('countFileLines accurately counts lines and identifies binary files', () => {
    const textFile = join(repo, 'count-test.txt');
    writeFileSync(textFile, 'a\nb\nc');
    expect(countFileLines(textFile)).toEqual({ added: 3, deleted: 0, binary: false });

    const emptyFile = join(repo, 'empty-test.txt');
    writeFileSync(emptyFile, '');
    expect(countFileLines(emptyFile)).toEqual({ added: 0, deleted: 0, binary: false });

    const binFile = join(repo, 'binary-test.bin');
    writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02]));
    expect(countFileLines(binFile)).toEqual({ binary: true });
  });

  it('commit staged-only leaves unstaged dirty', () => {
    writeFileSync(join(repo, 'staged.txt'), 's');
    writeFileSync(join(repo, 'unstaged.txt'), 'u');
    stagePath(repo, 'staged.txt');
    const sha = commitStaged(repo, 'only staged');
    expect(sha.length).toBeGreaterThan(0);
    const show = execFileSync('git', ['show', '--stat', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    expect(show).toContain('staged.txt');
    expect(show).not.toContain('unstaged.txt');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status).toContain('unstaged.txt');
  });

  it('returns isRepo false for non-git dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-wt-norepo-'));
    try {
      expect(readWorkingTree(dir).isRepo).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stagedDiff returns only staged hunks', () => {
    writeFileSync(join(repo, 'a.txt'), 'A');
    writeFileSync(join(repo, 'b.txt'), 'B');
    stagePath(repo, 'a.txt');
    const diff = stagedDiff(repo);
    expect(diff).toContain('a.txt');
    expect(diff).not.toContain('b.txt');
  });

  it('stagedDiff returns empty when nothing staged', () => {
    writeFileSync(join(repo, 'dirty.txt'), 'x');
    expect(stagedDiff(repo)).toBe('');
  });

  it('stagedDiffStat lists the staged file', () => {
    writeFileSync(join(repo, 'stat-me.txt'), 'hello');
    stagePath(repo, 'stat-me.txt');
    expect(stagedDiffStat(repo)).toContain('stat-me.txt');
  });

  it('recentSubjects returns newest-first and respects limit', () => {
    writeFileSync(join(repo, 'c1.txt'), '1');
    stagePath(repo, 'c1.txt');
    commitStaged(repo, 'first subject');
    writeFileSync(join(repo, 'c2.txt'), '2');
    stagePath(repo, 'c2.txt');
    commitStaged(repo, 'second subject');
    writeFileSync(join(repo, 'c3.txt'), '3');
    stagePath(repo, 'c3.txt');
    commitStaged(repo, 'third subject');
    expect(recentSubjects(repo, 2)).toEqual(['third subject', 'second subject']);
  });

  it('recentSubjects returns [] on a repo with no commits', () => {
    const empty = mkdtempSync(join(tmpdir(), 'tierwyn-wt-empty-'));
    try {
      execFileSync('git', ['init'], { cwd: empty });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: empty });
      execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: empty });
      expect(recentSubjects(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('listNestedGitRepos', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-nested-test-'));
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: root });
    writeFileSync(join(root, 'README.md'), '# root');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'root init'], { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('detects nested git repo at direct subfolder', () => {
    const internal = join(root, 'internal');
    mkdirSync(internal);
    execFileSync('git', ['init'], { cwd: internal });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: internal });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: internal });
    writeFileSync(join(internal, 'DOCS.md'), '# docs');
    execFileSync('git', ['add', 'DOCS.md'], { cwd: internal });
    execFileSync('git', ['commit', '-m', 'internal init'], { cwd: internal });

    const nested = listNestedGitRepos(root);
    expect(nested).toHaveLength(1);
    expect(nested[0].label).toBe('internal');
    expect(nested[0].cwd).toBe(internal);
  });

  it('detects nested git repo at depth 2', () => {
    const sub = join(root, 'packages', 'nested-repo');
    mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init'], { cwd: sub });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sub });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: sub });
    writeFileSync(join(sub, 'foo.txt'), 'bar');
    execFileSync('git', ['add', 'foo.txt'], { cwd: sub });
    execFileSync('git', ['commit', '-m', 'nested init'], { cwd: sub });

    const nested = listNestedGitRepos(root);
    expect(nested.some((n) => n.label === 'packages/nested-repo' && n.cwd === sub)).toBe(true);
  });

  it('ignores node_modules and .worktrees and dist', () => {
    const nodeModRepo = join(root, 'node_modules', 'some-pkg');
    mkdirSync(nodeModRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: nodeModRepo });

    const wtRepo = join(root, '.worktrees', 'wt-dir');
    mkdirSync(wtRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: wtRepo });

    const distRepo = join(root, 'dist', 'out');
    mkdirSync(distRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: distRepo });

    const nested = listNestedGitRepos(root);
    expect(nested).toHaveLength(0);
  });

  it('detects internal in project root if present', () => {
    const projectRoot = resolve(__dirname, '../../../..');
    const internalDir = join(projectRoot, 'internal');
    if (existsSync(join(internalDir, '.git'))) {
      const nested = listNestedGitRepos(projectRoot);
      expect(nested.some((n) => n.label === 'internal' && n.cwd === internalDir)).toBe(true);
    }
  });
});

describe('parseCommitLog', () => {
  const rec = (
    sha: string,
    short: string,
    subject: string,
    refs: string,
    at = '1700000000',
  ) => `${sha}\x1f${short}\x1ftest\x1ft@test.com\x1f${at}\x1f${subject}\x1f${refs}`;

  it('parses two records newest-first', () => {
    const raw = `${rec('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaa', 'second', 'HEAD -> main')}\x1e\n${rec('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'bbbbbbb', 'first', '')}\x1e\n`;
    const parsed = parseCommitLog(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaaaaaa',
      subject: 'second',
      refs: ['HEAD -> main'],
      timestamp: 1700000000 * 1000,
    });
    expect(parsed[1].subject).toBe('first');
    expect(parsed[1].refs).toEqual([]);
  });

  it('drops trailing separator and empty records', () => {
    const raw = `${rec('cccccccccccccccccccccccccccccccccccccccc', 'ccccccc', 'only', '')}\x1e\n`;
    expect(parseCommitLog(raw)).toHaveLength(1);
    expect(parseCommitLog('')).toEqual([]);
    expect(parseCommitLog('\x1e\n')).toEqual([]);
  });

  it('keeps a subject containing | and ,', () => {
    const raw = `${rec('dddddddddddddddddddddddddddddddddddddddd', 'ddddddd', 'feat: a, b | c', '')}\x1e`;
    expect(parseCommitLog(raw)[0].subject).toBe('feat: a, b | c');
  });

  it('splits %D decorations into trimmed refs', () => {
    const raw = `${rec('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'eeeeeee', 'tagged', 'HEAD -> main, tag: v1')}\x1e`;
    expect(parseCommitLog(raw)[0].refs).toEqual(['HEAD -> main', 'tag: v1']);
  });

  it('%D empty → refs: []', () => {
    const raw = `${rec('ffffffffffffffffffffffffffffffffffffffff', 'fffffff', 'plain', '')}\x1e`;
    expect(parseCommitLog(raw)[0].refs).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  it('maps M, A, D, R100, T', () => {
    const raw = [
      'M', 'src/a.ts',
      'A', 'new.txt',
      'D', 'gone.ts',
      'R100', 'old.txt', 'new-name.txt',
      'T', 'script.sh',
      '',
    ].join('\0');
    expect(parseNameStatusZ(raw)).toEqual([
      { status: 'modified', path: 'src/a.ts' },
      { status: 'new', path: 'new.txt' },
      { status: 'deleted', path: 'gone.ts' },
      { status: 'renamed', path: 'new-name.txt', origPath: 'old.txt' },
      { status: 'modified', path: 'script.sh' },
    ]);
  });

  it('does not treat combined-diff two-char codes starting with R as renames', () => {
    const raw = ['RM', 'file.txt', 'M', 'other.txt', ''].join('\0');
    expect(parseNameStatusZ(raw)).toEqual([
      { status: 'modified', path: 'file.txt' },
      { status: 'modified', path: 'other.txt' },
    ]);
  });
});

describe('parseNumstatZ', () => {
  it('parses normal counts', () => {
    expect(parseNumstatZ('12\t3\tsrc/a.ts\0')).toEqual([
      { path: 'src/a.ts', added: 12, deleted: 3, binary: false },
    ]);
  });

  it('treats -/- as binary with undefined counts', () => {
    expect(parseNumstatZ('-\t-\tblob.bin\0')).toEqual([
      { path: 'blob.bin', added: undefined, deleted: undefined, binary: true },
    ]);
  });

  it('parses a rename record', () => {
    expect(parseNumstatZ('0\t0\t\0old.txt\0new.txt\0')).toEqual([
      { path: 'new.txt', origPath: 'old.txt', added: 0, deleted: 0, binary: false },
    ]);
  });
});

describe('assertSha', () => {
  it('accepts 7-hex and 40-hex', () => {
    expect(assertSha('deadbee')).toBe('deadbee');
    expect(assertSha('0123456789abcdef0123456789abcdef01234567')).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
  });

  it('rejects revspecs, flags, and non-hex', () => {
    for (const bad of ['HEAD', 'HEAD@{1}', '--upload-pack=x', 'abc..def', '', 'deadbeefZ']) {
      expect(() => assertSha(bad)).toThrow('invalid sha');
    }
  });
});

describe('discardWorktreePath', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tierwyn-wt-discard-'));
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'committed');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('restores a modified tracked file and leaves status clean', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'dirty');
    discardWorktreePath(repo, 'tracked.txt');
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('committed');
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(porcelain).toBe('');
  });

  it('restores worktree to the index and preserves staged hunks', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v1');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'v2');
    discardWorktreePath(repo, 'tracked.txt');
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('v1');
    const wt = readWorkingTree(repo);
    expect(wt.staged.some((f) => f.path === 'tracked.txt')).toBe(true);
    expect(wt.unstaged.some((f) => f.path === 'tracked.txt')).toBe(false);
  });

  it('restores a tracked file deleted from the worktree', () => {
    unlinkSync(join(repo, 'tracked.txt'));
    discardWorktreePath(repo, 'tracked.txt');
    expect(existsSync(join(repo, 'tracked.txt'))).toBe(true);
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('committed');
  });

  it('throws on an untracked file', () => {
    writeFileSync(join(repo, 'fresh.txt'), 'nope');
    expect(() => discardWorktreePath(repo, 'fresh.txt')).toThrow('cannot discard untracked file');
    expect(existsSync(join(repo, 'fresh.txt'))).toBe(true);
  });
});

describe('headRef / refExists / fileHeadDiff', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tierwyn-wt-headref-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'orig\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('headRef reports branch, short sha and realpath toplevel', () => {
    const r = headRef(repo);
    expect(r.branch).toBe('main'); expect(r.detached).toBe(false);
    expect(r.headSha).toMatch(/^[0-9a-f]{7,}$/); expect(r.toplevel).toBe(realpathSync(repo));
  });
  it('headRef on a non-repo dir returns empty fields, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-'));
    try {
      expect(headRef(dir)).toEqual({ branch: '', detached: false, headSha: '', toplevel: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refExists true for HEAD, false for unknown, throws on bad ref', () => {
    expect(refExists(repo, 'HEAD')).toBe(true);
    expect(refExists(repo, 'nope-branch')).toBe(false);
    expect(() => refExists(repo, '--upload-pack=x')).toThrow('invalid ref');
  });
  it('fileHeadDiff: modified tracked file vs untouched', () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    expect(fileHeadDiff(join(repo, 'a.txt'))).toMatchObject({ modified: true, isTracked: true });
    expect(fileHeadDiff(join(repo, 'a.txt')).diff).toContain('+changed');
  });
});

describe('restoreFileToHead', () => {
  let repo: string;
  const initialA = 'orig\n';

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tierwyn-wt-restore-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), initialA);
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('restores a modified tracked file (staged + worktree) to HEAD', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    gitExec(repo, ['add', 'a.txt']);
    expect(await restoreFileToHead(join(repo, 'a.txt'))).toEqual({ action: 'restored', path: join(repo, 'a.txt') });
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(initialA);
    expect(gitExec(repo, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('deletes a file absent from HEAD', async () => {
    writeFileSync(join(repo, 'new.txt'), 'x');
    expect((await restoreFileToHead(join(repo, 'new.txt'))).action).toBe('deleted');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
  });

  it('throws outside a repo', async () => {
    const d = mkdtempSync(join(tmpdir(), 'nr-'));
    writeFileSync(join(d, 'f'), 'x');
    try {
      await expect(restoreFileToHead(join(d, 'f'))).rejects.toThrow('file is not in a git repository');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});


