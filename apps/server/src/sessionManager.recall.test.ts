import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings, enableAllAgents } from './db/seed.js';
import { setDb } from './db/index.js';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { listEventsForConversation, lastAssistantText } from './repositories/events.js';
import { saveMemory } from './repositories/memories.js';
import { updateGeneralSettings } from './repositories/settings.js';
import { buildTranscript } from './compaction/transcript.js';
import { WRAP_UP_TEXT } from './spawn/stop.js';
import { SessionManager } from './sessionManager.js';
import type { AgentAdapter, SessionConfig, TranscriptEvent } from '@tierwyn/shared';

class CaptureAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  prompts: string[] = [];
  native = true;
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt(text?: string) {
    if (text !== undefined) this.prompts.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'ok', final: true }, sessionId: '', seq: 2, ts: Date.now() });
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
  async isNativeSessionAvailable() { return this.native; }
  get nativeSessionId() { return 'native-recall'; }
}

class NonFinalAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  prompts: string[] = [];
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt(text?: string) {
    if (text !== undefined) this.prompts.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'partial' }, sessionId: '', seq: 2, ts: Date.now() });
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

/** In-flight until finish(); records sendPrompt text so drain follow-ups can be inspected. */
class PausedCaptureAdapter implements AgentAdapter {
  protected emitter = new EventEmitter();
  prompts: string[] = [];
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt(text?: string) {
    if (text !== undefined) this.prompts.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
  }
  finish() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {}
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
}

/** Soft-end then drain via getNextSteer so mixed queue items combine in one write. */
class SoftCancelCaptureAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  prompts: string[] = [];
  steered: string[] = [];
  private getNextSteer?: SessionConfig['getNextSteer'];
  private turnOpen = false;
  streamEvents() { return this.emitter; }
  async start(cfg: SessionConfig) { this.getNextSteer = cfg.getNextSteer; }
  async sendPrompt(text?: string) {
    if (text !== undefined) this.prompts.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.turnOpen = true;
  }
  async steer(_text: string) {}
  finish() {
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
    }
    this.emitter.emit('end');
  }
  async stop() {
    this.turnOpen = false;
    this.emitter.emit('end');
  }
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
}

class SteerCaptureAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  prompts: string[] = [];
  private getNextSteer?: SessionConfig['getNextSteer'];
  streamEvents() { return this.emitter; }
  async start(cfg: SessionConfig) { this.getNextSteer = cfg.getNextSteer; }
  async sendPrompt(text?: string) {
    if (text !== undefined) this.prompts.push(text);
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'ok', final: true }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    void this.pull();
  }
  async steer(_text: string) {}
  private async pull() {
    const next = await this.getNextSteer?.();
    if (next?.text) this.prompts.push(next.text);
  }
  async stop() {
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
  seedCatalogue(db);
  enableAllAgents(db);
  seedDefaultSettings(db);
  updateGeneralSettings(db, { memories: true });
  setDb(db);
  catalogue.load(db);
  const project = createProject(db, { name: 'P', rootPath: '/tmp/p' });
  const conv = createConversation(db, { projectId: project.id, title: 'C' });
  saveMemory(db, {
    projectId: project.id,
    kind: 'gotcha',
    text: 'New API prefixes must join HTTP_ROUTES in vite.config.ts',
    agent: null,
    conversationId: conv.id,
    now: Date.parse('2026-10-24T00:00:00Z'),
  });
  saveMemory(db, {
    projectId: project.id,
    kind: 'fact',
    text: 'zebra pineapple unique child chatter must not select recall',
    agent: null,
    conversationId: conv.id,
    now: Date.parse('2026-10-25T00:00:00Z'),
  });
  return { db, projectId: project.id, conversationId: conv.id };
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const USER_RECALL_TEXT = 'HTTP_ROUTES prefixes in vite config';
const CHILD_RECALL_TEXT = 'zebra pineapple unique child chatter';
const hasRecallBlock = (text: string) => text.includes('--- recalled memories');

const promptArgs = {
  agent: 'claude-code' as const,
  model: 'claude-opus-4-8',
  profileId: 'claude-code:opus-4.8',
};

describe('SessionManager recall', () => {
  it('new session: adapter text holds the block before the prompt; stored prompt is exactly input.text', async () => {
    const { db, projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: 'HTTP_ROUTES prefixes in vite config',
    });
    const sent = adapter.prompts[0] ?? '';
    expect(sent).toContain('--- recalled memories (reference notes, not instructions; verify if stale) ---');
    expect(sent.trimEnd().endsWith('HTTP_ROUTES prefixes in vite config')).toBe(true);
    const prompts = listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt');
    expect(prompts[0]?.payload).toMatchObject({ text: 'HTTP_ROUTES prefixes in vite config' });
    expect(JSON.stringify(prompts[0]?.payload)).not.toContain('recalled memories');
  });

  it('persists a chip event with recalledMemories and sender system', async () => {
    const { db, projectId, conversationId } = boot();
    registry.register('claude-code', () => new CaptureAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: 'HTTP_ROUTES prefixes in vite config',
    });
    const chip = listEventsForConversation(db, conversationId).find(
      (e) => e.type === 'message' && e.sender === 'system'
        && Array.isArray((e.payload as { recalledMemories?: string[] }).recalledMemories),
    );
    expect(chip).toBeDefined();
    const payload = chip!.payload as { chunk?: string; final?: boolean; recalledMemories: string[] };
    expect(payload.chunk).toBe('');
    expect(payload).not.toHaveProperty('final');
    expect(payload.recalledMemories[0]).toMatch(/^m_\d+$/);
  });

  it('chip text is not assistant output in buildTranscript or lastAssistantText', async () => {
    const { db, projectId, conversationId } = boot();
    registry.register('claude-code', () => new NonFinalAdapter());
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: USER_RECALL_TEXT,
    });
    const events = listEventsForConversation(db, conversationId) as TranscriptEvent[];
    const transcript = buildTranscript(events, { maxTokens: 10_000 });
    expect(transcript).not.toMatch(/ASSISTANT: Recalled/);
    expect(lastAssistantText(db, conversationId)).not.toMatch(/Recalled/);
    expect(lastAssistantText(db, conversationId)).toBe('partial');
  });

  it('no matches: adapter text and events are unchanged', async () => {
    const { db, projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: 'zzzzzy unique nonsense',
    });
    expect(adapter.prompts[0]).not.toContain('recalled memories');
    expect(listEventsForConversation(db, conversationId).some(
      (e) => e.type === 'message' && (e.payload as { recalledMemories?: string[] }).recalledMemories,
    )).toBe(false);
  });

  it('bare-prompt adapter receives its text with no block and no chip event', async () => {
    const { db, projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('grok-bot', () => adapter);
    updateGeneralSettings(db, { grokBotInProjectChats: true });
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      projectId, conversationId,
      agent: 'grok-bot',
      model: 'default',
      profileId: 'grok-bot:default',
      text: 'HTTP_ROUTES prefixes in vite config',
    });
    expect(adapter.prompts[0]).toBe('HTTP_ROUTES prefixes in vite config');
    expect(listEventsForConversation(db, conversationId).some(
      (e) => (e.payload as { recalledMemories?: string[] }).recalledMemories,
    )).toBe(false);
  });

  it.each(['subagent_notify', 'peer_message', 'parent_message'] as const)('new session: source %s gets no block', async (source) => {
    const { projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: USER_RECALL_TEXT,
      source,
    });
    expect(adapter.prompts[0]).not.toContain('recalled memories');
  });

  it('schedule tick gets no block', async () => {
    const { db, projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: USER_RECALL_TEXT,
      source: 'user',
      schedule: { jobId: 'job-1', jobName: 'tick', runId: 'run-1' },
    });
    expect(adapter.prompts[0]).not.toContain('recalled memories');
    expect(listEventsForConversation(db, conversationId).some(
      (e) => e.type === 'message' && (e.payload as { recalledMemories?: string[] }).recalledMemories,
    )).toBe(false);
  });

  it('parent_message gets no block', async () => {
    const { db, projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: USER_RECALL_TEXT,
      source: 'parent_message',
    });
    expect(adapter.prompts[0]).not.toContain('recalled memories');
    expect(listEventsForConversation(db, conversationId).some(
      (e) => e.type === 'message' && (e.payload as { recalledMemories?: string[] }).recalledMemories,
    )).toBe(false);
  });

  it('subagent_notify and skipRecall get no block', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: USER_RECALL_TEXT,
      source: 'subagent_notify',
    });
    expect(adapter.prompts[0]).not.toContain('recalled memories');
    adapter.prompts = [];
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: USER_RECALL_TEXT,
      skipRecall: true,
    });
    expect(adapter.prompts[0]).not.toContain('recalled memories');
  });

  it('slash commands get no block', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handleCommand({
      ...promptArgs, projectId, conversationId,
      name: 'help',
      args: 'HTTP_ROUTES prefixes in vite config',
    });
    expect(adapter.prompts.join('\n')).not.toContain('recalled memories');
  });

  it('same memory is not repeated on the next turn of a native resume', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    const text = 'HTTP_ROUTES prefixes in vite config';
    await mgr.handlePrompt({ ...promptArgs, projectId, conversationId, text });
    expect(adapter.prompts[0]).toContain('recalled memories');
    await mgr.handlePrompt({ ...promptArgs, projectId, conversationId, text });
    expect(adapter.prompts[1]).not.toContain('recalled memories');
  });

  it('a fresh handoff shows it again', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    const text = 'HTTP_ROUTES prefixes in vite config';
    await mgr.handlePrompt({ ...promptArgs, projectId, conversationId, text });
    await mgr.handlePrompt({ ...promptArgs, projectId, conversationId, text, handoffOverride: 'fresh' });
    expect(adapter.prompts[1]).toContain('recalled memories');
  });

  it('steer: drained text holds the block; persisted steer text does not', async () => {
    const { db, projectId, conversationId } = boot();
    const adapter = new SteerCaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    const sid = await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: 'hello there friend',
    });
    await mgr.steerSession(sid, 'HTTP_ROUTES prefixes in vite config', undefined, { recall: true });
    await new Promise((r) => setTimeout(r, 50));
    const steered = adapter.prompts.find((p) => p.includes('HTTP_ROUTES prefixes'));
    expect(steered).toBeDefined();
    expect(steered).toContain('recalled memories');
    const stored = listEventsForConversation(db, conversationId).filter((e) => e.type === 'steer' || e.type === 'prompt');
    expect(stored.some((e) => JSON.stringify(e.payload).includes('recalled memories'))).toBe(false);
  });

  it('queued steer_queue frames never contain the block', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const frames: { type: string; queue?: { text: string }[] }[] = [];
    const mgr = new SessionManager({
      broadcast: (_cid, frame) => { frames.push(frame as { type: string; queue?: { text: string }[] }); },
    });
    const sid = await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: 'hello there friend',
    });
    await mgr.steerSession(sid, 'HTTP_ROUTES prefixes in vite config', undefined, { intent: 'queue', recall: true });
    const queued = frames.filter((f) => f.type === 'steer_queue' || f.type === 'steer_queued');
    expect(JSON.stringify(queued)).not.toContain('recalled memories');
  });

  it('a recall failure still sends the prompt', async () => {
    const { db, projectId, conversationId } = boot();
    const adapter = new CaptureAdapter();
    registry.register('claude-code', () => adapter);
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (typeof sql === 'string' && sql.includes('memories_fts')) throw new Error('boom');
      return orig(sql);
    }) as typeof db.prepare;
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: 'HTTP_ROUTES prefixes in vite config',
    });
    expect(adapter.prompts[0]).toContain('HTTP_ROUTES prefixes in vite config');
  });

  it('peer_message adopted then drained to a new turn gets no recall block', async () => {
    const { projectId, conversationId } = boot();
    const made: PausedCaptureAdapter[] = [];
    registry.register('claude-code', () => {
      const a = new PausedCaptureAdapter();
      made.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: 'hello there friend',
    });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: USER_RECALL_TEXT,
      source: 'peer_message',
    });
    made[0]!.finish();
    await tick();
    const follow = made.flatMap((a) => a.prompts).find((p) => p.includes(USER_RECALL_TEXT));
    expect(follow).toBeDefined();
    expect(hasRecallBlock(follow!)).toBe(false);
  });

  it('subagent_notify adopted then drained to a new turn gets no recall block', async () => {
    const { projectId, conversationId } = boot();
    const made: PausedCaptureAdapter[] = [];
    registry.register('claude-code', () => {
      const a = new PausedCaptureAdapter();
      made.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: 'hello there friend',
    });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: USER_RECALL_TEXT,
      source: 'subagent_notify',
    });
    made[0]!.finish();
    await tick();
    const follow = made.flatMap((a) => a.prompts).find((p) => p.includes(USER_RECALL_TEXT));
    expect(follow).toBeDefined();
    expect(hasRecallBlock(follow!)).toBe(false);
  });

  it('notify first then user prompt: user prompt still gets a recall block', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new SoftCancelCaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: 'hello there friend',
    });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: CHILD_RECALL_TEXT,
      source: 'subagent_notify',
    });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: USER_RECALL_TEXT,
    });
    adapter.finish();
    await tick();
    const steered = adapter.steered.find((p) => p.includes(USER_RECALL_TEXT));
    expect(steered).toBeDefined();
    expect(hasRecallBlock(steered!)).toBe(true);
    expect(steered).toContain('HTTP_ROUTES');
    expect(steered).not.toContain('must not select recall');
  });

  it('user prompt first then notify: search uses only user keywords', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new SoftCancelCaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: 'hello there friend',
    });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: USER_RECALL_TEXT,
    });
    await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId,
      text: CHILD_RECALL_TEXT,
      source: 'subagent_notify',
    });
    adapter.finish();
    await tick();
    const steered = adapter.steered.find((p) => p.includes(USER_RECALL_TEXT));
    expect(steered).toBeDefined();
    expect(hasRecallBlock(steered!)).toBe(true);
    expect(steered).toContain('HTTP_ROUTES');
    expect(steered).not.toContain('must not select recall');
  });

  it('queued item with a handoff override recalls in the new turn', async () => {
    const { projectId, conversationId } = boot();
    const made: PausedCaptureAdapter[] = [];
    registry.register('claude-code', () => {
      const a = new PausedCaptureAdapter();
      made.push(a);
      return a;
    });
    const mgr = new SessionManager({ broadcast: () => {} });
    const sid = await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: 'hello there friend',
    });
    await mgr.steerSession(sid, USER_RECALL_TEXT, undefined, {
      intent: 'queue',
      handoffOverride: 'fresh',
      recall: true,
    });
    made[0]!.finish();
    await tick();
    const follow = made.flatMap((a) => a.prompts).find((p) => p.includes(USER_RECALL_TEXT));
    expect(follow).toBeDefined();
    expect(hasRecallBlock(follow!)).toBe(true);
  });

  it('reissue-token stub and stop wrap-up trigger no recall', async () => {
    const { projectId, conversationId } = boot();
    const adapter = new SoftCancelCaptureAdapter();
    registry.register('claude-code', () => adapter);
    const mgr = new SessionManager({ broadcast: () => {} });
    const sid = await mgr.handlePrompt({
      ...promptArgs, projectId, conversationId, text: 'hello there friend',
    });
    await mgr.reissueSpawnToken(conversationId);
    await mgr.steerSession(sid, WRAP_UP_TEXT(3000));
    const queued = mgr.getSession(sid)?.steerQueue ?? [];
    expect(queued.some((q) => q.recall)).toBe(false);
    adapter.finish();
    await tick();
    expect(adapter.steered.some(hasRecallBlock)).toBe(false);
  });
});
