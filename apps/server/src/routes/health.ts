import type { Express } from 'express';
import { gitSync } from '../git/gitExec.js';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TIERWYN_VERSION } from '@tierwyn/shared';
import { envPref } from '../config/env.js';

export interface HealthInfo {
  ok: true;
  /** Locked monorepo release version (generated into @tierwyn/shared). */
  version: string;
  /** Short git SHA when available (env override or live git). */
  gitSha: string | null;
  /** ISO timestamp of process start (or TIERWYN_BUILT_AT if set at build). */
  builtAt: string;
  /** How this process was launched. */
  serverMode: 'dist' | 'tsx' | 'unknown';
  /** Process start time (ms). */
  startedAt: number;
}

const startedAt = Date.now();

function detectServerMode(): HealthInfo['serverMode'] {
  const mode = envPref('SERVER_MODE');
  if (mode === 'dist' || mode === 'tsx') {
    return mode;
  }
  // argv / exec path heuristics
  const joined = process.argv.join(' ');
  if (joined.includes('tsx') || joined.includes('node_modules/tsx')) return 'tsx';
  try {
    const here = fileURLToPath(import.meta.url);
    if (here.includes(`${join('dist')}`) || here.endsWith('.js') && here.includes('/dist/')) {
      return 'dist';
    }
  } catch {
    /* ignore */
  }
  if (joined.includes('/dist/')) return 'dist';
  return 'unknown';
}

function resolveGitSha(): string | null {
  const shaOverride = envPref('GIT_SHA')?.trim();
  if (shaOverride) return shaOverride;
  try {
    const sha = gitSync(process.cwd(), ['rev-parse', '--short', 'HEAD'], {
      skipConfigScan: true,
      timeoutMs: 2000,
    }).trim();
    return sha || null;
  } catch {
    // Optional: VERSION file next to package root
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      for (const rel of ['../../../.git-sha', '../../.git-sha', '../.git-sha']) {
        const p = join(here, rel);
        if (existsSync(p)) {
          const t = readFileSync(p, 'utf8').trim();
          if (t) return t;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

const serverMode = detectServerMode();
const gitSha = resolveGitSha();
const builtAt = envPref('BUILT_AT')?.trim() || new Date(startedAt).toISOString();

export function getHealthInfo(): HealthInfo {
  return {
    ok: true,
    version: TIERWYN_VERSION,
    gitSha,
    builtAt,
    serverMode,
    startedAt,
  };
}

/** Public liveness + deploy fingerprint (no auth). */
export function registerHealthRoutes(app: Express): void {
  app.get('/health', (_req, res) => {
    res.json(getHealthInfo());
  });
}
