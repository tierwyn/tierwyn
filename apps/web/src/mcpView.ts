import type { McpLiveStatus, ResolvedMcpSkipReason } from '@tierwyn/shared';
import { mcpAgentCapability } from '@tierwyn/shared';

export type McpSelectionMode = 'inherit' | 'custom' | 'none';

/**
 * Returns plain-words description for resolver skip reasons.
 */
export function describeSkipReason(reason: ResolvedMcpSkipReason | string | undefined): string {
  switch (reason) {
    case 'delegating_blocked':
      return "Blocked: this chat can delegate — enable 'Allow in delegating chats' on the server";
    case 'disabled':
      return 'Disabled on the server';
    case 'unknown':
      return 'Unknown or removed server';
    case 'agent_not_injectable':
      return 'Agent does not support registry MCP injection';
    case 'agent_filtered':
      return "Excluded by server's agent filter";
    case 'transport_unsupported':
      return 'Transport is unsupported by this agent';
    case 'secret_missing':
      return 'Missing required secret (vault or env fallback)';
    case 'secret_env_unsupported':
      return 'Agent does not support secret env vars for this transport';
    case 'hub_placement_unsupported':
      return 'Hub placement supports http servers only (for now)';
    case 'command_not_found_on_host':
      return 'Command not found on the remote host';
    case 'cwd_outside_roots':
      return "Working directory is outside the remote host's allowed roots";
    default:
      return reason ? `Skipped: ${reason}` : 'Skipped';
  }
}

/**
 * Summarises live MCP statuses into counts and a display label.
 */
export function summariseStatus(statuses: McpLiveStatus[] | undefined | null): {
  total: number;
  connected: number;
  label: string;
} {
  if (!statuses || statuses.length === 0) {
    return { total: 0, connected: 0, label: 'MCP' };
  }
  const total = statuses.length;
  const connected = statuses.filter((s) => s.status === 'connected').length;
  return {
    total,
    connected,
    label: `MCP ${connected}/${total}`,
  };
}

/**
 * Maps live MCP status to badge severity variant.
 */
export function statusSeverity(status: McpLiveStatus['status']): 'success' | 'danger' | 'warning' | 'muted' {
  switch (status) {
    case 'connected':
      return 'success';
    case 'failed':
      return 'danger';
    case 'needs-auth':
    case 'pending':
      return 'warning';
    case 'disabled':
    default:
      return 'muted';
  }
}

/**
 * Tri-state selection helper for conversation MCP selection:
 * - null / undefined => 'inherit' (template default)
 * - empty array [] => 'none' (explicitly disabled)
 * - non-empty array => 'custom' (explicit list of server IDs)
 */
export function getMcpSelectionMode(selected: string[] | null | undefined): McpSelectionMode {
  if (selected === null || selected === undefined) return 'inherit';
  if (Array.isArray(selected) && selected.length === 0) return 'none';
  return 'custom';
}

/**
 * Converts tri-state selection mode and custom IDs back into the stored shape:
 * - 'inherit' => null
 * - 'none' => []
 * - 'custom' => customIds
 */
export function resolveSelectedIds(mode: McpSelectionMode, customIds: string[]): string[] | null {
  if (mode === 'inherit') return null;
  if (mode === 'none') return [];
  return [...customIds];
}

/**
 * Computes the input-bar MCP pill label across idle (pre-prompt) and live states.
 */
export function summariseChipLabel(
  statuses: McpLiveStatus[] | null | undefined,
  effective: { id: string; injected: boolean }[] | null | undefined,
  selected: string[] | null | undefined,
  disableNative?: boolean,
  disabledNative?: string[],
): { label: string; activeCount: number; isModified: boolean } {
  const isModified =
    (selected !== null && selected !== undefined) ||
    disableNative === true ||
    Boolean(disabledNative && disabledNative.length > 0);

  if (statuses && statuses.length > 0) {
    const s = summariseStatus(statuses);
    return { label: s.label, activeCount: s.connected, isModified };
  }
  const injectedCount = (effective ?? []).filter((e) => e.injected).length;
  if (injectedCount > 0) {
    return { label: `MCP ${injectedCount}`, activeCount: injectedCount, isModified };
  }
  if (Array.isArray(selected) && selected.length === 0) {
    return { label: 'MCP Off', activeCount: 0, isModified };
  }
  return { label: 'MCP', activeCount: 0, isModified };
}


/** One-line capability summary for an agent, e.g. "Registry injection: supported · Native overrides: enforced". */
export function describeMcpCapability(agentType: string): string {
  const c = mcpAgentCapability(agentType);
  return `Registry injection: ${c.registryInjection === 'supported' ? 'supported' : 'not supported'} · Native overrides: ${c.nativeOverrides === 'enforced' ? 'enforced' : 'not enforced'}`;
}
