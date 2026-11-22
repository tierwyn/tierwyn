# Grok Bot inbound watcher

A Grok Bot that keeps working after Tierwyn has closed the turn still writes into the
desktop app's replica. The inbound watcher is a server-lifetime poller on the same
attach-only CDP client the adapter uses. It is **not** an adapter instance and never
appears in Active Agents.

**Code:** `apps/server/src/adapters/grok-bot/watcher.ts`,
`apps/server/src/adapters/grok-bot/reconcile.ts`,
`apps/server/src/repositories/grokBotWatch.ts`,
`apps/server/src/repositories/remoteAgents.ts`

---

## What it does

Every `TIERWYN_GROKBOT_WATCH_MS` (default 25 s) the watcher:

1. Reads the app roster once.
2. **Reconciles the Remote Agents container** against that roster (see below).
3. **Resolves Bot ownership via reply lease**: for each Bot UUID, evaluates every
   non-archived conversation with a `grok-bot` session whose `native_session_id`
   matches that Bot.
   - `lastPromptAt`: newest `prompt` event in those sessions. A conversation with
     none is **not asked**.
   - `lastActivityAt`: newest event with `sender <> 'system'` in those sessions
     (system markers, including handover cards, never renew a lease).
   - `container`: top-level conversation in the Remote Agents project with session model
     `NULL` or `grok-bot:<botId>`.

   The owner conversation is chosen by priority:
   1. Among **asked** conversations with `now - lastActivityAt <= leaseMs`
      (`TIERWYN_GROKBOT_REPLY_LEASE_MS`, default 1 h): newest `lastActivityAt`.
   2. Otherwise, the Remote Agents container conversation.
   3. Otherwise, the asked conversation with the newest `lastActivityAt`
      regardless of lease (ensures replies are never dropped when auto-create is off).
   4. Otherwise, the Bot is not watched.

   When ownership moves between conversations, a **handover card** (`⇄ Grok Bot moved`)
   is posted in both the old and new owner conversations with a link to the other chat.
4. Chats whose `newestEntryId` matches the persisted cursor are skipped; no
   replica read.
5. If any `grok-bot` turn is live across Tierwyn, the watcher **holds the cursor**
   (never fast-forwards) so that entries appearing after the live adapter's last poll
   are delivered to the owner conversation after the live turn settles.
6. For a changed chat outside a live turn, reads the replica, persists
   new entries onto a synthetic idle session (assistant `send-message` rows as
   `message` / `sender: 'agent'`, and user `message` rows typed in the native app /
   phone / web as `prompt` / `sender: 'user'`), broadcasts `event` + a bare
   `conversation_updated` (no `status`), and fires one `agentMessage` notification
   per burst of assistant text. Late child replies in a spawn child are relayed
   to the parent conversation (a `result` marker always; parent LLM turn wake-up
   only when `spawn_edges.notify_parent = 1`). Replica `message.type === 'attachment'` rows
   (inbound files from the Bot or native app) go through the same
   `resolveSandboxMedia` path as the live adapter: bytes via
   `window.desktop.readAttachmentBytes`, write-if-absent under
   `<dataDir>/attachments/<conversationId>/<sha256>.<ext>`, then a `message`
   event with `payload.files` (sandbox `file://` URLs are never persisted).
   The replica echo of a prompt Tierwyn itself just
   sent is suppressed once, matched whitespace-normalised; a genuinely repeated
   question still lands. History backfill includes those user rows too.


Cursors live in the `settings` row `grokbot.watch.cursors` (optional `name` field
tracks the last auto-written conversation title). No extra cursor table.

---

## Remote Agents container

Boot seeds one system project (`id` `00000000-0000-4000-8000-00000000b07d`,
`projects.system = 1`, name **Remote Agents**). It cannot be renamed or deleted
(HTTP 409; the sidebar hides those menu items).

When a non-group Bot appears in the roster and **Auto-create Remote Agents** is
on (General settings, default on):

- Upsert its model row (`grok-bot:<botId>`) so the session FK holds; same
  descriptors `listModels()` publishes, so picker labels refresh within one tick.
- Create exactly one conversation in that project, titled from the Bot name,
  with `sessions.native_session_id = botId`. Opening it pre-selects that Bot.
- A Bot rename updates the conversation title **only while the title still
  matches the last name the watcher wrote**. An operator rename freezes it.
- A Bot that leaves the roster archives the conversation and appends one system
  marker (`_This Bot was removed from the Grok Bot roster._`). The composer
  becomes read-only. Reappearing does **not** unarchive or duplicate.
- An empty or failed roster read creates nothing and archives nothing.

Turning **Auto-create Remote Agents** off skips **creation** only. Existing
container conversations keep being watched, renamed, and retired.

### History backfill

Auto-create used to arm the watcher cursor at `newestEntryId`, so a newly adopted
Bot arrived blank. The replica already holds the full history (verified v0.30.0:
a 43-entry slice starts at `tbs0`). Reconcile now leaves `cursor.entryId` empty
and sets `cursor.backfill = K` (`K` = Settings **Grok Bot history backfill**,
default **200**, range 0–2000, `0` = start from now).

The next ingest of that Bot takes the last `min(K, entries.length)` replica
entries, writes them with each entry's own `timestampMs` (so the transcript
orders correctly), then clears `backfill`. Operator notifications are suppressed
for the whole batch; adopting a Bot must not push 200 toasts. One backfill
batch per tick, so adopting five Bots spreads over five intervals.

Existing conversations are never re-armed. A conversation deleted with the
delete-Bot flag **off** is re-created on the next tick *with* history (if
`K > 0`).

### Deletion

`DELETE /conversations/:id` already called `adapter.deleteNativeSession`. The
Grok Bot adapter implements it behind Settings **Delete Bot with conversation**
(default **off**). With the flag off, `deleteNativeSession` is a no-op and the
watcher re-creates the conversation on the next tick.

With the flag **on**, Tierwyn drives the app's own Bot-actions context menu
(live-verified v0.30.0):

```
Pin · Move to new section · Mark as Read · Edit Profile · Duplicate ·
Share as template · Copy conversation ID · Hide from sidebar · Delete
```

Then confirms the DOM `[role="alertdialog"]` (Cancel / Delete, not a native
Electron dialog). Failure is non-fatal: the HTTP delete still returns 200 after
the DB rows are gone; a surviving Bot is recoverable in the app. `Escape` (CDP
vk 27) dismisses a leftover menu. Closed Base UI popups linger with
`data-closed`; counting `[role="menuitem"]` is not an open signal.

The Remote Agents project cannot be deleted or renamed (HTTP 409). Container
conversations cannot be duplicated or moved (HTTP 409); the edit modal hides
those controls.

### Creation

The operator can create a named Bot from the sidebar the same way as a normal
conversation: **Remote Agents → New conversation → title → Create**. That path
does **not** call `POST /conversations` (still **403** for this project). It
calls `POST /grok-bot/bots` with `{ title }`.

The server:

1. **409** if Grok Bot is disabled (same gate as `POST /grok-bot/start`).
2. `ensureRunning('manual')` then attaches to the existing CDP page target
   (`discoverPageTarget` + `CdpClient` via `getApp().getClient()`).
3. Drives the New-chat bar (live-verified v0.30.x): **New chat** → type into
   **Search or create Bots** (native value setter + `input` event) → click
   `Create “<name>” Bot` (curly quotes; straight `"` also accepted) → poll the
   roster for a new id, preferring a name match. Failure closes the bar
   (**Close new chat** or Escape) so the desktop app is not left open.
4. Catalogue: only a **successful** post-create roster read that includes the
   new Bot id runs the full `upsertDiscoveredModels` (same as reconcile). If
   that read fails, Tierwyn inserts/refreshes **only** the new Bot's model row
   (no prune) so peers stay enabled, then creates the conversation. A race with
   the inbound watcher returns the existing conversation (**200**) instead of
   duplicating. Fresh create is **201** with the conversation object the UI
   already expects from `createConversation`.
5. Concurrent creates: process-wide lock → second request **409** `create
   already in progress`; the sidebar Create button shows Creating… and is
   disabled while the request is in flight.
6. CDP failure is **502** with a safe error string and **no** half-created DB
   row (the conversation is written only after a Bot id exists).
7. **Watcher ingest.** Fresh create (**201**) arms the same backfill cursor
   reconcile uses (`entryId` empty + `backfill: K`, or `newestEntryId` when
   `K = 0`) and kicks `tickNow()` so the welcome already in the replica is
   ingested immediately; without this, the first interval tick would seed
   `entryId = newest` and skip it. A 200 (watcher already created the row)
   does not re-arm.

Blank `Create new Bot` (no name) is out of scope: Tierwyn always supplies a
title. Duplicate-Bot from the context menu is also out of scope.

The create modal under Remote Agents is title-only (no template, workdir,
designation, capability, or tags).

### Onboarding question cards

New Bots show a multiple-choice form in the desktop transcript: `role="article"` / `.sand-message-card` wrapping a `<form>`,
lettered `button.sand-button` (`A`–`E`), `textarea[aria-label="Custom answer"]`,
and `button[aria-label="Dismiss question"]`.

Option / onboarding cards are **replica widgets**
(`send-message` + `message.type: "widget"` with `prompt` / `options` /
`allowCustom`). Open = no `respondedValue` and no `widgetSkipped`. The watcher
maps them to `interaction_request` (`kind: 'question'`, requestId `gbw-<entryId>`,
lettered choice ids `A`/`B`/… + `dismiss`) **without** selecting the Bot, so
the idle tick does not flicker the sidebar. Disappearance in the replica
(answered or skipped in the app) becomes `interaction_resolved` `auto`.

Answering from Tierwyn still needs one `selectAgent` hop: `answerIdleInteraction`
selects the Bot, remaps `gbw-…` to the live DOM stamp (`gbq-…` via prompt match),
then `clickQuestion` / `answerQuestionFreeText`, and restores the previous
selection. Live turns poll the DOM next to permission cards as before.

Tool **Allow once** / **Always allow** / **Never** cards remain DOM-only
(permission `kind`); they are never auto-approved. Live turns own all cards;
the watcher does not double-emit while `isLive`.

---

## Pruning sweep

The inbound watcher and auto-create path grow Remote Agents conversations
without an operator in the loop. A nightly pruning sweep rides the existing
retention scheduler (one pass per settled 03:00 chain, including when
conversation retention is 0 / keep-forever) and is scoped **only** to that
container:

1. **Transcript truncation**: each *active* (unarchived) container
   conversation is reduced to the newest `grokBotTranscriptEventLimit` events
   (Settings → General → Conversation Retention; default **2000**; `0` =
   unlimited). Truncation does not bump `updated_at`, does not delete
   `sessions` rows, and does not VACUUM; freed pages are reused by the next
   night's inserts, so the DB file plateaus rather than shrinks. Use **Purge
   now** if you actually want the bytes back after a one-off limit reduction.
2. **Stale sweep**: container conversations that reconcile archived (Bot
   left the roster) and have been silent longer than
   `conversationRetentionDays` are written to `data/archive/<id>.jsonl` and
   then deleted. A failed archive write leaves the conversation intact for a
   retry tomorrow. When retention days is 0, this pass is disabled.

Pinned conversations and conversations with a live/parked Tierwyn session are
exempt from both passes. Ordinary project conversations, including ones you
archived by hand; are never touched. Tierwyn never deletes anything inside
the Grok Bot app during this sweep.

**Clock caveat:** there is no `archived_at` column. The stale sweep keys on
`updated_at`, so the rule is "retired **and** silent for N days". A Bot
removed from the roster today whose last message is already older than the
window is swept on the next pass; the transcript is in the `.jsonl` archive.

---

## What it does not do

- **`grok-bot:default` is never watched** (outside the container). That profile
  means "whatever chat is open in the app". Container conversations are always
  pinned, so the exclusion does not apply to them.
- Never emits `status: running`. Conversation status stays `idle`. A watcher
  session with a running status would poison transcripts on restart via
  `closeStaleSessions`. Retirement is a `message` from `sender: 'system'`.
- Yields to a live turn: if any grok-bot turn is live across Tierwyn, the watcher
  holds the cursor (never fast-forwards), delivering entries after the turn settles.
  Backfill still lands (it is historical, not a live turn).
- Does not move existing ad-hoc grok-bot conversations into the container.
  `PATCH /conversations/:id { projectId }` is 409 when the source or target is
  the Remote Agents project.

---

## Environment

| Variable | Default | Effect |
|---|---|---|
| `TIERWYN_GROKBOT_WATCH_MS` | `25000` | Roster poll interval while the app is reachable. |
| `TIERWYN_GROKBOT_REPLY_LEASE_MS` | `3600000` | How long a chat that prompted a Bot keeps receiving its late replies before they return to the Remote Agents container. 0 = always the container. |
| `TIERWYN_GROKBOT_WATCH` | unset (on) | Set to `0` to disable the watcher. |

When the Grok Bot app is closed, the interval stretches to 60 s, then 300 s after
ten consecutive failures. A closed app is normal; no error events are written.

Notifications: Settings → General → Notifications → **Agent message**.

---

## Lifecycle supervisor

The inbound watcher never starts the desktop app. A separate supervisor
(`apps/server/src/adapters/grok-bot/supervisor.ts`) owns launching.

**States:** `disabled` · `unsupported` · `not-installed` · `no-display` · `stopped` · `starting` · `running` · `running-no-cdp` · `port-conflict` · `backoff` · `failed`.

**Policy** (`Settings → Grok Bot → Auto-start`, default `keep-running`):

| Policy | periodic | on-demand / prompt | manual |
|---|---|---|---|
| `off` | no | no | yes |
| `on-demand` | no | yes | yes |
| `keep-running` | yes | yes | yes |

`TIERWYN_GROKBOT_AUTOSTART=0` kills launching (including manual). `TIERWYN_GROKBOT_WATCH=0` still only kills the watcher.

**Launcher chain:** `systemctl --user start <unit>` → `systemd-run --user --unit=tierwyn-grokbot-adhoc` → detached `spawn`. Unit default `tierwyn-grokbot.service` (`TIERWYN_GROKBOT_UNIT`). Binary default `/opt/Grok Bot/grok-bot` (`TIERWYN_GROKBOT_BIN`).

**Enabled gate:** `grokBotEnabled(db)` is the `grok-bot` agent `enabled_flag`. When off, the watcher tick re-arms without dialling, the prune sweep is skipped, and the supervisor stays `disabled`.

**Kick:** the watcher's first unreachable edge per episode calls `supervisor.kick()`, which schedules an immediate periodic check (single-flight absorbs overlap). The supervisor never calls the watcher.

Boot is fail-open: `start()` only arms a 5 s unref timer after `listen`. `stop()` clears timers and never stops the app or unit.

---

## Scheduling a Bot

Grok Bot schedules always use **`resume_conversation`**. `executionMode` is immutable after create. Creating a `spawn_child` job with a grok-bot profile (or in the Remote Agents project), or switching a `spawn_child` job's profile to grok-bot, returns `400` with `code: grok_bot_requires_resume`; a new run conversation would steal the Bot's reply lease.

**Bot pinning.** At create (and on rebind / profile change), the server resolves the Bot id from the bound conversation (`getRemoteAgentBotId` in Remote Agents, or the last `grok-bot` session's `native_session_id` elsewhere) and stores `profileId: grok-bot:<botId>`. `inherit` and `grok-bot:default` are rewritten the same way so the job never follows whichever chat is open in the desktop app. After that rewrite, bare-prompt field checks run against the pinned profile (so `inherit` + steps / templates / agent-may-complete cannot slip through). A mismatched `grok-bot:<otherId>` or a bound chat with no Bot session yet → `400` (`grok_bot_unbound` when unbound).

**Bare prompt / no token / no steps.** Each tick sends only the substituted operator template (plus plain steer / pending context). No step-API footer, no run token, no `complete-job` URL. Packs, plan steps, worktrees, templates, and agent-may-complete are rejected for bare-prompt agents.

**On-demand start.** Before binding the run, dispatch kicks `ensureRunning('on-demand')` without awaiting it and reads the live supervisor `status()` (`bindEnsureGrokBot`). A launchable app leaving `stopped` is marked `starting` synchronously before the CDP probe awaits, so a cold tick proceeds; `_awaitSupervisor` inside `handlePrompt` joins the same in-flight launch for the slow path (and surfaces a clear error if the launch dies). States `running` and `starting` proceed. Terminal non-runnable states fail with `grok_bot_unavailable: …` before any run bind. A short **5 s** race is only a safety net around a wedged status read; the tick is never held for the full launch. Disabled agent, `TIERWYN_GROKBOT_AUTOSTART=0`, and policy `off` / `manual` stay non-launchable (`canLaunch` false) so the kick does not mark `starting` and the live status fails immediately.

**Timeout.** Bot run timeout defaults to **30 minutes** (`run_timeout_ms` default `1800000`). Resume success does **not** call `stopSession` (that would send "Stop now" to the Bot).

**Lease / handover.** A resume tick creates a new session in the Bot's *current owner* conversation, so `listWatchedBots` keeps the same owner; no handover card is posted when the schedule run is already the owner.

**Bots cannot self-schedule.** Agent-created jobs are forced to `spawn_child`, and grok-bot rejects `spawn_child`, so a Bot (bare-prompt, no spawn/schedule token) cannot mint a Bot schedule (R5 / A6). Use operator-created resume jobs or **operator conversation timers** for one-shot wakes.
