# Browser and PWA notifications

Tierwyn can raise OS notifications when work finishes away from the tab you are looking at: conversation completion, schedule fire (includes the run starting), schedule run end, auto-disable of a `once` job, and unsolicited inbound agent messages (Grok Bot watcher).

**Code:** `packages/shared/src/notifications.ts`, `apps/web/src/notifications.ts`, `apps/server/src/notifications/notifier.ts`

Off by default. Nothing fires until you opt in.

---

## Enable (operator)

1. Open Tierwyn on **HTTPS** (the reverse-proxy hostname). Plain `http://<lan-ip>:4173` cannot use `Notification`, service workers, or Web Push. Settings shows that instead of silent failure.
2. **Settings → Notifications.**
3. **Enable notifications on this device**: browser permission prompt (must be a click; never on page load). Repeat on each device. Open this panel once even if the browser already granted permission (device pref defaults off until you do).
4. Turn on the **server master** toggle, then the categories you want.
5. Optional: **Receive notifications when the app is closed**: Web Push for a killed PWA. On iOS 16.4+ this only works from an **installed** Home Screen PWA.

**Send test notification** appears after permission is granted.

---

## What notifies

| Category (settings) | When | Title / body (approx.) |
|---|---|---|
| Conversation complete | Any chat/spawn child reaches `done` or `error` | Conversation title · `Completed · <detail>` / `Failed · <detail>` |
| Schedule fired | Job dispatches a run (also covers “run conversation started”) | `⏱ <job name>` · `Run started · <detail>` |
| Schedule run ended | Run `succeeded` / `failed` / `timed_out` / `skipped` | `⏱ <job name>` · `Run <status> · <detail>` |
| Schedule disabled | Server **auto-disables** a `once` job | `⏱ <job name>` · `Schedule auto-disabled · <detail>` |
| Agent message | Unsolicited inbound message (Grok Bot watcher, conversation idle) | Conversation title (or `Agent`) · `New message · <detail>` |

`<detail>` = the conversation **description** when one exists, else the **project name**, else no
suffix (bare phrase). Same rule on every category; titles are unchanged.

Manual disable in the UI does **not** notify.

Fire and “scheduled conversation started” are **one** notification: one fire creates one run conversation.

Each conversation depth notifies on its own (`↳ Role` for spawn children). The parent does not get a second toast for the same child.

---

## When it stays quiet

The page path (open tab or live PWA) suppresses if:

- Master, category, or this-device pref is off, or permission is not `granted`.
- You are **looking at** that conversation (`document` visible + that row selected).
- This page session never saw the conversation `running` / `waiting`, so **clicking an old finished chat does not notify** (the server can replay `done` on subscribe).
- The conversation is a **schedule run**; completion is `schedule run ended`, not a second “conversation complete”.
- The same notification `tag` fired in the last 30 seconds.
- The frame is `session_ended` (never a trigger).

Web Push **cannot** see which conversation is on screen. A subscribed phone may buzz while you watch the same run on the desktop. Same-device duplicates collapse by `tag`. This is accepted; push is not gated on “no browser tab connected”.

---

## Interrupt filter (Jev)

Same notification copy, fewer notifications. An optional, server-only filter asks TypeSafe's Jev (`POST /v1/systemone`, pinned model) whether a notification should interrupt you. Off by default.

**Judged:** `done` completions, Grok Bot inbound messages, and `succeeded` / `skipped` schedule runs.

**Always notifies (never judged):** `error` completions, `failed` / `timed_out` runs. `scheduleFired`, `scheduleDisabled` and Grok Bot app-status events are never judged either.

**Fail-open.** Filter off, no key, category/master off (Jev never re-enables a category), TypeSafe down or erroring, the 2 s timeout, or a partial answer: behaviour is identical to a build without the filter.

**Thresholds.** `INTERRUPT_CONFIDENCE_FLOOR = 0.6` in `notifications/notifier.ts` (a constant, no UI). Suppress only when `interrupt_worthy` is clearly no (noul ≤ 0.4). `needs_attention` / `expects_reply` ≥ 0.5, or a `urgency` score ≥ 1 with confidence ≥ 0.6, override to "notify". One content-free `[decide] verdict …` log line per judged event, for tuning.

**Privacy.** What leaves the machine to TypeSafe: conversation title (≤120), description (≤200), job name, and at most 1500 chars of the last assistant reply, scrubbed (spawn/run tokens redacted, code fences → `[code]`, path-like tokens → `[path]`). Only `message` events are read, never tool calls or results. None of it is added to the push payload or the toast. Zero data retention is enterprise-only at TypeSafe.

**Latency.** While the filter is on, a `done` sidebar frame (`conversation_updated`) and a schedule run-ended frame are held until the verdict arrives, up to about 2 s, so a suppressed toast is never shown and then retracted. The output pane is not held. A held frame made stale by a newer status frame is dropped; the push still goes out.

**Settings.** Settings → General → *Notification filter (Jev)*: enable, API key (write-only), model, base URL, Test. Stored in the `settings` row `decision`; `GET /settings/decision` returns `apiKeySet`, never the key. `POST /settings/decision/test` probes server-side and ignores `enabled`. Cookie-auth only.

See [jev.md](jev.md) for the shared Jev plumbing and the auto-tagging consumer.

---

## Two delivery paths

| Path | When it works | View-aware? |
|---|---|---|
| Page `Notification` | Tab or PWA still alive (WS up) | Yes |
| Web Push (`web-push` + VAPID) | App closed / iOS background / Android frozen | No |

Both use the same `buildNotification()` title/body/`tag`. Click focuses an existing window or opens `/?c=<conversationId>` (then the query is stripped).

Bodies never include prompt text, agent output, tool arguments, file paths, or spawn tokens.

**Body detail suffix.** Every category appends `· <detail>` to its base phrase, where detail is the conversation **description** if there is one, otherwise the **project name**, and the suffix is dropped when there is neither:

| Category | Body |
|---|---|
| `conversationComplete` | `Completed · <detail>` / `Failed · <detail>` |
| `scheduleFired` | `Run started · <detail>` (project name, a just-created run has no description yet) |
| `scheduleRunEnded` | `Run succeeded\|failed\|timed out\|skipped · <detail>` |
| `scheduleDisabled` | `Schedule auto-disabled · <detail>` (project name, no conversation exists) |
| `agentMessage` | `New message · <detail>` |

The detail is **body-only**: titles are still the conversation title (or the literal `Conversation`) and `⏱ <job name>` (or `⏱ Agent run`). This reverses the earlier "never include the description" rule. It is a single-operator deployment and the operator wants the "what is this run" line on the lock screen; note that a push body transits the browser vendor's push service, so a description is not a place for secrets.

---

## Settings storage

| What | Where |
|---|---|
| Master + four categories + VAPID keypair | Server `settings` row `notifications` (`GET`/`POST /settings/notifications`) |
| Jev filter: enabled, key, model, base URL | Server `settings` row `decision` (`GET`/`POST /settings/decision`; key never returned) |
| “This browser may notify” | `localStorage['tierwyn.notifications.device']` |
| Push endpoints | `push_subscriptions` (migration **105**) |

`GET /settings/notifications` never returns `vapidPrivateKey`. POST cannot set VAPID keys. Subscribe routes (`/notifications/vapid-public-key`, `POST`/`DELETE /notifications/subscribe`) are **cookie-auth only**; not reachable with a spawn bearer token.

VAPID keys are generated on first push subscribe and stored in the settings row (no extra env var).

---

## Protocol (for implementers)

`conversation_updated { status }` already fans to every socket; no extra frame for completion.

`schedule_updated` may include:

- `jobName?`, so a client that never loaded that project can still title the toast
- `event?: 'fired' | 'auto_disabled'`; absent means a state refresh; do **not** notify from absence
- `interruptWorthy?: boolean`: Jev verdict, only on the terminal finalize frame when the filter ran. `false` = do not toast; `true` / absent = today's behaviour

`conversation_updated` may likewise carry `interruptWorthy?` on a terminal `done` frame. Absence never clears anything and never suppresses.

---

## Deploy notes

- `npm run deploy:prod:full` so the preview SPA picks up `sw.js` + Settings (schema migrations apply automatically at API boot).
- Notifications require the **TLS** hostname (`allowedHosts` / reverse proxy). See [deployment.md](../deploy/deployment.md).
- After deploy: hide a tab and finish a conversation (expect one toast); keep that conversation selected and visible (expect none); click an old finished conversation (expect none); run-now a schedule (expect exactly two: fired + ended).

See also: [conversation descriptions](conversation-descriptions.md), [scheduled-jobs.md](scheduled-jobs.md).
