/**
 * MCP server registry (migration 140). Rows hold descriptors only; secret values
 * live in the plugin vault under MCP_VAULT_ID with key `<id>/<kind>/<KEY>`.
 */
import type { Database } from 'better-sqlite3';
import type { McpPlacement, McpPublicVar, McpSecretKind, McpServerDef, McpServerNormalised, McpTransport, McpVar } from '@tierwyn/shared';
import { vaultClear, vaultGet, vaultSet, vaultStatus, vaultVerify } from '../plugins/vault.js';
import { MIN_SECRET_LEN } from '../plugins/host.js';
import { getCapturedMcpEnv } from './envFallback.js';
import { maskUrl } from './native.js';
import { MCP_VAULT_ID, refreshMcpRedactSet } from '../secrets/mcpRedact.js';

export { MCP_VAULT_ID };

/** Stored row, parsed. Never sent to clients — use toPublicDef. */
export interface McpServerRow {
  id: string;
  transport: McpTransport;
  placement: McpPlacement;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  env: McpVar[];
  headers: McpVar[];
  description?: string;
  enabled: boolean;
  allowInDelegating: boolean;
  agentTypes: string[] | null;
  createdAt: number;
  updatedAt: number;
}

interface DbRow {
  id: string; transport: string; placement: string | null; command: string | null; args: string; cwd: string | null;
  url: string | null; env: string; headers: string; description: string | null;
  enabled: number; allow_in_delegating: number; agent_types: string | null;
  created_at: number; updated_at: number;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (s == null) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function fromDb(r: DbRow): McpServerRow {
  return {
    id: r.id,
    transport: r.transport as McpTransport,
    placement: (r.placement ?? 'auto') as McpPlacement,
    ...(r.command != null ? { command: r.command } : {}),
    args: parseJson<string[]>(r.args, []),
    ...(r.cwd != null ? { cwd: r.cwd } : {}),
    ...(r.url != null ? { url: r.url } : {}),
    env: parseJson<McpVar[]>(r.env, []),
    headers: parseJson<McpVar[]>(r.headers, []),
    ...(r.description != null ? { description: r.description } : {}),
    enabled: r.enabled === 1,
    allowInDelegating: r.allow_in_delegating === 1,
    agentTypes: parseJson<string[] | null>(r.agent_types, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function secretVaultKey(id: string, kind: McpSecretKind, key: string): string {
  return `${id}/${kind}/${key}`;
}

export function listMcpServers(db: Database): McpServerRow[] {
  return (db.prepare('SELECT * FROM mcp_servers ORDER BY id').all() as DbRow[]).map(fromDb);
}

export function getMcpServer(db: Database, id: string): McpServerRow | undefined {
  const r = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as DbRow | undefined;
  return r ? fromDb(r) : undefined;
}

function vaultKeysFor(db: Database, id: string): string[] {
  return (db.prepare("SELECT key FROM plugin_secrets WHERE plugin_id = ? AND key LIKE ? ESCAPE '\\'")
    .all(MCP_VAULT_ID, `${id.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`) as Array<{ key: string }>).map((r) => r.key);
}

function declaredSecretKeys(row: Pick<McpServerRow, 'id' | 'env' | 'headers'>): Set<string> {
  return new Set([
    ...row.env.filter((v) => v.secret).map((v) => secretVaultKey(row.id, 'env', v.key)),
    ...row.headers.filter((v) => v.secret).map((v) => secretVaultKey(row.id, 'header', v.key)),
  ]);
}

export function upsertMcpServer(db: Database, input: McpServerNormalised, now = Date.now()): McpServerRow {
  const prev = getMcpServer(db, input.id);
  db.prepare(
    `INSERT INTO mcp_servers (id, transport, placement, command, args, cwd, url, env, headers, description,
       enabled, allow_in_delegating, agent_types, created_at, updated_at)
     VALUES (@id, @transport, @placement, @command, @args, @cwd, @url, @env, @headers, @description,
       @enabled, @allow, @agentTypes, @createdAt, @updatedAt)
     ON CONFLICT (id) DO UPDATE SET transport = excluded.transport, placement = excluded.placement,
       command = excluded.command,
       args = excluded.args, cwd = excluded.cwd, url = excluded.url, env = excluded.env,
       headers = excluded.headers, description = excluded.description, enabled = excluded.enabled,
       allow_in_delegating = excluded.allow_in_delegating, agent_types = excluded.agent_types,
       updated_at = excluded.updated_at`,
  ).run({
    id: input.id,
    transport: input.transport,
    placement: input.placement,
    command: input.command ?? null,
    args: JSON.stringify(input.args),
    cwd: input.cwd ?? null,
    url: input.url ?? null,
    env: JSON.stringify(input.env),
    headers: JSON.stringify(input.headers),
    description: input.description ?? null,
    enabled: input.enabled ? 1 : 0,
    allow: input.allowInDelegating ? 1 : 0,
    agentTypes: input.agentTypes === null ? null : JSON.stringify(input.agentTypes),
    createdAt: prev?.createdAt ?? now,
    updatedAt: Math.max(now, (prev?.updatedAt ?? 0) + 1),
  });
  // A var that stopped being secret (or was removed) must not leave its value behind.
  const keep = declaredSecretKeys(input);
  let cleared = false;
  for (const k of vaultKeysFor(db, input.id)) {
    if (!keep.has(k)) { vaultClear(db, MCP_VAULT_ID, k); cleared = true; }
  }
  if (cleared) refreshMcpRedactSet(db);
  return getMcpServer(db, input.id)!;
}

export function deleteMcpServer(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  for (const k of vaultKeysFor(db, id)) vaultClear(db, MCP_VAULT_ID, k);
  refreshMcpRedactSet(db);
  return info.changes > 0;
}

/** Throws (vault unavailable) — the route maps that to 503. */
export function setMcpSecret(db: Database, id: string, kind: McpSecretKind, key: string, value: string): void {
  vaultSet(db, MCP_VAULT_ID, secretVaultKey(id, kind, key), value);
  refreshMcpRedactSet(db);
}

export function clearMcpSecret(db: Database, id: string, kind: McpSecretKind, key: string): boolean {
  const ok = vaultClear(db, MCP_VAULT_ID, secretVaultKey(id, kind, key));
  refreshMcpRedactSet(db);
  return ok;
}

/** Where a secret var's value would come from right now. Never returns the value. */
export function mcpSecretStatus(db: Database, id: string, kind: McpSecretKind, v: McpVar): 'vault' | 'env' | null {
  let ok = false;
  try { ok = vaultVerify(db, MCP_VAULT_ID, secretVaultKey(id, kind, v.key)) === 'ok'; } catch { ok = false; }
  if (ok) return 'vault';
  if (!v.envFallback) return null;
  const envVal = getCapturedMcpEnv(v.envFallback);
  return envVal !== undefined && envVal.length >= MIN_SECRET_LEN ? 'env' : null;
}

/** Vault first, then boot-captured env fallback; undefined = missing (fail closed). */
export function readMcpSecret(db: Database, id: string, kind: McpSecretKind, v: McpVar): string | undefined {
  try {
    const hit = vaultGet(db, MCP_VAULT_ID, secretVaultKey(id, kind, v.key));
    if (hit) return hit.value;
  } catch { /* vault unavailable / mismatch → env fallback */ }
  if (v.envFallback) {
    const envVal = getCapturedMcpEnv(v.envFallback);
    if (envVal !== undefined && envVal.length >= MIN_SECRET_LEN) return envVal;
  }
  return undefined;
}

/** Vault updated_at stamp (0 if none) — feeds mcpSetHash so a rotated secret reaps. */
export function mcpSecretStamp(db: Database, id: string, kind: McpSecretKind, key: string): number {
  try { return vaultStatus(db, MCP_VAULT_ID, secretVaultKey(id, kind, key))?.updatedAt ?? 0; } catch { return 0; }
}

export function toPublicDef(db: Database, row: McpServerRow): McpServerDef {
  const pub = (kind: McpSecretKind) => (v: McpVar): McpPublicVar => {
    if (!v.secret) return { key: v.key, secret: false, value: v.value ?? '' };
    const source = mcpSecretStatus(db, row.id, kind, v);
    return {
      key: v.key, secret: true,
      ...(v.envFallback ? { envFallback: v.envFallback } : {}),
      configured: source !== null, source,
    };
  };
  return {
    id: row.id,
    transport: row.transport,
    placement: row.placement,
    ...(row.command !== undefined ? { command: row.command } : {}),
    args: row.args,
    ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
    ...(row.url !== undefined ? { url: maskUrl(row.url) } : {}),
    env: row.env.map(pub('env')),
    headers: row.headers.map(pub('header')),
    ...(row.description !== undefined ? { description: row.description } : {}),
    enabled: row.enabled,
    allowInDelegating: row.allowInDelegating,
    agentTypes: row.agentTypes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
