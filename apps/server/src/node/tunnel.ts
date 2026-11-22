import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { isTunnelPathAllowed, TUNNEL_MAX_BODY_BYTES } from '@tierwyn/shared';
import type { RpcPeer } from './rpc.js';
import { streamNodeRequest } from './tunnelStream.js';
import { buildReplayHeaders, filterResponseHeaders, flattenIncomingHeaders } from './tunnelHeaders.js';

export interface TunnelRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyB64: string;
}
export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
}

const RPC_TIMEOUT_MS = 15 * 60_000;

export type TunnelRequestFn = typeof httpRequest;

/** First port from `start` that is free on loopback. The hub itself holds 8788 when
 *  a node is enrolled on the hub machine. Falls back to `start` if none are free. */
export async function firstFreeLoopbackPort(start: number, tries = 100): Promise<number> {
  for (let port = start; port < start + tries; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  return start;
}

export function startTunnelListener(opts: {
  port: number;
  peer: () => RpcPeer | undefined;
  /** True when the hub advertises `tunnel.stream`; serve requests as http.* frame streams. */
  canStream?: () => boolean;
}): Promise<Server> {
  let nextRid = 1;
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (!isTunnelPathAllowed(method, req.url ?? '/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (opts.canStream?.()) {
      const peer = opts.peer();
      if (peer) {
        streamNodeRequest(peer, req, res, nextRid++);
        return;
      }
    }
    void handleNodeRequest(req, res, opts);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { peer: () => RpcPeer | undefined },
): Promise<void> {
  const method = req.method ?? 'GET';
  const rawPath = req.url ?? '/';
  if (!isTunnelPathAllowed(method, rawPath)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const peer = opts.peer();
  if (!peer) {
    json(res, 503, { error: 'hub unreachable' });
    return;
  }
  try {
    const r = await peer.request<TunnelResponse>('http', {
      method,
      path: rawPath,
      headers: flattenIncomingHeaders(req.headers),
      bodyB64: body.toString('base64'),
    } satisfies TunnelRequest, RPC_TIMEOUT_MS);
    res.writeHead(r.status, r.headers);
    res.end(Buffer.from(r.bodyB64 ?? '', 'base64'));
  } catch {
    json(res, 503, { error: 'hub unreachable' });
  }
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > TUNNEL_MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413);
        res.end();
        resolve(undefined);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400);
        res.end();
      }
      resolve(undefined);
    });
  });
}

export async function replayTunnelRequest(
  hostId: string,
  p: TunnelRequest,
  opts: { port: number; nodeSecret: string; requestFn?: TunnelRequestFn },
): Promise<TunnelResponse> {
  if (!isTunnelPathAllowed(p.method, p.path)) {
    return { status: 404, headers: {}, bodyB64: '' };
  }
  const headers = buildReplayHeaders(hostId, p.headers, opts.nodeSecret);
  const body = Buffer.from(p.bodyB64 || '', 'base64');
  if ((p.method === 'GET' || p.method === 'HEAD') && body.length > 0) {
    return { status: 400, headers: {}, bodyB64: '' };
  }
  headers['content-length'] = String(body.length);
  const request = opts.requestFn ?? httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value: TunnelResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request({
      hostname: '127.0.0.1',
      port: opts.port,
      method: p.method,
      path: p.path,
      headers,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (settled) return;
        size += c.length;
        if (size > TUNNEL_MAX_BODY_BYTES) {
          settle({ status: 502, headers: {}, bodyB64: '' });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      // req.destroy() above makes the socket emit 'socket hang up' on the
      // response — always listen so it can never surface as uncaught.
      res.on('error', () => {
        if (!settled) settle({ status: 502, headers: {}, bodyB64: '' });
      });
      res.on('end', () => {
        if (settled) return;
        settle({
          status: res.statusCode ?? 502,
          headers: filterResponseHeaders(res.headers),
          bodyB64: Buffer.concat(chunks).toString('base64'),
        });
      });
    });
    req.on('error', (err) => {
      if (settled) return;
      reject(err);
    });
    if (body.length) req.write(body);
    req.end();
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
