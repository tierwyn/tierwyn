import type { IncomingMessage, Server } from 'http';
import { isIP, type Socket } from 'net';
import type { Duplex } from 'stream';
import type { WebSocketServer } from 'ws';
import type { AuthConfig } from './config.js';
import { verifySessionCookieHeader } from './cookie.js';
import { envPref } from '../config/env.js';

/**
 * Wires cookie verification into the HTTP `upgrade` handshake. Unauthenticated
 * upgrades are rejected (401 + socket destroyed) BEFORE any WebSocket object or
 * subscription is created. Requires the WebSocketServer to be constructed with
 * `{ noServer: true }`. When AUTH_DISABLED is set the guard is a no-op.
 *
 * `/ws/node` is the remote-host dial-in: when `onNodeUpgrade` is provided it is
 * dispatched before the cookie check. Absent that hook, `/ws/node` falls through
 * to the cookie check as before.
 */
export function attachAuthenticatedWss(
  httpServer: Server,
  wss: WebSocketServer,
  config: AuthConfig,
  opts?: { onNodeUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void },
): void {
  httpServer.on('upgrade', (req, socket: Socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url ?? '/', 'http://x').pathname; } catch { /* ignore */ }
    if (pathname === '/ws/node' && opts?.onNodeUpgrade) {
      opts.onNodeUpgrade(req, socket, head);
      return;
    }

    // Browsers always send Origin; a cross-origin page (sibling subdomain whose
    // lax cookie still rides, or any site when AUTH_DISABLED) must not drive
    // the socket. Non-browser clients send no Origin and fall through to auth.
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (config.disabled && !hostAllowedWhenAuthDisabled(req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const authed = config.disabled
      || (config.configured && verifySessionCookieHeader(req.headers.cookie, config.sessionSecret, undefined, { secure: config.cookieSecure }));

    if (!authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
}

/** True when Origin is absent (non-browser) or matches the request Host. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

/**
 * DNS-rebinding guard for AUTH_DISABLED: an attacker domain re-pointed at
 * 127.0.0.1 is same-origin with itself, so Origin checks pass and there is no
 * cookie to miss. Only accept Hosts that can't be rebound: localhost, IP
 * literals, or TIERWYN_ALLOWED_HOSTS (`true`/`all` turns the check off).
 */
export function hostAllowedWhenAuthDisabled(
  host: string | undefined,
  allowedEnv: string | undefined = envPref('ALLOWED_HOSTS'),
): boolean {
  if (!host) return true; // HTTP/1.0 / non-browser clients; browsers always send Host
  let hostname: string;
  try { hostname = new URL(`http://${host}`).hostname.toLowerCase(); } catch { return false; }
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare.endsWith('.localhost') || isIP(bare)) return true;
  const raw = allowedEnv?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'true' || raw === 'all') return true;
  return raw.split(',').map((h) => h.trim()).includes(bare);
}
