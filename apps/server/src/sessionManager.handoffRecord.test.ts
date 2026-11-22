import { describe, it, expect, vi } from 'vitest';
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
import { createSession } from './repositories/sessions.js';
import { appendEvent } from './repositories/events.js';
import { listHandoffs } from './repositories/handoffs.js';
import { SessionManager, recordHandoff } from './sessionManager.js';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

const PROFILE = 'claude-code:opus-4.8';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db); seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  const p = createProject(db, { name: 'P', rootPath: '/tmp/proj' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  return { db, projectId: p.id, conversationId: c.id };
}

function seedPrior(db: Database.Database, conversationId: string) {
  createSession(db, { id: 'prev', conversationId, agentId: 'claude-code', agentModelId: PROFILE });
  appendEvent(db, { sessionId: 'prev', type: 'prompt', payload: { text: 'hi' }, sender: 'user' });
  createSession(db, { id: 'cur', conversationId, agentId: 'claude-code', agentModelId: PROFILE });
}

const base = (conversationId: string) => ({
  conversationId, sessionId: 'cur', toProfileId: PROFILE, handoffMode: 'prompt',
});

describe('recordHandoff', () => {
  it('same profile + fresh override records a fresh/fresh row', () => {
    const { db, conversationId } = boot();
    seedPrior(db, conversationId);
    recordHandoff(db, { ...base(conversationId), handoffOverride: 'fresh', plan: { mode: 'fresh' } });
    const rows = listHandoffs(db, conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requested_mode: 'fresh', resolved_mode: 'fresh', priming_context: null });
  });

  it('same profile without override records nothing', () => {
    const { db, conversationId } = boot();
    seedPrior(db, conversationId);
    recordHandoff(db, { ...base(conversationId), handoffOverride: undefined, plan: { mode: 'fresh' } });
    expect(listHandoffs(db, conversationId)).toHaveLength(0);
  });

  it('native plan records nothing, even with an override', () => {
    const { db, conversationId } = boot();
    seedPrior(db, conversationId);
    recordHandoff(db, { ...base(conversationId), handoffOverride: 'summary', plan: { mode: 'native' } });
    expect(listHandoffs(db, conversationId)).toHaveLength(0);
  });
});

describe('live session backstop', () => {
  class LiveAdapter implements AgentAdapter {
    private emitter = new EventEmitter();
    streamEvents() { return this.emitter; }
    async start(_cfg: SessionConfig) {}
    async sendPrompt() {
      this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    }
    async stop() { this.emitter.emit('end'); }
    async listSessions() { return []; }
    async loadSession() {}
    async listModels() { return []; }
  }

  it('same-profile live session + handoffOverride stops the session and never steers', async () => {
    const { projectId, conversationId } = boot();
    registry.register('claude-code', () => new LiveAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    const input = { projectId, conversationId, agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE };
    const first = await mgr.handlePrompt({ ...input, text: 'turn 1' });
    expect(mgr.inFlightSessionForConversation(conversationId)?.id).toBe(first);

    const stop = vi.spyOn(mgr, 'stopSession');
    const steer = vi.spyOn(mgr, 'steerSession');
    const second = await mgr.handlePrompt({ ...input, text: 'turn 2', handoffOverride: 'fresh' });
    expect(second).not.toBe(first);
    expect(stop).toHaveBeenCalledWith(first);
    expect(steer).not.toHaveBeenCalled();
  });
});
