import type { Express } from 'express';
import { getConversation, setConversationPinned, setConversationArchived } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import {
  performConversationDelete, performConversationMove, type ConversationRouteDeps,
} from './conversations.js';

/** One sidebar page of work. The loop is synchronous per id, so an unbounded
 *  batch would hold the event loop; 50 keeps the worst case in the tens of ms.
 *  ponytail: raise it when an operator actually hits the wall. */
const MAX_BULK_IDS = 50;

const ACTIONS = ['delete', 'move', 'pin', 'unpin', 'archive', 'unarchive'] as const;
export type BulkAction = typeof ACTIONS[number];

/** `ok:false` = the operation was refused for this id (error is the same string
 *  the single-id route returns). `ok:true` + `skipped` = nothing to do and that
 *  is fine (a spawn child on pin, a row already removed by a parent cascade). */
export interface BulkResult { id: string; ok: boolean; error?: string; skipped?: string }
export interface BulkResponse { results: BulkResult[]; deletedIds?: string[] }

/**
 * FW-18 — one gesture, N conversations. Deliberately NOT a `WHERE id IN (…)`
 * bulk statement: per-id results are the whole point, so a missing or busy row
 * is reported instead of aborting the batch. Every id goes through the same
 * helpers the single-id routes use, so guards and the native/TTS unlink cannot
 * drift (D9).
 *
 * Cookie auth only — inherited from the global requireAuth in index.ts. Do not
 * add bearer/spawn-token access here.
 */
export function registerConversationBulkRoutes(app: Express, deps: ConversationRouteDeps): void {
  app.post('/conversations/bulk', async (req, res) => {
    const body = (req.body ?? {}) as { action?: unknown; ids?: unknown; projectId?: unknown };

    // Action first: a typo'd action must never do work.
    const action = body.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ error: `action must be one of: ${ACTIONS.join(', ')}` });
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
    // ponytail: dedupe so a double-checked row is one unit of work and one result.
    const ids = [...new Set(rawIds as string[])];

    const db = deps.getDb();

    // Destination is validated once, not per id — a bad target is a bad request,
    // not 50 identical per-id failures.
    let targetProjectId = '';
    if (action === 'move') {
      targetProjectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
      if (!targetProjectId) {
        res.status(400).json({ error: 'projectId (non-empty string) required for move' });
        return;
      }
      if (!getProject(db, targetProjectId)) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
    }

    const results: BulkResult[] = [];
    const deletedIds: string[] = [];
    // Rows removed by an earlier id's cascade. Reporting 404 for those would be
    // a lie — they are gone, which is what the caller asked for (D8).
    const gone = new Set<string>();

    for (const id of ids) {
      if (action === 'delete') {
        if (gone.has(id)) { results.push({ id, ok: true, skipped: 'already deleted' }); continue; }
        const out = await performConversationDelete(deps, id);
        if (!out.ok) { results.push({ id, ok: false, error: out.error }); continue; }
        for (const d of out.deletedIds) {
          if (!gone.has(d)) { gone.add(d); deletedIds.push(d); }
        }
        results.push({ id, ok: true });
        continue;
      }

      if (action === 'move') {
        const out = performConversationMove(deps, id, targetProjectId);
        results.push(out.ok ? { id, ok: true } : { id, ok: false, error: out.error });
        continue;
      }

      // pin / unpin / archive / unarchive — intentionally NOT shared with
      // PATCH: a spawn child is a 400 there and a silent skip here
      // (operator decision, FW-18 D12).
      const existing = getConversation(db, id);
      if (!existing) { results.push({ id, ok: false, error: 'no such conversation' }); continue; }
      if (existing.parentConversationId) {
        results.push({ id, ok: true, skipped: 'not a root' });
        continue;
      }
      if (action === 'archive' || action === 'unarchive') {
        setConversationArchived(db, id, action === 'archive');
      } else {
        setConversationPinned(db, id, action === 'pin');
      }
      results.push({ id, ok: true });
    }

    const payload: BulkResponse = {
      results,
      ...(action === 'delete' ? { deletedIds } : {}),
    };
    res.json(payload);
  });
}
