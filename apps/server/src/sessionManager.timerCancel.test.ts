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
import {
  createTimer, getTimer, listPendingTimers, cancelPendingNonOperatorTimers,
} from './repositories/conversationTimers.js';
import { SessionManager } from './sessionManager.js';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

class StandardFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() { this.emitter.emit('end'); }
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

describe('[S2-2] fresh prompts cancel pending non-operator resume timers', () => {
  it('a fresh prompt cancels a pending agent-resume timer for that conversation', async () => {
    const { db, projectId, conversationId } = boot();
    registry.register('deepseek', () => new StandardFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const pending = createTimer(db, {
      conversationId, prompt: 'auto-resume after limit', profileId: 'deepseek:GLM-5.3',
      fireAtMs: Date.now() + 60_000, origin: 'agent-resume',
    });
    expect(listPendingTimers(db, conversationId).map((t) => t.id)).toEqual([pending.id]);

    await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'operator takes over',
    });

    expect(listPendingTimers(db, conversationId)).toEqual([]);
    expect(getTimer(db, pending.id)?.cancelledAt).not.toBeNull();
  });

  it('operator-origin timers survive a fresh prompt', async () => {
    const { db, projectId, conversationId } = boot();
    registry.register('deepseek', () => new StandardFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const operatorTimer = createTimer(db, {
      conversationId, prompt: 'remind me', profileId: 'deepseek:GLM-5.3',
      fireAtMs: Date.now() + 60_000, origin: 'operator',
    });

    await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'normal typed turn',
    });

    expect(getTimer(db, operatorTimer.id)?.cancelledAt).toBeNull();
    expect(listPendingTimers(db, conversationId).map((t) => t.id)).toEqual([operatorTimer.id]);
    // Sanity: the repo helper the wiring uses leaves operator rows alone.
    expect(cancelPendingNonOperatorTimers(db, conversationId, Date.now())).toBe(0);
  });
});
