import { createHmac, timingSafeEqual } from 'crypto';
import { serialize, parse } from 'cookie';

export const SESSION_COOKIE_NAME = 'tierwyn_session';
/** `__Host-` prefix requires Secure + Path=/ + no Domain; browsers reject it over HTTP. */
export const HOST_SESSION_COOKIE_NAME = '__Host-tierwyn_session';

export function sessionCookieName(secure: boolean): string {
  return secure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days

interface SessionPayload { iat: number; exp: number; iatMs?: number; ph?: string }

type SessionRevocation = { floorMs: () => number; passwordFp: string };
let revocation: SessionRevocation | undefined;

export function setSessionRevocation(r: SessionRevocation | undefined): void {
  revocation = r;
}

/** HMAC fingerprint of the operator password hash, bound into new session cookies. */
export function passwordFingerprint(secret: string, passwordHash: string): string {
  return createHmac('sha256', secret).update(`ph:${passwordHash}`).digest('base64url').slice(0, 16);
}

function phEqual(got: string | undefined, want: string): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** `<base64url(payload)>.<base64url(hmac)>` — payload carries iat/exp (+ iatMs/ph when revocation is wired). */
export function createSessionToken(secret: string, now: number, maxAgeMs = DEFAULT_MAX_AGE_MS): string {
  const payload: SessionPayload = {
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + maxAgeMs) / 1000),
    iatMs: now,
    ...(revocation ? { ph: revocation.passwordFp } : {}),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function verifySessionToken(token: string, secret: string, now: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;

  const expected = sign(payloadB64, secret);
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return false;
    if (revocation) {
      if (!phEqual(payload.ph, revocation.passwordFp)) return false;
      const iatMs = typeof payload.iatMs === 'number' ? payload.iatMs : payload.iat * 1000;
      if (iatMs < revocation.floorMs()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function issueSessionCookie(opts: {
  secret: string;
  secure: boolean;
  now?: number;
  maxAgeMs?: number;
}): string {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const token = createSessionToken(opts.secret, now, maxAgeMs);
  return serialize(sessionCookieName(opts.secure), token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

function expireCookie(name: string, secure: boolean): string {
  return serialize(name, '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  return expireCookie(sessionCookieName(opts.secure), opts.secure);
}

/** Expire current and alternate names so a COOKIE_SECURE flip still logs out. */
export function clearSessionCookies(opts: { secure: boolean }): string[] {
  const names = opts.secure
    ? [HOST_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME]
    : [SESSION_COOKIE_NAME];
  return names.map((name) => expireCookie(name, opts.secure));
}

export function readSessionToken(
  cookieHeader: string | undefined,
  opts?: { secure?: boolean },
): string | undefined {
  if (!cookieHeader) return undefined;
  try {
    const cookies = parse(cookieHeader);
    if (opts?.secure === true) return cookies[HOST_SESSION_COOKIE_NAME];
    if (opts?.secure === false) return cookies[SESSION_COOKIE_NAME];
    return cookies[HOST_SESSION_COOKIE_NAME] || cookies[SESSION_COOKIE_NAME];
  } catch {
    return undefined;
  }
}

export function verifySessionCookieHeader(
  cookieHeader: string | undefined,
  secret: string,
  now = Date.now(),
  opts?: { secure?: boolean },
): boolean {
  const token = readSessionToken(cookieHeader, opts);
  return token ? verifySessionToken(token, secret, now) : false;
}
