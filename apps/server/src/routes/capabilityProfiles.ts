import type { Express, Request, Response } from 'express';
import express from 'express';
import type { Database } from 'better-sqlite3';
import type { CapabilityProfile } from '@tierwyn/shared';
import { BUILTIN_CAPABILITY_PROFILES, capabilityProfileFp, validateCapabilityProfileInput } from '@tierwyn/shared';
import {
  getCapabilityProfile,
  listCapabilityProfiles,
  saveCapabilityProfile,
  deleteCapabilityProfile,
  countConversationsUsingProfile,
  listConversationIdsUsingProfile,
  listConversationIdsUsingDefaultProfile,
  getDefaultCapabilityProfileId,
  setDefaultCapabilityProfileId,
} from '../repositories/capabilityProfiles.js';
import { refreshConversationCapabilityTokens, type CapabilityRefreshSessions } from '../spawn/capabilityRefresh.js';

export interface CapabilityProfileDeps {
  getDb: () => Database;
  /** Enabled plugin catalogue — custom profiles may only reference these ids. */
  listPluginIds: () => string[];
  sessionManager?: CapabilityRefreshSessions;
}

function isBuiltinId(id: unknown): boolean {
  return typeof id === 'string' && BUILTIN_CAPABILITY_PROFILES.some((p) => p.id === id);
}

export function registerCapabilityProfileRoutes(app: Express, deps: CapabilityProfileDeps): void {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));

  r.get('/capability-profiles', (_req, res) => {
    const db = deps.getDb();
    res.json({
      profiles: listCapabilityProfiles(db),
      defaultProfileId: getDefaultCapabilityProfileId(db),
    });
  });

  r.post('/capability-profiles/default', async (req: Request, res: Response) => {
    const body = req.body as { id?: unknown } | undefined;
    if (typeof body?.id !== 'string' || !body.id.trim()) {
      res.status(400).json({ error: 'id string required' });
      return;
    }
    const id = body.id.trim();
    const db = deps.getDb();
    const target = getCapabilityProfile(db, id);
    if (!target) {
      res.status(404).json({ error: `unknown capability profile: ${id}` });
      return;
    }
    const previousDefault = getDefaultCapabilityProfileId(db);
    if (previousDefault !== target.id) {
      setDefaultCapabilityProfileId(db, target.id);
      for (const convId of listConversationIdsUsingDefaultProfile(db)) {
        await refreshConversationCapabilityTokens(convId, deps.sessionManager);
      }
    }
    res.json({
      ok: true,
      defaultProfileId: target.id,
      profiles: listCapabilityProfiles(db),
    });
  });

  r.post('/capability-profiles', async (req: Request, res: Response) => {
    const raw = req.body as { id?: unknown } | undefined;
    // Built-in ids are reserved (read-only): 409, not 400 — the payload is
    // well-formed, the target just can't be created/overwritten.
    if (isBuiltinId(raw?.id)) {
      res.status(409).json({ error: `id '${String(raw?.id)}' is a built-in profile` });
      return;
    }
    const parsed = validateCapabilityProfileInput(req.body, deps.listPluginIds());
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const saved: CapabilityProfile = parsed.profile;
    const db = deps.getDb();
    const previous = getCapabilityProfile(db, saved.id);
    const grantChanged = !previous
      || capabilityProfileFp(previous) !== capabilityProfileFp(saved);
    saveCapabilityProfile(db, saved);
    if (grantChanged) {
      const convIds = new Set(listConversationIdsUsingProfile(db, saved.id));
      if (saved.id === getDefaultCapabilityProfileId(db)) {
        for (const defId of listConversationIdsUsingDefaultProfile(db)) {
          convIds.add(defId);
        }
      }
      for (const id of convIds) {
        await refreshConversationCapabilityTokens(id, deps.sessionManager);
      }
    }
    res.status(201).json({
      profile: saved,
      profiles: listCapabilityProfiles(db),
      defaultProfileId: getDefaultCapabilityProfileId(db),
    });
  });

  r.delete('/capability-profiles/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const db = deps.getDb();
    const known = listCapabilityProfiles(db).find((p) => p.id === id);
    if (!known) {
      res.status(404).json({ error: 'unknown capability profile' });
      return;
    }
    if (known.builtin) {
      res.status(409).json({ error: 'built-in profiles cannot be deleted' });
      return;
    }
    if (getDefaultCapabilityProfileId(db) === id) {
      res.status(409).json({ error: 'cannot delete the default capability profile' });
      return;
    }
    const inUse = countConversationsUsingProfile(db, id);
    if (inUse > 0) {
      res.status(409).json({ error: `profile is in use by ${inUse} conversation(s)`, conversations: inUse });
      return;
    }
    deleteCapabilityProfile(db, id);
    res.json({
      profiles: listCapabilityProfiles(db),
      defaultProfileId: getDefaultCapabilityProfileId(db),
    });
  });

  app.use('/settings', r);
}
