import type { SchedulePack } from '@tierwyn/shared';
import { COMPLETE_JOB, GUARDRAILS, VERIFY } from './shared.js';

const PROMPT = `You are a one-shot implementation tick: one goal, one logical commit, then stop.
Nothing here recurs — do not create a schedule, do not chain another tick, do not mint work for later.

Current step: {{step.title}}
{{step.body}}

Plan: {{steps.snapshot}}
Job \`{{job.id}}\`, run \`{{run.id}}\`.

The goal is the step body above and, when the operator supplied one, the pending-context block below.
If both are empty, do **not** guess a goal — report that none was supplied and retire the job.

## Tick workflow

1. **Orient before you write.** Read the code the goal touches. Check \`git log --oneline -20\` and
   \`git status --short\`. If the goal already shipped, say so and stop rather than re-implementing it.
   Note work already uncommitted in the tree — you own only the diff you add.
2. **Delegate once.** Spawn exactly ONE implementer child using the delegation rules in your preamble
   (do not invent tokens or ids). Hand it the goal, the files you located, the guardrails below, and
   this result contract:
   - it ends with a \`## Result\` section listing every file it touched with full paths, the key
     decisions it made and why, and anything you need in order to continue;
   - a bare "Done" / "OK" / "Completed" as the entire response is forbidden;
   - any plan, spec or other multi-step artifact goes to a **file**, with the path quoted in
     \`## Result\` — never inlined as prose.
   One child. If it comes back short or wrong, read its result and finish the work yourself; do not
   fan out into a second implementer.
3. **Adversary-read the diff.** \`git diff\` and review it assuming it is wrong. Hunt for: correctness
   bugs, unhandled edge cases, scope creep past the goal, missing or faked verification, and each
   guardrail below. Fix what you find before verifying.
4. **Verify** (below).
5. **Commit once.** One logical commit, \`type(scope): subject\`, scope from
   server|web|shared|adapters|spawn|schedules|tts|ui|deploy|security. \`git add\` the exact paths.
   Do **not** push and do **not** open a PR unless the goal says so in as many words.
6. **Report** in your final turn summary: files changed, the verification output you actually saw,
   what you deliberately left out, and the commit hash. Then mark this step \`done\` via the step API.

${GUARDRAILS}

${VERIFY}

${COMPLETE_JOB}
`;

export const singlePrFeaturePack: SchedulePack = {
  slug: 'single-pr-feature',
  title: 'Single PR feature',
  description: 'One change, one PR. Spawn one implementer, verify, commit, complete-job.',
  version: 1,
  origin: 'shipped',
  requiresTemplate: true,
  profileAgentHint: 'claude-code',
  job: {
    cadence: { kind: 'once', fireInMs: 3_600_000 },
    promptTemplate: PROMPT,
    workdir: 'shared',
    agentMayComplete: true,
    steps: [
      {
        title: 'Implement and verify',
        body:
          'Implement: [[goal]]\n\n' +
          'Scope is exactly that sentence — no adjacent refactors, no opportunistic cleanups. ' +
          'Spawn one implementer child, review its diff adversarially, verify, and land one logical commit. ' +
          'Hand back the changed-file list and the commit hash in your final turn summary.',
      },
    ],
  },
};
