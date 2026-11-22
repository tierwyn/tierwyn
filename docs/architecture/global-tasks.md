# Global Tasks

Cross-project log of agent work. Agents create and update tasks for any user request to accomplish or modify work, no matter how small, through a bearer-scoped API. The operator reviews, completes, hides and deletes them in a header modal that updates live.

**Code:** `packages/shared/src/globalTasks.ts`, `apps/server/src/repositories/globalTasks.ts`, `apps/server/src/routes/globalTasks.ts`, `apps/server/src/spawn/preamble.ts` (`globalTasksBlock`), `apps/web/src/globalTasks.ts`, `apps/web/src/components/GlobalTasksModal.tsx`, `apps/web/src/components/GlobalTasksSettings.tsx`.

The per-conversation TodoWrite list (`TaskListModal`) is a different surface. This feature is always called **Global Tasks**.

---

## Data model

Table `global_tasks` (migration **138**). Limits: title ≤ 200 chars and single-line; description, testing and progress ≤ 4000 chars each; at most **3** `in_progress` tasks per conversation; operator list ≤ 500 rows.

| Link | Rule |
|---|---|
| Project | `ON DELETE CASCADE`, plus an explicit `DELETE` in `deleteProject` (the repo does not rely on `PRAGMA foreign_keys`). |
| Conversation | `ON DELETE SET NULL`, plus an explicit null-out in `deleteConversation`. `conversation_title` is a snapshot so the row survives retention/manual delete. |
| Session | Plain text, no FK. Provenance only (`session <first 8>` in the modal). |
| Project id | Stored on the row. `moveConversationTree` re-points every subtree task inside the same transaction. |
| Stale | Derived: `status='in_progress'` and `now - updatedAt > staleAfterHours`. No column, no sweep. |
| Hidden | `hidden_at` set. Hidden is not deleted. Auto-delete counts from `hidden_at`. |

DTO extras (operator list only): `projectName`, `conversationArchived`, `parentConversationId`, `parentConversationTitle`, `live` (server-side `hasLiveSession`).

---

## Agent API (bearer, `'tasks'` capability)

Mounted **before** `requireAuth`. Own conversation only. Server derives `projectId`, `conversationId`, `sessionId` and `conversationTitle`; never from the body. Text fields go through `redactSpawnTokens()`.

| Route | Notes |
|---|---|
| `GET /tasks/agent` (or `/conversations/:id/tasks/agent`) | Non-hidden tasks for this conversation (any status). Direct form infers conversation from Bearer token. |
| `POST /tasks/agent` (or `/conversations/:id/tasks/agent`) | `{ title, description?, testing?, progress? }` → 201. Cap 3 open → 409 `{ error, openTaskIds }`. |
| `PATCH /tasks/agent/:taskId` (or `/conversations/:id/tasks/agent/:taskId`) | `{ title?, description?, testing?, progress?, status? }`. Foreign task → 404. Hidden → 409. Reopen counts against the cap of 3. |

### Guards

| Condition | Response |
|---|---|
| No live token | 401 |
| Token lacks `'tasks'` | 403 `no_tasks_capability` |
| Path id ≠ token conversation | 403 `cross_conversation` |
| Feature disabled | 403 `global_tasks_off` |
| `scope='roots'` and conversation has a parent | 403 `global_tasks_root_only` |
| Conversation missing | 404 |
| Unknown body keys / over-length | 400 |
| 3 already open (create or reopen) | 409 `openTaskIds` |
| PATCH of a hidden task | 409 |

Live re-check of **enabled** and **scope** on every request. A token minted under `'all'` cannot keep writing after the operator narrows to `'roots'`.

---

## Operator API (cookie)

While `enabled=false` every `/tasks*` route below answers **403 `global_tasks_off`** (same decision as the agent guard); the log cannot be read, mutated, or swept over the API, and the web hides the header icon and stops fetching counts. Only the settings routes stay reachable; rows are kept and reappear on re-enable.

| Route | Purpose |
|---|---|
| `GET /tasks?view=in_progress\|completed\|hidden&projectId=` | Default `in_progress`. Newest first, ≤ 500. Always returns global `counts` (project filter does not shrink counts). |
| `GET /tasks/count` | `{ inProgress, completedVisible, hidden }` for the header badge. Fetched once on WS connect (only when enabled). |
| `PATCH /tasks/:id` | `{ status?, hidden? }` only. Operator complete sets `completedBy='operator'`. Reopen is allowed even with 3 already open. |
| `POST /tasks/hide-completed` | Hide every visible completed row. One `global_task_updated` frame per row. |
| `DELETE /tasks/:id` | Hard delete. |
| `DELETE /tasks?view=hidden` | Bulk hard-delete of hidden rows. Other `view` values → 400. |
| `GET\|POST /settings/global-tasks` | Settings JSON row `global_tasks`. |

---

## Frame

`global_task_updated` is operator-global (`sessionHub.broadcastAll`), same reach as `grokbot_status`:

```ts
{ type: 'global_task_updated', taskId, op: 'upsert' | 'delete', task?: GlobalTaskDto, counts: GlobalTaskCounts }
```

`counts` are global after the change. The header badge takes them from the frame. The modal applies upserts/deletes in place via `applyTaskFrame` and refetches every 15 s while open so `live` and `stale` stay fresh.

---

## Settings (defaults)

| Field | Default |
|---|---|
| `enabled` | `true` |
| `scope` | `'roots'` (no parent, or parent is a `schedule_home`). `'all'` includes children. |
| `staleAfterHours` | `48` (`0` = never) |
| `autoDeleteHiddenAfterDays` | `30` (`0` = never) |

Schedule runs (direct children of `schedule_home`) are policy roots; the home is a container, not a parent agent, so they record tasks under `'roots'`. Their sub-agents do not. Bare-prompt adapters (Grok Bot) mint no token and cannot write tasks.

---

## Lifecycle

| Situation | Behaviour |
|---|---|
| Session ends mid-task | Stays `in_progress`. Ages to **stale**. A live session shows **live**. No auto-complete. |
| Resume / model switch / compaction | Next turn GETs open tasks and updates the same row. Task belongs to the conversation. |
| Children, `scope='roots'` | No `'tasks'` capability. Report through `## Result`; the root owns the task. |
| Children, `scope='all'` | Own rows, UI `↳ sub-agent` + parent title. |
| Operator completes while agent is working | Allowed. Agent PATCH `in_progress` reopens if unhidden. Hidden → 409, agent opens a new task. |
| Conversation archived | Kept, `archived` badge, jump still works. |
| Conversation deleted | `conversationId` null, snapshot title kept, jump disabled. |
| Conversation moved | Subtree `projectId` re-pointed in `moveConversationTree`. |
| Project deleted | Tasks deleted. |
| Feature turned off | Agent and operator task routes 403 immediately; header icon hidden, count fetch skipped. Preamble block drops on the next turn (`gt` fingerprint). Existing rows stay in the DB and reappear when re-enabled. |

---

## Sweep

Nightly `afterPass` next to `pruneDecisionUsage` (own try/catch). Deletes rows with `hidden_at < now - autoDeleteHiddenAfterDays·86400000`. Silent: no WS frames. Skipped when days ≤ 0 **and while the feature is disabled** (`sweepHiddenGlobalTasks` no-ops); turning the log off pauses retention too, so every row survives until re-enable. Timer starts at hide, not at complete, so unreviewed completed work never disappears on its own.

---

## Security

- `'tasks'` is minted by `withSessionScope` iff Global Tasks is enabled and the conversation is in scope. It is independent of `schedule` so the operator can turn the log off without disarming timers.
- Routes re-check enabled + scope live, for agents **and** the operator (`global_tasks_off`). Own-conversation reads and writes only.
- Ids and titles are server-derived. Agent text is untrusted, length-capped, redacted, and rendered only through `MarkdownBody`.
- Cap of 3 open tasks per conversation. (Operator actions have no cap, so an operator reopen/unhide can leave >3 open tasks; the agent receives 409 on its next POST until count drops below 3.) Worst case of a prompt-injected agent is junk rows in one modal, which the operator deletes.
- Capability profiles do not gate this surface (core, not a plugin).

Preamble: `globalTasksBlock` in both full builders, one-line stubs, fingerprint `gt: 1` (root wording) or `gt: 2` (child wording). Key absent when the block is off.
