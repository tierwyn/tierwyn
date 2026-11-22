# Compaction and Resume Plans

Before every turn, Tierwyn decides how the agent gets the conversation's prior
context: resume the CLI's own session, replay a transcript, prime with an LLM
summary, or start clean. That decision is a `ResumePlan`. This page is the
reference for how the plan is chosen, which settings move it, and what happens
when a step fails. For the scenario walkthroughs (A → B → A, model switch,
fork, duplicate, rewind, `/btw`, the switch-choice modal) see
[handoffs.md](./handoffs.md); they are not repeated here.

| | |
|---|---|
| **Decision** | `buildResumePlan()`: `apps/server/src/compaction/compactor.ts` |
| **Summariser** | `compact()` (same file) + `makeAdapterRunner()`: `compaction/runner.ts` |
| **Transcript rendering** | `buildTranscript()`: `compaction/transcript.ts` |
| **Token estimate** | `estimateTokens()`: `compaction/tokenizer.ts` |
| **Argv cap** | `capForArgvSpawn()`: `compaction/primingCap.ts` |
| **Image re-attach** | `collectAllHandoffAttachments()`: `compaction/handoffAttachments.ts` |
| **Callers** | `SessionManager.handlePrompt` / `handleCommand` (`sessionManager.ts`), `/btw` (`routes/btw.ts`), `GET /conversations/:id/resume-plan` (`index.ts`) |
| **Types** | `ResumePlan`, `ResumeMode`, `CompactionSettings`, `HandoffOverride`: `packages/shared/src/domain.ts` |

## The plan

```ts
interface ResumePlan {
  mode: 'native' | 'compacted' | 'transcript' | 'fresh';
  nativeSessionId?: string;      // native only
  primingPrompt?: string;        // compacted / transcript
  primingAttachments?: { base64: string; mediaType: string; name?: string }[];
}
```

`SessionManager` passes `nativeSessionId` to `adapter.start()` only when
`mode === 'native'`, and prepends `primingPrompt` to the first prompt of the new
session. Priming attachments are forwarded only when the target profile accepts
images. Every non-native plan is recorded in the `handoffs` table by
`recordHandoff()` (`sessionManager.ts`).

## Decision rules

`buildResumePlan()` applies these in order. The first match wins.

1. **Override `fresh`** → `fresh`. No native resume, no priming.
2. **Native.** Look up the conversation's **globally** most recent session,
   excluding the session row just created for this turn (`excludeId`). Resume
   natively when all hold:
   - that session belongs to the target adapter (`agentId`);
   - it has a `nativeSessionId` and `adapter.isNativeSessionAvailable()` says
     it still exists;
   - there is no `summary`/`transcript` override, **or** compaction is
     disabled.

   Why globally most recent: after A → B → A, A's old session is resumable, but
   resuming it would silently drop every turn B produced. Requiring the last
   session overall to be A's sends that case to compaction instead. Why an
   override is ignored when compaction is off: honouring it would skip native
   resume and then have nothing to prime with, wiping context.
3. **No prior session** → `fresh`.
4. **Compaction disabled** (`compactionEnabled: false`) → `fresh`. Exception:
   `/btw` observer framing still gets a transcript plan, because a side question
   needs context.
5. **Effective mode** = the override if present, else `handoffMode`
   (`'transcript'` → transcript; `'summary'` or `'prompt'` → summary). The
   `'prompt'` setting only affects the web client, which asks the operator and
   sends the choice as an override.
6. **Transcript mode.** Render the transcript with full tool I/O, capped at
   `maxTranscriptHandoffTokens`. Empty → `fresh`. If its token estimate is
   `≤ targetContextWindow × transcriptContextSafetyFactor`, the plan is
   `transcript`. Otherwise fall through to the summary path.
7. **Silent summary shortcut.** Only when the summary mode came from the setting
   (no explicit override): render the transcript with tool I/O compacted. Empty
   → `fresh`. If it is `≤ outputTokenCap` tokens, send it as a `transcript`
   plan with no summariser call. A summary can't be meaningfully shorter than
   that, so this saves a full LLM round trip before the agent starts. An
   explicit "Summary" choice always runs the summariser.
8. **Summarise** with `compact()` → `compacted`.
9. **Summariser failed or returned empty** → `transcript` built with compacted
   tool I/O, or `fresh` if that is empty too.

The target context window comes from the target adapter's live `listModels()`
(`getTargetContextWindow`). Any failure, or a model with no advertised window,
returns `Infinity`, so in transcript mode the budget check always passes for
those models. The persisted `agent_models.context_window` is deliberately not
used here (see the comment at the `buildResumePlan` call in `sessionManager.ts`).

## Settings

Settings → Compaction (`GET|POST /settings/compaction`). Defaults are
`COMPACTION_DEFAULTS` in `apps/server/src/db/seed.ts`.

| Key | Default | Used for |
|---|---|---|
| `compactionEnabled` | `true` | Off → every non-native plan is `fresh`. Does not disable native resume. |
| `handoffMode` | `'summary'` | `'summary'` \| `'transcript'` \| `'prompt'` (rule 5) |
| `preferredProfileId` | `claude-code:sonnet-4.6` | Summariser profile. Its adapter's `estimateTokenCount`, if it has one, also replaces the tokenizer for budget checks in `SessionManager`. |
| `fallbackProfileId` | `claude-code:opus-4.8` | Summariser retry when the first call throws |
| `maxCompactorContextTokens` | `100000` | Cap on the transcript fed to the summariser |
| `outputTokenCap` | `4000` | Summary length limit (stated in the prompt and enforced after it) and the threshold for the silent shortcut |
| `summaryVerbosity` | `'medium'` | `low` / `medium` / `high` hint in the summariser prompt |
| `maxTranscriptHandoffTokens` | `150000` | Cap on transcript plans and fallbacks |
| `transcriptContextSafetyFactor` | `0.5` | Fraction of the target context window a transcript plan may fill |

Token counts are estimates: `cl100k_base` via `gpt-tokenizer`, falling back to
`chars / 4` if encoding throws. They are not the target model's own tokenizer.

## Transcript rendering

`buildTranscript()` renders events as labelled lines (`USER:`, `ASSISTANT:`,
`TOOL(name):`, `TOOL_RESULT:`, `FILE …:`, `ERROR:`). Cross-agent prompts get
their own labels: `SUBAGENT (role)`, `PEER (role)`, `PARENT (role)`, so a
summariser doesn't treat a peer or child as the task-giver. Operator `!` shell
commands render as `OPERATOR SHELL`, never as an agent tool call.

- **Truncation keeps the newest lines.** Lines are taken from the end until the
  token budget is reached, and `[earlier history truncated]` is prepended.
- **`compactToolIo`** (summary path, shortcut, fallbacks): `tool_call` is
  reduced to its most identifying argument (`file_path`, `command`, …), and
  `tool_result` bodies over 500 chars keep only their head and tail. The
  `transcript` mode leaves tool I/O intact.
- Images are not inlined. Up to 20 deduplicated images from earlier user
  prompts, plus the current turn's, are returned as `primingAttachments`.

## The summariser

`compact()` keeps a **rolling summary** in the `summaries` table, keyed to the
last event it covers:

- With a prior summary, only the events after its anchor are summarised,
  folded together with the prior text. No new events → the prior summary is
  returned with no LLM call.
- Every 5th compaction (`FULL_RESUMMARY_EVERY`) rebuilds from raw events to
  limit drift from summarising a summary. If the anchor event was pruned, the
  full transcript is used.
- Transcript and prior-summary text is defanged so that `--- END ---`-style
  markers inside it can't close the data region early.
- Output over `outputTokenCap` is cut to `outputTokenCap × 4` chars.
- `skipPersist` (used by `/btw`) computes a summary without writing a row, so a
  side question never moves the rolling anchor.

`makeAdapterRunner()` runs the summariser profile **on the hub**, even for
remote-host projects, so the summariser's agent CLI must be installed on the
hub. It always runs in `bypass` interaction mode, because a summariser waiting
on a permission prompt would stall the user's turn.

- **One-shot path:** `claude-code`, `pi`, `copilot` with
  `oneShot` mode `none` (tools disabled by CLI flag), when the prompt is
  ≤ 120,000 bytes (`ONESHOT_PROMPT_MAX_BYTES`, under Linux's 128 KiB per-argv
  limit).
- **Session path:** everything else. Starts a `textOnly` session and resolves on
  the first `status: done`, not on `end`, because adapters that keep their
  subprocess alive between turns never emit `end` here. The adapter is stopped
  on every exit path.
- **Timeout:** 120 s per call, then reject. With the fallback profile, the worst
  case before a turn starts is about 2 × 120 s, then the transcript fallback.
- **`toolFreeOnly`** (`/btw` priming): the session path is refused for adapters
  other than `claude-code`, which honours `textOnly`. The throw
  sends the plan to the transcript fallback.

## Priming prompt

`buildPrimingPrompt()` assembles:
intro line (resume or observer) → image note → rules block → body wrapped by
`frameHandoffContext()` (`spawn/prose.ts`).

- The **resume rules** tell the agent it is mid-conversation and must not
  explore the repo to "get oriented". `/btw` uses `BTW_OBSERVER_RULES` instead:
  it is an observer and must not continue the task.
- The body is capped **before** wrapping (`capForArgvSpawn`, default 400,000
  bytes, keeping the tail). This way, argv truncation inside an adapter can't
  cut off the untrusted-content wrapper.
- `/btw` passes `inflightId` instead of `excludeId`. The in-flight session's
  events are kept up to its last completed boundary (`tool_result`,
  `file_change`, or a final message), or dropped if it has none.

Bare-prompt adapters (`BARE_PROMPT_ADAPTERS`, e.g. `grok-bot`) only receive
priming under the conditions described in [handoffs.md](./handoffs.md).

## `GET /conversations/:id/resume-plan`

Cookie-authenticated. Returns `{ plan }` for the conversation's **last** session
agent as the target, with no override and no excluded session.

**Not a dry run.** On the `compacted` path it calls the summariser and writes a
`summaries` row, like a real handoff. The response can include the full priming
text and base64 image attachments. The web client does not call it. Don't
wire it up as a cheap preview without adding a no-persist flag first.

## Failure and fallback summary

| Failure | Result |
|---|---|
| Native session file gone / adapter exposes no ids | Not native → summary or transcript |
| Target context window unknown | `Infinity` → transcript mode never falls back on size |
| Transcript over budget (transcript mode) | Summary path |
| Preferred summariser throws or times out | `fallbackProfileId` (also used when `profileOverride` was given) |
| Fallback throws too, or summary is empty | Transcript with compacted tool I/O. Includes a fresh install with no Claude Code CLI: both defaults are `claude-code` profiles, so both calls fail and this transcript path is the recovery. The summariser never auto-picks an arbitrary enabled catalogue profile (most adapters are not tool-free summariser-capable). |
| Transcript empty | `fresh` |
| Priming body too large for argv | Oldest part dropped, `[earlier handoff context truncated …]` marker |
| Stop pressed while the plan is being built | Adapter never spawns |
