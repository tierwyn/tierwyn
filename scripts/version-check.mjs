#!/usr/bin/env node
/**
 * Public-clone wrapper for `npm run version:check`.
 *
 * Checks version integrity if an extended verifier script is present.
 * When absent, skips cleanly so a fresh clone's `npm run typecheck` / CI can run.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidatePaths = [
  process.env.TIERWYN_VERSION_VERIFIER,
  join(root, 'scripts/sync-version.mjs'),
  join(root, 'internal/maintenance_scripts/repository-management/sync-version.mjs'),
].filter(Boolean);

const inner = candidatePaths.find((p) => existsSync(p));

if (!inner) {
  console.log('version verifier not present — version check skipped');
  process.exit(0);
}

const result = spawnSync(process.execPath, [inner, '--check'], { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
