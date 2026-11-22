import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedDefaultSettings } from './db/seed.js';
import { setDb, getDb } from './db/index.js';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { listEventsForConversation } from './repositories/events.js';
import { createSpawnEdge, getEdgeByChild } from './repositories/spawnEdges.js';
import { SessionManager } from './sessionManager.js';
import type { AgentAdapter, ServerFrame, SessionConfig } from '@tierwyn/shared';

/** In-flight turn; stop() emits done then end so the watcher/bridge see a terminal. */
class StopEmittingAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
  }
  finish(status: 'done' | 'error' = 'done') {
    this.emitter.emit('event', { type: 'status', payload: { status }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
}

class SoftForceAdapter extends StopEmittingAdapter {
  interruptCalls = 0;
  interruptTurn() {
    this.interruptCalls++;
    this.finish('done');
  }
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
  const parent = createConversation(db, { projectId: p.id, title: 'parent' });
  const child = createConversation(db, { projectId: p.id, title: 'child', parentConversationId: parent.id });
  return { db, projectId: p.id, parentId: parent.id, childId: child.id };
}

describe('operator stop / interrupt must not notify the parent', () => {
  it('operator stopSession marks an open spawn edge interrupted (watcher CAS will drop notify)', async () => {
    const { parentId, childId, projectId } = boot();
    createSpawnEdge(getDb(), { parentConversationId: parentId, childConversationId: childId, notifyParent: true });
    registry.register('claude-code', () => new StopEmittingAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId: childId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'child task',
    });
    await mgr.stopSession(sid, { initiatedBy: 'operator' });

    expect(getEdgeByChild(getDb(), childId)!.status).toBe('interrupted');
  });

  it('system stopSession leaves the spawn edge open so a natural result can still notify', async () => {
    const { parentId, childId, projectId } = boot();
    createSpawnEdge(getDb(), { parentConversationId: parentId, childConversationId: childId, notifyParent: true });
    registry.register('claude-code', () => new StopEmittingAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId: childId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'child task',
    });
    await mgr.stopSession(sid);

    expect(getEdgeByChild(getDb(), childId)!.status).toBe('open');
  });

  it('operator stop does not stamp operator_interrupt (edge CAS is the stop gate)', async () => {
    const { childId, projectId } = boot();
    registry.register('claude-code', () => new StopEmittingAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId: childId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'child task',
    });
    await mgr.stopSession(sid, { initiatedBy: 'operator' });
    await new Promise((r) => setTimeout(r, 20));

    const done = listEventsForConversation(getDb(), childId).find(
      (e) => e.type === 'status' && (e.payload as { status?: string }).status === 'done',
    );
    expect((done?.payload as { cause?: string }).cause).toBeUndefined();
  });

  it('Interrupt & Send (force) stamps the interrupted done with operator_interrupt and session_ended cause', async () => {
    const { childId, projectId } = boot();
    const made: SoftForceAdapter[] = [];
    registry.register('claude-code', () => { const a = new SoftForceAdapter(); made.push(a); return a; });
    const frames: ServerFrame[] = [];
    const mgr = new SessionManager({ broadcast: (_cid, frame) => frames.push(frame) });

    const sid = await mgr.handlePrompt({
      projectId, conversationId: childId, agent: 'claude-code',
      model: 'claude-sonnet-4-6', profileId: 'claude-code:sonnet-4.6', text: 'child task',
    });
    await new Promise((r) => setTimeout(r, 10));
    await mgr.steerSession(sid, 'redirect', undefined, { intent: 'force' });
    await new Promise((r) => setTimeout(r, 20));

    expect(made[0].interruptCalls).toBe(1);
    const done = listEventsForConversation(getDb(), childId).find(
      (e) => e.type === 'status' && (e.payload as { status?: string }).status === 'done',
    );
    expect((done?.payload as { cause?: string }).cause).toBe('operator_interrupt');
    const ended = frames.find((f) => f.type === 'session_ended') as
      | Extract<ServerFrame, { type: 'session_ended' }>
      | undefined;
    expect(ended?.cause).toBe('operator_interrupt');
  });
});
