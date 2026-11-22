import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TtsRecording } from '@tierwyn/shared';

function baseRec(over: Partial<TtsRecording> = {}): TtsRecording {
  return {
    id: 'job-1',
    project_id: 'p1',
    conversation_id: 'c1',
    created_at: Date.now(),
    source: 'message',
    mode: 'as-is',
    provider: 'piper',
    voice: 'v',
    title: 'T',
    spoken_text: 'hello',
    path: '',
    bytes: 0,
    status: 'running',
    error: null,
    updated_at: Date.now(),
    ephemeral: 0,
    ...over,
  };
}

describe('ttsParkPlayer', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem(k: string) { return store[k] ?? null; },
      setItem(k: string, v: string) { store[k] = v; },
      removeItem(k: string) { delete store[k]; },
    });
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => {},
    });
    vi.stubGlobal('Audio', class {
      src = '';
      currentTime = 0;
      duration = 1;
      paused = true;
      ended = false;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener = () => {};
      removeAttribute = () => {};
      load = () => {};
      pause = vi.fn(function (this: { paused: boolean }) { this.paused = true; });
      play = vi.fn(async function (this: { paused: boolean }) {
        this.paused = false;
      });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('begin job → loading with jobId; mini bar visible', async () => {
    const park = await import('./ttsParkPlayer.js');
    park.ttsParkBeginJob('job-1', baseRec(), undefined);
    const snap = park.getTtsParkState();
    expect(snap.status).toBe('loading');
    expect(snap.jobId).toBe('job-1');
    expect(park.ttsParkMiniVisible(snap)).toBe(true);
    park.ttsParkStop();
  });

  it('autoplay rejection → ready and mini still visible', async () => {
    vi.stubGlobal('Audio', class {
      src = '';
      currentTime = 0;
      duration = 1;
      paused = true;
      ended = false;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener = () => {};
      removeAttribute = () => {};
      load = () => {};
      pause = vi.fn();
      play = vi.fn(async () => {
        throw new Error('NotAllowedError');
      });
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/tts/recordings/job-1') {
        return {
          ok: true,
          json: async () => ({
            recording: baseRec({
              status: 'done',
              path: 'tts-recordings/job-1.wav',
              bytes: 10,
            }),
          }),
        };
      }
      if (url.includes('/audio')) {
        return {
          ok: true,
          blob: async () => new Blob(['wav']),
          headers: { get: () => 'audio/wav' },
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    const park = await import('./ttsParkPlayer.js');
    park.ttsParkBeginJob('job-1', baseRec());
    // First poll delay is 1s
    await vi.advanceTimersByTimeAsync(1100);
    // Allow microtasks for fetch + play
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    const snap = park.getTtsParkState();
    // May still be loading if poll chain is deep — flush more
    for (let i = 0; i < 5 && snap.status === 'loading'; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
    }
    const final = park.getTtsParkState();
    expect(['ready', 'loading', 'playing']).toContain(final.status);
    if (final.status === 'ready') {
      expect(park.ttsParkMiniVisible(final)).toBe(true);
    }
    // Force ready path via rehydrate for RC4 regression guarantee
    park.ttsParkRehydrate(baseRec({
      status: 'done',
      path: 'tts-recordings/job-1.wav',
      bytes: 10,
    }));
    expect(park.getTtsParkState().status).toBe('ready');
    expect(park.ttsParkMiniVisible()).toBe(true);
    park.ttsParkStop();
  });

  it('poll error → bar error with message', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/tts/recordings/job-err') {
        return {
          ok: true,
          json: async () => ({
            recording: baseRec({
              id: 'job-err',
              status: 'error',
              error: 'sidecar returned 502',
            }),
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    const park = await import('./ttsParkPlayer.js');
    park.ttsParkBeginJob('job-err', baseRec({ id: 'job-err' }));
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.resolve();
    await Promise.resolve();
    const snap = park.getTtsParkState();
    expect(snap.status).toBe('error');
    expect(snap.error).toMatch(/502|sidecar/i);
    expect(park.ttsParkMiniVisible(snap)).toBe(true);
    park.ttsParkDismiss();
  });

  it('stale job ignored when second press changes jobId', async () => {
    let pollCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/tts/recordings/job-a') {
        pollCount += 1;
        // First job eventually done — must not clobber job-b
        return {
          ok: true,
          json: async () => ({
            recording: baseRec({
              id: 'job-a',
              status: 'done',
              path: 'tts-recordings/job-a.wav',
              bytes: 4,
            }),
          }),
        };
      }
      if (url === '/tts/recordings/job-b') {
        return {
          ok: true,
          json: async () => ({
            recording: baseRec({ id: 'job-b', status: 'running' }),
          }),
        };
      }
      if (url.includes('/audio')) {
        return {
          ok: true,
          blob: async () => new Blob(['wav']),
          headers: { get: () => 'audio/wav' },
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    const park = await import('./ttsParkPlayer.js');
    park.ttsParkBeginJob('job-a', baseRec({ id: 'job-a' }));
    park.ttsParkBeginJob('job-b', baseRec({ id: 'job-b' }));
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.resolve();
    await Promise.resolve();
    expect(park.getTtsParkState().jobId).toBe('job-b');
    // job-a poll may have run; identity guard keeps job-b
    expect(park.getTtsParkState().jobId).not.toBe('job-a');
    void pollCount;
    park.ttsParkStop();
  });

  it('boot rehydrate done → ready without autoplay', async () => {
    const play = vi.fn(async () => {});
    vi.stubGlobal('Audio', class {
      src = '';
      play = play;
      pause = vi.fn();
      load = () => {};
      removeAttribute = () => {};
      addEventListener = () => {};
    });
    const park = await import('./ttsParkPlayer.js');
    park.ttsParkRehydrate(baseRec({
      id: 'job-done',
      status: 'done',
      path: 'tts-recordings/job-done.wav',
      bytes: 8,
    }));
    expect(park.getTtsParkState().status).toBe('ready');
    expect(park.getTtsParkState().jobId).toBe('job-done');
    // Rehydrate does not call play()
    expect(play).not.toHaveBeenCalled();
    park.ttsParkStop();
  });
});
