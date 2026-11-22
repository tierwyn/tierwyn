import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { auth } from './api.js';

describe('auth.session', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('sends credentials: include, cache: no-store, and an AbortSignal', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ authenticated: true, configured: true }),
    });
    const res = await auth.session();
    expect(res).toEqual({ authenticated: true, configured: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/auth/session');
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects on non-OK status (e.g. 502 from reverse proxy)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    });
    await expect(auth.session()).rejects.toThrow(/502/);
  });

  it('aborts and rejects when the request hangs past timeoutMs', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    );

    const pending = auth.session(250);
    // Attach rejection handler before advancing timers so Node does not emit unhandledRejection.
    const assertion = expect(pending).rejects.toThrow(/Aborted/);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });
});
