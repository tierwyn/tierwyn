import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

/**
 * Walk up from `start` to the filesystem root, returning the path of the first
 * `.env` found. Lets the server load the monorepo-root `.env` whether it is
 * launched from the repo root or from `apps/server` (where the npm scripts run,
 * so CWD-relative `.env` would otherwise be missed).
 */
export function findEnvFile(
  start: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = resolve(dir, '.env');
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}
