/**
 * plugin_invocations journal — additive to the stdout `[plugins]` line.
 * Bound: 500 rows per plugin_id, trimmed on every write. Never throws to
 * callers — host.invoke() swallows DB errors so audit cannot break a call.
 */
import type { Database } from 'better-sqlite3';
import type { PluginInvocationRow } from '@tierwyn/shared';

export function recordInvocation(
  db: Database,
  row: {
    ts: number;
    pluginId: string;
    capability: string;
    callerKind: string;
    conversationId: string | null;
    ok: boolean;
    durationMs: number;
    error: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO plugin_invocations
       (ts, plugin_id, capability, caller_kind, conversation_id, ok, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ts,
    row.pluginId,
    row.capability,
    row.callerKind,
    row.conversationId,
    row.ok ? 1 : 0,
    row.durationMs,
    row.error,
  );
  db.prepare(
    `DELETE FROM plugin_invocations
      WHERE plugin_id = ?
        AND id <= (SELECT MAX(id) - 500 FROM plugin_invocations WHERE plugin_id = ?)`,
  ).run(row.pluginId, row.pluginId);
}

export function listInvocations(
  db: Database,
  pluginId: string,
  limit = 100,
): PluginInvocationRow[] {
  const clamped = Math.min(200, Math.max(1, Math.floor(limit) || 100));
  const rows = db.prepare(
    `SELECT id, ts, plugin_id, capability, caller_kind, conversation_id, ok, duration_ms, error
       FROM plugin_invocations
      WHERE plugin_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  ).all(pluginId, clamped) as Array<{
    id: number;
    ts: number;
    plugin_id: string;
    capability: string;
    caller_kind: string;
    conversation_id: string | null;
    ok: number;
    duration_ms: number;
    error: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    pluginId: r.plugin_id,
    capability: r.capability,
    callerKind: r.caller_kind,
    conversationId: r.conversation_id,
    ok: r.ok === 1,
    durationMs: r.duration_ms,
    error: r.error,
  }));
}

export function purgeInvocations(db: Database, pluginId: string): number {
  const info = db.prepare('DELETE FROM plugin_invocations WHERE plugin_id = ?').run(pluginId);
  return info.changes;
}
