import type { Database } from 'better-sqlite3';
import type { SessionManager } from '../sessionManager.js';
import { listOpenEdges, resolveSpawnEdge } from '../repositories/spawnEdges.js';

// Only notify parents for reasonably fresh interruptions; ancient open rows
// get the transcript marker only (no boot-time notify storm).
const NOTIFY_MAX_AGE_MS = 24 * 60 * 60_000;

/** Boot-time reconciliation of spawn edges orphaned by a restart. Children are
 *  subprocesses of this server, so any edge still 'open' at boot references a
 *  dead child turn. 🔒 SECURITY (threat-model concern 6): this pass emits
 *  server-authored text only — it never replays stored child prose and never
 *  starts child sessions, so a forged edge row cannot inject content or spawn
 *  work. CAS transition makes it idempotent across double-boots (concern 7). */
export function reconcileSpawnEdges(db: Database, sessionManager: SessionManager): number {
  const open = listOpenEdges(db);
  let count = 0;
  for (const edge of open) {
    if (!resolveSpawnEdge(db, edge.id, 'interrupted', 'interrupted')) continue; // CAS loser → someone else handled it
    count += 1;
    const who = edge.role ?? edge.profileId ?? edge.childConversationId;
    sessionManager.recordSpawnMarker(edge.parentConversationId, {
      kind: 'stalled',
      childConversationId: edge.childConversationId,
      text: `⏱ sub-agent (${who}) interrupted by server restart — partial transcript: GET /spawn/${edge.childConversationId}/result`,
      role: edge.role,
      // ponytail: no durationMs — createdAt→now would include server downtime
    });
    if (edge.notifyParent && Date.now() - edge.createdAt < NOTIFY_MAX_AGE_MS) {
      sessionManager.notifyParentSubagentResult(
        edge.parentConversationId,
        `Sub-agent (${who}) was interrupted by a server restart before returning a result. `
          + `Its partial transcript is available via GET /spawn/${edge.childConversationId}/result`
          + `?parentConversationId=${edge.parentConversationId}. Re-spawn it if the task still matters.`,
        { role: edge.role, childConversationId: edge.childConversationId },
      );
    }
  }
  return count;
}
