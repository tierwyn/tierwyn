/**
 * Read ~/.codex/models_cache.json → ModelDescriptor[].
 * Returns [] on any missing/unreadable/malformed file (caller falls back to seeded profiles).
 *
 * Never reads, logs, or persists any credential or authorization fields.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ModelDescriptor } from '@tierwyn/shared';

export interface CodexModelEntry {
  slug?: string;
  display_name?: string;
  context_window?: number;
  input_modalities?: string[];
  visibility?: string;
  priority?: number;
}

export function readCodexModelsCache(codexHome: string): ModelDescriptor[] {
  const path = join(codexHome, 'models_cache.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const models = (raw as Record<string, unknown>).models;
    if (!Array.isArray(models)) return [];

    const out: ModelDescriptor[] = [];
    for (const entry of models) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rec = entry as CodexModelEntry;
      const slug = rec.slug;
      if (typeof slug !== 'string' || !slug) continue;
      // Filter out internal review model
      if (slug === 'codex-auto-review') continue;

      const labelName = typeof rec.display_name === 'string' && rec.display_name ? rec.display_name : slug;
      const vision = Array.isArray(rec.input_modalities) ? rec.input_modalities.includes('image') : false;
      const desc: ModelDescriptor = {
        name: slug,
        label: `Codex · ${labelName}`,
        provider: 'openai',
        vision,
        steer: true,
      };
      if (typeof rec.context_window === 'number') {
        desc.contextWindow = rec.context_window;
      }
      out.push(desc);
    }
    return out;
  } catch {
    return [];
  }
}
