import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { csrfGuard } from './middleware.js';
import { issueSessionCookie } from './cookie.js';
import type { AuthConfig } from './config.js';

const SECRET = 'csrf-test-session-secret-value-ok';
const config: AuthConfig = {
  disabled: false,
  configured: true,
  sessionSecret: SECRET,
  passwordHash: 'x',
  cookieSecure: false,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(csrfGuard(config));
  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    app[method]('/echo', (_req, res) => res.json({ ok: true }));
  }
  return app;
}

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function call(
  method: string,
  opts: { origin?: string; referer?: string; cookie?: string; authorization?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const app = buildApp();
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.origin !== undefined) headers.origin = opts.origin;
    if (opts.referer !== undefined) headers.referer = opts.referer;
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.authorization) headers.authorization = opts.authorization;
    const r = await fetch(`http://127.0.0.1:${port}/echo`, {
      method,
      headers,
      body: method === 'GET' ? undefined : '{}',
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, json };
  } finally {
    srv.close();
  }
}

function sessionCookie(): string {
  return issueSessionCookie({ secret: SECRET, secure: false }).split(';')[0]!;
}

describe('csrfGuard mutating Origin/Referer', () => {
  it('rejects cross-origin POST/PUT/PATCH/DELETE with a mismatched Origin', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await call(method, { origin: 'https://evil.example' });
      expect({ method, status: res.status }).toEqual({ method, status: 403 });
    }
  });

  it('allows a same-origin mutating request', async () => {
    const app = buildApp();
    server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: '{}',
    });
    expect(r.status).toBe(200);
  });

  it('rejects a mismatched Referer when Origin is absent and a session cookie is present', async () => {
    const res = await call('POST', {
      cookie: sessionCookie(),
      referer: 'https://evil.example/csrf',
    });
    expect(res.status).toBe(403);
  });

  it('allows a Bearer-authenticated mutating request with no Origin', async () => {
    const res = await call('POST', { authorization: 'Bearer agent-token' });
    expect(res.status).toBe(200);
  });

  it('allows a cookie-authenticated mutating request with no Origin or Referer', async () => {
    const res = await call('POST', { cookie: sessionCookie() });
    expect(res.status).toBe(200);
  });

  it('allows GET with a mismatched Origin', async () => {
    const res = await call('GET', { origin: 'https://evil.example' });
    expect(res.status).toBe(200);
  });
});
