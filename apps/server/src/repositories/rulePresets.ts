import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { RulePreset } from '@tierwyn/shared';
import { RULE_PRESETS_MAX_PER_LAYER, flattenRulesHeading } from '@tierwyn/shared';

interface Row {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  content: string;
  created_at: number;
  updated_at: number;
}

function toPreset(r: Row, usage?: { projects: number; conversations: number }): RulePreset {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(usage ? { usage } : {}),
  };
}

export function parsePresetIdCell(cell: string | null | undefined): string[] | undefined {
  if (!cell) return undefined;
  try {
    const v: unknown = JSON.parse(cell);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      return v.length ? v : undefined;
    }
  } catch { /* corrupt cell */ }
  return undefined;
}

export function serialisePresetIds(ids: string[] | null | undefined): string | null {
  if (!ids || ids.length === 0) return null;
  return JSON.stringify(ids);
}

const NAME_MAX = 80;
const DESC_MAX = 200;

export function normalisePresetName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const name = flattenRulesHeading(raw, NAME_MAX);
  if (!name) return { ok: false, error: 'name required' };
  return { ok: true, value: name };
}

export function normalisePresetDescription(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'description must be a string' };
  const d = raw.trim();
  if (!d) return { ok: true, value: null };
  if (d.length > DESC_MAX) return { ok: false, error: `description too long (max ${DESC_MAX} chars)` };
  return { ok: true, value: d };
}

export function getRulePreset(db: Database, id: string): RulePreset | undefined {
  const r = db.prepare('SELECT * FROM rule_presets WHERE id = ?').get(id) as Row | undefined;
  return r ? toPreset(r) : undefined;
}

export function listRulePresets(db: Database, projectId?: string): RulePreset[] {
  const rows = projectId
    ? (db.prepare(
      'SELECT * FROM rule_presets WHERE project_id IS NULL OR project_id = ? ORDER BY name COLLATE NOCASE',
    ).all(projectId) as Row[])
    : (db.prepare('SELECT * FROM rule_presets ORDER BY name COLLATE NOCASE').all() as Row[]);
  const usage = usageIndex(db);
  return rows.map((r) => toPreset(r, usage.get(r.id) ?? { projects: 0, conversations: 0 }));
}

function usageIndex(db: Database): Map<string, { projects: number; conversations: number }> {
  const map = new Map<string, { projects: number; conversations: number }>();
  const bump = (id: string, key: 'projects' | 'conversations') => {
    const cur = map.get(id) ?? { projects: 0, conversations: 0 };
    cur[key] += 1;
    map.set(id, cur);
  };
  for (const r of db.prepare('SELECT rule_preset_ids FROM projects WHERE rule_preset_ids IS NOT NULL').all() as { rule_preset_ids: string }[]) {
    for (const id of parsePresetIdCell(r.rule_preset_ids) ?? []) bump(id, 'projects');
  }
  for (const r of db.prepare('SELECT rule_preset_ids FROM conversations WHERE rule_preset_ids IS NOT NULL').all() as { rule_preset_ids: string }[]) {
    for (const id of parsePresetIdCell(r.rule_preset_ids) ?? []) bump(id, 'conversations');
  }
  return map;
}

function nameTaken(db: Database, name: string, projectId: string | null, exceptId?: string): boolean {
  const row = projectId === null
    ? db.prepare(
      'SELECT id FROM rule_presets WHERE name = ? AND project_id IS NULL LIMIT 1',
    ).get(name) as { id: string } | undefined
    : db.prepare(
      'SELECT id FROM rule_presets WHERE name = ? AND project_id = ? LIMIT 1',
    ).get(name, projectId) as { id: string } | undefined;
  if (!row) return false;
  return row.id !== exceptId;
}

export type CreatePresetInput = {
  name: string;
  description?: string | null;
  content: string;
  projectId?: string | null;
};

export function createRulePreset(db: Database, input: CreatePresetInput): RulePreset {
  const now = Date.now();
  const row: Row = {
    id: randomUUID(),
    project_id: input.projectId ?? null,
    name: input.name,
    description: input.description ?? null,
    content: input.content,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    'INSERT INTO rule_presets (id, project_id, name, description, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(row.id, row.project_id, row.name, row.description, row.content, row.created_at, row.updated_at);
  return toPreset(row, { projects: 0, conversations: 0 });
}

export function updateRulePreset(
  db: Database,
  id: string,
  patch: { name?: string; description?: string | null; content?: string },
): RulePreset | undefined {
  const existing = db.prepare('SELECT * FROM rule_presets WHERE id = ?').get(id) as Row | undefined;
  if (!existing) return undefined;
  const name = patch.name ?? existing.name;
  const description = Object.prototype.hasOwnProperty.call(patch, 'description')
    ? (patch.description ?? null)
    : existing.description;
  const content = patch.content ?? existing.content;
  db.prepare(
    'UPDATE rule_presets SET name = ?, description = ?, content = ?, updated_at = ? WHERE id = ?',
  ).run(name, description, content, Date.now(), id);
  return getRulePreset(db, id);
}

export function nameConflict(db: Database, name: string, projectId: string | null, exceptId?: string): boolean {
  return nameTaken(db, name, projectId, exceptId);
}

export function deleteRulePreset(
  db: Database,
  id: string,
): { ok: boolean; scrubbed: { projects: number; conversations: number } } {
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM rule_presets WHERE id = ?').get(id) as { id: string } | undefined;
    if (!existing) return { ok: false, scrubbed: { projects: 0, conversations: 0 } };
    const scrubbed = scrubPresetId(db, id);
    db.prepare('DELETE FROM rule_presets WHERE id = ?').run(id);
    return { ok: true, scrubbed };
  })();
}

/** Drop `id` from JSON stacks. Does not bump conversations.updated_at. */
export function scrubPresetId(db: Database, id: string): { projects: number; conversations: number } {
  const like = `%${id}%`;
  let projects = 0;
  let conversations = 0;
  const projRows = db.prepare(
    'SELECT id, rule_preset_ids FROM projects WHERE rule_preset_ids LIKE ?',
  ).all(like) as { id: string; rule_preset_ids: string }[];
  const updP = db.prepare('UPDATE projects SET rule_preset_ids = ? WHERE id = ?');
  for (const r of projRows) {
    const ids = parsePresetIdCell(r.rule_preset_ids) ?? [];
    if (!ids.includes(id)) continue;
    updP.run(serialisePresetIds(ids.filter((x) => x !== id)), r.id);
    projects += 1;
  }
  const convRows = db.prepare(
    'SELECT id, rule_preset_ids FROM conversations WHERE rule_preset_ids LIKE ?',
  ).all(like) as { id: string; rule_preset_ids: string }[];
  const updC = db.prepare('UPDATE conversations SET rule_preset_ids = ? WHERE id = ?');
  for (const r of convRows) {
    const ids = parsePresetIdCell(r.rule_preset_ids) ?? [];
    if (!ids.includes(id)) continue;
    updC.run(serialisePresetIds(ids.filter((x) => x !== id)), r.id);
    conversations += 1;
  }
  return { projects, conversations };
}

export function getPresetsByIds(db: Database, ids: string[]): Map<string, RulePreset> {
  const map = new Map<string, RulePreset>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM rule_presets WHERE id IN (${placeholders})`).all(...unique) as Row[];
  for (const r of rows) map.set(r.id, toPreset(r));
  return map;
}

/**
 * Validate a stack against a project scope. null/[] → null.
 * Every id must exist and be global or belong to scopeProjectId.
 */
export function normalisePresetIds(
  db: Database,
  raw: unknown,
  scopeProjectId: string,
): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, value: null };
  }
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    return { ok: false, error: 'rulePresetIds must be an array of strings or null' };
  }
  const ids = raw as string[];
  if (ids.length > RULE_PRESETS_MAX_PER_LAYER) {
    return { ok: false, error: `at most ${RULE_PRESETS_MAX_PER_LAYER} presets per layer` };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: 'rulePresetIds must not contain duplicates' };
  }
  const found = getPresetsByIds(db, ids);
  for (const id of ids) {
    const p = found.get(id);
    if (!p) return { ok: false, error: `unknown preset ${id}` };
    if (p.projectId !== null && p.projectId !== scopeProjectId) {
      return { ok: false, error: `preset ${id} is not available in this project` };
    }
  }
  return { ok: true, value: ids };
}
