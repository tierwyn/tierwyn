/**
 * Parse `kiro-cli chat --list-models --format json` and cache the result.
 *
 * ponytail: the disk cache exists so boot discovery never blocks on a cold
 * kiro-cli spawn. If the 12h scheduler alone proves sufficient in practice,
 * delete models.ts's cache half and inline parseKiroModels into index.ts.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { ModelDescriptor } from '@tierwyn/shared';

const execFileAsync = promisify(execFile);
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

interface CacheFile {
  fetchedAt: number;
  models: ModelDescriptor[];
}

export function parseKiroModels(stdout: string): ModelDescriptor[] {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return []; }

  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as { models?: unknown }).models)) {
    entries = (raw as { models: unknown[] }).models;
  } else {
    return [];
  }

  const out: ModelDescriptor[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const id = rec.model_id;
    if (typeof id !== 'string' || !id) continue;
    const modelName = typeof rec.model_name === 'string' && rec.model_name ? rec.model_name : id;
    const desc: ModelDescriptor = {
      name: id,
      label: `Kiro · ${modelName}`,
      provider: 'kiro',
      vision: true,
      steer: false,
    };
    if (typeof rec.context_window_tokens === 'number') desc.contextWindow = rec.context_window_tokens;
    out.push(desc);
  }

  out.sort((a, b) => {
    if (a.name === 'auto' && b.name !== 'auto') return -1;
    if (b.name === 'auto' && a.name !== 'auto') return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

function readCache(cachePath: string): CacheFile | null {
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.fetchedAt !== 'number' || !Array.isArray(rec.models)) return null;
    return { fetchedAt: rec.fetchedAt, models: rec.models as ModelDescriptor[] };
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, models: ModelDescriptor[], fetchedAt: number): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const body: CacheFile = { fetchedAt, models };
  writeFileSync(cachePath, JSON.stringify(body), 'utf-8');
}

export async function listKiroModels(opts: {
  bin: string;
  cachePath: string;
  execFileFn?: typeof execFileAsync | ExecFileFn;
  now?: () => number;
}): Promise<ModelDescriptor[]> {
  const now = opts.now ?? Date.now;
  const execFn = (opts.execFileFn ?? execFileAsync) as ExecFileFn;
  const cached = readCache(opts.cachePath);
  if (cached && now() - cached.fetchedAt < TWELVE_HOURS_MS) {
    return cached.models;
  }

  try {
    const result = await execFn(opts.bin, ['chat', '--list-models', '--format', 'json'], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout);
    const models = parseKiroModels(stdout);
    if (models.length > 0) {
      writeCache(opts.cachePath, models, now());
      return models;
    }
  } catch {
    // spawn failure / timeout — fall through to stale cache
  }

  return cached?.models ?? [];
}
