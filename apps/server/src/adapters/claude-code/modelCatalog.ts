/**
 * Read ~/.claude/cache/model-catalog/*-cc.json → ModelDescriptor[].
 * Returns [] on any missing/unreadable/malformed catalogue (caller treats
 * empty as "unknown" so discovery does not prune).
 *
 * Never throws. Never reads catalog.state (account selection).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { ModelDescriptor } from '@tierwyn/shared';

export type ClaudeModelMatch = 'prefix' | 'exact';

export interface ClaudeModelPickerOption {
  model: string;
  label?: string;
}

export interface ClaudeModelSettings {
  availableModels?: string[];
  match: ClaudeModelMatch;
  modelPicker?: {
    options: ClaudeModelPickerOption[];
    replace: boolean;
  };
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function readManagedObjects(managedDir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const root = readJsonObject(join(managedDir, 'managed-settings.json'));
  if (root) out.push(root);
  const dropDir = join(managedDir, 'managed-settings.d');
  try {
    if (!existsSync(dropDir) || !statSync(dropDir).isDirectory()) return out;
    const names = readdirSync(dropDir)
      .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
      .sort();
    for (const name of names) {
      const obj = readJsonObject(join(dropDir, name));
      if (obj) out.push(obj);
    }
  } catch {
    // drop-ins optional
  }
  return out;
}

function foldManaged(objects: Record<string, unknown>[]): {
  availableModels?: string[];
  availableModelsMatch?: unknown;
  modelPicker?: unknown;
} {
  let availableModels: string[] | undefined;
  let availableModelsMatch: unknown;
  let modelPicker: unknown;
  let sawPicker = false;
  for (const obj of objects) {
    const list = stringList(obj.availableModels);
    if (list) {
      if (availableModels === undefined) availableModels = [];
      for (const item of list) {
        if (!availableModels.includes(item)) availableModels.push(item);
      }
    }
    if ('availableModelsMatch' in obj) availableModelsMatch = obj.availableModelsMatch;
    if ('modelPicker' in obj) {
      modelPicker = obj.modelPicker;
      sawPicker = true;
    }
  }
  return { availableModels, availableModelsMatch, modelPicker: sawPicker ? modelPicker : undefined };
}

function parseModelPicker(value: unknown): ClaudeModelSettings['modelPicker'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.options)) return undefined;
  const options: ClaudeModelPickerOption[] = [];
  for (const row of rec.options) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const model = (row as Record<string, unknown>).model;
    if (typeof model !== 'string' || !model) continue;
    const label = (row as Record<string, unknown>).label;
    const opt: ClaudeModelPickerOption = { model };
    if (typeof label === 'string' && label) opt.label = label;
    options.push(opt);
  }
  if (options.length === 0) return undefined;
  return { options, replace: rec.replaceBuiltInOptions === true };
}

/** User `settings.json` + managed files. Never throws. Never reads `env`. */
export function readClaudeModelSettings(claudeHome: string, managedDir: string): ClaudeModelSettings {
  try {
    const user = readJsonObject(join(claudeHome, 'settings.json'));
    const folded = foldManaged(readManagedObjects(managedDir));
    const userAvailable = user ? stringList(user.availableModels) : undefined;
    const availableModels = folded.availableModels !== undefined ? folded.availableModels : userAvailable;
    const match = folded.availableModelsMatch === 'exact' ? 'exact' : 'prefix';
    const modelPicker = parseModelPicker(folded.modelPicker !== undefined ? folded.modelPicker : user?.modelPicker);
    return { availableModels, match, modelPicker };
  } catch {
    return { match: 'prefix' };
  }
}

// ponytail: family detection is regex on the id; a new family name needs adding to FAMILIES.
const FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const IGNORED = new Set(['best', 'opusplan', 'default']);

function familyOf(id: string): string | undefined {
  const modern = /^claude-(opus|sonnet|haiku|fable)(-|$)/.exec(id);
  if (modern) return modern[1];
  const legacy = /^claude-[\d-]+-(opus|sonnet|haiku)/.exec(id);
  return legacy?.[1];
}

function strip(s: string): string {
  return s.replace(/-\d{8}$/, '');
}

function allows(name: string, list: string[], match: ClaudeModelMatch): boolean {
  const specific = list
    .filter((entry) => !FAMILIES.has(entry) && !IGNORED.has(entry))
    .map(strip);
  const narrowed = new Set(specific.map(familyOf).filter((f): f is string => Boolean(f)));
  if (list.some((a) => FAMILIES.has(a) && !narrowed.has(a) && familyOf(name) === a)) return true;
  for (const e of specific) {
    if (match === 'exact' ? name === e : name === e || name.startsWith(e + '-')) return true;
  }
  if (list.includes(name)) return true;
  return false;
}

export function applyModelSettings(catalog: ModelDescriptor[], s: ClaudeModelSettings): ModelDescriptor[] {
  const list = s.availableModels;
  const filtered = list !== undefined ? catalog.filter((m) => allows(m.name, list, s.match)) : catalog;
  if (!s.modelPicker) return filtered;
  const pickerRows: ModelDescriptor[] = s.modelPicker.options
    .filter((o) => list === undefined || allows(strip(o.model), list, s.match) || list.includes(o.model))
    .map((o) => {
      const name = /^claude-.*-\d{8}$/.test(o.model) ? strip(o.model) : o.model;
      const known = catalog.find((m) => m.name === name);
      return {
        name,
        label: o.label ? `Claude Code · ${o.label}` : (known?.label ?? `Claude Code · ${o.model}`),
        provider: 'anthropic',
        steer: true,
        vision: known?.vision ?? false,
      };
    });
  const base = s.modelPicker.replace ? [] : filtered;
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const row of [...base, ...pickerRows]) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }
  return out;
}

/** Read ~/.claude/cache/model-catalog/*-cc.json → ModelDescriptor[]. Returns []
 *  on a missing directory, no -cc.json file, bad JSON, or zero valid rows. */
export function readClaudeModelCatalog(claudeHome: string): ModelDescriptor[] {
  try {
    const dir = join(claudeHome, 'cache', 'model-catalog');
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((name) => name.endsWith('-cc.json'));
    if (files.length === 0) return [];

    let bestPath: string | null = null;
    let bestRank = -Infinity;
    for (const name of files) {
      const path = join(dir, name);
      const rank = rankCatalogFile(path);
      if (rank > bestRank) {
        bestRank = rank;
        bestPath = path;
      }
    }
    if (!bestPath) return [];

    const raw = JSON.parse(readFileSync(bestPath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const catalog = (raw as Record<string, unknown>).catalog;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return [];
    const config = (catalog as Record<string, unknown>).config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
    const models = (config as Record<string, unknown>).models;
    if (!Array.isArray(models)) return [];

    const out: ModelDescriptor[] = [];
    const seen = new Set<string>();
    for (const entry of models) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      const id = rec.id;
      if (typeof id !== 'string' || !id.startsWith('claude-')) continue;
      const name = id.replace(/-\d{8}$/, '');
      if (seen.has(name)) continue;
      seen.add(name);

      const display = typeof rec.name === 'string' && rec.name ? rec.name : id;
      const caps = rec.capabilities;
      const mmImages = caps && typeof caps === 'object' && !Array.isArray(caps)
        ? (caps as Record<string, unknown>).mm_images === true
        : false;

      // ponytail: filter against `claude --version` if a too-new row ever shows up.
      out.push({
        name,
        label: `Claude Code · ${display}`,
        provider: 'anthropic',
        steer: true,
        vision: mmImages,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function rankCatalogFile(path: string): number {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const fetchedAt = (raw as Record<string, unknown>).fetchedAt;
      if (typeof fetchedAt === 'number') return fetchedAt;
    }
  } catch {
    // fall through to mtime
  }
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -Infinity;
  }
}
