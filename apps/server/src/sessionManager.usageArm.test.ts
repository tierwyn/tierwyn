import { describe, it, expect, vi } from 'vitest';
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
import { SessionManager } from './sessionManager.js';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';

type Emitted = { type: string; payload: Record<string, unknown> };

/** Emits a scripted sequence of NormalisedEvents from sendPrompt, then 'end'. */
class ScriptedAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  constructor(private readonly script: Emitted[]) {}
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    let seq = 1;
    for (const e of this.script) {
      this.emitter.emit('event', { ...e, sessionId: '', seq: seq++, ts: Date.now() } as unknown);
    }
    this.emitter.emit('end');
  }
  async stop() {}
  async listSessions() { return []; }
  async loadSession() {}
  async listModels() { return []; }
  get nativeSessionId() { return 'native-scripted'; }
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
  const p = createProject(db, { name: 'P', rootPath: '/tmp/proj' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  return { db, projectId: p.id, conversationId: c.id };
}

function runTurn(adapter: AgentAdapter, arm: ReturnType<typeof vi.fn>) {
  const { projectId, conversationId } = boot();
  registry.register('claude-code', () => adapter);
  const mgr = new SessionManager({ broadcast: () => {}, usageWatcher: { arm } });
  return mgr.handlePrompt({
    projectId, conversationId, agent: 'claude-code',
    model: 'claude-opus-4-8', profileId: 'claude-code:opus-4.8', text: 'go',
  }).then(async (sid) => {
    await new Promise((r) => setTimeout(r, 20));
    return sid;
  });
}

describe('SessionManager usage-watcher arming', () => {
  it('arms error_text on a quota-shaped error event', async () => {
    const arm = vi.fn();
    const adapter = new ScriptedAdapter([
      { type: 'status', payload: { status: 'running' } },
      { type: 'error', payload: { message: "You've hit your usage limit" } },
      { type: 'status', payload: { status: 'error' } },
    ]);
    await runTurn(adapter, arm);

    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm.mock.calls[0][0]).toMatchObject({ reason: 'error_text' });
  });

  it('arms final_prose when the last message chunk carries quota language', async () => {
    const arm = vi.fn();
    const adapter = new ScriptedAdapter([
      { type: 'status', payload: { status: 'running' } },
      { type: 'message', payload: { chunk: 'hit your session limit', final: true } },
      { type: 'status', payload: { status: 'done' } },
    ]);
    await runTurn(adapter, arm);

    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm.mock.calls[0][0]).toMatchObject({ reason: 'final_prose' });
  });

  it('arms degenerate on a done turn with no output at all', async () => {
    const arm = vi.fn();
    const adapter = new ScriptedAdapter([
      { type: 'status', payload: { status: 'running' } },
      { type: 'status', payload: { status: 'done' } },
    ]);
    await runTurn(adapter, arm);

    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm.mock.calls[0][0]).toMatchObject({ reason: 'degenerate' });
  });

  it('does not arm on a benign interrupt error', async () => {
    const arm = vi.fn();
    const adapter = new ScriptedAdapter([
      { type: 'status', payload: { status: 'running' } },
      { type: 'status', payload: { status: 'error', message: 'Request interrupted by user' } },
    ]);
    await runTurn(adapter, arm);

    expect(arm).not.toHaveBeenCalled();
  });

  // [S2-8] The arming scan must run over ACCUMULATED turn prose. On a plain
  // (non-bridge) first turn there is no bridge target, so the scan used to
  // fall back to the last message chunk only — quota language split across
  // chunks, or followed by an innocuous tail, was silently missed.
  it('[S2-8] limit prose split across chunks with an innocuous tail still arms', async () => {
    const arm = vi.fn();
    const adapter = new ScriptedAdapter([
      { type: 'status', payload: { status: 'running' } },
      { type: 'message', payload: { chunk: 'You have hit your usage limit.' } },
      { type: 'message', payload: { chunk: ' Meanwhile, the weather today was quite pleasant.' } },
      { type: 'status', payload: { status: 'done' } },
    ]);
    await runTurn(adapter, arm);

    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm.mock.calls[0][0]).toMatchObject({ reason: 'final_prose' });
  });

  it('[S2-8] benign split prose on a first turn does not arm', async () => {
    const arm = vi.fn();
    const adapter = new ScriptedAdapter([
      { type: 'status', payload: { status: 'running' } },
      { type: 'message', payload: { chunk: 'Refactored the parser and' } },
      { type: 'message', payload: { chunk: ' added tests. All done.' } },
      { type: 'status', payload: { status: 'done' } },
    ]);
    await runTurn(adapter, arm);

    expect(arm).not.toHaveBeenCalled();
  });
});
