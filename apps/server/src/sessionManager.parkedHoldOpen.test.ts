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
import { createConversation, setConversationRules, setConversationTemplate } from './repositories/conversations.js';
import { saveTemplate } from './repositories/settings.js';
import { getLiveTokenForConversation } from './spawn/tokens.js';
import { SessionManager } from './sessionManager.js';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

class HoldOpenFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  public stopCalled = false;
  public lastOptions?: any;
  public lastRunCommandOptions?: any;
  public lastStartConfig?: SessionConfig;
  streamEvents() { return this.emitter; }
  async start(cfg: SessionConfig) { this.lastStartConfig = cfg; }
  async sendPrompt(_text: string, _attachments: any = [], _model?: string, _effort?: any, options?: any) {
    this.lastOptions = options;
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'done turn', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
  }
  async runCommand(name: string, args?: string, options?: any) {
    this.lastRunCommandOptions = options;
    await this.sendPrompt(args ? `/${name} ${args}` : `/${name}`, [], undefined, undefined, options);
  }
  async stop() {
    this.stopCalled = true;
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
}

class StandardFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {
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

describe('parked hold-open session adoption & handoff', () => {
  it('adopts parked session when continuing with same agent and profile', async () => {
    const { projectId, conversationId } = boot();
    const deepseekAdapter = new HoldOpenFakeAdapter();
    registry.register('deepseek', () => deepseekAdapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'turn 1',
    });

    expect(mgr.activeSessionForConversation(conversationId)?.id).toBe(firstSessionId);

    // Follow-up with same agent and profile
    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'turn 2',
    });

    expect(secondSessionId).toBe(firstSessionId);
    expect(deepseekAdapter.stopCalled).toBe(false);
  });

  it('stops parked session and does not adopt when switching to a different agent', async () => {
    const { projectId, conversationId } = boot();
    const deepseekAdapter = new HoldOpenFakeAdapter();
    const cursorAdapter = new StandardFakeAdapter();
    registry.register('deepseek', () => deepseekAdapter);
    registry.register('cursor', () => cursorAdapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'turn 1',
    });

    expect(firstSessionId).toBeTruthy();

    // Switch to a different agent
    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'cursor',
      model: 'composer-2.5', profileId: 'cursor:composer-2.5', text: 'turn 2',
      handoffOverride: 'summary',
    });

    expect(deepseekAdapter.stopCalled).toBe(true);
    expect(secondSessionId).not.toBe(firstSessionId);
  });

  it('stops parked session and does not adopt when switching profile within same agent', async () => {
    const { projectId, conversationId } = boot();
    const deepseekAdapter = new HoldOpenFakeAdapter();
    registry.register('deepseek', () => deepseekAdapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'turn 1',
    });

    // Switch model to GLM-5.3-Flash
    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3-Flash', profileId: 'deepseek:GLM-5.3-Flash', text: 'turn 2',
    });

    expect(deepseekAdapter.stopCalled).toBe(true);
    expect(secondSessionId).not.toBe(firstSessionId);
  });

  it('adopts parked antigravity session on the next same-profile prompt', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('antigravity', 'antigravity', 'antigravity', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('antigravity:test', 'antigravity', 'gemini-flash', 'antigravity:test', now);
    catalogue.load(db);

    const agyAdapter = new HoldOpenFakeAdapter();
    registry.register('antigravity', () => agyAdapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 1',
    });

    expect(mgr.activeSessionForConversation(conversationId)?.id).toBe(firstSessionId);

    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 2',
    });

    expect(secondSessionId).toBe(firstSessionId);
    expect(agyAdapter.stopCalled).toBe(false);

    await mgr.reapParkedSessions(conversationId);
    expect(agyAdapter.stopCalled).toBe(false);
  });

  it('prefixes updated operator rules on hold-open adoption and skips a second unchanged adopt', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('antigravity', 'antigravity', 'antigravity', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('antigravity:test', 'antigravity', 'gemini-flash', 'antigravity:test', now);
    catalogue.load(db);

    const agyAdapter = new HoldOpenFakeAdapter();
    registry.register('antigravity', () => agyAdapter);
    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 1',
    });
    const rec = (mgr as unknown as { sessions: Map<string, { rulesHash?: string; steerQueue: Array<{ text: string; adapterPrefix?: string }> }> })
      .sessions.get(firstSessionId)!;
    expect(rec.rulesHash).toBe('');

    setConversationRules(db, conversationId, 'always worktrees');
    const second = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 2',
    });
    expect(second).toBe(firstSessionId);
    expect(rec.steerQueue.some((q) => q.text === 'turn 2' && q.adapterPrefix?.includes('always worktrees'))).toBe(true);
    expect(rec.rulesHash).not.toBe('');

    const hashAfter = rec.rulesHash;
    rec.steerQueue.length = 0;
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 3',
    });
    expect(rec.rulesHash).toBe(hashAfter);
    expect(rec.steerQueue.every((q) => !q.adapterPrefix)).toBe(true);
  });

  it('reaps a parked hold-open session when going from none to options', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('antigravity', 'antigravity', 'antigravity', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('antigravity:test', 'antigravity', 'gemini-flash', 'antigravity:test', now);
    catalogue.load(db);

    const firstAdapter = new HoldOpenFakeAdapter();
    const secondAdapter = new HoldOpenFakeAdapter();
    const thirdAdapter = new HoldOpenFakeAdapter();
    let createCount = 0;
    registry.register('antigravity', () => {
      createCount++;
      if (createCount === 1) return firstAdapter;
      if (createCount === 2) return secondAdapter;
      return thirdAdapter;
    });

    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 1',
    });

    expect(mgr.activeSessionForConversation(conversationId)?.id).toBe(firstSessionId);
    expect(firstAdapter.stopCalled).toBe(false);

    // Turn 2 stages options -> must reap the parked session and spawn fresh
    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 2',
      options: { sandbox: true, mode: 'plan' },
    });

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(firstAdapter.stopCalled).toBe(true);
    expect(secondAdapter.lastOptions).toEqual({ sandbox: true, mode: 'plan' });

    // Turn 3: optionless turn following options turn must NOT adopt the flagged process
    const thirdSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 3',
    });

    expect(thirdSessionId).not.toBe(secondSessionId);
    expect(secondAdapter.stopCalled).toBe(true);
    expect(thirdAdapter.lastOptions).toBeUndefined();

    // Turn 4: optionless → optionless CAN adopt the clean parked process
    const fourthSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 4',
    });

    expect(fourthSessionId).toBe(thirdSessionId);
    expect(thirdAdapter.stopCalled).toBe(false);
  });

  it('adopts a parked hold-open session when the sticky option bag is identical', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('antigravity', 'antigravity', 'antigravity', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('antigravity:test', 'antigravity', 'gemini-flash', 'antigravity:test', now);
    catalogue.load(db);

    const adapters: HoldOpenFakeAdapter[] = [];
    registry.register('antigravity', () => {
      const a = new HoldOpenFakeAdapter();
      adapters.push(a);
      return a;
    });

    const mgr = new SessionManager({ broadcast: () => {} });
    const bag = { sandbox: true, mode: 'plan' };

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 1',
      options: bag,
    });

    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 2 sticky',
      options: { ...bag },
    });

    expect(secondSessionId).toBe(firstSessionId);
    expect(adapters[0].stopCalled).toBe(false);
    expect(adapters.length).toBe(1);
  });

  it('reaps a parked hold-open session when sandbox changes', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('grok-build', 'grok-build', 'grok-build', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('grok-build:test', 'grok-build', 'grok-4', 'grok-build:test', now);
    catalogue.load(db);

    const adapters: HoldOpenFakeAdapter[] = [];
    registry.register('grok-build', () => {
      const a = new HoldOpenFakeAdapter();
      adapters.push(a);
      return a;
    });

    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'grok-build',
      model: 'grok-4', profileId: 'grok-build:test', text: 'turn 1',
      options: { sandbox: 'workspace' },
    });

    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'grok-build',
      model: 'grok-4', profileId: 'grok-build:test', text: 'turn 2',
      options: { sandbox: 'strict' },
    });

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(adapters[0].stopCalled).toBe(true);
    expect(adapters.length).toBe(2);
  });

  it('reaps a parked hold-open session when going from options to none', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('antigravity', 'antigravity', 'antigravity', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('antigravity:test', 'antigravity', 'gemini-flash', 'antigravity:test', now);
    catalogue.load(db);

    const adapters: HoldOpenFakeAdapter[] = [];
    registry.register('antigravity', () => {
      const a = new HoldOpenFakeAdapter();
      adapters.push(a);
      return a;
    });

    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 1',
      options: { sandbox: true },
    });

    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 2',
    });

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(adapters[0].stopCalled).toBe(true);
  });

  it('throws validation error when prompt options are sent while a turn is in flight (MAJOR-1)', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('antigravity', 'antigravity', 'antigravity', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('antigravity:test', 'antigravity', 'gemini-flash', 'antigravity:test', now);
    catalogue.load(db);

    class InFlightFakeAdapter extends HoldOpenFakeAdapter {
      override async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        // Intentionally do not emit 'done' or 'end' - turn remains live
      }
    }

    const inFlightAdapter = new InFlightFakeAdapter();
    registry.register('antigravity', () => inFlightAdapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    // Start live turn
    const firstTurnPromise = mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 1',
    });
    await new Promise((r) => setTimeout(r, 20));

    // Attempting to send prompt options while turn is in-flight must throw
    await expect(
      mgr.handlePrompt({
        projectId, conversationId, agent: 'antigravity',
        model: 'gemini-flash', profileId: 'antigravity:test', text: 'turn 2 with options',
        options: { sandbox: true },
      }),
    ).rejects.toThrow('Prompt options cannot be applied while a turn is in flight');

    // Attempting to send command with prompt options while in-flight must also throw
    await expect(
      mgr.handleCommand({
        projectId, conversationId, agent: 'antigravity',
        model: 'gemini-flash', profileId: 'antigravity:test', name: 'status',
        options: { sandbox: true },
      }),
    ).rejects.toThrow('Prompt options cannot be applied while a turn is in flight');
  });

  it('threads prompt options to runCommand and respects appliedOptions adoption gate on commands (MAJOR-3)', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('antigravity', 'antigravity', 'antigravity', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('antigravity:test', 'antigravity', 'gemini-flash', 'antigravity:test', now);
    catalogue.load(db);

    const adapters: HoldOpenFakeAdapter[] = [];
    registry.register('antigravity', () => {
      const a = new HoldOpenFakeAdapter();
      adapters.push(a);
      return a;
    });

    const mgr = new SessionManager({ broadcast: () => {} });

    // Turn 1: command with options -> spawns adapters[0], options passed to runCommand
    const cmdSession1 = await mgr.handleCommand({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', name: 'review', args: 'diff',
      options: { sandbox: true },
    });
    expect(adapters[0].lastRunCommandOptions).toEqual({ sandbox: true });

    // Turn 2: command without options -> must NOT adopt adapters[0] (bag changed)
    const cmdSession2 = await mgr.handleCommand({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', name: 'status',
    });
    expect(cmdSession2).not.toBe(cmdSession1);
    expect(adapters[0].stopCalled).toBe(true);
    expect(adapters[1].lastRunCommandOptions).toBeUndefined();

    // Turn 3: command without options -> CAN adopt adapters[1] (identical empty bags)
    const cmdSession3 = await mgr.handleCommand({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', name: 'check',
    });
    expect(cmdSession3).toBe(cmdSession2);
    expect(adapters[1].stopCalled).toBe(false);
  });

  it('rejects invalid prompt options before creating any session row', async () => {
    const { db, projectId, conversationId } = boot();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
       VALUES (?, ?, ?, '', NULL, '{}', ?)`,
    ).run('antigravity', 'antigravity', 'antigravity', now);
    db.prepare(
      `INSERT OR REPLACE INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 1, '', ?)`,
    ).run('antigravity:test', 'antigravity', 'gemini-flash', 'antigravity:test', now);
    catalogue.load(db);

    const mgr = new SessionManager({ broadcast: () => {} });

    // Invalid JSON schema throws
    await expect(
      mgr.handlePrompt({
        projectId, conversationId, agent: 'antigravity',
        model: 'gemini-flash', profileId: 'antigravity:test', text: 'bad json',
        options: { jsonSchema: 'not-valid-json' },
      }),
    ).rejects.toThrow();

    // Value starting with dash throws
    await expect(
      mgr.handlePrompt({
        projectId, conversationId, agent: 'antigravity',
        model: 'gemini-flash', profileId: 'antigravity:test', text: 'bad flag',
        options: { mode: '-p' },
      }),
    ).rejects.toThrow();

    // No sessions created in DB
    const count = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c;
    expect(count).toBe(0);
  });

  it('reapParkedSessions with { all: true } reaps hold-open adapters', async () => {
    const { projectId, conversationId } = boot();
    const deepseekAdapter = new HoldOpenFakeAdapter();
    registry.register('deepseek', () => deepseekAdapter);

    const mgr = new SessionManager({ broadcast: () => {} });

    await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'turn 1',
    });

    // Default reap does not kill deepseek
    await mgr.reapParkedSessions(conversationId);
    expect(deepseekAdapter.stopCalled).toBe(false);

    // Reap with all: true kills deepseek
    await mgr.reapParkedSessions(conversationId, { all: true });
    expect(deepseekAdapter.stopCalled).toBe(true);
  });

  it('reaps parked hold-open session when model maxConcurrentSpawns upgrades token entitlement from schedule to spawn', async () => {
    const { db, projectId, conversationId } = boot();
    saveTemplate(db, {
      name: 'Mixed',
      roles: [{ role: 'Claude Opus 5.5', profileId: 'claude-code:claude-opus-5.5', when: 'review' }],
    });
    setConversationTemplate(db, conversationId, 'Mixed');
    db.prepare('UPDATE agent_models SET max_concurrent_spawns = NULL WHERE id = ?').run('deepseek:GLM-5.3');
    catalogue.load(db);

    const adapters: HoldOpenFakeAdapter[] = [];
    registry.register('deepseek', () => {
      const a = new HoldOpenFakeAdapter();
      adapters.push(a);
      return a;
    });

    const mgr = new SessionManager({ broadcast: () => {} });

    const firstSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'turn 1 without spawn cap',
    });
    expect(getLiveTokenForConversation(conversationId)?.scope.has('spawn')).toBe(false);

    // Operator enables maxConcurrentSpawns on the model while session is parked
    db.prepare('UPDATE agent_models SET max_concurrent_spawns = 3 WHERE id = ?').run('deepseek:GLM-5.3');
    catalogue.load(db);

    const secondSessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'deepseek',
      model: 'GLM-5.3', profileId: 'deepseek:GLM-5.3', text: 'turn 2 with spawn cap',
    });

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(adapters[0].stopCalled).toBe(true);
    expect(getLiveTokenForConversation(conversationId)?.scope.has('spawn')).toBe(true);
  });
});
