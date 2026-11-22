# Conversation Timers

Conversation timers allow scheduled future wake-ups in Tierwyn conversations without configuring full recurring or one-shot scheduled jobs. Timers can be scheduled by the operator (via the Prompt Timer modal or input chips), by parent agents (deferred descent resumes), by the usage-limit watcher (`auto-resume`), or by an agent waking itself up (`agent-self`).

**Code:** `packages/shared/src/conversationTimers.ts`, `apps/server/src/routes/conversationTimers.ts`, `apps/server/src/repositories/conversationTimers.ts`, `apps/server/src/schedules/conversationTimerSweep.ts`, `apps/web/src/promptTimer.ts`, `apps/web/src/agentActivity.ts`, `apps/web/src/components/AgentActivityModal.tsx`

---

## Timer Origins

Every timer row in `conversation_timers` carries an `origin` column defining its provenance and lifecycle behaviour:

| Origin | Created by | Chip Badge | Cancelled by fresh prompt? | Cancelled by stop? |
|---|---|---|---|---|
| `operator` | Human operator in web UI | *(none / unlabelled)* | No (operator intent preserved) | No |
| `agent-resume` | Parent agent via `/spawn/:childId/message` with deferral (`fireInMs` / `fireAtMs`) | `agent` | Yes (`cancelPendingNonOperatorTimers`) | Yes |
| `auto-resume` | Usage-limit watcher on quota exhaustion | `auto` | Yes (`cancelPendingNonOperatorTimers`) | Yes |
| `agent-self` | Autonomous agent via `POST /conversations/:id/timers/agent` | `self` | Yes (`cancelPendingNonOperatorTimers`) | Yes |

When any new prompt is delivered into a conversation (operator message, child `subagent_notify`, parent message, every `handlePrompt`) or a parent stops it, all pending non-operator timers (`agent-resume`, `auto-resume`, `agent-self`) are cancelled via `cancelPendingNonOperatorTimers`. Existing `operator` timers are never cancelled by automated flows.

---

## Agent Self-Timers

Agent self-timers allow an agent to schedule a one-off future wake-up for its own conversation (for example, to retry an API call after a rate-limit window resets, or to wait for an external background process).

### Configuration (`TIERWYN_AGENT_SELF_TIMERS`)

The server configuration controls which conversations may set self-timers via the environment variable `TIERWYN_AGENT_SELF_TIMERS`:

| Mode | Behavior |
|---|---|
| `level0` *(default)* | Top-level conversations (roots: no parent, or direct child of `schedule_home`) may set self-timers. Subagent children receive `403` with guidance to ask their parent to defer them instead. |
| `all` | Both roots and subagent children may set self-timers. |
| `off` | Self-timers are disabled server-wide (`403` for all agents). |

Invalid or missing values fall back to `level0` with a warning log.

### API Contract: `POST /conversations/:id/timers/agent`

The endpoint is mounted before operator authentication middleware and requires a live session Bearer token.

- **Headers:** `Authorization: Bearer <session-token>`, `Content-Type: application/json`
- **Path:** `:id` must match the token's own conversation ID (cross-conversation requests return `403 cross_conversation`).
- **Body:**
  ```json
  {
    "text": "Check deploy status after cooldown window",
    "fireInMs": 1800000
  }
  ```
  *(or `"fireAtMs": 1791234567890`, exactly one is allowed).*

#### Restrictions & Guardrails

1. **Token Capability:** The bearer token must carry the `'schedule'` capability.
2. **Forbidden Fields:** Fields such as `profileId`, `role`, `prompt`, `effort`, `options`, `attachments`, `notifyParent`, or `origin` are strictly rejected with HTTP `400`. Agents cannot switch models or inject profiles upon wake.
3. **Profile Inheritance:** Self-timers automatically inherit the calling session's profile (or the conversation's last active profile), requiring it to be currently valid and enabled.
4. **Deferral Cap:** Deferral time is capped by `usageAutoResumeMaxDeferMs` (default 8 hours, minimum 1 minute floor).
5. **Prompt Framing:** Prompts are framed server-side as:
   ```
   ⏰ Self-timer you set at <ISO timestamp>:

   <text>
   ```
   This prevents ambiguity in the transcript and ensures the agent and operator know the message originated from a timer.
6. **Conflict Handling:** Only one non-operator timer may be pending per conversation. Attempting to schedule a second returns HTTP `409 Conflict`.
7. **Child No-Relay Rule:** If an agent self-timer is scheduled on a child conversation under `all` mode, its delivery in `conversationTimerSweep` runs in `interactionMode: 'bypass'` without upward relay (`relayUp = false`). The parent never requested the wake-up, so unsolicited "◀ result" messages are not bridged up.

---

## Timed Activity Tab

The **Timed** tab in the Agent Activity modal (`AgentActivityModal`) displays all pending conversation timers across the system, sorted soonest-first:

- **Data Endpoint:** `GET /timers/pending` (operator cookie authentication).
- **Cap:** Lists up to 200 pending timers (`PENDING_TIMERS_LIST_CAP = 200`). If more exist, `truncated: true` is returned.
- **Lightweight Summaries:** To prevent bandwidth bloat from large prompts or attachment blobs, prompts are preview-truncated at 500 characters (`substr(prompt, 1, 500)`) and attachments are omitted from the summary query.
- **Grouping:** Timers are grouped by project preserving soonest-first order.
- **Countdown & Polling:** The Timed tab polls `GET /timers/pending` every 5 seconds while open, and fetches immediately upon tab switch. Countdown labels tick locally in real time (displaying `"firing…"` when due). Clicking a row jumps directly to that conversation.
