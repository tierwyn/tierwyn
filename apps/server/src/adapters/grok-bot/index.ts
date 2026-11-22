/**
 * Grok Bot adapter — attach-only CDP remote control of the official desktop app.
 * Phase 2: composer send, replica-poll transcript, approval relay, Stop now, live steer.
 *
 * Constructor is side-effect free (boot-time discovery instantiates every adapter).
 */
import { EventEmitter } from 'events';
import { copyFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, AgentStatus,
} from '@tierwyn/shared';
import type { CdpLike } from './cdp.js';
import { getApp } from './app.js';
import {
  readRoster, readSelection, readTranscriptReplica, parseActivityAt,
  resolveSandboxMedia, resetBridgeCache, rosterModelDescriptors, BOT_ID_RE, type RosterRow,
} from './bridge.js';
import {
  probeComposer, clickSendButton, readAgentState, selectAgent, waitForSelectedChat,
  composerSend, attachComposerFiles, MAX_STAGED_ATTACHMENTS,
  scanApprovals, clickApproval, scanQuestionCards, clickQuestion, answerQuestionFreeText, deleteAgent,
} from './inject.js';
import { IDLE_STATE, STOP_NOW } from './selectors.js';
import { entryEchoesPrompt, mapApprovalDelta, mapQuestionDelta, mapReplicaDelta } from './mapping.js';
import { DEFAULT_POLL_MS, DEFAULT_TURN_TIMEOUT_MS, idleMsFromEnv, isTurnSettled } from './settle.js';
import { START_TIMEOUT_MS, supervisorMessage } from './supervisor.js';
import { safeNativeSessionId } from '../sessionId.js';
import type { GrokBotLifecycleStatus } from '@tierwyn/shared';

const UI_ERROR = 'Grok Bot UI changed or app not signed in — adapter needs a selector update';

export type GrokBotAdapterOpts = {
  client?: CdpLike;
  connect?: () => Promise<CdpLike>;
  idleMs?: number;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Settings getter — deleting a Tierwyn conversation deletes the Bot iff true. */
  deleteBotOnConversationDelete?: () => boolean;
  /** Lifecycle supervisor: start/sendPrompt await this before CDP connect. */
  ensureRunning?: (reason: 'prompt') => Promise<GrokBotLifecycleStatus>;
  /** Watcher coordination: replica entry ids the live turn just ingested, so the
   *  inbound watcher never replays them after the turn ends between its ticks. */
  onIngested?: (botId: string, entryIds: string[]) => void;
  /** `<dataDir>/attachments` — Bot-sent files land under this / conversationId. */
  attachmentsDir?: string;
  /** Test seam: staging wait budget (default 30s). */
  attachTimeoutMs?: number;
};

export class GrokBotAdapter implements AgentAdapter {
  private _emitter = new EventEmitter();
  private _sessionId = '';
  private _nativeSessionId = '';
  private _seq = 0;
  private _client: CdpLike | null;
  private _connect: () => Promise<CdpLike>;
  private _stopped = false;
  private _ended = false;
  private _pinnedAgentId = '';
  private _getNextSteer?: SessionConfig['getNextSteer'];
  private _steerLoopRunning = false;
  private readonly _pendingApprovals = new Set<string>();
  private readonly _pendingQuestions = new Set<string>();
  /** requestIds we are answering — skip a racing `resolution:'auto'` from the scanner. */
  private readonly _answering = new Set<string>();
  /** requestIds we already emitted as answered — skip remount auto/request until the next sendPrompt. */
  private readonly _answered = new Set<string>();
  private _steerSeq = 0;
  private _lastStatus: AgentStatus | null = null;
  /** Last replica / busy / steer activity; the turn timer slides from this. */
  private _turnKeepaliveAt = 0;
  private readonly _idleMs: number;
  private readonly _pollMs: number;
  private readonly _timeoutMs: number;
  private readonly _now: () => number;
  private readonly _sleep: (ms: number) => Promise<void>;
  private readonly _deleteBotOnConversationDelete: () => boolean;
  private readonly _ensureRunning?: (reason: 'prompt') => Promise<GrokBotLifecycleStatus>;
  private readonly _onIngested?: (botId: string, entryIds: string[]) => void;
  private readonly _attachmentsDir: string;
  private readonly _attachTimeoutMs: number;
  private _conversationId = '';

  constructor(opts: GrokBotAdapterOpts = {}) {
    this._client = opts.client ?? null;
    this._connect = opts.connect ?? (() => getApp().getClient());
    this._idleMs = opts.idleMs ?? idleMsFromEnv();
    this._pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this._now = opts.now ?? Date.now;
    this._sleep = opts.sleep ?? ((ms) => new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref();
    }));
    this._deleteBotOnConversationDelete = opts.deleteBotOnConversationDelete ?? (() => false);
    this._ensureRunning = opts.ensureRunning;
    this._onIngested = opts.onIngested;
    this._attachmentsDir = opts.attachmentsDir ?? '';
    this._attachTimeoutMs = opts.attachTimeoutMs ?? 30_000;
  }

  streamEvents(): EventEmitter { return this._emitter; }

  get nativeSessionId(): string { return this._nativeSessionId; }

  /** "Models" are the Bot chats in the app roster: picking one targets that chat,
   *  which is also how the operator sees its real name instead of "Default". */
  async listModels(): Promise<ModelDescriptor[]> {
    try {
      const rows = await readRoster(await this._ensureClient());
      return rosterModelDescriptors(rows);
    } catch (err) {
      this._forgetClient(err);
      return [];
    }
  }

  /** The app keeps the thread server-side, so a Bot chat that is still in the
   *  roster is always resumable — this is what lights the resume badge. */
  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    if (!nativeSessionId) return false;
    try {
      const rows = await readRoster(await this._ensureClient());
      return rows.some((r) => r.id === nativeSessionId);
    } catch {
      return false;
    }
  }

  async deleteNativeSession(botId: string): Promise<void> {
    if (!this._deleteBotOnConversationDelete()) return;
    if (!BOT_ID_RE.test(botId)) return;           // 'default' and junk never reach the app
    try {
      if (!(await deleteAgent(await this._ensureClient(), botId, { sleep: this._sleep }))) {
        console.warn(`[grok-bot] delete for bot ${botId} did not settle; Bot may still exist`);
      }
    } catch (err) {
      // ponytail: never fail the HTTP delete — the DB rows are already gone by the
      // time this runs. A surviving Bot is recoverable; an ambiguous 500 is not.
      console.error(`[grok-bot] deleteNativeSession failed for ${botId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  async start(config: SessionConfig): Promise<void> {
    this._sessionId = config.sessionId;
    this._conversationId = config.conversationId;
    this._seq = 0;
    this._stopped = false;
    this._ended = false;
    this._lastStatus = null;
    this._pendingApprovals.clear();
    this._pendingQuestions.clear();
    this._answering.clear();
    this._answered.clear();
    this._steerSeq = 0;
    this._getNextSteer = config.getNextSteer;
    this._nativeSessionId = safeNativeSessionId(config.nativeSessionId) ?? '';
    // A profile whose model is a Bot id pins the conversation to that chat; the
    // seeded `default` model keeps the old "follow the app selection" behaviour.
    this._pinnedAgentId = BOT_ID_RE.test(config.model ?? '') ? String(config.model) : '';
    try {
      await this._awaitSupervisor();
      const client = await this._ensureClient();
      const composer = await probeComposer(client);
      if (!composer) {
        this._fail(UI_ERROR);
        return;
      }
      if (this._pinnedAgentId) {
        this._nativeSessionId = safeNativeSessionId(this._pinnedAgentId) ?? '';
        return;
      }
      const selected = await readSelection(client);
      if (selected) this._nativeSessionId = safeNativeSessionId(selected) ?? '';
    } catch (err) {
      this._fail(this._forgetClient(err));
    }
  }

  async sendPrompt(text: string, attachments?: Attachment[], model?: string): Promise<void> {
    if (this._stopped || this._ended) return;
    this._answered.clear();
    this._setStatus('running');
    void this._runSteerLoop();
    try {
      await this._awaitSupervisor();
      const client = await this._ensureClient();
      const composer = await probeComposer(client);
      if (!composer) {
        this._fail(UI_ERROR);
        return;
      }
      const pinned = BOT_ID_RE.test(model ?? '') ? String(model) : this._pinnedAgentId;
      const agentId = pinned || this._nativeSessionId || (await readSelection(client)) || '';
      if (!agentId) {
        this._fail(UI_ERROR);
        return;
      }
      this._nativeSessionId = safeNativeSessionId(agentId) ?? '';
      // The composer posts to the chat on screen, so a pinned Bot must be selected
      // first or the prompt would land in whichever chat the operator left open.
      if (pinned) {
        if (!(await selectAgent(client, pinned))) {
          this._fail(`Grok Bot chat ${pinned} is not in the app roster`);
          return;
        }
        await waitForSelectedChat(client, pinned, { sleep: this._sleep, timeoutMs: 1_500, pollMs: 50 });
      }
      const baseline = await readTranscriptReplica(client, agentId);
      const baselineIds = new Set(baseline.map((e) => e.id));
      const seen = new Set(baselineIds);
      const ingestedIds = new Set<string>();

      let stageDir: string | undefined;
      try {
        const staged = await this._attachNamed(client, attachments);
        if (staged === false) return;
        stageDir = staged;
        await composerSend(client, text);
      } finally {
        if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      }

      this._turnKeepaliveAt = this._now();
      let lastCount = baselineIds.size;
      let lastNewAt = this._turnKeepaliveAt;
      let sawUser = false;
      let sawAssistant = false;
      let lastSeenSteerSeq = this._steerSeq;

      // D7: a pending approval card may sit forever — do not cut it off with the
      // turn timer. Stop() is the only way out of a stuck wait. The timer is a
      // sliding idle window from last replica / busy / steer activity, not a
      // wall-clock cutoff from sendPrompt.
      while (!this._stopped && !this._ended && (this._pendingCount() > 0 || this._now() - this._turnKeepaliveAt < this._timeoutMs)) {
        const entries = await readTranscriptReplica(client, agentId);
        const t = this._now();
        if (this._steerSeq !== lastSeenSteerSeq) {
          lastSeenSteerSeq = this._steerSeq;
          sawAssistant = false;
          lastNewAt = t;
          this._turnKeepaliveAt = t;
        }
        if (entries.length !== lastCount) {
          lastCount = entries.length;
          lastNewAt = t;
          this._turnKeepaliveAt = t;
        }
        if (text.trim() === '') {
          if (entries.some((e) => e.kind === 'message' && e.role === 'user' && !baselineIds.has(e.id))) {
            sawUser = true;
          }
        } else if (entries.some((e) => !baselineIds.has(e.id) && entryEchoesPrompt(e, text))) {
          sawUser = true;
        }
        if (entries.some((e) => e.kind === 'send-message' && !baselineIds.has(e.id))) {
          sawAssistant = true;
        }
        const before = ingestedIds.size;
        for (const entry of entries) {
          // Everything that appeared during this turn belongs to the turn — the user
          // echo and steers included — so the watcher never replays it afterwards.
          if (!baselineIds.has(entry.id)) ingestedIds.add(entry.id);
          const mapped = mapReplicaDelta([entry], seen);
          for (const ev of mapped) {
            this._emit(await resolveSandboxMedia(client, ev, {
              conversationId: this._conversationId,
              attachmentsDir: this._attachmentsDir,
              agentId: this._nativeSessionId || undefined,
            }));
          }
        }
        if (ingestedIds.size > before) this._onIngested?.(agentId, [...ingestedIds]);
        await this._pollInteractions(client);

        const row = (await readRoster(client)).find((r) => r.id === agentId);
        const activity = parseActivityAt(row?.lastActivityAt);
        // Grok goes quiet for tens of seconds while it drives the computer. Without
        // the app's own busy mark the idle window expires mid-turn, Tierwyn calls the
        // turn done, and every later message is dropped on the floor.
        const state = await readAgentState(client, agentId);
        const busy = state != null && state !== IDLE_STATE;
        const streaming = busy || entries.some((e) => e.isStreaming === true);
        if (streaming) this._turnKeepaliveAt = t;
        const pending = this._pendingCount() > 0;
        if (!pending && isTurnSettled({
          sawUserEntry: sawUser,
          sawAssistantEntry: sawAssistant,
          anyStreaming: streaming,
          msSinceLastNewEntry: t - lastNewAt,
          msSinceLastActivity: activity == null ? null : t - activity,
          idleMs: this._idleMs,
        })) {
          this._finish('done');
          return;
        }
        if (this._stopped || this._ended) break;
        const remaining = this._timeoutMs - (this._now() - this._turnKeepaliveAt);
        if (this._pendingCount() === 0 && remaining <= 0) break;
        await this._sleep(Math.min(this._pollMs, this._pendingCount() > 0 ? this._pollMs : Math.max(1, remaining)));
      }

      if (this._ended) return;
      if (this._stopped) {
        this._finish('idle');
        return;
      }
      if (!sawUser) {
        await clickSendButton(client);
        this._fail('Grok Bot did not accept the prompt (Enter-dispatch produced no user replica entry)');
        return;
      }
      this._fail('Grok Bot turn timed out waiting for the replica to settle');
    } catch (err) {
      this._fail(this._forgetClient(err));
    }
  }

  async steer(text: string, attachments?: Attachment[]): Promise<void> {
    if (this._stopped || this._ended) return;
    if (!text && !(attachments && attachments.some((a) => a.base64 || a.tempPath))) return;
    this._steerSeq += 1;
    this._turnKeepaliveAt = this._now();
    let stageDir: string | undefined;
    try {
      const client = await this._ensureClient();
      const staged = await this._attachNamed(client, attachments);
      if (staged === false) return;
      stageDir = staged;
      await composerSend(client, text);
    } catch (err) {
      this._forgetClient(err);
    } finally {
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Soft-end: documented "Stop now" chat message. Must NOT emit EventEmitter 'end'. */
  interruptTurn(): void {
    void this._sendStopNow(false);
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this._answering.clear();
    this._answered.clear();
    await this._sendStopNow(true);
  }

  respondToInteraction(
    requestId: string,
    response: { selection: string[]; text?: string },
  ): void {
    if (!requestId) return;
    const isQuestion = this._pendingQuestions.has(requestId);
    const isApproval = this._pendingApprovals.has(requestId);
    if (!isQuestion && !isApproval) return;
    const choice = response.selection[0] ?? '';
    const text = typeof response.text === 'string' ? response.text.trim() : '';
    if (isQuestion) {
      if (!choice && !text) return;
      this._answering.add(requestId);
      void this._answerQuestion(requestId, choice, response);
      return;
    }
    if (!choice) return;
    this._answering.add(requestId);
    void this._clickAndResolve(requestId, choice, response);
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    try {
      const client = await this._ensureClient();
      return (await readRoster(client)).map((r: RosterRow) => ({
        id: r.id,
        summary: r.name ?? r.id,
        createdAt: parseActivityAt(r.lastActivityAt) ?? undefined,
      }));
    } catch (err) {
      this._forgetClient(err);
      return [];
    }
  }

  async loadSession(id: string): Promise<void> {
    this._nativeSessionId = safeNativeSessionId(id) ?? '';
  }

  private async _awaitSupervisor(): Promise<void> {
    if (!this._ensureRunning) return;
    let settled = false;
    const timeout = new Promise<null>((resolve) => {
      void this._sleep(START_TIMEOUT_MS + 5_000).then(() => {
        if (!settled) resolve(null);
      });
    });
    try {
      const status = await Promise.race([this._ensureRunning('prompt'), timeout]);
      if (!status) {
        throw new Error('Grok Bot did not become ready within 35s — see Settings → Grok Bot');
      }
      if (status.state !== 'running') {
        throw new Error(supervisorMessage(status));
      }
    } finally {
      settled = true;
    }
  }

  private async _ensureClient(): Promise<CdpLike> {
    if (this._client) return this._client;
    this._client = await this._connect();
    return this._client;
  }

  private _emit(e: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    this._emitter.emit('event', {
      ...e,
      sessionId: this._sessionId,
      seq: ++this._seq,
      ts: this._now(),
    } as NormalisedEvent);
  }

  private _setStatus(status: AgentStatus): void {
    if (this._lastStatus === status) return;
    this._lastStatus = status;
    this._emit({ type: 'status', payload: { status } });
  }

  private _pendingCount(): number {
    return this._pendingApprovals.size + this._pendingQuestions.size;
  }

  private async _pollInteractions(client: CdpLike): Promise<void> {
    const [approvals, questions] = await Promise.all([
      scanApprovals(client).catch(() => []),
      scanQuestionCards(client).catch(() => []),
    ]);
    const events = [
      ...mapApprovalDelta(approvals, this._pendingApprovals),
      ...mapQuestionDelta(questions, this._pendingQuestions),
    ];
    for (const ev of events) {
      const p = ev.payload as { resolution?: string; requestId?: string };
      const id = p.requestId;
      if (ev.type === 'interaction_request' && id && this._answered.has(id)) {
        this._pendingApprovals.delete(id);
        this._pendingQuestions.delete(id);
        continue;
      }
      if (ev.type === 'interaction_resolved') {
        if (p.resolution === 'auto' && id && (this._answering.has(id) || this._answered.has(id))) continue;
      }
      this._emit(ev);
    }
    if (this._pendingCount() > 0) this._setStatus('waiting');
    else if (events.some((e) => e.type === 'interaction_resolved')) this._setStatus('running');
  }

  private async _answerQuestion(
    requestId: string,
    choice: string,
    response: { selection: string[]; text?: string },
  ): Promise<void> {
    try {
      const client = await this._ensureClient();
      const text = typeof response.text === 'string' ? response.text.trim() : '';
      if (text && !choice) {
        const ok = await answerQuestionFreeText(client, requestId, text);
        if (!ok) {
          this._answering.delete(requestId);
          this._emit({ type: 'error', payload: { message: 'Could not submit the question card' } });
          return;
        }
      } else {
        const ok = await clickQuestion(client, requestId, choice);
        if (!ok) {
          this._answering.delete(requestId);
          this._emit({ type: 'error', payload: { message: 'Could not click the question card' } });
          return;
        }
      }
    } catch (err) {
      this._forgetClient(err);
      this._answering.delete(requestId);
      this._emit({ type: 'error', payload: { message: 'Could not click the question card' } });
      return;
    }
    this._pendingQuestions.delete(requestId);
    this._answered.add(requestId);
    this._emit({
      type: 'interaction_resolved',
      payload: {
        requestId,
        selection: response.selection,
        text: response.text,
        resolution: 'answered',
      },
    });
    this._answering.delete(requestId);
    this._setStatus('running');
  }

  private async _clickAndResolve(
    requestId: string,
    choice: string,
    response: { selection: string[]; text?: string },
  ): Promise<void> {
    try {
      await clickApproval(await this._ensureClient(), requestId, choice);
    } catch (err) {
      this._forgetClient(err);
    }
    this._pendingApprovals.delete(requestId);
    this._answered.add(requestId);
    this._emit({
      type: 'interaction_resolved',
      payload: {
        requestId,
        selection: response.selection,
        text: response.text,
        resolution: 'answered',
      },
    });
    this._answering.delete(requestId);
    this._setStatus('running');
  }

  private async _sendStopNow(emitEnd: boolean): Promise<void> {
    try {
      await composerSend(await this._ensureClient(), STOP_NOW);
    } catch (err) {
      this._forgetClient(err);
    }
    if (emitEnd) this._finish('idle');
  }

  /** Park on getNextSteer so sessionManager can inject mid-turn (LIVE_INJECT). */
  private async _runSteerLoop(): Promise<void> {
    if (this._steerLoopRunning || !this._getNextSteer) return;
    this._steerLoopRunning = true;
    try {
      while (!this._stopped && !this._ended) {
        const next = await this._getNextSteer();
        if (next == null || this._stopped || this._ended) return;
        await this.steer(next.text, next.attachments);
      }
    } catch {
      /* loop exit is benign */
    } finally {
      this._steerLoopRunning = false;
    }
  }

  /** Copy attachments under original names, stage via the composer input. */
  private async _attachNamed(client: CdpLike, attachments?: Attachment[]): Promise<string | undefined | false> {
    const kept = (attachments ?? []).filter((a) => a.base64 || a.tempPath);
    if (kept.length === 0) return undefined;
    if (kept.length > MAX_STAGED_ATTACHMENTS) {
      this._fail(`Grok Bot accepts at most ${MAX_STAGED_ATTACHMENTS} attachments`);
      return false;
    }
    const dir = await mkdtemp(join(tmpdir(), 'tierwyn-grokbot-'));
    const used = new Set<string>();
    const paths: string[] = [];
    const names: string[] = [];
    for (const a of kept) {
      const name = uniqueAttachmentName(a, used);
      const dest = join(dir, name);
      if (a.tempPath) await copyFile(a.tempPath, dest);
      else await writeFile(dest, Buffer.from(a.base64, 'base64'));
      paths.push(dest);
      names.push(name);
    }
    const result = await attachComposerFiles(client, paths, names, {
      sleep: this._sleep, timeoutMs: this._attachTimeoutMs, pollMs: 50,
    });
    if (result !== 'ok') {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this._fail(result === 'missing'
        ? 'attachment input not found — selector update needed'
        : 'Grok Bot did not accept the attachment(s)');
      return false;
    }
    return dir;
  }

  private _fail(message: string): void {
    if (this._ended) return;
    this._emit({ type: 'error', payload: { message } });
    this._setStatus('error');
    this._ended = true;
    this._stopped = true;
    this._emitter.emit('end');
  }

  private _finish(status: 'done' | 'idle'): void {
    if (this._ended) return;
    this._ended = true;
    this._stopped = true;
    this._setStatus(status);
    this._emitter.emit('end');
  }

  /** A dead socket must not poison later turns: forget both caches so the next
   *  call redials the (possibly restarted) Grok Bot instead of failing forever. */
  private _forgetClient(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/CDP socket (closed|dropped)/.test(msg)) {
      this._client = null;
      getApp().drop();
      resetBridgeCache();
    }
    return this._connectError(err);
  }

  private _connectError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    // Supervisor copy already names Settings → Grok Bot; don't wrap it.
    if (msg.startsWith('Grok Bot ')) return msg;
    if (/unreachable|ECONNREFUSED|fetch failed|page target/i.test(msg)) {
      return `Grok Bot app not reachable — start the desktop app with --remote-debugging-port (Grok Bot sidecar). ${msg}`;
    }
    return msg;
  }
}

function uniqueAttachmentName(a: Attachment, used: Set<string>): string {
  const raw = typeof a.name === 'string' ? basename(a.name) : '';
  const cleaned = raw.replace(/[/\\0\x00-\x1f]/g, '').trim();
  const extFromType = (a.mediaType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  let name = cleaned || `attachment.${extFromType}`;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (used.has(name)) {
    name = `${stem} (${n})${ext}`;
    n += 1;
  }
  used.add(name);
  return name;
}
