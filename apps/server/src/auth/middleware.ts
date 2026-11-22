import type { RequestHandler } from 'express';
import type { AuthConfig } from './config.js';
import { verifySessionCookieHeader } from './cookie.js';
import { sameOrigin } from './wsGuard.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origin/Referer CSRF check for mutating HTTP. Reuses wsGuard's Host match
 * (req.headers.host — same as WebSocket upgrades; reverse proxies must forward
 * Host, which Vite and the documented nginx Host $host setup both do).
 *
 * Origin present + mismatch → 403 (browsers always send Origin on POST).
 * Origin absent + valid session cookie + Referer mismatch → 403.
 * Origin/Referer absent (Bearer, curl, node) → pass.
 */
export function csrfGuard(config: AuthConfig): RequestHandler {
  return (req, res, next) => {
    if (!MUTATING.has(req.method)) { next(); return; }
    const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
    if (req.headers.origin !== undefined) {
      if (!sameOrigin(req.headers.origin, host)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      next();
      return;
    }
    const cookieAuthed = config.configured
      && verifySessionCookieHeader(req.headers.cookie, config.sessionSecret, undefined, { secure: config.cookieSecure });
    const referer = req.headers.referer;
    if (cookieAuthed && referer !== undefined && !sameOrigin(referer, host)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

/**
 * Guards protected REST routes. Returns 401 JSON unless a valid session cookie
 * is present. OPTIONS preflights pass through (CORS). When AUTH_DISABLED is set,
 * the guard is a no-op (local dev only).
 */
export function requireAuth(config: AuthConfig): RequestHandler {
  return (req, res, next) => {
    if (config.disabled) { next(); return; }
    if (req.method === 'OPTIONS') { next(); return; }
    // Not configured → fail closed without verifying (the secret would be empty).
    if (!config.configured) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (verifySessionCookieHeader(req.headers.cookie, config.sessionSecret, undefined, { secure: config.cookieSecure })) { next(); return; }
    res.status(401).json({ error: 'unauthorized' });
  };
}
