import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as childProcess from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    execFile: vi.fn(actual.execFile),
  };
});

import { ClaudeCodeAdapter } from './index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'model-catalog-cc.json');

describe('ClaudeCodeAdapter.listModels', () => {
  let claudeHome: string;
  let managedDir: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), 'cc-listmodels-'));
    managedDir = mkdtempSync(join(tmpdir(), 'cc-managed-'));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(managedDir, { recursive: true, force: true });
  });

  function adapter(): ClaudeCodeAdapter {
    return new ClaudeCodeAdapter({ claudeHome, managedSettingsDir: managedDir });
  }

  function writeFixture(): void {
    const dir = join(claudeHome, 'cache', 'model-catalog');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sample-cc.json'), readFileSync(FIXTURE, 'utf-8'));
  }

  it('returns catalogue rows and merges seed contextWindow by model name', async () => {
    writeFixture();
    const models = await adapter().listModels();
    const names = models.map((m) => m.name);
    expect(names).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]);
    expect(models.find((m) => m.name === 'claude-opus-4-8')?.contextWindow).toBe(1_000_000);
    expect(models.find((m) => m.name === 'claude-haiku-4-5')?.contextWindow).toBe(200_000);
    expect(models.find((m) => m.name === 'claude-opus-5-5')).not.toHaveProperty('contextWindow');
  });

  it('returns [] when the catalogue is absent', async () => {
    const models = await adapter().listModels();
    expect(models).toEqual([]);
  });

  it('resolves seed context windows when the catalogue is absent', async () => {
    const a = adapter();
    await a.start({ sessionId: 's', conversationId: 'c-seed-fb', cwd: '/tmp', model: 'claude-sonnet-4-6' });
    expect(await a.listModels()).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seeds = (a as any)._seedModels() as { name: string; contextWindow?: number }[];
    expect(seeds.find((m) => m.name === 'claude-sonnet-4-6')?.contextWindow).toBe(200_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (a as any)._resolveContextWindowSize('claude-sonnet-4-6');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((a as any)._contextWindowSize).toBe(200_000);
  });

  it('stores managedSettingsDir so a real /etc/claude-code cannot leak into tests', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter() as any)._managedSettingsDir).toBe(managedDir);
  });

  it('returns identical catalogue rows when user settings.json has only unrelated keys', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      env: { X: 'y' },
      effortLevel: 'high',
    }));
    const models = await adapter().listModels();
    expect(models.map((m) => m.name)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]);
  });

  it('filters the catalogue to opus-family rows when availableModels is ["opus"]', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ availableModels: ['opus'] }));
    const models = await adapter().listModels();
    expect(models.map((m) => m.name)).toEqual(['claude-opus-5-5', 'claude-opus-4-8']);
    expect(models.find((m) => m.name === 'claude-opus-4-8')?.contextWindow).toBe(1_000_000);
  });

  it('applies prefix, dated-id, and alias-narrowing availableModels entries', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ availableModels: ['claude-opus-5'] }));
    expect((await adapter().listModels()).map((m) => m.name)).toEqual(['claude-opus-5-5']);

    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ availableModels: ['claude-haiku-4-5-20251001'] }));
    expect((await adapter().listModels()).map((m) => m.name)).toEqual(['claude-haiku-4-5']);

    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ availableModels: ['opus', 'claude-opus-4-8'] }));
    expect((await adapter().listModels()).map((m) => m.name)).toEqual(['claude-opus-4-8']);
  });

  it('uses managed exact matching and ignores user-scoped availableModelsMatch', async () => {
    writeFixture();
    writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({
      availableModels: ['claude-opus-5-5'],
      availableModelsMatch: 'exact',
    }));
    expect((await adapter().listModels()).map((m) => m.name)).toEqual(['claude-opus-5-5']);

    rmSync(join(managedDir, 'managed-settings.json'));
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      availableModels: ['claude-opus-5'],
      availableModelsMatch: 'exact',
    }));
    expect((await adapter().listModels()).map((m) => m.name)).toEqual(['claude-opus-5-5']);
  });

  it('lets managed availableModels replace the user list and concatenates drop-ins', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ availableModels: ['opus'] }));
    writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({ availableModels: ['sonnet'] }));
    const dropDir = join(managedDir, 'managed-settings.d');
    mkdirSync(dropDir);
    writeFileSync(join(dropDir, '10-a.json'), JSON.stringify({ availableModels: ['haiku'] }));
    writeFileSync(join(dropDir, '.hidden.json'), JSON.stringify({ availableModels: ['fable'] }));
    writeFileSync(join(dropDir, 'x.txt'), JSON.stringify({ availableModels: ['opus'] }));
    expect((await adapter().listModels()).map((m) => m.name)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
  });

  // R9 — accepted no-prune; CLI enforces
  it('returns [] when the catalogue is present but the allowlist matches nothing', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ availableModels: [] }));
    expect(await adapter().listModels()).toEqual([]);
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ availableModels: ['claude-sonnet-4-5'] }));
    expect(await adapter().listModels()).toEqual([]);
  });

  it('appends modelPicker rows without relabelling catalogue names', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      modelPicker: {
        options: [
          { model: 'claude-opus-5-5', label: 'Ignored' },
          { model: 'sonnet', label: 'Sonnet (team)' },
          { model: 'claude-opus-4-1-20250805' },
        ],
      },
    }));
    const models = await adapter().listModels();
    expect(models.map((m) => m.name)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'sonnet',
      'claude-opus-4-1',
    ]);
    expect(models[0].label).toBe('Claude Code · Opus 5.5');
    const sonnet = models.find((m) => m.name === 'sonnet')!;
    expect(sonnet.label).toBe('Claude Code · Sonnet (team)');
    expect(sonnet.vision).toBe(false);
    expect(sonnet).not.toHaveProperty('contextWindow');
    const extra = models.find((m) => m.name === 'claude-opus-4-1')!;
    expect(extra.label).toBe('Claude Code · claude-opus-4-1-20250805');
    expect(extra).not.toHaveProperty('contextWindow');
  });

  it('replaces the catalogue when replaceBuiltInOptions is true', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      modelPicker: {
        options: [
          { model: 'claude-opus-4-8', label: 'Prod Opus' },
          { model: 'opus' },
        ],
        replaceBuiltInOptions: true,
      },
    }));
    const models = await adapter().listModels();
    expect(models.map((m) => m.name)).toEqual(['claude-opus-4-8', 'opus']);
    expect(models[0].label).toBe('Claude Code · Prod Opus');
    expect(models[0].vision).toBe(true);
    expect(models[0].contextWindow).toBe(1_000_000);
    expect(models[1].label).toBe('Claude Code · opus');
    expect(models[1]).not.toHaveProperty('contextWindow');
  });

  it('applies the allowlist to picker rows so dropped and duplicate names add nothing', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      availableModels: ['opus'],
      modelPicker: { options: [{ model: 'sonnet' }, { model: 'claude-opus-4-8' }] },
    }));
    expect((await adapter().listModels()).map((m) => m.name)).toEqual(['claude-opus-5-5', 'claude-opus-4-8']);
  });

  it('uses managed modelPicker in place of user modelPicker and ignores settings.local.json', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      modelPicker: { options: [{ model: 'sonnet', label: 'User Sonnet' }] },
    }));
    writeFileSync(join(claudeHome, 'settings.local.json'), JSON.stringify({
      availableModels: ['haiku'],
      modelPicker: { options: [{ model: 'haiku', label: 'Local Haiku' }] },
    }));
    writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({
      modelPicker: { options: [{ model: 'opus', label: 'Managed Opus' }], replaceBuiltInOptions: true },
    }));
    const models = await adapter().listModels();
    expect(models.map((m) => m.name)).toEqual(['opus']);
    expect(models[0].label).toBe('Claude Code · Managed Opus');
  });

  it('returns the catalogue when settings files are malformed or keys are the wrong type', async () => {
    writeFixture();
    writeFileSync(join(claudeHome, 'settings.json'), '{not json');
    writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({ availableModels: 'opus' }));
    const dropDir = join(managedDir, 'managed-settings.d');
    mkdirSync(dropDir);
    writeFileSync(join(dropDir, '10-a.json'), JSON.stringify({ modelPicker: { options: 'x' } }));
    const models = await adapter().listModels();
    expect(models.map((m) => m.name)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]);
  });

  it('returns [] when the catalogue is missing even if modelPicker replace is set', async () => {
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      modelPicker: { options: [{ model: 'opus' }], replaceBuiltInOptions: true },
    }));
    expect(await adapter().listModels()).toEqual([]);
  });

  it('ignores catalog.state and does not spawn a CLI during listModels', async () => {
    const dir = join(claudeHome, 'cache', 'model-catalog');
    mkdirSync(dir, { recursive: true });
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'sample-cc.json'), JSON.stringify({ ...fixture, catalog: { ...(fixture.catalog as object), state: { account: 'other' } } }));
    vi.mocked(childProcess.spawn).mockClear();
    vi.mocked(childProcess.execFile).mockClear();
    const models = await adapter().listModels();
    expect(models.map((m) => m.name)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});
