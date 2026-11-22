import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import type { GrokBotSupervisor } from '../adapters/grok-bot/supervisor.js';
import type { CdpLike } from '../adapters/grok-bot/cdp.js';
import type { RosterRow } from '../adapters/grok-bot/bridge.js';
import { createAgent as defaultCreateAgent } from '../adapters/grok-bot/inject.js';
import { readRosterRows, rosterModelDescriptors } from '../adapters/grok-bot/bridge.js';
import { upsertDiscoveredModels } from '../repositories/models.js';
import {
  findRemoteAgentConversation, createRemoteAgentConversation,
} from '../repositories/remoteAgents.js';
import { getConversation } from '../repositories/conversations.js';
import { getGeneralSettings } from '../repositories/settings.js';
import { readCursors, writeCursors } from '../repositories/grokBotWatch.js';

export const GROK_BOT_TITLE_MAX = 120;

/** Module-level create lock — one CDP create at a time per process. */
let createInFlight = false;

/** Test-only: clear the in-flight lock between cases. */
export function resetGrokBotCreateLockForTests(): void {
  createInFlight = false;
}

/** Insert/refresh one Bot model row without pruning peers (roster-read failure path). */
function ensureGrokBotModelRow(db: Database, botId: string, title: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, context_window, source, created_at)
     VALUES (@id, 'grok-bot', @model_name, @label, 'xai', 0, 1, 1, '', NULL, 'discovered', @now)
     ON CONFLICT(agent_id, model_name) DO UPDATE SET
       label = excluded.label,
       provider = excluded.provider`,
  ).run({
    id: `grok-bot:${botId}`,
    model_name: botId,
    label: `Grok Bot · ${title}`,
    now,
  });
}

export interface GrokBotRouteDeps {
  getDb?: () => Database;
  getClient?: () => Promise<CdpLike>;
  createAgent?: (client: CdpLike, name: string) => Promise<string | null>;
  readRoster?: (client: CdpLike) => Promise<RosterRow[]>;
  onCatalogueChanged?: () => void;
  /** Kick the inbound watcher so create ingest does not wait for the interval. */
  tickNow?: () => Promise<void>;
}

export function registerGrokBotRoutes(
  app: Express,
  supervisor: GrokBotSupervisor,
  deps: GrokBotRouteDeps = {},
): void {
  app.get('/grok-bot/status', async (_req: Request, res: Response) => {
    try {
      const status = await supervisor.probeIfStale();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'status failed' });
    }
  });

  app.post('/grok-bot/start', (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const extra = Object.keys(body).filter((k) => k !== 'reason');
    if (extra.length > 0) {
      res.status(400).json({ error: 'command/path fields are not accepted' });
      return;
    }
    const reason = body.reason;
    if (reason !== 'manual' && reason !== 'on-demand') {
      res.status(400).json({ error: 'reason must be manual or on-demand' });
      return;
    }
    const snap = supervisor.status();
    if (!snap.enabled || snap.state === 'disabled') {
      res.status(409).json({ error: 'Grok Bot is disabled', status: snap });
      return;
    }
    void supervisor.ensureRunning(reason);
    res.status(202).json(supervisor.status());
  });

  app.post('/grok-bot/bots', async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const raw = typeof body.title === 'string' ? body.title : '';
    const title = raw.trim();
    if (!title) {
      res.status(400).json({ error: 'title required' });
      return;
    }
    if (title.length > GROK_BOT_TITLE_MAX) {
      res.status(400).json({ error: `title must be ${GROK_BOT_TITLE_MAX} characters or fewer` });
      return;
    }
    const snap = supervisor.status();
    if (!snap.enabled || snap.state === 'disabled') {
      res.status(409).json({ error: 'Grok Bot is disabled', status: snap });
      return;
    }
    const getDb = deps.getDb;
    const getClient = deps.getClient;
    if (!getDb || !getClient) {
      res.status(500).json({ error: 'Grok Bot create is not configured' });
      return;
    }
    if (createInFlight) {
      res.status(409).json({ error: 'create already in progress' });
      return;
    }
    createInFlight = true;
    try {
      await supervisor.ensureRunning('manual');
      const client = await getClient();
      const create = deps.createAgent ?? defaultCreateAgent;
      const botId = await create(client, title);
      if (!botId) {
        res.status(502).json({ error: 'Grok Bot app did not create the Bot' });
        return;
      }
      const readRoster = deps.readRoster ?? readRosterRows;
      let rosterOk = false;
      let roster: RosterRow[] = [];
      try {
        roster = await readRoster(client);
        rosterOk = roster.some((r) => r.id === botId);
      } catch {
        rosterOk = false;
      }
      const db = getDb();
      // Full roster upsert only when the read succeeded and includes the new Bot.
      // A single-bot fallback would disable every other in-use Bot via prune.
      if (rosterOk) {
        upsertDiscoveredModels(db, 'grok-bot', rosterModelDescriptors(roster));
        deps.onCatalogueChanged?.();
      } else {
        ensureGrokBotModelRow(db, botId, title);
        deps.onCatalogueChanged?.();
      }
      const existing = findRemoteAgentConversation(db, botId);
      if (existing) {
        const conversation = getConversation(db, existing.id);
        if (!conversation) {
          res.status(500).json({ error: 'conversation lookup failed' });
          return;
        }
        res.status(200).json({ conversation });
        return;
      }
      const id = createRemoteAgentConversation(db, botId, title);
      const conversation = getConversation(db, id);
      if (!conversation) {
        res.status(500).json({ error: 'conversation lookup failed' });
        return;
      }
      const newest = roster.find((r) => r.id === botId)?.newestEntryId ?? '';
      const K = Math.max(0, Math.min(2000, Math.floor(getGeneralSettings(db).grokBotBackfillEntries ?? 200)));
      const now = Date.now();
      const cursors = readCursors(db);
      cursors[botId] = {
        entryId: K > 0 ? '' : (newest || ''),
        seq: 0,
        updatedAt: now,
        name: title,
        ...(K > 0 ? { backfill: K } : {}),
      };
      writeCursors(db, cursors);
      void deps.tickNow?.();
      res.status(201).json({ conversation });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'create failed';
      res.status(502).json({ error: msg });
    } finally {
      createInFlight = false;
    }
  });
}
