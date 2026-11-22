import { randomUUID } from 'crypto';
import type { AgentAdapter, NormalisedEvent } from '@tierwyn/shared';
import type { AdapterFactoryOpts } from '../registry.js';
import type { CompactRunner } from './compactor.js';

// A summariser does exactly one turn: prompt in → summary out → status:done.
// Resolve on that terminal status (NOT on 'end'): adapters that keep their
// subprocess alive between turns emit 'done' but only emit 'end' when the
// child process closes, which never happens here because the runner provides
// no getNextSteer loop. Waiting for 'end' made every summarised handoff hang
// for the full timeout (~2 min) and leaked the subprocess (the orphan-PID
// symptom the watchdogs chased). We stop() the adapter on every exit path
// to kill that subprocess at the right layer.
//
// The timeout stays as a last-resort backstop: if a summariser never even
// reaches 'done' (truly stuck / rate-limited silent-retry), it must not wedge
// the user turn forever — buildResumePlan awaits this before the target adapter
// starts. On timeout we reject; compact() tries the fallback profile; if that
// also fails, buildResumePlan falls back to a capped transcript slice.
const DEFAULT_TIMEOUT_MS = 120_000;

// ponytail: Linux MAX_ARG_STRLEN is 128 KiB per argv string. Argv-based oneShot
// (claude -p, pi, copilot, cursor) fails with E2BIG above that. If an adapter
// grows a stdin-fed oneShot, raise this or drop the gate.
export const ONESHOT_PROMPT_MAX_BYTES = 120_000;

// ponytail: `none` is flag-enforced on these (claude `--tools ''`,
// pi `--no-tools`, copilot `--available-tools ''`). cursor only
// fails *after* a tool is invoked, so it stays on the session path.
const ONESHOT_NONE_ADAPTERS = new Set(['claude-code', 'pi', 'copilot']);
const TEXT_ONLY_SESSION_ADAPTERS = new Set(['claude-code']);

export function makeAdapterRunner(deps: {
  createAdapter: (agentType: string, opts?: AdapterFactoryOpts) => AgentAdapter;
  resolveModel: (profileId: string) => string;
  cwd?: string;
  timeoutMs?: number;
  /** When true, never start a session that could have tools. BTW priming only. */
  toolFreeOnly?: boolean;
}): CompactRunner {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (profileId, prompt) => {
    const agentType = profileId.split(':')[0]!;
    // Summarisers are one-shot, text-only, non-interactive — never inherit the
    // operator's permission mode (questions/prompt) or they'll stall on gates.
    const adapter = deps.createAdapter(agentType, { interactionMode: 'bypass' });
    const model = deps.resolveModel(profileId);
    const modes = adapter.oneShotModes ?? ['none'];
    const canOneShot = typeof adapter.oneShot === 'function'
      && modes.includes('none')
      && Buffer.byteLength(prompt) <= ONESHOT_PROMPT_MAX_BYTES
      && ONESHOT_NONE_ADAPTERS.has(agentType);
    if (canOneShot) {
      const result = await adapter.oneShot!(prompt, {
        mode: 'none',
        model,
        ...(deps.cwd ? { cwd: deps.cwd } : {}),
        timeoutSecs: Math.ceil(timeoutMs / 1000),
      });
      return result.text;
    }

    if (deps.toolFreeOnly && !TEXT_ONLY_SESSION_ADAPTERS.has(agentType)) {
      throw new Error(
        `compaction summariser ${profileId} cannot run tool-free `
        + `(adapter ${agentType} has no enforced none-mode oneShot and does not honour textOnly)`,
      );
    }

    const sessionId = randomUUID();
    const emitter = adapter.streamEvents();

    let summary = '';
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (run: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void adapter.stop?.(); // kill the (possibly still-alive) summariser subprocess
        run();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error(`compaction summariser timed out after ${Math.round(timeoutMs / 1000)}s`))),
        timeoutMs,
      );

      emitter.on('event', (e: NormalisedEvent) => {
        if (e.type === 'message') summary += String(e.payload.chunk ?? '');
        else if (e.type === 'status' && e.payload.status === 'done') settle(() => resolve(summary));
        else if (e.type === 'status' && e.payload.status === 'error') settle(() => reject(new Error('summariser reported error')));
      });
      emitter.on('error', (err: Error) => settle(() => reject(err)));
      emitter.once('end', () => settle(() => resolve(summary)));

      adapter.start({ sessionId, conversationId: '', cwd: deps.cwd ?? process.cwd(), model, textOnly: true })
        .then(() => adapter.sendPrompt(prompt, [], model))
        .catch((err) => settle(() => reject(err)));
    });
  };
}
