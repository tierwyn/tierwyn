import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  KIMI_MODELS_TTL_MS,
  listKimiModels,
  kimiModelsCachePath,
  readKimiModelsCache,
} from './models.js';
import type { ModelDescriptor } from '@tierwyn/shared';

const SAMPLE: ModelDescriptor[] = [{
  name: 'zai-coding-plan/glm-5.3',
  label: 'Kimi Code · GLM-5.3',
  provider: 'z.ai',
  vision: true,
  steer: true,
  contextWindow: 1_000_000,
}];

describe('kimiModelsCachePath', () => {
  it('sits next to TIERWYN_DB as kimi-models.json', () => {
    expect(kimiModelsCachePath()).toMatch(/kimi-models\.json$/);
  });
});

describe('listKimiModels', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-models-'));
    cachePath = join(dir, 'kimi-models.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a fresh cache without calling probe', async () => {
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1_000_000, models: SAMPLE }));
    let calls = 0;
    const out = await listKimiModels({
      cachePath,
      probe: async () => {
        calls++;
        return SAMPLE;
      },
      now: () => 1_000_000 + 60_000, // 1 minute later — still fresh
    });
    expect(calls).toBe(0);
    expect(out).toEqual(SAMPLE);
  });

  it('probes and rewrites the cache when stale', async () => {
    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: 1,
      models: [{ name: 'stale', label: 'stale', provider: 'z.ai' }],
    }));
    const now = KIMI_MODELS_TTL_MS + 50;
    const out = await listKimiModels({
      cachePath,
      probe: async () => SAMPLE,
      now: () => now,
    });
    expect(out).toEqual(SAMPLE);
    const written = JSON.parse(readFileSync(cachePath, 'utf-8')) as { fetchedAt: number; models: unknown[] };
    expect(written.fetchedAt).toBe(now);
    expect(written.models).toEqual(SAMPLE);
  });

  it('returns the stale cache when probe rejects, even if expired', async () => {
    const stale = [{ name: 'stale-glm', label: 'stale', provider: 'z.ai' }];
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1, models: stale }));
    const fromStale = await listKimiModels({
      cachePath,
      probe: async () => { throw new Error('ENOENT'); },
      now: () => 99_999_999,
    });
    expect(fromStale).toEqual(stale);
  });

  it('returns [] when probe rejects and there is no cache', async () => {
    const missingPath = join(dir, 'missing', 'kimi-models.json');
    const empty = await listKimiModels({
      cachePath: missingPath,
      probe: async () => { throw new Error('ENOENT'); },
      now: () => 1,
    });
    expect(empty).toEqual([]);
    expect(existsSync(missingPath)).toBe(false);
  });

  it('does not write the cache when probe returns []', async () => {
    const out = await listKimiModels({
      cachePath,
      probe: async () => [],
      now: () => 1,
    });
    expect(out).toEqual([]);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('never throws on a corrupt cache file and treats it as absent', async () => {
    writeFileSync(cachePath, 'not json{{{');
    const out = await listKimiModels({
      cachePath,
      probe: async () => SAMPLE,
      now: () => 1,
    });
    expect(out).toEqual(SAMPLE);
    expect(readKimiModelsCache(cachePath)?.models).toEqual(SAMPLE);
  });
});
