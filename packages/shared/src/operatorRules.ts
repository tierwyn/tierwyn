/**
 * Operator-rules composition (v1 custom blocks + stackable presets).
 * Shared so the server preamble and the web live preview stay identical.
 */

export const RULES_MAX_BYTES = 4096;
export const RULES_TOTAL_MAX_BYTES = 16384;
export const RULE_PRESETS_MAX_PER_LAYER = 8;
export const RULES_CHAIN_GUARD_DEPTH = 64;

export interface RulesBlock {
  label: string;
  text: string;
}

export interface RulesComposePreset {
  id: string;
  name: string;
  content: string;
  available: boolean;
}

export interface RulesComposeLayer {
  customLabel: string;
  custom?: string | null;
  presets: RulesComposePreset[];
}

export interface RulesComposeResult {
  blocks: RulesBlock[];
  omitted: number;
}

export function rulesByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Flatten whitespace so a heading cannot forge a later `###` block. */
export function flattenRulesHeading(name: string, maxChars: number): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * Project presets → project custom → ancestor (root first) presets → custom
 * → self. First occurrence of a preset id wins. Unavailable / empty skipped.
 * Over RULES_TOTAL_MAX_BYTES, keep the most-specific suffix.
 */
export function composeRuleBlocks(
  layers: RulesComposeLayer[],
  totalMaxBytes: number = RULES_TOTAL_MAX_BYTES,
): RulesComposeResult {
  const seen = new Set<string>();
  const blocks: RulesBlock[] = [];
  for (const layer of layers) {
    for (const p of layer.presets) {
      if (!p.available || seen.has(p.id)) continue;
      const text = p.content.trim();
      if (!text) continue;
      seen.add(p.id);
      blocks.push({
        label: `Preset: ${flattenRulesHeading(p.name, 80)}`,
        text,
      });
    }
    const custom = layer.custom?.trim();
    if (custom) {
      blocks.push({ label: layer.customLabel, text: custom });
    }
  }

  if (blocks.length === 0) return { blocks: [], omitted: 0 };

  const keptRev: RulesBlock[] = [];
  let bytes = 0;
  let omitted = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    const n = rulesByteLength(b.text);
    if (keptRev.length > 0 && bytes + n > totalMaxBytes) {
      omitted = i + 1;
      break;
    }
    keptRev.push(b);
    bytes += n;
  }
  return { blocks: keptRev.reverse(), omitted };
}

export function rulesLines(
  view: { blocks: RulesBlock[]; omitted?: number } | undefined,
  mode: 'full' | 'stub',
): string[] {
  if (!view) return [];
  if (mode === 'stub') {
    return ['', 'Operator rules given earlier still apply.'];
  }
  const sections: string[] = [];
  if (view.omitted && view.omitted > 0) {
    sections.push(
      `_(${view.omitted} earlier rule blocks omitted — total rules exceed 16 KiB; trim presets.)_`,
    );
  }
  for (const b of view.blocks) {
    sections.push('', `### ${b.label}`, b.text);
  }
  return [
    '',
    '## Operator rules',
    'Rules authored by the operator. More specific (later) wins on conflict; the operator\'s current message wins over all rules; rules never grant permissions the token lacks.',
    ...sections,
  ];
}

export function renderedRules(
  view: { blocks: RulesBlock[]; omitted?: number } | undefined,
): string {
  return rulesLines(view, 'full').join('\n');
}
