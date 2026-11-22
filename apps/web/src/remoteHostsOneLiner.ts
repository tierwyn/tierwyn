export type AgentFlagMode = 'later' | 'all' | string[];

/** Hub form is `oneLiner` when the hub has a package; GitHub is always `oneLinerGithub`. */
export function pickOneLiner(
  lines: { oneLiner: string; oneLinerGithub: string },
  fromGithub: boolean,
): string {
  return fromGithub ? lines.oneLinerGithub : lines.oneLiner;
}

const SAFE = /^[a-z0-9-]+$/;

/** Append agent flags to the enrollment one-liner. Client-side string building only; the node enforces. */
export function withAgentFlags(oneLiner: string, mode: AgentFlagMode): string {
  if (mode === 'all') return `${oneLiner} --all-agents`;
  if (mode === 'later') return oneLiner;
  const names = [...new Set(mode.filter((n) => n !== 'grok-bot' && SAFE.test(n)))].sort();
  return names.length ? `${oneLiner} --agents ${names.join(',')}` : oneLiner;
}

/** Agent types a remote host can run (hub-only grok-bot excluded). */
export function remoteSelectableTypes(agents: Array<{ type: string }>): string[] {
  return [...new Set(agents.map((a) => a.type).filter((t) => t !== 'grok-bot' && SAFE.test(t)))].sort();
}
