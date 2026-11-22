# Conversation titles and descriptions

Spawn children used to be titled `↳ Role: first 60 characters of the prompt`, which hid the roster name in the sidebar. Conversations now keep a **short identity title** and a separate **one-line description**.

**Code:** `apps/server/src/conversationDescribe.ts`, `repositories/conversations.ts`, `apps/web/src/components/EditConversationModal.tsx`, `apps/web/src/components/Sidebar.tsx`

---

## What you see

| Surface | Title | Description |
|---|---|---|
| Sidebar (Projects + Schedules trees) | First line, ellipsized | Second line, quieter, only if set |
| Conversation header | `project: title` (unchanged) | Quiet subtitle under the title |
| Edit modal (sidebar ⋯ → Edit / Rename) | Editable | Single-line field, max 120 chars, plus Regenerate |
| Search | Matches title **or** description | |

Rows without a description stay one line (same height as before).

---

## How titles are chosen

| Kind | Title |
|---|---|
| Spawn child | `↳ <roster role or profile label>`: **not** the prompt |
| Root chat | Whatever you (or the create flow) set; not auto-renamed |
| Schedule run | Existing `⏱` / run title conventions |

The prompt’s first line is **not deleted**. It still appears on the parent’s `⇪ spawned →` marker in the transcript.

---

## How descriptions are generated

On the **first real user prompt** in a conversation (`handlePrompt`, after that prompt event is persisted):

1. If enhance LLM is configured (Settings → General → Prompt enhancer, same transport as ✨), generate a ≤12-word phrase naming **what the conversation is about** (`DEFAULT_DESCRIBE_PROMPT`). Prefer the opening request; do not write a task-list verb phrase.
2. Otherwise, or on failure / empty reply: first line of the prompt, clamped to 100 characters.
3. Result is sanitised (no newlines/backticks), clamped to 120 characters, stored with `description_source = 'auto'`.

Generation is **detached**. A slow or missing LLM never blocks or fails the turn. There is no error toast.

**Not generated when:**

- **Auto-generate conversation descriptions** is off (Settings → General → Prompt enhancer). Edit Conversation → Regenerate still works.
- The conversation already has a description, **or** `description_source` is set (including an operator **clear**, that leaves `description` empty and `source = 'user'`, so it will not be refilled).
- The first turn was only a `/command`; the first later real prompt still generates (slash-command events do not consume the window).
- Forks inherit the source conversation’s description; they do not regenerate.

---

## Operator edits

`PATCH /conversations/:id` with `{ "description": "…" }` or `null` sets `description_source = 'user'`, except a no-op clear of a never-described row (both fields already empty) which leaves source unset so first-prompt auto-describe can still run. The edit modal only sends `description` when that field actually changed. Clearing a real description is permanent: auto-generation will not write it back.

**Regenerate** (Edit Conversation → Regenerate) is an explicit click, not a silent rewrite. `POST /conversations/:id/describe` builds a short labelled bundle from at most three **substantive** user prompts (opening request first, latest if different, and the turn immediately before latest). Process/meta turns (copy-paste, “prompt for a new conversation”, thin `ok`/`continue`) are skipped so a late “write me a prompt” does not become the subtitle. A final assistant message is included only when every selected user excerpt is thin. Each excerpt is head-truncated (fences become `[code]`; dumps 200 chars, prose 400; whole bundle ≤ 2500; First is never shortened below its excerpt). The same enhance `clean()` + `DEFAULT_DESCRIBE_PROMPT` path writes `description_source = 'auto'` unconditionally; the click is consent, even if the previous source was `user`. If enhance is off or `clean()` fails, the fallback is the first line of the **opening** substantive prompt. Zero eligible prompts → `400 { error: 'no prompt text to describe' }`. The route may await (30s timeout). The modal stays open and patches the field plus sidebar/header via `onSaved`.

`GET /conversations/:id` returns the row (used for `?c=` notification deep links).

Live updates: when a description is written, a `conversation_updated` frame carries `description` (and optionally `title`) so the sidebar and header patch without a reload. Absence of those fields means “unchanged”.

---

## Schema

Migration **104**: `conversations.description` and `conversations.description_source` (`'auto' | 'user' | NULL`). No backfill of existing chats.

---

See also: [browser notifications](browser-notifications.md) (notification bodies append `· <description>` / `· <project name>`).
