import { afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { ServerFrame } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';
import { createProject } from './projects.js';
import { createConversation, getConversation } from './conversations.js';
import { createSession, setNativeSessionId } from './sessions.js';
import { updateAgent, upsertDiscoveredModels } from './models.js';
import {
  findRemoteAgentConversation, createRemoteAgentConversation,
  listRemoteAgentConversations, retireRemoteAgentConversation,
  getRemoteAgentBotId, assertValidRemoteAgentProfile, assertGrokBotConversationWritable,
  assertGrokBotAllowedInProject, grokBotBarePrimingEnabled,
} from './remoteAgents.js';
import { reconcileRoster, resetReconcileState, type ReconcileDeps } from '../adapters/grok-bot/reconcile.js';
import { updateGeneralSettings } from './settings.js';
import { seedDefaultSettings } from '../db/seed.js';

const BOT_A = '8c236467-9550-4bb2-bb9d-80938bc7e5f6';
const BOT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  ensureRemoteAgentsProject(db);
  return db;
}

function pin(db: Db, botId: string): void {
  upsertDiscoveredModels(db, 'grok-bot', [{
    name: botId,
    label: `Grok Bot · ${botId}`,
    provider: 'xai',
    vision: false,
    steer: true,
  }]);
}

describe('findRemoteAgentConversation', () => {
  it('returns archived rows', () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    retireRemoteAgentConversation(db, id);
    expect(findRemoteAgentConversation(db, BOT_A)).toEqual({ id, archived: true });
  });

  it('is scoped to the container project', () => {
    const db = setup();
    pin(db, BOT_A);
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'Ad hoc' });
    createSession(db, { id: 's1', conversationId: c.id, agentId: 'grok-bot', agentModelId: `grok-bot:${BOT_A}` });
    setNativeSessionId(db, 's1', BOT_A);
    expect(findRemoteAgentConversation(db, BOT_A)).toBeUndefined();
  });

  it('does not treat a grok-bot:default turn as Bot B\'s container conversation', () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
      { name: BOT_B, label: 'Grok Bot · B', provider: 'xai', vision: false, steer: true },
    ]);
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    createSession(db, {
      id: 'turn-default',
      conversationId: id,
      agentId: 'grok-bot',
      agentModelId: 'grok-bot:default',
    });
    setNativeSessionId(db, 'turn-default', BOT_B);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(9_999_999_999_999, 'turn-default');

    expect(findRemoteAgentConversation(db, BOT_B)).toBeUndefined();
    expect(findRemoteAgentConversation(db, BOT_A)).toEqual({ id, archived: false });
    expect(listRemoteAgentConversations(db, { archived: false })).toEqual([
      { id, botId: BOT_A },
    ]);
  });
});

afterEach(() => {
  resetReconcileState();
});

describe('createRemoteAgentConversation', () => {
  it('creates a 1:1 conversation with a watcher session', () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const conv = getConversation(db, id);
    expect(conv?.projectId).toBe(REMOTE_AGENTS_PROJECT_ID);
    expect(conv?.title).toBe('Inbox');
    const session = db.prepare(
      `SELECT native_session_id, agent_model_id FROM sessions WHERE conversation_id = ?`,
    ).get(id) as { native_session_id: string; agent_model_id: string };
    expect(session.native_session_id).toBe(BOT_A);
    expect(session.agent_model_id).toBe(`grok-bot:${BOT_A}`);
  });

  it('rolls back the conversation if the session insert fails', () => {
    const db = setup();
    // No agent_models row → FK on sessions.agent_model_id fails inside the tx.
    expect(() => createRemoteAgentConversation(db, BOT_A, 'Orphan')).toThrow();
    const n = (db.prepare(
      'SELECT COUNT(*) AS n FROM conversations WHERE project_id = ?',
    ).get(REMOTE_AGENTS_PROJECT_ID) as { n: number }).n;
    expect(n).toBe(0);
  });
});

describe('listRemoteAgentConversations / retire', () => {
  it('lists active container conversations and retire is idempotent', () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
      { name: BOT_B, label: 'Grok Bot · B', provider: 'xai', vision: false, steer: true },
    ]);
    const a = createRemoteAgentConversation(db, BOT_A, 'A');
    createRemoteAgentConversation(db, BOT_B, 'B');
    expect(listRemoteAgentConversations(db, { archived: false })).toHaveLength(2);
    retireRemoteAgentConversation(db, a);
    retireRemoteAgentConversation(db, a);
    expect(getConversation(db, a)?.archived).toBe(true);
    const active = listRemoteAgentConversations(db, { archived: false });
    expect(active).toHaveLength(1);
    expect(active[0]?.botId).toBe(BOT_B);
    expect(listRemoteAgentConversations(db, { archived: true }).map((c) => c.id)).toEqual([a]);
  });

  it('reconciling [A, B] after a default-profile stamp still creates Bot B', () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
      { name: BOT_B, label: 'Grok Bot · B', provider: 'xai', vision: false, steer: true },
    ]);
    const idA = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    createSession(db, {
      id: 'turn-default',
      conversationId: idA,
      agentId: 'grok-bot',
      agentModelId: 'grok-bot:default',
    });
    setNativeSessionId(db, 'turn-default', BOT_B);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(9_999_999_999_999, 'turn-default');
    expect(findRemoteAgentConversation(db, BOT_B)).toBeUndefined();

    const frames: Array<{ id: string; frame: ServerFrame }> = [];
    const deps: ReconcileDeps = {
      db,
      autoCreateEnabled: () => true,
      onCatalogueChanged: () => undefined,
      isLive: () => false,
      broadcast: (id, frame) => { frames.push({ id, frame }); },
      cursors: {},
      now: () => 1_700_000_000_000,
    };
    reconcileRoster(deps, [
      { id: BOT_A, name: 'Alpha', newestEntryId: 't0' },
      { id: BOT_B, name: 'Bravo', newestEntryId: 't0' },
    ]);

    const foundB = findRemoteAgentConversation(db, BOT_B);
    expect(foundB).toBeDefined();
    expect(foundB?.id).not.toBe(idA);
    expect(foundB?.archived).toBe(false);
    expect(getConversation(db, foundB!.id)?.title).toBe('Bravo');
    const listed = listRemoteAgentConversations(db, { archived: false });
    expect(listed).toEqual(expect.arrayContaining([
      { id: idA, botId: BOT_A },
      { id: foundB!.id, botId: BOT_B },
    ]));
    expect(listed).toHaveLength(2);
  });
});

describe('assertValidRemoteAgentProfile and getRemoteAgentBotId', () => {
  it('allows any profile for conversations outside the Remote Agents container', () => {
    const db = setup();
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'Ad hoc' });
    expect(() => assertValidRemoteAgentProfile(db, c.id, other.id, 'claude-code:claude-opus-5')).not.toThrow();
    expect(() => assertValidRemoteAgentProfile(db, c.id, other.id, 'grok-bot:default')).not.toThrow();
  });

  it('rejects grok-bot:default for conversations in the Remote Agents container', () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    expect(() => assertValidRemoteAgentProfile(db, id, REMOTE_AGENTS_PROJECT_ID, 'grok-bot:default'))
      .toThrow('Active chat profile (grok-bot:default) cannot be used in Remote Agents container');
  });

  it('rejects non-grok profiles for conversations in the Remote Agents container', () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    expect(() => assertValidRemoteAgentProfile(db, id, REMOTE_AGENTS_PROJECT_ID, 'claude-code:claude-opus-5'))
      .toThrow('Model cannot be changed for Remote Agents conversations: must be grok-bot:<botId>');
  });

  it('rejects mismatching bot id for conversations in the Remote Agents container', () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
      { name: BOT_B, label: 'Grok Bot · B', provider: 'xai', vision: false, steer: true },
    ]);
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    expect(() => assertValidRemoteAgentProfile(db, id, REMOTE_AGENTS_PROJECT_ID, `grok-bot:${BOT_B}`))
      .toThrow(`Conversation is permanently bound to grok-bot:${BOT_A}`);
  });

  it('accepts the matching bot profile', () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    expect(getRemoteAgentBotId(db, id)).toBe(BOT_A);
    expect(() => assertValidRemoteAgentProfile(db, id, REMOTE_AGENTS_PROJECT_ID, `grok-bot:${BOT_A}`)).not.toThrow();
  });
});

describe('assertGrokBotConversationWritable', () => {
  it('blocks container and last-session grok chats while the agent is disabled', () => {
    const db = setup();
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    expect(() => assertGrokBotConversationWritable(db, id, REMOTE_AGENTS_PROJECT_ID, `grok-bot:${BOT_A}`, 'grok-bot'))
      .toThrow(/Grok Bot is disabled/);

    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const adhoc = createConversation(db, { projectId: other.id, title: 'Ad hoc grok' });
    createSession(db, { id: 's-adhoc', conversationId: adhoc.id, agentId: 'grok-bot', agentModelId: 'grok-bot:default' });
    expect(() => assertGrokBotConversationWritable(db, adhoc.id, other.id, 'grok-bot:default', 'grok-bot'))
      .toThrow(/Grok Bot is disabled/);
    expect(() => assertGrokBotConversationWritable(db, adhoc.id, other.id, 'claude-code:sonnet', 'claude-code'))
      .toThrow(/Grok Bot is disabled/);

    const plain = createConversation(db, { projectId: other.id, title: 'Claude' });
    expect(() => assertGrokBotConversationWritable(db, plain.id, other.id, 'claude-code:sonnet', 'claude-code'))
      .not.toThrow();
  });

  it('allows an explicit switch to an enabled non-grok profile on a former grok chat', () => {
    const db = setup();
    updateAgent(db, 'claude-code', { enabled: true });
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const adhoc = createConversation(db, { projectId: other.id, title: 'Ad hoc grok' });
    createSession(db, { id: 's-switch', conversationId: adhoc.id, agentId: 'grok-bot', agentModelId: 'grok-bot:default' });
    expect(() => assertGrokBotConversationWritable(db, adhoc.id, other.id, 'claude-code:sonnet', 'claude-code'))
      .not.toThrow();
  });

  it('allows grok chats once the agent is enabled', () => {
    const db = setup();
    pin(db, BOT_A);
    updateAgent(db, 'grok-bot', { enabled: true });
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    expect(() => assertGrokBotConversationWritable(db, id, REMOTE_AGENTS_PROJECT_ID, `grok-bot:${BOT_A}`, 'grok-bot'))
      .not.toThrow();
  });
});

describe('assertGrokBotAllowedInProject', () => {
  function setupWithSettings() {
    const db = setup();
    seedDefaultSettings(db);
    updateAgent(db, 'grok-bot', { enabled: true });
    return db;
  }

  it('rejects grok-bot in a normal project when grokBotInProjectChats is off', () => {
    const db = setupWithSettings();
    updateGeneralSettings(db, { grokBotInProjectChats: false });
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'Chat' });
    expect(() => assertGrokBotAllowedInProject(db, c.id, other.id, 'grok-bot:default', 'grok-bot'))
      .toThrow(/project chats is off/i);
  });

  it('allows grok-bot in a normal project when grokBotInProjectChats is on', () => {
    const db = setupWithSettings();
    updateGeneralSettings(db, { grokBotInProjectChats: true });
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'Chat' });
    expect(() => assertGrokBotAllowedInProject(db, c.id, other.id, 'grok-bot:default', 'grok-bot'))
      .not.toThrow();
  });

  it('always allows Remote Agents container conversations', () => {
    const db = setupWithSettings();
    updateGeneralSettings(db, { grokBotInProjectChats: false });
    pin(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    expect(() => assertGrokBotAllowedInProject(db, id, REMOTE_AGENTS_PROJECT_ID, `grok-bot:${BOT_A}`, 'grok-bot'))
      .not.toThrow();
  });

  it('ignores non-grok profiles', () => {
    const db = setupWithSettings();
    updateGeneralSettings(db, { grokBotInProjectChats: false });
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'Chat' });
    expect(() => assertGrokBotAllowedInProject(db, c.id, other.id, 'claude-code:sonnet', 'claude-code'))
      .not.toThrow();
  });
});

describe('grokBotBarePrimingEnabled', () => {
  it('is true when project chats are enabled', () => {
    const db = setup();
    seedDefaultSettings(db);
    updateGeneralSettings(db, { grokBotInProjectChats: true });
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'Chat' });
    expect(grokBotBarePrimingEnabled(db, c.id, other.id)).toBe(true);
  });

  it('is false for normal projects when project chats are off', () => {
    const db = setup();
    seedDefaultSettings(db);
    updateGeneralSettings(db, { grokBotInProjectChats: false });
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const c = createConversation(db, { projectId: other.id, title: 'Chat' });
    expect(grokBotBarePrimingEnabled(db, c.id, other.id)).toBe(false);
  });

  it('is true for Remote Agents even when project chats are off', () => {
    const db = setup();
    seedDefaultSettings(db);
    updateGeneralSettings(db, { grokBotInProjectChats: false });
    pin(db, BOT_A);
    updateAgent(db, 'grok-bot', { enabled: true });
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    expect(grokBotBarePrimingEnabled(db, id, REMOTE_AGENTS_PROJECT_ID)).toBe(true);
  });
});

