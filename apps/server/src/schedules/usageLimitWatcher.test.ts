import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import {
  isLimitedGroup,
  earliestResetsAt,
  classifyUsageCard,
  createUsageLimitWatcher,
  findUsageProvider,
  findBuiltinUsageCard,
} from './usageLimitWatcher.js';

let db: Database;
let projectId: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
});

function seedAgentModel(type: string, model: string): { agentId: string; modelId: string } {
  const agentId = `agent-${type}`;
  const modelId = `model-${type}-${model}`;
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, type, label, env_vars, created_at) VALUES (?, ?, ?, '{}', ?)`,
  ).run(agentId, type, type, 1);
  db.prepare(
    `INSERT OR IGNORE INTO agent_models (id, agent_id, model_name, label, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(modelId, agentId, model, model, 1);
  return { agentId, modelId };
}

function seedLastSession(
  conversationId: string,
  sessionId: string,
  agentId: string,
  modelId: string,
  createdAt = 1,
): void {
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, agent_id, agent_model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, conversationId, agentId, modelId, createdAt, createdAt);
}

/** Conversation whose last session ran on the given agentType/model. */
function seedConversationOn(type: string, model: string, n: number): string {
  const { agentId, modelId } = seedAgentModel(type, model);
  const conversationId = createConversation(db, { projectId, title: `C${n}` }).id;
  seedLastSession(conversationId, `s-${conversationId}`, agentId, modelId);
  return conversationId;
}

describe('isLimitedGroup', () => {
  it('confirms at 99 not only 100', () => {
    expect(isLimitedGroup({ id: 'd', label: 'd', fiveHourPct: 99 })).toBe(true);
    expect(isLimitedGroup({ id: 'd', label: 'd', fiveHourPct: 98.9 })).toBe(false);
  });

  it('flags exhausted credits', () => {
    expect(isLimitedGroup({ id: 'd', label: 'd', creditsUsed: 10, creditsLimit: 10 })).toBe(true);
    expect(isLimitedGroup({ id: 'd', label: 'd', creditsUsed: 9, creditsLimit: 10 })).toBe(false);
    expect(isLimitedGroup({ id: 'd', label: 'd', creditsUsed: 10 })).toBe(false);
  });
});

describe('earliestResetsAt', () => {
  it('returns the earliest defined reset across windows', () => {
    expect(earliestResetsAt({ id: 'd', label: 'd', sevenDayResetsAt: 300, fiveHourResetsAt: 100 })).toBe(100);
    expect(earliestResetsAt({ id: 'd', label: 'd', monthlyResetsAt: 200 })).toBe(200);
    expect(earliestResetsAt({ id: 'd', label: 'd' })).toBeUndefined();
  });
});

describe('classifyUsageCard', () => {
  it('headroom when windows are low', () => {
    expect(classifyUsageCard({ groups: [{ id: 'd', label: 'd', fiveHourPct: 10 }], installed: true }).kind).toBe('headroom');
  });

  it('limited with resetsAt from the matching window', () => {
    const v = classifyUsageCard({
      id: 'claude-code',
      label: 'Claude Code',
      groups: [{ id: 'd', label: 'd', fiveHourPct: 100, fiveHourResetsAt: 50 }],
      installed: true,
    });
    expect(v).toEqual({ kind: 'limited', resetsAt: 50, cardLabel: 'Claude Code' });
  });

  it('limited with null resetsAt when the limited window has no timestamp', () => {
    const v = classifyUsageCard({
      id: 'x',
      label: 'X',
      groups: [{ id: 'd', label: 'd', fiveHourPct: 100 }],
      installed: true,
    });
    expect(v).toEqual({ kind: 'limited', resetsAt: null, cardLabel: 'X' });
  });

  it('unclassified on probe error', () => {
    expect(classifyUsageCard({ error: 'boom', groups: [] }).kind).toBe('unclassified');
    expect(classifyUsageCard({ installed: false, groups: [] }).kind).toBe('unclassified');
    expect(classifyUsageCard({ ok: false, groups: [] }).kind).toBe('unclassified');
  });

  it('[S2-4a] ok card with empty or missing groups is unclassified, not headroom', () => {
    expect(classifyUsageCard({ id: 'x', label: 'X', installed: true, ok: true, groups: [] }).kind).toBe('unclassified');
    expect(classifyUsageCard({ id: 'x', label: 'X', installed: true, ok: true }).kind).toBe('unclassified');
  });
});

describe('findUsageProvider / findBuiltinUsageCard (S2-4b profile routing)', () => {
  const providerCard = {
    id: 'zai-usage',
    label: 'Z.AI',
    configured: true,
    ok: true,
    profiles: [{ profileId: 'p1', label: 'P1', agentType: 'hermes', model: 'glm-5.3', enabled: true }],
  };

  it('[S2-4b] resolves a provider by stamped agentType+model, never by provider id', () => {
    expect(findUsageProvider([providerCard], 'hermes', 'glm-5.3')).toBe(providerCard);
    // The old dead branch matched `p.id === agentType` — agent types are not plugin ids.
    expect(findUsageProvider([providerCard], 'zai-usage', 'glm-5.3')).toBeUndefined();
    // A stale or different model must not win the probe.
    expect(findUsageProvider([providerCard], 'hermes', 'glm-5.2')).toBeUndefined();
    expect(findUsageProvider([providerCard], 'claude-code', 'opus')).toBeUndefined();
  });

  it('[S2-4b] builtin card must carry a stamped profile with the exact model — no any-model fallback', () => {
    const builtin = {
      agentType: 'claude-code',
      label: 'Claude Code',
      installed: true,
      groups: [{ id: 'd', label: 'd', fiveHourPct: 40 }],
      profiles: [{ profileId: 'p2', label: 'P2', agentType: 'claude-code', model: 'opus', enabled: true }],
    };
    expect(findBuiltinUsageCard([builtin], 'claude-code', 'opus')).toBe(builtin);
    expect(findBuiltinUsageCard([builtin], 'claude-code', 'sonnet')).toBeUndefined();
    expect(findBuiltinUsageCard(
      [{ agentType: 'kiro', label: 'Kiro', installed: true, groups: [], profiles: [] }],
      'kiro',
      'sonnet',
    )).toBeUndefined();
    expect(findBuiltinUsageCard(
      [{ agentType: 'kiro', label: 'Kiro', installed: true, groups: [] }],
      'kiro',
      'sonnet',
    )).toBeUndefined();
  });
});

describe('createUsageLimitWatcher layer1/2', () => {
  it('arms on quota error text and confirms via probe', async () => {
    const convId = seedConversationOn('claude-code', 'test-model', 1);
    const probeCard = vi.fn(async () => ({
      id: 'claude-code', label: 'Claude Code', installed: true, ok: true,
      groups: [{ id: 'd', label: 'd', fiveHourPct: 100, fiveHourResetsAt: 9_000 }],
    }));
    const notify = vi.fn();
    const w = createUsageLimitWatcher({ getDb: () => db, probeCard, notify });
    w.arm({ conversationId: convId, sessionId: `s-${convId}`, at: 1, reason: 'error_text' });

    const actions = await w.drainLayer2(2);

    expect(probeCard).toHaveBeenCalledTimes(1);
    expect(probeCard).toHaveBeenCalledWith('claude-code', 'test-model');
    expect(actions).toHaveLength(1);
    expect(actions[0].conversationId).toBe(convId);
    expect(actions[0].verdict.kind).toBe('limited');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      tag: `tierwyn:usage:${convId}`,
      conversationId: convId,
    });
  });

  it('does not arm-drain a headroom probe into a notify', async () => {
    const convId = seedConversationOn('claude-code', 'test-model', 2);
    const probeCard = vi.fn(async () => ({
      id: 'claude-code', label: 'Claude Code', installed: true,
      groups: [{ id: 'd', label: 'd', fiveHourPct: 10 }],
    }));
    const notify = vi.fn();
    const w = createUsageLimitWatcher({ getDb: () => db, probeCard, notify });
    w.arm({ conversationId: convId, sessionId: `s-${convId}`, at: 1, reason: 'error_text' });

    const actions = await w.drainLayer2(2);

    expect(actions).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies on an unclassified probe', async () => {
    const convId = seedConversationOn('claude-code', 'test-model', 3);
    const probeCard = vi.fn(async () => ({
      id: 'claude-code', label: 'Claude Code', error: 'boom',
    }));
    const notify = vi.fn();
    const w = createUsageLimitWatcher({ getDb: () => db, probeCard, notify });
    w.arm({ conversationId: convId, sessionId: `s-${convId}`, at: 1, reason: 'degenerate' });

    const actions = await w.drainLayer2(2);

    expect(actions).toHaveLength(1);
    expect(actions[0].verdict.kind).toBe('unclassified');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      tag: `tierwyn:usage:${convId}`,
      conversationId: convId,
    });
    expect(notify.mock.calls[0][0].body).toContain('usage limit suspected');
  });

  it('[S2-5] watcher push is distinguishable from a completion push', async () => {
    const convId = seedConversationOn('claude-code', 'test-model', 7);
    const probeCard = vi.fn(async () => ({
      id: 'claude-code', label: 'Claude Code', installed: true, ok: true,
      groups: [{ id: 'd', label: 'd', fiveHourPct: 100, fiveHourResetsAt: 9_000 }],
    }));
    const notify = vi.fn();
    const w = createUsageLimitWatcher({ getDb: () => db, probeCard, notify });
    w.arm({ conversationId: convId, sessionId: `s-${convId}`, at: 1, reason: 'error_text' });

    await w.drainLayer2(2);

    expect(notify).toHaveBeenCalledTimes(1);
    const push = notify.mock.calls[0][0];
    // [S2-5] Not the completion push: distinct tag, [usage-watcher] identity,
    // and no conversationComplete/agentStatus error shape at all.
    expect(push.tag).toBe(`tierwyn:usage:${convId}`);
    expect(push.tag).not.toBe(`tierwyn:conv:${convId}`);
    expect(push.title).toContain('[usage-watcher]');
    expect(push.body).toContain('[usage-watcher]');
    expect(push.body).toContain('usage limit confirmed');
    expect(push.conversationId).toBe(convId);
    expect('category' in push).toBe(false);
    expect('agentStatus' in push).toBe(false);
  });

  it('[S2-5] quota text on a no-card agent never arms — drop is logged with reason', async () => {
    const convId = seedConversationOn('pi', 'pi-model', 8);
    const probeCard = vi.fn();
    const notify = vi.fn();
    const log = vi.fn();
    const w = createUsageLimitWatcher({
      getDb: () => db, probeCard, notify, log,
      hasUsageCard: () => false,
    });
    w.arm({ conversationId: convId, sessionId: `s-${convId}`, at: 1, reason: 'error_text' });

    const actions = await w.drainLayer2(2);

    expect(actions).toEqual([]);
    expect(probeCard).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no usage card'));
  });

  it('[S3-1] a throwing probe degrades only that bucket to unclassified without killing the drain', async () => {
    const convPi = seedConversationOn('pi', 'pi-model', 5);
    const convClaude = seedConversationOn('claude-code', 'test-model', 6);
    const probeCard = vi.fn(async (agentType: string) => {
      if (agentType === 'pi') throw new Error('probe exploded');
      return {
        id: 'claude-code', label: 'Claude Code', installed: true, ok: true,
        groups: [{ id: 'd', label: 'd', fiveHourPct: 100, fiveHourResetsAt: 9_000 }],
      };
    });
    const notify = vi.fn();
    const w = createUsageLimitWatcher({ getDb: () => db, probeCard, notify });
    w.arm({ conversationId: convPi, sessionId: `s-${convPi}`, at: 1, reason: 'error_text' });
    w.arm({ conversationId: convClaude, sessionId: `s-${convClaude}`, at: 1, reason: 'error_text' });

    const actions = await w.drainLayer2(2);

    expect(probeCard).toHaveBeenCalledTimes(2);
    const byConv = new Map(actions.map((a) => [a.conversationId, a.verdict.kind]));
    expect(byConv.get(convPi)).toBe('unclassified');
    expect(byConv.get(convClaude)).toBe('limited');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('coalesces ten candidates on the same card into one probe', async () => {
    const convIds: string[] = [];
    for (let i = 0; i < 10; i++) convIds.push(seedConversationOn('claude-code', 'test-model', i));
    const probeCard = vi.fn(async () => ({
      id: 'claude-code', label: 'x', installed: true,
      groups: [{ id: 'd', label: 'd', fiveHourPct: 10 }],
    }));
    const w = createUsageLimitWatcher({ getDb: () => db, probeCard });
    for (let i = 0; i < 10; i++) {
      w.arm({ conversationId: convIds[i], sessionId: `s-${convIds[i]}`, at: 1, reason: 'error_text' });
    }

    await w.drainLayer2(2);

    expect(probeCard).toHaveBeenCalledTimes(1);
    expect(probeCard).toHaveBeenCalledWith('claude-code', 'test-model');
  });

  it('clears armed candidates after a drain', async () => {
    const convId = seedConversationOn('claude-code', 'test-model', 4);
    const probeCard = vi.fn(async () => ({
      id: 'claude-code', label: 'x', installed: true,
      groups: [{ id: 'd', label: 'd', fiveHourPct: 10 }],
    }));
    const w = createUsageLimitWatcher({ getDb: () => db, probeCard });
    w.arm({ conversationId: convId, sessionId: `s-${convId}`, at: 1, reason: 'error_text' });
    await w.drainLayer2(2);

    const again = await w.drainLayer2(3);

    expect(again).toEqual([]);
    expect(probeCard).toHaveBeenCalledTimes(1);
  });

  it("[S3-8] probes the session that produced the signal, not the conversation's newest session", async () => {
    const convId = createConversation(db, { projectId, title: 'C-mixed' }).id;
    const pi = seedAgentModel('pi', 'pi-old-model');
    const cc = seedAgentModel('claude-code', 'test-model');
    seedLastSession(convId, 's-old', pi.agentId, pi.modelId, 1); // produced the quota signal
    seedLastSession(convId, 's-new', cc.agentId, cc.modelId, 2); // later session, different agent
    const probeCard = vi.fn(async () => ({ id: 'pi', label: 'Pi', error: 'boom' }));
    const w = createUsageLimitWatcher({ getDb: () => db, probeCard });
    w.arm({ conversationId: convId, sessionId: 's-old', at: 1, reason: 'error_text' });

    await w.drainLayer2(2);

    expect(probeCard).toHaveBeenCalledTimes(1);
    expect(probeCard).toHaveBeenCalledWith('pi', 'pi-old-model');
    expect(probeCard).not.toHaveBeenCalledWith('claude-code', 'test-model');
  });
});
