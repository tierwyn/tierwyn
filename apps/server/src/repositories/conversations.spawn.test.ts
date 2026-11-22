import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import {
  createConversation, createScheduleHomeConversation, getConversation,
  childConversationIds, conversationDepth, spawnPolicyDepth, isPolicyRoot, setConversationSpawnWorkdir,
} from './conversations.js';
import type { Database } from 'better-sqlite3';

describe('conversation spawn fields', () => {
  let db: Database;
  let projectId: string;
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, migrations);
    projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  });

  it('persists parent/template/workdir and reads them back', () => {
    const parent = createConversation(db, { projectId, title: 'root', templateName: 'team' });
    const child = createConversation(db, {
      projectId, title: 'child', parentConversationId: parent.id, workdirPath: '/tmp/wt',
    });
    expect(getConversation(db, parent.id)!.templateName).toBe('team');
    const got = getConversation(db, child.id)!;
    expect(got.parentConversationId).toBe(parent.id);
    expect(got.workdirPath).toBe('/tmp/wt');
  });

  it('lists child conversation ids for a parent', () => {
    const parent = createConversation(db, { projectId, title: 'root' });
    const c1 = createConversation(db, { projectId, title: 'a', parentConversationId: parent.id });
    createConversation(db, { projectId, title: 'b' }); // unrelated root
    expect(childConversationIds(db, parent.id)).toEqual([c1.id]);
  });

  it('computes depth by walking the parent chain', () => {
    const root = createConversation(db, { projectId, title: 'root' });
    const child = createConversation(db, { projectId, title: 'c', parentConversationId: root.id });
    const grand = createConversation(db, { projectId, title: 'g', parentConversationId: child.id });
    expect(conversationDepth(db, root.id)).toBe(0);
    expect(conversationDepth(db, child.id)).toBe(1);
    expect(conversationDepth(db, grand.id)).toBe(2);
    expect(conversationDepth(db, 'missing')).toBe(0);
  });

  it('spawnPolicyDepth treats schedule ⏱ run under schedule_home as depth 0', () => {
    const home = createScheduleHomeConversation(db, { projectId, jobName: 'Job' });
    const run = createConversation(db, {
      projectId, title: '⏱ Job @ 2026-07-25T08:00', parentConversationId: home.id, templateName: 'Mixed',
    });
    const child = createConversation(db, {
      projectId, title: '↳ planner', parentConversationId: run.id,
    });
    const grand = createConversation(db, {
      projectId, title: '↳ implementer', parentConversationId: child.id,
    });
    // UI tree: home=0, run=1, child=2, grand=3
    expect(conversationDepth(db, home.id)).toBe(0);
    expect(conversationDepth(db, run.id)).toBe(1);
    expect(conversationDepth(db, child.id)).toBe(2);
    expect(conversationDepth(db, grand.id)).toBe(3);
    // Spawn policy: run is orchestrator root; home is only a shelf
    expect(spawnPolicyDepth(db, home.id)).toBe(0);
    expect(spawnPolicyDepth(db, run.id)).toBe(0);
    expect(spawnPolicyDepth(db, child.id)).toBe(1);
    expect(spawnPolicyDepth(db, grand.id)).toBe(2);

    // isPolicyRoot: home is false (inert header); run is true; descendants are false
    expect(isPolicyRoot(db, home.id)).toBe(false);
    expect(isPolicyRoot(db, run.id)).toBe(true);
    expect(isPolicyRoot(db, child.id)).toBe(false);
    expect(isPolicyRoot(db, grand.id)).toBe(false);
  });

  it('spawnPolicyDepth matches conversationDepth for non-schedule trees', () => {
    const root = createConversation(db, { projectId, title: 'root' });
    const child = createConversation(db, { projectId, title: 'c', parentConversationId: root.id });
    expect(spawnPolicyDepth(db, root.id)).toBe(0);
    expect(spawnPolicyDepth(db, child.id)).toBe(1);
    expect(isPolicyRoot(db, root.id)).toBe(true);
    expect(isPolicyRoot(db, child.id)).toBe(false);
  });
});

describe('setConversationSpawnWorkdir', () => {
  let db: Database;
  let projectId: string;
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, migrations);
    projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  });

  it('sets and reads back spawnWorkdir', () => {
    const conv = createConversation(db, { projectId, title: 'test' });
    const updated = setConversationSpawnWorkdir(db, conv.id, 'worktree');
    expect(updated?.spawnWorkdir).toBe('worktree');
    expect(getConversation(db, conv.id)!.spawnWorkdir).toBe('worktree');
  });

  it('clears spawnWorkdir with null', () => {
    const conv = createConversation(db, { projectId, title: 'test' });
    setConversationSpawnWorkdir(db, conv.id, 'worktree');
    const cleared = setConversationSpawnWorkdir(db, conv.id, null);
    expect(cleared?.spawnWorkdir).toBeUndefined();
    expect(getConversation(db, conv.id)!.spawnWorkdir).toBeUndefined();
  });

  it('returns undefined for a missing conversation id', () => {
    expect(setConversationSpawnWorkdir(db, 'no-such-id', 'worktree')).toBeUndefined();
  });
});
