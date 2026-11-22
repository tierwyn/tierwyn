# Operator rules

Per-project and per-conversation **instructions** authored only by the operator. Injected into spawn and schedule preambles so every harness sees the same standing rules.

Rules are not project memory. Memory is reference notes agents may edit. Rules are instructions; agents cannot write them.

Named **presets** let the operator write a block once and attach an ordered stack to any project or conversation. The free-form `rules` field is still the per-layer custom block on top of that stack.

## Where they live

| Layer | Stored in | Scope |
|---|---|---|
| Presets | `rule_presets` (global when `project_id` is NULL) | Library entries; applied only when selected |
| Project stack | `projects.rule_preset_ids` JSON `string[]` | Ordered presets for every conversation in the project |
| Project custom | `projects.rules` | Every preamble-bearing session in the project |
| Conversation stack | `conversations.rule_preset_ids` | Ordered presets for that conversation and descendants |
| Conversation custom | `conversations.rules` | That conversation and all of its descendants |

Edited in the UI: Sidebar project or conversation menu → **Rules…**. The modal has a preset stack (↑/↓/×), custom textarea, and a live preview of the stacked result with level headers. The **Rules** chip lights when any custom text or preset applies.

The add/edit preset modal can attach a **global** preset to one or more projects (folder-level `rule_preset_ids`) via a multi-select, and for **project-specific** presets can choose folder-level apply vs catalogue-only (attach later to individual conversations). Per-layer cap is still 8.

Empty means nothing is injected. There is no global toggle and no seeded presets.

## Inheritance

`project presets → project custom → root ancestor presets → custom → … → self presets → self custom`. A grandchild of an orchestrator still follows the orchestrator's rules. Children cannot opt out.

On conflict: more specific (later in that chain) wins. The operator's current message wins over all rules. Rules never grant permissions the token lacks.

The same preset selected at two layers is injected **once**, at the first (more general) position. Unknown or out-of-scope ids (conversation moved projects) are skipped.

## Size

- Per custom field / per preset content: **4 KiB** UTF-8 (`400` at save).
- Per layer: at most **8** presets.
- Total rendered block texts: **16 KiB**. Over the cap, the most-specific suffix is kept and the agent sees `_(N earlier rule blocks omitted, …)_`. `GET …/rules` returns `{ omitted: N }`.

Depth guard is **64** (cycles still break via a seen-set).

## When injected

Full block (`## Operator rules`) on a new session, a non-native resume/handoff, or a rules/preset edit (fingerprint `rules: <hash>` of **block texts** after truncation). Renaming a preset does not change the hash. A native resume with an unchanged fingerprint gets one line: *Operator rules given earlier still apply.*

Hold-open adapters (`antigravity`, `deepseek`) that adopt a parked session receive an adapter-only prefix when the hash changed: *Operator rules (updated, these replace any earlier operator rules)*. The operator transcript still shows the original prompt.

The fingerprint key is omitted when no rules apply, so a deploy does not invalidate existing hashes.

## Excluded

- The **Remote Agents** system project (`projects.system`)
- **Grok Bot** and other bare-prompt adapters (`ent.kind === 'none'`, no preamble)

## Auth

Writable only via operator cookie-auth routes (`PATCH /projects/:id`, `PATCH /conversations/:id`, `/rule-presets`). Spawn/Bearer tokens get `401`. See [SECURITY.md](../../SECURITY.md).
