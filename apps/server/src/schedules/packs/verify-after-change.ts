import type { SchedulePack } from '@tierwyn/shared';
import { COMPLETE_JOB } from './shared.js';

const PROMPT = `You are a delayed verification tick. Something was changed a while ago; your job is to
find out whether it actually works now. You **observe and report**. You change nothing.

Current step: {{step.title}}
{{step.body}}

Job \`{{job.id}}\`, run \`{{run.id}}\`.

What was changed, which commands to run, and what the expected behaviour is: the step body above and,
when the operator supplied one, the pending-context block below. If neither names anything to check,
do not invent a check — report that no verification target was supplied and retire the job.

## How to verify

1. **Run what you were told to run**, exactly as written, in the project root. Capture the real exit
   status and the real output. If a command does not exist or fails to start, that is a finding, not
   a reason to substitute a different command.
2. **Check the stated behaviour** as well as the exit code. A suite that passes while the feature is
   still broken is a pass on the wrong question — if the operator described an observable behaviour,
   look for that behaviour.
3. **Prefer evidence over inference.** Quote the actual lines you saw. Never report a result you
   reasoned your way to instead of observing. If you could not observe something, say "not observed"
   and say why.
4. **Separate new failures from old ones.** Check whether a failure also exists on the current branch
   independently of the change (\`git log --oneline -10\`, \`git status --short\`). Pre-existing
   failures get named and set aside, not fixed.

## Report

State a verdict in the first line of your summary — **PASS**, **FAIL**, or **INCONCLUSIVE** — then:

- every command you ran, with its exit status;
- the output lines that justify the verdict (trimmed, but real);
- for FAIL: the smallest description of what is broken and where, so the operator can queue a fix;
- for INCONCLUSIVE: what blocked you and what would unblock it.

Then mark this step \`done\` via the step API.

## Hard rules — you change nothing

- **No edits, no commits, no pushes, no deploys, no service restarts, no migrations, no destructive
  git.** Not even a one-line "obvious" fix: seeing a bug is the finding; fixing it is a different job.
- Read-only commands, plus the verification commands you were given. Building and testing is fine —
  those do not change tracked files. Anything that writes to the working tree is not.
- Do not print secrets or read \`.env*\`.
- If you find something badly broken, report it loudly and let the operator queue a fix job.

${COMPLETE_JOB}
`;

export const verifyAfterChangePack: SchedulePack = {
  slug: 'verify-after-change',
  title: 'Verify after change',
  description: 'Delayed verification of a change. Report pass/fail; change nothing.',
  version: 1,
  origin: 'shipped',
  requiresTemplate: false,
  job: {
    cadence: { kind: 'once', fireInMs: 3_600_000 },
    promptTemplate: PROMPT,
    workdir: 'shared',
    agentMayComplete: true,
    steps: [
      {
        title: 'Verify',
        body:
          'Verify this change:\n\n[[goal]]\n\n' +
          'Run the stated commands, check the stated behaviour, and report PASS / FAIL / INCONCLUSIVE ' +
          'with the real output as evidence. Change nothing — no edits, no commits, no fixes.',
      },
    ],
  },
};
