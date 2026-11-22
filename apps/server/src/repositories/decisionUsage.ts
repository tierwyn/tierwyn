import type { Database } from 'better-sqlite3';
import type { DecisionUsageSummary } from '@tierwyn/shared';

export interface DecisionUsageRow {
  ts: number;
  consumer: string;
  conversationId?: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  /** 'ok' or the safe error reason from callSystemOne — never bodies, keys or state. */
  outcome: string;
}

/** TypeSafe System One input price; output is free. Cost is computed at read time, so a price change re-prices history. */
// ponytail: single price; move to DecisionSettings if TypeSafe adds per-model pricing
export const JEV_INPUT_USD_PER_MTOK = 0.042;

const cost = (inputTokens: number) => (inputTokens / 1e6) * JEV_INPUT_USD_PER_MTOK;

export function insertDecisionUsage(db: Database, r: DecisionUsageRow): void {
  db.prepare(
    `INSERT INTO decision_usage (ts, consumer, conversation_id, model, input_tokens, output_tokens, latency_ms, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.ts, r.consumer, r.conversationId ?? null, r.model, r.inputTokens ?? null, r.outputTokens ?? null, r.latencyMs, r.outcome);
}

export function summariseDecisionUsage(db: Database, sinceMs: number): Omit<DecisionUsageSummary, 'windowLabel'> {
  const rows = db.prepare(
    `SELECT consumer, COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens,
            SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS missingUsage
       FROM decision_usage WHERE ts >= ? GROUP BY consumer ORDER BY calls DESC, consumer`,
  ).all(sinceMs) as { consumer: string; calls: number; inputTokens: number; outputTokens: number; missingUsage: number }[];
  const errors = db.prepare(
    `SELECT outcome, COUNT(*) AS count FROM decision_usage
      WHERE ts >= ? AND outcome != 'ok' GROUP BY outcome ORDER BY count DESC, outcome`,
  ).all(sinceMs) as { outcome: string; count: number }[];
  const sum = (k: 'calls' | 'inputTokens' | 'outputTokens' | 'missingUsage') => rows.reduce((a, r) => a + r[k], 0);
  const inputTokens = sum('inputTokens');
  return {
    since: sinceMs,
    calls: sum('calls'),
    inputTokens,
    outputTokens: sum('outputTokens'),
    costUsd: cost(inputTokens),
    missingUsage: sum('missingUsage'),
    byConsumer: rows.map((r) => ({ consumer: r.consumer, calls: r.calls, inputTokens: r.inputTokens, costUsd: cost(r.inputTokens) })),
    errors,
  };
}

export function pruneDecisionUsage(db: Database, olderThanMs: number): number {
  return db.prepare('DELETE FROM decision_usage WHERE ts < ?').run(olderThanMs).changes;
}
