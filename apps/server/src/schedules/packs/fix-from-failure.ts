import type { SchedulePack } from '@tierwyn/shared';
import { COMPLETE_JOB, GUARDRAILS, VERIFY } from './shared.js';

const PROMPT = `You are a one-shot fix tick. Reproduce first, then make the smallest change that clears
the failure, then prove it with a test. One commit, then stop.

Current step: {{step.title}}
{{step.body}}

Job \`{{job.id}}\`, run \`{{run.id}}\`.

The failure — error output, failing command, stack trace, or a description of the bad behaviour — is
the step body above and, when the operator supplied one, the pending-context block below.

## Tick workflow

1. **Reproduce.** Run the failing command and watch it fail. Quote the real output.
   **Never fix what you have not reproduced.** If you cannot reproduce it, do not "fix it anyway":
   report exactly what you ran, what happened instead, and what you would need from the operator
   (a command, a seed, an env var, a log), then retire the job.
2. **Find the cause, not the symptom.** Read the code path the failure walks. Form one hypothesis and
   name the evidence that would falsify it; check that evidence before editing anything. If two
   hypotheses both fit, add a log line or a temporary assertion to tell them apart rather than
   guessing. A fix you cannot explain is a coincidence.
3. **Minimal fix.** The smallest change that makes the reproduction pass. No refactor rides along, no
   adjacent cleanups, no "while I'm here". If the honest fix is large, say so and propose it instead
   of half-landing it.
4. **Regression test.** Add the test that would have caught this, beside the existing tests for that
   module. Confirm it **fails without your fix** (revert the fix briefly, watch it go red) and passes
   with it. A test you never saw fail is not a regression test.
5. **Verify:** re-run the original failing command, then the suite below.
6. **Commit once**, \`fix(scope): subject\`. \`git add\` the exact paths. Do not push.
7. **Report:** the reproduction, the root cause in one or two sentences, the fix, the new test, and
   the real command output. Then mark this step \`done\` via the step API.

${GUARDRAILS}

${VERIFY}

${COMPLETE_JOB}
`;

export const fixFromFailurePack: SchedulePack = {
  slug: 'fix-from-failure',
  title: 'Fix from failure',
  description: 'Reproduce a failure, minimal fix, regression test, complete-job.',
  version: 1,
  origin: 'shipped',
  requiresTemplate: true,
  profileAgentHint: 'claude-code',
  job: {
    cadence: { kind: 'once', fireInMs: 900_000 },
    promptTemplate: PROMPT,
    workdir: 'shared',
    agentMayComplete: true,
    steps: [
      {
        title: 'Reproduce, fix, verify',
        body:
          'The failure:\n\n[[goal]]\n\n' +
          'Reproduce it first and quote the real output — never fix what you have not reproduced. ' +
          'Then: minimal fix, a regression test you have watched fail without the fix, re-run the ' +
          'failing command plus the server suite, one `fix(...)` commit.',
      },
    ],
  },
};
