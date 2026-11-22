import { windowSizeForModel, defaultContextWindowForModel } from '@tierwyn/shared';

let lookup: ((agentId: string, modelName: string) => number | undefined) | undefined;

export function setCatalogueContextWindowLookup(fn: typeof lookup): void {
  lookup = fn;
}

/**
 * FW-7: coerce a context-window value to something safe to persist or compare.
 *
 * Returns null (= "unknown") for undefined, non-finite, or non-positive input.
 * A 0 must NEVER be stored: computeContextWindowPct() already treats
 * non-positive as unknown, so a stored 0 would look identical to a real
 * zero-size window while silently suppressing the percentage forever.
 */
export function normaliseContextWindow(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * FW-7: resolve a model's context window, in precedence order:
 *   1. live adapter listModels() hit  — freshest
 *   2. the catalogue-persisted window (agent_models.context_window)
 *   3. defaultContextWindowForModel() — Anthropic naming regex, a guess
 *
 * Deliberately NOT `resolveContextWindowSize(live, model)` then the DB: that
 * shared helper folds (3) in, which would let the naming guess beat a persisted,
 * adapter-advertised number.
 *
 * The try/catch wraps ONLY the live lookup, so an adapter that is missing from
 * PATH, times out, or returns [] still reaches (2) — that failure mode is the
 * entire reason FW-7 exists. Returns undefined when all three miss; callers must
 * not fabricate a percentage from an unknown window.
 */
export async function resolveContextWindowWithFallback(args: {
  modelName: string;
  storedContextWindow?: number;
  listModels: () => Promise<{ name: string; contextWindow?: number }[]>;
}): Promise<number | undefined> {
  let live: number | undefined;
  try {
    live = windowSizeForModel(await args.listModels(), args.modelName);
  } catch { /* adapter unavailable — fall through to the persisted value */ }

  return normaliseContextWindow(live)
    ?? normaliseContextWindow(args.storedContextWindow)
    ?? defaultContextWindowForModel(args.modelName);
}

/**
 * Catalogue-persisted window for (agentId, modelName), any source
 * (seed / discovered / user). This is what lets an operator-added model get a
 * live context-% from the adapter instead of only seed rows from
 * agent-profiles.json. Returns undefined when the DB is not initialised
 * (unit tests, node daemon) or no row carries a window.
 */
export function catalogueContextWindow(agentId: string, modelName: string): number | undefined {
  try {
    return normaliseContextWindow(lookup?.(agentId, modelName)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Adapter-side resolution: live listModels → catalogue DB → naming default. */
export function adapterContextWindow(
  agentId: string,
  models: { name: string; contextWindow?: number }[],
  modelName: string,
): number | undefined {
  return normaliseContextWindow(windowSizeForModel(models, modelName))
    ?? catalogueContextWindow(agentId, modelName)
    ?? defaultContextWindowForModel(modelName);
}
