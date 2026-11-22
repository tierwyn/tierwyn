import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';
import { createProject } from './projects.js';
import { createConversation, setConversationArchived } from './conversations.js';
import { createSession, setNativeSessionId } from './sessions.js';
import { appendEvent } from './events.js';
import { upsertDiscoveredModels } from './models.js';
import {
  listWatchedBots, ensureWatcherSession, readCursors, writeCursors,
} from './grokBotWatch.js';
import { createRemoteAgentConversation } from './remoteAgents.js';

const BOT_A = '8c236467-9550-4bb2-bb9d-80938bc7e5f6';
const BOT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  return { db, projectId: p.id };
}

function pinBot(db: Db, botId: string): string {
  const id = `grok-bot:${botId}`;
  upsertDiscoveredModels(db, 'grok-bot', [{
    name: botId,
    label: `Grok Bot · ${botId}`,
    provider: 'xai',
    vision: false,
    steer: true,
  }]);
  return id;
}

function bind(db: Db, opts: {
  projectId: string;
  title: string;
  botId: string;
  agentModelId: string;
  createdAt?: number;
}): { conversationId: string; sessionId: string } {
  const c = createConversation(db, { projectId: opts.projectId, title: opts.title });
  const sessionId = `s-${c.id.slice(0, 8)}-${Math.random().toString(16).slice(2)}`;
  createSession(db, {
    id: sessionId,
    conversationId: c.id,
    agentId: 'grok-bot',
    agentModelId: opts.agentModelId,
  });
  setNativeSessionId(db, sessionId, opts.botId);
  if (opts.createdAt != null) {
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(opts.createdAt, sessionId);
  }
  return { conversationId: c.id, sessionId };
}

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const OPTS = { now: NOW, leaseMs: HOUR };

function prompt(db: Db, sessionId: string, ts: number, sender: 'user' | 'system' = 'user') {
  appendEvent(db, {
    sessionId,
    type: sender === 'system' ? 'message' : 'prompt',
    payload: sender === 'system' ? { chunk: 'marker' } : { text: 'q' },
    sender, seq: 0, ts,
  });
}

describe('listWatchedBots', () => {
  it('returns a conversation that prompted a pinned Bot', () => {
    const { db, projectId } = setup();
    const modelId = pinBot(db, BOT_A);
    const { conversationId, sessionId } = bind(db, {
      projectId, title: 'Pinned', botId: BOT_A, agentModelId: modelId,
    });
    prompt(db, sessionId, NOW - 1000);
    expect(listWatchedBots(db, OPTS)).toEqual([
      { conversationId, botId: BOT_A, agentModelId: modelId },
    ]);
  });

  it('does not watch a conversation that never prompted the Bot', () => {
    const { db, projectId } = setup();
    const modelId = pinBot(db, BOT_A);
    bind(db, { projectId, title: 'Silent', botId: BOT_A, agentModelId: modelId });
    expect(listWatchedBots(db, OPTS)).toEqual([]);
  });

  it('excludes grok-bot:default even when native_session_id is a Bot UUID', () => {
    const { db, projectId } = setup();
    bind(db, {
      projectId, title: 'Default', botId: BOT_A, agentModelId: 'grok-bot:default',
    });
    expect(listWatchedBots(db, OPTS)).toEqual([]);
  });

  it('excludes archived conversations', () => {
    const { db, projectId } = setup();
    const modelId = pinBot(db, BOT_A);
    const { conversationId, sessionId } = bind(db, {
      projectId, title: 'Archived', botId: BOT_A, agentModelId: modelId,
    });
    prompt(db, sessionId, NOW);
    setConversationArchived(db, conversationId, true);
    expect(listWatchedBots(db, OPTS)).toEqual([]);
  });

  it('a conversation that prompted two Bots owns both while leased', () => {
    const { db, projectId } = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
      { name: BOT_B, label: 'Grok Bot · B', provider: 'xai', vision: false, steer: true },
    ]);
    const c = createConversation(db, { projectId, title: 'Rebound' });
    createSession(db, { id: 'old', conversationId: c.id, agentId: 'grok-bot', agentModelId: `grok-bot:${BOT_A}` });
    setNativeSessionId(db, 'old', BOT_A);
    createSession(db, { id: 'new', conversationId: c.id, agentId: 'grok-bot', agentModelId: `grok-bot:${BOT_B}` });
    setNativeSessionId(db, 'new', BOT_B);
    prompt(db, 'old', NOW - 2000);
    prompt(db, 'new', NOW - 1000);
    const got = listWatchedBots(db, OPTS).sort((a, b) => a.botId.localeCompare(b.botId));
    expect(got).toEqual([
      { conversationId: c.id, botId: BOT_A, agentModelId: `grok-bot:${BOT_A}` },
      { conversationId: c.id, botId: BOT_B, agentModelId: `grok-bot:${BOT_B}` },
    ].sort((a, b) => a.botId.localeCompare(b.botId)));
  });

  it('two asked conversations: the newest activity wins', () => {
    const { db, projectId } = setup();
    const modelId = pinBot(db, BOT_A);
    const older = bind(db, { projectId, title: 'Older', botId: BOT_A, agentModelId: modelId });
    const newer = bind(db, { projectId, title: 'Newer', botId: BOT_A, agentModelId: modelId });
    prompt(db, older.sessionId, NOW - 5000);
    prompt(db, newer.sessionId, NOW - 1000);
    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([newer.conversationId]);
  });

  it('a leased project chat beats the container (late replies land where asked)', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const asked = bind(db, { projectId, title: 'Asked', botId: BOT_A, agentModelId: modelId });
    prompt(db, asked.sessionId, NOW - 60_000);
    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([asked.conversationId]);
  });

  it('a new grok-bot session in the current owner (resume schedule tick) keeps the same owner — no handover', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const asked = bind(db, { projectId, title: 'Owner', botId: BOT_A, agentModelId: modelId });
    prompt(db, asked.sessionId, NOW - 60_000);
    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([asked.conversationId]);

    // Resume tick creates another session on the same conversation (same Bot pin).
    const tickSessionId = `tick-${asked.conversationId.slice(0, 8)}`;
    createSession(db, {
      id: tickSessionId,
      conversationId: asked.conversationId,
      agentId: 'grok-bot',
      agentModelId: modelId,
    });
    setNativeSessionId(db, tickSessionId, BOT_A);
    prompt(db, tickSessionId, NOW - 1_000);

    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([asked.conversationId]);
  });

  it('a grok-bot:default chat that prompted the Bot owns it while leased', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    pinBot(db, BOT_A);
    createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const asked = bind(db, { projectId, title: 'Default', botId: BOT_A, agentModelId: 'grok-bot:default' });
    prompt(db, asked.sessionId, NOW - 60_000);
    expect(listWatchedBots(db, OPTS)).toEqual([
      { conversationId: asked.conversationId, botId: BOT_A, agentModelId: 'grok-bot:default' },
    ]);
  });

  it('a spawn child that prompted the Bot owns it while leased', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const parent = createConversation(db, { projectId, title: 'Parent' });
    const child = createConversation(db, { projectId, title: '↳ child', parentConversationId: parent.id });
    createSession(db, { id: 'child-turn', conversationId: child.id, agentId: 'grok-bot', agentModelId: modelId });
    setNativeSessionId(db, 'child-turn', BOT_A);
    prompt(db, 'child-turn', NOW - 60_000);
    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([child.id]);
  });

  it('an expired lease falls back to the container', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    const containerId = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const asked = bind(db, { projectId, title: 'Asked', botId: BOT_A, agentModelId: modelId });
    prompt(db, asked.sessionId, NOW - HOUR - 1);
    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([containerId]);
  });

  it('system events do not renew a lease', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    const containerId = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const asked = bind(db, { projectId, title: 'Asked', botId: BOT_A, agentModelId: modelId });
    prompt(db, asked.sessionId, NOW - HOUR - 1);
    prompt(db, asked.sessionId, NOW - 10, 'system'); // handover card
    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([containerId]);
  });

  it('an agent reply slides the lease', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const asked = bind(db, { projectId, title: 'Asked', botId: BOT_A, agentModelId: modelId });
    prompt(db, asked.sessionId, NOW - 2 * HOUR);
    appendEvent(db, { sessionId: asked.sessionId, type: 'message', payload: { chunk: 'late' }, sender: 'agent', seq: 1, ts: NOW - 60_000 });
    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([asked.conversationId]);
  });

  it('no container: an expired asked conversation still owns the Bot', () => {
    const { db, projectId } = setup();
    const modelId = pinBot(db, BOT_A);
    const asked = bind(db, { projectId, title: 'Asked', botId: BOT_A, agentModelId: modelId });
    prompt(db, asked.sessionId, NOW - 5 * HOUR);
    expect(listWatchedBots(db, OPTS).map((w) => w.conversationId)).toEqual([asked.conversationId]);
  });

  it('leaseMs 0 routes to the container', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    const containerId = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const asked = bind(db, { projectId, title: 'Asked', botId: BOT_A, agentModelId: modelId });
    prompt(db, asked.sessionId, NOW);
    expect(listWatchedBots(db, { now: NOW, leaseMs: 0 }).map((w) => w.conversationId)).toEqual([containerId]);
  });

  it('skips a non-UUID native_session_id', () => {
    const { db, projectId } = setup();
    bind(db, {
      projectId, title: 'Junk', botId: 'not-a-uuid', agentModelId: 'grok-bot:default',
    });
    expect(listWatchedBots(db, OPTS)).toEqual([]);
  });

  it('excludes a non-default profile whose model_name is not the native session id', () => {
    const { db, projectId } = setup();
    // Catalogue CRUD can mint grok-bot:my-default with model_name `default`.
    // Unique (agent_id, model_name) is already taken by the seed row, so rename
    // that row's id and keep model_name — the pin invariant is on the model.
    db.prepare(`UPDATE agent_models SET id = 'grok-bot:my-default' WHERE id = 'grok-bot:default'`).run();
    bind(db, {
      projectId, title: 'Ambient', botId: BOT_A, agentModelId: 'grok-bot:my-default',
    });
    expect(listWatchedBots(db, OPTS)).toEqual([]);
  });

  it('watches a container conversation even when the model row is missing', () => {
    const { db } = setup();
    ensureRemoteAgentsProject(db);
    pinBot(db, BOT_A);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    db.prepare(`UPDATE sessions SET agent_model_id = NULL WHERE conversation_id = ?`).run(id);
    const watched = listWatchedBots(db, OPTS);
    expect(watched).toEqual([
      { conversationId: id, botId: BOT_A, agentModelId: null },
    ]);
  });

  it('does not rebind a container conversation to a grok-bot:default stamp of another Bot', () => {
    const { db } = setup();
    ensureRemoteAgentsProject(db);
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
    expect(listWatchedBots(db, OPTS)).toEqual([
      { conversationId: id, botId: BOT_A, agentModelId: `grok-bot:${BOT_A}` },
    ]);
  });

  it('does not let a pinned spawn child that never prompted displace the Remote Agents container binding', () => {
    const { db } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    const containerId = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    db.prepare('UPDATE sessions SET created_at = ? WHERE conversation_id = ?').run(1, containerId);
    // Same system project as the container: without excluding spawn children,
    // newest-wins would steal the inbound-watch binding.
    const parent = createConversation(db, { projectId: REMOTE_AGENTS_PROJECT_ID, title: 'Parent' });
    const child = createConversation(db, {
      projectId: REMOTE_AGENTS_PROJECT_ID, title: 'Spawn child', parentConversationId: parent.id,
    });
    createSession(db, {
      id: 'child-turn', conversationId: child.id, agentId: 'grok-bot', agentModelId: modelId,
    });
    setNativeSessionId(db, 'child-turn', BOT_A);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(99, 'child-turn');
    const watched = listWatchedBots(db, OPTS);
    expect(watched).toHaveLength(1);
    expect(watched[0]?.conversationId).toBe(containerId);
    expect(watched[0]?.conversationId).not.toBe(child.id);
  });

  it('prefers the container conversation over an ad-hoc one that never prompted for the same Bot', () => {
    const { db, projectId } = setup();
    ensureRemoteAgentsProject(db);
    const modelId = pinBot(db, BOT_A);
    const adHoc = bind(db, {
      projectId, title: 'Ad hoc', botId: BOT_A, agentModelId: modelId, createdAt: 99,
    });
    const containerId = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    db.prepare('UPDATE sessions SET created_at = ? WHERE conversation_id = ?').run(1, containerId);
    const watched = listWatchedBots(db, OPTS);
    expect(watched).toHaveLength(1);
    expect(watched[0]?.conversationId).toBe(containerId);
    expect(watched[0]?.conversationId).not.toBe(adHoc.conversationId);
  });
});

describe('ensureWatcherSession', () => {
  it('creates a session and reuses it on a second call', () => {
    const { db, projectId } = setup();
    const modelId = pinBot(db, BOT_A);
    const c = createConversation(db, { projectId, title: 'W' });
    const first = ensureWatcherSession(db, c.id, BOT_A, modelId);
    const second = ensureWatcherSession(db, c.id, BOT_A, modelId);
    expect(second).toBe(first);
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE conversation_id = ? AND agent_id = 'grok-bot'`,
    ).get(c.id) as { n: number };
    expect(n.n).toBe(1);
  });

  it('does not reuse a turn session that already has a prompt event', () => {
    const { db, projectId } = setup();
    const modelId = pinBot(db, BOT_A);
    const { conversationId, sessionId } = bind(db, {
      projectId, title: 'Turn', botId: BOT_A, agentModelId: modelId,
    });
    appendEvent(db, { sessionId, type: 'prompt', payload: { text: 'hi' }, sender: 'user', seq: 0, ts: 1 });
    const watcherId = ensureWatcherSession(db, conversationId, BOT_A, modelId);
    expect(watcherId).not.toBe(sessionId);
    const again = ensureWatcherSession(db, conversationId, BOT_A, modelId);
    expect(again).toBe(watcherId);
  });
});

describe('cursors', () => {
  it('round-trips a cursor map', () => {
    const { db } = setup();
    expect(readCursors(db)).toEqual({});
    writeCursors(db, { [BOT_A]: { entryId: 't7s0', seq: 12, updatedAt: 1788 } });
    expect(readCursors(db)).toEqual({
      [BOT_A]: { entryId: 't7s0', seq: 12, updatedAt: 1788 },
    });
  });

  it('round-trips an optional name and still parses a cursor without one', () => {
    const { db } = setup();
    writeCursors(db, { [BOT_A]: { entryId: 't7s0', seq: 1, updatedAt: 9, name: 'Inbox' } });
    expect(readCursors(db)[BOT_A]).toEqual({
      entryId: 't7s0', seq: 1, updatedAt: 9, name: 'Inbox',
    });
    writeCursors(db, { [BOT_B]: { entryId: 'x', seq: 0, updatedAt: 1 } });
    expect(readCursors(db)[BOT_B]).toEqual({ entryId: 'x', seq: 0, updatedAt: 1 });
    expect(readCursors(db)[BOT_B]?.name).toBeUndefined();
  });

  it('round-trips an optional backfill and still parses a cursor without one', () => {
    const { db } = setup();
    writeCursors(db, { [BOT_A]: { entryId: '', seq: 0, updatedAt: 9, backfill: 200 } });
    expect(readCursors(db)[BOT_A]).toEqual({
      entryId: '', seq: 0, updatedAt: 9, backfill: 200,
    });
    writeCursors(db, { [BOT_B]: { entryId: 'x', seq: 0, updatedAt: 1 } });
    expect(readCursors(db)[BOT_B]?.backfill).toBeUndefined();
  });

  it('merges in a newly armed backfill when a stale tick map is written afterward', () => {
    const { db } = setup();
    writeCursors(db, { [BOT_A]: { entryId: 'old', seq: 3, updatedAt: 1 } });
    const staleTickMap = readCursors(db);
    writeCursors(db, {
      ...readCursors(db),
      [BOT_B]: { entryId: '', seq: 0, updatedAt: 2, backfill: 200, name: 'New' },
    });
    expect(readCursors(db)[BOT_B]?.backfill).toBe(200);
    writeCursors(db, staleTickMap);
    expect(readCursors(db)[BOT_B]?.backfill).toBe(200);
    expect(readCursors(db)[BOT_B]?.name).toBe('New');
    expect(readCursors(db)[BOT_A]?.entryId).toBe('old');
  });

  it('returns {} for missing or malformed JSON', () => {
    const { db } = setup();
    expect(readCursors(db)).toEqual({});
    db.prepare("INSERT INTO settings (key, value) VALUES ('grokbot.watch.cursors', ?)").run('not-json');
    expect(readCursors(db)).toEqual({});
    db.prepare("UPDATE settings SET value = ? WHERE key = 'grokbot.watch.cursors'").run('[]');
    expect(readCursors(db)).toEqual({});
  });
});
