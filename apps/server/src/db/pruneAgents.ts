import type { Database } from 'better-sqlite3';
import { AGENT_VAULT_ID } from '../secrets/mcpRedact.js';

function likePrefix(value: string): string {
  return `${value.replace(/([\\%_])/g, '\\$1')}%`;
}

/** Drop catalogue rows for agent types that no longer have a registered adapter.
 *  Transcript history (`sessions`, `events`) is kept; session FKs are nulled. */
export function pruneUnregisteredAgents(db: Database, registeredTypes: Iterable<string>): number {
  const keep = new Set(registeredTypes);
  const stale = (db.prepare('SELECT id FROM agents').all() as Array<{ id: string }>)
    .map((r) => r.id)
    .filter((id) => !keep.has(id));
  if (stale.length === 0) return 0;

  const nullSessions = db.prepare(
    'UPDATE sessions SET agent_id = NULL, agent_model_id = NULL WHERE agent_id = ?',
  );
  // ponytail: full events scan, but only on boots that actually prune a stale agent.
  const nullEvents = db.prepare(
    'UPDATE events SET agent_model_id = NULL WHERE agent_model_id IN (SELECT id FROM agent_models WHERE agent_id = ?)',
  );
  const delCommands = db.prepare('DELETE FROM agent_commands WHERE agent_id = ?');
  const delSecrets = db.prepare(
    'DELETE FROM plugin_secrets WHERE plugin_id = ? AND key LIKE ? ESCAPE \'\\\'',
  );
  const delAgents = db.prepare('DELETE FROM agents WHERE id = ?');

  const tx = db.transaction(() => {
    for (const id of stale) {
      nullSessions.run(id);
      nullEvents.run(id);
      delCommands.run(id);
      delSecrets.run(AGENT_VAULT_ID, likePrefix(`env.${id}.`));
      delAgents.run(id);
    }
  });
  tx();
  return stale.length;
}
