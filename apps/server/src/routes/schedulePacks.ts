import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { validateSchedulePack } from '@tierwyn/shared';
import {
  listPacks, getPack, upsertImportedPack, deletePack,
} from '../repositories/schedulePacks.js';

export function registerSchedulePackRoutes(app: Express, getDb: () => Database): void {
  app.get('/schedule-packs', (_req, res) => {
    res.json({ packs: listPacks(getDb()) });
  });

  app.post('/schedule-packs', (req, res) => {
    const parsed = validateSchedulePack(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const db = getDb();
    const existing = getPack(db, parsed.pack.slug);
    if (existing?.origin === 'shipped') {
      res.status(409).json({ error: 'slug belongs to a shipped pack' });
      return;
    }
    const pack = upsertImportedPack(db, parsed.pack);
    res.status(201).json({ pack });
  });

  app.delete('/schedule-packs/:slug', (req, res) => {
    const result = deletePack(getDb(), req.params.slug);
    if (result === 'not_found') {
      res.status(404).json({ error: 'no such pack' });
      return;
    }
    if (result === 'shipped') {
      res.status(403).json({ error: 'cannot delete a shipped pack' });
      return;
    }
    res.status(204).end();
  });
}
