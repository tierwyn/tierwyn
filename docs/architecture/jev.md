# Jev (TypeSafe System One)

Jev is TypeSafe's decision model (`POST /v1/systemone`, pinned model). Tierwyn calls it through one fail-closed wrapper, `apps/server/src/decide.ts`. Off by default, server-side only.

## Consumers

| Consumer | Label | Runs | Gate |
|---|---|---|---|
| Notification filter | `notify` | Before a completion / inbound / run-ended notification | `enabled` + key |
| Conversation auto-tagging | `autotag` | Detached, once per conversation, on a `done` turn | `enabled` + key + `autoTagEnabled` |
| Settings → Test probe | `test` | On demand | key only (ignores `enabled`) |

`decide()` requires a `consumer`; every call and failure line from `decide.ts` carries it (`[decide] consumer=autotag model=… in=… ms=…`, failures `[decide] consumer=… failed: <reason>`). The notifier's own `[decide] verdict …` tuning line is notify-only and has no `consumer=`. The label is a closed union, so logs never carry free text. Logs never contain state, question text, tags, or the key.

## Shared settings

The `settings` row `decision` holds `enabled` (Jev master switch), the write-only `apiKey`, `model`, `baseUrl`, `autoTagEnabled`, and `memoryCheckEnabled`. There is one key for all consumers. `GET /settings/decision` returns `apiKeySet`, never the key. Cookie-auth only. The notification filter keys off `enabled` alone; see [browser-notifications.md](browser-notifications.md#interrupt-filter-jev) for its thresholds.

## Auto-tagging

Once per root chat conversation, Tierwyn asks Jev which catalogue tags fit and merges them into the conversation's tags. Settings → General → *Auto-tag conversations*.

**Trigger.** `autoTagConversationIfDue` in `apps/server/src/autoTags.ts`, called detached from `sessionManager.ts` on every prompt-turn `done` status (never delays or fails a turn). Gates, cheapest first:

1. `enabled && apiKey && autoTagEnabled`.
2. Not yet attempted (`conversations.auto_tagged_at IS NULL`), a non-empty description, and a root chat (no parent, no schedule job, `kind = 'chat'`). Spawn children and schedule runs are never tagged.
3. At least `AUTOTAG_MIN_PROMPTS` (3) real user prompts (commands and non-user sources such as `subagent_notify` are not counted). Not marked while short, so later turns retry.
4. The mark is claimed with a compare-and-set before the call, so racing `done` events make one request.

**What is sent.** One batched call: state `{ title (≤120), description (≤200) }` and one `noul` question per enabled catalogue tag (up to 24 built-in + 16 custom = 40 questions, one billed call). No transcript and no message text. Question keys are `t0…tN` by catalogue position; tag text is never used as a key. Contrast the notification filter, which also sends a scrubbed excerpt (≤1500 chars) of the last assistant reply.

**Result.** Tags with probability ≥ 0.7 (`AUTOTAG_THRESHOLD`), at most 3 (`AUTOTAG_MAX_APPLIED`), highest first, are merged additively after the operator's tags (case-insensitive dedupe, capped at `MAX_TAGS`). Tags are only ever added. The merge re-reads the tags in one synchronous transaction after the await, so a concurrent PATCH is never clobbered. A `conversation_updated { tags }` frame is broadcast only if the list changed. Log: `[autotag] conversation=<id> asked=<n> applied=<m>` (counts only).

**Once-only semantics.** A non-null verdict keeps the mark, including one that yields zero tags. A `null` verdict (error, timeout, key revoked) releases the mark so the next `done` retries; the ceiling is one failed 5 s call (`AUTOTAG_TIMEOUT_MS`) per turn while TypeSafe is down. If the enabled catalogue is empty or the conversation already has `MAX_TAGS` tags, it is marked without a call (`skipped=no-catalogue|full`), so enabling tags later does not back-fill. Existing conversations qualify on their next `done`; there is no back-fill job and no re-run button. Remote Agents (Grok Bot) containers are root chats and are tagged once like any other.

## Tag catalogue

Built-ins (24, in `packages/shared/src/conversationTagCatalogue.ts`) each carry a hint that becomes the question's "true" criterion. Custom tags (≤ 16) and disabled built-ins live in the `settings` row `conversation_tag_catalogue` as `{ custom: [{tag, hint}], disabledBuiltins: string[] }`. A missing or corrupt row reads as built-ins only. Custom tags follow the normal tag rules plus a hint (≤ 120 chars); a tag equal to a built-in (case-insensitive) or a duplicate is rejected.

Routes (cookie-only, registered with the Jev routes after `requireAuth`): `GET /settings/tag-catalogue` → `{ builtins, catalogue }`; `POST /settings/tag-catalogue` takes the whole `{ custom, disabledBuiltins }` document, 400 `{ error }` on invalid input.

## Usage & cost

Every System One call is recorded in the `decision_usage` table; one row per `callSystemOne` invocation, so 429 retries collapse into the final result. Rows are content-free: `ts`, `consumer` (`notify` | `autotag` | `test` | `memory`), nullable `conversation_id` (no foreign key, billing history survives conversation deletion), `model`, `input_tokens` / `output_tokens` (NULL when the response lacked `usage` or the call failed), `latency_ms`, and `outcome` (`ok` or the safe reason `callSystemOne` throws: `timeout`, `network error`, `bad response`, `http NNN`). Failed calls are recorded too, which gives rate-limit visibility (`http 429 ×3`). A `200` that fails validation still records its parsed token counts because TypeSafe billed it.

### Consumer: `memory` (background memory check)

When `memoryCheckEnabled` is turned on (Settings → General → Jev), saved memories are classified by Jev in the background:
- Verdict checks for `addressed_to_agents`, `task_chatter`, or `secret_like` content.
- A suspicious verdict sets `status = 'flagged'`, hiding the memory from prompt recall and agent search until reviewed and approved by the operator in the Memories modal.
- Fails open: if Jev times out or encounters an error, the memory remains active.

Recording is fail-closed in the other direction: it is wrapped in its own try/catch (`decideDeps.record`, wired to `insertDecisionUsage` at boot), so a DB error never changes Jev's answer. Non-integer / negative / non-numeric token values are stored as NULL.

**Pricing:** $0.042 per 1M input tokens, output free (`JEV_INPUT_USD_PER_MTOK` in `repositories/decisionUsage.ts`). Cost is computed at read time, never stored, so changing the constant re-prices history. At ~200–400 input tokens per call this is fractions of a cent per day.

**Where it shows:** a built-in (non-plugin) **Jev · TypeSafe System One** card in Settings → Agent Usage → Providers, fed by `GET /settings/agent-usage` (fixed last-30-days window): totals, per-consumer calls / tokens / cost, failures by reason, and a count of calls with no usage figures (failed calls included, so it is an upper bound on undercounting). The card is appended in that route only; it never appears in the agent-facing `/agent/usage`.

**Retention:** rows older than 90 days are pruned in the nightly retention `afterPass`.

## Constants

`AUTOTAG_THRESHOLD = 0.7`, `AUTOTAG_MAX_APPLIED = 3`, `AUTOTAG_MIN_PROMPTS = 3`, `AUTOTAG_TIMEOUT_MS = 5000` in `autoTags.ts`; `INTERRUPT_CONFIDENCE_FLOOR = 0.6` in `notifications/notifier.ts`. Constants, no UI.
