/**
 * Server-lifetime Grok Bot inbound watcher. Polls the CDP roster for unsolicited
 * Bot output when no Tierwyn session is open, persists it onto a synthetic idle
 * session, and fires one agentMessage notification per burst.
 *
 * Not an AgentAdapter. Never emits status events. Never launches the GUI.
 */
import type { Database } from 'better-sqlite3';
import type { NormalisedEvent, NotificationInput, ServerFrame } from '@tierwyn/shared';
import type { CdpLike } from './cdp.js';
import {
  resolveSandboxMedia, readRosterRows, readTranscriptReplicaChecked, resetBridgeCache, readSelection,
} from './bridge.js';
import {
  selectAgent, prefetchAgentReplica, scanQuestionCards, clickQuestion, clickApproval, answerQuestionFreeText, waitForSelectedChat,
} from './inject.js';
import {
  entryEchoesPrompt, mapQuestionDelta, mapReplicaDelta, openReplicaWidgetsToCards,
  type PartialEvent, type QuestionCard,
} from './mapping.js';
import {
  ensureWatcherSession, listWatchedBots, readCursors, writeCursors, DEFAULT_REPLY_LEASE_MS, type Cursor,
} from '../../repositories/grokBotWatch.js';
import { appendEvent, latestPromptTextForConversation } from '../../repositories/events.js';
import { getConversation, touchConversation } from '../../repositories/conversations.js';
import { getProject } from '../../repositories/projects.js';
import { envPref } from '../../config/env.js';
import { reconcileRoster } from './reconcile.js';

const DEFAULT_INTERVAL_MS = 25_000;
const BACKOFF_MS = 60_000;
const BACKOFF_MAX_MS = 300_000;
const BACKOFF_ESCALATE_AFTER = 10;

export interface WatcherDeps {
  db: Database;
  /** Same singleton the adapter borrows. */
  getClient: () => Promise<CdpLike>;
  health: () => 'ok' | 'unreachable' | 'unhealthy';
  /** Forget a dead socket so the next tick redials. */
  dropClient: () => void;
  /** sessionManager.activeSessions()-backed; live conversations are cursor-advanced, not emitted. */
  isLive: (conversationId: string) => boolean;
  broadcast: (conversationId: string, frame: ServerFrame) => void;
  notify: (input: NotificationInput) => void;
  /** Skip auto-creating container conversations; existing ones are still renamed/retired. */
  autoCreateEnabled?: () => boolean;
  /** Replica entries replayed into a newly auto-created conversation. 0 = start from now. */
  backfillEntries?: () => number;
  /** Reload the in-memory catalogue after a roster upsert. */
  onCatalogueChanged?: () => void;
  /** Master switch: skip dial/reconcile/ingest when false. Default true. */
  enabled?: () => boolean;
  /** Once per unreachable episode — supervisor.kick(). */
  onUnreachableEdge?: () => void;
  /** `<dataDir>/attachments` for Bot-sent file shards. */
  attachmentsDir?: string;
  /** Reply lease for listWatchedBots. Default env TIERWYN_GROKBOT_REPLY_LEASE_MS, else 1 h. */
  replyLeaseMs?: () => number;
  /** Owner conversation for a Bot changed (not fired on the first tick after boot). */
  onHandover?: (h: { botId: string; botName?: string; fromConversationId: string; toConversationId: string }) => void;
  /** Agent prose just persisted by the watcher (one call per burst, never during backfill). */
  onReply?: (conversationId: string, prose: string) => void;
  /** Test seams. */
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface WatcherStats {
  ticks: number;
  ingested: number;
  skippedLive: number;
  errors: number;
  lastTickAt: number | null;
}

function defaultIntervalMs(): number {
  const n = Number(envPref('GROKBOT_WATCH_MS'));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

function defaultReplyLeaseMs(): number {
  const raw = envPref('GROKBOT_REPLY_LEASE_MS');
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_REPLY_LEASE_MS;
}

function watchEnabled(): boolean {
  return envPref('GROKBOT_WATCH') !== '0';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isCdpDrop(err: unknown): boolean {
  return /CDP socket (closed|dropped)/i.test(errText(err));
}

/** Open question-kind interaction_request ids with no later resolved event. */
function unresolvedQuestionIds(db: Database, conversationId: string): Set<string> {
  const rows = db.prepare(
    `SELECT e.type AS type, e.payload AS payload
       FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE s.conversation_id = ?
        AND e.type IN ('interaction_request', 'interaction_resolved')
      ORDER BY e.ts ASC, e.seq ASC`,
  ).all(conversationId) as { type: string; payload: string }[];
  const open = new Set<string>();
  for (const row of rows) {
    let p: { requestId?: string; kind?: string } = {};
    try { p = JSON.parse(row.payload) as { requestId?: string; kind?: string }; } catch { continue; }
    if (typeof p.requestId !== 'string' || !p.requestId) continue;
    if (row.type === 'interaction_request') {
      if (p.kind === 'question') open.add(p.requestId);
    } else {
      open.delete(p.requestId);
    }
  }
  return open;
}

/** Strip markdown images so data URLs never land in a push body. */
function notificationDetail(chunk: string | undefined): string {
  return (chunk ?? '').replace(/!\[.*?\]\(.*?\)/g, '').trim();
}

export class GrokBotWatcher {
  private readonly db: Database;
  private readonly getClient: WatcherDeps['getClient'];
  private readonly health: WatcherDeps['health'];
  private readonly dropClient: WatcherDeps['dropClient'];
  private readonly isLive: WatcherDeps['isLive'];
  private readonly broadcast: WatcherDeps['broadcast'];
  private readonly notify: WatcherDeps['notify'];
  private readonly autoCreateEnabled: () => boolean;
  private readonly backfillEntries: () => number;
  private readonly onCatalogueChanged: () => void;
  private readonly enabled: () => boolean;
  private readonly onUnreachableEdge: () => void;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (h: unknown) => void;
  private readonly attachmentsDir: string;

  private stopped = false;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private consecutiveUnreachable = 0;
  private loggedUnreachable = false;
  private readonly missingLogged = new Set<string>();
  private readonly lostLogged = new Set<string>();
  private readonly stalePrefetchAttempts = new Map<string, number>();
  private readonly replyLeaseMs: () => number;
  private readonly onHandover: NonNullable<WatcherDeps['onHandover']>;
  private readonly onReply: NonNullable<WatcherDeps['onReply']>;
  private readonly lastOwner = new Map<string, string>();
  /** Replica ids a live turn already delivered, per bot. Union of every turn since
   *  the cursor last passed them; ids are dropped as the cursor walks past.
   *  ponytail: cleared wholesale above 5000 ids (only reachable if the cursor is
   *  lost repeatedly); turn-scoped sets if that ever drops a real entry. */
  private readonly adapterIngested = new Map<string, Set<string>>();
  private readonly _stats: WatcherStats = {
    ticks: 0, ingested: 0, skippedLive: 0, errors: 0, lastTickAt: null,
  };

  constructor(deps: WatcherDeps) {
    this.db = deps.db;
    this.getClient = deps.getClient;
    this.health = deps.health;
    this.dropClient = deps.dropClient;
    this.isLive = deps.isLive;
    this.broadcast = deps.broadcast;
    this.notify = deps.notify;
    this.autoCreateEnabled = deps.autoCreateEnabled ?? (() => true);
    this.backfillEntries = deps.backfillEntries ?? (() => 200);
    this.onCatalogueChanged = deps.onCatalogueChanged ?? (() => {});
    this.enabled = deps.enabled ?? (() => true);
    this.onUnreachableEdge = deps.onUnreachableEdge ?? (() => {});
    this.replyLeaseMs = deps.replyLeaseMs ?? defaultReplyLeaseMs;
    this.onHandover = deps.onHandover ?? (() => {});
    this.onReply = deps.onReply ?? (() => {});
    this.intervalMs = deps.intervalMs ?? defaultIntervalMs();
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.attachmentsDir = deps.attachmentsDir ?? '';
  }

  start(): void {
    if (!watchEnabled()) {
      this.stopped = true;
      return;
    }
    this.stopped = false;
    this.arm(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  /** Called by the adapter while a live turn ingests transcript entries. */
  noteAdapterIngested(botId: string, entryIds: string[]): void {
    if (!botId) return;
    const set = this.adapterIngested.get(botId) ?? new Set<string>();
    for (const id of entryIds) set.add(id);
    if (set.size > 5000) set.clear();
    this.adapterIngested.set(botId, set);
  }

  stats(): WatcherStats {
    return { ...this._stats };
  }

  async tickNow(): Promise<void> {
    if (this.stopped || !watchEnabled() || !this.enabled()) return;
    await this.withTickLock(() => this.tick());
  }

  /** Serialise watcher CDP/selection: ticks and idle answers never interleave.
   *  Exclusive lock — cursor/seq writes cannot race a concurrent tick (B4 merge is extra). */
  private async withTickLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.running;
    const run = (async () => {
      if (prev) await prev.catch(() => undefined);
      return await fn();
    })();
    this.running = run.then(() => undefined, () => undefined);
    return run;
  }

  private arm(ms: number): void {
    this.disarm();
    if (this.stopped) return;
    const h = this.setTimer(() => {
      if (this.stopped) return;
      void this.tickNow();
    }, ms);
    if (h && typeof (h as { unref?: () => void }).unref === 'function') {
      (h as { unref: () => void }).unref();
    }
    this.timer = h;
  }

  private disarm(): void {
    if (this.timer != null) this.clearTimerFn(this.timer);
    this.timer = null;
  }

  private backoffMs(): number {
    if (this.consecutiveUnreachable >= BACKOFF_ESCALATE_AFTER) return BACKOFF_MAX_MS;
    return BACKOFF_MS;
  }

  private async tick(): Promise<void> {
    if (this.stopped || !watchEnabled()) return;
    let next = this.intervalMs;
    try {
      this._stats.ticks += 1;
      this._stats.lastTickAt = this.now();

      if (!this.enabled()) {
        next = this.intervalMs;
        return;
      }

      let client: CdpLike;
      try {
        client = await this.getClient();
      } catch {
        this.dropClient();
        resetBridgeCache();
        this.consecutiveUnreachable += 1;
        this._stats.errors += 1;
        if (!this.loggedUnreachable) {
          this.loggedUnreachable = true;
          this.onUnreachableEdge();
          const health = this.health();
          console.warn(`[grok-bot watcher] app ${health === 'ok' ? 'dropped' : health}; backing off`);
        }
        next = this.backoffMs();
        return;
      }
      this.consecutiveUnreachable = 0;
      this.loggedUnreachable = false;

      const rows = await readRosterRows(client);
      const cursors = readCursors(this.db);
      let cursorsDirty = false;
      try {
        cursorsDirty = reconcileRoster({
          db: this.db,
          autoCreateEnabled: this.autoCreateEnabled,
          onCatalogueChanged: this.onCatalogueChanged,
          isLive: this.isLive,
          broadcast: this.broadcast,
          cursors,
          now: this.now,
          backfillEntries: this.backfillEntries,
        }, rows);
      } catch (err) {
        // Persist in-place cursor mutations (rename/retire) even if reconcile
        // threw after mutating `cursors` and before returning dirty.
        cursorsDirty = true;
        this._stats.errors += 1;
        console.warn('[grok-bot watcher] reconcile failed:', errText(err));
      }
      if (cursorsDirty) writeCursors(this.db, cursors);

      const watched = listWatchedBots(this.db, { now: this.now(), leaseMs: this.replyLeaseMs() });
      const names = new Map(rows.map((r) => [r.id, r.name]));
      for (const w of watched) {
        const prev = this.lastOwner.get(w.botId);
        this.lastOwner.set(w.botId, w.conversationId);
        if (prev && prev !== w.conversationId) {
          try {
            this.onHandover({ botId: w.botId, botName: names.get(w.botId), fromConversationId: prev, toConversationId: w.conversationId });
          } catch (err) {
            console.warn('[grok-bot watcher] handover hook failed:', errText(err));
          }
        }
      }
      const turnLive = this.anyGrokBotLive();
      if (watched.length === 0) return;

      const byId = new Map(rows.map((r) => [r.id, r]));
      let backfillUsedThisTick = false;

      for (const w of watched) {
        let dirty = false;
        try {
          const result = await this.ingestBot(client, w, byId.get(w.botId), cursors, backfillUsedThisTick, turnLive);
          dirty = result.dirty;
          if (result.didBackfill) backfillUsedThisTick = true;
          // Replica widget detect — no selectAgent (avoids sidebar flicker). Skip only
          // when THIS conversation has a live turn; other Bots' live turns are fine.
          if (!this.isLive(w.conversationId) && byId.has(w.botId)) {
            if (await this.ingestQuestions(client, w, cursors)) dirty = true;
          }
        } catch (err) {
          dirty = true;
          this._stats.errors += 1;
          console.warn('[grok-bot watcher] bot tick failed:', errText(err));
          if (isCdpDrop(err)) {
            this.dropClient();
            next = this.backoffMs();
          }
        } finally {
          if (dirty) writeCursors(this.db, cursors);
        }
      }
    } catch (err) {
      this._stats.errors += 1;
      console.warn('[grok-bot watcher] tick failed:', errText(err));
      if (isCdpDrop(err)) {
        this.dropClient();
        next = this.backoffMs();
      }
    } finally {
      if (!this.stopped && watchEnabled()) this.arm(next);
    }
  }

  private async ingestBot(
    client: CdpLike,
    w: { conversationId: string; botId: string; agentModelId: string | null },
    row: { newestEntryId?: string } | undefined,
    cursors: Record<string, Cursor>,
    backfillUsedThisTick: boolean,
    turnLive: boolean,
  ): Promise<{ dirty: boolean; didBackfill: boolean }> {
    const skip = { dirty: false, didBackfill: false };
    if (!row) {
      if (!this.missingLogged.has(w.botId)) {
        this.missingLogged.add(w.botId);
        console.warn(`[grok-bot watcher] bot ${w.botId} no longer in roster`);
      }
      return skip;
    }
    const newest = row.newestEntryId;
    if (!newest) return skip;

    const now = this.now();
    const cursor = cursors[w.botId];
    if (!cursor) {
      cursors[w.botId] = { entryId: newest, seq: 0, updatedAt: now };
      return { dirty: true, didBackfill: false };
    }
    const K = typeof cursor.backfill === 'number' && cursor.backfill > 0 ? cursor.backfill : 0;
    const backfilling = K > 0;
    // A pending backfill on a live owner is start-from-now: skip it, never replay.
    if (backfilling && this.isLive(w.conversationId)) {
      cursor.entryId = newest;
      cursor.updatedAt = now;
      delete cursor.backfill;
      this._stats.skippedLive += 1;
      return { dirty: true, didBackfill: false };
    }
    // Any live Grok Bot turn owns the desktop. Hold the cursor (never fast-forward):
    // whatever the adapter did not report is delivered after the turn ends.
    if (turnLive && !backfilling) {
      this._stats.skippedLive += 1;
      return skip;
    }
    if (backfilling && backfillUsedThisTick) return skip;
    if (!backfilling && newest === cursor.entryId) return skip;

    const { entries, malformed } = await readTranscriptReplicaChecked(client, w.botId);
    if (malformed) return skip;
    const hasNewest = entries.some((e) => e.id === newest);
    if (hasNewest) {
      this.stalePrefetchAttempts.delete(w.botId);
    }

    let fresh;
    if (backfilling) {
      if (entries.length === 0) {
        const attempts = (this.stalePrefetchAttempts.get(w.botId) ?? 0) + 1;
        if (attempts <= 1 && (await prefetchAgentReplica(client, w.botId))) {
          this.stalePrefetchAttempts.set(w.botId, attempts);
          return skip;
        }
        this.stalePrefetchAttempts.delete(w.botId);
      } else {
        this.stalePrefetchAttempts.delete(w.botId);
      }
      const take = Math.min(K, entries.length);
      fresh = take > 0 ? entries.slice(-take) : [];
    } else {
      const idx = entries.findIndex((e) => e.id === cursor.entryId);
      if (idx < 0) {
        if (!hasNewest) {
          const attempts = (this.stalePrefetchAttempts.get(w.botId) ?? 0) + 1;
          if (attempts <= 2 && (await prefetchAgentReplica(client, w.botId))) {
            this.stalePrefetchAttempts.set(w.botId, attempts);
            return skip;
          }
          this.stalePrefetchAttempts.delete(w.botId);
        }
        cursor.entryId = newest;
        cursor.updatedAt = now;
        if (!this.lostLogged.has(w.botId)) {
          this.lostLogged.add(w.botId);
          console.warn(`[grok-bot watcher] cursor lost for ${w.botId}; resyncing`);
        }
        return { dirty: true, didBackfill: false };
      }
      fresh = entries.slice(idx + 1);
      if (fresh.length === 0) {
        if (!hasNewest) await prefetchAgentReplica(client, w.botId);
        return skip;
      }
      if (!hasNewest) await prefetchAgentReplica(client, w.botId);
    }

    const seen = new Set<string>();
    let sessionId: string | undefined;
    const persistedChunks: string[] = [];
    let lastTs = 0;
    // Only the single most recent Tierwyn-sent prompt can race the watcher cursor, so the
    // guard is read lazily and spent after one suppression — a genuinely repeated question
    // must still land. undefined = not read yet, null = spent / nothing to match.
    let echoGuard: string | null | undefined;

    for (const entry of fresh) {
      const delivered = this.adapterIngested.get(w.botId);
      if (!backfilling && delivered?.has(entry.id)) {
        delivered.delete(entry.id);
        cursor.entryId = entry.id;
        cursor.updatedAt = this.now();
        continue;
      }
      const mapped = mapReplicaDelta([entry], seen, { includeUser: true });
      for (let ev of mapped) {
        if (ev.type === 'prompt') {
          if (echoGuard === undefined) {
            echoGuard = latestPromptTextForConversation(this.db, w.conversationId);
          }
          if (echoGuard && entryEchoesPrompt(entry, echoGuard)) {
            echoGuard = null;
            continue;
          }
        }
        ev = await resolveSandboxMedia(client, ev, {
          conversationId: w.conversationId,
          attachmentsDir: this.attachmentsDir,
          agentId: w.botId,
        });
        sessionId ??= ensureWatcherSession(this.db, w.conversationId, w.botId, w.agentModelId);
        cursor.seq += 1;
        let ts: number;
        if (backfilling) {
          const entryTs = typeof entry.timestampMs === 'number' && entry.timestampMs > 0
            ? entry.timestampMs
            : (lastTs > 0 ? lastTs + 1 : this.now());
          ts = Math.max(lastTs + 1, entryTs);
          lastTs = ts;
        } else {
          ts = this.now();
        }
        const saved = appendEvent(this.db, {
          sessionId,
          type: ev.type,
          payload: ev.payload,
          sender: ev.type === 'prompt' ? 'user' : 'agent',
          agentModelId: w.agentModelId ?? undefined,
          seq: cursor.seq,
          ts,
        });
        // D4 rule 1: last *persisted* entry, even if broadcast later throws.
        cursor.entryId = entry.id;
        cursor.updatedAt = this.now();
        touchConversation(this.db, w.conversationId, saved.ts);
        this.broadcast(w.conversationId, {
          type: 'event',
          conversationId: w.conversationId,
          event: saved as unknown as NormalisedEvent,
        });
        this.broadcast(w.conversationId, {
          type: 'conversation_updated',
          conversationId: w.conversationId,
          ts: saved.ts,
        });
        this._stats.ingested += 1;
        if (saved.type === 'message') {
          const chunk = (saved.payload as { chunk?: string }).chunk;
          if (chunk) persistedChunks.push(chunk);
        }
      }
      cursor.entryId = entry.id;
      cursor.updatedAt = this.now();
    }

    if (backfilling) {
      delete cursor.backfill;
      cursor.entryId = fresh.length > 0 ? fresh[fresh.length - 1]!.id : newest;
      cursor.updatedAt = this.now();
    } else if (persistedChunks.length > 0) {
      const conv = getConversation(this.db, w.conversationId);
      const projectName = conv ? getProject(this.db, conv.projectId)?.name : undefined;
      this.notify({
        category: 'agentMessage',
        conversationId: w.conversationId,
        conversationTitle: conv?.title,
        description: notificationDetail(persistedChunks[persistedChunks.length - 1])
          || conv?.description,
        projectName,
      });
      try {
        this.onReply(w.conversationId, persistedChunks.join('\n\n'));
      } catch (err) {
        console.warn('[grok-bot watcher] reply hook failed:', errText(err));
      }
    }
    return { dirty: true, didBackfill: backfilling };
  }

  private anyGrokBotLive(): boolean {
    const rows = this.db.prepare(
      `SELECT DISTINCT conversation_id AS id FROM sessions WHERE agent_id = 'grok-bot'`,
    ).all() as { id: string }[];
    return rows.some((r) => this.isLive(r.id));
  }

  private persistPartials(
    w: { conversationId: string; botId: string; agentModelId: string | null },
    cursors: Record<string, Cursor>,
    events: PartialEvent[],
  ): boolean {
    if (events.length === 0) return false;
    const now = this.now();
    const cursor = cursors[w.botId] ?? { entryId: '', seq: 0, updatedAt: now };
    const sessionId = ensureWatcherSession(this.db, w.conversationId, w.botId, w.agentModelId);
    for (const ev of events) {
      cursor.seq += 1;
      const saved = appendEvent(this.db, {
        sessionId,
        type: ev.type,
        payload: ev.payload,
        sender: 'agent',
        agentModelId: w.agentModelId ?? undefined,
        seq: cursor.seq,
        ts: now,
      });
      cursor.updatedAt = now;
      touchConversation(this.db, w.conversationId, saved.ts);
      this.broadcast(w.conversationId, {
        type: 'event',
        conversationId: w.conversationId,
        event: saved as unknown as NormalisedEvent,
      });
      this.broadcast(w.conversationId, {
        type: 'conversation_updated',
        conversationId: w.conversationId,
        ts: saved.ts,
      });
    }
    cursors[w.botId] = cursor;
    return true;
  }

  private async restoreSelectionUnlessLive(client: CdpLike, previous: string | null): Promise<void> {
    if (!previous) return;
    if (this.anyGrokBotLive()) return;
    try { await selectAgent(client, previous); } catch { /* ignore non-UUID selection */ }
  }

  /** Open option/onboarding cards from the replica — no DOM select / no flicker. */
  private async ingestQuestions(
    client: CdpLike,
    w: { conversationId: string; botId: string; agentModelId: string | null },
    cursors: Record<string, Cursor>,
  ): Promise<boolean> {
    const { entries, malformed } = await readTranscriptReplicaChecked(client, w.botId);
    if (malformed) return false;
    const pending = unresolvedQuestionIds(this.db, w.conversationId);
    const cards = openReplicaWidgetsToCards(entries);
    const events = mapQuestionDelta(cards, pending);
    return this.persistPartials(w, cursors, events);
  }

  /**
   * Replica-minted ids are `gbw-<entryId>`; the DOM stamp is `gbq-<hash(prompt)>`.
   * After select, rematch by prompt (or sole visible card) before clicking.
   */
  private async resolveQuestionDomCard(
    client: CdpLike,
    requestId: string,
    botId: string,
  ): Promise<QuestionCard | null> {
    const cards = await scanQuestionCards(client).catch(() => [] as QuestionCard[]);
    if (cards.length === 0) return null;
    const exact = cards.find((c) => c.cardId === requestId);
    if (exact) return exact;
    if (!requestId.startsWith('gbw-')) {
      return cards.length === 1 ? cards[0]! : null;
    }
    const entryId = requestId.slice('gbw-'.length);
    const { entries } = await readTranscriptReplicaChecked(client, botId);
    const entry = entries.find((e) => e.id === entryId);
    const prompt = entry?.message?.widget?.prompt?.trim() ?? '';
    if (prompt) {
      const byPrompt = cards.find((c) => {
        const p = (c.prompt || '').replace(/\s+/g, ' ').trim();
        return p === prompt || p.startsWith(prompt) || prompt.startsWith(p.slice(0, Math.min(40, p.length)));
      });
      if (byPrompt) return byPrompt;
    }
    return cards.length === 1 ? cards[0]! : null;
  }

  async answerIdleInteraction(
    sessionId: string,
    requestId: string,
    response: { selection: string[]; text?: string },
  ): Promise<{ accepted: boolean; reason?: 'not_found' | 'unsupported' | 'error'; message?: string }> {
    if (!watchEnabled() || !this.enabled()) {
      return { accepted: false, reason: 'unsupported', message: 'Grok Bot watcher is off' };
    }
    if (!sessionId || !requestId) {
      return { accepted: false, reason: 'not_found', message: 'Session not found' };
    }
    const row = this.db.prepare(
      `SELECT s.conversation_id AS conversationId,
              s.native_session_id AS botId,
              s.agent_model_id AS agentModelId
         FROM sessions s
        WHERE s.id = ? AND s.agent_id = 'grok-bot'`,
    ).get(sessionId) as {
      conversationId: string; botId: string | null; agentModelId: string | null;
    } | undefined;
    const botId = row?.botId;
    if (!row || !botId) return { accepted: false, reason: 'not_found', message: 'Session not found' };
    const target = { conversationId: row.conversationId, botId, agentModelId: row.agentModelId };
    if (this.anyGrokBotLive()) {
      return { accepted: false, reason: 'unsupported', message: 'A live Grok Bot turn owns the desktop' };
    }
    if (this.isLive(target.conversationId)) {
      return { accepted: false, reason: 'unsupported', message: 'Live session owns this conversation' };
    }
    const choice = response.selection[0] ?? '';
    const text = typeof response.text === 'string' ? response.text.trim() : '';
    if (!choice && !text) {
      return { accepted: false, reason: 'error', message: 'empty answer' };
    }
    return this.withTickLock(() => this.performIdleAnswer(target, requestId, response, choice, text));
  }

  private async performIdleAnswer(
    row: { conversationId: string; botId: string; agentModelId: string | null },
    requestId: string,
    response: { selection: string[]; text?: string },
    choice: string,
    text: string,
  ): Promise<{ accepted: boolean; reason?: 'not_found' | 'unsupported' | 'error'; message?: string }> {
    if (this.anyGrokBotLive()) {
      return { accepted: false, reason: 'unsupported', message: 'A live Grok Bot turn owns the desktop' };
    }
    if (this.isLive(row.conversationId)) {
      return { accepted: false, reason: 'unsupported', message: 'Live session owns this conversation' };
    }
    try {
      const client = await this.getClient();
      const previous = await readSelection(client);
      const restoreTo = previous && previous !== row.botId ? previous : null;
      if (!(await selectAgent(client, row.botId))) {
        return { accepted: false, reason: 'error', message: 'Grok Bot chat is not in the app roster' };
      }
      if (!(await waitForSelectedChat(client, row.botId))) {
        await this.restoreSelectionUnlessLive(client, restoreTo);
        return { accepted: false, reason: 'error', message: 'Grok Bot chat did not become selected' };
      }
      if (this.anyGrokBotLive() || this.isLive(row.conversationId)) {
        await this.restoreSelectionUnlessLive(client, restoreTo);
        return { accepted: false, reason: 'unsupported', message: 'A live Grok Bot turn owns the desktop' };
      }
      const isApproval = requestId.startsWith('gb-')
        && !requestId.startsWith('gbq-')
        && !requestId.startsWith('gbw-');
      let ok = false;
      if (isApproval) {
        ok = await clickApproval(client, requestId, choice);
      } else {
        const dom = await this.resolveQuestionDomCard(client, requestId, row.botId);
        if (!dom) {
          await this.restoreSelectionUnlessLive(client, restoreTo);
          return { accepted: false, reason: 'error', message: 'Could not find the question card in the app' };
        }
        ok = text && !choice
          ? await answerQuestionFreeText(client, dom.cardId, text)
          : await clickQuestion(client, dom.cardId, choice);
      }
      if (!ok) {
        await this.restoreSelectionUnlessLive(client, restoreTo);
        return { accepted: false, reason: 'error', message: isApproval ? 'Could not click the approval card' : 'Could not click the question card' };
      }
      const cursors = readCursors(this.db);
      this.persistPartials(
        { conversationId: row.conversationId, botId: row.botId, agentModelId: row.agentModelId },
        cursors,
        [{
          type: 'interaction_resolved',
          payload: {
            requestId,
            selection: response.selection,
            text: response.text,
            resolution: 'answered',
          },
        }],
      );
      writeCursors(this.db, cursors);
      await this.restoreSelectionUnlessLive(client, restoreTo);
      return { accepted: true };
    } catch (err) {
      return { accepted: false, reason: 'error', message: errText(err) };
    }
  }
}

export function startGrokBotWatcher(deps: WatcherDeps): {
  stop(): void;
  tickNow(): Promise<void>;
  stats(): WatcherStats;
  noteAdapterIngested(botId: string, entryIds: string[]): void;
  answerIdleInteraction(
    sessionId: string,
    requestId: string,
    response: { selection: string[]; text?: string },
  ): Promise<{ accepted: boolean; reason?: 'not_found' | 'unsupported' | 'error'; message?: string }>;
} {
  const watcher = new GrokBotWatcher(deps);
  watcher.start();
  return {
    stop: () => watcher.stop(),
    tickNow: () => watcher.tickNow(),
    stats: () => watcher.stats(),
    noteAdapterIngested: (botId, entryIds) => watcher.noteAdapterIngested(botId, entryIds),
    answerIdleInteraction: (sessionId, requestId, response) =>
      watcher.answerIdleInteraction(sessionId, requestId, response),
  };
}
