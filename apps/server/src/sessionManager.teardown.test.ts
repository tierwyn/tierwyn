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
import { createConversation } from './repositories/conversations.js';
import { listEventsForSession } from './repositories/events.js';
import { SessionManager } from './sessionManager.js';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

class TestFakeAdapter implements AgentAdapter {
  public emitter = new EventEmitter();
  public stopCount = 0;
  public promptsSeen: string[] = [];

  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt(text: string) {
    this.promptsSeen.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: `reply to: ${text}`, final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
  }
  async stop() {
    this.stopCount++;
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
}

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db);
  seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  const p = createProject(db, { name: 'P', rootPath: '/tmp/proj' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  return { db, projectId: p.id, conversationId: c.id };
}

describe('SessionManager stopWhenSettled teardown race guard', () => {
  it('prevents teardown from killing a concurrent follow-up prompt on the same conversation', async () => {
    const { db, projectId, conversationId } = boot();
    const adapter = new TestFakeAdapter();
    registry.register('grok-build', () => adapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    // Turn 1
    const sid1 = await mgr.handlePrompt({
      projectId, conversationId, agent: 'grok-build',
      model: 'grok-4.6', profileId: 'grok-build:grok-4.6', text: 'turn 1',
    });

    expect(adapter.promptsSeen.some((p) => p.includes('turn 1'))).toBe(true);

    // Concurrently trigger stopWhenSettled (as onResult would) and an immediate follow-up prompt
    const teardownPromise = mgr.stopWhenSettled(conversationId, sid1);
    const followUpPromise = mgr.handlePrompt({
      projectId, conversationId, agent: 'grok-build',
      model: 'grok-4.6', profileId: 'grok-build:grok-4.6', text: 'turn 2 follow-up',
    });

    const [, sid2] = await Promise.all([teardownPromise, followUpPromise]);

    // Turn 2 must have been delivered and executed
    expect(adapter.promptsSeen.some((p) => p.includes('turn 2 follow-up'))).toBe(true);

    // Verify no "queued message(s) discarded" error event occurred in either session
    const events1 = listEventsForSession(db, sid1);
    const errorEv1 = events1.find((e) => e.type === 'error' && JSON.stringify(e.payload).includes('discarded'));
    expect(errorEv1).toBeUndefined();

    if (sid2 && sid2 !== sid1) {
      const events2 = listEventsForSession(db, sid2);
      const errorEv2 = events2.find((e) => e.type === 'error' && JSON.stringify(e.payload).includes('discarded'));
      expect(errorEv2).toBeUndefined();
    }
  });

  it('still reaps settled session when no follow-up prompt arrives', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new TestFakeAdapter();
    registry.register('grok-build', () => adapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'grok-build',
      model: 'grok-4.6', profileId: 'grok-build:grok-4.6', text: 'initial prompt',
    });

    expect(adapter.stopCount).toBe(0);

    // Run stopWhenSettled with no follow-up
    await mgr.stopWhenSettled(conversationId, sid, 5_000);

    // Session should be stopped and adapter.stop() invoked once
    expect(adapter.stopCount).toBe(1);
    expect(mgr.activeSessionForConversation(conversationId)).toBeUndefined();
  });

  it('deadline force-stops so a stuck pending steer queue cannot leak PID forever', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new TestFakeAdapter();
    registry.register('grok-build', () => adapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'grok-build',
      model: 'grok-4.6', profileId: 'grok-build:grok-4.6', text: 'turn 1',
    });

    // Artificially wedge the steer queue so hasPendingSteerWork is permanently true
    const record = (mgr as any).sessions.get(sid);
    record.steerQueue.push({ id: 'stuck-1', text: 'stuck steer', ts: Date.now() });

    // Short timeout of 50ms should expire and force-stop
    await mgr.stopWhenSettled(conversationId, sid, 50);

    expect(adapter.stopCount).toBe(1);
    expect(mgr.activeSessionForConversation(conversationId)).toBeUndefined();
  });
});
