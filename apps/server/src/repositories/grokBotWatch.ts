/**
 * Watched-Bot set, synthetic watcher sessions, and durable replica cursors.
 * Phase 1 stores cursors in the existing settings blob — no migration.
 *
 * ponytail: one JSON blob under a settings key. Bounded by the roster (tens of Bots).
 *           Promote to a real table if this ever exceeds ~1k rows or gains a second writer.
 */
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { createSession, setNativeSessionId } from './sessions.js';
import { REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';

const CURSOR_KEY = 'grokbot.watch.cursors';

/** Roster ids are UUIDs; the seeded `default` profile means "whatever chat is open". */
const BOT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface WatchedBot {
  conversationId: string;
  botId: string;
  agentModelId: string | null;
}

/** How long the last conversation to talk with a Bot keeps its replies. */
export const DEFAULT_REPLY_LEASE_MS = 3_600_000;

export interface Cursor {
  entryId: string;
  seq: number;
  updatedAt: number;
  /** Last Bot name we wrote as the conversation title. Optional so pre-Phase-2
   *  blobs still parse. A missing name is armed from the current title on the
   *  next reconcile tick (then a Bot rename can follow). */
  name?: string;
  /** When set, the next watcher ingest replays the last N replica entries
   *  (historical timestamps, no notification) then clears this field.
   *  Optional so pre-parity blobs still parse. */
  backfill?: number;
}

interface CandidateRow {
  conversation_id: string;
  bot_id: string;
  agent_model_id: string | null;
  created_at: number;
  container: number;
  last_prompt_at: number | null;
  last_activity_at: number | null;
}

/**
 * One owner conversation per Bot UUID. The newest conversation that *prompted* the
 * Bot owns it while its last non-system activity is within `leaseMs`; then the
 * Remote Agents container takes over; with no container the newest asker keeps it.
 * Inbound replies route to the active owner conversation, falling back to the
 * Remote Agents container or the newest prompting conversation.
 *
 * ponytail: one grouped scan of grok-bot sessions plus idx_events_session probes per
 *           tick. Fine for thousands of sessions; add a (bot, conversation) activity
 *           table if this ever shows up in a profile.
 */
export function listWatchedBots(
  db: Database,
  opts: { now: number; leaseMs: number },
): WatchedBot[] {
  const rows = db.prepare(
    `SELECT s.conversation_id AS conversation_id,
            s.native_session_id AS bot_id,
            (SELECT s3.agent_model_id FROM sessions s3
              WHERE s3.conversation_id = s.conversation_id
                AND s3.native_session_id = s.native_session_id
              ORDER BY s3.created_at DESC LIMIT 1) AS agent_model_id,
            MAX(s.created_at) AS created_at,
            MAX(c.project_id = @sys AND c.parent_conversation_id IS NULL
                AND (s.agent_model_id IS NULL OR s.agent_model_id = 'grok-bot:' || s.native_session_id)) AS container,
            (SELECT MAX(e.ts) FROM events e JOIN sessions s2 ON s2.id = e.session_id
              WHERE s2.conversation_id = s.conversation_id
                AND s2.native_session_id = s.native_session_id
                AND e.type = 'prompt') AS last_prompt_at,
            (SELECT MAX(e.ts) FROM events e JOIN sessions s2 ON s2.id = e.session_id
              WHERE s2.conversation_id = s.conversation_id
                AND s2.native_session_id = s.native_session_id
                AND e.sender <> 'system') AS last_activity_at
       FROM sessions s
       JOIN conversations c ON c.id = s.conversation_id
      WHERE s.agent_id = 'grok-bot'
        AND s.native_session_id IS NOT NULL
        AND s.native_session_id <> ''
        AND (c.archived IS NULL OR c.archived = 0)
      GROUP BY s.conversation_id, s.native_session_id`,
  ).all({ sys: REMOTE_AGENTS_PROJECT_ID }) as CandidateRow[];

  const byBot = new Map<string, CandidateRow[]>();
  for (const r of rows) {
    if (!BOT_ID_RE.test(r.bot_id)) continue;
    const list = byBot.get(r.bot_id) ?? [];
    list.push(r);
    byBot.set(r.bot_id, list);
  }

  const newest = (xs: CandidateRow[], key: (r: CandidateRow) => number) =>
    xs.reduce((a, b) => (key(b) > key(a) ? b : a));
  const activity = (r: CandidateRow) => r.last_activity_at ?? 0;

  const out: WatchedBot[] = [];
  for (const [botId, cands] of byBot) {
    const asked = cands.filter((r) => r.last_prompt_at != null);
    const leased = opts.leaseMs > 0
      ? asked.filter((r) => opts.now - activity(r) <= opts.leaseMs)
      : [];
    const containers = cands.filter((r) => r.container === 1);
    const pick = leased.length > 0 ? newest(leased, activity)
      : containers.length > 0 ? newest(containers, (r) => r.created_at)
      : asked.length > 0 ? newest(asked, activity)
      : undefined;
    if (pick) out.push({ conversationId: pick.conversation_id, botId, agentModelId: pick.agent_model_id });
  }
  return out;
}

export function ensureWatcherSession(
  db: Database,
  conversationId: string,
  botId: string,
  agentModelId: string | null,
): string {
  const existing = db.prepare(
    `SELECT s.id AS id
       FROM sessions s
      WHERE s.conversation_id = ?
        AND s.agent_id = 'grok-bot'
        AND s.native_session_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM events e WHERE e.session_id = s.id AND e.type = 'prompt'
        )
      LIMIT 1`,
  ).get(conversationId, botId) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = randomUUID();
  createSession(db, {
    id,
    conversationId,
    agentId: 'grok-bot',
    agentModelId: agentModelId ?? undefined,
  });
  setNativeSessionId(db, id, botId);
  return id;
}

export function readCursors(db: Database): Record<string, Cursor> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CURSOR_KEY) as
    | { value: string }
    | undefined;
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, Cursor> = {};
    for (const [botId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const c = raw as {
        entryId?: unknown; seq?: unknown; updatedAt?: unknown; name?: unknown; backfill?: unknown;
      };
      if (typeof c.entryId !== 'string' || typeof c.seq !== 'number' || typeof c.updatedAt !== 'number') {
        continue;
      }
      out[botId] = {
        entryId: c.entryId,
        seq: c.seq,
        updatedAt: c.updatedAt,
        name: typeof c.name === 'string' ? c.name : undefined,
        backfill: typeof c.backfill === 'number' && Number.isInteger(c.backfill) && c.backfill > 0
          ? c.backfill
          : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeCursors(db: Database, cursors: Record<string, Cursor>): void {
  persistCursors(db, { ...readCursors(db), ...cursors });
}

/** Full-map replace. Use when keys must be deleted (prune). */
export function replaceCursors(db: Database, cursors: Record<string, Cursor>): void {
  persistCursors(db, cursors);
}

function persistCursors(db: Database, cursors: Record<string, Cursor>): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    CURSOR_KEY,
    JSON.stringify(cursors),
  );
}
