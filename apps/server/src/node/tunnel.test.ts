import { createServer } from 'http';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { TUNNEL_MAX_BODY_BYTES, type NodeFrame } from '@tierwyn/shared';
import express from 'express';
import { isLoopback } from '../routes/plugins.js';
import { memoryPair, RpcPeer } from './rpc.js';
import {
  firstFreeLoopbackPort,
  replayTunnelRequest,
  startTunnelListener,
  type TunnelRequest,
  type TunnelResponse,
} from './tunnel.js';
import type { RpcPeer as RpcPeerType } from './rpc.js';

const PATH_TRICKS = [
  '/agent/../conversations/x',
  '//spawn',
  '/spawn%2f..%2fsettings',
  '/SPAWN',
] as const;

const servers: Array<{ close: (cb?: (err?: Error) => void) => void }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve, reject) => {
    s.close((err) => (err ? reject(err) : resolve()));
  })).map((p) => p.catch(() => undefined)));
});

function track<T extends { close: (cb?: (err?: Error) => void) => void }>(s: T): T {
  servers.push(s);
  return s;
}

function call(
  port: number,
  method: string,
  path: string,
  opts?: { body?: Buffer | string; headers?: Record<string, string> },
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const body = opts?.body === undefined ? undefined : Buffer.from(opts.body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: opts?.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function listen(peer: () => RpcPeerType | undefined) {
  const server = track(await startTunnelListener({ port: 0, peer }));
  const addr = server.address() as AddressInfo;
  return { server, port: addr.port };
}

function echoingPeer(): { peer: RpcPeer; frames: TunnelRequest[] } {
  const [hubT, nodeT] = memoryPair();
  const frames: TunnelRequest[] = [];
  new RpcPeer(hubT, {
    http: async (p) => {
      const req = p as TunnelRequest;
      frames.push(req);
      return {
        status: 201,
        headers: { 'x-echo': 'yes', 'content-type': 'text/plain' },
        bodyB64: req.bodyB64,
      } satisfies TunnelResponse;
    },
  });
  const peer = new RpcPeer(nodeT, {});
  return { peer, frames };
}

describe('startTunnelListener', () => {
  it('node listener 404s disallowed path without sending a frame', async () => {
    const frames: unknown[] = [];
    const { port } = await listen((() => ({
      request: async (m: string, p?: unknown) => {
        frames.push({ m, p });
        return { status: 200, headers: {}, bodyB64: '' };
      },
    })) as unknown as () => RpcPeerType);
    const res = await call(port, 'GET', '/settings');
    expect(res.status).toBe(404);
    expect(frames).toHaveLength(0);
  });

  it.each(PATH_TRICKS)('node listener 404s path trick %s without a frame', async (path) => {
    const frames: unknown[] = [];
    const { port } = await listen((() => ({
      request: async (m: string, p?: unknown) => {
        frames.push({ m, p });
        return { status: 200, headers: {}, bodyB64: '' };
      },
    })) as unknown as () => RpcPeerType);
    const res = await call(port, 'POST', path);
    expect(res.status).toBe(404);
    expect(frames).toHaveLength(0);
  });

  it('413 over 8 MiB', async () => {
    const frames: unknown[] = [];
    const { port } = await listen((() => ({
      request: async (m: string, p?: unknown) => {
        frames.push({ m, p });
        return { status: 200, headers: {}, bodyB64: '' };
      },
    })) as unknown as () => RpcPeerType);
    const body = Buffer.alloc(TUNNEL_MAX_BODY_BYTES + 1, 0x61);
    const res = await call(port, 'POST', '/spawn/raw', {
      body,
      headers: { 'content-type': 'text/plain', 'content-length': String(body.length) },
    });
    expect(res.status).toBe(413);
    expect(frames).toHaveLength(0);
  }, 20_000);

  it('503 when hub down', async () => {
    const { port } = await listen(() => undefined);
    const res = await call(port, 'POST', '/spawn/raw', { body: 'hi' });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body.toString())).toEqual({ error: 'hub unreachable' });
  });

  it('allowed POST /spawn/raw round-trips body and status', async () => {
    const { peer, frames } = echoingPeer();
    const { port } = await listen(() => peer);
    const res = await call(port, 'POST', '/spawn/raw', {
      body: 'hello-tunnel',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(201);
    expect(res.body.toString()).toBe('hello-tunnel');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.method).toBe('POST');
    expect(frames[0]!.path).toBe('/spawn/raw');
    expect(Buffer.from(frames[0]!.bodyB64, 'base64').toString()).toBe('hello-tunnel');
  });

  it('canStream=false serves requests through the buffered http RPC', async () => {
    const { peer, frames } = echoingPeer();
    const server = track(await startTunnelListener({
      port: 0,
      peer: () => peer,
      canStream: () => false,
    }));
    const port = (server.address() as AddressInfo).port;
    const res = await call(port, 'GET', '/spawn/x/result');
    expect(res.status).toBe(201);
    expect(frames).toHaveLength(1);
  });

  it('canStream=true dispatches to the streaming tunnel (no buffered RPC)', async () => {
    const [hubT, nodeT] = memoryPair();
    const buffered: unknown[] = [];
    const hub = new RpcPeer(hubT, {
      http: async () => {
        buffered.push(1);
        return { status: 500, headers: {}, bodyB64: '' };
      },
    });
    const headSeen = new Promise<Extract<NodeFrame, { t: 'http.head' }>>((resolve) => {
      hub.on('frame', (f: NodeFrame) => { if (f.t === 'http.head' && f.method !== undefined) resolve(f); });
    });
    const nodePeer = new RpcPeer(nodeT, {});
    const server = track(await startTunnelListener({
      port: 0,
      peer: () => nodePeer,
      canStream: () => true,
    }));
    const port = (server.address() as AddressInfo).port;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/spawn/x/result', method: 'GET', agent: false });
    req.on('error', () => undefined); // destroyed below — swallow the hang-up
    req.end();
    const head = await headSeen;
    req.destroy();
    nodePeer.close();
    hub.close();
    expect(head.method).toBe('GET');
    expect(head.path).toBe('/spawn/x/result');
    expect(buffered).toHaveLength(0);
  });
});

describe('replayTunnelRequest', () => {
  it('replay strips cookie/host/x-forwarded and adds node headers', async () => {
    let seen: { url?: string; headers: http.IncomingHttpHeaders; method?: string } | undefined;
    const echo = track(createServer((req, res) => {
      seen = { url: req.url, headers: req.headers, method: req.method };
      res.writeHead(204);
      res.end();
    }));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const port = (echo.address() as AddressInfo).port;
    const out = await replayTunnelRequest('host-abc', {
      method: 'POST',
      path: '/spawn/raw',
      headers: {
        cookie: 'sid=evil',
        host: 'evil.example',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-proto': 'https',
        'x-tierwyn-node': 'forged',
        'x-tierwyn-node-auth': 'forged-secret',
        'x-tierwyn-node': 'forged-new',
        'x-tierwyn-node-auth': 'forged-secret-new',
        connection: 'keep-alive',
        'content-length': '999',
        'content-type': 'text/plain',
        te: 'trailers',
        'keep-alive': 'timeout=5',
        'proxy-authorization': 'Basic x',
        'accept-encoding': 'gzip',
      },
      bodyB64: Buffer.from('abc').toString('base64'),
    }, { port, nodeSecret: 'real-secret' });
    expect(out.status).toBe(204);
    expect(seen?.url).toBe('/spawn/raw');
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.headers.host).toBe(`127.0.0.1:${port}`);
    expect(seen?.headers['x-forwarded-for']).toBeUndefined();
    expect(seen?.headers['x-forwarded-proto']).toBeUndefined();
    expect(seen?.headers['x-tierwyn-node']).toBe('host-abc');
    expect(seen?.headers['x-tierwyn-node-auth']).toBe('real-secret');
    expect(seen?.headers['content-type']).toBe('text/plain');
    expect(seen?.headers['content-length']).toBe('3');
    expect(seen?.headers.te).toBeUndefined();
    expect(seen?.headers['keep-alive']).toBeUndefined();
    expect(seen?.headers['proxy-authorization']).toBeUndefined();
    expect(seen?.headers['accept-encoding']).toBeUndefined();
  });

  it('GET smuggle body is rejected before the hub (never a second request)', async () => {
    const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }> = [];
    const echo = track(createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
      res.writeHead(204);
      res.end();
    }));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const port = (echo.address() as AddressInfo).port;
    const smuggle = 'POST /settings/compaction HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n';
    const out = await replayTunnelRequest('host-abc', {
      method: 'GET',
      path: '/agent/usage',
      headers: {},
      bodyB64: Buffer.from(smuggle).toString('base64'),
    }, { port, nodeSecret: 'real-secret' });
    await new Promise((r) => setTimeout(r, 50));
    expect(out).toEqual({ status: 400, headers: {}, bodyB64: '' });
    expect(seen).toHaveLength(0);
  });

  it('replay rejects disallowed path even if node sent it', async () => {
    let hits = 0;
    const echo = track(createServer((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end('should-not');
    }));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const port = (echo.address() as AddressInfo).port;
    const out = await replayTunnelRequest('host-abc', {
      method: 'GET',
      path: '/settings',
      headers: {},
      bodyB64: '',
    }, { port, nodeSecret: 's' });
    expect(out.status).toBe(404);
    expect(hits).toBe(0);
  });

  it.each(PATH_TRICKS)('replay rejects path trick %s', async (path) => {
    let hits = 0;
    const echo = track(createServer((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end('no');
    }));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const port = (echo.address() as AddressInfo).port;
    const out = await replayTunnelRequest('host-abc', {
      method: 'POST',
      path,
      headers: {},
      bodyB64: '',
    }, { port, nodeSecret: 's' });
    expect(out.status).toBe(404);
    expect(hits).toBe(0);
  });

  it('caps hub response at TUNNEL_MAX_BODY_BYTES', async () => {
    const echo = track(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(TUNNEL_MAX_BODY_BYTES + 1, 0x61));
    }));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const port = (echo.address() as AddressInfo).port;
    const out = await replayTunnelRequest('host-abc', {
      method: 'GET',
      path: '/agent/usage',
      headers: {},
      bodyB64: '',
    }, { port, nodeSecret: 's' });
    expect(out.status).toBe(502);
    expect(out.headers).toEqual({});
    expect(out.bodyB64).toBe('');
  }, 20_000);

  it('replay hits 127.0.0.1 so loopback-only /agent/plugins/x/help passes', async () => {
    const app = express();
    app.get('/agent/plugins/x/help', (req, res) => {
      if (!isLoopback(req)) {
        res.status(403).json({ error: 'loopback only' });
        return;
      }
      res.type('text/plain').send('help-ok');
    });
    const server = track(app.listen(0, '127.0.0.1'));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on('listening', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const out = await replayTunnelRequest('host-abc', {
      method: 'GET',
      path: '/agent/plugins/x/help',
      headers: {},
      bodyB64: '',
    }, { port, nodeSecret: 's' });
    expect(out.status).toBe(200);
    expect(Buffer.from(out.bodyB64, 'base64').toString()).toBe('help-ok');
  });
});

describe('firstFreeLoopbackPort', () => {
  it('skips a port already held on loopback', async () => {
    const held = createServer();
    await new Promise<void>((r) => held.listen(0, '127.0.0.1', () => r()));
    const port = (held.address() as { port: number }).port;
    try {
      expect(await firstFreeLoopbackPort(port)).toBeGreaterThan(port);
    } finally {
      held.close();
    }
  });
});
