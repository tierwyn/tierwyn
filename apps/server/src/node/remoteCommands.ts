import type { CommandDescriptor, CommandRecord } from '@tierwyn/shared';

const FILE_BACKED = new Set(['skill', 'plugin', 'command-template']);

/**
 * Merge a remote host's reported commands with the hub catalogue rows (ALL rows,
 * incl. disabled). Operator enabled flags win; file-backed rows (skills, plugins,
 * templates) the host did not report are dropped; unknown remote entries are added.
 * Pass `remote = []` for an offline host: only built-in/user/seed rows survive.
 * Returns enabled rows only, sorted by label.
 */
export function mergeRemoteCommands(
  dbRows: CommandRecord[],
  remote: CommandDescriptor[],
  agentId: string,
): CommandRecord[] {
  const remoteByName = new Map(remote.map((c) => [c.name, c]));
  const out: CommandRecord[] = [];
  const seen = new Set<string>();
  for (const row of dbRows) {
    seen.add(row.name);
    const r = remoteByName.get(row.name);
    // ponytail: hub-local 'builtin' rows (kiro/qwen ACP) always survive; switch to dropping unreported 'discovered' rows if it bites.
    if (!r && row.sourceDetail && FILE_BACKED.has(row.sourceDetail)) continue;
    if (!row.enabled) continue;
    out.push(r ? { ...row, description: r.description ?? row.description, sourceDetail: r.sourceDetail ?? row.sourceDetail } : row);
  }
  for (const r of remote) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push({
      id: `remote:${r.name}`, agentId, name: r.name, label: r.label,
      description: r.description ?? '', source: 'discovered',
      sourceDetail: r.sourceDetail ?? null, enabled: true,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
