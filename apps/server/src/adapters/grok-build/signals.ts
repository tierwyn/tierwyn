/**
 * Read Grok's durable per-session telemetry from
 *   ~/.grok/sessions/<percent-encoded-cwd>/<nativeSessionId>/signals.json
 *
 * Same numbers `/session-info` shows (contextWindowUsage / Tokens / Window).
 * Used by GET /conversations/:id/usage so the Usage panel can show live context %
 * for resumable sessions without running the /session-info slash turn.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { encodeSessionBucket, GROK_SESSIONS_DIR } from './sessionPaths.js';

export interface GrokSignalsFile {
  contextWindowUsage?: number;
  contextTokensUsed?: number;
  contextWindowTokens?: number;
  /** Epoch ms of signals.json mtime (freshness). */
  mtimeMs?: number;
}

function tryReadSignals(path: string): GrokSignalsFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const out: GrokSignalsFile = {};
    if (typeof raw.contextWindowUsage === 'number') out.contextWindowUsage = raw.contextWindowUsage;
    if (typeof raw.contextTokensUsed === 'number') out.contextTokensUsed = raw.contextTokensUsed;
    if (typeof raw.contextWindowTokens === 'number') out.contextWindowTokens = raw.contextWindowTokens;
    try { out.mtimeMs = statSync(path).mtimeMs; } catch { /* skip */ }
    // Only return when we got at least one context field.
    if (
      out.contextWindowUsage === undefined
      && out.contextTokensUsed === undefined
      && out.contextWindowTokens === undefined
    ) {
      return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Locate and parse signals.json for a native Grok session id.
 * Prefer the cwd-bucket path; fall back to scanning all session buckets
 * (mirrors GrokBuildAdapter.isNativeSessionAvailable).
 */
export function readGrokSessionSignals(
  nativeSessionId: string,
  opts: { cwd?: string; sessionsRoot?: string } = {},
): GrokSignalsFile | null {
  if (!nativeSessionId) return null;
  const root = opts.sessionsRoot ?? GROK_SESSIONS_DIR;
  const bucket = opts.cwd ? encodeSessionBucket(opts.cwd) : '';
  if (bucket) {
    const hit = tryReadSignals(join(root, bucket, nativeSessionId, 'signals.json'));
    if (hit) return hit;
  }
  try {
    const buckets = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const b of buckets) {
      if (bucket && b === bucket) continue; // already tried
      const hit = tryReadSignals(join(root, b, nativeSessionId, 'signals.json'));
      if (hit) return hit;
    }
  } catch {
    // missing root — no signals
  }
  return null;
}
