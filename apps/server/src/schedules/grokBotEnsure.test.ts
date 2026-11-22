import { describe, it, expect, vi } from 'vitest';
import type { GrokBotLifecycleStatus } from '@tierwyn/shared';
import { bindEnsureGrokBot } from './grokBotEnsure.js';

function status(over: Partial<GrokBotLifecycleStatus> = {}): GrokBotLifecycleStatus {
  return {
    state: 'stopped',
    enabled: true,
    autoStart: 'on-demand',
    envLocks: { autostart: false, watch: false },
    launcher: null,
    attribution: null,
    layout: 'native',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    lastErrorAt: null,
    since: 1,
    ...over,
  };
}

describe('bindEnsureGrokBot', () => {
  it('kicks ensureRunning once without awaiting and returns live status', async () => {
    const ensureRunning = vi.fn(
      (_reason: 'on-demand') => new Promise<GrokBotLifecycleStatus>(() => {}),
    );
    const live = status({ state: 'starting' });
    const statusFn = vi.fn(() => live);
    const ensure = bindEnsureGrokBot({ ensureRunning, status: statusFn });
    const result = await ensure();
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(ensureRunning).toHaveBeenCalledWith('on-demand');
    expect(statusFn).toHaveBeenCalled();
    expect(result).toEqual(live);
  });

  it('swallows ensureRunning rejection (no unhandled rejection)', async () => {
    const ensureRunning = vi.fn(async () => {
      throw new Error('launch blew up');
    });
    const ensure = bindEnsureGrokBot({
      ensureRunning,
      status: () => status({ state: 'failed', lastError: 'launch blew up' }),
    });
    await expect(ensure()).resolves.toMatchObject({ state: 'failed' });
    // Let the rejected promise's .catch run.
    await Promise.resolve();
  });
});
