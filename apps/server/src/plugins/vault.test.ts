import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  initVaultKey,
  vaultAvailable,
  vaultUnavailableReason,
  vaultSet,
  vaultGet,
  vaultClear,
  vaultStatus,
  vaultAllValues,
  currentKeyId,
  vaultVerify,
  vaultPurgePlugin,
} from './vault.js';

const SECRET32 = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 ascii bytes
const SECRET32B = 'abcdefghijklmnopqrstuvwxyz012346';
const ENV_KEY = 'env-vault-key-value-32bytes-min!!'; // 32+

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d, migrations);
  return d;
}

describe('plugin vault', () => {
  beforeEach(() => {
    initVaultKey({ sessionSecret: SECRET32 });
  });

  it('roundtrip set → get → clear and records updatedAt', () => {
    const d = db();
    const before = Date.now();
    vaultSet(d, 'zai-usage', 'ZAI_API_KEY', 'test-secret-value-aaaa');
    const hit = vaultGet(d, 'zai-usage', 'ZAI_API_KEY');
    expect(hit?.value).toBe('test-secret-value-aaaa');
    expect(hit?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(vaultStatus(d, 'zai-usage', 'ZAI_API_KEY')?.updatedAt).toBe(hit?.updatedAt);
    expect(vaultClear(d, 'zai-usage', 'ZAI_API_KEY')).toBe(true);
    expect(vaultGet(d, 'zai-usage', 'ZAI_API_KEY')).toBeUndefined();
    expect(vaultStatus(d, 'zai-usage', 'ZAI_API_KEY')).toBeUndefined();
    expect(vaultClear(d, 'zai-usage', 'ZAI_API_KEY')).toBe(false);
  });

  it('fail closed: missing secret ⇒ vaultSet AND vaultGet throw', () => {
    initVaultKey({ sessionSecret: '' });
    expect(vaultAvailable()).toBe(false);
    const reason = vaultUnavailableReason();
    expect(reason).toBe('no derivation secret ≥32 bytes (set SESSION_SECRET or TIERWYN_PLUGIN_VAULT_KEY)');
    const d = db();
    expect(() => vaultSet(d, 'p', 'K', 'abcdefghij')).toThrow(reason);
    expect(() => vaultGet(d, 'p', 'K')).toThrow(reason);
    try {
      vaultSet(d, 'p', 'K', 'abcdefghij');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('credential_missing');
    }
  });

  it('fail closed: short (<32B) secret ⇒ vaultSet AND vaultGet throw', () => {
    initVaultKey({ sessionSecret: 'a'.repeat(31) });
    expect(vaultAvailable()).toBe(false);
    expect(vaultUnavailableReason()).toBe(
      'no derivation secret ≥32 bytes (set SESSION_SECRET or TIERWYN_PLUGIN_VAULT_KEY)',
    );
    const d = db();
    expect(() => vaultSet(d, 'p', 'K', 'abcdefghij')).toThrow(/no derivation secret/);
    expect(() => vaultGet(d, 'p', 'K')).toThrow(/no derivation secret/);
  });

  it('empty SESSION_SECRET + AUTH_DISABLED ⇒ unavailable, not a derived key', () => {
    // AUTH_DISABLED=true leaves sessionSecret as '' (auth/config.ts). Must never HKDF empty IKM.
    initVaultKey({ sessionSecret: '' });
    expect(vaultAvailable()).toBe(false);
    expect(vaultUnavailableReason()).toMatch(/no derivation secret ≥32 bytes/);
    expect(currentKeyId()).toBeUndefined();
    const d = db();
    expect(() => vaultSet(d, 'p', 'K', 'abcdefghij')).toThrow();
    // 32-byte secret works; empty does not silently succeed.
    initVaultKey({ sessionSecret: SECRET32 });
    expect(vaultAvailable()).toBe(true);
    vaultSet(d, 'p', 'K', 'abcdefghij');
    expect(vaultGet(d, 'p', 'K')?.value).toBe('abcdefghij');
  });

  it("key_id is 'sess:v1' without TIERWYN_PLUGIN_VAULT_KEY and 'env:v1' with it", () => {
    const d = db();
    initVaultKey({ sessionSecret: SECRET32 });
    vaultSet(d, 'p', 'K', 'value-from-sess-secret-xx');
    const sess = d.prepare('SELECT key_id FROM plugin_secrets WHERE plugin_id = ? AND key = ?')
      .get('p', 'K') as { key_id: string };
    expect(sess.key_id).toBe('sess:v1');
    expect(currentKeyId()).toBe('sess:v1');

    initVaultKey({ envKey: ENV_KEY, sessionSecret: SECRET32 });
    vaultSet(d, 'p', 'K2', 'value-from-env-key-yyyyyy');
    const env = d.prepare('SELECT key_id FROM plugin_secrets WHERE plugin_id = ? AND key = ?')
      .get('p', 'K2') as { key_id: string };
    expect(env.key_id).toBe('env:v1');
    expect(currentKeyId()).toBe('env:v1');
  });

  it('key_id mismatch ⇒ exact "encrypted with a different key — re-enter"', () => {
    const d = db();
    initVaultKey({ envKey: ENV_KEY, sessionSecret: SECRET32 });
    vaultSet(d, 'p', 'K', 'secret-under-env-v1-zzzzzz');
    initVaultKey({ sessionSecret: SECRET32 }); // now sess:v1
    expect(() => vaultGet(d, 'p', 'K')).toThrow('encrypted with a different key — re-enter');
    try {
      vaultGet(d, 'p', 'K');
    } catch (err) {
      expect((err as Error).message).toBe('encrypted with a different key — re-enter');
      expect((err as { code?: string }).code).toBe('credential_missing');
    }
  });

  it('tampered ciphertext/tag ⇒ safe message, no plaintext, no raw crypto error', () => {
    const d = db();
    const secret = 'plaintext-secret-never-in-error';
    vaultSet(d, 'p', 'K', secret);
    d.prepare('UPDATE plugin_secrets SET ciphertext = ? WHERE plugin_id = ? AND key = ?')
      .run(Buffer.from('tampered-bytes-here'), 'p', 'K');
    try {
      vaultGet(d, 'p', 'K');
      expect.fail('expected throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toBe('stored credential could not be decrypted — re-enter');
      expect(msg).not.toContain(secret);
      expect(msg.toLowerCase()).not.toMatch(/unsupported state|unable to authenticate|bad decrypt|aes/);
    }
  });

  it('vaultAllValues returns decrypted secrets; rotating the same source skips unreadable rows', () => {
    const d = db();
    vaultSet(d, 'p', 'K', 'redact-me-please-12');
    expect(vaultAllValues(d)).toEqual(['redact-me-please-12']);
    // Same key_id ('sess:v1') but a different SESSION_SECRET — GCM tag fails.
    // Precedence change (env vs sess) is the key_id-mismatch path, covered above.
    initVaultKey({ sessionSecret: SECRET32B });
    expect(() => vaultGet(d, 'p', 'K')).toThrow(
      'stored credential could not be decrypted — re-enter',
    );
    expect(vaultAllValues(d)).toEqual([]);
  });

  it('vaultVerify decrypt-and-discard: ok / missing / mismatch / undecryptable / unavailable', () => {
    const d = db();
    expect(vaultVerify(d, 'p', 'K')).toBe('missing');
    vaultSet(d, 'p', 'K', 'verify-discard-value-xx');
    expect(vaultVerify(d, 'p', 'K')).toBe('ok');

    initVaultKey({ envKey: ENV_KEY, sessionSecret: SECRET32 });
    expect(vaultVerify(d, 'p', 'K')).toBe('mismatch');

    initVaultKey({ sessionSecret: SECRET32 });
    d.prepare('UPDATE plugin_secrets SET ciphertext = ? WHERE plugin_id = ? AND key = ?')
      .run(Buffer.from('tampered-bytes-here'), 'p', 'K');
    expect(vaultVerify(d, 'p', 'K')).toBe('undecryptable');

    initVaultKey({ sessionSecret: SECRET32 });
    vaultSet(d, 'p', 'K2', 'another-stored-secret-yy');
    initVaultKey({ sessionSecret: '' });
    expect(vaultVerify(d, 'p', 'K2')).toBe('unavailable');
  });

  it('vaultPurgePlugin deletes only that plugin\'s rows', () => {
    const d = db();
    initVaultKey({ sessionSecret: SECRET32 });
    vaultSet(d, 'alpha', 'K1', 'secret-alpha-1');
    vaultSet(d, 'alpha', 'K2', 'secret-alpha-2');
    vaultSet(d, 'beta', 'K1', 'secret-beta-1');

    const deleted = vaultPurgePlugin(d, 'alpha');
    expect(deleted).toBe(2);

    expect(vaultGet(d, 'alpha', 'K1')).toBeUndefined();
    expect(vaultGet(d, 'alpha', 'K2')).toBeUndefined();
    expect(vaultGet(d, 'beta', 'K1')?.value).toBe('secret-beta-1');
  });
});
