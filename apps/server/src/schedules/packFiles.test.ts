import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  symlinkSync, rmSync, realpathSync, lstatSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SchedulePackFile } from '@tierwyn/shared';
import { jobNameToSlug } from '@tierwyn/shared';
import {
  materialisePackFiles, substitutePackTokens, unlinkPackFiles,
  PackFileConflict, PackFilePathError,
} from './packFiles.js';

const FOUR: SchedulePackFile[] = [
  { kind: 'prompt', body: 'prompt [[goal]]' },
  { kind: 'progress', body: 'progress' },
  { kind: 'roster', body: 'roster' },
  { kind: 'README', body: 'readme [[jobSlug]]' },
];

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tierwyn-packs-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('substitutePackTokens', () => {
  it('substitutes known tokens and leaves unknown ones verbatim', () => {
    const out = substitutePackTokens('go [[goal]] then [[nope]]', { goal: 'ship it' });
    expect(out).toBe('go ship it then [[nope]]');
  });

  it('does not treat $& in a value as a replace pattern', () => {
    expect(substitutePackTokens('x[[goal]]y', { goal: 'a$&b' })).toBe('xa$&by');
  });

  it('does not re-expand a value that contains [[…]]', () => {
    const out = substitutePackTokens('A[[goal]]B[[projectRoot]]C', {
      goal: 'see [[projectRoot]]',
      projectRoot: '/real',
    });
    expect(out).toBe('Asee [[projectRoot]]B/realC');
  });
});

describe('materialisePackFiles', () => {
  it('writes the four derived names from the job slug', () => {
    const root = tmp();
    const jobSlug = jobNameToSlug('[feature-wave] Evolve wave', 'feature-wave');
    expect(jobSlug).toBe('evolve-wave');
    const { written } = materialisePackFiles(root, jobSlug, FOUR, { goal: 'g', jobSlug });
    expect(written.sort()).toEqual([
      '.tierwyn/schedule/evolve-wave-README.md',
      '.tierwyn/schedule/evolve-wave-progress.md',
      '.tierwyn/schedule/evolve-wave-prompt.md',
      '.tierwyn/schedule/evolve-wave-roster.md',
    ].sort());
    expect(readFileSync(join(root, '.tierwyn/schedule/evolve-wave-prompt.md'), 'utf8')).toBe('prompt g');
    expect(readFileSync(join(root, '.tierwyn/schedule/evolve-wave-README.md'), 'utf8')).toBe('readme evolve-wave');
    for (const rel of written) {
      expect(realpathSync(join(root, rel)).startsWith(realpathSync(root))).toBe(true);
    }
  });

  it('refuses when any target exists and writes none of the rest', () => {
    const root = tmp();
    mkdirSync(join(root, '.tierwyn', 'schedule'), { recursive: true });
    writeFileSync(join(root, '.tierwyn/schedule/evolve-wave-progress.md'), 'old');
    expect(() => materialisePackFiles(root, 'evolve-wave', FOUR, {})).toThrow(PackFileConflict);
    try {
      materialisePackFiles(root, 'evolve-wave', FOUR, {});
    } catch (e) {
      expect(e).toBeInstanceOf(PackFileConflict);
      expect((e as PackFileConflict).conflicts).toEqual(['.tierwyn/schedule/evolve-wave-progress.md']);
    }
    expect(existsSync(join(root, '.tierwyn/schedule/evolve-wave-prompt.md'))).toBe(false);
    expect(readFileSync(join(root, '.tierwyn/schedule/evolve-wave-progress.md'), 'utf8')).toBe('old');
  });

  it('rejects a symlinked .tierwyn/schedule', () => {
    const root = tmp();
    const outside = tmp();
    mkdirSync(join(root, '.tierwyn'));
    symlinkSync(outside, join(root, '.tierwyn', 'schedule'));
    expect(() => materialisePackFiles(root, 'job', FOUR, {})).toThrow(PackFilePathError);
    expect(existsSync(join(outside, 'job-prompt.md'))).toBe(false);
    // Failing materialise must not create files under the escaped dir.
    expect(existsSync(join(outside, 'job-progress.md'))).toBe(false);
  });

  it('rejects a symlink at .tierwyn (not just .tierwyn/schedule) without creating outside/schedule', () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, '.tierwyn'));
    expect(() => materialisePackFiles(root, 'job', FOUR, {})).toThrow(PackFilePathError);
    // mkdir must not run before the escape check — no empty schedule/ outside.
    expect(existsSync(join(outside, 'schedule'))).toBe(false);
    expect(existsSync(join(outside, 'job-prompt.md'))).toBe(false);
  });

  it('accepts a project path that legitimately contains a symlink', () => {
    const real = tmp();
    const parent = tmp();
    const link = join(parent, 'linked-checkout');
    symlinkSync(real, link);
    const { written } = materialisePackFiles(link, 'ok-job', [{ kind: 'prompt', body: 'hi' }], {});
    expect(written).toEqual(['.tierwyn/schedule/ok-job-prompt.md']);
    expect(existsSync(join(real, '.tierwyn/schedule/ok-job-prompt.md'))).toBe(true);
  });

  it('throws a path error when the project root is missing or not a directory', () => {
    expect(() => materialisePackFiles(join(tmp(), 'nope'), 'job', FOUR, {})).toThrow(PackFilePathError);
    const file = join(tmp(), 'not-a-dir');
    writeFileSync(file, 'x');
    try {
      materialisePackFiles(file, 'job', FOUR, {});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PackFilePathError);
      expect((e as PackFilePathError).message).toBe('project root does not exist');
    }
    expect(existsSync(join(file, '.tierwyn'))).toBe(false);
  });

  it('overwrite: true replaces existing file content and returns all four in written', () => {
    const root = tmp();
    mkdirSync(join(root, '.tierwyn', 'schedule'), { recursive: true });
    writeFileSync(join(root, '.tierwyn/schedule/evolve-wave-progress.md'), 'old');
    const { written } = materialisePackFiles(
      root, 'evolve-wave', FOUR, { goal: 'g', jobSlug: 'evolve-wave' }, { overwrite: true },
    );
    expect(written.sort()).toEqual([
      '.tierwyn/schedule/evolve-wave-README.md',
      '.tierwyn/schedule/evolve-wave-progress.md',
      '.tierwyn/schedule/evolve-wave-prompt.md',
      '.tierwyn/schedule/evolve-wave-roster.md',
    ].sort());
    expect(readFileSync(join(root, '.tierwyn/schedule/evolve-wave-progress.md'), 'utf8')).toBe('progress');
    expect(readFileSync(join(root, '.tierwyn/schedule/evolve-wave-prompt.md'), 'utf8')).toBe('prompt g');
    expect(readFileSync(join(root, '.tierwyn/schedule/evolve-wave-roster.md'), 'utf8')).toBe('roster');
    expect(readFileSync(join(root, '.tierwyn/schedule/evolve-wave-README.md'), 'utf8')).toBe('readme evolve-wave');
  });

  it('overwrite: true with no existing files behaves like default', () => {
    const root = tmp();
    const { written } = materialisePackFiles(root, 'fresh-job', FOUR, {}, { overwrite: true });
    expect(written.sort()).toEqual([
      '.tierwyn/schedule/fresh-job-README.md',
      '.tierwyn/schedule/fresh-job-progress.md',
      '.tierwyn/schedule/fresh-job-prompt.md',
      '.tierwyn/schedule/fresh-job-roster.md',
    ].sort());
    expect(readFileSync(join(root, '.tierwyn/schedule/fresh-job-prompt.md'), 'utf8')).toBe('prompt [[goal]]');
  });

  it('overwrite: true still throws PackFilePathError for bad slug / missing root', () => {
    expect(() => materialisePackFiles(tmp(), '../escape', FOUR, {}, { overwrite: true }))
      .toThrow(PackFilePathError);
    expect(() => materialisePackFiles(join(tmp(), 'nope'), 'job', FOUR, {}, { overwrite: true }))
      .toThrow(PackFilePathError);
  });

  it('overwrite: true refuses a non-dangling symlink and leaves the target file untouched', () => {
    const root = tmp();
    const outside = tmp();
    const outsideFile = join(outside, 'secret.md');
    writeFileSync(outsideFile, 'do not clobber');
    mkdirSync(join(root, '.tierwyn', 'schedule'), { recursive: true });
    symlinkSync(outsideFile, join(root, '.tierwyn/schedule/job-prompt.md'));
    expect(() => materialisePackFiles(
      root, 'job', [{ kind: 'prompt', body: 'new' }], {}, { overwrite: true },
    )).toThrow(PackFilePathError);
    expect(readFileSync(outsideFile, 'utf8')).toBe('do not clobber');
  });

  it('overwrite: true replaces a dangling symlink without creating its outside target', () => {
    const root = tmp();
    const outside = tmp();
    const danglingTarget = join(outside, 'not-yet-created.md');
    mkdirSync(join(root, '.tierwyn', 'schedule'), { recursive: true });
    const linkPath = join(root, '.tierwyn/schedule/job-prompt.md');
    symlinkSync(danglingTarget, linkPath);
    expect(existsSync(danglingTarget)).toBe(false);

    const { written } = materialisePackFiles(
      root, 'job', [{ kind: 'prompt', body: 'pack-body' }], {}, { overwrite: true },
    );
    expect(written).toEqual(['.tierwyn/schedule/job-prompt.md']);
    // Outside target must never be created (write must not follow the link).
    expect(existsSync(danglingTarget)).toBe(false);
    // Project path is now a regular file with the pack content.
    const lst = lstatSync(linkPath);
    expect(lst.isSymbolicLink()).toBe(false);
    expect(lst.isFile()).toBe(true);
    expect(readFileSync(linkPath, 'utf8')).toBe('pack-body');
  });

  it('materialises two differently-named jobs from the same pack without collision', () => {
    const root = tmp();
    const a = jobNameToSlug('[feature-wave] Evolve wave', 'feature-wave');
    const b = jobNameToSlug('[feature-wave] Docs wave', 'feature-wave');
    expect(a).toBe('evolve-wave');
    expect(b).toBe('docs-wave');
    materialisePackFiles(root, a, [{ kind: 'prompt', body: 'a' }], {});
    materialisePackFiles(root, b, [{ kind: 'prompt', body: 'b' }], {});
    expect(readFileSync(join(root, '.tierwyn/schedule/evolve-wave-prompt.md'), 'utf8')).toBe('a');
    expect(readFileSync(join(root, '.tierwyn/schedule/docs-wave-prompt.md'), 'utf8')).toBe('b');
  });
});

describe('unlinkPackFiles', () => {
  it('removes only computed names for the given kinds', () => {
    const root = tmp();
    materialisePackFiles(root, 'job-a', FOUR, {});
    unlinkPackFiles(root, 'job-a', ['prompt', 'roster']);
    expect(existsSync(join(root, '.tierwyn/schedule/job-a-prompt.md'))).toBe(false);
    expect(existsSync(join(root, '.tierwyn/schedule/job-a-roster.md'))).toBe(false);
    expect(existsSync(join(root, '.tierwyn/schedule/job-a-progress.md'))).toBe(true);
    expect(existsSync(join(root, '.tierwyn/schedule/job-a-README.md'))).toBe(true);
  });

  it('ignores a symlink at the target and leaves it in place', () => {
    const root = tmp();
    const outside = tmp();
    const outsideFile = join(outside, 'secret.md');
    writeFileSync(outsideFile, 'keep');
    mkdirSync(join(root, '.tierwyn', 'schedule'), { recursive: true });
    symlinkSync(outsideFile, join(root, '.tierwyn/schedule/job-prompt.md'));
    unlinkPackFiles(root, 'job', ['prompt']);
    expect(existsSync(join(root, '.tierwyn/schedule/job-prompt.md'))).toBe(true);
    expect(readFileSync(outsideFile, 'utf8')).toBe('keep');
  });

  it('no-ops on a bad slug', () => {
    const root = tmp();
    materialisePackFiles(root, 'job', [{ kind: 'prompt', body: 'x' }], {});
    unlinkPackFiles(root, '../escape', ['prompt']);
    expect(existsSync(join(root, '.tierwyn/schedule/job-prompt.md'))).toBe(true);
  });

  it('refuses when .tierwyn is a symlink outside — deletes nothing outside', () => {
    const root = tmp();
    const outside = tmp();
    const outsideFile = join(outside, 'job-prompt.md');
    writeFileSync(outsideFile, 'keep-me');
    symlinkSync(outside, join(root, '.tierwyn'));
    unlinkPackFiles(root, 'job', ['prompt']);
    expect(existsSync(outsideFile)).toBe(true);
    expect(readFileSync(outsideFile, 'utf8')).toBe('keep-me');
  });

  it('refuses when .tierwyn/schedule is a symlink outside — deletes nothing outside', () => {
    const root = tmp();
    const outside = tmp();
    const outsideFile = join(outside, 'job-prompt.md');
    writeFileSync(outsideFile, 'keep-me');
    mkdirSync(join(root, '.tierwyn'));
    symlinkSync(outside, join(root, '.tierwyn', 'schedule'));
    unlinkPackFiles(root, 'job', ['prompt']);
    expect(existsSync(outsideFile)).toBe(true);
    expect(readFileSync(outsideFile, 'utf8')).toBe('keep-me');
  });
});
