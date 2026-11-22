import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import type { SummariesListResponse } from '@tierwyn/shared';
import { getConversation, getRootAncestor, listDescendants } from '../repositories/conversations.js';
import { listSummaries, listSummariesForTree } from '../repositories/summaries.js';

/** Mounts GET /conversations/:id/summaries. `getDb` lets tests inject an in-memory DB. */
export function registerSummaryRoutes(app: Express, getDb: () => Database): void {
  app.get('/conversations/:id/summaries', (req, res) => {
    const id = String(req.params.id);
    const tree = req.query.tree === '1';
    if (tree) {
      // Tree mode (semantics A): whole tree under the root ancestor, regardless
      // of which node the user is viewing. Resolve the root once, fetch the full
      // descendant set, and return both summaries and a minimal {id,title} map
      // so the modal can label each row's source conversation.
      const rootId = getRootAncestor(getDb(), id);
      const summaries = listSummariesForTree(getDb(), rootId);
      const rootConv = getConversation(getDb(), rootId);
      const conversations: { id: string; title: string }[] = [];
      if (rootConv) conversations.push({ id: rootConv.id, title: rootConv.title });
      for (const c of listDescendants(getDb(), rootId)) {
        conversations.push({ id: c.id, title: c.title });
      }
      const body: SummariesListResponse = { summaries, conversations };
      res.json(body);
      return;
    }
    // Default path — byte-for-byte unchanged for backward compat.
    const body: SummariesListResponse = { summaries: listSummaries(getDb(), id) };
    res.json(body);
  });
}
