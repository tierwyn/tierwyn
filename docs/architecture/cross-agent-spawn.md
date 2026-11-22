# Cross-Agent Sub-Agent Spawning

Tierwyn lets one agent (or the operator) spawn a *different* agent/model as a
tracked child conversation, using the same `handlePrompt` engine that drives
the web UI. The child is a normal conversation row with
`parent_conversation_id` set; no new object type; transcript/usage/resume/
status are inherited for free.

This page is the authoritative description of cross-agent spawning architecture.

See also: **[Agent Mesh](agent-mesh.md)**; subtree awareness and *lateral*
peer messaging, built on top of the tree this page creates.

## Why

Tierwyn drives 15 CLI agents plus the Grok Bot desktop app. Each can already use its *own* native
sub-agent mechanism (Claude's Task tool, etc.). There was no way for Pi to
delegate to Claude Code/Opus (or vice versa) and have that show up as
first-class, tracked activity inside Tierwyn.

Core insight: `SessionManager.handlePrompt` already spins up **any**
registered adapter into a conversation and streams events back. Driving
Claude Code from a UI click and driving it from another agent are the
*same code path*. The feature reduces to: **give a running agent an
authenticated way to call `handlePrompt` from inside its own turn,
targeting a new child conversation.**

## Two deciders, one engine

| Mode | Decider | Trigger |
|---|---|---|
| **Template / roles** | The parent **agent**, autonomously | Agent reads an injected roster and runs the spawn command when it judges a delegate fits |
| **Manual** | The **operator** | "Spawn sub-agent" action in the web UI |

Both terminate at `POST /spawn` (JSON) or `POST /spawn/raw` (file-backed body for agent delegation). The only difference is who fills in the args and which transport carries the prompt.

## `POST /spawn` (JSON)

`apps/server/src/routes/spawn.ts`: JSON body, sync or async. Used by the web UI (`SpawnModal`) and for trivial one-line agent delegations.

## `POST /spawn/raw` (agent delegation)

Raw `text/plain` **body** = prompt bytes (typically `curl --data-binary @file`). Envelope in `X-Spawn-*` headers so task prose never rides through shell quoting or JSON escaping. **No server-side path read**; same security model as inline JSON `prompt`.

```
POST /spawn/raw
Authorization: Bearer <ephemeral spawn token>
Content-Type: text/plain
X-Spawn-Parent: <parentConversationId>
X-Spawn-Role: <role>            # or X-Spawn-Profile: <profileId>
X-Spawn-Wait: false             # optional; coerce with === 'true'
X-Spawn-Notify: true            # optional
X-Spawn-Workdir: shared         # optional: shared|worktree
X-Spawn-Confirm-Shared: true    # optional

<body = raw prompt bytes>
```

## `POST /spawn` (legacy JSON details)

### Auth (Q1)

Two paths, either passes the gate:

1. **Bearer token** (`Authorization: Bearer <ephemeral>`); for agent shell calls.
   The token is **minted per session, scoped to that conversation**, and
   **revoked when the session ends** (30-min TTL backstop). Issuer lives at
   `apps/server/src/spawn/tokens.ts` (`issueSpawnToken` /
   `validateSpawnToken` / `revokeSpawnTokensForSession`). Nothing is read from
   the env, written to disk, or shared across conversations.
2. **Operator cookie**: for UI calls; verified by the existing session middleware.

The token check runs even when `AUTH_DISABLED=true`, so dev and prod behave
identically. Because tokens are session-scoped, a token stolen from logs or
DB-persisted events is useless after the issuing session ends, and live
tokens are scrubbed from persisted events before they hit the DB
(`repositories/events.ts` → `redactSpawnTokens()`), so they never appear in
the DB file or the `/conversations/:id/transcript` REST output.

The route is mounted **before** `requireAuth` so bearer-token agent calls
(no cookie) reach the handler.

### Request / response

```jsonc
// Request (agent shell or UI)
{
  "parentConversationId": "C1",          // required
  "profileId": "claude-code:opus-4.8",   // exactly one of profileId | role
  "role": "reviewer",                    // optional; resolves via template
  "prompt": "audit the auth changes",
  "wait": true,                          // true = block + return prose
  "workdir": "worktree",                 // "shared" | "worktree"; default = target profile
  "confirmShared": false,                // ack non-git fallback (see Workdir)
  "notifyParent": false                  // async only; re-feed result into parent's turn
}

// Response (sync)
{ "conversationId": "C2", "result": "<prose>", "workdir": "/path/used" }

// Response (async)
{ "conversationId": "C2", "workdir": "/path/used" }

// Bare-prompt (Grok Bot) children also include:
{ "resultPath": "/project/.tierwyn/delegates/<role>-<childId8>-RESULT.md" }
```

### Handler flow

1. **Auth**: bearer XOR operator cookie.
2. **Validate parent**: exists; rejected with 400 `depth limit` once its
   spawn-policy depth reaches `MAX_SPAWN_DEPTH` (`apps/server/src/spawn/config.ts`,
   default 5, env `TIERWYN_MAX_SPAWN_DEPTH`). Bearer spawns are also capped per
   spawner profile: `maxConcurrentSpawns` at depth 0, `maxGrandchildSpawns`
   below it (unset → 0, so non-root parents cannot spawn by default; 429 when full).
3. **Resolve profile**: *roster-bound for bearer.* An agent-token (bearer)
   spawn may only name a delegate that appears on the parent conversation's
   spawn template: `role` → `profileId` via the roster, or a direct
   `profileId` / `X-Spawn-Profile` that some roster role already carries.
   No template (or an empty roster) → 400 `parent has no spawn template`;
   off-roster profile → 400 `profile not in parent template roster`; `role`
   and `profileId` both sent must agree. Operator (cookie) spawns are
   unrestricted; any enabled catalogue profile, template optional. Either
   way, 4xx if the resolved profile is unknown/disabled.
4. **Breadth cap (Q11)**: agent/bearer spawns only; manual bypasses it. Cap
   = *spawner* profile's `maxConcurrentSpawns`. 0/unset = spawning disabled
   (fail-closed). 429 on overflow.
5. **Workdir**: see [Workdir](#workdir-q13) below.
6. **Create child conversation**: ordinary `conversations` row with
   `parent_conversation_id = parent.id`.
7. **Spawn marker**: append `⇪ spawned → C2` to the parent transcript.
8. **Dispatch**: `sessionManager.handlePrompt({ ...input, cwd,
   interactionMode: 'bypass' })`. Children ALWAYS run in bypass; they
   can't surface permission cards to the operator and shouldn't block on
   `canUseTool`. Mirrors Claude's native Task tool semantics.
9. **Result handling**: see [Result handling](#result-handling) below.
   - `wait:true`; disables Node's request timeout (`req.setTimeout(0)`) and
     resolves the HTTP response with the prose.
   - `wait:false`; returns `{ conversationId }` immediately. The marker
     fires when the child finishes regardless.

### Bare-prompt children (Grok Bot)

Grok Bot is a consumer chat surface, not a Tierwyn-API-capable coding agent.
A spawn child on grok-bot:

- Gets **no** spawn token and **no** delegation/schedule preamble.
- Receives a server-baked host / CWD / RESULT note on every new `handlePrompt`
  turn (first spawn and idle `/spawn/<child>/message` resumes). Live steers
  never re-inject it. The note has no spawn/HTTP/Tierwyn API teaching; the
  RESULT path may still contain `.tierwyn` as a folder name.
- Returns `resultPath` on the spawn response so the parent can find
  `{cwd}/.tierwyn/delegates/{roleSlug}-{childId8}-RESULT.md`.
- Is rejected with **409** `grok-bot busy: one live Grok Bot turn at a time`
  if any grok-bot session is already live (one desktop, one composer). No queue.
  The same busy/usable/project-chats gates run on idle `/spawn/:child/message`
  resumes and profile switches onto grok-bot. Live mid-turn steers skip them.
- Is rejected with **400** if Grok Bot is unusable (`grokBotUsable` is false:
  disabled, or not `running`/`starting`; a closed app is hidden even when
  autostart could launch it) or if `grokBotInProjectChats` is off outside
  Remote Agents. Unusable also hides grok-bot from the parent delegation
  roster and the web picker.
- Should use a **pinned Bot profile** (`grok-bot:<uuid>`) on the template role,
  not `grok-bot:default` (that profile types into whatever chat is open).
- Relays Allow/Deny/Always-allow cards as `interaction_request` (never
  auto-approved). A card waits in the child UI; the 15-minute stall watcher
  still applies.
- Is never an inbound-watcher target. The watcher only binds root chats
  (`parent_conversation_id IS NULL`); any nested conversation is excluded,
  not only spawn children.

### Result handling

The watcher (`watchChildResult` in `routes/spawn.ts`) subscribes to the
child's event stream via `sessionHub` and resolves on any of:

- **`session_ended`**: adapter emitted `'end'` and `SessionManager.cleanup()`
  ran (subprocess exited cleanly).
- **`status:done` / `status:error`**: child emitted its final status frame.
  Explicitly handled because claude-agent-sdk holds the subprocess stdin open
  after `result` for follow-up turns: `session_ended` may never fire on a
  successful child.
- **stall**: no `message`/`tool_call`/`tool_result` for 5 min
  (`HEARTBEAT_STALL_MS`). Watcher rejects, `onStalled` force-stops the wedged
  session so its record doesn't park in the breadth-cap count.

Accumulated `message` chunks become the prose for the `◀ result:` marker.

## Degenerate-result defence (Layers 1–4)

`watchChildResult` originally captured *only* the last contiguous assistant
prose run. If the child ended on a `tool_call` with no closing prose, OR on a
terse "Done." acknowledgement, the parent received a useless fragment. Four
defences now stack to keep the parent informed:

1. **Preamble briefing** (`spawn/preamble.ts` → `DEFAULT_DELEGATION_INSTRUCTIONS`,
   operator-overridable via `SpawnTemplate.delegationInstructions`); tells the
   parent to instruct children to end responses with a structured `## Result`
   heading (files touched, key decisions, handover notes) and to write multi-step
   artifacts to a `.md` file rather than inlining them. Forbids terse acks.
2. **Turn-tracking + degenerate detection** (`watchChildResult`); accumulates
   assistant prose **by turn** (tool boundaries flush the current turn). On
   resolve, picks the last substantive turn (regex + length<15 filter); falls
   back to the full `chunks` buffer tagged `degenerate: true` if none qualify.
   Marker prefix becomes `⚠ ◀ result (degenerate):` so thin results are visible
   to the operator.
3. **Token-authorized GET endpoint** (`GET /spawn/:childConversationId/result`): recovery path. Parent re-fetches the child's full transcript + assembled
   prose after the fact. Auth is the same per-turn spawn token OR operator
   cookie. **Ancestry walk** (`spawn.ts:366-376`) is the load-bearing security
   property: walks `parent_conversation_id` upward and 403s if the chain
   doesn't contain the token's conversation. Prevents cross-conversation reads.
   Returns `{ conversationId, parentConversationId, prose, degenerate, events }`.
4. **Auto-recover notify text** (`onResult` in `spawn.ts:293-304`), when the
   result is degenerate, the parent's `notifyParentSubagentResult` payload
   includes the exact GET path to re-fetch, so the parent LLM can self-recover
   without operator intervention.

**Why per-turn tokens make this work at scale:** `issueSpawnToken` runs inside
`handlePrompt` (`sessionManager.ts:536`), so a parent on turn *N* always holds a
fresh token. The GET endpoint is scoped to the **parent conversation**, not the
specific spawn moment; any turn's token reads any descendant, however old. The
only real failure window is a single turn that burns >30 min of wall-clock
before issuing a GET, in which case the preamble's standing 401-recovery
instruction applies ("ask the user to re-inject").

**Blast radius of one exfiltrated live token = the entire descendant subtree**
(conversation-scoped GET). Acceptable for single-user localhost; the first thing
to revisit if Tierwyn ever goes multi-tenant. TTL stays at 30 min; extending it
would grow the in-window exfil replay surface without closing any real gap.

### Subprocess cleanup

claude-agent-sdk keeps the child subprocess alive after `result` (next turn
could stream in). To avoid PID leaks, `onResult` calls
`sessionManager.stopSession(childSession.id)` if the child session is still
active. This kills the subprocess and runs `cleanup()` → frees the breadth
cap slot for the next spawn.

### Heartbeat

The watcher still ticks every `HEARTBEAT_INTERVAL_MS` (30s) of silence to
detect stalls; tool activity (`tool_call`/`tool_result`) resets that clock,
so a child busy with long tool calls is making progress, not stalled. The
callback is a no-op: spawn no longer writes `heartbeat` markers into the
parent transcript.

The UI shows a **single** live `⏱ still running · {role} · {elapsed}` row
under each open spawned card, ticking every 1s from the spawned event's `ts`
(wall-clock wait, including while tools run). The live number is best-effort
against the browser clock; a skewed client can freeze at `0s` or open
inflated. Historical heartbeat markers are hidden. When this process's
watcher resolves or stalls, `durationMs` is stored on the terminal
`SpawnMarker` (from `spawn_edges.created_at` to now, no extra SQL column)
and shown as `ran {elapsed}`, that value is authoritative. Boot
reconciliation (`rearm.ts`) writes `stalled` without `durationMs` so the
figure does not include server downtime. Approval-gated spawns start both
clocks at dispatch (after approve), so queue time is excluded.

### `notifyParent` (Q14)

Async-only. When true, a finished child's result is pushed into the parent
session's steer/follow-up queue via `SessionManager.steerSession`:

- If the parent turn is live/steerable → injected into the running turn.
- Otherwise → drained as a fresh follow-up turn after the current one ends.

This re-enters the parent **agent's** reasoning, not just the transcript. If
the parent session is gone, it degrades to transcript-only (the `◀ result`
marker still lands).

#### Follow-up turn is silent in the UI

When the parent session has already ended (the typical `wait:false` flow),
the follow-up is dispatched via `handlePrompt` rather than `steerSession`.
To avoid a misleading `User:` card duplicating the existing `◀ Result` spawn
marker, that follow-up prompt is persisted with
`payload.source === 'subagent_notify'` and `sender: 'system'`. The web UI
hides the prompt-echo block for such prompts; only the parent agent's
response turn renders, and the `◀ Result` marker remains the operator-visible
source of the child's prose. The full `Sub-agent (…) result:\n\n{prose}`
text is still what the LLM sees; only the UI rendering is suppressed.
Compaction labels these `SUBAGENT (role):` rather than `USER:`.

Mid-turn injection (parent session still live) is unchanged: it still flows
through `steerSession` and renders as **Steer / Injection:**.

## Workdir (Q13)

Precedence: **request `workdir` → target profile's `defaultWorkdir` → `shared`.**

- `shared` → `cwd = project.rootPath`.
- `worktree` on a git repo → `git worktree add` a sibling dir named after
  the child conversation id; `cwd` = that path. Path/branch recorded on the
  child and surfaced in the result marker.
- `worktree` on a **non-git** project → **no silent fallback**. Returns:

  ```jsonc
  409 { "warning": "not a git repo; worktree unavailable",
        "wouldRunIn": "shared",
        "retryWith": { "confirmShared": true } }
  ```

  Caller re-issues with `confirmShared:true` (manual UI surfaces a confirm
  dialog; an agent re-runs the command with the flag).

Worktrees are **not auto-removed**; cleanup/merge is operator-driven. Paths
are surfaced in the result marker so the operator can find them.

## Templates / roles (autonomous delegation)

A template is a named roster stored as a JSON blob in the existing
`settings` table (key `spawn_templates`). No new table.

```jsonc
{
  "name": "default-team",
  "roles": [
    { "role": "reviewer",   "profileId": "claude-code:opus-4.8", "when": "deep correctness review" },
    { "role": "fast-coder", "profileId": "pi:...",               "when": "quick mechanical edits" },
    { "role": "researcher", "profileId": "opencode:...",         "when": "docs/web research" }
  ]
}
```

- **Attach:** the chosen template name is stored on the conversation
  (`template_name` column, set at creation next to the model selector; "none"
  = autonomous delegation off, manual still available).
- **Inject:** when a *root* conversation has a template, `handlePrompt`
  prepends a delegation preamble to the parent's prompt. The preamble
  contains the roster **plus a ready-to-run `curl` block** with the
  session's live spawn token and the parent conversation id already
  substituted; the agent copies the fenced block verbatim and edits only
  `prompt`/`role`. Copying a whole block is far more reliable than splicing
  a UUID (Q6). The token rotates each session, so the block is only valid
  for the run that produced it.
- **Resolve:** `/spawn` maps `role → profileId` via the parent's template
  before profile validation. For **bearer** (agent) spawns the roster is a
  hard allow-list, not just a lookup table: a direct `profileId` /
  `X-Spawn-Profile` is accepted only if a roster role carries it, and a
  parent with no template cannot delegate at all. The roster printed in the
  preamble is therefore what the agent can actually reach. Operator spawns
  from the Spawn modal (cookie auth) bypass the roster entirely.

Builder: `apps/server/src/spawn/preamble.ts` (`buildDelegationPreamble`). Call *mechanics* (optional JSON spawn fields, message/result curls, timer/task/mesh error codes) live on loopback `GET /agent/help/<topic>` so the preamble can stay guidance-only. Behavioural rules; whether/when/never; remain inline.

**Default mode is async.** The example curl ships with `wait:false,
notifyParent:true`. The parent agent does NOT block on the child's full
run; its turn ends, and when the child finishes, the parent is resumed
with the result. Sync (`wait:true`) is reserved for short (<2min) tasks
where the parent literally cannot continue without the result.

## Conversation designations

A **designation** is an optional one-word function chip on a conversation:
`orchestrator`, `planner`, `implementer`, `reviewer`, `research` (built-ins,
live in code and cannot be deleted) plus operator-defined customs
(**Settings → Templates → Designations**; at most 8 customs, each ≤ 24 characters,
`word` or `hyphenated-word` shape). The chip shows on the conversation in
the UI; it is labelling for humans and agents, not a permission.

Set one at spawn with the JSON field `"designation"` or the
`X-Spawn-Designation` header on `/spawn/raw`; later or cleared with
`PATCH /conversations/:id` `{ designation }` / `{ designation: null }`.
Spawn and PATCH accept only tokens from the combined built-in + custom
catalogue; anything else is a 400. The delegation preamble lists the
current catalogue so parent agents pick a valid token instead of inventing
a spelling. Code: `packages/shared/src/conversationDesignation.ts`.

## Manual spawn (operator delegation)

A **"Spawn sub-agent"** action on any conversation opens
`apps/web/src/components/SpawnModal.tsx`:

- target = **any enabled profile** (full picker); if a template is attached,
  its roles appear as one-click shortcuts
- prompt text + `wait` toggle + `workdir` choice
- fires the same `POST /spawn`; a non-git `worktree` request surfaces the
  409 as a "not a git repo; run in shared dir?" confirm dialog

Works with no template attached; serves as the operator override when an
agent should have delegated but didn't.

## UI

- **Sidebar nesting**: children render indented under their parent
  (`↳ <role/agent>`). Parent thread stays readable; sub-runs hang off it.
- **Cross-links**: `⇪ spawned → C2` in the parent links to the child. The
  child's first marker (`↳ spawned by C1`) links back up.
- **Result**: `◀ result` in the parent carries the prose; full detail is
  one click away in the child. When the child ran in a worktree, the marker
  shows the worktree path/branch.

Marker shape: `SpawnMarker` in `packages/shared/src/events.ts`, rendered in
`apps/web/src/components/OutputPane.tsx` by branching on
`event.payload.spawnMarker`.

## Spawn approval (safe mode Phase 1–3)

By default a bearer-initiated spawn dispatches immediately. With **spawn
approval** on, the bearer creates a *pending request* and the child does not
run until the operator (cookie) approves it. Manual operator spawns always
dispatch immediately; the operator already authored the prompt.

```
Agent (bearer)  →  POST /spawn[/raw]  →  202 { requestId, status: 'pending' }
Operator (cookie) → POST /spawn/requests/:id/approve  →  dispatchSpawn() → child runs
Operator (cookie) → POST /spawn/requests/:id/deny     →  request cancelled; parent notified
```

**Policy resolution** (`approvalRequired` in `routes/spawn.ts`):

1. Conversation's template `spawnApprovalRequired`, if `undefined`, fall through.
2. Global `CompactionSettings.spawnApprovalRequired` (default `false`).

Default `false` preserves pre-Phase-1 behaviour byte-for-byte: no
`spawn_requests` row is inserted, `POST /spawn` returns `200 { conversationId }`.

**Auth matrix:**

| Auth | Create pending | Approve / deny | Manual dispatch |
|---|---|---|---|
| Bearer (spawn token) | Yes | **No** (403) | No |
| Operator cookie | n/a (dispatches immediately) | Yes | Yes |

**`wait:true` + approval**: rejected with HTTP 400 before any row insert; sync
wait is incompatible with an approval gate (the parent would block on a child
that can't start until the operator returns).

**Idempotent approve**: `approveSpawnRequest` is a compare-and-set on
`status='pending'`; a double-click or second tab gets 409 `{ ok: false, status }`.

**Lifecycle**: pending rows expire when the parent session ends (and via a TTL
backstop sweep on every `GET /spawn/requests`). Deny emits a `✗ spawn denied`
marker + a `subagent_notify` to the parent so it stops waiting on the child.

**Preamble**: when `spawnApprovalRequired` is on, `buildDelegationPreamble`
splices a note telling the parent agent to expect `202 { requestId }` rather
than a running child, not to retry it as an error, and that `notifyParent:true`
will resume its turn once the operator approves and the child completes.

**Schema**: the `spawn_requests` table (baseline schema): `id`,
`parent_conversation_id`, `parent_session_id`, `role`, `profile_id`,
`prompt`, `workdir`, `wait`, `notify_parent`, `status`
(`pending|approved|denied|expired|dispatched`), `child_conversation_id`, `designation`,
timestamps (incl. `decided_at`), `decided_by`, `error`.

**UI**: `SpawnApprovalModal` shows role, profile, workdir, and the **full
prompt** (no truncation). The header surfaces a pending badge; a
`spawn_request_updated` WS frame triggers a refetch across all subscribed
clients. The approval queue is operator-global: `GET /spawn/requests` without
a `parentConversationId` returns all pending requests so an operator can
approve regardless of which conversation is currently open.

### Capability filter (safe mode Phase 4)

When the parent conversation is in a permission mode (`interactionMode !==
'bypass'`), bypass-only adapters cannot honour per-tool gates. Three enforcement
points keep them out of the delegation path:

1. **`/profiles` response**: each row is stamped with a derived
   `permissionCapable: boolean` (`agentSupportsPermissionMode(agentType)`).
   The web picker greys out `permissionCapable === false` profiles with a
   "bypass only" badge and ignores clicks on them.
2. **`SessionManager.handlePrompt`**: rejects an incompatible `profileId`
   **before** session creation (no orphan DB rows) with a clear error naming
   the capable agents.
3. **`buildDelegationPreamble`**: omits bypass-only roles from the parent's
   roster when `parentInteractionMode` is non-bypass, picks the curl example
   from the remaining capable roles, and prints a count of omitted roles so the
   parent agent knows why its roster shrank.
4. **`dispatchSpawn`**: rejects a spawn to a bypass-only profile with HTTP 400
   when the global mode is permission-gated. Children always run `bypass`
   internally (next section), but the role itself must be a capable agent.

Permission-capable adapters: `claude-code`, `codex`, `hermes`, `grok-build`,
`kiro`, `qwen`, `kimi`, `grok-bot`
(`PERMISSION_CAPABLE_ADAPTERS` in `packages/shared/src/profiles.ts`). All
others are bypass-only.

## Permission model: children always bypass

Spawned children can't surface permission cards to the operator (the parent
agent is driving, not the UI). They run with `interactionMode: 'bypass'`
regardless of the global setting.

How it's threaded:

- `AdapterFactory` (`apps/server/src/registry.ts`) accepts an opts arg:
  ```ts
  type AdapterFactoryOpts = { interactionMode?: 'bypass' | 'questions' | 'prompt' };
  type AdapterFactory = (opts?: AdapterFactoryOpts) => AgentAdapter;
  ```
- `SessionManager.handlePrompt` reads `PromptInput.interactionMode` and
  passes it to `registry.create(agentType, opts)`.
- `routes/spawn.ts` always sets `interactionMode: 'bypass'` on the dispatch.
- claude-code factories in `apps/server/src/index.ts` read
  `opts?.interactionMode ?? getCompactionSettings(db).interactionMode`.

Without this, a child spawned into `questions` mode (the operator's top-level
setting) blocks forever on the first `canUseTool` callback; the adapter
emits `interaction_request`, nothing answers it, the subprocess sleeps.

## Schema

Spawn columns on `conversations` / `agent_models` (pre-release migration 016,
now part of `001_baseline.sql`):

```sql
ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN template_name TEXT;
ALTER TABLE conversations ADD COLUMN workdir_path TEXT;
CREATE INDEX idx_conversations_parent ON conversations(parent_conversation_id);

ALTER TABLE agent_models ADD COLUMN max_concurrent_spawns INTEGER;
ALTER TABLE agent_models ADD COLUMN default_workdir TEXT;
```

`AgentProfile` (`packages/shared/src/profiles.ts`) gains:

```ts
maxConcurrentSpawns?: number;   // 0/unset = spawning disabled
defaultWorkdir?: 'shared' | 'worktree';
```

Both round-trip through the catalogue CRUD/editor
(`apps/web/src/components/CatalogueSettings.tsx`).

## Files at a glance

**Server:**
- `apps/server/src/routes/spawn.ts`: `POST /spawn` (auth, validation,
  breadth cap, workdir, markers, sync/async, bypass dispatch) +
  `GET /spawn/:childConversationId/result` (token-authorized transcript fetch
  with ancestry walk)
- `apps/server/src/worktree.ts`: `isGitRepo`, `createWorktree`
- `apps/server/src/spawn/preamble.ts`: `buildDelegationPreamble`
- `apps/server/src/spawn/config.ts`: `MAX_SPAWN_DEPTH`
- `apps/server/src/repositories/conversations.ts`; parent/template/workdir
  mapping + `childConversationIds`
- `apps/server/src/repositories/settings.ts`; template CRUD over settings
  table
- `apps/server/src/registry.ts`: `AdapterFactory` opts + `AdapterFactoryOpts`
- `apps/server/src/sessionManager.ts`: `PromptInput.interactionMode` +
  `PromptInput.cwd` threaded to `registry.create`
- `apps/server/src/index.ts`; registers `/spawn` + templates REST, factory
  opts, `POST /conversations` accepts `templateName`
- `apps/server/src/spawn/tokens.ts`; in-memory issuer for ephemeral,
  session-scoped spawn tokens (replaces the former static `SPAWN_TOKEN` env)

**Shared:**
- `packages/shared/src/domain.ts`: `Workdir`, `SpawnTemplate`,
  `Conversation.parentConversationId/templateName/workdirPath`
- `packages/shared/src/profiles.ts`: `maxConcurrentSpawns`, `defaultWorkdir`
- `packages/shared/src/protocol.ts`: `SpawnRequest`, `SpawnResponse`,
  `SpawnResultResponse` (GET `/spawn/:id/result`), `CreateConversationRequest.templateName`
- `packages/shared/src/events.ts`: `SpawnMarker`

**Web:**
- `apps/web/src/api.ts`: `spawn`, `listTemplates`, `saveTemplate`,
  `deleteTemplate`
- `apps/web/src/components/SpawnModal.tsx`; manual spawn UI
- `apps/web/src/components/TemplateSettings.tsx`; template CRUD panel
- `apps/web/src/components/OutputPane.tsx`; marker rendering
- `apps/web/src/components/Sidebar.tsx`; nested children
- `apps/web/src/components/CatalogueSettings.tsx`:
  `maxConcurrentSpawns`/`defaultWorkdir` editor fields

## Sharp edges

- **Agent ignores the roster**: models don't always delegate when they
  should. Manual mode + `when` hints mitigate; never guaranteed.
- **Same-cwd write races**: `shared` is safe for sync (parent blocked) and
  read-only delegates; concurrent async *writers* should use
  `workdir:worktree`.
- **Worktree sprawl**: worktrees aren't auto-removed; they accumulate
  until the operator cleans/merges them. Paths are surfaced in markers so
  they're findable.
- **`wait:true` holds a turn**: long sub-runs block the parent agent;
  default preamble ships `wait:false + notifyParent:true` for this reason.
- **`notifyParent` auto-wakes the parent**: a follow-up turn fires when an
  async child finishes; powerful for orchestration but means the parent can
  resume unprompted. Per-spawn flag so it's opt-in. The delegation preamble
  therefore forbids parent-side `sleep`/timer polling and repeated
  `GET /spawn/.../result` loops after async spawn; completion is the
  one-shot notify; GET/RESULT.md are recovery-only (stall, ⚠, missed notify).
- **Cold-start latency**: claude-code subprocess + managedSettings + SDK
  handshake is ~20-30s before the first chunk. A trivial "say hi" round-trip
  is 60-90s end-to-end; tool-heavy tasks run minutes. If a `wait:true` curl
  times out, the child keeps running server-side and the result still lands
  on the parent transcript.
- **Billing**: each agent uses its own CLI auth, so a Claude sub-agent
  spawned from Pi bills your Claude account. Expected; nothing to build.

## Non-goals (deferred)

- Automatic worktree cleanup/merge.
- Per-agent skill files (Q10); prompt-only delivery.
- Templates as a queryable table (Q9): JSON blob for now.

## Verified behaviour

End-to-end test against prod after bypass + watcher patches:

| Path | Result |
|---|---|
| Async `wait:false` + `notifyParent:true` | child wrote file, subprocess exited clean, `◀ result:` marker persisted, parent steer landed |
| Sync `wait:true` | returned `{result}` inline in 5.4s; subprocess exited clean |
| Bypass permission mode | 2 tool_calls + 2 tool_results, no `canUseTool` deadlock |
| Heartbeat markers | persisted to parent transcript every 30s of silence |
| Stall-detect (5 min) | wired and force-stops wedged session; not triggered in test (child too fast) |
| Subprocess cleanup on result | no PID leak after `status:done` |
| Breadth cap | `max_concurrent_spawns=1` (default for all enabled profiles via SQL UPDATE) |

Common failure modes observed + fixed during testing:

- `too many active sub-agents (0/0)`; parent profile had
  `max_concurrent_spawns=0`. Default is now 1 on all enabled profiles.
- Subprocess hang after `status:done`; claude-agent-sdk keeps stdin open;
  watcher now resolves on `status:done` and `onResult` calls `stopSession`.
- Async spawn errors swallowed: `void handlePrompt(...)` had no `.catch`;
  now `.catch(err => watcher.fail(err.message))`.
- Stall false positives on tool-heavy children: `tool_call`/`tool_result`
  now reset the stall clock.
