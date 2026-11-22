import type { Express } from 'express';
import {
  performScheduleDelete,
  performScheduleArchive,
  performScheduleUnarchive,
  performScheduleEnable,
  performScheduleDisable,
  type ScheduleRouteDeps,
} from './schedules.js';

const MAX_BULK_IDS = 50;

const SCHEDULE_BULK_ACTIONS = ['delete', 'archive', 'unarchive', 'enable', 'disable'] as const;
export type ScheduleBulkAction = typeof SCHEDULE_BULK_ACTIONS[number];

export interface ScheduleBulkResult { id: string; ok: boolean; error?: string; skipped?: string }
export interface ScheduleBulkResponse {
  results: ScheduleBulkResult[];
  deletedConversationIds?: string[];
  deletedIds?: string[];
}

/**
 * FW-18 extension — one gesture, N schedules.
 * Loops single-id repo helpers and reports per-id results { id, ok, error?, skipped? }.
 * Cookie auth only (inherited from requireAuth).
 */
export function registerScheduleBulkRoutes(app: Express, deps: ScheduleRouteDeps): void {
  app.post('/schedules/bulk', async (req, res) => {
    const body = (req.body ?? {}) as { action?: unknown; ids?: unknown };

    const action = body.action;
    if (typeof action !== 'string' || !(SCHEDULE_BULK_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ error: `action must be one of: ${SCHEDULE_BULK_ACTIONS.join(', ')}` });
      return;
    }

    const rawIds = body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0
        || rawIds.some((x) => typeof x !== 'string' || x.length === 0)) {
      res.status(400).json({ error: 'ids (non-empty string[]) required' });
      return;
    }
    if (rawIds.length > MAX_BULK_IDS) {
      res.status(400).json({ error: `too many ids (max ${MAX_BULK_IDS})` });
      return;
    }
    const ids = [...new Set(rawIds as string[])];

    const results: ScheduleBulkResult[] = [];
    const deletedConversationIds: string[] = [];

    for (const id of ids) {
      if (action === 'delete') {
        const out = await performScheduleDelete(deps, id);
        if (!out.ok) {
          results.push({ id, ok: false, error: out.error });
        } else {
          for (const d of out.deletedConversationIds) {
            if (!deletedConversationIds.includes(d)) deletedConversationIds.push(d);
          }
          results.push({ id, ok: true });
        }
        continue;
      }

      if (action === 'archive') {
        const out = performScheduleArchive(deps, id);
        results.push(out.ok ? { id, ok: true } : { id, ok: false, error: out.error });
        continue;
      }

      if (action === 'unarchive') {
        const out = performScheduleUnarchive(deps, id);
        results.push(out.ok ? { id, ok: true } : { id, ok: false, error: out.error });
        continue;
      }

      if (action === 'enable') {
        const out = performScheduleEnable(deps, id);
        results.push(out.ok ? { id, ok: true } : { id, ok: false, error: out.error });
        continue;
      }

      if (action === 'disable') {
        const out = performScheduleDisable(deps, id);
        results.push(out.ok ? { id, ok: true } : { id, ok: false, error: out.error });
        continue;
      }
    }

    const payload: ScheduleBulkResponse = {
      results,
      ...(action === 'delete' ? { deletedConversationIds, deletedIds: deletedConversationIds } : {}),
    };
    res.json(payload);
  });
}
