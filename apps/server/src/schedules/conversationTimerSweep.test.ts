import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { AgentProfile } from '@tierwyn/shared';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, setConversationPendingHandoffMode } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { createTimer, getTimer } from '../repositories/conversationTimers.js';
import { createSpawnEdge } from '../repositories/spawnEdges.js';
import { catalogue } from '../catalogue.js';
import { seedDefaultSettings, seedCatalogue, enableAllAgents } from '../db/seed.js';
import { updateCompactionSettings } from '../repositories/settings.js';
import { createConversationTimerSweep } from './conversationTimerSweep.js';
import { JobScheduler } from './jobScheduler.js';

const PROFILE_ID = 'claude-code:test-model';
const PROFILE: AgentProfile = {
  id: PROFILE_ID, agentType: 'claude-code', model: 'test-model',
  label: 'Test', description: '', vision: false, steer: true, enabled: true,
};
const NOW = 1_800_000_000_000;

let db: Database;
let projectId: string;
let conversationId: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  conversationId = createConversation(db, { projectId, title: 'C' }).id;
});

function seedTimer(fireAtMs = NOW, prompt = 'run the tests') {
  return createTimer(db, { conversationId, prompt, profileId: PROFILE_ID, fireAtMs, createdAt: NOW - 1 });
}

function makeSweep(handlePrompt = vi.fn(async () => 'session-1')) {
  const sweep = createConversationTimerSweep({
    getDb: () => db,
    handlePrompt,
    getProfile: (id) => (id === PROFILE_ID ? PROFILE : undefined),
  });
  return { sweep, handlePrompt };
}

describe('conversation timer sweep', () => {
  it('delivers a due timer through handlePrompt as an operator prompt', async () => {
    const timer = seedTimer();
    const { sweep, handlePrompt } = makeSweep();

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt).toHaveBeenCalledWith({
      projectId,
      conversationId,
      agent: 'claude-code',
      model: 'test-model',
      profileId: PROFILE_ID,
      text: 'run the tests',
    });
    // No `source` override → handlePrompt defaults to 'user' (normal User card).
    expect(handlePrompt.mock.calls[0][0]).not.toHaveProperty('source');
    expect(getTimer(db, timer.id)?.firedAt).toBe(NOW);
  });

  it('delivers exactly once when a session is already in flight (handlePrompt owns the steer/queue decision)', async () => {
    // agentId omitted: sessions.agent_id FKs to agents(id); this test only
    // needs a session row so the sweep sees an in-flight conversation.
    createSession(db, { id: 'live-session', conversationId });
    seedTimer();
    const { sweep, handlePrompt } = makeSweep();

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt.mock.calls[0][0].conversationId).toBe(conversationId);
  });

  it('leaves future and cancelled timers alone', async () => {
    const future = seedTimer(NOW + 60_000);
    const { sweep, handlePrompt } = makeSweep();

    await sweep(NOW);

    expect(handlePrompt).not.toHaveBeenCalled();
    expect(getTimer(db, future.id)?.firedAt).toBeNull();
  });

  it('stays claimed and records the error when handlePrompt throws', async () => {
    const timer = seedTimer();
    const { sweep } = makeSweep(vi.fn(async () => { throw new Error('adapter exploded'); }));

    await expect(sweep(NOW)).resolves.toBeUndefined();   // never throws out of tickOnce

    const after = getTimer(db, timer.id);
    expect(after?.firedAt).toBe(NOW);                    // claim-before-deliver
    expect(after?.error).toBe('adapter exploded');
  });

  it('fails a timer whose profile disappeared and keeps sweeping the rest', async () => {
    const orphan = createTimer(db, {
      conversationId, prompt: 'x', profileId: 'gone:model', fireAtMs: NOW, createdAt: NOW - 1,
    });
    const good = seedTimer();
    const { sweep, handlePrompt } = makeSweep();

    await sweep(NOW);

    expect(getTimer(db, orphan.id)?.error).toMatch(/profile/i);
    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(getTimer(db, good.id)?.error).toBeNull();
  });

  it('fails a timer whose profile is present but enabled: false', async () => {
    const timer = seedTimer();
    const handlePrompt = vi.fn(async () => 'session-1');
    const sweep = createConversationTimerSweep({
      getDb: () => db,
      handlePrompt,
      getProfile: (id) => (id === PROFILE_ID ? { ...PROFILE, enabled: false } : undefined),
    });

    await sweep(NOW);

    expect(getTimer(db, timer.id)?.error).toMatch(/profile/i);
    expect(handlePrompt).not.toHaveBeenCalled();
  });

  it('fails a timer whose agent is disabled in the live catalogue', async () => {
    db.prepare(
      `INSERT INTO agents (id, type, label, created_at, enabled_flag)
       VALUES ('claude-code', 'claude-code', 'Claude Code', ?, 0)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
       VALUES (?, 'claude-code', 'test-model', 'Test', 1, ?)`,
    ).run(PROFILE_ID, NOW);
    catalogue.load(db);
    const timer = seedTimer();
    const handlePrompt = vi.fn(async () => 'session-1');
    const sweep = createConversationTimerSweep({ getDb: () => db, handlePrompt });

    await sweep(NOW);

    expect(getTimer(db, timer.id)?.error).toMatch(/profile/i);
    expect(handlePrompt).not.toHaveBeenCalled();
  });

  it('never creates a schedule job, run, or child conversation', async () => {
    seedTimer();
    const conversationsBefore =
      (db.prepare('SELECT COUNT(*) c FROM conversations').get() as { c: number }).c;
    const { sweep } = makeSweep();

    await sweep(NOW);

    expect((db.prepare('SELECT COUNT(*) c FROM schedule_jobs').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM schedule_runs').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM conversations').get() as { c: number }).c)
      .toBe(conversationsBefore);
  });
});

describe('conversation timer sweep — snapshot delivery', () => {
  const ATT = [{ base64: 'QUJD', mediaType: 'text/plain', name: 'rebuild.log' }];

  it('spreads effort, options, attachments and handoffOverride into handlePrompt', async () => {
    createTimer(db, {
      conversationId, prompt: 'go', profileId: PROFILE_ID, fireAtMs: NOW, createdAt: NOW - 1,
      effort: 'high', options: { disableSlashCommands: true }, attachments: ATT,
      handoffOverride: 'transcript',
    });
    const { sweep, handlePrompt } = makeSweep();

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt).toHaveBeenCalledWith(expect.objectContaining({
      conversationId, text: 'go', profileId: PROFILE_ID,
      agent: 'claude-code', model: 'test-model',
      effort: 'high', options: { disableSlashCommands: true },
      attachments: ATT, handoffOverride: 'transcript',
    }));
    // Still an operator send — the sweep must not stamp a source.
    expect(handlePrompt.mock.calls[0][0]).not.toHaveProperty('source');
  });

  it('omits snapshot keys entirely when the timer has none', async () => {
    seedTimer();
    const { sweep, handlePrompt } = makeSweep();

    await sweep(NOW);

    const arg = handlePrompt.mock.calls[0][0];
    for (const key of ['effort', 'options', 'attachments', 'handoffOverride']) {
      expect(arg, `${key} must be omitted, not undefined-valued`).not.toHaveProperty(key);
    }
  });

  it('drops an effort level the profile no longer supports and still fires', async () => {
    createTimer(db, {
      conversationId, prompt: 'go', profileId: PROFILE_ID, fireAtMs: NOW, createdAt: NOW - 1,
      // claude-code does not have a 'turbo' level — clampEffort drops it.
      effort: 'turbo' as 'high',
    });
    const { sweep, handlePrompt } = makeSweep();

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt.mock.calls[0][0]).not.toHaveProperty('effort');
  });

  it('fires plain when a stored options snapshot no longer sanitises', async () => {
    const t = createTimer(db, {
      conversationId, prompt: 'go', profileId: PROFILE_ID, fireAtMs: NOW, createdAt: NOW - 1,
    });
    db.prepare('UPDATE conversation_timers SET options = ? WHERE id = ?')
      .run(JSON.stringify({ jsonSchema: '-danger' }), t.id);
    const { sweep, handlePrompt } = makeSweep();

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt.mock.calls[0][0]).not.toHaveProperty('options');
    expect(getTimer(db, t.id)!.error).toBeNull();   // a dropped option is not a delivery failure
  });
});

const GLM_ID = 'hermes:GLM-5.3-Flash';
const GROK_ID = 'grok-build:grok-4.5';
const GLM_PROFILE: AgentProfile = {
  id: GLM_ID, agentType: 'hermes', model: 'GLM-5.3-Flash',
  label: 'GLM Flash', description: '', vision: false, steer: true, enabled: true,
};
const GROK_PROFILE: AgentProfile = {
  id: GROK_ID, agentType: 'grok-build', model: 'grok-4.5',
  label: 'Grok 4.5', description: '', vision: false, steer: true, enabled: true,
};

function insertProfileRows(agentId: string, profileId: string, model: string) {
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, type, label, created_at) VALUES (?, ?, ?, ?)`,
  ).run(agentId, agentId, agentId, NOW);
  db.prepare(
    `INSERT OR REPLACE INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(profileId, agentId, model, model, NOW);
}

describe('conversation timer sweep — hanging handlePrompt does not stall later ticks', () => {
  it('finishes the sweep while the first handlePrompt is outstanding, then claims a later due timer', async () => {
    const first = seedTimer(NOW, 'first prompt');
    let resolveFirst!: (v: string) => void;
    const firstHang = new Promise<string>((r) => { resolveFirst = r; });
    const handlePrompt = vi.fn((input: { text: string }) => {
      if (input.text === 'first prompt') return firstHang;
      return Promise.resolve('session-2');
    });
    const { sweep } = makeSweep(handlePrompt);

    const firstSweep = sweep(NOW);
    await expect(firstSweep).resolves.toBeUndefined();
    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(getTimer(db, first.id)?.firedAt).toBe(NOW);

    const second = createTimer(db, {
      conversationId, prompt: 'second prompt', profileId: PROFILE_ID,
      fireAtMs: NOW + 5_000, createdAt: NOW,
    });
    await sweep(NOW + 5_000);

    expect(handlePrompt).toHaveBeenCalledTimes(2);
    expect(handlePrompt.mock.calls[1][0].text).toBe('second prompt');
    expect(getTimer(db, second.id)?.firedAt).toBe(NOW + 5_000);

    resolveFirst('session-1');
    await firstHang;
  });

  it('tickOnce clears the ticking guard even when handlePrompt never resolves, so the next tick claims another timer', async () => {
    seedTimer(NOW, 'first prompt');
    let resolveFirst!: (v: string) => void;
    const firstHang = new Promise<string>((r) => { resolveFirst = r; });
    const handlePrompt = vi.fn((input: { text: string }) => {
      if (input.text === 'first prompt') return firstHang;
      return Promise.resolve('session-2');
    });
    const sweep = createConversationTimerSweep({
      getDb: () => db,
      handlePrompt,
      getProfile: (id) => (id === PROFILE_ID ? PROFILE : undefined),
    });
    let now = NOW;
    const scheduler = new JobScheduler({
      getDb: () => db,
      dispatchTick: async () => {},
      sweepTimers: sweep,
      now: () => now,
    });

    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
    expect(handlePrompt).toHaveBeenCalledTimes(1);

    const second = createTimer(db, {
      conversationId, prompt: 'second prompt', profileId: PROFILE_ID,
      fireAtMs: NOW + 5_000, createdAt: NOW,
    });
    now = NOW + 5_000;
    await expect(scheduler.tickOnce()).resolves.toBeUndefined();

    expect(handlePrompt).toHaveBeenCalledTimes(2);
    expect(handlePrompt.mock.calls[1][0].text).toBe('second prompt');
    expect(getTimer(db, second.id)?.firedAt).toBe(NOW + 5_000);

    resolveFirst('session-1');
    await firstHang;
  });
});

describe('conversation timer sweep — fire-time handoff override', () => {
  beforeEach(() => {
    seedDefaultSettings(db);
    updateCompactionSettings(db, { handoffMode: 'prompt' });
    insertProfileRows('hermes', GLM_ID, 'GLM-5.3-Flash');
    insertProfileRows('grok-build', GROK_ID, 'grok-4.5');
  });

  function makeCrossSweep(handlePrompt = vi.fn(async () => 'session-1')) {
    const sweep = createConversationTimerSweep({
      getDb: () => db,
      handlePrompt,
      getProfile: (id) => {
        if (id === GLM_ID) return GLM_PROFILE;
        if (id === GROK_ID) return GROK_PROFILE;
        if (id === PROFILE_ID) return PROFILE;
        return undefined;
      },
    });
    return { sweep, handlePrompt };
  }

  it('defaults handoffOverride to summary when last session profile differs and snapshot is null', async () => {
    createSession(db, {
      id: 'prev-glm', conversationId,
      agentId: 'hermes', agentModelId: GLM_ID,
    });
    createTimer(db, {
      conversationId, prompt: 'Another test', profileId: GROK_ID,
      fireAtMs: NOW, createdAt: NOW - 1,
    });
    const { sweep, handlePrompt } = makeCrossSweep();

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt.mock.calls[0][0]).toEqual(expect.objectContaining({
      profileId: GROK_ID,
      text: 'Another test',
      handoffOverride: 'summary',
    }));
  });

  it('omits handoffOverride when the last session profile matches the timer', async () => {
    createSession(db, {
      id: 'prev-grok', conversationId,
      agentId: 'grok-build', agentModelId: GROK_ID,
    });
    createTimer(db, {
      conversationId, prompt: 'same model', profileId: GROK_ID,
      fireAtMs: NOW, createdAt: NOW - 1,
    });
    const { sweep, handlePrompt } = makeCrossSweep();

    await sweep(NOW);

    expect(handlePrompt.mock.calls[0][0]).not.toHaveProperty('handoffOverride');
  });

  it('ignores a stored snapshot when the last session already matches the timer profile', async () => {
    createSession(db, {
      id: 'prev-grok', conversationId,
      agentId: 'grok-build', agentModelId: GROK_ID,
    });
    createTimer(db, {
      conversationId, prompt: 'stale snapshot', profileId: GROK_ID,
      fireAtMs: NOW, createdAt: NOW - 1,
      handoffOverride: 'summary',
    });
    const { sweep, handlePrompt } = makeCrossSweep();

    await sweep(NOW);

    expect(handlePrompt.mock.calls[0][0]).not.toHaveProperty('handoffOverride');
  });

  it('omits handoffOverride when there is no prior session', async () => {
    createTimer(db, {
      conversationId, prompt: 'fresh', profileId: GROK_ID,
      fireAtMs: NOW, createdAt: NOW - 1,
    });
    const { sweep, handlePrompt } = makeCrossSweep();

    await sweep(NOW);

    expect(handlePrompt.mock.calls[0][0]).not.toHaveProperty('handoffOverride');
  });

  it('lets a stored transcript snapshot win over the fire-time default', async () => {
    createSession(db, {
      id: 'prev-glm', conversationId,
      agentId: 'hermes', agentModelId: GLM_ID,
    });
    createTimer(db, {
      conversationId, prompt: 'keep transcript', profileId: GROK_ID,
      fireAtMs: NOW, createdAt: NOW - 1,
      handoffOverride: 'transcript',
    });
    const { sweep, handlePrompt } = makeCrossSweep();

    await sweep(NOW);

    expect(handlePrompt.mock.calls[0][0].handoffOverride).toBe('transcript');
  });
});

// [S1-2] A deferred (non-operator) timer on a spawned child is NOT an operator
// turn: the sweep must resolve the child's spawn edge and deliver the prompt
// with parent_message sourcing so the result bridges back up the tree
// (handlePrompt derives the upward bridge from source + subagent.replyTo).
describe('[S1-2] deferred timer delivery carries parent_message context', () => {
  let parent: string;
  let child: string;

  beforeEach(() => {
    parent = conversationId;
    child = createConversation(db, { projectId, title: 'child', parentConversationId: parent }).id;
  });

  function childTimer(origin: 'agent-resume' | 'auto-resume', extra: Partial<Parameters<typeof createTimer>[1]> = {}) {
    return createTimer(db, {
      conversationId: child, prompt: 'continue after usage limit', profileId: PROFILE_ID,
      fireAtMs: NOW, createdAt: NOW - 1, origin, ...extra,
    });
  }

  it('an agent-resume timer on a spawned child delivers as a parent-sourced bypass turn', async () => {
    createSpawnEdge(db, {
      parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: true,
    });
    const { sweep, handlePrompt } = makeSweep();

    childTimer('agent-resume');

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt.mock.calls[0][0]).toMatchObject({
      conversationId: child,
      source: 'parent_message',
      interactionMode: 'bypass',
      subagent: { role: 'auditor', childConversationId: child, replyTo: parent },
    });
  });

  it('a grandchild deferral notifies the middle agent (replyTo from the edge)', async () => {
    const middle = child;
    const leaf = createConversation(db, { projectId, title: 'leaf', parentConversationId: middle }).id;
    createSpawnEdge(db, {
      parentConversationId: middle, childConversationId: leaf, role: 'impl', notifyParent: true,
    });
    const { sweep, handlePrompt } = makeSweep();

    createTimer(db, {
      conversationId: leaf, prompt: 'continue after usage limit', profileId: PROFILE_ID,
      fireAtMs: NOW, createdAt: NOW - 1, origin: 'auto-resume',
    });

    await sweep(NOW);

    expect(handlePrompt.mock.calls[0][0]).toMatchObject({
      conversationId: leaf,
      source: 'parent_message',
      subagent: { role: 'impl', childConversationId: leaf, replyTo: middle },
    });
  });

  it('a safe-mode child keeps its safe-mode options and still gains bypass', async () => {
    createSpawnEdge(db, {
      parentConversationId: parent, childConversationId: child, notifyParent: true,
    });
    const { sweep, handlePrompt } = makeSweep();

    childTimer('agent-resume', { options: { safeMode: true } });

    await sweep(NOW);

    expect(handlePrompt.mock.calls[0][0]).toMatchObject({
      conversationId: child,
      source: 'parent_message',
      interactionMode: 'bypass',
      options: { safeMode: true },
    });
  });

  it('operator-origin timers stay plain sends, even on a conversation with an edge', async () => {
    createSpawnEdge(db, {
      parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: true,
    });
    const { sweep, handlePrompt } = makeSweep();

    createTimer(db, {
      conversationId: child, prompt: 'remind me', profileId: PROFILE_ID,
      fireAtMs: NOW, createdAt: NOW - 1, origin: 'operator',
    });

    await sweep(NOW);

    const delivered = handlePrompt.mock.calls[0][0];
    expect(delivered.source).toBeUndefined();
    expect(delivered.subagent).toBeUndefined();
    expect(delivered.interactionMode).toBeUndefined();
  });

  it('timer.notifyParent true is spread onto subagent.notify even when the edge is false', async () => {
    createSpawnEdge(db, {
      parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: false,
    });
    const { sweep, handlePrompt } = makeSweep();
    childTimer('agent-resume', { notifyParent: true });
    await sweep(NOW);
    expect(handlePrompt.mock.calls[0][0].subagent).toMatchObject({
      role: 'auditor', childConversationId: child, replyTo: parent, notify: true,
    });
  });

  it('timer.notifyParent false is spread onto subagent.notify even when the edge is true', async () => {
    createSpawnEdge(db, {
      parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: true,
    });
    const { sweep, handlePrompt } = makeSweep();
    childTimer('agent-resume', { notifyParent: false });
    await sweep(NOW);
    expect(handlePrompt.mock.calls[0][0].subagent).toMatchObject({ notify: false });
  });

  it('null notifyParent omits subagent.notify (inherit edge at bridge time)', async () => {
    createSpawnEdge(db, {
      parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: true,
    });
    const { sweep, handlePrompt } = makeSweep();
    childTimer('agent-resume'); // omitted → null
    await sweep(NOW);
    expect(handlePrompt.mock.calls[0][0].subagent).toEqual({
      role: 'auditor', childConversationId: child, replyTo: parent,
    });
    expect('notify' in handlePrompt.mock.calls[0][0].subagent).toBe(false);
  });

  it('operator-origin timer with notifyParent true still has no subagent', async () => {
    createSpawnEdge(db, {
      parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: true,
    });
    const { sweep, handlePrompt } = makeSweep();
    createTimer(db, {
      conversationId: child, prompt: 'remind me', profileId: PROFILE_ID,
      fireAtMs: NOW, createdAt: NOW - 1, origin: 'operator', notifyParent: true,
    });
    await sweep(NOW);
    const delivered = handlePrompt.mock.calls[0][0];
    expect(delivered.source).toBeUndefined();
    expect(delivered.subagent).toBeUndefined();
  });

  it('an agent-self timer on a spawned child is a plain bypass turn — it does NOT relay to the parent', async () => {
    createSpawnEdge(db, { parentConversationId: parent, childConversationId: child, role: 'auditor', notifyParent: true });
    const { sweep, handlePrompt } = makeSweep();
    createTimer(db, { conversationId: child, prompt: 'self wake', profileId: PROFILE_ID, fireAtMs: NOW, createdAt: NOW - 1, origin: 'agent-self' });
    await sweep(NOW);
    const input = handlePrompt.mock.calls[0][0];
    expect(input).toMatchObject({ conversationId: child, interactionMode: 'bypass', text: 'self wake' });
    expect(input).not.toHaveProperty('source');
    expect(input).not.toHaveProperty('subagent');
  });

  it('an agent-self timer on a root delivers as a plain top-level prompt', async () => {
    const { sweep, handlePrompt } = makeSweep();
    createTimer(db, { conversationId: parent, prompt: 'root wake', profileId: PROFILE_ID, fireAtMs: NOW, createdAt: NOW - 1, origin: 'agent-self' });
    await sweep(NOW);
    const input = handlePrompt.mock.calls[0][0];
    expect(input).toMatchObject({ conversationId: parent, text: 'root wake' });
    expect(input).not.toHaveProperty('source');
    expect(input).not.toHaveProperty('interactionMode');
  });
});



describe('conversation timer sweep — default handoff under handoffMode prompt', () => {
  beforeEach(() => { seedCatalogue(db); enableAllAgents(db); seedDefaultSettings(db); });
  const run = async (lastAgent: string, lastModel: string) => {
    updateCompactionSettings(db, { handoffMode: 'prompt' });
    createSession(db, { id: 'prev', conversationId, agentId: lastAgent, agentModelId: lastModel });
    seedTimer();
    const { sweep, handlePrompt } = makeSweep();
    await sweep(NOW);
    return handlePrompt.mock.calls[0][0] as { handoffOverride?: string };
  };

  it('same-agent model change keeps native resume (no override)', async () => {
    const sibling = (db.prepare("SELECT id FROM agent_models WHERE agent_id = 'claude-code' LIMIT 1").get() as { id: string });
    expect(await run('claude-code', sibling.id)).not.toHaveProperty('handoffOverride');
  });

  it('cross-agent switch defaults to summary', async () => {
    const other = (db.prepare("SELECT id, agent_id FROM agent_models WHERE agent_id <> 'claude-code' LIMIT 1").get() as { id: string; agent_id: string });
    expect((await run(other.agent_id, other.id)).handoffOverride).toBe('summary');
  });
});

describe('conversation timer sweep — staged handoff', () => {
  beforeEach(() => { seedCatalogue(db); enableAllAgents(db); seedDefaultSettings(db); });

  it('an agent-resume timer with no snapshot + staged fresh → handlePrompt gets fresh and onPendingHandoffConsumed is called', async () => {
    setConversationPendingHandoffMode(db, conversationId, 'fresh');
    const onConsumed = vi.fn();
    const handlePrompt = vi.fn(async () => 'sess-1');
    const sweep = createConversationTimerSweep({
      getDb: () => db,
      handlePrompt,
      getProfile: (id) => (id === PROFILE_ID ? PROFILE : undefined),
      onPendingHandoffConsumed: onConsumed,
    });
    createTimer(db, {
      conversationId,
      prompt: 'resume work',
      profileId: PROFILE_ID,
      fireAtMs: NOW,
      createdAt: NOW - 1,
      origin: 'agent-resume',
    });

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt.mock.calls[0][0].handoffOverride).toBe('fresh');
    expect(onConsumed).toHaveBeenCalledWith(conversationId);
  });

  it('an operator timer ignores staged', async () => {
    setConversationPendingHandoffMode(db, conversationId, 'fresh');
    const onConsumed = vi.fn();
    const handlePrompt = vi.fn(async () => 'sess-1');
    const sweep = createConversationTimerSweep({
      getDb: () => db,
      handlePrompt,
      getProfile: (id) => (id === PROFILE_ID ? PROFILE : undefined),
      onPendingHandoffConsumed: onConsumed,
    });
    createTimer(db, {
      conversationId,
      prompt: 'operator work',
      profileId: PROFILE_ID,
      fireAtMs: NOW,
      createdAt: NOW - 1,
      origin: 'operator',
    });

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt.mock.calls[0][0]).not.toHaveProperty('handoffOverride');
    expect(onConsumed).not.toHaveBeenCalled();
  });

  it('an agent-resume timer with same profile as last session and snapshot fresh → handlePrompt gets fresh', async () => {
    insertProfileRows('claude-code', PROFILE_ID, 'test-model');
    createSession(db, {
      id: 'prev-sess',
      conversationId,
      agentId: 'claude-code',
      agentModelId: PROFILE_ID,
    });

    const handlePrompt = vi.fn(async () => 'sess-2');
    const sweep = createConversationTimerSweep({
      getDb: () => db,
      handlePrompt,
      getProfile: (id) => (id === PROFILE_ID ? PROFILE : undefined),
    });
    createTimer(db, {
      conversationId,
      prompt: 'resume work with fresh session',
      profileId: PROFILE_ID,
      fireAtMs: NOW,
      createdAt: NOW - 1,
      origin: 'agent-resume',
      handoffOverride: 'fresh',
    });

    await sweep(NOW);

    expect(handlePrompt).toHaveBeenCalledTimes(1);
    expect(handlePrompt.mock.calls[0][0].handoffOverride).toBe('fresh');
  });
});
