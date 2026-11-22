import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseKiroModels, listKiroModels } from './models.js';

/** Live-captured `kiro-cli chat --list-models --format json` envelope (2.19.1). */
const LIVE_ENVELOPE = {
  models: [
    {
      model_name: 'auto',
      description: 'Models chosen by task for optimal usage and consistent quality',
      model_id: 'auto',
      context_window_tokens: 1000000,
      rate_multiplier: 1.0,
      rate_unit: 'Credit',
    },
    {
      model_name: 'claude-sonnet-4.5',
      description: 'Claude Sonnet 4.5 model',
      model_id: 'claude-sonnet-4.5',
      context_window_tokens: 200000,
      rate_multiplier: 1.3,
      rate_unit: 'Credit',
    },
    {
      model_name: 'glm-5',
      description: 'GLM-5 model',
      model_id: 'glm-5',
      context_window_tokens: 200000,
      rate_multiplier: 0.5,
      rate_unit: 'Credit',
    },
    {
      model_name: 'qwen3-coder-next',
      description: 'Experimental preview of Qwen3 Coder Next',
      model_id: 'qwen3-coder-next',
      context_window_tokens: 256000,
      rate_multiplier: 0.05,
      rate_unit: 'Credit',
    },
  ],
  default_model: 'auto',
};

describe('parseKiroModels', () => {
  it('parses the live envelope, puts auto first, and prefixes labels with Kiro · ', () => {
    // Shuffle so sort is actually tested (live JSON already has auto first).
    const shuffled = {
      models: [
        LIVE_ENVELOPE.models[2],
        LIVE_ENVELOPE.models[1],
        LIVE_ENVELOPE.models[3],
        LIVE_ENVELOPE.models[0],
      ],
      default_model: 'auto',
    };
    const out = parseKiroModels(JSON.stringify(shuffled));
    expect(out.map((m) => m.name)).toEqual(['auto', 'claude-sonnet-4.5', 'glm-5', 'qwen3-coder-next']);
    expect(out[0]).toMatchObject({
      name: 'auto',
      label: 'Kiro · auto',
      provider: 'kiro',
      vision: true,
      steer: false,
      contextWindow: 1_000_000,
    });
    expect(out[1].label).toBe('Kiro · claude-sonnet-4.5');
    expect(out[2].contextWindow).toBe(200_000);
  });

  it('parses a bare array identically to the {models:[]} envelope', () => {
    const fromEnvelope = parseKiroModels(JSON.stringify(LIVE_ENVELOPE));
    const fromArray = parseKiroModels(JSON.stringify(LIVE_ENVELOPE.models));
    expect(fromArray).toEqual(fromEnvelope);
  });

  it('returns [] on garbage, empty string, or {} and never throws', () => {
    expect(parseKiroModels('')).toEqual([]);
    expect(parseKiroModels('not json')).toEqual([]);
    expect(parseKiroModels('{}')).toEqual([]);
    expect(parseKiroModels('null')).toEqual([]);
    expect(parseKiroModels(JSON.stringify({ models: [{ model_name: 'x' }] }))).toEqual([]);
  });
});

describe('listKiroModels', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kiro-models-'));
    cachePath = join(dir, 'kiro-models.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a fresh cache without calling execFileFn', async () => {
    const models = parseKiroModels(JSON.stringify(LIVE_ENVELOPE));
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1_000_000, models }));
    let calls = 0;
    const out = await listKiroModels({
      bin: 'kiro-cli',
      cachePath,
      execFileFn: async () => {
        calls++;
        return { stdout: '' };
      },
      now: () => 1_000_000 + 60_000, // 1 minute later — still fresh
    });
    expect(calls).toBe(0);
    expect(out.map((m) => m.name)).toEqual(models.map((m) => m.name));
  });

  it('spawns and rewrites the cache when stale', async () => {
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1, models: [{ name: 'stale', label: 'stale', provider: 'kiro' }] }));
    const now = 12 * 60 * 60 * 1000 + 50;
    const out = await listKiroModels({
      bin: 'kiro-cli',
      cachePath,
      execFileFn: async (bin, args) => {
        expect(bin).toBe('kiro-cli');
        expect(args).toEqual(['chat', '--list-models', '--format', 'json']);
        return { stdout: JSON.stringify(LIVE_ENVELOPE) };
      },
      now: () => now,
    });
    expect(out[0].name).toBe('auto');
    const written = JSON.parse(readFileSync(cachePath, 'utf-8')) as { fetchedAt: number; models: unknown[] };
    expect(written.fetchedAt).toBe(now);
    expect(written.models).toHaveLength(out.length);
  });

  it('returns the stale cache when execFileFn rejects, and [] when there is no cache', async () => {
    const stale = [{ name: 'stale-auto', label: 'Kiro · stale-auto', provider: 'kiro', vision: true, steer: false }];
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1, models: stale }));
    const fromStale = await listKiroModels({
      bin: 'kiro-cli',
      cachePath,
      execFileFn: async () => { throw new Error('ENOENT'); },
      now: () => 99_999_999,
    });
    expect(fromStale).toEqual(stale);

    const missingPath = join(dir, 'missing', 'kiro-models.json');
    const empty = await listKiroModels({
      bin: 'kiro-cli',
      cachePath: missingPath,
      execFileFn: async () => { throw new Error('ENOENT'); },
      now: () => 1,
    });
    expect(empty).toEqual([]);
    expect(existsSync(missingPath)).toBe(false);
  });
});
