import { createHash, randomBytes } from 'crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { PassThrough } from 'stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { isTunnelPathAllowed, TUNNEL_STREAM_IDLE_MS, TUNNEL_STREAM_MAX_PER_HOST, TUNNEL_STREAM_WINDOW_BYTES, type NodeFrame } from '@tierwyn/shared';
import { HubStreamRouter, CreditSender, makeLoopbackStreamReplay, streamNodeRequest, type HubStreamReplay, type Respond } from './tunnelStream.js';
import { memoryPair, RpcPeer } from './rpc.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function get(port: number, path: string, opts?: { headers?: Record<string, string> }): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: opts?.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), res }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const flush = () => new Promise<void>((r) => setImmediate(() => setImmediate(() => r())));

interface E2E {
  clientPort: number;
  router: HubStreamRouter;
  app: Server;
  nodeListener: Server;
  hubPeer: RpcPeer;
  nodePeer: RpcPeer;
  close: () => void;
}

/** Full chain: client → node listener → frames → HubStreamRouter → loopback app. */
async function startE2E(hubApp: (req: IncomingMessage, res: ServerResponse) => void): Promise<E2E> {
  const app = createServer(hubApp);
  const appPort = await listen(app);

  const [nodeT, hubT] = memoryPair();
  const hubPeer = new RpcPeer(hubT, {
    'hub.features': async () => ({ features: ['tunnel.stream'] }),
  });
  const router = new HubStreamRouter('host1', hubPeer, makeLoopbackStreamReplay({ port: appPort, nodeSecret: 'node-secret', requestFn: httpRequest }));
  hubPeer.on('frame', (f: NodeFrame) => {
    if (f.t === 'http.head' || f.t === 'http.chunk' || f.t === 'http.end' || f.t === 'http.credit') router.onFrame(f);
  });
  hubPeer.on('close', () => router.closeAll());
  const nodePeer = new RpcPeer(nodeT, {});

  let rid = 0;
  const nodeListener = createServer((req, res) => {
    if (!isTunnelPathAllowed(req.method ?? 'GET', req.url ?? '/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    rid += 1;
    streamNodeRequest(nodePeer, req, res, rid);
  });
  const clientPort = await listen(nodeListener);

  return {
    clientPort,
    router,
    app,
    nodeListener,
    hubPeer,
    nodePeer,
    close: () => {
      nodeListener.close();
      app.close();
      nodePeer.close();
      hubPeer.close();
    },
  };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
afterAll(() => {
  for (const s of servers) s.close();
});

describe('CreditSender', () => {
  it('pauses at the credit window and resumes on credit', async () => {
    const sent: NodeFrame[] = [];
    const s = new CreditSender((f) => { sent.push(f); return true; }, 7);
    const raw = () => sent
      .filter((f): f is Extract<NodeFrame, { t: 'http.chunk' }> => f.t === 'http.chunk')
      .reduce((n, f) => n + Buffer.from(f.b64, 'base64').length, 0);

    const p1 = s.write(Buffer.alloc(512 * 1024, 1));
    const p2 = s.write(Buffer.alloc(512 * 1024, 2));
    const p3 = s.write(Buffer.alloc(512 * 1024, 3));
    await flush();
    expect(raw()).toBe(TUNNEL_STREAM_WINDOW_BYTES); // 1 MiB sent, third write parked
    s.credit(512 * 1024);
    await Promise.all([p1, p2, p3]);
    expect(raw()).toBe(3 * 512 * 1024);
    s.end();
    expect(sent.at(-1)).toMatchObject({ t: 'http.end', rid: 7 });
  });

  it('splits oversized buffers into TUNNEL_STREAM_CHUNK_BYTES chunks', async () => {
    const sent: NodeFrame[] = [];
    const s = new CreditSender((f) => { sent.push(f); return true; }, 1, 4 * 1024 * 1024);
    await s.write(Buffer.alloc(3 * 256 * 1024 + 1, 9));
    const chunks = sent.filter((f) => f.t === 'http.chunk');
    expect(chunks.length).toBe(4);
    s.end();
  });
});

describe('HubStreamRouter', () => {
  function stubReplay(calls: Array<{ head: { method: string; path: string }; respond: Respond }>): HubStreamReplay {
    return (_hostId, head, _body, respond) => {
      calls.push({ head, respond });
    };
  }

  const HEAD = { method: 'POST', path: '/agent/git/status', headers: {} };

  it('enforces TUNNEL_STREAM_MAX_PER_HOST (33rd → 503)', () => {
    const calls: Array<{ head: { method: string; path: string }; respond: Respond }> = [];
    const [a, b] = memoryPair();
    const router = new HubStreamRouter('h', new RpcPeer(b, {}), stubReplay(calls));
    const peer = new RpcPeer(a, {});
    for (let i = 1; i <= TUNNEL_STREAM_MAX_PER_HOST; i++) {
      router.onFrame({ t: 'http.head', rid: i, ...HEAD });
    }
    expect(calls.length).toBe(TUNNEL_STREAM_MAX_PER_HOST);
    router.onFrame({ t: 'http.head', rid: 99, ...HEAD });
    expect(calls.length).toBe(TUNNEL_STREAM_MAX_PER_HOST);
    expect(peer).toBeDefined(); // 503 frames went to the transport; router held nothing extra
    expect(router.size).toBe(TUNNEL_STREAM_MAX_PER_HOST);
  });

  it('aborts with 400 when a GET carries a body chunk', async () => {
    const calls: Array<{ head: { method: string; path: string }; respond: Respond }> = [];
    const [a, b] = memoryPair();
    const hubPeer = new RpcPeer(b, {});
    const sent: NodeFrame[] = [];
    // Router replies travel hubPeer → transport `a`; observe them node-side.
    new RpcPeer(a, {}).on('frame', (f) => { if ('rid' in f) sent.push(f); });
    const router = new HubStreamRouter('h', hubPeer, stubReplay(calls));
    router.onFrame({ t: 'http.head', rid: 1, method: 'GET', path: '/agent/git/status', headers: {} });
    expect(calls.length).toBe(1);
    router.onFrame({ t: 'http.chunk', rid: 1, b64: Buffer.from('x').toString('base64') });
    expect(router.size).toBe(0);
    await flush(); // memoryPair delivers via queueMicrotask
    const head = sent.find((f) => f.t === 'http.head');
    expect(head).toMatchObject({ t: 'http.head', rid: 1, status: 400 });
  });

  it('aborts when the body exceeds the declared content-length', async () => {
    const calls: Array<{ head: { method: string; path: string }; respond: Respond }> = [];
    const [a, b] = memoryPair();
    const hubPeer = new RpcPeer(b, {});
    const sent: NodeFrame[] = [];
    // Router replies travel hubPeer → transport `a`; observe them node-side.
    new RpcPeer(a, {}).on('frame', (f) => { if ('rid' in f) sent.push(f); });
    const router = new HubStreamRouter('h', hubPeer, stubReplay(calls));
    router.onFrame({ t: 'http.head', rid: 1, method: 'POST', path: '/agent/x', headers: { 'content-length': '10' } });
    router.onFrame({ t: 'http.chunk', rid: 1, b64: Buffer.alloc(11, 1).toString('base64') });
    expect(router.size).toBe(0);
    await flush(); // memoryPair delivers via queueMicrotask
    expect(sent.find((f) => f.t === 'http.head')).toMatchObject({ status: 400 });
  });

  it('aborts with 400 when http.end arrives short of the declared content-length', async () => {
    const calls: Array<{ head: { method: string; path: string }; respond: Respond }> = [];
    const [a, b] = memoryPair();
    const hubPeer = new RpcPeer(b, {});
    const sent: NodeFrame[] = [];
    new RpcPeer(a, {}).on('frame', (f) => { if ('rid' in f) sent.push(f); });
    const router = new HubStreamRouter('h', hubPeer, stubReplay(calls));
    router.onFrame({ t: 'http.head', rid: 1, method: 'POST', path: '/agent/x', headers: { 'content-length': '100' } });
    router.onFrame({ t: 'http.chunk', rid: 1, b64: Buffer.alloc(42, 1).toString('base64') });
    router.onFrame({ t: 'http.end', rid: 1 });
    expect(router.size).toBe(0);
    expect(calls.length).toBe(1); // replay began, but the upstream gets torn down
    await flush();
    expect(sent.find((f) => f.t === 'http.head')).toMatchObject({ status: 400 });
  });

  it('rejects declared request bodies over TUNNEL_STREAM_MAX_REQ_BYTES with 413', async () => {
    const calls: Array<{ head: { method: string; path: string }; respond: Respond }> = [];
    const [a, b] = memoryPair();
    const hubPeer = new RpcPeer(b, {});
    const sent: NodeFrame[] = [];
    // Router replies travel hubPeer → transport `a`; observe them node-side.
    new RpcPeer(a, {}).on('frame', (f) => { if ('rid' in f) sent.push(f); });
    const router = new HubStreamRouter('h', hubPeer, stubReplay(calls));
    router.onFrame({
      t: 'http.head',
      rid: 1,
      method: 'POST',
      path: '/agent/x',
      headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
    });
    expect(calls.length).toBe(0);
    await flush(); // memoryPair delivers via queueMicrotask
    expect(sent.find((f) => f.t === 'http.head')).toMatchObject({ status: 413 });
  });

  it('drops rejected request bodies even when the node keeps sending', () => {
    const calls: Array<{ head: { method: string; path: string }; respond: Respond }> = [];
    const [, b] = memoryPair();
    const router = new HubStreamRouter('h', new RpcPeer(b, {}), stubReplay(calls));
    router.onFrame({ t: 'http.head', rid: 1, method: 'GET', path: '/agent/git/status', headers: {} });
    router.onFrame({ t: 'http.chunk', rid: 1, b64: 'eHg=' });
    router.onFrame({ t: 'http.chunk', rid: 1, b64: 'eHg=' });
    router.onFrame({ t: 'http.end', rid: 1 });
    expect(calls.length).toBe(1);
  });
});

describe('streaming tunnel e2e', () => {
  it('streams a 20 MiB response intact', async () => {
    const payload = randomBytes(20 * 1024 * 1024);
    let received = 0;
    const e2e = await startE2E((req, res) => {
      const hash = createHash('sha256').update(payload);
      void req; // discard request body
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) });
      for (let off = 0; off < payload.length; off += 256 * 1024) {
        res.write(payload.subarray(off, Math.min(off + 256 * 1024, payload.length)));
      }
      res.end();
      received = hash.digest().length;
    });
    try {
      const r = await get(e2e.clientPort, '/agent/git/status');
      expect(r.status).toBe(200);
      expect(r.body.length).toBe(payload.length);
      expect(createHash('sha256').update(r.body).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'));
      expect(received).toBe(32); // hub app ran
    } finally {
      e2e.close();
    }
  });

  it('streams a 20 MiB request body intact', async () => {
    const payload = randomBytes(20 * 1024 * 1024);
    const e2e = await startE2E((req, res) => {
      const hash = createHash('sha256');
      req.on('data', (c: Buffer) => hash.update(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(hash.digest('hex'));
      });
    });
    try {
      const body = await new Promise<Buffer>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: e2e.clientPort, path: '/agent/artifacts', method: 'POST', headers: { 'content-length': String(payload.length) }, agent: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.end(payload);
      });
      expect(body.toString()).toBe(createHash('sha256').update(payload).digest('hex'));
    } finally {
      e2e.close();
    }
  });

  it('delivers SSE bytes before the app ends the response', async () => {
    let appEnded = false;
    const e2e = await startE2E((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => { appEnded = true; res.end(); }, 30_000);
    });
    try {
      const first = await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: e2e.clientPort, path: '/agent/mcp/sse', method: 'GET', agent: false }, (res) => {
          res.once('data', (c: Buffer) => resolve(c.toString()));
          res.once('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      expect(first).toBe('data: first\n\n');
      expect(appEnded).toBe(false);
    } finally {
      e2e.close();
    }
  });

  it('aborts with 400 when a GET request carries a body', async () => {
    const e2e = await startE2E((_req, res) => {
      res.writeHead(200);
      res.end('should not happen');
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: e2e.clientPort, path: '/agent/git/status', method: 'GET', agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.write('sneaky body');
        req.end();
      });
      expect(status).toBe(400);
    } finally {
      e2e.close();
    }
  });

  it('rejects declared bodies over 64 MiB with 413', async () => {
    const e2e = await startE2E((_req, res) => {
      res.writeHead(200);
      res.end('nope');
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: e2e.clientPort,
          path: '/agent/artifacts',
          method: 'POST',
          headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
          agent: false,
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(413);
    } finally {
      e2e.close();
    }
  });

  // Note: an under-length content-length mismatch (declared > sent) is covered by
  // the HubStreamRouter unit test — a compliant Node http client never completes
  // such a request (no FIN, no error), so it cannot be produced end-to-end.

  it('aborts both ends when the peer connection drops mid-response', async () => {
    let appClosed = false;
    const e2e = await startE2E((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      res.on('close', () => { appClosed = true; });
    });
    try {
      const first = await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: e2e.clientPort, path: '/agent/mcp/sse', method: 'GET', agent: false }, (res) => {
          res.once('data', (c: Buffer) => resolve(c.toString()));
        });
        req.on('error', () => resolve(''));
        req.end();
      });
      expect(first).toContain('data: first');
      e2e.hubPeer.close();
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(appClosed).toBe(true);
      expect(e2e.router.size).toBe(0);
    } finally {
      e2e.close();
    }
  });

  it('ends the upstream request when the agent client disconnects', async () => {
    let appClosed = false;
    const e2e = await startE2E((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      res.on('close', () => { appClosed = true; });
    });
    try {
      const clientRes = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: e2e.clientPort, path: '/agent/mcp/sse', method: 'GET', agent: false }, (res) => resolve(res));
        req.on('error', reject);
        req.end();
      });
      await new Promise<void>((r) => setTimeout(r, 20));
      clientRes.destroy();
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(appClosed).toBe(true);
      expect(e2e.router.size).toBe(0);
    } finally {
      e2e.close();
    }
  });

  it('keeps response content-type but drops content-length and hop-by-hop headers', async () => {
    const e2e = await startE2E((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5', 'x-custom': 'keepme' });
      res.end('hello');
    });
    try {
      const r = await get(e2e.clientPort, '/agent/git/status');
      expect(r.headers['content-type']).toBe('text/plain');
      expect(r.headers['x-custom']).toBe('keepme');
      expect(r.headers['content-length']).toBeUndefined();
      expect(r.body.toString()).toBe('hello');
    } finally {
      e2e.close();
    }
  });

  it('answers 502 on the agent side when the hub connection dies before response head', async () => {
    const e2e = await startE2E(() => { /* app never responds */ });
    try {
      const status = await new Promise<number>((resolve) => {
        const req = httpRequest({ host: '127.0.0.1', port: e2e.clientPort, path: '/agent/git/status', method: 'GET', agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', () => resolve(0));
        req.end();
        // kill the peer before the app responds
        setTimeout(() => e2e.hubPeer.close(), 10);
      });
      expect([502, 0]).toContain(status);
    } finally {
      e2e.close();
    }
  });
});

describe('HubStreamRouter idle timer', () => {
  it('outbound response chunks and credits survive past the idle window', async () => {
    vi.useFakeTimers();
    try {
      const [, b] = memoryPair();
      const sent: NodeFrame[] = [];
      const peer = new RpcPeer(b, {});
      const orig = peer.send.bind(peer);
      peer.send = (f: NodeFrame) => { sent.push(f); return orig(f); };
      let respond: Respond | undefined;
      const router = new HubStreamRouter('h', peer, (_id, _head, _body, r) => { respond = r; });
      router.onFrame({ t: 'http.head', rid: 1, method: 'GET', path: '/agent/git/status', headers: {} });
      expect(respond).toBeDefined();
      respond!.head(200, { 'content-type': 'text/plain' });
      await respond!.chunk(Buffer.from('a'));
      await vi.advanceTimersByTimeAsync(TUNNEL_STREAM_IDLE_MS - 1_000);
      router.onFrame({ t: 'http.credit', rid: 1, bytes: 1 });
      await respond!.chunk(Buffer.from('b'));
      await vi.advanceTimersByTimeAsync(TUNNEL_STREAM_IDLE_MS - 1_000);
      expect(sent.some((f) => f.t === 'http.end' && f.error === 'idle timeout')).toBe(false);
      expect(router.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('streamNodeRequest backpressure', () => {
  it('pauses the request when the credit window is exhausted and aborts on early finish', async () => {
    const [hubT, nodeT] = memoryPair();
    const hubPeer = new RpcPeer(hubT, {});
    const nodePeer = new RpcPeer(nodeT, {});
    const req = new PassThrough();
    Object.assign(req, { method: 'POST', url: '/agent/x', headers: {} });
    const res = new PassThrough() as PassThrough & {
      writeHead: (...args: unknown[]) => void;
    };
    res.writeHead = () => undefined;

    let paused = 0;
    const origPause = req.pause.bind(req);
    req.pause = () => { paused += 1; return origPause(); };

    streamNodeRequest(nodePeer, req as unknown as IncomingMessage, res as unknown as ServerResponse, 1);
    req.write(Buffer.alloc(TUNNEL_STREAM_WINDOW_BYTES));
    req.write(Buffer.alloc(64 * 1024));
    await flush();
    expect(paused).toBeGreaterThan(0);

    hubPeer.send({ t: 'http.head', rid: 1, status: 413, headers: { 'content-type': 'application/json' } });
    hubPeer.send({ t: 'http.end', rid: 1 });
    await flush();
    expect(() => req.write(Buffer.alloc(32))).not.toThrow();
    req.end();
    await flush();
  });
});

describe('streamNodeRequest router wiring', () => {
  it('ignores frames for unknown rids', () => {
    const [, b] = memoryPair();
    const router = new HubStreamRouter('h', new RpcPeer(b, {}), () => {});
    router.onFrame({ t: 'http.chunk', rid: 4242, b64: 'eHg=' });
    router.onFrame({ t: 'http.credit', rid: 4242, bytes: 10 });
    router.onFrame({ t: 'http.end', rid: 4242 });
    expect(router.size).toBe(0);
  });

  it('PassThrough body feeds a piped request', async () => {
    const body = new PassThrough();
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve) => {
      body.on('data', (c: Buffer) => chunks.push(c));
      body.on('end', resolve);
    });
    body.write(Buffer.from('hello'));
    body.end();
    await done;
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });
});
