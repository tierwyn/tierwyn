import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedDefaultSettings } from './db/seed.js';
import { setDb } from './db/index.js';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import { createProject } from './repositories/projects.js';
import {
  createConversation,
  listConversations,
  markConversationViewed,
} from './repositories/conversations.js';
import { listEventsForConversation } from './repositories/events.js';
import { SessionHub } from './sessionHub.js';
import { SessionManager } from './sessionManager.js';
import { conversationUpdatedFromSessionFrame } from './conversationUpdatedFan.js';
import type { AgentAdapter, ServerFrame, SessionConfig } from '@tierwyn/shared';

/** Hold-open: emits done but not 'end', so the SessionRecord stays in the map. */
class HoldOpenFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'tick', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
  }
  async stop() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
  get nativeSessionId() { return 'native-holdopen-unread'; }
}

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db);
  seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  registry.register('claude-code', () => new HoldOpenFakeAdapter());
  const p = createProject(db, { name: 'P', rootPath: '/tmp/proj' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  return { db, projectId: p.id, conversationId: c.id };
}

function drain(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Mirrors apps/server/src/index.ts SessionManager.broadcast: conversation
 * subscribers get the raw frame; every client gets conversation_updated
 * built by conversationUpdatedFromSessionFrame (the same helper production
 * now uses). session_started/ended also fan globally. A "non-subscribed
 * client" is a hub-registered socket that never subscribed to this conversation.
 */
function installIndexBroadcast(hub: SessionHub) {
  const globalFan: ServerFrame[] = [];
  const broadcast = (conversationId: string, frame: ServerFrame) => {
    hub.broadcast(conversationId, frame);
    const update = conversationUpdatedFromSessionFrame(conversationId, frame, Date.now());
    hub.broadcastAll(update);
    globalFan.push(update);
    if (frame.type === 'session_started' || frame.type === 'session_ended') {
      hub.broadcastAll(frame);
      globalFan.push(frame);
    }
  };
  return { broadcast, globalFan };
}

describe('held-open turn-end unread (parked-blue)', () => {
  it('held-open turn end fans conversation_updated {status:done} to a non-subscriber and hydrates lastStatus', async () => {
    const { db, projectId, conversationId } = boot();
    // Operator viewed this conversation earlier; last_viewed_at predates the turn.
    markConversationViewed(db, conversationId, Date.now() - 60_000);

    const hub = new SessionHub();
    const subscriber = { sent: [] as ServerFrame[], send(f: ServerFrame) { this.sent.push(f); } };
    const bystander = { sent: [] as ServerFrame[], send(f: ServerFrame) { this.sent.push(f); } };
    hub.subscribe('other-conv', subscriber);
    hub.register(subscriber);
    hub.register(bystander);

    const { broadcast, globalFan } = installIndexBroadcast(hub);
    const mgr = new SessionManager({ broadcast });

    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'tick',
    });
    await drain();

    const parked = mgr.activeSessionForConversation(conversationId);
    expect(parked?.id).toBe(sessionId);
    expect(parked?.lastStatus).toBe('done');

    const statusPayloads = listEventsForConversation(db, conversationId)
      .filter((e) => e.type === 'status')
      .map((e) => (e.payload as { status?: string }).status);
    expect(statusPayloads).toContain('done');

    const bystanderDone = bystander.sent.filter(
      (f) => f.type === 'conversation_updated'
        && f.conversationId === conversationId
        && f.status === 'done',
    );
    expect(bystanderDone.length).toBeGreaterThan(0);

    const subscriberHubEvents = subscriber.sent.filter(
      (f) => f.type === 'event' && f.conversationId === conversationId,
    );
    expect(subscriberHubEvents).toEqual([]);

    const listed = listConversations(db, projectId).find((c) => c.id === conversationId);
    expect(listed?.lastStatus).toBe('done');

    expect(globalFan.some((f) => f.type === 'conversation_updated' && f.status === 'done')).toBe(true);
  });

  it('stopping a parked session still hydrates lastStatus:done and fans idle without clearing it', async () => {
    const { db, projectId, conversationId } = boot();
    markConversationViewed(db, conversationId, Date.now() - 60_000);

    const hub = new SessionHub();
    const bystander = { sent: [] as ServerFrame[], send(f: ServerFrame) { this.sent.push(f); } };
    hub.register(bystander);
    const { broadcast } = installIndexBroadcast(hub);
    const mgr = new SessionManager({ broadcast });

    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'tick',
    });
    await drain();
    await mgr.stopSession(sessionId);
    await drain();

    expect(mgr.activeSessionForConversation(conversationId)).toBeUndefined();

    const listed = listConversations(db, projectId).find((c) => c.id === conversationId);
    expect(listed?.lastStatus).toBe('done');

    expect(bystander.sent.some(
      (f) => f.type === 'conversation_updated' && f.conversationId === conversationId && f.status === 'done',
    )).toBe(true);
    expect(bystander.sent.some(
      (f) => f.type === 'conversation_updated' && f.conversationId === conversationId && f.status === 'idle',
    )).toBe(true);
  });

  it('listConversations omits lastStatus when the operator viewed after done', async () => {
    const { db, projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'tick',
    });
    await drain();
    markConversationViewed(db, conversationId, Date.now() + 1);

    const listed = listConversations(db, projectId).find((c) => c.id === conversationId);
    expect(listed?.lastStatus).toBeUndefined();
  });
});
