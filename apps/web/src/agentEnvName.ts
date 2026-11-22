/** Client-side check for per-agent vault env names. Server also denies reserved names. */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function isValidEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}

export function relativeEnvTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
