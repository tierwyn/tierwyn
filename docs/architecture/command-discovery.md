# Command Discovery by Adapter

How each agent adapter populates the `agent_commands` table, what the catalogue
API can refresh on demand, and how to edit the static built-in verb lists without
touching code. For feasibility notes and per-CLI discovery paths, see
[Agent Commands & Skills: Discovery and Feasibility](./agent-commands-discovery.md).

## Discovery behaviour

| Agent | Built-in verbs | Skills / templates | Dynamic? | `source` in DB |
|---|---|---|---|---|
| **claude-code** | `apps/server/agent-commands.json`; filtered by `agentType==='claude-code'` (6 entries) | `listCommands()` scans `~/.claude/skills/` + plugin cache | Built-ins: file-driven; skills: live scan | `seed` / `discovered` |
| **opencode** | `agent-commands.json`; filtered by `agentType==='opencode'` (6 entries) | `listCommands()` scans `~/.config/opencode/skills/` + `command/` templates | Built-ins: file-driven; skills: live scan | `seed` / `discovered` |
| **pi** | None; no built-in verbs in JSON | `listCommands()` scans `~/.pi/agent/skills/` + `~/.agents/skills/` | Yes; live filesystem scan | `discovered` |
| **antigravity** | None; agy exposes no enumerable built-in verbs | `listCommands()` scans `~/.gemini/skills/` | Yes; live filesystem scan | `discovered` |

**Summary:** claude-code and opencode merge a static built-in table
(`seedCommands` at boot) with filesystem skills refreshed by the scheduler.
pi and antigravity are skills-only; everything comes from `listCommands()` on
each discovery cycle. Stale `discovered` rows are pruned by
`upsertDiscoveredCommands`; stale `seed` rows are pruned by `seedCommands` on
boot.

The UI reads enabled commands via `GET /api/agents/:id/commands`.

## Editing static lists (claude-code, opencode)

Edit `apps/server/agent-commands.json` and **restart the server**; no code
change, no rebuild required.

| Edit | Effect on next boot |
|---|---|
| **Add a command** to the JSON `commands` array | Inserted into `agent_commands` with `source='seed'`, `enabled_flag=1` |
| **Remove a command** from the JSON array | Existing `source='seed'` row is pruned |
| **Edit `label` / `description` / `sourceDetail`** | Existing row updated in place |
| **Change `agentType`** on an entry | Old row pruned; new row inserted under the new agent |

Each entry requires `agentType`, `name`, `label`, and `description`. Optional
`sourceDetail` defaults to `'builtin'` (stored as `source_detail` in the DB).

Safety: if the JSON is missing, unparseable, or has an empty `commands` array,
`seedCommands` throws at boot and refuses to prune; a malformed file can never
wipe the catalogue.

What is NOT touched by `seedCommands`:
- `source='discovered'` rows (filesystem skills from `listCommands()`)
- `source='user'` rows (future catalogue CRUD)

## On-demand refresh

```http
POST /api/agents/:id/pull-commands
```

Mirrors `POST /agents/:id/pull-models`. Calls the adapter's `listCommands()`,
upserts results as `source='discovered'`, and prunes stale discovered rows for
that agent. Returns `{ commands: CommandRecord[] }`.

Requirements:
- Agent must exist (`404` if not).
- Adapter must implement `listCommands` (`400` if absent, e.g. a stub adapter).

Use this after installing or removing skills on disk without waiting for the
12-hour scheduler tick. Built-in verbs (`source='seed'`) are **not** affected:
edit `agent-commands.json` and restart for those.

The web client exposes this as `api.pullCommands(agentId)` in `apps/web/src/api.ts`.

## The `source` discriminator

`agent_commands.source` mirrors the `agent_models` pattern from
[Model Discovery by Adapter](./model-discovery.md):

| Value | Meaning | Created by | Pruned by discovery? | Pruned by seedCommands? |
|---|---|---|---|---|
| `seed` | Built-in verbs from `agent-commands.json` | `seedCommands()` at boot | No | Yes (if not in current JSON) |
| `discovered` | Filesystem-scanned skills/templates | `upsertDiscoveredCommands()` | Yes (if not in current list) | No |
| `user` | Future: custom commands via catalogue CRUD | Not yet implemented | No | No |

## Phase 2: command frame vs prompt passthrough

Phase 1 shipped the picker and catalogue only; slash text was sent as a normal
`prompt` frame and passed verbatim to `adapter.sendPrompt()`.

Phase 2 adds a dedicated WS `command` frame and server-side `handleCommand`:

1. **Client**: `CommandPicker` and manual Enter (when text matches `/name` or
   `/skill:name`) emit `{ type: 'command', name, args?, ... }` via `sendCommand`
   in `apps/web/src/ws.ts`. Plain prose still uses `type: 'prompt'`.
2. **Server**: `apps/server/src/index.ts` routes `command` frames to
   `sessionManager.handleCommand`, which persists a `prompt` event with
   `commandName` / `commandArgs` metadata plus the formatted slash text.
3. **Adapter**: if `runCommand(name, args)` exists, it is called after
   `adapter.start`. Otherwise falls back to `sendPrompt` with `/${name}` text.

Per-adapter invocation:

| Agent | `runCommand` behaviour |
|---|---|
| **opencode** | `opencode run --command <name> --format json` (native flag) |
| **claude-code / antigravity** | `sendPrompt('/<name> [args]')` passthrough |
| **pi** | `sendPrompt('/skill:<name> [args]')` passthrough |

**Backward compatible:** clients that only send `prompt` frames keep working.
Adapters that already interpreted leading-`/` text natively behave the same;
the command frame mainly enables structured metadata in the transcript and lets
OpenCode use its non-interactive command API.
