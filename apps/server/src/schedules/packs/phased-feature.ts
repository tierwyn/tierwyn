import type { SchedulePack } from '@tierwyn/shared';
import { COMPLETE_JOB, GUARDRAILS, VERIFY } from './shared.js';

/** Pointer only — the real policy is the written prompt file (8 KiB ceiling on this string). */
const PROMPT = `Read \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` **first**. It is the policy for this job and
it outranks any habit you have. Then read \`.tierwyn/schedule/[[jobSlug]]-progress.md\` (the phase ledger —
what previous ticks did) and \`.tierwyn/schedule/[[jobSlug]]-README.md\` (file map, operator notes).

This tick's phase:
{{step.title}}
{{step.body}}

All phases:
{{steps.snapshot}}

Job \`{{job.id}}\`, run \`{{run.id}}\` — quote both in the ledger row you append.
The epic goal is in the pending-context block below when the operator supplied one this run; the
README and the ledger header carry it durably.

**One phase per tick.** Do this phase, append exactly one ledger row, mark this step \`done\` via the
step-API footer, and stop. Do not run ahead into the next phase. Do not propose new work. Do not
create any schedule. If the phase cannot be completed, mark the step \`blocked\` with the reason in its
body, write the ledger row anyway, and stop — a blocked phase the operator can see beats a guessed one.
`;

const PROMPT_FILE = `# [[jobName]] — phased feature policy

Scheduled orchestrator for **one closed epic**, delivered in linear phases, one phase per tick.
Follow the spawn/delegation rules in your **preamble**; never invent tokens, ids or endpoints.

Repo root: \`[[projectRoot]]\` · job timezone: \`[[timezone]]\` · file stem: \`[[jobSlug]]\`

**The epic:** [[goal]]

## What this job is — and is not

This is a **closed** epic. The scope was fixed when the operator applied the pack.

- **Never propose new work.** If you notice something worth doing that is outside the epic, write it
  as a one-line "deferred" note in the ledger and move on. It is the operator's to queue, not yours.
- **Never mint a schedule.** No \`POST …/schedules/agent\`, no self-chaining, no follow-up job. This job
  is the only schedule involved; it fires on its own cadence until the last phase is done.
- **Never spawn a phase as a job.** The implementer is a **child** you spawn inside this tick and wait
  for — not a scheduled job for later.
- One phase per tick, in order. Do not batch two phases because they "look small".

## Source of truth, read every tick in this order

1. \`.tierwyn/schedule/[[jobSlug]]-progress.md\` — the phase ledger. What is done, what is blocked, what
   the previous tick handed you.
2. \`.tierwyn/schedule/[[jobSlug]]-README.md\` — epic statement, file map, operator notes.
3. \`{{step.title}}\` / \`{{step.body}}\` from your tick prompt — **this** phase.
4. \`git log --oneline -20\` and \`git status --short\` — what actually landed, and what is uncommitted.

If the ledger says the epic is **DONE** or **STOPPED**: do nothing, append no row, and retire the job
(see below). Do not restart a finished epic.

## Per-tick workflow

1. **Read the four sources above.** Reconcile: if the ledger claims a phase is \`done\` but the code
   disagrees, trust the code and correct the ledger with a note.
2. **Do the phase.** For anything that writes code, spawn **one** implementer child per the preamble
   rules. Give it the phase body, the files you located, the guardrails below, and this contract:
   - it ends with a \`## Result\` listing every file touched (full paths), the decisions it made and
     why, and what the next phase needs to know;
   - "Done" / "OK" as the whole response is forbidden;
   - plans, specs and other multi-step artifacts go to a **file**, path quoted in \`## Result\`.
   Planning-only phases need no child — do the reading yourself and write the plan to a file.
3. **Review the diff** (\`git diff\`) assuming it is wrong: correctness, unhandled edges, scope creep
   past this phase, missing verification, guardrail breaches. Fix before verifying.
4. **Verify** (below). A phase that does not compile does not count as done.
5. **Commit** the phase as one logical commit, \`type(scope): subject\`. \`git add\` the exact paths.
   Do not push.
6. **Append exactly one ledger row** to \`.tierwyn/schedule/[[jobSlug]]-progress.md\`: phase, status,
   tick number, a one-line note, and the commit hash (or \`—\` when nothing was committed).
7. **Mark this step** \`done\` (or \`blocked\`, with the reason in its body) via the step-API footer.
8. **Report** in your final turn summary: phase, what changed, real verification output, commit hash,
   and what the next phase inherits. There is no notifier — your summary is the channel.

## Blocked phases

A phase you cannot finish gets \`blocked\`, not a guess. Write what you tried, what stopped you, and
what you need from the operator, in both the step body and the ledger row. Then stop. The next tick
reads the ledger and either retries (if the operator unblocked it) or stays blocked.

## Finishing

When the last phase is done: write the closing ledger row, set the ledger header to
\`Status: DONE\`, summarise the whole epic (phases, commits, what was deferred) in your final turn,
and retire the job. Do not leave a finished epic firing daily.

${GUARDRAILS}

${VERIFY}

${COMPLETE_JOB}
`;

const PROGRESS_FILE = `# [[jobName]] — phase ledger

**Epic:** [[goal]]
**Status:** ACTIVE  <!-- ACTIVE | BLOCKED | DONE | STOPPED -->
**Job:** [[jobName]] · stem \`[[jobSlug]]\` · timezone \`[[timezone]]\`
**Policy:** \`.tierwyn/schedule/[[jobSlug]]-prompt.md\`

One row per phase per tick, appended by the tick that did the work. Never rewrite history here —
if a previous row was wrong, add a correcting row and say so in its note.

| phase | status | tick | notes | commit |
|---|---|---|---|---|
| Phase 1 — Scope & plan | pending | — | — | — |
| Phase 2 — Implement core | pending | — | — | — |
| Phase 3 — Integrate & test | pending | — | — | — |
| Phase 4 — Verify & document | pending | — | — | — |
| Phase 5 — Wrap up & stop | pending | — | — | — |

Statuses: \`pending\` → \`done\` | \`blocked\` (with the reason in the note).

## Deferred

Anything worth doing that is **outside** this epic. The tick writes it here and moves on; the
operator decides whether it ever becomes its own job.

- _(none yet)_
`;

const README_FILE = `# [[jobName]]

A **phased feature** job: one closed epic, up to five linear phases, one phase per tick.
Created from the \`phased-feature\` schedule pack.

**Epic:** [[goal]]
**Repo root:** \`[[projectRoot]]\`
**Timezone:** \`[[timezone]]\`
**File stem:** \`[[jobSlug]]\` (derived from the job name — rename the job and these files no longer match)

## Files

| Path | Purpose |
|---|---|
| \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` | The policy every tick follows. Edit this to change how the job behaves. |
| \`.tierwyn/schedule/[[jobSlug]]-progress.md\` | Phase ledger — what each tick did, with commits. |
| \`.tierwyn/schedule/[[jobSlug]]-README.md\` | This file. |

The job owns these files after apply: editing them changes the job's behaviour immediately, with no
redeploy and no reapply. Deleting the pack changes nothing here.

## What it does not do

No roster, no proposals, no minted schedules, no notifier. The epic is fixed; the phases are fixed;
the tick reports in its final turn summary. If you want an open-ended, propose-and-approve workflow,
that is the **feature-wave** pack instead.

## Operator runbook

1. **Interval jobs from a pack land disabled.** Open the job in the Schedule browser and hit
   **Enable** (or **Run now** for the first phase immediately).
2. **The phases are the steps.** Edit a phase's title/body under **Edit steps** — the next tick picks
   up the new text. That is how you re-scope mid-epic.
3. **Blocked?** The step body and the ledger row both carry the reason. Fix the blocker, set the step
   back to \`pending\`, and the next tick retries.
4. **Finishing early:** mark the remaining steps \`done\` or archive the job. A tick that finds the
   ledger \`Status: DONE\` no-ops and retires the job.
5. **Nudging one tick** without editing the plan: enable *Carry-forward context* and write under
   *Context for next run*. It is consumed once, on the next non-skip fire.
`;

export const phasedFeaturePack: SchedulePack = {
  slug: 'phased-feature',
  title: 'Phased feature',
  description: 'One closed epic, linear phases. No proposals, no minted jobs.',
  version: 1,
  origin: 'shipped',
  requiresTemplate: true,
  profileAgentHint: 'claude-code',
  job: {
    cadence: { kind: 'interval', everyMs: 86_400_000 },
    promptTemplate: PROMPT,
    workdir: 'shared',
    agentMayComplete: true,
    steps: [
      {
        title: 'Phase 1 — Scope & plan',
        body:
          'Scope the epic and write the plan. Epic: [[goal]]\n\n' +
          'Read the code the epic touches, list the files and subsystems in play, name what is out of ' +
          'scope, and write the plan to a file in the project, following the plan location in the ' +
          'project\'s AGENTS.md/CLAUDE.md if any, otherwise `docs/plans/`. Quote the plan path in the ' +
          'ledger row. No implementation this tick.',
      },
      {
        title: 'Phase 2 — Implement core',
        body:
          'Implement the core of the epic against the Phase 1 plan.\n\n' +
          'The smallest slice that makes the central capability real — not the polish, not the edges. ' +
          'One implementer child, one logical commit.',
      },
      {
        title: 'Phase 3 — Integrate & test',
        body:
          'Wire the core into the rest of the system and cover it with tests.\n\n' +
          'Callers, routes, UI entry points, shared types — whatever Phase 2 left dangling. Add the ' +
          'tests that would catch a regression in this epic; watch them fail before they pass.',
      },
      {
        title: 'Phase 4 — Verify & document',
        body:
          'Verify end to end and document what shipped.\n\n' +
          'Run the full verification set and quote the real output. Update the docs that are now wrong ' +
          '(architecture notes, README, CLAUDE.md if the contract changed). No new features this tick.',
      },
      {
        title: 'Phase 5 — Wrap up & stop',
        body:
          'Close the epic.\n\n' +
          'Reconcile the ledger against `git log`, write the closing row, set the ledger header to ' +
          '`Status: DONE`, summarise the whole epic (phases, commits, deferred items) in your final ' +
          'turn summary, then retire the job via complete-job.',
      },
    ],
  },
  files: [
    { kind: 'prompt', body: PROMPT_FILE },
    { kind: 'progress', body: PROGRESS_FILE },
    { kind: 'README', body: README_FILE },
  ],
};
