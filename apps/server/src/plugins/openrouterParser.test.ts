import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../plugin-src/openrouter-usage/index.js');
const plugin = await import(pluginPath) as {
  parseOpenRouterKeyJson: (raw: unknown) => {
    label?: string;
    limit?: number;
    limitRemaining?: number;
    usage?: number;
    isFreeTier?: boolean;
  };
  parseOpenRouterCreditsJson: (raw: unknown) => {
    totalCredits: number;
    totalUsage: number;
    remaining: number;
  };
  parseKeyList: (value: unknown) => Array<{ name?: string; key: string }>;
  buildOpenRouterUsage: (
    entries: Array<{ name?: string; key?: string; raw?: unknown; error?: string }>,
    accountRaw: unknown,
    nowMs: number,
  ) => {
    fetchedAt: number;
    plan?: string;
    groups: Array<{
      id: string;
      label: string;
      creditsUsed?: number;
      creditsLimit?: number;
      monthlyPct?: number;
      monthlyWindowLabel?: string;
      prepaidBalance?: number;
    }>;
    creditsUsed?: number;
    creditsLimit?: number;
    monthlyPct?: number;
    monthlyWindowLabel?: string;
    prepaidBalance?: number;
  };
};

// -- Fixtures ----------------------------------------------------------------

const CAPPED_KEY_BODY = {
  data: {
    label: 'laptop-key',
    limit: 10,
    limit_remaining: 6,
    usage: 4,
    is_free_tier: false,
  },
};

const UNCAPPED_KEY_BODY = {
  data: {
    label: 'ci-key',
    limit: null,
    limit_remaining: null,
    usage: 3.5,
    is_free_tier: false,
  },
};

const CREDITS_BODY = {
  data: {
    total_credits: 100.5,
    total_usage: 25.75,
  },
};

// -- parseOpenRouterKeyJson --------------------------------------------------

describe('parseOpenRouterKeyJson', () => {
  it('parses a capped key response (happy path)', () => {
    const r = plugin.parseOpenRouterKeyJson(CAPPED_KEY_BODY);
    expect(r).toEqual({
      label: 'laptop-key',
      limit: 10,
      limitRemaining: 6,
      usage: 4,
      isFreeTier: false,
    });
  });

  it('handles limit: null / limit_remaining: null (uncapped key)', () => {
    const r = plugin.parseOpenRouterKeyJson(UNCAPPED_KEY_BODY);
    expect(r.limit).toBeUndefined();
    expect(r.limitRemaining).toBeUndefined();
    expect(r.usage).toBe(3.5);
  });

  it('coerces numeric strings (schema drift)', () => {
    const r = plugin.parseOpenRouterKeyJson({
      data: { limit: '10', usage: '4.5', limit_remaining: '5.5' },
    });
    expect(r.limit).toBe(10);
    expect(r.usage).toBe(4.5);
    expect(r.limitRemaining).toBe(5.5);
  });

  it('throws on null, {}, and { data: null }', () => {
    expect(() => plugin.parseOpenRouterKeyJson(null)).toThrow('openrouter key: empty response');
    expect(() => plugin.parseOpenRouterKeyJson({})).toThrow('openrouter key: missing data');
    expect(() => plugin.parseOpenRouterKeyJson({ data: null })).toThrow('openrouter key: missing data');
  });
});

// -- parseOpenRouterCreditsJson ----------------------------------------------

describe('parseOpenRouterCreditsJson', () => {
  it('computes remaining = total_credits - total_usage (happy path)', () => {
    const r = plugin.parseOpenRouterCreditsJson(CREDITS_BODY);
    expect(r.totalCredits).toBe(100.5);
    expect(r.totalUsage).toBe(25.75);
    expect(r.remaining).toBeCloseTo(74.75);
  });

  it('throws on missing or non-numeric data', () => {
    expect(() => plugin.parseOpenRouterCreditsJson(null)).toThrow('openrouter credits: empty response');
    expect(() => plugin.parseOpenRouterCreditsJson({})).toThrow('openrouter credits: missing data');
    expect(() => plugin.parseOpenRouterCreditsJson({ data: { total_credits: 'abc' } })).toThrow('openrouter credits: missing data');
  });
});

// -- parseKeyList ------------------------------------------------------------

describe('parseKeyList', () => {
  it('1. legacy single bare key → [{ key }], no name', () => {
    const r = plugin.parseKeyList('sk-or-v1-aaa');
    expect(r).toEqual([{ key: 'sk-or-v1-aaa' }]);
    expect(r[0]).not.toHaveProperty('name');
  });

  it('2. comma list of bare keys → order preserved, no names', () => {
    const r = plugin.parseKeyList('sk-a,sk-b,sk-c');
    expect(r).toEqual([{ key: 'sk-a' }, { key: 'sk-b' }, { key: 'sk-c' }]);
    r.forEach(e => expect(e).not.toHaveProperty('name'));
  });

  it('3. Work=sk-a,Personal=sk-b → both names + keys', () => {
    const r = plugin.parseKeyList('Work=sk-a,Personal=sk-b');
    expect(r).toEqual([
      { name: 'Work', key: 'sk-a' },
      { name: 'Personal', key: 'sk-b' },
    ]);
  });

  it('4. mixed named + bare in one value', () => {
    const r = plugin.parseKeyList('Work=sk-a,sk-b,Personal=sk-c');
    expect(r).toEqual([
      { name: 'Work', key: 'sk-a' },
      { key: 'sk-b' },
      { name: 'Personal', key: 'sk-c' },
    ]);
  });

  it('5. whitespace: "  Work = sk-a ,  sk-b  " → name and key both trimmed', () => {
    const r = plugin.parseKeyList('  Work = sk-a ,  sk-b  ');
    expect(r).toEqual([
      { name: 'Work', key: 'sk-a' },
      { key: 'sk-b' },
    ]);
  });

  it('6. trailing comma / ",," / whitespace-only fragments → skipped, no empty entries', () => {
    const r = plugin.parseKeyList('sk-a,,sk-b, ,sk-c,');
    expect(r).toEqual([{ key: 'sk-a' }, { key: 'sk-b' }, { key: 'sk-c' }]);
  });

  it('7. empty string, whitespace-only, and ",,," → []', () => {
    expect(plugin.parseKeyList('')).toEqual([]);
    expect(plugin.parseKeyList('   ')).toEqual([]);
    expect(plugin.parseKeyList(',,,')).toEqual([]);
  });

  it('8. dedupe identical key values → one entry, first name kept', () => {
    const r = plugin.parseKeyList('Work=sk-a,Personal=sk-a');
    expect(r).toEqual([{ name: 'Work', key: 'sk-a' }]);
  });

  it('9. cap: 20 entries in → exactly 12 out, first 12, order preserved', () => {
    const entries = Array.from({ length: 20 }, (_, i) => `sk-${i}`).join(',');
    const r = plugin.parseKeyList(entries);
    expect(r).toHaveLength(12);
    expect(r[0].key).toBe('sk-0');
    expect(r[11].key).toBe('sk-11');
  });

  it('10. Work= (empty key after =) → one bare entry { key: "Work" }', () => {
    const r = plugin.parseKeyList('Work=');
    expect(r).toEqual([{ key: 'Work' }]);
  });

  it('11. =sk-a (leading =) → { key: "sk-a" }, no name', () => {
    const r = plugin.parseKeyList('=sk-a');
    expect(r).toEqual([{ key: 'sk-a' }]);
    expect(r[0]).not.toHaveProperty('name');
  });

  it('12. name containing spaces ("My laptop=sk-a") survives verbatim', () => {
    const r = plugin.parseKeyList('My laptop=sk-a');
    expect(r).toEqual([{ name: 'My laptop', key: 'sk-a' }]);
  });
});

// -- buildOpenRouterUsage ----------------------------------------------------

describe('buildOpenRouterUsage', () => {
  const NOW = 1787000000000;

  it('account + one capped key → prepaid-only account, used-semantics key, top-level mirror', () => {
    const entries = [{ raw: CAPPED_KEY_BODY }];
    const r = plugin.buildOpenRouterUsage(entries, CREDITS_BODY, NOW);

    expect(r.fetchedAt).toBe(NOW);
    expect(r.plan).toBe('paid');
    expect(r.groups).toHaveLength(2);

    // Account group — prepaid balance only (historic usage omitted)
    const acct = r.groups.find(g => g.id === 'account')!;
    expect(acct.label).toBe('Account');
    expect(acct.creditsUsed).toBeUndefined();
    expect(acct.creditsLimit).toBeUndefined();
    expect(acct.monthlyPct).toBeUndefined();
    expect(acct.monthlyWindowLabel).toBeUndefined();
    expect(acct.prepaidBalance).toBeCloseTo(74.75);

    // Key group — used-semantics
    const key1 = r.groups.find(g => g.id === 'key-1')!;
    expect(key1.label).toBe('laptop-key');
    expect(key1.creditsUsed).toBe(4);
    expect(key1.creditsLimit).toBe(10);
    expect(key1.monthlyPct).toBe(40);
    expect(key1.prepaidBalance).toBeUndefined(); // key limit remaining ≠ prepaid balance

    // Top-level mirror = account (prepaid-only)
    expect(r.creditsUsed).toBeUndefined();
    expect(r.creditsLimit).toBeUndefined();
    expect(r.monthlyPct).toBeUndefined();
    expect(r.monthlyWindowLabel).toBeUndefined();
    expect(r.prepaidBalance).toBeCloseTo(74.75);
  });

  it('uncapped key with account data → no bar, prepaidBalance = account remaining, label has "no spend cap"', () => {
    const entries = [{ raw: UNCAPPED_KEY_BODY }];
    const r = plugin.buildOpenRouterUsage(entries, CREDITS_BODY, NOW);

    const key1 = r.groups.find(g => g.id === 'key-1')!;
    expect(key1.label).toContain('no spend cap');
    expect(key1.prepaidBalance).toBeCloseTo(74.75);
    expect(key1.monthlyPct).toBeUndefined();
    expect(key1.creditsUsed).toBeUndefined();
    expect(key1.creditsLimit).toBeUndefined();
  });

  it('three keys where key 2 errors (HTTP 401) → healthy groups intact, bad one label-only', () => {
    const entries = [
      { raw: CAPPED_KEY_BODY },
      { name: 'Broken', error: 'HTTP 401' },
      { raw: CAPPED_KEY_BODY },
    ];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    expect(r.groups).toHaveLength(3);
    const bad = r.groups.find(g => g.id === 'key-2')!;
    expect(bad.label).toBe('Broken — HTTP 401');
    expect(bad.creditsUsed).toBeUndefined();

    // Healthy keys still have data
    const k1 = r.groups.find(g => g.id === 'key-1')!;
    expect(k1.creditsUsed).toBe(4);
    const k3 = r.groups.find(g => g.id === 'key-3')!;
    expect(k3.creditsUsed).toBe(4);
  });

  it('accountRaw: undefined (403 management-key case) → no account group, top-level mirrors key-1', () => {
    const entries = [{ raw: CAPPED_KEY_BODY }];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    expect(r.groups.find(g => g.id === 'account')).toBeUndefined();
    expect(r.groups).toHaveLength(1);

    // Top-level mirrors key-1
    expect(r.creditsUsed).toBe(4);
    expect(r.creditsLimit).toBe(10);
    expect(r.monthlyPct).toBe(40);
  });

  it('every entry errored → throws, message contains first error', () => {
    const entries = [
      { error: 'HTTP 500' },
      { error: 'timeout' },
    ];
    expect(() => plugin.buildOpenRouterUsage(entries, undefined, NOW)).toThrow('HTTP 500');
  });

  it('pct clamping: usage > limit → 100, limit: 0 → no pct, no division by zero', () => {
    const overLimit = {
      data: { label: 'over', limit: 10, limit_remaining: -5, usage: 15, is_free_tier: false },
    };
    const zeroLimit = {
      data: { label: 'zero', limit: 0, limit_remaining: 0, usage: 0, is_free_tier: false },
    };

    const entries = [
      { raw: overLimit },
      { raw: zeroLimit },
    ];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    const k1 = r.groups.find(g => g.id === 'key-1')!;
    expect(k1.monthlyPct).toBe(100);

    const k2 = r.groups.find(g => g.id === 'key-2')!;
    expect(k2.monthlyPct).toBeUndefined();
    // Confirm no NaN or Infinity leaked
    expect(k2.creditsLimit).toBe(0);
  });

  it('uncapped key + accountRaw: undefined → resolves (no throw), label-only group, fetchedAt present', () => {
    const entries = [{ raw: UNCAPPED_KEY_BODY }];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    expect(r.fetchedAt).toBe(NOW);
    expect(r.groups).toHaveLength(1);

    const key1 = r.groups.find(g => g.id === 'key-1')!;
    expect(key1.label).toContain('no spend cap');
    expect(key1.creditsUsed).toBeUndefined();
    expect(key1.creditsLimit).toBeUndefined();
    expect(key1.monthlyPct).toBeUndefined();
    // No account → no prepaidBalance on the uncapped group
    expect(key1.prepaidBalance).toBeUndefined();
  });

  it('creditsUsed floored at 0 when limit_remaining > limit (N3 retitle)', () => {
    // limit_remaining > limit produces negative creditsUsed before the fix,
    // but creditsUsed is clamped to 0, so monthlyPct = 0 (not negative).
    const negativeUsed = {
      data: { label: 'neg', limit: 10, limit_remaining: 12, usage: 0, is_free_tier: false },
    };
    const entries = [{ raw: negativeUsed }];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    const k1 = r.groups.find(g => g.id === 'key-1')!;
    expect(k1.creditsUsed).toBe(0); // clamped from -2
    expect(k1.monthlyPct).toBe(0);
  });

  it('all keys fail to parse + no account → throws with first parse error message', () => {
    const entries = [
      { raw: { data: null } },
      { raw: null },
    ];
    expect(() => plugin.buildOpenRouterUsage(entries, undefined, NOW)).toThrow(
      'openrouter key: missing data',
    );
  });

  // -- Name precedence (tests 13–17) ----------------------------------------

  it('13. operator name beats OpenRouter label', () => {
    const body = { data: { label: 'dashboard-name', limit: 10, limit_remaining: 6, usage: 4, is_free_tier: false } };
    const entries = [{ name: 'Work', raw: body }];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    const k1 = r.groups.find(g => g.id === 'key-1')!;
    expect(k1.label).toBe('Work');
  });

  it('14. no operator name + normal label → the label', () => {
    const body = { data: { label: 'my-server-key', limit: 10, limit_remaining: 6, usage: 4, is_free_tier: false } };
    const entries = [{ raw: body }];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    const k1 = r.groups.find(g => g.id === 'key-1')!;
    expect(k1.label).toBe('my-server-key');
  });

  it('15. no operator name + masked label "SK-OR-V1-EEC…E6B" → Key 2 (demotion, case-insensitive)', () => {
    const body1 = { data: { label: 'Work key', limit: 5, limit_remaining: 3, usage: 2, is_free_tier: false } };
    const body2 = { data: { label: 'SK-OR-V1-EEC1234E6B', limit: 10, limit_remaining: 6, usage: 4, is_free_tier: false } };
    const entries = [{ raw: body1 }, { raw: body2 }];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    const k2 = r.groups.find(g => g.id === 'key-2')!;
    expect(k2.label).toBe('Key 2');
  });

  it('16. no name, no label → Key N with the correct 1-based index (assert with N=3)', () => {
    const bodyNoLabel = { data: { limit: 10, limit_remaining: 6, usage: 4, is_free_tier: false } };
    const entries = [
      { raw: CAPPED_KEY_BODY },
      { raw: CAPPED_KEY_BODY },
      { raw: bodyNoLabel },
    ];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    const k3 = r.groups.find(g => g.id === 'key-3')!;
    expect(k3.label).toBe('Key 3');
  });

  it('17. a normal label that merely contains "sk" ("risk-key") is not demoted', () => {
    const body = { data: { label: 'risk-key', limit: 10, limit_remaining: 6, usage: 4, is_free_tier: false } };
    const entries = [{ raw: body }];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    const k1 = r.groups.find(g => g.id === 'key-1')!;
    expect(k1.label).toBe('risk-key');
  });

  // -- R2 account math (tests 18–21) -----------------------------------------

  it('18. account group: prepaid balance only, no historic usage bar or credits row', () => {
    const entries = [{ raw: CAPPED_KEY_BODY }];
    const r = plugin.buildOpenRouterUsage(entries, CREDITS_BODY, NOW);

    const acct = r.groups.find(g => g.id === 'account')!;
    expect(acct.prepaidBalance).toBeCloseTo(74.75);      // remaining (leftover)
    expect(acct.creditsUsed).toBeUndefined();
    expect(acct.creditsLimit).toBeUndefined();
    expect(acct.monthlyPct).toBeUndefined();
    expect(acct.monthlyWindowLabel).toBeUndefined();
  });

  it('19. top-level mirror equals account group (prepaid balance only)', () => {
    const entries = [{ raw: CAPPED_KEY_BODY }];
    const r = plugin.buildOpenRouterUsage(entries, CREDITS_BODY, NOW);

    const acct = r.groups.find(g => g.id === 'account')!;
    expect(r.prepaidBalance).toBe(acct.prepaidBalance);
    expect(r.creditsUsed).toBeUndefined();
    expect(r.creditsLimit).toBeUndefined();
    expect(r.monthlyPct).toBeUndefined();
    expect(r.monthlyWindowLabel).toBeUndefined();
  });

  it('20. total_credits: 0 → prepaidBalance is 0, no NaN/Infinity anywhere in the group', () => {
    const zeroCredits = { data: { total_credits: 0, total_usage: 0 } };
    const entries = [{ raw: CAPPED_KEY_BODY }];
    const r = plugin.buildOpenRouterUsage(entries, zeroCredits, NOW);

    const acct = r.groups.find(g => g.id === 'account')!;
    expect(acct.prepaidBalance).toBe(0);
    expect(acct.monthlyPct).toBeUndefined();
    // JSON.stringify maps NaN/Infinity to null, so assert on raw numeric values.
    for (const v of Object.values(acct)) {
      if (typeof v === 'number') {
        expect(Number.isFinite(v)).toBe(true);
        expect(Number.isNaN(v)).toBe(false);
      }
    }
  });

  it('21. capped key in same result still reads "key credits used" with used-semantics', () => {
    const entries = [{ raw: CAPPED_KEY_BODY }];
    const r = plugin.buildOpenRouterUsage(entries, CREDITS_BODY, NOW);

    const acct = r.groups.find(g => g.id === 'account')!;
    const key1 = r.groups.find(g => g.id === 'key-1')!;

    // Account: prepaid-only (no window label)
    expect(acct.monthlyWindowLabel).toBeUndefined();
    // Key: used-semantics
    expect(key1.monthlyWindowLabel).toBe('key credits used');
    expect(key1.creditsUsed).toBe(4); // limit - limitRemaining = 10 - 6
  });

  // -- Structure / degradation at N>1 (tests 22–24) --------------------------

  it('22. five keys + account → ids exactly as expected, unique', () => {
    const entries = Array.from({ length: 5 }, () => ({ raw: CAPPED_KEY_BODY }));
    const r = plugin.buildOpenRouterUsage(entries, CREDITS_BODY, NOW);

    const ids = r.groups.map(g => g.id);
    expect(ids).toEqual(['account', 'key-1', 'key-2', 'key-3', 'key-4', 'key-5']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('23. five keys where #2 and #4 error → no group label contains any key value', () => {
    const fakeKey1 = { data: { label: 'real-1', limit: 10, limit_remaining: 6, usage: 4, is_free_tier: false } };
    const fakeKey3 = { data: { label: 'real-3', limit: 10, limit_remaining: 6, usage: 4, is_free_tier: false } };
    const fakeKey5 = { data: { label: 'real-5', limit: 10, limit_remaining: 6, usage: 4, is_free_tier: false } };
    const FAKE_KEY_2 = 'sk-or-v1-FAKEKEY123';
    const FAKE_KEY_4 = 'sk-or-v1-LEAKME456';

    const entries = [
      { name: 'Alpha', raw: fakeKey1 },
      { name: 'Beta', key: FAKE_KEY_2, error: `fetch failed for ${FAKE_KEY_2}` },
      { name: 'Gamma', raw: fakeKey3 },
      { key: FAKE_KEY_4, error: `timeout ${FAKE_KEY_4}` },  // no name → Key 4
      { raw: fakeKey5 },
    ];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);

    // Three healthy + two errored
    expect(r.groups).toHaveLength(5);

    const bad2 = r.groups.find(g => g.id === 'key-2')!;
    expect(bad2.label).toBe('Beta — fetch failed for [redacted]');
    expect(bad2.creditsUsed).toBeUndefined();

    const bad4 = r.groups.find(g => g.id === 'key-4')!;
    expect(bad4.label).toBe('Key 4 — timeout [redacted]');
    expect(bad4.creditsUsed).toBeUndefined();

    // REGRESSION GUARD: recognisable fake keys must not appear in the result
    const serialised = JSON.stringify(r);
    expect(serialised).not.toContain(FAKE_KEY_2);
    expect(serialised).not.toContain(FAKE_KEY_4);
    expect(serialised).not.toContain('sk-or-v1-FAKEKEY123');
    expect(serialised).not.toContain('sk-or-v1-LEAKME456');
  });

  it('24. every entry errored + no account → still throws with the first error message', () => {
    const entries = [
      { name: 'A', error: 'HTTP 500' },
      { error: 'DNS fail' },
      { name: 'C', error: 'timeout' },
    ];
    expect(() => plugin.buildOpenRouterUsage(entries, undefined, NOW)).toThrow('HTTP 500');
  });

  // -- Display-name hygiene + redactKey length gate (tests 25–29) ------------

  it("25. entry whose name is another entry's real key → serialised result must not contain that key", () => {
    const KEY_A = 'sk-or-v1-AAAKEYVALUE01';
    const KEY_B = 'sk-or-v1-BBBKEYVALUE02';
    const entries = [
      { name: 'Work', key: KEY_A, raw: CAPPED_KEY_BODY },
      { name: KEY_A, key: KEY_B, raw: CAPPED_KEY_BODY },
    ];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);
    const serialised = JSON.stringify(r);
    expect(serialised).not.toContain(KEY_A);
    expect(serialised).not.toContain(KEY_B);

    // Typo path: name is sk-or- prefixed but is NOT any entry's key → demote to Key N
    const TYPO = 'sk-or-v1-NOTANEENTRYKEY';
    const rTypo = plugin.buildOpenRouterUsage(
      [{ name: TYPO, key: KEY_B, raw: CAPPED_KEY_BODY }],
      undefined,
      NOW,
    );
    expect(rTypo.groups.find(g => g.id === 'key-1')!.label).toBe('Key 1');
    expect(JSON.stringify(rTypo)).not.toContain(TYPO);
    expect(JSON.stringify(rTypo)).not.toContain(KEY_B);
  });

  it('26. entry whose name embeds a fake key mid-string → key not contained in result', () => {
    const LEAK = 'sk-or-v1-LEAKME456';
    const entries = [
      { name: `my key ${LEAK}`, key: LEAK, raw: CAPPED_KEY_BODY },
    ];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);
    const serialised = JSON.stringify(r);
    expect(serialised).not.toContain(LEAK);
    expect(r.groups.find(g => g.id === 'key-1')!.label).toBe('my key [redacted]');
  });

  it('27. benign operator names Work / Personal pass through unchanged', () => {
    const entries = [
      { name: 'Work', key: 'sk-or-v1-FAKEWORKKEY01', raw: CAPPED_KEY_BODY },
      { name: 'Personal', key: 'sk-or-v1-FAKEPERSKEY02', raw: CAPPED_KEY_BODY },
    ];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);
    expect(r.groups.find(g => g.id === 'key-1')!.label).toBe('Work');
    expect(r.groups.find(g => g.id === 'key-2')!.label).toBe('Personal');
  });

  it('28. short key "timeout" (7 chars) does not redact that word from error text', () => {
    const entries = [
      { key: 'timeout', error: 'The operation was aborted due to timeout' },
      { name: 'Work', raw: CAPPED_KEY_BODY },
    ];
    const r = plugin.buildOpenRouterUsage(entries, undefined, NOW);
    const bad = r.groups.find(g => g.id === 'key-1')!;
    expect(bad.label).toBe('Key 1 — The operation was aborted due to timeout');
    expect(bad.label).toContain('timeout');
    expect(bad.label).not.toContain('[redacted]');
  });

  it('29. all-keys-failed: error containing own key is redacted once, never nested', () => {
    const FAKE = 'sk-or-v1-FAKEKEY123';
    const entries = [{ key: FAKE, error: `fetch failed for ${FAKE}` }];
    expect(() => plugin.buildOpenRouterUsage(entries, undefined, NOW)).toThrow();
    try {
      plugin.buildOpenRouterUsage(entries, undefined, NOW);
      expect.unreachable('expected all-keys-failed throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain('[redacted]');
      expect(msg).not.toContain('red[redacted]cted');
      expect(msg).not.toContain(FAKE);
    }
  });
});
