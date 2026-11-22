import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue, enableAllAgents } from './db/seed.js';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import { setDb } from './db/index.js';
import { createProject } from './repositories/projects.js';
import { createConversation, setConversationPermissionMode, setConversationTemplate } from './repositories/conversations.js';
import { updateCompactionSettings, saveTemplate } from './repositories/settings.js';
import { SessionManager, effectiveInteractionMode } from './sessionManager.js';
import { createSession, getSession } from './repositories/sessions.js';
import type { AgentAdapter, SessionConfig, ResolvedMcpServer } from '@tierwyn/shared';
import { EventEmitter } from 'events';

class TestAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  public currentMode?: string;
  public stopped = false;
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'done', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
  }
  async stop() {
    this.stopped = true;
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async setPermissionMode(mode: 'bypass' | 'questions' | 'prompt') {
    this.currentMode = mode;
  }
}

describe('effectiveInteractionMode', () => {
  it('returns override if specified', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c', permissionMode: 'questions' });

    expect(effectiveInteractionMode(db, conv.id, 'prompt')).toBe('prompt');
  });

  it('returns conversation permissionMode when set', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    updateCompactionSettings(db, { interactionMode: 'bypass' });
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c', permissionMode: 'prompt' });

    expect(effectiveInteractionMode(db, conv.id)).toBe('prompt');
  });

  it('falls back to compactionSettings when conversation permissionMode is null', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    updateCompactionSettings(db, { interactionMode: 'questions' });
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });

    expect(effectiveInteractionMode(db, conv.id)).toBe('questions');
  });

  it('falls back to bypass when no settings or conversation exist', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);

    expect(effectiveInteractionMode(db, 'nonexistent')).toBe('bypass');
  });
});

describe('applyConversationPermissionMode live switching', () => {
  it('calls adapter.setPermissionMode on live sessions', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    setDb(db);

    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c', permissionMode: 'bypass' });

    const adapter = new TestAdapter();
    const sm = new SessionManager({ getDb: () => db } as any);

    // Fake an active session in sm.sessions map
    const sessionId = 'test-session-1';
    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      adapter,
      interactionMode: 'bypass',
      turnActive: true,
      lastStatus: 'running',
      abortController: new AbortController(),
      pendingEvents: [],
      steerQueue: [],
    });

    // Update permission mode in db
    setConversationPermissionMode(db, conv.id, 'prompt');

    // Apply permission mode
    const res = await sm.applyConversationPermissionMode(conv.id);
    expect(res.applied).toBe('live');

    // Verify adapter.setPermissionMode was called
    expect(adapter.currentMode).toBe('prompt');
    const rec = (sm as any).sessions.get(sessionId);
    expect(rec.interactionMode).toBe('prompt');
  });

  it('reaps parked sessions when mode changes', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    setDb(db);

    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c', permissionMode: 'bypass' });

    // Adapter without setPermissionMode
    class BareAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      public stopped = false;
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {}
      async stop() { this.stopped = true; }
      async listSessions() { return []; }
      async loadSession() {}
    }

    const adapter = new BareAdapter();
    const sm = new SessionManager({ getDb: () => db } as any);

    // Fake a parked (turnActive: false, lastStatus: 'done') session
    const sessionId = 'test-session-parked';
    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      adapter,
      interactionMode: 'bypass',
      turnActive: false,
      lastStatus: 'done',
      started: true,
      abortController: new AbortController(),
      pendingEvents: [],
      steerQueue: [],
    });

    // Update mode to prompt
    setConversationPermissionMode(db, conv.id, 'prompt');

    // Apply permission mode
    const res = await sm.applyConversationPermissionMode(conv.id);
    expect(res.applied).toBe('reaped');

    expect(adapter.stopped).toBe(true);
    expect(sm.activeSessions().some((s) => s.id === sessionId)).toBe(false);
  });
});

describe('parked session adoption guard', () => {
  it('does not adopt parked session when conversation permission mode changes from questions to bypass', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);

    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c', permissionMode: 'questions' });

    const createdOpts: any[] = [];
    const oldAdapter = new TestAdapter();
    const newAdapter = new TestAdapter();

    registry.register('claude-code', (opts) => {
      createdOpts.push(opts);
      return newAdapter;
    });

    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    // Fake a parked session whose record interactionMode is 'questions'
    const parkedSessionId = 'parked-session-q';
    (sm as any).sessions.set(parkedSessionId, {
      id: parkedSessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter: oldAdapter,
      startedAt: Date.now(),
      interactionMode: 'questions',
      abortController: new AbortController(),
      started: true,
      steerQueue: [],
      injectable: false,
      turnActive: false,
      lastStatus: 'done',
      appliedOptions: {},
      steerOrigin: {
        projectId: project.id,
        conversationId: conv.id,
        agent: 'claude-code',
        model: 'claude-sonnet-4-6',
        profileId: 'claude-code:sonnet-4.6',
      },
    });

    // Conversation mode is updated to 'bypass'
    setConversationPermissionMode(db, conv.id, 'bypass');

    // Drive handlePrompt with claude-code
    const newSessionId = await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hello',
    });

    // Assert old session was stopped and NOT adopted
    expect(oldAdapter.stopped).toBe(true);
    expect(newSessionId).not.toBe(parkedSessionId);

    // Assert registry.create was called with interactionMode: 'bypass'
    expect(createdOpts[0]).toEqual({ interactionMode: 'bypass', sandbox: false });

    // Assert the new record carries the new effective mode
    const newRecord = (sm as any).sessions.get(newSessionId);
    expect(newRecord).toBeDefined();
    expect(newRecord.interactionMode).toBe('bypass');
  });

  it('does not adopt parked session when conversation permission mode changes from bypass to questions', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);

    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c', permissionMode: 'bypass' });

    const createdOpts: any[] = [];
    const oldAdapter = new TestAdapter();
    const newAdapter = new TestAdapter();

    registry.register('claude-code', (opts) => {
      createdOpts.push(opts);
      return newAdapter;
    });

    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    // Fake a parked session whose record interactionMode is 'bypass'
    const parkedSessionId = 'parked-session-b';
    (sm as any).sessions.set(parkedSessionId, {
      id: parkedSessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter: oldAdapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      steerQueue: [],
      injectable: false,
      turnActive: false,
      lastStatus: 'done',
      appliedOptions: {},
      steerOrigin: {
        projectId: project.id,
        conversationId: conv.id,
        agent: 'claude-code',
        model: 'claude-sonnet-4-6',
        profileId: 'claude-code:sonnet-4.6',
      },
    });

    // Conversation mode is updated to 'questions'
    setConversationPermissionMode(db, conv.id, 'questions');

    // Drive handlePrompt with claude-code
    const newSessionId = await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hello',
    });

    // Assert old session was stopped and NOT adopted
    expect(oldAdapter.stopped).toBe(true);
    expect(newSessionId).not.toBe(parkedSessionId);

    // Assert registry.create was called with interactionMode: 'questions'
    expect(createdOpts[0]).toEqual({ interactionMode: 'questions', sandbox: false });

    // Assert the new record carries the new effective mode
    const newRecord = (sm as any).sessions.get(newSessionId);
    expect(newRecord).toBeDefined();
    expect(newRecord.interactionMode).toBe('questions');
  });
});

describe('SessionManager WP-2.4 live controls', () => {
  function setupTestDb() {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c', permissionMode: 'bypass' });
    return { db, project, conv };
  }

  it('mid-turn profile switch: live-capable adapter switches in place without stopping', async () => {
    const { db, project, conv } = setupTestDb();
    const setModelLiveSpy = vi.fn().mockResolvedValue(undefined);
    class LiveAdapter extends TestAdapter {
      async setModelLive(model: string) { await setModelLiveSpy(model); }
    }
    const adapter = new LiveAdapter();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    const sessionId = 'sess-live-1';
    createSession(db, {
      id: sessionId,
      conversationId: conv.id,
      agentId: 'claude-code',
      agentModelId: 'claude-code:sonnet-4.6',
    });

    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      turnActive: true,
      lastStatus: 'running',
      steerQueue: [],
      pendingEvents: [],
      steerOrigin: {
        projectId: project.id,
        conversationId: conv.id,
        agent: 'claude-code',
        model: 'claude-sonnet-4-6',
        profileId: 'claude-code:sonnet-4.6',
      },
    });

    const steerSpy = vi.spyOn(sm, 'steerSession').mockResolvedValue(true as any);

    // Prompt for the same agent but switching profile to claude-code:opus-4.8
    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      profileId: 'claude-code:opus-4.8',
      text: 'switch to opus',
    });

    expect(adapter.stopped).toBe(false);
    expect(setModelLiveSpy).toHaveBeenCalledWith('claude-opus-4-8');
    expect(steerSpy).toHaveBeenCalledWith(sessionId, 'switch to opus', undefined, { recall: true });

    const rec = (sm as any).sessions.get(sessionId);
    expect(rec.profileId).toBe('claude-code:opus-4.8');
    expect(rec.model).toBe('claude-opus-4-8');
    expect(rec.steerOrigin.profileId).toBe('claude-code:opus-4.8');
    expect(rec.steerOrigin.model).toBe('claude-opus-4-8');

    // DB session updated
    const dbSess = getSession(db, sessionId);
    expect(dbSess?.agentModelId).toBe('claude-code:opus-4.8');
  });

  it('mid-turn profile switch: setModelLive rejects falls back to stopSession', async () => {
    const { db, project, conv } = setupTestDb();
    const setModelLiveSpy = vi.fn().mockRejectedValue(new Error('SDK setModel failed'));
    class LiveAdapter extends TestAdapter {
      async setModelLive(model: string) { await setModelLiveSpy(model); }
    }
    const adapter = new LiveAdapter();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    const sessionId = 'sess-live-fail';
    createSession(db, {
      id: sessionId,
      conversationId: conv.id,
      agentId: 'claude-code',
      agentModelId: 'claude-code:sonnet-4.6',
    });

    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      turnActive: true,
      lastStatus: 'running',
      steerQueue: [],
      pendingEvents: [],
      steerOrigin: {
        projectId: project.id,
        conversationId: conv.id,
        agent: 'claude-code',
        model: 'claude-sonnet-4-6',
        profileId: 'claude-code:sonnet-4.6',
      },
    });

    let newCreated = false;
    vi.spyOn(registry, 'create').mockImplementationOnce(() => {
      newCreated = true;
      return new TestAdapter();
    });

    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      profileId: 'claude-code:opus-4.8',
      text: 'switch to opus',
    });

    expect(adapter.stopped).toBe(true);
    expect(newCreated).toBe(true);
  });

  it('mid-turn profile switch: adapter without setModelLive falls back to stopSession', async () => {
    const { db, project, conv } = setupTestDb();
    // TestAdapter does NOT have setModelLive
    const adapter = new TestAdapter();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    const sessionId = 'sess-live-nobin';
    createSession(db, {
      id: sessionId,
      conversationId: conv.id,
      agentId: 'claude-code',
      agentModelId: 'claude-code:sonnet-4.6',
    });

    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      turnActive: true,
      lastStatus: 'running',
      steerQueue: [],
      pendingEvents: [],
    });

    let newCreated = false;
    vi.spyOn(registry, 'create').mockImplementationOnce(() => {
      newCreated = true;
      return new TestAdapter();
    });

    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      profileId: 'claude-code:opus-4.8',
      text: 'switch to opus',
    });

    expect(adapter.stopped).toBe(true);
    expect(newCreated).toBe(true);
  });

  it('mid-turn profile switch with prompt options falls back to stopSession instead of throwing PromptOptionError', async () => {
    const { db, project, conv } = setupTestDb();
    const setModelLiveSpy = vi.fn().mockResolvedValue(undefined);
    class LiveModelAdapter extends TestAdapter {
      async setModelLive(model: string) { setModelLiveSpy(model); }
    }
    const adapter = new LiveModelAdapter();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    const sessionId = 'sess-live-options';
    createSession(db, {
      id: sessionId,
      conversationId: conv.id,
      agentId: 'claude-code',
      agentModelId: 'claude-code:sonnet-4.6',
    });

    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      turnActive: true,
      lastStatus: 'running',
      steerQueue: [],
      pendingEvents: [],
      steerOrigin: {
        projectId: project.id,
        conversationId: conv.id,
        agent: 'claude-code',
        model: 'claude-sonnet-4-6',
        profileId: 'claude-code:sonnet-4.6',
      },
    });

    let newCreated = false;
    vi.spyOn(registry, 'create').mockImplementationOnce(() => {
      newCreated = true;
      return new TestAdapter();
    });

    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      profileId: 'claude-code:opus-4.8',
      text: 'switch to opus with option',
      options: { disableSlashCommands: true },
    });

    expect(setModelLiveSpy).not.toHaveBeenCalled();
    expect(adapter.stopped).toBe(true);
    expect(newCreated).toBe(true);
  });

  it('mid-turn profile switch: entitlement kind change falls back to stopSession (I1)', async () => {
    const { db, project, conv } = setupTestDb();
    saveTemplate(db, {
      name: 'tmpl-spawn',
      description: 'template with spawn',
      roles: [],
    });
    setConversationTemplate(db, conv.id, 'tmpl-spawn');

    const setModelLiveSpy = vi.fn().mockResolvedValue(undefined);
    class LiveModelAdapter extends TestAdapter {
      async setModelLive(model: string) { setModelLiveSpy(model); }
    }
    const adapter = new LiveModelAdapter();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    const sessionId = 'sess-live-entitlement';
    createSession(db, {
      id: sessionId,
      conversationId: conv.id,
      agentId: 'claude-code',
      agentModelId: 'claude-code:sonnet-4.6',
    });

    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      turnActive: true,
      lastStatus: 'running',
      steerQueue: [],
      pendingEvents: [],
      mcpHash: '',
      steerOrigin: {
        projectId: project.id,
        conversationId: conv.id,
        agent: 'claude-code',
        model: 'claude-sonnet-4-6',
        profileId: 'claude-code:sonnet-4.6',
      },
    });

    const origGetProfile = catalogue.getProfile.bind(catalogue);
    vi.spyOn(catalogue, 'getProfile').mockImplementation((id: string) => {
      const p = origGetProfile(id);
      if (!p) return undefined;
      if (id === 'claude-code:opus-4.8') {
        return { ...p, maxConcurrentSpawns: 0 };
      }
      return { ...p, maxConcurrentSpawns: 3 };
    });

    let newCreated = false;
    vi.spyOn(registry, 'create').mockImplementationOnce(() => {
      newCreated = true;
      return new TestAdapter();
    });

    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      profileId: 'claude-code:opus-4.8',
      text: 'switch to opus',
    });

    expect(setModelLiveSpy).not.toHaveBeenCalled();
    expect(adapter.stopped).toBe(true);
    expect(newCreated).toBe(true);
  });

  it('mid-turn profile switch: resolved MCP hash differs from session record falls back to stopSession (I1)', async () => {
    const { db, project, conv } = setupTestDb();
    const setModelLiveSpy = vi.fn().mockResolvedValue(undefined);
    class LiveModelAdapter extends TestAdapter {
      async setModelLive(model: string) { setModelLiveSpy(model); }
    }
    const adapter = new LiveModelAdapter();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    const sessionId = 'sess-live-mcphash';
    createSession(db, {
      id: sessionId,
      conversationId: conv.id,
      agentId: 'claude-code',
      agentModelId: 'claude-code:sonnet-4.6',
    });

    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      turnActive: true,
      lastStatus: 'running',
      steerQueue: [],
      pendingEvents: [],
      mcpHash: 'stale-mcp-hash-999',
      steerOrigin: {
        projectId: project.id,
        conversationId: conv.id,
        agent: 'claude-code',
        model: 'claude-sonnet-4-6',
        profileId: 'claude-code:sonnet-4.6',
      },
    });

    let newCreated = false;
    vi.spyOn(registry, 'create').mockImplementationOnce(() => {
      newCreated = true;
      return new TestAdapter();
    });

    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      profileId: 'claude-code:opus-4.8',
      text: 'switch to opus',
    });

    expect(setModelLiveSpy).not.toHaveBeenCalled();
    expect(adapter.stopped).toBe(true);
    expect(newCreated).toBe(true);
  });

  it('applyConversationMcpServers: swaps live on live-capable adapter returning true without reap', async () => {
    const { db, conv } = setupTestDb();
    const setMcpLiveSpy = vi.fn().mockResolvedValue(true);
    class LiveMcpAdapter extends TestAdapter {
      async setMcpServersLive(servers: ResolvedMcpServer[]) { return setMcpLiveSpy(servers); }
    }
    const adapter = new LiveMcpAdapter();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    const sessionId = 'sess-mcp-live';
    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      turnActive: true,
      lastStatus: 'running',
      steerQueue: [],
      pendingEvents: [],
      mcpHash: 'initial-hash',
    });

    const res = await sm.applyConversationMcpServers(conv.id);
    expect(res).toBe('live');
    expect(setMcpLiveSpy).toHaveBeenCalledTimes(1);
    expect(adapter.stopped).toBe(false);
    const rec = (sm as any).sessions.get(sessionId);
    // mcpHash updated
    expect(rec.mcpHash).toBeDefined();
  });

  it('applyConversationMcpServers: reaps when setMcpServersLive returns false', async () => {
    const { db, conv } = setupTestDb();
    const setMcpLiveSpy = vi.fn().mockResolvedValue(false);
    class LiveMcpAdapter extends TestAdapter {
      async setMcpServersLive(servers: ResolvedMcpServer[]) { return setMcpLiveSpy(servers); }
    }
    const adapter = new LiveMcpAdapter();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    const sessionId = 'sess-mcp-reap';
    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      adapter,
      startedAt: Date.now(),
      interactionMode: 'bypass',
      abortController: new AbortController(),
      started: true,
      turnActive: true,
      lastStatus: 'running',
      steerQueue: [],
      pendingEvents: [],
      mcpHash: 'initial-hash',
    });

    const parkedAdapter = new TestAdapter();
    const parkedId = 'sess-parked-sibling';
    (sm as any).sessions.set(parkedId, {
      id: parkedId,
      conversationId: conv.id,
      agentType: 'hermes',
      adapter: parkedAdapter,
      startedAt: Date.now(),
      abortController: new AbortController(),
      started: true,
      turnActive: false,
      lastStatus: 'done',
      steerQueue: [],
      pendingEvents: [],
    });

    const reapSpy = vi.spyOn(sm, 'reapParkedSessions');
    const res = await sm.applyConversationMcpServers(conv.id);
    expect(res).toBe('reaped');
    expect(setMcpLiveSpy).toHaveBeenCalledTimes(1);
    expect(reapSpy).toHaveBeenCalledWith(conv.id, { all: true });
    expect(parkedAdapter.stopped).toBe(true);
  });

  it('applyConversationMcpServers: returns none when no sessions exist, reaped when parked only', async () => {
    const { db, conv } = setupTestDb();
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as any);

    // No sessions at all
    const resNone = await sm.applyConversationMcpServers(conv.id);
    expect(resNone).toBe('none');

    // Parked session without setMcpServersLive
    const parkedAdapter = new TestAdapter();
    const sessionId = 'sess-parked-only';
    (sm as any).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      agentType: 'hermes',
      adapter: parkedAdapter,
      startedAt: Date.now(),
      abortController: new AbortController(),
      started: true,
      turnActive: false,
      lastStatus: 'done',
      steerQueue: [],
      pendingEvents: [],
    });

    const resReaped = await sm.applyConversationMcpServers(conv.id);
    expect(resReaped).toBe('reaped');
    expect(parkedAdapter.stopped).toBe(true);
  });
});


