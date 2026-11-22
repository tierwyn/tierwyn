import type { IncomingMessage } from 'http';
import {
  isSpoofableBrandHeader,
  NODE_HEADER,
  NODE_SECRET_HEADER,
  TUNNEL_STREAM_HEADER,
} from './brandHeaders.js';

/**
 * DB-free header helpers shared by the buffered replay (node/tunnel.ts) and
 * the streaming tunnel (node/tunnelStream.ts). The node entry graph imports
 * this module, so it must never reach the hub's SQLite layer.
 */

/** Hub-side: headers that must never cross the tunnel upstream. */
export function dropRequestHeader(key: string): boolean {
  const k = key.toLowerCase();
  if (
    k === 'cookie' || k === 'host' || k === 'connection' || k === 'content-length'
    || k === 'transfer-encoding' || k === 'te' || k === 'upgrade' || k === 'keep-alive'
    || k === 'proxy-authorization' || k === 'expect' || k === 'accept-encoding'
  ) return true;
  if (k.startsWith('x-forwarded-')) return true;
  // C32: strip both brand prefixes so an agent cannot spoof a node header.
  // MCP bridge keys are the sole exemption (isSpoofableBrandHeader).
  if (isSpoofableBrandHeader(k)) return true;
  return false;
}

/** Node → hub loopback header set: drop hop-by-hop, inject node identity. */
export function buildReplayHeaders(
  hostId: string,
  headers: Record<string, string> | undefined,
  nodeSecret: string,
  opts?: { stream?: boolean },
): Record<string, string> {
  const out: Record<string, string> = {};
  let declaredContentLength: string | undefined;
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = k.toLowerCase();
    if (key === 'content-length') {
      declaredContentLength = v;
      continue;
    }
    if (dropRequestHeader(key)) continue;
    out[key] = v;
  }
  out[NODE_HEADER] = hostId;
  out[NODE_SECRET_HEADER] = nodeSecret;
  // Streaming replay only: lets the hub route GET / open-ended MCP safely.
  if (opts?.stream) out[TUNNEL_STREAM_HEADER] = '1';
  if (declaredContentLength !== undefined) out['content-length'] = declaredContentLength;
  return out;
}

/** Node listener: flatten Node's multi-valued IncomingHttpHeaders into the wire format. */
export function flattenIncomingHeaders(h: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Hub → agent response headers. Streaming additionally drops content-length (body is re-chunked). */
export function filterResponseHeaders(h: IncomingMessage['headers'], dropContentLength = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === 'set-cookie' || key === 'transfer-encoding' || key === 'content-encoding') continue;
    if (dropContentLength && key === 'content-length') continue;
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
