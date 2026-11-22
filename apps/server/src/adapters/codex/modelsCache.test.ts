/**
 * modelsCache.test.ts — readCodexModelsCache (temp dir only; never reads ~/.codex).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readCodexModelsCache } from './modelsCache.js';

describe('readCodexModelsCache', () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-cache-'));
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  function writeCache(body: unknown) {
    writeFileSync(join(codexHome, 'models_cache.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }

  it('maps cached models with context window, vision, and Codex label', () => {
    writeCache({
      fetched_at: '2026-10-14T10:00:00Z',
      client_version: '0.142.5',
      models: [
        {
          slug: 'gpt-5.6-terra',
          display_name: 'GPT-5.6-Terra',
          context_window: 272000,
          input_modalities: ['text', 'image'],
          visibility: 'list',
        },
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          context_window: 400000,
          input_modalities: ['text', 'image'],
          visibility: 'hide',
        },
      ],
    });

    const result = readCodexModelsCache(codexHome);
    expect(result.map((m) => m.name)).toEqual(['gpt-5.6-terra', 'gpt-5.5']);

    const terra = result[0];
    expect(terra.label).toBe('Codex · GPT-5.6-Terra');
    expect(terra.provider).toBe('openai');
    expect(terra.contextWindow).toBe(272000);
    expect(terra.vision).toBe(true);
    expect(terra.steer).toBe(true);
  });

  it('filters out codex-auto-review', () => {
    writeCache({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review' },
      ],
    });

    const result = readCodexModelsCache(codexHome);
    expect(result.map((m) => m.name)).toEqual(['gpt-5.5']);
  });

  it('falls back to slug when display_name is missing or empty', () => {
    writeCache({
      models: [
        { slug: 'custom-codex-model' },
      ],
    });

    const result = readCodexModelsCache(codexHome);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('custom-codex-model');
    expect(result[0].label).toBe('Codex · custom-codex-model');
    expect(result[0].vision).toBe(false);
  });

  it('returns [] when models_cache.json does not exist', () => {
    expect(readCodexModelsCache(codexHome)).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    writeCache('{invalid-json');
    expect(readCodexModelsCache(codexHome)).toEqual([]);
  });

  it('returns [] when models field is not an array', () => {
    writeCache({ models: 'not-an-array' });
    expect(readCodexModelsCache(codexHome)).toEqual([]);
  });

  it('skips invalid entries without a string slug', () => {
    writeCache({
      models: [
        null,
        123,
        { display_name: 'No slug' },
        { slug: '' },
        { slug: 'valid-slug', display_name: 'Valid' },
      ],
    });

    const result = readCodexModelsCache(codexHome);
    expect(result.map((m) => m.name)).toEqual(['valid-slug']);
  });
});
