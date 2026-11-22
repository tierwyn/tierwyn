import type { Database } from 'better-sqlite3';
import type { ModelDescriptor, AgentRecord, ModelRecord, CreateAgentRequest, UpdateAgentRequest, CreateModelRequest, UpdateModelRequest } from '@tierwyn/shared';
import { normaliseContextWindow } from '../contextWindow.js';

export function ensureAgent(db: Database, agent: { id: string; label: string; description?: string }): void {
  // In this system the agent id and its `type` discriminator are the same value
  // (the registry keys adapters by type, e.g. 'pi' / 'claude-code'), so type := id.
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, type, label, description, executable_path, env_vars, enabled_flag, created_at)
     VALUES (@id, @id, @label, @description, NULL, '{}', 0, @now)`
  ).run({ id: agent.id, label: agent.label, description: agent.description ?? '', now: Date.now() });
}

/**
 * Upsert discovered models for an agent, keyed by (agent_id, model_name).
 * New rows: source='discovered', enabled_flag=1, vision_flag/steer_flag/
 * context_window from descriptor.
 * Existing rows: refresh label/provider/vision_flag/steer_flag from the new
 * descriptor — PRESERVE only user-controlled enabled_flag and source (so a
 * user-created or seeded row that happens to collide with a discovered
 * model_name is not downgraded, but metadata corrections from the adapter
 * still propagate on subsequent discovery cycles).
 *
 * Manual vision/steer overrides recorded in agent_model_overrides (see
 * updateModel) are re-applied AFTER the descriptor refresh, so an operator
 * edit survives discovery instead of silently reverting (FW-4).
 *
 * After upserting, prune rows where source='discovered' AND model_name is no
 * longer reported by the adapter. source='user' (Phase 5 CRUD) and source='seed'
 * (agent-profiles.json) rows are never pruned here.
 */
export function upsertDiscoveredModels(db: Database, agentId: string, models: ModelDescriptor[]): void {
  // Empty descriptor list: do nothing. The scheduler already skips this path,
  // but guard here too so a future caller can't accidentally wipe an agent's
  // whole discovered catalogue on a transient CLI failure (empty == "we don't
  // know", not "the agent exposes zero models").
  if (models.length === 0) return;

  const upsert = db.prepare(
    `INSERT INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, context_window, source, created_at)
     VALUES (@id, @agent_id, @model_name, @label, @provider, @vision, @steer, 1, @description, @context_window, 'discovered', @now)
     ON CONFLICT(agent_id, model_name) DO UPDATE SET
       label = excluded.label,
       provider = excluded.provider,
       vision_flag = excluded.vision_flag,
       steer_flag = excluded.steer_flag,
       -- FW-7: a number refreshes, a MISSING value preserves the last known
       -- window. listModels() is flaky by nature (CLI off PATH, transient auth
       -- failure, thinner descriptor after an adapter upgrade); an unconditional
       -- '= excluded.context_window' would regress a known 1M window to NULL on
       -- one bad tick, reintroducing the exact bug FW-7 fixes.
       context_window = COALESCE(excluded.context_window, agent_models.context_window)`
  );
  // Only prune unreferenced rows. sessions/events FK-reference agent_models(id)
  // without ON DELETE CASCADE; a hard DELETE of a still-referenced stale name
  // throws FOREIGN KEY constraint failed and — when it lived in the same
  // transaction as the upserts — rolled back the whole discovery cycle
  // (symptom: antigravity stuck on legacy "Gemini 3.5 Flash (Medium)" labels
  // after agy renamed its catalogue to slug ids).
  const prune = db.prepare(
    `DELETE FROM agent_models
       WHERE agent_id = @agent_id
         AND source = 'discovered'
         AND model_name NOT IN (SELECT value FROM json_each(@names))
         -- Keep operator-disabled rows as tombstones: deleting one lets a later
         -- re-list re-INSERT it with enabled_flag=1 (disabled model reappears).
         AND enabled_flag = 1
         AND id NOT IN (SELECT agent_model_id FROM sessions WHERE agent_model_id IS NOT NULL)
         AND id NOT IN (SELECT agent_model_id FROM events WHERE agent_model_id IS NOT NULL)`
  );
  // Cheap indexed pre-check: prune/disable only touch enabled discovered rows
  // missing from the new list. Skipping both when none exist avoids full-table
  // scans of `events` (unindexed agent_model_id) on every discovery tick.
  const hasStaleEnabled = db.prepare(
    `SELECT 1 FROM agent_models
      WHERE agent_id = @agent_id
        AND source = 'discovered'
        AND enabled_flag = 1
        AND model_name NOT IN (SELECT value FROM json_each(@names))
      LIMIT 1`
  );
  // Stale-but-referenced rows: disable so they drop out of the picker without
  // breaking historical session FKs. Re-discovery that re-lists the same name
  // hits ON CONFLICT and preserves enabled_flag — so once disabled they stay
  // disabled unless the operator flips them. Intentional for renamed rows.
  const disableStaleReferenced = db.prepare(
    `UPDATE agent_models
        SET enabled_flag = 0
      WHERE agent_id = @agent_id
        AND source = 'discovered'
        AND enabled_flag = 1
        AND model_name NOT IN (SELECT value FROM json_each(@names))
        AND (
          id IN (SELECT agent_model_id FROM sessions WHERE agent_model_id IS NOT NULL)
          OR id IN (SELECT agent_model_id FROM events WHERE agent_model_id IS NOT NULL)
        )`
  );
  // FW-4: descriptor metadata wins EXCEPT where the operator recorded a manual
  // override — those re-assert themselves after every descriptor refresh.
  // Runs last inside the same transaction so there is no window where a
  // discovery cycle observes (or broadcasts) reverted flags.
  const applyOverrides = db.prepare(
    `UPDATE agent_models AS m
        SET vision_flag = COALESCE(o.vision_override, m.vision_flag),
            steer_flag  = COALESCE(o.steer_override,  m.steer_flag)
      FROM agent_model_overrides AS o
      WHERE o.agent_id = m.agent_id
        AND o.model_name = m.model_name
        AND m.agent_id = @agent_id`
  );
  const existingIdForName = db.prepare(
    'SELECT id FROM agent_models WHERE agent_id = ? AND model_name = ?'
  ).pluck();
  const idTaken = db.prepare('SELECT 1 FROM agent_models WHERE id = ?').pluck();
  // The derived id can already belong to a row with a different model_name,
  // for example an operator-created row. That would throw UNIQUE on agent_models.id and roll back the
  // whole cycle. Reuse the existing id for this name, else find a free one.
  const resolveId = (name: string): string => {
    const existing = existingIdForName.get(agentId, name) as string | undefined;
    if (existing) return existing;
    const base = `${agentId}:${name}`;
    let id = base;
    for (let n = 2; idTaken.get(id); n++) id = `${base}~${n}`;
    return id;
  };
  const tx = db.transaction((rows: ModelDescriptor[]) => {
    const now = Date.now();
    for (const m of rows) {
      upsert.run({
        id: resolveId(m.name),
        agent_id: agentId,
        model_name: m.name,
        label: m.label,
        provider: m.provider ?? null,
        vision: m.vision ? 1 : 0,
        steer: m.steer ? 1 : 0,
        description: '',
        context_window: normaliseContextWindow(m.contextWindow),
        now,
      });
    }
    // json_each expects a JSON array string; empty array short-circuits the NOT IN
    // (which would otherwise match every row and wipe the agent's catalogue).
    const namesJson = JSON.stringify(rows.map((m) => m.name));
    if (hasStaleEnabled.get({ agent_id: agentId, names: namesJson })) {
      prune.run({ agent_id: agentId, names: namesJson });
      disableStaleReferenced.run({ agent_id: agentId, names: namesJson });
    }
    applyOverrides.run({ agent_id: agentId });
  });
  tx(models);
}

// ── Catalogue CRUD (Phase 5) ────────────────────────────────────────────────

interface AgentRow {
  id: string;
  type: string;
  label: string;
  description: string;
  executable_path: string | null;
  env_vars: string;
  enabled_flag: number;
}

interface ModelRow {
  id: string;
  agent_id: string;
  model_name: string;
  label: string;
  provider: string | null;
  vision_flag: number;
  steer_flag: number;
  enabled_flag: number;
  description: string;
  source: string;
  max_concurrent_spawns: number | null;
  max_grandchild_spawns: number | null;
}

function parseEnvVars(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch { return {}; }
}

function toAgentRecord(r: AgentRow): AgentRecord {
  return {
    id: r.id,
    type: r.type,
    label: r.label,
    description: r.description,
    executablePath: r.executable_path,
    envVars: parseEnvVars(r.env_vars),
    enabled: r.enabled_flag === 1,
  };
}

function toModelRecord(r: ModelRow): ModelRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    modelName: r.model_name,
    label: r.label,
    provider: r.provider,
    vision: r.vision_flag === 1,
    steer: r.steer_flag === 1,
    enabled: r.enabled_flag === 1,
    description: r.description,
    maxConcurrentSpawns: r.max_concurrent_spawns ?? undefined,
    maxGrandchildSpawns: r.max_grandchild_spawns ?? undefined,
  };
}

export function listAgents(db: Database): AgentRecord[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY label').all() as AgentRow[];
  return rows.map(toAgentRecord);
}

export function getAgent(db: Database, id: string): AgentRecord | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  return row ? toAgentRecord(row) : undefined;
}

export function createAgent(db: Database, req: CreateAgentRequest): AgentRecord {
  const id = req.id ?? req.type;
  db.prepare(
    `INSERT INTO agents (id, type, label, description, executable_path, env_vars, enabled_flag, created_at)
     VALUES (@id, @type, @label, @description, @executable_path, @env_vars, 0, @now)`
  ).run({
    id,
    type: req.type,
    label: req.label,
    description: req.description ?? '',
    executable_path: req.executablePath ?? null,
    env_vars: JSON.stringify(req.envVars ?? {}),
    now: Date.now(),
  });
  return getAgent(db, id)!;
}

export function updateAgent(db: Database, id: string, patch: UpdateAgentRequest): AgentRecord | undefined {
  const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  if (!existing) return undefined;
  const merged = {
    label: patch.label ?? existing.label,
    description: patch.description ?? existing.description,
    executable_path: patch.executablePath !== undefined ? patch.executablePath : existing.executable_path,
    env_vars: patch.envVars !== undefined ? JSON.stringify(patch.envVars) : existing.env_vars,
    enabled_flag: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled_flag,
  };
  db.prepare(
    `UPDATE agents SET label=@label, description=@description, executable_path=@executable_path,
                       env_vars=@env_vars, enabled_flag=@enabled_flag WHERE id=@id`
  ).run({ ...merged, id });
  return getAgent(db, id);
}

export function deleteAgent(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  return info.changes > 0;
}

export function listModels(db: Database): ModelRecord[] {
  const rows = db.prepare('SELECT * FROM agent_models ORDER BY label').all() as ModelRow[];
  return rows.map(toModelRecord);
}

export function listModelsForAgent(db: Database, agentId: string): ModelRecord[] {
  const rows = db.prepare('SELECT * FROM agent_models WHERE agent_id = ? ORDER BY label').all(agentId) as ModelRow[];
  return rows.map(toModelRecord);
}

export function getModel(db: Database, id: string): ModelRecord | undefined {
  const row = db.prepare('SELECT * FROM agent_models WHERE id = ?').get(id) as ModelRow | undefined;
  return row ? toModelRecord(row) : undefined;
}

/**
 * ModelSelector (and catalogue edit-blur) expect labels as "Agent · Model".
 * Prefix bare labels so manual create matches seed/discovery conventions.
 */
export function withAgentLabelPrefix(agentLabel: string, label: string): string {
  const raw = label.trim();
  if (!raw) return raw;
  const prefix = `${agentLabel} · `;
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
}

export function createModel(db: Database, agentId: string, req: CreateModelRequest): ModelRecord {
  const id = `${agentId}:${req.modelName}`;
  const agent = getAgent(db, agentId);
  const baseLabel = (req.label?.trim() || req.modelName).trim();
  const label = agent ? withAgentLabelPrefix(agent.label, baseLabel) : baseLabel;
  db.prepare(
    `INSERT INTO agent_models
       (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, source, max_concurrent_spawns, max_grandchild_spawns, created_at)
     VALUES (@id, @agent_id, @model_name, @label, @provider, @vision, @steer, @enabled, @description, 'user', @maxSpawns, @maxGrandchildren, @now)`
  ).run({
    id,
    agent_id: agentId,
    model_name: req.modelName,
    label,
    provider: req.provider ?? null,
    vision: req.vision ? 1 : 0,
    steer: req.steer ? 1 : 0,
    enabled: req.enabled === false ? 0 : 1,
    description: req.description ?? '',
    maxSpawns: req.maxConcurrentSpawns ?? null,
    maxGrandchildren: req.maxGrandchildSpawns ?? null,
    now: Date.now(),
  });
  return getModel(db, id)!;
}

export function updateModel(db: Database, id: string, patch: UpdateModelRequest): ModelRecord | undefined {
  const existing = db.prepare('SELECT * FROM agent_models WHERE id = ?').get(id) as ModelRow | undefined;
  if (!existing) return undefined;
  const renamedTo = patch.modelName !== undefined && patch.modelName.trim() !== '' && patch.modelName !== existing.model_name
    ? patch.modelName.trim()
    : null;
  const merged = {
    modelName: renamedTo ?? existing.model_name,
    label: patch.label ?? existing.label,
    provider: patch.provider !== undefined ? patch.provider : existing.provider,
    vision: patch.vision !== undefined ? (patch.vision ? 1 : 0) : existing.vision_flag,
    steer: patch.steer !== undefined ? (patch.steer ? 1 : 0) : existing.steer_flag,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled_flag,
    description: patch.description ?? existing.description,
    maxSpawns: patch.maxConcurrentSpawns !== undefined ? patch.maxConcurrentSpawns : existing.max_concurrent_spawns,
    maxGrandchildren: patch.maxGrandchildSpawns !== undefined ? patch.maxGrandchildSpawns : existing.max_grandchild_spawns,
  };
  // FW-4: an explicit manual vision/steer write is recorded as a persistent
  // override (keyed by the FINAL model_name, so renames carry it along) and is
  // re-applied after every discovery upsert — without this, the next discovery
  // tick reverts the flags from the adapter descriptor and the catalogue edit
  // UI gives an illusion of control.
  if (patch.vision !== undefined || patch.steer !== undefined) {
    db.prepare(
      `INSERT INTO agent_model_overrides (agent_id, model_name, vision_override, steer_override, updated_at)
       VALUES (@agent_id, @model_name, @vision, @steer, @now)
       ON CONFLICT(agent_id, model_name) DO UPDATE SET
         vision_override = COALESCE(excluded.vision_override, vision_override),
         steer_override  = COALESCE(excluded.steer_override,  steer_override),
         updated_at = excluded.updated_at`
    ).run({
      agent_id: existing.agent_id,
      model_name: merged.modelName,
      vision: patch.vision !== undefined ? (patch.vision ? 1 : 0) : null,
      steer: patch.steer !== undefined ? (patch.steer ? 1 : 0) : null,
      now: Date.now(),
    });
  }
  db.prepare(
    `UPDATE agent_models SET model_name=@modelName, label=@label, provider=@provider, vision_flag=@vision,
       steer_flag=@steer, enabled_flag=@enabled, description=@description,
       max_concurrent_spawns=@maxSpawns, max_grandchild_spawns=@maxGrandchildren WHERE id=@id`
  ).run({ ...merged, id });
  return getModel(db, id);
}

export function deleteModel(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM agent_models WHERE id = ?').run(id);
  return info.changes > 0;
}
