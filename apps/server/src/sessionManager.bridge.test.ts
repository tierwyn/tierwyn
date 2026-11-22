import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { EventEmitter } from 'events';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

const PROFILE = 'claude-code:opus-4.8';

class ConsolidatingFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  /** Scripted per-turn outcome; each sendPrompt consumes the next entry.
   *  `error` emits a non-fatal-looking error EVENT before the terminal status
   *  (the incident's shape: quota text arrives as an error event). */
  script: { status: 'done' | 'error'; chunk?: string; error?: string }[] = [
    { status: 'done', chunk: 'Consolidated: grandchild finished the audit; 3 findings, all fixed.' },
  ];
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    const step = this.script.shift() ?? { status: 'done' as const };
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    if (step.chunk) this.emitter.emit('event', { type: 'message', payload: { chunk: step.chunk }, sessionId: '', seq: 2, ts: Date.now() });
    if (step.error) this.emitter.emit('event', { type: 'error', payload: { message: step.error }, sessionId: '', seq: 4, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: step.status }, sessionId: '', seq: 3, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {}
  async listModels() { return []; }
  async listSessions() { return []; }
  async loadSession() {}
}

describe('upward bridge: subagent_notify turn on a conversation with a parent', () => {
  let mgr: SessionManager;
  let l0: string; let l1: string; let projectId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
    setDb(db);
    catalogue.load(db);
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    l0 = createConversation(db, { projectId, title: 'orchestrator' }).id;
    l1 = createConversation(db, { projectId, title: 'child', parentConversationId: l0 }).id;
    // L0 must have a prior real session so notifyParentSubagentResult branch 2 can resume it.
    createSession(db, { id: 'l0-sess', conversationId: l0, agentId: 'claude-code', agentModelId: PROFILE });
    mgr = new SessionManager({ broadcast: () => {} });
  });

  it('pushes the follow-up turn prose up to the parent (t7→t9 of the failing timeline)', async () => {
    // Simulate t7: the grandchild result arrives on L1 as a fresh subagent_notify turn.
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'Sub-agent (auditor) result:\n\naudit done',
      source: 'subagent_notify',
      subagent: { role: 'auditor', childConversationId: 'l2-fake' },
    });
    await new Promise((r) => setTimeout(r, 50)); // let the bridged notify turn on L0 run

    const db = getDb();
    // The bridge must have recorded a follow-up result marker in L0's transcript…
    const l0Events = listEventsForConversation(db, l0);
    const marker = l0Events.find((e) =>
      e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('follow-up'));
    expect(marker).toBeTruthy();
    // …and started a silent subagent_notify turn on L0 carrying the consolidated prose.
    const notifyPrompt = l0Events.find((e) =>
      e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify'
      && (e.payload as { text: string }).text.includes('Consolidated: grandchild finished'));
    expect(notifyPrompt).toBeTruthy();
    expect(notifyPrompt!.sender).toBe('system');
  });

  it('does NOT bridge a plain user-sourced turn on a child conversation', async () => {
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'first task turn', // no source → child's ordinary first turn; the route watcher owns it
    });
    await new Promise((r) => setTimeout(r, 50));
    const l0Events = listEventsForConversation(getDb(), l0);
    expect(l0Events.filter((e) => e.type === 'prompt')).toHaveLength(0);
  });

  it('honors notify_parent=false on the edge: marker recorded, no notify turn started', async () => {
    const db = getDb();
    const { createSpawnEdge } = await import('./repositories/spawnEdges.js');
    createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: false });
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'grandchild says hi', source: 'subagent_notify', subagent: { role: 'auditor' },
    });
    await new Promise((r) => setTimeout(r, 50));
    const l0Events = listEventsForConversation(db, l0);
    expect(l0Events.some((e) => e.type === 'message' && (e.payload as { spawnMarker?: unknown }).spawnMarker)).toBe(true);
    expect(l0Events.filter((e) => e.type === 'prompt')).toHaveLength(0); // 🔒 explicit opt-out honored
  });

  it('does not bridge past the root (L0 subagent_notify turn has no parent)', async () => {
    await mgr.handlePrompt({
      projectId, conversationId: l0,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'child result arriving at root', source: 'subagent_notify', subagent: { role: 'x' },
    });
    await new Promise((r) => setTimeout(r, 50));
    // no throw, no infinite recursion, exactly the one prompt event on L0
    expect(listEventsForConversation(getDb(), l0).filter((e) => e.type === 'prompt')).toHaveLength(1);
  });

  it('parent_message reply bridges to replyTo (the sender), not the direct parent', async () => {
    const db = getDb();
    const l2 = createConversation(db, { projectId, title: 'l2', parentConversationId: l1 }).id;
    createSession(db, { id: 'l2-sess', conversationId: l2, agentId: 'claude-code', agentModelId: PROFILE });
    // L0 messaged L2 directly (descent-validated at the route); reply must go to L0.
    await mgr.handlePrompt({
      projectId, conversationId: l2,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'answer the orchestrator', source: 'parent_message',
      subagent: { replyTo: l0, childConversationId: l2 },
    });
    await new Promise((r) => setTimeout(r, 50));
    const l0Prompts = listEventsForConversation(db, l0).filter((e) => e.type === 'prompt');
    expect(l0Prompts.some((e) => (e.payload as { text: string }).text.includes('Consolidated: grandchild finished'))).toBe(true);
    // and the intermediate L1 got NO notify turn from this exchange
    expect(listEventsForConversation(db, l1).filter((e) => e.type === 'prompt')).toHaveLength(0);
  });

  it('exactly one upward notify per hop (no double-notify on L0)', async () => {
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'Sub-agent (auditor) result:\n\naudit done',
      source: 'subagent_notify',
      subagent: { role: 'auditor', childConversationId: 'l2-fake' },
    });
    await new Promise((r) => setTimeout(r, 50));
    const l0Notifies = listEventsForConversation(getDb(), l0).filter(
      (e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify',
    );
    // One hop up only: L1→L0 once. A future regression that double-fires would be ≥2.
    expect(l0Notifies).toHaveLength(1);
  });
});

describe('recovery bridge: plain operator follow-up after missed auto-notify (P3)', () => {
  let mgr: SessionManager;
  let l0: string; let l1: string; let projectId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
    setDb(db);
    catalogue.load(db);
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    l0 = createConversation(db, { projectId, title: 'orchestrator' }).id;
    l1 = createConversation(db, { projectId, title: 'child', parentConversationId: l0 }).id;
    createSession(db, { id: 'l0-sess', conversationId: l0, agentId: 'claude-code', agentModelId: PROFILE });
    mgr = new SessionManager({ broadcast: () => {} });
  });

  it('bridges one plain terminal turn when edge is interrupted and followup_count is 0', async () => {
    const db = getDb();
    const { createSpawnEdge, resolveSpawnEdge } = await import('./repositories/spawnEdges.js');
    const edge = createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: true });
    resolveSpawnEdge(db, edge.id, 'interrupted', 'interrupted');

    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'operator follow-up after restart',
    });
    await new Promise((r) => setTimeout(r, 50));

    const l0Events = listEventsForConversation(db, l0);
    const markers = l0Events.filter((e) =>
      e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('◀ result (follow-up):'));
    expect(markers).toHaveLength(1);
    const notifies = l0Events.filter(
      (e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify',
    );
    expect(notifies).toHaveLength(1);
    expect((notifies[0]!.payload as { text: string }).text).toContain('Consolidated: grandchild finished');
  });

  it('fires recovery bridge at most once across two sequential plain terminal turns', async () => {
    const db = getDb();
    const { createSpawnEdge, resolveSpawnEdge, getEdgeByChild } = await import('./repositories/spawnEdges.js');
    const edge = createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: true });
    resolveSpawnEdge(db, edge.id, 'interrupted', 'interrupted');

    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'first follow-up',
    });
    await new Promise((r) => setTimeout(r, 50));
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'second follow-up',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(getEdgeByChild(db, l1)!.followupCount).toBe(1);
    const l0Notifies = listEventsForConversation(db, l0).filter(
      (e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify',
    );
    expect(l0Notifies).toHaveLength(1);
  });

  it('operator stop on a sourced turn does not notify the parent', async () => {
    const { EventEmitter } = await import('events');
    class PausedBridgeAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('event', { type: 'message', payload: { chunk: 'partial grandchild prose' }, sessionId: '', seq: 2, ts: Date.now() });
      }
      async stop() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 9, ts: Date.now() });
        this.emitter.emit('end');
      }
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }
    registry.register('claude-code', () => new PausedBridgeAdapter());

    const sid = await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'Sub-agent (auditor) result:\n\naudit in progress',
      source: 'subagent_notify',
      subagent: { role: 'auditor', childConversationId: 'l2-fake' },
    });
    await mgr.stopSession(sid, { initiatedBy: 'operator' });
    await new Promise((r) => setTimeout(r, 50));

    const l0Events = listEventsForConversation(getDb(), l0);
    expect(l0Events.filter((e) => e.type === 'prompt')).toHaveLength(0);
    expect(l0Events.filter((e) =>
      e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('follow-up'),
    )).toHaveLength(0);
  });

  it('does not recovery-bridge when edge is still open (watcher owns first notify)', async () => {
    const db = getDb();
    const { createSpawnEdge } = await import('./repositories/spawnEdges.js');
    createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: true });

    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'first task turn on open edge',
    });
    await new Promise((r) => setTimeout(r, 50));

    const l0Events = listEventsForConversation(db, l0);
    expect(l0Events.filter((e) => e.type === 'prompt')).toHaveLength(0);
    expect(l0Events.filter((e) =>
      e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('follow-up'),
    )).toHaveLength(0);
  });
});

describe('recovery bridge: outcome-aware slot consumption (incident 2026-08-25)', () => {
  let mgr: SessionManager;
  let adapter: ConsolidatingFakeAdapter;
  let l0: string; let l1: string; let projectId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
    setDb(db);
    catalogue.load(db);
    adapter = new ConsolidatingFakeAdapter();
    registry.register('claude-code', () => adapter);
    projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    l0 = createConversation(db, { projectId, title: 'orchestrator' }).id;
    l1 = createConversation(db, { projectId, title: 'child', parentConversationId: l0 }).id;
    createSession(db, { id: 'l0-sess', conversationId: l0, agentId: 'claude-code', agentModelId: PROFILE });
    mgr = new SessionManager({ broadcast: () => {} });
  });

  /** Interrupted edge with the recovery slot unspent — the incident's starting state. */
  async function interruptedEdge() {
    const db = getDb();
    const { createSpawnEdge, resolveSpawnEdge } = await import('./repositories/spawnEdges.js');
    const edge = createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: true });
    resolveSpawnEdge(db, edge.id, 'interrupted', 'interrupted');
    return edge.id;
  }
  const followUp = (text: string) => mgr.handlePrompt({
    projectId, conversationId: l1,
    agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
    text,
  });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('an errored follow-up notifies but does NOT consume the recovery slot; the retry that succeeds consumes it', async () => {
    const db = getDb();
    const { getEdgeByChild } = await import('./repositories/spawnEdges.js');
    await interruptedEdge();

    // Turn 1: login error — error event + degenerate-ish error prose, terminal status error.
    adapter.script = [{ status: 'error', chunk: 'Not logged in · Please run /login', error: 'CLI login required: not authenticated (exit 1)' }];
    await followUp('try again');
    await settle();
    // Notified (visibility, now with the error framed) but slot retained…
    expect(listEventsForConversation(db, l0).filter(
      (e) => e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('◀ result (follow-up, failed):'),
    )).toHaveLength(1);
    const firstNotify = listEventsForConversation(db, l0).find(
      (e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify',
    );
    expect((firstNotify!.payload as { text: string }).text).toContain('<error>CLI login required: not authenticated (exit 1)</error>');
    expect((firstNotify!.payload as { text: string }).text).toContain('TURN FAILED');
    expect(getEdgeByChild(db, l1)!.followupCount).toBe(0);

    // Turn 2: the successful retry — substantive prose, consumes the slot.
    adapter.script = [{ status: 'done', chunk: 'VERDICT: SHIP-AFTER-FIX — one blocker found in the calendar row binding, everything else clean.' }];
    await followUp('and now the real result');
    await settle();
    expect(getEdgeByChild(db, l1)!.followupCount).toBe(1);

    // Turn 3: slot spent — no further recovery bridging.
    adapter.script = [{ status: 'done', chunk: 'A third answer that would previously have been orphaned side-quest prose.' }];
    await followUp('side quest');
    await settle();
    const notifyPrompts = listEventsForConversation(db, l0).filter(
      (e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify',
    );
    expect(notifyPrompts).toHaveLength(2); // error turn + successful turn only
  });

  it('a degenerate done ("ok") does not consume the slot; a substantive done does', async () => {
    const db = getDb();
    const { getEdgeByChild } = await import('./repositories/spawnEdges.js');
    await interruptedEdge();

    adapter.script = [{ status: 'done', chunk: 'ok' }];
    await followUp('did it work?');
    await settle();
    expect(getEdgeByChild(db, l1)!.followupCount).toBe(0); // degenerate → slot kept

    adapter.script = [{ status: 'done', chunk: 'Full report: the extraction is verbatim, the cap is fair-share, tests are real.' }];
    await followUp('give me the report');
    await settle();
    expect(getEdgeByChild(db, l1)!.followupCount).toBe(1); // substantive → consumed
  });

  it('bridge-source turns (subagent_notify) never consume the recovery slot', async () => {
    const db = getDb();
    const { getEdgeByChild } = await import('./repositories/spawnEdges.js');
    await interruptedEdge();

    adapter.script = [{ status: 'done', chunk: 'Grandchild cascade result with plenty of substantive prose in it.' }];
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'grandchild result arrives', source: 'subagent_notify',
      subagent: { role: 'grandchild' },
    });
    await settle();
    // Bridged upward (marker present) but the operator's recovery slot is intact.
    expect(listEventsForConversation(db, l0).some((e) =>
      e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('follow-up'))).toBe(true);
    expect(getEdgeByChild(db, l1)!.followupCount).toBe(0);
  });

  it('two overlapping recovery turns on the same child yield exactly ONE parent notify (CAS)', async () => {
    const db = getDb();
    const { getEdgeByChild } = await import('./repositories/spawnEdges.js');
    await interruptedEdge();
    adapter.script = [
      { status: 'done', chunk: 'First overlapping recovery answer with real substance in it.' },
      { status: 'done', chunk: 'Second overlapping recovery answer with real substance in it.' },
    ];
    // Overlap: settle() waits past the CAS window; firing both without awaiting
    // lets both terminal statuses race the unspent slot. Only one may win.
    await Promise.all([followUp('overlap one'), followUp('overlap two')]);
    // Overlap serializes onto one live session (second prompt steers/queues,
    // then drains). The recovery slot is still spent at most once.
    await new Promise((r) => setTimeout(r, 250));

    expect(getEdgeByChild(db, l1)!.followupCount).toBe(1);
    const markers = listEventsForConversation(db, l0).filter((e) =>
      e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('◀ result (follow-up):'));
    expect(markers).toHaveLength(1);
    const notifyPrompts = listEventsForConversation(db, l0).filter(
      (e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify',
    );
    expect(notifyPrompts).toHaveLength(1);
  });
});

describe('bridge notifyParent override (descent message)', () => {
  let mgr: SessionManager;
  let l0: string; let l1: string; let projectId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
    setDb(db);
    catalogue.load(db);
    registry.register('claude-code', () => new ConsolidatingFakeAdapter());
    projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    l0 = createConversation(db, { projectId, title: 'orchestrator' }).id;
    l1 = createConversation(db, { projectId, title: 'child', parentConversationId: l0 }).id;
    createSession(db, { id: 'l0-sess', conversationId: l0, agentId: 'claude-code', agentModelId: PROFILE });
    mgr = new SessionManager({ broadcast: () => {} });
  });

  it('edge notifyParent=false, parent_message with subagent.notify=true bridges to parent', async () => {
    const db = getDb();
    const { createSpawnEdge } = await import('./repositories/spawnEdges.js');
    createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: false });
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'follow up from parent',
      source: 'parent_message',
      subagent: { replyTo: l0, childConversationId: l1, notify: true },
    });
    await new Promise((r) => setTimeout(r, 50));
    const l0Events = listEventsForConversation(db, l0);
    expect(l0Events.some((e) => e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('follow-up'))).toBe(true);
    expect(l0Events.filter((e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify')).toHaveLength(1);
  });

  it('edge notifyParent=true, subagent.notify=false records marker but does not notify parent', async () => {
    const db = getDb();
    const { createSpawnEdge } = await import('./repositories/spawnEdges.js');
    createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: true });
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'follow up from parent',
      source: 'parent_message',
      subagent: { replyTo: l0, childConversationId: l1, notify: false },
    });
    await new Promise((r) => setTimeout(r, 50));
    const l0Events = listEventsForConversation(db, l0);
    expect(l0Events.some((e) => e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('follow-up'))).toBe(true);
    expect(l0Events.filter((e) => e.type === 'prompt')).toHaveLength(0);
  });

  it('notify undefined inherits edge: notifyParent=false suppresses, notifyParent=true notifies', async () => {
    const db = getDb();
    const { createSpawnEdge } = await import('./repositories/spawnEdges.js');
    // Case 1: edge false, notify undefined -> no notify
    createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: false });
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'turn 1', source: 'parent_message',
      subagent: { replyTo: l0, childConversationId: l1 },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(listEventsForConversation(db, l0).filter((e) => e.type === 'prompt')).toHaveLength(0);

    // Case 2: update edge to true, notify undefined -> notifies
    db.prepare('UPDATE spawn_edges SET notify_parent = 1 WHERE child_conversation_id = ?').run(l1);
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'turn 2', source: 'parent_message',
      subagent: { replyTo: l0, childConversationId: l1 },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(listEventsForConversation(db, l0).filter((e) => e.type === 'prompt')).toHaveLength(1);
  });

  it('queued path: steer with subagent.notify=true into a live non-injectable turn, let drain relaunch -> bridge honours notify', async () => {
    const db = getDb();
    const { createSpawnEdge } = await import('./repositories/spawnEdges.js');
    createSpawnEdge(db, { parentConversationId: l0, childConversationId: l1, notifyParent: false });

    class LiveAdapter implements AgentAdapter {
      emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
      }
      finish(chunk: string) {
        this.emitter.emit('event', { type: 'message', payload: { chunk }, sessionId: '', seq: 2, ts: Date.now() });
        this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() {}
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }

    const adapter1 = new LiveAdapter();
    let turnCount = 0;
    registry.register('claude-code', () => {
      turnCount++;
      if (turnCount === 1) return adapter1;
      return new ConsolidatingFakeAdapter();
    });

    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'first turn',
    });

    const sess = mgr.inFlightSessionForConversation(l1)!;
    expect(sess).toBeDefined();
    expect(sess.injectable).toBe(false);

    await mgr.steerSession(sess.id, 'queued parent message', undefined, {
      source: 'parent_message',
      subagent: { replyTo: l0, childConversationId: l1, notify: true },
    });

    adapter1.finish('turn 1 done');

    await vi.waitFor(() => {
      const l0Events = listEventsForConversation(db, l0);
      expect(l0Events.some((e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify')).toBe(true);
    }, { timeout: 3000 });

    const l0Events = listEventsForConversation(db, l0);
    expect(l0Events.some((e) => e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('follow-up'))).toBe(true);
    expect(l0Events.filter((e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify')).toHaveLength(1);
  });
});

describe('upward bridge: terminal-error notify (incident 2026-10-11, plan §2)', () => {
  let mgr: SessionManager;
  let adapter: ConsolidatingFakeAdapter;
  let l0: string; let l1: string; let projectId: string;

  beforeEach(() => {
    const db = openDb(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
    setDb(db);
    catalogue.load(db);
    adapter = new ConsolidatingFakeAdapter();
    registry.register('claude-code', () => adapter);
    projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    l0 = createConversation(db, { projectId, title: 'orchestrator' }).id;
    l1 = createConversation(db, { projectId, title: 'child', parentConversationId: l0 }).id;
    createSession(db, { id: 'l0-sess', conversationId: l0, agentId: 'claude-code', agentModelId: PROFILE });
    mgr = new SessionManager({ broadcast: () => {} });
  });

  const notifyTurn = (script: { status: 'done' | 'error'; chunk?: string; error?: string }[]) => {
    adapter.script = script;
    return mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'Sub-agent (auditor) result:\n\nrelaying grandchild work',
      source: 'subagent_notify',
      subagent: { role: 'auditor', childConversationId: 'l2-fake' },
    });
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const l0Notifies = () => listEventsForConversation(getDb(), l0).filter(
    (e) => e.type === 'prompt' && (e.payload as { source?: string }).source === 'subagent_notify',
  );
  const l0Markers = () => listEventsForConversation(getDb(), l0)
    .filter((e) => e.type === 'message')
    .map((e) => ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? ''));

  it('6 · incident replay: quota error on a follow-up turn reaches the parent, framed as untrusted', async () => {
    await notifyTurn([{
      status: 'error',
      error: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 50m5s.',
    }]);
    await settle();
    const notifies = l0Notifies();
    expect(notifies).toHaveLength(1);
    const text = (notifies[0]!.payload as { text: string }).text;
    expect(text).toContain('TURN FAILED');
    expect(text).toContain('<error>');
    expect(text).toContain('Individual quota reached');
    expect(text.indexOf('<error>')).toBeGreaterThan(text.indexOf('<subagent-result child='));
    expect(text).toContain('usage/quota limit'); // server-authored hint, quota variant
    expect(text).toContain('Do not assume the child is still working');
    expect(text).toContain(`GET /spawn/${l1}/result?parentConversationId=${l0}`);
    const markers = l0Markers().filter((t) => t.includes('◀ result (follow-up'));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.startsWith('⚠ ◀ result (follow-up, failed): error: Individual quota')).toBe(true);
  });

  it('7 · errored turn WITH substantive prose: marker warns, notify carries both prose and <error>', async () => {
    await notifyTurn([{
      status: 'error',
      chunk: 'Partial but real findings: the bridge leaks when the adapter crashes before any status event arrives.',
      error: 'Individual quota reached mid-report',
    }]);
    await settle();
    const markers = l0Markers().filter((t) => t.includes('◀ result (follow-up'));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.startsWith('⚠ ◀ result (follow-up, failed): Partial but real findings')).toBe(true);
    const text = (l0Notifies()[0]!.payload as { text: string }).text;
    expect(text).toContain('Partial but real findings');
    expect(text).toContain('<error>Individual quota reached mid-report</error>');
  });

  it('8 · substantive done plus a stray non-fatal error event keeps today’s clean frame', async () => {
    await notifyTurn([{
      status: 'done',
      chunk: 'Full substantive report covering every detail the parent asked for, with room to spare.',
      error: 'command denied by operator policy: rm -rf /',
    }]);
    await settle();
    const text = (l0Notifies()[0]!.payload as { text: string }).text;
    expect(text).toContain('Full substantive report');
    expect(text).not.toContain('<error>');
    expect(text).not.toContain('TURN FAILED');
    expect(text).not.toContain('Sub-agent turn failed');
    expect(l0Markers().some((t) => t.includes('⚠'))).toBe(false);
  });

  it('9 · degenerate done with no error event: TURN FAILED + generic hint, no <error> block', async () => {
    await notifyTurn([{ status: 'done', chunk: 'ok' }]);
    await settle();
    const text = (l0Notifies()[0]!.payload as { text: string }).text;
    expect(text).toContain('TURN FAILED');
    expect(text).toContain('ended without a usable result');
    expect(text).not.toContain('<error>');
    expect(l0Markers().some((t) => t.startsWith('⚠ ◀ result (follow-up):'))).toBe(true);
  });

  it('11 · G2: adapter ’error’ emitter with no status event still notifies the parent exactly once', async () => {
    class CrashyAdapter implements AgentAdapter {
      emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('error', new Error('spawn agy ENOENT'));
        this.emitter.emit('end');
      }
      async stop() {}
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }
    registry.register('claude-code', () => new CrashyAdapter());
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'grandchild result arriving', source: 'subagent_notify',
      subagent: { role: 'auditor', childConversationId: 'l2-fake' },
    });
    await settle();
    const notifies = l0Notifies();
    expect(notifies).toHaveLength(1);
    const text = (notifies[0]!.payload as { text: string }).text;
    expect(text).toContain('<error>spawn agy ENOENT</error>');
    expect(text).toContain('TURN FAILED');
    expect(l0Markers().some((t) => t.startsWith('⚠ ◀ result (follow-up, failed): error: spawn agy ENOENT'))).toBe(true);
  });

  it('12 · G2: start() rejection (failTurn) notifies the parent exactly once', async () => {
    class StartRejectingAdapter implements AgentAdapter {
      private emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() { throw new Error('start failed: adapter boot threw'); }
      async sendPrompt() {}
      async stop() {}
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }
    registry.register('claude-code', () => new StartRejectingAdapter());
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'grandchild result arriving', source: 'subagent_notify',
      subagent: { role: 'auditor', childConversationId: 'l2-fake' },
    });
    await settle();
    const notifies = l0Notifies();
    expect(notifies).toHaveLength(1);
    expect((notifies[0]!.payload as { text: string }).text).toContain('<error>start failed: adapter boot threw</error>');
  });

  it('13 · double terminal (status:error event then adapter ’error’): exactly one notify (bridged guard)', async () => {
    class DoubleTerminalAdapter implements AgentAdapter {
      emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('event', { type: 'error', payload: { message: 'Individual quota reached. Resets in 50m5s.' }, sessionId: '', seq: 2, ts: Date.now() });
        this.emitter.emit('event', { type: 'status', payload: { status: 'error' }, sessionId: '', seq: 3, ts: Date.now() });
        this.emitter.emit('error', new Error('child process crashed after status'));
        this.emitter.emit('end');
      }
      async stop() {}
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }
    registry.register('claude-code', () => new DoubleTerminalAdapter());
    await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'grandchild result arriving', source: 'subagent_notify',
      subagent: { role: 'auditor', childConversationId: 'l2-fake' },
    });
    await settle();
    expect(l0Notifies()).toHaveLength(1);
  });

  it('14 · operator stop, then late error + status:error from the adapter: no notify, no marker', async () => {
    class LateErrorAdapter implements AgentAdapter {
      emitter = new EventEmitter();
      streamEvents() { return this.emitter; }
      async start() {}
      async sendPrompt() {
        this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
        this.emitter.emit('event', { type: 'message', payload: { chunk: 'partial prose' }, sessionId: '', seq: 2, ts: Date.now() });
      }
      failHard() {
        this.emitter.emit('event', { type: 'error', payload: { message: 'EPIPE after kill' }, sessionId: '', seq: 3, ts: Date.now() });
        this.emitter.emit('event', { type: 'status', payload: { status: 'error' }, sessionId: '', seq: 4, ts: Date.now() });
        this.emitter.emit('end');
      }
      async stop() {}
      async listModels() { return []; }
      async listSessions() { return []; }
      async loadSession() {}
    }
    const late = new LateErrorAdapter();
    registry.register('claude-code', () => late);
    const sid = await mgr.handlePrompt({
      projectId, conversationId: l1,
      agent: 'claude-code', model: 'opus-4.8', profileId: PROFILE,
      text: 'grandchild result arriving', source: 'subagent_notify',
      subagent: { role: 'auditor', childConversationId: 'l2-fake' },
    });
    await mgr.stopSession(sid, { initiatedBy: 'operator' });
    late.failHard();
    await settle();
    const l0Events = listEventsForConversation(getDb(), l0);
    expect(l0Events.filter((e) => e.type === 'prompt')).toHaveLength(0);
    expect(l0Events.filter((e) =>
      e.type === 'message' && ((e.payload as { spawnMarker?: { text: string } }).spawnMarker?.text ?? '').includes('follow-up'),
    )).toHaveLength(0);
  });
});
