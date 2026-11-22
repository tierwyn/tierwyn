import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import express from 'express';
import argon2 from 'argon2';
import { registerAuthRoutes } from './routes.js';
import { requireAuth } from './middleware.js';
import { LoginRateLimiter } from './rateLimit.js';
import { passwordFingerprint, SESSION_COOKIE_NAME, setSessionRevocation } from './cookie.js';
import type { AuthConfig } from './config.js';

const PASSWORD = 'operator-secret';
let HASH = '';

beforeAll(async () => { HASH = await argon2.hash(PASSWORD); });

function makeConfig(over: Partial<AuthConfig> = {}): AuthConfig {
  return {
    disabled: false,
    configured: true,
    sessionSecret: 'unit-test-session-secret-value',
    passwordHash: HASH,
    cookieSecure: false,
    ...over,
  };
}

function buildApp(
  config: AuthConfig,
  rateLimiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000, lockoutMs: 60_000 }),
  extra: { onLogout?: () => void } = {},
) {
  const app = express();
  app.use(express.json());
  app.options('*', (_req, res) => res.sendStatus(200));
  registerAuthRoutes(app, { config, rateLimiter, onLogout: extra.onLogout });
  app.use(requireAuth(config));
  app.get('/protected', (_req, res) => res.json({ secret: 42 }));
  return app;
}

async function call(
  app: express.Express,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; origin?: 'same' | 'foreign' } = {},
) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin === 'same') headers.origin = `http://127.0.0.1:${port}`;
    if (opts.origin === 'foreign') headers.origin = 'https://evil.example';
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const setCookie = r.headers.getSetCookie?.()[0] ?? r.headers.get('set-cookie') ?? undefined;
    // Reduce a Set-Cookie header to the "name=value" form a client would echo back.
    const cookie = setCookie ? setCookie.split(';')[0] : undefined;
    return { status: r.status, json, setCookie, cookie, retryAfter: r.headers.get('retry-after') };
  } finally {
    server.close();
  }
}

describe('auth routes + requireAuth middleware', () => {
  afterEach(() => setSessionRevocation(undefined));

  it('rejects login with the wrong password (401, no cookie)', async () => {
    const res = await call(buildApp(makeConfig()), 'POST', '/auth/login', { body: { password: 'nope' } });
    expect(res.status).toBe(401);
    expect(res.setCookie).toBeUndefined();
  });

  it('accepts login with the correct password and sets a cookie', async () => {
    const res = await call(buildApp(makeConfig()), 'POST', '/auth/login', { body: { password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    expect(res.setCookie).toMatch(/HttpOnly/i);
    expect(res.setCookie).toMatch(/SameSite=Lax/i);
  });

  it('protects routes: 401 without a cookie, 200 with a valid one', async () => {
    const app = buildApp(makeConfig());
    const noCookie = await call(app, 'GET', '/protected');
    expect(noCookie.status).toBe(401);

    const login = await call(app, 'POST', '/auth/login', { body: { password: PASSWORD } });
    const withCookie = await call(app, 'GET', '/protected', { cookie: login.cookie });
    expect(withCookie.status).toBe(200);
    expect(withCookie.json.secret).toBe(42);
  });

  it('lets OPTIONS preflight through without auth', async () => {
    const res = await call(buildApp(makeConfig()), 'OPTIONS', '/protected');
    expect(res.status).toBe(200);
  });

  it('GET /auth/session reflects authentication state', async () => {
    const app = buildApp(makeConfig());
    const anon = await call(app, 'GET', '/auth/session');
    expect(anon.json.authenticated).toBe(false);
    expect(anon.json.configured).toBe(true);

    const login = await call(app, 'POST', '/auth/login', { body: { password: PASSWORD } });
    const authed = await call(app, 'GET', '/auth/session', { cookie: login.cookie });
    expect(authed.json.authenticated).toBe(true);
  });

  it('logout clears the cookie and ends access', async () => {
    const app = buildApp(makeConfig());
    const logout = await call(app, 'POST', '/auth/logout');
    expect(logout.status).toBe(200);
    expect(logout.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;?`));
    expect(logout.setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('rate-limits repeated failed logins with 429 + Retry-After', async () => {
    const app = buildApp(makeConfig());
    for (let i = 0; i < 5; i++) {
      const r = await call(app, 'POST', '/auth/login', { body: { password: 'wrong' } });
      expect(r.status).toBe(401);
    }
    const locked = await call(app, 'POST', '/auth/login', { body: { password: PASSWORD } });
    expect(locked.status).toBe(429);
    expect(Number(locked.retryAfter)).toBeGreaterThan(0);
  });

  it('AUTH_DISABLED bypasses the guard and reports authenticated', async () => {
    const app = buildApp(makeConfig({ disabled: true }));
    const prot = await call(app, 'GET', '/protected');
    expect(prot.status).toBe(200);
    const session = await call(app, 'GET', '/auth/session');
    expect(session.json.authenticated).toBe(true);
  });

  it('AUTH_DISABLED bypasses auth even when secrets are not configured', async () => {
    const app = buildApp(makeConfig({ disabled: true, configured: false }));
    expect((await call(app, 'GET', '/protected')).status).toBe(200);
    const session = await call(app, 'GET', '/auth/session');
    expect(session.json.authenticated).toBe(true);
  });

  describe('not configured (missing secrets) — fail closed', () => {
    it('GET /auth/session reports authenticated=false, configured=false', async () => {
      const app = buildApp(makeConfig({ configured: false, sessionSecret: '', passwordHash: '' }));
      const session = await call(app, 'GET', '/auth/session');
      expect(session.json).toEqual({ authenticated: false, configured: false });
    });

    it('POST /auth/login is refused with a clear "not configured" error', async () => {
      const app = buildApp(makeConfig({ configured: false, sessionSecret: '', passwordHash: '' }));
      const res = await call(app, 'POST', '/auth/login', { body: { password: 'anything' } });
      expect(res.status).toBe(503);
      expect(res.json.configured).toBe(false);
      expect(res.setCookie).toBeUndefined();
    });

    it('protected routes stay locked (401) when not configured', async () => {
      const app = buildApp(makeConfig({ configured: false, sessionSecret: '', passwordHash: '' }));
      expect((await call(app, 'GET', '/protected')).status).toBe(401);
    });
  });

  describe('logout session floor', () => {
    afterEach(() => setSessionRevocation(undefined));

    it('logout with a valid cookie bumps the floor so the cookie no longer works', async () => {
      const cfg = makeConfig();
      let floor = 0;
      setSessionRevocation({
        floorMs: () => floor,
        passwordFp: passwordFingerprint(cfg.sessionSecret, HASH),
      });
      const app = buildApp(cfg, undefined, { onLogout: () => { floor = Date.now(); } });
      const login = await call(app, 'POST', '/auth/login', { body: { password: PASSWORD } });
      expect((await call(app, 'GET', '/protected', { cookie: login.cookie })).status).toBe(200);
      const logout = await call(app, 'POST', '/auth/logout', { cookie: login.cookie, origin: 'same' });
      expect(logout.status).toBe(200);
      expect((await call(app, 'GET', '/protected', { cookie: login.cookie })).status).toBe(401);
    });

    it('logout without a cookie does not bump the floor', async () => {
      const cfg = makeConfig();
      let bumped = false;
      setSessionRevocation({
        floorMs: () => 0,
        passwordFp: passwordFingerprint(cfg.sessionSecret, HASH),
      });
      const app = buildApp(cfg, undefined, { onLogout: () => { bumped = true; } });
      const login = await call(app, 'POST', '/auth/login', { body: { password: PASSWORD } });
      await call(app, 'POST', '/auth/logout');
      expect(bumped).toBe(false);
      expect((await call(app, 'GET', '/protected', { cookie: login.cookie })).status).toBe(200);
    });

    it('logout with a foreign Origin does not bump the floor', async () => {
      const cfg = makeConfig();
      let bumped = false;
      setSessionRevocation({
        floorMs: () => 0,
        passwordFp: passwordFingerprint(cfg.sessionSecret, HASH),
      });
      const app = buildApp(cfg, undefined, { onLogout: () => { bumped = true; } });
      const login = await call(app, 'POST', '/auth/login', { body: { password: PASSWORD } });
      const logout = await call(app, 'POST', '/auth/logout', { cookie: login.cookie, origin: 'foreign' });
      expect(logout.status).toBe(200);
      expect(bumped).toBe(false);
      expect((await call(app, 'GET', '/protected', { cookie: login.cookie })).status).toBe(200);
    });
  });
});
