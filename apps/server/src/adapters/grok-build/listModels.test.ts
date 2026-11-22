import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GrokBuildAdapter } from './index.js';

describe('GrokBuildAdapter.listModels', () => {
  let grokHome: string;

  beforeEach(() => {
    grokHome = mkdtempSync(join(tmpdir(), 'grok-listmodels-'));
  });

  afterEach(() => {
    rmSync(grokHome, { recursive: true, force: true });
  });

  function writeCache(models: Record<string, unknown>) {
    writeFileSync(join(grokHome, 'models_cache.json'), JSON.stringify({ models }));
  }

  it('listModels returns cache-derived models when models_cache.json exists', async () => {
    writeCache({
      'grok-4.6': {
        info: { id: 'grok-4.6', name: 'Grok 4.6', context_window: 500_000, hidden: false },
      },
      'grok-4.5': {
        info: { id: 'grok-4.5', name: 'Grok 4.5', context_window: 500_000, hidden: false },
      },
    });
    const adapter = new GrokBuildAdapter({ grokHome });
    const models = await adapter.listModels();
    const names = models.map((m) => m.name);
    expect(names).toContain('grok-4.6');
    expect(names).toContain('grok-4.5');
    const grok46 = models.find((m) => m.name === 'grok-4.6');
    expect(grok46?.label).toBe('Grok Build · Grok 4.6');
    expect(grok46?.provider).toBe('xai');
    expect(grok46?.contextWindow).toBe(500_000);
    expect(grok46?.vision).toBe(true);
    expect(grok46?.steer).toBe(true);
  });

  it('listModels falls back to the catalogue seed when the cache is absent', async () => {
    const adapter = new GrokBuildAdapter({ grokHome });
    const models = await adapter.listModels();
    const names = models.map((m) => m.name);
    expect(names).toContain('grok-4.5');
    expect(names).toContain('grok-4.6');
    const grok46 = models.find((m) => m.name === 'grok-4.6');
    expect(grok46?.contextWindow).toBe(500_000);
  });

  it('listModels prefers the cache over the seed', async () => {
    writeCache({
      'grok-test-only': {
        info: { id: 'grok-test-only', name: 'Test Only', context_window: 1000, hidden: false },
      },
    });
    const adapter = new GrokBuildAdapter({ grokHome });
    const models = await adapter.listModels();
    expect(models.map((m) => m.name)).toEqual(['grok-test-only']);
  });
});
