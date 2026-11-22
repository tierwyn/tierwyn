import { describe, it, expect } from 'vitest';
import { parseGitDiff } from './diffParser.js';

describe('parseGitDiff', () => {
  it('handles empty, null, or undefined input', () => {
    expect(parseGitDiff('')).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
    expect(parseGitDiff('   \n  \n')).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
    expect(parseGitDiff(null)).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
    expect(parseGitDiff(undefined)).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
  });

  it('parses single modified file diff', () => {
    const raw = [
      'diff --git a/src/index.ts b/src/index.ts',
      'index c0a7424..0dbafd8 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,5 +1,6 @@',
      ' import { a } from "b";',
      '-const x = 1;',
      '+const x = 2;',
      '+const y = 3;',
      ' export default x;',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(1);
    const f = result.files[0];
    expect(f.filePath).toBe('src/index.ts');
    expect(f.displayDir).toBe('src/');
    expect(f.displayName).toBe('index.ts');
    expect(f.status).toBe('modified');
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
    expect(result.totalAdditions).toBe(2);
    expect(result.totalDeletions).toBe(1);

    expect(f.lines).toHaveLength(6);
    expect(f.lines[0]).toEqual({ kind: 'hunk', text: '@@ -1,5 +1,6 @@' });
    expect(f.lines[1]).toEqual({ kind: 'unchanged', text: 'import { a } from "b";' });
    expect(f.lines[2]).toEqual({ kind: 'delete', text: 'const x = 1;' });
    expect(f.lines[3]).toEqual({ kind: 'insert', text: 'const x = 2;' });
    expect(f.lines[4]).toEqual({ kind: 'insert', text: 'const y = 3;' });
    expect(f.lines[5]).toEqual({ kind: 'unchanged', text: 'export default x;' });
  });

  it('correctly separates multiple files in a unified git diff', () => {
    const raw = [
      'diff --git a/apps/server/src/test.ts b/apps/server/src/test.ts',
      'index 1111111..2222222 100644',
      '--- a/apps/server/src/test.ts',
      '+++ b/apps/server/src/test.ts',
      '@@ -10,3 +10,4 @@',
      '+  await done;',
      '+});',
      '+});',
      'diff --git a/apps/server/src/adapters/deepseek/index.ts b/apps/server/src/adapters/deepseek/index.ts',
      'index c0a7424..0dbafd8 100644',
      '--- a/apps/server/src/adapters/deepseek/index.ts',
      '+++ b/apps/server/src/adapters/deepseek/index.ts',
      '@@ -1,6 +1,8 @@',
      ' import { EventEmitter } from "events";',
      '+import { homedir } from "os";',
      '+import { join } from "path";',
      ' import type { AgentAdapter } from "@tierwyn/shared";',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(2);

    expect(result.files[0].filePath).toBe('apps/server/src/test.ts');
    expect(result.files[0].displayDir).toBe('apps/server/src/');
    expect(result.files[0].displayName).toBe('test.ts');
    expect(result.files[0].additions).toBe(3);
    expect(result.files[0].deletions).toBe(0);

    expect(result.files[1].filePath).toBe('apps/server/src/adapters/deepseek/index.ts');
    expect(result.files[1].displayDir).toBe('apps/server/src/adapters/deepseek/');
    expect(result.files[1].displayName).toBe('index.ts');
    expect(result.files[1].additions).toBe(2);
    expect(result.files[1].deletions).toBe(0);

    expect(result.totalAdditions).toBe(5);
    expect(result.totalDeletions).toBe(0);
  });

  it('handles new file creation', () => {
    const raw = [
      'diff --git a/src/newfile.ts b/src/newfile.ts',
      'new file mode 100644',
      'index 0000000..abcdef1',
      '--- /dev/null',
      '+++ b/src/newfile.ts',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe('created');
    expect(result.files[0].filePath).toBe('src/newfile.ts');
    expect(result.files[0].additions).toBe(2);
    expect(result.files[0].deletions).toBe(0);
  });

  it('handles deleted file', () => {
    const raw = [
      'diff --git a/src/oldfile.ts b/src/oldfile.ts',
      'deleted file mode 100644',
      'index abcdef1..0000000',
      '--- a/src/oldfile.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-hello',
      '-world',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe('deleted');
    expect(result.files[0].filePath).toBe('src/oldfile.ts');
    expect(result.files[0].additions).toBe(0);
    expect(result.files[0].deletions).toBe(2);
  });

  it('handles renamed file', () => {
    const raw = [
      'diff --git a/src/prev.ts b/src/next.ts',
      'similarity index 98%',
      'rename from src/prev.ts',
      'rename to src/next.ts',
      'index abc..def 100644',
      '--- a/src/prev.ts',
      '+++ b/src/next.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe('renamed');
    expect(result.files[0].oldPath).toBe('src/prev.ts');
    expect(result.files[0].newPath).toBe('src/next.ts');
    expect(result.files[0].filePath).toBe('src/prev.ts → src/next.ts');
    expect(result.files[0].additions).toBe(1);
    expect(result.files[0].deletions).toBe(1);
  });

  it('handles binary file differences', () => {
    const raw = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 1234567..89abcdef 100644',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe('binary');
    expect(result.files[0].binary).toBe(true);
    expect(result.files[0].filePath).toBe('assets/logo.png');
    expect(result.files[0].lines).toHaveLength(0);
  });

  it('handles quoted filenames with spaces', () => {
    const raw = [
      'diff --git "a/path with space/file.ts" "b/path with space/file.ts"',
      'index 111..222 100644',
      '--- "a/path with space/file.ts"',
      '+++ "b/path with space/file.ts"',
      '@@ -1,1 +1,1 @@',
      '-1',
      '+2',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filePath).toBe('path with space/file.ts');
    expect(result.files[0].displayName).toBe('file.ts');
    expect(result.files[0].displayDir).toBe('path with space/');
  });

  it('handles Untracked files section', () => {
    const raw = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '+a',
      '',
      'Untracked files:',
      '  extra/one.ts',
      '  two.ts',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(3);
    expect(result.files[0].filePath).toBe('a.ts');
    expect(result.files[1].filePath).toBe('extra/one.ts');
    expect(result.files[1].status).toBe('created');
    expect(result.files[2].filePath).toBe('two.ts');
    expect(result.files[2].status).toBe('created');
  });

  it('handles non-git patch fallback with --- and +++', () => {
    const raw = [
      '--- a/src/simple.ts',
      '+++ b/src/simple.ts',
      '@@ -1,2 +1,2 @@',
      '-first',
      '+second',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].additions).toBe(1);
    expect(result.files[0].deletions).toBe(1);
  });

  it('disambiguates chipLabel when multiple files share the same basename', () => {
    const raw = [
      'diff --git a/apps/server/src/adapters/deepseek/index.ts b/apps/server/src/adapters/deepseek/index.ts',
      '--- a/apps/server/src/adapters/deepseek/index.ts',
      '+++ b/apps/server/src/adapters/deepseek/index.ts',
      '@@ -1,1 +1,2 @@',
      '+a',
      'diff --git a/apps/server/src/index.ts b/apps/server/src/index.ts',
      '--- a/apps/server/src/index.ts',
      '+++ b/apps/server/src/index.ts',
      '@@ -1,1 +1,2 @@',
      '+b',
    ].join('\n');

    const result = parseGitDiff(raw);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].displayName).toBe('index.ts');
    expect(result.files[0].chipLabel).toBe('deepseek/index.ts');
    expect(result.files[1].displayName).toBe('index.ts');
    expect(result.files[1].chipLabel).toBe('src/index.ts');
  });
});

