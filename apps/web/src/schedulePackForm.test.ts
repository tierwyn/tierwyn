import { describe, it, expect } from 'vitest';
import type { ScheduleJobDetail, SchedulePack, SchedulePackCadence } from '@tierwyn/shared';
import { validateSchedulePack } from '@tierwyn/shared';
import {
  cadenceToFormState,
  formStateToCreateBody,
  jobToPackDoc,
  slugFromJobName,
  spawnCapRemedy,
  packApplyToastMessage,
  INTERVAL_PACK_DISABLED_TOAST,
  BLANK_JOB_PROMPT,
  type ScheduleCreateFormState,
} from './schedulePackForm.js';

const NOW = 1_700_000_000_000;

function blankState(over: Partial<ScheduleCreateFormState> = {}): ScheduleCreateFormState {
  return {
    name: 'Nightly digest',
    timezone: 'UTC',
    kind: 'interval',
    everyMs: 86_400_000,
    cronExpr: '0 9 * * *',
    fireInMs: 3_600_000,
    profileId: 'claude-code:opus-4.8',
    promptTemplate: '',
    steer: '',
    workdir: 'shared',
    templateName: '',
    packSlug: '',
    goal: '',
    packVars: {},
    ...over,
  };
}

function sampleJob(over: Partial<ScheduleJobDetail> = {}): ScheduleJobDetail {
  return {
    id: 'j1',
    projectId: 'p1',
    name: '[feature-wave] Evolve wave',
    enabled: true,
    archived: false,
    timezone: 'Europe/London',
    scheduleKind: 'interval',
    scheduleExpr: '{"everyMs":86400000}',
    overlapPolicy: 'skip',
    executionMode: 'spawn_child',
    profileId: 'claude-code:opus-4.8',
    homeConversationId: 'h1',
    promptTemplate: 'Read the roster and mint one job.',
    steer: 'Implementer for minted one-shot jobs: profileId `p`, templateName `t`.',
    runTimeoutMs: 1_800_000,
    nextFireAt: NOW + 86_400_000,
    agentMayComplete: true,
    carryContextEnabled: true,
    workdir: 'shared',
    templateName: 'Tierwyn implementer',
    createdBy: 'operator',
    createdAt: NOW,
    updatedAt: NOW,
    steps: [
      {
        id: 's1',
        jobId: 'j1',
        ordinal: 0,
        title: 'Wave tick',
        body: 'Reconcile, mint, propose.',
        status: 'ready',
        updatedAt: NOW,
      },
    ],
    stepProgress: { done: 0, total: 1 },
    ...over,
  };
}

describe('cadenceToFormState', () => {
  it('maps interval cadence to everyMs', () => {
    const cadence: SchedulePackCadence = { kind: 'interval', everyMs: 86_400_000 };
    const state = cadenceToFormState(cadence);
    expect(state.kind).toBe('interval');
    expect(state.everyMs).toBe(86_400_000);
  });

  it('maps cron cadence to expr', () => {
    const state = cadenceToFormState({ kind: 'cron', expr: '0 6 * * 1' });
    expect(state.kind).toBe('cron');
    expect(state.cronExpr).toBe('0 6 * * 1');
  });

  it('maps once cadence to fireInMs', () => {
    const state = cadenceToFormState({ kind: 'once', fireInMs: 900_000 });
    expect(state.kind).toBe('once');
    expect(state.fireInMs).toBe(900_000);
  });
});

describe('formStateToCreateBody — Blank job', () => {
  it('is byte-identical to the pre-pack Sidebar payload', () => {
    const body = formStateToCreateBody(blankState());
    const expected = {
      name: 'Nightly digest',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: '{"everyMs":86400000}',
      profileId: 'claude-code:opus-4.8',
      promptTemplate: BLANK_JOB_PROMPT,
      workdir: 'shared',
      steps: [{ title: 'Step 1', body: 'Describe the work for this step.' }],
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(expected));
  });

  it('falls back empty prompt to the standing stub', () => {
    const body = formStateToCreateBody(blankState({ promptTemplate: '   ' }));
    expect(body.promptTemplate).toBe(BLANK_JOB_PROMPT);
  });

  it('keeps a typed prompt', () => {
    const body = formStateToCreateBody(blankState({ promptTemplate: 'Do the thing.' }));
    expect(body.promptTemplate).toBe('Do the thing.');
  });

  it('omits steer and templateName when empty, includes them when set', () => {
    const empty = formStateToCreateBody(blankState());
    expect(empty).not.toHaveProperty('steer');
    expect(empty).not.toHaveProperty('templateName');
    expect(empty).not.toHaveProperty('packSlug');
    expect(empty).not.toHaveProperty('goal');
    expect(empty).not.toHaveProperty('packVars');
    expect(empty).not.toHaveProperty('enabled');

    const filled = formStateToCreateBody(blankState({
      steer: '  focus on tests  ',
      templateName: 'Tierwyn implementer',
    }));
    expect(filled.steer).toBe('focus on tests');
    expect(filled.templateName).toBe('Tierwyn implementer');
    const expected = {
      name: 'Nightly digest',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: '{"everyMs":86400000}',
      profileId: 'claude-code:opus-4.8',
      promptTemplate: BLANK_JOB_PROMPT,
      steer: 'focus on tests',
      workdir: 'shared',
      templateName: 'Tierwyn implementer',
      steps: [{ title: 'Step 1', body: 'Describe the work for this step.' }],
    };
    expect(JSON.stringify(filled)).toBe(JSON.stringify(expected));
  });

  it('serialises cron as the raw expression', () => {
    const body = formStateToCreateBody(blankState({
      kind: 'cron',
      cronExpr: '0 9 * * *',
    }));
    expect(body.scheduleKind).toBe('cron');
    expect(body.scheduleExpr).toBe('0 9 * * *');
    expect(body.steps).toEqual([{ title: 'Step 1', body: 'Describe the work for this step.' }]);
  });

  it('serialises once as {"atMs": now + fireInMs}', () => {
    const body = formStateToCreateBody(blankState({
      kind: 'once',
      fireInMs: 900_000,
    }), NOW);
    expect(body.scheduleKind).toBe('once');
    expect(body.scheduleExpr).toBe(JSON.stringify({ atMs: NOW + 900_000 }));
  });
});

describe('formStateToCreateBody — resume_conversation', () => {
  it('emits executionMode + boundConversationId and omits steps/workdir/templateName', () => {
    const body = formStateToCreateBody(blankState({
      executionMode: 'resume_conversation',
      boundConversationId: 'conv-bound',
      profileId: 'inherit',
      promptTemplate: 'Ping the chat',
      packSlug: 'evolve-wave',
      templateName: 'delegate',
      workdir: 'worktree',
      goal: 'ship it',
    }));
    expect(body.executionMode).toBe('resume_conversation');
    expect(body.boundConversationId).toBe('conv-bound');
    expect(body.profileId).toBe('inherit');
    expect(body.promptTemplate).toBe('Ping the chat');
    expect(body).not.toHaveProperty('steps');
    expect(body).not.toHaveProperty('workdir');
    expect(body).not.toHaveProperty('templateName');
    expect(body).not.toHaveProperty('packSlug');
    expect(body).not.toHaveProperty('goal');
  });

  it('spawn_child state omits executionMode and boundConversationId keys', () => {
    const body = formStateToCreateBody(blankState());
    expect(body).not.toHaveProperty('executionMode');
    expect(body).not.toHaveProperty('boundConversationId');
  });
});

describe('formStateToCreateBody — barePrompt', () => {
  it('omits steps/templateName/packSlug and forces workdir shared', () => {
    const body = formStateToCreateBody(blankState({
      barePrompt: true,
      profileId: 'grok-bot:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      promptTemplate: 'Ping the bot',
      packSlug: 'evolve-wave',
      templateName: 'delegate',
      workdir: 'worktree',
      goal: 'ship it',
      packVars: { x: '1' },
    }));
    expect(body).not.toHaveProperty('steps');
    expect(body).not.toHaveProperty('templateName');
    expect(body).not.toHaveProperty('packSlug');
    expect(body).not.toHaveProperty('goal');
    expect(body).not.toHaveProperty('packVars');
    expect(body.workdir).toBe('shared');
    expect(body.promptTemplate).toBe('Ping the bot');
  });

  it('sends empty promptTemplate when the box is blank (never BLANK_JOB_PROMPT)', () => {
    const body = formStateToCreateBody(blankState({
      barePrompt: true,
      promptTemplate: '',
    }));
    expect(body.promptTemplate).toBe('');
    expect(body.promptTemplate).not.toBe(BLANK_JOB_PROMPT);
  });
});

describe('formStateToCreateBody — pack selected', () => {
  it('omits promptTemplate when the box is empty so the pack default survives the merge', () => {
    const body = formStateToCreateBody(blankState({
      packSlug: 'verify-after-change',
      promptTemplate: '   ',
    }));
    expect(body).not.toHaveProperty('promptTemplate');
    expect(body.packSlug).toBe('verify-after-change');
    expect(body).not.toHaveProperty('steps');
  });

  it('sends a typed promptTemplate as an operator override', () => {
    const body = formStateToCreateBody(blankState({
      packSlug: 'verify-after-change',
      promptTemplate: 'Custom policy',
    }));
    expect(body.promptTemplate).toBe('Custom policy');
  });

  it('sends goal, packVars, and omits empty goal', () => {
    const withGoal = formStateToCreateBody(blankState({
      packSlug: 'feature-wave',
      goal: '  ship the wave  ',
      packVars: { mode: 'closed', implementerProfileId: 'p1' },
    }));
    expect(withGoal.goal).toBe('ship the wave');
    expect(withGoal.packVars).toEqual({ mode: 'closed', implementerProfileId: 'p1' });

    const noGoal = formStateToCreateBody(blankState({
      packSlug: 'feature-wave',
      goal: '   ',
      packVars: { mode: 'closed' },
    }));
    expect(noGoal).not.toHaveProperty('goal');
  });
});

describe('slugFromJobName', () => {
  it('strips a [pack] prefix and kebab-cases the rest', () => {
    expect(slugFromJobName('[feature-wave] Evolve wave')).toBe('evolve-wave');
    expect(slugFromJobName('Nightly digest')).toBe('nightly-digest');
  });

  it('returns empty when the name sanitises to nothing', () => {
    expect(slugFromJobName('!!!')).toBe('');
    expect(slugFromJobName('[wave] 你好')).toBe('');
  });
});

describe('jobToPackDoc', () => {
  it('round-trips interval jobs: cadence, prompt, steer, steps without status, requiresTemplate', () => {
    const pack = jobToPackDoc(sampleJob(), {
      slug: 'evolve-wave',
      title: 'Evolve wave',
      description: 'Saved from a live job',
    }, NOW);
    expect(pack.origin).toBe('imported');
    expect(pack.version).toBe(1);
    expect(pack.slug).toBe('evolve-wave');
    expect(pack.requiresTemplate).toBe(true);
    expect(pack.files).toBeUndefined();
    expect(pack.job.cadence).toEqual({ kind: 'interval', everyMs: 86_400_000 });
    expect(pack.job.promptTemplate).toBe('Read the roster and mint one job.');
    expect(pack.job.steer).toBe('Implementer for minted one-shot jobs: profileId `p`, templateName `t`.');
    expect(pack.job.workdir).toBe('shared');
    expect(pack.job.overlapPolicy).toBe('skip');
    expect(pack.job.executionMode).toBe('spawn_child');
    expect(pack.job.runTimeoutMs).toBe(1_800_000);
    expect(pack.job.agentMayComplete).toBe(true);
    expect(pack.job.steps).toEqual([{ title: 'Wave tick', body: 'Reconcile, mint, propose.' }]);
    expect(pack.job.steps?.[0]).not.toHaveProperty('status');

    const form = cadenceToFormState(pack.job.cadence);
    expect(form.kind).toBe('interval');
    expect(form.everyMs).toBe(86_400_000);

    const validated = validateSchedulePack(pack);
    expect(validated.ok).toBe(true);
  });

  it('does not set requiresTemplate when the job has no templateName', () => {
    const pack = jobToPackDoc(sampleJob({ templateName: undefined }), {
      slug: 'plain',
      title: 'Plain',
      description: '',
    }, NOW);
    expect(pack.requiresTemplate).toBeUndefined();
  });

  it('converts a once job to fireInMs = atMs - now, floored at 1 minute', () => {
    const future = jobToPackDoc(sampleJob({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: NOW + 900_000 }),
      templateName: undefined,
    }), { slug: 'soon', title: 'Soon', description: '' }, NOW);
    expect(future.job.cadence).toEqual({ kind: 'once', fireInMs: 900_000 });

    const past = jobToPackDoc(sampleJob({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: NOW - 5_000 }),
    }), { slug: 'past', title: 'Past', description: '' }, NOW);
    expect(past.job.cadence).toEqual({ kind: 'once', fireInMs: 60_000 });

    const tooSoon = jobToPackDoc(sampleJob({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: NOW + 30_000 }),
    }), { slug: 'toosoon', title: 'Too soon', description: '' }, NOW);
    expect(tooSoon.job.cadence).toEqual({ kind: 'once', fireInMs: 60_000 });
  });

  it('clamps a sub-5min interval job up to the pack floor so save-as-pack validates', () => {
    const pack = jobToPackDoc(sampleJob({
      scheduleExpr: '{"everyMs":1000}',
      templateName: undefined,
    }), { slug: 'fast', title: 'Fast', description: '' }, NOW);
    expect(pack.job.cadence).toEqual({ kind: 'interval', everyMs: 300_000 });
    expect(validateSchedulePack(pack).ok).toBe(true);
  });

  it('clamps a once job beyond 7 days down to the pack ceiling', () => {
    const pack = jobToPackDoc(sampleJob({
      scheduleKind: 'once',
      scheduleExpr: JSON.stringify({ atMs: NOW + 10 * 86_400_000 }),
      templateName: undefined,
    }), { slug: 'later', title: 'Later', description: '' }, NOW);
    expect(pack.job.cadence).toEqual({ kind: 'once', fireInMs: 604_800_000 });
    expect(validateSchedulePack(pack).ok).toBe(true);
  });

  it('maps cron jobs to cadence.expr', () => {
    const pack = jobToPackDoc(sampleJob({
      scheduleKind: 'cron',
      scheduleExpr: '0 6 * * 1',
    }), { slug: 'monday', title: 'Monday', description: '' }, NOW);
    expect(pack.job.cadence).toEqual({ kind: 'cron', expr: '0 6 * * 1' });
  });
});

describe('spawnCapRemedy', () => {
  it('names Settings → Agents so a greyed-out submit is not a mystery', () => {
    expect(spawnCapRemedy('claude-code:opus-4.8')).toBe(
      "profile 'claude-code:opus-4.8' has no spawn capacity — set maxConcurrentSpawns for it in Settings → Agents",
    );
  });
});

describe('cadenceToFormState + formStateToCreateBody pack round-trip', () => {
  it('an interval pack form submits everyMs JSON', () => {
    const pack: Pick<SchedulePack, 'job'> = {
      job: {
        cadence: { kind: 'interval', everyMs: 86_400_000 },
        promptTemplate: 'pointer',
      },
    };
    const cadence = cadenceToFormState(pack.job.cadence);
    const body = formStateToCreateBody(blankState({
      packSlug: 'phased-feature',
      kind: cadence.kind,
      everyMs: cadence.everyMs,
      promptTemplate: pack.job.promptTemplate,
    }));
    expect(body.scheduleKind).toBe('interval');
    expect(body.scheduleExpr).toBe('{"everyMs":86400000}');
  });
});

describe('packApplyToastMessage', () => {
  it('returns null when there is nothing to show', () => {
    expect(packApplyToastMessage({})).toBeNull();
    expect(packApplyToastMessage({ warnings: [] })).toBeNull();
  });

  it('shows pack apply notes alone', () => {
    expect(packApplyToastMessage({ warnings: ['stage translate skipped'] })).toBe(
      'Pack apply notes: stage translate skipped',
    );
  });

  it('shows the interval-disabled note alone', () => {
    expect(packApplyToastMessage({ intervalPackDisabled: true })).toBe(
      INTERVAL_PACK_DISABLED_TOAST,
    );
  });

  it('combines warnings and interval-disabled so neither message is lost', () => {
    const msg = packApplyToastMessage({
      warnings: ['stage translate skipped', 'stage review skipped'],
      intervalPackDisabled: true,
    });
    expect(msg).toContain('Pack apply notes: stage translate skipped; stage review skipped');
    expect(msg).toContain(INTERVAL_PACK_DISABLED_TOAST);
  });
});
