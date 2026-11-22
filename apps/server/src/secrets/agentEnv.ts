import type { Database } from 'better-sqlite3';
import type { AgentEnvSlice } from '../childEnv.js';
import { COPILOT_ENV_NAME, isDeniedAgentEnvName } from '../childEnv.js';
import { vaultAvailable, vaultGet } from '../plugins/vault.js';
import { AGENT_VAULT_ID } from './mcpRedact.js';

export { COPILOT_ENV_NAME };
export const COPILOT_ENV_VAULT_KEY = `env.copilot.${COPILOT_ENV_NAME}`;
const LEGACY_COPILOT_TOKEN_KEY = 'copilot.token';

const AGENT_ENV_KEY_RE = /^env\.([a-z][a-z0-9-]*)\.([A-Z_][A-Z0-9_]{0,127})$/;

export function agentEnvVaultKey(agentType: string, name: string): string {
  return `env.${agentType}.${name}`;
}

export function parseAgentEnvVaultKey(key: string): { agentType: string; name: string } | undefined {
  const m = AGENT_ENV_KEY_RE.exec(key);
  if (!m) return undefined;
  return { agentType: m[1]!, name: m[2]! };
}

/**
 * One-off boot rename: vault ciphertext is not AAD-bound to the key column,
 * so rewriting `key` is safe. No-op when the destination already exists.
 */
export function migrateCopilotTokenKey(db: Database): void {
  db.prepare(
    `UPDATE plugin_secrets
        SET key = ?
      WHERE plugin_id = ? AND key = ?
        AND NOT EXISTS (
          SELECT 1 FROM plugin_secrets WHERE plugin_id = ? AND key = ?
        )`,
  ).run(
    COPILOT_ENV_VAULT_KEY,
    AGENT_VAULT_ID,
    LEGACY_COPILOT_TOKEN_KEY,
    AGENT_VAULT_ID,
    COPILOT_ENV_VAULT_KEY,
  );
}

export function loadAgentEnv(db: Database, agentType: string): AgentEnvSlice {
  const managedNames = new Set<string>();
  const own: Record<string, string> = {};
  let rows: Array<{ key: string }> = [];
  try {
    rows = db.prepare(
      `SELECT key FROM plugin_secrets WHERE plugin_id = ? AND key LIKE 'env.%'`,
    ).all(AGENT_VAULT_ID) as Array<{ key: string }>;
  } catch {
    return { own, managedNames };
  }
  const canDecrypt = vaultAvailable();
  for (const { key } of rows) {
    const parsed = parseAgentEnvVaultKey(key);
    if (!parsed) continue;
    if (isDeniedAgentEnvName(parsed.name)) {
      console.warn('[agent-env] ignoring now-denied var', parsed.name);
      continue;
    }
    managedNames.add(parsed.name);
    if (!canDecrypt || parsed.agentType !== agentType) continue;
    try {
      const hit = vaultGet(db, AGENT_VAULT_ID, key);
      if (hit) own[parsed.name] = hit.value;
    } catch {
      /* undecryptable: still managed (scrubbed), not injected */
    }
  }
  return { own, managedNames };
}

export function loadAllAgentEnv(db: Database): { vars: Record<string, Record<string, string>>; managedNames: Set<string> } {
  const vars: Record<string, Record<string, string>> = {};
  const managedNames = new Set<string>();
  let rows: Array<{ key: string }> = [];
  try {
    rows = db.prepare(
      `SELECT key FROM plugin_secrets WHERE plugin_id = ? AND key LIKE 'env.%'`,
    ).all(AGENT_VAULT_ID) as Array<{ key: string }>;
  } catch {
    return { vars, managedNames };
  }
  const canDecrypt = vaultAvailable();
  for (const { key } of rows) {
    const parsed = parseAgentEnvVaultKey(key);
    if (!parsed) continue;
    if (isDeniedAgentEnvName(parsed.name)) {
      console.warn('[agent-env] ignoring now-denied var', parsed.name);
      continue;
    }
    managedNames.add(parsed.name);
    if (!canDecrypt) continue;
    try {
      const hit = vaultGet(db, AGENT_VAULT_ID, key);
      if (!hit) continue;
      (vars[parsed.agentType] ??= {})[parsed.name] = hit.value;
    } catch {
      /* undecryptable: still managed (scrubbed on the node), not delivered */
    }
  }
  return { vars, managedNames };
}

export function listAgentEnvVars(db: Database): Array<{ agentType: string; name: string; updatedAt: number; denied?: boolean }> {
  let rows: Array<{ key: string; updated_at: number }> = [];
  try {
    rows = db.prepare(
      `SELECT key, updated_at FROM plugin_secrets WHERE plugin_id = ? AND key LIKE 'env.%'`,
    ).all(AGENT_VAULT_ID) as Array<{ key: string; updated_at: number }>;
  } catch {
    return [];
  }
  const out: Array<{ agentType: string; name: string; updatedAt: number; denied?: boolean }> = [];
  for (const row of rows) {
    const parsed = parseAgentEnvVaultKey(row.key);
    if (!parsed) continue;
    out.push({
      agentType: parsed.agentType,
      name: parsed.name,
      updatedAt: row.updated_at,
      ...(isDeniedAgentEnvName(parsed.name) ? { denied: true } : {}),
    });
  }
  return out;
}
