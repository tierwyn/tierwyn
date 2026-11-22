import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { issueSessionCookie } from '../auth/cookie.js';
import { issueSpawnToken } from '../spawn/tokens.js';
import { apiErrorHandler } from './errorHandler.js';
import {
  isPreAuthJsonPath,
  isPublicJsonPath,
  jsonAuthed,
  preAuthJson,
  WS_OPERATOR_MAX_PAYLOAD,
} from './limits.js';
import type { AuthConfig } from '../auth/config.js';

const SECRET = 'limits-test-session-secret-value-ok';
const config: AuthConfig = {
  disabled: false,
  configured: true,
  sessionSecret: SECRET,
  passwordHash: 'x',
  cookieSecure: false,
};

function buildApp(extra?: { nodeHostId?: string }) {
  const app = express();
  if (extra?.nodeHostId) {
    app.use((_req, res, next) => {
      res.locals.nodeHostId = extra.nodeHostId;
      next();
    });
  }
  app.use(preAuthJson(config));
  app.use((_req, res, next) => {
    // stand-in for requireAuth: cookie routes reach jsonAuthed
    next();
  });
  app.use(jsonAuthed);
  app.post('/auth/login', (req, res) => res.json({ n: JSON.stringify(req.body).length }));
  app.post('/node/enroll', (req, res) => res.json({ n: JSON.stringify(req.body).length }));
  app.post('/spawn/x/message', (req, res) => res.json({ n: JSON.stringify(req.body).length }));
  app.post('/agent/plugins/gemini-image/capabilities/image.generate', (req, res) =>
    res.json({ n: JSON.stringify(req.body).length }));
  app.put('/files', (req, res) => res.json({ n: JSON.stringify(req.body).length }));
  app.put('/conversations/c1/draft', (req, res) => res.json({ n: JSON.stringify(req.body).length }));
  app.use(apiErrorHandler);
  return app;
}

async function post(
  app: express.Express,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: path.startsWith('/files') || path.includes('/draft') ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, json };
  } finally {
    server.close();
  }
}

function fatJson(bytes: number): string {
  return `{"x":"${'a'.repeat(bytes)}"}`;
}

describe('json path matchers', () => {
  it('public: /auth/* and /node/enroll only', () => {
    expect(isPublicJsonPath('/auth/login')).toBe(true);
    expect(isPublicJsonPath('/auth/logout')).toBe(true);
    expect(isPublicJsonPath('/node/enroll')).toBe(true);
    expect(isPublicJsonPath('/spawn')).toBe(false);
    expect(isPublicJsonPath('/files')).toBe(false);
  });

  it('pre-auth dual-auth paths, not cookie-only files/drafts', () => {
    expect(isPreAuthJsonPath('/spawn/raw')).toBe(true);
    expect(isPreAuthJsonPath('/spawn/abc/message')).toBe(true);
    expect(isPreAuthJsonPath('/agent/plugins/x/capabilities/y')).toBe(true);
    expect(isPreAuthJsonPath('/agent/mcp/sid')).toBe(true);
    expect(isPreAuthJsonPath('/agent/memory')).toBe(true);
    expect(isPreAuthJsonPath('/projects/p1/schedules/agent')).toBe(true);
    expect(isPreAuthJsonPath('/schedules/j1/steps')).toBe(true);
    expect(isPreAuthJsonPath('/conversations/c1/timers/agent')).toBe(true);
    expect(isPreAuthJsonPath('/conversations/c1/tasks/agent')).toBe(true);
    expect(isPreAuthJsonPath('/tasks/agent')).toBe(true);
    expect(isPreAuthJsonPath('/files')).toBe(false);
    expect(isPreAuthJsonPath('/conversations/c1/draft')).toBe(false);
    expect(isPreAuthJsonPath('/settings/compaction')).toBe(false);
    expect(isPreAuthJsonPath('/auth/login')).toBe(false);
  });
});

describe('preAuthJson + jsonAuthed stack', () => {
  it('unauthenticated /auth/login over 64kb → 413', async () => {
    const res = await post(buildApp(), '/auth/login', fatJson(70_000));
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: 'payload too large' });
  });

  it('unauthenticated /auth/login under 64kb parses', async () => {
    const res = await post(buildApp(), '/auth/login', '{"password":"x"}');
    expect(res.status).toBe(200);
  });

  it('unauthenticated /spawn over 64kb → 413', async () => {
    const res = await post(buildApp(), '/spawn/x/message', fatJson(70_000));
    expect(res.status).toBe(413);
  });

  it('forged Bearer on /spawn does not raise the 64kb cap', async () => {
    const res = await post(buildApp(), '/spawn/x/message', fatJson(70_000), {
      authorization: 'Bearer 00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(413);
  });

  it('spawn token on /spawn allows a body over 64kb', async () => {
    const token = issueSpawnToken('c1', 's1');
    const res = await post(buildApp(), '/spawn/x/message', fatJson(100_000), {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
  });

  it('session cookie on /agent/plugins allows a body over 64kb', async () => {
    const cookie = issueSessionCookie({ secret: SECRET, secure: false }).split(';')[0]!;
    const res = await post(
      buildApp(),
      '/agent/plugins/gemini-image/capabilities/image.generate',
      fatJson(100_000),
      { cookie },
    );
    expect(res.status).toBe(200);
  });

  it('node host id on /agent/mcp allows a body over 64kb', async () => {
    const res = await post(
      buildApp({ nodeHostId: 'host-1' }),
      '/agent/plugins/gemini-image/capabilities/image.generate',
      fatJson(100_000),
    );
    expect(res.status).toBe(200);
  });

  it('cookie-only PUT /files over 64kb is not 413 (parsed after requireAuth)', async () => {
    const res = await post(buildApp(), '/files', fatJson(100_000));
    expect(res.status).toBe(200);
  });

  it('cookie-only PUT /conversations/:id/draft over 64kb is not 413', async () => {
    const res = await post(buildApp(), '/conversations/c1/draft', fatJson(100_000));
    expect(res.status).toBe(200);
  });
});

describe('wired into index.ts / vite.config.ts', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');
  const viteSrc = readFileSync(join(here, '../../../../apps/web/vite.config.ts'), 'utf8');

  it('originGuard runs before preAuthJson; jsonAuthed after requireAuth', () => {
    const origin = indexSrc.indexOf('app.use(originGuard');
    const pre = indexSrc.indexOf('app.use(preAuthJson(authConfig))');
    const auth = indexSrc.indexOf('app.use(requireAuth(authConfig))');
    const authed = indexSrc.indexOf('app.use(jsonAuthed)');
    expect(origin).toBeGreaterThan(-1);
    expect(pre).toBeGreaterThan(origin);
    expect(auth).toBeGreaterThan(pre);
    expect(authed).toBeGreaterThan(auth);
    expect(indexSrc).not.toMatch(/express\.json\(\{\s*limit:\s*'25mb'\s*\}\)/);
  });

  it('operator WebSocketServer sets maxPayload to WS_OPERATOR_MAX_PAYLOAD', () => {
    expect(WS_OPERATOR_MAX_PAYLOAD).toBe(32 * 1024 * 1024);
    expect(indexSrc).toMatch(/maxPayload:\s*WS_OPERATOR_MAX_PAYLOAD/);
  });

  it('vite preview + server send frame-ancestors none and X-Frame-Options DENY', () => {
    expect(viteSrc).toContain("'X-Frame-Options': 'DENY'");
    expect(viteSrc).toContain("frame-ancestors 'none'");
    const def = viteSrc.indexOf('const FRAME_HEADERS');
    const serverHeaders = viteSrc.indexOf('server:');
    const previewHeaders = viteSrc.indexOf('preview:');
    expect(def).toBeGreaterThan(-1);
    expect(def).toBeLessThan(serverHeaders);
    expect(previewHeaders).toBeGreaterThan(serverHeaders);
    expect(viteSrc.slice(serverHeaders, previewHeaders)).toContain('...FRAME_HEADERS');
    expect(viteSrc.slice(previewHeaders)).toContain('...FRAME_HEADERS');
  });
});
