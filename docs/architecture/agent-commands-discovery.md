# Agent Commands & Skills: Discovery and Feasibility

How each agent adapter's slash-commands and skills could be enumerated and
exposed dynamically in the Tierwyn UI. Companion document to
[Model Discovery by Adapter](./model-discovery.md); reads as the parallel
story for the `listCommands()` capability that does not yet exist.

## TL;DR

**Feasible, with one problem child (agy).** Three of four CLIs (claude-code,
pi, opencode) have converged on the [agentskills.io](https://agentskills.io)
`SKILL.md` standard, so a single directory-scan + YAML-frontmatter parser
covers them. Built-in slash-verbs (`/clear`, `/model`, `/cost`) are not
enumerable by any CLI and require a small hardcoded table per adapter,
refreshed against vendor docs. agy is closed-source, has no `--list-commands`,
and its `-p` mode does not officially accept slash commands; it would get
skills-only discovery with no built-in verbs.

The `AgentAdapter` contract (`packages/shared/src/adapter.ts:37-51`) already
has optional capability methods (`isNativeSessionAvailable?`,
`estimateTokenCount?` at line 50); a `listCommands?()` slots in identically.
`SessionConfig.cwd` (`packages/shared/src/adapter.ts:7`) is already populated
from `project.rootPath` in `sessionManager.ts:213`, so per-session invocation
has cwd context. No existing happy path needs to change.

## Discovery behaviour

| Agent | Skill manifest path | Count today | Built-in verbs enumerable? | Non-interactive invoke? |
|---|---|---|---|---|
| **claude-code** | `~/.claude/skills/<name>/SKILL.md` + `<plugin>/skills/` + `.claude/skills/` | 28 | No; hardcode from docs | Yes: `claude -p "/name"` |
| **pi** | `~/.pi/skills/`, `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.agents/skills/` (walked up from cwd) | 2 (symlinks into `~/.agents/skills/`) | No; hardcode from upstream README | Yes: `pi -p "/skill:name"` (note `skill:` prefix) |
| **opencode** | `~/.config/opencode/skills/<name>/SKILL.md` + `~/.config/opencode/command/<name>.md` + `.opencode/` project variants | 0 local | No, but `opencode agent list` + `opencode models` cover related surfaces | Yes: `opencode run --command <name>` (gold standard) |
| **antigravity** | `~/.gemini/skills/<name>/SKILL.md` | 14 | **No; closed binary, `?` is interactive-only** | Unknown: `-p` accepts plain prompts; `/cmds` interpretation undocumented |

**Summary:** every adapter can implement a uniform `listCommands()` because
discovery is a separate, cheap, non-streaming call; exactly the same shape
as `listModels()` today (no args, runs outside any session). The transport
substrate (SDK / RPC / stream-json / plain-text / NDJSON) only matters for
*invoking* commands, not discovering them.

**On passthrough:** all adapters receive leading-`/` text verbatim through
the pipeline (see "Today's passthrough behaviour" below); no adapter is
special-cased. Whether a given CLI *interprets* the slash token is
per-CLI: claude-code/pi do; agy and opencode are unverified.

## Manifest format (universal)

All four CLIs that have skills use the same on-disk format:

```
~/.<agent>/skills/<skill-name>/SKILL.md
```

with YAML frontmatter:

```yaml
---
name: find-skills
description: Helps users discover and install agent skills when they ask...
---
```

Only `name` and `description` are required. No build step, no binary:
trivially parseable with `readdirSync` + a frontmatter regex. The
the claude-code adapter already imports filesystem primitives
for session enumeration (`readdirSync` at
`apps/server/src/adapters/claude-code/index.ts:2`).

## Where commands live in the data model

**Per-agent, not per-model.** Skills apply regardless of which model is
selected within an adapter; adding a `commands?` field to `AgentProfile`
(`packages/shared/src/profiles.ts:1-12`) would duplicate the list across
every model row of the same agent. The right home is a new table.

### `agent_commands` schema

Mirrors `agent_models` accurately, including the columns added by later
migrations, not just the original migration-001 shape:

| Column | Notes |
|---|---|
| `id` | PK |
| `agent_id` | FK → `agents.id` |
| `name` | e.g. `clear`, `cost`, `find-skills` |
| `label` | Display label |
| `description` | From `SKILL.md` frontmatter or built-in verb docs |
| `source` | `seed` \| `discovered` \| `user` (migration-009 pattern) |
| `enabled_flag` | Integer boolean |
| `created_at` | Timestamp |

With `UNIQUE(agent_id, name)` (mirroring the `agent_models` unique index).

### Source value semantics (parallel to `agent_models`)

Reusing the exact discriminator from
[Model Discovery by Adapter](./model-discovery.md) so the two docs stay
parallel:

| `source` value | Commands it holds | Lifecycle |
|---|---|---|
| `seed` | Built-in verbs (`/clear`, `/model`, `/cost`, …) driven by a static table per adapter | Re-upserted on every boot; prune anything in the table that's missing |
| `discovered` | Filesystem-scanned `SKILL.md` entries (home + plugin paths) | Refreshed by the scheduler's discovery cycle; pruned if absent on disk |
| `user` | Future: custom commands edited via the catalogue CRUD UI | Never pruned |

### Repo touchpoints (all confirmed present)

- **Migration:** new file in `apps/server/src/db/migrations/` (see
  [add-database-migration.md](../guides/add-database-migration.md)), **and** a new entry appended to the
  `migrations` array in `apps/server/src/db/migrations/index.ts`.
  Adding the file alone is dead; registration is hand-maintained (see team
  memory `project_migrations_array_handmaintained`).
- **Repository:** new functions in `apps/server/src/repositories/commands.ts`
  mirroring `ensureAgent` / `upsertDiscoveredModels` / the CRUD helpers in
  `repositories/models.ts`. The `json_each` prune pattern at
  `repositories/models.ts:43-48` is the template for command pruning.
- **Seed:** built-in verbs seeded by a `seedCommands` function following
  `seedCatalogue` (`apps/server/src/db/seed.ts:22-92`), **including its
  empty-list prune guard at lines 77-82**; a malformed static table must
  never wipe the catalogue.
- **Discovery:** extend `runModelDiscovery` (`apps/server/src/scheduler.ts:12-28`)
  with a sibling `runCommandDiscovery` on the same 12h cadence.
- **REST:** `GET /agents/:id/commands`, `POST /agents/:id/pull-commands`
  parallel to `pull-models` (`apps/server/src/routes/catalogue.ts:119-137`);
  new DTOs `CommandsResponse` / `PullCommandsResponse` in
  `packages/shared/src/protocol.ts` alongside `PullModelsResponse` (line
  141) and `ModelRecord` (127-137).
- **Adapter contract:** optional `listCommands?(): Promise<CommandDescriptor[]>`
  on `AgentAdapter` (`packages/shared/src/adapter.ts:37-51`), declared
  exactly as `estimateTokenCount?` at line 50.

The PRD invariant at `docs/specs/agent-command-centre-traycer-phases.md:26`
(INV-2: "adding an agent = writing one adapter, no UI rewrite") is preserved
by this design.

## Today's passthrough behaviour

There is no slash-command parsing anywhere in the pipeline today. A
`/skill-name` typed in `InputBar.tsx` (textarea + value binding at
**lines 104-111**) is shipped verbatim end-to-end:

1. `InputBar.tsx:29-41`: `handleSend` trims and calls `onSend(text, ...)`
2. `App.tsx:286-306`; handoff modal may pop, then `dispatchPrompt`
3. `App.tsx:241-256`; calls `sendPrompt({...text...})` from the WS hook
4. `ws.ts:289-306`; sends `ClientFrame { type: 'prompt', text, ... }`
5. `apps/server/src/index.ts:438-442`; server routes to
   `sessionManager.handlePrompt`
6. `sessionManager.ts:229-233`: `textToSend` passed directly to
   `adapter.sendPrompt(textToSend, ...)` (only mutation is optional
   priming-prompt prepend). **No adapter branching.**

**Implication:** claude-code and pi *already interpret*
leading-`/` text natively, so `/skill-name` half-works by accident today
for those three; just without autocomplete, per-agent filtering, or any
way to surface the available list. agy and opencode receive the same
leading-`/` text; whether their CLIs interpret it as a command or as prose
is unverified.

## Recommended extension

### Phase 1: client-side picker (no prompt-path changes)

The cheapest viable feature. Detect `/` against the `text` state in
`InputBar.tsx:22`, fetch the selected agent's command list, show a picker
mounted near the textarea (`InputBar.tsx:104-111`). Detection keys off
`text` in `handleSend` (`InputBar.tsx:29-41`). On send, transmit the text
unchanged; the native CLI parses the slash command.

- **REST helper:** new function in `apps/web/src/api.ts` alongside
  `api.activeAgent` (used at `App.tsx:231`); fetches the command list
  for the active agent.
- **Covers:** claude-code, pi (today's "half-works" surface).
- **Agnostic:** agy and opencode still receive `/foo` verbatim; their
  interpretation is unchanged from today.
- **Cost:** one REST read endpoint + a picker component. No adapter or
  prompt-path changes.

### Phase 2: dedicated `command` frame + adapter method

A `command` ClientFrame extended onto the `ClientFrame` union in
`packages/shared/src/protocol.ts:31`, wired through `sendFrame` in
`ws.ts:300-306`. Server routing mirrors the prompt path in
`sessionManager.ts` (`handlePrompt` → adapter call at line 233). An
optional `runCommand?(name, args)` on `AgentAdapter`
(`packages/shared/src/adapter.ts:37-51`); declared exactly as
`estimateTokenCount?` at line 50. Lets:

- opencode use `opencode run --command <name>` properly (gold standard)
- agy fall back gracefully (built-in verbs hardcode + skills-only list)
- the UI distinguish command invocations from prose in the transcript

Not strictly required for the MVP, but recommended before treating the
feature as shipped.

## Per-adapter implementation notes

### claude-code

`listCommands()` walks:

- `~/.claude/skills/`
- `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/`
- `<cwd>/.claude/skills/` (project-scoped, see Open Question #2)
- `~/.claude/plugins/installed_plugins.json` for plugin-level metadata

Built-in verbs (`/clear`, `/model`, `/cost`, `/compact`, `/agents`,
`/review`, etc.) come from a static table; the `--help` output lists CLI
subcommands but not in-session slash commands, and there is no
`--list-commands` flag.

Note: skills and slash-commands have been merged; every `SKILL.md`
becomes invokable as `/<name>`, and `--disable-slash-commands` disables
them. The adapter already passes through text, so Phase 1 needs no
adapter change.

### pi

`listCommands()` walks four standard paths (per the pi-mono README):

- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- `.pi/skills/` (walked up from cwd)
- `.agents/skills/` (walked up from cwd)

Skill invocation in pi uses the `/skill:<name>` prefix (note the `:`,
different from claude). The client picker should normalise this: store the canonical name and let the adapter rewrite on send.

Extensions (npm packages like `npm:pi-mcp-adapter`) are a *separate
concept* from skills in pi. Listed in
`~/.pi/agent/settings.json` `packages` array, discoverable via `pi list`.
These could be a future command-source category but not MVP.

### opencode

The most wrapper-friendly CLI in the set. `listCommands()` walks:

- `~/.config/opencode/skills/<name>/SKILL.md`
- `~/.config/opencode/command/<name>.md` (separate "command" concept:
  markdown templates with frontmatter, invokable as `/<filename>`)
- `.opencode/skills/` and `.opencode/command/` (project-scoped)

Built-in verbs (`/init`, `/clear`, `/compact`, `/agents`, `/models`,
`/share`, etc.) must be hardcoded; no `opencode commands` subcommand
exists. But `opencode agent list` and `opencode models` are clean
structured surfaces if those ever need to enter the catalogue.

Phase 2 should prefer `opencode run --command <name> --format json`:
it's the only CLI with an explicit non-interactive command-invocation
flag.

### antigravity (PROBLEMATIC)

agy is the weakest surface in the set:

- **Closed-source Go binary** (the `agy` binary, resolved on PATH, see
  `AGENT_BINARIES` in `apps/server/src/discovery.ts:27`; there is no
  hardcoded `~/.local/bin/agy` path in the repo, install hint is
  `agy install`). Internal command registry not introspectable.
- **No `--list-commands`**; in-session `?` is interactive-only.
- **`-p` mode does not officially accept slash commands**: they're
  treated as user input (per the passthrough note above, agy receives
  the text; whether it interprets the leading `/` is unverified).
- **CLI flags leak into the Gemini system prompt** when passed as args,
  so wrapper-side invocation has side effects.

`listCommands()` for agy should walk `~/.gemini/skills/` and **omit
built-in verbs entirely** until agy exposes them. The 14 skills on disk
will show in the picker, but invocation will be "passes through as text
and may or may not be interpreted"; same half-works status as today.
Flag this in the UI (e.g. an "experimental" affordance on the picker
when `agentType === 'antigravity'`).

## Open questions

1. **Plugin vs skill divergence.** pi separates "extensions" (npm packages)
   from "skills" (markdown). claude-code merges them via plugin
   bundles. agy and opencode split them. The `CommandDescriptor` type
   should probably carry a `source_detail` discriminator (`'skill'` vs
   `'plugin'` vs `'builtin'` vs `'command-template'`) so the UI can group
   or filter intelligently. Consistent with the existing `source` column
   pattern.

2. **Project-scoped skills at discovery time.** All four non-agy CLIs
   support `<cwd>/.<agent>/skills/` in addition to home-dir skills.
   `SessionConfig.cwd` already exists (`packages/shared/src/adapter.ts:7`,
   populated from `project.rootPath` at `sessionManager.ts:213`), so
   per-session *invocation* has cwd context. But `listCommands()`:
   mirroring `listModels()`, which takes **no args**; runs at boot-time
   on the scheduler, outside any session. The gap is **discovery**, not
   invocation: the scheduler has no cwd to walk project-scoped skill
   dirs. Options: (a) add a per-session discovery call passing
   `SessionConfig.cwd` when a session starts, (b) defer project-skill
   resolution to invocation time (adapter reads cwd from its config),
   (c) limit MVP to home-dir + plugin skills and revisit. Home-dir
   skills are unaffected either way.

3. **Shared ecosystem deduplication.** `~/.agents/skills/` is a
   cross-CLI skill pool (pi symlinks into it; the `find-skills` SKILL.md
   describes it as "the open agent skills ecosystem"). If the same skill
   is exposed by multiple agents, the catalogue will store duplicates.
   Acceptable for MVP; could be deduplicated by content-hash later.

4. **Built-in verb refresh.** With no `--list-commands` anywhere,
   built-in verbs need periodic manual sync against vendor docs. The
   consistent pattern already established in this repo is "edit a
   JSON/static table and restart"; see the *Editing static lists*
   section of [Model Discovery by Adapter](./model-discovery.md) for the
   `agent-profiles.json` → `seedCatalogue` precedent. Built-in verbs are
   the `source='seed'` analogue here. Flag staleness in a comment in the
   static table; revisit quarterly. A doc-scraping CI test is **not**
   worth the maintenance cost.

5. **agy `?` menu scraping.** Could potentially be reverse-engineered
   by piping `?` to agy's stdin in `-p` mode and parsing the help banner.
   Not recommended for MVP; fragile, undocumented, and likely to break
   across agy versions.

## References

External documentation:

- [Claude Code Commands docs](https://code.claude.com/docs/en/commands)
- [Claude Code Skills docs](https://code.claude.com/docs/en/skills)
- [Pi coding agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [Antigravity CLI docs](https://antigravity.google/docs/cli-using)
- [OpenCode Commands docs](https://opencode.ai/docs/commands/)
- [OpenCode Agent Skills docs](https://opencode.ai/docs/skills/)
- [Agent Skills standard (agentskills.io)](https://agentskills.io/)

Related in repo:

- `packages/shared/src/adapter.ts:7`: `SessionConfig.cwd` (already present)
- `packages/shared/src/adapter.ts:37-51`; adapter contract; `estimateTokenCount?` at line 50 is the template for `listCommands?()` / `runCommand?()`
- `packages/shared/src/profiles.ts:1-12`; profile type (do not extend with commands, per-model duplication)
- `packages/shared/src/protocol.ts:31`: `ClientFrame` union (extend for Phase 2 `command` frame)
- `packages/shared/src/protocol.ts:127-141`: `ModelRecord` / `PullModelsResponse` (template for `CommandsResponse` DTOs)
- `apps/server/src/discovery.ts:27`: `AGENT_BINARIES` resolves `agy` via PATH (no hardcoded path)
- `apps/server/src/scheduler.ts:12-28`; model discovery scheduler (template for `runCommandDiscovery`)
- `apps/server/src/db/seed.ts:22-92`: `seedCatalogue` pattern + empty-list prune guard (77-82)
- `apps/server/src/db/migrations/index.ts:8-19`; hand-maintained migrations array (next version = 11)
- `apps/server/src/repositories/models.ts:43-48`: `json_each` prune pattern (template for command pruning)
- `apps/server/src/routes/catalogue.ts:119-137`: `pull-models` (template for `pull-commands`)
- `apps/server/src/sessionManager.ts:213`: `project.rootPath` → `SessionConfig.cwd`
- `apps/server/src/sessionManager.ts:229-233`: `textToSend` passthrough to `adapter.sendPrompt` (no adapter branching)
- `apps/web/src/api.ts`: REST helpers (where `api.listCommands` lives in Phase 1)
- `apps/web/src/components/InputBar.tsx:22,29-41,104-111`: `text` state, `handleSend`, textarea+value binding (picker mounts here)
