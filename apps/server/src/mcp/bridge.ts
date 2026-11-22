/**
 * Hub-placed MCP servers for remote sessions. The hub rewrites each hub server
 * to `http://127.0.0.1:<nodeListenPort>/agent/mcp/<id>` carrying a per-session
 * 256-bit key; the agent's node forwards via its tunnel listener and the hub
 * route (registerMcpBridgeRoutes) validates the key before proxying to the
 * real hub-local server. Keys never transit the agent except inside that header.
 */
import { randomBytes } from 'node:crypto';
import type { ResolvedMcpServer, ResolvedMcpSkipReason } from '@tierwyn/shared';
import { BRIDGE_HEADER, BRIDGE_HEADERS } from '../node/brandHeaders.js';
import { closeHubPipesForSession } from './hubPipe.js';

export { BRIDGE_HEADER };

export interface BridgeEntry {
  conversationId: string;
  sessionId: string;
  hostId: string;
  serverIds: string[];
}

const byKey = new Map<string, BridgeEntry>();
const bySession = new Map<string, string[]>();

export function lookupBridgeKey(key: string): BridgeEntry | undefined {
  return byKey.get(key);
}

export function revokeBridgeKeysForSession(sessionId: string): void {
  for (const k of bySession.get(sessionId) ?? []) byKey.delete(k);
  bySession.delete(sessionId);
  // Auth is dead immediately; pipe teardown (incl. killing stdio children) drains async.
  void closeHubPipesForSession(sessionId);
}

export function bridgeServers(
  servers: ResolvedMcpServer[] | undefined,
  ctx: { conversationId: string; sessionId: string; hostId: string; listenPort: number },
): ResolvedMcpServer[] | undefined {
  revokeBridgeKeysForSession(ctx.sessionId);
  if (!servers || !servers.some((s) => s.placement === 'hub')) return servers;
  const key = randomBytes(32).toString('hex');
  const hubIds: string[] = [];
  const out = servers.map((s) => {
    if (s.placement !== 'hub') return s;
    hubIds.push(s.id);
    return {
      ...s,
      transport: 'http' as const,
      args: [],
      url: `http://127.0.0.1:${ctx.listenPort}/agent/mcp/${s.id}`,
      env: {},
      headers: { [BRIDGE_HEADER]: key },
      secretEnvKeys: [],
      secretHeaderKeys: [...BRIDGE_HEADERS],
    };
  });
  byKey.set(key, { conversationId: ctx.conversationId, sessionId: ctx.sessionId, hostId: ctx.hostId, serverIds: hubIds });
  bySession.set(ctx.sessionId, [key]);
  return out;
}

const SKIPS_MAX = 200;
// ponytail: in-memory, lost on restart; next session start refills it.
const skipsByConversation = new Map<string, { id: string; reason: ResolvedMcpSkipReason }[]>();

/** Why hub-eligible servers did not inject for a remote conversation (web surfaces these). */
export function recordHostMcpSkips(conversationId: string, skips: { id: string; reason: ResolvedMcpSkipReason }[]): void {
  skipsByConversation.delete(conversationId); // refresh insertion order on re-record
  if (!skips.length) return;
  skipsByConversation.set(conversationId, skips);
  while (skipsByConversation.size > SKIPS_MAX) {
    const oldest = skipsByConversation.keys().next().value;
    if (oldest === undefined) break;
    skipsByConversation.delete(oldest);
  }
}

export function hostMcpSkips(conversationId: string): { id: string; reason: ResolvedMcpSkipReason }[] {
  return skipsByConversation.get(conversationId) ?? [];
}
