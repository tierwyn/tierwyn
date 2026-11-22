import { join } from 'path';
import { homedir } from 'os';

/** ~/.grok/sessions — Grok ACP session store root. */
export const GROK_SESSIONS_DIR = join(homedir(), '.grok', 'sessions');

/**
 * Encode a cwd the way grok stores session buckets on disk. CONFIRMED Phase 0:
 * `/home/user/Projects/Tierwyn` → `%2Fhome%2Fuser%2FProjects%2FTierwyn`
 * — every `/` becomes `%2F`, other characters unchanged. encodeURIComponent
 * does NOT do this for `/` on Linux paths; we percent-encode `/` explicitly.
 */
export function encodeSessionBucket(cwd: string): string {
  if (!cwd) return '';
  // Replace each path separator with %2F, leaving the rest of the path bytes
  // as-is (matching the observed on-disk shape — no further encoding of `.`,
  // `-`, letters, etc.).
  return cwd.split('/').map((seg) => encodeURIComponent(seg)).join('%2F');
}
