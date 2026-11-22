# Agent Adapters: Architecture, Capabilities & MCP Reference

The operator and developer reference for how Tierwyn integrates and runs local coding agents: process model, resume, steering, permissions, per-message prompt options, MCP/web capability, and failure modes.

> [!NOTE]
> Source of truth is code, not this page. The capability sets live in `packages/shared/src/profiles.ts` (`PERMISSION_CAPABLE_ADAPTERS`, `LIVE_INJECT_ADAPTERS`, `SOFT_CANCEL_ADAPTERS`, `HARD_STOP_ADAPTERS`, `HOLD_OPEN_FOLLOWUP_ADAPTERS`, `IMAGE_CAPABLE_ADAPTERS`, `SLASH_COMMAND_CAPABLE_ADAPTERS`, `BARE_PROMPT_ADAPTERS`) and per-message options in `packages/shared/src/promptOptions.ts` (`PROMPT_OPTIONS_BY_ADAPTER`). If this page and those sets disagree, the sets win.

---

## 1. Architectural overview

- **No vendor API keys in Tierwyn.** Every model call goes through the agent's own locally installed and authenticated CLI/SDK. (The Direct LLM sidecar profiles are a separate, opt-in feature.)
- **Local child processes.** Agents run under Tierwyn's UID with an env built by `buildChildEnv()` (`apps/server/src/childEnv.ts`). It always deletes `PORT`, `HOST`, `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, `TIERWYN_PLUGIN_VAULT_KEY`, plus every plugin-declared credential key. `TIERWYN_LISTEN_PORT` is deliberately **kept**; the delegation/schedule preamble curls need it.
- **Normalised events.** Every wire format (SDK message objects, stream-json, JSON-RPC/ACP notifications, JSONL, CDP replica reads) is mapped to `NormalisedEvent` (`packages/shared/src/events.ts`) and fanned out by `SessionHub`.
- **Contract.** Adapters implement `AgentAdapter` from `packages/shared/src/adapter.ts` and are registered in `apps/server/src/index.ts`. The registry holds **16** agent types: 15 CLI types in `apps/server/src/adapters/registerAll.ts` (14 distinct implementations; `kilocode` is `OpenCodeAdapter` with `bin: 'kilo'`, `~/.config/kilo` and `~/.local/share/kilo/kilo.db`), plus the Grok Bot desktop app (`grok-bot`) registered separately in `index.ts`.

---

## 2. Execution models

| Model | Adapters | Process lifetime | Transport |
|---|---|---|---|
| **A. ACP over stdio** | `grok-build`, `hermes`, `kiro`, `qwen`, `kimi` | One process per session, reused across turns | JSON-RPC (Agent Client Protocol) |
| **B. Other long-lived JSON-RPC** | `codex`, `pi`, `deepseek` | One process per session, reused across turns | Vendor JSON-RPC |
| **C. Stream-json stdin, held open** | `claude-code` (SDK), `antigravity` | One process per session; each turn is a new stdin line | NDJSON in/out |
| **D. Spawn per turn** | `cursor`, `copilot`, `opencode`, `kilocode`, `openclaw` | Fresh process per message, exits at end of turn | stdout JSON / JSONL |
| **E. CDP attach** | `grok-bot` | Tierwyn never launches it; attaches to a running app | Chrome DevTools Protocol |

> [!IMPORTANT]
> "Turn done" and "session done" are different. In models A–C a `status: done` ends the **turn**; the adapter's `'end'` event fires only when the child actually exits or `stop()` runs. Codex is explicit about this: `turn/completed` never emits `'end'`.

### A. ACP adapters

| Adapter | Spawn argv | Notes |
|---|---|---|
| `grok-build` | `grok [--sandbox <profile>] agent stdio` | `--sandbox` is a top-level flag and must precede `agent`. Does **not** send the ACP `initialized` notification (grok logs a decode error for it). Effort/yolo travel in `_meta` on `session/new`/`session/load`/`session/set_model`. |
| `hermes` | `hermes [--yolo] acp` | `--yolo` is a top-level flag, not an `acp` sub-flag. |
| `kiro` | `kiro-cli acp [--effort …] [--trust-all-tools]` | Spawned `detached`. Changing effort/trust respawns and resumes by native id. |
| `qwen` | `qwen --acp [-s]` | `-s` = container sandbox (see §7). |
| `kimi` | `kimi acp` | Spawned `detached`. |

Handshake: `initialize` → `session/new` (fresh) or `session/load` (resume), both with `{ cwd, mcpServers: [] }` → `session/set_model` → `session/prompt`. Output arrives as `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `available_commands_update`, …). Tool gates arrive as the server→client request `session/request_permission`.

- **Resume:** `session/load` replays history as `session/update` notifications. Adapters suppress those replays until `sendPrompt()` sets `_accepting`, so the old transcript is not re-emitted into Tierwyn. `session/load` leaves the model unset on hermes/kiro/kimi, so every adapter follows it with `session/set_model`.
- **Stop:** soft. `interruptTurn()` sends `session/cancel` and the ACP process survives (`SOFT_CANCEL_ADAPTERS`).
- **Kiro gotcha:** `kiro-cli` deserialises `mcpServers` as a `Vec`, not a map. Sending `{}` breaks `session/new`, so it must be `[]`.

### B. Long-lived JSON-RPC (non-ACP)

- **`codex`**: `codex app-server [effort args]`. One thread per conversation (`thread/start`, then `thread/resume`). Each prompt is one `turn/start`. A mid-turn steer is `turn/steer` with `expectedTurnId`. When `interactionMode !== 'bypass'`, approvals arrive as server→client RPCs. The sandbox policy binds at thread creation, so changing it starts a **new** Codex thread.
- **`pi`**: `pi --mode rpc …`. A steer is an RPC prompt with `streamingBehavior: 'steer'`: pi delivers it after the current tool calls and before the next LLM call. Sessions live under `~/.pi/agent/sessions`. Changing thinking/tools options restarts the process and resumes by session path.
- **`deepseek`**: `dsh --profile sdk`. `reasoningEffort` binds at `initialize`, so changing it respawns. Conversation-level effort accepts `low`, `high`, `max` (live-verified against `deepseek-official/deepseek-chat`; dsh rejects `medium` and `xhigh`). Native `subagent.started` / `subagent.finished` notifications map to path-A `helper` events (`running` → `completed` / `stopped` / `failed`); there is no `stopHelper`. Held open between turns (`HOLD_OPEN_FOLLOWUP_ADAPTERS`) because dsh treats a reused native id as an on-disk collision. Sessions are persisted in `.dsh/sessions/<slug>/<sessionId>` and resumed via `session/resume` on respawn. Reasoning chain-of-thought (`reasoning-delta` chunks) are dropped to avoid flooding the transcript. Slash commands come from `~/.dsh/skills` and `~/.agents/skills` (or per-project `.dsh/skills` / `.agents/skills`). Install: `npm i -g @deepseek-ai/dsh`.
  - **Multi-provider (`pi-ai`) models (`z.ai/<model>`, `openrouter/<model>`, `openai/<model>`, etc.):** Tierwyn maps `z.ai/*` profiles to `dsh` provider `zai` (lowercasing the model id) and forwards `ZAI_API_KEY`. For any non-`deepseek-official` provider not already configured in `~/.dsh/profiles/sdk/cordis.patch.yml`, `DeepSeekAdapter` automatically passes a `--patch` overlay (`~/.dsh/.tierwyn-patches/pi-ai-<provider>.yml`) enabling that provider on `id: llm-pi-ai` with ambient env-key discovery, so operators only need to set the provider's API key (e.g. `ZAI_API_KEY`) in **Settings → Agents → DeepSeek → Encrypted environment** (works locally, in `bwrap`, and on remote nodes). To override `baseURL` (e.g. standard Z.AI API `https://api.z.ai/api/paas/v4` or China `https://open.bigmodel.cn/api/coding/paas/v4` instead of the default Coding Plan endpoint), configure the provider in `~/.dsh/profiles/sdk/cordis.patch.yml` and Tierwyn will defer to it.

### C. Stream-json, held open

- **`claude-code`**: `@anthropic-ai/claude-agent-sdk` `query()` with a streaming prompt iterator. Resume is SDK `resume: <nativeSessionId>`. `bypass` maps to `permissionMode: 'bypassPermissions'`; `prompt`/`questions` map to `'default'` plus a `canUseTool` callback. That callback also routes `AskUserQuestion` into Tierwyn's question card. A per-turn `permissionMode` override replaces that baseline; when it (or `restricted`) is active in a `bypass` conversation, `canUseTool` is attached in prompt behaviour so gated tools raise permission cards instead of being silently denied. The `restricted` / `safeMode` prompt options go through the SDK `extraArgs` (`--restricted`, `--safe-mode`); `restricted` never runs under `bypassPermissions` (the CLI refuses it) and uses `acceptEdits` when nothing else chose a mode. The adapter drops to the **CLI fallback** only when the SDK cannot start (spawn/ENOENT), and only for `bypass` conversations (and tool-less `textOnly` sessions); otherwise it surfaces a clear error, because the fallback cannot gate tool permissions. Its argv comes from the pure `buildClaudeCliArgs()`: `--dangerously-skip-permissions` is added only when the conversation is bypass, no `permissionMode` override is set and `restricted` is off (the flag overrides `--permission-mode`, and conflicts with `--restricted`); otherwise `--permission-mode` is passed alone. A non-zero exit reports the last stderr line (`claude exited with code N: <line>`).
- **`antigravity`**: `agy --input-format stream-json --output-format stream-json [--add-dir=<cwd>] [--project <id>] --print-timeout 30m [--model …] [--effort …] [--mode …] [--sandbox] [--disable-slash-commands] [--json-schema …] [--conversation <uuid>] --print=`. Context % is taken from the last `agent_response` step snapshot (`input + cache_read`), not from `result.usage`, which is cumulative tool-loop turnover. See [agent-usage.md](agent-usage.md#probe-sources-built-in).
  - `--print=` (empty) is mandatory. A bare `--print` or a non-empty one kills the process.
  - Flag order matters: `--add-dir=`/`--project` must come before `--model`.
  - On resume (`--conversation`), agy ignores `--add-dir`/`--project` and reuses the original project root.
  - Tierwyn deliberately does **not** pass `--dangerously-skip-permissions`, because the token leaks into Gemini's system prompt and causes hallucinations. Set `"toolPermission": "always-proceed"` in agy's `settings.json` instead.
  - Held open between turns (`HOLD_OPEN_FOLLOWUP_ADAPTERS`) so a follow-up does not cold-respawn. Native conversations live at `~/.gemini/antigravity-cli/conversations/<uuid>.db`.

### D. Spawn per turn

| Adapter | Per-turn argv (abridged) | Resume |
|---|---|---|
| `cursor` | `cursor-agent -p --output-format stream-json --force --stream-partial-output --trust --approve-mcps [--mode] [--sandbox] [--auto-review] [--model] [--image <p>] [--add-dir <d>] <text>` | `--resume <chatId>` |
| `copilot` | `copilot -p … --output-format json --stream on -C <cwd> [--model] [--effort] (--allow-all-tools \| read-only tool list) --deny-tool … --no-ask-user --no-remote-export --no-auto-update --disable-builtin-mcps --log-level none [--attachment <p>]` | turn 1 `--session-id <uuid>`, later `--resume=<uuid>` |
| `opencode` / `kilocode` | `opencode run --format json [--variant] [--thinking] [--pure] [--agent] …` (`kilo` for KiloCode) | `--session <id>` |
| `openclaw` | `openclaw agent --local --json --session-id <id> -m <text> [--thinking] [--timeout]` | same `--session-id` every turn |

- **Prompt options** bind only to the process they are passed to. For spawn-per-turn adapters that makes them naturally one-turn-only.
- **Stop** is a hard kill (`HARD_STOP_ADAPTERS`). "Interrupt & Send" means kill, then reinject the text as the end-drain follow-up.
- **Copilot deny list** (`DENY_TOOLS`, always on, and it beats `--allow-all-tools`): `shell(git push)`, `shell(gh:*)`, `github-mcp-server`, `write(.env)`.
- **Copilot authentication:** On desktop hosts, Copilot reads credentials from the local desktop keyring. Inside a sandbox (`bwrap`) or on headless remote hosts without a desktop keyring, authentication is supplied via `COPILOT_GITHUB_TOKEN` in the encrypted agent vault (Settings → Agents → Copilot → Encrypted environment). The CLI requires a GitHub CLI OAuth token (`gh auth token`, starting with `gho_`), as Copilot's model endpoints reject raw Personal Access Tokens (`github_pat_...`). Tierwyn automatically supplies the token as both `COPILOT_GITHUB_TOKEN` and `GH_TOKEN`.

### E. CDP attach (`grok-bot`)

This adapter attaches to the **Grok Bot desktop app** (Electron, `/opt/Grok Bot/grok-bot`) over loopback CDP (`TIERWYN_GROKBOT_CDP_PORT`, default `9333`). It is not a browser tab. A lifecycle supervisor may start the app (`systemctl --user start` → `systemd-run` → detached spawn). `TIERWYN_GROKBOT_AUTOSTART=0` kills launching, including manual Start. If the port is unreachable the adapter emits `error` and then `'end'`.

- **Input:** it types into the composer with `Input.insertText` + Enter.
- **Output:** it polls the `clientPersistence` replicas. A turn is settled by the replica plus the per-Bot busy mark `[data-grok-state]`.
- **Prompt text:** `BARE_PROMPT_ADAPTERS`; no spawn/schedule preamble and no Bearer. Handoff/resume priming (plus Hostname + conversation-CWD note) applies when Settings → Grok Bot → **Allow in project chats** is on, or the conversation is under Grok Bots. With that flag off, grok-bot is hidden from other projects’ pickers and rejected server-side outside Remote Agents. The picker (and spawn roster) also hide grok-bot when `grokBotUsable` is false (only `running` / `starting`; a closed app stays hidden even if autostart could launch). Nested conversations (`parent_conversation_id` set, spawn children, manual nests, schedule-home children) are never inbound-watcher targets.

Full detail is in `CLAUDE.md` and [`grok-bot-watcher.md`](grok-bot-watcher.md).

---

## 3. Interaction (permission) modes

The global setting lives in `CompactionSettings.interactionMode` and is passed to each adapter at construction.

| Mode | Meaning | Who can run it |
|---|---|---|
| `bypass` (default) | No gates. Every tool auto-runs. | All adapters |
| `questions` | Tool gates bypassed; only question prompts (`AskUserQuestion`-style) surface as `interaction_request` | All adapters; bypass-only ones simply ignore it |
| `prompt` | Every tool gate surfaces as an `interaction_request` card | **Permission-capable only** |

**Permission-capable** adapters: `claude-code` (`canUseTool`), `codex` (approval RPC), `hermes` / `grok-build` / `kiro` / `qwen` / `kimi` (ACP `session/request_permission`), and `grok-bot` (Allow once / Deny / Always allow cards; never auto-approved).

**Bypass-only** adapters: `pi`, `opencode`, `kilocode`, `cursor`, `antigravity`, `openclaw`, `copilot`, `deepseek`. In `prompt` mode they are greyed out in the picker, rejected in `handlePrompt` before a session is created, omitted from the delegation roster, and rejected by `dispatchSpawn` with a 400.

> [!WARNING]
> Spawned children **always** run `bypass` internally, whatever the parent's mode. Spawn approval (`spawnApprovalRequired`) authorises the whole sub-task; it is not per-tool gating. See `SECURITY.md` § Safe mode.

Some per-message options override the mode for **one** turn:
- `permissionMode` on `claude-code`, `qwen` and `kimi`
- `yoloMode` on `grok-build`, `trustAllTools` on `kiro`, `yolo` on `hermes`
- `sandbox` on `codex`

Escalating to bypass/full access through the Claude-family `permissionMode` option is deliberately not offered.

---

## 4. Steering and stop semantics

What happens when you press Enter while a turn is running (`steerClass()` in `profiles.ts`):

| Class | Adapters | Behaviour |
|---|---|---|
| **live** | `claude-code`, `codex`, `pi`, `grok-bot` | Text is folded into the **running** turn. No Interrupt & Send needed. |
| **force / soft** | `hermes`, `grok-build`, `kiro`, `qwen`, `kimi` | Queue, or Interrupt & Send via `session/cancel`. The process survives. |
| **force / hard** | `cursor`, `copilot`, `opencode`, `kilocode`, `openclaw`, `antigravity`, `kiro`* | Queue, or Interrupt & Send via kill + reinject |
| **queue** | anything else with catalogue `steer: false` | Delivered after the turn ends |

\* `kiro` is in both the soft and hard sets. `forceMechanism()` checks soft first, so kiro soft-cancels.

> [!NOTE]
> Antigravity is **not** live-inject. Its `steer()` parks on `getNextSteer` between turns (hold-open follow-up). Mid-turn, it takes the hard-stop path.

---

## 5. Per-message prompt options

The "+ options" menu is driven by `PROMPT_OPTIONS_BY_ADAPTER`. Values are sanitised by `sanitisePromptOptions()`: a string value starting with `-` **throws** (argv-injection guard), and the first choice of every select is the neutral "emit no flag" default.

| Adapter | Options (→ flag / field) | Binding |
|---|---|---|
| `claude-code` | `jsonSchema` (`--json-schema`), `disableSlashCommands`, `maxTurns` (1/3/5/10), `permissionMode` (manual/acceptEdits/plan/dontAsk), `restricted` (`--restricted`), `safeMode` (`--safe-mode`) | Per SDK query; `restricted`/`safeMode` use SDK `extraArgs` (`--restricted` / `--safe-mode`) |
| `antigravity` | `mode` (`plan` / `accept-edits`), `sandbox` (`--sandbox`), `jsonSchema`, `disableSlashCommands` | New agy process; context preserved. `plan` is a bias, **not a hard gate**, in headless mode |
| `cursor` | `mode` (`plan` / `ask`, both read-only), `sandbox` (`enabled` / `disabled`), `autoReview` (`--auto-review`) | This turn only |
| `copilot` | `mode` (`plan` / `autopilot`), `effort` (needs a pinned model, not `auto`), `toolsPolicy` (`readOnly` → view/grep/glob), `assistedApproval` | This turn only |
| `opencode` / `kilocode` | `variant`, `thinking`, `pure` (no plugins), `agent` | This turn only |
| `openclaw` | `thinking`, `timeout` (120–1800 s) | This turn only |
| `codex` | `sandbox` (`read-only` / `danger-full-access`) | New Codex thread |
| `pi` | `thinking`, `toolsProfile` (`readOnly` / `none`) | Respawn, resumes by session path |
| `deepseek` | `reasoningEffort` (`low` / `high` / `max`; `medium` and `xhigh` are rejected by dsh) | Respawn (binds at `initialize`), resumes by native id |
| `grok-build` | `sandbox` (`workspace` / `read-only` / `strict`), `reasoningEffort`, `yoloMode` | `sandbox` restarts grok (resumes via `session/load`); the other two go via `_meta` |
| `kiro` | `effort`, `trustAllTools` | Respawn, resumes by native id |
| `hermes` | `yolo` | Respawn, resumes by native id |
| `qwen` | `permissionMode` (via `session/set_mode`), `sandbox` (`-s`) | Next prompt; the ACP session persists |
| `kimi` | `permissionMode` (default-strict / yolo / auto) | Next prompt; the ACP session persists |
| `grok-bot` | none | - |

---

## 6. MCP, web and vision

### 6.1 MCP handling per adapter

| Adapter | What Tierwyn does | MCP in practice |
|---|---|---|
| `claude-code` | Normal turns pass **no** `settingSources`. The SDK then loads user/project/local settings like the CLI does, so `~/.claude.json`, `.mcp.json`, plugins and claude.ai-managed servers are all live. `oneShot()` and `textOnly` (priming summariser) sessions pass `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`; the CLI fallback's text-only path passes `--strict-mcp-config`. The `safeMode` option disables MCP for one turn. | **Full** |
| `cursor` | Always passes `--approve-mcps` and `--trust`, so servers from `~/.cursor/mcp.json` / `.cursor/mcp.json` run with no approval stall. The flags auto-approve servers; they do not select them. | **Full, auto-approved** |
| `copilot` | Always passes `--disable-builtin-mcps`, and denies `github-mcp-server` by name. Tierwyn passes no `--additional-mcp-config`. | **User servers only** (`~/.copilot/mcp-config.json`) |
| `codex` | Passes nothing MCP-related; `mcpToolCall` thread items are rendered | **Full** via `~/.codex/config.toml` `[mcp_servers.*]` |
| `antigravity` | Passes nothing MCP-related | **Full** via `~/.gemini/config/mcp_config.json`. `agy mcp enable/disable` is a **global** mutation, so per-conversation toggling is rejected by design. |
| `opencode` / `kilocode` | Passes nothing (the `pure` option disables plugins) | Global config only |
| `grok-build`, `kiro`, `qwen`, `kimi`, `hermes` | Tierwyn **injects** selected registry MCP servers on main `session/new` / `session/load` via ACP; secrets passed as literals on stdin (hermes: stdio only until `mcpCapabilities` advertised) | **Injected from registry** when selected |
| `pi` | - | No MCP switch. Offline is a separate knob (`--offline` / `PI_OFFLINE=1`). |
| `deepseek` | Tierwyn injects selected registry MCP servers (`stdio` + `streamable-http`) via a `0600` `--patch` overlay mounting `@deepseek-ai/dsh-mcp-client` (secrets passed via `TIERWYN_MCPV_*` env vars, never on disk or argv) | **Injected from registry** when selected |
| `openclaw` | - | Not wired in Tierwyn |
| `grok-bot` | - | N/A (GUI app) |

> [!IMPORTANT]
> **ACP caveat.** In ACP the *client* hands the agent its MCP roster. Tierwyn injects selected registry MCP servers into supported ACP agents (`grok-build`, `kiro`, `qwen`, `kimi`, `hermes`) via `session/new` / `session/load`. Whether an agent CLI **also** merges servers from its own native config file (`~/.grok/config.toml`, `~/.hermes/config.yaml`, …) is agent-specific and unverified. Grok emits `_x.ai/mcp/*` notifications, and the `grok-build` sandbox caveat says strict sandboxing "breaks MCP servers", which suggests grok may also load native servers. Injected registry servers take effect when selected in the conversation or template.

### 6.2 Web search and page reading

| Adapter | Web search / fetch |
|---|---|
| `claude-code` | Native `WebSearch` / `WebFetch`. `--restricted` removes `WebFetch`. |
| `grok-build` | Native xAI `web_search` / web fetch, on by default. The CLI has `--disable-web-search`, but Tierwyn never passes it. Sandbox `read-only` / `strict` blocks child network on Linux, which kills web search. |
| Everyone with a shell tool | `curl -sL https://r.jina.ai/<url>` returns clean markdown at near-zero cost |
| MCP-capable adapters | Browser automation via `chrome-devtools-mcp` / `@playwright/mcp` (§6.3) |

Other adapters' native search depends on the model backend and is not something Tierwyn controls.

### 6.3 Browser automation: why it is not enabled everywhere

There are two different needs:
- **Reading docs and articles** needs text. Use native fetch or `r.jina.ai`.
- **Debugging a local UI** (`localhost:5173` / `4173`) needs the DOM, console, network and screenshots. That is what `chrome-devtools-mcp` / `@playwright/mcp` are for.

Keep browser MCP scoped to the frontend-coding agents (`antigravity`, `claude-code`, `cursor`), because:
- **RAM:** each MCP instance spawns its own headless Chromium, typically 200–500 MB or more. Parallel spawns and scheduled jobs multiply that.
- **Context:** about 30 tool schemas are injected into every turn, whether or not a browser is needed.

### 6.4 Images

Attachments are enabled only when **both** `profile.vision` is true **and** the adapter is in `IMAGE_CAPABLE_ADAPTERS`. That covers every adapter. Delivery differs by adapter:

| Mechanism | Adapters |
|---|---|
| Inline blocks | claude-code, pi, codex (`turn/start` input), deepseek |
| Native flag | cursor `--image` (plus an `@path` fallback), copilot `--attachment`, opencode/kilocode `--file` |
| `@<tempPath>` text mentions resolved by the model against the local fs | antigravity, grok-build, hermes, openclaw, kimi, kiro, qwen |

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `spawn <agent> ENOENT` in prod, although `which <agent>` works | systemd user units do not inherit the shell `PATH` | Add every agent-CLI dir (`~/.npm-global/bin`, `~/.opencode/bin`, …) to `PATH=` in `/etc/tierwyn/prod.env`, then restart `tierwyn-prod.service` |
| Agent greyed out / "not permission-capable" 400 | Conversation is in `prompt` mode and the agent is bypass-only | Switch to `questions` or `bypass`, or pick a permission-capable agent |
| Turn hangs with no output (cursor / copilot) | An approval prompt nobody can answer. Usually `autoReview` (cursor), `assistedApproval` (copilot), or a workspace-trust prompt on an old cursor-agent. | Drop the option. Tierwyn's default argv (`--trust --approve-mcps`, `--no-ask-user`) exists to avoid exactly this. |
| Turn stalls on a card in `prompt` mode | A permission request is waiting in the UI | Answer the `interaction_request` card. Grok Bot cards are never auto-approved. |
| Antigravity `Error: timeout waiting for response` | agy print-mode timeout | Tierwyn passes `--print-timeout 30m`. Longer turns still die, so split the work. |
| Antigravity asks for permission / tool refused | `toolPermission` is not `always-proceed` in agy `settings.json` | Set it. Tierwyn will not pass `--dangerously-skip-permissions`. |
| Antigravity "plan mode" still edited files | `--mode plan` is a bias, not a gate, in print mode | Use cursor `plan`/`ask` or codex `read-only` for hard read-only |
| grok-build: web search, MCP or delegation curls fail | Sandbox `read-only` / `strict` blocks child network on Linux | Use `workspace` or off |
| qwen sandbox turn "stalls" on first use | Pulling the multi-GB `ghcr.io/qwenlm/qwen-code` image | Wait it out. Inside the container the agent cannot reach Tierwyn on 127.0.0.1, so delegation, schedule and plugin calls fail. |
| Resumed ACP session answers with the wrong model | `session/load` leaves the model unset | Handled by `session/set_model` after load. If it recurs, check the adapter logs for a set_model error. |
| Kiro `session/new` deserialisation error | `mcpServers` sent as a map | It must be an array (`[]`) |
| Old transcript re-appears on resume (ACP) | `session/load` replay leaking | Replays are gated by `_accepting`. If this appears, it is an adapter bug; file it. |
| Copilot rejects `--effort` | Profile model is `auto` | Pin a concrete model |
| Grok Bot: immediate error + end | CDP port `9333` unreachable | Start the app / `tierwyn-grokbot.service`; check `TIERWYN_GROKBOT_CDP_PORT` |
| Memory spikes, many `chrome` processes | One headless Chromium per MCP-enabled agent, and orphans after hard kills | `pgrep -fa 'chrome-devtools-mcp\|playwright'` and kill orphans; scope browser MCP per §6.3 |
| Codex: session looks "ended" after a turn | Misreading `turn/completed` | `'end'` fires only on process exit. A stuck session means `codex app-server` did not exit, so `stop()` it. |
| Claude Code turn shows `Claude SDK could not start and the CLI fallback is disabled…` | SDK failed to spawn in a non-bypass interaction mode | Fix the Claude Code install, or switch the conversation to bypass (the CLI fallback cannot gate tool permissions) |

---

## 8. Security notes

- **Env scrubbing:** see §1. This protects against disclosure through the product surface. It is **not** a boundary against same-UID `/proc/<pid>/environ` reads.
- **MCP egress plus a spawn token** lets a prompt-injected agent misuse the live token within its run window. Do not enable untrusted MCP egress in spawn-capable conversations (`SECURITY.md`).
- **Copilot** has a hardcoded deny list (§2 D). Other bypass-only adapters have no Tierwyn-side tool policy at all.
- **Safe mode** (`spawnApprovalRequired`) queues bearer spawns for operator approval. Combining it with `wait: true` is rejected.

---

## 9. Adding an adapter

See `CLAUDE.md` § Adding a new adapter. Also add the new `agentType` to the relevant capability sets in `profiles.ts`, and to `PROMPT_OPTIONS_BY_ADAPTER` / `promptOptionsFootnote()` if it takes per-message options, then update this page.
