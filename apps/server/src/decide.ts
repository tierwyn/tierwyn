import type { DecisionSettings } from '@tierwyn/shared';
import type { DecisionUsageRow } from './repositories/decisionUsage.js';

export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };
/** Closed union so the `[decide]` log label can never carry free text. */
export type DecideConsumer = 'notify' | 'autotag' | 'memory' | 'test';
export interface DecideResult { answers: Record<string, Answer>; model: string; latencyMs: number }

/** Test seam, like notifierDeps. */
export const decideDeps = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  /** Set at boot (index.ts) to persist a usage row. Default no-op keeps tests / db-less callers working. */
  record: (_row: DecisionUsageRow): void => {},
};

const MAX_ATTEMPTS = 3;

function validAnswer(q: Question, a: unknown): a is Answer {
  const x = a as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || x.type !== q.type) return false;
  if (q.type === 'noul') return typeof x.noul === 'number';
  if (q.type === 'choice') return typeof x.choice === 'string' && typeof x.confidence === 'number';
  return typeof x.score === 'number' && typeof x.confidence === 'number';
}

const unit = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 1;
/** Scores are small ordinal levels (criteria list length); 10 is a generous sane bound. */
const SCORE_MAX = 10;
/** Out-of-range numbers make an answer absent (callers treat absent as "notify"); NaN fails every comparison. */
function inRange(a: Answer): boolean {
  if (a.type === 'noul') return unit(a.noul);
  if (a.type === 'choice') return unit(a.confidence);
  return typeof a.score === 'number' && a.score >= 0 && a.score <= SCORE_MAX && unit(a.confidence);
}

/** Non-negative integer or undefined — garbage (strings, NaN, negatives) must not reach the ledger. */
const token = (n: unknown): number | undefined => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : undefined);

/**
 * Throws with a safe reason string ('http 401', 'timeout', 'bad response', …). Never includes key/state.
 * Records exactly one usage row per invocation (not per retry attempt); a recording failure never changes the outcome.
 */
export async function callSystemOne(
  settings: DecisionSettings,
  state: unknown,
  questions: Record<string, Question>,
  timeoutMs = 2000,
  consumer: DecideConsumer = 'test',
  conversationId?: string,
): Promise<DecideResult> {
  const started = decideDeps.now();
  const usage: { input?: number; output?: number } = {};
  let outcome = 'ok';
  try {
    return await callUnrecorded(settings, state, questions, timeoutMs, consumer, started, usage);
  } catch (e) {
    // Only the reasons callUnrecorded throws are ledger-safe; anything else (a TypeError message) collapses.
    const msg = e instanceof Error ? e.message : '';
    outcome = /^(timeout|network error|bad response|http \d+)$/.test(msg) ? msg : 'error';
    throw e;
  } finally {
    try {
      decideDeps.record({
        ts: started, consumer, conversationId, model: settings.model,
        inputTokens: usage.input, outputTokens: usage.output,
        latencyMs: Math.max(0, decideDeps.now() - started), outcome,
      });
    } catch { /* fail-closed: a ledger error must never change Jev's answer */ }
  }
}

async function callUnrecorded(
  settings: DecisionSettings,
  state: unknown,
  questions: Record<string, Question>,
  timeoutMs: number,
  consumer: DecideConsumer,
  started: number,
  usage: { input?: number; output?: number },
): Promise<DecideResult> {
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/v1/systemone`;
  const deadline = started + timeoutMs;
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: settings.model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  };

  let res: Response | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      res = await decideDeps.fetch(url, init);
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      throw new Error(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error');
    }
    if (res.ok) break;
    void res.body?.cancel().catch(() => {});
    if ((res.status !== 429 && res.status !== 529) || attempt === MAX_ATTEMPTS - 1) {
      throw new Error(`http ${res.status}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
    if (decideDeps.now() + delay > deadline) throw new Error(`http ${res.status}`);
    await decideDeps.sleep(delay);
  }
  if (!res?.ok) throw new Error('bad response');

  let body: { answers?: unknown; model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  try {
    body = await res.json() as typeof body;
  } catch {
    throw new Error('bad response');
  }
  // Captured before validation: a 200 that fails validation was still billed by TypeSafe.
  usage.input = token(body?.usage?.input_tokens);
  usage.output = token(body?.usage?.output_tokens);
  // A response from a different model than the pinned one is not trusted at all.
  if (body.model !== undefined && body.model !== settings.model) throw new Error('bad response');
  const answers = body.answers as Record<string, unknown> | undefined;
  if (!answers || typeof answers !== 'object') throw new Error('bad response');
  for (const [key, q] of Object.entries(questions)) {
    if (!validAnswer(q, answers[key])) throw new Error('bad response');
    if (!inRange(answers[key] as Answer)) delete answers[key];
  }
  // Keys that were never asked are unvalidated; no consumer may see them.
  for (const key of Object.keys(answers)) if (!Object.hasOwn(questions, key)) delete answers[key];
  const latencyMs = decideDeps.now() - started;
  const model = typeof body.model === 'string' ? body.model : settings.model;
  console.log(`[decide] consumer=${consumer} model=${model} in=${usage.input ?? '?'} ms=${latencyMs}`);
  return { answers: answers as Record<string, Answer>, model, latencyMs };
}

/** Fail-closed wrapper: null when disabled / no key / any error. Never throws. */
export async function decide(
  state: unknown,
  questions: Record<string, Question>,
  opts: { settings: DecisionSettings; timeoutMs?: number; consumer: DecideConsumer; conversationId?: string },
): Promise<DecideResult | null> {
  if (!opts.settings.enabled || !opts.settings.apiKey) return null;
  try {
    return await callSystemOne(opts.settings, state, questions, opts.timeoutMs, opts.consumer, opts.conversationId);
  } catch (e) {
    console.warn(`[decide] consumer=${opts.consumer} failed:`, e instanceof Error ? e.message : 'error');
    return null;
  }
}
