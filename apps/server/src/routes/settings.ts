import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import type { DecisionSettings, NotificationSettings } from '@tierwyn/shared';
import { BUILTIN_TAG_CATALOGUE, validateCustomPrompt, validatePromptPack } from '@tierwyn/shared';
import {
  getGeneralSettings, updateGeneralSettings,
  getNotificationSettings, updateNotificationSettings, publicNotificationSettings,
  getDecisionSettings, updateDecisionSettings, publicDecisionSettings,
  getTagCatalogueSettings, setTagCatalogueSettings,
  listCustomPrompts, saveCustomPrompt, deleteCustomPrompt, importCustomPrompts,
} from '../repositories/settings.js';
import { callSystemOne } from '../decide.js';
import { getRetentionStats, type RetentionKickResult } from '../repositories/retention.js';
import {
  listArchiveEntries, restoreArchivedConversation,
  deleteArchiveFile, deleteAllArchiveFiles,
} from '../repositories/archiveRestore.js';

const NOTIFICATION_BOOL_KEYS = [
  'enabled',
  'conversationComplete',
  'scheduleFired',
  'scheduleRunEnded',
  'scheduleDisabled',
  'agentMessage',
] as const satisfies readonly (keyof NotificationSettings)[];

export function registerGeneralSettingsRoutes(app: Express, getDb: () => Database, onGeneralChanged?: () => void): void {
  app.get('/settings/general', (_req, res) => {
    res.json({ settings: getGeneralSettings(getDb()) });
  });

  app.post('/settings/general', (req, res) => {
    try {
      const settings = updateGeneralSettings(getDb(), req.body);
      onGeneralChanged?.();
      res.json({ settings });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid general settings' });
    }
  });

  app.get('/settings/prompts', (_req, res) => {
    res.json({ prompts: listCustomPrompts(getDb()) });
  });

  app.post('/settings/prompts', (req, res) => {
    const result = validateCustomPrompt(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ prompts: saveCustomPrompt(getDb(), result.prompt) });
  });

  app.delete('/settings/prompts/:id', (req, res) => {
    res.json({ prompts: deleteCustomPrompt(getDb(), req.params.id) });
  });

  app.post('/settings/prompts/import', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
      res.status(400).json({ error: 'overwrite must be a boolean' });
      return;
    }
    const result = validatePromptPack(body.pack);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(importCustomPrompts(getDb(), result.pack.prompts, body.overwrite === true));
  });
}

export function registerNotificationSettingsRoutes(app: Express, getDb: () => Database): void {
  app.get('/settings/notifications', (_req, res) => {
    res.json({ settings: publicNotificationSettings(getNotificationSettings(getDb())) });
  });

  app.post('/settings/notifications', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<NotificationSettings> = {};
    for (const key of NOTIFICATION_BOOL_KEYS) {
      if (typeof body[key] === 'boolean') patch[key] = body[key];
    }
    if (typeof body.vapidSubject === 'string') patch.vapidSubject = body.vapidSubject;
    res.json({ settings: publicNotificationSettings(updateNotificationSettings(getDb(), patch)) });
  });
}

/** Jev notification filter. Cookie-only: mount after requireAuth. The key is write-only. */
export function registerDecisionSettingsRoutes(app: Express, getDb: () => Database): void {
  app.get('/settings/decision', (_req, res) => {
    res.json({ settings: publicDecisionSettings(getDecisionSettings(getDb())) });
  });

  app.post('/settings/decision', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<DecisionSettings> = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be a boolean' }); return; }
      patch.enabled = body.enabled;
    }
    if (body.autoTagEnabled !== undefined) {
      if (typeof body.autoTagEnabled !== 'boolean') { res.status(400).json({ error: 'autoTagEnabled must be a boolean' }); return; }
      patch.autoTagEnabled = body.autoTagEnabled;
    }
    if (body.memoryCheckEnabled !== undefined) {
      if (typeof body.memoryCheckEnabled !== 'boolean') { res.status(400).json({ error: 'memoryCheckEnabled must be a boolean' }); return; }
      patch.memoryCheckEnabled = body.memoryCheckEnabled;
    }
    if (body.apiKey !== undefined) {
      if (typeof body.apiKey !== 'string') { res.status(400).json({ error: 'apiKey must be a string' }); return; }
      // Exact '' is the explicit clear (the UI's "Clear key"); whitespace-only is a stray keystroke, not a clear.
      if (body.apiKey === '' || body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
    }
    if (body.model !== undefined) {
      if (typeof body.model !== 'string' || !body.model.trim() || body.model.trim().length > 64) {
        res.status(400).json({ error: 'model must be a non-empty string (max 64 chars)' });
        return;
      }
      patch.model = body.model.trim();
    }
    if (body.baseUrl !== undefined) {
      let url: URL | undefined;
      try { url = typeof body.baseUrl === 'string' ? new URL(body.baseUrl.trim()) : undefined; } catch { /* invalid */ }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
        res.status(400).json({ error: 'baseUrl must be an http(s) URL' });
        return;
      }
      patch.baseUrl = (body.baseUrl as string).trim().replace(/\/+$/, '');
    }
    res.json({ settings: publicDecisionSettings(updateDecisionSettings(getDb(), patch)) });
  });

  // Whole-document catalogue: one validator, two routes (cookie-only, like the rest of Jev).
  app.get('/settings/tag-catalogue', (_req, res) => {
    res.json({ builtins: BUILTIN_TAG_CATALOGUE, catalogue: getTagCatalogueSettings(getDb()) });
  });

  app.post('/settings/tag-catalogue', (req, res) => {
    const r = setTagCatalogueSettings(getDb(), req.body);
    if (!r.ok) { res.status(400).json({ error: r.error }); return; }
    res.json({ builtins: BUILTIN_TAG_CATALOGUE, catalogue: r.catalogue });
  });

  // Server-side probe so the browser never needs the stored key. Ignores `enabled`.
  app.post('/settings/decision/test', async (_req, res) => {
    const s = getDecisionSettings(getDb());
    if (!s.apiKey) { res.status(400).json({ ok: false, error: 'no api key' }); return; }
    const started = Date.now();
    try {
      const r = await callSystemOne(
        s,
        'Tierwyn connectivity test.',
        { ok: { type: 'noul', instructions: 'Is this a connectivity test?' } },
        5000,
      );
      const a = r.answers.ok;
      res.json({ ok: true, model: r.model, latencyMs: r.latencyMs, noul: a?.type === 'noul' ? a.noul : undefined });
    } catch (e) {
      res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'error', latencyMs: Date.now() - started });
    }
  });
}

export function registerRetentionPurgeRoute(
  app: Express,
  opts: {
    getRetentionDays: () => number;
    runNow: () => Promise<RetentionKickResult>;
    getDb: () => Database;
    dataDir: string;
    dbPath: string;
    isPurgeRunning?: () => boolean;
  },
): void {
  app.get('/settings/retention/stats', (_req, res) => {
    res.json(getRetentionStats(opts.getDb(), {
      dbPath: opts.dbPath,
      dataDir: opts.dataDir,
      retentionDays: opts.getRetentionDays(),
      purgeRunning: opts.isPurgeRunning?.() ?? false,
    }));
  });

  app.post('/settings/retention/purge', async (_req, res) => {
    if (opts.getRetentionDays() <= 0) {
      res.status(400).json({ error: 'retention is disabled (set days > 0 first)' });
      return;
    }
    const result = await opts.runNow();
    if (result.alreadyRunning) {
      res.status(409).json({ alreadyRunning: true });
      return;
    }
    const stats = getRetentionStats(opts.getDb(), {
      dbPath: opts.dbPath,
      dataDir: opts.dataDir,
      retentionDays: opts.getRetentionDays(),
      purgeRunning: opts.isPurgeRunning?.() ?? false,
    });
    res.json({
      alreadyRunning: false,
      deleted: result.deletedIds.length,
      eventsDeleted: result.eventsDeleted,
      remaining: result.remaining,
      dbSizeBytes: stats.dbSizeBytes,
      vacuumSkipped: result.vacuumSkipped,
      vacuumFailed: result.vacuumFailed,
    });
  });
}

/**
 * FW-11: browse and restore `data/archive/<id>.jsonl`.
 *
 * Cookie-auth like every other /settings route — no bearer, no token. These
 * routes never serve archive bytes: the list is header metadata only and the
 * restore re-inserts rows. `files.ts` keeps denying `archive/` paths.
 */
export function registerRetentionArchiveRoutes(
  app: Express,
  opts: { getDb: () => Database; dataDir: string },
): void {
  app.get('/settings/retention/archive', (_req, res) => {
    res.json({ items: listArchiveEntries(opts.dataDir) });
  });

  app.delete('/settings/retention/archive', (_req, res) => {
    res.json(deleteAllArchiveFiles(opts.dataDir));
  });

  app.delete('/settings/retention/archive/:id', (req, res) => {
    const out = deleteArchiveFile(opts.dataDir, req.params.id);
    if (out.ok) {
      res.json({ deleted: 1 });
      return;
    }
    res.status(out.code === 'not_found' ? 404 : 400).json({ error: out.message });
  });

  app.post('/settings/retention/archive/:id/restore', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' && body.projectId !== ''
      ? body.projectId
      : undefined;

    const out = restoreArchivedConversation(opts.getDb(), opts.dataDir, req.params.id, { projectId });
    if (out.ok) {
      res.json({
        restored: out.restored,
        projectId: out.projectId,
        eventsRestored: out.eventsRestored,
        parentCleared: out.parentCleared,
      });
      return;
    }
    // A missing target project is a 404 (the client named a thing that is not
    // there); a missing *original* project is a 400 (the client must choose).
    const status =
      out.code === 'not_found' ? 404
        : out.code === 'already_live' ? 409
          : out.code === 'no_project' && projectId ? 404
            : 400;
    res.status(status).json({ error: out.message });
  });
}
