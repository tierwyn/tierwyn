import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { NodeHello } from '@tierwyn/shared';

export interface RemoteHostRow {
  id: string;
  name: string;
  status: 'pending' | 'enrolled' | 'trusted' | 'disabled';
  publicKey?: string;
  hubOrigin?: string;
  hello: Partial<NodeHello>;
  lastSeenAt?: number;
  allowMcpSecrets: boolean;
  autoTrust: boolean;
  description?: string;
  allowAgentEnvSecrets: boolean;
  enrollExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  name: string;
  status: RemoteHostRow['status'];
  enroll_token_hash: string | null;
  enroll_expires_at: number | null;
  public_key: string | null;
  hub_origin: string | null;
  hello: string;
  last_seen_at: number | null;
  allow_mcp_secrets: number;
  auto_trust: number;
  description: string | null;
  allow_agent_env_secrets: number;
  created_at: number;
  updated_at: number;
}

/** Display-only release semver. Keep a short non-empty string; drop anything else. */
export function sanitizeHelloVersion<T extends Partial<NodeHello>>(hello: T): T {
  const v = hello.version;
  if (typeof v === 'string' && v.length > 0 && v.length <= 32) return hello;
  if (v === undefined && !Object.prototype.hasOwnProperty.call(hello, 'version')) return hello;
  const { version: _drop, ...rest } = hello;
  return rest as T;
}

function parseHello(raw: string): Partial<NodeHello> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? v as Partial<NodeHello> : {};
  } catch {
    return {};
  }
}

function toHost(r: Row): RemoteHostRow {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    ...(r.public_key ? { publicKey: r.public_key } : {}),
    ...(r.hub_origin ? { hubOrigin: r.hub_origin } : {}),
    hello: parseHello(r.hello),
    ...(r.last_seen_at != null ? { lastSeenAt: r.last_seen_at } : {}),
    allowMcpSecrets: r.allow_mcp_secrets === 1,
    autoTrust: r.auto_trust === 1,
    ...(r.description ? { description: r.description } : {}),
    allowAgentEnvSecrets: r.allow_agent_env_secrets === 1,
    ...(r.enroll_expires_at != null ? { enrollExpiresAt: r.enroll_expires_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createPendingHost(
  db: Database,
  name: string,
  tokenHash: string,
  expiresAt: number,
  autoTrust = true,
): RemoteHostRow {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO remote_hosts (id, name, status, enroll_token_hash, enroll_expires_at, auto_trust, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(id, name, tokenHash, expiresAt, autoTrust ? 1 : 0, now, now);
  return getRemoteHost(db, id)!;
}

/** SELECT-only: hash match, unexpired, pending. Does not consume the token. */
export function enrollTokenValid(db: Database, tokenHash: string, now: number): boolean {
  const row = db.prepare(
    `SELECT 1 AS ok FROM remote_hosts
      WHERE enroll_token_hash = ? AND enroll_expires_at > ? AND status = 'pending'`,
  ).get(tokenHash, now) as { ok: number } | undefined;
  return !!row;
}

export function redeemEnrollToken(
  db: Database,
  tokenHash: string,
  now: number,
  enroll: { publicKey: string; hubOrigin: string; hello: Partial<NodeHello> },
): RemoteHostRow | undefined {
  const row = db.prepare(
    `UPDATE remote_hosts
        SET status = CASE WHEN auto_trust = 1 THEN 'trusted' ELSE 'enrolled' END,
            public_key = ?,
            hub_origin = ?,
            hello = ?,
            enroll_token_hash = NULL,
            enroll_expires_at = NULL,
            updated_at = ?
      WHERE enroll_token_hash = ? AND enroll_expires_at > ? AND status = 'pending'
      RETURNING *`,
  ).get(enroll.publicKey, enroll.hubOrigin, JSON.stringify(sanitizeHelloVersion(enroll.hello ?? {})), now, tokenHash, now) as Row | undefined;
  return row ? toHost(row) : undefined;
}

export function getRemoteHost(db: Database, id: string): RemoteHostRow | undefined {
  const r = db.prepare('SELECT * FROM remote_hosts WHERE id = ?').get(id) as Row | undefined;
  return r ? toHost(r) : undefined;
}

export function listRemoteHosts(db: Database): RemoteHostRow[] {
  return (db.prepare('SELECT * FROM remote_hosts ORDER BY created_at DESC').all() as Row[]).map(toHost);
}

export function setRemoteHostStatus(db: Database, id: string, status: RemoteHostRow['status']): void {
  db.prepare('UPDATE remote_hosts SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
}

export function updateRemoteHost(
  db: Database,
  id: string,
  patch: { name?: string; allowMcpSecrets?: boolean; description?: string | null; allowAgentEnvSecrets?: boolean },
): RemoteHostRow | undefined {
  const existing = getRemoteHost(db, id);
  if (!existing) return undefined;
  const name = patch.name ?? existing.name;
  const allow = patch.allowMcpSecrets ?? existing.allowMcpSecrets;
  const description = patch.description === undefined ? (existing.description ?? null) : patch.description;
  const allowEnv = patch.allowAgentEnvSecrets ?? existing.allowAgentEnvSecrets;
  db.prepare(
    'UPDATE remote_hosts SET name = ?, allow_mcp_secrets = ?, description = ?, allow_agent_env_secrets = ?, updated_at = ? WHERE id = ?',
  ).run(name, allow ? 1 : 0, description, allowEnv ? 1 : 0, Date.now(), id);
  return getRemoteHost(db, id);
}

export function saveHello(db: Database, id: string, hello: NodeHello, now: number): void {
  db.prepare('UPDATE remote_hosts SET hello = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(sanitizeHelloVersion(hello)), now, now, id);
}

export function listBoundProjects(db: Database, hostId: string): { id: string; name: string }[] {
  return db.prepare(
    'SELECT id, name FROM projects WHERE remote_host_id = ? ORDER BY name COLLATE NOCASE',
  ).all(hostId) as { id: string; name: string }[];
}

export function deleteRemoteHost(
  db: Database,
  id: string,
  opts?: { unbind?: boolean },
): { ok: boolean; projects: number; projectNames: string[] } {
  const bound = listBoundProjects(db, id);
  const projectNames = bound.map((p) => p.name);
  if (bound.length > 0 && !opts?.unbind) {
    return { ok: false, projects: bound.length, projectNames };
  }
  if (bound.length > 0) {
    db.prepare('UPDATE projects SET remote_host_id = NULL WHERE remote_host_id = ?').run(id);
  }
  db.prepare('DELETE FROM remote_hosts WHERE id = ?').run(id);
  return { ok: true, projects: 0, projectNames };
}

export function remoteHostIdFor(
  db: Database,
  ref: { projectId?: string; conversationId?: string },
): string | null {
  if (ref.projectId) {
    const r = db.prepare('SELECT remote_host_id FROM projects WHERE id = ?')
      .get(ref.projectId) as { remote_host_id: string | null } | undefined;
    return r?.remote_host_id ?? null;
  }
  if (ref.conversationId) {
    const r = db.prepare(
      `SELECT p.remote_host_id AS remote_host_id
         FROM conversations c JOIN projects p ON p.id = c.project_id
        WHERE c.id = ?`,
    ).get(ref.conversationId) as { remote_host_id: string | null } | undefined;
    return r?.remote_host_id ?? null;
  }
  return null;
}

export function keyFingerprint(publicKeyB64: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('base64')
    .replace(/=+$/, '');
  return `SHA256:${digest}`;
}
