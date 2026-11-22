/**
 * Effective MCP set for one session start. One resolver, plain-language skip
 * reasons (ResolvedMcpSkipReason) shared by sessionManager and GET /conversations/:id/mcp.
 */
import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { McpTransport, ResolvedMcpServer, ResolvedMcpSkipReason, SpawnTemplate } from '@tierwyn/shared';
import { ACP_MCP_ADAPTERS, MCP_INJECTABLE_ADAPTERS, effectiveMcpPlacement } from '@tierwyn/shared';
import { getMcpServer, mcpSecretStamp, readMcpSecret } from './registry.js';

export { ACP_MCP_ADAPTERS };

/** ACP `initialize` → agentCapabilities.mcpCapabilities, cached per agentType.
 *  ponytail: caps don't change within a binary version; restart picks up upgrades. */
const acpCaps = new Map<string, { http?: boolean; sse?: boolean }>();
export function recordAcpMcpCaps(agentType: string, caps: { http?: boolean; sse?: boolean } | undefined): void {
  acpCaps.set(agentType, { http: caps?.http === true, sse: caps?.sse === true });
}
/** Test seam. */
export function _resetAcpMcpCaps(): void { acpCaps.clear(); }

function transportSupported(agentType: string, t: McpTransport): boolean {
  if (t === 'stdio') return true;
  if (agentType === 'codex' || agentType === 'deepseek') return t === 'http';
  if (ACP_MCP_ADAPTERS.has(agentType)) {
    // Unknown until the first initialize: optimistic here; the adapter filters
    // again with the live caps (toAcpMcpServers), so nothing unsupported is sent.
    const caps = acpCaps.get(agentType);
    return caps ? caps[t] === true : true;
  }
  return true;
}

export interface ResolveInput {
  db: Database;
  conv: {
    mcpServers?: string[] | null;
    parentConversationId?: string;
    disableNativeMcp?: boolean;
    disabledNativeMcp?: string[];
  } | undefined;
  template: SpawnTemplate | undefined;
  agentType: string;
  /** Session would hold a spawn-capable token (tokenEntitlement kind 'spawn'). */
  delegating: boolean;
  /** Set when the session's agent runs on a remote host: hub-placed servers bridge through the node tunnel. */
  remoteHostId?: string | null;
  /** Host advertises `tunnel.stream` (P3+): sse/stdio hub rows can stream; without it only http's buffered fallback works. */
  remoteStreaming?: boolean;
  /** Session working directory — expands `${TIERWYN_CWD}` on injected args/cwd. */
  agentCwd?: string;
}

const CWD_TOKENS = ['${TIERWYN_CWD}'] as const;

export function hasMcpCwdToken(s: string): boolean {
  return CWD_TOKENS.some((t) => s.includes(t));
}

export function expandMcpCwdTokens(s: string, cwd: string): string {
  let out = s;
  for (const t of CWD_TOKENS) out = out.split(t).join(cwd);
  return out;
}

export interface ResolveResult {
  inject: ResolvedMcpServer[];
  skipped: { id: string; reason: ResolvedMcpSkipReason }[];
  /** sha256 over injected id:updated_at + secret stamps; '' when nothing injected. */
  hash: string;
  /** Ids considered, in order (conversation list, else template default). */
  selected: string[];
  disableNative: boolean;
  disabledNative: string[];
}

export function resolveSessionMcp(input: ResolveInput): ResolveResult {
  const { db, agentType } = input;
  // Template default applies to root conversations only; spawned children get
  // exactly their role's list (written at dispatch) — nothing implicit.
  const selected = input.conv?.mcpServers
    ?? (input.conv?.parentConversationId ? undefined : input.template?.mcpServers)
    ?? [];
  const inject: ResolvedMcpServer[] = [];
  const skipped: ResolveResult['skipped'] = [];
  const hashParts: string[] = [];
  // codex forwards secret env by its own name (env_vars) through one shared process env.
  const codexSecretEnv = new Map<string, string>();
  for (const id of selected) {
    const skip = (reason: ResolvedMcpSkipReason) => { skipped.push({ id, reason }); };
    let row;
    try { row = getMcpServer(db, id); } catch { row = undefined; }
    if (!row) { skip('unknown'); continue; }
    if (!row.enabled) { skip('disabled'); continue; }
    if (!MCP_INJECTABLE_ADAPTERS.has(agentType)) { skip('agent_not_injectable'); continue; }
    if (row.agentTypes && !row.agentTypes.includes(agentType)) { skip('agent_filtered'); continue; }
    if (input.delegating && !row.allowInDelegating) { skip('delegating_blocked'); continue; }
    if (!transportSupported(agentType, row.transport)) { skip('transport_unsupported'); continue; }
    const placement = effectiveMcpPlacement(row);
    if (input.remoteHostId && placement === 'hub') {
      // Hub stdio spawns run on the hub's filesystem; ${TIERWYN_CWD}
      // would resolve to the agent's cwd, which only exists on the remote host.
      if (row.transport === 'stdio' &&
          (row.args.some((a) => hasMcpCwdToken(a)) || (row.cwd !== undefined && hasMcpCwdToken(row.cwd)))) {
        skip('hub_cwd_unresolvable'); continue;
      }
      // stdio/sse need the streaming tunnel; http always has the buffered fallback.
      if (row.transport !== 'http' && !input.remoteStreaming) {
        skip('hub_placement_unsupported'); continue;
      }
    }

    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const secretEnvKeys: string[] = [];
    const secretHeaderKeys: string[] = [];
    const stamps: string[] = [];
    let missing = false;
    for (const [kind, vars, out, secretKeys] of [
      ['env', row.env, env, secretEnvKeys],
      ['header', row.headers, headers, secretHeaderKeys],
    ] as const) {
      for (const v of vars) {
        if (!v.secret) { out[v.key] = v.value ?? ''; continue; }
        const value = readMcpSecret(db, row.id, kind, v);
        if (value === undefined) { missing = true; break; }
        out[v.key] = value;
        secretKeys.push(v.key);
        stamps.push(`${kind}/${v.key}@${mcpSecretStamp(db, row.id, kind, v.key)}`);
      }
      if (missing) break;
    }
    if (missing) { skip('secret_missing'); continue; }
    if (agentType === 'codex' && secretEnvKeys.some((k) => codexSecretEnv.has(k) && codexSecretEnv.get(k) !== env[k])) {
      skip('secret_env_unsupported');
      continue;
    }
    if (agentType === 'codex') for (const k of secretEnvKeys) codexSecretEnv.set(k, env[k]);

    const cwd = input.agentCwd;
    const args = cwd ? row.args.map((a) => expandMcpCwdTokens(a, cwd)) : row.args;
    const resolvedCwd = row.cwd !== undefined
      ? (cwd ? expandMcpCwdTokens(row.cwd, cwd) : row.cwd)
      : undefined;
    inject.push({
      id: row.id,
      transport: row.transport,
      ...(row.command !== undefined ? { command: row.command } : {}),
      args,
      ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
      ...(row.url !== undefined ? { url: row.url } : {}),
      ...(input.remoteHostId && placement === 'hub' ? { placement: 'hub' as const } : {}),
      env, headers, secretEnvKeys, secretHeaderKeys,
    });
    hashParts.push(`${row.id}:${row.updatedAt}:${stamps.sort().join(',')}`);
  }
  const disableNative = input.conv?.disableNativeMcp === true;
  const disabledNative = input.conv?.disabledNativeMcp ?? [];
  if (disableNative) {
    hashParts.push('native:disabled');
  }
  if (disabledNative.length) {
    hashParts.push(`native:off:${[...disabledNative].sort().join(',')}`);
  }
  const hash = hashParts.length
    ? createHash('sha256').update(hashParts.sort().join('|')).digest('hex').slice(0, 16)
    : '';
  return { inject, skipped, hash, selected, disableNative, disabledNative };
}
