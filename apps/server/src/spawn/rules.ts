/**
 * Operator rules: DB-backed project + ancestor-chain conversation
 * instructions, plus stackable presets (migration 144).
 */
import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { Conversation, Project, RulePresetRef } from '@tierwyn/shared';
import {
  RULES_MAX_BYTES,
  RULES_CHAIN_GUARD_DEPTH,
  composeRuleBlocks,
  flattenRulesHeading,
  renderedRules,
  rulesLines as sharedRulesLines,
  type RulesBlock,
  type RulesComposeLayer,
  type RulesComposePreset,
} from '@tierwyn/shared';
import { getPresetsByIds, parsePresetIdCell } from '../repositories/rulePresets.js';

export { RULES_MAX_BYTES, renderedRules };
export type { RulesBlock };

export interface RulesView {
  blocks: RulesBlock[];
  hash: string;
  omitted: number;
}

export interface ChainRow {
  id: string;
  title: string;
  rules: string | null;
  rulePresetIds?: string[];
}

export function normaliseRules(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'rules must be a string or null' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (Buffer.byteLength(trimmed, 'utf8') > RULES_MAX_BYTES) {
    return { ok: false, error: `rules too long (max ${RULES_MAX_BYTES} bytes)` };
  }
  return { ok: true, value: trimmed };
}

function hashBlocks(blocks: RulesBlock[]): string {
  const payload = blocks.map((b) => b.text);
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

/** Root-first ancestor walk including self. Cycles stop via `seen`. */
export function walkConversationChain(db: Database, convId: string): ChainRow[] {
  const chain: ChainRow[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = convId;
  let depth = 0;
  const stmt = db.prepare(
    'SELECT id, title, rules, rule_preset_ids, parent_conversation_id FROM conversations WHERE id = ?',
  );
  while (cur && depth < RULES_CHAIN_GUARD_DEPTH) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const row = stmt.get(cur) as
      | {
          id: string;
          title: string;
          rules: string | null;
          rule_preset_ids: string | null;
          parent_conversation_id: string | null;
        }
      | undefined;
    if (!row) break;
    chain.push({
      id: row.id,
      title: row.title,
      rules: row.rules,
      rulePresetIds: parsePresetIdCell(row.rule_preset_ids),
    });
    cur = row.parent_conversation_id ?? undefined;
    depth += 1;
  }
  chain.reverse();
  return chain;
}

function presetRefs(
  ids: string[] | undefined,
  byId: ReturnType<typeof getPresetsByIds>,
  scopeProjectId: string,
): { refs: RulePresetRef[]; compose: RulesComposePreset[] } {
  const refs: RulePresetRef[] = [];
  const compose: RulesComposePreset[] = [];
  for (const id of ids ?? []) {
    const p = byId.get(id);
    const inScope = !!p && (p.projectId === null || p.projectId === scopeProjectId);
    const available = inScope;
    refs.push({
      id,
      name: p ? flattenRulesHeading(p.name, 80) : 'unavailable',
      available,
    });
    compose.push({
      id,
      name: p?.name ?? 'unavailable',
      content: available ? p!.content : '',
      available,
    });
  }
  return { refs, compose };
}

function collectPresetIds(project: Pick<Project, 'rulePresetIds'>, chain: ChainRow[]): string[] {
  const ids: string[] = [...(project.rulePresetIds ?? [])];
  for (const row of chain) ids.push(...(row.rulePresetIds ?? []));
  return ids;
}

export function loadRules(
  db: Database,
  conv: Pick<Conversation, 'id' | 'title' | 'parentConversationId' | 'rules' | 'rulePresetIds' | 'projectId'>,
  project: Pick<Project, 'system' | 'rules' | 'rulePresetIds' | 'id'>,
): RulesView | undefined {
  if (project.system) return undefined;

  const chain = walkConversationChain(db, conv.id);
  const byId = getPresetsByIds(db, collectPresetIds(project, chain));
  const scope = conv.projectId ?? project.id;

  const layers: RulesComposeLayer[] = [
    {
      customLabel: 'Project',
      custom: project.rules,
      presets: presetRefs(project.rulePresetIds, byId, scope).compose,
    },
    ...chain.map((row) => ({
      customLabel: `Conversation: ${flattenRulesHeading(row.title, 120)}`,
      custom: row.rules,
      presets: presetRefs(row.rulePresetIds, byId, scope).compose,
    })),
  ];

  const { blocks, omitted } = composeRuleBlocks(layers);
  if (blocks.length === 0) return undefined;
  if (omitted > 0) {
    console.warn(`[rules] conversation=${conv.id} omitted=${omitted} bytes=${blocks.reduce((n, b) => n + Buffer.byteLength(b.text, 'utf8'), 0)}`);
  }
  return { blocks, hash: hashBlocks(blocks), omitted };
}

/** Project layer only (modal preview / GET /projects/:id/rules). */
export function loadProjectRules(
  db: Database,
  project: Pick<Project, 'system' | 'rules' | 'rulePresetIds' | 'id'>,
): RulesView | undefined {
  if (project.system) return undefined;
  const byId = getPresetsByIds(db, project.rulePresetIds ?? []);
  const { blocks, omitted } = composeRuleBlocks([
    {
      customLabel: 'Project',
      custom: project.rules,
      presets: presetRefs(project.rulePresetIds, byId, project.id).compose,
    },
  ]);
  if (blocks.length === 0) return undefined;
  return { blocks, hash: hashBlocks(blocks), omitted };
}

export function describeRulesLayers(
  db: Database,
  conv: Pick<Conversation, 'id' | 'projectId'>,
  project: Pick<Project, 'system' | 'rules' | 'rulePresetIds' | 'id' | 'name'>,
): {
  project: { rules: string | null; presets: RulePresetRef[] } | null;
  chain: Array<{ conversationId: string; title: string; rules: string | null; presets: RulePresetRef[] }>;
} {
  if (project.system) {
    return { project: null, chain: [] };
  }
  const chain = walkConversationChain(db, conv.id);
  const byId = getPresetsByIds(db, collectPresetIds(project, chain));
  const scope = conv.projectId ?? project.id;
  return {
    project: {
      rules: project.rules?.trim() ? project.rules : null,
      presets: presetRefs(project.rulePresetIds, byId, scope).refs,
    },
    chain: chain.map((row) => ({
      conversationId: row.id,
      title: row.title,
      rules: row.rules,
      presets: presetRefs(row.rulePresetIds, byId, scope).refs,
    })),
  };
}

export function rulesFpExtra(view: RulesView | undefined): { rules?: string } {
  return view ? { rules: view.hash } : {};
}

export function rulesLines(view: RulesView | undefined, mode: 'full' | 'stub'): string[] {
  return sharedRulesLines(view, mode);
}
