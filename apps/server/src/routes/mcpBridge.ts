import type { Database } from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { TUNNEL_MAX_BODY_BYTES, effectiveMcpPlacement } from '@tierwyn/shared';
import { lookupBridgeKey } from '../mcp/bridge.js';
import { getOrCreateHubPipe, makeRowTransport } from '../mcp/hubPipe.js';
import { getMcpServer, readMcpSecret, type McpServerRow } from '../mcp/registry.js';
import { assertOutboundUrl, OutboundUrlError } from '../net/outboundUrl.js';
import {
  firstHeader as headerPref,
  MCP_KEY_HEADERS,
  TUNNEL_STREAM_HEADERS,
} from '../node/brandHeaders.js';

const UPSTREAM_TIMEOUT_MS = 15 * 60_000;

/** Request headers we forward upstream; everything else (auth, cookies, bridge key) is dropped. */
const FORWARDED_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'] as const;

/** Response headers relayed back to the node; never content-length / content-encoding / set-cookie / location. */
const RELAYED_HEADERS = ['content-type', 'mcp-session-id'] as const;

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  (Array.isArray(v) ? v[0] : v) as string | undefined;

export function registerMcpBridgeRoutes(
  app: Express,
  deps: {
    getDb: () => Database;
    fetch?: typeof fetch;
    /** Injectable for tests; default builds the row's stdio/sse transport on the hub. */
    spawnTransport?: (row: McpServerRow) => Transport | Promise<Transport> | undefined;
  },
): void {
  const doFetch = deps.fetch ?? fetch;

  app.all('/agent/mcp/:serverId', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      // Node-tunnel traffic only (originGuard set this after timing-safe auth). Without it
      // the path does not exist: browsers must never be able to probe for bridge keys.
      const hostId = res.locals.nodeHostId as string | undefined;
      if (!hostId) { res.status(404).json({ error: 'not found' }); return; }

      // The node sets the stream marker when it can stream (P3 tunnel); GET is then an
      // open-ended MCP exchange (SSE / server-initiated messages), never buffered.
      const streaming = headerPref(req.headers, TUNNEL_STREAM_HEADERS) === '1';
      const method = req.method;
      if (method === 'HEAD' || !(method === 'POST' || method === 'DELETE' || (method === 'GET' && streaming))) {
        res.set('Allow', 'POST, DELETE').status(405).json({ error: 'method not allowed' });
        return;
      }

      if (method === 'POST' && !req.is('application/json')) {
        res.status(415).json({ error: 'unsupported_media_type' });
        return;
      }

      // The bridge key authorises exactly one (host, session, server-set) tuple.
      const serverId = String(req.params.serverId);
      const entry = lookupBridgeKey(headerPref(req.headers, MCP_KEY_HEADERS) ?? '');
      if (!entry || entry.hostId !== hostId || !entry.serverIds.includes(serverId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      const db = deps.getDb();
      const row = getMcpServer(db, serverId);
      const rowOk = row &&
        row.enabled &&
        effectiveMcpPlacement(row) === 'hub' &&
        (row.transport === 'stdio' || ((row.transport === 'http' || row.transport === 'sse') && row.url));
      if (!row || !rowOk) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      // The key authorised this call; the MCP exchange must never see it (nor any
      // ambient hub auth) — transports only understand MCP headers.
      for (const k of MCP_KEY_HEADERS) delete req.headers[k];
      delete req.headers['authorization'];
      delete req.headers['cookie'];

      if (row.transport === 'http') {
        await forwardHttp(db, row, req, res, method, streaming, doFetch);
        return;
      }

      // stdio / sse: pipe the SDK transport pair cached per (bridge session, server).
      let pipe;
      try {
        pipe = await getOrCreateHubPipe({ sessionId: entry.sessionId, serverId }, () => {
          const spawned = deps.spawnTransport?.(row);
          return spawned !== undefined
            ? spawned
            : makeRowTransport(row, (kind, v) => readMcpSecret(db, row.id, kind, v));
        });
      } catch (err) {
        if (!res.headersSent) {
          if (err instanceof Error && err.message === 'too_many_pipes') {
            res.status(503).json({ error: 'too_many_pipes' });
          } else {
            res.status(502).json({ error: 'upstream_error' });
          }
        }
        return;
      }
      await pipe.down.handleRequest(req, res, method === 'POST' ? req.body : undefined);
    })().catch(() => {
      if (!res.headersSent) res.status(502).json({ error: 'upstream_error' });
    });
  });
}

/** http rows: one request → one upstream response, buffered (P2 nodes) or streamed (P3 tunnel). */
async function forwardHttp(
  db: Database,
  row: McpServerRow,
  req: Request,
  res: Response,
  method: string,
  streaming: boolean,
  doFetch: typeof fetch,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const v = firstHeader(req.headers[name]);
    if (v) headers[name] = v;
  }
  for (const v of row.headers) {
    const value = v.secret ? readMcpSecret(db, row.id, 'header', v) : v.value ?? '';
    if (value === undefined) {
      res.status(502).json({ error: 'secret_missing' });
      return;
    }
    headers[v.key.toLowerCase()] = value;
  }

  try {
    await assertOutboundUrl(row.url!, 'operator-endpoint');
  } catch (err) {
    if (err instanceof OutboundUrlError) {
      res.status(403).json({ error: 'blocked_url', reason: err.code });
      return;
    }
    throw err;
  }

  const upstream = await doFetch(row.url!, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  for (const name of RELAYED_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) res.set(name, v);
  }

  if (!streaming) {
    // Old node: one bounded buffered reply.
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > TUNNEL_MAX_BODY_BYTES) {
      res.status(502).json({ error: 'response_too_large' });
      return;
    }
    if (!res.headersSent) res.status(upstream.status).send(body);
    return;
  }

  // Streaming: no cap — responses can be arbitrarily long-lived SSE.
  res.status(upstream.status);
  if (upstream.body) {
    const pump = Readable.fromWeb(upstream.body as NodeWebReadableStream);
    pump.pipe(res);
    // Client (node) went away: stop pulling upstream.
    res.on('close', () => pump.destroy());
  } else {
    res.end();
  }
}
