/** Branded header names shared by hub and node. */

export const NODE_HEADER = 'x-tierwyn-node';
export const NODE_HEADERS = [NODE_HEADER] as const;

export const NODE_SECRET_HEADER = 'x-tierwyn-node-auth';
export const NODE_SECRET_HEADERS = [NODE_SECRET_HEADER] as const;

export const TUNNEL_STREAM_HEADER = 'x-tierwyn-tunnel-stream';
export const TUNNEL_STREAM_HEADERS = [TUNNEL_STREAM_HEADER] as const;

export const MCP_KEY_HEADER = 'x-tierwyn-mcp-key';
export const MCP_KEY_HEADERS = [MCP_KEY_HEADER] as const;

/** Agent-facing title-case names (HTTP is case-insensitive; Express lowercases). */
export const BRIDGE_HEADER = 'X-Tierwyn-Mcp-Key';
export const BRIDGE_HEADERS = [BRIDGE_HEADER] as const;

export const NODE_ID_HEADER = 'x-tierwyn-node-id';
export const NODE_ID_HEADERS = [NODE_ID_HEADER] as const;

export const NODE_TS_HEADER = 'x-tierwyn-node-ts';
export const NODE_TS_HEADERS = [NODE_TS_HEADER] as const;

export const NODE_SIG_HEADER = 'x-tierwyn-node-sig';
export const NODE_SIG_HEADERS = [NODE_SIG_HEADER] as const;

export const BUILD_ID_HEADER = 'x-tierwyn-build-id';
export const BUILD_ID_HEADERS = [BUILD_ID_HEADER] as const;

export const PACKAGE_SHA_HEADER = 'x-tierwyn-package-sha256';
export const PACKAGE_SHA_HEADERS = [PACKAGE_SHA_HEADER] as const;

export function isMcpKeyHeader(key: string): boolean {
  const k = key.toLowerCase();
  return k === MCP_KEY_HEADER;
}

/**
 * Agent-supplied branded headers that must never cross the tunnel as-is.
 * The node re-injects identity / stream markers after the drop.
 * MCP bridge keys are the sole exemption — they are the agent's proof to the hub.
 */
export function isSpoofableBrandHeader(key: string): boolean {
  const k = key.toLowerCase();
  if (isMcpKeyHeader(k)) return false;
  return k.startsWith('x-tierwyn-');
}

export function firstHeader(
  headers: Record<string, string | string[] | undefined> | Headers,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    let v: string | string[] | null | undefined;
    if (typeof (headers as Headers).get === 'function') {
      v = (headers as Headers).get(name);
    } else {
      v = (headers as Record<string, string | string[] | undefined>)[name]
        ?? (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
    }
    if (v === undefined || v === null) continue;
    const s = Array.isArray(v) ? v[0] : v;
    if (s) return s;
  }
  return undefined;
}

export function deleteHeaders(
  headers: Record<string, string | string[] | undefined>,
  names: readonly string[],
): void {
  for (const n of names) {
    delete headers[n];
    delete headers[n.toLowerCase()];
  }
}
