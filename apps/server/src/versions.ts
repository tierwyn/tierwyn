/**
 * Version probing and caching for the catalogue (WP-2.3).
 *
 * Probes installed CLI versions via `<bin> --version` and queries npm registry /
 * GitHub releases for the latest published versions. Caches results in the
 * `settings` table under `agent_versions` with a 12-hour TTL.
 */

import type { Database } from 'better-sqlite3';
import { execFile } from 'child_process';
import { buildChildEnv } from './childEnv.js';
import { AGENT_BINARIES, binaryOnPath } from './discovery.js';

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Extracts the first semver-like token from CLI output text.
 * Matches standard semver `X.Y.Z` with optional prerelease/build suffix (`-foo`, `+bar`),
 * as well as date-style versions (`2026.10.14-0f9edde`). Strips leading `v`.
 */
export function parseCliVersion(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)/);
  return m ? m[1] : undefined;
}

/**
 * Compares two version strings (semver-ish simplified spec).
 * - Strips build metadata after `+`.
 * - Splits core vs prerelease at the first `-`.
 * - Compares the three numeric core parts (any non-numeric part → undefined unless identical, then 0).
 * - A release WITHOUT prerelease is GREATER than one WITH.
 * - Two prereleases with identical cores → compare not needed, return 0.
 *
 * Returns:
 * - -1 if a < b
 * - 0 if a == b
 * - 1 if a > b
 * - undefined if either cannot be parsed as a 3-part numeric core (and not identical).
 */
export function compareVersions(a: string, b: string): number | undefined {
  if (a === b) return 0;
  const aClean = a.split('+')[0];
  const bClean = b.split('+')[0];
  if (aClean === bClean) return 0;

  const aDash = aClean.indexOf('-');
  const aCore = aDash >= 0 ? aClean.slice(0, aDash) : aClean;
  const aHasPre = aDash >= 0;

  const bDash = bClean.indexOf('-');
  const bCore = bDash >= 0 ? bClean.slice(0, bDash) : bClean;
  const bHasPre = bDash >= 0;

  const aParts = aCore.split('.');
  const bParts = bCore.split('.');
  if (aParts.length !== 3 || bParts.length !== 3) {
    return a === b ? 0 : undefined;
  }
  for (let i = 0; i < 3; i++) {
    if (!/^\d+$/.test(aParts[i]) || !/^\d+$/.test(bParts[i])) {
      return a === b ? 0 : undefined;
    }
  }

  for (let i = 0; i < 3; i++) {
    const na = Number(aParts[i]);
    const nb = Number(bParts[i]);
    if (na < nb) return -1;
    if (na > nb) return 1;
  }

  // Cores are numerically identical
  if (!aHasPre && bHasPre) return 1;
  if (aHasPre && !bHasPre) return -1;
  return 0;
}

/**
 * Returns true if installed < latest, false if up-to-date/ahead, or undefined
 * if either side cannot be parsed.
 */
export function isBehind(installed?: string, latest?: string): boolean | undefined {
  if (!installed || !latest) return undefined;
  const inst = parseCliVersion(installed);
  const lat = parseCliVersion(latest);
  if (!inst || !lat) return undefined;
  const cmp = compareVersions(inst, lat);
  if (cmp === undefined) return undefined;
  return cmp < 0;
}

// ── Impure probes ────────────────────────────────────────────────────────────

export type RunVersion = (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRunVersion: RunVersion = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { env: buildChildEnv(), timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Executes `<bin> --version` and parses the output for a semver token.
 * Never throws (returns undefined on any error/timeout).
 * Retries once after `retryDelayMs`: at hello time ~15 probes fork in parallel
 * and a slow or transiently failing CLI must not lose its version.
 */
export async function probeInstalledVersion(
  bin: string,
  exec?: RunVersion,
  retryDelayMs = 2000,
): Promise<string | undefined> {
  const runner = exec ?? defaultRunVersion;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout, stderr } = await runner(bin, ['--version']);
      const parsed = parseCliVersion(`${stdout}\n${stderr}`);
      if (parsed !== undefined) return parsed;
    } catch {
      // fall through to the retry
    }
    if (attempt === 0) await sleep(retryDelayMs);
  }
  return undefined;
}

/**
 * Queries the npm registry for the latest published version of a package.
 * Returns undefined on error or non-200.
 */
export async function fetchLatestNpm(pkg: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${pkg}/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[versions] npm fetch for "${pkg}" returned HTTP ${res.status}`);
      return undefined;
    }
    const data = (await res.json()) as { version?: unknown };
    if (typeof data?.version === 'string') {
      return parseCliVersion(data.version);
    }
    console.warn(`[versions] npm fetch for "${pkg}" invalid JSON or missing version`);
    return undefined;
  } catch (err) {
    console.warn(`[versions] npm fetch error for "${pkg}":`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/**
 * Queries GitHub releases API for the latest published tag of owner/repo.
 * Returns undefined on error, 404, or non-200.
 */
export async function fetchLatestGitHub(repo: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[versions] GitHub releases fetch for "${repo}" returned HTTP ${res.status}`);
      return undefined;
    }
    const data = (await res.json()) as { tag_name?: unknown };
    if (typeof data?.tag_name === 'string') {
      const stripped = data.tag_name.startsWith('v') ? data.tag_name.slice(1) : data.tag_name;
      return parseCliVersion(stripped) ?? stripped;
    }
    console.warn(`[versions] GitHub releases fetch for "${repo}" missing tag_name`);
    return undefined;
  } catch (err) {
    console.warn(`[versions] GitHub releases fetch error for "${repo}":`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/**
 * Vendor install scripts embed the release in their download URL
 * (e.g. cursor's …/lab/<version>/<sha>/…); the first match is the latest.
 */
const SCRIPT_VERSION_RE = /lab\/(\d{4}\.\d+\.\d+[-+][0-9a-f]{7,})\//;

/**
 * A `text` feed must BE a version, not merely contain one — an HTML error page
 * that happens to mention "Ray 1.2.3" must not become a latest version.
 */
const BARE_VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * Fetches a latest version from a direct URL feed (`latestFeed` on an
 * AGENT_BINARIES entry). `json` reads the body's `version` field, `text` only
 * accepts a whole trimmed body that is a bare version string, `script`
 * extracts the release from an install script.
 * Returns undefined on error, non-200, or an unparseable body.
 */
export async function fetchLatestFeed(
  meta: { url: string; kind: 'json' | 'text' | 'script' },
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(meta.url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn(`[versions] feed fetch for "${meta.url}" returned HTTP ${res.status}`);
      return undefined;
    }
    const body = await res.text();
    let raw: string | undefined;
    if (meta.kind === 'json') {
      try {
        const data = JSON.parse(body) as { version?: unknown };
        raw = typeof data?.version === 'string' ? data.version : undefined;
      } catch {
        raw = undefined;
      }
    } else if (meta.kind === 'text') {
      const trimmed = body.trim();
      raw = BARE_VERSION_RE.test(trimmed) ? trimmed : undefined;
    } else {
      raw = body.match(SCRIPT_VERSION_RE)?.[1];
    }
    const parsed = raw !== undefined ? parseCliVersion(raw) : undefined;
    if (parsed === undefined) {
      console.warn(`[versions] feed fetch for "${meta.url}" had no parseable version`);
    }
    return parsed;
  } catch (err) {
    console.warn(`[versions] feed fetch error for "${meta.url}":`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

// ── Cache & discovery ────────────────────────────────────────────────────────

export interface VersionCacheEntry {
  installed?: string;
  latest?: string;
  checkedAt: number;
}
export type VersionCache = Record<string, VersionCacheEntry>;

export const VERSION_SETTINGS_KEY = 'agent_versions';
export const VERSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function loadVersionCache(db: Database): VersionCache {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(VERSION_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return {};
    return JSON.parse(row.value) as VersionCache;
  } catch {
    return {};
  }
}

function saveVersionCache(db: Database, cache: VersionCache): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    VERSION_SETTINGS_KEY,
    JSON.stringify(cache),
  );
}

/**
 * Refreshes version cache for known agent binaries.
 * Respects 12-hour TTL unless `force: true` is passed.
 * Failed lookups retain previous cached values.
 * Never throws.
 */
export async function refreshAgentVersions(
  db: Database,
  opts?: {
    now?: () => number;
    probe?: typeof probeInstalledVersion;
    npm?: typeof fetchLatestNpm;
    github?: typeof fetchLatestGitHub;
    feed?: typeof fetchLatestFeed;
    force?: boolean;
  },
): Promise<VersionCache> {
  const now = opts?.now ? opts.now() : Date.now();
  const probe = opts?.probe ?? probeInstalledVersion;
  const npm = opts?.npm ?? fetchLatestNpm;
  const github = opts?.github ?? fetchLatestGitHub;
  const feed = opts?.feed ?? fetchLatestFeed;
  const force = opts?.force ?? false;

  const cache: VersionCache = { ...loadVersionCache(db) };

  const rows = db.prepare('SELECT type, executable_path FROM agents').all() as { type: string; executable_path: string | null }[];
  const overrides = new Map<string, string | null>();
  for (const r of rows) overrides.set(r.type, r.executable_path);

  for (const [type, meta] of Object.entries(AGENT_BINARIES)) {
    if (meta.noVersion) continue;

    const existing = cache[type];
    const isFresh = existing && existing.checkedAt && (now - existing.checkedAt < VERSION_TTL_MS);
    if (isFresh && !force) continue;

    try {
      const override = overrides.get(type);
      const bin = (override && override.trim()) || meta.bin || type;

      let installed: string | undefined = undefined;
      if (binaryOnPath(bin)) {
        const probed = await probe(bin);
        installed = probed !== undefined ? probed : existing?.installed;
      }

      let latest: string | undefined = existing?.latest;
      if (meta.pkg) {
        const fetched = await npm(meta.pkg);
        if (fetched !== undefined) latest = fetched;
      } else if (meta.releasesRepo) {
        const fetched = await github(meta.releasesRepo);
        if (fetched !== undefined) latest = fetched;
      } else if (meta.latestFeed) {
        const fetched = await feed(meta.latestFeed);
        if (fetched !== undefined) latest = fetched;
      }

      cache[type] = {
        installed,
        latest,
        checkedAt: now,
      };
    } catch (err) {
      console.warn(`[versions] failed to refresh versions for "${type}":`, err);
    }
  }

  saveVersionCache(db, cache);
  return cache;
}
