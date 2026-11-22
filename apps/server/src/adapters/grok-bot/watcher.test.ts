import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { NotificationInput, ServerFrame } from '@tierwyn/shared';
import { runMigrations } from '../../db/migrate.js';
import { migrations } from '../../db/migrations/index.js';
import { seedCatalogue, ensureRemoteAgentsProject } from '../../db/seed.js';
import { createProject } from '../../repositories/projects.js';
import { createConversation, getConversation, setConversationDescription } from '../../repositories/conversations.js';
import { createSession, setNativeSessionId } from '../../repositories/sessions.js';
import { appendEvent, listEventsForConversation } from '../../repositories/events.js';
import { upsertDiscoveredModels } from '../../repositories/models.js';
import { readCursors, writeCursors } from '../../repositories/grokBotWatch.js';
import { issueSpawnToken, revokeSpawnTokensForSession } from '../../spawn/tokens.js';
import type { CdpLike } from './cdp.js';
import type { ReplicaEntry } from './mapping.js';
import { resetBridgeCache } from './bridge.js';
import { startGrokBotWatcher, type WatcherDeps } from './watcher.js';
import { resetReconcileState } from './reconcile.js';
import { createRemoteAgentConversation } from '../../repositories/remoteAgents.js';

const BOT = '8c236467-9550-4bb2-bb9d-80938bc7e5f6';
const PREFIX = 'sand.client.slice.account.acct.';
const KEYS = [
  `${PREFIX}selection.last-agent`,
  `${PREFIX}roster.last-roster`,
  `${PREFIX}transcript.replicas.${BOT}`,
];

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  upsertDiscoveredModels(db, 'grok-bot', [{
    name: BOT, label: 'Grok Bot · Inbox', provider: 'xai', vision: false, steer: true,
  }]);
  const p = createProject(db, { name: 'Tierwyn', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'Inbox Triage' });
  const modelId = `grok-bot:${BOT}`;
  createSession(db, { id: 'turn-1', conversationId: c.id, agentId: 'grok-bot', agentModelId: modelId });
  setNativeSessionId(db, 'turn-1', BOT);
  appendEvent(db, { sessionId: 'turn-1', type: 'prompt', payload: { text: 'hi' }, sender: 'user', seq: 0, ts: 1 });
  return { db, conversationId: c.id, modelId };
}

type FakeOpts = {
  replica?: ReplicaEntry[];
  replicasByBot?: Record<string, ReplicaEntry[]>;
  newestEntryId?: string;
  rosterMissing?: boolean;
  malformedReplica?: unknown;
  images?: Record<string, string | null>;
  /** Fake window.desktop.readAttachmentBytes results keyed by sandbox URL. */
  attachmentBytes?: Record<string, { kind: string | null; size?: number; b64?: string } | null>;
  rosterRows?: Array<{ id: string; name?: string; newestEntryId?: string }>;
  /** Current `selection.last-agent` so restore can fire. */
  selection?: string | null;
  onSelectAgent?: (id: string) => void;
  questions?: Array<{
    cardId: string;
    prompt: string;
    choices: { id: string; label: string }[];
    allowFreeText?: boolean;
  }>;
  approvals?: Array<{
    cardId: string;
    prompt: string;
    choices: { id: string; label: string }[];
  }>;
};

function makeFake(opts: FakeOpts = {}): {
  client: CdpLike;
  evaluates: string[];
  selectedAgents: string[];
  questionClicks: { cardId: string; choiceId: string }[];
  approvalClicks: { cardId: string; choiceId: string }[];
  freeTexts: { cardId: string; text: string }[];
  state: {
    replica: ReplicaEntry[];
    newestEntryId: string;
    rosterMissing: boolean;
    malformedReplica: unknown;
    rosterRows?: Array<{ id: string; name?: string; newestEntryId?: string }>;
    replicasByBot?: Record<string, ReplicaEntry[]>;
    questions: NonNullable<FakeOpts['questions']>;
    approvals: NonNullable<FakeOpts['approvals']>;
    selection: string | null;
  };
} {
  const state = {
    replica: opts.replica ? [...opts.replica] : [] as ReplicaEntry[],
    newestEntryId: opts.newestEntryId ?? opts.replica?.[opts.replica.length - 1]?.id ?? 't0',
    rosterMissing: opts.rosterMissing ?? false,
    malformedReplica: opts.malformedReplica,
    rosterRows: opts.rosterRows,
    replicasByBot: opts.replicasByBot,
    questions: opts.questions ? [...opts.questions] : [],
    approvals: opts.approvals ? [...opts.approvals] : [],
    selection: opts.selection ?? null,
  };
  const evaluates: string[] = [];
  const selectedAgents: string[] = [];
  const questionClicks: { cardId: string; choiceId: string }[] = [];
  const approvalClicks: { cardId: string; choiceId: string }[] = [];
  const freeTexts: { cardId: string; text: string }[] = [];
  const client: CdpLike = {
    async evaluate(expression: string) {
      evaluates.push(expression);
      if (expression.includes('el.click()') && expression.includes('sand-agent-item')) {
        const m = expression.match(/data-agent-id=\\"([0-9a-fA-F-]{36})\\"/)
          ?? expression.match(/data-agent-id="([0-9a-fA-F-]{36})"/);
        if (m?.[1]) {
          selectedAgents.push(m[1]);
          opts.onSelectAgent?.(m[1]);
        }
      }
      if (expression.includes('__tierwynGrokBotQuestionScan')) return [...state.questions];
      if (expression.includes('__tierwynGrokBotQuestionClick')) {
        const m = expression.match(/__tierwynGrokBotQuestionClick\((.*)\)/);
        const args = m?.[1] ? JSON.parse(`[${m[1]}]`) as [string, string] : ['', ''];
        questionClicks.push({ cardId: args[0], choiceId: args[1] });
        state.questions.splice(0);
        return true;
      }
      if (expression.includes('__tierwynGrokBotQuestionFreeText')) {
        const m = expression.match(/__tierwynGrokBotQuestionFreeText\((.*)\)/);
        const args = m?.[1] ? JSON.parse(`[${m[1]}]`) as [string, string] : ['', ''];
        freeTexts.push({ cardId: args[0], text: args[1] });
        state.questions.splice(0);
        return true;
      }
      if (expression.includes('__tierwynGrokBotScan')) return [...state.approvals];
      if (expression.includes('__tierwynGrokBotClick')) {
        const m = expression.match(/__tierwynGrokBotClick\((.*)\)/);
        const args = m?.[1] ? JSON.parse(`[${m[1]}]`) as [string, string] : ['', ''];
        approvalClicks.push({ cardId: args[0], choiceId: args[1] });
        state.approvals.splice(0);
        return true;
      }
      if (expression.includes('sand-agent-item')) return true;
      if (expression.includes('readAttachmentBytes')) {
        const m = expression.match(/path:\s*"([^"]+)"/) ?? expression.match(/readAttachmentBytes\("([^"]+)"/);
        const url = m?.[1] ?? '';
        return opts.attachmentBytes?.[url] ?? null;
      }
      if (expression.includes('resolveAttachmentMedia')) {
        const m = expression.match(/source:\s*"([^"]+)"/) ?? expression.match(/resolveAttachmentMedia\("([^"]+)"\)/);
        const url = m?.[1] ?? '';
        const dataUrl = opts.images?.[url];
        if (dataUrl === null || dataUrl === undefined) return null;
        return { kind: 'image', dataUrl };
      }
      if (expression.includes('listClientPersistenceKeys')) return KEYS;
      if (expression.includes('readClientPersistence')) {
        if (expression.includes('selection.last-agent')) {
          if (!state.selection) return null;
          return { schemaVersion: 1, value: { agentId: state.selection } };
        }
        if (expression.includes('roster.last-roster')) {
          if (state.rosterMissing) return { schemaVersion: 1, value: { rows: [] } };
          if (state.rosterRows) return { schemaVersion: 1, value: { rows: state.rosterRows } };
          return {
            schemaVersion: 1,
            value: {
              rows: [{
                id: BOT,
                name: 'Inbox Triage',
                newestEntryId: state.newestEntryId,
              }],
            },
          };
        }
        if (expression.includes('transcript.replicas')) {
          if (state.malformedReplica !== undefined) return state.malformedReplica;
          const m = expression.match(/transcript\.replicas\.([0-9a-fA-F-]{36})/);
          const botId = m?.[1];
          if (botId && state.replicasByBot?.[botId]) {
            return { schemaVersion: 1, value: { entries: state.replicasByBot[botId] } };
          }
          return { schemaVersion: 1, value: { entries: state.replica } };
        }
      }
      return null;
    },
    async send() { return {}; },
    on() { return () => undefined; },
    async close() { /* noop */ },
  };
  return { client, evaluates, selectedAgents, questionClicks, approvalClicks, freeTexts, state };
}

function boot(opts: {
  db: Db;
  fake?: ReturnType<typeof makeFake>;
  getClient?: () => Promise<CdpLike>;
  isLive?: (id: string) => boolean;
  health?: () => 'ok' | 'unreachable' | 'unhealthy';
  autoCreateEnabled?: () => boolean;
  onBroadcast?: (id: string, frame: ServerFrame) => void;
  enabled?: () => boolean;
  onUnreachableEdge?: () => void;
  attachmentsDir?: string;
  onHandover?: WatcherDeps['onHandover'];
  onReply?: WatcherDeps['onReply'];
  replyLeaseMs?: () => number;
}) {
  const frames: ServerFrame[] = [];
  const notes: NotificationInput[] = [];
  const delays: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const dropClient = vi.fn();
  const fake = opts.fake;
  const ctl = startGrokBotWatcher({
    db: opts.db,
    getClient: opts.getClient ?? (async () => fake!.client),
    health: opts.health ?? (() => 'ok'),
    dropClient,
    isLive: opts.isLive ?? (() => false),
    broadcast: (id, frame) => {
      frames.push(frame);
      opts.onBroadcast?.(id, frame);
    },
    notify: (n) => { notes.push(n); },
    autoCreateEnabled: opts.autoCreateEnabled ?? (() => false),
    onCatalogueChanged: () => undefined,
    enabled: opts.enabled,
    onUnreachableEdge: opts.onUnreachableEdge,
    attachmentsDir: opts.attachmentsDir,
    onHandover: opts.onHandover,
    onReply: opts.onReply,
    replyLeaseMs: opts.replyLeaseMs,
    intervalMs: 25_000,
    now: () => 1_700_000_000_000,
    setTimer: (fn, ms) => {
      delays.push(ms);
      const h = { fn, ms };
      timers.push(h);
      return h;
    },
    clearTimer: () => undefined,
  });
  return { ctl, frames, notes, delays, dropClient, timers };
}

const user = (id: string, content: string): ReplicaEntry => ({
  kind: 'message', id, role: 'user', content,
});
const assistant = (id: string, content: string, images?: { url: string; alt: string }[]): ReplicaEntry => ({
  kind: 'send-message',
  id,
  message: { type: 'text', content, images },
});

function watcherEvents(db: Db, conversationId: string) {
  return listEventsForConversation(db, conversationId).filter((e) => e.type !== 'prompt');
}

afterEach(() => {
  resetBridgeCache();
  resetReconcileState();
  vi.unstubAllEnvs();
});

describe('GrokBotWatcher', () => {
  it('empty watched set still reads the roster for reconcile', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    const fake = makeFake();
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    expect(fake.evaluates.some((e) => e.includes('roster.last-roster'))).toBe(true);
    ctl.stop();
  });

  it('first sight records the cursor and persists nothing', async () => {
    const { db, conversationId } = setupDb();
    const replica = [user('t7u', 'hi'), assistant('t7s0', 'pong')];
    const fake = makeFake({ replica, newestEntryId: 't7s0' });
    const { ctl, frames, notes } = boot({ db, fake });
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(frames).toEqual([]);
    expect(notes).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s0');
    expect(readCursors(db)[BOT]?.seq).toBe(0);
    ctl.stop();
  });

  it('new entries after cursor are persisted in order with one notification', async () => {
    const { db, conversationId } = setupDb();
    const fake = makeFake({ replica: [user('t7u', 'hi'), assistant('t7s0', 'pong')], newestEntryId: 't7s0' });
    const { ctl, frames, notes } = boot({ db, fake });
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);

    fake.state.replica = [
      user('t7u', 'hi'),
      assistant('t7s0', 'pong'),
      assistant('t7s1', 'later'),
      assistant('t7s2', 'and more'),
    ];
    fake.state.newestEntryId = 't7s2';
    await ctl.tickNow();
    const events = watcherEvents(db, conversationId);
    expect(events.map((e) => e.type)).toEqual(['message', 'message']);
    expect(events.map((e) => e.sender)).toEqual(['agent', 'agent']);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => (e.payload as { chunk: string }).chunk)).toEqual(['later', 'and more']);
    const eventFrames = frames.filter((f) => f.type === 'event');
    const updateFrames = frames.filter((f) => f.type === 'conversation_updated');
    expect(eventFrames).toHaveLength(2);
    expect(updateFrames).toHaveLength(2);
    expect(updateFrames.every((f) => f.type === 'conversation_updated' && f.status === undefined)).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.category).toBe('agentMessage');
    expect(notes[0]?.conversationId).toBe(conversationId);
    ctl.stop();
  });

  it('idempotence: a second tick with the same replica persists nothing', async () => {
    const { db, conversationId } = setupDb();
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const { ctl, notes } = boot({ db, fake });
    await ctl.tickNow();
    fake.state.replica = [assistant('t7s0', 'old'), assistant('t7s1', 'new')];
    fake.state.newestEntryId = 't7s1';
    await ctl.tickNow();
    const afterFirst = watcherEvents(db, conversationId).length;
    expect(afterFirst).toBe(1);
    expect(notes).toHaveLength(1);
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toHaveLength(afterFirst);
    expect(notes).toHaveLength(1);
    ctl.stop();
  });

  it('restart: a new watcher over the same DB re-reads the cursor and persists nothing', async () => {
    const { db, conversationId } = setupDb();
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const first = boot({ db, fake });
    await first.ctl.tickNow();
    fake.state.replica = [assistant('t7s0', 'old'), assistant('t7s1', 'new')];
    fake.state.newestEntryId = 't7s1';
    await first.ctl.tickNow();
    first.ctl.stop();
    expect(watcherEvents(db, conversationId)).toHaveLength(1);

    resetBridgeCache();
    const fake2 = makeFake({ replica: fake.state.replica, newestEntryId: 't7s1' });
    const second = boot({ db, fake: fake2 });
    await second.ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toHaveLength(1);
    expect(second.notes).toHaveLength(0);
    second.ctl.stop();
  });

  it('live turn holds the cursor; entries after the adapter’s last poll arrive after the turn', async () => {
    const { db, conversationId } = setupDb();
    let live = true;
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const { ctl, notes } = boot({ db, fake, isLive: () => live });
    await ctl.tickNow(); // first sight → cursor t7s0
    fake.state.replica = [assistant('t7s0', 'old'), user('t7u', 'hi'), assistant('t7s1', 'pong'), assistant('t7s2', 'late')];
    fake.state.newestEntryId = 't7s2';
    ctl.noteAdapterIngested(BOT, ['t7u', 't7s1']);
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(notes).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s0');
    expect(ctl.stats().skippedLive).toBeGreaterThan(0);
    live = false;
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId).map((e) => (e.payload as { chunk?: string }).chunk)).toEqual(['late']);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s2');
    ctl.stop();
  });

  it('a live grok-bot turn in another conversation also holds the cursor', async () => {
    const { db, conversationId } = setupDb();
    const projectId = getConversation(db, conversationId)!.projectId;
    const other = createConversation(db, { projectId, title: 'Other' });
    createSession(db, { id: 'other-turn', conversationId: other.id, agentId: 'grok-bot', agentModelId: 'grok-bot:default' });
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const { ctl } = boot({ db, fake, isLive: (id) => id === other.id });
    await ctl.tickNow();
    fake.state.replica = [assistant('t7s0', 'old'), assistant('t7s1', 'mid-turn')];
    fake.state.newestEntryId = 't7s1';
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s0');
    ctl.stop();
  });

  it('two turns between ticks: neither turn is replayed', async () => {
    const { db, conversationId } = setupDb();
    const replica = [assistant('t7s0', 'old'), assistant('a1', 'turn one'), assistant('b1', 'turn two')];
    const fake = makeFake({ replica, newestEntryId: 'b1' });
    writeCursors(db, { [BOT]: { entryId: 't7s0', seq: 0, updatedAt: 1 } });
    const { ctl } = boot({ db, fake });
    ctl.noteAdapterIngested(BOT, ['a1']);
    ctl.noteAdapterIngested(BOT, ['b1']);
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe('b1');
    ctl.stop();
  });

  it('unreachable app: no throw, no events, backoff applied, next tick still scheduled', async () => {
    const { db, conversationId } = setupDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctl, delays, dropClient, notes } = boot({
      db,
      getClient: async () => { throw new Error('ECONNREFUSED'); },
      health: () => 'unreachable',
    });
    await expect(ctl.tickNow()).resolves.toBeUndefined();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(notes).toEqual([]);
    expect(dropClient).toHaveBeenCalled();
    expect(delays.at(-1)).toBe(60_000);
    expect(ctl.stats().errors).toBeGreaterThan(0);
    warn.mockRestore();
    ctl.stop();
  });

  it('cursor lost: resync to newest, nothing persisted, logged once', async () => {
    const { db, conversationId } = setupDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const replica = [assistant('t9s0', 'fresh')];
    const fake = makeFake({ replica, newestEntryId: 't9s0' });
    const { ctl, notes } = boot({ db, fake });
    await ctl.tickNow();
    expect(readCursors(db)[BOT]?.entryId).toBe('t9s0');

    const replica2 = [assistant('t9s1', 'newer')];
    const fake2 = makeFake({ replica: replica2, newestEntryId: 't9s1' });
    ctl.stop();
    resetBridgeCache();
    const second = boot({ db, fake: fake2 });
    await second.ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(notes.concat(second.notes)).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe('t9s1');
    const lost = warn.mock.calls.filter((c) => String(c[0]).includes('cursor lost'));
    expect(lost).toHaveLength(1);
    await second.ctl.tickNow();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('cursor lost'))).toHaveLength(1);
    warn.mockRestore();
    second.ctl.stop();
  });

  it('malformed envelope: cursor unchanged, no events', async () => {
    const { db, conversationId } = setupDb();
    const replica = [assistant('t7s0', 'old')];
    const fake = makeFake({ replica, newestEntryId: 't7s0' });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    const before = readCursors(db)[BOT];

    ctl.stop();
    resetBridgeCache();
    const fake2 = makeFake({
      replica,
      newestEntryId: 't7s1',
      malformedReplica: { schemaVersion: 1, value: { entries: 'nope' } },
    });
    const second = boot({ db, fake: fake2 });
    await second.ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe(before?.entryId);
    second.ctl.stop();
  });

  it('images: file:// rewritten to data URL; unresolvable degrades without aborting the burst', async () => {
    const { db, conversationId } = setupDb();
    const good = 'file:///home/box/a.jpg';
    const bad = 'file:///home/box/missing.jpg';
    const fake = makeFake({
      replica: [assistant('t7s0', 'old')],
      newestEntryId: 't7s0',
      images: { [good]: 'data:image/png;base64,abc', [bad]: null },
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    fake.state.replica = [
      assistant('t7s0', 'old'),
      assistant('t7s1', 'pic', [{ url: good, alt: 'shot' }]),
      assistant('t7s2', 'also', [{ url: bad, alt: 'gone' }]),
    ];
    fake.state.newestEntryId = 't7s2';
    await ctl.tickNow();
    const events = watcherEvents(db, conversationId);
    expect(events).toHaveLength(2);
    const chunks = events.map((e) => (e.payload as { chunk: string }).chunk);
    expect(chunks[0]).toContain('data:image/png;base64,abc');
    expect(chunks[0]).not.toContain('file://');
    expect(chunks[1]).toContain('](#unavailable)');
    ctl.stop();
  });

  it('persists an attachment shard and strips file:// from the stored payload', async () => {
    const { db, conversationId } = setupDb();
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-watch-att-'));
    const bytes = Buffer.from('hello from grok bot\n');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const url = 'file:///home/box/agent-data/agents/x/attachments/deadbeef.txt';
    const fake = makeFake({
      replica: [assistant('t7s0', 'old')],
      newestEntryId: 't7s0',
      attachmentBytes: { [url]: { kind: 'bytes', size: bytes.length, b64: bytes.toString('base64') } },
    });
    const { ctl } = boot({ db, fake, attachmentsDir: dir });
    await ctl.tickNow();
    fake.state.replica = [
      assistant('t7s0', 'old'),
      {
        kind: 'send-message',
        id: 't11s0',
        message: { type: 'attachment', url, file_name: 'test-file.txt' },
      },
    ];
    fake.state.newestEntryId = 't11s0';
    await ctl.tickNow();
    const events = watcherEvents(db, conversationId);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { files: Array<{ path?: string; status: string }> };
    expect(payload.files[0]?.status).toBe('ok');
    expect(payload.files[0]?.path).toBe(join(dir, conversationId, `${sha}.txt`));
    expect(JSON.stringify(events[0]!.payload)).not.toMatch(/file:\/\//);
    ctl.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never emits a status event', async () => {
    const { db, conversationId } = setupDb();
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const { ctl, frames } = boot({ db, fake });
    await ctl.tickNow();
    fake.state.replica = [assistant('t7s0', 'old'), assistant('t7s1', 'new')];
    fake.state.newestEntryId = 't7s1';
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId).every((e) => e.type !== 'status')).toBe(true);
    expect(frames.some((f) => f.type === 'event' && f.event.type === 'status')).toBe(false);
    ctl.stop();
  });

  it('two bursts on one conversation share one sessions row', async () => {
    const { db, conversationId } = setupDb();
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const first = boot({ db, fake });
    await first.ctl.tickNow();
    fake.state.replica = [assistant('t7s0', 'old'), assistant('t7s1', 'a')];
    fake.state.newestEntryId = 't7s1';
    await first.ctl.tickNow();
    first.ctl.stop();

    resetBridgeCache();
    const fake2 = makeFake({
      replica: [assistant('t7s0', 'old'), assistant('t7s1', 'a'), assistant('t7s2', 'b')],
      newestEntryId: 't7s2',
    });
    const second = boot({ db, fake: fake2 });
    await second.ctl.tickNow();
    second.ctl.stop();

    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM sessions
        WHERE conversation_id = ? AND agent_id = 'grok-bot'
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id AND e.type = 'prompt')`,
    ).get(conversationId) as { n: number };
    expect(n.n).toBe(1);
    expect(watcherEvents(db, conversationId)).toHaveLength(2);
  });

  it('mid-burst broadcast failure does not re-persist earlier entries on the next tick', async () => {
    const { db, conversationId } = setupDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    let eventCount = 0;
    let failAt = 3;
    const { ctl } = boot({
      db,
      fake,
      onBroadcast: (_id, frame) => {
        if (frame.type !== 'event') return;
        eventCount += 1;
        if (eventCount === failAt) throw new Error('broadcast boom');
      },
    });
    await ctl.tickNow();
    fake.state.replica = [
      assistant('t7s0', 'old'),
      assistant('t7s1', 'one'),
      assistant('t7s2', 'two'),
      assistant('t7s3', 'three'),
    ];
    fake.state.newestEntryId = 't7s3';
    await ctl.tickNow();

    const chunksOf = () => watcherEvents(db, conversationId).map((e) => (e.payload as { chunk: string }).chunk);
    const afterFail = chunksOf();
    expect(afterFail.slice(0, 2)).toEqual(['one', 'two']);
    expect(afterFail.filter((c) => c === 'one')).toHaveLength(1);
    expect(afterFail.filter((c) => c === 'two')).toHaveLength(1);

    failAt = -1;
    await ctl.tickNow();
    const chunks = chunksOf();
    expect(chunks.filter((c) => c === 'one')).toHaveLength(1);
    expect(chunks.filter((c) => c === 'two')).toHaveLength(1);
    expect(chunks.filter((c) => c === 'three')).toHaveLength(1);
    expect(chunks).toEqual(['one', 'two', 'three']);
    warn.mockRestore();
    ctl.stop();
  });

  it('notification body uses the redacted persisted chunk', async () => {
    const { db, conversationId } = setupDb();
    const token = issueSpawnToken(conversationId, 'turn-1');
    try {
      const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
      const { ctl, notes } = boot({ db, fake });
      await ctl.tickNow();
      fake.state.replica = [
        assistant('t7s0', 'old'),
        assistant('t7s1', `echo ${token}`),
      ];
      fake.state.newestEntryId = 't7s1';
      await ctl.tickNow();
      expect(notes).toHaveLength(1);
      expect(notes[0]?.description).toContain('[REDACTED]');
      expect(notes[0]?.description).not.toContain(token);
      ctl.stop();
    } finally {
      revokeSpawnTokensForSession('turn-1');
    }
  });

  it('notification body strips markdown images and falls back to conversation description', async () => {
    const { db, conversationId } = setupDb();
    setConversationDescription(db, conversationId, 'Inbox notes');
    const good = 'file:///home/box/a.jpg';
    const fake = makeFake({
      replica: [assistant('t7s0', 'old')],
      newestEntryId: 't7s0',
      images: { [good]: 'data:image/png;base64,abc' },
    });
    const { ctl, notes } = boot({ db, fake });
    await ctl.tickNow();
    fake.state.replica = [
      assistant('t7s0', 'old'),
      assistant('t7s1', '', [{ url: good, alt: 'shot' }]),
    ];
    fake.state.newestEntryId = 't7s1';
    await ctl.tickNow();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.description).toBe('Inbox notes');
    expect(notes[0]?.description).not.toMatch(/data:image|!\[/);
    ctl.stop();
  });

  it('mid-tick CDP socket drop drops the client and backs off', async () => {
    const { db } = setupDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    fake.client.evaluate = async () => {
      throw new Error('CDP socket closed');
    };
    const { ctl, delays, dropClient } = boot({ db, fake });
    await ctl.tickNow();
    expect(dropClient).toHaveBeenCalled();
    expect(delays.at(-1)).toBe(60_000);
    warn.mockRestore();
    ctl.stop();
  });

  it('stop() aborts a pending tick and an already-armed timer callback', async () => {
    const { db } = setupDb();
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const { ctl, timers } = boot({ db, fake });
    ctl.stop();
    const ticks = ctl.stats().ticks;
    await ctl.tickNow();
    expect(ctl.stats().ticks).toBe(ticks);
    expect(fake.evaluates).toEqual([]);
    timers.at(-1)?.fn();
    await Promise.resolve();
    expect(ctl.stats().ticks).toBe(ticks);
  });

  it('reconcile auto-creates from the tick roster when enabled', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    ensureRemoteAgentsProject(db);
    const fake = makeFake({ replica: [assistant('t7s0', 'hi')], newestEntryId: 't7s0' });
    const { ctl } = boot({ db, fake, autoCreateEnabled: () => true });
    await ctl.tickNow();
    const row = db.prepare(
      `SELECT c.title AS title, s.native_session_id AS botId
         FROM conversations c
         JOIN sessions s ON s.conversation_id = c.id
        WHERE s.native_session_id = ?`,
    ).get(BOT) as { title: string; botId: string } | undefined;
    expect(row?.title).toBe('Inbox Triage');
    expect(row?.botId).toBe(BOT);
    ctl.stop();
  });

  it('retire path writes no status event and stops replica reads', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    ensureRemoteAgentsProject(db);
    upsertDiscoveredModels(db, 'grok-bot', [{
      name: BOT, label: 'Grok Bot · Inbox', provider: 'xai', vision: false, steer: true,
    }]);
    const conversationId = createRemoteAgentConversation(db, BOT, 'Inbox Triage');
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT, label: 'Grok Bot · Inbox', provider: 'xai', vision: false, steer: true },
      { name: other, label: 'Grok Bot · Other', provider: 'xai', vision: false, steer: true },
    ]);
    const fake = makeFake({
      replica: [assistant('t7s0', 'old')],
      newestEntryId: 't7s0',
      rosterRows: [
        { id: BOT, name: 'Inbox Triage', newestEntryId: 't7s0' },
        { id: other, name: 'Other', newestEntryId: 'x0' },
      ],
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    fake.state.rosterRows = [{ id: other, name: 'Other', newestEntryId: 'x0' }];
    fake.evaluates.length = 0;
    await ctl.tickNow();
    expect(getConversation(db, conversationId)?.archived).toBe(true);
    const events = listEventsForConversation(db, conversationId);
    expect(events.map((e) => e.type)).toEqual(['message']);
    expect(events[0]?.sender).toBe('system');
    expect(events.every((e) => e.type !== 'status')).toBe(true);
    fake.evaluates.length = 0;
    await ctl.tickNow();
    expect(fake.evaluates.some((e) => e.includes(`transcript.replicas.${BOT}`))).toBe(false);
    ctl.stop();
  });

  it('persists cursor mutations when reconcile throws after renaming', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    ensureRemoteAgentsProject(db);
    upsertDiscoveredModels(db, 'grok-bot', [{
      name: BOT, label: 'Grok Bot · Inbox', provider: 'xai', vision: false, steer: true,
    }]);
    const conversationId = createRemoteAgentConversation(db, BOT, 'Old Name');
    writeCursors(db, { [BOT]: { entryId: 't7s0', seq: 0, updatedAt: 1, name: 'Old Name' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = makeFake({
      replica: [assistant('t7s0', 'old')],
      newestEntryId: 't7s0',
      rosterRows: [{ id: BOT, name: 'New Name', newestEntryId: 't7s0' }],
    });
    const { ctl } = boot({
      db,
      fake,
      autoCreateEnabled: () => false,
      onBroadcast: () => { throw new Error('broadcast exploded'); },
    });
    await ctl.tickNow();
    expect(getConversation(db, conversationId)?.title).toBe('New Name');
    expect(readCursors(db)[BOT]?.name).toBe('New Name');
    warn.mockRestore();
    ctl.stop();
  });

  it('turn ends between ticks: entries the live adapter ingested are not replayed', async () => {
    const { db, conversationId } = setupDb();
    // The reply landed and the turn settled between watcher ticks; the cursor
    // still sits on the user echo from the last mid-turn fast-forward.
    const replica = [user('t7u', 'hi'), assistant('t7s0', 'pong')];
    const fake = makeFake({ replica, newestEntryId: 't7s0' });
    writeCursors(db, { [BOT]: { entryId: 't7u', seq: 0, updatedAt: 1 } });
    const { ctl } = boot({ db, fake });
    ctl.noteAdapterIngested(BOT, ['t7s0']);
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s0');

    // A later, genuinely unsolicited entry still flows.
    fake.state.replica = [...replica, assistant('t7s1', 'unsolicited')];
    fake.state.newestEntryId = 't7s1';
    await ctl.tickNow();
    const events = watcherEvents(db, conversationId);
    expect(events.map((e) => (e.payload as { chunk: string }).chunk)).toEqual(['unsolicited']);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s1');
    ctl.stop();
  });
});

const BOT2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PREV = '11111111-2222-4333-8444-555555555555';

function datedAssistant(id: string, content: string, ts: number): ReplicaEntry {
  return { kind: 'send-message', id, timestampMs: ts, message: { type: 'text', content } };
}

function nAssistants(n: number, startTs = 1_000): ReplicaEntry[] {
  return Array.from({ length: n }, (_, i) => datedAssistant(`e${i}`, `msg-${i}`, startTs + i));
}

function setupRemote(botIds: string[] = [BOT]) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  ensureRemoteAgentsProject(db);
  upsertDiscoveredModels(db, 'grok-bot', botIds.map((id) => ({
    name: id, label: `Grok Bot · ${id.slice(0, 8)}`, provider: 'xai' as const, vision: false, steer: true,
  })));
  const convs = botIds.map((id) => ({
    botId: id,
    conversationId: createRemoteAgentConversation(db, id, id.slice(0, 8)),
  }));
  return { db, convs };
}

describe('GrokBotWatcher backfill', () => {
  it('a 43-entry replica with K=200 emits all 43, historical ts, no notify', async () => {
    const { db, convs } = setupRemote();
    const conversationId = convs[0]!.conversationId;
    const replica = nAssistants(43);
    writeCursors(db, { [BOT]: { entryId: '', seq: 0, updatedAt: 1, backfill: 200 } });
    const fake = makeFake({
      replica,
      newestEntryId: replica[replica.length - 1]!.id,
      rosterRows: [{ id: BOT, name: 'Inbox', newestEntryId: replica[replica.length - 1]!.id }],
    });
    const { ctl, notes } = boot({ db, fake, autoCreateEnabled: () => false });
    await ctl.tickNow();
    const events = watcherEvents(db, conversationId);
    expect(events).toHaveLength(43);
    expect(events.map((e) => e.ts)).toEqual(replica.map((r) => r.timestampMs));
    const ts = events.map((e) => e.ts);
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
    expect(notes).toEqual([]);
    expect(readCursors(db)[BOT]?.backfill).toBeUndefined();
    expect(readCursors(db)[BOT]?.entryId).toBe('e42');
    ctl.stop();
  });

  it('K=10 emits the last 10 entries', async () => {
    const { db, convs } = setupRemote();
    const replica = nAssistants(43);
    writeCursors(db, { [BOT]: { entryId: '', seq: 0, updatedAt: 1, backfill: 10 } });
    const fake = makeFake({
      replica,
      newestEntryId: 'e42',
      rosterRows: [{ id: BOT, name: 'Inbox', newestEntryId: 'e42' }],
    });
    const { ctl, notes } = boot({ db, fake, autoCreateEnabled: () => false });
    await ctl.tickNow();
    const events = watcherEvents(db, convs[0]!.conversationId);
    expect(events).toHaveLength(10);
    expect(events.map((e) => (e.payload as { chunk: string }).chunk)).toEqual(
      replica.slice(-10).map((r) => (r.message as { content: string }).content),
    );
    expect(notes).toEqual([]);
    ctl.stop();
  });

  it('notify is skipped during backfill and fires for the next live entry', async () => {
    const { db, convs } = setupRemote();
    const replica = nAssistants(3);
    writeCursors(db, { [BOT]: { entryId: '', seq: 0, updatedAt: 1, backfill: 200 } });
    const fake = makeFake({
      replica,
      newestEntryId: 'e2',
      rosterRows: [{ id: BOT, name: 'Inbox', newestEntryId: 'e2' }],
    });
    const { ctl, notes } = boot({ db, fake, autoCreateEnabled: () => false });
    await ctl.tickNow();
    expect(notes).toEqual([]);
    expect(readCursors(db)[BOT]?.backfill).toBeUndefined();

    fake.state.replica = [...replica, datedAssistant('e3', 'live', 2_000)];
    fake.state.newestEntryId = 'e3';
    if (fake.state.rosterRows) fake.state.rosterRows[0]!.newestEntryId = 'e3';
    await ctl.tickNow();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.category).toBe('agentMessage');
    expect(notes[0]?.conversationId).toBe(convs[0]!.conversationId);
    const events = watcherEvents(db, convs[0]!.conversationId);
    expect(events.map((e) => (e.payload as { chunk: string }).chunk)).toEqual(['msg-0', 'msg-1', 'msg-2', 'live']);
    ctl.stop();
  });

  it('clears backfill after the batch; a second tick emits nothing', async () => {
    const { db, convs } = setupRemote();
    const replica = nAssistants(5);
    writeCursors(db, { [BOT]: { entryId: '', seq: 0, updatedAt: 1, backfill: 200 } });
    const fake = makeFake({
      replica,
      newestEntryId: 'e4',
      rosterRows: [{ id: BOT, name: 'Inbox', newestEntryId: 'e4' }],
    });
    const { ctl } = boot({ db, fake, autoCreateEnabled: () => false });
    await ctl.tickNow();
    expect(watcherEvents(db, convs[0]!.conversationId)).toHaveLength(5);
    await ctl.tickNow();
    expect(watcherEvents(db, convs[0]!.conversationId)).toHaveLength(5);
    expect(readCursors(db)[BOT]?.backfill).toBeUndefined();
    ctl.stop();
  });

  it('live conversation during backfill: cursor advances, backfill cleared, nothing persisted', async () => {
    const { db, convs } = setupRemote();
    const conversationId = convs[0]!.conversationId;
    const replica = nAssistants(5);
    writeCursors(db, { [BOT]: { entryId: '', seq: 0, updatedAt: 1, backfill: 200 } });
    const fake = makeFake({
      replica,
      newestEntryId: 'e4',
      rosterRows: [{ id: BOT, name: 'Inbox', newestEntryId: 'e4' }],
    });
    const { ctl, notes } = boot({ db, fake, autoCreateEnabled: () => false, isLive: () => true });
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId)).toEqual([]);
    expect(notes).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe('e4');
    expect(readCursors(db)[BOT]?.backfill).toBeUndefined();
    expect(ctl.stats().skippedLive).toBeGreaterThan(0);
    ctl.stop();
  });

  it('two pending Bots backfill across two ticks', async () => {
    const { db, convs } = setupRemote([BOT, BOT2]);
    const a = nAssistants(4, 1_000);
    const b = nAssistants(3, 2_000);
    writeCursors(db, {
      [BOT]: { entryId: '', seq: 0, updatedAt: 1, backfill: 200 },
      [BOT2]: { entryId: '', seq: 0, updatedAt: 1, backfill: 200 },
    });
    const fake = makeFake({
      replicasByBot: { [BOT]: a, [BOT2]: b },
      rosterRows: [
        { id: BOT, name: 'A', newestEntryId: 'e3' },
        { id: BOT2, name: 'B', newestEntryId: 'e2' },
      ],
    });
    const { ctl, notes } = boot({ db, fake, autoCreateEnabled: () => false });
    await ctl.tickNow();
    const pending = [BOT, BOT2].filter((id) => readCursors(db)[id]?.backfill);
    expect(pending).toHaveLength(1);
    const done = [BOT, BOT2].find((id) => !readCursors(db)[id]?.backfill)!;
    const firstConv = convs.find((c) => c.botId === done)!.conversationId;
    expect(watcherEvents(db, firstConv).length).toBeGreaterThan(0);
    expect(notes).toEqual([]);

    await ctl.tickNow();
    expect(readCursors(db)[BOT]?.backfill).toBeUndefined();
    expect(readCursors(db)[BOT2]?.backfill).toBeUndefined();
    expect(watcherEvents(db, convs[0]!.conversationId).length).toBeGreaterThan(0);
    expect(watcherEvents(db, convs[1]!.conversationId).length).toBeGreaterThan(0);
    expect(notes).toEqual([]);
    ctl.stop();
  });
});

describe('native-app prompts', () => {
  it('persists a replica user row as a prompt event from the user', async () => {
    const { db, conversationId } = setupDb();
    const fake = makeFake({
      replica: [
        { id: 'e0', kind: 'send-message', message: { type: 'text', content: 'seed' } },
        { id: 'e1', kind: 'message', role: 'user', content: 'check my email' },
        { id: 'e2', kind: 'send-message', message: { type: 'text', content: 'on it' } },
      ],
      newestEntryId: 'e0',
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();                 // seeds the cursor at e0
    fake.state.newestEntryId = 'e2';
    await ctl.tickNow();
    ctl.stop();

    const evs = listEventsForConversation(db, conversationId).slice(1); // drop the seeded 'hi'
    expect(evs.map((e) => [e.type, e.sender])).toEqual([
      ['prompt', 'user'],
      ['message', 'agent'],
    ]);
    expect((evs[0].payload as { text: string }).text).toBe('check my email');
  });

  it('suppresses the replica echo of the prompt Tierwyn just sent, once', async () => {
    const { db, conversationId } = setupDb();   // newest prompt text is 'hi'
    const fake = makeFake({
      replica: [
        { id: 'e0', kind: 'send-message', message: { type: 'text', content: 'seed' } },
        { id: 'e1', kind: 'message', role: 'user', content: 'hi' },
        { id: 'e2', kind: 'message', role: 'user', content: 'hi' },
      ],
      newestEntryId: 'e0',
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    fake.state.newestEntryId = 'e2';
    await ctl.tickNow();
    ctl.stop();

    const prompts = listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt');
    // seeded 'hi' + the second (legitimately repeated) 'hi'; the first echo is dropped.
    expect(prompts).toHaveLength(2);
  });

  it('matches the echo whitespace-normalised across newlines', async () => {
    const { db, conversationId } = setupDb();
    appendEvent(db, {
      sessionId: 'turn-1', type: 'prompt', payload: { text: 'line one\nline two' },
      sender: 'user', seq: 1, ts: 2,
    });
    const fake = makeFake({
      replica: [
        { id: 'e0', kind: 'send-message', message: { type: 'text', content: 'seed' } },
        { id: 'e1', kind: 'message', role: 'user', content: 'line one line two' },
      ],
      newestEntryId: 'e0',
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    fake.state.newestEntryId = 'e1';
    await ctl.tickNow();
    ctl.stop();

    expect(listEventsForConversation(db, conversationId).filter((e) => e.type === 'prompt')).toHaveLength(2);
  });

  it('does not fire an agentMessage notification for a prompt-only burst', async () => {
    const { db } = setupDb();
    const fake = makeFake({
      replica: [
        { id: 'e0', kind: 'send-message', message: { type: 'text', content: 'seed' } },
        { id: 'e1', kind: 'message', role: 'user', content: 'anyone there' },
      ],
      newestEntryId: 'e0',
    });
    const { ctl, notes } = boot({ db, fake });
    await ctl.tickNow();
    fake.state.newestEntryId = 'e1';
    await ctl.tickNow();
    ctl.stop();

    expect(notes).toHaveLength(0);
  });
});

describe('GrokBotWatcher enabled gate', () => {
  it('disabled → no getClient, no cursor write, re-armed at the interval; re-enabled dials', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    let enabled = false;
    let gets = 0;
    const fake = makeFake();
    const { ctl, delays } = boot({
      db,
      fake,
      enabled: () => enabled,
      getClient: async () => { gets += 1; return fake.client; },
    });
    await ctl.tickNow();
    expect(gets).toBe(0);
    expect(delays.at(-1)).toBe(25_000);
    enabled = true;
    await ctl.tickNow();
    expect(gets).toBe(1);
    ctl.stop();
  });

  it('onUnreachableEdge fires once per episode and again after recovery', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    const edges: number[] = [];
    let fail = true;
    const fake = makeFake();
    const { ctl } = boot({
      db,
      fake,
      getClient: async () => {
        if (fail) throw new Error('CDP unreachable');
        return fake.client;
      },
      onUnreachableEdge: () => { edges.push(1); },
    });
    await ctl.tickNow();
    await ctl.tickNow();
    await ctl.tickNow();
    expect(edges).toHaveLength(1);
    fail = false;
    await ctl.tickNow();
    fail = true;
    await ctl.tickNow();
    expect(edges).toHaveLength(2);
    ctl.stop();
  });
});

const Q_PROMPT = 'What would you most like me to help with?';
/** DOM stamp returned by scanQuestionCards after select (prompt must match replica widget). */
const QUESTION_DOM = {
  cardId: 'gbq-help',
  prompt: Q_PROMPT,
  choices: [
    { id: 'A', label: 'A Email and calendar' },
    { id: 'B', label: 'B Coding and debugging' },
    { id: 'dismiss', label: 'Dismiss' },
  ],
  allowFreeText: true,
};

function openWidget(id: string, prompt: string, labels: string[], allowCustom = true): ReplicaEntry {
  return {
    kind: 'send-message',
    id,
    message: {
      type: 'widget',
      widget: {
        prompt,
        allowCustom,
        options: labels.map((label) => ({ label, value: label })),
      },
    },
  };
}

const OPEN_Q = openWidget('t8s0', Q_PROMPT, ['Email and calendar', 'Coding and debugging']);

describe('GrokBotWatcher question cards', () => {
  it('persists interaction_request from replica widgets without selectAgent', async () => {
    const { db, conversationId } = setupDb();
    writeCursors(db, { [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 } });
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong'), OPEN_Q],
      newestEntryId: 't8s0',
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    expect(fake.selectedAgents).toEqual([]);
    expect(fake.evaluates.some((e) => e.includes('__tierwynGrokBotQuestionScan'))).toBe(false);
    const first = listEventsForConversation(db, conversationId).filter((e) => e.type === 'interaction_request');
    expect(first).toHaveLength(1);
    expect(first[0]?.payload).toMatchObject({
      requestId: 'gbw-t8s0',
      kind: 'question',
      allowFreeText: true,
      prompt: Q_PROMPT,
    });

    await ctl.tickNow();
    expect(listEventsForConversation(db, conversationId).filter((e) => e.type === 'interaction_request')).toHaveLength(1);

    // Operator answered in the app → respondedValue closes the widget.
    const closed = { ...OPEN_Q, respondedValue: 'Email and calendar' };
    fake.state.replica = [assistant('t7s0', 'pong'), closed];
    await ctl.tickNow();
    const resolved = listEventsForConversation(db, conversationId).filter((e) => e.type === 'interaction_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.payload).toMatchObject({ requestId: 'gbw-t8s0', resolution: 'auto' });
    ctl.stop();
  });

  it('skips question ingest while a live Tierwyn session owns the conversation', async () => {
    const { db, conversationId } = setupDb();
    writeCursors(db, { [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 } });
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong'), OPEN_Q],
      newestEntryId: 't8s0',
    });
    const { ctl } = boot({ db, fake, isLive: () => true });
    await ctl.tickNow();
    expect(listEventsForConversation(db, conversationId).some((e) => e.type === 'interaction_request')).toBe(false);
    ctl.stop();
  });

  it('answerIdleInteraction selects the Bot, remaps gbw- to DOM stamp, then clicks', async () => {
    const { db, conversationId } = setupDb();
    writeCursors(db, { [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 } });
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong'), OPEN_Q],
      newestEntryId: 't8s0',
      questions: [QUESTION_DOM],
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    const req = listEventsForConversation(db, conversationId).find((e) => e.type === 'interaction_request');
    expect(req).toBeTruthy();
    expect((req!.payload as { requestId?: string }).requestId).toBe('gbw-t8s0');
    const result = await ctl.answerIdleInteraction(
      req!.sessionId, 'gbw-t8s0', { selection: ['A'] },
    );
    expect(result.accepted).toBe(true);
    expect(fake.selectedAgents).toContain(BOT);
    expect(fake.questionClicks).toEqual([{ cardId: 'gbq-help', choiceId: 'A' }]);
    const resolved = listEventsForConversation(db, conversationId).filter((e) => e.type === 'interaction_resolved');
    expect(resolved.some((e) => e.payload && (e.payload as { resolution?: string }).resolution === 'answered')).toBe(true);
    ctl.stop();
  });

  it('answerIdleInteraction CDP-clicks an approval card when requestId is gb- not gbq-', async () => {
    const { db, conversationId } = setupDb();
    writeCursors(db, { [BOT]: { entryId: 't7s0', seq: 0, updatedAt: 1 } });
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong')],
      newestEntryId: 't7s0',
      approvals: [{
        cardId: 'gb-abc-1',
        prompt: 'Grok Bot wants approval',
        choices: [
          { id: 'allow_once', label: 'Allow once' },
          { id: 'always_allow', label: 'Always allow' },
          { id: 'deny', label: 'Never' },
        ],
      }],
    });
    const { ctl } = boot({ db, fake });
    const result = await ctl.answerIdleInteraction(
      'turn-1', 'gb-abc-1', { selection: ['allow_once'] },
    );
    expect(result.accepted).toBe(true);
    expect(fake.approvalClicks).toEqual([{ cardId: 'gb-abc-1', choiceId: 'allow_once' }]);
    expect(fake.questionClicks).toEqual([]);
    const resolved = listEventsForConversation(db, conversationId).filter((e) => e.type === 'interaction_resolved');
    expect(resolved.some((e) => e.payload && (e.payload as { requestId?: string }).requestId === 'gb-abc-1')).toBe(true);
    ctl.stop();
  });

  it('detects idle Bot widgets without selectAgent even while another grok-bot turn is live', async () => {
    const { db, convs } = setupRemote([BOT, BOT2]);
    writeCursors(db, {
      [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 },
      [BOT2]: { entryId: 'x1', seq: 0, updatedAt: 1 },
    });
    const liveId = convs[0]!.conversationId;
    const idleId = convs[1]!.conversationId;
    const idleWidget = openWidget('x1', Q_PROMPT, ['Email and calendar', 'Coding and debugging']);
    const fake = makeFake({
      newestEntryId: 't8s0',
      rosterRows: [
        { id: BOT, name: 'A', newestEntryId: 't8s0' },
        { id: BOT2, name: 'B', newestEntryId: 'x1' },
      ],
      replicasByBot: {
        [BOT]: [assistant('t7s0', 'pong'), OPEN_Q],
        [BOT2]: [assistant('x0', 'idle'), idleWidget],
      },
    });
    const { ctl } = boot({ db, fake, isLive: (id) => id === liveId });
    await ctl.tickNow();
    expect(fake.selectedAgents).toEqual([]);
    expect(fake.evaluates.some((e) => e.includes('__tierwynGrokBotQuestionScan'))).toBe(false);
    expect(listEventsForConversation(db, liveId).some((e) => e.type === 'interaction_request')).toBe(false);
    expect(listEventsForConversation(db, idleId).some((e) => e.type === 'interaction_request')).toBe(true);
    ctl.stop();
  });

  it('answerIdleInteraction refuses while any grok-bot conversation is live', async () => {
    const { db, convs } = setupRemote([BOT, BOT2]);
    writeCursors(db, {
      [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 },
      [BOT2]: { entryId: 'x0', seq: 0, updatedAt: 1 },
    });
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong'), OPEN_Q],
      newestEntryId: 't8s0',
      questions: [QUESTION_DOM],
      rosterRows: [
        { id: BOT, name: 'A', newestEntryId: 't8s0' },
        { id: BOT2, name: 'B', newestEntryId: 'x0' },
      ],
    });
    const liveId = convs[0]!.conversationId;
    const idleSession = db.prepare(
      `SELECT id FROM sessions WHERE conversation_id = ? AND agent_id = 'grok-bot'`,
    ).get(convs[1]!.conversationId) as { id: string };
    const { ctl } = boot({ db, fake, isLive: (id) => id === liveId });
    const result = await ctl.answerIdleInteraction(
      idleSession.id, 'gbw-t8s0', { selection: ['A'] },
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('unsupported');
    expect(fake.selectedAgents).toEqual([]);
    ctl.stop();
  });

  it('tick never selectAgents for question detect (replica only)', async () => {
    const { db } = setupRemote([BOT, BOT2]);
    writeCursors(db, {
      [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 },
      [BOT2]: { entryId: 'x1', seq: 0, updatedAt: 1 },
    });
    const fake = makeFake({
      selection: PREV,
      rosterRows: [
        { id: BOT, name: 'A', newestEntryId: 't8s0' },
        { id: BOT2, name: 'B', newestEntryId: 'x1' },
      ],
      replicasByBot: {
        [BOT]: [assistant('t7s0', 'pong'), OPEN_Q],
        [BOT2]: [assistant('x0', 'idle'), openWidget('x1', Q_PROMPT, ['One', 'Two'])],
      },
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    expect(fake.selectedAgents).toEqual([]);
    expect(fake.selectedAgents).not.toContain(PREV);
    ctl.stop();
  });

  it('answerIdleInteraction waits for an in-flight tick before touching CDP', async () => {
    const { db } = setupDb();
    writeCursors(db, { [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 } });
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong'), OPEN_Q],
      newestEntryId: 't8s0',
      questions: [QUESTION_DOM],
    });
    let releaseTick!: () => void;
    const gate = new Promise<void>((r) => { releaseTick = r; });
    let gets = 0;
    const { ctl } = boot({
      db,
      fake,
      getClient: async () => {
        gets += 1;
        if (gets === 1) await gate;
        return fake.client;
      },
    });
    const tickP = ctl.tickNow();
    await Promise.resolve();
    const idleP = ctl.answerIdleInteraction('turn-1', 'gbw-t8s0', { selection: ['A'] });
    await new Promise((r) => setTimeout(r, 40));
    expect(fake.questionClicks).toEqual([]);
    releaseTick();
    await tickP;
    const result = await idleP;
    expect(result.accepted).toBe(true);
    expect(fake.questionClicks).toEqual([{ cardId: 'gbq-help', choiceId: 'A' }]);
    ctl.stop();
  });

  it('answerIdleInteraction waits for the selected chat before clicking', async () => {
    const { db } = setupDb();
    writeCursors(db, { [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 } });
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong'), OPEN_Q],
      newestEntryId: 't8s0',
      questions: [QUESTION_DOM],
    });
    const { ctl } = boot({ db, fake });
    const result = await ctl.answerIdleInteraction('turn-1', 'gbw-t8s0', { selection: ['A'] });
    expect(result.accepted).toBe(true);
    expect(fake.evaluates.some((e) => e.includes('sand-chat-header'))).toBe(true);
    expect(fake.questionClicks).toEqual([{ cardId: 'gbq-help', choiceId: 'A' }]);
    ctl.stop();
  });

  it('answerIdleInteraction restores the previous selection afterwards', async () => {
    const { db } = setupDb();
    writeCursors(db, { [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 } });
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong'), OPEN_Q],
      newestEntryId: 't8s0',
      questions: [QUESTION_DOM],
      selection: PREV,
    });
    const { ctl } = boot({ db, fake });
    const result = await ctl.answerIdleInteraction('turn-1', 'gbw-t8s0', { selection: ['A'] });
    expect(result.accepted).toBe(true);
    expect(fake.selectedAgents).toEqual([BOT, PREV]);
    ctl.stop();
  });

  it('answerIdleInteraction does not click when a grok-bot turn goes live after select', async () => {
    const { db, conversationId } = setupDb();
    writeCursors(db, { [BOT]: { entryId: 't8s0', seq: 0, updatedAt: 1 } });
    const live = new Set<string>();
    const fake = makeFake({
      replica: [assistant('t7s0', 'pong'), OPEN_Q],
      newestEntryId: 't8s0',
      questions: [QUESTION_DOM],
      selection: PREV,
      onSelectAgent: (id) => {
        if (id === BOT) live.add(conversationId);
      },
    });
    const { ctl } = boot({ db, fake, isLive: (id) => live.has(id) });
    const result = await ctl.answerIdleInteraction('turn-1', 'gbw-t8s0', { selection: ['A'] });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('unsupported');
    expect(fake.questionClicks).toEqual([]);
    expect(fake.selectedAgents).toEqual([BOT]);
    expect(fake.selectedAgents).not.toContain(PREV);
    ctl.stop();
  });
});

describe('GrokBotWatcher kill switch', () => {
  it('tickNow is a no-op and does not arm a timer when TIERWYN_GROKBOT_WATCH=0', async () => {
    vi.stubEnv('TIERWYN_GROKBOT_WATCH', '0');
    const { db } = setupDb();
    const fake = makeFake({ replica: [assistant('t7s0', 'pong')], newestEntryId: 't7s0' });
    let gets = 0;
    const { ctl, delays } = boot({
      db,
      fake,
      getClient: async () => { gets += 1; return fake.client; },
    });
    expect(delays).toEqual([]);
    await ctl.tickNow();
    expect(gets).toBe(0);
    expect(delays).toEqual([]);
    expect(ctl.stats().ticks).toBe(0);
    ctl.stop();
  });

  it('tickNow is a no-op and does not arm a further timer when enabled() is false', async () => {
    const { db } = setupDb();
    const fake = makeFake({ replica: [assistant('t7s0', 'pong')], newestEntryId: 't7s0' });
    let gets = 0;
    const { ctl, delays } = boot({
      db,
      fake,
      enabled: () => false,
      getClient: async () => { gets += 1; return fake.client; },
    });
    const armedAtStart = delays.length;
    await ctl.tickNow();
    expect(gets).toBe(0);
    expect(delays.length).toBe(armedAtStart);
    expect(ctl.stats().ticks).toBe(0);
    ctl.stop();
  });

  it('answerIdleInteraction refuses when the watcher is off', async () => {
    const { db } = setupDb();
    const fake = makeFake({ questions: [QUESTION_DOM] });
    const { ctl } = boot({ db, fake, enabled: () => false });
    const result = await ctl.answerIdleInteraction('turn-1', 'gbw-t8s0', { selection: ['A'] });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('unsupported');
    expect(fake.selectedAgents).toEqual([]);
    ctl.stop();
  });

  it('answerIdleInteraction refuses when TIERWYN_GROKBOT_WATCH=0', async () => {
    vi.stubEnv('TIERWYN_GROKBOT_WATCH', '0');
    const { db } = setupDb();
    const fake = makeFake({ questions: [QUESTION_DOM] });
    const { ctl } = boot({ db, fake });
    const result = await ctl.answerIdleInteraction('turn-1', 'gbw-t8s0', { selection: ['A'] });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('unsupported');
    ctl.stop();
  });
});

describe('GrokBotWatcher handover', () => {
  it('fires once when ownership moves, never on the first tick', async () => {
    const { db, conversationId } = setupDb(); // project chat, prompt at ts 1
    ensureRemoteAgentsProject(db);
    const containerId = createRemoteAgentConversation(db, BOT, 'Inbox');
    const NOW = 1_700_000_000_000;
    db.prepare(`UPDATE events SET ts = ? WHERE session_id = 'turn-1'`).run(NOW - 1000);
    const handovers: Array<{ fromConversationId: string; toConversationId: string }> = [];
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const { ctl } = boot({
      db, fake,
      replyLeaseMs: () => 3_600_000,
      onHandover: (h) => handovers.push({ fromConversationId: h.fromConversationId, toConversationId: h.toConversationId }),
    });
    await ctl.tickNow();                       // seeds owner = project chat
    expect(handovers).toEqual([]);
    db.prepare(`UPDATE events SET ts = ? WHERE session_id = 'turn-1'`).run(NOW - 2 * 3_600_000);
    await ctl.tickNow();                       // lease expired → container
    await ctl.tickNow();                       // stable → no repeat
    expect(handovers).toEqual([{ fromConversationId: conversationId, toConversationId: containerId }]);
    ctl.stop();
  });

  it('one relay per burst', async () => {
    const { db } = setupDb();
    const fake = makeFake({ replica: [assistant('t7s0', 'old')], newestEntryId: 't7s0' });
    const replies: string[] = [];
    const { ctl } = boot({ db, fake, onReply: (_id, prose) => replies.push(prose) });
    await ctl.tickNow();
    fake.state.replica = [assistant('t7s0', 'old'), assistant('t7s1', 'one'), assistant('t7s2', 'two')];
    fake.state.newestEntryId = 't7s2';
    await ctl.tickNow();
    expect(replies).toEqual(['one\n\ntwo']);
    ctl.stop();
  });
});

describe('GrokBotWatcher background prefetch (zero flicker)', () => {
  it('prefetches without selecting or advancing cursor when replica is stale behind newestEntryId', async () => {
    const { db, conversationId } = setupDb();
    const fake = makeFake({
      replica: [assistant('t7s0', 'old')],
      newestEntryId: 't7s0',
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s0');

    // Roster reports t7s1, but the replica slice in clientPersistence hasn't flushed t7s1 yet
    fake.state.newestEntryId = 't7s1';
    fake.evaluates.length = 0;
    await ctl.tickNow();
    expect(fake.selectedAgents).toEqual([]);
    expect(fake.evaluates.some((e) => e.includes('pointerover'))).toBe(true);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s0');
    expect(watcherEvents(db, conversationId)).toEqual([]);

    // Next tick after background prefetch flushes t7s1 into the replica
    fake.state.replica = [assistant('t7s0', 'old'), assistant('t7s1', 'hydrated')];
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId).map((e) => (e.payload as { chunk: string }).chunk)).toEqual(['hydrated']);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s1');
    ctl.stop();
  });

  it('does not declare cursor lost when replica is empty/unhydrated; prefetches first and ingests on next tick', async () => {
    const { db, conversationId } = setupDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeCursors(db, { [BOT]: { entryId: 't7s0', seq: 0, updatedAt: 1 } });
    // Unhydrated replica (empty) while roster says t7s1
    const fake = makeFake({
      replica: [],
      newestEntryId: 't7s1',
    });
    const { ctl } = boot({ db, fake });
    await ctl.tickNow();
    expect(fake.selectedAgents).toEqual([]);
    expect(fake.evaluates.some((e) => e.includes('pointerover'))).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('cursor lost'))).toEqual([]);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s0');

    // Replica hydrates before next tick
    fake.state.replica = [assistant('t7s0', 'old'), assistant('t7s1', 'recovered')];
    await ctl.tickNow();
    expect(watcherEvents(db, conversationId).map((e) => (e.payload as { chunk: string }).chunk)).toEqual(['recovered']);
    expect(readCursors(db)[BOT]?.entryId).toBe('t7s1');
    warn.mockRestore();
    ctl.stop();
  });
});


