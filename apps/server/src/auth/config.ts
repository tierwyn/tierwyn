import { envPrefFrom } from '../config/env.js';

export interface AuthConfig {
  /** When true, all auth enforcement is bypassed (local dev only). */
  disabled: boolean;
  /**
   * Whether both required secrets are present. When false (and not disabled),
   * the app boots fail-closed: every protected route and the WS upgrade are
   * rejected and no login can succeed — the operator must set the secrets in
   * .env and restart. We never sign or verify a cookie with an empty secret.
   */
  configured: boolean;
  /** HMAC secret used to sign the session cookie. */
  sessionSecret: string;
  /** argon2 hash of the single operator password. */
  passwordHash: string;
  /** Whether the session cookie carries the Secure flag (default true). */
  cookieSecure: boolean;
}

type Env = Record<string, string | undefined>;

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || /^127\./.test(h);
}

/**
 * Refuse AUTH_DISABLED on a non-loopback bind. Override with
 * TIERWYN_ALLOW_AUTH_DISABLED_NONLOCAL=1.
 */
export function assertAuthBindSafe(cfg: AuthConfig, host: string, env: Env = process.env): void {
  if (!cfg.disabled) return;
  if (isLoopbackHost(host)) return;
  if (envPrefFrom(env, 'ALLOW_AUTH_DISABLED_NONLOCAL') === '1') return;
  throw new Error(
    `Refusing to start: AUTH_DISABLED=true with HOST=${host}. Bind to 127.0.0.1 or enable auth.`,
  );
}

/**
 * Load auth configuration from the environment. Never throws: when the required
 * secrets are missing the app boots in a fail-closed "not configured" state
 * (see AuthConfig.configured) rather than starting unauthenticated. Setting
 * AUTH_DISABLED=true bypasses auth entirely (local dev only).
 */
export function loadAuthConfig(env: Env = process.env): AuthConfig {
  const disabled = env.AUTH_DISABLED === 'true';
  const sessionSecret = env.SESSION_SECRET ?? '';
  const passwordHash = env.OPERATOR_PASSWORD_HASH ?? '';
  const cookieSecure = env.COOKIE_SECURE !== 'false'; // default true
  const configured =
    Buffer.byteLength(sessionSecret, 'utf8') >= 32 && passwordHash.length > 0;

  return { disabled, configured, sessionSecret, passwordHash, cookieSecure };
}
