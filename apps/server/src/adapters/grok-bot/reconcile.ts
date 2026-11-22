/**
 * Roster → Remote Agents container. Runs inside the watcher tick after
 * readRosterRows; no CDP of its own. Never writes a status event.
 */
import type { Database } from 'better-sqlite3';
import type { ServerFrame } from '@tierwyn/shared';
import { BOT_ID_RE, rosterModelDescriptors, type RosterRow } from './bridge.js';
import { upsertDiscoveredModels } from '../../repositories/models.js';
import {
  findRemoteAgentConversation, createRemoteAgentConversation,
  listRemoteAgentConversations, retireRemoteAgentConversation,
} from '../../repositories/remoteAgents.js';
import { ensureWatcherSession, type Cursor } from '../../repositories/grokBotWatch.js';
import { appendEvent } from '../../repositories/events.js';
import { getConversation, renameConversation } from '../../repositories/conversations.js';

export interface ReconcileDeps {
  db: Database;
  autoCreateEnabled: () => boolean;
  onCatalogueChanged: () => void;
  isLive: (conversationId: string) => boolean;
  broadcast: (conversationId: string, frame: ServerFrame) => void;
  cursors: Record<string, Cursor>;
  now: () => number;
  /** Replica entries to replay into a newly auto-created conversation. 0 = start from now. */
  backfillEntries?: () => number;
}

let lastFingerprint = '';
const reappearedLogged = new Set<string>();

export function resetReconcileState(): void {
  lastFingerprint = '';
  reappearedLogged.clear();
}

function fingerprint(bots: RosterRow[]): string {
  return bots
    .map((b) => `${b.id}\0${b.name ?? ''}`)
    .sort()
    .join('\n');
}

export function reconcileRoster(deps: ReconcileDeps, rows: RosterRow[]): boolean {
  const bots = rows.filter((r) => typeof r.id === 'string' && BOT_ID_RE.test(r.id));
  // ponytail: single all-or-nothing JSON slice, so an empty read is the only
  //           partial-read shape worth guarding. Add an N-consecutive-absence
  //           debounce if a partially-populated roster is ever seen.
  if (bots.length === 0) return false;

  const fp = fingerprint(bots);
  if (fp !== lastFingerprint) {
    upsertDiscoveredModels(deps.db, 'grok-bot', rosterModelDescriptors(bots));
    deps.onCatalogueChanged();
    lastFingerprint = fp;
  }

  const now = deps.now();
  let dirty = false;
  const autoCreate = deps.autoCreateEnabled();

  for (const bot of bots) {
    const botName = (bot.name?.trim() || bot.id);
    const conv = findRemoteAgentConversation(deps.db, bot.id);
    if (!conv) {
      if (!autoCreate) continue;
      createRemoteAgentConversation(deps.db, bot.id, botName);
      const K = Math.max(0, Math.min(2000, Math.floor(deps.backfillEntries?.() ?? 200)));
      const cursor = deps.cursors[bot.id] ?? {
        entryId: K > 0 ? '' : (bot.newestEntryId ?? ''),
        seq: 0,
        updatedAt: now,
      };
      cursor.name = botName;
      cursor.seq = 0;
      if (K > 0) {
        cursor.entryId = '';
        cursor.backfill = K;
      } else {
        if (!cursor.entryId && bot.newestEntryId) cursor.entryId = bot.newestEntryId;
        delete cursor.backfill;
      }
      cursor.updatedAt = now;
      deps.cursors[bot.id] = cursor;
      dirty = true;
      continue;
    }
    if (conv.archived) {
      if (!reappearedLogged.has(bot.id)) {
        reappearedLogged.add(bot.id);
        console.warn(
          `[grok-bot] bot ${bot.id} reappeared in roster; conversation stays archived`,
        );
      }
      continue;
    }
    if (maybeRename(deps, conv.id, bot.id, botName, now)) dirty = true;
  }

  const botIds = new Set(bots.map((b) => b.id));
  for (const conv of listRemoteAgentConversations(deps.db, { archived: false })) {
    if (botIds.has(conv.botId)) continue;
    if (deps.isLive(conv.id)) continue;
    retireRemoteAgentConversation(deps.db, conv.id);
    const sessionId = ensureWatcherSession(
      deps.db, conv.id, conv.botId, `grok-bot:${conv.botId}`,
    );
    const cursor = deps.cursors[conv.botId] ?? { entryId: '', seq: 0, updatedAt: now };
    cursor.seq += 1;
    cursor.updatedAt = now;
    deps.cursors[conv.botId] = cursor;
    appendEvent(deps.db, {
      sessionId,
      type: 'message',
      sender: 'system',
      seq: cursor.seq,
      ts: now,
      payload: { chunk: '_This Bot was removed from the Grok Bot roster._', final: true },
    });
    deps.broadcast(conv.id, {
      type: 'conversation_updated',
      conversationId: conv.id,
      ts: now,
      archived: true,
    });
    dirty = true;
  }
  return dirty;
}

function maybeRename(
  deps: ReconcileDeps,
  conversationId: string,
  botId: string,
  botName: string,
  now: number,
): boolean {
  // ponytail: title provenance rides the cursor blob. Promote to a title_source
  //           column if a cursor wipe ever loses renames people cared about.
  const conv = getConversation(deps.db, conversationId);
  const cursor = deps.cursors[botId];
  if (!conv || !cursor) return false;
  let dirty = false;
  if (cursor.name === undefined) {
    cursor.name = conv.title === botName ? botName : conv.title;
    cursor.updatedAt = now;
    dirty = true;
  }
  if (cursor.name !== undefined && conv.title === cursor.name && conv.title !== botName) {
    renameConversation(deps.db, conversationId, botName);
    cursor.name = botName;
    cursor.updatedAt = now;
    deps.broadcast(conversationId, {
      type: 'conversation_updated',
      conversationId,
      ts: now,
      title: botName,
    });
    return true;
  }
  return dirty;
}
