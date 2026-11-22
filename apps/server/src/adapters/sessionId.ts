/** Native CLI session ids are UUIDs / slugs. Anything else (paths, flags) is rejected. */
export const NATIVE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

const NEVER_STORE_PREFIXES = [
  '/proc', '/sys', '/dev', '/run', '/etc', '/boot', '/root', '/var/lib', '/var/run',
];

export function safeNativeSessionId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return NATIVE_SESSION_ID_RE.test(v) && !v.includes('..') ? v : undefined;
}

/**
 * Persistence / resume of adapters whose native id is a filesystem path (Pi).
 * Slugs pass; absolute paths pass only when they are not system dirs.
 */
export function safePersistedNativeSessionId(v: unknown): string | undefined {
  const slug = safeNativeSessionId(v);
  if (slug) return slug;
  if (typeof v !== 'string') return undefined;
  if (v.length < 2 || v.length > 1024 || v.includes('\0') || v.includes('..')) return undefined;
  if (!v.startsWith('/')) return undefined;
  const n = v.endsWith('/') ? v.slice(0, -1) : v;
  if (NEVER_STORE_PREFIXES.some((d) => n === d || n.startsWith(d + '/'))) return undefined;
  return v;
}

/** User-task alias: same as safeNativeSessionId, null instead of undefined. */
export function validateSessionId(sid: unknown): string | null {
  return safeNativeSessionId(sid) ?? null;
}
