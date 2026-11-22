# Agent schedule creation: discoverability weaknesses and fixes

Status: implemented, uncommitted. Written after two field reports from agents asked to
create a recurring schedule; one succeeded only after side-channel database access, one
failed entirely and never found the scheduler.

This document describes the failure modes generically. It contains no roster names,
template names, profile ids, ports or conversation ids: everything installation-specific is
resolved at runtime from the database.

---

## Summary of the two field reports

**Attempt A (succeeded, expensively).** The agent knew the scheduler existed and read the
help document. It then could not discover which `templateName` and `profileId` values were
valid, because neither is listed anywhere reachable over agent auth; the help document
explicitly told it to ask the operator. Instead it located the systemd unit, read the
production env file to find the SQLite path, discovered the `sqlite3` CLI was not installed,
fell back to Python's `sqlite3` module, and queried the settings table directly. It also
guessed the wrong table name for profiles on the first try. Only after that did the create
call succeed on the first attempt.

**Attempt B (failed, abandoned).** The agent did not know a scheduler existed. Its preamble
documented only the spawn endpoints, so when asked to "create a schedule" it matched on the
word and reached for tooling from its own harness; cloud routines, then a session-local
cron tool. It correctly reasoned that cloud routines cannot reach a loopback address, but
drew the wrong conclusion from that contradiction: rather than infer its inventory was
incomplete, it concluded local cron was the only remaining option. When finally pointed at
the help endpoint it guessed the wrong path, received `401`, and spent the rest of the
session debugging its bearer token, which had been valid the entire time.

---

## Weakness 1: the schedule pointer was withheld from agents that could use it

**What was wrong.** The delegation preamble appended its "Delayed verification (schedule)"
block only for conversations at spawn-policy depth 0. Any spawned child; even one that was
itself spawn-capable and carried a valid token; received the roster with no mention of the
scheduler.

The authorisation path never had that restriction. `authorizeAgentScheduleCreate` is
explicitly depth-agnostic: it validates that the bearer maps to a live conversation, that
the conversation belongs to the target project, and that the per-conversation and
per-project job caps are not exceeded. Depth is not consulted. So a depth-1 child's token
would have been accepted at the create endpoint; the gate existed only in the prose.

**Why it is the worst of the four.** A capability that is present in the authorisation layer
but absent from the documentation an agent is handed is worse than no capability at all. The
agent does not fail closed and report a limitation; it reaches for whatever adjacent tool
its harness provides and substitutes something with different semantics. In attempt B that
meant a cloud-hosted routine that could not have reached the local API, silently swapped in
for a local scheduled job. Had the agent been slightly less careful, that substitution would
have shipped looking like a success.

**Change.** The `depth === 0` condition on the schedule pointer is removed; the pointer is
emitted at every depth. The comment on the call site now states that the pointer must track
the authorisation rule rather than being tightened independently of it. No authorisation
behaviour changed; the caps remain the sole rate boundary on the token path.

## Weakness 2: no way to say "this is the only scheduler"

**What was wrong.** Agents driving this system arrive with their own scheduling primitives:
cloud-hosted routines, harness-local cron, self-pacing wakeup loops. The word "schedule"
collides across all of them. The preamble named an endpoint but never asserted primacy, so
an agent scanning its available tools for a match found several and had no basis for
preferring the one belonging to this system.

**Change.** Both the spawn preamble and the schedule-only preamble now state plainly that
this is the only scheduler in play and that harness-provided scheduling tools must not be
used for it. They also instruct the agent to read the help document *before* composing the
create call rather than after a failure, which is where the newly-added discovery lists
live.

This is prose, not enforcement. There is no mechanism to prevent an agent from calling its
own cron tool. The instruction is worth having because the failure it prevents is silent:
the wrong scheduler succeeds, and nothing surfaces until the job does not fire.

## Weakness 3: template and profile names were undiscoverable over agent auth

**What was wrong.** Two fields decide whether a scheduled tick can delegate. Both must be
supplied by name, both must match exactly, and neither was listed anywhere an agent holding
a spawn or schedule token could read. `GET /settings/*` and `GET /profiles` both require an
operator cookie and reject either token kind. The help document acknowledged this and
directed the agent to ask the operator.

That instruction is correct and also unusable in practice. An agent mid-task, working from
a one-line operator request, will not stop and ask; it will find another way. Attempt A's
"another way" was reading the production database file. That is a working answer to the
question and an alarming amount of privilege to exercise in order to learn two strings that
are not secret.

The failure has a second edge. Operators refer to templates by description, not by their
stored name, and the two commonly differ. An agent that guesses from the operator's phrasing
gets an `unknown template` rejection whose body named only the rejected string, giving it
nothing to correct toward. The previous help text warned about one specific wrong guess:
submitting JSON array indices, which produced a confusing `unknown template: 6`, which
suggests agents had already been reaching into the settings blob and mishandling its shape.

**Change; a resolver, not a listing.** `GET /agent/schedule-help?resolve=<fragment>` appends a
Resolve section naming any template, and any enabled profile, whose name, id or label contains
the fragment. Each profile match reports its spawn capability, so the agent learns whether the
tick will be able to delegate. Templates come from the settings repository and profiles from
the in-memory catalogue, so a match cannot drift from what the create endpoint will accept.

The deliberate constraint is that **there is no way to enumerate**. A bare request appends only
instructions for using `resolve`; a query under two characters is refused rather than matched
broadly; matches are capped per kind. The agent must already hold a name, which it does, since
the operator's instruction is what named the model or template in the first place. What the
resolver supplies is the mapping from the operator's phrasing to the stored string, which is
the only part the agent could not have known.

This is the narrower of two designs. The first attempt appended the full list of template names
and spawn-capable profiles. It solved the same problem and was rejected for a good reason: it
turned a help endpoint into a complete inventory of every configured agent, model and roster,
returned to any caller on the loopback interface without a credential. The catalogue is not
secret, but handing it over wholesale is a poor default; it is a standing description of the
deployment's capabilities, available to anything that can induce an agent to fetch a URL, and
it grows more informative as the deployment grows. Resolution answers the question the agent
actually has without answering questions it has not asked.

The `unknown template` rejection follows the same rule: it says the name did not exist and
points at `resolve`, rather than enumerating the valid names as a first draft did.

**Disclosure.** A resolve response carries names, labels and a small integer; all already
visible in the operator UI; for matches only. The route is loopback-only, rejecting any
non-local peer at the socket level before the handler runs. It carries no token and mints
nothing.

Note that the static help text previously named specific profile ids while explaining which
ones tend to lack a spawn cap. Those are removed: the same point is now made as a rule (assume
a profile cannot spawn until confirmed) with the per-profile answer deferred to `resolve`. A
regression test asserts that a bare help response contains no enabled profile id at all, which
is what caught the hardcoded ones.

## Weakness 4: unknown routes answer 401, so path errors impersonate auth errors

**What was wrong.** `requireAuth` is mounted as middleware ahead of the protected routes, so
a request to a path that does not exist is rejected by the guard before Express ever
discovers there is no matching handler. Every unknown path returns `401 unauthorized`,
byte-identical to the response for a genuinely bad credential.

From the client this is indistinguishable. Attempt B typed a slightly wrong help path, got
`401`, and concluded its token was dead; a conclusion reinforced by that token legitimately
rotating several times across the session, and by a standing instruction to treat `401` as a
signal to stop and request re-injection. That instruction is sound; here it aimed the agent
at the wrong suspect and cost it the rest of the session. The agent eventually proved the
token had been valid all along by calling a *known* route with a fabricated id and receiving
`404`; a route that checks auth first cannot return `404` to an unauthenticated caller.

**Change.** Documented, not fixed. Both preambles now state the exact help path and warn that
unknown paths on this server answer `401` rather than `404`, so a `401` on a GET means a
mistyped path and not an expired token.

**Why not fixed.** Making the guard distinguish the two cases means it must know whether a
route exists, which means moving it behind route matching; a change to the mounting order
of every protected route, with the failure mode being a route accidentally left
unauthenticated. The observable symptom is a diagnostic ambiguity, not a security or
correctness defect, and it is fully addressed by telling the agent what `401` means here.
Worth revisiting if the mount order is ever restructured for other reasons.

---

## Deliberately not addressed

**Sub-daily recurring intervals; resolved (see also `scheduled-jobs.md`).** Agent-created
interval jobs are floored at **5 minutes** (`AGENT_MIN_INTERVAL_MS`) and cron is still rejected.
**Every agent-created job (interval and one-shot) is inserted `enabled=0`** (`pending_operator_enable`) so
unattended execution cannot start without operator enable or Run now. Self-chaining one-shots
for multi-tick waves is no longer necessary for cadences ≥ 5 min; prefer one interval job and
tell the operator it is pending enable. Caps (50/conversation, 50/project, non-archived) still
bound agent-created schedules.

**Resolving a template's contents.** `resolve` returns a template's name and nothing else. Its
roles, their profiles, its delegation instructions and its approval setting stay invisible. An
agent can therefore name a template but cannot see who is in it or whether it gates on
approval. That is intentional and matches the create endpoint, which only needs the name.

**Read-back of created jobs.** An agent that creates a job cannot list it afterwards; the
job-listing routes are operator-only. So it cannot confirm the next fire time, whether the
approval gate held the job disabled, or whether a chain is still alive. Attempt A worked
around this by writing a local notes file. A token-scoped read-only listing; jobs created by
the bearer's own conversation; would close it. Not built, because nothing in either report
actually failed for want of it.

---

## Files changed

| File | Change |
|---|---|
| `apps/server/src/sessionManager.ts` | Schedule pointer emitted at every depth, not only depth 0 |
| `apps/server/src/spawn/preamble.ts` | Scheduler-primacy and `401`-means-wrong-path notes in both preambles; doc comment corrected |
| `apps/server/src/routes/schedules.ts` | `resolveNamesMd()` query-scoped resolver on the help route; discovery section rewritten; hardcoded profile ids removed from the static text; `unknown template` error points at `resolve` |
| `apps/server/src/routes/schedules.agentCreate.test.ts` | Help-document assertions updated; four tests covering resolve hit, no-match, sub-minimum query, and the no-enumeration guarantee |

Full server suite passes; typecheck clean across all workspaces.
