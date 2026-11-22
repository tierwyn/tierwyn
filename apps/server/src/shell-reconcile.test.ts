import { describe, it, expect } from 'vitest';
import type { ChildProcess } from 'child_process';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedDefaultSettings } from './db/seed.js';
import { setDb } from './db/index.js';
import { catalogue } from './catalogue.js';
import { createProject } from './repositories/projects.js';
import { createConversation } from './repositories/conversations.js';
import { createSession } from './repositories/sessions.js';
import {
  appendEvent,
  listEventsForConversation,
  listOrphanShellToolCalls,
} from './repositories/events.js';
import { SessionManager } from './sessionManager.js';

const STARTUP_MSG = '⚠ Server restarted while this command was running — output was lost.';
const SHUTDOWN_MSG = '⚠ Server shutting down — command interrupted. Output may be partial.';

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
  createSession(db, {
    id: 's1',
    conversationId: c.id,
    agentId: 'claude-code',
    agentModelId: 'claude-code:opus-4.8',
  });
  const mgr = new SessionManager({ broadcast: () => {} });
  return { db, projectId: p.id, conversationId: c.id, mgr };
}

describe('shell orphan reconcile', () => {
  it('1. orphan tool_call → synthesized startup result', () => {
    const { db, conversationId, mgr } = boot();
    const toolUseId = mgr.recordShellStart(conversationId, { command: 'ls', cwd: '/tmp' });

    const n = mgr.reconcileOrphanShellResults(db);
    expect(n).toBe(1);

    const results = listEventsForConversation(db, conversationId).filter(
      (e) => e.type === 'tool_result',
    );
    expect(results).toHaveLength(1);
    const payload = results[0]!.payload as {
      toolUseId: string;
      content: string;
      isError: boolean;
    };
    expect(payload.toolUseId).toBe(toolUseId);
    expect(payload.content).toBe(STARTUP_MSG);
    expect(payload.isError).toBe(true);
    expect(results[0]!.sender).toBe('system');
  });

  it('2. non-orphan (matching result present) is untouched', () => {
    const { db, conversationId, mgr } = boot();
    const toolUseId = mgr.recordShellStart(conversationId, { command: 'ls', cwd: '/tmp' });
    mgr.recordShellResult(conversationId, toolUseId, {
      content: 'ok',
      isError: false,
    });
    const before = listEventsForConversation(db, conversationId).filter(
      (e) => e.type === 'tool_result',
    ).length;

    const n = mgr.reconcileOrphanShellResults(db);
    expect(n).toBe(0);
    const after = listEventsForConversation(db, conversationId).filter(
      (e) => e.type === 'tool_result',
    ).length;
    expect(after).toBe(before);
  });

  it('2b. global toolUseId anti-join: result in different session still matches', () => {
    const { db, conversationId, mgr } = boot();
    // tool_call lands in session s1 via ensureShellSessionId
    const toolUseId = mgr.recordShellStart(conversationId, { command: 'ls', cwd: '/tmp' });

    // Matching tool_result in a *different* session row (same conversation)
    createSession(db, {
      id: 's2',
      conversationId,
      agentId: 'claude-code',
      agentModelId: 'claude-code:opus-4.8',
    });
    appendEvent(db, {
      sessionId: 's2',
      type: 'tool_result',
      payload: { toolUseId, content: 'from session B', isError: false },
      sender: 'system',
      ts: Date.now(),
      seq: 0,
    });

    expect(listOrphanShellToolCalls(db)).toHaveLength(0);
    expect(mgr.reconcileOrphanShellResults(db)).toBe(0);
  });

  it('3. reconcile is idempotent (double call → one result)', () => {
    const { db, conversationId, mgr } = boot();
    const toolUseId = mgr.recordShellStart(conversationId, { command: 'ls', cwd: '/tmp' });

    expect(mgr.reconcileOrphanShellResults(db)).toBe(1);
    expect(mgr.reconcileOrphanShellResults(db)).toBe(0);

    const results = listEventsForConversation(db, conversationId).filter(
      (e) =>
        e.type === 'tool_result' &&
        (e.payload as { toolUseId?: string }).toolUseId === toolUseId,
    );
    expect(results).toHaveLength(1);
  });

  it('4. non-shell agent tool_call is ignored', () => {
    const { db, conversationId, mgr } = boot();
    appendEvent(db, {
      sessionId: 's1',
      type: 'tool_call',
      payload: { toolUseId: 'agent-tc-1', name: 'Bash', input: { command: 'echo hi' } },
      sender: 'agent',
      ts: Date.now(),
      seq: 0,
    });

    expect(listOrphanShellToolCalls(db)).toHaveLength(0);
    expect(mgr.reconcileOrphanShellResults(db)).toBe(0);
  });

  it('5. shutdown settle persists interrupted result, kills child, clears registry', () => {
    const { db, conversationId, mgr } = boot();
    const toolUseId = mgr.recordShellStart(conversationId, { command: 'sleep 30', cwd: '/tmp' });

    let killedWith: string | undefined;
    const stub = {
      kill: (signal?: string) => {
        killedWith = signal;
      },
      once: () => {},
    } as unknown as ChildProcess;

    mgr.registerShellChild(toolUseId, stub, conversationId);
    mgr.settleShellChildrenForShutdown();

    expect(killedWith).toBe('SIGTERM');

    const results = listEventsForConversation(db, conversationId).filter(
      (e) => e.type === 'tool_result',
    );
    expect(results).toHaveLength(1);
    const payload = results[0]!.payload as {
      toolUseId: string;
      content: string;
      isError: boolean;
    };
    expect(payload.toolUseId).toBe(toolUseId);
    expect(payload.content).toBe(SHUTDOWN_MSG);
    expect(payload.isError).toBe(true);

    // Registry empty: a second settle must not write another result
    mgr.settleShellChildrenForShutdown();
    const resultsAfter = listEventsForConversation(db, conversationId).filter(
      (e) => e.type === 'tool_result',
    );
    expect(resultsAfter).toHaveLength(1);
  });
});
