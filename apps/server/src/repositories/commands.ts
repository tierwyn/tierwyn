import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { CommandDescriptor, CommandRecord, CreateCommandRequest, UpdateCommandRequest } from '@tierwyn/shared';

interface CommandRow {
  id: string;
  agent_id: string;
  name: string;
  label: string;
  description: string;
  source: string;
  source_detail: string | null;
  enabled_flag: number;
}

function toCommandRecord(r: CommandRow): CommandRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    label: r.label,
    description: r.description,
    source: r.source as CommandRecord['source'],
    sourceDetail: (r.source_detail as CommandRecord['sourceDetail']) ?? null,
    enabled: r.enabled_flag === 1,
  };
}

/**
 * Upsert discovered commands for an agent, keyed by (agent_id, name).
 * New rows: source='discovered', enabled_flag=1.
 * Existing rows: refresh label/description/source_detail — preserve enabled_flag and source.
 *
 * After upserting, prune rows where source='discovered' AND name is no longer
 * reported. source='user' and source='seed' rows are never pruned here.
 */
export function upsertDiscoveredCommands(db: Database, agentId: string, commands: CommandDescriptor[]): void {
  if (commands.length === 0) return;

  const upsert = db.prepare(
    `INSERT INTO agent_commands
       (id, agent_id, name, label, description, source, source_detail, enabled_flag, created_at)
     VALUES (@id, @agent_id, @name, @label, @description, 'discovered', @source_detail, 1, @now)
     ON CONFLICT(agent_id, name) DO UPDATE SET
       label = excluded.label,
       description = excluded.description,
       source_detail = excluded.source_detail`
  );
  const prune = db.prepare(
    `DELETE FROM agent_commands
       WHERE agent_id = @agent_id
         AND source = 'discovered'
         AND name NOT IN (SELECT value FROM json_each(@names))`
  );
  const tx = db.transaction((rows: CommandDescriptor[]) => {
    const now = Date.now();
    for (const c of rows) {
      upsert.run({
        id: `${agentId}:${c.name}`,
        agent_id: agentId,
        name: c.name,
        label: c.label,
        description: c.description ?? '',
        source_detail: c.sourceDetail ?? null,
        now,
      });
    }
    const namesJson = JSON.stringify(rows.map((c) => c.name));
    prune.run({ agent_id: agentId, names: namesJson });
  });
  tx(commands);
}

export function listCommands(db: Database): CommandRecord[] {
  const rows = db.prepare('SELECT * FROM agent_commands ORDER BY label').all() as CommandRow[];
  return rows.map(toCommandRecord);
}

export function listCommandsForAgent(db: Database, agentId: string): CommandRecord[] {
  const rows = db.prepare(
    'SELECT * FROM agent_commands WHERE agent_id = ? AND enabled_flag = 1 ORDER BY label'
  ).all(agentId) as CommandRow[];
  return rows.map(toCommandRecord);
}

export const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Trim, strip one leading '/', validate. Returns null when invalid. */
export function normaliseCommandName(raw: string): string | null {
  const trimmed = raw.trim();
  const name = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  if (!name || name.length > 64 || !COMMAND_NAME_RE.test(name)) return null;
  return name;
}

export function getCommand(db: Database, id: string): CommandRecord | undefined {
  const row = db.prepare('SELECT * FROM agent_commands WHERE id = ?').get(id) as CommandRow | undefined;
  return row ? toCommandRecord(row) : undefined;
}

/** Throws `Error('duplicate')` if (agentId, name) already exists. */
export function createCommand(db: Database, agentId: string, req: CreateCommandRequest): CommandRecord {
  const dup = db.prepare('SELECT 1 FROM agent_commands WHERE agent_id = ? AND name = ?').get(agentId, req.name);
  if (dup) throw new Error('duplicate');
  const id = `user:${randomUUID()}`;
  const label = (req.label?.trim() || req.name);
  db.prepare(
    `INSERT INTO agent_commands
       (id, agent_id, name, label, description, source, source_detail, enabled_flag, created_at)
     VALUES (@id, @agent_id, @name, @label, @description, 'user', NULL, @enabled, @now)`
  ).run({
    id,
    agent_id: agentId,
    name: req.name,
    label,
    description: req.description?.trim() ?? '',
    enabled: req.enabled === false ? 0 : 1,
    now: Date.now(),
  });
  return getCommand(db, id)!;
}

/** Returns undefined if no such id. Throws `Error('duplicate')` on rename collision. */
export function updateCommand(db: Database, id: string, patch: UpdateCommandRequest): CommandRecord | undefined {
  const existing = db.prepare('SELECT * FROM agent_commands WHERE id = ?').get(id) as CommandRow | undefined;
  if (!existing) return undefined;
  const name = patch.name !== undefined ? patch.name : existing.name;
  // B1: create defaults label=name; a rename must sync that defaulted label so the
  // picker stops matching the old verb. Custom labels (label !== old name) stay put.
  let label: string;
  if (patch.label !== undefined) {
    const labelRaw = patch.label.trim();
    label = labelRaw === '' ? name : labelRaw;
  } else if (name !== existing.name && existing.label === existing.name) {
    label = name;
  } else {
    label = existing.label;
  }
  const description = patch.description !== undefined ? patch.description.trim() : existing.description;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled_flag;
  if (name !== existing.name) {
    const clash = db.prepare(
      'SELECT 1 FROM agent_commands WHERE agent_id = ? AND name = ? AND id <> ?',
    ).get(existing.agent_id, name, id);
    if (clash) throw new Error('duplicate');
  }
  db.prepare(
    `UPDATE agent_commands
        SET name = @name, label = @label, description = @description, enabled_flag = @enabled
      WHERE id = @id`
  ).run({ id, name, label, description, enabled });
  return getCommand(db, id);
}

export function deleteCommand(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM agent_commands WHERE id = ?').run(id);
  return info.changes > 0;
}

/** Every row for an agent, including disabled — catalogue UI only. */
export function listAllCommandsForAgent(db: Database, agentId: string): CommandRecord[] {
  const rows = db.prepare(
    'SELECT * FROM agent_commands WHERE agent_id = ? ORDER BY label'
  ).all(agentId) as CommandRow[];
  return rows.map(toCommandRecord);
}
