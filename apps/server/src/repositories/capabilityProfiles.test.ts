import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import {
  resolveConversationProfile,
  saveCapabilityProfile,
  deleteCapabilityProfile,
  listConversationIdsUsingProfile,
  listConversationIdsUsingDefaultProfile,
  getDefaultCapabilityProfileId,
  setDefaultCapabilityProfileId,
} from './capabilityProfiles.js';

beforeEach(() => {
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  setDb(db);
});

describe('resolveConversationProfile', () => {
  it('NULL / empty resolves to all', () => {
    expect(resolveConversationProfile(getDb(), null)).toEqual({ id: 'all', plugins: '*', usage: true });
    expect(resolveConversationProfile(getDb(), undefined)).toEqual({ id: 'all', plugins: '*', usage: true });
    expect(resolveConversationProfile(getDb(), '')).toEqual({ id: 'all', plugins: '*', usage: true });
  });

  it('unknown id fails closed to minimal and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveConversationProfile(getDb(), 'no-such-profile')).toEqual({
        id: 'minimal',
        plugins: [],
        usage: false,
        memory: false,
      });
      expect(warn).toHaveBeenCalledWith('[capability-profiles] unknown profile no-such-profile → minimal');
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves a stored custom profile', () => {
    saveCapabilityProfile(getDb(), { id: 'team', label: 'Team', plugins: ['gemini-image'], usage: true });
    expect(resolveConversationProfile(getDb(), 'team')).toEqual({
      id: 'team',
      plugins: ['gemini-image'],
      usage: true,
    });
  });
});

describe('listConversationIdsUsingProfile', () => {
  it('returns every conversation assigned the id', () => {
    const db = getDb();
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const a = createConversation(db, { projectId: project.id, title: 'a', capabilityProfile: 'media' });
    const b = createConversation(db, { projectId: project.id, title: 'b', capabilityProfile: 'media' });
    createConversation(db, { projectId: project.id, title: 'c', capabilityProfile: 'minimal' });
    expect(listConversationIdsUsingProfile(db, 'media').sort()).toEqual([a.id, b.id].sort());
    expect(listConversationIdsUsingProfile(db, 'minimal')).toHaveLength(1);
    expect(listConversationIdsUsingProfile(db, 'all')).toEqual([]);
  });

  it('listConversationIdsUsingDefaultProfile returns conversations where capability_profile is NULL', () => {
    const db = getDb();
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const def1 = createConversation(db, { projectId: project.id, title: 'def1' });
    const def2 = createConversation(db, { projectId: project.id, title: 'def2', capabilityProfile: null });
    createConversation(db, { projectId: project.id, title: 'explicit', capabilityProfile: 'media' });
    expect(listConversationIdsUsingDefaultProfile(db).sort()).toEqual([def1.id, def2.id].sort());
  });
});

describe('default capability profile', () => {
  it('defaults to all when unset', () => {
    expect(getDefaultCapabilityProfileId(getDb())).toBe('all');
  });

  it('can be set to a built-in or custom profile', () => {
    const db = getDb();
    expect(setDefaultCapabilityProfileId(db, 'all')).toBe(true);
    expect(getDefaultCapabilityProfileId(db)).toBe('all');

    // custom profile
    saveCapabilityProfile(db, { id: 'custom-safe', label: 'Custom Safe', plugins: [], usage: false });
    expect(setDefaultCapabilityProfileId(db, 'custom-safe')).toBe(true);
    expect(getDefaultCapabilityProfileId(db)).toBe('custom-safe');

    // non-existent profile rejected
    expect(setDefaultCapabilityProfileId(db, 'non-existent')).toBe(false);
    expect(getDefaultCapabilityProfileId(db)).toBe('custom-safe');
  });

  it('fails closed to minimal and warns when stored default profile does not exist', () => {
    const db = getDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_capability_profile', ?)").run('corrupted-or-deleted');
      expect(getDefaultCapabilityProfileId(db)).toBe('minimal');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("configured default profile 'corrupted-or-deleted' not found → minimal"));
    } finally {
      warn.mockRestore();
    }
  });

  it('resolveConversationProfile uses the configured default when capabilityProfile is null or empty', () => {
    const db = getDb();
    saveCapabilityProfile(db, { id: 'custom-safe', label: 'Custom Safe', plugins: ['gemini-image'], usage: false });
    setDefaultCapabilityProfileId(db, 'custom-safe');

    expect(resolveConversationProfile(db, null)).toEqual({
      id: 'custom-safe',
      plugins: ['gemini-image'],
      usage: false,
    });
    expect(resolveConversationProfile(db, '')).toEqual({
      id: 'custom-safe',
      plugins: ['gemini-image'],
      usage: false,
    });
    // Explicit 'all' still resolves to all
    expect(resolveConversationProfile(db, 'all')).toEqual({
      id: 'all',
      plugins: '*',
      usage: true,
    });
  });

  it('deleteCapabilityProfile refuses to delete the active default profile', () => {
    const db = getDb();
    saveCapabilityProfile(db, { id: 'temp-profile', label: 'Temp', plugins: [], usage: false });
    setDefaultCapabilityProfileId(db, 'temp-profile');

    expect(deleteCapabilityProfile(db, 'temp-profile')).toBe(false);
    expect(getDefaultCapabilityProfileId(db)).toBe('temp-profile');

    // After switching default away, it can be deleted
    setDefaultCapabilityProfileId(db, 'all');
    expect(deleteCapabilityProfile(db, 'temp-profile')).toBe(true);
  });
});
