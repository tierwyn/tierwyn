import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  gitHistoryUrl, gitCommitUrl, gitCommitDiffUrl, gitCommitFileUrl,
  fetchGitHistory, fetchGitCommitDetail, fetchGitCommitDiff, fetchGitCommitFile,
  UnauthorizedError,
} from './api.js';

describe('git history URL builders', () => {
  it('encodes cwd and path so a space and # round-trip', () => {
    const ctx = { projectId: 'p1', cwd: '/tmp/my repo' };
    const path = 'src/foo #bar.ts';
    const sha = 'abc1234';

    const history = gitHistoryUrl(ctx);
    const commit = gitCommitUrl(ctx, sha);
    const diff = gitCommitDiffUrl(ctx, sha, path);
    const file = gitCommitFileUrl(ctx, sha, path);

    expect(history.startsWith('/files/git-history?')).toBe(true);
    expect(commit.startsWith('/files/git-history/commit?')).toBe(true);
    expect(diff.startsWith('/files/git-history/diff?')).toBe(true);
    expect(file.startsWith('/files/git-history/file?')).toBe(true);

    for (const url of [history, commit, diff, file]) {
      const qs = new URL(url, 'http://tierwyn.local').searchParams;
      expect(qs.get('cwd')).toBe('/tmp/my repo');
      expect(qs.get('projectId')).toBe('p1');
    }
    expect(new URL(diff, 'http://tierwyn.local').searchParams.get('path')).toBe(path);
    expect(new URL(file, 'http://tierwyn.local').searchParams.get('path')).toBe(path);
    expect(file).toContain(encodeURIComponent('#'));
  });

  it('omits limit and skip when undefined', () => {
    const url = gitHistoryUrl({ projectId: 'p1' });
    const qs = new URL(url, 'http://tierwyn.local').searchParams;
    expect(qs.has('limit')).toBe(false);
    expect(qs.has('skip')).toBe(false);
    expect(qs.get('projectId')).toBe('p1');
  });

  it('includes limit and skip when set', () => {
    const url = gitHistoryUrl({ projectId: 'p1', limit: 50, skip: 50 });
    const qs = new URL(url, 'http://tierwyn.local').searchParams;
    expect(qs.get('limit')).toBe('50');
    expect(qs.get('skip')).toBe('50');
  });

  it('includes ref when set (W6)', () => {
    const url = gitHistoryUrl({ projectId: 'p1', ref: 'feature/branch' });
    const qs = new URL(url, 'http://tierwyn.local').searchParams;
    expect(qs.get('ref')).toBe('feature/branch');
  });
});

describe('git history fetchers', () => {
  const originalFetch = global.fetch;
  const ctx = { projectId: 'p1', cwd: '/r' };

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends credentials include', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ commits: [], hasMore: false }),
    });
    await fetchGitHistory(ctx);
    expect(global.fetch).toHaveBeenCalledWith(
      gitHistoryUrl(ctx),
      { credentials: 'include' },
    );
  });

  it('throws UnauthorizedError on 401 for each fetcher', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
    await expect(fetchGitHistory(ctx)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(fetchGitCommitDetail(ctx, 'abc1234')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(fetchGitCommitDiff(ctx, 'abc1234', 'a.ts')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(fetchGitCommitFile(ctx, 'abc1234', 'a.ts')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('surfaces the server error string on non-ok', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: 'invalid sha' }),
    });
    await expect(fetchGitHistory(ctx)).rejects.toThrow('invalid sha');
    await expect(fetchGitCommitDetail(ctx, 'HEAD')).rejects.toThrow('invalid sha');
    await expect(fetchGitCommitDiff(ctx, 'abc', 'a.ts')).rejects.toThrow('invalid sha');
    await expect(fetchGitCommitFile(ctx, 'abc', 'a.ts')).rejects.toThrow('invalid sha');
  });
});
