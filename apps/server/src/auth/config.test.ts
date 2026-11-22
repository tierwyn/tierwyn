import { describe, it, expect } from 'vitest';
import { loadAuthConfig, assertAuthBindSafe } from './config.js';

const FULL = {
  SESSION_SECRET: 'a-very-long-random-secret-value-32b',
  OPERATOR_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$abc$def',
};

describe('loadAuthConfig', () => {
  it('loads a complete config with secure cookies by default', () => {
    const cfg = loadAuthConfig(FULL);
    expect(cfg.disabled).toBe(false);
    expect(cfg.configured).toBe(true);
    expect(cfg.sessionSecret).toBe(FULL.SESSION_SECRET);
    expect(cfg.passwordHash).toBe(FULL.OPERATOR_PASSWORD_HASH);
    expect(cfg.cookieSecure).toBe(true);
  });

  it('boots un-configured (no throw) when SESSION_SECRET is missing', () => {
    const cfg = loadAuthConfig({ OPERATOR_PASSWORD_HASH: FULL.OPERATOR_PASSWORD_HASH });
    expect(cfg.configured).toBe(false);
    expect(cfg.disabled).toBe(false);
  });

  it('boots un-configured (no throw) when OPERATOR_PASSWORD_HASH is missing', () => {
    const cfg = loadAuthConfig({ SESSION_SECRET: FULL.SESSION_SECRET });
    expect(cfg.configured).toBe(false);
  });

  it('treats empty-string secrets as not configured', () => {
    expect(loadAuthConfig({ SESSION_SECRET: '', OPERATOR_PASSWORD_HASH: '' }).configured).toBe(false);
  });

  it('rejects SESSION_SECRET shorter than 32 bytes and accepts >= 32 bytes', () => {
    expect(
      loadAuthConfig({
        SESSION_SECRET: 'a'.repeat(31),
        OPERATOR_PASSWORD_HASH: FULL.OPERATOR_PASSWORD_HASH,
      }).configured,
    ).toBe(false);
    expect(
      loadAuthConfig({
        SESSION_SECRET: 'a'.repeat(32),
        OPERATOR_PASSWORD_HASH: FULL.OPERATOR_PASSWORD_HASH,
      }).configured,
    ).toBe(true);
  });

  it('does not fail when AUTH_DISABLED=true even with no secrets', () => {
    const cfg = loadAuthConfig({ AUTH_DISABLED: 'true' });
    expect(cfg.disabled).toBe(true);
    expect(cfg.configured).toBe(false);
  });

  it('treats only "true" as disabling auth', () => {
    expect(loadAuthConfig({ ...FULL, AUTH_DISABLED: 'false' }).disabled).toBe(false);
    expect(loadAuthConfig({ ...FULL, AUTH_DISABLED: '1' }).disabled).toBe(false);
  });

  it('honours COOKIE_SECURE=false for local plain-HTTP dev', () => {
    expect(loadAuthConfig({ ...FULL, COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(loadAuthConfig({ ...FULL, COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
  });
});

describe('assertAuthBindSafe', () => {
  const disabled = loadAuthConfig({ AUTH_DISABLED: 'true' });
  const enabled = loadAuthConfig(FULL);

  it('throws when AUTH_DISABLED on a non-loopback bind', () => {
    expect(() => assertAuthBindSafe(disabled, '0.0.0.0', {})).toThrow(/Refusing to start/);
    expect(() => assertAuthBindSafe(disabled, '192.168.1.10', {})).toThrow(/Refusing to start/);
  });

  it('allows AUTH_DISABLED on loopback', () => {
    expect(() => assertAuthBindSafe(disabled, '127.0.0.1', {})).not.toThrow();
    expect(() => assertAuthBindSafe(disabled, '::1', {})).not.toThrow();
    expect(() => assertAuthBindSafe(disabled, 'localhost', {})).not.toThrow();
  });

  it('allows AUTH_DISABLED on a non-loopback bind with the explicit hatch', () => {
    expect(() => assertAuthBindSafe(disabled, '0.0.0.0', { TIERWYN_ALLOW_AUTH_DISABLED_NONLOCAL: '1' })).not.toThrow();
  });

  it('does not throw when auth is enabled on a non-loopback bind', () => {
    expect(() => assertAuthBindSafe(enabled, '0.0.0.0', {})).not.toThrow();
  });
});
