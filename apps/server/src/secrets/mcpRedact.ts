/**
 * In-memory redaction set of every MCP secret value (vault rows under `tierwyn:mcp`
 * plus boot-captured TIERWYN_MCP_* env).
 * Applied at the single persist choke point
 * (repositories/events.ts appendEvent). Refreshed at boot and after every secret write.
 */
import type { Database } from 'better-sqlite3';
import { MIN_SECRET_LEN } from '../plugins/host.js';
import { vaultAvailable, vaultGet } from '../plugins/vault.js';
import { capturedMcpEnvValues } from '../mcp/envFallback.js';
import { capturedAaEnvValue } from '../aa/catalogue.js';

export const MCP_VAULT_ID = 'tierwyn:mcp';
/** Built-in agent credentials (`env.<agentType>.<NAME>` plus any leftover rows). Redacted like MCP secrets. */
export const AGENT_VAULT_ID = 'tierwyn:agents';
/** Artificial Analysis (and future third-party) keys. */
export const INTEGRATIONS_VAULT_ID = 'tierwyn:integrations';

let needles: string[] = [];

export function refreshMcpRedactSet(db: Database): void {
  const values = new Set<string>(capturedMcpEnvValues());
  const aa = capturedAaEnvValue();
  if (aa) values.add(aa);
  if (vaultAvailable()) {
    try {
      const keys = db.prepare('SELECT plugin_id, key FROM plugin_secrets WHERE plugin_id IN (?, ?, ?)')
        .all(MCP_VAULT_ID, AGENT_VAULT_ID, INTEGRATIONS_VAULT_ID) as Array<{ plugin_id: string; key: string }>;
      for (const { plugin_id, key } of keys) {
        try {
          const hit = vaultGet(db, plugin_id, key);
          if (hit) values.add(hit.value);
        } catch { /* undecryptable row: nothing to redact, it can't be injected either */ }
      }
    } catch { /* table missing (test DBs) */ }
  }
  const out = new Set<string>();
  for (const v of values) {
    if (v.length < MIN_SECRET_LEN) continue;
    out.add(v);
    // Payloads are redacted after JSON.stringify — also match the escaped form.
    out.add(JSON.stringify(v).slice(1, -1));
  }
  // Longest first so a value that contains another is replaced whole.
  needles = [...out].sort((a, b) => b.length - a.length);
}

export function redactMcpSecrets(text: string): string {
  let out = text;
  for (const n of needles) if (out.includes(n)) out = out.split(n).join('[REDACTED]');
  return out;
}

/** Test seam. */
export function _setMcpRedactNeedles(values: string[]): void {
  needles = values;
}
