import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { ServerFrame } from '@tierwyn/shared';
import { runMigrations } from '../../db/migrate.js';
import { migrations } from '../../db/migrations/index.js';
import { seedCatalogue, ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from '../../db/seed.js';
import { getConversation, renameConversation } from '../../repositories/conversations.js';
import { listEventsForConversation } from '../../repositories/events.js';
import { upsertDiscoveredModels } from '../../repositories/models.js';
import { type Cursor } from '../../repositories/grokBotWatch.js';
import {
  findRemoteAgentConversation, createRemoteAgentConversation,
  listRemoteAgentConversations,
} from '../../repositories/remoteAgents.js';
import type { RosterRow } from './bridge.js';
import { reconcileRoster, resetReconcileState, type ReconcileDeps } from './reconcile.js';

const BOT_A = '8c236467-9550-4bb2-bb9d-80938bc7e5f6';
const BOT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GROUP = 'not-a-uuid';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  ensureRemoteAgentsProject(db);
  return db;
}

function bot(id: string, name: string, newestEntryId = 't0'): RosterRow {
  return { id, name, newestEntryId };
}

function harness(db: Db, opts?: {
  autoCreate?: boolean;
  live?: Set<string>;
  backfill?: number;
}) {
  const frames: Array<{ id: string; frame: ServerFrame }> = [];
  const catalogueCalls: number[] = [];
  const cursors: Record<string, Cursor> = {};
  const deps: ReconcileDeps = {
    db,
    autoCreateEnabled: () => opts?.autoCreate !== false,
    onCatalogueChanged: () => { catalogueCalls.push(1); },
    isLive: (id) => opts?.live?.has(id) ?? false,
    broadcast: (id, frame) => { frames.push({ id, frame }); },
    cursors,
    now: () => 1_700_000_000_000,
    backfillEntries: () => opts?.backfill ?? 200,
  };
  return { deps, frames, catalogueCalls, cursors };
}

function containerSessions(db: Db) {
  return db.prepare(
    `SELECT c.id, c.title, c.archived, s.native_session_id AS botId, s.agent_model_id AS modelId
       FROM conversations c
       JOIN sessions s ON s.conversation_id = c.id
      WHERE c.project_id = ?`,
  ).all(REMOTE_AGENTS_PROJECT_ID) as Array<{
    id: string; title: string; archived: number | null; botId: string; modelId: string;
  }>;
}

afterEach(() => {
  resetReconcileState();
});

beforeEach(() => {
  resetReconcileState();
});

describe('reconcileRoster', () => {
  it('1. creates a conversation for a new Bot', () => {
    const db = setup();
    const { deps } = harness(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    const rows = containerSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Inbox');
    expect(rows[0]?.botId).toBe(BOT_A);
    expect(rows[0]?.modelId).toBe(`grok-bot:${BOT_A}`);
    expect(getConversation(db, rows[0]!.id)?.projectId).toBe(REMOTE_AGENTS_PROJECT_ID);
  });

  it('2. second reconcile of the same roster creates nothing', () => {
    const db = setup();
    const { deps } = harness(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    const first = containerSessions(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    expect(containerSessions(db)).toEqual(first);
  });

  it('3. auto-create disabled skips new Bots but still renames and retires', () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
    ]);
    const id = createRemoteAgentConversation(db, BOT_A, 'Old Name');
    const { deps, cursors, frames } = harness(db, { autoCreate: false });
    cursors[BOT_A] = { entryId: 't0', seq: 0, updatedAt: 1, name: 'Old Name' };
    reconcileRoster(deps, [bot(BOT_A, 'New Name')]);
    expect(getConversation(db, id)?.title).toBe('New Name');
    expect(frames.some((f) => f.frame.type === 'conversation_updated' && 'title' in f.frame && f.frame.title === 'New Name')).toBe(true);

    reconcileRoster(deps, []); // empty — no retire
    expect(getConversation(db, id)?.archived).toBeUndefined();

    resetReconcileState();
    reconcileRoster(deps, [bot(BOT_B, 'Other')]); // BOT_A gone, auto-create off
    expect(findRemoteAgentConversation(db, BOT_B)).toBeUndefined();
    expect(getConversation(db, id)?.archived).toBe(true);
  });

  it('4. Bot rename follows an untouched title and broadcasts title', () => {
    const db = setup();
    const { deps, cursors, frames } = harness(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    expect(cursors[BOT_A]?.name).toBe('Inbox');
    frames.length = 0;
    reconcileRoster(deps, [bot(BOT_A, 'Inbox v2')]);
    const conv = findRemoteAgentConversation(db, BOT_A)!;
    expect(getConversation(db, conv.id)?.title).toBe('Inbox v2');
    expect(cursors[BOT_A]?.name).toBe('Inbox v2');
    const titled = frames.filter((f) => f.frame.type === 'conversation_updated' && f.frame.title === 'Inbox v2');
    expect(titled).toHaveLength(1);
  });

  it('5. operator rename is never overwritten', () => {
    const db = setup();
    const { deps, frames } = harness(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    const conv = findRemoteAgentConversation(db, BOT_A)!;
    renameConversation(db, conv.id, 'My notes');
    frames.length = 0;
    reconcileRoster(deps, [bot(BOT_A, 'Inbox v2')]);
    expect(getConversation(db, conv.id)?.title).toBe('My notes');
    expect(frames).toEqual([]);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox v3')]);
    expect(getConversation(db, conv.id)?.title).toBe('My notes');
  });

  it('6. disappearing Bot archives with one system marker and a broadcast', () => {
    const db = setup();
    const { deps, frames } = harness(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox'), bot(BOT_B, 'Other')]);
    const conv = findRemoteAgentConversation(db, BOT_A)!;
    frames.length = 0;
    reconcileRoster(deps, [bot(BOT_B, 'Other')]);
    expect(getConversation(db, conv.id)?.archived).toBe(true);
    const events = listEventsForConversation(db, conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('message');
    expect(events[0]?.sender).toBe('system');
    expect((events[0]?.payload as { chunk: string }).chunk).toBe(
      '_This Bot was removed from the Grok Bot roster._',
    );
    expect(frames.filter((f) => f.frame.type === 'conversation_updated' && f.id === conv.id)).toHaveLength(1);
  });

  it('7. a second retire writes the marker once', () => {
    const db = setup();
    const { deps } = harness(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    const conv = findRemoteAgentConversation(db, BOT_A)!;
    reconcileRoster(deps, [bot(BOT_B, 'Other')]);
    reconcileRoster(deps, [bot(BOT_B, 'Other')]);
    expect(listEventsForConversation(db, conv.id)).toHaveLength(1);
  });

  it('8. isLive defers retirement until the next tick', () => {
    const db = setup();
    const live = new Set<string>();
    const { deps } = harness(db, { live });
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    const conv = findRemoteAgentConversation(db, BOT_A)!;
    live.add(conv.id);
    reconcileRoster(deps, [bot(BOT_B, 'Other')]);
    expect(getConversation(db, conv.id)?.archived).toBeUndefined();
    expect(listEventsForConversation(db, conv.id)).toHaveLength(0);
    live.delete(conv.id);
    reconcileRoster(deps, [bot(BOT_B, 'Other')]);
    expect(getConversation(db, conv.id)?.archived).toBe(true);
    expect(listEventsForConversation(db, conv.id)).toHaveLength(1);
  });

  it('9. a reappearing Bot stays archived and is not duplicated', () => {
    const db = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = harness(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    reconcileRoster(deps, []);
    resetReconcileState(); // empty roster returns early; force a retire via BOT_B
    reconcileRoster(deps, [bot(BOT_B, 'Other')]);
    const retired = findRemoteAgentConversation(db, BOT_A);
    expect(retired?.archived).toBe(true);
    const before = listRemoteAgentConversations(db, { archived: true }).length
      + listRemoteAgentConversations(db, { archived: false }).length;
    reconcileRoster(deps, [bot(BOT_A, 'Inbox'), bot(BOT_B, 'Other')]);
    expect(findRemoteAgentConversation(db, BOT_A)?.archived).toBe(true);
    const after = listRemoteAgentConversations(db, { archived: true }).length
      + listRemoteAgentConversations(db, { archived: false }).length;
    expect(after).toBe(before);
    warn.mockRestore();
  });

  it('10. empty roster archives nothing and creates nothing', () => {
    const db = setup();
    const { deps, catalogueCalls } = harness(db);
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
    ]);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    reconcileRoster(deps, []);
    expect(getConversation(db, id)?.archived).toBeUndefined();
    expect(containerSessions(db)).toHaveLength(1);
    expect(catalogueCalls).toEqual([]);
  });

  it('11. non-UUID roster ids are ignored', () => {
    const db = setup();
    const { deps } = harness(db);
    reconcileRoster(deps, [{ id: GROUP, name: 'Team chat' }]);
    expect(containerSessions(db)).toEqual([]);
    const models = db.prepare(
      "SELECT id FROM agent_models WHERE agent_id = 'grok-bot' AND model_name = ?",
    ).all(GROUP) as { id: string }[];
    expect(models).toEqual([]);
  });

  it('12. unchanged fingerprint skips catalogue upsert', () => {
    const db = setup();
    const { deps, catalogueCalls } = harness(db);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    expect(catalogueCalls).toHaveLength(1);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    expect(catalogueCalls).toHaveLength(1);
    reconcileRoster(deps, [bot(BOT_A, 'Inbox v2')]);
    expect(catalogueCalls).toHaveLength(2);
  });

  it('13. auto-create succeeds when agent_models has no row yet', () => {
    const db = setup();
    const { deps } = harness(db);
    const existing = db.prepare(
      "SELECT id FROM agent_models WHERE id = ?",
    ).get(`grok-bot:${BOT_A}`);
    expect(existing).toBeUndefined();
    expect(() => reconcileRoster(deps, [bot(BOT_A, 'Fresh')])).not.toThrow();
    const conv = findRemoteAgentConversation(db, BOT_A);
    expect(conv).toBeDefined();
    expect(db.prepare("SELECT id FROM agent_models WHERE id = ?").get(`grok-bot:${BOT_A}`)).toBeTruthy();
  });

  it('15. nameless cursor arms from the current title when it already matches the Bot', () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
    ]);
    const id = createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const { deps, cursors, frames } = harness(db);
    cursors[BOT_A] = { entryId: 't0', seq: 0, updatedAt: 1 };
    expect(cursors[BOT_A]?.name).toBeUndefined();
    const dirty = reconcileRoster(deps, [bot(BOT_A, 'Inbox')]);
    expect(dirty).toBe(true);
    expect(cursors[BOT_A]?.name).toBe('Inbox');
    expect(getConversation(db, id)?.title).toBe('Inbox');
    expect(frames.filter((f) => f.frame.type === 'conversation_updated' && 'title' in f.frame)).toEqual([]);
  });

  it('16. nameless cursor then follows a Bot rename (self-arm + rename)', () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
    ]);
    const id = createRemoteAgentConversation(db, BOT_A, 'Alpha');
    const { deps, cursors, frames } = harness(db);
    cursors[BOT_A] = { entryId: 't0', seq: 0, updatedAt: 1 };
    reconcileRoster(deps, [bot(BOT_A, 'Alpha v2')]);
    expect(getConversation(db, id)?.title).toBe('Alpha v2');
    expect(cursors[BOT_A]?.name).toBe('Alpha v2');
    const titled = frames.filter((f) => f.frame.type === 'conversation_updated' && f.frame.title === 'Alpha v2');
    expect(titled).toHaveLength(1);
  });

  it('14. no status event on any path', () => {
    const db = setup();
    const live = new Set<string>();
    const { deps } = harness(db, { live });
    reconcileRoster(deps, [bot(BOT_A, 'Inbox'), bot(BOT_B, 'Other')]);
    const a = findRemoteAgentConversation(db, BOT_A)!;
    live.add(a.id);
    reconcileRoster(deps, [bot(BOT_B, 'Renamed')]);
    live.delete(a.id);
    reconcileRoster(deps, [bot(BOT_B, 'Renamed again')]);
    reconcileRoster(deps, []);
    resetReconcileState();
    reconcileRoster(deps, [bot(BOT_B, 'Still here')]);
    const types = db.prepare('SELECT DISTINCT type FROM events').all() as { type: string }[];
    expect(types.map((t) => t.type)).not.toContain('status');
  });

  it('17. auto-create with K>0 leaves entryId empty and sets backfill: K', () => {
    const db = setup();
    const { deps, cursors } = harness(db, { backfill: 200 });
    reconcileRoster(deps, [bot(BOT_A, 'Inbox', 't99')]);
    expect(cursors[BOT_A]?.entryId).toBe('');
    expect(cursors[BOT_A]?.backfill).toBe(200);
    expect(cursors[BOT_A]?.name).toBe('Inbox');
  });

  it('18. auto-create with K=0 arms newestEntryId (pre-parity)', () => {
    const db = setup();
    const { deps, cursors } = harness(db, { backfill: 0 });
    reconcileRoster(deps, [bot(BOT_A, 'Inbox', 't99')]);
    expect(cursors[BOT_A]?.entryId).toBe('t99');
    expect(cursors[BOT_A]?.backfill).toBeUndefined();
  });

  it('19. an existing conversation is never re-armed for backfill', () => {
    const db = setup();
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Grok Bot · A', provider: 'xai', vision: false, steer: true },
    ]);
    createRemoteAgentConversation(db, BOT_A, 'Inbox');
    const { deps, cursors } = harness(db, { backfill: 200 });
    cursors[BOT_A] = { entryId: 't0', seq: 3, updatedAt: 1, name: 'Inbox' };
    reconcileRoster(deps, [bot(BOT_A, 'Inbox', 't99')]);
    expect(cursors[BOT_A]?.entryId).toBe('t0');
    expect(cursors[BOT_A]?.seq).toBe(3);
    expect(cursors[BOT_A]?.backfill).toBeUndefined();
  });
});
