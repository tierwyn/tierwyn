import { describe, it, expect } from 'vitest';
import {
  PACK_FILE_MAX_BYTES,
  PACK_PROMPT_MAX_BYTES,
  PACK_STEPS_MAX,
  validateSchedulePack,
  type SchedulePack,
} from '@tierwyn/shared';
import { SHIPPED_PACKS } from './index.js';

/** Built-in apply-time tokens the server always supplies (spec §6.3). */
const BUILTIN_TOKENS = ['goal', 'jobName', 'slug', 'jobSlug', 'projectRoot', 'timezone', 'pipelineNotes'];

/** Every string a pack ships that goes through apply-time [[token]] substitution. */
function bodiesOf(pack: SchedulePack): string[] {
  const out = [pack.job.promptTemplate];
  if (pack.job.steer) out.push(pack.job.steer);
  for (const s of pack.job.steps ?? []) out.push(s.title, s.body);
  for (const f of pack.files ?? []) out.push(f.body);
  return out;
}

function tokensIn(text: string): string[] {
  return [...text.matchAll(/\[\[([a-zA-Z0-9_]+)\]\]/g)].map((m) => m[1]);
}

describe('shipped schedule packs', () => {
  it('ships the seven documented slugs, each once', () => {
    const slugs = SHIPPED_PACKS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.sort()).toEqual(
      [
        'docs-campaign',
        'feature-wave',
        'fix-from-failure',
        'phased-feature',
        'pr-review',
        'single-pr-feature',
        'verify-after-change',
      ].sort(),
    );
  });

  for (const pack of SHIPPED_PACKS) {
    describe(pack.slug, () => {
      it('passes validateSchedulePack', () => {
        const res = validateSchedulePack(pack);
        expect(res.ok ? '' : res.error).toBe('');
        expect(res.ok).toBe(true);
      });

      it('keeps promptTemplate under the tick-prompt ceiling', () => {
        const bytes = Buffer.byteLength(pack.job.promptTemplate, 'utf8');
        expect(bytes).toBeLessThanOrEqual(PACK_PROMPT_MAX_BYTES);
        expect(bytes).toBeGreaterThan(200); // not a stub
      });

      it('has at most AGENT_STEPS_MAX steps', () => {
        expect(pack.job.steps?.length ?? 0).toBeLessThanOrEqual(PACK_STEPS_MAX);
      });

      it('declares each file kind at most once', () => {
        const kinds = (pack.files ?? []).map((f) => f.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
      });

      it('uses only built-in or declared [[tokens]]', () => {
        const declared = (pack.applyFields ?? []).map((f) => f.key);
        const known = new Set([...BUILTIN_TOKENS, ...declared]);
        const used = new Set(bodiesOf(pack).flatMap(tokensIn));
        expect([...used].filter((t) => !known.has(t))).toEqual([]);
      });

      it('never hardcodes a file stem as the pack slug', () => {
        // Paths in prose must be derived from the job name, so a pack can be applied twice.
        for (const body of bodiesOf(pack)) {
          expect(body).not.toContain(`.tierwyn/schedule/${pack.slug}-`);
        }
      });

      it('declares no frozen credentials or external targets', () => {
        for (const body of bodiesOf(pack)) {
          expect(body).not.toMatch(/telegram:/i);
          expect(body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
        }
      });
    });
  }

  it('feature-wave ships both mode sections behind one header line', () => {
    const prompt = SHIPPED_PACKS.find((p) => p.slug === 'feature-wave')!.files!.find(
      (f) => f.kind === 'prompt',
    )!.body;
    expect(prompt).toContain('**Active mode: [[mode]]**');
    expect(prompt).toContain('### Mode: closed');
    expect(prompt).toContain('### Mode: open-propose');
  });

  it('feature-wave v4 has single-schedule pipeline architecture and no schedule minting', () => {
    const pack = SHIPPED_PACKS.find((p) => p.slug === 'feature-wave')!;
    expect(pack.version).toBe(4);
    expect(pack.requiredStages).toEqual(['implement']);
    expect(pack.job.promptTemplate).toContain('{{pipeline}}');
    expect(pack.job.steer).toBeUndefined();
    expect(pack.job.variables).toEqual({
      stages: 'plan,implement,review',
      commitOnTick: 'true',
      mode: 'closed',
    });

    const val = validateSchedulePack(pack);
    expect(val.ok ? '' : val.error).toBe('');
    expect(val.ok).toBe(true);

    for (const body of bodiesOf(pack)) {
      expect(body).not.toContain('schedules/agent');
      expect(body).not.toContain('POST …/schedules/agent');
      expect(body).not.toMatch(/POST\s+[^\n]*\/schedules/);
    }
  });

  it('docs-campaign is a one-step evergreen pack with all four files', () => {
    const pack = SHIPPED_PACKS.find((p) => p.slug === 'docs-campaign')!;
    expect(validateSchedulePack(pack).ok).toBe(true);
    expect(pack.job.steps).toHaveLength(1);
    expect(pack.requiresTemplate).toBe(false);
    expect((pack.files ?? []).map((f) => f.kind).sort()).toEqual([
      'README',
      'progress',
      'prompt',
      'roster',
    ]);
    for (const f of pack.files ?? []) {
      expect(Buffer.byteLength(f.body, 'utf8')).toBeLessThanOrEqual(PACK_FILE_MAX_BYTES);
    }
    // The slice table, the roster gate and the harness are the pack's whole point.
    const prompt = pack.files!.find((f) => f.kind === 'prompt')!.body;
    for (const slice of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      expect(prompt).toContain(`**${slice}**`);
    }
    expect(prompt).toContain('STOP procedure');
    expect(pack.files!.find((f) => f.kind === 'roster')!.body).toContain('| Operator |');
  });

  it('evergreen-step packs tell the tick to PATCH its step back to ready', () => {
    // A body-only patch leaves the step `running`, which selectCurrentStep skips —
    // the job would stall. The status is the load-bearing half of the instruction.
    for (const slug of ['feature-wave', 'docs-campaign']) {
      const pack = SHIPPED_PACKS.find((p) => p.slug === slug)!;
      expect(pack.job.steps).toHaveLength(1);
      const prompt = pack.files!.find((f) => f.kind === 'prompt')!.body;
      expect(prompt).toContain('## Step heartbeat');
      expect(prompt).toContain('"status": "ready"');
    }
  });

  it('the two file-writing packs point at their prompt file instead of inlining policy', () => {
    for (const slug of ['phased-feature', 'feature-wave']) {
      const pack = SHIPPED_PACKS.find((p) => p.slug === slug)!;
      expect(pack.job.promptTemplate).toContain('[[jobSlug]]-prompt.md');
      // Pointer templates still carry tick-time tokens the server substitutes each fire.
      expect(pack.job.promptTemplate).toContain('{{step.title}}');
    }
  });

  it('retunable applyFields are fire-time {{vars}} in promptTemplate or steer', () => {
    // Apply seeds job.variables for packVars keys referenced as {{vars.<key>}}
    // in the envelope, or handled by pipeline seeding (like commitOnTick which is
    // rendered directly by {{pipeline}}). Baking them as [[tokens]] instead means
    // the operator cannot retune from Variables.
    const pipelineKeys = new Set(['commitOnTick']);
    for (const pack of SHIPPED_PACKS) {
      const envelope = `${pack.job.promptTemplate}\n${pack.job.steer ?? ''}`;
      for (const field of pack.applyFields ?? []) {
        if (pipelineKeys.has(field.key)) continue;
        expect(
          envelope.includes(`{{vars.${field.key}}}`),
          `${pack.slug} applyField '${field.key}' must appear as {{vars.${field.key}}} in promptTemplate or steer`,
        ).toBe(true);
      }
    }
  });
});
