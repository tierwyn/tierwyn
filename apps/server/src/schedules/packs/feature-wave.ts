import type { SchedulePack } from '@tierwyn/shared';
import { COMPLETE_JOB, GUARDRAILS, STEP_HEARTBEAT, VERIFY } from './shared.js';

/** Pointer only — the real policy is the written prompt file (8 KiB ceiling on this string). */
const PROMPT = `Read \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` **first**. It is the policy for this wave and
it outranks any habit you have. Then, in order:

1. \`.tierwyn/schedule/[[jobSlug]]-progress.md\` — the ledger (tick count, operator actions, pipeline runs)
2. \`.tierwyn/schedule/[[jobSlug]]-roster.md\` — the roster, which is the operator's approval surface
3. \`.tierwyn/schedule/[[jobSlug]]-README.md\` — mode, pipeline stages, file map, runbook

This tick's step:
{{step.title}}
{{step.body}}

Job \`{{job.id}}\`, run \`{{run.id}}\` — quote both in the ledger row you append.
The wave's theme is in the pending-context block below when the operator supplied one this run; the
README carries it durably.

Active mode: {{vars.mode}}

{{pipeline}}

One tick = reconcile the roster, run the pipeline for at most **one** approved row, optionally append
one proposal (open-propose), update the ledger, stop. You may create **no** schedules of any kind.
Never self-chain. Never mark your step \`done\` — this step is evergreen and the wave's state lives in the roster.
`;

const PROMPT_FILE = `# [[jobName]] — feature wave policy

You are the **scheduled orchestrator** for this wave. Follow the spawn/delegation rules in your
**preamble**; never invent tokens, ids or endpoints.

Repo root: \`[[projectRoot]]\` · job timezone: \`[[timezone]]\` · file stem: \`[[jobSlug]]\`
Wave theme (from the operator at apply): [[goal]]

## Cadence model (critical)

This is a **single interval schedule** — one job id, firing on its own cadence.

- This job **never creates schedules**. Schedule creation is forbidden in this wave.
- All stages of work are executed in-tick via child subagents (\`POST /spawn\`).
- On a STOP condition: run the STOP procedure and retire this job only.

If the ledger header says \`Status: STOPPED\`, or \`.tierwyn/schedule/[[jobSlug]]-STOPPED.md\` exists:
no-op. Spawn nothing, append nothing. Retire the job if it is still enabled.

## Source of truth — read every tick, in this order

1. \`.tierwyn/schedule/[[jobSlug]]-progress.md\` — ledger: tick count, operator actions, piped rows, stages run
2. \`.tierwyn/schedule/[[jobSlug]]-roster.md\` — the roster (**the** approval surface)
3. \`.tierwyn/schedule/[[jobSlug]]-README.md\` — mode, pipeline stages, runbook
4. \`git log --oneline -40\` — what already shipped, so stale proposals get dropped
5. Planning and architecture docs in the repo — deferred work someone already thought about
6. The code itself — a proposal is not validated until it has been checked against current code

## Rails (hard)

| Rail | Value |
|---|---|
| Max rows piped per tick | **1** |
| Max fix loops per row per tick | **1** |
| Max pending \`proposed\` rows in the roster | **5** (queue full ⇒ propose nothing, note it in the ledger) |
| Max ticks before forced STOP | **30** |
| Disengagement STOP | **6 consecutive ticks with zero operator action** while ≥3 rows pend |
| Review note | every 3rd tick, append a short "what needs the operator" note to the ledger |

Count "operator action" as any roster status flip you did not make yourself since the last tick.

## Per-tick workflow

1. **Read the sources.** Confirm the ledger is not \`STOPPED\`. Increment the tick counter.
2. **Reconcile the roster — before anything else.** For each \`proposed\` row, validate it against
   current code (\`git log -S\`, grep, read the files). If it already shipped or has become obsolete,
   flip it to \`rejected\` with the note "obsolete at tick N". Rows seeded from memory or from an
   operator's one-liner are **tentative** until validated this way. Count operator actions.
3. **Check tree cleanliness, then select at most one row and run the pipeline:**
   - First, verify working tree cleanliness with \`git status --short\`. If the working tree has uncommitted changes from an \`awaiting-commit\` row or a \`BLOCK\`ed row, do NOT pipe any new row that tick: record in the ledger that the working tree holds uncommitted modifications awaiting operator commit or review, report the dirty files in your final turn summary, and proceed directly to step 4 without implementing.
   - Row selection precedence:
     1. If an unfinished \`in-progress\` row exists from an earlier crashed/stalled tick, resume that row first.
     2. Otherwise, select the oldest \`approved\` row.
     3. Ignore rows that are \`shipped\`, \`rejected\`, \`blocked\`, or \`awaiting-commit\`.
   - Execute the pipeline for the selected row (see "Pipeline execution" below).
4. **Propose — mode-dependent.** See the mode sections below. This is the only step the mode changes.
5. **Update the ledger:** tick number, date, operator actions counted, row piped, stages run, verdict,
   commit hash or diff summary, proposal appended or why not, and notes.
6. **End the tick.** If a STOP condition fired, run the STOP procedure. Otherwise end with a
   structured summary — there is **no notifier**: your final turn summary is the only channel to the
   operator, so put the proposal, the pipeline outcome and any blocker in it, in plain prose.

**Active mode: [[mode]]** (initial default at apply; dynamically governed by the tick prompt's \`Active mode: {{vars.mode}}\` variable, which is authoritative and overrides this file) — follow only the matching section below; ignore the other.

### Mode: closed

The roster is a **closed pool**. The operator fills it; you work it.

- **Do not append new rows.** Not "just one more", not a row you think is obviously needed. If you
  notice something worth doing, write it as a one-line *deferred* note at the bottom of the ledger and
  move on. The operator promotes it to a roster row if they want it.
- Your work in step 4 is reconciliation only: keep statuses honest against the code.
- The pool is considered drained when NO rows are \`approved\` and NO rows are \`in-progress\` (even if rows remain \`awaiting-commit\` or \`blocked\`, since the wave cannot make automatic progress without operator action). Run the STOP procedure or note the blocked state in the ledger and summary rather than idling indefinitely.

### Mode: open-propose

You may grow the roster, **one validated row per tick, maximum**.

- Only if the roster holds fewer than **5** pending \`proposed\` rows. At 5, propose nothing and say the
  queue is full in the ledger and your summary.
- Pick **one** candidate. Prefer measured gaps — deferred plans, architecture-doc TODOs, known design
  gaps recorded in the ledger — over greenfield invention.
- **Validate before proposing.** Read the code. A proposal that turns out to already exist is worse
  than no proposal: it burns an operator review cycle.
- Substantial only: a new user-visible capability, or a major enhancement of one. **Not** chores,
  renames, refactors, dependency bumps or internal cleanup.
- Reject at proposal time, without asking: rewrites; major dependency bumps; anything that widens the
  security posture or exposes the product to additional users or the internet; auth changes; and
  production deploys of any kind.
- Append one row with a fresh \`FW-<n>\` id (next free number) and every column filled: status
  \`proposed\`, title, problem, proposal, scope (files/subsystems), risk (low/med/high), verify
  (the actual commands), source (where the idea came from).

## Pipeline execution

1. **Pipeline definition:** Take the pipeline table from the tick prompt (\`{{pipeline}}\` renders it).
   It is authoritative; this file does not repeat roles or functions.
2. **Mark in-progress before spawning:** Mark the selected row \`in-progress (tick N, run id)\` in the roster
   **before** spawning children, so a crashed tick is visible and the next tick resumes rather than duplicating.
   After each stage successfully finishes, annotate the row in the roster with completed stages:
   \`in-progress (tick N, run id; done: <stages>)\` before spawning the next stage.
   On pickup, if an unfinished \`in-progress\` row from an earlier crashed/stalled tick exists, resume it: inspect
   the \`done: <stages>\` annotation on the roster row itself, corroborate with \`git status\` and \`git log\`,
   and resume from the first incomplete stage (do not rely on the end-of-tick ledger row, which is not written
   if a crash occurs mid-pipeline).
3. **Execute stages in order:** Spawn each non-skipped stage in order (\`wait:false\` + \`notify:true\`).
   Pass the stage function, full roster row details, and file paths from prior stages' \`## Result\`.
   Every child must end with \`## Result\` (listing touched files with full paths, key decisions, and parent context)
   and write its mirror RESULT file (\`.tierwyn/delegates/<role>-<slug>-RESULT.md\`).
4. **Plan stage:** Skip the plan stage for simple rows (risk \`low\`, ≤2 files, 1 subsystem, no
   migration/shared-type/protocol change). Complex rows (risk \`med\`/\`high\`, or 3+ files, or 2+ subsystems,
   or a DB migration, or shared types/WS protocol, or spawn/auth/schedules) must run the plan stage to produce
   a plan file under the repo plans directory.
5. **Review stage verdicts:**
   - \`SHIP\` → continue to commit/ship.
   - \`SHIP-AFTER-FIX\` → spawn one fix child to the implement role, then re-review once. A second non-SHIP counts as \`BLOCK\`.
   - \`BLOCK\` → do not commit; set row status to \`blocked\` in the roster (with the review reason recorded in the ledger and roster note), and stop the tick. The operator can inspect the review feedback, address issues, and change status back to \`approved\` when ready for another attempt.
6. **Missing role in template:** For an optional stage, note in ledger "stage <id> skipped: role not in template"
   and continue. For a required stage (\`implement\`), set row \`blocked\` and stop the tick.
7. **Commit policy:** If \`commitOnTick\` is true, verify then commit once (\`type(scope): subject\`, exact paths).
   Flip row to \`shipped\` with commit hash and verdict in roster.
   If \`commitOnTick\` is false, leave changes uncommitted, set row to \`awaiting-commit\` with a diff summary
   (\`git status --short\`) in the ledger.
8. **No review stage:** If no review stage is configured, commit only on fully green verify and note "unreviewed" in ledger.

## STOP procedure

1. Ledger header → \`Status: STOPPED\`, with a UTC timestamp and what remains deferred.
2. Write \`.tierwyn/schedule/[[jobSlug]]-STOPPED.md\`: what shipped, what was deferred, this job id.
3. Retire this job (below).
4. Final summary: the wave has stopped, why, and what the operator would need to change to start a
   new arc.

${STEP_HEARTBEAT}

The body is a one-liner like \`tick 7: piped FW-12; 2 rows approved pending\`. The ledger remains the
real record — the step body is a glance-level indicator only.

${GUARDRAILS}

${VERIFY}

${COMPLETE_JOB}
`;

const ROSTER_FILE = `# [[jobName]] — roster

**This file is the operator's approval surface.** The tick reads it every fire and acts only on what
it says. To approve an item, change its \`status\` from \`proposed\` to \`approved\`. To kill one, set
\`rejected\`. Nothing else is needed — no UI, no command.

Statuses: \`proposed\` · \`approved\` · \`in-progress\` · \`awaiting-commit\` · \`shipped\` · \`rejected\` · \`blocked\`

Rules the tick follows:

- It runs the pipeline for at most one row per tick: resuming an unfinished \`in-progress\` row first, or picking the oldest \`approved\` row. It ignores \`shipped\`, \`rejected\`, \`blocked\`, and \`awaiting-commit\` rows.
- It never sets \`approved\` itself. That flip is the operator's, always.
- When review yields \`BLOCK\`, it flips the row to \`blocked\` until the operator addresses the issue and re-approves.
- It may flip \`proposed\` → \`rejected\` when a row turns out to be already shipped or obsolete, with a
  note saying so.
- At most **5** \`proposed\` rows pend at once.

| status | ID | title | problem | proposal | scope | risk | verify | source |
|---|---|---|---|---|---|---|---|---|
| _(empty — the first tick fills this)_ | | | | | | | | |

## Shipped

| ID | title | commit | date | verdict |
|---|---|---|---|---|
| _(none yet)_ | | | | |
`;

const PROGRESS_FILE = `# [[jobName]] — ledger

**Status:** ACTIVE  <!-- ACTIVE | STOPPED -->
**Wave theme:** [[goal]]
**Mode at apply:** [[mode]]
**Ticks:** 0
**Zero-action ticks in a row:** 0
**Policy:** \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` · **Roster:** \`.tierwyn/schedule/[[jobSlug]]-roster.md\`

Append-only. One row per tick, written by that tick. If a previous row was wrong, add a correcting
row and say so — never rewrite history here.

| tick | date (UTC) | operator actions | row piped | stages run | verdict | commit | proposed | notes |
|---|---|---|---|---|---|---|---|---|
| 0 | — | — | — | — | — | — | — | created from feature-wave v4[[pipelineNotes]] |

## Deferred

Ideas the tick noticed but did not propose (out of scope, queue full, or closed mode). The operator
promotes anything here into a roster row if they want it.

- _(none yet)_

## Review notes

Every third tick: what is pending, what needs the operator, what is stuck.

- _(none yet)_
`;

const README_FILE = `# [[jobName]]

A **feature wave**: a standing job that reconciles a roster, runs an in-tick plan → implement → review
pipeline for items **you** approved, and — in open-propose mode — suggests one new item per tick.
Created from the \`feature-wave\` schedule pack.

**Wave theme:** [[goal]]
**Mode at apply:** \`[[mode]]\`
**Repo root:** \`[[projectRoot]]\` · **Timezone:** \`[[timezone]]\` · **File stem:** \`[[jobSlug]]\`

## Pipeline

Edit \`stages\`, \`<id>Role\`, \`<id>Function\`, \`commitOnTick\`, \`mode\` in the Schedule Browser → Variables.
Takes effect on the next tick without modifying files.

Workdir: \`shared\` (default) or \`worktree\` — set in the job's edit form.
With \`worktree\` + \`commitOnTick=false\` the changes live in the tick's worktree, and the tick reports its path.

## Files

| Path | Purpose |
|---|---|
| \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` | Tick policy: workflow, rails, pipeline execution, both mode sections |
| \`.tierwyn/schedule/[[jobSlug]]-roster.md\` | **The approval surface** — flip a row to \`approved\` here |
| \`.tierwyn/schedule/[[jobSlug]]-progress.md\` | Ledger: ticks, operator actions, piped rows, stages run, deferred ideas |
| \`.tierwyn/schedule/[[jobSlug]]-README.md\` | This file |
| \`.tierwyn/schedule/[[jobSlug]]-STOPPED.md\` | Written by the STOP procedure; its presence makes every later tick a no-op |

The job owns these files after apply. Editing them changes behaviour immediately — no redeploy, no
reapply. Deleting the pack changes nothing here.

## Flow

1. The tick fires, reads ledger → roster → README, and reconciles the roster against current code and \`git log\`.
2. Any row you set to \`approved\` runs through the in-tick pipeline (≤1 per tick):
   plan (if complex) → implement → adversary-review → commit (if configured) → flip to \`shipped\` (or \`awaiting-commit\`).
3. In \`open-propose\` mode only, the tick appends **one** validated \`proposed\` row (≤5 pending).
4. The ledger is updated; the tick reports in its final turn summary. **There is no notifier** — read
   the tick's summary in the conversation, or read the ledger.

## Switching modes later

Edit \`mode\` in Schedule Browser → Variables. The tick prompt's variable is authoritative. Both mode sections ship in \`.tierwyn/schedule/[[jobSlug]]-prompt.md\`.

## Operator runbook

1. **Interval jobs from a pack land disabled.** Open the job in the Schedule browser and **Enable**
   (or **Run now** for the first tick).
2. **Approving:** edit the roster row's status to \`approved\`. The next tick picks it up.
3. **Handling \`awaiting-commit\` rows:** when \`commitOnTick\` is false, inspect the uncommitted changes
   (\`git status --short\`, \`git diff\`), run tests, commit with \`type(scope): subject\`, and flip the
   row's status in the roster to \`shipped\` (recording the commit hash).
4. **Handling \`blocked\` rows:** when review yields \`BLOCK\`, inspect the reason in the ledger and roster note,
   address the feedback or provide guidance, and flip the status back to \`approved\` to re-enter the queue.
5. **Pipeline configuration:** roles are auto-matched from the template's "use when" text at apply; fine-tune in the Variables tab.
6. **Stopping:** the wave stops itself on its rails (30 ticks, or 6 zero-action ticks with ≥3 pending,
   or a drained pool in closed mode) and writes \`[[jobSlug]]-STOPPED.md\`. To stop it now, disable the
   job; to stop it permanently, disable and archive it.
7. **Nudging one tick:** enable *Carry-forward context* and write under *Context for next run*.
   Consumed once, on the next non-skip fire.
`;

export const featureWavePack: SchedulePack = {
  slug: 'feature-wave',
  title: 'Feature wave',
  description: 'Reconcile a roster; run an in-tick plan -> implement -> review pipeline for one approved row per tick.',
  version: 4,
  origin: 'shipped',
  requiresTemplate: true,
  profileAgentHint: 'claude-code',
  requiredStages: ['implement'],
  job: {
    cadence: { kind: 'interval', everyMs: 86_400_000 },
    promptTemplate: PROMPT,
    workdir: 'shared',
    agentMayComplete: true,
    runTimeoutMs: 7_200_000,
    variables: {
      stages: 'plan,implement,review',
      commitOnTick: 'true',
      mode: 'closed',
    },
    steps: [
      {
        title: 'Wave tick',
        body:
          'Evergreen — never mark this step `done`; the wave keeps its state in the roster, not in steps.\n\n' +
          'Reconcile the roster against current code, run the pipeline for at most one approved row, ' +
          'optionally append at most one validated proposal (open-propose mode only), ' +
          'update the ledger, and report in your final turn summary. You may create no schedules of any kind.',
      },
    ],
  },
  applyFields: [
    {
      key: 'mode',
      label: 'Wave mode',
      type: 'select',
      options: [
        { value: 'closed', label: 'Closed pool (default)' },
        { value: 'open-propose', label: 'Open propose' },
      ],
    },
    {
      key: 'commitOnTick',
      label: 'Commit policy',
      type: 'select',
      options: [
        { value: 'true', label: 'Commit after review passes (default)' },
        { value: 'false', label: 'Leave changes uncommitted' },
      ],
    },
  ],
  files: [
    { kind: 'prompt', body: PROMPT_FILE },
    { kind: 'progress', body: PROGRESS_FILE },
    { kind: 'roster', body: ROSTER_FILE },
    { kind: 'README', body: README_FILE },
  ],
};
