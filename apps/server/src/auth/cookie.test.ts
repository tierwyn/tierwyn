import { describe, it, expect, afterEach } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  issueSessionCookie,
  clearSessionCookie,
  clearSessionCookies,
  verifySessionCookieHeader,
  readSessionToken,
  setSessionRevocation,
  passwordFingerprint,
} from './cookie.js';

const SECRET = 'test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const T0 = 1_700_000_000_000; // fixed "now"

/** Pull the cookie value out of a Set-Cookie header for round-tripping. */
function cookieHeaderFrom(setCookie: string): string {
  const value = setCookie.split(';')[0]; // "tierwyn_session=<token>"
  return value;
}

describe('session cookie', () => {
  afterEach(() => setSessionRevocation(undefined));

  it('issues a Set-Cookie that verifies back', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    const ok = verifySessionCookieHeader(cookieHeaderFrom(setCookie), SECRET, T0 + 1000);
    expect(ok).toBe(true);
  });

  it('issues __Host-tierwyn_session with Secure, HttpOnly, Path=/, no Domain when secure', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    expect(setCookie).toMatch(/^__Host-tierwyn_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it('clearSessionCookie uses SameSite=Lax to match the issued cookie', () => {
    expect(clearSessionCookie({ secure: true })).toMatch(/SameSite=Lax/i);
  });

  it('omits Secure when secure=false (local dev over plain HTTP)', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: false, now: T0 });
    expect(setCookie).toMatch(/^tierwyn_session=/);
    expect(setCookie).not.toMatch(/^__Host-/);
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it('rejects a cookie signed with a different secret', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    const ok = verifySessionCookieHeader(cookieHeaderFrom(setCookie), 'a-different-secret', T0 + 1000);
    expect(ok).toBe(false);
  });

  it('rejects a tampered token body', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    const token = readSessionToken(cookieHeaderFrom(setCookie))!;
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ iat: 0, exp: 9_999_999_999 })).toString('base64url')}.${sig}`;
    const ok = verifySessionCookieHeader(`${SESSION_COOKIE_NAME}=${forged}`, SECRET, T0);
    expect(ok).toBe(false);
  });

  it('rejects an expired cookie', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0, maxAgeMs: 1000 });
    const ok = verifySessionCookieHeader(cookieHeaderFrom(setCookie), SECRET, T0 + 2000);
    expect(ok).toBe(false);
  });

  it('rejects a missing or garbage cookie header', () => {
    expect(verifySessionCookieHeader(undefined, SECRET, T0)).toBe(false);
    expect(verifySessionCookieHeader('', SECRET, T0)).toBe(false);
    expect(verifySessionCookieHeader('tierwyn_session=not-a-token', SECRET, T0)).toBe(false);
    expect(verifySessionCookieHeader('other=1', SECRET, T0)).toBe(false);
  });

  it('clearSessionCookie expires the __Host- cookie when secure', () => {
    const setCookie = clearSessionCookie({ secure: true });
    expect(setCookie).toMatch(/^__Host-tierwyn_session=;?/);
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it('clearSessionCookies expires __Host- and plain names when secure', () => {
    const expired = clearSessionCookies({ secure: true });
    expect(expired).toHaveLength(2);
    expect(expired[0]).toMatch(/^__Host-tierwyn_session=;?/);
    expect(expired[1]).toMatch(/^tierwyn_session=;?/);
  });

  it('clearSessionCookies expires the plain name (not __Host-) when insecure', () => {
    const expired = clearSessionCookies({ secure: false });
    expect(expired.some((c) => c.startsWith('tierwyn_session='))).toBe(true);
    expect(expired.some((c) => c.startsWith('__Host-'))).toBe(false);
  });

  it('reads both __Host-tierwyn_session and tierwyn_session cookies when secure is unspecified', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    const token = readSessionToken(cookieHeaderFrom(setCookie))!;
    expect(verifySessionCookieHeader(`__Host-tierwyn_session=${token}`, SECRET, T0 + 1000)).toBe(true);
    expect(verifySessionCookieHeader(`tierwyn_session=${token}`, SECRET, T0 + 1000)).toBe(true);
  });

  it('enforces __Host-tierwyn_session only when secure=true, and plain name when secure=false', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    const token = readSessionToken(cookieHeaderFrom(setCookie))!;
    expect(verifySessionCookieHeader(`__Host-tierwyn_session=${token}`, SECRET, T0 + 1000, { secure: true })).toBe(true);
    expect(verifySessionCookieHeader(`tierwyn_session=${token}`, SECRET, T0 + 1000, { secure: true })).toBe(false);
    expect(verifySessionCookieHeader(`tierwyn_session=${token}`, SECRET, T0 + 1000, { secure: false })).toBe(true);
    expect(verifySessionCookieHeader(`__Host-tierwyn_session=${token}`, SECRET, T0 + 1000, { secure: false })).toBe(false);
  });

  it('does not accept a nuncii_session cookie', () => {
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    const token = readSessionToken(cookieHeaderFrom(setCookie))!;
    expect(verifySessionCookieHeader(`nuncii_session=${token}`, SECRET, T0 + 1000)).toBe(false);
  });
});

describe('session revocation', () => {
  afterEach(() => setSessionRevocation(undefined));

  const fp = passwordFingerprint(SECRET, 'hash-v1');

  it('rejects a token minted before the floor and accepts one after', () => {
    setSessionRevocation({ floorMs: () => T0 + 5_000, passwordFp: fp });
    const before = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    expect(verifySessionCookieHeader(cookieHeaderFrom(before), SECRET, T0 + 6_000)).toBe(false);
    const after = issueSessionCookie({ secret: SECRET, secure: true, now: T0 + 5_000 });
    expect(verifySessionCookieHeader(cookieHeaderFrom(after), SECRET, T0 + 6_000)).toBe(true);
  });

  it('rejects a password-fingerprint mismatch', () => {
    setSessionRevocation({ floorMs: () => 0, passwordFp: fp });
    const setCookie = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    setSessionRevocation({ floorMs: () => 0, passwordFp: passwordFingerprint(SECRET, 'hash-v2') });
    expect(verifySessionCookieHeader(cookieHeaderFrom(setCookie), SECRET, T0 + 1000)).toBe(false);
  });

  it('rejects a legacy token without ph when revocation is set; accepts when not', () => {
    const legacy = issueSessionCookie({ secret: SECRET, secure: true, now: T0 });
    expect(verifySessionCookieHeader(cookieHeaderFrom(legacy), SECRET, T0 + 1000)).toBe(true);
    setSessionRevocation({ floorMs: () => 0, passwordFp: fp });
    expect(verifySessionCookieHeader(cookieHeaderFrom(legacy), SECRET, T0 + 1000)).toBe(false);
  });
});
