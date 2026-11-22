import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedDefaultSettings } from './db/seed.js';
import { updateCompactionSettings, updateGlobalTasksSettings } from './repositories/settings.js';
import { CONVERSATION_CAPABILITIES } from './spawn/tokens.js';
import { withSessionScope } from './sessionManager.js';
import { createProject } from './repositories/projects.js';
import { createConversation, createScheduleHomeConversation } from './repositories/conversations.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  return db;
}

describe('withSessionScope', () => {
  it('mints tasks for a root by default', () => {
    const db = setup();
    const scope = withSessionScope(db, CONVERSATION_CAPABILITIES, { parentConversationId: null });
    expect(scope.has('tasks')).toBe(true);
    expect(scope.has('schedule')).toBe(true);
    expect(scope.has('plugin')).toBe(true);
    expect(scope.has('mesh')).toBe(false);
  });

  it('does not mint tasks for a child under scope roots', () => {
    const db = setup();
    const scope = withSessionScope(db, CONVERSATION_CAPABILITIES, { parentConversationId: 'x' });
    expect(scope.has('tasks')).toBe(false);
  });

  it('mints tasks for a child under scope all', () => {
    const db = setup();
    updateGlobalTasksSettings(db, { scope: 'all' });
    const scope = withSessionScope(db, CONVERSATION_CAPABILITIES, { parentConversationId: 'x' });
    expect(scope.has('tasks')).toBe(true);
  });

  it('mints tasks for nobody when enabled is false', () => {
    const db = setup();
    updateGlobalTasksSettings(db, { enabled: false });
    expect(withSessionScope(db, CONVERSATION_CAPABILITIES, { parentConversationId: null }).has('tasks')).toBe(false);
    expect(withSessionScope(db, CONVERSATION_CAPABILITIES, { parentConversationId: 'x' }).has('tasks')).toBe(false);
  });

  it('still adds mesh when meshMessaging is on', () => {
    const db = setup();
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    const scope = withSessionScope(db, CONVERSATION_CAPABILITIES, { parentConversationId: null });
    expect(scope.has('mesh')).toBe(true);
    expect(scope.has('tasks')).toBe(true);
  });

  it('mints tasks for a schedule run (policy root) by default under scope roots, but not its spawned subagent', () => {
    const db = setup();
    const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    const home = createScheduleHomeConversation(db, { projectId: project.id, jobName: 'Nightly' });
    const run = createConversation(db, {
      projectId: project.id,
      title: '⏱ Nightly @ 08:00',
      parentConversationId: home.id,
    });
    const subagent = createConversation(db, {
      projectId: project.id,
      title: '↳ helper',
      parentConversationId: run.id,
    });

    // Schedule run itself is a policy root -> tasks minted by default under roots
    const runScope = withSessionScope(db, CONVERSATION_CAPABILITIES, run);
    expect(runScope.has('tasks')).toBe(true);

    // Subagent spawned by the schedule run -> child, tasks NOT minted under roots
    const subScope = withSessionScope(db, CONVERSATION_CAPABILITIES, subagent);
    expect(subScope.has('tasks')).toBe(false);

    // Under scope: all, subagent gets tasks
    updateGlobalTasksSettings(db, { scope: 'all' });
    const subScopeAll = withSessionScope(db, CONVERSATION_CAPABILITIES, subagent);
    expect(subScopeAll.has('tasks')).toBe(true);
  });
});
