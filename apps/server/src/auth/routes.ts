import type { Express } from 'express';
import type { LoginRequest, LoginResponse, SessionResponse } from '@tierwyn/shared';
import type { AuthConfig } from './config.js';
import { verifyPassword } from './password.js';
import { issueSessionCookie, clearSessionCookies, verifySessionCookieHeader } from './cookie.js';
import type { LoginRateLimiter } from './rateLimit.js';
import { sameOrigin } from './wsGuard.js';

export interface AuthRoutesDeps {
  config: AuthConfig;
  rateLimiter: LoginRateLimiter;
  /** Server-side session floor bump (authenticated same-origin logout only). */
  onLogout?: () => void;
}

/** Mounts POST /auth/login, POST /auth/logout, GET /auth/session. */
export function registerAuthRoutes(app: Express, deps: AuthRoutesDeps): void {
  const { config, rateLimiter } = deps;

  app.post('/auth/login', async (req, res) => {
    if (!config.disabled && !config.configured) {
      // Fail closed: no secrets set, so no login can succeed. Tell the operator.
      res.status(503).json({
        error: 'Authentication is not configured. Set OPERATOR_PASSWORD_HASH and '
          + 'SESSION_SECRET in .env, then restart the server. See .env.example.',
        configured: false,
      });
      return;
    }

    const key = req.ip ?? 'unknown';

    const slot = rateLimiter.tryAcquire(key);
    if (!slot.allowed || !slot.release) {
      res.setHeader('Retry-After', String(slot.retryAfterSec ?? 60));
      res.status(429).json({ error: 'too many attempts' });
      return;
    }

    const { password } = (req.body ?? {}) as Partial<LoginRequest>;
    let ok = false;
    try {
      ok = await verifyPassword(config.passwordHash, password ?? '');
    } finally {
      slot.release(ok);
    }
    if (!ok) {
      res.status(401).json({ error: 'invalid credentials' }); // generic
      return;
    }

    res.setHeader('Set-Cookie', issueSessionCookie({ secret: config.sessionSecret, secure: config.cookieSecure }));
    const body: LoginResponse = { ok: true };
    res.json(body);
  });

  app.post('/auth/logout', (req, res) => {
    const authed = config.disabled
      || (config.configured && verifySessionCookieHeader(req.headers.cookie, config.sessionSecret, undefined, { secure: config.cookieSecure }));
    // Always clear the browser cookie. Only bump the server floor for an
    // authenticated same-origin request — a cross-site POST must not log the
    // operator out everywhere.
    if (authed && !config.disabled && sameOrigin(req.headers.origin, req.headers.host)) {
      deps.onLogout?.();
    }
    res.setHeader('Set-Cookie', clearSessionCookies({ secure: config.cookieSecure }));
    res.json({ ok: true });
  });

  app.get('/auth/session', (req, res) => {
    const authenticated = config.disabled
      || (config.configured && verifySessionCookieHeader(req.headers.cookie, config.sessionSecret, undefined, { secure: config.cookieSecure }));
    const body: SessionResponse = {
      authenticated,
      configured: config.disabled || config.configured,
    };
    res.json(body);
  });
}
