export interface PromptVariable {
  /** Matches PROMPT_VAR_NAME_RE. Unique within an entry. */
  name: string;
  /** Form label. Falls back to `name` when absent. */
  label?: string;
  /** Optional stored default. The collect-values form ignores this: first open
   *  is empty/None; later opens restore the last submitted value per browser. */
  default?: string;
  /** 'roster' ⇒ the fill form offers the conversation's spawn-template role names
   *  instead of a free-text field. Absent ⇒ free text. */
  source?: 'roster';
}

export interface PromptCollectionEntry {
  id: string;
  name: string;
  description: string;
  body: string;
  /** Presets are compiled in; 'custom' rows live in the settings blob. */
  origin: 'preset' | 'custom';
  /** Optional metadata for `{{tokens}}` found in `body`. Absent ⇒ names only. */
  variables?: PromptVariable[];
  createdAt?: number;
  updatedAt?: number;
}

export const PROMPT_NAME_MAX = 80;
export const PROMPT_DESCRIPTION_MAX = 160;
export const PROMPT_BODY_MAX = 8000;
export const PROMPT_VAR_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const PROMPT_VARS_MAX = 16;
export const PROMPT_VAR_LABEL_MAX = 60;
export const PROMPT_VAR_DEFAULT_MAX = 500;   // bytes, UTF-8

/** Non-global source. Construct a fresh /g regex per call — lastIndex is stateful. */
const PROMPT_VAR_TOKEN_SOURCE = '(?<!\\{)\\{\\{([A-Za-z][A-Za-z0-9_]{0,31})\\}\\}(?!\\})';

function promptVarTokenRe(): RegExp {
  return new RegExp(PROMPT_VAR_TOKEN_SOURCE, 'g');
}

export const PRESET_PROMPTS: PromptCollectionEntry[] = [
  {
    id: 'preset-code-review',
    name: 'Code review this diff',
    description: 'Correctness, contracts, concurrency and security in priority order. Findings worst-first with file:line, impact and a concrete fix.',
    origin: 'preset',
    body: `Review the current uncommitted diff in this repository as the last reviewer before this reaches production.

Method:
1. Read the whole diff end to end before judging any part of it, and state what the change is trying to achieve.
2. For each hunk, open the surrounding file and the callers. A hunk that is correct in isolation can still break a caller you never read — most real defects live at that seam.
3. Re-derive the author's intent from the code, then hunt for the ways the code fails that intent.
4. Review the tests in the diff as carefully as the production code. A test that cannot fail is itself a defect.

Look for, in priority order:
- Correctness: inverted condition, off-by-one, wrong operator or variable, unhandled branch, incorrect early return.
- Contract breaks: changed signature, return shape, nullability or error semantics, with callers, stored data or wire payloads not updated.
- State and lifetime: mutation of shared or captured state, missing cleanup, leaked handles, unbounded growth, a cache written but never invalidated.
- Concurrency: check-then-act races, non-atomic read-modify-write, awaiting inside a lock, assumptions of single-threaded or single-instance execution.
- Edge cases: empty, null, zero, one, duplicate, maximum, non-ASCII, timezone, partial failure midway through a loop.
- Error handling: swallowed exceptions, errors logged and then ignored, retries without backoff or idempotency, partial writes with no rollback.
- Security-sensitive changes: auth, authorization, input validation, secrets, SQL, subprocess, file paths, deserialization.
- Compatibility: migrations, API and wire-format changes, feature flags, deployment ordering between components.
- Observability: if the code introduced here fails in production, could anyone diagnose it from the logs and metrics that exist?
- Naming, duplication, dead code and style — last, and briefly.

Guardrails: do not fix, refactor or commit anything; report only. Separate what you verified by reading code from what you inferred, label the inferences, and name the evidence that would settle them. Do not narrate the diff back to me, and do not dress preferences up as defects.

Output findings worst-first as: severity — file:line — what is wrong — why it matters — the concrete fix. Severity is blocker (data loss, security hole, breaks production), major (wrong behaviour in a realistic case) or minor (maintainability). Then a short list of the risky parts you checked and found sound, so I can see your coverage. Close with one verdict line: ship, ship with nits, or do not ship.`,
  },
  {
    id: 'preset-explain-codebase',
    name: 'Explain this codebase',
    description: 'Orientation grounded in real files: build and run, entry points, one traced end-to-end flow, data model, conventions, sharp edges.',
    origin: 'preset',
    body: `Orient me in this codebase. Explore first and conclude second — nothing you tell me should come from a filename alone.

Method:
1. Read the package, build and dependency manifests, the README and the top-level layout. Establish the language, framework, package manager, and how this is built, run and tested.
2. Identify every entry point: binaries, servers, workers, scheduled jobs, CLI commands, migrations.
3. Pick the single most representative request or job and trace it end to end, naming the actual files and functions in order. That trace is the spine of your answer.
4. Only then generalise into modules and layers.

Report:
- What the system does and who consumes it, in two sentences.
- How to build, run and test it locally, with exact commands taken from the manifests or scripts rather than guessed.
- Entry points and what triggers each.
- The traced flow as an ordered list of hops: file, function, what it does, what it hands on.
- The data model: primary stores, key tables or collections, and the core domain objects everything else revolves around.
- Key modules: only those that matter, one line on responsibility and one on what depends on them.
- Cross-cutting machinery: configuration, secrets, auth, logging, error handling, background work, feature flags.
- External boundaries: every network dependency, and what happens when it is unavailable.
- Conventions worth copying, and the seams the code uses for testing.
- Domain vocabulary: terms this codebase uses in a non-obvious way.
- Sharp edges: legacy corners, global state, implicit ordering, anything easy to break unknowingly.

Cite a file path for every claim. Where the code does not tell you, write "unclear" and say what you would read next, rather than guessing. Distinguish what is genuinely live from what looks aspirational or abandoned.

Output scannable markdown under those headings, ending with a "where to change what" table: common task, the file to open first, and the test that would catch a mistake.`,
  },
  {
    id: 'preset-write-tests',
    name: 'Write tests',
    description: 'Tests in the repo existing style that provably fail when behaviour breaks: contract first, boundaries, real error paths, no flakiness.',
    origin: 'preset',
    variables: [
      { name: 'target', label: 'Code or behaviour to test', default: 'the code I point you at' },
    ],
    body: `Write tests for {{target}}.

Before writing anything:
1. Read several existing test files and copy their conventions exactly — framework, runner, directory, file and test naming, fixtures, factories, assertion helpers, setup and teardown. Do not introduce a new library or a new pattern.
2. Find how tests are run here and run the suite once, so you know what green looks like before you touch it.
3. Read the code under test and write down the contract it must honour: inputs, outputs, errors, side effects, invariants.
4. Enumerate the cases you intend to cover and why each earns its place. Show me that list.

Cover:
- The happy path, at the level of behaviour a caller actually cares about.
- Boundaries: empty, zero, one, many, maximum, absent, duplicate, out of order, non-ASCII.
- Error paths the code genuinely handles, asserting the specific error, not merely that something threw.
- Invariants and round trips: encode then decode, write then read, idempotency wherever the code claims it.
- A regression case for any bug this code carries a comment or issue about.

Rules:
- A test must fail if the behaviour regresses. If it would still pass with the logic deleted, it is worthless — delete it.
- Assert on observable behaviour and public surface, not on internal call sequences, unless the interaction genuinely is the contract.
- One reason to fail per test. Name tests after the behaviour, not the function.
- Deterministic only: no sleeps, no real clock or timezone, no unseeded randomness, no network, no dependence on test ordering or on state another test left behind. Inject a clock, a seed or a fake instead of waiting.
- Prefer real objects and small hand-written fakes over mock frameworks; mock only at genuine process boundaries.
- Do not change production code unless testability strictly requires it. If it does, make the smallest possible change and justify it explicitly.

Then prove the tests are real: run them, and for each meaningful assertion break the production code temporarily and confirm the expected test — and only that one — fails. Report anything that stayed green.

Output: files added or changed; a table of case, what it pins down, and how you proved it can fail; the test run output; and a short list of behaviours you deliberately left untested and why.`,
  },
  {
    id: 'preset-debug',
    name: 'Debug systematically',
    description: 'Reproduce, reduce, binary-search the path, test one falsifiable hypothesis at a time, fix the cause not the symptom, then verify.',
    origin: 'preset',
    variables: [
      { name: 'problem', label: 'What is going wrong' },
    ],
    body: `Debug the following problem. Find the root cause before you change any code.

Problem: {{problem}}

Method, in order:
1. State the failure precisely: expected behaviour, observed behaviour, verbatim error and stack trace, and how often it happens.
2. Collect the facts already available — logs, recent deploys, recent commits, config or data changes, whether it ever worked and when it stopped.
3. Reproduce it deterministically. If you cannot, say so and work on narrowing the conditions rather than fixing by inspection.
4. Reduce: shrink to the smallest input, test or code path that still fails. Every element you can remove while keeping the failure is a fact you have earned.
5. Map the path the data actually takes, then binary-search it: pick the midpoint, check whether the value is already wrong there, and discard half the path each time.
6. Take one hypothesis at a time. Before each check, write what you expect to see if it is true and what you expect if it is false — a check that cannot come out negative teaches you nothing. Then run it and record what actually happened.
7. Verify assumptions instead of trusting them: that the running code is the code you edited, that the config is the config you read, that the version, branch and cache are what you think.
8. Only once a check confirms the mechanism, write the fix.

Guardrails: no speculative patches, no shotgun edits, no changing several things at once, no "try it and see if it helps". Fix the cause — if you are about to add a null check, first explain why the value is null. If your fix makes the symptom vanish but leaves an observed fact unexplained, you are not done. If three hypotheses have been disproved, stop and tell me what you know and what you would need next.

Output: repro steps; the evidence trail as hypothesis, prediction, check, result; the root cause in plain language including why it was not obvious; the fix and why it addresses the cause; how to verify it holds; a regression test if this repo has tests; and where else the same class of bug could be hiding.`,
  },
  {
    id: 'preset-refactor',
    name: 'Refactor safely',
    description: 'Behaviour-preserving cleanup in small named moves, pinned by tests before and after, with no behaviour change smuggled in.',
    origin: 'preset',
    variables: [
      { name: 'target', label: 'Code to refactor', default: 'the code I point you at' },
    ],
    body: `Refactor {{target}} without changing observable behaviour.

Before editing:
1. Establish what the code does now and who depends on it: callers, tests, public surface, serialised formats, and anything reflective or dynamically dispatched that a rename would silently miss.
2. Establish the safety net. Run the existing tests and record the result. If nothing meaningfully covers this code, first write characterisation tests capturing today's behaviour — including behaviour you believe is wrong — then refactor.
3. Name the specific problem you are solving: duplication, over-long function, tangled responsibility, awkward dependency, misleading names. If you cannot name it, do not refactor it.

Method: work in small individually-valid steps, each a known move — rename, extract function or variable, inline, move, introduce a parameter object, replace conditional with lookup, split a type, delete dead code. Run the tests after each step. Never combine a rename with a move in one step; that is how a mistake becomes invisible in the diff.

Constraints:
- Never mix a behaviour change into a refactor. If you find a bug, note it and leave it unless I say otherwise.
- Keep the public API identical unless I asked for a signature change; if you must change it, update every caller in the same change.
- Prefer deleting code to adding abstraction. Do not add an interface, factory, wrapper or config knob with exactly one caller and no second one in sight.
- Do not widen scope: no drive-by reformatting, no unrelated files, no dependency changes, no reordering imports for taste.
- Stop when it is clear enough. There is no prize for maximum decomposition, and every extra layer is another jump the next reader has to follow.

Verify: the same test or check set must pass before and after with identical results. Confirm the public surface is unchanged where the language allows it, and call out anything technically observable that did shift — log text, error messages, iteration order.

Output: the problem you set out to fix; the ordered list of moves; files changed with the structural change in each; what you deliberately left alone and why; any bug found but not fixed; and the before and after verification output.`,
  },
  {
    id: 'preset-commit-message',
    name: 'Write a commit message',
    description: 'Reads the real diff, checks atomicity and proposes a split if needed, then a conventional-commit subject and a body explaining why.',
    origin: 'preset',
    body: `Write a git commit message for the current changes.

Read the actual diff first — staged if anything is staged, otherwise the working tree — and read git log to learn this repo's conventions. Write from the code, not from our conversation, and never describe a change the diff does not contain.

Check atomicity before writing prose. If the diff mixes unrelated concerns — a fix plus a refactor, two features, formatting plus logic — say so and propose a split: one message per commit, with the files or hunks that belong to each. One coherent change per commit beats one message that has to hedge.

Format, unless git log shows a different house style, in which case match the repo:
- Subject: type(scope): imperative summary, at most 72 characters, no trailing period. Types: feat, fix, refactor, perf, test, docs, build, ci, chore. Scope is the module or area, omitted when it would be noise.
- Blank line.
- Body wrapped at 72 columns, covering why the change was needed, what approach it takes, and which alternative you rejected when the choice is not self-evident. Explain the reasoning a reader will not recover from the diff in six months. State user-visible behaviour changes explicitly.
- Footer: BREAKING CHANGE with the migration path; issue or ticket references; co-authors.

Judgement: omit the body only when the change is genuinely trivial. Do not restate the diff line by line, do not pad, and do not claim testing or review you did not perform.

Output the message alone as plain text ready to paste, with no commentary and no surrounding code fence. If you are proposing a split, output one clearly labelled message per commit with its file list. Do not run git commit, git add or git push.`,
  },
  {
    id: 'preset-pr-description',
    name: 'Write a PR description',
    description: 'Diff-grounded PR body: summary, motivation, approach, testing evidence, risk and rollback, plus where reviewers should look hardest.',
    origin: 'preset',
    variables: [
      { name: 'base_branch', label: 'Base branch the PR targets', default: 'main' },
    ],
    body: `Write a pull request description for this branch against {{base_branch}}.

Read the real diff and the branch's full commit log first. Every claim must be traceable to the diff — invent nothing: no changes, no motivation, no tests, no screenshots. If the branch is too large to read fully, say what you skipped.

Write for a reviewer who has ten seconds for the top of the page and forty minutes for the code. Your job is to spend their attention where it pays.

Sections, dropping any that genuinely has nothing in it rather than padding it:
- Summary: what changes and what it means for a user or caller, in two or three sentences.
- Why: the problem, ticket or incident behind it — not a restatement of the code.
- Approach: the design decision that shaped the diff and the alternative rejected, only where it is not obvious.
- What changed: bullets grouped by area, each naming files or modules, so the reviewer can plan their pass.
- Testing: exactly what you ran and what it showed — commands, new tests, manual steps — and plainly what remains untested.
- Risk and rollout: blast radius, migrations and whether they reverse, backfills, config or environment variables, feature flags, ordering constraints between services, and the rollback path.
- Compatibility: API, wire-format, database or public behaviour changes, and who else has to change with you.
- Review focus: the two or three places you most want a human to examine, each with the specific question you want answered.
- Follow-ups: gaps deliberately left out of scope, and whether they are tracked.

Be candid about the weak spots. A description that hides the shaky part costs more in review than it saves.

Output markdown ready to paste into the PR body, with a suggested PR title in the repo's convention on the first line. Do not create, push, approve or merge the PR.`,
  },
  {
    id: 'preset-security-review',
    name: 'Security review',
    description: 'Adversarial pass over changed code: map entry points, trace source to sink, check injection, authz, secrets, crypto, SSRF, races.',
    origin: 'preset',
    body: `Review the changed code in this branch or working tree for security defects. Reason like an attacker probing it, not like the author explaining it.

Method:
1. Map the attack surface in the diff: every new or changed entry point — route, handler, message consumer, CLI flag, webhook, file parser, template — and who can reach it, from anonymous to authenticated tenant to admin.
2. Trace untrusted data from each source to every sink it reaches: database query, process spawn, filesystem path, outbound HTTP request, template render, deserializer, redirect, log line, generated code.
3. For each flow ask what the attacker controls, and what they would have to send to break the assumption the sink is making.

Check specifically:
- Injection: SQL and NoSQL, OS command and argument, path traversal, XSS including sinks that bypass escaping, template injection, header and log injection, XXE.
- Authorization: is every entry point authenticated, and is object-level ownership checked rather than mere membership? Look for identifiers taken from the request and trusted. Check tenant isolation on every query touching shared tables.
- Authentication and session: token generation, expiry, revocation, constant-time comparison, cookie flags, post-login redirects.
- Secrets: hardcoded credentials or keys, secrets reaching logs, error responses, URLs, analytics or persisted rows, or committed to the repo.
- Crypto misuse: home-grown crypto, ECB, static or reused IVs, weak or unsalted password hashing, predictable randomness where security depends on it.
- SSRF and outbound calls: user-controlled URLs, unvalidated redirects, requests able to reach internal addresses or metadata endpoints.
- Deserialization and dynamic execution: unsafe deserializers, eval, dynamic import or reflection driven by input.
- Races and TOCTOU: check-then-use on files or permissions, non-atomic balance or quota updates, double submission.
- Resource abuse: unbounded reads, uploads or pagination, missing rate limits, catastrophic-backtracking regexes, decompression bombs.
- Data exposure: over-broad responses, mass assignment, PII in logs, verbose errors, missing redaction.
- Configuration and dependencies: TLS verification disabled, permissive CORS, debug endpoints, default credentials, and new or bumped packages where the manifest or lockfile actually changed.

Rate honestly. If you cannot describe a concrete path from an attacker to the sink, mark it informational rather than inflating it, and check for mitigations that already exist earlier in the request path before calling something exploitable.

Output findings sorted critical, high, medium, low, informational. For each: file:line, the attack path in one or two sentences, the impact including what data or capability is gained, the preconditions the attacker needs, and the concrete remediation. Then list the surfaces you examined and found sound. State explicitly if you found nothing. Do not apply fixes and do not attempt live exploitation.`,
  },
  {
    id: 'preset-document',
    name: 'Document this module',
    description: 'Audience-first docs: intent, mental model, public surface, invariants, failure modes, limits and a real example the code cannot state.',
    origin: 'preset',
    variables: [
      { name: 'target', label: 'Module, package or component', default: 'the module I point you at' },
    ],
    body: `Document {{target}}.

First decide the audience and the job the document does: onboarding a newcomer, a reference for a caller integrating against it, or a rationale record for a future maintainer. Say which you chose — mixing all three produces a document nobody finishes.

Then read the code and its call sites before writing a word. Documentation that paraphrases the implementation is worse than none, because it rots silently. Write what the code cannot say for itself: intent, constraints, consequences.

Cover:
- Purpose: the problem it solves, why it exists, and what would break without it.
- Mental model: the two or three concepts a reader needs before the API makes sense, in the vocabulary the code itself uses.
- Public surface: the functions, types, endpoints or events callers are meant to use. For each: what every parameter means beyond its type, the return, the errors, the side effects.
- Invariants and preconditions: what must hold going in, what is guaranteed coming out, required ordering, and what is not thread-safe, not idempotent or not reentrant.
- A usage example lifted from a real call site, complete enough to run, including imports and setup.
- Failure modes: what it raises or returns on each error, whether it is retryable, and what the caller should do.
- Performance and limits: complexity, blocking behaviour, batch sizes, rate limits, any ceiling worth knowing before it is hit.
- Configuration: environment variables and options, their defaults, and what changing each actually does.
- Boundaries: what it deliberately does not handle, and what to use instead.
- Rationale: the non-obvious decisions and their reasons, so a future reader does not simplify them back into a bug.

Skip private helpers unless they carry a surprising rule, and never document what the signature already says. Where the code did not let you determine something, mark it unverified rather than inventing it, and collect those items at the end.

Output the finished document as markdown matching this repo's existing docs layout, headings and tone, plus the exact file path where it should live and any index or table of contents needing a new link.`,
  },
  {
    id: 'preset-fix-failing-test',
    name: 'Fix a failing or flaky test',
    description: 'Decide whether test or code is wrong and prove it, characterise flakes by failure rate, fix the cause, never weaken the assertion.',
    origin: 'preset',
    variables: [
      { name: 'test_name', label: 'Test name or file' },
      { name: 'failure_output', label: 'Pasted failure output, if you have it' },
    ],
    body: `Investigate a failing or flaky test.

Test: {{test_name}}

Failure output as I have it — if this is blank or summarised, reproduce and capture the real output yourself:
{{failure_output}}

Run it yourself first and capture the real output, including the compared values and the full stack — never work from a summarised report. Then answer one question before touching anything: is the test wrong, or is the code wrong? Commit to an answer and show the evidence.

Hard failure:
1. Read the assertion, the value it actually received, and the code path that produced that value.
2. Walk back from the assertion to the first point where reality diverges from the expectation.
3. Rule out the boring causes before the interesting ones: stale build artifact, stale snapshot or fixture, changed dependency, environment variable, wrong working directory, or a test that was passing for the wrong reason until now.
4. Decide: if the behaviour changed intentionally, update the test and state what contract changed. If not, fix the code.

Flake:
1. Characterise it. Run it many times in isolation, many times inside the full suite, and in a different order, recording the failure rate in each mode. Where the rate differs is most of the diagnosis.
2. Match it to a mechanism rather than a category: shared mutable state or a store not reset between tests, ordering dependence, real clock, timezone or DST boundary, unseeded randomness or hash ordering, unawaited async work, a fixed sleep standing in for a condition, port or temp-file collisions under parallel execution, network or filesystem reliance, resource exhaustion late in a long run.
3. Fix the cause: inject the clock, seed the randomness, await the real condition, isolate the fixture, make setup and teardown symmetric.

Guardrails: never make a test pass by weakening the assertion, widening a tolerance, adding a retry, extending a timeout or skipping it — unless you argue explicitly that the test asserted the wrong thing and state the right assertion. If you must quarantine something to unblock, say so plainly and record the open question rather than burying it.

Output: the original failure output; the diagnosis naming the mechanism, not the category; whether test or code was at fault; the fix; and the verification run. For a flake, give the failure rate before and at least fifty consecutive green runs after, in the same mode that used to fail.`,
  },
  {
    id: 'preset-find-regression',
    name: 'Find when this broke',
    description: 'Build a deterministic check, bound and bisect history to the first bad commit, confirm it flips, explain the mechanism, then advise.',
    origin: 'preset',
    variables: [
      { name: 'regression', label: 'What broke, and what it used to do' },
    ],
    body: `Find the commit that introduced this regression: {{regression}}

1. Build a cheap deterministic check first: one command, script or test that exits non-zero on the broken behaviour and zero on the good behaviour, runs in seconds, and touches as little of the system as possible. Confirm it reports broken at the current HEAD. A bisect driven by an unreliable check produces a confident wrong answer.
2. Bound the search. Find a revision you can confirm good — a release tag, a deployment record, or the last date it demonstrably worked — and verify the transition actually lies inside that range before searching within it.
3. Bisect. Use git bisect run with your check where the build allows; otherwise bisect manually and say so. At each step rebuild and reinstall dependencies if the project needs it, so you are testing that revision's code and not a stale artifact. Mark revisions that fail to build for unrelated reasons as skip, never as bad.
4. If bisect is impractical — merge-heavy history, long builds, environment-dependent failure — say so and search directly instead: git log filtered to the suspect paths, and a pickaxe search for the symbol or string involved.
5. Consider causes outside the repo: a floated dependency, a regenerated lockfile, data or configuration drift, an external API change. A clean bisect landing on an innocent-looking commit is a hint that the real trigger is external.

Then confirm and explain: check out the suspect commit and its parent and demonstrate that your check flips between them. Read the diff and explain the actual mechanism — which change produced which behaviour, and why the consequence was not obvious at the time. Say whether that commit introduced the bug or merely exposed a latent one.

Finally recommend revert, forward fix, or deliberate acceptance, with reasoning — including whether later work has been built on top of it, and whether the same pattern was applied elsewhere at the same time.

Output: the repro check as a runnable command; the good and bad bounds used; the first bad commit with hash, subject, author and date; the demonstration that it flips there; the mechanism in plain language; the recommended remedy; and a regression test that would have caught it. Do not revert, commit, push or force-push without asking me first.`,
  },
  {
    id: 'preset-performance',
    name: 'Investigate a performance problem',
    description: 'Define the metric, baseline on realistic data, profile with a real tool, fix only the dominant cost, re-measure and check side effects.',
    origin: 'preset',
    variables: [
      { name: 'symptom', label: 'Slow operation and how it shows up' },
    ],
    body: `Investigate this performance problem: {{symptom}}

Measure first; do not optimise from intuition and do not change code before you have a baseline.

1. Define the metric and the target: latency at which percentile, throughput at what concurrency, memory ceiling, cold start, bundle size, cost per request. "Feels slow" is not a metric. State what would count as done, so you know when to stop.
2. Establish the baseline. Build a repeatable benchmark against a realistic workload and data volume — profiling ten rows will point you at the wrong thing. Warm up, run enough iterations, and report the median with its spread. If run-to-run variance exceeds the improvement you are chasing, fix the measurement before the code.
3. Profile with a real tool from this stack: sampling profiler, allocation profiler, query log with EXPLAIN, browser performance trace, flame graph. Report where time and memory actually go, with figures. Never name a hot spot you did not observe.
4. Identify the dominant cost and check it against the usual suspects: N+1 queries or requests, a missing or unused index, work repeated in a loop that could be hoisted or batched, repeated serialisation and parsing, needless copying or allocation on a hot path, synchronous I/O blocking a worker, an algorithm that turns quadratic at real input sizes, absent caching or caching at the wrong layer, an extra network hop, over-fetching data that is then discarded.
5. Fix the dominant cost only. Amdahl decides this: a tenfold speedup of something taking five percent of the time is invisible. If the profile is flat with no dominant cost, say so — the honest answer may be that the architecture, not a hot spot, is the problem.
6. Re-measure with the identical benchmark and compare against baseline including variance. Then check second-order effects: memory, cache hit rate, database load, tail latency, and behaviour under concurrency.

Guardrails: never trade correctness, safety or readability for a speedup the measurement does not justify. Call out any change in behaviour, staleness, ordering or memory the fix introduces. If the change did not deliver, revert it and say so rather than keeping a complication that bought nothing.

Output: metric and target; benchmark and workload; baseline figures with spread; profile evidence naming the dominant cost and its share; the single change made; after figures; the improvement in percentage and absolute terms; second-order effects checked; and what you would attack next if the target is still unmet.`,
  },
  {
    id: 'preset-dependency-upgrade',
    name: 'Upgrade a dependency safely',
    description: 'Sweep every major hop for breaking changes, map the blast radius before editing, upgrade coherently, verify, then list manual checks.',
    origin: 'preset',
    variables: [
      { name: 'dependency', label: 'Package to upgrade' },
      { name: 'target_version', label: 'Target version', default: 'latest stable' },
    ],
    body: `Upgrade {{dependency}} to {{target_version}}. If no target version is given, take the latest stable release and say which that is.

1. Establish the delta: current version, target, and every intermediate major release. Check why the current version is pinned — a comment, a lockfile note or a past revert often explains a constraint you are otherwise about to rediscover the hard way. Note whether it is a direct dependency or one reached only transitively.
2. Read the changelog and migration guide for every major hop, not just the last. List breaking changes, removed and deprecated APIs, changed defaults and silent behaviour changes. Then filter that list against what this repo actually calls, and say what you filtered out.
3. Map the blast radius before editing. Find every use of the affected APIs, including indirect use through local wrappers and helpers, configuration files, type definitions and stubs, generated code, test fixtures and mocks mimicking the old shape, and documentation examples. List the call sites first; edit second.
4. Check the surrounding ecosystem: peer dependency ranges, plugins or adapters pinned to the old major, runtime or language version requirements, and other packages depending on it transitively at a conflicting version.
5. Where several majors are involved, prefer stepping one at a time and verifying at each stop. A single leap across three majors makes failures uninterpretable.
6. Apply the change coherently — manifest, lockfile and code together, plus any codemod the maintainers ship, reviewed rather than trusted blindly.
7. Verify: install cleanly from the lockfile, then build, typecheck, lint and run the full test suite. Fix fallout at the source. Never pin back, cast, ignore or suppress a warning to force the build green without saying so explicitly.

Then be honest about what verification cannot see: runtime-only behaviour, changed defaults, altered error strings someone may be matching on, performance shifts, and paths exercised only in production. Those belong on a manual-check list, not inside a claim that everything passed.

Output: the version delta and hops taken; each breaking change that mattered and how you handled it; the call sites found and changed; files changed; the exact verification commands with their results; the residual risks I should test by hand; and the rollback procedure, including whether reverting the lockfile alone is sufficient.`,
  },
  {
    id: 'preset-compare-approaches',
    name: 'Compare two approaches',
    description: 'Pin the decision criteria, ground the options in this codebase, weigh cost to build and to live with, then commit to one recommendation.',
    origin: 'preset',
    variables: [
      { name: 'approach_a', label: 'First approach' },
      { name: 'approach_b', label: 'Second approach' },
    ],
    body: `Compare these approaches and give me one recommendation.

Approach A: {{approach_a}}
Approach B: {{approach_b}}

1. Pin down the decision first: state the question in one sentence, the non-negotiable constraints (deadline, team size, existing stack, compliance, expected scale), and how you would know in six months that it was the right call. A comparison without a decision criterion is just a list of adjectives.
2. Ground it in this codebase. Existing patterns, dependencies already present, team familiarity and the operational surface constrain this far more than abstract merit does. Read enough to say what is already here, and cite it.
3. Include the cheap options as real candidates: doing nothing, the smallest version that solves eighty percent of the problem, and buying instead of building. One of them wins more often than the framing of the question suggests.

For each option give:
- How it works, in two or three sentences, concrete enough that someone could start tomorrow.
- Cost to build: rough scope, and what else has to change around it.
- Cost to live with: operations, on-call surface, upgrades, and the tax on everyone who touches it later.
- How it fails: the realistic failure mode, how it is detected, and how bad the worst case gets.
- What it forecloses: what becomes hard or impossible afterwards, and how expensive it is to reverse.

Then a comparison table using only criteria that actually decide this case — drawn from complexity, fit with existing code, performance, operational burden, testability, failure modes, security surface, migration cost, reversibility, dependency footprint, team familiarity. Drop any criterion where the options tie; a row that does not discriminate is noise. Say which criteria you weighted most and why.

Be honest about the losing option's genuine advantages, and name the conditions under which your answer flips. Separate what you know from what you are assuming, and flag any assumption cheap enough to settle with a short spike. Weight reversibility heavily: a decision that is easy to undo deserves less deliberation than one that is not.

End with one recommendation stated plainly: the option, the single strongest reason, the main risk you are accepting, and the first step to take. No fence-sitting, no "it depends", no ranking without a winner. Do not implement anything yet.`,
  },
  {
    id: 'preset-write-feature-spec',
    name: 'Write a spec for a new feature',
    description: 'Turn a feature idea into a grounded specification — behaviour, constraints and done-when, not an implementation plan. Optional grill-me first; leave grill empty to skip it.',
    origin: 'preset',
    variables: [
      { name: 'feature', label: 'Feature to specify' },
      { name: 'grill', label: 'Grill me first? (empty / none = no)' },
    ],
    body: `Write a **specification** for a feature we are considering. Spec only: what it is, who it is for, how it should behave, and how we will know it is done. This is not an implementation plan, not a task list, and not a file-by-file patch guide. Do not implement anything.

Feature: {{feature}}

Grill me first: {{grill}}

Treat grilling as **off** unless {{grill}} clearly asks for it (yes, grill, grill-me, true). Empty, none, no, skip, and "do not use this instruction" all mean do not grill — explore the codebase and write the spec without interviewing me first. If grilling is on: interview me relentlessly about this feature until we share an understanding; one question at a time, wait for my answer; give your recommended answer with each question; if the codebase can answer it, explore instead of asking; do not write the spec until grilling is finished.

Then produce the spec:
1. Ground it in this repository so the spec is true of *this* product, not a generic app. Read enough to know existing behaviour, vocabulary, and constraints. If the idea conflicts with how this codebase works, say so in the spec rather than papering over it.
2. Write the spec to a file, not only in chat. Follow this repository's convention for **specs** (CLAUDE.md / AGENTS.md / a specs directory — never a plans/ directory, and never an implementation-plan template). Prefer \`YYYY-MM-DD-<slug>.md\`. Report the path.
3. Cover, concretely: the problem and who it is for; desired behaviour and important edge cases; what is in scope and what is not; success criteria / "done when"; constraints (security, compatibility, existing UX); open questions and assumptions labelled as such; risks and what would falsify the design.
4. Do **not** include: ordered implementation tasks, "touch file X then Y", bite-sized coding steps, TDD checklists, commit instructions, or a writing-plans / executing-plans workflow. A later planner may turn this spec into a plan; you are not that planner.

Guardrails: do not write production code, do not commit, do not deploy, do not produce a plan document. Stop and ask only on a genuine ambiguity the codebase cannot settle.

Output: whether you grilled and what that changed; the spec file path; a short summary of the specified behaviour and the open questions still on me.`,
  },
  {
    id: 'preset-orchestrate-pipeline',
    name: 'Orchestrate plan → build → review',
    description: 'Run a three-stage delegation: a planner, an implementer and an adversarial reviewer picked from the roster, with you judging every handoff.',
    origin: 'preset',
    variables: [
      { name: 'task', label: 'What the pipeline should deliver' },
      { name: 'planner', label: 'Roster role to plan', default: 'Claude Opus 5 Planner', source: 'roster' },
      { name: 'implementer', label: 'Roster role to implement', default: 'Grok 4.6 Implementer', source: 'roster' },
      { name: 'reviewer', label: 'Roster role to review adversarially', default: 'Cursor Opus', source: 'roster' },
    ],
    body: `Act as the orchestrator for the task below. You are not the implementer: you delegate through a plan, build and adversarial review pipeline, and you own the handoffs between the stages.

Task: {{task}}

Stage roles, named exactly as they appear in the delegate roster in your preamble:
- Planner: {{planner}}
- Implementer: {{implementer}}
- Adversarial reviewer: {{reviewer}}

Before spawning anything:
1. Re-read the delegate roster in your preamble and list every role it offers together with its "used when" description, so we can both see what was available and what you selected. The roster is a hard allow-list enforced server-side — an unknown role is rejected with HTTP 400, never silently substituted.
2. If any of the three roles above is missing from that roster, stop and show me the roster. Do not fall back to a similar-looking role, do not reuse a profile id from another conversation, and do not retry a rejected spawn with a different profile hoping it will be accepted.
3. Read enough of this repository yourself to write a brief a cold agent could execute. Every child starts with no memory of this conversation, so anything you know and do not write down is lost.

Stage 1 — plan. Give the planner the goal, the constraints, the files you already know are involved, and what "done" means. Require the plan as a file in the repository, with the path reported back, rather than as prose in a chat response. Read the plan yourself when it lands and judge it: if it is vague, mis-scoped, or solves a different problem, send it back or replan before spending an implementation on it.

Stage 2 — build. Give the implementer the plan's file path, not a paraphrase of the plan. State the verification gates it must run and the fact that it must not declare success on unrun commands. Require the list of files it touched.

Stage 3 — adversarial review. Brief the reviewer to disprove the work, not to bless it: hunt for the case the implementer did not consider, the gate that passes for the wrong reason, the requirement from the plan that quietly went missing. Give it the plan path and the diff, and tell it explicitly that finding nothing is an acceptable answer only if it lists the surfaces it checked. Do not let the implementer review its own work.

Delegation mechanics, every time:
- Write the task prose to a file under \`.tierwyn/delegates/\` and post it with \`--data-binary @path\`. Never put task prose on the curl command line — quotes, parentheses and newlines will break it.
- Spawn async (\`X-Spawn-Wait: false\`, \`X-Spawn-Notify: true\`) and then end your turn. A one-shot upstream notify wakes you when the child finishes. Do not sleep, poll, loop on a timer, or mint a schedule job to check on a child.
- Require every child to end with a "## Result" section listing the files it touched with full paths, the decisions it made and why, and what you need to know to continue. Forbid a bare "Done" or "Completed" as the whole response — once a child finishes it cannot be asked anything, so that one response is your only channel back.
- Require any plan, spec or multi-step artifact to be written to a file, with the path named in "## Result", so the next stage can read it instead of reconstructing it from prose.
- If a child returns a degenerate or truncated result, re-fetch its transcript with \`GET /spawn/<childId>/result\` once, or read its RESULT.md. Mid-turn narration is not completion.

Guardrails: run the stages in order and read each result before commissioning the next — a pipeline where you forward output unread is just an expensive relay. Carry the reviewer's findings back to the implementer rather than fixing them yourself; if you find yourself writing the code, say so and stop, because that is the signal the delegation was the wrong shape. Do not commit, push or deploy unless I asked.

Output after each stage: which role you spawned, the child conversation id, the artifact path it produced, your own judgement of that artifact, and what you are commissioning next. At the end: the roster you chose from, the three children and their results, the review findings and their disposition, the files changed, the gates run with their output, and anything still open.`,
  },
  {
    id: 'preset-orch-add-feature',
    name: 'Orchestrate adding a feature',
    description: 'Run the plan → build → review pipeline for a new feature: planner specs integration points and house conventions, implementer builds with gates, adversarial reviewer tries to disprove it.',
    origin: 'preset',
    variables: [
      { name: 'feature', label: 'Feature to add' },
      { name: 'planner', label: 'Roster role to plan', default: 'Claude Opus 5 Planner', source: 'roster' },
      { name: 'implementer', label: 'Roster role to implement', default: 'Grok 4.6 Implementer', source: 'roster' },
      { name: 'reviewer', label: 'Roster role to review adversarially', default: 'Cursor Opus', source: 'roster' },
    ],
    body: `Act as the orchestrator for adding a new feature to this project. You are not the implementer: you delegate through a plan, build and adversarial review pipeline, and you own the handoffs between the stages.

Feature to add: {{feature}}

Stage roles, named exactly as they appear in the delegate roster in your preamble:
- Planner: {{planner}}
- Implementer: {{implementer}}
- Adversarial reviewer: {{reviewer}}

Before spawning anything:
1. Re-read the delegate roster in your preamble and list every role it offers together with its "used when" description, so we can both see what was available and what you selected. The roster is a hard allow-list enforced server-side — an unknown role is rejected with HTTP 400, never silently substituted.
2. If any of the three roles above is missing from that roster, stop and show me the roster. Do not fall back to a similar-looking role, do not reuse a profile id from another conversation, and do not retry a rejected spawn with a different profile hoping it will be accepted.
3. Scope the feature yourself before writing any brief: read enough of this repository to name where the feature plugs in — the files and modules it touches, the existing patterns it should follow, and the conventions (naming, error handling, tests, docs) already in place. Every child starts with no memory of this conversation, so anything you know and do not write down is lost. If the feature as described conflicts with how this codebase works, surface that now rather than building the briefs on top of it.

Stage 1 — plan. Brief the planner with the feature, the integration points you found, the house conventions it must follow, and what "done" means including the tests and docs this repository expects. Require the plan as a file in the repository, with the path reported back, rather than as prose in a chat response. Read the plan yourself when it lands and judge it: does it implement the feature as asked, reuse what is already here instead of reinventing it, and name the smallest coherent change? If it is vague, over-scoped, or solves a different problem, send it back or replan before spending an implementation on it.

Stage 2 — build. Give the implementer the plan's file path, not a paraphrase of the plan. State the verification gates it must run (build, typecheck, tests as this repository defines them) and the fact that it must not declare success on unrun commands. Require the diff to stay minimal and to read like the code around it. Require the list of files it touched.

Stage 3 — adversarial review. Brief the reviewer to disprove the work, not to bless it: hunt for the edge case the plan never considered, the requirement that quietly went missing between the plan and the diff, the test that passes for the wrong reason, and the regression to existing behaviour this change could cause. Give it the plan path and the diff, and tell it explicitly that finding nothing is an acceptable answer only if it lists the surfaces it checked. Do not let the implementer review its own work.

Delegation mechanics, every time:
- Write the task prose to a file under \`.tierwyn/delegates/\` and post it with \`--data-binary @path\`. Never put task prose on the curl command line — quotes, parentheses and newlines will break it.
- Spawn async (\`X-Spawn-Wait: false\`, \`X-Spawn-Notify: true\`) and then end your turn. A one-shot upstream notify wakes you when the child finishes. Do not sleep, poll, loop on a timer, or mint a schedule job to check on a child.
- Require every child to end with a "## Result" section listing the files it touched with full paths, the decisions it made and why, and what you need to know to continue. Forbid a bare "Done" or "Completed" as the whole response — once a child finishes it cannot be asked anything, so that one response is your only channel back.
- Require any plan, spec or multi-step artifact to be written to a file, with the path named in "## Result", so the next stage can read it instead of reconstructing it from prose.
- If a child returns a degenerate or truncated result, re-fetch its transcript with \`GET /spawn/<childId>/result\` once, or read its RESULT.md. Mid-turn narration is not completion.

Guardrails: run the stages in order and read each result before commissioning the next — a pipeline where you forward output unread is just an expensive relay. Carry the reviewer's findings back to the implementer rather than fixing them yourself; if you find yourself writing the code, say so and stop, because that is the signal the delegation was the wrong shape. Do not commit, push or deploy unless I asked.

Output after each stage: which role you spawned, the child conversation id, the artifact path it produced, your own judgement of that artifact, and what you are commissioning next. At the end: the feature as shipped, the three children and their results, the review findings and their disposition, the files changed, the gates run with their output, and anything still open.`,
  },
  {
    id: 'preset-adversarial-review',
    name: 'Spawn an adversarial reviewer',
    description: 'Delegate a disprove-it review of work already done: fresh eyes, no authorship bias, findings with evidence and a plain ship or do-not-ship verdict.',
    origin: 'preset',
    variables: [
      { name: 'subject', label: 'What should be reviewed' },
      { name: 'reviewer', label: 'Roster role to review', default: 'Cursor Opus', source: 'roster' },
    ],
    body: `Commission an adversarial review of work that has already been done. Delegate it — the point is fresh eyes without the authorship bias, so do not review it yourself.

Under review: {{subject}}
Reviewer role, exactly as it appears in the delegate roster in your preamble: {{reviewer}}

First confirm the role exists in your roster and say which other roles you passed over and why. The roster is enforced server-side; an unknown role is rejected outright rather than substituted. If {{reviewer}} authored the work under review, say so and pick a different role — a reviewer grading its own homework is theatre.

Then write the reviewer's brief to a file under \`.tierwyn/delegates/\` and post it with \`--data-binary\`. The brief must carry everything a cold agent needs, because it cannot ask you a follow-up question:
- What the work was supposed to achieve, and the plan or spec file path if one exists.
- How to see the change: the branch, the diff command, or the specific files.
- How to run the tests and gates itself, so it can verify rather than trust.
- The standard: its job is to disprove the work, not to bless it. Reward finding the case nobody considered, the gate that passes for the wrong reason, the requirement that quietly went missing between the plan and the diff, the test that would still pass if the logic were deleted.
- The honesty rules: separate what it verified by reading or running from what it inferred, label the inferences, and name the evidence that would settle them. Do not inflate a preference into a defect, and do not pad a report to look thorough. Finding nothing is a legitimate result, but only alongside the list of surfaces checked.
- Guardrails: report, do not fix. No commits, no refactors, no drive-by edits.
- The output contract: findings worst-first as severity, file:line, what is wrong, why it matters, the concrete fix; then the surfaces checked and found sound; then one verdict line — ship, ship with nits, or do not ship.

Spawn async with notify on and end your turn; the upstream notify will wake you. Do not poll for the result.

Require the reviewer to end with a "## Result" section listing every file it touched, its key judgements and reasoning, and what you need in order to act — and forbid a terse acknowledgement as the entire response. Require the full review itself to be written to a file, with the path named in "## Result".

When it returns, do not just forward it to me. Triage it: for each finding say whether you agree, and where you disagree give the reason. Sort the findings into fix now, fix later with a tracked note, and reject with justification. A review you pass through unexamined has bought nothing.

Output: the reviewer role and why it was the right pick, the child conversation id, the review file path, the findings with your triage decision on each, and your recommendation on whether this ships.`,
  },
  {
    id: 'preset-roster-survey',
    name: 'Survey the delegate roster',
    description: 'Enumerate every role available to spawn with its used-when description, then recommend a concrete assignment for the work at hand.',
    origin: 'preset',
    variables: [
      { name: 'task', label: 'Work to staff', default: 'the work in this conversation' },
    ],
    body: `Show me the delegation capability I actually have here, then recommend how to staff a piece of work with it.

Work to staff: {{task}}

First, enumerate the roster. Read the delegate roster in your preamble and list every role it offers, in a table: the role name exactly as it must be spelled when spawning, the agent and model behind it, and its "used when" description verbatim. Do not paraphrase the descriptions and do not invent roles that are not there — the roster is a hard allow-list enforced server-side, and an unknown role is rejected with HTTP 400 rather than resolved to something close.

Note the operating limits alongside it: your spawn depth budget, whether any role is marked as a fallback for another that may be rate limited, and any role you would be unable to use for this particular task because of the interaction mode it requires.

Then recommend an assignment for the work above:
- Break the work into the stages that genuinely want different agents — typically planning, implementation and adversarial review, but say plainly if this work only needs one of them. Not everything deserves a pipeline, and a three-stage handoff on a ten-line change costs more than it returns.
- For each stage name the role you would use, the reason that role over the alternatives, and what you would hand it as input.
- Name the fallback for each stage and the condition that would trigger it, since rate limits are the usual reason a plan stalls halfway.
- Say what you would deliberately keep in this conversation rather than delegate, and why — the work where writing a brief costs more than doing the thing is work that should not be delegated.
- Flag any stage where the roster has no good fit, rather than forcing the nearest role into it.

Do not spawn anything yet. This is a survey and a staffing proposal; I will tell you when to execute it.

Output: the roster table; the operating limits; the staged assignment with roles, reasons, inputs and fallbacks; what stays local; and any gap in the roster this work exposes.`,
  },
  {
    id: 'preset-land-branch',
    name: 'Land this branch on main',
    description: 'Survey the working branch, integrate it into the target branch (default main) safely, then leave me checked out there with a clean tree.',
    origin: 'preset',
    variables: [
      { name: 'target_branch', label: 'Branch to land onto', default: 'main' },
    ],
    body: `We are on a working branch. Integrate it into the target branch and leave me there. Target branch: {{target_branch}} — if that is blank, use the repository's default branch (check the remote, do not assume).

Survey before touching anything:
1. \`git status\`, \`git branch --show-current\`, \`git log --oneline <target>..HEAD\` and \`git log --oneline HEAD..<target>\`. State the current branch, the target, how far each has diverged, and whether the tree is dirty.
2. Uncommitted changes are a decision, not an obstacle: list them and ask whether to commit, stash or discard unless I already said. Never discard silently, and never \`git checkout .\`, \`reset --hard\` or \`clean -fd\` on files I have not agreed to lose.
3. Check whether the branch is pushed and whether it has an open PR. If a PR exists, prefer merging through it over merging locally behind its back.
4. Read any repository instructions (CLAUDE.md, AGENTS.md, CONTRIBUTING) for the project's merge convention, protected branches, or anything the branch must not clobber on the target.

Then integrate:
5. Pick the mechanism and say why in one line: merge (preserves history, default), squash (many scrappy commits, one logical change), rebase then fast-forward (linear history is the house style), or PR merge if one is open. If the choice is genuinely close, take the one that matches existing history in \`git log\` on the target.
6. Update the target from its remote first, integrate, and stop at the first conflict rather than guessing. Conflicts: show me the conflicting hunks and your proposed resolution, resolve semantically rather than by picking a side, and never resolve by taking whichever version makes the build pass without understanding it.
7. Verify after integrating, before pushing: build, typecheck and the test suite as this repository defines them. A merge that compiles on each side and breaks combined is the normal failure here.

Finish:
8. Push if the branch was already published, and say exactly what you pushed where. Do not force-push a shared branch.
9. Leave me checked out on the target branch with a clean working tree. Confirm with a final \`git status\` and \`git log --oneline -5\`.
10. Delete the merged branch only if I asked; otherwise report it as merged and leave it.

Guardrails: no rewriting published history, no force-push, no dropping stashes, no deleting untracked files. If any step is ambiguous or destructive, stop and ask instead of choosing for me.

Output: the branches and mechanism used, the conflicts and how you resolved them, the verification commands and their results, what was pushed, and the final branch and status.`,
  },
  {
    id: 'preset-docs-sync',
    name: 'Bring the docs up to date',
    description: 'Map the existing docs structure, diff its claims against the code as it is now, then update stale pages and fill real gaps in place — never reorganise.',
    origin: 'preset',
    variables: [
      { name: 'scope', label: 'What to bring up to date', default: 'recent changes in this repository' },
    ],
    body: `Bring this repository's documentation up to date with the code as it is today. Scope: {{scope}}

1. Map the documentation before touching it: where docs live (docs/ tree, root README, AGENTS.md / CLAUDE.md, package READMEs), how pages are named and formatted, and which index or README catalogs each section. The structure and conventions you find are the spec — write inside them, never reorganise them.
2. Establish ground truth for the scope: read the code and the recent history (git log, open diff) and record what the system actually does now — commands, flags, endpoints, paths, workflows, defaults. A page that faithfully describes an old version is worse than a missing one.
3. Diff the claims: for each documented statement in scope, mark it still true, stale, or describing something gone; for each behaviour in scope with no page, mark it missing. Build that gap list before writing anything, so placement decisions are made once with the whole picture, not page by page.
4. Update in place. Prefer editing an existing page over creating one. Create a page only when the content genuinely has no home, and then place, name, format and link it exactly like its siblings — and add it to whatever index or README catalogs that section, because an unindexed page is undiscoverable and will rot.
5. Write documentation, not marketing: real commands, real paths, real flag names, checked against the code rather than reconstructed from memory. Keep the length and tone of the pages around you. Where the code and a doc disagree and you cannot tell which is intended, stop and ask me about that point instead of documenting a guess.
6. Then verify: if this repository has a docs gate (checker script, link check — look in package.json), run it and make it pass. Quote the result.

Guardrails: do not restructure, rename or merge existing pages without my agreement, do not rewrite accurate pages for style, and make no code changes. No commits unless I asked.

Output: the docs map as you found it; the gap list (stale / missing / describing removed behaviour); every page changed or added with a one-line what-and-why; pages you deliberately left alone; the gate output; and anything you could not verify.`,
  },
];

export type ValidatePromptResult =
  | { ok: true; prompt: PromptCollectionEntry }
  | { ok: false; error: string };

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** crypto.randomUUID is secure-context-only; this also runs in the browser on the
 *  plain-HTTP LAN preview path (import preview), where it would be undefined. */
function mintPromptId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Ordered, deduped variable names in first-appearance order. */
export function parsePromptVariables(body: string): string[] {
  // ponytail: linear rescan per keystroke; memoise if the editor ever feels laggy
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(promptVarTokenRe())) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Parsed names, enriched by entry.variables metadata. Orphan metadata ignored. */
export function resolvePromptVariables(
  entry: Pick<PromptCollectionEntry, 'body' | 'variables'>,
): PromptVariable[] {
  const metaByName = new Map<string, PromptVariable>();
  for (const v of entry.variables ?? []) {
    metaByName.set(v.name, v);
  }
  return parsePromptVariables(entry.body).map((name) => {
    const meta = metaByName.get(name);
    if (!meta) return { name };
    const out: PromptVariable = { name };
    if (typeof meta.label === 'string' && meta.label !== '') out.label = meta.label;
    if (typeof meta.default === 'string' && meta.default !== '') out.default = meta.default;
    if (meta.source === 'roster') out.source = 'roster';
    return out;
  });
}

/** Single-pass substitution. Unknown names ⇒ ''. hasOwn guard: `{{constructor}}`
 *  is a legal variable name and must not resolve to an Object.prototype function. */
export function substitutePromptVariables(body: string, values: Record<string, string>): string {
  return body.replace(promptVarTokenRe(), (_match, name: string) =>
    (Object.hasOwn(values, name) ? values[name] : '') ?? '');
}

/** Server-side trust boundary: called by the POST route on operator input. */
export function validateCustomPrompt(input: unknown): ValidatePromptResult {
  if (!isRecord(input)) {
    return { ok: false, error: 'prompt must be an object' };
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';

  if (!name) return { ok: false, error: 'name is required' };
  if (!description) return { ok: false, error: 'description is required' };
  if (!body) return { ok: false, error: 'body is required' };

  if (name.length > PROMPT_NAME_MAX) {
    return { ok: false, error: `name must be ≤ ${PROMPT_NAME_MAX} characters` };
  }
  if (description.length > PROMPT_DESCRIPTION_MAX) {
    return { ok: false, error: `description must be ≤ ${PROMPT_DESCRIPTION_MAX} characters` };
  }
  if (utf8Bytes(body) > PROMPT_BODY_MAX) {
    return { ok: false, error: `body must be ≤ ${PROMPT_BODY_MAX} bytes` };
  }

  const rawId = typeof input.id === 'string' ? input.id.trim() : '';
  if (rawId.startsWith('preset-')) {
    return { ok: false, error: 'id cannot start with preset-' };
  }

  let variables: PromptVariable[] | undefined;
  if (input.variables !== undefined) {
    if (!Array.isArray(input.variables)) {
      return { ok: false, error: 'variables must be an array' };
    }
    if (input.variables.length > PROMPT_VARS_MAX) {
      return { ok: false, error: 'at most 16 variables' };
    }
    const inBody = new Set(parsePromptVariables(body));
    const seen = new Set<string>();
    const kept: PromptVariable[] = [];
    for (let i = 0; i < input.variables.length; i++) {
      const raw = input.variables[i];
      if (!isRecord(raw) || typeof raw.name !== 'string') {
        return { ok: false, error: `variables[${i}].name required` };
      }
      const varName = raw.name;
      if (!PROMPT_VAR_NAME_RE.test(varName)) {
        return { ok: false, error: `variables[${i}].name must match ^[A-Za-z][A-Za-z0-9_]{0,31}$` };
      }
      if (seen.has(varName)) {
        return { ok: false, error: `variables: duplicate name "${varName}"` };
      }
      seen.add(varName);

      let label: string | undefined;
      if (raw.label !== undefined) {
        if (typeof raw.label !== 'string' || raw.label.length > PROMPT_VAR_LABEL_MAX) {
          return { ok: false, error: `variables[${i}].label must be ≤ ${PROMPT_VAR_LABEL_MAX} characters` };
        }
        if (raw.label !== '') label = raw.label;
      }
      let def: string | undefined;
      if (raw.default !== undefined) {
        if (typeof raw.default !== 'string' || utf8Bytes(raw.default) > PROMPT_VAR_DEFAULT_MAX) {
          return { ok: false, error: `variables[${i}].default must be ≤ ${PROMPT_VAR_DEFAULT_MAX} bytes` };
        }
        if (raw.default !== '') def = raw.default;
      }

      if (!inBody.has(varName)) continue;

      const v: PromptVariable = { name: varName };
      if (label !== undefined) v.label = label;
      if (def !== undefined) v.default = def;
      if (raw.source === 'roster') v.source = 'roster';
      kept.push(v);
    }
    if (kept.length > 0) variables = kept;
  }

  const now = Date.now();
  const id = rawId || mintPromptId();
  const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
    ? input.createdAt
    : now;

  return {
    ok: true,
    prompt: {
      id,
      name,
      description,
      body,
      origin: 'custom',
      ...(variables ? { variables } : {}),
      createdAt,
      updatedAt: now,
    },
  };
}
