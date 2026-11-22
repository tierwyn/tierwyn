/**
 * modelCatalog.test.ts — readClaudeModelCatalog (temp dir only; never reads ~/.claude).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import type { ModelDescriptor } from '@tierwyn/shared';
import { readClaudeModelCatalog, applyModelSettings, readClaudeModelSettings } from './modelCatalog.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'model-catalog-cc.json');

describe('readClaudeModelCatalog', () => {
  let claudeHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), 'cc-cat-'));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  function catalogDir(): string {
    const dir = join(claudeHome, 'cache', 'model-catalog');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeCatalog(filename: string, body: unknown): string {
    const path = join(catalogDir(), filename);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  }

  function writeFixture(filename = 'sample-cc.json'): void {
    writeFileSync(join(catalogDir(), filename), readFileSync(FIXTURE, 'utf-8'));
  }

  it('maps fixture rows in file order, strips the Haiku date stamp, and follows mm_images for vision', () => {
    writeFixture();
    const result = readClaudeModelCatalog(claudeHome);
    expect(result.map((m) => m.name)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]);
    const opus = result[0];
    expect(opus.label).toBe('Claude Code · Opus 5.5');
    expect(opus.provider).toBe('anthropic');
    expect(opus.steer).toBe(true);
    expect(opus.vision).toBe(true);
    expect(opus).not.toHaveProperty('contextWindow');
    expect(result[2].vision).toBe(true);
    expect(result[4].vision).toBe(false);
    expect(result[4].label).toBe('Claude Code · Sonnet 5');
  });

  it('returns [] when the catalog directory is missing', () => {
    expect(readClaudeModelCatalog(claudeHome)).toEqual([]);
  });

  it('returns [] when the catalog directory is empty', () => {
    catalogDir();
    expect(readClaudeModelCatalog(claudeHome)).toEqual([]);
  });

  it('returns [] when only a non -cc.json file is present', () => {
    writeCatalog('other.json', { fetchedAt: 1, catalog: { config: { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }] } } });
    expect(readClaudeModelCatalog(claudeHome)).toEqual([]);
  });

  it('returns [] on bad JSON without throwing', () => {
    writeCatalog('bad-cc.json', '{not json');
    expect(readClaudeModelCatalog(claudeHome)).toEqual([]);
  });

  it('returns [] when catalog.config.models is not an array', () => {
    writeCatalog('no-array-cc.json', { fetchedAt: 1, catalog: { config: { models: { id: 'claude-opus-5-5' } } } });
    expect(readClaudeModelCatalog(claudeHome)).toEqual([]);
  });

  it('skips rows with no id, a non-string id, or a non-claude- id, and dedupes by stripped name', () => {
    writeCatalog('mixed-cc.json', {
      fetchedAt: 1,
      catalog: {
        config: {
          models: [
            { name: 'No Id' },
            { id: 12, name: 'Numeric' },
            { id: 'gpt-4o', name: 'GPT' },
            { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
            { id: 'claude-haiku-4-5', name: 'Haiku 4.5 again' },
            { id: 'claude-opus-5-5', name: 'Opus 5.5' },
          ],
        },
      },
    });
    const result = readClaudeModelCatalog(claudeHome);
    expect(result.map((m) => m.name)).toEqual(['claude-haiku-4-5', 'claude-opus-5-5']);
    expect(result[0].label).toBe('Claude Code · Haiku 4.5');
  });

  it('picks the -cc.json file with the larger fetchedAt when several exist', () => {
    writeCatalog('older-cc.json', {
      fetchedAt: 100,
      catalog: { config: { models: [{ id: 'claude-opus-4-8', name: 'Opus 4.8' }] } },
    });
    writeCatalog('newer-cc.json', {
      fetchedAt: 200,
      catalog: { config: { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }] } },
    });
    const result = readClaudeModelCatalog(claudeHome);
    expect(result.map((m) => m.name)).toEqual(['claude-opus-5-5']);
  });

  it('falls back to file mtime when fetchedAt is missing', () => {
    const older = writeCatalog('older-cc.json', {
      catalog: { config: { models: [{ id: 'claude-opus-4-8', name: 'Opus 4.8' }] } },
    });
    const newer = writeCatalog('newer-cc.json', {
      catalog: { config: { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }] } },
    });
    const olderTime = new Date('2020-01-01T00:00:00Z');
    const newerTime = new Date('2026-01-01T00:00:00Z');
    utimesSync(older, olderTime, olderTime);
    utimesSync(newer, newerTime, newerTime);
    const result = readClaudeModelCatalog(claudeHome);
    expect(result.map((m) => m.name)).toEqual(['claude-opus-5-5']);
  });

  it('ignores catalog.state when mapping rows', () => {
    writeCatalog('state-cc.json', {
      fetchedAt: 1,
      catalog: {
        state: { account: 'other' },
        config: { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }] },
      },
    });
    expect(readClaudeModelCatalog(claudeHome).map((m) => m.name)).toEqual(['claude-opus-5-5']);
  });
});

const CATALOG: ModelDescriptor[] = [
  { name: 'claude-opus-5-5', label: 'Claude Code · Opus 5.5', provider: 'anthropic', steer: true, vision: true },
  { name: 'claude-fable-5-1', label: 'Claude Code · Fable 5.1', provider: 'anthropic', steer: true, vision: true },
  { name: 'claude-haiku-4-5', label: 'Claude Code · Haiku 4.5', provider: 'anthropic', steer: true, vision: true },
  { name: 'claude-opus-4-8', label: 'Claude Code · Opus 4.8', provider: 'anthropic', steer: true, vision: true },
  { name: 'claude-sonnet-5', label: 'Claude Code · Sonnet 5', provider: 'anthropic', steer: true, vision: false },
];

describe('applyModelSettings', () => {
  it('keeps opus-family rows in original order for availableModels ["opus"]', () => {
    const rows = applyModelSettings(CATALOG, { availableModels: ['opus'], match: 'prefix' });
    expect(rows.map((m) => m.name)).toEqual(['claude-opus-5-5', 'claude-opus-4-8']);
  });

  it('matches a version prefix and a date-stripped full id, and narrows a family alias', () => {
    expect(
      applyModelSettings(CATALOG, { availableModels: ['claude-opus-5'], match: 'prefix' }).map((m) => m.name),
    ).toEqual(['claude-opus-5-5']);
    expect(
      applyModelSettings(CATALOG, { availableModels: ['claude-haiku-4-5-20251001'], match: 'prefix' }).map((m) => m.name),
    ).toEqual(['claude-haiku-4-5']);
    expect(
      applyModelSettings(CATALOG, { availableModels: ['opus', 'claude-opus-4-8'], match: 'prefix' }).map((m) => m.name),
    ).toEqual(['claude-opus-4-8']);
  });

  it('exact match keeps a full id and rejects a version prefix', () => {
    expect(
      applyModelSettings(CATALOG, { availableModels: ['claude-opus-5-5'], match: 'exact' }).map((m) => m.name),
    ).toEqual(['claude-opus-5-5']);
    expect(
      applyModelSettings(CATALOG, { availableModels: ['claude-opus-5'], match: 'exact' }).map((m) => m.name),
    ).toEqual([]);
  });

  // R9 — accepted no-prune; CLI enforces
  it('returns [] when the allowlist matches nothing', () => {
    expect(applyModelSettings(CATALOG, { availableModels: [], match: 'prefix' })).toEqual([]);
    expect(
      applyModelSettings(CATALOG, { availableModels: ['claude-sonnet-4-5'], match: 'prefix' }).map((m) => m.name),
    ).toEqual([]);
  });

  it('appends picker rows without relabelling an existing catalogue name', () => {
    const rows = applyModelSettings(CATALOG, {
      match: 'prefix',
      modelPicker: {
        options: [
          { model: 'claude-opus-5-5', label: 'Ignored' },
          { model: 'sonnet', label: 'Sonnet (team)' },
          { model: 'claude-opus-4-1-20250805' },
        ],
        replace: false,
      },
    });
    expect(rows.map((m) => m.name)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'sonnet',
      'claude-opus-4-1',
    ]);
    expect(rows[0].label).toBe('Claude Code · Opus 5.5');
    const sonnet = rows.find((m) => m.name === 'sonnet')!;
    expect(sonnet.label).toBe('Claude Code · Sonnet (team)');
    expect(sonnet.vision).toBe(false);
    expect(rows.find((m) => m.name === 'claude-opus-4-1')!.label).toBe('Claude Code · claude-opus-4-1-20250805');
  });

  it('replaces the catalogue when replaceBuiltInOptions is true', () => {
    const rows = applyModelSettings(CATALOG, {
      match: 'prefix',
      modelPicker: {
        options: [
          { model: 'claude-opus-4-8', label: 'Prod Opus' },
          { model: 'opus' },
        ],
        replace: true,
      },
    });
    expect(rows.map((m) => m.name)).toEqual(['claude-opus-4-8', 'opus']);
    expect(rows[0].label).toBe('Claude Code · Prod Opus');
    expect(rows[0].vision).toBe(true);
    expect(rows[1].label).toBe('Claude Code · opus');
    expect(rows[1].vision).toBe(false);
  });

  it('applies the allowlist to picker rows and dedupes names already in the catalogue', () => {
    const rows = applyModelSettings(CATALOG, {
      availableModels: ['opus'],
      match: 'prefix',
      modelPicker: {
        options: [{ model: 'sonnet' }, { model: 'claude-opus-4-8' }],
        replace: false,
      },
    });
    expect(rows.map((m) => m.name)).toEqual(['claude-opus-5-5', 'claude-opus-4-8']);
  });
});

describe('readClaudeModelSettings', () => {
  let claudeHome: string;
  let managedDir: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), 'cc-settings-'));
    managedDir = mkdtempSync(join(tmpdir(), 'cc-managed-'));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(managedDir, { recursive: true, force: true });
  });

  it('reads availableModelsMatch exact from managed settings only', () => {
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      availableModels: ['claude-opus-5'],
      availableModelsMatch: 'exact',
    }));
    const userOnly = readClaudeModelSettings(claudeHome, managedDir);
    expect(userOnly.match).toBe('prefix');
    expect(userOnly.availableModels).toEqual(['claude-opus-5']);

    writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({
      availableModels: ['claude-opus-5-5'],
      availableModelsMatch: 'exact',
    }));
    const managed = readClaudeModelSettings(claudeHome, managedDir);
    expect(managed.match).toBe('exact');
    expect(managed.availableModels).toEqual(['claude-opus-5-5']);
  });

  it('lets managed availableModels replace the user list and concatenates drop-ins, ignoring hidden and non-json', () => {
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ availableModels: ['opus'] }));
    writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({ availableModels: ['sonnet'] }));
    const dropDir = join(managedDir, 'managed-settings.d');
    mkdirSync(dropDir);
    writeFileSync(join(dropDir, '10-a.json'), JSON.stringify({ availableModels: ['haiku'] }));
    writeFileSync(join(dropDir, '.hidden.json'), JSON.stringify({ availableModels: ['fable'] }));
    writeFileSync(join(dropDir, 'x.txt'), JSON.stringify({ availableModels: ['opus'] }));
    const s = readClaudeModelSettings(claudeHome, managedDir);
    expect(s.availableModels).toEqual(['sonnet', 'haiku']);
  });

  it('lets managed modelPicker replace the user picker whole and ignores settings.local.json', () => {
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
    const s = readClaudeModelSettings(claudeHome, managedDir);
    expect(s.availableModels).toBeUndefined();
    expect(s.modelPicker).toEqual({
      options: [{ model: 'opus', label: 'Managed Opus' }],
      replace: true,
    });
  });

  it('treats bad JSON and wrong-typed keys as unset without throwing', () => {
    writeFileSync(join(claudeHome, 'settings.json'), '{not json');
    writeFileSync(join(managedDir, 'managed-settings.json'), '{also bad');
    const dropDir = join(managedDir, 'managed-settings.d');
    mkdirSync(dropDir);
    writeFileSync(join(dropDir, '10-a.json'), '{nope');
    expect(() => readClaudeModelSettings(claudeHome, managedDir)).not.toThrow();
    expect(readClaudeModelSettings(claudeHome, managedDir)).toEqual({ match: 'prefix' });

    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({
      availableModels: 'opus',
      modelPicker: { options: 'x' },
    }));
    writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({
      modelPicker: { options: [{ label: 'no model' }, { model: '' }, { model: 'kept' }] },
    }));
    const s = readClaudeModelSettings(claudeHome, managedDir);
    expect(s.availableModels).toBeUndefined();
    expect(s.modelPicker).toEqual({ options: [{ model: 'kept' }], replace: false });
  });
});
