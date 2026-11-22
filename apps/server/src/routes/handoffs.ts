import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { listHandoffs } from '../repositories/handoffs.js';

/** Mounts GET /conversations/:id/handoffs. `getDb` lets tests inject an in-memory DB. */
export function registerHandoffRoutes(app: Express, getDb: () => Database): void {
  app.get('/conversations/:id/handoffs', (req, res) => {
    res.json({ handoffs: listHandoffs(getDb(), req.params.id) });
  });
}
