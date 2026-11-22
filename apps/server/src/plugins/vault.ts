/**
 * Plugin credential vault — AES-256-GCM at rest, HKDF-SHA256 key.
 * Fail-closed: no derivation secret ≥32 bytes ⇒ reads AND writes throw.
 * Never log, return, or interpolate credential values.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import type { Database } from 'better-sqlite3';

export type VaultKeyId = 'env:v1' | 'sess:v1';

// HKDF info. Changing it re-derives a different key and every plugin_secrets
// row becomes undecryptable without a re-encryption migration.
const INFO = 'tierwyn:plugin-vault:v1';
const UNAVAILABLE =
  'no derivation secret ≥32 bytes (set SESSION_SECRET or TIERWYN_PLUGIN_VAULT_KEY)';
const KEY_MISMATCH = 'encrypted with a different key — re-enter';
const DECRYPT_FAILED = 'stored credential could not be decrypted — re-enter';

let key: Buffer | undefined;
let keyId: VaultKeyId | undefined;
let reason: string | undefined = UNAVAILABLE;

function missingErr(): Error {
  const msg = reason ?? UNAVAILABLE;
  return Object.assign(new Error(msg), { code: 'credential_missing' as const });
}

function requireKey(): { key: Buffer; keyId: VaultKeyId } {
  if (!key || !keyId) throw missingErr();
  return { key, keyId };
}

export function initVaultKey(o: { envKey?: string; sessionSecret: string }): void {
  const envKey = typeof o.envKey === 'string' && o.envKey.length > 0 ? o.envKey : undefined;
  const ikm = envKey ?? o.sessionSecret ?? '';
  const chosen: VaultKeyId = envKey !== undefined ? 'env:v1' : 'sess:v1';
  if (Buffer.byteLength(ikm, 'utf8') < 32) {
    key = undefined;
    keyId = undefined;
    reason = UNAVAILABLE;
    return;
  }
  key = Buffer.from(hkdfSync('sha256', Buffer.from(ikm, 'utf8'), Buffer.alloc(0), INFO, 32));
  keyId = chosen;
  reason = undefined;
}

export function vaultAvailable(): boolean {
  return key !== undefined && keyId !== undefined;
}

export function vaultUnavailableReason(): string | undefined {
  return vaultAvailable() ? undefined : (reason ?? UNAVAILABLE);
}

export function currentKeyId(): VaultKeyId | undefined {
  return keyId;
}

/** Bumped on vaultSet / vaultClear / vaultPurgePlugin so redact caches cannot go stale. */
let vaultMutateSeq = 0;
export function vaultWriteSeq(): number {
  return vaultMutateSeq;
}
function noteVaultWrite(): void {
  vaultMutateSeq += 1;
}

export function vaultSet(db: Database, pluginId: string, credKey: string, value: string): void {
  const material = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', material.key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  db.prepare(
    `INSERT INTO plugin_secrets (plugin_id, key, key_id, ciphertext, iv, tag, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (plugin_id, key) DO UPDATE SET
       key_id = excluded.key_id,
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       tag = excluded.tag,
       updated_at = excluded.updated_at`,
  ).run(pluginId, credKey, material.keyId, ciphertext, iv, tag, Date.now());
  noteVaultWrite();
}

export function vaultGet(
  db: Database,
  pluginId: string,
  credKey: string,
): { value: string; updatedAt: number } | undefined {
  const material = requireKey();
  const row = db.prepare(
    `SELECT key_id, ciphertext, iv, tag, updated_at
       FROM plugin_secrets WHERE plugin_id = ? AND key = ?`,
  ).get(pluginId, credKey) as
    | { key_id: string; ciphertext: Buffer; iv: Buffer; tag: Buffer; updated_at: number }
    | undefined;
  if (!row) return undefined;
  if (row.key_id !== material.keyId) {
    throw Object.assign(new Error(KEY_MISMATCH), { code: 'credential_missing' as const });
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', material.key, row.iv);
    decipher.setAuthTag(row.tag);
    const value = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    return { value, updatedAt: row.updated_at };
  } catch {
    throw Object.assign(new Error(DECRYPT_FAILED), { code: 'credential_missing' as const });
  }
}

export function vaultClear(db: Database, pluginId: string, credKey: string): boolean {
  const info = db.prepare('DELETE FROM plugin_secrets WHERE plugin_id = ? AND key = ?').run(pluginId, credKey);
  if (info.changes > 0) noteVaultWrite();
  return info.changes > 0;
}

export function vaultPurgePlugin(db: Database, pluginId: string): number {
  const info = db.prepare('DELETE FROM plugin_secrets WHERE plugin_id = ?').run(pluginId);
  if (info.changes > 0) noteVaultWrite();
  return info.changes;
}

export function vaultStatus(
  db: Database,
  pluginId: string,
  credKey: string,
): { updatedAt: number } | undefined {
  const row = db.prepare(
    'SELECT updated_at FROM plugin_secrets WHERE plugin_id = ? AND key = ?',
  ).get(pluginId, credKey) as { updated_at: number } | undefined;
  if (!row) return undefined;
  return { updatedAt: row.updated_at };
}

export type VaultVerifyResult = 'ok' | 'missing' | 'mismatch' | 'undecryptable' | 'unavailable';

/**
 * Decrypt-and-discard. Never returns the plaintext. Used by the operator
 * status path so an undecryptable row cannot look healthy.
 */
export function vaultVerify(db: Database, pluginId: string, credKey: string): VaultVerifyResult {
  const row = vaultStatus(db, pluginId, credKey);
  if (!row) return 'missing';
  if (!vaultAvailable()) return 'unavailable';
  try {
    vaultGet(db, pluginId, credKey);
    return 'ok';
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === KEY_MISMATCH) return 'mismatch';
    return 'undecryptable';
  }
}

export function vaultAllValues(db: Database): string[] {
  const material = requireKey();
  const rows = db.prepare(
    'SELECT key_id, ciphertext, iv, tag FROM plugin_secrets',
  ).all() as Array<{ key_id: string; ciphertext: Buffer; iv: Buffer; tag: Buffer }>;
  const out: string[] = [];
  for (const row of rows) {
    if (row.key_id !== material.keyId) continue;
    try {
      const decipher = createDecipheriv('aes-256-gcm', material.key, row.iv);
      decipher.setAuthTag(row.tag);
      out.push(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'));
    } catch {
      // skip unreadable rows — one bad ciphertext must not empty the redaction feed
    }
  }
  return out;
}
