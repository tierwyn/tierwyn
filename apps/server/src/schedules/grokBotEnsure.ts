import type { GrokBotLifecycleStatus } from '@tierwyn/shared';

/** Minimal supervisor surface the schedule fire pre-check needs. */
export interface GrokBotEnsureSupervisor {
  ensureRunning(reason: 'on-demand'): Promise<GrokBotLifecycleStatus>;
  status(): GrokBotLifecycleStatus;
}

/**
 * Fire-time Grok Bot pre-check (D2/A5): kick an on-demand launch without
 * awaiting it, then return the live non-blocking `status()`.
 *
 * `ensureRunning` waits for the whole launch and never resolves as `starting`.
 * Awaiting it from the scheduler tick would stall the poll (~30 s+) or trip
 * the short race and fail every cold start. The supervisor marks a launchable
 * app `starting` synchronously when leaving `stopped` (before the CDP probe
 * await), so this immediate `status()` read sees in-progress; `handlePrompt`'s
 * `_awaitSupervisor` joins the same in-flight launch for the slow path.
 * Attach `.catch` so a rejected launch cannot become an Express-4 unhandled
 * rejection. Dispatch wraps this in a 5 s race only as a wedged-read net.
 */
export function bindEnsureGrokBot(
  supervisor: GrokBotEnsureSupervisor,
): () => Promise<GrokBotLifecycleStatus> {
  return async () => {
    void supervisor.ensureRunning('on-demand').catch(() => {});
    return supervisor.status();
  };
}
