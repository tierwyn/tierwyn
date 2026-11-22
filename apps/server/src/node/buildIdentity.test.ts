import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readBuildIdentity } from './buildIdentity.js';

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tierwyn-build-id-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitRepo(): string {
  const d = tmp();
  execFileSync('git', ['init'], { cwd: d, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 't'], {
    cwd: d,
    stdio: 'ignore',
  });
  return d;
}

describe('readBuildIdentity', () => {
  it('BUILD_ID present → {id: trimmed, source: package}', () => {
    const d = tmp();
    writeFileSync(join(d, 'BUILD_ID'), '  abc-def  \n');
    expect(readBuildIdentity(d)).toEqual({ id: 'abc-def', source: 'package' });
  });

  it('BUILD_ID wins over .git', () => {
    const d = gitRepo();
    writeFileSync(join(d, 'BUILD_ID'), 'pkg-over-git');
    expect(readBuildIdentity(d)).toEqual({ id: 'pkg-over-git', source: 'package' });
  });

  it('git repo → {id: HEAD sha, source: git}', () => {
    const d = gitRepo();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    expect(readBuildIdentity(d)).toEqual({ id: sha, source: 'git' });
  });

  it('neither → {id: unknown, source: git}', () => {
    expect(readBuildIdentity(tmp())).toEqual({ id: 'unknown', source: 'git' });
  });

  it('empty BUILD_ID falls through to git', () => {
    const d = gitRepo();
    writeFileSync(join(d, 'BUILD_ID'), '  \n');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    expect(readBuildIdentity(d)).toEqual({ id: sha, source: 'git' });
  });
});
