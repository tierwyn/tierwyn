import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue, enableAllAgents } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import {
  listTemplates, saveTemplate, deleteTemplate, getTemplate, invalidTemplateProfile, invalidTemplateEffort,
  listRoleWhenPresets, saveRoleWhenPreset, deleteRoleWhenPreset,
  listCustomDesignations, addCustomDesignation, deleteCustomDesignation, listDesignationCatalogue,
} from './settings.js';
import type { Database } from 'better-sqlite3';

describe('spawn templates', () => {
  let db: Database;
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db); enableAllAgents(db);
    catalogue.load(db);
  });

  it('starts empty, saves, replaces by name, deletes', () => {
    expect(listTemplates(db)).toEqual([]);
    saveTemplate(db, { name: 'team', roles: [{ role: 'reviewer', profileId: 'claude-code:opus', when: 'review' }] });
    expect(getTemplate(db, 'team')!.roles).toHaveLength(1);
    saveTemplate(db, { name: 'team', roles: [] }); // replace by name
    expect(getTemplate(db, 'team')!.roles).toEqual([]);
    deleteTemplate(db, 'team');
    expect(listTemplates(db)).toEqual([]);
  });

  it('flags a role pointing at an unknown profile', () => {
    expect(invalidTemplateProfile({ name: 't', roles: [{ role: 'x', profileId: 'nope', when: '' }] })).toBe('nope');
  });

  it('passes when every profileId is known + enabled', () => {
    const good = catalogue.listProfiles().find((p) => p.enabled)!.id;
    expect(invalidTemplateProfile({ name: 't', roles: [{ role: 'x', profileId: good, when: '' }] })).toBeUndefined();
  });

  it('flags a role with an unknown effort token', () => {
    expect(invalidTemplateEffort({
      name: 't',
      roles: [{ role: 'x', profileId: 'claude-code:opus', when: '', effort: 'turbo' as never }],
    })).toBe('turbo');
  });

  it('passes when effort is omitted or a known level', () => {
    expect(invalidTemplateEffort({
      name: 't',
      roles: [{ role: 'x', profileId: 'claude-code:opus', when: '' }],
    })).toBeUndefined();
    expect(invalidTemplateEffort({
      name: 't',
      roles: [{ role: 'x', profileId: 'claude-code:opus', when: '', effort: 'high' }],
    })).toBeUndefined();
  });
});

describe('role when presets', () => {
  let db: Database;
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });

  it('starts empty, saves, upserts by id, deletes', () => {
    expect(listRoleWhenPresets(db)).toEqual([]);
    saveRoleWhenPreset(db, { id: 'a', name: 'Implementer', when: 'implement features' });
    saveRoleWhenPreset(db, { id: 'b', name: 'Reviewer', when: 'review PRs' });
    expect(listRoleWhenPresets(db)).toHaveLength(2);

    saveRoleWhenPreset(db, { id: 'a', name: 'Implementer', when: 'ship code' });
    const list = listRoleWhenPresets(db);
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.id === 'a')!.when).toBe('ship code');
    expect(list.find((p) => p.id === 'b')!.name).toBe('Reviewer');

    deleteRoleWhenPreset(db, 'a');
    expect(listRoleWhenPresets(db).map((p) => p.id)).toEqual(['b']);
    deleteRoleWhenPreset(db, 'b');
    expect(listRoleWhenPresets(db)).toEqual([]);
  });

  it('returns empty array for malformed JSON blob', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('role_when_presets', ?)").run('not-json');
    expect(listRoleWhenPresets(db)).toEqual([]);
  });
});

describe('conversation designations', () => {
  let db: Database;
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });

  it('starts with builtins only', () => {
    expect(listCustomDesignations(db)).toEqual([]);
    expect(listDesignationCatalogue(db)).toEqual([
      'orchestrator', 'planner', 'implementer', 'reviewer', 'research',
    ]);
  });

  it('adds a custom, rejects a builtin, deletes only customs', () => {
    const added = addCustomDesignation(db, 'Auditor');
    expect(added).toEqual({ ok: true, custom: ['auditor'] });
    expect(listDesignationCatalogue(db)).toContain('auditor');
    expect(addCustomDesignation(db, 'planner').ok).toBe(false);
    expect(deleteCustomDesignation(db, 'planner').ok).toBe(false);
    expect(deleteCustomDesignation(db, 'auditor')).toEqual({ ok: true, custom: [] });
  });

  it('returns empty customs for malformed JSON', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('conversation_designations', ?)").run('not-json');
    expect(listCustomDesignations(db)).toEqual([]);
  });
});
