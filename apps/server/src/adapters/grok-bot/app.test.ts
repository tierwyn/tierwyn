import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CdpClient } from './cdp.js';
import { GrokBotApp, disposeApp } from './app.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

async function startFake(): Promise<{ port: number; sockets: WebSocket[]; close: () => Promise<void> }> {
  const sockets: WebSocket[] = [];
  const httpServer = createServer((req, res) => {
    const port = (httpServer.address() as { port: number }).port;
    if (req.url === '/json/version') {
      res.end(JSON.stringify({ Browser: 'GrokBot/0.30.0' }));
      return;
    }
    if (req.url === '/json/list') {
      res.end(JSON.stringify([{
        type: 'page', title: 'Grok Bot',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
      }]));
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
      const msg = JSON.parse(String(raw)) as { id: number };
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });
  const port = await listen(httpServer);
  return {
    port,
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
  await disposeApp();
  await fake?.close();
  fake = null;
});

describe('GrokBotApp', () => {
  it('never imports child_process', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
    expect(src).not.toMatch(/child_process/);
  });

  it('connects to a reachable CDP endpoint', async () => {
    fake = await startFake();
    const app = new GrokBotApp({ port: fake.port, createClient: () => new CdpClient() });
    const client = await app.getClient();
    await client.send('Runtime.enable');
    expect(app.health()).toBe('ok');
    await app.dispose();
  });

  it('reports unreachable when nothing is listening', async () => {
    const app = new GrokBotApp({ port: 1 });
    await expect(app.getClient()).rejects.toThrow();
    expect(app.health()).toBe('unreachable');
  });

  it('reconnects after a socket drop', async () => {
    fake = await startFake();
    const app = new GrokBotApp({ port: fake.port });
    await app.getClient();
    expect(app.health()).toBe('ok');
    fake.sockets[0]?.close();
    app.drop();
    const again = await app.getClient();
    await again.send('Runtime.enable');
    expect(app.health()).toBe('ok');
    await app.dispose();
  });
});
