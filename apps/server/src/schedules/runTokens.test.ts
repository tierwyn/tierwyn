import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  issueRunToken,
  validateRunToken,
  revokeRunToken,
  revokeRunTokensForRun,
  redactRunTokens,
  rebindRunToken,
} from './runTokens.js';

describe('runTokens', () => {
  const base = {
    jobId: 'job-1',
    runId: 'run-1',
    conversationId: 'conv-home',
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a token valid for the same job', () => {
    const token = issueRunToken(base);
    expect(validateRunToken(token, base.jobId)).toEqual({
      ok: true,
      jobId: base.jobId,
      runId: base.runId,
      conversationId: base.conversationId,
    });
  });

  it('rejects a token scoped to a different job', () => {
    const token = issueRunToken(base);
    expect(validateRunToken(token, 'other-job')).toEqual({ ok: false });
  });

  it('does not extend expiry when validated against the wrong job', () => {
    const token = issueRunToken(base);
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(validateRunToken(token, 'other-job')).toEqual({ ok: false });
    // jobId mismatch returns before the slide; original expiry still holds.
    vi.advanceTimersByTime(2);
    expect(validateRunToken(token, base.jobId)).toEqual({ ok: false });

    const live = issueRunToken(base);
    vi.advanceTimersByTime(20 * 60_000);
    expect(validateRunToken(live, 'other-job')).toEqual({ ok: false });
    expect(validateRunToken(live, base.jobId).ok).toBe(true);
    vi.advanceTimersByTime(20 * 60_000);
    expect(validateRunToken(live, base.jobId).ok).toBe(true);
  });

  it('rejects an unvalidated token after the 30-minute TTL', () => {
    const token = issueRunToken(base);
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(validateRunToken(token, base.jobId)).toEqual({ ok: false });
  });

  it('slides the TTL window on each successful validation', () => {
    const token = issueRunToken(base);
    vi.advanceTimersByTime(20 * 60_000);
    expect(validateRunToken(token, base.jobId).ok).toBe(true);
    // 40 min from issue — dead without a slide; live because validate at t=20 reset the window.
    vi.advanceTimersByTime(20 * 60_000);
    expect(validateRunToken(token, base.jobId).ok).toBe(true);
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(validateRunToken(token, base.jobId).ok).toBe(false);
  });

  it('revokes a single token', () => {
    const token = issueRunToken(base);
    revokeRunToken(token);
    expect(validateRunToken(token, base.jobId)).toEqual({ ok: false });
  });

  it('revokes all tokens for a run', () => {
    const t1 = issueRunToken(base);
    const t2 = issueRunToken({ ...base, runId: 'run-1' });
    const t3 = issueRunToken({ ...base, runId: 'run-2' });
    revokeRunTokensForRun('run-1');
    expect(validateRunToken(t1, base.jobId).ok).toBe(false);
    expect(validateRunToken(t2, base.jobId).ok).toBe(false);
    expect(validateRunToken(t3, base.jobId).ok).toBe(true);
  });

  it('rebinds a live token to a new conversationId, keeping the same string', () => {
    const token = issueRunToken(base);
    rebindRunToken(token, 'conv-child');
    expect(validateRunToken(token, base.jobId)).toEqual({
      ok: true,
      jobId: base.jobId,
      runId: base.runId,
      conversationId: 'conv-child',
    });
  });

  it('rebind is a no-op for an unknown token', () => {
    expect(() => rebindRunToken('nope', 'conv-child')).not.toThrow();
  });

  it('redacts live token values from text', () => {
    const token = issueRunToken(base);
    const text = `Bearer ${token} in logs`;
    expect(redactRunTokens(text)).toBe('Bearer [REDACTED] in logs');
  });
});
