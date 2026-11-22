import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { SpawnMarker } from '@tierwyn/shared';
import { runMigrations } from '../../db/migrate.js';
import { migrations } from '../../db/migrations/index.js';
import { seedCatalogue } from '../../db/seed.js';
import { createProject } from '../../repositories/projects.js';
import { createConversation, getConversation } from '../../repositories/conversations.js';
import { createSpawnEdge } from '../../repositories/spawnEdges.js';
import { recordGrokBotHandover, relayLateChildReply } from './watcherHooks.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const a = createConversation(db, { projectId: p.id, title: 'Inbox' });
  const b = createConversation(db, { projectId: p.id, title: 'Release chat' });
  const marks: Array<{ conversationId: string; marker: SpawnMarker }> = [];
  const sm = { recordSpawnMarker: (conversationId: string, marker: SpawnMarker) => { marks.push({ conversationId, marker }); } };
  return { db, a: a.id, b: b.id, marks, sm };
}

describe('recordGrokBotHandover', () => {
  it('posts a linked handover card in both chats', () => {
    const { db, a, b, marks, sm } = setup();
    recordGrokBotHandover(db, sm, { botId: 'x', botName: 'Ops', fromConversationId: a, toConversationId: b });
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({ conversationId: b, marker: { kind: 'handover', childConversationId: a } });
    expect(marks[0]!.marker.text).toContain('Grok Bot · Ops replies now arrive here');
    expect(marks[1]).toMatchObject({ conversationId: a, marker: { kind: 'handover', childConversationId: b } });
    expect(marks[1]!.marker.text).toContain('“Release chat”');
  });

  it('skips the card for a conversation that no longer exists', () => {
    const { db, a, marks, sm } = setup();
    recordGrokBotHandover(db, sm, { botId: 'x', fromConversationId: 'gone', toConversationId: a });
    expect(marks.map((m) => m.conversationId)).toEqual([a]);
  });
});

describe('relayLateChildReply', () => {
  function withChild(notifyParent: boolean) {
    const s = setup();
    const p = createConversation(s.db, { projectId: getConversation(s.db, s.a)!.projectId, title: '↳ ops', parentConversationId: s.a });
    createSpawnEdge(s.db, { parentConversationId: s.a, childConversationId: p.id, role: 'ops', notifyParent });
    const notifies: Array<{ parent: string; text: string }> = [];
    const sm = {
      ...s.sm,
      notifyParentSubagentResult: (parent: string, text: string) => { notifies.push({ parent, text }); },
    };
    return { ...s, child: p.id, sm, notifies };
  }

  it('marks and notifies the parent when the edge notifies', () => {
    const { db, a, child, sm, marks, notifies } = withChild(true);
    relayLateChildReply(db, sm, child, 'done at last');
    expect(marks).toEqual([expect.objectContaining({ conversationId: a, marker: expect.objectContaining({ kind: 'result', childConversationId: child }) })]);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.parent).toBe(a);
    expect(notifies[0]!.text).toContain('done at last');
  });

  it('marks but does not wake the parent when notifyParent is off', () => {
    const { db, child, sm, marks, notifies } = withChild(false);
    relayLateChildReply(db, sm, child, 'quiet');
    expect(marks).toHaveLength(1);
    expect(notifies).toEqual([]);
  });

  it('does nothing for a conversation without a spawn edge', () => {
    const { db, b, sm, marks, notifies } = withChild(true);
    relayLateChildReply(db, sm, b, 'x');
    expect(marks).toEqual([]);
    expect(notifies).toEqual([]);
  });
});

