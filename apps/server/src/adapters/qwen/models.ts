/**
 * Disk cache for qwen `session/new` model discovery.
 *
 * Mirrors kiro/models.ts: sibling of TIERWYN_DB (`data/qwen-models.json`),
 * `{ fetchedAt, models }` shape, 12h TTL matching DISCOVERY_INTERVAL_MS.
 * Fresh cache skips the throwaway ACP probe (which otherwise litters
 * ~/.qwen/projects/<cwd>/chats/ on every boot / 12h tick). Probe failure
 * falls back to stale cache even when expired. All IO is try/catch — a
 * bad cache file must never throw.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ModelDescriptor } from '@tierwyn/shared';
import { dbPathFromEnv } from '../../config/env.js';

/** Matches scheduler DISCOVERY_INTERVAL_MS so a cache written at tick N is fresh until tick N+1. */
export const QWEN_MODELS_TTL_MS = 12 * 60 * 60 * 1000;

interface CacheFile {
  fetchedAt: number;
  models: ModelDescriptor[];
}

export function qwenModelsCachePath(): string {
  const dbPath = dbPathFromEnv();
  return join(dirname(dbPath), 'qwen-models.json');
}

export function readQwenModelsCache(cachePath: string): CacheFile | null {
  try {
    if (!existsSync(cachePath)) return null;
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.fetchedAt !== 'number' || !Array.isArray(rec.models)) return null;
    return { fetchedAt: rec.fetchedAt, models: rec.models as ModelDescriptor[] };
  } catch {
    return null;
  }
}

export function writeQwenModelsCache(cachePath: string, models: ModelDescriptor[], fetchedAt: number): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const body: CacheFile = { fetchedAt, models };
    writeFileSync(cachePath, JSON.stringify(body), 'utf-8');
  } catch {
    /* never throw — a full disk must not abort listModels */
  }
}

export async function listQwenModels(opts: {
  cachePath: string;
  probe: () => Promise<ModelDescriptor[]>;
  now?: () => number;
}): Promise<ModelDescriptor[]> {
  const now = opts.now ?? Date.now;
  const cached = readQwenModelsCache(opts.cachePath);
  if (cached && cached.models.length > 0 && now() - cached.fetchedAt < QWEN_MODELS_TTL_MS) {
    return cached.models;
  }

  try {
    const models = await opts.probe();
    if (models.length > 0) {
      writeQwenModelsCache(opts.cachePath, models, now());
      return models;
    }
  } catch {
    // spawn failure / timeout — fall through to stale cache
  }

  return cached?.models ?? [];
}
