/**
 * modelsCache.test.ts — readHermesModels (temp dir only; never reads ~/.hermes).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readHermesModels } from './modelsCache.js';

describe('readHermesModels', () => {
  let hermesHome: string;

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-cache-'));
  });

  afterEach(() => {
    rmSync(hermesHome, { recursive: true, force: true });
  });

  function writeModels(body: unknown) {
    writeFileSync(join(hermesHome, 'models.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }

  it('maps models.json entries to ModelDescriptors with provider prefix and vision detection', () => {
    writeModels([
      {
        id: '1',
        name: 'Claude Sonnet 4',
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-20250514',
      },
      {
        id: '2',
        name: 'glm-5.1',
        provider: 'zai',
        model: 'glm-5.1',
      },
      {
        id: '3',
        name: 'google-free',
        provider: 'custom',
        model: 'models/gemma-4-31b-it',
      },
    ]);

    const result = readHermesModels(hermesHome);
    expect(result).toHaveLength(3);

    expect(result[0].name).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result[0].label).toBe('Hermes · Claude Sonnet 4');
    expect(result[0].provider).toBe('openrouter');
    expect(result[0].vision).toBe(true);
    expect(result[0].steer).toBe(true);

    expect(result[1].name).toBe('zai/glm-5.1');
    expect(result[1].label).toBe('Hermes · glm-5.1');
    expect(result[1].provider).toBe('zai');
    expect(result[1].vision).toBe(false);
    expect(result[1].steer).toBe(true);

    expect(result[2].name).toBe('models/gemma-4-31b-it');
    expect(result[2].label).toBe('Hermes · google-free');
    expect(result[2].provider).toBe('custom');
    expect(result[2].vision).toBe(false);
  });

  it('deduplicates entries by model identifier', () => {
    writeModels([
      { name: 'First', provider: 'zai', model: 'glm-5.1' },
      { name: 'Second', provider: 'zai', model: 'glm-5.1' },
    ]);

    const result = readHermesModels(hermesHome);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('zai/glm-5.1');
    expect(result[0].label).toBe('Hermes · First');
  });

  it('falls back to model string when name is absent or empty', () => {
    writeModels([
      { provider: 'zai', model: 'glm-5.2' },
    ]);

    const result = readHermesModels(hermesHome);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('zai/glm-5.2');
    expect(result[0].label).toBe('Hermes · glm-5.2');
  });

  it('returns [] when models.json is missing', () => {
    expect(readHermesModels(hermesHome)).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    writeModels('not json');
    expect(readHermesModels(hermesHome)).toEqual([]);
  });

  it('returns [] when JSON is not an array', () => {
    writeModels({ not: 'an-array' });
    expect(readHermesModels(hermesHome)).toEqual([]);
  });

  it('skips invalid entries without a string model', () => {
    writeModels([
      null,
      123,
      { name: 'No model' },
      { model: '' },
      { model: 'valid-model' },
    ]);

    const result = readHermesModels(hermesHome);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid-model');
  });
});
