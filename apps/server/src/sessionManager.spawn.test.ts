import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, setDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedCommands, seedDefaultSettings } from './db/seed.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { createSession, lastSessionForConversation } from './repositories/sessions.js';
import { listEventsForConversation } from './repositories/events.js';
import { SessionManager } from './sessionManager.js';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import { EventEmitter } from 'events';
import type { AgentAdapter, SessionConfig } from '@tierwyn/shared';
import type { ServerFrame } from '@tierwyn/shared';

class EndingFakeAdapter implements AgentAdapter {
  private emitter = new EventEmitter();
  streamEvents() { return this.emitter; }
  async start(_cfg: SessionConfig) {}
  async sendPrompt() {
    this.emitter.emit('event', { type: 'status', payload: { status: 'running' }, sessionId: '', seq: 1, ts: Date.now() });
    this.emitter.emit('event', { type: 'message', payload: { chunk: 'ack' }, sessionId: '', seq: 2, ts: Date.now() });
    this.emitter.emit('event', { type: 'status', payload: { status: 'done' }, sessionId: '', seq: 3, ts: Date.now() });
    this.emitter.emit('end');
  }
  async stop() {}
  async listModels() { return []; }
  async listSessions() { return []; }
  async loadSession() {}
}

describe('SessionManager spawn helpers', () => {
  let mgr: SessionManager;
  let parentId: string;
  beforeEach(() => {
    const db = openDb(':memory:');
    runMigrations(db, migrations);
    seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
    setDb(db);
    catalogue.load(db);
    registry.register('claude-code', () => new EndingFakeAdapter());
    const project = createProject(db, { name: 'p', rootPath: '/tmp/p' });
    parentId = createConversation(db, { projectId: project.id, title: 'root' }).id;
    const frames: ServerFrame[] = [];
    mgr = new SessionManager({ broadcast: (_c, f) => frames.push(f) });
  });

  it('recordSpawnMarker appends a message event with spawnMarker to the parent', () => {
    mgr.recordSpawnMarker(parentId, { kind: 'spawned', childConversationId: 'C2', text: 'spawned → C2' });
    const events = listEventsForConversation(setDbRef(), parentId);
    const marker = events.find((e) => e.type === 'message' && (e.payload as any).spawnMarker);
    expect(marker).toBeTruthy();
    expect((marker!.payload as any).spawnMarker.childConversationId).toBe('C2');
  });

  it('activeSessionForConversation returns undefined when nothing is running', () => {
    expect(mgr.activeSessionForConversation(parentId)).toBeUndefined();
  });

  it('notifyParentSubagentResult starts a follow-up turn when the parent session has ended', async () => {
    const db = setDbRef();
    const profileId = 'claude-code:opus-4.8';
    createSession(db, {
      id: 'parent-sess',
      conversationId: parentId,
      agentId: 'claude-code',
      agentModelId: profileId,
    });

    mgr.notifyParentSubagentResult(
      parentId,
      'Sub-agent (The Smart General Purpose) result:\n\ndone',
      { role: 'The Smart General Purpose', childConversationId: 'child-1' },
    );
    await new Promise((r) => setTimeout(r, 30));

    const promptEvents = listEventsForConversation(db, parentId)
      .filter((e) => e.type === 'prompt');
    const texts = promptEvents.map((e) => (e.payload as { text: string }).text);
    expect(texts).toContain('Sub-agent (The Smart General Purpose) result:\n\ndone');

    // Silent follow-up: source/subagent metadata persisted, sender 'system'.
    const notify = promptEvents.find(
      (e) => (e.payload as { source?: string }).source === 'subagent_notify',
    );
    expect(notify).toBeTruthy();
    expect(notify!.sender).toBe('system');
    expect((notify!.payload as { subagent: { childConversationId: string } }).subagent.childConversationId).toBe('child-1');
    expect(mgr.activeSessionForConversation(parentId)).toBeUndefined();
  });

  it('reuses the parent last real session for the marker (no null-agent pollution)', () => {
    const db = setDbRef();
    // a real agent turn on the parent
    createSession(db, { id: 'real-sess', conversationId: parentId, agentId: 'claude-code' });
    mgr.recordSpawnMarker(parentId, { kind: 'spawned', childConversationId: 'C2', text: 'spawned → C2' });
    // marker must attach to the real session, not a fresh one
    const sessions = db.prepare('SELECT id, agent_id FROM sessions WHERE conversation_id = ?').all(parentId) as { id: string; agent_id: string | null }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('real-sess');
    // last session stays the real agent one
    expect(lastSessionForConversation(db, parentId)!.agentId).toBe('claude-code');
  });
});

// helper: re-read the singleton db the manager uses
import { getDb } from './db/index.js';
function setDbRef() { return getDb(); }
