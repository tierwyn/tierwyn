import type { SchedulePack } from '@tierwyn/shared';
import { COMPLETE_JOB, GUARDRAILS, STEP_HEARTBEAT } from './shared.js';

/** Pointer only — the real policy is the written prompt file (8 KiB ceiling on this string). */
const PROMPT = `Read \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` **first**. It is the policy for this job and it
outranks any habit you have. Then, in order:

1. \`.tierwyn/schedule/[[jobSlug]]-progress.md\` — the append-only ledger (which slices are done)
2. \`.tierwyn/schedule/[[jobSlug]]-roster.md\` — page inventory + fact table. The \`Operator\` column is
   authoritative: an empty cell means "not approved", never "go ahead".
3. \`.tierwyn/schedule/[[jobSlug]]-README.md\` — file map and the operator runbook

This tick's step:
{{step.title}}
{{step.body}}

The campaign knobs — archetype, depth, docs tool, changelog, commits, and the deep-depth
implementer profile — are in your **steer**, immediately after this template. If the steer is
empty, fall back to the README. Never substitute your own values.

Do exactly **one** slice this tick. Run that slice's exit test, quote its **real** output in the
ledger row you append, then stop. A slice with no quoted command output is not done.

Never invent a fact. Every value in a doc page comes from code with a \`path:line\`, or the slice is
marked \`blocked\` and you name what you need. Job \`{{job.id}}\`, run \`{{run.id}}\` — quote both in the
ledger row. Never mark your step \`done\`: the step is evergreen and the campaign's state lives in the
ledger and the roster. The job retires itself only through the STOP procedure.
`;

const PROMPT_FILE = `# [[jobName]] — documentation campaign policy

You are the **scheduled documentation worker** for this repository. One tick = one slice.

Repo root: \`[[projectRoot]]\` · timezone: \`[[timezone]]\` · file stem: \`[[jobSlug]]\`
Archetype: **[[archetype]]** · depth: **[[depth]]** · docs tool: **[[docsTool]]**
Changelog: **[[changelogPolicy]]** · commits: **[[commitMode]]**
Operator brief (from apply): [[goal]]

> The knobs above are an **apply-time snapshot**. Live values live in the job's **variables**
> (interpolated into the steer every tick). Prefer the steer; fall back here only if it is empty.

If the brief names a docs root or a file glob, use them. Otherwise the docs root is \`docs/\` and the
glob is every \`*.md\` tracked by git outside \`node_modules\`, \`.tierwyn/\` and vendored directories.

If the ledger header says \`Status: STOPPED\`, or \`.tierwyn/schedule/[[jobSlug]]-STOPPED.md\` exists:
no-op. Write nothing, append nothing. Retire the job if it is still enabled.

## The eight slices

Do them in order. Skip a slice only when the depth setting excludes it. Each slice ends with an
**exit test** — a command you actually run, whose real output you paste into the ledger row.

| # | Slice | Does | Exit test (quote the real output) |
|---|---|---|---|
| **S1** | Inventory & facts | Fill the roster: every existing doc file (path, bytes, last-touched, proposed disposition \`keep\` / \`merge:<target>\` / \`rewrite\` / \`delete\`) and the fact table extracted **from code**, every row carrying \`path:line\`. Stub the single hub. Write **no prose pages**. | Roster page-inventory row count equals the count from the \`find\`/\`git ls-files\` command you ran — paste both. Zero fact rows without a \`path:line\`. |
| **S2** | Prune & boundary | Execute only the dispositions the operator approved. Enforce the public/internal boundary (no internal-only paths in public pages). Check the root meta set: README, LICENSE, SECURITY, CONTRIBUTING, CHANGELOG, CODE_OF_CONDUCT where applicable. **No link repair** — that is S8. | Every approved \`delete\` row is gone (\`ls\` on the paths returns not-found); every \`merge\` target contains the merged content. Boundary grep returns zero hits. |
| **S3** | Getting started (tutorial) | Exactly one page: verified prerequisites, install, and the shortest path to one guaranteed success. No branching, nothing optional, no "you may also want to". | You **execute** the page's commands in order and quote their real output. \`getting-started/\` holds exactly one page. |
| **S4** | How-to guides | Task-oriented pages with imperative titles ("Deploy to production", "Run the test suite", "Add a migration"). One goal per page. Deployment and operations live here. | Every guide title is a verb phrase (list them). No guide repeats getting-started content (grep for the duplicated command). |
| **S5** | Reference | Configuration reference — every key: name, type, default, effect, where it is read — plus the archetype's interface reference. Interface reference is **generated**: wire and document the generator, never hand-write it. | Set difference between config keys found by grepping the code and keys in the reference is empty — paste both lists. Generator command runs clean. |
| **S6** | Architecture & decisions | What the pieces are, how a request or flow moves through them, the domain model. Diagrams are **Mermaid text in the markdown**, never binary. Plus \`architecture/decisions/\`: retroactively record the 3–8 decisions the codebase has already made (Nygard/MADR shape: context, decision, consequences, status; immutable once written, superseded rather than edited). | At least one ADR per named architectural constraint in the fact table. \`git status\` shows zero binary files added. |
| **S7** | Troubleshooting | Symptom → cause → fix. **Verified failure modes only** — each entry traceable to a real error string in the code, a real log line, or a documented environment hazard. No speculation. | Every entry cites a reproducible trigger or the \`path:line\` where the error originates — paste the grep that proves each error string exists. |
| **S8** | Sweep, harness & STOP | Slim the README to a landing page. Repair every link (the single link-repair pass). Verify hub integrity: exactly one hub, every page reachable from it in ≤2 hops. Install the freshness harness (below). Then run the STOP procedure. | Link check exits 0. README under the length ceiling (state it, e.g. 150 lines). Freshness check runs green from a clean checkout — paste its output. |

**Depth** is whatever the steer names (\`depth\`). Apply-time snapshot: [[depth]].

- \`light\` — S1, S2, S3, S8 only. Four ticks. Right for a small repo.
- \`standard\` — all eight, one per tick.
- \`deep\` — all eight, plus per-subsystem explanation pages in S6 and a fuller ADR backfill. Only at
  this depth may you delegate bulk generated-reference work to the implementer named in your steer
  (README fallback: \`[[implementerProfileId]]\`), and only
  if your preamble actually grants you a spawn roster. Otherwise do it yourself.

## Target structure

Lowercase-kebab directories. Uppercase is for **root-level meta files only** — \`README\`, \`LICENSE\`,
\`CONTRIBUTING\`, \`SECURITY\`, \`CHANGELOG\`, \`CODE_OF_CONDUCT\`. Never an uppercase directory: docs
toolchains publish the directory path as the URL, and case-only renames are hostile to
case-insensitive filesystems and to git history.

\`\`\`
README.md                 landing page only: what it is, who it is for, install, first run, links out
CHANGELOG.md              Keep a Changelog shape, [Unreleased] present
docs/
  README.md               the one hub — never two competing index pages
  getting-started/        TUTORIAL   — install to first successful run, one guaranteed path
  guides/                 HOW-TO     — task-oriented, one goal per page, imperative titles
  reference/              REFERENCE  — dry, complete, scannable; generated where a generator exists
    configuration.md      every env var and config key: name, type, default, effect
  architecture/           EXPLANATION — why the system is shaped this way
    decisions/            ADRs: 0001-<slug>.md, numbered, immutable, never renamed
  troubleshooting.md      symptom to cause to fix; verified failure modes only
\`\`\`

The four Diátaxis modes and what each reader wants:

- **Tutorial** (\`getting-started/\`) — reader is learning, has no context, needs a guaranteed-success
  path. Teaching only. No options, no alternatives, no reference tables.
- **How-to guide** (\`guides/\`) — reader is working, has context, wants a goal achieved. Imperative
  title, one goal, commands verbatim.
- **Reference** (\`reference/\`) — reader wants a fact and will not read prose. Complete and dry.
  Generated wherever a generator exists; hand-written reference is stale reference.
- **Explanation** (\`architecture/\`, \`architecture/decisions/\`) — reader is studying and wants the
  "why". Architecture pages say what the system is; ADRs say why it is that way and never rot.

A page belongs to **exactly one** mode. If it teaches and enumerates, split it.

## Rules (hard, ordered by how often they get violated)

1. **Code wins over prose.** Never restate a fact from an existing page. Re-derive it from source and
   record \`path:line\`. Page and code disagree ⇒ the page is wrong; fix it and note the delta.
2. **One slice per tick.** Two only if both are pure mechanical passes. Never run ahead because the
   next slice "looks small".
3. **Delete before you write.** A rewrite that leaves the superseded page in place made things worse.
4. **Move, do not rewrite.** Prefer \`git mv\` and surgical edits over regenerating a page. A rewrite
   discards accumulated correctness nobody can re-derive.
5. **Never invent.** No placeholder versions, no example URLs, no "typically around 30 seconds", no
   aspirational features. If a value is not in the code, mark the slice \`blocked\` and name what you
   need.
6. **Every command in a doc is executed, or explicitly marked unverified.** An untested command block
   is a bug with good formatting.
7. **One page, one Diátaxis mode.**
8. **One hub.** Never create a second index. If two exist, retiring one is part of the slice.
9. **Exit test before ledger row.** Run the command, paste the real output. No output, not done.
10. **Diagrams are text.** Mermaid or equivalent, inside the markdown. No binary diagram source.
11. **No secrets, ever.** Do not read or quote \`.env*\` or credential stores. The configuration
    reference documents names, types and defaults — never values.
12. **Commit mode comes from your steer** (\`commitMode\`). Apply-time snapshot: [[commitMode]].
    \`no-commit\` ⇒ leave the tree dirty for the operator to review; \`commit-per-slice\` ⇒ one commit
    per slice, \`docs(<slice>): <subject>\`, adding only the paths you touched. Never destructive git
    either way.
13. **Blocked beats guessed.** A slice needing an operator decision is marked \`blocked\` with the
    specific question. Move to the next slice only if it does not depend on the blocked one. Never
    loop on the same blocker.
14. **Stop when done.** All in-scope slices complete with green exit tests ⇒ STOP procedure ⇒ retire
    the job. Do not invent a ninth slice.

## The roster gate

The roster's page-inventory table is the operator's approval surface, and it works like every other
pack here: **you approve by editing a word.**

- The tick fills \`Proposed\` and leaves \`Operator\` **blank**.
- S2 executes **only** rows where \`Operator\` reads \`approve\`. An empty cell means "not yet".
- An unapproved \`delete\` is skipped and re-proposed, with a ledger note. Never delete on your own
  judgement.

The fact table is yours to maintain: \`key | value | source (path:line) | verified (date)\`. Re-verify
the rows a slice depends on before using them, and record any drift as a fact delta in the ledger.

## Archetype adaptation

S4 and S5 content follow the archetype named in your steer (\`archetype\`). Apply-time snapshot: **[[archetype]]**.

The slices are the same everywhere; S4 and S5 content is what changes.

| Archetype | S5 reference produces | S3 ends at | Emphasise in S4 | De-emphasise |
|---|---|---|---|---|
| \`monorepo\` | Per-package reference plus the package map: what each workspace is, and the build order | dev servers up and talking to each other | Build order and cross-package contracts — the number-one onboarding failure | Single-artifact assumptions |
| \`library\` | Generated API docs (TypeDoc, Sphinx, rustdoc, godoc) plus the public-surface stability policy | a working snippet that uses the library | Changelog, SemVer and the deprecation policy | Deployment, operations |
| \`cli\` | \`--help\` capture per command, exit codes, config-file schema, env vars | the first successful command with real output | Install matrix (package managers, platforms), shell completion | API reference, architecture depth |
| \`service\` | OpenAPI emitted from the route definitions, auth model, error catalogue, rate limits | a successful authenticated request | Deployment, observability, runbook, backup and restore | Library-style API docs |
| \`desktop\` | Settings reference, file locations, keyboard shortcuts | the app open and doing one useful thing | Install per OS, permissions, update mechanism | HTTP API, server ops |
| \`infra\` | Module inputs and outputs, resource inventory, state backend | a successful plan or dry-run | Blast radius, rollback, drift, secrets handling | End-user tutorials |

## Docs toolchain

Follow the toolchain named in your steer (\`docsTool\`). Apply-time snapshot: **[[docsTool]]**.

- \`none\` — portable markdown. Relative links only. The S8 link check is a small script in the repo's
  own language; do not add a dependency for it.
- \`mkdocs\` / \`docusaurus\` / \`sphinx\` / \`vitepress\` — follow that tool's front-matter and nav/index
  conventions, keep the nav config in sync with every file you add, move or delete, and prefer that
  tool's own link checker for S8 if the project already depends on it.

## Changelog

Follow the changelog policy named in your steer (\`changelogPolicy\`). Apply-time snapshot: **[[changelogPolicy]]**.

\`scaffold\` ⇒ S2 installs \`CHANGELOG.md\` in Keep a Changelog shape with an \`## [Unreleased]\` section
and a one-paragraph policy. \`skip\` ⇒ leave the changelog alone.

**Under both settings: never backfill a changelog from \`git log\`.** It produces noise nobody trusts
and it lies about user-visible impact.

## The freshness harness (S8 output)

Deliberately minimal — the point is that it survives, not that it is comprehensive.

1. **Link check** — wired into the project's existing test or CI command. Use what the ecosystem
   already has; if nothing exists, a short script that resolves every relative markdown link and
   exits non-zero on a miss beats adding a dependency.
2. **Fact assertions** — three to six tests over the load-bearing fact-table rows (default port,
   minimum runtime version, entry-point paths), each asserting the documented value still matches the
   source it came from. Twenty assertions is a maintenance burden that gets deleted within a quarter.
3. **A dated stamp** in the hub: "Facts verified against code on YYYY-MM-DD."

Do **not** install a spell checker, a prose linter or a doc-coverage metric. All three generate more
noise than signal and get disabled.

If this repository has \`npm run typecheck\` and a test command, run them once in S8 after wiring the
harness and quote the real pass/fail counts. Failures already present on the branch are not your
regressions — name them and leave them alone.

## STOP procedure

1. Ledger header ⇒ \`Status: STOPPED\`, with a UTC timestamp and anything left deferred or blocked.
2. Write \`.tierwyn/schedule/[[jobSlug]]-STOPPED.md\`: what each slice produced, what the freshness
   harness checks and how to run it, and this job id. Its presence makes every later tick a no-op.
3. Retire this job (below).
4. Final summary: what the corpus looks like now, what the operator still has to decide, and what
   remains unapproved in the roster. There is **no notifier** — your final turn summary and the
   ledger are the only channels to the operator.

${STEP_HEARTBEAT}

The body is a one-liner like \`S3 done (getting-started verified); S4 how-to guides next\`. The ledger
remains the real record — the step body is a glance-level indicator only.

${GUARDRAILS}

${COMPLETE_JOB}
`;

const ROSTER_FILE = `# [[jobName]] — page inventory & facts

**This file is the operator's approval surface.** The tick fills \`Proposed\` and leaves \`Operator\`
blank. Slice S2 acts **only** on rows where \`Operator\` reads \`approve\` — an empty cell means "not
yet", never "go ahead". To approve a disposition, type \`approve\`. To refuse it, type \`no\`.

Dispositions: \`keep\` · \`merge:<target path>\` · \`rewrite\` · \`delete\`

## Page inventory

Every documentation file in the repo, one row each. S1 fills this table; its exit test is that the
row count equals the count returned by the file-listing command it ran.

| Path | Bytes | Last touched | Proposed | Operator | Notes |
|---|---|---|---|---|---|
| _(empty — the first tick fills this)_ | | | | | |

## Fact table

Extracted from code, never from an existing doc page. A row without a \`Source\` is invalid and S1's
exit test fails on it. \`Verified\` is the date the value was last checked against that source.

| Key | Value | Source (path:line) | Verified |
|---|---|---|---|
| _(empty — the first tick fills this)_ | | | |

## Blocked

Questions the tick cannot answer from the code. Answer one inline and the next tick unblocks that
slice.

- _(none yet)_
`;

const PROGRESS_FILE = `# [[jobName]] — ledger

**Status:** ACTIVE  <!-- ACTIVE | STOPPED -->
**Archetype:** [[archetype]] · **Depth:** [[depth]] · **Docs tool:** [[docsTool]]
**Changelog:** [[changelogPolicy]] · **Commits:** [[commitMode]]
**Brief:** [[goal]]
**Ticks:** 0
**Policy:** \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` · **Roster:** \`.tierwyn/schedule/[[jobSlug]]-roster.md\`

Append-only. One row per tick, written by that tick. If an earlier row was wrong, append a correcting
row and say so — never rewrite history here.

The \`exit test + output\` cell must contain the **real** output of the command the slice ran. A row
without it means the slice is not done, whatever the prose says.

| tick | date (UTC) | slice | disposition changes | files touched | exit test + output | fact deltas | next |
|---|---|---|---|---|---|---|---|
| 0 | — | — | — | — | — | — | S1 |

## Slice status

| slice | state | tick | note |
|---|---|---|---|
| S1 inventory & facts | pending | — | |
| S2 prune & boundary | pending | — | |
| S3 getting started | pending | — | |
| S4 how-to guides | pending | — | |
| S5 reference | pending | — | |
| S6 architecture & decisions | pending | — | |
| S7 troubleshooting | pending | — | |
| S8 sweep, harness & stop | pending | — | |

States: \`pending\` · \`done\` · \`blocked\` · \`skipped (depth)\`

## Deferred

Things a slice noticed but did not do. The operator promotes anything here into the brief or the
roster if they want it.

- _(none yet)_
`;

const README_FILE = `# [[jobName]]

A **documentation campaign**: a standing job that brings this repository's documentation to a
maintainable standard in eight closed slices — one slice per tick — and ends by installing a cheap
freshness check so the result defends itself. Created from the \`docs-campaign\` schedule pack.

**Brief:** [[goal]]
**Archetype:** \`[[archetype]]\` · **Depth:** \`[[depth]]\` · **Docs tool:** \`[[docsTool]]\`
**Changelog:** \`[[changelogPolicy]]\` · **Commits:** \`[[commitMode]]\`
**Deep-depth implementer:** \`[[implementerProfileId]]\` (only consulted at \`deep\`)
**Repo root:** \`[[projectRoot]]\` · **Timezone:** \`[[timezone]]\` · **File stem:** \`[[jobSlug]]\`

> The knobs above are a **fallback copy**. The authoritative set lives in the job's **variables**
> (\`archetype\`, \`depth\`, \`docsTool\`, \`changelogPolicy\`, \`commitMode\`, \`implementerProfileId\`),
> which the tick interpolates into the steer — edit them in the Schedule browser under "Variables"
> to retune mid-campaign without touching any file. Keep this line in sync if you care about the
> fallback.

## Files

| Path | Purpose |
|---|---|
| \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` | Tick policy: the eight slices, their exit tests, the 14 rules, the archetype matrix, the STOP procedure |
| \`.tierwyn/schedule/[[jobSlug]]-roster.md\` | **The approval surface** — page inventory (dispositions) plus the fact table |
| \`.tierwyn/schedule/[[jobSlug]]-progress.md\` | Append-only ledger: one row per tick, slice status, deferred notes |
| \`.tierwyn/schedule/[[jobSlug]]-README.md\` | This file |
| \`.tierwyn/schedule/[[jobSlug]]-STOPPED.md\` | Written by the STOP procedure; its presence makes every later tick a no-op |

The job owns these files after apply. Editing them changes behaviour on the next tick — no redeploy,
no reapply. Deleting the pack changes nothing here.

## The eight slices

1. **Inventory & facts** — index every doc page with a proposed disposition; extract the fact table
   from code with \`path:line\` provenance. No prose is written this tick.
2. **Prune & boundary** — execute the dispositions **you approved**, enforce the public/internal
   boundary, check the root meta-file set.
3. **Getting started** — one tutorial page, its commands actually executed.
4. **How-to guides** — task-oriented pages, imperative titles, one goal each.
5. **Reference** — configuration reference plus a **generated** interface reference for the archetype.
6. **Architecture & decisions** — how the system works, plus ADRs recording the decisions it already
   made. Diagrams as Mermaid text.
7. **Troubleshooting** — verified failure modes only, each traceable to a real error in the code.
8. **Sweep, harness & STOP** — slim the README, repair links once, install the freshness check, stop.

At \`light\` depth only slices 1, 2, 3 and 8 run — four ticks.

## Approving dispositions (the one thing the job needs from you)

Open \`.tierwyn/schedule/[[jobSlug]]-roster.md\` after the first tick. Each page-inventory row carries a
\`Proposed\` disposition — \`keep\`, \`merge:<target>\`, \`rewrite\` or \`delete\` — and an empty \`Operator\`
cell.

- Type \`approve\` in the \`Operator\` cell to let slice S2 execute that disposition.
- Type \`no\` to refuse it. Leave it blank if you have not decided.
- **Blank is not approval.** S2 skips unapproved rows and re-proposes them, so nothing gets deleted
  because you did not get to it.

That is the whole gate. There is no UI and no command — you approve by editing a word.

## Operator runbook

1. **Interval jobs from a pack land disabled.** Open the job in the Schedule browser and **Enable**,
   or hit **Run now** for the first tick. Landing disabled is deliberate: you see the roster before
   anything is deleted.
2. **Review cadence.** Default is daily. One slice lands per tick, so you get a day to read each diff
   before the next one arrives. Slow it down if that is too fast for you.
3. **Commits.** At \`no-commit\` (default) the tick leaves the working tree dirty and you commit what
   you approve of. At \`commit-per-slice\` each slice makes one \`docs(...)\` commit. Flip this in
   **Variables** (\`commitMode\`) — the job never pushes and never runs destructive git.
4. **Blocked slices.** A slice that needs a decision it cannot make writes the question into the
   roster's **Blocked** section and moves on. Answer it there; the next tick picks it up.
5. **Retuning knobs** (depth, docs tool, changelog, commits, implementer): edit **Variables** in
   the Schedule browser. **Changing policy** (docs root, drop a slice, README ceiling): edit
   \`.tierwyn/schedule/[[jobSlug]]-prompt.md\` — it is the live policy, read fresh every tick.
6. **Nudging one tick.** Enable *Carry-forward context* and write under *Context for next run*.
   Consumed once, on the next non-skip fire.
7. **Stopping.** The campaign stops itself after the last in-scope slice, writes
   \`[[jobSlug]]-STOPPED.md\` and retires the job. To stop it now, disable it; to stop it permanently,
   disable and archive it.

## What it leaves behind

A link check and three-to-six fact assertions wired into the project's existing test command, plus a
dated "facts verified against code" stamp in the docs hub. That is the difference between a campaign
and a maintainable corpus: the next drift is caught by CI rather than by another campaign.
`;

export const docsCampaignPack: SchedulePack = {
  slug: 'docs-campaign',
  title: 'Documentation campaign',
  description:
    "Bring a repository's documentation to a maintainable standard in eight closed slices: inventory and verified facts, prune, tutorial, how-to guides, reference, architecture and decisions, troubleshooting, then sweep and install a freshness check.",
  version: 3,
  origin: 'shipped',
  // ponytail: no spawns — doc work is reading and writing, not parallelisable. `implementerProfileId`
  // stays an optional field rather than promoting the whole pack to requiresTemplate.
  requiresTemplate: false,
  profileAgentHint: 'claude-code',
  job: {
    cadence: { kind: 'interval', everyMs: 86_400_000 },
    promptTemplate: PROMPT,
    steer:
      'Campaign knobs: archetype `{{vars.archetype}}`, depth `{{vars.depth}}`, docsTool `{{vars.docsTool}}`, changelogPolicy `{{vars.changelogPolicy}}`, commitMode `{{vars.commitMode}}`, implementerProfileId `{{vars.implementerProfileId}}`.',
    workdir: 'shared',
    overlapPolicy: 'skip',
    runTimeoutMs: 3_600_000,
    agentMayComplete: true,
    steps: [
      {
        title: 'Documentation slice',
        body:
          'Evergreen — never mark this step `done`; the campaign keeps its state in the ledger and the roster.\n\n' +
          "Pick the first slice in the prompt file's table that the ledger does not show as `done` or " +
          '`skipped`, do only that slice, run its exit test, and append one ledger row containing the ' +
          'real command output. When the last in-scope slice is green, run the STOP procedure.',
      },
    ],
  },
  applyFields: [
    {
      key: 'archetype',
      label: 'Project archetype',
      type: 'select',
      help: 'Drives what the reference slice generates and what the guides emphasise.',
      options: [
        { value: 'monorepo', label: 'Full-stack monorepo' },
        { value: 'library', label: 'Library / SDK' },
        { value: 'cli', label: 'CLI tool' },
        { value: 'service', label: 'Web service / REST API' },
        { value: 'desktop', label: 'Desktop / GUI app' },
        { value: 'infra', label: 'Infrastructure / IaC' },
      ],
    },
    {
      key: 'depth',
      label: 'Depth',
      type: 'select',
      options: [
        { value: 'standard', label: 'Standard — all 8 slices' },
        { value: 'light', label: 'Light — inventory, prune, getting started, sweep' },
        { value: 'deep', label: 'Deep — all 8 plus per-subsystem explanation and ADR backfill' },
      ],
    },
    {
      key: 'docsTool',
      label: 'Docs toolchain',
      type: 'select',
      help: 'Controls front-matter, nav conventions, and the link checker the final slice installs.',
      options: [
        { value: 'none', label: 'Plain markdown' },
        { value: 'mkdocs', label: 'MkDocs' },
        { value: 'docusaurus', label: 'Docusaurus' },
        { value: 'sphinx', label: 'Sphinx' },
        { value: 'vitepress', label: 'VitePress' },
      ],
    },
    {
      key: 'changelogPolicy',
      label: 'Changelog',
      type: 'select',
      help: 'Never backfilled from git log under either setting.',
      options: [
        { value: 'scaffold', label: 'Scaffold CHANGELOG.md with [Unreleased]' },
        { value: 'skip', label: 'Leave the changelog alone' },
      ],
    },
    {
      key: 'commitMode',
      label: 'Commits',
      type: 'select',
      options: [
        { value: 'no-commit', label: 'Do not commit (operator reviews the tree)' },
        { value: 'commit-per-slice', label: 'One commit per slice' },
      ],
    },
    { key: 'implementerProfileId', label: 'Implementer (deep depth only)', type: 'profile' },
  ],
  files: [
    { kind: 'prompt', body: PROMPT_FILE },
    { kind: 'progress', body: PROGRESS_FILE },
    { kind: 'roster', body: ROSTER_FILE },
    { kind: 'README', body: README_FILE },
  ],
};
