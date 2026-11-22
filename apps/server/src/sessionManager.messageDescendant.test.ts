import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { openDb, setDb, getDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings, enableAllAgents } from './db/seed.js';
import { catalogue } from './catalogue.js';
import { createProject } from './repositories/projects.js';
import { createConversation, getConversation, setConversationPendingHandoffMode } from './repositories/conversations.js';
import { createSession } from './repositories/sessions.js';
import { updateCompactionSettings } from './repositories/settings.js';
import { SessionManager } from './sessionManager.js';

let mgr: SessionManager;
let parentId: string;
let childId: string;
let last: { id: string; agentType: string };
let other: { id: string; agentType: string; model: string };
let broadcastFrames: unknown[] = [];

beforeEach(() => {
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db); seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  const profiles = catalogue.listProfiles();
  last = profiles[0];
  other = profiles.find((p) => p.agentType !== last.agentType)!;
  const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
  parentId = createConversation(db, { projectId: project.id, title: 'root' }).id;
  childId = createConversation(db, { projectId: project.id, title: 'child', parentConversationId: parentId }).id;
  createSession(db, { id: randomUUID(), conversationId: childId, agentId: last.agentType, agentModelId: last.id });
  broadcastFrames = [];
  mgr = new SessionManager({
    broadcast: () => {},
    broadcastAll: (frame) => broadcastFrames.push(frame),
  });
});

describe('messageDescendant profile override', () => {
  it('override path skips the agentType equality guard and calls handlePrompt with the new profileId', async () => {
    const spy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('sess-1');
    const delivered = mgr.messageDescendant(childId, 'resume', { replyTo: parentId, profileId: other.id });
    expect(delivered).toBe('new_turn');
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({
      profileId: other.id,
      agent: other.agentType,
      model: other.model,
      source: 'parent_message',
    });
    spy.mockRestore();
  });

  it('no-override path still drops when last.agentId does not match the last profile agentType', () => {
    const db = getDb();
    db.prepare('DELETE FROM sessions WHERE conversation_id = ?').run(childId);
    createSession(db, {
      id: randomUUID(), conversationId: childId,
      agentId: last.agentType, agentModelId: other.id,
    });
    expect(mgr.messageDescendant(childId, 'resume', { replyTo: parentId })).toBe('dropped');
  });

  it('live turn steers and ignores profileId', () => {
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockReturnValue({ id: 'live' } as never);
    const steer = vi.spyOn(mgr, 'steerSession').mockResolvedValue({ mode: 'injected', queueLength: 0 } as never);
    const delivered = mgr.messageDescendant(childId, 'hi', { replyTo: parentId, profileId: other.id });
    expect(delivered).toBe('steered');
    expect(steer).toHaveBeenCalled();
    expect(steer.mock.calls[0][1]).toBe('hi');
  });

  it('cross-agent override under handoffMode prompt passes handoffOverride summary', async () => {
    updateCompactionSettings(getDb(), { handoffMode: 'prompt' });
    const spy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('sess-1');
    mgr.messageDescendant(childId, 'resume', { replyTo: parentId, profileId: other.id });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].handoffOverride).toBe('summary');
    spy.mockRestore();
  });

  it('same-agent model change under handoffMode prompt keeps native resume (no override)', async () => {
    const sibling = catalogue.listProfiles().find((p) => p.agentType === last.agentType && p.id !== last.id);
    expect(sibling).toBeDefined();
    updateCompactionSettings(getDb(), { handoffMode: 'prompt' });
    const spy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('sess-1');
    mgr.messageDescendant(childId, 'resume', { replyTo: parentId, profileId: sibling!.id });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].profileId).toBe(sibling!.id);
    expect(spy.mock.calls[0][0].handoffOverride).toBeUndefined();
    spy.mockRestore();
  });

  it('notify lands in subagent meta passed to handlePrompt', async () => {
    const spy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('sess-1');
    mgr.messageDescendant(childId, 'resume', { replyTo: parentId, notify: true });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].subagent).toMatchObject({
      replyTo: parentId,
      childConversationId: childId,
      notify: true,
    });
    spy.mockRestore();
  });

  it('notify lands in subagent meta passed to steerSession on live turn', () => {
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockReturnValue({ id: 'live' } as never);
    const steer = vi.spyOn(mgr, 'steerSession').mockResolvedValue({ mode: 'injected', queueLength: 0 } as never);
    mgr.messageDescendant(childId, 'hi', { replyTo: parentId, notify: false });
    expect(steer).toHaveBeenCalledWith('live', 'hi', undefined, {
      source: 'parent_message',
      recall: true,
      subagent: expect.objectContaining({ replyTo: parentId, childConversationId: childId, notify: false }),
    });
  });

  it('calls onStartError when handlePrompt rejects', async () => {
    const onStartError = vi.fn();
    vi.spyOn(mgr, 'handlePrompt').mockRejectedValue(new Error('adapter crashed before start'));
    mgr.messageDescendant(childId, 'resume', { replyTo: parentId, onStartError });
    await vi.waitFor(() => expect(onStartError).toHaveBeenCalledWith('adapter crashed before start'));
  });

  it('S3-3: logs warning via console.warn when onStartError is omitted and handlePrompt rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(mgr, 'handlePrompt').mockRejectedValue(new Error('background start failure'));
    mgr.messageDescendant(childId, 'resume', { replyTo: parentId });
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
      '[messageDescendant] handlePrompt start failed:',
      'background start failure',
    ));
    warnSpy.mockRestore();
  });
});

describe('messageDescendant handoff & staged pendingHandoffMode', () => {
  it('staged fresh + no override → handlePrompt receives handoffOverride: fresh, DB cleared, broadcastAll gets null', async () => {
    const db = getDb();
    setConversationPendingHandoffMode(db, childId, 'fresh');
    expect(getConversation(db, childId)?.pendingHandoffMode).toBe('fresh');

    const spy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('sess-1');
    const delivered = mgr.messageDescendant(childId, 'resume', { replyTo: parentId });
    expect(delivered).toBe('new_turn');

    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].handoffOverride).toBe('fresh');
    expect(getConversation(db, childId)?.pendingHandoffMode).toBeUndefined();
    expect(broadcastFrames).toContainEqual(expect.objectContaining({
      type: 'conversation_updated',
      conversationId: childId,
      pendingHandoffMode: null,
    }));
    spy.mockRestore();
  });

  it('explicit meta.handoff: transcript beats staged summary (staged is still cleared)', async () => {
    const db = getDb();
    setConversationPendingHandoffMode(db, childId, 'summary');
    const spy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('sess-1');

    const delivered = mgr.messageDescendant(childId, 'resume', { replyTo: parentId, handoff: 'transcript' });
    expect(delivered).toBe('new_turn');

    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].handoffOverride).toBe('transcript');
    expect(getConversation(db, childId)?.pendingHandoffMode).toBeUndefined();
    expect(broadcastFrames).toContainEqual(expect.objectContaining({
      type: 'conversation_updated',
      conversationId: childId,
      pendingHandoffMode: null,
    }));
    spy.mockRestore();
  });

  it('live child → steered, staged not cleared', () => {
    const db = getDb();
    setConversationPendingHandoffMode(db, childId, 'fresh');
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockReturnValue({ id: 'live' } as never);
    const steer = vi.spyOn(mgr, 'steerSession').mockResolvedValue({ mode: 'injected', queueLength: 0 } as never);

    const delivered = mgr.messageDescendant(childId, 'hi', { replyTo: parentId });
    expect(delivered).toBe('steered');
    expect(steer).toHaveBeenCalled();
    expect(getConversation(db, childId)?.pendingHandoffMode).toBe('fresh');
    expect(broadcastFrames).toEqual([]);
  });

  it('no staged + cross-agent + prompt mode → summary (existing behaviour)', async () => {
    updateCompactionSettings(getDb(), { handoffMode: 'prompt' });
    const spy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('sess-1');

    mgr.messageDescendant(childId, 'resume', { replyTo: parentId, profileId: other.id });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].handoffOverride).toBe('summary');
    spy.mockRestore();
  });
});
