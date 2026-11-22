import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { updateDecisionSettings, updateNotificationSettings } from '../repositories/settings.js';
import { seedCatalogue } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent } from '../repositories/events.js';
import { upsertPushSubscription, listPushSubscriptions } from '../repositories/pushSubscriptions.js';
import {
  ensureVapidKeys, notifyOperator, notifierDeps, judgeInterrupt, decideThenNotify, interruptDeps,
} from './notifier.js';
import { issueSpawnToken, revokeSpawnTokensForConversation } from '../spawn/tokens.js';
import { _setMcpRedactNeedles } from '../secrets/mcpRedact.js';
import { outboundDns } from '../net/outboundUrl.js';
import type { Answer } from '../decide.js';

const origLookup = outboundDns.lookup;

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

const sub = {
  endpoint: 'https://push.example/a',
  p256dh: 'p1',
  auth: 'a1',
};

const completeInput = {
  category: 'conversationComplete' as const,
  conversationId: 'conv-1',
  conversationTitle: '↳ Implementer',
  projectName: 'Tierwyn',
  agentStatus: 'done' as const,
};

describe('notifyOperator', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn(async () => ({}));
    notifierDeps.sendNotification = send;
    notifierDeps.generateVAPIDKeys = () => ({ publicKey: 'PUB', privateKey: 'PRIV' });
    notifierDeps.setVapidDetails = () => {};
    outboundDns.lookup = (async () => [{ address: '1.2.3.4', family: 4 }]) as typeof outboundDns.lookup;
  });

  afterEach(() => {
    outboundDns.lookup = origLookup;
    _setMcpRedactNeedles([]);
  });

  it('sends nothing when master enabled is false', async () => {
    const db = freshDb();
    upsertPushSubscription(db, sub);
    notifyOperator(db, completeInput);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing when the category toggle is false', async () => {
    const db = freshDb();
    updateNotificationSettings(db, { enabled: true, conversationComplete: false, vapidPrivateKey: 'PRIV', vapidPublicKey: 'PUB' });
    upsertPushSubscription(db, sub);
    notifyOperator(db, completeInput);
    await vi.waitFor(() => expect(send).not.toHaveBeenCalled());
  });

  it('sends nothing when there are no subscriptions', async () => {
    const db = freshDb();
    updateNotificationSettings(db, { enabled: true, vapidPrivateKey: 'PRIV', vapidPublicKey: 'PUB' });
    notifyOperator(db, completeInput);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing when buildNotification returns null', async () => {
    const db = freshDb();
    updateNotificationSettings(db, { enabled: true, vapidPrivateKey: 'PRIV', vapidPublicKey: 'PUB' });
    upsertPushSubscription(db, sub);
    notifyOperator(db, { category: 'conversationComplete', conversationId: 'c', agentStatus: 'running' });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one payload per subscription with exactly title, body, tag, data.conversationId', async () => {
    const db = freshDb();
    updateNotificationSettings(db, { enabled: true, vapidPrivateKey: 'PRIV', vapidPublicKey: 'PUB' });
    upsertPushSubscription(db, sub);
    upsertPushSubscription(db, { endpoint: 'https://push.example/b', p256dh: 'p2', auth: 'a2' });
    notifyOperator(db, completeInput);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    for (const call of send.mock.calls) {
      const payload = JSON.parse(call[1] as string) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['body', 'data', 'tag', 'title']);
      expect(payload).toMatchObject({
        title: '↳ Implementer',
        body: 'Completed · Tierwyn',
        tag: 'tierwyn:conv:conv-1',
        data: { conversationId: 'conv-1' },
      });
      expect(Object.keys(payload.data as object)).toEqual(['conversationId']);
    }
  });

  it('redacts MCP secrets from the push title', async () => {
    _setMcpRedactNeedles(['mcp-secret-value-xx']);
    const db = freshDb();
    updateNotificationSettings(db, { enabled: true, vapidPrivateKey: 'PRIV', vapidPublicKey: 'PUB' });
    upsertPushSubscription(db, sub);
    notifyOperator(db, {
      ...completeInput,
      conversationTitle: 'done mcp-secret-value-xx',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(send.mock.calls[0]![1] as string) as { title: string };
    expect(payload.title).toContain('[REDACTED]');
    expect(payload.title).not.toContain('mcp-secret-value-xx');
  });

  it('deletes a subscription on 410 and leaves it on 500 without throwing', async () => {
    const db = freshDb();
    updateNotificationSettings(db, { enabled: true, vapidPrivateKey: 'PRIV', vapidPublicKey: 'PUB' });
    upsertPushSubscription(db, sub);
    upsertPushSubscription(db, { endpoint: 'https://push.example/b', p256dh: 'p2', auth: 'a2' });
    send.mockImplementation(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint.endsWith('/a')) {
        const err = new Error('gone') as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
      const err = new Error('boom') as Error & { statusCode: number };
      err.statusCode = 500;
      throw err;
    });
    expect(() => notifyOperator(db, completeInput)).not.toThrow();
    await vi.waitFor(() => {
      const endpoints = listPushSubscriptions(db).map((r) => r.endpoint);
      expect(endpoints).toEqual(['https://push.example/b']);
    });
  });

  it('gates grokBotApp on the agentMessage toggle', async () => {
    const db = freshDb();
    upsertPushSubscription(db, sub);
    updateNotificationSettings(db, {
      enabled: true, agentMessage: false, vapidPrivateKey: 'PRIV', vapidPublicKey: 'PUB',
    });
    notifyOperator(db, { category: 'grokBotApp', description: 'Grok Bot failed' });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    updateNotificationSettings(db, { agentMessage: true });
    notifyOperator(db, { category: 'grokBotApp', description: 'Grok Bot failed' });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
  });
});

describe('ensureVapidKeys', () => {
  beforeEach(() => {
    notifierDeps.generateVAPIDKeys = () => ({ publicKey: 'PUB-GEN', privateKey: 'PRIV-GEN' });
  });

  it('generates and persists a keypair on first call and returns the same on the second', () => {
    const db = freshDb();
    const first = ensureVapidKeys(db);
    expect(first).toEqual({
      publicKey: 'PUB-GEN',
      privateKey: 'PRIV-GEN',
      subject: 'mailto:operator@localhost',
    });
    notifierDeps.generateVAPIDKeys = () => ({ publicKey: 'OTHER', privateKey: 'OTHER' });
    const second = ensureVapidKeys(db);
    expect(second).toEqual(first);
  });
});

describe('Jev interrupt filter', () => {
  const SECRET_EXCERPT = 'distinctive-excerpt-zebra-7731';
  let send: ReturnType<typeof vi.fn>;
  let decideStub: ReturnType<typeof vi.fn>;
  const origDecide = interruptDeps.decide;

  const noul = (n: number): Answer => ({ type: 'noul', noul: n });
  const doneAnswers = (iw: number, na: number, urgency = 0.2): Record<string, Answer> => ({
    interrupt_worthy: noul(iw),
    needs_attention: noul(na),
    urgency: { type: 'score', score: urgency, probabilities: {}, confidence: 0.9 },
  });
  const answer = (answers: Record<string, Answer>) =>
    decideStub.mockResolvedValue({ answers, model: 'jev-1.13.0', latencyMs: 5 });

  function setup(opts: { decisionOn?: boolean; message?: string } = {}) {
    const db = freshDb();
    seedCatalogue(db);
    updateNotificationSettings(db, { enabled: true, vapidPrivateKey: 'PRIV', vapidPublicKey: 'PUB' });
    upsertPushSubscription(db, sub);
    if (opts.decisionOn !== false) updateDecisionSettings(db, { enabled: true, apiKey: 'k' });
    const p = createProject(db, { name: 'Tierwyn', rootPath: '/p' });
    const c = createConversation(db, { projectId: p.id, title: 'Impl' });
    createSession(db, { id: 's1', conversationId: c.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
    appendEvent(db, {
      sessionId: 's1', type: 'message', sender: 'agent', seq: 0, ts: 1,
      payload: { chunk: opts.message ?? `All good ${SECRET_EXCERPT}`, final: true },
    });
    const input = {
      category: 'conversationComplete' as const,
      conversationId: c.id,
      conversationTitle: 'Impl',
      projectName: 'Tierwyn',
      agentStatus: 'done' as const,
    };
    return { db, input };
  }

  beforeEach(() => {
    send = vi.fn(async () => ({}));
    notifierDeps.sendNotification = send;
    notifierDeps.setVapidDetails = () => {};
    decideStub = vi.fn();
    interruptDeps.decide = decideStub as unknown as typeof interruptDeps.decide;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    outboundDns.lookup = (async () => [{ address: '1.2.3.4', family: 4 }]) as typeof outboundDns.lookup;
  });
  afterEach(() => {
    interruptDeps.decide = origDecide;
    outboundDns.lookup = origLookup;
    vi.restoreAllMocks();
  });

  it('judgeInterrupt returns undefined when category off (decide not called)', () => {
    const { db, input } = setup();
    updateNotificationSettings(db, { conversationComplete: false });
    expect(judgeInterrupt(db, input)).toBeUndefined();
    updateNotificationSettings(db, { conversationComplete: true, enabled: false });
    expect(judgeInterrupt(db, input)).toBeUndefined();
    expect(decideStub).not.toHaveBeenCalled();
  });

  it('judgeInterrupt returns sync undefined when decision disabled', () => {
    const { db, input } = setup({ decisionOn: false });
    expect(judgeInterrupt(db, input)).toBeUndefined();
    expect(decideStub).not.toHaveBeenCalled();
  });

  it('error completion bypasses decide and pushes', async () => {
    const { db, input } = setup();
    const errInput = { ...input, agentStatus: 'error' as const };
    expect(judgeInterrupt(db, errInput)).toBeUndefined();
    decideThenNotify(db, errInput);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(decideStub).not.toHaveBeenCalled();
  });

  it('done with clear-no verdict suppresses push', async () => {
    const { db, input } = setup();
    answer(doneAnswers(0.1, 0.1));
    decideThenNotify(db, input);
    await vi.waitFor(() => expect(decideStub).toHaveBeenCalledTimes(1));
    expect(decideStub.mock.calls[0]![2]).toMatchObject({ consumer: 'notify', conversationId: input.conversationId });
    await new Promise((r) => setTimeout(r, 20));
    expect(send).not.toHaveBeenCalled();
  });

  it('needs_attention >= 0.5 notifies even when interrupt_worthy is low', async () => {
    const { db, input } = setup();
    answer(doneAnswers(0.05, 0.8));
    decideThenNotify(db, input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('decide null => push sent', async () => {
    const { db, input } = setup();
    decideStub.mockResolvedValue(null);
    decideThenNotify(db, input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('partial answers fail open', async () => {
    const { db, input } = setup();
    answer({ interrupt_worthy: noul(0.05) });
    await expect(judgeInterrupt(db, input)).resolves.toBeUndefined();
  });

  it('agentMessage: expects_reply overrides a clear-no; clear-no alone suppresses', async () => {
    const { db, input } = setup();
    const msg = { category: 'agentMessage' as const, conversationId: input.conversationId };
    answer({ interrupt_worthy: noul(0.1), expects_reply: noul(0.9) });
    await expect(judgeInterrupt(db, msg)).resolves.toBe(true);
    answer({ interrupt_worthy: noul(0.1), expects_reply: noul(0.1) });
    await expect(judgeInterrupt(db, msg)).resolves.toBe(false);
  });

  it('scheduleRunEnded: succeeded is judged, failed/timed_out never call decide', async () => {
    const { db } = setup();
    const run = { category: 'scheduleRunEnded' as const, jobName: 'nightly', runId: 'r1' };
    answer({ interrupt_worthy: noul(0.1) });
    await expect(judgeInterrupt(db, { ...run, runStatus: 'succeeded' })).resolves.toBe(false);
    decideStub.mockClear();
    expect(judgeInterrupt(db, { ...run, runStatus: 'failed' })).toBeUndefined();
    expect(judgeInterrupt(db, { ...run, runStatus: 'timed_out' })).toBeUndefined();
    expect(decideStub).not.toHaveBeenCalled();
  });

  it('scheduleFired and scheduleDisabled never call decide', () => {
    const { db } = setup();
    expect(judgeInterrupt(db, { category: 'scheduleFired', jobName: 'j' })).toBeUndefined();
    expect(judgeInterrupt(db, { category: 'scheduleDisabled', jobName: 'j' })).toBeUndefined();
    expect(judgeInterrupt(db, { category: 'grokBotApp', description: 'x' })).toBeUndefined();
    expect(decideStub).not.toHaveBeenCalled();
  });

  it('redacts secrets from the interrupt-filter description', async () => {
    _setMcpRedactNeedles(['mcp-secret-value-xx']);
    const { db, input } = setup();
    answer(doneAnswers(0.9, 0.1));
    await judgeInterrupt(db, { ...input, description: 'notes mcp-secret-value-xx leftover' });
    expect(decideStub).toHaveBeenCalled();
    const state = decideStub.mock.calls[0]![0] as { description?: string };
    expect(state.description).toContain('[REDACTED]');
    expect(state.description).not.toContain('mcp-secret-value-xx');
  });

  it('excerpt text and live tokens never appear in push payload; tokens are scrubbed from the state', async () => {
    const { db, input } = setup({ message: `All good ${SECRET_EXCERPT} TOKEN_PLACEHOLDER` });
    // Token becomes live after the row was stored, as when a still-valid token sits in old prose.
    const token = issueSpawnToken(input.conversationId, 's1');
    db.prepare("UPDATE events SET payload = replace(payload, 'TOKEN_PLACEHOLDER', ?)").run(token);
    answer(doneAnswers(0.9, 0.1));
    decideThenNotify(db, input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(decideStub.mock.calls[0]![2]).toMatchObject({ consumer: 'notify' });
    const state = decideStub.mock.calls[0]![0] as { lastAssistantExcerpt: string };
    expect(state.lastAssistantExcerpt).toContain(SECRET_EXCERPT);
    expect(state.lastAssistantExcerpt).not.toContain(token);
    expect(state.lastAssistantExcerpt).toContain('[REDACTED]');
    const payload = send.mock.calls[0]![1] as string;
    expect(payload).not.toContain(SECRET_EXCERPT);
    expect(payload).not.toContain(token);
    revokeSpawnTokensForConversation(input.conversationId);
  });

  it('noul boundary: 0.4 suppresses, 0.40001 notifies', async () => {
    const { db, input } = setup();
    const msg = { category: 'agentMessage' as const, conversationId: input.conversationId };
    answer({ interrupt_worthy: noul(0.4), expects_reply: noul(0.1) });
    await expect(judgeInterrupt(db, msg)).resolves.toBe(false);
    answer({ interrupt_worthy: noul(0.40001), expects_reply: noul(0.1) });
    await expect(judgeInterrupt(db, msg)).resolves.toBe(true);
  });

  it('urgency override needs score>=1 and confidence>=0.6', async () => {
    const { db, input } = setup();
    const urgent = (score: number, confidence: number): Record<string, Answer> => ({
      interrupt_worthy: noul(0.1),
      needs_attention: noul(0.1),
      urgency: { type: 'score', score, probabilities: {}, confidence },
    });
    answer(urgent(1.5, 0.9));
    await expect(judgeInterrupt(db, input)).resolves.toBe(true);
    answer(urgent(1.5, 0.59));
    await expect(judgeInterrupt(db, input)).resolves.toBe(false);
    answer(urgent(0.9, 0.9));
    await expect(judgeInterrupt(db, input)).resolves.toBe(false);
  });

  it('agentMessage skips decide when there is no push key or no subscriber', async () => {
    const { db, input } = setup();
    const msg = { category: 'agentMessage' as const, conversationId: input.conversationId };
    answer({ interrupt_worthy: noul(0.1), expects_reply: noul(0.1) });
    db.prepare('DELETE FROM push_subscriptions').run();
    expect(judgeInterrupt(db, msg)).toBeUndefined();
    upsertPushSubscription(db, sub);
    updateNotificationSettings(db, { vapidPrivateKey: '' });
    expect(judgeInterrupt(db, msg)).toBeUndefined();
    expect(decideStub).not.toHaveBeenCalled();
    updateNotificationSettings(db, { vapidPrivateKey: 'PRIV' });
    await expect(judgeInterrupt(db, msg)).resolves.toBe(false);
    expect(decideStub).toHaveBeenCalledTimes(1);
  });

  const excerptOf = (message: string): string => {
    const { db, input } = setup({ message });
    answer(doneAnswers(0.9, 0.1));
    void judgeInterrupt(db, input);
    return (decideStub.mock.calls.at(-1)![0] as { lastAssistantExcerpt: string }).lastAssistantExcerpt;
  };

  it('scrub: an unterminated fence drops everything after it', () => {
    const out = excerptOf('Ran it:\n```bash\ncat /etc/secret_file\nrm -rf x');
    expect(out).toContain('Ran it');
    expect(out).not.toContain('rm -rf');
    expect(out).not.toContain('secret_file');
  });

  it('scrub: odd fence count (window starts mid-fence) still drops trailing code', () => {
    const out = excerptOf('x\n```\np\n```\nmore\n```\nrm -rf y');
    expect(out).toContain('more');
    expect(out).not.toContain('rm -rf');
    expect(excerptOf('tail of code\n```\nprose then code')).not.toContain('prose then code');
  });

  it('scrub: inline code spans are replaced', () => {
    const out = excerptOf('run `npm run secret-task` now');
    expect(out).toContain('[code]');
    expect(out).not.toContain('secret-task');
  });

  it('scrub: leading-slash, single-segment, bare multi-segment and Windows paths', () => {
    const out = excerptOf('see apps/server/src/index.ts and /etc and ~/notes/x.md and C:\\Users\\bob\\a.txt and D:/proj/b.ts');
    for (const leak of ['apps', 'server', 'index.ts', '/etc', 'notes', 'Users', 'bob', 'proj']) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('[path]');
    expect(excerptOf('yes/no and 1/2 and and/or')).toContain('yes/no');
  });

  it('state excerpt replaces code fences and paths', () => {
    const { db, input } = setup({
      message: 'Edited /home/me/proj/src/a.ts and ./rel/dir/b.ts\n```ts\nconst secret = 1;\n```\ndone',
    });
    answer(doneAnswers(0.9, 0.1));
    void judgeInterrupt(db, input);
    const state = decideStub.mock.calls[0]![0] as { lastAssistantExcerpt: string; origin: string };
    expect(state.lastAssistantExcerpt).toContain('[code]');
    expect(state.lastAssistantExcerpt).toContain('[path]');
    expect(state.lastAssistantExcerpt).not.toContain('const secret');
    expect(state.lastAssistantExcerpt).not.toContain('/home/me');
    expect(state.origin).toBe('operator_chat');
  });
});
