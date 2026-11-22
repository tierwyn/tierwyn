import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  gitSync, gitEnv, GitUnsafeConfigError,
} from './gitExec.js';
import { snapshotCode } from './shadowOps.js';
import { createWorktree } from '../worktree.js';

const dirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function initRepo(): string {
  const dir = tmp('tierwyn-gitexec-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], {
    cwd: dir, stdio: 'ignore',
  });
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('gitExec config scan', () => {
  it('refuses core.fsmonitor and does not run it', () => {
    const repo = initRepo();
    const marker = join(tmpdir(), `tierwyn-fsm-${randomUUID()}`);
    execFileSync('git', ['config', '--local', 'core.fsmonitor', `touch ${marker}`], { cwd: repo });
    expect(() => gitSync(repo, ['status'])).toThrow(GitUnsafeConfigError);
    expect(existsSync(marker)).toBe(false);
  });

  it('createWorktree does not fire a post-checkout hook', () => {
    const repo = initRepo();
    const marker = join(tmpdir(), `tierwyn-hook-${randomUUID()}`);
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    const { path } = createWorktree(repo, randomUUID());
    dirs.push(path);
    expect(existsSync(marker)).toBe(false);
  });

  it('snapshotCode returns null for an evil filter and does not run it', () => {
    const repo = initRepo();
    const marker = join(tmpdir(), `tierwyn-filt-${randomUUID()}`);
    execFileSync('git', ['config', '--local', 'filter.evil.clean', `touch ${marker}`], { cwd: repo });
    writeFileSync(join(repo, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(repo, 'tracked.txt'), 'x\n');
    expect(snapshotCode(repo, 'c1', 'cp1')).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses include.path', () => {
    const repo = initRepo();
    execFileSync('git', ['config', '--local', 'include.path', '/tmp/x'], { cwd: repo });
    expect(() => gitSync(repo, ['status'])).toThrow(GitUnsafeConfigError);
  });

  it('refuses a rewritten .git file pointing at a crafted gitdir', () => {
    const evil = initRepo();
    const marker = join(tmpdir(), `tierwyn-redir-${randomUUID()}`);
    execFileSync('git', ['config', '--local', 'core.fsmonitor', `touch ${marker}`], { cwd: evil });
    const fake = tmp('tierwyn-fakewt-');
    writeFileSync(join(fake, '.git'), `gitdir: ${join(evil, '.git')}\n`);
    expect(() => gitSync(fake, ['status'])).toThrow(GitUnsafeConfigError);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses diff.external and does not run it', () => {
    const repo = initRepo();
    const marker = join(tmpdir(), `tierwyn-diffext-${randomUUID()}`);
    execFileSync('git', ['config', '--local', 'diff.external', `touch ${marker}`], { cwd: repo });
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    execFileSync('git', ['add', 'f.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'f'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'f.txt'), 'y\n');
    expect(() => gitSync(repo, ['diff', 'HEAD', '--', 'f.txt'])).toThrow(GitUnsafeConfigError);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses submodule.*.update', () => {
    const repo = initRepo();
    execFileSync('git', ['config', '--local', 'submodule.evil.update', '!touch /tmp/x'], { cwd: repo });
    expect(() => gitSync(repo, ['status'])).toThrow(GitUnsafeConfigError);
  });

  it('re-scans after a same-size same-mtime rewrite (ctime changes)', () => {
    const repo = initRepo();
    const marker = join(tmpdir(), `tierwyn-cache-${randomUUID()}`);
    const config = join(repo, '.git', 'config');
    const orig = readFileSync(config, 'utf8');
    const padTo = (s: string, n: number) => (s.endsWith('\n') ? s : s + '\n').padEnd(n, '#');
    const evilBody = `[core]\n\tfsmonitor = touch ${marker}\n`;
    const n = Math.max(orig.length, evilBody.length) + 8;
    writeFileSync(config, padTo(orig, n));
    expect(() => gitSync(repo, ['status'])).not.toThrow();
    const st = statSync(config);
    writeFileSync(config, padTo(evilBody, n));
    utimesSync(config, st.atime, st.mtime);
    expect(() => gitSync(repo, ['status'])).toThrow(GitUnsafeConfigError);
    expect(existsSync(marker)).toBe(false);
  });

  it('allows exact git-lfs filter values', () => {
    const repo = initRepo();
    execFileSync('git', ['config', '--local', 'filter.lfs.clean', 'git-lfs clean -- %f'], { cwd: repo });
    execFileSync('git', ['config', '--local', 'filter.lfs.smudge', 'git-lfs smudge -- %f'], { cwd: repo });
    execFileSync('git', ['config', '--local', 'filter.lfs.process', 'git-lfs filter-process'], { cwd: repo });
    execFileSync('git', ['config', '--local', 'filter.lfs.required', 'true'], { cwd: repo });
    expect(() => gitSync(repo, ['status'])).not.toThrow();
  });

  it('allows core.hooksPath = .git/hooks', () => {
    const repo = initRepo();
    execFileSync('git', ['config', '--local', 'core.hooksPath', '.git/hooks'], { cwd: repo });
    expect(() => gitSync(repo, ['status'])).not.toThrow();
  });

  it('allows an absolute core.hooksPath equal to gitDir/hooks', () => {
    const repo = initRepo();
    execFileSync('git', ['config', '--local', 'core.hooksPath', join(repo, '.git', 'hooks')], { cwd: repo });
    expect(() => gitSync(repo, ['status'])).not.toThrow();
  });

  it('refuses core.hooksPath pointing at /tmp/evil-hooks', () => {
    const repo = initRepo();
    execFileSync('git', ['config', '--local', 'core.hooksPath', '/tmp/evil-hooks'], { cwd: repo });
    expect(() => gitSync(repo, ['status'])).toThrow(GitUnsafeConfigError);
  });

  it('refuses core.hooksPath = ./.husky', () => {
    const repo = initRepo();
    execFileSync('git', ['config', '--local', 'core.hooksPath', './.husky'], { cwd: repo });
    expect(() => gitSync(repo, ['status'])).toThrow(GitUnsafeConfigError);
  });
});

describe('gitEnv', () => {
  it('background profile scrubs SESSION_SECRET and blanks global config', () => {
    const prev = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'hub-secret';
    try {
      const env = gitEnv('background');
      expect(env.SESSION_SECRET).toBeUndefined();
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    } finally {
      if (prev === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prev;
    }
  });

  it('operator profile keeps global config', () => {
    const env = gitEnv('operator');
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  });

  it('keeps GIT_INDEX_FILE from extra and drops GIT_DIR', () => {
    const env = gitEnv('background', { GIT_INDEX_FILE: '/tmp/idx', GIT_DIR: '/evil', SESSION_SECRET: 'x' });
    expect(env.GIT_INDEX_FILE).toBe('/tmp/idx');
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
  });
});
