import { describe, it, expect } from 'vitest';
import {
  parseScheduleVariables,
  VAR_KEY_RE,
  VAR_MAX_KEYS,
  VAR_VALUE_MAX_BYTES,
  VARS_MAX_BYTES,
} from './scheduleVars.js';

describe('parseScheduleVariables', () => {
  it('accepts a valid string map', () => {
    expect(parseScheduleVariables({ focus: 'audio', cap: '3' })).toEqual({
      ok: true,
      value: { focus: 'audio', cap: '3' },
    });
  });

  it('normalises {} to undefined', () => {
    expect(parseScheduleVariables({})).toEqual({ ok: true, value: undefined });
  });

  it('treats null as clear (undefined)', () => {
    expect(parseScheduleVariables(null)).toEqual({ ok: true, value: undefined });
  });

  it('treats undefined as absent', () => {
    expect(parseScheduleVariables(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('rejects a non-object', () => {
    expect(parseScheduleVariables('nope').ok).toBe(false);
    expect(parseScheduleVariables(['a']).ok).toBe(false);
    const r = parseScheduleVariables('nope');
    if (!r.ok) expect(r.error).toMatch(/JSON object/);
  });

  it('rejects a key with a dot', () => {
    const r = parseScheduleVariables({ 'a.b': 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid key "a\.b"/);
  });

  it('rejects a key that starts with a digit', () => {
    const r = parseScheduleVariables({ '1foo': 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid key "1foo"/);
  });

  it('rejects a 65-char key', () => {
    const k = 'a' + 'x'.repeat(64);
    expect(k.length).toBe(65);
    const r = parseScheduleVariables({ [k]: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid key/);
  });

  it('accepts a 64-char key matching VAR_KEY_RE', () => {
    const k = 'a' + 'x'.repeat(63);
    expect(VAR_KEY_RE.test(k)).toBe(true);
    expect(parseScheduleVariables({ [k]: 'ok' })).toEqual({
      ok: true,
      value: { [k]: 'ok' },
    });
  });

  it('rejects a number value', () => {
    const r = parseScheduleVariables({ n: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('variables.n must be a string');
  });

  it('rejects a null value', () => {
    const r = parseScheduleVariables({ n: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('variables.n must be a string');
  });

  it('rejects a nested object value', () => {
    const r = parseScheduleVariables({ n: { inner: 'x' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('variables.n must be a string');
  });

  it('rejects an array value', () => {
    const r = parseScheduleVariables({ n: ['x'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('variables.n must be a string');
  });

  it('rejects an oversize value', () => {
    const r = parseScheduleVariables({ big: 'x'.repeat(VAR_VALUE_MAX_BYTES + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds 2048 bytes/);
  });

  it('rejects more than VAR_MAX_KEYS keys', () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < VAR_MAX_KEYS + 1; i++) obj[`k${i}`] = 'v';
    const r = parseScheduleVariables(obj);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most 32 keys/);
  });

  it('rejects a map whose serialised JSON exceeds VARS_MAX_BYTES', () => {
    const obj: Record<string, string> = {};
    // 8 keys × 1200 bytes ≫ 8192 once JSON-quoted.
    for (let i = 0; i < 8; i++) obj[`k${i}`] = 'x'.repeat(1200);
    const r = parseScheduleVariables(obj);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large \(max 8192 bytes\)/);
    expect(VARS_MAX_BYTES).toBe(8192);
  });

  it('accepts __proto__ as a safe own-property key', () => {
    const input = JSON.parse('{"__proto__":"val"}');
    const r = parseScheduleVariables(input);
    expect(r.ok).toBe(true);
    if (r.ok && r.value) {
      expect(Object.prototype.hasOwnProperty.call(r.value, '__proto__')).toBe(true);
      expect((r.value as Record<string, string>)['__proto__']).toBe('val');
    }
  });
});
