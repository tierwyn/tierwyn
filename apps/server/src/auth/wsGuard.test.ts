import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { attachAuthenticatedWss, hostAllowedWhenAuthDisabled } from './wsGuard.js';
import { issueSessionCookie } from './cookie.js';
import type { AuthConfig } from './config.js';

const SECRET = 'ws-guard-test-secret-value';

function makeConfig(over: Partial<AuthConfig> = {}): AuthConfig {
  return { disabled: false, configured: true, sessionSecret: SECRET, passwordHash: 'x', cookieSecure: false, ...over };
}

let server: Server | undefined;

afterEach(() => { server?.close(); server = undefined; });

function startGuarded(config: AuthConfig): Promise<number> {
  server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;
  wss.on('connection', (ws: WebSocket) => { connections++; ws.send('welcome'); });
  attachAuthenticatedWss(server, wss, config);
  (server as Server & { connectionCount: () => number }).connectionCount = () => connections;
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
  });
}

/** Resolves 'open' if the socket connects, 'rejected' if the upgrade is refused. */
function tryConnect(port: number, cookie?: string, path = '/'): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, cookie ? { headers: { cookie } } : undefined);
    ws.on('open', () => { resolve('open'); ws.close(); });
    ws.on('unexpected-response', () => resolve('rejected'));
    ws.on('error', () => resolve('rejected'));
  });
}

describe('WebSocket upgrade guard', () => {
  it('rejects an upgrade without a valid cookie before a connection is made', async () => {
    const port = await startGuarded(makeConfig());
    const result = await tryConnect(port);
    expect(result).toBe('rejected');
    expect((server as Server & { connectionCount: () => number }).connectionCount()).toBe(0);
  });

  it('rejects an upgrade with an invalid cookie', async () => {
    const port = await startGuarded(makeConfig());
    expect(await tryConnect(port, 'tierwyn_session=garbage')).toBe('rejected');
  });

  it('accepts an upgrade carrying a valid session cookie', async () => {
    const port = await startGuarded(makeConfig());
    const cookie = issueSessionCookie({ secret: SECRET, secure: false }).split(';')[0];
    const result = await tryConnect(port, cookie);
    expect(result).toBe('open');
    expect((server as Server & { connectionCount: () => number }).connectionCount()).toBe(1);
  });

  it('accepts any upgrade when AUTH_DISABLED is set', async () => {
    const port = await startGuarded(makeConfig({ disabled: true }));
    const result = await tryConnect(port);
    expect(result).toBe('open');
  });

  it('rejects a cross-origin browser upgrade even with a valid cookie or AUTH_DISABLED; allows same-origin', async () => {
    const port = await startGuarded(makeConfig({ disabled: true }));
    const connect = (origin: string) => new Promise<'open' | 'rejected'>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin });
      ws.on('open', () => { resolve('open'); ws.close(); });
      ws.on('unexpected-response', () => resolve('rejected'));
      ws.on('error', () => resolve('rejected'));
    });
    expect(await connect('https://evil.example')).toBe('rejected');
    expect(await connect('null')).toBe('rejected');
    expect(await connect(`http://127.0.0.1:${port}`)).toBe('open');
  });

  it('rejects every upgrade when not configured (never verifies an empty-secret cookie)', async () => {
    const port = await startGuarded(makeConfig({ configured: false, sessionSecret: '' }));
    // A cookie an attacker could forge against an empty secret must NOT be accepted.
    const forged = issueSessionCookie({ secret: '', secure: false }).split(';')[0];
    expect(await tryConnect(port, forged)).toBe('rejected');
  });

  it('wsGuard: /ws/node routed to onNodeUpgrade without cookie; /ws still requires cookie', async () => {
    const hits: string[] = [];
    server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    let connections = 0;
    wss.on('connection', (ws: WebSocket) => { connections++; ws.send('welcome'); });
    attachAuthenticatedWss(server, wss, makeConfig(), {
      onNodeUpgrade: (req, socket) => {
        hits.push(req.url ?? '');
        socket.write('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
        socket.destroy();
      },
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
    });
    expect(await tryConnect(port, undefined, '/ws/node')).toBe('rejected');
    expect(hits.some((u) => u.split('?')[0] === '/ws/node')).toBe(true);
    expect(connections).toBe(0);
    expect(await tryConnect(port, undefined, '/ws')).toBe('rejected');
    expect(hits.some((u) => u.split('?')[0] === '/ws')).toBe(false);
    const cookie = issueSessionCookie({ secret: SECRET, secure: false }).split(';')[0];
    expect(await tryConnect(port, cookie, '/ws')).toBe('open');
    expect(connections).toBe(1);
  });
});

describe('hostAllowedWhenAuthDisabled (DNS rebinding)', () => {
  it('accepts unrebindable hosts and the allow-list, rejects other names', () => {
    for (const h of ['localhost:5173', '127.0.0.1:8787', '[::1]:8787', '192.168.1.5', 'app.localhost']) {
      expect(hostAllowedWhenAuthDisabled(h, undefined)).toBe(true);
    }
    expect(hostAllowedWhenAuthDisabled('evil.example:8787', undefined)).toBe(false);
    expect(hostAllowedWhenAuthDisabled('box.lan:5173', 'box.lan, other')).toBe(true);
    expect(hostAllowedWhenAuthDisabled('evil.example', 'box.lan')).toBe(false);
    expect(hostAllowedWhenAuthDisabled('evil.example', 'all')).toBe(true);
  });
});
