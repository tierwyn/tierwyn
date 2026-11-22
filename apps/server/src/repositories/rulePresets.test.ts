import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, updateProject, getProject } from './projects.js';
import { createConversation, getConversation, setConversationRulePresetIds } from './conversations.js';
import {
  createRulePreset,
  deleteRulePreset,
  listRulePresets,
  nameConflict,
  normalisePresetIds,
} from './rulePresets.js';

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('rulePresets repository', () => {
  it('creates, lists, and 409s duplicate names in the same scope', () => {
    const db = fresh();
    const project = createProject(db, { name: 'P', rootPath: '/tmp/p' });
    const g = createRulePreset(db, { name: 'Tone', content: 'be terse' });
    expect(g.projectId).toBeNull();
    expect(nameConflict(db, 'Tone', null)).toBe(true);
    expect(nameConflict(db, 'Tone', project.id)).toBe(false);
    const scoped = createRulePreset(db, { name: 'Tone', content: 'project tone', projectId: project.id });
    expect(scoped.projectId).toBe(project.id);
    const listed = listRulePresets(db, project.id);
    expect(listed.map((p) => p.id).sort()).toEqual([g.id, scoped.id].sort());
  });

  it('scrubs stacks on delete and leaves remaining order intact', () => {
    const db = fresh();
    const project = createProject(db, { name: 'P', rootPath: '/tmp/p' });
    const a = createRulePreset(db, { name: 'A', content: 'a' });
    const b = createRulePreset(db, { name: 'B', content: 'b' });
    const c = createRulePreset(db, { name: 'C', content: 'c' });
    updateProject(db, project.id, { rulePresetIds: [a.id, b.id, c.id] });
    const conv = createConversation(db, { projectId: project.id, title: 'root' });
    const stacked = setConversationRulePresetIds(db, conv.id, [b.id, a.id])!;

    const result = deleteRulePreset(db, b.id);
    expect(result.ok).toBe(true);
    expect(result.scrubbed).toEqual({ projects: 1, conversations: 1 });
    expect(getProject(db, project.id)?.rulePresetIds).toEqual([a.id, c.id]);
    expect(getConversation(db, conv.id)?.rulePresetIds).toEqual([a.id]);
    expect(getConversation(db, conv.id)?.updatedAt).toBe(stacked.updatedAt);
  });

  it('normalisePresetIds rejects 9 ids, duplicates, and another project\'s preset', () => {
    const db = fresh();
    const p1 = createProject(db, { name: 'P1', rootPath: '/tmp/1' });
    const p2 = createProject(db, { name: 'P2', rootPath: '/tmp/2' });
    const ids = Array.from({ length: 9 }, (_, i) => createRulePreset(db, { name: `N${i}`, content: 'x' }).id);
    expect(normalisePresetIds(db, ids, p1.id).ok).toBe(false);
    expect(normalisePresetIds(db, [ids[0], ids[0]], p1.id).ok).toBe(false);
    const foreign = createRulePreset(db, { name: 'Other', content: 'o', projectId: p2.id });
    const bad = normalisePresetIds(db, [foreign.id], p1.id);
    expect(bad.ok).toBe(false);
    expect(normalisePresetIds(db, null, p1.id)).toEqual({ ok: true, value: null });
  });
});
