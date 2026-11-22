import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { createSession } from './repositories/sessions.js';
import { appendEvent } from './repositories/events.js';
import { computeSubtreeTime, _resetSubtreeTimeCache } from './subtreeTime.js';

describe('computeSubtreeTime', () => {
  let db: Database.Database;
  let projectId: string;

  beforeEach(() => {
    _resetSubtreeTimeCache();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const p = createProject(db, { name: 'P', rootPath: '/p' });
    projectId = p.id;
  });

  it('ignores helper events after done so elapsed time is unchanged', async () => {
    const c = createConversation(db, { projectId, title: 'C' });
    createSession(db, { id: 's1', conversationId: c.id });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: {}, sender: 'agent', ts: 4000, seq: 2 });
    appendEvent(db, { sessionId: 's1', type: 'status', payload: { status: 'done' }, sender: 'agent', ts: 5000, seq: 3 });
    appendEvent(db, {
      sessionId: 's1', type: 'helper',
      payload: { taskId: 't1', label: 'Explore', description: 'x', status: 'running', startedAt: 2000 },
      sender: 'agent', ts: 15000, seq: 4,
    });
    appendEvent(db, {
      sessionId: 's1', type: 'helper',
      payload: { taskId: 't1', label: 'Explore', description: 'x', status: 'completed', startedAt: 2000 },
      sender: 'agent', ts: 25000, seq: 5,
    });
    const res = await computeSubtreeTime(db, c.id);
    expect(res.selfMs).toBe(4000);
  });

  it('excludes post-done dead time (late idle when the session parks)', async () => {
    const c = createConversation(db, { projectId, title: 'C' });
    createSession(db, { id: 's1', conversationId: c.id });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: {}, sender: 'agent', ts: 4000, seq: 2 });
    appendEvent(db, { sessionId: 's1', type: 'status', payload: { status: 'done' }, sender: 'agent', ts: 5000, seq: 3 });
    appendEvent(db, { sessionId: 's1', type: 'status', payload: { status: 'idle' }, sender: 'agent', ts: 50_000_000, seq: 4 });
    const res = await computeSubtreeTime(db, c.id);
    expect(res.selfMs).toBe(4000);
  });

  it('case 1: single conversation, two turns', async () => {
    const c = createConversation(db, { projectId, title: 'C' });
    createSession(db, { id: 's1', conversationId: c.id });

    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: {}, sender: 'agent', ts: 4000, seq: 2 });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: {}, sender: 'user', ts: 10000, seq: 3 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: {}, sender: 'agent', ts: 12000, seq: 4 });

    const res = await computeSubtreeTime(db, c.id);
    expect(res.selfMs).toBe(5000); // (4000 - 1000) + (12000 - 10000)
    expect(res.descendantsMs).toBe(0);
    expect(res.totalMs).toBe(5000);
    expect(res.descendantCount).toBe(0);
    expect(res.truncated).toBe(false);
    expect(res.omittedCount).toBe(0);
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0]).toEqual({
      conversationId: c.id,
      parentConversationId: null,
      title: 'C',
      depth: 0,
      workedMs: 5000,
      turns: 2,
      lastEventTs: 12000,
    });
  });

  it('excludes time blocked on an unresolved interaction_request', async () => {
    const c = createConversation(db, { projectId, title: 'C' });
    createSession(db, { id: 's1', conversationId: c.id });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's1', type: 'interaction_request', payload: {}, sender: 'agent', ts: 2000, seq: 2 });
    appendEvent(db, { sessionId: 's1', type: 'interaction_resolved', payload: {}, sender: 'user', ts: 50000, seq: 3 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: {}, sender: 'agent', ts: 53000, seq: 4 });
    const res = await computeSubtreeTime(db, c.id);
    expect(res.selfMs).toBe(4000); // 1000 before the card + 3000 after it
    expect(res.nodes[0].turns).toBe(1);
  });

  it('case 2: events before the first prompt are ignored', async () => {
    const c = createConversation(db, { projectId, title: 'C' });
    createSession(db, { id: 's1', conversationId: c.id });

    appendEvent(db, { sessionId: 's1', type: 'status', payload: {}, sender: 'system', ts: 500, seq: 1 });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 2 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: {}, sender: 'agent', ts: 2000, seq: 3 });

    const res = await computeSubtreeTime(db, c.id);
    expect(res.selfMs).toBe(1000); // 2000 - 1000
    expect(res.nodes[0].turns).toBe(1);
  });

  it('case 3: two sessions in one conversation with late wind-down event in session A', async () => {
    const c = createConversation(db, { projectId, title: 'C' });
    createSession(db, { id: 'sA', conversationId: c.id });
    createSession(db, { id: 'sB', conversationId: c.id });

    // Session A prompt and message
    appendEvent(db, { sessionId: 'sA', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 'sA', type: 'message', payload: {}, sender: 'agent', ts: 2000, seq: 2 });

    // Session B prompt and message
    appendEvent(db, { sessionId: 'sB', type: 'prompt', payload: {}, sender: 'user', ts: 3000, seq: 1 });
    appendEvent(db, { sessionId: 'sB', type: 'message', payload: {}, sender: 'agent', ts: 4000, seq: 2 });

    // Session A late wind-down event at ts 5000 (after session B prompt)
    appendEvent(db, { sessionId: 'sA', type: 'status', payload: {}, sender: 'system', ts: 5000, seq: 3 });

    const res = await computeSubtreeTime(db, c.id);
    // Session A turn: 1000..5000 = 4000 ms.
    // Session B turn: 3000..4000 = 1000 ms.
    // Total selfMs = 5000 ms, 2 turns.
    expect(res.selfMs).toBe(5000);
    expect(res.nodes[0].turns).toBe(2);
    expect(res.nodes[0].lastEventTs).toBe(5000);
  });

  it('case 4: root -> child -> grandchild with overlapping times', async () => {
    const root = createConversation(db, { projectId, title: 'Root' });
    const child = createConversation(db, { projectId, title: 'Child', parentConversationId: root.id });
    const grand = createConversation(db, { projectId, title: 'Grandchild', parentConversationId: child.id });

    createSession(db, { id: 's-root', conversationId: root.id });
    createSession(db, { id: 's-child', conversationId: child.id });
    createSession(db, { id: 's-grand', conversationId: grand.id });

    // Root: 1000..3000 (2000 ms)
    appendEvent(db, { sessionId: 's-root', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's-root', type: 'message', payload: {}, sender: 'agent', ts: 3000, seq: 2 });

    // Child: 2000..5000 (3000 ms)
    appendEvent(db, { sessionId: 's-child', type: 'prompt', payload: {}, sender: 'user', ts: 2000, seq: 1 });
    appendEvent(db, { sessionId: 's-child', type: 'message', payload: {}, sender: 'agent', ts: 5000, seq: 2 });

    // Grandchild: 2500..4500 (2000 ms) - overlaps with child
    appendEvent(db, { sessionId: 's-grand', type: 'prompt', payload: {}, sender: 'user', ts: 2500, seq: 1 });
    appendEvent(db, { sessionId: 's-grand', type: 'message', payload: {}, sender: 'agent', ts: 4500, seq: 2 });

    const res = await computeSubtreeTime(db, root.id);
    expect(res.selfMs).toBe(2000);
    expect(res.descendantsMs).toBe(5000); // 3000 + 2000
    expect(res.totalMs).toBe(7000);
    expect(res.descendantCount).toBe(2);
    expect(res.nodes).toHaveLength(3);

    expect(res.nodes[0]).toMatchObject({
      conversationId: root.id,
      parentConversationId: null,
      depth: 0,
      workedMs: 2000,
    });
    expect(res.nodes[1]).toMatchObject({
      conversationId: child.id,
      parentConversationId: root.id,
      depth: 1,
      workedMs: 3000,
    });
    expect(res.nodes[2]).toMatchObject({
      conversationId: grand.id,
      parentConversationId: child.id,
      depth: 2,
      workedMs: 2000,
    });
  });

  it('case 5: a btw answer-child and its subtree are excluded', async () => {
    const root = createConversation(db, { projectId, title: 'Root' });
    const btwChild = createConversation(db, { projectId, title: 'BtwChild', parentConversationId: root.id });
    const btwGrandchild = createConversation(db, { projectId, title: 'BtwGrandchild', parentConversationId: btwChild.id });

    // Insert btw_queries record pointing to btwChild
    db.prepare(`
      INSERT INTO btw_queries (id, parent_conv_id, child_conv_id, question, status, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('btw-1', root.id, btwChild.id, 'question', 'done', 'agent-1', Date.now());

    createSession(db, { id: 's-root', conversationId: root.id });
    createSession(db, { id: 's-btw', conversationId: btwChild.id });
    createSession(db, { id: 's-btw-grand', conversationId: btwGrandchild.id });

    appendEvent(db, { sessionId: 's-root', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's-root', type: 'message', payload: {}, sender: 'agent', ts: 2000, seq: 2 });

    appendEvent(db, { sessionId: 's-btw', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's-btw', type: 'message', payload: {}, sender: 'agent', ts: 3000, seq: 2 });

    const res = await computeSubtreeTime(db, root.id);
    expect(res.descendantCount).toBe(0);
    expect(res.descendantsMs).toBe(0);
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0].conversationId).toBe(root.id);
  });

  it('case 6: cache hit, append invalidation, and deletion invalidation via count', async () => {
    const root = createConversation(db, { projectId, title: 'Root' });
    const child = createConversation(db, { projectId, title: 'Child', parentConversationId: root.id });

    createSession(db, { id: 's-root', conversationId: root.id });
    createSession(db, { id: 's-child', conversationId: child.id });

    appendEvent(db, { sessionId: 's-root', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's-root', type: 'message', payload: {}, sender: 'agent', ts: 2000, seq: 2 });

    appendEvent(db, { sessionId: 's-child', type: 'prompt', payload: {}, sender: 'user', ts: 2000, seq: 1 });
    const midEvt = appendEvent(db, { sessionId: 's-child', type: 'message', payload: {}, sender: 'agent', ts: 4000, seq: 2 });

    // Call 1: initial scan
    const res1 = await computeSubtreeTime(db, root.id);
    expect(res1.selfMs).toBe(1000);
    expect(res1.descendantsMs).toBe(2000);
    expect(res1.totalMs).toBe(3000);

    // Append an event to child session
    appendEvent(db, { sessionId: 's-child', type: 'message', payload: {}, sender: 'agent', ts: 6000, seq: 3 });

    // Call 2: reflects new time (6000 - 2000 = 4000)
    const res2 = await computeSubtreeTime(db, root.id);
    expect(res2.descendantsMs).toBe(4000);
    expect(res2.totalMs).toBe(5000);

    // Delete middle event (midEvt at ts 4000): count changes from 3 to 2, max_ts is still 6000
    db.prepare('DELETE FROM events WHERE id = ?').run(midEvt.id);

    // Call 3: count changed, cache invalidated, recomputed
    const res3 = await computeSubtreeTime(db, root.id);
    // Turns: prompt@2000, message@6000 -> 4000 ms, 1 turn
    expect(res3.descendantsMs).toBe(4000);
    expect(res3.nodes[1].turns).toBe(1);
  });

  it('case 7: truncation with maxNodes option', async () => {
    const root = createConversation(db, { projectId, title: 'Root' });
    const maxNodes = 5;
    // Create maxNodes + 3 children (8 children)
    for (let i = 0; i < maxNodes + 3; i++) {
      createConversation(db, { projectId, title: `Child ${i}`, parentConversationId: root.id });
    }

    const res = await computeSubtreeTime(db, root.id, { maxNodes });
    expect(res.truncated).toBe(true);
    expect(res.omittedCount).toBe(3);
    expect(res.nodes).toHaveLength(maxNodes + 1); // 6 (root + 5 children)
    expect(res.descendantCount).toBe(maxNodes); // kept descendants
  });

  it('case 8: concurrent calls for the same root return the same promise', async () => {
    const root = createConversation(db, { projectId, title: 'Root' });
    createSession(db, { id: 's-root', conversationId: root.id });
    appendEvent(db, { sessionId: 's-root', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's-root', type: 'message', payload: {}, sender: 'agent', ts: 2000, seq: 2 });

    const p1 = computeSubtreeTime(db, root.id);
    const p2 = computeSubtreeTime(db, root.id);
    expect(p1).toBe(p2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });

  it('F1: does not trigger unhandled rejection when computation errors on schema-less db', async () => {
    _resetSubtreeTimeCache();
    const rawDb = new Database(':memory:');
    await expect(computeSubtreeTime(rawDb, 'x')).rejects.toThrow();
  });

  it('F2: corrupt cycle (A -> B -> A) yields exactly 2 nodes without duplicate ids', async () => {
    const convA = createConversation(db, { projectId, title: 'A' });
    const convB = createConversation(db, { projectId, title: 'B', parentConversationId: convA.id });

    // Force corrupt cycle by pointing A's parent to B
    db.prepare('UPDATE conversations SET parent_conversation_id = ? WHERE id = ?').run(convB.id, convA.id);

    createSession(db, { id: 's-A', conversationId: convA.id });
    createSession(db, { id: 's-B', conversationId: convB.id });
    appendEvent(db, { sessionId: 's-A', type: 'prompt', payload: {}, sender: 'user', ts: 1000, seq: 1 });
    appendEvent(db, { sessionId: 's-A', type: 'message', payload: {}, sender: 'agent', ts: 2000, seq: 2 });
    appendEvent(db, { sessionId: 's-B', type: 'prompt', payload: {}, sender: 'user', ts: 2000, seq: 1 });
    appendEvent(db, { sessionId: 's-B', type: 'message', payload: {}, sender: 'agent', ts: 3000, seq: 2 });

    const res = await computeSubtreeTime(db, convA.id);
    expect(res.nodes).toHaveLength(2);
    expect(res.nodes.map((n) => n.conversationId)).toEqual([convA.id, convB.id]);
    expect(res.descendantCount).toBe(1);
  });
});
