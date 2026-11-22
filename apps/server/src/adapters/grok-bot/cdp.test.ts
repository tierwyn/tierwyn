/**
 * Fake CDP endpoint: real ws.Server + stub HTTP /json/list.
 * Covers id correlation, out-of-order replies, event dispatch, socket-drop rejection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CdpClient, discoverPageTarget } from './cdp.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

type Script = (ws: WebSocket, msg: { id: number; method: string; params?: unknown }) => void;

async function startFake(opts: {
  list?: Array<Record<string, unknown>>;
  onMessage?: Script;
}): Promise<{ port: number; wss: WebSocketServer; close: () => Promise<void>; sockets: WebSocket[] }> {
  const sockets: WebSocket[] = [];
  const httpServer = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Browser: 'GrokBot/0.30.0' }));
      return;
    }
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json');
      const port = (httpServer.address() as { port: number }).port;
      const list = opts.list ?? [
        { type: 'webview', title: 'noVNC', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/webview` },
        { type: 'page', title: 'Grok Bot', id: 'page-1', url: 'file:///opt/Grok Bot/index.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` },
      ];
      res.end(JSON.stringify(list));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: unknown };
      if (opts.onMessage) opts.onMessage(ws, msg);
    });
  });
  const port = await listen(httpServer);
  return {
    port,
    wss,
    sockets,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.close();
      wss.close();
      httpServer.close(() => resolve());
    }),
  };
}

let fake: Awaited<ReturnType<typeof startFake>> | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe('discoverPageTarget', () => {
  it('picks the type:page target, not a webview', async () => {
    fake = await startFake({});
    const target = await discoverPageTarget(fake.port);
    expect(target.type).toBe('page');
    expect(target.webSocketDebuggerUrl).toContain('/devtools/page/');
  });

  it('rejects when no page target exists', async () => {
    fake = await startFake({
      list: [{ type: 'webview', title: 'x', webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' }],
    });
    await expect(discoverPageTarget(fake.port)).rejects.toThrow(/page target/i);
  });
});

describe('CdpClient', () => {
  it('correlates replies by id even when they arrive out of order', async () => {
    fake = await startFake({
      onMessage: (ws, msg) => {
        // Delay id=1, reply to id=2 immediately.
        if (msg.id === 2) {
          ws.send(JSON.stringify({ id: 2, result: { value: 'second' } }));
        } else if (msg.id === 1) {
          setTimeout(() => ws.send(JSON.stringify({ id: 1, result: { value: 'first' } })), 20);
        }
      },
    });
    const client = new CdpClient();
    await client.connect(`ws://127.0.0.1:${fake.port}/devtools/page/1`);
    const [a, b] = await Promise.all([
      client.send<{ value: string }>('Runtime.evaluate', { expression: '1' }),
      client.send<{ value: string }>('Runtime.evaluate', { expression: '2' }),
    ]);
    expect(a.value).toBe('first');
    expect(b.value).toBe('second');
    await client.close();
  });

  it('dispatches CDP events by method name', async () => {
    fake = await startFake({
      onMessage: (ws, msg) => {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        ws.send(JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: 'x', payload: '1' } }));
      },
    });
    const client = new CdpClient();
    await client.connect(`ws://127.0.0.1:${fake.port}/devtools/page/1`);
    const got = new Promise<unknown>((resolve) => {
      client.on('Runtime.bindingCalled', resolve);
    });
    await client.send('Runtime.enable');
    expect(await got).toEqual({ name: 'x', payload: '1' });
    await client.close();
  });

  it('rejects in-flight commands when the socket drops', async () => {
    fake = await startFake({
      onMessage: () => { /* never reply */ },
    });
    const client = new CdpClient();
    await client.connect(`ws://127.0.0.1:${fake.port}/devtools/page/1`);
    const pending = client.send('Runtime.evaluate', { expression: '1' });
    fake.sockets[0]?.close();
    await expect(pending).rejects.toThrow(/closed|drop|disconnect/i);
  });

  it('evaluate returns result.value and throws on exceptionDetails', async () => {
    fake = await startFake({
      onMessage: (ws, msg) => {
        const expr = (msg.params as { expression?: string } | undefined)?.expression;
        if (expr === 'throw') {
          ws.send(JSON.stringify({
            id: msg.id,
            result: { result: { type: 'undefined' }, exceptionDetails: { exception: { description: 'boom' } } },
          }));
        } else {
          ws.send(JSON.stringify({
            id: msg.id,
            result: { result: { type: 'string', value: 'ok' } },
          }));
        }
      },
    });
    const client = new CdpClient();
    await client.connect(`ws://127.0.0.1:${fake.port}/devtools/page/1`);
    await expect(client.evaluate('1+1')).resolves.toBe('ok');
    await expect(client.evaluate('throw')).rejects.toThrow(/boom/);
    await client.close();
  });

  it('refuses to connect to a non-loopback URL', async () => {
    const client = new CdpClient();
    await expect(client.connect('ws://8.8.8.8:9333/devtools/page/1')).rejects.toThrow(/127\.0\.0\.1/);
  });
});
