import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../plugin-src/kilo-usage/index.js');
const plugin = await import(pluginPath) as {
  parseKeyList: (value: unknown) => Array<{ name?: string; key: string }>;
  parseKiloBalanceJson: (raw: unknown) => { balance: number; depleted?: boolean };
  parseKiloProfileJson: (raw: unknown) => { name?: string; email?: string };
  redactKey: (text: unknown, key?: string) => string;
  buildKiloUsage: (
    entries: Array<{ name?: string; key?: string; raw?: unknown; profile?: unknown; error?: string }>,
    nowMs: number,
    opts?: { forAgent?: boolean },
  ) => {
    fetchedAt: number;
    plan?: string;
    groups: Array<{ id: string; label: string; prepaidBalance?: number; hasCredits?: boolean }>;
    prepaidBalance?: number;
    hasCredits?: boolean;
  };
};

// -- Fixtures ----------------------------------------------------------------

const BALANCE_BODY = { balance: 3.640134, isDepleted: false };
const DEPLETED_BODY = { balance: 0, isDepleted: true };
const PROFILE_BODY = {
  user: {
    id: 'c42462fb',
    email: 'ops@example.com',
    name: 'Rocco De Angelis',
    image: 'https://…',
  },
  hasPersonalAccount: true,
};
const FAKE_KEY_A = 'kilo_FAKEKEYAAAA0123456789';
const FAKE_KEY_B = 'kilo_FAKEKEYBBBB0123456789';

function assertNoKeyLeak(result: unknown): void {
  const serialised = JSON.stringify(result);
  for (const k of [FAKE_KEY_A, FAKE_KEY_B]) expect(serialised).not.toContain(k);
}

// -- parseKeyList ------------------------------------------------------------

describe('parseKeyList', () => {
  it("1. bare key → [{key}], no name property", () => {
    const r = plugin.parseKeyList('kilo-a');
    expect(r).toEqual([{ key: 'kilo-a' }]);
    expect(r[0]).not.toHaveProperty('name');
  });

  it('2. comma list of bare keys → order preserved, none named', () => {
    const r = plugin.parseKeyList('kilo-a,kilo-b,kilo-c');
    expect(r).toEqual([{ key: 'kilo-a' }, { key: 'kilo-b' }, { key: 'kilo-c' }]);
    r.forEach((e) => expect(e).not.toHaveProperty('name'));
  });

  it('3. Work=kilo-a,Personal=kilo-b → both named', () => {
    const r = plugin.parseKeyList('Work=kilo-a,Personal=kilo-b');
    expect(r).toEqual([
      { name: 'Work', key: 'kilo-a' },
      { name: 'Personal', key: 'kilo-b' },
    ]);
  });

  it('4. mixed named + bare in one value', () => {
    const r = plugin.parseKeyList('Work=kilo-a,kilo-b,Personal=kilo-c');
    expect(r).toEqual([
      { name: 'Work', key: 'kilo-a' },
      { key: 'kilo-b' },
      { name: 'Personal', key: 'kilo-c' },
    ]);
  });

  it('5. whitespace around name, =, key, and commas is trimmed', () => {
    const r = plugin.parseKeyList('  Work = kilo-a ,  kilo-b  ');
    expect(r).toEqual([
      { name: 'Work', key: 'kilo-a' },
      { key: 'kilo-b' },
    ]);
  });

  it('6. empty / whitespace-only fragments (trailing comma, ,, ) are skipped', () => {
    const r = plugin.parseKeyList('kilo-a,,kilo-b, ,kilo-c,');
    expect(r).toEqual([{ key: 'kilo-a' }, { key: 'kilo-b' }, { key: 'kilo-c' }]);
  });

  it("7. empty string, whitespace-only, and ',,,' → []", () => {
    expect(plugin.parseKeyList('')).toEqual([]);
    expect(plugin.parseKeyList('   ')).toEqual([]);
    expect(plugin.parseKeyList(',,,')).toEqual([]);
  });

  it('8. duplicate key values → one entry, first name kept', () => {
    const r = plugin.parseKeyList('Work=kilo-a,Personal=kilo-a');
    expect(r).toEqual([{ name: 'Work', key: 'kilo-a' }]);
  });

  it('9. cap: 20 bare keys → exactly 12 out, first 12, order preserved', () => {
    const entries = Array.from({ length: 20 }, (_, i) => `kilo-${i}`).join(',');
    const r = plugin.parseKeyList(entries);
    expect(r).toHaveLength(12);
    expect(r[0].key).toBe('kilo-0');
    expect(r[11].key).toBe('kilo-11');
  });

  it("10. Work= (empty key after =) → [{key:'Work'}] (documented surprise)", () => {
    const r = plugin.parseKeyList('Work=');
    expect(r).toEqual([{ key: 'Work' }]);
  });

  it("11. =kilo-a (empty name before =) → [{key:'kilo-a'}], no name", () => {
    const r = plugin.parseKeyList('=kilo-a');
    expect(r).toEqual([{ key: 'kilo-a' }]);
    expect(r[0]).not.toHaveProperty('name');
  });

  it("12. name containing spaces ('My laptop=kilo-a') survives verbatim", () => {
    const r = plugin.parseKeyList('My laptop=kilo-a');
    expect(r).toEqual([{ name: 'My laptop', key: 'kilo-a' }]);
  });
});

// -- parseKiloBalanceJson ----------------------------------------------------

describe('parseKiloBalanceJson', () => {
  it('1. observed balance body → dollars + depleted:false', () => {
    const r = plugin.parseKiloBalanceJson(BALANCE_BODY);
    expect(r.balance).toBeCloseTo(3.640134);
    expect(r.depleted).toBe(false);
  });

  it("2. {balance:'12.5'} → numeric string coercion", () => {
    const r = plugin.parseKiloBalanceJson({ balance: '12.5' });
    expect(r.balance).toBe(12.5);
  });

  it('3. {data:{balance:5}} → tolerates a future envelope', () => {
    const r = plugin.parseKiloBalanceJson({ data: { balance: 5 } });
    expect(r.balance).toBe(5);
  });

  it('4. {balanceMicroDollars:3640134} → dollars ≈ 3.640134', () => {
    const r = plugin.parseKiloBalanceJson({ balanceMicroDollars: 3640134 });
    expect(r.balance).toBeCloseTo(3.640134);
  });

  it('5. {balance_micro_dollars:1000000} → dollars === 1 (snake variant)', () => {
    const r = plugin.parseKiloBalanceJson({ balance_micro_dollars: 1_000_000 });
    expect(r.balance).toBe(1);
  });

  it('6. {balance:150000} stays 150000 — no magnitude heuristic', () => {
    const r = plugin.parseKiloBalanceJson({ balance: 150000 });
    expect(r.balance).toBe(150000);
  });

  it('7. depleted body: balance 0 is present (not dropped as falsy), depleted true', () => {
    const r = plugin.parseKiloBalanceJson(DEPLETED_BODY);
    expect(r).toHaveProperty('balance', 0);
    expect(r.balance).toBe(0);
    expect(r.depleted).toBe(true);
  });

  it('8. negative balance passes through, not clamped', () => {
    const r = plugin.parseKiloBalanceJson({ balance: -1.2 });
    expect(r.balance).toBe(-1.2);
  });

  it('9. {balance:5} with no isDepleted → depleted === undefined', () => {
    const r = plugin.parseKiloBalanceJson({ balance: 5 });
    expect(r.balance).toBe(5);
    expect(r.depleted).toBeUndefined();
  });

  it("10. null → throws 'kilo balance: empty response'", () => {
    expect(() => plugin.parseKiloBalanceJson(null)).toThrow('kilo balance: empty response');
  });

  it("11. [] → throws 'kilo balance: empty response' (array is not a record)", () => {
    expect(() => plugin.parseKiloBalanceJson([])).toThrow('kilo balance: empty response');
  });

  it("12. {} → throws 'kilo balance: missing balance'", () => {
    expect(() => plugin.parseKiloBalanceJson({})).toThrow('kilo balance: missing balance');
  });

  it("13. {success:false, error:'Invalid token (…)' } → missing balance, no token text in message", () => {
    expect(() =>
      plugin.parseKiloBalanceJson({ success: false, error: 'Invalid token (8019fb73-1ef3-4cb4-9694-7c98664d63b9)' }),
    ).toThrow('kilo balance: missing balance');
    try {
      plugin.parseKiloBalanceJson({ success: false, error: 'Invalid token (8019fb73-1ef3-4cb4-9694-7c98664d63b9)' });
      expect.unreachable('expected throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain('Invalid token');
    }
  });

  it("plus: {balance:'abc'} and {balance:null} both throw missing balance", () => {
    expect(() => plugin.parseKiloBalanceJson({ balance: 'abc' })).toThrow('kilo balance: missing balance');
    expect(() => plugin.parseKiloBalanceJson({ balance: null })).toThrow('kilo balance: missing balance');
  });
});

// -- parseKiloProfileJson ----------------------------------------------------

describe('parseKiloProfileJson', () => {
  it('1. observed profile body → name + email; id/image ignored', () => {
    const r = plugin.parseKiloProfileJson(PROFILE_BODY);
    expect(r).toEqual({ name: 'Rocco De Angelis', email: 'ops@example.com' });
  });

  it('2. {user:{email}} → email only, no name', () => {
    const r = plugin.parseKiloProfileJson({ user: { email: 'a@b.c' } });
    expect(r).toEqual({ email: 'a@b.c' });
    expect(r).not.toHaveProperty('name');
  });

  it('3. {user:null} → {}, does not throw', () => {
    expect(plugin.parseKiloProfileJson({ user: null })).toEqual({});
  });

  it('4. null → {}, does not throw', () => {
    expect(plugin.parseKiloProfileJson(null)).toEqual({});
  });

  it('5. empty/non-string name/email are omitted', () => {
    expect(plugin.parseKiloProfileJson({ user: { name: '', email: 123 } })).toEqual({});
  });
});

// -- buildKiloUsage ----------------------------------------------------------

describe('buildKiloUsage', () => {
  const NOW = 1787000000000;

  it('1. one key, BALANCE_BODY → group + top-level mirror', () => {
    const r = plugin.buildKiloUsage([{ raw: BALANCE_BODY }], NOW);
    expect(r.fetchedAt).toBe(NOW);
    expect(r.plan).toBe('paid');
    expect(r.groups).toHaveLength(1);
    const g = r.groups.find((x) => x.id === 'key-1')!;
    expect(g.prepaidBalance).toBeCloseTo(3.640134);
    expect(g.hasCredits).toBe(true);
    expect(r.prepaidBalance).toBeCloseTo(3.640134);
    expect(r.hasCredits).toBe(true);
  });

  it('2. one key, DEPLETED_BODY → prepaidBalance 0 present, hasCredits false; finite numbers', () => {
    const r = plugin.buildKiloUsage([{ raw: DEPLETED_BODY }], NOW);
    const g = r.groups.find((x) => x.id === 'key-1')!;
    expect(g).toHaveProperty('prepaidBalance', 0);
    expect(g.prepaidBalance).toBe(0);
    expect(g.hasCredits).toBe(false);
    expect(r).toHaveProperty('prepaidBalance', 0);
    expect(r.prepaidBalance).toBe(0);
    expect(r.hasCredits).toBe(false);
    for (const v of Object.values(g)) {
      if (typeof v === 'number') {
        expect(Number.isFinite(v)).toBe(true);
        expect(Number.isNaN(v)).toBe(false);
      }
    }
  });

  it('3. body without isDepleted → hasCredits undefined, no false invented', () => {
    const r = plugin.buildKiloUsage([{ raw: { balance: 5 } }], NOW);
    const g = r.groups.find((x) => x.id === 'key-1')!;
    expect(g.hasCredits).toBeUndefined();
    expect(g).not.toHaveProperty('hasCredits');
    expect(r.hasCredits).toBeUndefined();
    expect(r).not.toHaveProperty('hasCredits');
  });

  it('4. three keys, #2 HTTP 401 → label-only error row; others keep balances', () => {
    const r = plugin.buildKiloUsage(
      [
        { raw: BALANCE_BODY },
        { name: 'Broken', error: 'HTTP 401' },
        { raw: { balance: 12.5, isDepleted: false } },
      ],
      NOW,
    );
    expect(r.groups).toHaveLength(3);
    const bad = r.groups.find((x) => x.id === 'key-2')!;
    expect(bad.label).toBe('Broken — HTTP 401');
    expect(bad.prepaidBalance).toBeUndefined();
    expect(r.groups.find((x) => x.id === 'key-1')!.prepaidBalance).toBeCloseTo(3.640134);
    expect(r.groups.find((x) => x.id === 'key-3')!.prepaidBalance).toBe(12.5);
  });

  it('5. all entries error → throws, message contains the first error', () => {
    expect(() =>
      plugin.buildKiloUsage([{ error: 'HTTP 500' }, { error: 'timeout' }], NOW),
    ).toThrow('HTTP 500');
  });

  it("6. all entries unparseable → throws 'kilo balance: missing balance'", () => {
    expect(() =>
      plugin.buildKiloUsage([{ raw: {} }, { raw: null }], NOW),
    ).toThrow('kilo balance: missing balance');
  });

  it('7. operator name + API profile → operator name wins', () => {
    const r = plugin.buildKiloUsage(
      [{ name: 'Work', raw: BALANCE_BODY, profile: PROFILE_BODY }],
      NOW,
    );
    expect(r.groups[0].label).toBe('Work');
  });

  it('8. no operator name + PROFILE_BODY → user.name', () => {
    const r = plugin.buildKiloUsage([{ raw: BALANCE_BODY, profile: PROFILE_BODY }], NOW);
    expect(r.groups[0].label).toBe('Rocco De Angelis');
  });

  it('9. no operator name + email-only profile → email', () => {
    const r = plugin.buildKiloUsage(
      [{ raw: BALANCE_BODY, profile: { user: { email: 'a@b.c' } } }],
      NOW,
    );
    expect(r.groups[0].label).toBe('a@b.c');
  });

  it('10. no name, no profile, N=3 → Key 3', () => {
    const r = plugin.buildKiloUsage(
      [{ raw: BALANCE_BODY }, { raw: BALANCE_BODY }, { raw: BALANCE_BODY }],
      NOW,
    );
    expect(r.groups.find((x) => x.id === 'key-3')!.label).toBe('Key 3');
  });

  it('11. two unnamed keys, same PROFILE_BODY → duplicate API label demoted', () => {
    const r = plugin.buildKiloUsage(
      [
        { raw: BALANCE_BODY, profile: PROFILE_BODY },
        { raw: BALANCE_BODY, profile: PROFILE_BODY },
      ],
      NOW,
    );
    expect(r.groups.find((x) => x.id === 'key-1')!.label).toBe('Rocco De Angelis');
    expect(r.groups.find((x) => x.id === 'key-2')!.label).toBe('Key 2');
  });

  it('12. two named keys with the same operator name both keep it', () => {
    const r = plugin.buildKiloUsage(
      [
        { name: 'Work', raw: BALANCE_BODY },
        { name: 'Work', raw: BALANCE_BODY },
      ],
      NOW,
    );
    expect(r.groups.find((x) => x.id === 'key-1')!.label).toBe('Work');
    expect(r.groups.find((x) => x.id === 'key-2')!.label).toBe('Work');
  });

  it("13. entry B's name is entry A's key → neither key in serialised output", () => {
    const r = plugin.buildKiloUsage(
      [
        { name: 'Work', key: FAKE_KEY_A, raw: BALANCE_BODY },
        { name: FAKE_KEY_A, key: FAKE_KEY_B, raw: BALANCE_BODY },
      ],
      NOW,
    );
    assertNoKeyLeak(r);
  });

  it('14. name embeds own key mid-string → redacted label, key absent from output', () => {
    const r = plugin.buildKiloUsage(
      [{ name: `my key ${FAKE_KEY_A}`, key: FAKE_KEY_A, raw: BALANCE_BODY }],
      NOW,
    );
    expect(r.groups[0].label).toBe('my key [redacted]');
    assertNoKeyLeak(r);
  });

  it('15. JWT-shaped operator name (unknown key) demoted to Key 1; string absent', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const r = plugin.buildKiloUsage([{ name: jwt, raw: BALANCE_BODY }], NOW);
    expect(r.groups[0].label).toBe('Key 1');
    expect(JSON.stringify(r)).not.toContain(jwt);
  });

  it("16. name 'kilo_SOMETHINGNOTANENTRYKEY' demoted to Key 1", () => {
    const r = plugin.buildKiloUsage(
      [{ name: 'kilo_SOMETHINGNOTANENTRYKEY', raw: BALANCE_BODY }],
      NOW,
    );
    expect(r.groups[0].label).toBe('Key 1');
  });

  it('16b. opaque ≥32-char hash with no kilo_/sk-/eyJ prefix is demoted (length+no-space clause)', () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(hash.length).toBeGreaterThanOrEqual(32);
    expect(/\s/.test(hash)).toBe(false);
    expect(/^(kilo[-_]|sk-|eyJ)/i.test(hash)).toBe(false);
    const r = plugin.buildKiloUsage([{ name: hash, raw: BALANCE_BODY }], NOW);
    expect(r.groups[0].label).toBe('Key 1');
    expect(JSON.stringify(r)).not.toContain(hash);
  });

  it('16c. long human name with spaces (≥32 chars) is NOT demoted', () => {
    const name = 'Very Long Organization Name For Testing';
    expect(name.length).toBeGreaterThanOrEqual(32);
    expect(/\s/.test(name)).toBe(true);
    const r = plugin.buildKiloUsage([{ name, raw: BALANCE_BODY }], NOW);
    expect(r.groups[0].label).toBe(name);
  });

  it("17. names 'Work' / 'Personal' pass through unchanged", () => {
    const r = plugin.buildKiloUsage(
      [
        { name: 'Work', raw: BALANCE_BODY },
        { name: 'Personal', raw: BALANCE_BODY },
      ],
      NOW,
    );
    expect(r.groups.find((x) => x.id === 'key-1')!.label).toBe('Work');
    expect(r.groups.find((x) => x.id === 'key-2')!.label).toBe('Personal');
  });

  it('18. short key "timeout" (7 chars) does not redact that word from error text', () => {
    const r = plugin.buildKiloUsage(
      [
        { key: 'timeout', error: 'The operation was aborted due to timeout' },
        { name: 'Work', raw: BALANCE_BODY },
      ],
      NOW,
    );
    const bad = r.groups.find((x) => x.id === 'key-1')!;
    expect(bad.label).toContain('timeout');
    expect(bad.label).not.toContain('[redacted]');
    expect(bad.label).toBe('Key 1 — The operation was aborted due to timeout');
  });

  it('19. five keys, #1 errors, #2–#5 healthy → ids unique; top-level mirrors first healthy', () => {
    const r = plugin.buildKiloUsage(
      [
        { error: 'HTTP 401' },
        { raw: { balance: 9.5, isDepleted: false } },
        { raw: BALANCE_BODY },
        { raw: BALANCE_BODY },
        { raw: BALANCE_BODY },
      ],
      NOW,
    );
    const ids = r.groups.map((g) => g.id);
    expect(ids).toEqual(['key-1', 'key-2', 'key-3', 'key-4', 'key-5']);
    expect(new Set(ids).size).toBe(ids.length);
    const key2 = r.groups.find((x) => x.id === 'key-2')!;
    expect(r.prepaidBalance).toBe(key2.prepaidBalance);
    expect(r.prepaidBalance).toBe(9.5);
    expect(r.plan).toBe('paid');
  });

  it("19b. error for key 2 embedding key 1 (FAKE_KEY_A) is redacted from the label", () => {
    const r = plugin.buildKiloUsage(
      [
        { name: 'Work', key: FAKE_KEY_A, raw: BALANCE_BODY },
        { name: 'Broken', key: FAKE_KEY_B, error: `fetch failed for ${FAKE_KEY_A}` },
      ],
      NOW,
    );
    const bad = r.groups.find((x) => x.id === 'key-2')!;
    expect(bad.label).toBe('Broken — fetch failed for [redacted]');
    expect(bad.label).toContain('[redacted]');
    expect(bad.label).not.toContain(FAKE_KEY_A);
    expect(bad.label).not.toContain(FAKE_KEY_B);
    assertNoKeyLeak(r);
  });

  it('20. all-keys-failed error embedding its own key is redacted once, never nested', () => {
    const entries = [{ key: FAKE_KEY_A, error: `fetch failed for ${FAKE_KEY_A}` }];
    expect(() => plugin.buildKiloUsage(entries, NOW)).toThrow();
    try {
      plugin.buildKiloUsage(entries, NOW);
      expect.unreachable('expected all-keys-failed throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain('[redacted]');
      expect(msg).not.toContain('red[redacted]cted');
      expect(msg).not.toContain(FAKE_KEY_A);
    }
  });

  it('forAgent: unnamed key with profile name/email → Key N, not identity', () => {
    const r = plugin.buildKiloUsage(
      [{ raw: BALANCE_BODY, profile: PROFILE_BODY }],
      NOW,
      { forAgent: true },
    );
    expect(r.groups[0]!.label).toBe('Key 1');
    expect(JSON.stringify(r)).not.toContain('Rocco');
    expect(JSON.stringify(r)).not.toContain('ops@example.com');
  });

  it('forAgent: operator name still wins; profile email is unused', () => {
    const r = plugin.buildKiloUsage(
      [{ name: 'Work', raw: BALANCE_BODY, profile: { user: { email: 'a@b.c' } } }],
      NOW,
      { forAgent: true },
    );
    expect(r.groups[0]!.label).toBe('Work');
    expect(JSON.stringify(r)).not.toContain('a@b.c');
  });
});
