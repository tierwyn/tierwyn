import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCall, hardenGitEnv } from './gitCall.js';

describe('gitCall', () => {
  let root: string;
  let repo: string;
  let outside: string;
  let headSha: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tierwyn-gitcall-root-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'orig\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    outside = mkdtempSync(join(tmpdir(), 'tierwyn-gitcall-out-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const call = (method: string, args?: unknown[], cwd = repo) => gitCall([root], { method, cwd, args });

  it('rejects unknown methods', async () => {
    await expect(call('notAMethod', [])).rejects.toMatchObject({ code: 'method_not_allowed' });
  });

  describe('worktree methods', () => {
    it('addOperatorWorktree creates sibling under roots', async () => {
      const r = await gitCall([root], { method: 'addOperatorWorktree', cwd: repo, args: ['wt-feat', { newBranch: true }] });
      expect(r).toEqual({
        ok: true,
        r: { cwd: realpathSync(join(root, 'repo-wt-feat')), branch: 'wt-feat' },
      });
      expect(existsSync(join(root, 'repo-wt-feat', 'a.txt'))).toBe(true);
    });

    it('addOperatorWorktree refuses parent outside roots', async () => {
      const r = await gitCall([repo], { method: 'addOperatorWorktree', cwd: repo, args: ['wt-esc', { newBranch: true }] });
      expect(r).toEqual({ ok: false, kind: 'error', message: 'worktree_outside_roots' });
      expect(existsSync(join(root, 'repo-wt-esc'))).toBe(false);
    });

    it('createSpawnWorktree creates sibling under roots and rejects bad id or parent outside roots', async () => {
      expect(await gitCall([root], { method: 'createSpawnWorktree', cwd: repo, args: ['../bad'] }))
        .toEqual({ ok: false, kind: 'error', message: 'invalid conversationId' });
      expect(await gitCall([repo], { method: 'createSpawnWorktree', cwd: repo, args: ['12345678-abcd'] }))
        .toEqual({ ok: false, kind: 'error', message: 'worktree_outside_roots' });
      const r = await gitCall([root], { method: 'createSpawnWorktree', cwd: repo, args: ['12345678-abcd'] });
      expect(r).toEqual({
        ok: true,
        r: { path: realpathSync(join(root, 'repo-spawn-12345678')), branch: 'tierwyn/spawn-12345678' },
      });
      expect(existsSync(join(root, 'repo-spawn-12345678', 'a.txt'))).toBe(true);
    });
  });
  it('stagePath + commitStaged round-trip; returns short sha', async () => {
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    expect(await call('stagePath', ['a.txt'])).toEqual({ ok: true, r: undefined });
    const r = await call('commitStaged', ['msg']);
    expect(r).toMatchObject({ ok: true });
    expect((r as { r: string }).r).toMatch(/^[0-9a-f]{7,}$/);
  });
  it('pathspec guards: ../, .git/, absolute → kind:error, nothing staged', async () => {
    for (const p of ['../x', '.git/config', join(repo, 'a.txt')]) {
      expect(await call('stagePath', [p])).toMatchObject({ ok: false, kind: 'error' });
    }
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' })).toBe('');
  });
  it('branch guards: --orphan, bad baseRef, -remote rejected', async () => {
    expect(await call('switchBranch', ['--orphan'])).toMatchObject({ ok: false, kind: 'error' });
    expect(await call('createBranch', ['ok', '--upload-pack=x'])).toMatchObject({ ok: false, kind: 'error', message: 'invalid ref' });
    expect(await call('pushRemote', ['--mirror'])).toMatchObject({ ok: false, kind: 'error', message: 'invalid remote' });
  });
  it('commitStaged rejects empty / non-string / >64KiB message', async () => {
    for (const msg of ['', '  ', 5, 'x'.repeat(65537)]) {
      expect(await call('commitStaged', [msg])).toEqual({ ok: false, kind: 'error', message: 'invalid message' });
    }
  });
  it('createBranch + switchBranch succeed; branch not found → kind:error', async () => {
    expect(await call('createBranch', ['feat'])).toEqual({ ok: true, r: 'feat' });
    expect(await call('switchBranch', ['main'])).toEqual({ ok: true, r: 'main' });
    expect(await call('switchBranch', ['nope'])).toEqual({ ok: false, kind: 'error', message: 'branch not found' });
  });
  it('stashPush/stashPop round-trip', async () => {
    writeFileSync(join(repo, 'a.txt'), 'stashed\n');
    expect(await call('stashPush', ['m'])).toEqual({ ok: true, r: undefined });
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('orig\n');
    expect(await call('stashPop', [])).toEqual({ ok: true, r: undefined });
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('stashed\n');
  });
  it('restoreFileToHead jails: outside roots / .git / secret path rejected', async () => {
    writeFileSync(join(outside, 'f'), 'x');
    writeFileSync(join(repo, '.env'), 'X=1');
    await expect(call('restoreFileToHead', [join(outside, 'f')])).rejects.toMatchObject({ code: 'path_outside_roots' });
    await expect(call('restoreFileToHead', ['.git/config'])).rejects.toMatchObject({ code: 'path_not_allowed' });
    await expect(call('restoreFileToHead', ['.env'])).rejects.toMatchObject({ code: 'path_not_allowed' });
  });
  it('cwd must be absolute and must not be inside .git', async () => {
    await expect(call('readWorkingTree', [], 'repo')).rejects.toMatchObject({ code: 'bad_path' });
    await expect(call('readWorkingTree', [], join(repo, '.git'))).rejects.toMatchObject({ code: 'path_not_allowed' });
  });
  it('hardenGitEnv sets GIT_TERMINAL_PROMPT=0 and never overrides', () => {
    const e: NodeJS.ProcessEnv = { HOME: outside };
    hardenGitEnv(e);
    expect(e.GIT_TERMINAL_PROMPT).toBe('0');
    expect(e.GIT_SSH_COMMAND).toBeUndefined();
    const keep: NodeJS.ProcessEnv = { HOME: outside, GIT_TERMINAL_PROMPT: '1', GIT_SSH_COMMAND: 'ssh -i k' };
    hardenGitEnv(keep);
    expect(keep).toMatchObject({ GIT_TERMINAL_PROMPT: '1', GIT_SSH_COMMAND: 'ssh -i k' });
  });
  it('I2: restoreFileToHead preserves symlink target when restoring tracked symlink', async () => {
    const targetFile = join(repo, 'target.txt');
    writeFileSync(targetFile, 'target content\n');
    const linkPath = join(repo, 'link.txt');
    symlinkSync('target.txt', linkPath);
    execFileSync('git', ['add', 'link.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add link'], { cwd: repo });

    const untrackedTarget = join(repo, 'untracked.txt');
    writeFileSync(untrackedTarget, 'untracked content\n');
    rmSync(linkPath);
    symlinkSync('untracked.txt', linkPath);

    const r = await call('restoreFileToHead', ['link.txt']);
    expect(r).toEqual({ ok: true, r: { action: 'restored', path: linkPath } });
    expect(readFileSync(untrackedTarget, 'utf8')).toBe('untracked content\n');
  });
  it('I2: restoreFileToHead unlinks untracked symlink without modifying tracked target', async () => {
    const trackedFile = join(repo, 'a.txt');
    const untrackedLink = join(repo, 'untracked-link.txt');
    symlinkSync('a.txt', untrackedLink);

    const r = await call('restoreFileToHead', ['untracked-link.txt']);
    expect(r).toEqual({ ok: true, r: { action: 'deleted', path: untrackedLink } });
    expect(readFileSync(trackedFile, 'utf8')).toBe('orig\n');
  });
  it('rejects cwd outside roots, incl. symlink escape', async () => {
    await expect(gitCall([root], { method: 'readWorkingTree', cwd: outside })).rejects.toMatchObject({ code: 'path_outside_roots' });
    symlinkSync(outside, join(root, 'esc'));
    await expect(gitCall([root], { method: 'readWorkingTree', cwd: join(root, 'esc') })).rejects.toMatchObject({ code: 'path_outside_roots' });
  });
  it('runs a read method and returns its JSON', async () => {
    const r = await gitCall([root], { method: 'readWorkingTree', cwd: repo });
    expect(r).toMatchObject({ ok: true, r: { isRepo: true, branch: 'main' } });
  });
  it('re-runs guards: bad sha and ../ pathspec come back as kind:error with module text', async () => {
    expect(await gitCall([root], { method: 'commitDetail', cwd: repo, args: ['HEAD@{1}'] }))
      .toEqual({ ok: false, kind: 'error', message: 'invalid sha' });
    const r = await gitCall([root], { method: 'commitFileContent', cwd: repo, args: [headSha, '../outside/x'] });
    expect(r).toMatchObject({ ok: false, kind: 'error' });
    expect((r as { message: string }).message).toMatch(/pathspec/);
  });
  it('listCommits drops unknown opts keys', async () => {
    const r = await gitCall([root], { method: 'listCommits', cwd: repo, args: [{ limit: 1, evil: '--exec' }] });
    expect(r).toMatchObject({ ok: true, r: { commits: [expect.any(Object)] } });
  });
  it('GitCommandError → kind:git with stderr and exitCode', async () => {
    const r = await gitCall([root], { method: 'commitDetail', cwd: repo, args: ['deadbeef'] });
    expect(r).toMatchObject({ ok: false, kind: 'git', exitCode: 128 });
    expect((r as { stderr: string }).stderr).toMatch(/bad object|unknown revision/);
  });
  it('fileHeadDiff refuses secret and .git paths', async () => {
    writeFileSync(join(repo, '.env'), 'X=1');
    await expect(gitCall([root], { method: 'fileHeadDiff', cwd: repo, args: ['.env'] })).rejects.toMatchObject({ code: 'path_not_allowed' });
    await expect(gitCall([root], { method: 'fileHeadDiff', cwd: repo, args: ['.git/config'] })).rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  describe('shadow checkpoint methods', () => {
    const conv = 'conv-1';
    const cp = 'cp-1';

    it('snapshotCode creates refs/tierwyn/checkpoints/<conv>/<cp> and returns the commit', async () => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      const r = await gitCall([root], { method: 'snapshotCode', cwd: repo, args: [conv, cp] });
      expect(r).toMatchObject({ ok: true });
      const sha = (r as { r: string }).r;
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const resolved = execFileSync('git', ['rev-parse', `refs/tierwyn/checkpoints/${conv}/${cp}`], { cwd: repo, encoding: 'utf8' }).trim();
      expect(resolved).toBe(sha);
    });

    it('snapshotCode skips no-op trees (null codeRef)', async () => {
      const r = await gitCall([root], { method: 'snapshotCode', cwd: repo, args: [conv, cp] });
      expect(r).toEqual({ ok: true, r: null });
    });

    it('codeDiff restore mode shows working-tree drift vs the snapshot', async () => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      const snap = await gitCall([root], { method: 'snapshotCode', cwd: repo, args: [conv, cp] });
      const sha = (snap as { r: string }).r as string;
      writeFileSync(join(repo, 'a.txt'), 'drifted\n');
      const r = await gitCall([root], { method: 'codeDiff', cwd: repo, args: [sha] });
      expect(r).toMatchObject({ ok: true });
      expect((r as { r: string }).r).toContain('drifted');
    });

    it('codeDiff captured mode shows the snapshot vs its parent', async () => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      const snap = await gitCall([root], { method: 'snapshotCode', cwd: repo, args: [conv, cp] });
      const sha = (snap as { r: string }).r as string;
      const r = await gitCall([root], { method: 'codeDiff', cwd: repo, args: [sha, 'captured'] });
      expect(r).toMatchObject({ ok: true });
      expect((r as { r: string }).r).toContain('changed');
    });

    it('restoreCode worktree mode resets tracked files and drops untracked', async () => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      const snap = await gitCall([root], { method: 'snapshotCode', cwd: repo, args: [conv, cp] });
      const sha = (snap as { r: string }).r as string;
      writeFileSync(join(repo, 'a.txt'), 'drifted\n');
      writeFileSync(join(repo, 'b.txt'), 'untracked\n');
      const r = await gitCall([root], { method: 'restoreCode', cwd: repo, args: [sha, 'worktree'] });
      expect(r).toEqual({ ok: true, r: undefined });
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('changed\n');
      expect(() => readFileSync(join(repo, 'b.txt'))).toThrow();
    });

    it('restoreCode bad mode → kind:error, no git spawned (tree untouched)', async () => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      const r = await gitCall([root], { method: 'restoreCode', cwd: repo, args: [headSha, 'bogus'] });
      expect(r).toMatchObject({ ok: false, kind: 'error' });
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('changed\n');
    });

    it('snapshotCode rejects bad conversation ids', async () => {
      await expect(gitCall([root], { method: 'snapshotCode', cwd: repo, args: ['../x', cp] })).rejects.toMatchObject({ code: 'bad_name' });
      await expect(gitCall([root], { method: 'deleteShadowRef', cwd: repo, args: ['a/b', cp] })).rejects.toMatchObject({ code: 'bad_name' });
    });

    it('resolveShadowRef / isWorkingTreeClean / currentHead / isGitRepo round-trip', async () => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      const snap = await gitCall([root], { method: 'snapshotCode', cwd: repo, args: [conv, cp] });
      const sha = (snap as { r: string }).r as string;
      expect(await gitCall([root], { method: 'resolveShadowRef', cwd: repo, args: [conv, cp] })).toEqual({ ok: true, r: sha });
      expect(await gitCall([root], { method: 'isWorkingTreeClean', cwd: repo, args: [] })).toEqual({ ok: true, r: false });
      expect(await gitCall([root], { method: 'currentHead', cwd: repo, args: [] })).toEqual({ ok: true, r: headSha });
      expect(await gitCall([root], { method: 'isGitRepo', cwd: repo, args: [] })).toEqual({ ok: true, r: true });
      expect(await gitCall([root], { method: 'isGitRepo', cwd: root, args: [] })).toEqual({ ok: true, r: false });
    });

    it('deleteShadowRef removes the ref from both namespaces', async () => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      await gitCall([root], { method: 'snapshotCode', cwd: repo, args: [conv, cp] });
      expect(await gitCall([root], { method: 'deleteShadowRef', cwd: repo, args: [conv, cp] })).toEqual({ ok: true, r: undefined });
      expect(await gitCall([root], { method: 'resolveShadowRef', cwd: repo, args: [conv, cp] })).toEqual({ ok: true, r: null });
    });
  });
});
