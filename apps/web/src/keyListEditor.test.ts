import { describe, expect, it } from 'vitest';
import {
  KEY_LIST_MAX,
  keyListSummary,
  serialiseKeyList,
  usesKeyListEditor,
  validateKeyRows,
  type KeyRow,
} from './keyListEditor.js';
// Grammar owner is untyped plugin JS; vitest resolves this path for the round-trip test.
// @ts-expect-error no declaration file for plugin-src/openrouter-usage/index.js
import { parseKeyList } from '../../../plugin-src/openrouter-usage/index.js';

const SECRET_A = 'sk-or-v1-SECRETAAA11111111111111111111';
const SECRET_B = 'sk-or-v1-SECRETBBB22222222222222222222';
const SECRET_C = 'sk-or-v1-SECRETCCC33333333333333333333';

function named(name: string, key: string): KeyRow {
  return { name, key };
}

describe('serialiseKeyList', () => {
  it('joins named rows as name=key', () => {
    expect(serialiseKeyList([
      named('Work', 'sk-or-v1-aaa'),
      named('Personal', 'sk-or-v1-bbb'),
    ])).toBe('Work=sk-or-v1-aaa,Personal=sk-or-v1-bbb');
  });

  it('serialises an empty name as a bare key with no equals', () => {
    expect(serialiseKeyList([named('', 'sk-or-v1-ccc')])).toBe('sk-or-v1-ccc');
  });

  it('preserves mixed named + bare order', () => {
    expect(serialiseKeyList([
      named('Work', 'sk-or-v1-aaa'),
      named('', 'sk-or-v1-ccc'),
      named('Personal', 'sk-or-v1-bbb'),
    ])).toBe('Work=sk-or-v1-aaa,sk-or-v1-ccc,Personal=sk-or-v1-bbb');
  });

  it('trims whitespace on name and key', () => {
    expect(serialiseKeyList([named(' Work ', ' sk-or-v1-aaa ')])).toBe('Work=sk-or-v1-aaa');
  });

  it('drops rows with an empty key, including a fully empty row', () => {
    expect(serialiseKeyList([named('Work', ''), named('', '')])).toBe('');
    expect(serialiseKeyList([named('', '')])).toBe('');
  });
});

describe('round-trip with parseKeyList (plugin grammar owner)', () => {
  it('parses serialised named + bare rows back with names only on named rows', () => {
    const rows: KeyRow[] = [
      named('Work', SECRET_A),
      named('Personal', SECRET_B),
      named('', SECRET_C),
    ];
    expect(parseKeyList(serialiseKeyList(rows))).toEqual([
      { name: 'Work', key: SECRET_A },
      { name: 'Personal', key: SECRET_B },
      { key: SECRET_C },
    ]);
  });

  it('does not emit Work= / =sk-a degenerate edges for any accepted row set', () => {
    const accepted: KeyRow[] = [
      named('Work', SECRET_A),
      named('', SECRET_B),
      named('  ', SECRET_C),
    ];
    expect(validateKeyRows(accepted)).toBeNull();
    const serialised = serialiseKeyList(accepted);
    for (const entry of serialised.split(',')) {
      expect(entry.startsWith('=')).toBe(false);
      expect(entry.endsWith('=')).toBe(false);
    }
    expect(parseKeyList(serialised)).toHaveLength(
      accepted.filter((r) => r.key.trim()).length,
    );
  });
});

describe('validateKeyRows', () => {
  const clean: KeyRow[] = [named('Work', SECRET_A), named('', SECRET_B)];

  it('returns null for a clean set', () => {
    expect(validateKeyRows(clean)).toBeNull();
  });

  it('rejects a name containing a comma', () => {
    const msg = validateKeyRows([named('Work,Home', SECRET_A)]);
    expect(msg).toBeTruthy();
    expect(msg).not.toContain(SECRET_A);
  });

  it('rejects a name containing an equals', () => {
    const msg = validateKeyRows([named('Work=x', SECRET_A)]);
    expect(msg).toBeTruthy();
    expect(msg).not.toContain(SECRET_A);
  });

  it('rejects a key containing a comma', () => {
    const msg = validateKeyRows([named('Work', `${SECRET_A},extra`)]);
    expect(msg).toBeTruthy();
    expect(msg).not.toContain(SECRET_A);
  });

  it('rejects a key containing an equals', () => {
    const msg = validateKeyRows([named('Work', `${SECRET_A}=x`)]);
    expect(msg).toBeTruthy();
    expect(msg).not.toContain(SECRET_A);
  });

  it('rejects a named row with an empty key', () => {
    const msg = validateKeyRows([named('Work', '')]);
    expect(msg).toBeTruthy();
  });

  it('rejects duplicate key values', () => {
    const msg = validateKeyRows([named('Work', SECRET_A), named('Home', SECRET_A)]);
    expect(msg).toBeTruthy();
    expect(msg).not.toContain(SECRET_A);
  });

  it('accepts 12 valid rows and rejects 13 with the cap message', () => {
    const twelve: KeyRow[] = Array.from({ length: 12 }, (_, i) => named(`n${i}`, `sk-or-v1-k${i}`));
    expect(validateKeyRows(twelve)).toBeNull();
    const thirteen = [...twelve, named('n12', 'sk-or-v1-k12')];
    const msg = validateKeyRows(thirteen);
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/12/);
  });
});

describe('KEY_LIST_MAX', () => {
  // Convention: 12, matching the plugin's MAX_KEYS by agreement — not an
  // enforced mirror (MAX_KEYS is not exported from the plugin).
  it('is 12', () => {
    expect(KEY_LIST_MAX).toBe(12);
  });
});

describe('keyListSummary hygiene', () => {
  it('emits counts only and never the key material', () => {
    const rows = [named('Work', SECRET_A), named('Personal', SECRET_B), named('', SECRET_C)];
    const summary = keyListSummary(rows);
    expect(summary).toMatch(/3 keys \(2 named\)/);
    expect(summary).not.toContain(SECRET_A);
    expect(summary).not.toContain(SECRET_B);
    expect(summary).not.toContain(SECRET_C);
    expect(summary).not.toContain('sk-or-v1');
  });

  it('uses singular key when exactly one row is filled', () => {
    expect(keyListSummary([named('Work', SECRET_A)])).toBe('1 key (1 named)');
    expect(keyListSummary([named('', SECRET_A)])).toBe('1 key (0 named)');
  });
});

describe('usesKeyListEditor', () => {
  it('is true for openrouter-usage OPENROUTER_API_KEY and kilo-usage KILO_API_KEY', () => {
    expect(usesKeyListEditor('openrouter-usage', 'OPENROUTER_API_KEY')).toBe(true);
    expect(usesKeyListEditor('kilo-usage', 'KILO_API_KEY')).toBe(true);
    expect(usesKeyListEditor('zai-usage', 'ZAI_API_KEY')).toBe(false);
    expect(usesKeyListEditor('openrouter-usage', 'SOMETHING_ELSE')).toBe(false);
    expect(usesKeyListEditor('kilo-usage', 'SOMETHING_ELSE')).toBe(false);
  });
});
