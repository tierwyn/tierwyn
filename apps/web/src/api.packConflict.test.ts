import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, PackFileConflictError } from './api.js';
import type { CreateScheduleJobRequest } from '@tierwyn/shared';

const body: CreateScheduleJobRequest = {
  name: 'Epic',
  timezone: 'UTC',
  scheduleKind: 'interval',
  scheduleExpr: JSON.stringify({ everyMs: 86_400_000 }),
  profileId: 'p',
  packSlug: 'phased-feature',
};

describe('api.createSchedule pack file conflict', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws PackFileConflictError on 409 with conflicts', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'pack file conflict', conflicts: ['a', 'b'] }),
    });
    await expect(api.createSchedule('proj', body)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PackFileConflictError);
      const e = err as PackFileConflictError;
      expect(e.conflicts).toEqual(['a', 'b']);
      expect(e.message).toBe('pack file conflict: a, b');
      return true;
    });
  });

  it('throws a plain Error on 400 with conflicts', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'pack apply failed', conflicts: ['a'] }),
    });
    await expect(api.createSchedule('proj', body)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PackFileConflictError);
      expect((err as Error).message).toBe('pack apply failed: a');
      return true;
    });
  });

  it('throws a plain Error on 409 without conflicts', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'duplicate' }),
    });
    await expect(api.createSchedule('proj', body)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PackFileConflictError);
      expect((err as Error).message).toBe('duplicate');
      return true;
    });
  });
});
