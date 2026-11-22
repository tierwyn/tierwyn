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
import { SessionManager } from './sessionManager.js';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

class ClaudeHelpersFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  public stopCalled = 0;
  public delivered: string[] = [];
  public stoppedHelpers: string[] = [];
  private getNextSteer?: SessionConfig['getNextSteer'];

  streamEvents() { return this.emitter; }

  async start(cfg: SessionConfig) {
    this.getNextSteer = cfg.getNextSteer;
  }

  emitHelper(status: 'running' | 'completed' | 'stopped', taskId = 't1') {
    this.emitter.emit('event', {
      type: 'helper',
      payload: {
        taskId,
        label: 'Explore',
        description: 'list files',
        status,
        startedAt: Date.now(),
        toolUseId: 'tu1',
      },
      sessionId: '',
      seq: 1,
      ts: Date.now(),
    });
  }

  async sendPrompt(text: string) {
    this.delivered.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitHelper('running');
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'launched', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    void this.pullLoop();
  }

  private async pullLoop() {
    while (this.getNextSteer) {
      const next = await this.getNextSteer();
      if (!next) break;
      this.delivered.push(next.text);
      this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 4, ts: Date.now() });
      this.emitter.emit('event', { type: 'message', payload: { chunk: 'queued', final: true }, sessionId: '', seq: 5, ts: Date.now() });
      this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 6, ts: Date.now() });
    }
  }

  async stopHelper(taskId: string) {
    this.stoppedHelpers.push(taskId);
    this.emitHelper('stopped', taskId);
  }

  async stop() {
    this.stopCalled++;
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

const prompt = (projectId: string, conversationId: string, text: string) => ({
  projectId, conversationId, agent: 'claude-code' as const,
  model: 'claude-sonnet-4-6', profileId: 'claude-code:sonnet-4.6', text,
});

describe('SessionManager helpers lifetime', () => {
  it('(a) adopts a parked claude-code session that still has a running helper', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new ClaudeHelpersFakeAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });

    const first = await mgr.handlePrompt(prompt(projectId, conversationId, 'turn 1'));
    await new Promise((r) => setImmediate(r));
    expect(mgr.runningHelperCount(conversationId)).toBe(1);
    expect(adapter.stopCalled).toBe(0);

    const second = await mgr.handlePrompt(prompt(projectId, conversationId, 'turn 2'));
    await new Promise((r) => setImmediate(r));

    expect(second).toBe(first);
    expect(adapter.stopCalled).toBe(0);
    expect(adapter.delivered.some((t) => t.includes('turn 2'))).toBe(true);
  });

  it('(b) reaps the parked session once the helper completes', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new ClaudeHelpersFakeAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });

    const first = await mgr.handlePrompt(prompt(projectId, conversationId, 'turn 1'));
    await new Promise((r) => setImmediate(r));
    adapter.emitHelper('completed');
    expect(mgr.runningHelperCount(conversationId)).toBe(0);

    const second = await mgr.handlePrompt(prompt(projectId, conversationId, 'turn 2'));
    expect(second).not.toBe(first);
    expect(adapter.stopCalled).toBeGreaterThan(0);
  });

  it('(c) runningHelperCount follows running → completed', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new ClaudeHelpersFakeAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });

    await mgr.handlePrompt(prompt(projectId, conversationId, 'turn 1'));
    expect(mgr.runningHelperCount(conversationId)).toBe(1);
    adapter.emitHelper('completed');
    expect(mgr.runningHelperCount(conversationId)).toBe(0);
  });

  it('(d) reapParkedSessions({ all: true }) still stops a helper-holding session', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new ClaudeHelpersFakeAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });

    await mgr.handlePrompt(prompt(projectId, conversationId, 'turn 1'));
    expect(mgr.runningHelperCount(conversationId)).toBe(1);
    await mgr.reapParkedSessions(conversationId, { all: true });
    expect(adapter.stopCalled).toBeGreaterThan(0);
  });

  it('stopHelper forwards to the adapter and returns false without one', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new ClaudeHelpersFakeAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });

    await mgr.handlePrompt(prompt(projectId, conversationId, 'turn 1'));
    expect(await mgr.stopHelper(conversationId, 't1')).toBe(true);
    expect(adapter.stoppedHelpers).toEqual(['t1']);
    expect(await mgr.stopHelper('missing', 't1')).toBe(false);
  });
});
