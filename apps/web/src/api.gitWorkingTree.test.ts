import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchWorkingTree, stageWorkingTreePath, unstageWorkingTreePath, commitWorkingTree,
  generateWorkingTreeCommitMessage, putWorkingTreeCommitMessage,
  discardWorkingTreePath,
} from './api.js';
import { UnauthorizedError } from './api.js';

describe('git working tree API', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetchWorkingTree sends credentials include', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ isRepo: true, cwd: '/r', staged: [], unstaged: [] }),
    });
    await fetchWorkingTree({ projectId: 'p1' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/files/working-tree?projectId=p1',
      { credentials: 'include' },
    );
  });

  it('fetchWorkingTree throws UnauthorizedError on 401', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
    await expect(fetchWorkingTree({ projectId: 'p1' })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('fetchWorkingTree throws with server error on 4xx', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad request' }),
    });
    await expect(fetchWorkingTree({ projectId: 'p1' })).rejects.toThrow('bad request');
  });

  it('stageWorkingTreePath sends credentials include', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await stageWorkingTreePath({ cwd: '/r', path: 'a.ts', projectId: 'p1' });
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].credentials).toBe('include');
    expect(call[1].method).toBe('POST');
  });

  it('unstageWorkingTreePath throws on 4xx with error text', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'index.lock' }),
    });
    await expect(unstageWorkingTreePath({ cwd: '/r', path: 'a.ts', projectId: 'p1' }))
      .rejects.toThrow('index.lock');
  });

  it('commitWorkingTree throws UnauthorizedError on 401', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
    await expect(commitWorkingTree({ cwd: '/r', message: 'm', projectId: 'p1' }))
      .rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('putWorkingTreeCommitMessage issues PUT with credentials and message', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }),
    });
    await putWorkingTreeCommitMessage({ cwd: '/r', projectId: 'p1', message: 'draft' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/files/working-tree/commit-message',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/r', projectId: 'p1', message: 'draft' }),
      }),
    );
  });

  it('putWorkingTreeCommitMessage throws UnauthorizedError on 401', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
    await expect(putWorkingTreeCommitMessage({ cwd: '/r', projectId: 'p1', message: 'x' }))
      .rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('putWorkingTreeCommitMessage surfaces server error on 4xx', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'commit message too long' }),
    });
    await expect(putWorkingTreeCommitMessage({ cwd: '/r', projectId: 'p1', message: 'x' }))
      .rejects.toThrow('commit message too long');
  });

  it('generateWorkingTreeCommitMessage returns { ok: true, generating: true }', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, generating: true }),
    });
    await expect(generateWorkingTreeCommitMessage({ cwd: '/r', projectId: 'p1' }))
      .resolves.toEqual({ ok: true, generating: true });
  });

  it('discardWorkingTreePath posts to /files/working-tree/discard with credentials include', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, path: 'a.ts' }),
    });
    await discardWorkingTreePath({ cwd: '/r', path: 'a.ts', projectId: 'p1' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/files/working-tree/discard',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/r', path: 'a.ts', projectId: 'p1' }),
      }),
    );
  });
});
