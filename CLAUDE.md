# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Tierwyn Is

**Tierwyn**, said "TEER-win"; *Tiers of agents. Stack the wins.* Tierwyn is a coding agent meta-harness; a web UI + API server that lets you drive multiple AI coding agents (15 CLIs: Claude Code, Pi, OpenCode, KiloCode, Antigravity, Cursor, Hermes, Codex, Grok Build, Kiro, Qwen Code, OpenClaw, Kimi Code, GitHub Copilot, DeepSeek; plus the Grok Bot desktop app) from a browser. It uses no Anthropic API key; it drives the `claude` CLI directly via `@anthropic-ai/claude-agent-sdk`.

## Commands

### Development

```bash
# Install everything
npm install

# Build the shared package first (required before first run or after shared changes)
npm run build --workspace=packages/shared

# Run both server and web in dev mode (concurrently)
npm run dev

# Run only one side
npm run dev:server    # tsx watch on apps/server/src/index.ts (port 8787)
npm run dev:web       # Vite dev server (port 5173)

# Build plugin .tar.gz from plugin-src/ into plugin-archives/
npm run package:plugins
```

### Tests

```bash
# Run all server tests
npm run test --workspace=apps/server

# Watch mode
npm run test:watch --workspace=apps/server

# Run a single test file
npx vitest run apps/server/src/catalogue.test.ts

# Web-side pure-module tests (node environment, src/**/*.test.ts only: no jsdom)
npm run test --workspace=apps/web
```

### Type checking

```bash
npm run typecheck   # runs tsc --noEmit across all workspaces
```

### Build

```bash
npm run build   # builds all workspaces; server build copies SQL migrations to dist/
```

### Deploy / restart (prod, same machine)

```bash
# Full rebuild + restart API + web (default when operator says "deploy restart")
npm run deploy:prod:full

# Web-only rebuild + restart (CSS/UI-only changes)
npm run deploy:prod
```

### Installer CLI (`tierwyn`)

`scripts/install.sh` is also the `tierwyn` command (symlink at `~/.local/bin/tierwyn`, offered at the end of setup).

```bash
tierwyn                 # interactive home
tierwyn setup           # install / update (alias: install)
tierwyn doctor          # diagnostics (exit 1 on failure)
tierwyn restart         # restart the installed API + web pair: tierwyn-prod* if present, else tierwyn-hub* (or: start|stop|restart [prod|hub|all|piper|kokoro|grokbot])
tierwyn hub restart     # dedicated hub user pair (tierwyn-hub + tierwyn-hub-web): hub start|stop|restart|logs|status
tierwyn config          # re-run mode / port / password, then re-render units
tierwyn update          # channel update (stable = newest vX.Y.Z tag, edge = main) + rebuild + restart running services
tierwyn channel [stable|edge]  # show/set channel (~/.config/tierwyn/channel, or TIERWYN_CHANNEL); stable never downgrades
tierwyn logs [target]   # follow journald logs (same targets as restart)
tierwyn linger          # keep services running after logout (sudo loginctl enable-linger)
tierwyn node setup|enroll|run|start|stop|restart|logs|update|allow|disallow|status  # remote-host daemon (not the hub)
                         # update [--from-hub] [--allow-http]: git pull+rebuild, or hub package swap;
                         # --from-hub converts git → ~/tierwyn-node (BUILD_ID); --allow-http persists allowHttpPackage
```

Dedicated hub user (sandbox on, agents cannot edit the install): [`docs/deploy/hub-user.md`](docs/deploy/hub-user.md). Hub install: `curl …/scripts/install.sh | bash` still clones; Configure → Dedicated hub. Node hosts: Settings one-liner defaults to the **hub package** (`GET /node/install.sh` with `TIERWYN_HUB_PKG_SHA256` marker → `~/tierwyn-node`) when `dist/node-package/` exists; toggle GitHub for a git checkout. Guide: [`docs/architecture/remote-hosts.md`](docs/architecture/remote-hosts.md).

Node floor is **22.13** (`engines.node` `>=22.13.0`; installer `node_version_ok` rejects 22.x below 22.13; `MIN_NODE` is the major 22). First unflagged `node:sqlite` on 22. The existing 24.x `>=24.22.1` OpenClaw rule stays.

## Architecture

### Monorepo structure

```
apps/server  ; Express + WebSocket API server (Node, ESM, Vitest)
apps/web     ; React + Vite SPA (TypeScript, Vitest for pure .ts modules; no DOM/component tests)
packages/shared; types and domain models shared between server and web
```

`packages/shared` is the contract boundary. Both sides import from `@tierwyn/shared`. Build it before the other two.

### Server

**Entry point:** `apps/server/src/index.ts`; boots DB, seeds catalogue, registers adapters, mounts Express routes, and handles WebSocket upgrade.

**Key subsystems:**

| Module | Purpose |
|---|---|
| `catalogue.ts` | `ProfileCatalogue`; in-memory map of `AgentProfile` rows loaded from SQLite; reloaded on every catalogue mutation |
| `registry.ts` | `AdapterRegistry`; maps `agentType` string → factory; all 16 adapters (15 CLIs + Grok Bot desktop app) registered at boot |
| `sessionManager.ts` | Orchestrates a `prompt` or `command` WebSocket frame into an adapter lifecycle: creates a DB session, calls `adapter.start()` → `adapter.sendPrompt()`, streams `NormalisedEvent`s back via `broadcast` |
| `sessionHub.ts` | Per-conversation fan-out: tracks which WebSocket clients are subscribed and delivers `ServerFrame`s to them |
| `scheduler.ts` | Runs `listModels()` and `listCommands()` on every adapter at startup and every 12 hours; persists results to the DB catalogue |
| `schedules/` | User-facing **JobScheduler** (interval/cron jobs, plan steps, tick prompt assembly, pipeline stages, run dispatch). Distinct from model-discovery `scheduler.ts`. Operator guide: [`docs/architecture/scheduled-jobs.md`](docs/architecture/scheduled-jobs.md) |
| `discovery.ts` | Non-spawning PATH probe: checks whether each agent binary is installed. Installed-vs-latest versions are probed by the discovery scheduler and cached 12 h in the `agent_versions` settings row; upgrade refuses while sessions are live. |
| `compaction/compactor.ts` | Builds a `ResumePlan` (native / compacted / transcript / fresh) for resuming a conversation across context-window limits |
| `auth/` | Single-operator cookie auth: argon2 password hash with concurrency throttling + HMAC-signed session cookie; session floor instant revocation (`auth.session_floor_ms`) on logout and password change (`ph` fingerprint); `AUTH_DISABLED=true` bypasses for local dev (`assertAuthBindSafe` refuses non-loopback binds unless `TIERWYN_ALLOW_AUTH_DISABLED_NONLOCAL=1`) |
| `plugins/` | Per-instance ESM plugins (`PluginHost` + loader). Nothing bundled; source in `plugin-src/`, import tar.gz. Encrypted vault + env fallback (phase 2); `buildChildEnv()` scrubs secrets from agent children. Operator guide: [`docs/architecture/plugins.md`](docs/architecture/plugins.md) |
| `mcp/` | MCP server registry (`mcp_servers` table), per-conversation selection, resolver & injector (`MCP_INJECTABLE_ADAPTERS`; per-agent `mcpAgentCapability()` in shared; only `claude-code` enforces native overrides, UI renders the rest read-only), native read-only viewer (`GET /mcp/native`), REST routes. Operator guide: [`docs/architecture/mcp-servers.md`](docs/architecture/mcp-servers.md) |
| `memory/` | Project memories: database-backed, topic-recalled project notes saved by agents and managed by operator (migration 153); replaces v0 memory.md. Guide: [`docs/architecture/project-memory.md`](docs/architecture/project-memory.md) |
| `spawn/rules.ts` | Operator rules: project + ancestor-chain conversation instructions + stackable presets (migration 144), cookie-only writes, injected into full preambles (stub reminder on native resume; hold-open adoption prefix on hash change). Guide: [`docs/architecture/operator-rules.md`](docs/architecture/operator-rules.md) |
| `node/` | Remote Hosts: hub `nodeHub.ts` + `tierwyn node` `main.ts` (`apps/server/src/node/`). Adapter-boundary RPC over outbound WSS `/ws/node`. Operator guide: [`docs/architecture/remote-hosts.md`](docs/architecture/remote-hosts.md) |
| `sandbox/` | Optional bwrap isolation per agent CLI process: `bwrap.ts` (argv builder + `sandboxSpawnFor` + tree-kill; self-bound `.git` with read-only config/hooks/info overlays), `profiles.ts`, `capability.ts`, custom-path checks. Centralized git execution in `apps/server/src/git/gitExec.ts` (`gitSync`/`gitAsync`) enforces `GIT_SAFE_CONFIG` (`-c core.hooksPath=/dev/null`) and `assertSafeRepoConfig`. Resolved per session start, monotonic spawn pin. Guide: [`docs/architecture/sandbox.md`](docs/architecture/sandbox.md) |
| `db/` | SQLite via `better-sqlite3`; migrations in `db/migrations/*.sql` numbered sequentially; `db/seed.ts` seeds default profiles and slash commands |

**Adapter interface** (`packages/shared/src/adapter.ts`):
Every agent adapter implements `AgentAdapter`: `start()`, `sendPrompt()`, `streamEvents()` (EventEmitter emitting `NormalisedEvent`), `stop()`, `listModels()`, and optionally `listCommands()`, `runCommand()`, `isNativeSessionAvailable()`.

Adapters live in `apps/server/src/adapters/<agent-name>/`. The Claude Code adapter (`adapters/claude-code/`) uses `@anthropic-ai/claude-agent-sdk` and falls back to spawning the `claude` CLI subprocess. Parked sessions with running helpers are adopted, not reaped.

The OpenClaw adapter (`adapters/openclaw/`) is a **spawn-per-turn** adapter: `openclaw agent --local --json --session-id <id> -m <text>` runs once per user message and exits with a single JSON result object. The same `--session-id` resumes context across turns. Dynamic model discovery uses `openclaw models list --json`. No steering, no streaming, text-only MVP. Install: `npm i -g openclaw@latest`. Config: `~/.openclaw/openclaw.json`.

The GitHub Copilot adapter (`adapters/copilot/`) is a **spawn-per-turn** adapter with **streaming JSONL**: `copilot -p … --output-format json --stream on`. Turn 1 uses `--session-id <uuid>`; later turns use `--resume=<uuid>`. Bypass-mode with `--allow-all-tools` plus a static deny list; no steering, no interactive approvals. Models are seed-only (`listModels()` returns `[]`). Install: `npm i -g @github/copilot` then `copilot login`. Config: `~/.copilot/`.

The DeepSeek adapter (`adapters/deepseek/`) is a **long-lived JSON-RPC** adapter: `dsh --profile sdk` runs once per session, held open between turns. Sessions are persisted under `~/.dsh/sessions/<slug>/<sessionId>` and resumed via `session/resume`. `reasoningEffort` (low/high/max; dsh rejects medium and xhigh) binds at `initialize`, so changing it respawns and resumes by native id. Native `subagent.started`/`subagent.finished` notifications map to path-A helper events (no `stopHelper`). Reasoning chain-of-thought is dropped from the transcript to avoid verbosity. Models are seed-only (`listModels()` returns seeded profiles). Slash commands come from skill directory scanning. Bypass-mode; no tool permissions. Install: `npm i -g @deepseek-ai/dsh`. Config: `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` if using a custom DeepSeek endpoint; `ZAI_API_KEY` for z.ai provider support.

The Grok Bot adapter (`adapters/grok-bot/`) is **CDP attach** of the official desktop app: Tierwyn may start the unit on demand (lifecycle supervisor, `adapters/grok-bot/supervisor.ts`). Reads `TIERWYN_GROKBOT_CDP_PORT` (default `9333`); if unreachable it emits an error and `'end'`. Chat writes go through the composer (`Input.insertText` + Enter, plus `DOM.setFileInputFiles` on `input.sand-prompt-file-input` for outbound attachments); reads poll `window.desktop.agent.clientPersistence` replicas. Inbound `message.type === 'attachment'` rows are persisted as `MessageFile` shards under `<dataDir>/attachments/<conversationId>/` via `window.desktop.readAttachmentBytes`. `BARE_PROMPT_ADAPTERS` in `packages/shared/src/profiles.ts` suppresses the delegation/schedule preamble and Bearer (no spawn/schedule token). Spawn children still get a server-baked host/CWD/RESULT note (no token); `grokBotUsable` hides grok-bot from pickers and spawn rosters unless the app is `running` or `starting` (closed stays hidden even if autostart could launch). Handoff priming + Hostname/CWD note is gated by Settings `grokBotInProjectChats` (default off; Grok Bot stays in the Grok Bots project only). Turn completion is detected from the replica plus the app's own per-Bot busy mark (`.sand-agent-item[data-agent-id] [data-grok-state]`, `idle | working`); without the mark the idle window expires while Grok silently drives the computer and later messages are lost. The user echo is matched whitespace-normalised (`entryEchoesPrompt`) because the app collapses newlines, and assistant text comes from `send-message` entries. `listModels()` returns the app roster, so the picker shows real Bot names; choosing one pins the conversation to that chat (the row is clicked before typing) while the seeded `grok-bot:default` profile follows whatever chat is open. `isNativeSessionAvailable()` is roster membership, which is what lights the resume badge. Phase 2 relays Allow once / Deny / Always allow cards as `interaction_request` (never auto-approved), `stop()`/`interruptTurn()` send the documented "Stop now" chat message, and `steer()` is live inject (`LIVE_INJECT_ADAPTERS`). A server-lifetime **inbound watcher** (`adapters/grok-bot/watcher.ts`) polls the roster every `TIERWYN_GROKBOT_WATCH_MS` (default 25 s; `TIERWYN_GROKBOT_WATCH=0` kills it) and ingests Bot messages that arrive outside a live turn into the Bot's owner conversation. The last conversation to talk with the Bot owns it for `TIERWYN_GROKBOT_REPLY_LEASE_MS` (default 1 h), then the Remote Agents container. Owner changes post a ⇄ handover card in both chats. Phase 2 also auto-provisions one conversation per roster Bot in the undeletable **Remote Agents** system project (`projects.system`, keyed by `sessions.native_session_id`; opt-out `grokBotAutoCreateRemoteAgents`). The inbound watcher also persists user messages typed in the native app / phone / web as `prompt` events (`sender: 'user'`), deduped against the prompt Tierwyn itself just sent. A nightly pruning sweep rides the retention scheduler: active container transcripts are truncated to `grokBotTranscriptEventLimit` events (default 2000, `0` = unlimited) and retired Bot conversations idle past `conversationRetentionDays` are archived to `data/archive/<id>.jsonl` and deleted. Sidecar unit: `docs/deploy/systemd/tierwyn-grokbot.service`. Watcher notes: [`docs/architecture/grok-bot-watcher.md`](docs/architecture/grok-bot-watcher.md).

**Event normalisation:** All agent output is normalised into `NormalisedEvent` (defined in `packages/shared/src/events.ts`): `prompt`, `message`, `tool_call`, `tool_result`, `file_change`, `status`, `error`, `steer`, `interaction_request`, `interaction_resolved`, `helper`. `helper` = snapshot of one native CLI subagent (Claude Code `task_*` system messages), newest per taskId wins; see [`docs/architecture/helpers.md`](docs/architecture/helpers.md). The `status` event carries `AgentStatus`: `running | idle | waiting | error | done`.

**WebSocket protocol:** Clients send `ClientFrame` (subscribe / prompt / command / stop / steer / cancel_steer / edit_steer / interaction_response / stop_helper); server sends `ServerFrame` (event / heartbeat / session_started / session_ended / active_sessions / conversation_updated / stop_result / steer_result / steer_queued / steer_queue / interaction_result / btw_updated / spawn_request_updated / checkpoints_updated / schedule_updated / draft_updated / grokbot_status / remote_host_status / global_task_updated / memory_updated / conversations_changed / timers_changed). `conversation_updated` may carry `title`/`description` on metadata broadcasts only, and `pendingHandoffMode` (`null` = cleared) when the staged next-send action changes. `conversation_updated` / `active_sessions` may carry `helpersRunning`; `conversation_updated.settingsChanged` (permission mode / effort / MCP / template / capability profile PATCH) makes other devices refetch the conversation. `timers_changed` is operator-global, ids only (`conversationIds`), coalesced from `repositories/conversationTimers.ts` on create / edit / cancel / fire. Peer draft text lands in a focused composer once it has been idle `FOCUSED_IDLE_MS` (`apps/web/src/draftLock.ts`). `conversations_changed` is operator-global, ids only (`projectIds`, `createdIds?`, `deletedIds?`), emitted from `noteConversationsChanged` in `repositories/conversations.ts` (setImmediate-coalesced); clients debounce a sidebar refetch. `schedule_updated` may carry `jobName` and `event: 'fired' | 'auto_disabled'`. `grokbot_status` is operator-global and carries `GrokBotLifecycleStatus` on supervisor transitions only. `remote_host_status` is operator-global and is broadcast with the full decorated view on connect, disconnect, refresh, patch, and install or update progress (not every ping). `global_task_updated` is operator-global and carries global `counts`. `memory_updated` is operator-global and carries global memory `counts`. `PromptMessage` and `CommandMessage` accept optional ephemeral per-message `options` (`PromptOptions`, documented in `packages/shared/src/promptOptions.ts`). Shared types in `packages/shared/src/protocol.ts`. Operator notifications: [docs/architecture/browser-notifications.md](docs/architecture/browser-notifications.md). Descriptions: [docs/architecture/conversation-descriptions.md](docs/architecture/conversation-descriptions.md). Dictation Fast/Slow: [docs/architecture/dictation.md](docs/architecture/dictation.md).

**REST routes:**
- `GET /profiles`: enabled catalogue entries
- `/memories*`: operator memory management (cookie-only; `GET /memories?view=all|suggestions|flagged`, `GET /memories/counts`, `GET /memories/:id`, `DELETE /memories/:id`, `POST /memories/:id/approve`, `POST /memories/:id/edit` (operator correction = supersede by an operator-authored copy), `POST /memories/:id/promote`, `POST /memories/:id/dismiss`). Guide: [`docs/architecture/project-memory.md`](docs/architecture/project-memory.md)
- `GET /agent/memory?q=<words>`, `POST /agent/memory`, `POST /agent/memory/:id/supersede`; agent memory search, save, and supersede (session Bearer holding `memory` capability, scoped to conversation's project; guide: [`docs/architecture/project-memory.md`](docs/architecture/project-memory.md))
- `GET /agent/search`: agent conversation-history search (session Bearer holding `memory`; global + per-project scope, sandbox/remote cap); guide: [`docs/architecture/agent-search.md`](docs/architecture/agent-search.md)
- `GET /conversations/search?q&projectId&limit&matchesPerConversation`: operator FTS message search (cookie); centred snippets; `matches[]` (≤5/conversation) only when `matchesPerConversation` is passed.
- `GET /grok-bot/status`: Grok Bot lifecycle snapshot (cookie; probes CDP if stale)
- `POST /grok-bot/start`: `{ reason: 'manual' | 'on-demand' }` → 202 fire-and-forget (cookie; 409 if disabled)
- `GET/POST /projects`, `PATCH /projects/:id` (`name`, `rootPath`, **`rules`**, **`rulePresetIds`**, **`sandbox`**, **`sandboxPaths`**, **`agentSearchScope`**; cookie; system projects 409), `POST /projects/:id/move` (`rootPath`, `dryRun?`; cookie; 409 if agents active), `GET /projects/:id/conversations`, `GET /projects/:id/rules`, `POST /conversations`
- `/remote-hosts*`: cookie-only (list/create/trust/patch/refresh/delete 409s with `projectNames` while bound unless `?unbind=1`; view may carry `boundProjects`, `GET :id/stat-path`, `POST :id/agents/:type/install`, `POST :id/agents/install-all`; sequential `missing+behind` batch; host view carries `installBatch: { running, remaining }`). `POST :id/agents/:type/login` (Codex / Claude Code / Copilot / Grok Build / Cursor, 202), `POST :id/agents/:type/login/cancel`, and `POST :id/agents/:type/login/code` (`claude-code` paste-back); view may carry `logins` (per-agent) and ed25519 public key `fingerprint`. `POST /remote-hosts` accepts optional `autoTrust` (default `false`) and returns `oneLiner` (hub package when available), `oneLinerGithub`, `packageAvailable`, `insecureOrigin`, and `expiresAt` (10m TTL). `PATCH /remote-hosts/:id` accepts `name`, `allowMcpSecrets`, `allowAgentEnvSecrets`, `disabled`, and `description` (nullable display note, max 500 chars). `POST /node/enroll` answers `{ hostId, trusted }`. `POST /remote-hosts/:id/update` may answer `200 { ok: true, upToDate: true }` for a package host already on the hub build (no RPC); package host + no tarball → 503 `package_unavailable`. `POST /projects` takes an optional `cloneUrl` with `remoteHostId`. `POST /node/enroll`; public + login-rate-limited (single-use token, 10m TTL). `GET /node/install.sh` (public, sha256 marker substituted) and `GET /node/package.tgz` (enroll Bearer or node signature). Guide: [`docs/architecture/remote-hosts.md`](docs/architecture/remote-hosts.md)
- `POST /agents/versions/refresh`: re-probe installed + latest versions for the hub catalogue (fire-and-forget; completion signals via `catalogue_updated`); `POST /agents/install-all`; sequential hub install/upgrade batch (`mode: 'missing' | 'missing+behind'`, 409 while another batch runs; response carries `targets` + `skipped`)
- `GET/POST /rule-presets`, `PATCH/DELETE /rule-presets/:id`; stackable rule preset catalogue (cookie; global or per-project)
- `GET /conversations/:id/transcript`: all stored events (or paged via optional `tailTurns=1..200` and `before=<ts>:<seq>`; returns `{ events, hasMore?, cursor? }`; transparently gzips when body > 64 KB and client accepts gzip)
- `GET /conversations/:id/active-agent`: last session + native availability
- `GET /sessions/active`: every in-flight session across all projects, plus session-conversation ancestors (Active Agents modal; carries the server clock so clients correct local clock skew)
- `GET /conversations/:id/usage`: aggregated token/cost + rate-limit data from `~/.claude/rate-limits.json`
- `GET /conversations/:id/subtree-time`: aggregated time worked by root and all descendants (per-session cached, 404 on unknown id)
- `GET /conversations/:id/resume-plan`: compaction decision
- `GET /conversations/:id`: single conversation row (deep link / `?c=`)
- `PATCH /conversations/:id`: `title`, `templateName`, `spawnWorkdir`, `pinned`, `archived`, `tags`, `projectId`, **`description`**, **`designation`**, **`capabilityProfile`** (400 on unknown profile id; a *change* writes the profile onto the conversation and its descendants, reaps parked sessions, revokes spawn tokens, and re-issues only when a live session exists; any PATCH of description marks `description_source = 'user'`), **`mcpServers`** (null to inherit template default, or array of string ids; reaps parked sessions with `{ all: true }`), **`permissionMode`** (null = inherit global), **`effort`** (`off|low|medium|high|xhigh|max`, null clears; per-conversation composer effort, broadcasts `settingsChanged`, no reap), **`pendingHandoffMode`** (`'fresh' | 'summary' | null`; staged next-send action, does not bump `updated_at`, broadcast on `conversation_updated`), **`rules`** (operator instructions; `null` clears; 4 KiB; cookie-only; no reap; fingerprint re-injects next session), **`rulePresetIds`** (ordered preset stack; `null`/`[]` clears; cookie-only)
- `GET /conversations/:id/rules`: inherited `{ project: { rules, presets }, chain, hash, omitted, rendered }` for the Rules modal (cookie)
- `GET /conversations/:id/sandbox`: resolved sandbox status, inheritance chain, effective paths (cookie; guide: [`docs/architecture/sandbox.md`](docs/architecture/sandbox.md))
- `GET|POST /settings/compaction`
- `GET|POST /settings/sandbox`: wave-2 sandbox document `{ global, defaults, hostPaths }` (cookie; unknown host/agent 400; reaps parked sessions whose resolution flips)
- `GET /settings/agent-env`, `PUT|DELETE /settings/agent-env/:agentType/:name`; per-agent vault env vars (cookie; values never returned; unknown/denied/short → 400; vault off → 503; reaps parked sessions of that agent type)
- `GET /settings/direct-llm`, `POST /settings/direct-llm`, `POST /settings/direct-llm/:id`, `DELETE /settings/direct-llm/:id`, `POST /settings/direct-llm/:id/test`; Direct LLM profiles (built-in cleanup/enhancer + extra profiles in `direct_llm_profiles` settings row); sidecar sites select one via `route.profile`
- `GET|POST /settings/notifications`: master + category toggles (never returns `vapidPrivateKey`)
- `GET|POST /settings/tag-catalogue`: Jev auto-tag catalogue, whole document `{ custom, disabledBuiltins }` (cookie-only; guide: [`docs/architecture/jev.md`](docs/architecture/jev.md))
- `GET /notifications/vapid-public-key`, `POST|DELETE /notifications/subscribe`; cookie-auth only
- `GET /settings/agent-usage?fresh=1`: per-agent rate-limit/quota snapshots (panel guide incl. Z.ai key config: [`docs/architecture/agent-usage.md`](docs/architecture/agent-usage.md))
- `GET/POST /schedule-packs`, `DELETE /schedule-packs/:slug`; global schedule-pack catalogue (instantiate-and-forget job blueprints; shipped rows undeletable)
- Catalogue CRUD in `routes/catalogue.ts` (`GET /agents`, `GET /catalogue`, `POST /agents/:id/upgrade` starts the fixed AGENT_BINARIES install command in background; 409 while sessions of that type are live; `POST /agents/:type/login`, `/login/cancel`, `/login/code`; cookie; hub-local interactive login for Codex / Claude Code / Copilot / Grok Build / Cursor; state on `GET /agents` `login`/`loggedIn`, pushed via `catalogue_updated`), conversation mutations in `routes/conversations.ts`
- Auth routes: `POST /auth/login`, `POST /auth/logout`, `GET /auth/session`
- `POST /spawn/:childConversationId/message`: descent-validated downward talk-back (bearer or cookie). Target id in the path; JSON body `{"parentConversationId":"<sender conversation id>","text":"…", "notifyParent"?: boolean, "wait"?: boolean, "fireInMs"?: number, "fireAtMs"?: number, "handoff"?: 'fresh'|'summary'|'transcript'}`. Optional `notifyParent` overrides edge notify for that turn (including deferred `fireInMs`/`fireAtMs` resumes; persisted on the timer; omitted inherits the spawn edge). Optional `handoff` (descent only, idle child only) starts the next turn as a fresh session, summary handover, or transcript handover (staged operator handoff consumed automatically). Optional `wait: true` (descent only, idle child only, ≤15 min, **not** combinable with deferral) blocks until the child turn ends and returns `{ok: true, delivered: 'new_turn', result, errored, degenerate, handoff?}`. Both required fields are read from the parsed JSON body **only**; a `text/plain` body, a `?parentConversationId=` query param or an `X-Spawn-Parent` header are ignored and answer `400`, not `401`
- `POST /spawn/:childConversationId/stop`: parent-authorized kill of a strict descendant (bearer with `spawn` capability, or cookie). JSON `{ "parentConversationId":"<caller id>", "graceMs": 3000 }` (default 3000, cap 15000). Unlike `/message`, `parentConversationId` is also accepted from the query or `X-Spawn-Parent`. 200 `{ ok, childId, previousStatus, stopped: 'killed'|'settled-naturally'|'already-stopped', alreadyStopped, notifyFired, timerCancelled, wrapUpDelivered }`. Self-stop 400; unknown 404; non-descendant 403.
- `GET /agent/plugins`, `GET /agent/plugins/help`, `GET /agent/plugins/:id/help` (per-plugin HELP.md; loopback + bearer/cookie), `POST /agent/plugins/:id/capabilities/:name`; agent plugin surface (session bearer holding plugin scope or cookie; help is loopback-only)
- `GET /agent/usage`: built-in agent quota snapshots for agents (allowlist projection, no providers/insights; 6/min per conversation)
- `GET /agent/usage/:target`: one target's snapshot for agents; `target` is an agent type (`claude-code`) or usage-provider plugin id (`zai-usage`); 403 `not_in_profile` unless the conversation's capability profile grants usage; 6/min per conversation
- `POST /agent/artifacts/deliver`: re-push a hub-side artifact-shard output to the node after a failed transfer for a remote conversation (bearer, own conversation, remote conversations only, 10/min)
- `ALL /agent/mcp/:serverId`: tunnel-only MCP bridge: the node's loopback listener forwards hub-placed MCP server calls here; per-session `X-Tierwyn-Mcp-Key` auth ([`docs/architecture/mcp-servers.md`](docs/architecture/mcp-servers.md) §13)
- `GET|POST /settings/capability-profiles`, `DELETE /settings/capability-profiles/:id`; capability-profile CRUD (cookie; built-in ids are read-only → 409; delete 409 with the conversation count while in use; a grant-set upsert revokes live tokens of conversations using that id). Profiles scope an agent Bearer to a plugin allow-list + usage flag; see `docs/architecture/plugins.md` § Capability profiles and SECURITY.md § Token capabilities
- `GET /plugins`, `POST /plugins` (multipart tar.gz import), `DELETE /plugins/:id` (unload + purge), `PATCH /plugins/:id`; operator plugin catalogue (cookie; status never values)
- `PUT/DELETE /plugins/:id/credentials/:key`: vault write/clear (cookie; 503 if vault unavailable)
- `GET /plugins/:id/invocations`: newest-first audit rows (cookie; `error` is already-safe text)
- `GET /mcp/servers`, `POST /mcp/servers`, `DELETE /mcp/servers/:id`; operator MCP server registry (cookie; returns servers + `vaultAvailable`; secret values never exposed)
- `PUT/DELETE /mcp/servers/:id/secrets/:kind/:key`: write-only secret set/clear (`kind` is `env` or `header`; min length 8; cookie; 503 if vault unavailable)
- `GET /mcp/native?agentType=<type>&projectId=<id>`: read-only view of native agent MCP configs (`claude-code`, `codex`, `cursor`, etc.; values masked; cookie)
- `POST /mcp/native/:agentType`: write-through install of an MCP registry entry into native agent config (`scope`: `user`|`project`; atomic `.bak` + 0600 tmp rename; `${VAR}` placeholders for `claude-code`, explicit `copySecrets: true` for others; 409 if project-scope and agent is live; cookie)
- `DELETE /mcp/native/:agentType/entry/:name`: write-through remove of an MCP server entry from native agent config (cookie)
- `GET /conversations/:id/mcp?agentType=<type>`: effective MCP selection & skip reasons for conversation (cookie)
- `GET /conversations/:id/mcp/status`: live MCP status from running agent (`claude-code` only; cookie)
- `POST /conversations/:id/mcp/:serverName/:action`: live MCP control (`enable` | `disable` | `reconnect`; `claude-code` only; cookie)
- `GET|POST /conversations/:id/timers`: list / create per-conversation prompt timers (cookie; not schedule_jobs)
- `POST /conversations/:id/timers/agent`: agent self-timer (bearer, own conversation only; `TIERWYN_AGENT_SELF_TIMERS` level0|all|off, default level0; ≤ usageAutoResumeMaxDeferMs; one pending non-operator timer → 409; origin 'agent-self'; guide: [`docs/architecture/conversation-timers.md`](docs/architecture/conversation-timers.md))
- `DELETE /conversations/:id/timers/:timerId`: cancel a pending timer (cookie; 409 if already fired or cancelled)
- `GET /timers/pending`: cross-conversation pending timer summaries for the Agent Activity Timed tab (cookie; ≤200, soonest first)
- `GET /files/git-branches`, `GET /files/git-branch-diff[/file]`, `POST /files/working-tree/{switch-branch,create-branch,fetch,pull,stash,stash-pop,create-worktree}`; operator git ops (cookie); mutations 409 while agents are live on the checkout
- `GET /files/list?conversationId|projectId&path=`: directory listing for the topbar file browser (cookie; root from DB, relative path only, `.git` hidden, ≤2000 entries)
- `GET /project-browse/roots[?remoteHostId=]`, `GET /project-browse/list?root=&path=[&remoteHostId=]`, `GET /project-browse/stat?path=`; directory roots, subfolder listing, and stat check for project creation and folder browsing (cookie-only; root must equal configured root, relative path only, `.git` hidden, ≤2000 entries)
- `GET|POST /tasks/agent` (or `/conversations/:id/tasks/agent`), `PATCH /tasks/agent/:taskId` (or `/conversations/:id/tasks/agent/:taskId`); agent Global Tasks (bearer, own conversation, `'tasks'` capability, ≤3 open)
- `GET /tasks`, `GET /tasks/count`, `PATCH|DELETE /tasks/:id`, `POST /tasks/hide-completed`, `DELETE /tasks?view=hidden`; operator Global Tasks (cookie; all 403 `global_tasks_off` while the feature is disabled), `GET|POST /settings/global-tasks`; always reachable. Guide: [`docs/architecture/global-tasks.md`](docs/architecture/global-tasks.md)

**Database:** SQLite at `./data/tierwyn.db` (path from `TIERWYN_DB` env; prod uses `./data/prod.db`). Schema in `db/migrations/`. Migrations run at boot via `db/migrate.ts`. Tables: `projects` (incl. `system` flag, migration 118; Remote Agents container), `conversations` (incl. `description` / `description_source`, migration 104; `designation`, migration 122), `sessions`, `events`, `agents`, `agent_models`, `agent_commands`, `settings` (notifications JSON row, `direct_llm_profiles` JSON row, `conversation_designations` JSON row, `conversation_tag_catalogue` JSON row, `global_tasks` JSON row), `push_subscriptions` (migration 105), `draft_prompts` auto-send columns (migration 106), `plugin_secrets` / `plugin_invocations` (migration 115), `mesh_edges` / `mesh_messages` (migration 116), `schedule_jobs.variables` (migration 120), `git_commit_drafts` (migration 121), `conversation_timers` (migration 124; snapshot columns `effort` / `options` / `attachments` / `handoff_override`, migration 125), `btw_queries.forked_conv_id` (migration 127), `conversations.capability_profile` (migration 128), `schedule_jobs.capability_profile` (migration 129), `conversations.auto_tagged_at` (migration 130; Jev auto-tag once-marker, server-internal), `conversation_timers.origin` / `conversation_timers.attempt` / `spawn_edges.outcome` + `idx_conversation_timers_auto` (migration 131; agent-resume provenance), `conversations.stopped_at` (migration 133; parent-authorized child stop), `decision_usage` (migration 134; Jev/TypeSafe System One per-call token ledger, content-free, 90-day retention; summarised on the Settings → Agent Usage Jev card, see [`docs/architecture/jev.md`](docs/architecture/jev.md)), `conversation_timers.notify_parent` (migration 135; deferred descent notify override), legacy seed-id remap (migration 136), Claude Opus 5 id remap (migration 137), `global_tasks` (migration 138), `handoffs.requested_mode` accepts `'fresh'` (migration 139; session reset; table rebuild), `mcp_servers` + `conversations.mcp_servers` (migration 140; MCP registry + per-conversation selection; secrets in `plugin_secrets` under `tierwyn:mcp`), `conversations.permission_mode` (migration 141; per-conversation permission mode), `conversations.pending_handoff_mode` (migration 142; staged `+` menu `fresh`/`summary` next-send action, cleared by the WS prompt/command/steer handler), `projects.rules` + `conversations.rules` (migration 143; operator instructions; cookie-only), `rule_presets` + `projects.rule_preset_ids` + `conversations.rule_preset_ids` (migration 144; stackable rule presets), `remote_hosts` + `projects.remote_host_id` (migration 145; Remote Hosts / `tierwyn node`), `mcp_servers.placement` (migration 146; registry MCP placement: hub vs agent's host), `projects.trust_repo_config` (migration 147; repo agent config trust gate), `remote_hosts.allow_agent_env_secrets` (migration 152; per-host gate for replicating Settings → Agents env vars to the node, default off), `memories` + `memories_fts` (migration 153; DB-backed project memories with FTS5 keyword recall), partial `events` indexes for boot reconcilers (migration 154), `projects.agent_search_scope` (migration 155; per-project agent search scope override), `conversations.effort` (migration 156; per-conversation composer effort). Registered migrations: `001_baseline.sql` only (every pre-release migration 001–156 squashed into it at release; the install's `schema_migrations` was restamped to `{1}`). Next new migration is **2**. `agents.enabled_flag` is the agent-level master switch; a disabled agent hides all its models from `/profiles` without touching per-model `enabled_flag`. Fresh installs seed every agent disabled; enabling requires the binary to be present.


### Web (React SPA)

Single `App.tsx` component manages all state. Sub-components in `apps/web/src/components/`:
- `Sidebar`: project/conversation tree, two-line title + description, live status badges
- `OutputPane`: renders `NormalisedEvent` stream (markdown via `react-markdown` + `remark-gfm`)
- `InputBar` + `CommandPicker`; prompt input, slash-command discovery and dispatch
- `ModelSelector`: picks agent profile from `/profiles`
- `UsagePanel`: token/cost/rate-limit display
- `CompactionSettings`, `CatalogueSettings`, `NotificationSettings`, `PluginSettings`, `McpServerSettings`; settings panels (notifications live under Settings → Notifications; Direct LLM tab holds unified profile editor + sidecar routing; plugins under Settings → Plugins; MCP servers under Settings → MCP Servers)
- `McpStatusChip`: live MCP status chip in the topbar header for `claude-code` sessions (connected, failed, pending, enable/disable controls)
- `HandoffChoiceModal`: lets the user pick summary vs transcript compaction mode before resuming
- `AgentActivityModal` (aliased as `ActiveAgentsModal`); cross-project Agent Activity view: in-flight and completed sessions with unread tracking, spawn tree, elapsed time, jump / stop, mark read, Active / Completed / Timed tabs
- `GlobalTasksModal`: header modal for the cross-project Global Tasks log (in progress / completed / hidden)
- `MemoriesModal`: header modal for project memories (rule suggestions / flagged / all)
- `HelpersModal`: native helpers list + thread + stop; header chip `⑂ N helpers running`
- `RecalledMemoriesChip`: collapsed/expandable transcript chip displaying memories recalled for a turn
- `FileBrowserModal`: topbar folder button / palette "File browser": per-directory listing of a conversation or project root (`GET /files/list`); files open in its own `FileModal` by relative path + root context
- `GlobalTasksSettings`: Settings → Global Tasks tab (enable, scope, stale window, auto-delete hidden)

WebSocket client in `apps/web/src/ws.ts`; REST calls in `apps/web/src/api.ts`.

### Shared package

`packages/shared/src/`:
- `domain.ts`: `Project`, `Conversation` (`description` / `descriptionSource`), `SessionMeta`, `TranscriptEvent`, `CompactionSettings`, `ResumePlan`, `NotificationSettings`
- `notifications.ts`: `buildNotification()` (shared page + push payload)
- `events.ts`: `NormalisedEvent` union and `AgentStatus`
- `adapter.ts`: `AgentAdapter` interface, `SessionConfig`, `ModelDescriptor`, `CommandDescriptor`
- `protocol.ts`: `ClientFrame` / `ServerFrame` WebSocket message types
- `promptOptions.ts`: `PromptOptionDescriptor`, `sanitisePromptOptions()`, `PromptOptions`
- `profiles.ts`: `AgentProfile` (catalogue row shape)

## Security

- **Spawn token + MCP egress**: agents in spawn-capable conversations are handed an ephemeral spawn token (minted per session, scoped to that conversation, revoked on session end; a 30-min **idle** TTL backstop that slides on session events, on every wake-up (operator or bridged steer) and while a `wait:true` spawn blocks. An expired token is reissued on the next wake with the same capability rules as session start (bare-prompt → none, spawn-eligible template → spawn set, otherwise `{schedule, plugin}`); `spawn/tokens.ts`) so they can call `POST /spawn`. There is no static `SPAWN_TOKEN` env secret. An MCP egress tool (firecrawl, playwright, n8n, etc.) still gives a prompt-injected agent a way to misuse its *live* token during the run; either spawn an attacker-chosen child or curl the token out; and a holder can spawn a `bypass`-mode child with worktree repo access. Ephemeral scoping kills the at-rest / replay-later / cross-conversation vectors but not the in-window injection, so: don't enable untrusted MCP egress in templated/spawn-capable conversations. Blast radius is capped by `MAX_SPAWN_DEPTH` (env `TIERWYN_MAX_SPAWN_DEPTH`, default 5; see `spawn/config.ts`), per-profile `maxConcurrentSpawns`/`maxGrandchildSpawns`, and worktree isolation. Live tokens and secrets are scrubbed across timers, spawn requests, tasks, notifications, and persisted events via a unified redaction filter (`secrets/redactAll.ts` composing spawn tokens, run tokens, MCP secrets, and plugin vault secrets, with cache invalidation on vault writes), so they never land in the DB file or the `/conversations/:id/transcript` REST output. A token carries a **set** of capabilities (`'spawn' | 'schedule' | 'plugin' | 'mesh' | 'tasks' | 'memory'`), not one scope string: spawn-capable conversations mint `{spawn, schedule, plugin, memory}` and every other conversation mints `{schedule, plugin, memory}` (`CONVERSATION_CAPABILITIES`; so single-agent chats can invoke enabled plugins; bare-prompt adapters still mint nothing); `'mesh'` is added to that set iff `meshMessaging !== 'off'` at mint time; `'tasks'` is added iff Global Tasks is enabled and the conversation is in scope (`roots` default: no parent). See SECURITY.md § Token capabilities. `/btw` answers run through the sidecar read-only/no-tools path and mint no token; the priming summariser is also tool-free (`toolFreeOnly`; oneShot `'none'` or a `textOnly` session on claude-code, otherwise a capped transcript).
- **Scheduler is a second agent-reachable boundary**: `POST /projects/:id/schedules/agent` is governed by `authorizeAgentScheduleCreate`, not by the spawn controls. Bearer callers are roster-locked to their own conversation's template (a template-less conversation may not name a profile at all); one-shot jobs are created enabled and self-start (unless safe mode / spawn approval is required), while interval jobs start disabled unless the operator enabled `allowAgentRecurringSchedules` in settings; complete-job auto-archives completed one-shots; bypass-only profiles are rejected at create time; `schedule_home` resets spawn-policy depth (bounded ~10/project by the job cap). Removing a conversation's template downgrades it to a `{schedule, plugin}` token rather than disarming it. See SECURITY.md § Scheduler as an agent-reachable path.
- **Cross-level messaging (Option C)**: every spawn persists a `spawn_edges` row (migration `029`) carrying the `notifyParent` preference; turns sourced `subagent_notify`/`parent_message` bridge their final prose one hop up (target = validated `replyTo` or the durable parent edge; never message content), wrapped in an UNTRUSTED frame (`spawn/prose.ts → frameSubagentProse`). `POST /spawn/:childId/message` lets a token-holder message strict descendants (T0) or, when mesh messaging is on, adjacent peers that hold a live `mesh_edges` row (`canMessage()`). Boot reconciles orphaned edges with server-authored text only.
- **Plugin credentials (phase 2)**: plugin-declared env keys (e.g. `ZAI_API_KEY`) plus `SESSION_SECRET` / `OPERATOR_PASSWORD_HASH` / `TIERWYN_PLUGIN_VAULT_KEY` are captured at boot and deleted from `process.env`; the vault encrypts UI-set values with AES-256-GCM (HKDF over `TIERWYN_PLUGIN_VAULT_KEY` or `SESSION_SECRET`). Fail-closed if the derivation secret is &lt;32 bytes. Rotating `SESSION_SECRET` invalidates operator cookies **and** every `sess:v1` vault row together; use `TIERWYN_PLUGIN_VAULT_KEY` to decouple them. `buildChildEnv()` scrubs secrets from every agent spawn (incl. the Claude Code SDK path). **Per-agent env vault:** keys stored as `env.<agentType>.<NAME>` under `tierwyn:agents` are scrubbed from every child and re-injected only for that agent type (`GET|PUT|DELETE /settings/agent-env*`). Unsandboxed agents can still read `prod.env` and decrypt the vault; sandbox closes that. Values never appear in capability responses, the preamble, or transcripts. This is disclosure-through-the-product-surface protection, **not** a boundary against same-UID `/proc/<server-pid>/environ` reads. `zai-usage` requires a dedicated `ZAI_API_KEY` and will not fall back to `OPENAI_API_KEY`. See [`docs/architecture/plugins.md`](docs/architecture/plugins.md).
- **MCP injection & secrets**: Tierwyn injects registry-configured MCP servers into supported agents (`MCP_INJECTABLE_ADAPTERS`: `claude-code`, `codex`, `qwen`, `kimi`, `kiro`, `grok-build`, `hermes`). Secret env vars and header values are stored in the encrypted vault (`tierwyn:mcp`) with boot-captured `TIERWYN_MCP_*` fallback. Secret values never touch argv: passed via `${TIERWYN_MCPV_n}` placeholders in agent config files and child env, or on ACP stdin. Persisted events redact known MCP secrets (`redactMcpSecrets`). Delegating chats drop MCP servers unless `allowInDelegating` is enabled. See SECURITY.md § MCP injection and [`docs/architecture/mcp-servers.md`](docs/architecture/mcp-servers.md).
- **Safe mode (spawn approval + capability filter)**: optional bundle, all off by default (`spawnApprovalRequired: false`, `interactionMode: 'bypass'`). When `spawnApprovalRequired` is on (global `CompactionSettings` or per-template `SpawnTemplate.spawnApprovalRequired`), bearer spawns queue as `pending` in the `spawn_requests` table (migration `025`) and only dispatch after the operator (cookie) `POST /spawn/requests/:id/approve`; `wait:true` + approval is rejected with 400 (sync wait incompatible with a gate). When `interactionMode !== 'bypass'`, bypass-only adapters (`pi`, `opencode`, `kilocode`, `cursor`, `antigravity`, `openclaw`) are greyed out in the picker, rejected at `handlePrompt` before session creation, omitted from the delegation preamble roster, and rejected at `dispatchSpawn` with 400. Permission-capable = `claude-code`, `codex`, `hermes`, `grok-build`, `kiro`, `qwen`, `kimi`, `grok-bot` (`PERMISSION_CAPABLE_ADAPTERS` in `packages/shared/src/profiles.ts`). Children **always** run `bypass` internally regardless of the parent's mode; approval is "authorize the whole sub-task", not per-tool gating for the child. Full design + threat model in `SECURITY.md` § Safe mode.
- **Remote Hosts**: a project bound to a `tierwyn node` host runs adapters on that machine over WSS `/ws/node` (max 32 pre-auth connections). Dedicated unprivileged node user; origin-bound single-use tokens (10m TTL, `autoTrust` opt-in default false); host view carries ed25519 public key fingerprint for operator verification; tunnel path allow-list (streaming `http.*` frames keep framing, allow-list, and redaction; the MCP bridge key is the only `http.head` exemption). Hub-placed stdio children get `buildChildEnv()` + vault env, never hub session secrets. `files.write` is jailed to node policy roots (lexical + realpath). `node.selfUpdate` is a fixed `tierwyn node update` argv gated by `allowSelfUpdate` (git pull or hub package swap). MCP secrets reach a trusted host only when `allow_mcp_secrets` is on (default). Per-agent vault env reaches a host only when `allow_agent_env_secrets` is on (default **off**): over TLS into node memory only, re-sent on reconnect, scrubbed from the node's other children; not a boundary against the node's user. See SECURITY.md § Remote Hosts and [`docs/architecture/remote-hosts.md`](docs/architecture/remote-hosts.md).
- **Outbound URL & SSRF prevention**: `assertOutboundUrl` and `safeFetch` in `net/outboundUrl.ts` validate outbound destinations. Blocks loopback, RFC1918, CGNAT, link-local, cloud metadata (AWS IMDS `fd00:ec2::254`, Aliyun metadata `100.100.100.200`), multicast, and IPv4-mapped/compatible IPv6 notations (`::ffff:0:0/96`, `64:ff9b::/96`) for public requests. Whitelist exceptions are configured via `TIERWYN_OUTBOUND_ALLOW`.
- **Execution environment & preview isolation**: `childEnv.ts` scrubs dangerous execution hijack variables (`NPM_CONFIG_*`, `GIT_SEQUENCE_EDITOR`, `LESSOPEN`, `GOFLAGS`, etc.). HTML preview mockups enforce a strict iframe CSP (`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-src 'none';`) in `htmlMock.ts`. Antigravity `upgradeUri` strictly enforces `https:` scheme.

## Environment

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Never set to `0.0.0.0`; use a reverse proxy |
| `PORT` | `8787` | |
| `TIERWYN_DB` | `./data/tierwyn.db` | SQLite file path |
| `OPERATOR_PASSWORD_HASH` |; | argon2id hash; generate with the command in `.env.example` |
| `SESSION_SECRET` |; | ≥32-byte random string for HMAC cookie signing |
| `AUTH_DISABLED` | unset | `true` for local dev only; removes all auth. Refuses non-loopback bind unless `TIERWYN_ALLOW_AUTH_DISABLED_NONLOCAL=1` |
| `COOKIE_SECURE` | `true` | Set `false` for plain-HTTP localhost dev |
| `TIERWYN_OUTBOUND_ALLOW` | unset | Comma-separated hostnames or CIDRs allowed to bypass SSRF outbound IP blocklist |
| `TIERWYN_GIT_RUN_HOOKS` | unset | Set to `1` to allow running git hooks on operator UI commits (bypasses `core.hooksPath=/dev/null`) |
| `TIERWYN_PROJECT_ROOTS` | unset (home) | Allowed project roots for local clone, folder browsing, and creation (colon-separated absolute paths; empty string disables) |
| `TIERWYN_AGENT_SELF_TIMERS` | `level0` | Who may self-schedule: level0 (roots), all, off |
| `TIERWYN_GROKBOT_CDP_PORT` | `9333` | Loopback CDP port for the Grok Bot sidecar. |
| `TIERWYN_GROKBOT_IDLE_MS` | `8000` | Replica-poll idle window before a grok-bot turn is treated as settled. |
| `TIERWYN_GROKBOT_WATCH_MS` | `25000` | Inbound watcher roster-poll interval for unsolicited Bot messages. |
| `TIERWYN_GROKBOT_REPLY_LEASE_MS` | `3600000` | How long a chat that prompted a Bot keeps receiving its late replies before they return to the Remote Agents container. 0 = always the container. |
| `TIERWYN_GROKBOT_WATCH` | unset (on) | Set to `0` to disable the Grok Bot inbound watcher. |
| `TIERWYN_GROKBOT_AUTOSTART` | unset (on) | Set to `0` to kill launching (manual included). Omit in prod so policy can start the app. |
| `TIERWYN_GROKBOT_BIN` | `/opt/Grok Bot/grok-bot` | Absolute path of the desktop binary. |
| `TIERWYN_GROKBOT_UNIT` | `tierwyn-grokbot.service` | systemd user unit name for launcher 1. |

## Production deployment

Two instances (dev + prod), by convention on one host, split by env file + port + DB:

| | Dev | Prod |
|---|---|---|
| Env | repo `.env` (`AUTH_DISABLED=true`) | dedicated prod env file outside the repo (convention: `/etc/tierwyn/prod.env`), 600, owned by the user running the units |
| PORT | 8787 | 8788 |
| `TIERWYN_DB` | `./data/tierwyn.db` | `./data/prod.db` |
| Frontend | `npm run dev` (Vite 5173) | `npm run preview` (Vite 4173, `--host 0.0.0.0`) |
| Daemon | terminal | `tierwyn-prod.service` + `tierwyn-prod-web.service` (user systemd units; templates in `docs/deploy/systemd/`) |
| Optional TTS |; | `tierwyn-piper.service` and/or `tierwyn-kokoro.service` (operator sidecars; see below) |

Reverse proxy: a TLS reverse proxy (e.g. Nginx, Caddy, Nginx Proxy Manager) forwarding your Tierwyn domain → the prod host's `:4173`, with WebSocket upgrade enabled (the `/ws` upgrade must pass through).

### Build + start (prod)

```bash
# First-time / unit install (if units missing):
#   cp docs/deploy/systemd/tierwyn-*.service ~/.config/systemd/user/
#   systemctl --user daemon-reload
#   systemctl --user enable --now tierwyn-prod.service tierwyn-prod-web.service
# Piper TTS (optional but required when Settings provider is "piper"):
#   systemctl --user enable --now tierwyn-piper.service
# Kokoro TTS (optional but required when Settings provider is "kokoro"; native venv, cpu/cuda/rocm):
#   tierwyn sidecars   # → Kokoro

# Routine deploy restart (build all workspaces + restart API + web):
npm run deploy:prod:full
```

Full sidecar install + glue model: **[docs/deploy/operator-sidecars.md](docs/deploy/operator-sidecars.md)**.
Unit templates: **[docs/deploy/systemd/](docs/deploy/systemd/)**.

### Known prod-only behaviour / gotchas

- **`allowedHosts` in `apps/web/vite.config.ts`**: Vite preview rejects unknown Host headers; behind a reverse proxy the browser sends the external domain. Gate it with `TIERWYN_ALLOWED_HOSTS`: unset → Vite default (localhost + IPs); `true`/`all` → allow any Host; otherwise a comma-separated hostname list. The prod-web unit ships `Environment=TIERWYN_ALLOWED_HOSTS=true`; narrow it to your domain. The live unit (`~/.config/systemd/user/tierwyn-prod-web.service`) needs the same line before the next web restart.
- **`--host 0.0.0.0` on the preview unit**: `tierwyn-prod-web.service` ExecStart must bind 0.0.0.0, not the Vite default 127.0.0.1. `daemon-reload + restart` after editing.
- **`EnvironmentFile` ownership**: the prod env file (e.g. `/etc/tierwyn/prod.env`) must be readable by the UID running the user systemd unit (own it by that user, keep 600). Root-owned files cause `Result: resources` start failures.
- **`PATH` in prod.env**: systemd user units do NOT inherit your interactive shell PATH. Agent CLIs land in install-specific dirs that the unit's default PATH omits: `npm i -g` → `~/.npm-global/bin` (openclaw installs here), etc. Symptom: `spawn <agent> ENOENT` when launching a chat, even though `which <agent>` finds it in your terminal (because `.bashrc` adds the dir). Fix: add a `PATH=...` line to your prod env file listing every dir that holds an agent CLI, then `systemctl --user restart tierwyn-prod.service`. Template + verify command live in `.env.example`.
- **`COOKIE_SECURE` over direct HTTP**: secure cookies are dropped by the browser on plain HTTP → login loops back. Set `false` for direct-HTTP testing; flip to `true` behind TLS.
- **`TRUST_PROXY` behind reverse proxy**: `apps/server/src/index.ts` sets `app.set('trust proxy', ...)` from `TRUST_PROXY`: unset → `'loopback'`, a pure integer → hop count, anything else → Express trust list. Recommended: list the trusted proxies explicitly (e.g. `TRUST_PROXY=loopback,<reverse-proxy-ip>`); avoid hop counts when Vite preview (`xfwd`) sits between the external reverse proxy and the API, because `1` makes every client look like the proxy IP and lets one attacker lock out login. Keep `HOST=127.0.0.1` (never expose `:8788` directly; a direct client could forge `X-Forwarded-For`).
- **`SESSION_SECRET` vs `OPERATOR_PASSWORD_HASH`**: easy to swap on paste. SESSION_SECRET is opaque base64 from `openssl rand -base64 32`; OPERATOR_PASSWORD_HASH starts with `$argon2id$`.
- **`vite.config.ts` carries prod-critical changes** (preview block, `/ws` through same host). It is tracked; a `git checkout .` / `git reset --hard` that clobbers an uncommitted `apps/web/vite.config.ts` takes prod web down on next restart. `apps/web/src/ws.ts` is committed on main (including the additive `grokbot_status` dispatch); that stale "uncommitted prod-critical edit" warning no longer applies to it.
- **Never run destructive git on `main` while prod is live**: `git checkout .`, `git reset --hard`, `git clean -fd`, branch switch that touches `apps/web/vite.config.ts`. These clobber uncommitted prod-critical edits and the next `tierwyn-prod-web.service` restart serves a broken SPA. If you need to branch, commit `vite.config.ts` first.
- **Rate limiter**: in-memory, ~5 failures per 15 min on `/auth/login`. Restarts clear it.

Full deployment walkthrough: **[docs/deploy/deployment.md](docs/deploy/deployment.md)**.  
Operator sidecars (Piper + Kokoro + systemd glue): **[docs/deploy/operator-sidecars.md](docs/deploy/operator-sidecars.md)**.

### Piper TTS multi-voice (operator-managed)

**Tierwyn does not start Piper.** The API only proxies to Settings `tts.piperUrl` (default `http://127.0.0.1:5000`) and reports `piperUp` via TCP probe. If the user unit is missing/stopped, the UI stays on provider “piper” but playback falls back to browser TTS.

Piper is **not** stock `python -m piper.http_server -m <one-voice>`. The operator runs a small Flask wrapper that lazy-loads voices from disk; switch voices in the UI with no restart.

| Path | Purpose |
|---|---|
| `docs/deploy/piper/server.py` | **Versioned** wrapper source (copy into `~/tierwyn-piper/`) |
| `docs/deploy/systemd/tierwyn-piper.service` | **Versioned** unit template |
| `~/tierwyn-piper/server.py` | Live wrapper on the host |
| `~/piper-venv/` | Python venv with `piper-tts` + `flask` |
| `~/piper-voices/*.onnx` (+ sibling `.onnx.json`) | Voice models on disk |
| `~/.config/systemd/user/tierwyn-piper.service` | Enabled user unit → bind `127.0.0.1:5000` |

**Install / enable (summary):** see [docs/deploy/operator-sidecars.md](docs/deploy/operator-sidecars.md) § Piper. Short path:

```bash
python3 -m venv ~/piper-venv && ~/piper-venv/bin/pip install piper-tts flask
mkdir -p ~/tierwyn-piper ~/piper-voices
cp docs/deploy/piper/server.py ~/tierwyn-piper/server.py
cp docs/deploy/systemd/tierwyn-piper.service ~/.config/systemd/user/
loginctl enable-linger "$USER"   # once; units survive logout
systemctl --user daemon-reload
systemctl --user enable --now tierwyn-piper.service
curl -s http://127.0.0.1:5000/voices   # expect JSON stems
```

HF download convention (in-UI catalogue): `https://huggingface.co/rhasspy/piper-voices/resolve/main/<lang>/<locale>/<name>/<quality>/<id>.onnx` (+ `.onnx.json`). Downloads land in `~/piper-voices/`.

Before first install, stop any legacy one-voice server: `pkill -f 'piper.http_server'` then `ss -tlnp | grep 5000`.

### Kokoro TTS (operator-managed)

**Tierwyn does not start Kokoro.** The API only proxies to Settings `tts.kokoroUrl` (default `http://127.0.0.1:8880`) and reports `kokoroUp` via TCP probe. If the unit is missing/stopped, the UI stays on provider “kokoro” but playback falls back to browser TTS.

**Native, no Docker.** `docs/deploy/kokoro/server.py` is a stdlib HTTP wrapper around the PyPI `kokoro` package (OpenAI-compatible subset: `POST /v1/audio/speech` → WAV, `GET /v1/audio/voices`, `GET /health`). `tierwyn sidecars` → Kokoro detects the GPU but lets the operator pick **cpu / cuda / rocm** (`TIERWYN_KOKORO_PROFILE` skips the prompt), builds a uv Python 3.12 venv (kokoro needs <3.13) with the matching PyTorch index (`cpu`, `cu130`/`cu126`, `rocm7.1`), and writes `~/.config/tierwyn/kokoro.env`. Weights + voices download from Hugging Face on first start. zh voices come from `misaki[zh]` (pure Python). ja voices are best-effort: `misaki[ja]` needs `pyopenjtalk`, which has no wheel and compiles with cmake + g++; without a toolchain the installer skips it and the server drops `j` voices. When it does install, `unidic` must be **uninstalled** in favour of `unidic-lite` (no dictionary until a separate 500 MB download, so MeCab init fails). The port only opens after a warm-up synthesis. Runs in parallel with Piper on port 8880.

| Path | Purpose |
|---|---|
| `docs/deploy/kokoro/server.py` | **Versioned** wrapper source (copied to `~/tierwyn-kokoro/`) |
| `docs/deploy/systemd/tierwyn-kokoro.service` | **Versioned** unit template |
| `~/kokoro-venv/` | Python 3.12 venv; `.tierwyn-torch` records the installed PyTorch index |
| `~/.config/tierwyn/kokoro.env` | `KOKORO_DEVICE=cpu` or `cuda` (+ ROCm vars); edit + restart to switch |
| `~/.cache/huggingface/` | Model weights + voice packs |

Pick the device profile (**cpu / cuda / rocm**) at install; verify:

```bash
curl -s http://127.0.0.1:8880/health   # {"status": "healthy", "device": "cpu"}
curl -s -X POST http://127.0.0.1:8880/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"input":"hello","voice":"af_heart"}' -o /tmp/k.wav && file /tmp/k.wav   # WAVE
```

Default Settings voice: `af_heart`. Runbook: [docs/deploy/operator-sidecars.md](docs/deploy/operator-sidecars.md) § Kokoro.

## Adding a new adapter

1. Create `apps/server/src/adapters/<name>/index.ts` implementing `AgentAdapter`.
2. Register it in `apps/server/src/index.ts` via `registry.register('<name>', () => new MyAdapter())` and add it to `discoverableAgents`.
3. Add a default binary entry in `apps/server/src/discovery.ts` (`AGENT_BINARIES`).
4. Seed initial profiles in `apps/server/src/db/seed.ts` or add a migration.

## Adding a DB migration

Add a new sequentially-numbered `.sql` file in `apps/server/src/db/migrations/` and register it in
`apps/server/src/db/migrations/index.ts` (the array is hand-maintained; dropping a file in does
nothing). Migrations run automatically at server boot, each applied exactly once.

**The whole schema is `001_baseline.sql` (version 1, the only registered migration).** Every pre-release migration (legacy 001–042 and 100–156) was squashed into it at release; their SQL is in git history. The existing install's `schema_migrations` was restamped to the single row `1` and its schema verified identical to the baseline (orphan `conversations.preferred_profile_id` dropped). Next new migration is **2**.

The baseline is generated, not hand-written: replay the chain into an in-memory DB and serialise
`sqlite_master` (FTS5 shadow tables excluded). It is idempotent (`CREATE … IF NOT EXISTS` only),
so it is a no-op against any DB that already has the schema. New migrations need no such constraint.


## Documentation layout

| Kind | Path | Repo |
|---|---|---|
| Spawn task + RESULT handoff | `.tierwyn/delegates/<role>-<slug>.md` (+ `-RESULT.md`) | Untracked (gitignored) |
| Product architecture / deploy | `docs/architecture/`, `docs/deploy/` | Main Tierwyn repo |
| Agent instructions | `AGENTS.md`, `CLAUDE.md` | Main Tierwyn repo |

**Write rules for agents:**

- Ephemeral spawn plumbing → `.tierwyn/delegates/` only.
- Product architecture, deployment guides, user-facing docs → `docs/`. Never put temporary session output here.
- If `CLAUDE.local.md` or `AGENTS.local.md` is present in the workspace root, follow its operator-specific local environment rules.

Product docs index: [`docs/README.md`](docs/README.md).
