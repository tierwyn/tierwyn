import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { registerAuthRoutes } from './routes.js';
import { LoginRateLimiter } from './rateLimit.js';
import type { AuthConfig } from './config.js';
import { verifyPassword } from './password.js';

vi.mock('./password.js', () => ({
  verifyPassword: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return false;
  }),
}));

function buildApp() {
  const config: AuthConfig = {
    disabled: false,
    configured: true,
    sessionSecret: 'unit-test-session-secret-value',
    passwordHash: 'unused',
    cookieSecure: false,
  };
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app, {
    config,
    rateLimiter: new LoginRateLimiter({ maxAttempts: 5, windowMs: 60_000, lockoutMs: 60_000 }),
  });
  return app;
}

describe('login throttle under parallel bursts', () => {
  it('caps concurrent verifyPassword calls (global in-flight + per-key pending)', async () => {
    const app = buildApp();
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () =>
        fetch(`http://127.0.0.1:${port}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'nope' }),
        }).then(async (r) => ({ status: r.status })),
      ));
      expect(vi.mocked(verifyPassword).mock.calls.length).toBeLessThanOrEqual(5);
      expect(vi.mocked(verifyPassword).mock.calls.length).toBeLessThanOrEqual(LoginRateLimiter.MAX_GLOBAL_IN_FLIGHT);
      expect(results.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
