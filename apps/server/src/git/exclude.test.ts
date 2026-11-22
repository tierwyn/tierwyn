import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureProjectStateGitExclude } from './exclude.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs = [];
});

function gitInit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tierwyn-exclude-'));
  dirs.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@localhost'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('ensureProjectStateGitExclude (C18)', () => {
  it('appends /.tierwyn/ to .git/info/exclude in a git cwd', () => {
    const dir = gitInit();
    ensureProjectStateGitExclude(dir);
    const text = readFileSync(join(dir, '.git/info/exclude'), 'utf8');
    expect(text.split(/\r?\n/).map((l) => l.trim())).toContain('/.tierwyn/');
  });

  it('is idempotent and does not duplicate the line', () => {
    const dir = gitInit();
    ensureProjectStateGitExclude(dir);
    ensureProjectStateGitExclude(dir);
    const text = readFileSync(join(dir, '.git/info/exclude'), 'utf8');
    expect(text.split(/\r?\n/).filter((l) => l.trim() === '/.tierwyn/')).toHaveLength(1);
  });

  it('preserves existing exclude lines', () => {
    const dir = gitInit();
    mkdirSync(join(dir, '.git/info'), { recursive: true });
    writeFileSync(join(dir, '.git/info/exclude'), '# keep me\n/tmp/\n');
    ensureProjectStateGitExclude(dir);
    const text = readFileSync(join(dir, '.git/info/exclude'), 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('/tmp/');
    expect(text).toContain('/.tierwyn/');
  });

  it('is a no-op outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-exclude-nongit-'));
    dirs.push(dir);
    ensureProjectStateGitExclude(dir);
    expect(() => readFileSync(join(dir, '.git/info/exclude'))).toThrow();
  });
});
