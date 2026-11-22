import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { openDb, setDb, getDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedCommands, seedDefaultSettings } from './db/seed.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { createSession } from './repositories/sessions.js';
import { listEventsForConversation } from './repositories/events.js';
import { SessionManager } from './sessionManager.js';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

const PROFILE = 'claude-code:opus-4.8';

/** Emits done but never 'end' — holds the session open like claude-agent-sdk. */
class ParkedAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'parent finished turn' }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    // no 'end' → session stays in the map as parked
  }
  async stop() {
    this.emitter.emit('end');
  }
  async listModels() { return []; }
  async listSessions() { return []; }
  async loadSession() {}
}

/** Mid-turn forever (status:running only). */
class LiveAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
  }
  async stop() {
    this.emitter.emit('end');
  }
  async listModels() { return []; }
  async listSessions() { return []; }
  async loadSession() {}
}

/** Injectable: supports steer(); can end on demand. */
class InjectableAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  private getNextSteer?: () => Promise<{ text: string; attachments?: unknown[] } | null>;
  interruptCalls = 0;
  streamEvents() { return this.emitter; }
  async start(cfg: SessionConfig) {
    this.getNextSteer = cfg.getNextSteer;
  }
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
  }
  async steer(_text: string) {
    // no-op — items land in the queue when no pullNextSteer is parked
  }
  interruptTurn() {
    this.interruptCalls += 1;
  }
  /** Test helper: push a stream event through the same emitter SessionManager watches. */
  emitEvent(event: { type: string; payload: unknown; sessionId?: string; seq?: number; ts?: number }) {
    this.emitter.emit('event', {
      sessionId: event.sessionId ?? '',
      seq: event.seq ?? 0,
      ts: event.ts ?? Date.now(),
      ...event,
    });
  }
  /** End the turn without consuming pending steers. */
  finish() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {
    this.emitter.emit('end');
  }
  async listModels() { return []; }
  async listSessions() { return []; }
  async loadSession() {}
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('notifyParentSubagentResult (PR2)', () => {
  let mgr: SessionManager;
  let parentId: string;
  let projectId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
    setDb(db);
    catalogue.load(db);
    // Force steer flag so injectable tests can opt in via adapter.steer
    db.prepare('UPDATE agent_models SET steer_flag = 1 WHERE id = ?').run(PROFILE);
    catalogue.load(db);
    projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    parentId = createConversation(db, { projectId, title: 'root' }).id;
    mgr = new SessionManager({ broadcast: () => {} });
  });

  it('parked parent (status:done, hold-open) starts a fresh subagent_notify turn', async () => {
    registry.register('claude-code', () => new ParkedAdapter());
    createSession(getDb(), {
      id: 'prior', conversationId: parentId,
      agentId: 'claude-code', agentModelId: PROFILE,
    });

    // Park a hold-open session on the parent.
    await mgr.handlePrompt({
      projectId, conversationId: parentId,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'original parent turn',
    });
    await sleep(20);
    expect(mgr.activeSessionForConversation(parentId)?.lastStatus).toBe('done');
    expect(mgr.inFlightSessionForConversation(parentId)).toBeUndefined();

    const before = listEventsForConversation(getDb(), parentId).filter((e) => e.type === 'prompt').length;

    mgr.notifyParentSubagentResult(
      parentId,
      'Sub-agent (auditor) result:\n\nall good',
      { role: 'auditor', childConversationId: 'child-parked' },
    );
    await sleep(40);

    const prompts = listEventsForConversation(getDb(), parentId).filter((e) => e.type === 'prompt');
    expect(prompts.length).toBeGreaterThan(before);
    const notify = prompts.find((e) => (e.payload as { source?: string }).source === 'subagent_notify');
    expect(notify).toBeTruthy();
    expect(notify!.sender).toBe('system');
    expect((notify!.payload as { text: string }).text).toContain('all good');
  });

  it('live mid-turn parent steers into the session (no fresh turn)', async () => {
    registry.register('claude-code', () => new LiveAdapter());
    createSession(getDb(), {
      id: 'prior', conversationId: parentId,
      agentId: 'claude-code', agentModelId: PROFILE,
    });

    await mgr.handlePrompt({
      projectId, conversationId: parentId,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'live parent',
    });
    await sleep(20);
    expect(mgr.inFlightSessionForConversation(parentId)?.lastStatus).toBe('running');

    const promptsBefore = listEventsForConversation(getDb(), parentId).filter((e) => e.type === 'prompt').length;

    mgr.notifyParentSubagentResult(
      parentId,
      'Sub-agent (x) result:\n\nsteered payload',
      { role: 'x', childConversationId: 'child-live' },
    );
    await sleep(20);

    // No additional prompt turn — message is queued/steered into the live session.
    const promptsAfter = listEventsForConversation(getDb(), parentId).filter((e) => e.type === 'prompt');
    expect(promptsAfter).toHaveLength(promptsBefore);
    expect(promptsAfter.every((e) => (e.payload as { source?: string }).source !== 'subagent_notify')).toBe(true);
  });

  it('notify resume uses conversation workdir_path as cwd (not bare project root)', async () => {
    const worktree = '/tmp/worktree-parent-notify';
    const wtParent = createConversation(getDb(), {
      projectId, title: 'wt parent', workdirPath: worktree,
    }).id;
    createSession(getDb(), {
      id: 'prior-wt', conversationId: wtParent,
      agentId: 'claude-code', agentModelId: PROFILE,
    });

    let seenCwd: string | undefined;
    class CaptureCwdAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start(cfg: SessionConfig) { seenCwd = cfg.cwd; }
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('event', { type: 'message', payload: { chunk: 'ok' }, sessionId: '', seq: 2, ts: Date.now() });
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() { this.emitter.emit('end'); }
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }
    registry.register('claude-code', () => new CaptureCwdAdapter());

    // First turn seeds last session (and parks... but ends immediately here).
    await mgr.handlePrompt({
      projectId, conversationId: wtParent,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'seed',
      cwd: worktree,
    });
    await sleep(30);
    seenCwd = undefined;

    mgr.notifyParentSubagentResult(
      wtParent,
      'Sub-agent (auditor) result:\n\nall good',
      { role: 'auditor', childConversationId: 'child-wt' },
    );
    await sleep(50);

    expect(seenCwd).toBe(worktree);
  });

  it('no resumable session records a visible undeliverable marker (not silent)', async () => {
    // No prior session rows with agentId/agentModelId — cannot resume.
    // Path is async (reapParkedSessions.then → resumeNotifyTurn).
    mgr.notifyParentSubagentResult(
      parentId,
      'Sub-agent (ghost) result:\n\nlost',
      { role: 'ghost', childConversationId: 'child-none' },
    );
    await sleep(20);

    const markers = listEventsForConversation(getDb(), parentId).filter(
      (e) => e.type === 'message' && (e.payload as { spawnMarker?: { text: string } }).spawnMarker,
    );
    expect(markers.length).toBeGreaterThanOrEqual(1);
    const text = (markers[markers.length - 1].payload as { chunk: string }).chunk;
    expect(text).toContain('could not be delivered');
    expect(text).toContain('GET /spawn/child-none/result');
  });

  it('queued subagent_notify mid-turn does NOT interrupt while stream is active', async () => {
    registry.register('claude-code', () => new InjectableAdapter());
    createSession(getDb(), {
      id: 'prior', conversationId: parentId,
      agentId: 'claude-code', agentModelId: PROFILE,
    });

    // Long idle so natural activity would win; interrupt only after idle.
    mgr = new SessionManager({ broadcast: () => {}, sourcedNotifyIdleMs: 200 });

    await mgr.handlePrompt({
      projectId, conversationId: parentId,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'still generating',
    });
    await sleep(20);

    const live = mgr.inFlightSessionForConversation(parentId);
    expect(live).toBeTruthy();
    const sessionAdapter = live!.adapter as InjectableAdapter;

    mgr.notifyParentSubagentResult(
      parentId,
      'Sub-agent (z) result:\n\nready',
      { role: 'z', childConversationId: 'child-int' },
    );
    // Immediately after queue: no interrupt yet (wait for idle or natural done).
    await sleep(30);
    expect(sessionAdapter.interruptCalls).toBe(0);

    // Stream activity (chunks) should push the idle timer out.
    sessionAdapter.emitEvent({ type: 'message', payload: { chunk: 'still talking' } });
    await sleep(100);
    expect(sessionAdapter.interruptCalls).toBe(0);

    // Still no fresh prompt turn — notify stays queued for drain.
    const notifyPrompts = listEventsForConversation(getDb(), parentId).filter(
      (e) => (e.payload as { source?: string }).source === 'subagent_notify',
    );
    expect(notifyPrompts).toHaveLength(0);
  });

  it('queued subagent_notify mid-turn soft-interrupts after stream idle', async () => {
    registry.register('claude-code', () => new InjectableAdapter());
    createSession(getDb(), {
      id: 'prior', conversationId: parentId,
      agentId: 'claude-code', agentModelId: PROFILE,
    });

    mgr = new SessionManager({ broadcast: () => {}, sourcedNotifyIdleMs: 50 });

    await mgr.handlePrompt({
      projectId, conversationId: parentId,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'waiting on kids',
    });
    await sleep(20);

    const live = mgr.inFlightSessionForConversation(parentId);
    expect(live).toBeTruthy();
    const sessionAdapter = live!.adapter as InjectableAdapter;

    mgr.notifyParentSubagentResult(
      parentId,
      'Sub-agent (z) result:\n\nready',
      { role: 'z', childConversationId: 'child-int' },
    );
    // Before idle budget: no interrupt.
    await sleep(20);
    expect(sessionAdapter.interruptCalls).toBe(0);
    // After idle budget with no stream events: soft-yield.
    await sleep(80);
    expect(sessionAdapter.interruptCalls).toBeGreaterThanOrEqual(1);
  });

  it('drain keeps unconsumed subagent_notify steers as a follow-up turn', async () => {
    // injectable path: steer_flag=1 + adapter.steer → type 'steer' when no resolver is parked.
    // registry.create may be called more than once (context-window probe); always
    // finish via the live session's adapter instance.
    registry.register('claude-code', () => new InjectableAdapter());
    createSession(getDb(), {
      id: 'prior', conversationId: parentId,
      agentId: 'claude-code', agentModelId: PROFILE,
    });

    await mgr.handlePrompt({
      projectId, conversationId: parentId,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'injectable parent',
    });
    await sleep(20);

    const live = mgr.inFlightSessionForConversation(parentId);
    expect(live).toBeTruthy();
    expect(live!.injectable).toBe(true);

    const steered = await mgr.steerSession(live!.id, 'Sub-agent (y) result:\n\nfrom queue', undefined, {
      source: 'subagent_notify',
      subagent: { role: 'y', childConversationId: 'child-q' },
    });
    expect(steered.mode).toBe('queued');
    expect(steered.queueLength).toBeGreaterThanOrEqual(1);

    // End without consuming the steer — previously discarded; now drains as follow-up.
    (live!.adapter as InjectableAdapter).finish();
    await sleep(60);

    const prompts = listEventsForConversation(getDb(), parentId).filter((e) => e.type === 'prompt');
    const followUp = prompts.find(
      (e) => (e.payload as { source?: string }).source === 'subagent_notify'
        && (e.payload as { text: string }).text.includes('from queue'),
    );
    expect(followUp).toBeTruthy();
    expect(followUp!.sender).toBe('system');
  });
});
