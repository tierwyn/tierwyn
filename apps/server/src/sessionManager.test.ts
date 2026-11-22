import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings, enableAllAgents, ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from './db/seed.js';
import { setDb } from './db/index.js';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import { createProject } from './repositories/projects.js';
import { hostname as osHostname } from 'os';
import { createConversation, setConversationTemplate } from './repositories/conversations.js';
import { createSpawnEdge } from './repositories/spawnEdges.js';
import { getLiveTokenForConversation } from './spawn/tokens.js';
import { createRemoteAgentConversation } from './repositories/remoteAgents.js';
import { upsertDiscoveredModels } from './repositories/models.js';
import { listEventsForConversation } from './repositories/events.js';
import { getSession } from './repositories/sessions.js';
import { saveTemplate, updateCompactionSettings, addCustomDesignation, updateGeneralSettings } from './repositories/settings.js';
import { SessionManager } from './sessionManager.js';
import { beginProjectMove, endProjectMove, PROJECT_MOVING_ERROR } from './projectMove.js';
import { decodeFp } from './spawn/preamble-mode.js';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

class FakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  public cwd = '';
  streamEvents() { return this.emitter; }
  async start(cfg: SessionConfig) { this.cwd = cfg.cwd; }
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'hi', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() { this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() }); }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
  get nativeSessionId() { return 'native-fake'; }
}

/** Hold-open: emits done but not 'end', so the SessionRecord stays in the map. */
class HoldOpenFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  public stopped = 0;
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'tick', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
  }
  async stop() {
    this.stopped += 1;
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
  get nativeSessionId() { return 'native-holdopen'; }
}

/** Hold-open whose stop() hangs until released, so a test can pause prompt
 *  setup mid-gate (reap → stopSession) and mutate project state underneath. */
class GatedHoldOpenAdapter extends HoldOpenFakeAdapter {
  private gate: Promise<void> | undefined;
  holdStopOn(p: Promise<void>) { this.gate = p; }
  override async stop() {
    if (this.gate) await this.gate;
    await super.stop();
  }
}

/** Hold-open: status:done fires, but sendPrompt stays pending until the child closes. */
class HangAfterDoneAdapter implements AgentAdapter {
  protected emitter = new EventEmitter();
  public stopped = 0;
  public prompts: string[] = [];
  private resolveHang!: () => void;
  private hang = new Promise<void>((r) => { this.resolveHang = r; });
  constructor(private readonly stayRunning = false) {}
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt(text: string) {
    this.prompts.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    if (!this.stayRunning) {
      this.emitter.emit('event', { type: 'message', payload: { chunk: 'reply', final: true }, sessionId: '', seq: 2, ts: Date.now() });
      this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    }
    await this.hang;
  }
  async stop() {
    this.stopped += 1;
    this.resolveHang();
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
  get nativeSessionId() { return 'native-hang-after-done'; }
}

class CommandFakeAdapter extends FakeAdapter {
  async runCommand(_name: string, _args?: string) {
    const emitter = this.streamEvents();
    emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    emitter.emit('event', { type: 'message', payload: { chunk: 'cmd ok', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    emitter.emit('end');
  }
}

/** A fake whose turn stays open until finish() is called, so tests can steer
 *  a genuinely in-flight session. */
class PausedFakeAdapter implements AgentAdapter {
  protected emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    // intentionally does NOT emit 'end' — the test drives that via finish()
  }
  finish() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {}
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
  get nativeSessionId() { return 'native-fake'; }
}

/** Paused fake that also supports native injection. */
class InjectableFakeAdapter extends PausedFakeAdapter {
  public steered: string[] = [];
  private getNextSteer?: () => Promise<{ text: string } | null>;

  async steer(_text: string) {}

  async start(cfg: SessionConfig) {
    this.getNextSteer = cfg.getNextSteer;
    void this.pullLoop();
  }

  async pullLoop() {
    while (this.getNextSteer) {
      const next = await this.getNextSteer();
      if (!next) break;
      this.steered.push(next.text);
    }
  }
}

/** Injectable (profile.steer + adapter.steer) but does NOT call getNextSteer
 *  in start() — mirrors Hermes before the steer-loop fix, or any injectable
 *  adapter mid-sendPrompt before its loop parks a resolver. SessionManager
 *  must report 'queued' (not 'injected') so the operator sees the truth. */
class NoPollInjectableFakeAdapter extends PausedFakeAdapter {
  async steer(_text: string) {}
  // intentionally no pullLoop — no resolver ever parked
}

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  enableAllAgents(db);
  seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  registry.register('claude-code', () => new FakeAdapter());
  const p = createProject(db, { name: 'P', rootPath: '/tmp/proj' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  return { db, projectId: p.id, conversationId: c.id };
}

function insertProfile(db: DatabaseType, id: string, agentId: string, model: string) {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, created_at)
     VALUES (?, ?, ?, '', NULL, '{}', ?)`,
  ).run(agentId, agentId, agentId, now);
  db.prepare(
    `INSERT OR REPLACE INTO agent_models
     (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, created_at)
     VALUES (?, ?, ?, ?, NULL, 0, 0, 1, '', ?)`,
  ).run(id, agentId, model, id, now);
}

describe('SessionManager (phase 2)', () => {
  it('persists the prompt and all streamed events, broadcasts to the hub', async () => {
    const { db, projectId, conversationId } = boot();
    const broadcasts: { conversationId: string; type: string }[] = [];
    const mgr = new SessionManager({
      broadcast: (cid, frame) => broadcasts.push({ conversationId: cid, type: frame.type }),
    });

    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });

    // allow the async stream to drain
    await new Promise((r) => setTimeout(r, 20));

    const events = listEventsForConversation(db, conversationId);
    const types = events.map((e) => e.type);
    expect(types).toContain('prompt');     // user prompt persisted
    expect(types).toContain('message');    // agent output persisted
    expect(events.find((e) => e.type === 'prompt')!.sender).toBe('user');
    expect(broadcasts.some((b) => b.conversationId === conversationId && b.type === 'event')).toBe(true);
    expect(typeof sessionId).toBe('string');
  });

  it('persists schedule metadata on the prompt payload when provided', async () => {
    const { db, projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    const schedule = { jobId: 'job-1', jobName: 'nightly', runId: 'run-1' };
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'tick',
      schedule,
    });
    await new Promise((r) => setTimeout(r, 20));
    const prompt = listEventsForConversation(db, conversationId).find((e) => e.type === 'prompt')!;
    expect(prompt.sender).toBe('user');
    expect((prompt.payload as { schedule?: unknown }).schedule).toEqual(schedule);
  });

  it('handlePrompt rejects a profile whose agent is disabled', async () => {
    const { db, projectId, conversationId } = boot();
    db.prepare("UPDATE agents SET enabled_flag=0 WHERE id='claude-code'").run();
    catalogue.load(db);
    const mgr = new SessionManager({ broadcast: () => {} });
    await expect(mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    })).rejects.toThrow(/Unknown or disabled profile/);
    const n = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('handlePrompt rejects with PROJECT_MOVING_ERROR when project folder is being moved', async () => {
    const { projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    beginProjectMove(projectId);
    try {
      await expect(mgr.handlePrompt({
        projectId, conversationId, agent: 'claude-code',
        model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
      })).rejects.toThrow(PROJECT_MOVING_ERROR);
    } finally {
      endProjectMove(projectId);
    }
  });

  it('handlePrompt rejects when a move begins while prompt setup is still in flight (review N1)', async () => {
    const { projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });

    // Turn 1 parks a hold-open session; turn 2's gate reaps it, pausing setup
    // inside the gated stop() while the project move begins underneath.
    const hold = new GatedHoldOpenAdapter();
    registry.register('claude-code', () => hold);
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'first',
    });
    await new Promise((r) => setTimeout(r, 20)); // let turn 1 go parked (status done)

    let release!: () => void;
    hold.holdStopOn(new Promise<void>((r) => { release = r; }));
    const second = mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'second',
    });
    await new Promise((r) => setTimeout(r, 20)); // let turn 2 reach the gated stop

    beginProjectMove(projectId); // move starts mid-setup
    release();

    try {
      await expect(second).rejects.toThrow(PROJECT_MOVING_ERROR);
    } finally {
      endProjectMove(projectId);
    }
  });

  it('estimates token usage when adapter emits done without token fields', async () => {
    const { db, projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello world',
    });
    await new Promise((r) => setTimeout(r, 20));

    const meta = getSession(db, sessionId);
    expect(meta?.inputTokens).toBeGreaterThan(0);
    expect(meta?.outputTokens).toBeGreaterThan(0);
    expect(meta?.tokensEstimated).toBe(true);
  });

  it('does not overwrite CLI-reported token counts with estimates', async () => {
    class ReportingFakeAdapter extends FakeAdapter {
      async sendPrompt() {
        const emitter = this.streamEvents();
        emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        emitter.emit('event', {
          type: 'status',
          payload: { status: 'done', inputTokens: 500, outputTokens: 100 },
          sessionId: '', seq: 2, ts: Date.now(),
        });
        emitter.emit('end');
      }
    }
    const { db, projectId, conversationId } = boot();
    registry.register('claude-code', () => new ReportingFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'ignored for counts',
    });
    await new Promise((r) => setTimeout(r, 20));

    const meta = getSession(db, sessionId);
    expect(meta?.inputTokens).toBe(500);
    expect(meta?.outputTokens).toBe(100);
    expect(meta?.tokensEstimated).toBe(false);
  });

  it('writes inflight token estimates before the session completes', async () => {
    class StreamingFakeAdapter extends FakeAdapter {
      async sendPrompt() {
        const emitter = this.streamEvents();
        emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        emitter.emit('event', { type: 'message', payload: { chunk: 'hello there', final: false }, sessionId: '', seq: 2, ts: Date.now() });
        await new Promise((r) => setTimeout(r, 50));
        emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
        emitter.emit('end');
      }
    }
    const { db, projectId, conversationId } = boot();
    registry.register('claude-code', () => new StreamingFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello world',
    });

    // Wait for initial inflight write (after sendPrompt starts) but before done.
    await new Promise((r) => setTimeout(r, 30));
    const mid = getSession(db, sessionId);
    expect(mid?.inputTokens).toBeGreaterThan(0);
    expect(mid?.tokensEstimated).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    const final = getSession(db, sessionId);
    expect(final?.outputTokens).toBeGreaterThan(0);
    expect(final?.tokensEstimated).toBe(true);
  });

  it('finalizes tokenizer estimates when adapter stops with idle', async () => {
    class IdleStopFakeAdapter extends FakeAdapter {
      async sendPrompt() {
        const emitter = this.streamEvents();
        emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        emitter.emit('event', { type: 'message', payload: { chunk: 'partial answer', final: false }, sessionId: '', seq: 2, ts: Date.now() });
        emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 3, ts: Date.now() });
        emitter.emit('end');
      }
    }
    const { db, projectId, conversationId } = boot();
    registry.register('claude-code', () => new IdleStopFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello world',
    });
    await new Promise((r) => setTimeout(r, 20));

    const meta = getSession(db, sessionId);
    expect(meta?.outputTokens).toBeGreaterThan(0);
    expect(meta?.tokensEstimated).toBe(true);
  });

  it('includes tool I/O in tokenizer output estimates', async () => {
    class ToolHeavyFakeAdapter extends FakeAdapter {
      async sendPrompt() {
        const emitter = this.streamEvents();
        emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        emitter.emit('event', {
          type: 'tool_result',
          payload: { toolUseId: 't1', content: 'x'.repeat(4000), isError: false },
          sessionId: '', seq: 2, ts: Date.now(),
        });
        emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
        emitter.emit('end');
      }
    }
    const { db, projectId, conversationId } = boot();
    registry.register('claude-code', () => new ToolHeavyFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hi',
    });
    await new Promise((r) => setTimeout(r, 20));

    const meta = getSession(db, sessionId);
    expect(meta?.outputTokens).toBeGreaterThanOrEqual(500);
    expect(meta?.tokensEstimated).toBe(true);
  });

  it('records the native session id on the persisted session row', async () => {
    const { db, projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    const sessionId = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hi',
    });
    await new Promise((r) => setTimeout(r, 20));
    const row = db.prepare('SELECT native_session_id FROM sessions WHERE id = ?').get(sessionId) as { native_session_id: string };
    expect(row.native_session_id).toBe('native-fake');
  });

  it('reaps a parked hold-open session before starting a follow-up prompt', async () => {
    const { projectId, conversationId } = boot();
    const parked: HoldOpenFakeAdapter[] = [];
    registry.register('claude-code', () => {
      const a = new HoldOpenFakeAdapter();
      parked.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });
    const first = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'tick',
    });
    expect(mgr.activeSessionForConversation(conversationId)?.id).toBe(first);
    expect(parked[0]!.stopped).toBe(0);

    const second = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'Unlock the step',
    });
    expect(second).not.toBe(first);
    expect(parked[0]!.stopped).toBe(1);
    expect(mgr.activeSessionForConversation(conversationId)?.id).toBe(second);
  });

  it('adopts hold-open session when template is unchanged, but reaps when template changes', async () => {
    const { db, projectId, conversationId } = boot();
    insertProfile(db, 'antigravity:gemini-flash', 'antigravity', 'gemini-flash');
    db.prepare('UPDATE agent_models SET max_concurrent_spawns = 2, max_grandchild_spawns = 2 WHERE id = ?').run('antigravity:gemini-flash');
    catalogue.load(db);

    const parked: HoldOpenFakeAdapter[] = [];
    registry.register('antigravity', () => {
      const a = new HoldOpenFakeAdapter();
      parked.push(a);
      return a;
    });

    const mgr = new SessionManager({ broadcast: () => {} });

    // Turn 1: no template attached -> session 1 started
    const s1 = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:gemini-flash', text: 'hello',
    });
    expect(parked).toHaveLength(1);
    expect(parked[0]!.stopped).toBe(0);

    // Turn 2: same prompt options, template still null -> adopts parked session
    const s2 = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:gemini-flash', text: 'followup',
    });
    expect(s2).toBe(s1);
    expect(parked[0]!.stopped).toBe(0);

    // Now operator attaches template 'Mixed'
    saveTemplate(db, {
      name: 'Mixed',
      roles: [{ role: 'planner', profileId: 'antigravity:gemini-flash', when: 'planning' }],
    });
    setConversationTemplate(db, conversationId, 'Mixed');

    // Turn 3: template changed to Mixed -> must reap parked session and spawn fresh
    const s3 = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:gemini-flash', text: 'spawn delegates',
    });
    expect(s3).not.toBe(s1);
    expect(parked[0]!.stopped).toBe(1);
    expect(parked).toHaveLength(2);

    // Fresh session s3 should have spawn preamble fingerprint
    const sessRow = db.prepare('SELECT preamble_fp FROM sessions WHERE id = ?').get(s3) as { preamble_fp: string };
    expect(sessRow.preamble_fp).toMatch(/^spawn:/);

    // Turn 4: same template 'Mixed' -> adopts s3
    const s4 = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:gemini-flash', text: 'another followup',
    });
    expect(s4).toBe(s3);
    expect(parked[1]!.stopped).toBe(0);

    // Now operator edits template 'Mixed' definition in settings (adds a reviewer role)
    saveTemplate(db, {
      name: 'Mixed',
      roles: [
        { role: 'planner', profileId: 'antigravity:gemini-flash', when: 'planning' },
        { role: 'reviewer', profileId: 'antigravity:gemini-flash', when: 'review' },
      ],
    });

    // Turn 5: template definition changed -> must reap parked session again
    const s5 = await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:gemini-flash', text: 'with new roles',
    });
    expect(s5).not.toBe(s3);
    expect(parked[1]!.stopped).toBe(1);
    expect(parked).toHaveLength(3);
  });

  it('handleCommand calls adapter.runCommand with name and args', async () => {
    const { db, projectId, conversationId } = boot();
    let captured: CommandFakeAdapter | undefined;
    registry.register('claude-code', () => {
      const adapter = new CommandFakeAdapter();
      if (!captured) {
        captured = adapter;
        vi.spyOn(captured, 'runCommand');
      }
      return adapter;
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    await mgr.handleCommand({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8',
      name: 'commit', args: 'fix typo',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(captured!.runCommand).toHaveBeenCalledWith('commit', 'fix typo');

    const prompt = listEventsForConversation(db, conversationId).find((e) => e.type === 'prompt');
    expect(prompt!.sender).toBe('user');
    const payload = prompt!.payload as { text: string; commandName: string; commandArgs: string; attachments: unknown[] };
    expect(payload.text).toBe('/commit fix typo');
    expect(payload.commandName).toBe('commit');
    expect(payload.commandArgs).toBe('fix typo');
    expect(payload.attachments).toEqual([]);
  });

  it('handleCommand falls back to sendPrompt with slash text when runCommand is absent', async () => {
    const { projectId, conversationId } = boot();
    let captured: FakeAdapter | undefined;
    registry.register('claude-code', () => {
      const adapter = new FakeAdapter();
      if (!captured) {
        captured = adapter;
        vi.spyOn(captured, 'sendPrompt');
      }
      return adapter;
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    await mgr.handleCommand({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8',
      name: 'review',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(captured!.sendPrompt).toHaveBeenCalledWith('/review', [], 'claude-opus-4-8', undefined);
  });
});

describe('SessionManager concurrent starts', () => {
  it('does not open a second session when two prompts race on the same conversation', async () => {
    const { db, projectId, conversationId } = boot();
    registry.register('claude-code', () => new PausedFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    const input = {
      projectId, conversationId, agent: 'claude-code' as const,
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8',
    };

    const [id1, id2] = await Promise.all([
      mgr.handlePrompt({ ...input, text: 'one' }),
      mgr.handlePrompt({ ...input, text: 'two' }),
    ]);

    expect(id1).toBe(id2);
    expect(mgr.activeSessions().filter((s) => s.conversationId === conversationId)).toHaveLength(1);
    const prompts = listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(mgr.getSession(id1)!.steerQueue).toHaveLength(1);
  });
});

describe('SessionManager hanging sendPrompt (hold-open)', () => {
  const DS_ID = 'deepseek:chat';
  function seedDeepseek(db: Parameters<typeof insertProfile>[0]) {
    insertProfile(db, DS_ID, 'deepseek', 'chat');
    catalogue.load(db);
  }

  it('returns after sendPrompt is started even if the child never closes', async () => {
    const { db, projectId, conversationId } = boot();
    seedDeepseek(db);
    const hanging = new HangAfterDoneAdapter();
    registry.register('deepseek', () => hanging);
    const mgr = new SessionManager({ broadcast: () => {} });

    const sessionId = await mgr.handlePrompt({
      projectId, conversationId,
      agent: 'deepseek', model: 'chat',
      profileId: DS_ID, text: 'This is a tedt',
    });

    expect(typeof sessionId).toBe('string');
    const live = mgr.activeSessionForConversation(conversationId);
    expect(live?.id).toBe(sessionId);
    expect(live?.lastStatus).toBe('done');
    expect(hanging.stopped).toBe(0);
    await mgr.stopSession(sessionId);
  });

  it('stops a done-but-child-alive session when the next prompt uses a different profile', async () => {
    const { db, projectId, conversationId } = boot();
    seedDeepseek(db);
    const hanging = new HangAfterDoneAdapter();
    const grok = new FakeAdapter();
    registry.register('deepseek', () => hanging);
    registry.register('grok-build', () => grok);
    const mgr = new SessionManager({ broadcast: () => {} });

    const first = await mgr.handlePrompt({
      projectId, conversationId,
      agent: 'deepseek', model: 'chat',
      profileId: DS_ID, text: 'This is a tedt',
    });
    expect(mgr.activeSessionForConversation(conversationId)?.lastStatus).toBe('done');

    const second = await mgr.handlePrompt({
      projectId, conversationId,
      agent: 'grok-build', model: 'grok-4.5',
      profileId: 'grok-build:grok-4.5', text: 'Another test',
    });

    expect(hanging.stopped).toBe(1);
    expect(second).not.toBe(first);
    expect(typeof second).toBe('string');
  });

  it('stops an in-flight session rather than steering when the next prompt uses a different profile', async () => {
    const { db, projectId, conversationId } = boot();
    seedDeepseek(db);
    const hanging = new HangAfterDoneAdapter(true);
    const grok = new FakeAdapter();
    registry.register('deepseek', () => hanging);
    registry.register('grok-build', () => grok);
    const mgr = new SessionManager({ broadcast: () => {} });

    const first = await mgr.handlePrompt({
      projectId, conversationId,
      agent: 'deepseek', model: 'chat',
      profileId: DS_ID, text: 'still running',
    });
    expect(mgr.inFlightSessionForConversation(conversationId)?.id).toBe(first);

    const second = await mgr.handlePrompt({
      projectId, conversationId,
      agent: 'grok-build', model: 'grok-4.5',
      profileId: 'grok-build:grok-4.5', text: 'switch model',
    });

    expect(hanging.stopped).toBe(1);
    expect(second).not.toBe(first);
    expect(typeof second).toBe('string');
  });
});

describe('SessionManager steering', () => {
  it('queues a steer message when the adapter is not injectable and broadcasts steer_queued', async () => {
    const { projectId, conversationId } = boot();
    const made: PausedFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new PausedFakeAdapter(); made.push(a); return a; });
    const broadcasts: { type: string }[] = [];
    const mgr = new SessionManager({ broadcast: (_cid, frame) => broadcasts.push({ type: frame.type }) });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });

    const result = await mgr.steerSession(sid, 'also run the tests');
    expect(result.mode).toBe('queued');
    expect(result.queueLength).toBe(1);
    expect(broadcasts.some((b) => b.type === 'steer_queued')).toBe(true);
  });

  it('drains the queue into a follow-up turn when the turn ends', async () => {
    const { db, projectId, conversationId } = boot();
    const made: PausedFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new PausedFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    await mgr.steerSession(sid, 'follow up please');
    made[0].finish();                          // first turn ends → drain
    await new Promise((r) => setTimeout(r, 30)); // let the follow-up handlePrompt run

    const prompts = listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt');
    expect(prompts.map((p) => (p.payload as { text: string }).text)).toEqual(['hello', 'follow up please']);
    // handlePrompt creates multiple adapter instances internally (main + compactor + compact runner).
    // A follow-up turn creates more instances than a single turn, so made.length > 2 confirms drain happened.
    expect(made.length).toBeGreaterThan(2); // original turn + follow-up turn (each creates 2-3 instances)
  });

  it('injects natively when profile.steer and adapter.steer are present', async () => {
    const { db, projectId, conversationId } = boot();
    const made: InjectableFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new InjectableFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-sonnet-4-6', profileId: 'claude-code:sonnet-4.6', text: 'hello', // sonnet-4.6 has steer:true
    });
    const result = await mgr.steerSession(sid, 'steer me');
    await new Promise((r) => setTimeout(r, 10));

    expect(result.mode).toBe('injected');
    expect(made[0].steered).toEqual(['steer me']);
    // handlePrompt internally creates 2 instances (main + compactor) for a fresh session.
    // If a follow-up turn were spawned it would create 3+ more. Checking made.length === 2
    // confirms only one handlePrompt call ran (no follow-up dispatched).
    expect(made.length).toBe(2); // no follow-up turn; 2 = main + compactor from single handlePrompt
    const prompts = listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt' || e.type === 'steer');
    expect(prompts.map((p) => (p.payload as { text: string }).text)).toEqual(['hello', 'steer me']);
  });

  it('drains an unconsumed plain steer as a follow-up turn instead of discarding it', async () => {
    const { db, projectId, conversationId } = boot();
    const made: PausedFakeAdapter[] = [];
    // Injectable (profile steer:true + adapter.steer) but the steer loop never
    // pulls — the exact race where the turn ends with the steer still queued.
    class NeverPullsAdapter extends PausedFakeAdapter { async steer() {} }
    registry.register('claude-code', () => { const a = new NeverPullsAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-sonnet-4-6', profileId: 'claude-code:sonnet-4.6', text: 'hello',
    });
    await mgr.steerSession(sid, 'do not lose me');
    made[0].finish();
    await new Promise((r) => setTimeout(r, 30));

    const texts = listEventsForConversation(db, conversationId)
      .filter((e) => e.type === 'prompt' || e.type === 'steer')
      .map((e) => (e.payload as { text: string }).text);
    expect(texts).toContain('do not lose me');
  });

  it('clears the queue on stop so no follow-up turn is dispatched', async () => {
    const { projectId, conversationId } = boot();
    const made: PausedFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new PausedFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    await mgr.steerSession(sid, 'will be discarded');
    await mgr.stopSession(sid);
    made[0].finish();
    await new Promise((r) => setTimeout(r, 30));

    // handlePrompt internally creates 2 instances (main + compactor) for a fresh session.
    // If a follow-up turn were spawned it would create 3+ more. Checking made.length === 2
    // confirms only one handlePrompt call ran (no follow-up dispatched after stop cleared the queue).
    expect(made.length).toBe(2); // queue cleared → no follow-up; 2 = main + compactor from single handlePrompt
  });

  it('returns not_found for an unknown session', async () => {
    boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    const result = await mgr.steerSession('nope', 'hi');
    expect(result.mode).toBe('not_found');
  });

  it('reports queued (not injected) when an injectable adapter has no parked resolver', async () => {
    // Reproduces the Hermes bug: record.injectable is true (steer flag +
    // adapter.steer present) but the adapter never entered its steer loop,
    // so no resolver is parked on steerResolvers. Previously steerSession
    // returned mode 'injected' and the message vanished into a queue that
    // nothing drained. The fix returns 'queued' so the operator sees the
    // message sitting in the queue and the drain-on-turn-end fallback can
    // still deliver it as a follow-up prompt.
    const { projectId, conversationId } = boot();
    registry.register('claude-code', () => new NoPollInjectableFakeAdapter());
    const broadcasts: { type: string }[] = [];
    const mgr = new SessionManager({ broadcast: (_cid, frame) => broadcasts.push({ type: frame.type }) });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-sonnet-4-6', profileId: 'claude-code:sonnet-4.6', text: 'hello', // sonnet-4.6 has steer:true
    });

    const result = await mgr.steerSession(sid, 'should land in queue');

    expect(result.mode).toBe('queued');
    expect(result.queueLength).toBe(1);
    expect(broadcasts.some((b) => b.type === 'steer_queued')).toBe(true);
  });
});

/** Soft-cancel fake: injectable, no parked resolver during sendPrompt (Hermes-shaped).
 *  sendPrompt returns immediately (so handlePrompt can return the session id);
 *  interruptTurn / finish soft-end the turn and start the steer loop — no EventEmitter 'end'. */
class SoftCancelFakeAdapter extends PausedFakeAdapter {
  interruptCalls = 0;
  steered: string[] = [];
  steeredAttachments: Array<{ base64?: string; mediaType?: string; name?: string; tempPath?: string }[]> = [];
  private getNextSteer?: () => Promise<{ text: string; attachments?: unknown[] } | null>;
  private turnOpen = false;

  async steer(_text: string) {}

  async start(cfg: SessionConfig) {
    this.getNextSteer = cfg.getNextSteer;
  }

  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.turnOpen = true;
  }

  interruptTurn() {
    this.interruptCalls++;
    this.softEnd();
  }

  finish() {
    this.softEnd();
  }

  private softEnd() {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 2, ts: Date.now() });
    void this.pullLoop();
  }

  private async pullLoop() {
    while (this.getNextSteer) {
      const next = await this.getNextSteer();
      if (!next) break;
      this.steered.push(next.text);
      this.steeredAttachments.push(
        (next.attachments ?? []) as { base64?: string; mediaType?: string; name?: string; tempPath?: string }[],
      );
    }
    // Null from getNextSteer = structured-command drain or session end.
    // Real soft-cancel adapters (grok-build) emit 'end' here so SessionManager
    // can re-dispatch commandName queue items via handleCommand.
    this.emitter.emit('end');
  }

  async stop() {
    this.turnOpen = false;
    this.emitter.emit('end');
  }
}

describe('SessionManager Force Steer (intent)', () => {
  const STEER_PROFILE = {
    agent: 'claude-code' as const,
    model: 'claude-sonnet-4-6',
    profileId: 'claude-code:sonnet-4.6', // steer:true
  };

  it('intent omitted behaves like auto: injectable with parked resolver → injected', async () => {
    const { projectId, conversationId } = boot();
    const made: InjectableFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new InjectableFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    const result = await mgr.steerSession(sid, 'steer me');
    await new Promise((r) => setTimeout(r, 10));

    expect(result.mode).toBe('injected');
    expect(made[0].steered).toEqual(['steer me']);
  });

  it('intent omitted on non-injectable → queued', async () => {
    const { projectId, conversationId } = boot();
    registry.register('claude-code', () => new PausedFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    const result = await mgr.steerSession(sid, 'follow');
    expect(result.mode).toBe('queued');
  });

  it('editSteerMessage updates text in place and preserves queue order', async () => {
    const { projectId, conversationId } = boot();
    const broadcasts: Array<{ type?: string; queue?: Array<{ id: string; text: string }> }> = [];
    registry.register('claude-code', () => new PausedFakeAdapter());
    const mgr = new SessionManager({
      broadcast: (_cid, frame) => { broadcasts.push(frame as typeof broadcasts[number]); },
    });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    await mgr.steerSession(sid, 'first', undefined, { intent: 'queue' });
    await mgr.steerSession(sid, 'second', undefined, { intent: 'queue' });
    await mgr.steerSession(sid, 'third', undefined, { intent: 'queue' });

    const mid = mgr.getSession(sid)!.steerQueue[1]!;
    await mgr.editSteerMessage(conversationId, sid, mid.id, 'second edited', [
      { base64: 'abc', mediaType: 'text/plain', name: 'n.txt' },
    ]);

    const queue = mgr.getSession(sid)!.steerQueue;
    expect(queue.map((q) => q.text)).toEqual(['first', 'second edited', 'third']);
    expect(queue[1]!.id).toBe(mid.id);
    expect(queue[1]!.attachments).toEqual([{ base64: 'abc', mediaType: 'text/plain', name: 'n.txt' }]);

    const lastQueueFrame = [...broadcasts].reverse().find((f) => f.type === 'steer_queue');
    expect(lastQueueFrame?.queue?.map((q) => q.text)).toEqual(['first', 'second edited', 'third']);
  });

  it('editSteerMessage no-ops when the message is gone', async () => {
    const { projectId, conversationId } = boot();
    registry.register('claude-code', () => new PausedFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    await mgr.steerSession(sid, 'only', undefined, { intent: 'queue' });
    await mgr.editSteerMessage(conversationId, sid, 'missing-id', 'nope');

    expect(mgr.getSession(sid)!.steerQueue).toHaveLength(1);
    expect(mgr.getSession(sid)!.steerQueue[0]!.text).toBe('only');
  });

  it('editSteerMessage clears slash command fields when the replacement is plain text', async () => {
    const { projectId, conversationId } = boot();
    registry.register('claude-code', () => new PausedFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    await mgr.steerSession(sid, '/review src', undefined, {
      intent: 'queue', commandName: 'review', commandArgs: 'src',
    });
    const id = mgr.getSession(sid)!.steerQueue[0]!.id;
    await mgr.editSteerMessage(conversationId, sid, id, 'plain follow-up');

    expect(mgr.getSession(sid)!.steerQueue[0]).toMatchObject({ text: 'plain follow-up' });
    expect(mgr.getSession(sid)!.steerQueue[0]!.commandName).toBeUndefined();
    expect(mgr.getSession(sid)!.steerQueue[0]!.commandArgs).toBeUndefined();
  });

  it("intent:'queue' on injectable with parked resolver → queued, resolver not consumed", async () => {
    const { projectId, conversationId } = boot();
    const made: InjectableFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new InjectableFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    const result = await mgr.steerSession(sid, 'park me', undefined, { intent: 'queue' });
    await new Promise((r) => setTimeout(r, 10));

    expect(result.mode).toBe('queued');
    expect(result.queueLength).toBe(1);
    expect(made[0].steered).toEqual([]);
    const record = mgr.getSession(sid)!;
    expect(record.steerQueue).toHaveLength(1);
    expect(record.steerQueue[0].type).toBe('queue');
  });

  it("intent:'queue' on soft-cancel → drains via steer loop after turn ends (not stuck PENDING)", async () => {
    const { db, projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new SoftCancelFakeAdapter(); made.push(a); return a; });
    const broadcasts: Array<{ type?: string; queue?: unknown[] }> = [];
    const mgr = new SessionManager({
      broadcast: (_cid, frame) => { broadcasts.push(frame as { type?: string; queue?: unknown[] }); },
    });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Operator chose Queue mid-turn (modal default) — not Interrupt & Send.
    const result = await mgr.steerSession(sid, 'after this turn', undefined, { intent: 'queue' });
    expect(result.mode).toBe('queued');
    expect(mgr.getSession(sid)!.steerQueue).toHaveLength(1);

    // Natural end → soft-cancel steer loop must drain plain type:'queue'.
    // (Previously only source:'force' was isDrainable; Queue sat forever at IDLE.)
    made[0].finish();
    await new Promise((r) => setTimeout(r, 40));

    expect(made[0].steered).toEqual(['after this turn']);
    expect(mgr.getSession(sid)?.steerQueue).toHaveLength(0);

    const emptyQueueFrames = broadcasts.filter(
      (f) => f.type === 'steer_queue' && Array.isArray(f.queue) && f.queue.length === 0,
    );
    expect(emptyQueueFrames.length).toBeGreaterThanOrEqual(1);

    const userFacing = listEventsForConversation(db, conversationId)
      .filter((e) => e.type === 'prompt' || e.type === 'steer');
    expect(userFacing.map((e) => e.type)).toEqual(['prompt', 'prompt']);
    expect(userFacing[1].payload).toMatchObject({ text: 'after this turn' });
  });

  it("intent:'force' with interruptTurn → force_steered, interrupt once, source:force queue item", async () => {
    const { projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new SoftCancelFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    const result = await mgr.steerSession(sid, 'cut in', undefined, { intent: 'force' });

    expect(result.mode).toBe('force_steered');
    expect(made[0].interruptCalls).toBe(1);
    // Result reports the queue length at push time (before steer-loop drain).
    expect(result.queueLength).toBe(1);
    // Allow the soft-end steer loop to consume the force item.
    await new Promise((r) => setTimeout(r, 40));
    expect(made[0].steered).toEqual(['cut in']);
  });

  it("intent:'force' without interruptTurn → queued with message, no throw", async () => {
    const { projectId, conversationId } = boot();
    // Injectable but no interruptTurn
    registry.register('claude-code', () => new NoPollInjectableFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    const result = await mgr.steerSession(sid, 'please', undefined, { intent: 'force' });

    expect(result.mode).toBe('queued');
    expect(result.message).toMatch(/unsupported|queued/i);
    expect(result.queueLength).toBe(1);
  });

  it('force item drains via steer loop after soft interrupt (single delivery)', async () => {
    const { db, projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new SoftCancelFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    await mgr.steerSession(sid, 'redirect now', undefined, { intent: 'force' });
    // interruptTurn already released sendPrompt → steer loop should drain
    await new Promise((r) => setTimeout(r, 40));

    expect(made[0].steered).toEqual(['redirect now']);
    expect(mgr.getSession(sid)?.steerQueue).toHaveLength(0);

    // Force reinject must persist as prompt (new turn), not steer — otherwise
    // the UI nests it under the interrupted turn and the ⚡ divider looks like
    // a false mid-turn "Steer / Injection".
    const userFacing = listEventsForConversation(db, conversationId)
      .filter((e) => e.type === 'prompt' || e.type === 'steer');
    expect(userFacing.map((e) => e.type)).toEqual(['prompt', 'prompt']);
    expect(userFacing[1].payload).toMatchObject({ text: 'redirect now' });
  });

  it("intent:'force' with image → steer-loop delivery includes tempPath (Grok path refs)", async () => {
    const { projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new SoftCancelFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    // 1x1 PNG
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await mgr.steerSession(
      sid,
      'describe this',
      [{ base64: pngB64, mediaType: 'image/png', name: 'dot.png' }],
      { intent: 'force' },
    );
    await new Promise((r) => setTimeout(r, 40));

    expect(made[0].steered).toEqual(['describe this']);
    const atts = made[0].steeredAttachments[0] ?? [];
    expect(atts).toHaveLength(1);
    expect(atts[0].tempPath).toBeTruthy();
    expect(atts[0].tempPath).toMatch(/tierwyn-attachments/);
    expect(atts[0].mediaType).toBe('image/png');
  });

  it('race: natural done before cancel → force item drains once; interrupt is no-op', async () => {
    const { projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => { const a = new SoftCancelFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Natural finish first, then force (interrupt on already-finished turn)
    made[0].finish();
    await new Promise((r) => setTimeout(r, 20));

    const result = await mgr.steerSession(sid, 'late force', undefined, { intent: 'force' });
    expect(result.mode).toBe('force_steered');
    // interruptTurn still called (adapter no-ops if already done — SoftCancel counts it)
    await new Promise((r) => setTimeout(r, 40));

    expect(made[0].steered).toEqual(['late force']);
  });

  it('stopSession after Force Steer clears the source:force item', async () => {
    const { projectId, conversationId } = boot();
    // interruptTurn is a no-op (does not soft-end) so the force item stays queued
    // until hard Stop — mirrors "Force then Stop abandons the redirect".
    class InterruptNoOpFake extends NoPollInjectableFakeAdapter {
      interruptCalls = 0;
      interruptTurn() { this.interruptCalls++; }
    }
    const made: InterruptNoOpFake[] = [];
    registry.register('claude-code', () => { const a = new InterruptNoOpFake(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    const result = await mgr.steerSession(sid, 'will clear', undefined, { intent: 'force' });
    expect(result.mode).toBe('force_steered');
    expect(made[0].interruptCalls).toBe(1);
    expect(mgr.getSession(sid)!.steerQueue).toHaveLength(1);

    await mgr.stopSession(sid);
    made[0].finish();
    await new Promise((r) => setTimeout(r, 30));

    expect(mgr.getSession(sid)).toBeUndefined();
    // handlePrompt instances: main+compactor only — no follow-up drain after stop.
    expect(made.length).toBe(2);
  });
});

/** Hard-stop fake: no interruptTurn; stop() kills and emits EventEmitter 'end'
 *  (cursor / opencode / kilocode shape). */
class HardStopFakeAdapter extends PausedFakeAdapter {
  stopCalls = 0;
  async stop() {
    this.stopCalls++;
    this.emitter.emit('event', { type: 'status', payload: { status: 'idle' }, sessionId: '', seq: 9, ts: Date.now() });
    this.emitter.emit('end');
  }
}

describe('SessionManager Force Steer hard-stop (cursor/opencode/kilocode)', () => {
  const CURSOR_PROFILE = {
    agent: 'cursor' as const,
    model: 'composer-2.5',
    profileId: 'cursor:composer-2.5',
  };

  it("intent:'force' on hard-stop adapter → stop once, force_steered, drain reinjects text", async () => {
    const { db, projectId, conversationId } = boot();
    const made: HardStopFakeAdapter[] = [];
    registry.register('cursor', () => { const a = new HardStopFakeAdapter(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...CURSOR_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    const result = await mgr.steerSession(sid, 'cut in hard', undefined, { intent: 'force' });

    expect(result.mode).toBe('force_steered');
    expect(made[0].stopCalls).toBe(1);
    // No interruptTurn on this adapter
    expect(typeof (made[0] as unknown as { interruptTurn?: unknown }).interruptTurn).toBe('undefined');

    await new Promise((r) => setTimeout(r, 40));
    const prompts = listEventsForConversation(db, conversationId)
      .filter((e) => e.type === 'prompt')
      .map((e) => (e.payload as { text: string }).text);
    expect(prompts).toEqual(['hello', 'cut in hard']);
    // Original turn + follow-up (compactor is claude-code, not counted in `made`)
    expect(made.length).toBeGreaterThanOrEqual(2);
  });

  it("intent:'force' on non-hard non-soft → still queued with unsupported message", async () => {
    const { projectId, conversationId } = boot();
    // antigravity-shaped: paused, no interruptTurn, agentType not in HARD_STOP
    registry.register('claude-code', () => new PausedFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    const result = await mgr.steerSession(sid, 'please', undefined, { intent: 'force' });

    expect(result.mode).toBe('queued');
    expect(result.message).toMatch(/unsupported|queued/i);
  });

  it('operator stopSession still clears queue and does not auto-reinject after hard-stop force', async () => {
    const { projectId, conversationId } = boot();
    // stop() that does NOT emit end — so force path can push, then operator Stop
    // clears before any natural end. (Mirrors stopSession abort+clear before kill.)
    class StopNoEndFake extends PausedFakeAdapter {
      stopCalls = 0;
      async stop() { this.stopCalls++; /* no end — session stays until finish() */ }
    }
    const made: StopNoEndFake[] = [];
    registry.register('cursor', () => { const a = new StopNoEndFake(); made.push(a); return a; });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...CURSOR_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Queue a force item without going through hard-stop kill (simulate push then Stop)
    await mgr.steerSession(sid, 'parked', undefined, { intent: 'queue' });
    expect(mgr.getSession(sid)!.steerQueue).toHaveLength(1);

    await mgr.stopSession(sid);
    made[0].finish();
    await new Promise((r) => setTimeout(r, 30));

    expect(mgr.getSession(sid)).toBeUndefined();
    // Only the original cursor turn — no drain reinject (compactor is claude-code, not in `made`).
    expect(made.length).toBe(1);
  });

  it('queued structured slash after process-end adapters drains via handleCommand', async () => {
    const { db, projectId, conversationId } = boot();
    const runCommands: string[] = [];
    class EndAfterPromptFake extends PausedFakeAdapter {
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('event', { type: 'message', payload: { chunk: 'hi', final: true }, sessionId: '', seq: 2, ts: Date.now() });
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
        this.emitter.emit('end');
      }
      async runCommand(name: string, args?: string) {
        runCommands.push(name + (args ? ` ${args}` : ''));
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('event', { type: 'message', payload: { chunk: 'ok', final: true }, sessionId: '', seq: 2, ts: Date.now() });
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
        this.emitter.emit('end');
      }
    }
    // First session holds open so we can queue; follow-up uses EndAfterPromptFake for runCommand.
    let n = 0;
    registry.register('claude-code', () => {
      n++;
      if (n === 1) return new PausedFakeAdapter();
      return new EndAfterPromptFake();
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    await mgr.steerSession(sid, '/session-info', undefined, {
      intent: 'queue',
      commandName: 'session-info',
    });
    (mgr.getSession(sid)!.adapter as PausedFakeAdapter).finish();
    await new Promise((r) => setTimeout(r, 80));

    expect(runCommands).toEqual(['session-info']);
    const cmdPrompt = listEventsForConversation(db, conversationId)
      .filter((e) => e.type === 'prompt')
      .map((e) => e.payload as { commandName?: string })
      .find((p) => p.commandName === 'session-info');
    expect(cmdPrompt).toBeTruthy();
  });
});

describe('SessionManager structured slash queue drain', () => {
  const STEER_PROFILE = {
    agent: 'claude-code' as const,
    model: 'claude-sonnet-4-6',
    profileId: 'claude-code:sonnet-4.6',
  };

  it('queued structured slash (commandName) drains via handleCommand / runCommand after soft-cancel turn', async () => {
    const { db, projectId, conversationId } = boot();
    const runCommands: string[] = [];
    class SoftCancelCommandFake extends SoftCancelFakeAdapter {
      async runCommand(name: string, args?: string) {
        runCommands.push(args?.trim() ? `${name} ${args}` : name);
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('event', { type: 'message', payload: { chunk: 'compacted', final: true }, sessionId: '', seq: 2, ts: Date.now() });
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
        void this['pullLoop']();
      }
    }
    const made: SoftCancelCommandFake[] = [];
    registry.register('claude-code', () => {
      const a = new SoftCancelCommandFake();
      made.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    const result = await mgr.steerSession(sid, '/compact keep auth', undefined, {
      intent: 'queue',
      commandName: 'compact',
      commandArgs: 'keep auth',
    });
    expect(result.mode).toBe('queued');
    expect(mgr.getSession(sid)!.steerQueue[0]).toMatchObject({
      commandName: 'compact',
      commandArgs: 'keep auth',
      text: '/compact keep auth',
    });

    // Natural end → steer loop sees commandName → exits → end → handleCommand
    made[0].finish();
    await new Promise((r) => setTimeout(r, 100));

    expect(runCommands).toEqual(['compact keep auth']);
    const prompts = listEventsForConversation(db, conversationId)
      .filter((e) => e.type === 'prompt')
      .map((e) => e.payload as { text?: string; commandName?: string });
    expect(prompts.some((p) => p.commandName === 'compact')).toBe(true);
  });
});

describe('SessionManager mid-turn fresh new session queue drain', () => {
  const STEER_PROFILE = {
    agent: 'claude-code' as const,
    model: 'claude-sonnet-4-6',
    profileId: 'claude-code:sonnet-4.6',
  };

  it('stores handoffOverride on queuedItem when intent is queue', async () => {
    const { projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => {
      const a = new SoftCancelFakeAdapter();
      made.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 10));

    const result = await mgr.steerSession(sid, 'fresh start message', undefined, {
      intent: 'queue',
      handoffOverride: 'fresh',
    });
    expect(result.mode).toBe('queued');
    expect(mgr.getSession(sid)!.steerQueue[0]).toMatchObject({
      text: 'fresh start message',
      handoffOverride: 'fresh',
      type: 'queue',
    });
  });

  it('queued fresh item is not consumed in-process and drains as fresh turn with handoffOverride fresh', async () => {
    const { db, projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => {
      const a = new SoftCancelFakeAdapter();
      made.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'turn 1',
    });
    await new Promise((r) => setTimeout(r, 10));

    await mgr.steerSession(sid, 'turn 2 fresh', undefined, {
      intent: 'queue',
      handoffOverride: 'fresh',
    });

    const handlePromptSpy = vi.spyOn(mgr, 'handlePrompt');

    // Turn 1 ends naturally → steer loop sees handoffOverride → exits loop without consuming
    made[0].finish();
    await new Promise((r) => setTimeout(r, 100));

    // Assert turn 2 fresh was NOT consumed in-process by made[0]
    expect(made[0].steered).not.toContain('turn 2 fresh');

    // Assert handlePrompt was called with handoffOverride: 'fresh'
    const freshCall = handlePromptSpy.mock.calls.find((c) => c[0].text === 'turn 2 fresh');
    expect(freshCall).toBeDefined();
    expect(freshCall![0].handoffOverride).toBe('fresh');

    // And second session was created for the new turn (distinct session ID)
    const promptEvents = listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt');
    expect(promptEvents.length).toBe(2);
    expect(promptEvents[1].sessionId).not.toBe(sid);
  });

  it('queued fresh item while session is already parked at done is not consumed in-process and drains as fresh session', async () => {
    const { db, projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => {
      const a = new SoftCancelFakeAdapter();
      made.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'turn 1',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Finish turn 1 so adapter enters parked pullLoop waiting on getNextSteer
    made[0].finish();
    await new Promise((r) => setTimeout(r, 20));

    const handlePromptSpy = vi.spyOn(mgr, 'handlePrompt');

    // Steer while parked at done
    await mgr.steerSession(sid, 'parked fresh message', undefined, {
      intent: 'queue',
      handoffOverride: 'fresh',
    });
    await new Promise((r) => setTimeout(r, 100));

    // Not consumed in-process
    expect(made[0].steered).not.toContain('parked fresh message');

    // Drained via handlePrompt as fresh turn
    const freshCall = handlePromptSpy.mock.calls.find((c) => c[0].text === 'parked fresh message');
    expect(freshCall).toBeDefined();
    expect(freshCall![0].handoffOverride).toBe('fresh');

    const promptEvents = listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt');
    expect(promptEvents.length).toBe(2);
    expect(promptEvents[1].sessionId).not.toBe(sid);
  });

  it('mixed queue order [plain, fresh] delivers first plain in-process and fresh triggers exit', async () => {
    const { db, projectId, conversationId } = boot();
    const made: SoftCancelFakeAdapter[] = [];
    registry.register('claude-code', () => {
      const a = new SoftCancelFakeAdapter();
      made.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...STEER_PROFILE, text: 'initial',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Queue plain message first, then fresh message
    await mgr.steerSession(sid, 'plain mid-turn 1', undefined, { intent: 'queue' });
    await mgr.steerSession(sid, 'fresh mid-turn 2', undefined, { intent: 'queue', handoffOverride: 'fresh' });

    const handlePromptSpy = vi.spyOn(mgr, 'handlePrompt');

    made[0].finish();
    await new Promise((r) => setTimeout(r, 100));

    // First plain message was consumed in-process by made[0]
    expect(made[0].steered).toContain('plain mid-turn 1');
    // Fresh message was NOT consumed in-process by made[0]
    expect(made[0].steered).not.toContain('fresh mid-turn 2');

    // Fresh message drained as its own new session
    const freshCall = handlePromptSpy.mock.calls.find((c) => c[0].text === 'fresh mid-turn 2');
    expect(freshCall).toBeDefined();
    expect(freshCall![0].handoffOverride).toBe('fresh');
  });
});

describe('SessionManager prompt-event effort persistence (D7/B4)', () => {
  it('persists effective effort on prompt events for effort-capable adapters', async () => {
    const { db, projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
      effort: 'xhigh',
    });
    await new Promise((r) => setTimeout(r, 20));
    const prompt = listEventsForConversation(db, conversationId).find((e) => e.type === 'prompt');
    expect(prompt).toBeDefined();
    expect((prompt!.payload as { effort?: string }).effort).toBe('xhigh');
  });

  it('omits unsupported effort on codex when a raw max is requested (clampEffort)', async () => {
    // Client normally sends resolveEffort'd values (max→high before the wire).
    // Server clampEffort is defense-in-depth: unsupported levels are omitted so
    // the audit pill never claims a level the adapter did not receive.
    // Ceiling fallback (max→high) is tested on resolveEffort in packages/shared.
    const { db, projectId, conversationId } = boot();
    insertProfile(db, 'codex:test', 'codex', 'gpt-5');
    catalogue.load(db);
    registry.register('codex', () => new FakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'codex',
      model: 'gpt-5', profileId: 'codex:test', text: 'hello',
      effort: 'max',
    });
    await new Promise((r) => setTimeout(r, 20));
    const prompt = listEventsForConversation(db, conversationId).find((e) => e.type === 'prompt');
    expect(prompt).toBeDefined();
    expect((prompt!.payload as { effort?: string }).effort).toBeUndefined();
  });

  it('persists codex high when the client-clamped effective level is high', async () => {
    const { db, projectId, conversationId } = boot();
    insertProfile(db, 'codex:test2', 'codex', 'gpt-5');
    catalogue.load(db);
    registry.register('codex', () => new FakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'codex',
      model: 'gpt-5', profileId: 'codex:test2', text: 'hello',
      effort: 'high',
    });
    await new Promise((r) => setTimeout(r, 20));
    const prompt = listEventsForConversation(db, conversationId).find((e) => e.type === 'prompt');
    expect((prompt!.payload as { effort?: string }).effort).toBe('high');
  });

  it('persists antigravity medium (agy 1.1.27 --effort) and omits effort on opencode', async () => {
    const { db, projectId, conversationId } = boot();
    insertProfile(db, 'antigravity:test', 'antigravity', 'gemini-flash');
    insertProfile(db, 'opencode:test', 'opencode', 'default');
    catalogue.load(db);
    registry.register('antigravity', () => new FakeAdapter());
    registry.register('opencode', () => new FakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'antigravity',
      model: 'gemini-flash', profileId: 'antigravity:test', text: 'hello agy',
      effort: 'medium',
    });
    await new Promise((r) => setTimeout(r, 20));
    const prompt1 = listEventsForConversation(db, conversationId).find((e) => e.type === 'prompt');
    expect(prompt1).toBeDefined();
    expect((prompt1!.payload as { effort?: string }).effort).toBe('medium');

    await mgr.handlePrompt({
      projectId, conversationId, agent: 'opencode',
      model: 'default', profileId: 'opencode:test', text: 'hello opencode',
      effort: 'medium',
    });
    await new Promise((r) => setTimeout(r, 20));
    const prompts = listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt');
    expect(prompts.length).toBe(2);
    expect((prompts[1]!.payload as { effort?: string }).effort).toBeUndefined();
  });
});

describe('SessionManager.autoSendTranscript', () => {
  it('returns steered when a live turn exists and calls steerSession with no source', async () => {
    const { projectId, conversationId } = boot();
    registry.register('claude-code', () => new PausedFakeAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    const sid = await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'hello',
    });
    const steerSpy = vi.spyOn(mgr, 'steerSession');
    const outcome = mgr.autoSendTranscript(conversationId, 'hello from voice', null);
    expect(outcome).toBe('steered');
    expect(steerSpy).toHaveBeenCalledWith(sid, 'hello from voice', undefined, { recall: true });
    expect(steerSpy.mock.calls[0][3]).not.toHaveProperty('source');
  });

  it('returns new_turn with client ctx on a never-prompted conversation', async () => {
    const { projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    const hpSpy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('fake-sid');
    const outcome = mgr.autoSendTranscript(conversationId, 'dictated text', {
      profileId: 'claude-code:opus-4.8',
      agent: 'claude-code',
      model: 'claude-opus-4-8',
    });
    expect(outcome).toBe('new_turn');
    await new Promise((r) => setTimeout(r, 40));
    expect(hpSpy).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      conversationId,
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      profileId: 'claude-code:opus-4.8',
      text: 'dictated text',
      source: 'user',
    }));
  });

  it('returns new_turn from lastSessionForConversation when ctx is null', async () => {
    const { projectId, conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId, agent: 'claude-code',
      model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'seed',
    });
    await new Promise((r) => setTimeout(r, 30));
    const hpSpy = vi.spyOn(mgr, 'handlePrompt').mockResolvedValue('fake-sid');
    const outcome = mgr.autoSendTranscript(conversationId, 'follow-up dictate', null);
    expect(outcome).toBe('new_turn');
    await new Promise((r) => setTimeout(r, 40));
    expect(hpSpy).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      conversationId,
      agent: 'claude-code',
      profileId: 'claude-code:opus-4.8',
      text: 'follow-up dictate',
      source: 'user',
    }));
  });

  it('returns dropped when neither client ctx nor last session resolves', () => {
    const { conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    const hpSpy = vi.spyOn(mgr, 'handlePrompt');
    const steerSpy = vi.spyOn(mgr, 'steerSession');
    const outcome = mgr.autoSendTranscript(conversationId, 'orphan', null);
    expect(outcome).toBe('dropped');
    expect(hpSpy).not.toHaveBeenCalled();
    expect(steerSpy).not.toHaveBeenCalled();
  });

  it('returns dropped for invalid profileId without calling handlePrompt (Risk #4)', () => {
    const { conversationId } = boot();
    const mgr = new SessionManager({ broadcast: () => {} });
    const hpSpy = vi.spyOn(mgr, 'handlePrompt');
    const outcome = mgr.autoSendTranscript(conversationId, 'bad ctx', {
      profileId: 'does-not-exist',
      agent: 'claude-code',
      model: 'whatever',
    });
    expect(outcome).toBe('dropped');
    expect(hpSpy).not.toHaveBeenCalled();
  });
});

class CaptureFakeAdapter extends FakeAdapter {
  constructor(private prompts: string[]) { super(); }
  async isNativeSessionAvailable() { return true; }
  async sendPrompt(text: string) {
    this.prompts.push(text);
    return super.sendPrompt();
  }
}

function bootSpawnCapable() {
  const ctx = boot();
  const { db, conversationId } = ctx;
  db.prepare('UPDATE agent_models SET max_concurrent_spawns = 1 WHERE id = ?').run('claude-code:opus-4.8');
  db.prepare('UPDATE agent_models SET max_concurrent_spawns = 1 WHERE id = ?').run('grok-build:grok-4.6');
  catalogue.load(db);
  saveTemplate(db, {
    name: 'team',
    roles: [{ role: 'reviewer-alpha', profileId: 'claude-code:opus-4.8', when: 'deep correctness review' }],
  });
  setConversationTemplate(db, conversationId, 'team');
  return ctx;
}

function registerCapture(agentType: string, prompts: string[]) {
  registry.register(agentType, () => new CaptureFakeAdapter(prompts));
}

function readFp(db: DatabaseType, sessionId: string) {
  const row = db.prepare('SELECT preamble_fp FROM sessions WHERE id = ?').get(sessionId) as { preamble_fp: string | null };
  return decodeFp(row.preamble_fp ?? undefined);
}

function lastSent(prompts: string[]) {
  expect(prompts.length).toBeGreaterThan(0);
  return prompts[prompts.length - 1]!;
}

describe('SessionManager preamble stub/full injection', () => {
  const promptArgs = {
    agent: 'claude-code' as const,
    model: 'claude-opus-4-8',
    profileId: 'claude-code:opus-4.8',
  };

  it('first prompt in a spawn-capable conversation injects the roster and stores stubCount 0', async () => {
    const { db, projectId, conversationId } = bootSpawnCapable();
    const prompts: string[] = [];
    registerCapture('claude-code', prompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    const sid = await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'hello' });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(prompts);
    expect(sent).toContain('reviewer-alpha');
    expect(sent).toContain('hard allow-list');
    expect(sent).toContain('Optional designation');
    expect(sent).toContain('X-Spawn-Designation');
    const fp = readFp(db, sid);
    expect(fp?.stubCount).toBe(0);
    expect(fp?.base.startsWith('spawn:')).toBe(true);
  });

  it('second prompt on native resume with unchanged template injects a stub, not the roster', async () => {
    const { db, projectId, conversationId } = bootSpawnCapable();
    const prompts: string[] = [];
    registerCapture('claude-code', prompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    const first = await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'hello' });
    await new Promise((r) => setTimeout(r, 20));
    const firstSent = lastSent(prompts);
    expect(firstSent).toContain('reviewer-alpha');
    const firstTok = firstSent.match(/Bearer ([0-9a-f-]{36})/)?.[1];

    const second = await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'again' });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(prompts);
    expect(sent).toContain('rules unchanged');
    expect(sent).toContain('use only this one');
    expect(sent).not.toContain('reviewer-alpha');
    expect(sent).not.toContain('Roster lock');
    expect(sent).not.toContain('Optional designation');
    expect(sent).not.toContain('X-Spawn-Designation');
    const stubTok = sent.match(/use only this one:\*\* `([^`]+)`/)?.[1];
    expect(stubTok).toBeTruthy();
    expect(stubTok).not.toBe(firstTok);
    expect(readFp(db, first)?.stubCount).toBe(0);
    expect(readFp(db, second)?.stubCount).toBe(1);
  });

  it('native resume after template roles change re-injects the roster with stubCount 0', async () => {
    const { db, projectId, conversationId } = bootSpawnCapable();
    const prompts: string[] = [];
    registerCapture('claude-code', prompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    saveTemplate(db, {
      name: 'team',
      roles: [
        { role: 'reviewer-alpha', profileId: 'claude-code:opus-4.8', when: 'deep correctness review' },
        { role: 'impl-beta', profileId: 'claude-code:opus-4.8', when: 'implementation' },
      ],
    });

    const sid = await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'again' });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(prompts);
    expect(sent).toContain('reviewer-alpha');
    expect(sent).toContain('impl-beta');
    expect(sent).toContain('hard allow-list');
    expect(readFp(db, sid)?.stubCount).toBe(0);
  });

  it('native resume after designation catalogue change re-injects the roster with stubCount 0', async () => {
    const { db, projectId, conversationId } = bootSpawnCapable();
    const prompts: string[] = [];
    registerCapture('claude-code', prompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    const added = addCustomDesignation(db, 'auditor');
    expect(added.ok).toBe(true);

    const sid = await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'again' });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(prompts);
    expect(sent).toContain('Optional designation');
    expect(sent).toContain('auditor');
    expect(sent).toContain('hard allow-list');
    expect(readFp(db, sid)?.stubCount).toBe(0);
  });

  it('template removed between turns injects the full schedule-only block, not a stub', async () => {
    const { db, projectId, conversationId } = bootSpawnCapable();
    const prompts: string[] = [];
    registerCapture('claude-code', prompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    setConversationTemplate(db, conversationId, null);

    const sid = await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'again' });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(prompts);
    expect(sent).toContain('opt-in — not a standing task');
    expect(sent).not.toContain('rules unchanged');
    expect(sent).not.toContain('reviewer-alpha');
    const fp = readFp(db, sid);
    expect(fp?.base.startsWith('schedule:')).toBe(true);
    expect(fp?.stubCount).toBe(0);
  });

  it('an intervening handleCommand session with NULL fp does not break the stub chain', async () => {
    const { db, projectId, conversationId } = bootSpawnCapable();
    const prompts: string[] = [];
    registerCapture('claude-code', prompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    const cmdSid = await mgr.handleCommand({
      projectId, conversationId, ...promptArgs, name: 'review',
    });
    await new Promise((r) => setTimeout(r, 20));
    const cmdRow = db.prepare('SELECT preamble_fp FROM sessions WHERE id = ?').get(cmdSid) as { preamble_fp: string | null };
    expect(cmdRow.preamble_fp).toBeNull();

    const sid = await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'again' });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(prompts);
    expect(sent).toContain('rules unchanged');
    expect(sent).not.toContain('reviewer-alpha');
    expect(readFp(db, sid)?.stubCount).toBe(1);
  });

  it('non-native cross-adapter resume injects the full roster', async () => {
    const { db, projectId, conversationId } = bootSpawnCapable();
    updateCompactionSettings(db, { compactionEnabled: true });
    const claudePrompts: string[] = [];
    const grokPrompts: string[] = [];
    registerCapture('claude-code', claudePrompts);
    registerCapture('grok-build', grokPrompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({ projectId, conversationId, ...promptArgs, text: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    const sid = await mgr.handlePrompt({
      projectId, conversationId,
      agent: 'grok-build', model: 'grok-4.6', profileId: 'grok-build:grok-4.6',
      text: 'switch',
    });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(grokPrompts);
    expect(sent).toContain('reviewer-alpha');
    expect(sent).toContain('hard allow-list');
    expect(sent).not.toContain('rules unchanged');
    expect(readFp(db, sid)?.stubCount).toBe(0);
  });
});

describe('SessionManager — Remote Agents model lock', () => {
  const BOT_A = 'aaaaaaaa-1111-4222-8333-444444444444';
  const BOT_B = 'bbbbbbbb-1111-4222-8333-444444444444';

  function setupRemote() {
    const { db } = boot();
    ensureRemoteAgentsProject(db);
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_A, label: 'Bot A', provider: 'xai', vision: false, steer: true },
      { name: BOT_B, label: 'Bot B', provider: 'xai', vision: false, steer: true },
    ]);
    const conversationId = createRemoteAgentConversation(db, BOT_A, 'Remote Bot A');
    return { db, conversationId };
  }

  it('rejects grok-bot:default for Remote Agents conversation', async () => {
    const { conversationId } = setupRemote();
    const mgr = new SessionManager({ broadcast: () => {} });
    await expect(mgr.handlePrompt({
      projectId: REMOTE_AGENTS_PROJECT_ID,
      conversationId,
      agent: 'grok-bot',
      model: 'default',
      profileId: 'grok-bot:default',
      text: 'hi',
    })).rejects.toThrow('Active chat profile (grok-bot:default) cannot be used in Remote Agents container');
  });

  it('rejects non-grok model for Remote Agents conversation', async () => {
    const { conversationId } = setupRemote();
    const mgr = new SessionManager({ broadcast: () => {} });
    await expect(mgr.handlePrompt({
      projectId: REMOTE_AGENTS_PROJECT_ID,
      conversationId,
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      profileId: 'claude-code:opus-4.8',
      text: 'hi',
    })).rejects.toThrow('Model cannot be changed for Remote Agents conversations: must be grok-bot:<botId>');
  });

  it('rejects mismatching botId for Remote Agents conversation', async () => {
    const { conversationId } = setupRemote();
    const mgr = new SessionManager({ broadcast: () => {} });
    await expect(mgr.handlePrompt({
      projectId: REMOTE_AGENTS_PROJECT_ID,
      conversationId,
      agent: 'grok-bot',
      model: BOT_B,
      profileId: `grok-bot:${BOT_B}`,
      text: 'hi',
    })).rejects.toThrow(`Conversation is permanently bound to grok-bot:${BOT_A}`);
  });
});

describe('SessionManager grok-bot bare spawn child note', () => {
  it('injects RESULT path + host/cwd on a spawn-edged grok-bot child with no Bearer or token', async () => {
    const { db, projectId } = boot();
    updateGeneralSettings(db, { grokBotInProjectChats: true });
    const parent = createConversation(db, { projectId, title: 'parent' });
    const child = createConversation(db, {
      projectId, title: 'child', parentConversationId: parent.id,
    });
    createSpawnEdge(db, {
      parentConversationId: parent.id,
      childConversationId: child.id,
      role: 'Grok Bot Default',
      profileId: 'grok-bot:default',
      notifyParent: false,
    });
    const prompts: string[] = [];
    registerCapture('grok-bot', prompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId: child.id,
      agent: 'grok-bot', model: 'default', profileId: 'grok-bot:default',
      text: 'do the task',
    });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(prompts);
    const resultPath = `/tmp/proj/.tierwyn/delegates/grok-bot-default-${child.id.slice(0, 8)}-RESULT.md`;
    expect(sent).toContain(resultPath);
    expect(sent).toContain(osHostname());
    expect(sent).toContain('/tmp/proj');
    expect(sent).toContain('do the task');
    expect(sent).not.toMatch(/Bearer/i);
    expect(sent).not.toContain('You can delegate');
    expect(getLiveTokenForConversation(child.id)).toBeUndefined();
  });

  it('does not inject the child note when there is no spawn edge', async () => {
    const { db, projectId } = boot();
    updateGeneralSettings(db, { grokBotInProjectChats: true });
    const parent = createConversation(db, { projectId, title: 'parent' });
    const nested = createConversation(db, {
      projectId, title: 'nested', parentConversationId: parent.id,
    });
    const prompts: string[] = [];
    registerCapture('grok-bot', prompts);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId: nested.id,
      agent: 'grok-bot', model: 'default', profileId: 'grok-bot:default',
      text: 'plain chat',
    });
    await new Promise((r) => setTimeout(r, 20));
    const sent = lastSent(prompts);
    expect(sent).toBe('plain chat');
    expect(sent).not.toContain('RESULT.md');
  });
});

describe('SessionManager follow-up drain settle race (M2)', () => {
  const PROFILE = {
    agent: 'claude-code' as const,
    model: 'claude-opus-4-8',
    profileId: 'claude-code:opus-4.8',
  };

  it('hasPendingSteerWork stays true between adapter end and follow-up session register', async () => {
    const { projectId, conversationId } = boot();
    const first = new PausedFakeAdapter();
    const followUp = new PausedFakeAdapter();
    let n = 0;
    registry.register('claude-code', () => {
      n += 1;
      return n === 1 ? first : followUp;
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...PROFILE, text: 'turn 1',
    });
    await mgr.steerSession(sid, 'queued notify follow-up', undefined, { intent: 'queue' });

    let releaseFollowUp!: () => void;
    const holdFollowUp = new Promise<void>((r) => { releaseFollowUp = r; });
    let gapPending: boolean | undefined;
    let gapInFlight: boolean | undefined;
    const orig = mgr.handlePrompt.bind(mgr);
    vi.spyOn(mgr, 'handlePrompt').mockImplementation(async (input) => {
      gapPending = mgr.hasPendingSteerWork(conversationId);
      gapInFlight = mgr.inFlightSessionForConversation(conversationId) !== undefined;
      await holdFollowUp;
      return orig(input);
    });

    first.finish();
    await vi.waitFor(() => {
      expect(gapPending).toBeDefined();
    });
    expect(gapInFlight).toBe(false);
    expect(gapPending).toBe(true);

    const settled = { done: false };
    const settleP = mgr.waitForConversationSettle(conversationId, {
      hasOpenNotifyChildren: () => false,
      timeoutMs: 400,
      pollMs: 20,
    }).then(() => { settled.done = true; });

    await new Promise((r) => setTimeout(r, 80));
    expect(settled.done).toBe(false);

    releaseFollowUp();
    await vi.waitFor(() => {
      expect(mgr.inFlightSessionForConversation(conversationId)?.id).not.toBe(sid);
    });
    followUp.finish();
    await settleP;
  });

  it('drains a second queued follow-up without waiting on its own drain counter', async () => {
    const { db, projectId, conversationId } = boot();
    const first = new PausedFakeAdapter();
    let created = 0;
    registry.register('claude-code', () => {
      created += 1;
      return created === 1 ? first : new FakeAdapter();
    });
    const mgr = new SessionManager({ broadcast: () => {} });

    const sid = await mgr.handlePrompt({
      projectId, conversationId, ...PROFILE, text: 'turn 1',
    });
    await mgr.steerSession(sid, 'follow-up A', undefined, { intent: 'queue' });
    await mgr.steerSession(sid, 'follow-up B', undefined, { intent: 'queue' });
    first.finish();

    await vi.waitFor(() => {
      const prompts = listEventsForConversation(db, conversationId)
        .filter((e) => e.type === 'prompt')
        .map((e) => (e.payload as { text?: string }).text ?? '');
      expect(prompts.some((t) => t.includes('follow-up A'))).toBe(true);
      expect(prompts.some((t) => t.includes('follow-up B'))).toBe(true);
    }, { timeout: 2000 });
  });
});


