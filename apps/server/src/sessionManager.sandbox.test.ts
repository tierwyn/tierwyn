import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue, enableAllAgents } from './db/seed.js';
import { catalogue } from './catalogue.js';
import { registry, type AdapterFactoryOpts } from './registry.js';
import { setDb } from './db/index.js';
import { createProject, updateProject } from './repositories/projects.js';
import { createConversation, setConversationSandbox } from './repositories/conversations.js';
import { putSandboxSettings } from './repositories/sandboxSettings.js';
import { createPendingHost } from './repositories/remoteHosts.js';
import { getSession } from './repositories/sessions.js';
import { listEventsForSession } from './repositories/events.js';
import { SessionManager } from './sessionManager.js';
import * as bwrap from './sandbox/bwrap.js';
import type { AgentAdapter, RemoteHostView, SessionConfig } from '@tierwyn/shared';
import { EventEmitter } from 'events';

describe('sessionManager sandbox', () => {
  beforeEach(() => {
    bwrap._resetBwrapProbeForTests();
    vi.spyOn(bwrap, 'bwrapAvailable').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bwrap._resetBwrapProbeForTests();
    registry.setRemoteFactory(undefined);
  });

  it('records session error via failTurn when bwrap is unavailable (does not throw to caller)', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);

    const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });
    setConversationSandbox(db, conv.id, 'on');

    const startSpy = vi.fn(async (_cfg: SessionConfig) => {});
    class BareAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start(cfg: SessionConfig) { await startSpy(cfg); }
      async sendPrompt() {}
      async stop() {}
      async listSessions() { return []; }
      async loadSession() {}
      async listModels() { return []; }
    }

    registry.register('claude-code', () => new BareAdapter());

    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as never);

    const sessionId = await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hi',
    });

    expect(sessionId).toBeTruthy();
    expect(getSession(db, sessionId)).toBeTruthy();

    await vi.waitFor(() => {
      const events = listEventsForSession(db, sessionId);
      return events.some((e) => e.type === 'error'
        && (e.payload as { message?: string }).message === 'sandbox_unavailable');
    });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('inherited on + hub cannot sandbox → unsandboxed turn + system notice (Q2)', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);
    putSandboxSettings(db, { global: true, defaults: [], hostPaths: {} });

    const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });

    const startSpy = vi.fn(async (_cfg: SessionConfig) => {});
    class BareAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start(cfg: SessionConfig) { await startSpy(cfg); }
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() {}
      async listSessions() { return []; }
      async loadSession() {}
      async listModels() { return []; }
    }
    registry.register('claude-code', () => new BareAdapter());
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as never);
    const sessionId = await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hi',
    });
    expect(startSpy).toHaveBeenCalled();
    await vi.waitFor(() => {
      const events = listEventsForSession(db, sessionId);
      return events.some((e) => e.type === 'message'
        && e.sender === 'system'
        && String((e.payload as { chunk?: string }).chunk).includes("host can't sandbox"));
    });
  });

  it('remote host without sandbox feature + inherited on → unsandboxed (Q2)', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);
    putSandboxSettings(db, { global: true, defaults: [], hostPaths: {} });

    const host = createPendingHost(db, 'vm', 'hash', Date.now() + 60_000);
    db.prepare("UPDATE remote_hosts SET status = 'trusted' WHERE id = ?").run(host.id);
    const project = createProject(db, { name: 'p', rootPath: '/tmp/p', remoteHostId: host.id });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });

    const captured: { sandbox?: boolean }[] = [];
    const startSpy = vi.fn(async () => {});
    class BareAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() { await startSpy(); }
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() {}
      async listSessions() { return []; }
      async loadSession() {}
      async listModels() { return []; }
    }
    registry.setRemoteFactory((_type, opts) => {
      captured.push({ sandbox: opts.sandbox });
      return new BareAdapter();
    });
    const views = new Map<string, RemoteHostView>();
    views.set(host.id, {
      id: host.id,
      name: 'vm',
      state: 'connected',
      hello: {
        agents: { 'claude-code': { installed: true, methods: [] } },
        models: { 'claude-code': [] },
        features: ['trust_repo_config'],
        sandbox: { policy: 'allow', available: true },
      },
      allowMcpSecrets: true,
      createdAt: Date.now(),
    } as RemoteHostView);

    const sm = new SessionManager({
      broadcast: () => {},
      getDb: () => db,
      remoteHosts: { view: (id) => views.get(id) },
    } as never);

    const sessionId = await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hi',
    });
    expect(captured[0]?.sandbox).toBe(false);
    expect(startSpy).toHaveBeenCalled();
    await vi.waitFor(() => {
      const events = listEventsForSession(db, sessionId);
      return events.some((e) => e.type === 'message'
        && e.sender === 'system'
        && String((e.payload as { chunk?: string }).chunk).includes("host can't sandbox"));
    });
  });

  it('applyConversationSandbox reaps parked sessions', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    setDb(db);

    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });
    const adapter = new (class implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {}
      async stop() {}
      async listSessions() { return []; }
      async loadSession() {}
      async listModels() { return []; }
    })();
    const sm = new SessionManager({ getDb: () => db } as never);
    const sessionId = 'parked-sandbox';
    (sm as { sessions: Map<string, unknown> }).sessions.set(sessionId, {
      id: sessionId,
      conversationId: conv.id,
      adapter,
      interactionMode: 'bypass',
      sandbox: false,
      turnActive: false,
      lastStatus: 'done',
      started: true,
      abortController: new AbortController(),
      steerQueue: [],
    });

    setConversationSandbox(db, conv.id, 'on');
    const res = await sm.applyConversationSandbox(conv.id);
    expect(res).toBe('reaped');
    expect(sm.activeSessions().some((s) => s.id === sessionId)).toBe(false);
  });

  it('passes hub host ∪ project custom paths into factory opts', async () => {
    vi.spyOn(bwrap, 'bwrapAvailable').mockReturnValue(true);
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);
    putSandboxSettings(db, {
      global: false,
      defaults: [],
      hostPaths: { hub: [{ path: '/srv/models', mode: 'rw' }] },
    });

    const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    updateProject(db, project.id, { sandboxPaths: [{ path: '/srv/models', mode: 'ro' }, { path: '/data/cache', mode: 'ro' }] });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });
    setConversationSandbox(db, conv.id, 'on');

    const captured: AdapterFactoryOpts[] = [];
    class BareAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() {}
      async listSessions() { return []; }
      async loadSession() {}
      async listModels() { return []; }
    }
    registry.register('claude-code', (opts) => {
      captured.push(opts ?? {});
      return new BareAdapter();
    });
    const sm = new SessionManager({ broadcast: () => {}, getDb: () => db } as never);
    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hi',
    });
    expect(captured[0]?.sandbox).toBe(true);
    expect(captured[0]?.sandboxPaths).toEqual([
      { path: '/srv/models', mode: 'ro' },
      { path: '/data/cache', mode: 'ro' },
    ]);
  });

  it('remote node with sandbox_paths forwards host ∪ project paths', async () => {
    vi.spyOn(bwrap, 'bwrapAvailable').mockReturnValue(true);
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);

    const host = createPendingHost(db, 'vm', 'hash', Date.now() + 60_000);
    db.prepare("UPDATE remote_hosts SET status = 'trusted' WHERE id = ?").run(host.id);
    putSandboxSettings(db, {
      global: false,
      defaults: [],
      hostPaths: { [host.id]: [{ path: '/work/models', mode: 'rw' }] },
    });
    const project = createProject(db, { name: 'p', rootPath: '/work/p', remoteHostId: host.id });
    updateProject(db, project.id, { sandboxPaths: [{ path: '/work/models', mode: 'ro' }, { path: '/work/cache', mode: 'ro' }] });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });
    setConversationSandbox(db, conv.id, 'on');

    const captured: AdapterFactoryOpts[] = [];
    class BareAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() {}
      async listSessions() { return []; }
      async loadSession() {}
      async listModels() { return []; }
    }
    registry.setRemoteFactory((_type, opts) => {
      captured.push(opts);
      return new BareAdapter();
    });
    const views = new Map<string, RemoteHostView>();
    views.set(host.id, {
      id: host.id,
      name: 'vm',
      state: 'connected',
      hello: {
        agents: { 'claude-code': { installed: true, methods: [] } },
        models: { 'claude-code': [] },
        features: ['sandbox', 'sandbox_paths', 'trust_repo_config'],
        sandbox: { policy: 'allow', available: true },
        sandboxPaths: { allow: 'rw' },
        roots: ['/work'],
        homedir: '/home/n',
      },
      allowMcpSecrets: true,
      createdAt: Date.now(),
    } as RemoteHostView);

    const sm = new SessionManager({
      broadcast: () => {},
      getDb: () => db,
      remoteHosts: { view: (id) => views.get(id) },
    } as never);
    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hi',
    });
    expect(captured[0]?.sandbox).toBe(true);
    expect(captured[0]?.sandboxPaths).toEqual([
      { path: '/work/models', mode: 'ro' },
      { path: '/work/cache', mode: 'ro' },
    ]);
  });

  it('old node + inherited sandbox + remote paths → sandboxed without extras + notice', async () => {
    vi.spyOn(bwrap, 'bwrapAvailable').mockReturnValue(true);
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);
    putSandboxSettings(db, { global: true, defaults: [], hostPaths: {} });

    const host = createPendingHost(db, 'vm', 'hash', Date.now() + 60_000);
    db.prepare("UPDATE remote_hosts SET status = 'trusted' WHERE id = ?").run(host.id);
    const project = createProject(db, { name: 'p', rootPath: '/work/p', remoteHostId: host.id });
    updateProject(db, project.id, { sandboxPaths: [{ path: '/work/models', mode: 'ro' }] });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });

    const captured: AdapterFactoryOpts[] = [];
    class BareAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() {}
      async listSessions() { return []; }
      async loadSession() {}
      async listModels() { return []; }
    }
    registry.setRemoteFactory((_type, opts) => {
      captured.push(opts);
      return new BareAdapter();
    });
    const views = new Map<string, RemoteHostView>();
    views.set(host.id, {
      id: host.id,
      name: 'vm',
      state: 'connected',
      hello: {
        agents: { 'claude-code': { installed: true, methods: [] } },
        models: { 'claude-code': [] },
        features: ['sandbox', 'trust_repo_config'],
        sandbox: { policy: 'allow', available: true },
        roots: ['/work'],
        homedir: '/home/n',
      },
      allowMcpSecrets: true,
      createdAt: Date.now(),
    } as RemoteHostView);

    const sm = new SessionManager({
      broadcast: () => {},
      getDb: () => db,
      remoteHosts: { view: (id) => views.get(id) },
    } as never);
    const sessionId = await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hi',
    });
    expect(captured[0]?.sandbox).toBe(true);
    expect(captured[0]?.sandboxPaths).toBeUndefined();
    await vi.waitFor(() => {
      const events = listEventsForSession(db, sessionId);
      const hit = events.some((e) => e.type === 'message'
        && e.sender === 'system'
        && String((e.payload as { chunk?: string }).chunk).includes('remote custom paths require a node update'));
      expect(hit).toBe(true);
    });
  });

  it('old node + explicit sandbox on + remote paths keeps paths for the proxy 501', async () => {
    vi.spyOn(bwrap, 'bwrapAvailable').mockReturnValue(true);
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);

    const host = createPendingHost(db, 'vm', 'hash', Date.now() + 60_000);
    db.prepare("UPDATE remote_hosts SET status = 'trusted' WHERE id = ?").run(host.id);
    const project = createProject(db, { name: 'p', rootPath: '/work/p', remoteHostId: host.id });
    updateProject(db, project.id, { sandboxPaths: [{ path: '/work/models', mode: 'ro' }] });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });
    setConversationSandbox(db, conv.id, 'on');

    const captured: AdapterFactoryOpts[] = [];
    class BareAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() {}
      async listSessions() { return []; }
      async loadSession() {}
      async listModels() { return []; }
    }
    registry.setRemoteFactory((_type, opts) => {
      captured.push(opts);
      return new BareAdapter();
    });
    const views = new Map<string, RemoteHostView>();
    views.set(host.id, {
      id: host.id,
      name: 'vm',
      state: 'connected',
      hello: {
        agents: { 'claude-code': { installed: true, methods: [] } },
        models: { 'claude-code': [] },
        features: ['sandbox', 'trust_repo_config'],
        sandbox: { policy: 'allow', available: true },
        roots: ['/work'],
        homedir: '/home/n',
      },
      allowMcpSecrets: true,
      createdAt: Date.now(),
    } as RemoteHostView);

    const sm = new SessionManager({
      broadcast: () => {},
      getDb: () => db,
      remoteHosts: { view: (id) => views.get(id) },
    } as never);
    await sm.handlePrompt({
      projectId: project.id,
      conversationId: conv.id,
      agent: 'claude-code',
      model: 'claude-sonnet',
      profileId: 'claude-code:sonnet-4.6',
      text: 'hi',
    });
    expect(captured[0]?.sandbox).toBe(true);
    expect(captured[0]?.sandboxPaths).toEqual([{ path: '/work/models', mode: 'ro' }]);
  });
});
