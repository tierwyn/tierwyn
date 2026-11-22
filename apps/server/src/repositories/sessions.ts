import type { Database } from 'better-sqlite3';
import type { SessionMeta, ConversationUsage } from '@tierwyn/shared';
import { contextWindowOccupancy, computeContextWindowPct } from '@tierwyn/shared';
import { safePersistedNativeSessionId } from '../adapters/sessionId.js';

interface Row {
  id: string;
  conversation_id: string;
  agent_id: string | null;
  agent_model_id: string | null;
  native_session_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  context_window_pct: number | null;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_pct: number | null;
  seven_day_resets_at: number | null;
  tokens_estimated: number | null;
  created_at: number;
  updated_at: number;
}

function toMeta(r: Row): SessionMeta {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    agentId: r.agent_id ?? undefined,
    agentModelId: r.agent_model_id ?? undefined,
    nativeSessionId: r.native_session_id ?? undefined,
    inputTokens: r.input_tokens ?? undefined,
    outputTokens: r.output_tokens ?? undefined,
    cacheReadTokens: r.cache_read_tokens ?? undefined,
    cacheCreationTokens: r.cache_creation_tokens ?? undefined,
    costUsd: r.cost_usd ?? undefined,
    contextWindowPct: r.context_window_pct ?? undefined,
    fiveHourPct: r.five_hour_pct ?? undefined,
    fiveHourResetsAt: r.five_hour_resets_at ?? undefined,
    sevenDayPct: r.seven_day_pct ?? undefined,
    sevenDayResetsAt: r.seven_day_resets_at ?? undefined,
    tokensEstimated: r.tokens_estimated === 1 ? true : r.tokens_estimated === 0 ? false : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createSession(
  db: Database,
  input: { id: string; conversationId: string; agentId?: string; agentModelId?: string }
): SessionMeta {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, agent_id, agent_model_id, native_session_id, created_at, updated_at)
     VALUES (?,?,?,?,NULL,?,?)`
  ).run(input.id, input.conversationId, input.agentId ?? null, input.agentModelId ?? null, now, now);
  return toMeta({
    id: input.id,
    conversation_id: input.conversationId,
    agent_id: input.agentId ?? null,
    agent_model_id: input.agentModelId ?? null,
    native_session_id: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    cost_usd: null,
    context_window_pct: null,
    five_hour_pct: null,
    five_hour_resets_at: null,
    seven_day_pct: null,
    seven_day_resets_at: null,
    tokens_estimated: null,
    created_at: now,
    updated_at: now,
  });
}

export function getSession(db: Database, id: string): SessionMeta | undefined {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
  return r ? toMeta(r) : undefined;
}

export function lastSessionForConversation(
  db: Database,
  conversationId: string,
  opts: { agentId?: string; excludeId?: string } = {},
): SessionMeta | undefined {
  const clauses = ['conversation_id = ?'];
  const params: (string | number)[] = [conversationId];
  if (opts.agentId) {
    // When resuming within a single adapter, only consider prior sessions from
    // that same adapter — otherwise a freshly-created empty session for a newly
    // selected adapter (or a prior adapter's session) would win and we'd
    // native-resume the wrong agent's session.
    clauses.push('agent_id = ?');
    params.push(opts.agentId);
  }
  if (opts.excludeId) {
    clauses.push('id != ?');
    params.push(opts.excludeId);
  }
  const r = db
    .prepare(
      `SELECT * FROM sessions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...params) as Row | undefined;
  return r ? toMeta(r) : undefined;
}

/** Most recent fingerprint written by an injecting prompt. Skips sessions that
 *  never injected (e.g. handleCommand) so a NULL row cannot force a full
 *  re-teach. Do not use lastSessionForConversation for this. */
export function lastPreambleFp(
  db: Database,
  conversationId: string,
  opts: { excludeId?: string } = {},
): string | undefined {
  const r = db.prepare(
    `SELECT preamble_fp FROM sessions
      WHERE conversation_id = ? AND preamble_fp IS NOT NULL
        ${opts.excludeId ? 'AND id != ?' : ''}
      ORDER BY created_at DESC LIMIT 1`,
  ).get(
    ...(opts.excludeId ? [conversationId, opts.excludeId] : [conversationId]),
  ) as { preamble_fp: string } | undefined;
  return r?.preamble_fp;
}

export function setPreambleFp(db: Database, sessionId: string, fp: string): void {
  db.prepare(`UPDATE sessions SET preamble_fp = ?, updated_at = ? WHERE id = ?`)
    .run(fp, Date.now(), sessionId);
}

export function setNativeSessionId(db: Database, sessionId: string, nativeId: string): void {
  if (!safePersistedNativeSessionId(nativeId)) {
    console.warn('[sessions] rejected unsafe native session id');
    return;
  }
  db.prepare('UPDATE sessions SET native_session_id = ?, updated_at = ? WHERE id = ?').run(
    nativeId,
    Date.now(),
    sessionId
  );
}

/** WP-2.4: persist a live model switch so defaulting readers (schedules, spawn
 *  role resolution, timers) see the new profile. */
export function setSessionAgentModel(db: Database, sessionId: string, agentModelId: string): void {
  db.prepare('UPDATE sessions SET agent_model_id = ?, updated_at = ? WHERE id = ?')
    .run(agentModelId, Date.now(), sessionId);
}

export function clearNativeSessionId(db: Database, sessionId: string): void {
  db.prepare('UPDATE sessions SET native_session_id = NULL, updated_at = ? WHERE id = ?').run(
    Date.now(),
    sessionId,
  );
}

/** Partial update for live tokenizer estimates while a session is still running.
 *  Never overwrites CLI-reported counts from an earlier done/error in this row. */
export function setSessionUsageInflight(
  db: Database,
  sessionId: string,
  usage: { inputTokens: number; outputTokens: number },
): void {
  db.prepare(
    `UPDATE sessions
     SET input_tokens = ?, output_tokens = ?, tokens_estimated = 1, updated_at = ?
     WHERE id = ? AND (tokens_estimated IS NULL OR tokens_estimated = 1)`,
  ).run(usage.inputTokens, usage.outputTokens, Date.now(), sessionId);
}

export function setSessionUsage(
  db: Database,
  sessionId: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
    contextWindowPct?: number;
    fiveHourPct?: number;
    fiveHourResetsAt?: number;
    sevenDayPct?: number;
    sevenDayResetsAt?: number;
    tokensEstimated?: boolean;
  }
): void {
  db.prepare(
    `UPDATE sessions
     SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?,
         cost_usd = ?, context_window_pct = COALESCE(?, context_window_pct),
         five_hour_pct = ?, five_hour_resets_at = ?,
         seven_day_pct = ?, seven_day_resets_at = ?,
         tokens_estimated = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    usage.inputTokens ?? null,
    usage.outputTokens ?? null,
    usage.cacheReadTokens ?? null,
    usage.cacheCreationTokens ?? null,
    usage.costUsd ?? null,
    usage.contextWindowPct ?? null,
    usage.fiveHourPct ?? null,
    usage.fiveHourResetsAt ?? null,
    usage.sevenDayPct ?? null,
    usage.sevenDayResetsAt ?? null,
    usage.tokensEstimated === undefined ? null : usage.tokensEstimated ? 1 : 0,
    Date.now(),
    sessionId
  );
}

/**
 * On boot: find any session whose last status event is still "running" (i.e. the
 * server was killed mid-session) and write a terminal error event so clients that
 * re-fetch the transcript see a clean final state instead of a stuck spinner.
 */
export function closeStaleSessions(db: Database): void {
  const stale = db.prepare<[], { session_id: string; agent_model_id: string | null }>(
    `SELECT e.session_id,
            s.agent_model_id
     FROM   events e
     JOIN   sessions s ON s.id = e.session_id
     WHERE  e.type    = 'status'
       AND  json_extract(e.payload, '$.status') = 'running'
       AND  NOT EXISTS (
              SELECT 1 FROM events e2
              WHERE  e2.session_id = e.session_id
                AND  e2.type       = 'status'
                AND  json_extract(e2.payload, '$.status') IN ('done', 'error', 'idle')
              )
     GROUP BY e.session_id`
  ).all();

  if (stale.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO events (id, session_id, type, payload, sender, agent_model_id, seq, ts)
     VALUES (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
             substr(hex(randomblob(2)),2) || '-' ||
             substr('89ab',abs(random()) % 4 + 1, 1) ||
             substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
            ?, 'status', '{"status":"error","message":"Session interrupted by server restart"}',
            'system', ?, 0, ?)`
  );

  const now = Date.now();
  const tx = db.transaction(() => {
    for (const row of stale) insert.run(row.session_id, row.agent_model_id, now);
  });
  tx();
  console.log(`[Tierwyn] closed ${stale.length} stale session(s) from previous run`);
}

export function getConversationUsage(
  db: Database,
  conversationId: string,
  opts?: { contextWindowSize?: number; agentId?: string },
): ConversationUsage {
  const aggRow = db.prepare(
    `SELECT
       COUNT(*)                          AS session_count,
       COALESCE(SUM(input_tokens), 0)   AS input_tokens,
       COALESCE(SUM(output_tokens), 0)  AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
       COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
       COALESCE(SUM(cost_usd), 0)       AS cost_usd
     FROM sessions
     WHERE conversation_id = ?`
  ).get(conversationId) as {
    session_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
  };

  // Rate limits and context window % come from different sessions — a recent
  // turn may capture allowance without context (unknown model window size) or
  // vice versa. Fetch each field from the most recent session where it was set.
  // When agentId is set, only seed from that agent — otherwise switching from
  // Antigravity/Claude (5h windows) into Grok (weekly-only) leaks a fake 5h bar.
  const agentClause = opts?.agentId ? ' AND agent_id = ?' : '';
  const agentArgs = opts?.agentId ? [opts.agentId] : [];

  const lastCtxRow = db.prepare(
    `SELECT context_window_pct, input_tokens, cache_read_tokens, cache_creation_tokens
     FROM sessions
     WHERE conversation_id = ? AND context_window_pct IS NOT NULL${agentClause}
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
  ).get(conversationId, ...agentArgs) as {
    context_window_pct: number;
    input_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
  } | undefined;

  const lastRlRow = db.prepare(
    `SELECT five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at
     FROM sessions
     WHERE conversation_id = ?
       AND (five_hour_pct IS NOT NULL
            OR five_hour_resets_at IS NOT NULL
            OR seven_day_pct IS NOT NULL
            OR seven_day_resets_at IS NOT NULL)${agentClause}
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
  ).get(conversationId, ...agentArgs) as {
    five_hour_pct: number | null;
    five_hour_resets_at: number | null;
    seven_day_pct: number | null;
    seven_day_resets_at: number | null;
  } | undefined;

  const lastTokenRow = db.prepare(
    `SELECT input_tokens, cache_read_tokens, cache_creation_tokens
     FROM sessions
     WHERE conversation_id = ?
       AND (input_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_creation_tokens IS NOT NULL)${agentClause}
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
  ).get(conversationId, ...agentArgs) as {
    input_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
  } | undefined;

  const lastUsageRow = db.prepare(
    `SELECT tokens_estimated
     FROM sessions
     WHERE conversation_id = ?
       AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)${agentClause}
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`
  ).get(conversationId, ...agentArgs) as { tokens_estimated: number | null } | undefined;

  const cacheReadTokens = aggRow.cache_read_tokens;
  const cacheCreationTokens = aggRow.cache_creation_tokens;
  const inputTokens = aggRow.input_tokens; // uncached portion only (Anthropic's input_tokens)
  const totalInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const uncachedInputTokens = inputTokens;
  const cachedRatio = totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : 0;

  let contextWindowPct = lastCtxRow?.context_window_pct ?? undefined;
  // Backfill when turns persisted token counts but omitted context % (e.g. the
  // active model was absent from agent-profiles.json so the adapter could not
  // resolve a window size at turn end).
  if (contextWindowPct === undefined && opts?.contextWindowSize && lastTokenRow) {
    const pct = computeContextWindowPct(
      contextWindowOccupancy({
        inputTokens: lastTokenRow.input_tokens ?? undefined,
        cacheReadTokens: lastTokenRow.cache_read_tokens ?? undefined,
        cacheCreationTokens: lastTokenRow.cache_creation_tokens ?? undefined,
      }),
      opts.contextWindowSize,
    );
    if (pct !== undefined) contextWindowPct = pct;
  }

  return {
    inputTokens,
    totalInputTokens,
    outputTokens: aggRow.output_tokens,
    cacheReadTokens,
    cacheCreationTokens,
    uncachedInputTokens,
    cachedRatio,
    costUsd: aggRow.cost_usd,
    isCached: cacheReadTokens > 0,
    sessionCount: aggRow.session_count,
    contextWindowPct,
    fiveHourPct: lastRlRow?.five_hour_pct ?? undefined,
    fiveHourResetsAt: lastRlRow?.five_hour_resets_at ?? undefined,
    sevenDayPct: lastRlRow?.seven_day_pct ?? undefined,
    sevenDayResetsAt: lastRlRow?.seven_day_resets_at ?? undefined,
    tokensEstimated: lastUsageRow?.tokens_estimated === 1 ? true : undefined,
  };
}

/** A parsed Claude Code statusLine JSON object, or null when its file is absent. */
export type StatusLinePayload = Record<string, unknown> | null;

/** Overlays live Claude Code statusLine telemetry onto a ConversationUsage.
 *  Pure (no I/O) so it can be unit-tested independently of the filesystem.
 *
 *  - rate_limits are account-wide and a pure fallback here: the freshest source
 *    is the in-band SDK /usage data already on `usage` (set by getConversationUsage
 *    from the session row). These files only fill windows that in-band left
 *    undefined — `perSession` (Tierwyn SDK statusLine) first, then `global` (TUI).
 *    Neither ever overwrites a live in-band value.
 *  - context_window is session-scoped: ONLY `perSession` describes this
 *    conversation's window. The global file reflects a different (TUI) session,
 *    so it must never be used for context %. The live value always overrides
 *    any persisted estimate (the persisted value is a turn-end snapshot).
 *
 *  This is what makes the usage panel's refresh meaningful and prevents the
 *  stale/bogus context % that used to mask the real value. */
export function applyStatusLineUsage(
  usage: ConversationUsage,
  sources: { perSession: StatusLinePayload; global: StatusLinePayload },
): void {
  type RLWindow = { used_percentage?: number; resets_at?: number | string };
  type RL = Record<string, RLWindow> | undefined;
  const perRL = sources.perSession?.rate_limits as RL;
  const globalRL = sources.global?.rate_limits as RL;
  // Per-window fallback: prefer per-session for each window independently so
  // that a per-session file with only five_hour still lets the global file
  // supply seven_day (the SDK does not always emit both rate_limit_events).
  const fiveHour = perRL?.five_hour ?? globalRL?.five_hour;
  const sevenDay = perRL?.seven_day ?? globalRL?.seven_day;
  // Fallback only: in-band data (from the SDK /usage control request, stored on
  // the session row) is the freshest source. Apply the statusLine file solely to
  // fill windows the in-band path left undefined — never overwrite a live value
  // with a possibly-stale TUI-written number.
  if (usage.fiveHourPct === undefined && fiveHour?.used_percentage !== undefined) usage.fiveHourPct = fiveHour.used_percentage;
  if (usage.sevenDayPct === undefined && sevenDay?.used_percentage !== undefined) usage.sevenDayPct = sevenDay.used_percentage;
  if (usage.fiveHourResetsAt === undefined && fiveHour?.resets_at !== undefined) {
    const raw = fiveHour.resets_at;
    // resets_at is seconds (number) or ISO string -> normalise to epoch ms.
    usage.fiveHourResetsAt = typeof raw === 'number' ? raw * 1000 : Date.parse(raw);
  }
  if (usage.sevenDayResetsAt === undefined && sevenDay?.resets_at !== undefined) {
    const raw = sevenDay.resets_at;
    usage.sevenDayResetsAt = typeof raw === 'number' ? raw * 1000 : Date.parse(raw);
  }
  const cw = sources.perSession?.context_window as { used_percentage?: number } | undefined;
  if (cw?.used_percentage !== undefined) {
    usage.contextWindowPct = Math.round(cw.used_percentage);
  }
}

/**
 * Overlay Grok session `signals.json` context telemetry onto ConversationUsage.
 * Pure (no I/O) — mirror of applyStatusLineUsage for grok-build.
 *
 * Grok's durable per-session file (same source /session-info uses) is more
 * authoritative than the last-turn ACP occupancy snapshot, especially after
 * resume when no new turn has completed yet. Always overrides a present
 * contextWindowPct (stale turn-end value) when signals carry a number.
 */
export function applyGrokSignalsUsage(
  usage: ConversationUsage,
  signals: {
    contextWindowUsage?: number;
    contextTokensUsed?: number;
    contextWindowTokens?: number;
  } | null,
): void {
  if (!signals) return;
  if (typeof signals.contextWindowUsage === 'number' && Number.isFinite(signals.contextWindowUsage)) {
    usage.contextWindowPct = Math.min(100, Math.max(0, Math.round(signals.contextWindowUsage)));
  } else if (
    typeof signals.contextTokensUsed === 'number'
    && typeof signals.contextWindowTokens === 'number'
    && signals.contextWindowTokens > 0
    && Number.isFinite(signals.contextTokensUsed)
  ) {
    usage.contextWindowPct = Math.min(
      100,
      Math.max(0, Math.round((signals.contextTokensUsed / signals.contextWindowTokens) * 100)),
    );
  }
  // Prefer Grok's real window size over the catalogue profile when present.
  if (typeof signals.contextWindowTokens === 'number' && signals.contextWindowTokens > 0) {
    usage.contextWindowSize = Math.round(signals.contextWindowTokens);
  }
}

/**
 * Overlay in-memory adapter occupancy onto ConversationUsage while a session
 * is still running. Overrides stale turn-end / file values when the adapter
 * has captured assistant-step usage this turn.
 */
export function applyLiveAdapterContextUsage(
  usage: ConversationUsage,
  live: { contextWindowPct?: number; contextWindowSize?: number },
): void {
  if (typeof live.contextWindowPct === 'number' && Number.isFinite(live.contextWindowPct)) {
    usage.contextWindowPct = Math.min(100, Math.max(0, Math.round(live.contextWindowPct)));
  }
  if (typeof live.contextWindowSize === 'number' && live.contextWindowSize > 0) {
    usage.contextWindowSize = Math.round(live.contextWindowSize);
  }
}

