import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, enableAllAgents, seedCommands, seedDefaultSettings } from '../db/seed.js';
import { catalogue } from '../catalogue.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, isStopped } from '../repositories/conversations.js';
import { createSpawnEdge, getEdgeByChild, resolveSpawnEdge } from '../repositories/spawnEdges.js';
import { createTimer, listPendingTimers } from '../repositories/conversationTimers.js';
import { SessionManager } from '../sessionManager.js';
import { projectAwareness } from '../mesh/awareness.js';
import { watchChildResult } from './watch.js';
import { stopChild, WRAP_UP_TEXT } from './stop.js';

let mgr: SessionManager;
let parentId: string;
let projectId: string;

function makeChild(opts: { notifyParent?: boolean; role?: string } = {}) {
  const child = createConversation(getDb(), {
    projectId, title: 'child', parentConversationId: parentId,
  });
  createSpawnEdge(getDb(), {
    parentConversationId: parentId,
    childConversationId: child.id,
    role: opts.role ?? 'impl',
    notifyParent: opts.notifyParent ?? false,
  });
  return child.id;
}

beforeEach(() => {
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedCatalogue(db); enableAllAgents(db); seedCommands(db); seedDefaultSettings(db);
  setDb(db);
  catalogue.load(db);
  const project = createProject(db, { name: 'p', rootPath: process.cwd() });
  projectId = project.id;
  parentId = createConversation(db, { projectId, title: 'root' }).id;
  mgr = new SessionManager({ broadcast: () => {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stopChild', () => {
  it('kills a mid-turn child after grace', async () => {
    const childId = makeChild();
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockReturnValue({ id: 's1', lastStatus: 'running' } as never);
    vi.spyOn(mgr, 'steerSession').mockResolvedValue({ mode: 'injected', queueLength: 0 } as never);
    const stopSpy = vi.spyOn(mgr, 'stopSession').mockResolvedValue({ stopped: true });
    const { promise } = watchChildResult(childId, { onHeartbeat: () => {}, onStalled: () => {} });

    const out = await stopChild(mgr, { childId, callerId: parentId, graceMs: 0 });

    expect(out.stopped).toBe('killed');
    expect(stopSpy).toHaveBeenCalledWith('s1');
    const watch = await promise;
    expect(watch.stopped).toBe(true);
    expect(watch.prose).toMatch(/◼ stopped-by-parent/);
    const edge = getEdgeByChild(getDb(), childId)!;
    expect(edge.status).toBe('interrupted');
    expect(edge.outcome).toBe('stopped');
    expect(isStopped(getDb(), childId)).toBe(true);
    const peers = projectAwareness({ db: getDb(), conversationId: parentId, active: [] });
    const childPeer = peers.find((p) => p.conversationId === childId);
    expect(childPeer?.status).toBe('stopped');
    expect(childPeer?.canMessage).toBe(false);
  });

  it('idle child alreadyStopped and cancels agent-resume timers but not operator timers', async () => {
    const childId = makeChild();
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockReturnValue(undefined);
    const stopSpy = vi.spyOn(mgr, 'stopSession').mockResolvedValue({ stopped: true });
    createTimer(getDb(), {
      conversationId: childId, prompt: 'resume', profileId: 'claude-code:x',
      fireAtMs: Date.now() + 60_000, origin: 'agent-resume',
    });
    createTimer(getDb(), {
      conversationId: childId, prompt: 'op', profileId: 'claude-code:x',
      fireAtMs: Date.now() + 120_000, origin: 'operator',
    });

    const out = await stopChild(mgr, { childId, callerId: parentId, graceMs: 0 });

    expect(out.alreadyStopped).toBe(true);
    expect(out.stopped).toBe('already-stopped');
    expect(out.timerCancelled).toBe(true);
    expect(stopSpy).not.toHaveBeenCalled();
    const pending = listPendingTimers(getDb(), childId);
    expect(pending).toHaveLength(1);
    expect(pending[0].origin).toBe('operator');
  });

  it('notify fires exactly once with marker iff the edge is armed', async () => {
    const armedId = makeChild({ notifyParent: true });
    const notifySpy = vi.spyOn(mgr, 'notifyParentSubagentResult').mockImplementation(() => {});
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockReturnValue(undefined);

    const armed = await stopChild(mgr, { childId: armedId, callerId: parentId, graceMs: 0 });
    expect(armed.notifyFired).toBe(true);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0]).toBe(parentId);
    expect(notifySpy.mock.calls[0][1]).toMatch(/^◼ stopped-by-parent/);

    const again = await stopChild(mgr, { childId: armedId, callerId: parentId, graceMs: 0 });
    expect(again.notifyFired).toBe(false);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    notifySpy.mockClear();
    const unarmedId = makeChild({ notifyParent: false });
    const unarmed = await stopChild(mgr, { childId: unarmedId, callerId: parentId, graceMs: 0 });
    expect(unarmed.notifyFired).toBe(false);
    expect(notifySpy).not.toHaveBeenCalled();

    const resolvedId = makeChild({ notifyParent: true });
    const edge = getEdgeByChild(getDb(), resolvedId)!;
    resolveSpawnEdge(getDb(), edge.id, 'resolved', 'success');
    const resolved = await stopChild(mgr, { childId: resolvedId, callerId: parentId, graceMs: 0 });
    expect(resolved.notifyFired).toBe(false);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('settles inside grace without stopSession', async () => {
    const childId = makeChild({ notifyParent: true });
    let polls = 0;
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockImplementation(() => {
      polls += 1;
      if (polls <= 2) return { id: 's1', lastStatus: 'running' } as never;
      return undefined;
    });
    vi.spyOn(mgr, 'steerSession').mockResolvedValue({ mode: 'injected', queueLength: 0 } as never);
    const stopSpy = vi.spyOn(mgr, 'stopSession').mockResolvedValue({ stopped: true });
    const notifySpy = vi.spyOn(mgr, 'notifyParentSubagentResult').mockImplementation(() => {});

    const out = await stopChild(mgr, { childId, callerId: parentId, graceMs: 500 });

    expect(out.stopped).toBe('settled-naturally');
    expect(stopSpy).not.toHaveBeenCalled();
    expect(getEdgeByChild(getDb(), childId)!.status).toBe('open');
    expect(out.notifyFired).toBe(false);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('queued wrap-up is removed', async () => {
    const childId = makeChild();
    const wrap = WRAP_UP_TEXT(100);
    let live = true;
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockImplementation(() =>
      live ? { id: 's1', lastStatus: 'running' } as never : undefined,
    );
    vi.spyOn(mgr, 'steerSession').mockResolvedValue({ mode: 'queued', queueLength: 1 } as never);
    vi.spyOn(mgr, 'getSession').mockReturnValue({
      steerQueue: [{ id: 'q-wrap', text: wrap }],
    } as never);
    const cancelSpy = vi.spyOn(mgr, 'cancelSteerMessage').mockImplementation(async () => {
      live = false;
    });
    vi.spyOn(mgr, 'stopSession').mockResolvedValue({ stopped: true });

    const out = await stopChild(mgr, { childId, callerId: parentId, graceMs: 100 });

    expect(cancelSpy).toHaveBeenCalledWith(childId, 's1', 'q-wrap');
    expect(out.wrapUpDelivered).toBe(false);
  });

  it('double concurrent stop shares one kill', async () => {
    const childId = makeChild({ notifyParent: true });
    vi.spyOn(mgr, 'inFlightSessionForConversation').mockReturnValue({ id: 's1', lastStatus: 'running' } as never);
    const stopSpy = vi.spyOn(mgr, 'stopSession').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { stopped: true };
    });
    const notifySpy = vi.spyOn(mgr, 'notifyParentSubagentResult').mockImplementation(() => {});

    const [a, b] = await Promise.all([
      stopChild(mgr, { childId, callerId: parentId, graceMs: 0 }),
      stopChild(mgr, { childId, callerId: parentId, graceMs: 0 }),
    ]);

    expect(a).toEqual(b);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
