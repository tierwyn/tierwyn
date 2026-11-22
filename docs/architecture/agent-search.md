# Agent history search

Agents search past conversation transcripts with `GET /agent/search` and fetch surrounding turns with `GET /agent/conversations/:id/context`. Both require a live session Bearer that holds the `memory` capability (the same grant as project memories). Query parameters, context-fetch options, and error text live in `GET /agent/help/search`. Never query SQLite from inside a sandbox or remote host; these routes are the sanctioned path.

This is distinct from project-memory pull (`GET /agent/memory`). Memories are operator/agent notes; history search is transcript excerpts. See [project-memory.md](project-memory.md).

## What is searched

Hits come from prompt, assistant-message, and terminal native helper snapshot (label, description, summary) text in matching conversations. Spawn-child chats are ordinary conversations, so they are already in the index when they fall in scope.

Operator message search (`GET /conversations/search`, sidebar, Ctrl+K In messages, Ctrl+Shift+F) shares the same FTS index, including terminal helper snapshots on the parent transcript. Find-in-transcript (Ctrl+F) does not. Helper vs subagent: [helpers.md](helpers.md).

## Scope

Three values: `off` | `project` | `all`.

| Control | Where | Shape |
|---|---|---|
| Global | Settings → General → Agent history search | `GeneralSettings.agentSearchScope` (default `project`) |
| Per-project override | Edit project → Agent history search; `PATCH /projects/:id { agentSearchScope }` | `off` / `project` / `all` / `null`. `null` (and the omitted GET key) means inherit global. Migration 155 (`projects.agent_search_scope`). |

Resolution (one helper, used by the search guard, the preamble, and the fingerprint):

| Step | Result |
|---|---|
| 1. Base | `project.agentSearchScope ?? global` |
| 2. Cap | If the conversation is sandboxed **or** the project is on a remote host, `all` becomes `project`. `off` and `project` are unchanged. |

The cap shares one flag (`cappedBySandbox`); remote-host isolation uses the same preamble wording ("sandbox active"). See [sandbox.md](sandbox.md) and [remote-hosts.md](remote-hosts.md).

Changing the global or project setting does **not** reap parked sessions. The guard uses the new effective scope on the next search; a fingerprint change injects a full preamble on the next turn (same model as the global setting and as operator rules).

## Preamble and fingerprint

Search lines are emitted only when the memory capability would also pass **and** effective scope is not `off`.

| Mode | Effective | Line |
|---|---|---|
| Full | `project` | `(this project only; same Bearer)` |
| Full | `project`, capped | `(this project only, sandbox active; same Bearer)` |
| Full | `all` | `(default: this project; scope=all enabled; same Bearer)` |
| Stub | `project` | `this project only` |
| Stub | `project`, capped | `this project only; sandbox active` |
| Stub | `all` | `scope=all enabled` |

Fingerprint extras (absent when off or memory is not allowed): `{ ss: <effective> }` plus `ssc: 1` **only when capped**. Uncapped hashes stay `{ ss: 'project' }` / `{ ss: 'all' }` so a deploy does not mass-re-preamble.

## Errors

| Code | When |
|---|---|
| `agent_search_off` | Effective scope is `off` (403) |
| `cross_project_search_disabled` | `scope=all` or a foreign `projectIds` when effective is not `all` (403) |
| `rate_limited` | More than 30 search/context requests per conversation per minute (429) |
| `no_memory_capability` | Bearer lacks `memory` or the capability profile has `memory: false` (403) |

## Transcript search (Ctrl+F)

In the web UI, pressing `Ctrl+F` / `Cmd+F` (or selecting **Find in transcript** from the conversation menu) opens the floating transcript search bar (`TranscriptFindBar`). It matches visible user/assistant cards. Helper snapshots are not in this bar; search those with message search (`Ctrl/Cmd+Shift+F`). Spawn-child transcripts are separate conversations; search those the same way, or by opening the child.

- **Inline highlighting:** Uses the browser's CSS Custom Highlight API (`CSS.highlights`) to highlight every match occurrence directly across rendered Markdown and code blocks without mutating React DOM, with a high-contrast active highlight and automatic fallback to HAST `<mark>` wrapping on unsupported browsers.
- **Scrollable results overlay:** Lists up to 500 matches with turn number, role badge, and surrounding context words; clicking any item (or stepping with `Enter` / `Shift+Enter` / `↑` / `↓`) auto-expands collapsed turns and scrolls directly to that occurrence.
- **Search modes:**
  - **Substring** (default): case-insensitive phrase match.
  - **`All` (multi-word):** space-separated AND at the card level; highlights every occurrence of each term in document order.
  - **`.*` (regex):** compiles `RegExp` with inline syntax-error feedback, zero-length match guards, and a 2,000-occurrence cap (mutually exclusive with `All`).
  - **`Aa` (match case):** applies across substring, `All`, and `.*` modes.
