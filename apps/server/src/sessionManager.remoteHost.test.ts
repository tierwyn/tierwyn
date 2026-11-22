import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { hostname as osHostname } from 'os';
import type { AgentAdapter, RemoteHostView, SessionConfig } from '@tierwyn/shared';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue, enableAllAgents } from './db/seed.js';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import { setDb } from './db/index.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { createPendingHost } from './repositories/remoteHosts.js';
import { updateGeneralSettings } from './repositories/settings.js';
import { SessionManager } from './sessionManager.js';

class FakeAdapter implements AgentAdapter {
  constructor(private prompts?: string[]) {}
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt(text?: string) {
    if (text !== undefined) this.prompts?.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'done', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
}

/** Turn adapter that never emits 'end': hold forever → still running; hold
 *  released → parked at a terminal 'done' status with the Map entry intact. */
class TrackingAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  sid = '';
  stopped = false;
  private letGo: () => void = () => {};
  private readonly hold = new Promise<void>((r) => { this.letGo = r; });
  releaseHold(): void { this.letGo(); }
  streamEvents() { return this.emitter; }
  async start(cfg: SessionConfig) { this.sid = cfg.sessionId; }
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    await this.hold;
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 2, ts: Date.now() });
  }
  async stop() {
    this.stopped = true;
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
}

async function until(pred: () => boolean, msg = 'waiting'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > 2000) throw new Error(msg);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sessionCount(db: Database, conversationId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE conversation_id = ?')
    .get(conversationId) as { c: number }).c;
}

function connectedView(id: string, installed: boolean, features: ('trust_repo_config' | any)[] = ['trust_repo_config']): RemoteHostView {
  return {
    id,
    name: 'box',
    state: 'connected',
    hello: {
      hostname: 'rh-t14-host',
      os: 'linux',
      listenPort: 9999,
      agents: { 'claude-code': { installed, methods: [] } },
      models: { 'claude-code': [] },
      features,
    },
    allowMcpSecrets: true,
    createdAt: Date.now(),
  };
}

describe('SessionManager remote host', () => {
  afterEach(() => {
    registry.setRemoteFactory(undefined);
  });

  function setup(opts?: { remoteMake?: () => AgentAdapter }) {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    setDb(db);
    catalogue.load(db);

    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    const remoteProject = createProject(db, { name: 'remote', rootPath: '/tmp/r', remoteHostId: host.id });
    const localProject = createProject(db, { name: 'local', rootPath: '/tmp/l' });
    const remoteConv = createConversation(db, { projectId: remoteProject.id, title: 'rc' });
    const localConv = createConversation(db, { projectId: localProject.id, title: 'lc' });

    const views = new Map<string, RemoteHostView>();
    const remoteCalls: { type: string; host: string }[] = [];
    const prompts: string[] = [];
    const make = opts?.remoteMake ?? (() => new FakeAdapter(prompts));
    registry.register('claude-code', make);
    registry.setRemoteFactory((type, opts) => {
      remoteCalls.push({ type, host: opts.remoteHostId });
      return make();
    });

    const sm = new SessionManager({
      broadcast: () => {},
      remoteHosts: { view: (id) => views.get(id) },
    });

    return { db, host, remoteProject, localProject, remoteConv, localConv, views, remoteCalls, prompts, sm };
  }

  const prompt = (projectId: string, conversationId: string) => ({
    projectId,
    conversationId,
    agent: 'claude-code' as const,
    model: 'claude-sonnet-4-6',
    profileId: 'claude-code:sonnet-4.6',
    text: 'hello',
  });

  it('remote project prompt creates adapter via remote factory with remoteHostId', async () => {
    const { host, remoteProject, remoteConv, views, remoteCalls, sm } = setup();
    views.set(host.id, connectedView(host.id, true));
    await sm.handlePrompt(prompt(remoteProject.id, remoteConv.id));
    expect(remoteCalls.some((c) => c.host === host.id && c.type === 'claude-code')).toBe(true);
  });

  it('rejects before createSession when host disconnected', async () => {
    const { db, host, remoteProject, remoteConv, views, sm } = setup();
    views.set(host.id, { ...connectedView(host.id, true), state: 'disconnected' });
    await expect(sm.handlePrompt(prompt(remoteProject.id, remoteConv.id)))
      .rejects.toThrow(/not available on host: host_disconnected/);
    expect(sessionCount(db, remoteConv.id)).toBe(0);
  });

  it('handleCommand rejects before createSession when host disconnected', async () => {
    const { db, host, remoteProject, remoteConv, views, sm } = setup();
    views.set(host.id, { ...connectedView(host.id, true), state: 'disconnected' });
    await expect(sm.handleCommand({
      projectId: remoteProject.id,
      conversationId: remoteConv.id,
      agent: 'claude-code',
      model: 'claude-sonnet-4-6',
      profileId: 'claude-code:sonnet-4.6',
      name: 'help',
    })).rejects.toThrow(/not available on host: host_disconnected/);
    expect(sessionCount(db, remoteConv.id)).toBe(0);
  });

  it('rejects agent_not_installed', async () => {
    const { db, host, remoteProject, remoteConv, views, sm } = setup();
    views.set(host.id, connectedView(host.id, false));
    await expect(sm.handlePrompt(prompt(remoteProject.id, remoteConv.id)))
      .rejects.toThrow(/not available on host: agent_not_installed/);
    expect(sessionCount(db, remoteConv.id)).toBe(0);
  });

  it('rejects untrusted remote project when host lacks trust_repo_config feature', async () => {
    const { db, host, remoteProject, remoteConv, views, sm } = setup();
    views.set(host.id, connectedView(host.id, true, []));
    await expect(sm.handlePrompt(prompt(remoteProject.id, remoteConv.id)))
      .rejects.toThrow(/Update tierwyn node on the remote host to run untrusted projects/);
    expect(sessionCount(db, remoteConv.id)).toBe(0);
  });

  it('local project unaffected', async () => {
    const { localProject, localConv, remoteCalls, sm } = setup();
    await sm.handlePrompt(prompt(localProject.id, localConv.id));
    expect(remoteCalls).toEqual([]);
  });

  it('remote prompt text contains remote hostname and not os.hostname()', async () => {
    const { host, remoteProject, remoteConv, views, prompts, sm } = setup();
    views.set(host.id, connectedView(host.id, true));
    await sm.handlePrompt(prompt(remoteProject.id, remoteConv.id));
    const text = prompts.join('\n');
    expect(text).toContain('rh-t14-host');
    expect(text).not.toContain(osHostname());
  });

  it('preamble port uses hello.listenPort', async () => {
    const { host, remoteProject, remoteConv, views, prompts, sm } = setup();
    views.set(host.id, connectedView(host.id, true));
    await sm.handlePrompt(prompt(remoteProject.id, remoteConv.id));
    expect(prompts.join('\n')).toContain('http://127.0.0.1:9999');
  });

  it('local prompt text is unchanged (no host note)', async () => {
    const { db, localProject, localConv, prompts, sm } = setup();
    updateGeneralSettings(db, { memories: true });
    await sm.handlePrompt(prompt(localProject.id, localConv.id));
    const text = prompts.join('\n');
    expect(text).toContain('hello');
    expect(text).not.toContain('You are running on host');
    expect(text).not.toContain('rh-t14-host');
    expect(text).not.toContain('http://127.0.0.1:9999');
  });

  it('reapParkedSessionsByHost stops parked sessions on that host only', async () => {
    const adapters: TrackingAdapter[] = [];
    const { db, host, remoteProject, remoteConv, views, sm } = setup({
      remoteMake: () => {
        const a = new TrackingAdapter();
        adapters.push(a);
        return a;
      },
    });
    const host2 = createPendingHost(db, 'box-2', 'h2', Date.now() + 60_000);
    const project2 = createProject(db, { name: 'remote-2', rootPath: '/tmp/r2', remoteHostId: host2.id });
    const conv2 = createConversation(db, { projectId: project2.id, title: 'rc2' });
    const holdConv = createConversation(db, { projectId: remoteProject.id, title: 'hold' });
    views.set(host.id, connectedView(host.id, true));
    views.set(host2.id, connectedView(host2.id, true));

    const sidOf = (convId: string) => (db.prepare('SELECT id FROM sessions WHERE conversation_id = ?')
      .get(convId) as { id: string }).id;

    await sm.handlePrompt(prompt(remoteProject.id, remoteConv.id));  // host 1
    adapters.find((a) => a.sid === sidOf(remoteConv.id))!.releaseHold(); // → parked at done
    void sm.handlePrompt(prompt(remoteProject.id, holdConv.id)).catch(() => {}); // held → still running
    await sm.handlePrompt(prompt(project2.id, conv2.id));            // host 2
    adapters.find((a) => a.sid === sidOf(conv2.id))!.releaseHold(); // → parked at done

    const parkedHost1 = sidOf(remoteConv.id);
    const runningHost1 = sidOf(holdConv.id);
    const parkedHost2 = sidOf(conv2.id);

    await until(() => {
      const act = sm.activeSessions();
      return act.some((s) => s.id === parkedHost1 && s.lastStatus === 'done')
        && act.some((s) => s.id === parkedHost2 && s.lastStatus === 'done')
        && act.some((s) => s.id === runningHost1 && s.lastStatus === 'running');
    }, 'sessions did not settle into parked/running states');

    await sm.reapParkedSessionsByHost(host.id);

    const remaining = sm.activeSessions().map((s) => s.id);
    expect(remaining).toContain(runningHost1);
    expect(remaining).toContain(parkedHost2);
    expect(remaining).not.toContain(parkedHost1);
    const bySid = (sid: string) => adapters.find((a) => a.sid === sid)!;
    expect(bySid(parkedHost1).stopped).toBe(true);
    expect(bySid(runningHost1).stopped).toBe(false);
    expect(bySid(parkedHost2).stopped).toBe(false);
  });
});
