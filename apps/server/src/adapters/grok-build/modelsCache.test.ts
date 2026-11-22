/**
 * modelsCache.test.ts — readGrokModelsCache (temp dir only; never reads ~/.grok).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readGrokModelsCache } from './modelsCache.js';

describe('readGrokModelsCache', () => {
  let grokHome: string;

  beforeEach(() => {
    grokHome = mkdtempSync(join(tmpdir(), 'grok-cache-'));
  });

  afterEach(() => {
    rmSync(grokHome, { recursive: true, force: true });
  });

  function writeCache(body: unknown) {
    writeFileSync(join(grokHome, 'models_cache.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }

  function sampleEntry(id: string, extra: Record<string, unknown> = {}) {
    return {
      info: {
        id,
        name: extra.name ?? (id === 'grok-4.6' ? 'Grok 4.6' : id === 'grok-4.5' ? 'Grok 4.5' : id),
        model_family: 'xai',
        context_window: extra.context_window ?? 500_000,
        hidden: extra.hidden ?? false,
        ...extra.infoExtra,
      },
      api_key: extra.api_key ?? null,
      env_key: extra.env_key ?? null,
      api_base_url: extra.api_base_url ?? null,
    };
  }

  it('readGrokModelsCache maps both cached models with 500k context and the Grok Build label', () => {
    writeCache({
      fetched_at: '2026-08-19T02:21:41Z',
      grok_version: '1.0.5',
      models: {
        'grok-4.6': sampleEntry('grok-4.6'),
        'grok-4.5': sampleEntry('grok-4.5'),
      },
    });
    const result = readGrokModelsCache(grokHome);
    expect(result.map((m) => m.name)).toEqual(['grok-4.6', 'grok-4.5']);
    const grok46 = result[0];
    expect(grok46.label).toBe('Grok Build · Grok 4.6');
    expect(grok46.provider).toBe('xai');
    expect(grok46.contextWindow).toBe(500_000);
    expect(grok46.vision).toBe(true);
    expect(grok46.steer).toBe(true);
  });

  it('readGrokModelsCache skips models flagged hidden', () => {
    writeCache({
      models: {
        'grok-4.6': sampleEntry('grok-4.6'),
        'grok-4.5': sampleEntry('grok-4.5', { hidden: true }),
      },
    });
    const result = readGrokModelsCache(grokHome);
    expect(result.map((m) => m.name)).toEqual(['grok-4.6']);
  });

  it('readGrokModelsCache falls back to the model id when info.name is absent', () => {
    writeCache({
      models: {
        'grok-4.6': {
          info: { id: 'grok-4.6', context_window: 500_000, hidden: false },
        },
      },
    });
    const result = readGrokModelsCache(grokHome);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Grok Build · grok-4.6');
  });

  it('readGrokModelsCache never surfaces credential fields', () => {
    writeCache({
      models: {
        'grok-4.6': {
          info: {
            id: 'grok-4.6',
            name: 'Grok 4.6',
            context_window: 500_000,
            hidden: false,
            api_key: 'sk-SECRET',
          },
          api_key: 'sk-SECRET',
          env_key: 'SECRET_ENV',
          api_base_url: 'https://SECRET.example',
        },
      },
    });
    const result = readGrokModelsCache(grokHome);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('readGrokModelsCache returns [] when the cache file is missing', () => {
    expect(readGrokModelsCache(grokHome)).toEqual([]);
  });

  it('readGrokModelsCache returns [] on malformed JSON', () => {
    writeCache('{not json');
    expect(readGrokModelsCache(grokHome)).toEqual([]);
  });

  it('readGrokModelsCache returns [] when models is an array instead of an object', () => {
    writeCache({ models: [{ info: { id: 'grok-4.6' } }] });
    expect(readGrokModelsCache(grokHome)).toEqual([]);
  });
});
