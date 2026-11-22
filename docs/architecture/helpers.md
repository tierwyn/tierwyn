# Helpers (native CLI subagents)

The word **subagent** is used two ways. They are not the same thing.

| | **Helper** | **Subagent** (delegate / spawn child) |
|---|---|---|
| What | The agent's own CLI tool (`Agent` / older `Task`) | A child conversation created via Tierwyn `/spawn` |
| Transcript | Lives inside the parent turn | Own conversation, own events |
| Token / result | No spawn token, no `◀ result` card | Spawn token; reports back with `## Result` |
| Tree | Header chip `⑂ N helpers running`; Helpers modal | Sidebar spawn tree; Agent Activity |

**Helpers** are in-process. **Subagents** are separate Tierwyn conversations. See [cross-agent-spawn.md](cross-agent-spawn.md) for spawn children. Agent-facing wording: `GET /agent/help/helpers`.

## Event shape

Two paths. Only path A is a real lifecycle.

**Path A: `helper` events** (`HelperEvent`). Snapshot per `taskId` (`running` / `completed` / `failed` / `stopped`, usage, summary, `parentTaskId`). Newest per `taskId` wins. `sessionManager` keeps `runningHelpers` from these events, that set drives the header chip, sidebar dashed ring, parked-session **adoption**, `stopWhenSettled`, and conversation-complete notification suppression. `stop_helper` → `adapter.stopHelper?()`.

- **Claude Code** maps SDK `task_*` system messages (`task_started`, `task_progress`, `task_notification`, `task_updated`, `background_tasks_changed`) to `helper` snapshots. Progress emits are throttled to one per task per 15 s; start, notification, terminal, and level-driven changes always emit. Filter: `task_type === 'local_agent'` or `subagent_type` set; exclude `main-session`, ambient, `skip_transcript`, and `local_bash`. `stopHelper` → SDK `stopTask`.
- **DeepSeek** maps the `subagent.started` / `subagent.finished` RPC notifications (dsh `parentSessionId` must match the session). Terminal status is `completed` on `status: ok`, `stopped` on a cancelled/aborted stop reason, otherwise `failed`; the summary comes from `lastAssistantMessage`. `stopHelper` is unimplemented.
- **Grok Build** maps `spawn_subagent`. The launch `tool_call_update` text holds `subagent_id: <uuid>` and `type:`; that becomes `helper{status: running, background: true}`. `get_command_or_subagent_output` `rawOutput` `{type:'TaskOutput', Result:{…}}` becomes `completed` / `failed`; `kill_command_or_subagent` and `TaskNotFound` become `stopped`. If the parent never fetches output, the adapter polls `~/.grok/sessions/<bucket>/<id>/subagents/<subagent_id>/output.json`. `stopHelper` is unimplemented (no out-of-band ACP cancel per subagent).

**Path B; web heuristic** (`apps/web/src/subagents.ts`). Any `tool_call` named `Task` / `Agent`, **or** carrying a string `input.subagent_type`, is treated as a helper. That gives the `⑂` transcript line and a Helpers-modal row. **Any `tool_result` marks it completed**, including an async "started in background" ack; the helper does **not** stay `running`. Path B does not drive the chip, adoption, or stop.

- **Cursor** renames `taskToolCall` → `Task` and injects `subagent_type` (`input.subagentType` or `'helper'`), so path B catches it. The Task tool is sync, so result = completed is correct.
- **Codex** re-emits each `collabAgentToolCall` receiver as a synthetic `Agent` tool_call with `subagent_type` (= nickname), plus a matching `tool_result` when the collab state goes terminal. Path B only; no `helper` events, so no chip / adoption / stop.

## Liveness

A helper shows `running` only if its newest snapshot is `running` **and** the conversation is in `activeConversationIds` (parked hold-open stays listed until reaped). Otherwise it shows `stopped`. Reload rebuilds from persisted snapshots. Path B rows with a `tool_result` are already `completed` even while the conversation is live.

## Surfaces

- Transcript: one compact `⑂` line per launching tool_call (click opens the modal). Inner helper events are hidden from the main stream.
- Header chip `⑂ N helpers running` while N > 0 (path A only).
- Sidebar: dashed-ring `status-dot helpers-active` (below `descendant-active`; conversation status stays `done` / `idle`).
- Helpers modal: tree, live elapsed, tool counts, progress/final summary, inner thread (tool calls and inner `message` events tagged with `parentToolUseId`).

`conversation_updated` / `active_sessions` may carry `helpersRunning`. ClientFrame `stop_helper` → `adapter.stopHelper` → Claude Code SDK `stopTask`. Adapters without `stopHelper` (Grok Build, DeepSeek) ignore the frame.

## Session lifetime

Parked sessions with path-A running helpers (Claude Code, Grok Build, DeepSeek) are **adopted**, not reaped, on the next operator prompt. An incompatible change still stops the process (helpers emit `stopped`). `stopWhenSettled` waits on helpers up to its 10-minute deadline. Grok's `spawn_subagent` defaults to `background: true`, so the parent turn can end while children run; path A is what keeps the session adopted until `output.json` or a fetch/kill arrives.

## Known limits

- **C1:** Inner helper `message` events (tagged with `parentToolUseId`) are emitted and persisted alongside tool calls, and shown in the Helpers modal thread (hidden from the main transcript stream).
- **C3:** A spawned child's `◀ result` still fires at its first `done`; helpers do not delay that one-shot. Conversation-complete notifications are suppressed while helpers run, because the CLI starts a follow-up turn on helper finish.
- **C4:** Helpers on transcript pages that have not loaded (`tailTurns`) are missing until those pages load. Schedule-run finalization can still stop a session with running helpers.

## Search

Operator message search (`GET /conversations/search`) and agent history search (`GET /agent/search`) both index terminal helper snapshots (label, description, summary) on the parent transcript. Find-in-transcript (Ctrl+F) does not. Helpers are not separate conversations. Details: [agent-search.md](agent-search.md).
