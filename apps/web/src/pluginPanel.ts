import type { PluginCredentialStatus, PluginInvocationRow } from '@tierwyn/shared';

function vaultDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Operator-facing credential row label. Never includes a secret value. */
export function credentialRowLabel(status: PluginCredentialStatus): string {
  if (status.needsReentry) return 'Set (vault, needs re-entry)';
  if (!status.configured) return 'Not set';
  if (status.source === 'vault' && status.updatedAt != null) {
    return `Set (vault, ${vaultDate(status.updatedAt)})`;
  }
  if (status.source === 'vault') return 'Set (vault)';
  return 'Set (env, restart to change)';
}

/** One-line invocation summary. `error` is already safe text from the server. */
export function invocationLine(row: PluginInvocationRow): string {
  const when = Number.isFinite(row.ts) ? new Date(row.ts).toISOString() : String(row.ts);
  const caller = row.callerKind + (row.conversationId ? ` ${row.conversationId}` : '');
  const result = row.ok ? 'ok' : 'fail';
  const err = row.error ? ` ${row.error}` : '';
  return `${when} ${row.capability} ${caller} ${result} ${row.durationMs}ms${err}`;
}

export function deleteConfirmText(p: { id: string; name: string }): string {
  return `Delete plugin "${p.name}" (${p.id})? Its files, stored credentials, settings and invocation history will be removed.`;
}

export function isPluginArchiveName(name: string): boolean {
  return /\.(tar\.gz|tgz)$/i.test(name);
}
