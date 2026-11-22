import { describe, it, expect } from 'vitest';
import {
  parseStages,
  resolveStages,
  renderPipelineSection,
  checkPipelineRoles,
  autoMatchStageRoles,
  fillStageRoles,
  sanitiseRoleMatchKeywords,
  DEFAULT_ROLE_MATCH_KEYWORDS,
  ROLE_MATCH_MAX_STAGES,
  ROLE_MATCH_MAX_KEYWORDS,
  BUILTIN_STAGE_FUNCTIONS,
  PIPELINE_MAX_STAGES,
} from './pipeline.js';

const ROSTER = [
  { role: 'Claude Opus 5.5', when: 'Use this as primary planner for specs or planning before other options' },
  { role: 'Grok 4.6', when: 'Use this as primary implementer for code implementations before other options' },
  { role: 'GLM-5.3', when: 'The operator specifically asks for the model. This model is disabled for automatic selection.' },
  { role: 'Haiku', when: 'Use whenever you need to do quick research tasks' },
  { role: 'Cursor Opus', when: 'Use this as secondary planner if the primary planner is unavailable' },
  { role: 'Cursor Grok 4.6', when: 'Use this as secondary implementer if the primary implementer is unavailable' },
  { role: 'Antigravity Flash', when: 'Use for medium difficulty inplementation and for ui tasks' },
  { role: 'Cursor Composer', when: 'Use when you have a detailed plan and implementation is easier' },
  { role: 'Grok build Grok 4.5', when: 'Use this as implementer for code implementations if the user requests it specifically' },
];

describe('parseStages', () => {
  it('parses valid comma-separated stage ids', () => {
    const res = parseStages('plan,implement');
    expect(res).toEqual({ ok: true, ids: ['plan', 'implement'] });
  });

  it('trims whitespace around stage ids', () => {
    const res = parseStages('  plan ,  implement , review  ');
    expect(res).toEqual({ ok: true, ids: ['plan', 'implement', 'review'] });
  });

  it('returns error on undefined or empty string', () => {
    expect(parseStages(undefined).ok).toBe(false);
    expect(parseStages('').ok).toBe(false);
    expect(parseStages('   ').ok).toBe(false);
  });

  it('returns error on duplicate stage ids', () => {
    const res = parseStages('plan,implement,plan');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/duplicate stage id "plan"/);
    }
  });

  it('returns error when exceeding PIPELINE_MAX_STAGES (8)', () => {
    const nineStages = 's1,s2,s3,s4,s5,s6,s7,s8,s9';
    const res = parseStages(nineStages);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/too many stages \(got 9, max 8\)/);
    }
  });

  it('allows exactly 8 stages', () => {
    const eightStages = 's1,s2,s3,s4,s5,s6,s7,s8';
    const res = parseStages(eightStages);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ids).toHaveLength(8);
    }
  });

  it('rejects invalid stage ids', () => {
    expect(parseStages('Plan').ok).toBe(false);
    expect(parseStages('1x').ok).toBe(false);
    expect(parseStages('a-b').ok).toBe(false);
    expect(parseStages('stage_one').ok).toBe(false);
    expect(parseStages('a'.repeat(25)).ok).toBe(false);
    expect(parseStages('plan,,implement').ok).toBe(false);
  });
});

describe('resolveStages', () => {
  it('uses default stages when stages variable is missing or empty', () => {
    const res = resolveStages({});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stages.map((s) => s.id)).toEqual(['plan', 'implement', 'review']);
      expect(res.commit).toBe(true);
    }
  });

  it('marks stages as skipped when role is empty, none or NONE', () => {
    const res = resolveStages({
      stages: 'plan,implement,review',
      planRole: '',
      implementRole: 'none',
      reviewRole: 'NONE',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stages[0].skipped).toBe(true);
      expect(res.stages[0].role).toBeNull();
      expect(res.stages[1].skipped).toBe(true);
      expect(res.stages[1].role).toBeNull();
      expect(res.stages[2].skipped).toBe(true);
      expect(res.stages[2].role).toBeNull();
    }
  });

  it('uses builtin functions for known ids when function is empty', () => {
    const res = resolveStages({
      stages: 'plan,implement,review,test',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stages[0].fn).toBe(BUILTIN_STAGE_FUNCTIONS.plan);
      expect(res.stages[1].fn).toBe(BUILTIN_STAGE_FUNCTIONS.implement);
      expect(res.stages[2].fn).toBe(BUILTIN_STAGE_FUNCTIONS.review);
      expect(res.stages[3].fn).toBe(BUILTIN_STAGE_FUNCTIONS.test);
    }
  });

  it('uses (no function set) for unknown ids when function is empty', () => {
    const res = resolveStages({
      stages: 'custom',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stages[0].fn).toBe('(no function set)');
    }
  });

  it('preserves custom role and function', () => {
    const res = resolveStages({
      stages: 'custom',
      customRole: 'Custom Role',
      customFunction: 'Do custom things',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stages[0].skipped).toBe(false);
      expect(res.stages[0].role).toBe('Custom Role');
      expect(res.stages[0].fn).toBe('Do custom things');
    }
  });

  it('does not resolve builtin function via prototype for stage id constructor', () => {
    const res = resolveStages({
      stages: 'constructor',
      constructorRole: 'X',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stages[0].id).toBe('constructor');
      expect(res.stages[0].role).toBe('X');
      expect(res.stages[0].fn).toBe('(no function set)');
    }
  });

  it('handles commitOnTick correctly', () => {
    expect(resolveStages({}).ok && (resolveStages({}) as any).commit).toBe(true);
    expect(resolveStages({ commitOnTick: 'true' }).ok && (resolveStages({ commitOnTick: 'true' }) as any).commit).toBe(true);
    expect(resolveStages({ commitOnTick: 'false' }).ok && (resolveStages({ commitOnTick: 'false' }) as any).commit).toBe(false);
    expect(resolveStages({ commitOnTick: 'invalid' }).ok).toBe(false);
  });
});

describe('renderPipelineSection', () => {
  it('renders markdown table correctly with skipped stages and commitOnTick', () => {
    const out = renderPipelineSection({
      stages: 'plan,implement,translate,review',
      planRole: 'Claude Opus 5.5',
      implementRole: 'Antigravity Flash 3.8',
      translateRole: 'none',
      reviewRole: 'Claude Opus 5.5',
      commitOnTick: 'true',
    });

    expect(out).toContain('## Pipeline Stages & Role Functions');
    expect(out).toContain('| # | stage | role (spawn this exact roster name) | function |');
    expect(out).toContain('| 1 | plan | Claude Opus 5.5 | Write a plan file');
    expect(out).toContain('| 2 | implement | Antigravity Flash 3.8 | Implement the selected row');
    expect(out).toContain('| 3 | translate | — skipped (role none) | — |');
    expect(out).toContain('| 4 | review | Claude Opus 5.5 | Adversarially review');
    expect(out).toContain('Commit on tick: **yes** — after the last stage passes, commit once (`type(scope): subject`, exact paths).');
  });

  it('renders commitOnTick no when commitOnTick is false', () => {
    const out = renderPipelineSection({
      stages: 'implement',
      implementRole: 'Grok 4.6',
      commitOnTick: 'false',
    });
    expect(out).toContain('Commit on tick: **no** — do NOT commit; leave changes in the working tree and list them in your summary.');
  });

  it('returns not configured message on invalid stages without throwing', () => {
    const out = renderPipelineSection({
      stages: 'Plan,implement',
    });
    expect(out).toMatch(/^Pipeline: not configured \(invalid stage id "Plan"/);
  });

  it('never throws on empty object', () => {
    expect(() => renderPipelineSection({})).not.toThrow();
    const out = renderPipelineSection({});
    expect(out).toContain('## Pipeline Stages & Role Functions');
    expect(out).toContain('| 1 | plan | — skipped (role none) | — |');
  });

  it('collapses newlines and escapes pipes so a function cannot forge extra table rows', () => {
    const out = renderPipelineSection({
      stages: 'custom',
      customRole: 'Role',
      customFunction: 'a\n| 9 | evil | x | y |',
    });
    const dataRows = out.split('\n').filter((line) => /^\| \d+ \|/.test(line));
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]).not.toMatch(/\n/);
    expect(dataRows[0]).toContain('\\|');
    expect(dataRows[0]).not.toMatch(/[^\\]\| 9 \|/);
    expect(out).not.toMatch(/\n\| 9 \|/);
  });
});

describe('checkPipelineRoles', () => {
  const templateRoles = ['Claude Opus 5.5', 'Antigravity Flash 3.8', 'Reviewer'];

  it('succeeds when all roles exist in template', () => {
    const vars = {
      stages: 'plan,implement,review',
      planRole: 'Claude Opus 5.5',
      implementRole: 'Antigravity Flash 3.8',
      reviewRole: 'Reviewer',
    };
    const res = checkPipelineRoles(vars, templateRoles, ['implement']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.notes).toHaveLength(0);
      expect(res.vars.implementRole).toBe('Antigravity Flash 3.8');
    }
  });

  it('fails when a required stage role is missing from template', () => {
    const vars = {
      stages: 'implement',
      implementRole: 'Unknown Role',
    };
    const res = checkPipelineRoles(vars, templateRoles, ['implement']);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("required stage 'implement' role 'Unknown Role' not in template roles");
    }
  });

  it('fails when a required stage is skipped or has role none', () => {
    const vars = {
      stages: 'implement',
      implementRole: 'none',
    };
    const res = checkPipelineRoles(vars, templateRoles, ['implement']);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("required stage 'implement' is skipped");
    }
  });

  it('fails when a required stage is omitted from stages', () => {
    const vars = {
      stages: 'plan,review',
      planRole: 'Claude Opus 5.5',
      reviewRole: 'Reviewer',
    };
    const res = checkPipelineRoles(vars, templateRoles, ['implement']);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("required stage 'implement' not in stages list");
    }
  });

  it('sets optional stage role to none and adds note when role not in template', () => {
    const vars = {
      stages: 'plan,implement,review',
      planRole: 'Unknown Planner',
      implementRole: 'Antigravity Flash 3.8',
      reviewRole: 'Reviewer',
    };
    const res = checkPipelineRoles(vars, templateRoles, ['implement']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.vars.planRole).toBe('none');
      expect(res.vars.implementRole).toBe('Antigravity Flash 3.8');
      expect(res.notes).toContain("stage 'plan' skipped at apply: role 'Unknown Planner' not in template");
    }
  });
});

describe('autoMatchStageRoles', () => {
  it('picks primary planner and implementer; review is unmatched', () => {
    const matched = autoMatchStageRoles(['plan', 'implement', 'review'], ROSTER);
    expect(matched.plan).toBe('Claude Opus 5.5');
    expect(matched.implement).toBe('Grok 4.6');
    expect(matched.review).toBeUndefined();
  });

  it('prefers a plain implement match over a secondary, and never picks opt-out', () => {
    const withoutGrok = ROSTER.filter((r) => r.role !== 'Grok 4.6');
    const matched = autoMatchStageRoles(['implement'], withoutGrok);
    expect(matched.implement).toBe('Cursor Composer');
  });

  it('picks secondary implementer when the only other candidate opted out', () => {
    const roster = ROSTER.filter((r) =>
      r.role === 'Cursor Grok 4.6' || r.role === 'Grok build Grok 4.5',
    );
    const matched = autoMatchStageRoles(['implement'], roster);
    expect(matched.implement).toBe('Cursor Grok 4.6');
  });

  it('falls back to a role-name hit', () => {
    const matched = autoMatchStageRoles(['review'], [{ role: 'Reviewer', when: 'anything' }]);
    expect(matched.review).toBe('Reviewer');
  });

  it('breaks ties by template order', () => {
    const roster = [
      { role: 'First Coder', when: 'implement features' },
      { role: 'Second Coder', when: 'implement features' },
    ];
    const matched = autoMatchStageRoles(['implement'], roster);
    expect(matched.implement).toBe('First Coder');
  });

  it('does not treat a substring inside another word as a plan hit', () => {
    const matched = autoMatchStageRoles(['plan'], [{ role: 'Explainer', when: 'explanation only' }]);
    expect(matched.plan).toBeUndefined();
  });

  it('uses custom keywords as a replacement, not a merge, and falls back to the stage id', () => {
    const docs = autoMatchStageRoles(
      ['docs'],
      [{ role: 'Docs Bot', when: 'primary documentation writer' }],
      { docs: ['documentation'] },
    );
    expect(docs.docs).toBe('Docs Bot');

    const research = autoMatchStageRoles(
      ['research'],
      [{ role: 'Haiku', when: 'Use whenever you need to do quick research tasks' }],
    );
    expect(research.research).toBe('Haiku');

    const rustOnly = autoMatchStageRoles(
      ['implement'],
      [{ role: 'Grok 4.6', when: 'Use this as primary implementer for code implementations' }],
      { implement: ['rust'] },
    );
    expect(rustOnly.implement).toBeUndefined();
  });

  it('does not throw when a keyword contains regex metacharacters', () => {
    expect(() => autoMatchStageRoles(
      ['implement'],
      [{ role: 'PlusPlus', when: 'c++ expert' }],
      { implement: ['c++'] },
    )).not.toThrow();
  });

  it('skips empty role names', () => {
    const matched = autoMatchStageRoles(['implement'], [
      { role: '  ', when: 'primary implementer' },
      { role: 'Real', when: 'implementer' },
    ]);
    expect(matched.implement).toBe('Real');
  });
});

describe('fillStageRoles', () => {
  it('fills blank implementRole and notes the match', () => {
    const res = fillStageRoles({ stages: 'implement' }, ROSTER);
    expect(res.vars.implementRole).toBe('Grok 4.6');
    expect(res.notes).toContain("stage 'implement' → 'Grok 4.6' (auto-matched)");
  });

  it('leaves explicit none and explicit role names untouched', () => {
    const none = fillStageRoles({ stages: 'implement', implementRole: 'none' }, ROSTER);
    expect(none.vars.implementRole).toBe('none');
    expect(none.notes).toHaveLength(0);

    const explicit = fillStageRoles({ stages: 'implement', implementRole: 'Foo' }, ROSTER);
    expect(explicit.vars.implementRole).toBe('Foo');
    expect(explicit.notes).toHaveLength(0);
  });

  it('sets unmatched stages to none with a skip note', () => {
    const res = fillStageRoles({ stages: 'review' }, ROSTER);
    expect(res.vars.reviewRole).toBe('none');
    expect(res.notes).toContain("stage 'review' skipped: no template delegate matched");
  });

  it('returns vars unchanged when stages cannot be parsed', () => {
    const vars = { stages: 'Plan,implement' };
    const res = fillStageRoles(vars, ROSTER);
    expect(res.vars).toEqual(vars);
    expect(res.notes).toHaveLength(0);
  });
});

describe('sanitiseRoleMatchKeywords', () => {
  it('lowercases and dedupes keywords', () => {
    const r = sanitiseRoleMatchKeywords({ implement: ['Code', ' code ', 'CODE'] });
    expect(r).toEqual({ ok: true, value: { implement: ['code'] } });
  });

  it('accepts an empty keyword array', () => {
    const r = sanitiseRoleMatchKeywords({ implement: [] });
    expect(r).toEqual({ ok: true, value: { implement: [] } });
  });

  it('rejects a bad stage key', () => {
    const r = sanitiseRoleMatchKeywords({ 'Bad-Id': ['code'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^roleMatchKeywords/);
  });

  it('rejects constructor', () => {
    const r = sanitiseRoleMatchKeywords({ constructor: ['code'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^roleMatchKeywords/);
  });

  it('rejects more than ROLE_MATCH_MAX_STAGES keys', () => {
    const tooMany: Record<string, string[]> = {};
    for (let i = 0; i < ROLE_MATCH_MAX_STAGES + 1; i++) tooMany[`s${i}`] = ['x'];
    const r = sanitiseRoleMatchKeywords(tooMany);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^roleMatchKeywords/);
  });

  it('rejects more than ROLE_MATCH_MAX_KEYWORDS after dedupe', () => {
    const kws = Array.from({ length: ROLE_MATCH_MAX_KEYWORDS + 1 }, (_, i) => `k${i}`);
    const r = sanitiseRoleMatchKeywords({ implement: kws });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^roleMatchKeywords/);
  });

  it('rejects a non-string keyword and a keyword with punctuation', () => {
    expect(sanitiseRoleMatchKeywords({ implement: [1] as unknown as string[] }).ok).toBe(false);
    const bad = sanitiseRoleMatchKeywords({ implement: ['bad!kw'] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^roleMatchKeywords/);
  });

  it('rejects a non-object root', () => {
    expect(sanitiseRoleMatchKeywords(null).ok).toBe(false);
    expect(sanitiseRoleMatchKeywords([]).ok).toBe(false);
  });

  it('exports the default keyword map used by the engine', () => {
    expect(DEFAULT_ROLE_MATCH_KEYWORDS.implement).toContain('implementer');
    expect(DEFAULT_ROLE_MATCH_KEYWORDS.plan).toContain('planner');
    expect(DEFAULT_ROLE_MATCH_KEYWORDS.review).toContain('reviewer');
  });
});
