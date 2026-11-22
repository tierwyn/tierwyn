import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  insertDecisionUsage, summariseDecisionUsage, pruneDecisionUsage, JEV_INPUT_USD_PER_MTOK,
  type DecisionUsageRow,
} from './decisionUsage.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);
function setup() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}
const row = (o: Partial<DecisionUsageRow> = {}): DecisionUsageRow => ({
  ts: NOW, consumer: 'notify', model: 'jev-1.13.0', inputTokens: 100, outputTokens: 5, latencyMs: 80, outcome: 'ok', ...o,
});

describe('decisionUsage repository', () => {
  it('stores nullable conversation id / tokens', () => {
    const db = setup();
    insertDecisionUsage(db, row({ conversationId: 'c1' }));
    insertDecisionUsage(db, row({ inputTokens: undefined, outputTokens: undefined, outcome: 'timeout' }));
    const rows = db.prepare('SELECT conversation_id c, input_tokens i, output_tokens o FROM decision_usage ORDER BY id').all();
    expect(rows).toEqual([{ c: 'c1', i: 100, o: 5 }, { c: null, i: null, o: null }]);
  });

  it('empty table → zeros', () => {
    expect(summariseDecisionUsage(setup(), 0)).toEqual({
      since: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, missingUsage: 0, byConsumer: [], errors: [],
    });
  });

  it('prices 1,000,000 input tokens at exactly $0.042', () => {
    const db = setup();
    insertDecisionUsage(db, row({ inputTokens: 1_000_000 }));
    const s = summariseDecisionUsage(db, 0);
    expect(JEV_INPUT_USD_PER_MTOK).toBe(0.042);
    expect(s.costUsd).toBe(0.042);
    expect(s.byConsumer[0]!.costUsd).toBe(0.042);
  });

  it('groups per consumer, counts NULL tokens as missingUsage, groups errors excluding ok', () => {
    const db = setup();
    insertDecisionUsage(db, row({ consumer: 'notify', inputTokens: 300 }));
    insertDecisionUsage(db, row({ consumer: 'notify', inputTokens: 200, outputTokens: undefined }));
    insertDecisionUsage(db, row({ consumer: 'notify', inputTokens: undefined, outputTokens: undefined })); // ok, no usage
    insertDecisionUsage(db, row({ consumer: 'autotag', inputTokens: 50 }));
    for (let i = 0; i < 3; i++) insertDecisionUsage(db, row({ consumer: 'autotag', inputTokens: undefined, outputTokens: undefined, outcome: 'http 429' }));
    insertDecisionUsage(db, row({ consumer: 'test', inputTokens: undefined, outputTokens: undefined, outcome: 'timeout' }));
    const s = summariseDecisionUsage(db, 0);
    expect(s.calls).toBe(8);
    expect(s.inputTokens).toBe(550);
    expect(s.outputTokens).toBe(10);
    expect(s.missingUsage).toBe(5);
    expect(s.byConsumer.map((c) => [c.consumer, c.calls, c.inputTokens])).toEqual([
      ['autotag', 4, 50], ['notify', 3, 500], ['test', 1, 0],
    ]);
    expect(s.errors).toEqual([{ outcome: 'http 429', count: 3 }, { outcome: 'timeout', count: 1 }]);
    expect(s.costUsd).toBeCloseTo(550 / 1e6 * 0.042, 12);
  });

  it('since filter excludes older rows', () => {
    const db = setup();
    insertDecisionUsage(db, row({ ts: NOW - 40 * DAY }));
    insertDecisionUsage(db, row({ ts: NOW - 1 * DAY }));
    expect(summariseDecisionUsage(db, NOW - 30 * DAY).calls).toBe(1);
    expect(summariseDecisionUsage(db, 0).calls).toBe(2);
  });

  it('prune deletes only rows older than the cutoff', () => {
    const db = setup();
    insertDecisionUsage(db, row({ ts: NOW - 100 * DAY }));
    insertDecisionUsage(db, row({ ts: NOW - 10 * DAY }));
    expect(pruneDecisionUsage(db, NOW - 90 * DAY)).toBe(1);
    expect(summariseDecisionUsage(db, 0).calls).toBe(1);
  });
});
