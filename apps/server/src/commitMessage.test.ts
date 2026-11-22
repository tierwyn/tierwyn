import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedDefaultSettings } from './db/seed.js';
import { updateSidecarLlmSettings } from './repositories/settings.js';
import { stagedDiff, stagedDiffStat, recentSubjects } from './git/workingTree.js';
import {
  buildCommitMessagePrompt,
  generateCommitMessage,
  commitMessageDeps,
  sanitiseCommitMessage,
  COMMIT_DIFF_BUDGET,
  COMMIT_DIFF_HEAD_CHARS,
  COMMIT_MESSAGE_MAX_CHARS,
  COMMIT_MESSAGE_SYSTEM_PROMPT,
  COMMIT_TIMEOUT_SECS,
} from './commitMessage.js';

vi.mock('./git/workingTree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git/workingTree.js')>();
  return {
    ...actual,
    stagedDiff: vi.fn(actual.stagedDiff),
    stagedDiffStat: vi.fn(actual.stagedDiffStat),
    recentSubjects: vi.fn(actual.recentSubjects),
  };
});

describe('COMMIT_TIMEOUT_SECS', () => {
  it('is 120 so agent_readonly commit loops stay above the read-only floor', () => {
    expect(COMMIT_TIMEOUT_SECS).toBe(120);
  });
});

describe('COMMIT_MESSAGE_SYSTEM_PROMPT', () => {
  it('names Conventional Commits type(scope): subject so the default cannot silently regress', () => {
    expect(COMMIT_MESSAGE_SYSTEM_PROMPT).toContain('type(scope): subject');
  });
});

describe('buildCommitMessagePrompt', () => {
  it('includes exemplar lines and the raw diff under budget', () => {
    const { prompt, summarised } = buildCommitMessagePrompt({
      subjects: ['feat(web): add panel', 'fix(server): race'],
      fileCount: 2,
      diff: 'diff --git a/x b/x\n+hello',
    });
    expect(summarised).toBe(false);
    expect(prompt).toContain('- feat(web): add panel');
    expect(prompt).toContain('- fix(server): race');
    expect(prompt).toContain('Staged changes (2 file(s)):');
    expect(prompt).toContain('diff --git a/x b/x\n+hello');
    expect(prompt).not.toContain('[diff too large');
  });

  it('switches to the [diff too large …] + stat + truncated-head form over budget', () => {
    const big = 'x'.repeat(COMMIT_DIFF_BUDGET + 1);
    const { prompt, summarised } = buildCommitMessagePrompt({
      subjects: ['init'],
      fileCount: 3,
      diff: big,
      diffStat: ' a.txt | 1 +\n 1 file changed, 1 insertion(+)',
    });
    expect(summarised).toBe(true);
    expect(prompt).toContain(`[diff too large to include in full (${big.length} characters) — change stat, then the first ${COMMIT_DIFF_HEAD_CHARS} characters of the diff below]`);
    expect(prompt).toContain('a.txt | 1 +');
    expect(prompt).toContain('Staged changes (3 file(s)):');
    expect(prompt).toContain('[truncated diff]');
    expect(prompt).toContain(big.slice(0, 40));
    expect(prompt).not.toContain(big);
  });

  it('omits the truncated head when diffHead is empty (diff could not be materialised)', () => {
    const big = 'x'.repeat(COMMIT_DIFF_BUDGET + 1);
    const { prompt, summarised } = buildCommitMessagePrompt({
      subjects: ['init'],
      fileCount: 3,
      diff: big,
      diffStat: ' a.txt | 1 +',
      diffHead: '',
    });
    expect(summarised).toBe(true);
    expect(prompt).toContain('a.txt | 1 +');
    expect(prompt).not.toContain('[truncated diff]');
    expect(prompt).not.toContain(big.slice(0, 40));
  });

  it('emits the no-history line when subjects are empty', () => {
    const { prompt } = buildCommitMessagePrompt({
      subjects: [],
      fileCount: 1,
      diff: '+x',
    });
    expect(prompt).toContain('(no commit history yet — no house style to follow)');
    expect(prompt).not.toContain('- ');
  });

  it('interpolates FILE_COUNT', () => {
    const { prompt } = buildCommitMessagePrompt({
      subjects: ['a'],
      fileCount: 7,
      diff: '+y',
    });
    expect(prompt).toContain('Staged changes (7 file(s)):');
  });

  it('uses a larger diff head when maxDiffChars is raised', () => {
    const maxDiffChars = 50_000;
    const big = 'x'.repeat(maxDiffChars * 2 + 1);
    const { prompt, summarised } = buildCommitMessagePrompt({
      subjects: ['init'],
      fileCount: 1,
      diff: big,
      diffStat: ' a.txt | 1 +',
      maxDiffChars,
    });
    expect(summarised).toBe(true);
    expect(prompt).toContain(`the first ${maxDiffChars} characters of the diff`);
    expect(prompt).toContain(big.slice(0, maxDiffChars));
    expect(prompt).not.toContain(big);
  });

  it('sends a 150k diff whole when maxInputChars is 200000', () => {
    const diff = 'y'.repeat(150_000);
    const { prompt, summarised } = buildCommitMessagePrompt({
      subjects: ['init'],
      fileCount: 1,
      diff,
      maxDiffChars: 200_000,
    });
    expect(summarised).toBe(false);
    expect(prompt).toContain(diff);
    expect(prompt).not.toContain('[diff too large');
  });

  it('keeps default framing byte-identical when maxInputChars is unset', () => {
    const big = 'x'.repeat(COMMIT_DIFF_BUDGET + 1);
    const args = {
      subjects: ['init'],
      fileCount: 3,
      diff: big,
      diffStat: ' a.txt | 1 +\n 1 file changed, 1 insertion(+)',
    };
    const unset = buildCommitMessagePrompt(args);
    const explicitDefault = buildCommitMessagePrompt({ ...args, maxDiffChars: COMMIT_DIFF_HEAD_CHARS });
    expect(unset).toEqual(explicitDefault);
  });

  it('summarises a 10000-char diff when maxDiffChars is 500', () => {
    const { summarised, prompt } = buildCommitMessagePrompt({
      subjects: ['init'],
      fileCount: 1,
      diff: 'z'.repeat(10_000),
      diffStat: ' a.txt | 1 +',
      maxDiffChars: 500,
    });
    expect(summarised).toBe(true);
    expect(prompt).toContain('[diff too large');
    expect(prompt).toContain('z'.repeat(500));
    expect(prompt).not.toContain('z'.repeat(501));
  });
});

describe('generateCommitMessage', () => {
  let db: Database.Database;
  const orig = commitMessageDeps.sidecarComplete;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    commitMessageDeps.sidecarComplete = vi.fn(async () => 'feat: generated');
    vi.mocked(recentSubjects).mockReturnValue(['init']);
    vi.mocked(stagedDiff).mockReturnValue('diff --git a/x b/x\n+hello');
    vi.mocked(stagedDiffStat).mockReturnValue(' a.txt | 1 +');
  });

  afterEach(() => {
    commitMessageDeps.sidecarComplete = orig;
    db.close();
  });

  it('reads the commit route and no longer passes systemPrompt', async () => {
    const out = await generateCommitMessage(db, '/tmp/tierwyn-not-a-git-repo', 1);
    expect(out.message).toBe('feat: generated');
    expect(out.summarised).toBe(false);
    expect(commitMessageDeps.sidecarComplete).toHaveBeenCalledTimes(1);
    const args = vi.mocked(commitMessageDeps.sidecarComplete).mock.calls[0]!;
    expect(args[1]).toBe('commit');
    expect(args[3]).toMatchObject({ timeoutSecs: COMMIT_TIMEOUT_SECS, cwd: '/tmp/tierwyn-not-a-git-repo' });
    expect(args[3]).not.toHaveProperty('systemPrompt');
  });

  it('passes remoteHostId through to sidecarComplete', async () => {
    await generateCommitMessage(db, '/tmp/tierwyn-not-a-git-repo', 1, undefined, 'h1');
    expect(vi.mocked(commitMessageDeps.sidecarComplete).mock.calls[0]![3]).toMatchObject({
      cwd: '/tmp/tierwyn-not-a-git-repo',
      remoteHostId: 'h1',
    });
  });

  it('sizes the materialisation-failure sentinel against the live diff budget', async () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', maxInputChars: 200_000 },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    vi.mocked(stagedDiff).mockImplementation(() => { throw new Error('maxBuffer'); });
    const out = await generateCommitMessage(db, '/tmp/tierwyn-not-a-git-repo', 1);
    expect(out.summarised).toBe(true);
    expect(stagedDiffStat).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(commitMessageDeps.sidecarComplete).mock.calls[0]![2] as string;
    expect(prompt).toContain('[diff too large to include in full (400001 characters)');
    expect(prompt).not.toContain('x'.repeat(40_001));
  });
});

describe('sanitiseCommitMessage', () => {
  it('strips a fenced reply', () => {
    expect(sanitiseCommitMessage('```\nfeat(web): do the thing\n```'))
      .toBe('feat(web): do the thing');
    expect(sanitiseCommitMessage('```text\nfix(server): race\n```'))
      .toBe('fix(server): race');
  });

  it('keeps a structured subject + body reply intact', () => {
    expect(sanitiseCommitMessage('feat(x): subject\n\nBody that explains the change\n- one\n- two'))
      .toBe('feat(x): subject\n\nBody that explains the change\n- one\n- two');
  });

  it('collapses blank runs in the body to a single blank line', () => {
    expect(sanitiseCommitMessage('feat: x\n\n\n\npara two\n\n\npara three\n\n'))
      .toBe('feat: x\n\npara two\n\npara three');
  });

  it('strips wrapping quotes and backticks', () => {
    expect(sanitiseCommitMessage('"feat(x): quoted"')).toBe('feat(x): quoted');
    expect(sanitiseCommitMessage("'feat(x): quoted'")).toBe('feat(x): quoted');
    expect(sanitiseCommitMessage('`feat(x): quoted`')).toBe('feat(x): quoted');
  });

  it('strips a Subject: / Commit message: label', () => {
    expect(sanitiseCommitMessage('Subject: feat(x): labelled')).toBe('feat(x): labelled');
    expect(sanitiseCommitMessage('Commit message: fix(y): labelled')).toBe('fix(y): labelled');
  });

  it('strips Subject: before quotes so Subject: "feat: x" loses both', () => {
    expect(sanitiseCommitMessage('Subject: "feat: x"')).toBe('feat: x');
  });

  it('drops ~~~ fence markers instead of returning ~~~', () => {
    expect(sanitiseCommitMessage('~~~\nfeat: x\n~~~')).toBe('feat: x');
  });

  it('takes the fenced body after a preamble, not the preamble', () => {
    expect(sanitiseCommitMessage('Here is the commit message:\n```\nfeat: x\n```'))
      .toBe('feat: x');
  });

  it('keeps a colon-terminated subject (plus body) when the reply is unfenced and unlabelled', () => {
    expect(sanitiseCommitMessage('Update README:\n- add install steps'))
      .toBe('Update README:\n\n- add install steps');
    expect(sanitiseCommitMessage('refactor: split the parser:\nit was too big'))
      .toBe('refactor: split the parser:\n\nit was too big');
  });

  it('normalises bare CR so it cannot hide text in git log --oneline', () => {
    expect(sanitiseCommitMessage('feat: x\rIGNORE ME')).toBe('feat: x IGNORE ME');
  });

  it('drops a trailing period', () => {
    expect(sanitiseCommitMessage('feat(x): do a thing.')).toBe('feat(x): do a thing');
  });

  it('throws on empty or whitespace-only', () => {
    expect(() => sanitiseCommitMessage('')).toThrow(/no usable subject/);
    expect(() => sanitiseCommitMessage('   \n  ')).toThrow(/no usable subject/);
    expect(() => sanitiseCommitMessage('```\n\n```')).toThrow(/no usable subject/);
  });

  it('caps pathological output at COMMIT_MESSAGE_MAX_CHARS on a line boundary', () => {
    const line = 'a'.repeat(100);
    const raw = `feat: subject\n\n${Array.from({ length: 50 }, () => line).join('\n')}`;
    const out = sanitiseCommitMessage(raw);
    expect(out.length).toBeLessThanOrEqual(COMMIT_MESSAGE_MAX_CHARS);
    expect(out.startsWith('feat: subject\n\n')).toBe(true);
    expect(out.endsWith('a'.repeat(100))).toBe(true);
  });
});
