import { describe, expect, it } from 'vitest';
import { isWrappingUp, resolveEffectiveStatus } from './effectiveStatus.js';

describe('resolveEffectiveStatus', () => {
  it('keeps WS running/waiting as live', () => {
    expect(resolveEffectiveStatus({
      wsStatus: 'running', eventsStatus: 'idle', staleRunning: false,
    })).toBe('running');
    expect(resolveEffectiveStatus({
      wsStatus: 'waiting', eventsStatus: 'running', staleRunning: false,
    })).toBe('waiting');
  });

  it('treats zombie transcript running as idle when the socket is up and no live session', () => {
    expect(resolveEffectiveStatus({
      wsStatus: undefined, eventsStatus: 'running', staleRunning: true,
    })).toBe('idle');
  });

  it('keeps sticky WS error unless the transcript already shows a later success', () => {
    expect(resolveEffectiveStatus({
      wsStatus: 'error', eventsStatus: 'running', staleRunning: false,
    })).toBe('error');
    expect(resolveEffectiveStatus({
      wsStatus: 'error', eventsStatus: 'done', staleRunning: false,
    })).toBe('done');
  });

  it('does not treat a buffered running event as live after the WS map was cleared (hold-open done)', () => {
    // conversation_updated { status: 'done' } deletes conversationStatuses[id]
    // immediately, but the matching status event may still sit in the rAF
    // buffer. currentSessionId is still set (parked subprocess) so staleRunning
    // is false — without this, isRunning stays true and Send steers into the
    // session the scheduler is about to stop.
    expect(resolveEffectiveStatus({
      wsStatus: undefined,
      eventsStatus: 'running',
      staleRunning: false,
    })).toBe('idle');
    expect(resolveEffectiveStatus({
      wsStatus: undefined,
      eventsStatus: 'waiting',
      staleRunning: false,
    })).toBe('idle');
  });

  it('still surfaces transcript done/idle/error when the WS map is empty', () => {
    expect(resolveEffectiveStatus({
      wsStatus: undefined, eventsStatus: 'done', staleRunning: false,
    })).toBe('done');
    expect(resolveEffectiveStatus({
      wsStatus: undefined, eventsStatus: 'idle', staleRunning: false,
    })).toBe('idle');
    expect(resolveEffectiveStatus({
      wsStatus: undefined, eventsStatus: 'error', staleRunning: false,
    })).toBe('error');
  });
});

describe('isWrappingUp', () => {
  const base = {
    connected: true, effectiveStatus: 'idle' as const,
    eventsStatus: 'running' as const, hasCurrentSession: true,
  };

  it('fires in the hold-open teardown window (map cleared, buffer still streaming, session addressable)', () => {
    expect(isWrappingUp(base)).toBe(true);
    expect(isWrappingUp({ ...base, eventsStatus: 'waiting' })).toBe(true);
  });

  it('never fires while the WS map says live, or once the buffer drained', () => {
    expect(isWrappingUp({ ...base, effectiveStatus: 'running' })).toBe(false);
    expect(isWrappingUp({ ...base, effectiveStatus: 'waiting' })).toBe(false);
    expect(isWrappingUp({ ...base, eventsStatus: 'done' })).toBe(false);
    expect(isWrappingUp({ ...base, effectiveStatus: 'error', eventsStatus: 'running' })).toBe(false);
  });

  it('never fires for zombie sessions (no addressable session) or when disconnected', () => {
    expect(isWrappingUp({ ...base, hasCurrentSession: false })).toBe(false);
    expect(isWrappingUp({ ...base, connected: false })).toBe(false);
  });
});
