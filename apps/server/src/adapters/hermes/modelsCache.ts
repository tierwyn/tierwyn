/**
 * Read ~/.hermes/models.json → ModelDescriptor[].
 * Returns [] on any missing/unreadable/malformed file (caller falls back to seeded profiles).
 *
 * Never reads, logs, or persists any credential or authorization fields.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ModelDescriptor } from '@tierwyn/shared';

export interface HermesModelEntry {
  id?: string;
  name?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  createdAt?: number;
}

export function readHermesModels(hermesHome: string): ModelDescriptor[] {
  const path = join(hermesHome, 'models.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!Array.isArray(raw)) return [];

    const out: ModelDescriptor[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rec = entry as HermesModelEntry;
      const rawModel = typeof rec.model === 'string' ? rec.model.trim() : '';
      if (!rawModel) continue;

      const provider = typeof rec.provider === 'string' ? rec.provider.trim() : '';
      let modelId: string;
      if (rawModel.includes('/') || rawModel.includes(':')) {
        modelId = rawModel;
      } else if (provider) {
        modelId = `${provider}/${rawModel}`;
      } else {
        modelId = rawModel;
      }

      if (seen.has(modelId)) continue;
      seen.add(modelId);

      const labelName = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : rawModel;
      const lower = rawModel.toLowerCase();
      const vision = lower.includes('claude') || lower.includes('gpt') || lower.includes('gemini') || lower.includes('vision');

      out.push({
        name: modelId,
        label: `Hermes · ${labelName}`,
        provider: provider || 'hermes',
        vision,
        steer: true,
      });
    }

    return out;
  } catch {
    return [];
  }
}
