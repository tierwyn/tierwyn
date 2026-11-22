/**
 * Read ~/.grok/models_cache.json → ModelDescriptor[]. Returns [] on any
 * missing/unreadable/malformed file (caller falls back to the catalogue seed).
 *
 * Never reads, logs, or persists models[].api_key / env_key / api_base_url.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ModelDescriptor } from '@tierwyn/shared';

/** Read ~/.grok/models_cache.json → ModelDescriptor[]. Returns [] on any
 *  missing/unreadable/malformed file (caller falls back to the catalogue seed). */
export function readGrokModelsCache(grokHome: string): ModelDescriptor[] {
  const path = join(grokHome, 'models_cache.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const models = (raw as Record<string, unknown>).models;
    // models is an object keyed by model id, not an array.
    if (!models || typeof models !== 'object' || Array.isArray(models)) return [];

    const out: ModelDescriptor[] = [];
    for (const entry of Object.values(models as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const info = (entry as Record<string, unknown>).info;
      if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
      const rec = info as Record<string, unknown>;
      if (rec.hidden === true) continue;
      const id = rec.id;
      if (typeof id !== 'string' || !id) continue;

      const labelName = typeof rec.name === 'string' && rec.name ? rec.name : id;
      const desc: ModelDescriptor = {
        name: id,
        label: `Grok Build · ${labelName}`,
        provider: 'xai',
        vision: true,
        steer: true,
      };
      if (typeof rec.context_window === 'number') desc.contextWindow = rec.context_window;
      out.push(desc);
    }

    // Deterministic: grok-4.6 before grok-4.5 regardless of Object.values insertion order.
    out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    return out;
  } catch {
    return [];
  }
}
