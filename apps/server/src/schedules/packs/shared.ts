/**
 * Prose blocks shared by the shipped packs.
 *
 * ponytail: one module of string constants rather than six copies of the same
 * policy — a guardrail change is one edit, not six near-identical ones that
 * drift. These are inlined into each pack's `promptTemplate` / file bodies at
 * module load, so an exported or imported pack document is still self-contained.
 */

/** Standing guardrails. Carried into every shipped pack. */
export const GUARDRAILS = [
  '## Guardrails (hard)',
  '',
  '- **Never deploy.** No `npm run deploy:prod*`, no `systemctl`, no service restarts — the operator deploys.',
  '- **No destructive git:** no `checkout --`, `reset --hard`, `clean -fd`, no force-push, no branch switch, no stash drop. Stay on the current branch.',
  '- **Never clobber uncommitted edits** in `apps/web/vite.config.ts` or `apps/web/src/ws.ts` — they carry prod-critical changes that a careless checkout takes production down with.',
  '- A new `.sql` migration is **dead** unless you register it in `apps/server/src/db/migrations/index.ts`. The array is hand-maintained.',
  '- If `packages/shared` changed, `npm run build --workspace=packages/shared` **first** — everything else compiles against its build output.',
  '- `git add` the specific paths you touched. Never `git add -A`, never `git commit -a`: another agent may be working in the same tree.',
  '- Do not print secrets and do not read `.env*`. If a spawn or API call returns 401, stop and tell the operator — never invent a token or a conversation id.',
].join('\n');

/** The verification floor. Anything weaker than this is not verification. */
export const VERIFY = [
  '## Verify',
  '',
  '- `npm run typecheck`',
  '- `npm run test --workspace=apps/server`',
  '',
  'Run them; do not predict their output. Quote the real pass/fail counts in your summary.',
  'Failures that already exist on the current branch are not your regressions — name them and leave them alone.',
].join('\n');

/**
 * Evergreen-step packs only. A pack whose single step is never marked `done`
 * writes no step at all, so `detectStepUpdate` sees nothing and every run gets
 * stamped `no_step_update` (cosmetic — the step is returned to `ready`, not
 * blocked). A status-bearing PATCH each tick both silences that and turns the
 * step display into a live progress indicator.
 *
 * ponytail: `"status": "ready"` is load-bearing, not decoration. A body-only
 * PATCH bumps updated_at, which suppresses finalizeRun's reset branch and leaves
 * the step `running` — and `selectCurrentStep` skips `running`, so the next tick
 * would find no step and the job would quietly stall. Hence the shouty warning
 * in the prose below.
 */
export const STEP_HEARTBEAT = [
  '## Step heartbeat (end of every tick)',
  '',
  'This job has one **evergreen** step that is never marked `done`, so nothing writes to the step API',
  'unless you do. Without a write the server stamps the run `no_step_update`. Before you end your turn,',
  'PATCH the current step id printed in your step-API footer:',
  '',
  '```json',
  '{ "status": "ready", "body": "<one line: where the work stands and what is next>" }',
  '```',
  '',
  '- **`"status": "ready"` is mandatory.** A body-only patch leaves the step `running`, and a `running`',
  '  step is never selected again — the job would stall silently. Always send the status.',
  '- **Never `"status": "done"`.** This step is evergreen; `done` removes it from selection for good.',
  '- Non-2xx: retry once, then note it in the ledger and carry on. This is bookkeeping, not a blocker —',
  '  never mark a slice `blocked` over it.',
].join('\n');

/**
 * How a tick retires its own job.
 *
 * The footer only prints an explicit complete-job URL for agent-created jobs, and
 * a pack apply is operator-created — so the instruction has to derive the URL from
 * the steps URL that is always printed, rather than hardcode a host or a port.
 */
export const COMPLETE_JOB = [
  '## Retiring this job',
  '',
  'When the work above is finished, retire the job: take the `…/schedules/<job id>/steps` URL',
  'printed in your step-API footer, replace the trailing `/steps` with `/complete-job`, and POST it',
  'with the same Bearer run token. If it answers non-2xx, retry once, then say so plainly in your',
  'summary and tell the operator to disable the job by hand in the Schedule browser.',
].join('\n');
