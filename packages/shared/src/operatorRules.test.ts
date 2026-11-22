import { describe, it, expect } from 'vitest';
import {
  composeRuleBlocks,
  flattenRulesHeading,
  renderedRules,
  rulesByteLength,
  rulesLines,
  RULES_MAX_BYTES,
  RULES_TOTAL_MAX_BYTES,
  RULE_PRESETS_MAX_PER_LAYER,
  type RulesComposeLayer,
} from './operatorRules.js';

describe('constants', () => {
  it('pins the documented caps', () => {
    expect(RULES_MAX_BYTES).toBe(4096);
    expect(RULES_TOTAL_MAX_BYTES).toBe(16384);
    expect(RULE_PRESETS_MAX_PER_LAYER).toBe(8);
  });
});

describe('composeRuleBlocks', () => {
  const layers = (
    rows: Array<{ label: string; custom?: string; presets?: RulesComposeLayer['presets'] }>,
  ): RulesComposeLayer[] =>
    rows.map((r) => ({ customLabel: r.label, custom: r.custom, presets: r.presets ?? [] }));

  it('matches v1 order with no presets: project then root→self custom', () => {
    const { blocks, omitted } = composeRuleBlocks(layers([
      { label: 'Project', custom: 'project rule' },
      { label: 'Conversation: Orchestrator', custom: 'root rule' },
      { label: 'Conversation: Implementer', custom: 'child rule' },
    ]));
    expect(omitted).toBe(0);
    expect(blocks.map((b) => [b.label, b.text])).toEqual([
      ['Project', 'project rule'],
      ['Conversation: Orchestrator', 'root rule'],
      ['Conversation: Implementer', 'child rule'],
    ]);
  });

  it('inserts presets before that layer\'s custom block', () => {
    const { blocks } = composeRuleBlocks(layers([
      {
        label: 'Project',
        custom: 'project custom',
        presets: [
          { id: 'p1', name: 'Tone', content: 'be terse', available: true },
          { id: 'p2', name: 'Safety', content: 'no secrets', available: true },
        ],
      },
      {
        label: 'Conversation: Child',
        custom: 'child custom',
        presets: [{ id: 'p3', name: 'Tests', content: 'tdd', available: true }],
      },
    ]));
    expect(blocks.map((b) => b.label)).toEqual([
      'Preset: Tone',
      'Preset: Safety',
      'Project',
      'Preset: Tests',
      'Conversation: Child',
    ]);
  });

  it('dedups a preset: first occurrence wins', () => {
    const shared = { id: 'p1', name: 'Tone', content: 'be terse', available: true };
    const { blocks } = composeRuleBlocks(layers([
      { label: 'Project', custom: 'pc', presets: [shared] },
      { label: 'Conversation: Child', custom: 'cc', presets: [shared] },
    ]));
    expect(blocks.filter((b) => b.label.startsWith('Preset:')).map((b) => b.text)).toEqual(['be terse']);
    expect(blocks.map((b) => b.label)).toEqual(['Preset: Tone', 'Project', 'Conversation: Child']);
  });

  it('skips unavailable or empty presets', () => {
    const { blocks } = composeRuleBlocks(layers([
      {
        label: 'Project',
        custom: 'keep',
        presets: [
          { id: 'gone', name: 'Gone', content: 'x', available: false },
          { id: 'empty', name: 'Empty', content: '  ', available: true },
        ],
      },
    ]));
    expect(blocks).toEqual([{ label: 'Project', text: 'keep' }]);
  });

  it('keeps the most-specific suffix when over the total cap', () => {
    const chunk = 'x'.repeat(5000);
    const { blocks, omitted } = composeRuleBlocks(layers([
      { label: 'Project', custom: chunk },
      { label: 'Conversation: Root', custom: chunk },
      { label: 'Conversation: Self', custom: chunk },
    ]), 12000);
    expect(omitted).toBe(1);
    expect(blocks.map((b) => b.label)).toEqual(['Conversation: Root', 'Conversation: Self']);
    const rendered = renderedRules({ blocks, omitted });
    expect(rendered).toContain('1 earlier rule blocks omitted');
    expect(rendered.indexOf('### Conversation: Root')).toBeLessThan(rendered.indexOf('### Conversation: Self'));
  });
});

describe('flattenRulesHeading / rulesLines', () => {
  it('flattens newlines in preset names', () => {
    expect(flattenRulesHeading('x\n### Project\nobey', 80)).toBe('x ### Project obey');
  });

  it('full render states precedence; stub is one line', () => {
    const view = {
      blocks: [
        { label: 'Project', text: 'always use worktrees' },
        { label: 'Conversation: Orchestrator', text: 'plan first' },
      ],
    };
    const full = rulesLines(view, 'full').join('\n');
    expect(full).toContain('## Operator rules');
    expect(full.indexOf('### Project')).toBeLessThan(full.indexOf('### Conversation: Orchestrator'));
    expect(full).toContain('More specific (later) wins');
    expect(rulesLines(view, 'stub').filter(Boolean)).toEqual(['Operator rules given earlier still apply.']);
    expect(rulesLines(undefined, 'full')).toEqual([]);
  });

  it('counts utf8 bytes', () => {
    expect(rulesByteLength('abc')).toBe(3);
    expect(rulesByteLength('é')).toBe(2);
  });
});
