import { describe, it, expect, afterEach } from 'vitest';
import { buildChildEnv, setAgentEnvSource } from '../childEnv.js';
import { AgentEnvStore } from './agentEnvStore.js';

const makeStore = () => new AgentEnvStore(() => ['pi', 'codex']);

afterEach(() => {
  setAgentEnvSource(() => ({ own: {}, managedNames: new Set() }));
});

describe('AgentEnvStore', () => {
  it('injects only for the owning agent', () => {
    const s = makeStore();
    expect(s.replace({ pi: { ZAI_API_KEY: 'zai-secret-1' } })).toEqual({ changed: true });
    expect(s.slice('pi').own).toEqual({ ZAI_API_KEY: 'zai-secret-1' });
    expect(s.slice('codex').own).toEqual({});
    expect([...s.slice('codex').managedNames]).toContain('ZAI_API_KEY');
  });

  it('empty scope gets no values', () => {
    const s = makeStore();
    s.replace({ pi: { ZAI_API_KEY: 'zai-secret-1' } });
    const empty = s.slice('');
    expect(empty.own).toEqual({});
    expect([...empty.managedNames]).toContain('ZAI_API_KEY');
  });

  it('drops reserved and malformed entries', () => {
    const s = makeStore();
    s.replace({ pi: { LD_PRELOAD: 'evil-value-1', PATH: '/evil/path', lower: 'x'.repeat(9), GOOD_KEY: 12 } });
    expect(s.slice('pi').own).toEqual({});
    expect([...s.slice('pi').managedNames]).toEqual([]);
    expect(s.secrets()).toEqual([]);
    // JSON.parse makes `__proto__` a plain data property; a null-proto store
    // must hold it (if ever) without reaching Object.prototype.
    const parsed = JSON.parse('{"pi":{"__proto__":"x"}}') as unknown;
    expect(() => s.replace(parsed)).not.toThrow();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    const victim: Record<string, unknown> = {};
    expect(victim.polluted).toBeUndefined();
  });

  it('does not hold keys for agents not allowed here', () => {
    const s = makeStore();
    s.replace({ cursor: { CURSOR_API_KEY: 'cursor-secret' }, 'grok-bot': { X_KEY: 'grok-secret-1' } });
    expect(JSON.stringify(s.secrets())).not.toContain('cursor-secret');
    expect(JSON.stringify(s.secrets())).not.toContain('grok-secret-1');
    expect(s.slice('cursor').own).toEqual({});
    expect(s.slice('grok-bot').own).toEqual({});
    expect([...s.slice('pi').managedNames]).toContain('CURSOR_API_KEY');
    expect([...s.slice('pi').managedNames]).toContain('X_KEY');
  });

  it('managedNames scrubs names with no value here', () => {
    const s = makeStore();
    s.replace({}, ['OPENAI_API_KEY', 'LD_PRELOAD', 7]);
    expect([...s.slice('pi').managedNames]).toEqual(['OPENAI_API_KEY']);
    expect(s.secrets()).toEqual([]);
    s.replace({}, 'nope');
    expect([...s.slice('pi').managedNames]).toEqual([]);
  });

  describe('changed', () => {
    it('tracks real state changes and ignores key order', () => {
      const s = makeStore();
      expect(s.replace({}, []).changed).toBe(false);
      expect(s.replace({ pi: { K1: 'value-1' } }).changed).toBe(true);
      expect(s.replace({ pi: { K1: 'value-1' } }).changed).toBe(false);
      expect(s.replace({ pi: { K1: 'value-2' } }).changed).toBe(true);
      expect(s.replace({ pi: { K1: 'value-2' } }, ['K9']).changed).toBe(true);
      expect(s.replace({}, []).changed).toBe(true);
      expect(s.replace({}, []).changed).toBe(false);
    });

    it('key order must not matter', () => {
      const s = makeStore();
      s.replace({ pi: { A1: 'aa', B2: 'bb' }, codex: { C3: 'cc' } });
      expect(s.replace({ codex: { C3: 'cc' }, pi: { B2: 'bb', A1: 'aa' } }).changed).toBe(false);
    });
  });

  it('secrets keeps retired values', () => {
    const s = makeStore();
    s.replace({ pi: { K: 'aaaa-value-1' } });
    s.replace({ pi: { K: 'bbbb-value-2' } });
    s.replace({}, []);
    expect(s.secrets()).toEqual(expect.arrayContaining(['aaaa-value-1', 'bbbb-value-2']));
    expect(s.slice('pi').own).toEqual({});
  });

  it('secrets are longest first', () => {
    const s = makeStore();
    s.replace({ pi: { A: 'abcd1234' } });
    s.replace({ pi: { A: 'abcd1234xyz' } });
    expect(s.secrets()[0]).toBe('abcd1234xyz');
  });

  it('ignores short values for redaction', () => {
    const s = makeStore();
    s.replace({ pi: { A: 'abcd' } });
    expect(s.secrets()).toEqual([]);
  });

  it('buildChildEnv precedence', () => {
    const s = makeStore();
    process.env.ZAI_API_KEY = 'local-value';
    try {
      setAgentEnvSource(s.slice);
      expect(buildChildEnv(undefined, undefined, 'pi').ZAI_API_KEY).toBe('local-value');
      s.replace({ pi: { ZAI_API_KEY: 'vault-value-1' } });
      expect(buildChildEnv(undefined, undefined, 'pi').ZAI_API_KEY).toBe('vault-value-1');
      expect(buildChildEnv(undefined, undefined, 'codex').ZAI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.ZAI_API_KEY;
    }
  });
});
