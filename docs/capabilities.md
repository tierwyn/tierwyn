# Tierwyn capabilities

Operator-facing map of what Tierwyn does. **Not** an API reference and **not** a full manual.

| | |
|---|---|
| **Audience** | Self-host operators, future contributors |
| **Source of truth** | Running UI + `apps/web` / `apps/server` / `packages/shared` |

---

## At a glance

| Area | What you get |
|---|---|
| **Agents** | Drive local coding CLIs from one browser UI |
| **Projects & chats** | Tree of projects → conversations, live status, persistence in SQLite |
| **Delegation** | Parent agents spawn children via templates + short-lived tokens |
| **Schedules** | Project jobs (interval/cron/once) with multi-step plans |
| **Voice** | Dictation (STT) in, TTS out (browser / Piper / Kokoro) |
| **Safety** | Single-operator auth, optional permission modes + spawn approval |
| **Notifications** | Opt-in OS / PWA alerts for completions and schedule events |
| **Ops** | Same-machine prod deploy, reverse proxy, optional TTS sidecars |

Tierwyn is a **single-operator command centre**, not a multi-tenant hosted sandbox. Agents typically run with full local privileges unless you tighten interaction mode. Read [SECURITY.md](../SECURITY.md) before network exposure.

---

## Core workspace

| Capability | What it does | Where in UI | Deeper doc / code |
|---|---|---|---|
| **Projects** | Group conversations and schedules; optional project path / shell allow-list | Sidebar → Projects | `POST/GET/DELETE /projects` |
| **Conversations** | Chat sessions with transcript persistence, rename, delete, mark unread | Sidebar tree | `routes/conversations.ts` |
| **Titles vs descriptions** | Spawn title stays `↳ Role`; one-line description from the first prompt | Sidebar two lines; header subtitle; edit modal | [conversation-descriptions.md](architecture/conversation-descriptions.md) |
| **Designations** | Optional function chip per conversation (`orchestrator`, `planner`, …); built-ins in code, customs in Settings | Conversation chip; Settings → Templates → Designations | [cross-agent-spawn.md](architecture/cross-agent-spawn.md) § Conversation designations |
| **Live status dots** | Running / idle / error-style indicators on conversations and schedule runs | Sidebar | Status + WS events |
| **Agent activity** | In-flight and completed sessions across all projects as spawn trees; elapsed time, jump to conversation, stop, mark read | Header → **Agent activity** button | `GET /sessions/active`, `AgentActivityModal` |
| **Command palette & message search** | `Ctrl/Cmd+K` jumps to chats, projects and actions; `Ctrl/Cmd+Shift+F` (or a `? ` prefix) searches message text across conversations, including spawn-child chats and native helper snapshots | Palette overlay | `GET /conversations/search`; `apps/web/src/commandPalette.ts`; [agent-search.md](architecture/agent-search.md) |
| **Find in transcript** | Find bar over the open conversation (visible user/assistant cards) | `Ctrl/Cmd+F`; ⋮ menu on mobile | `TranscriptFindBar`; [agent-search.md](architecture/agent-search.md) § Transcript search |
| **Global Tasks** | Cross-project log of agent work: in progress, completed, hidden | Header modal; Settings → Global Tasks | [global-tasks.md](architecture/global-tasks.md) |
| **Archive conversations** | Soft-hide finished chats from the sidebar without deleting; archived roots are exempt from the retention purge | Conversation ⋯ menu / bulk bar; archive toggle in sidebar header | [conversation-retention.md](architecture/conversation-retention.md) |
| **Spawn children in tree** | Fold/unfold child conversations under parents | Sidebar fold controls | Spawn edges |
| **Schedules tree** | Jobs and runs alongside chats | Sidebar → Schedules tab | [scheduled-jobs.md](architecture/scheduled-jobs.md) |
| **Transcript / events** | Normalized stream: messages, tools, file changes, status | Main output pane | `packages/shared` events |
| **Markdown rendering** | GFM markdown, code, mermaid, images | Output pane | `MarkdownBody`, `MermaidBlock` |
| **Tool collapsing** | Collapsible tool call / result blocks | Output pane | `EventItem`, `ToolInputDisplay` |
| **Usage panel** | Tokens / cost / rate-limit style stats when available | Usage UI | `GET …/usage` |
| **Drafts** | Unsent prompt text (and attachments) persisted per conversation | Input bar | draft routes on conversations |
| **Login / session** | Cookie auth (argon2 + HMAC); optional `AUTH_DISABLED` for local dev only | Login screen | [SECURITY.md](../SECURITY.md), `auth/` |

---

## Agents & models

| Capability | What it does | Where in UI | Notes |
|---|---|---|---|
| **Multi-adapter runtime** | Pluggable CLIs behind one event model | Profile / model picker | Registered types include: `claude-code`, `pi`, `antigravity`, `opencode`, `kilocode`, `cursor`, `hermes`, `codex`, `grok-build`, `kiro`, `qwen`, `openclaw`, `kimi`, `copilot`, `deepseek`, `grok-bot` (plus discovery of installed binaries) |
| **Profile catalogue** | Enable/disable profiles, wire agent type → binary/settings | Settings → Agents | `routes/catalogue.ts`, seed profiles |
| **Model discovery** | Periodic `listModels` into catalogue + how to add models per agent (auto vs manual) | Settings / picker | [model-discovery.md](architecture/model-discovery.md) |
| **Command discovery** | Slash / agent commands where supported | Command picker | [command-discovery.md](architecture/command-discovery.md), [agent-commands-discovery.md](architecture/agent-commands-discovery.md) |
| **Interaction mode** | `bypass` · `questions` · `prompt` | Settings → General (and per conversation where applied) | Full `prompt` mode needs permission-capable adapters (`claude-code`, `codex`, `hermes`, `grok-build`, `kiro`, `qwen`, `kimi`, `grok-bot`) |
| **Effort / thinking level** | Per-adapter effort where CLI supports it, saved per conversation | Effort control near model | Levels vary by adapter (`packages/shared` `effortLevelsFor`) |
| **Vision / images** | Attach images when profile + adapter support vision | Attach on input | Annotate via image annotator |
| **File attachments** | Non-image files on prompts | Attach any file | Served via files routes when previewing |
| **Slash commands** | Native agent slash commands (capability-gated) | `/` command picker | Not all agent types support them |

Adapter set and install hints: `apps/server/src/discovery.ts`, `apps/server/src/index.ts` registry.

---

## Conversation control

| Capability | What it does | Where in UI | Deeper doc / code |
|---|---|---|---|
| **Prompt / stop** | Send user turns; stop in-flight generation | Input bar | WS `prompt` / `stop` frames |
| **Steer (live inject)** | Mid-turn text into live process (capable adapters) | Send while running | Claude Code, Codex, Pi; see README steer table |
| **Force steer** | Queue vs Interrupt & Send (soft cancel or hard stop + reinject) | Steer choice modal | `steerClass` / `forceMechanism` in `profiles.ts` |
| **Queue** | Hold mid-turn messages until session ends, then follow-up | Same input path on non-steerable agents | Hermes, Cursor, etc. (adapter-dependent) |
| **Compaction / handoff** | Resume across context limits: summary, transcript, or ask | Settings → Compaction; handoff modals | [handoffs.md](architecture/handoffs.md) |
| **Fork conversation** | Branch a conversation (first send always asks handoff mode) | Conversation actions | `POST …/fork`; [handoffs.md](architecture/handoffs.md#fork-at-event-transcript-branch) |
| **Checkpoints** | Named restore points; code diff; restore conversation and/or files | Checkpoint list → Restore… | [checkpoints.md](architecture/checkpoints.md) |
| **Excise turn** | Surgical remove of a turn (and related cleanup) | Conversation tooling | `…/excise-turn` |
| **Handoff history / summaries** | View prior handoff summaries | Summary list / handoff modals | [handoffs.md](architecture/handoffs.md); summaries routes |
| **Copy / export helpers** | Copy conversation content | Copy modal | Web UI |
| **Markdown file list** | Project markdown listing helpers | Markdown list modal | files + UI |
| **Project files browser** | Browse a conversation or project root by directory and open files | Topbar folder button; palette → File browser | `FileBrowserModal`, `GET /files/list` |
| **Image album** | Several images from one turn open as an album with prev/next and a filmstrip | Turn file previews → File modal | `FileModal` |
| **Conversation timers** | Send a prompt into a conversation later; agents can set self-timers | Prompt timer modal; Agent Activity → Timed | [conversation-timers.md](architecture/conversation-timers.md) |
| **Native helpers** | Live list of an agent's own CLI helpers (`Agent` / `Task`); not Tierwyn spawn children; with thread and stop | Header chip `⑂ N helpers running` | [helpers.md](architecture/helpers.md) |

---

## Cross-agent spawn & templates

| Capability | What it does | Where in UI | Deeper doc / code |
|---|---|---|---|
| **Spawn templates** | Named roster of roles → profiles; injected preamble | Settings → Templates | [cross-agent-spawn.md](architecture/cross-agent-spawn.md) |
| **Role / when presets** | Reusable “when to use which role” snippets | Settings → Templates (presets) | role-presets settings |
| **`POST /spawn` / `/spawn/raw`** | Parent (bearer token) creates child conversation | Agent-driven; Subagent panel | Ephemeral token per session |
| **Spawn approval (safe mode)** | Operator approve/deny pending spawns | Spawn approval modal | [SECURITY.md](../SECURITY.md) § Safe mode |
| **Child result / notify** | Parent receives child completion prose | Parent transcript | `GET /spawn/:id/result`, notify edges |
| **Downward message** | Parent → strict descendant message | Agent API | `POST /spawn/:id/message` |
| **Worktree / depth caps** | Isolation and max spawn depth | Config / templates | Spawn config, env `TIERWYN_MAX_SPAWN_DEPTH` |

Agents write long tasks under `.tierwyn/delegates/` and post with `/spawn/raw` so prompts avoid shell quoting. That directory is gitignored (ephemeral).

---

## Context, extensions & hosts

| Capability | What it does | Where in UI | Deeper doc / code |
|---|---|---|---|
| **Operator rules** | Project and conversation instructions plus stackable presets, injected into the preamble | Rules modal; Settings → Rule Presets | [operator-rules.md](architecture/operator-rules.md) |
| **Project memories** | Agent-saved project notes recalled by topic; operator approves, edits, dismisses | Header Memories modal | [project-memory.md](architecture/project-memory.md) |
| **Agent history search** | Agents search past transcripts (including spawn-child chats), scoped off / project / all | Settings → General; Edit project | [agent-search.md](architecture/agent-search.md) |
| **MCP servers** | Central MCP registry injected per conversation; secrets in the vault | Settings → MCP Servers | [mcp-servers.md](architecture/mcp-servers.md) |
| **Plugins** | Per-instance ESM plugins agents can call | Settings → Plugins | [plugins.md](architecture/plugins.md) |
| **Sandbox** | Optional bwrap isolation per agent process | Settings → Sandbox; per conversation | [sandbox.md](architecture/sandbox.md) |
| **Remote Hosts** | Run a project's agents on another machine via `tierwyn node` | Settings → Remote Hosts | [remote-hosts.md](architecture/remote-hosts.md) |

---

## Scheduled jobs

| Capability | What it does | Where in UI | Deeper doc / code |
|---|---|---|---|
| **Project schedules** | Interval, cron, or once jobs | Sidebar Schedules; Schedule browser | [scheduled-jobs.md](architecture/scheduled-jobs.md) |
| **Plan steps** | Durable ordered work units | Edit steps in schedule UI | Steps API on `/schedules/:jobId/steps` |
| **Prompt template** | Standing envelope for each tick | Edit schedule | `{{step.*}}` placeholders |
| **Context for next run** | One-shot sticky note for next tick | Schedule UI | Consumed once |
| **Agent-created schedules** | Agents create jobs via help + create endpoint | Agent tools | [agent-schedule-discoverability.md](architecture/agent-schedule-discoverability.md), `GET /agent/schedule-help` |
| **Overlap / queue policy** | Behaviour when a tick fires while previous still running | Scheduler implementation | See scheduled-jobs doc |
| **Pause / complete job** | Operator or agent control of job lifecycle | Schedule UI + agent footer | complete-job, pause-request |

Selecting a job opens the **Schedule browser** (not a normal chat). Runs still produce conversations you can inspect.

---

## Notifications (browser / PWA)

| Capability | What it does | Where in UI | Deeper doc / code |
|---|---|---|---|
| **Conversation complete** | OS toast when a root, spawn child, or other chat reaches `done` / `error` | Settings → General → Notifications (opt-in) | [browser-notifications.md](architecture/browser-notifications.md) |
| **Schedule fired / ended / auto-disabled** | Toast on dispatch (includes run start), terminal run, `once` auto-disable | Same settings | Fire + start are **one** notification |
| **View-aware suppress** | No toast for the conversation you are looking at; no toast for old finished chats you click | Client dispatcher | Armed on `running`/`waiting` only |
| **Web Push** | Notify when the PWA is closed / killed (iOS: installed PWA) | “Receive notifications when the app is closed” | `web-push` |
| **HTTPS required** | `Notification` / SW / Push need a secure context | Settings shows a notice on plain HTTP | Reverse-proxy hostname |

Off by default. Cookie-auth only for subscribe. Bodies never include prompts or tokens; they append "· <description|project>"; see [browser-notifications.md](architecture/browser-notifications.md).

---

## Voice: dictation (in) and TTS (out)

| Capability | What it does | Where in UI | Deeper doc / code |
|---|---|---|---|
| **Dictation / STT** | Mic → text into the composer (whisper-cli, or browser Web Speech) | Mic / dictation strip | `POST /transcribe`, Settings → Voice |
| **Dictation modes** | Whisper **Fast** (raw) vs **Slow** (cleanup only, or one-shot **enhance with context**) | Fast/Slow strip; Slow modal after snap | [dictation.md](architecture/dictation.md) |
| **TTS providers** | Browser `speechSynthesis`, **Piper**, or **Kokoro** | Settings → Voice | [operator-sidecars.md](deploy/operator-sidecars.md) |
| **TTS speak** | Speak assistant (or scoped) text | Speak icons / scope modals | `routes/tts.ts` |
| **TTS park player** | Park/queue playback | Park bar | Web `ttsParkPlayer` |
| **TTS recordings** | Saved WAV clips; project association | Recordings modal / tree | TTS recordings repository |
| **Voice cleanup LLM** | Optional LLM polish of transcripts | Voice settings | Separate from enhance |
| **TTS LLM summarize** | Optional summarize-before-speak | Voice / TTS prompts | TtsPromptManager |

Tierwyn does **not** start Piper/Kokoro; those are operator systemd sidecars. If a provider is selected but the sidecar is down, the UI may fall back to browser TTS.

---

## Prompt helpers

| Capability | What it does | Where in UI | Notes |
|---|---|---|---|
| **Prompt enhance** | LLM rewrite of draft (quick / context-aware) | ✨ on input bar; Settings → General → Prompt enhancer | Same LLM writes first-prompt **conversation descriptions** unless that toggle is off |
| **BTW (side question)** | Ephemeral context-aware side question without derailing main turn | BTW control | Settings → Sidecar LLMs → BTW side question (answerer + priming); `routes/btw.ts`; [handoffs.md](architecture/handoffs.md#btw-one-shot-side-question) |
| **Saved prompts library** | Built-in presets + your own prompts; `{{variable}}` fill modal (roster-backed role dropdowns), pack import/export | Input bar → prompts button | [prompt-collection.md](architecture/prompt-collection.md) |
| **Command picker** | Slash commands and shell commands | `/` picker | Capability-gated per agent |
| **Operator shell** | Run allow-listed shell from UI/agent context | Shell picker; project shell allow-list | `routes/shell.ts`, Shell allow modal on project |
| **Image annotation** | Draw/mark on attached images before send | Annotate on thumbnails | `ImageAnnotator` |

---

## Safety & auth (summary)

| Capability | What it does | Where | Deeper doc |
|---|---|---|---|
| **Single-operator cookie auth** | Login required unless `AUTH_DISABLED` | Login | [SECURITY.md](../SECURITY.md) |
| **Ephemeral spawn tokens** | Scoped bearer for `POST /spawn`; not a static secret | Injected to agents | SECURITY § spawn |
| **Spawn approval gate** | Optional queue until operator approves | Settings + modal | Safe mode |
| **Permission-capable filter** | Hide/reject bypass-only agents in full prompt mode | Picker + server | `PERMISSION_CAPABLE_ADAPTERS` |
| **Token redaction** | Live spawn tokens scrubbed from persisted events | Server | events repository |
| **Shell allow-list** | Per-project command patterns | Project shell allow UI | shell routes |

Default posture is powerful (local bypass). Harden before LAN/VPN exposure.

---

## Deploy & operations

| Capability | What it does | Where | Deeper doc |
|---|---|---|---|
| **Dev stack** | API `:8787` + Vite `:5173` | `npm run dev` | [README](../README.md) |
| **Prod stack** | API + Vite preview, user systemd units | `npm run deploy:prod:full` | [deployment.md](deploy/deployment.md) |
| **Reverse proxy / TLS** | External hostname → preview + WebSocket | NPM / Caddy / nginx examples | `docs/deploy/*` |
| **TTS sidecars** | Piper `:5000`, Kokoro `:8880` | systemd templates | [operator-sidecars.md](deploy/operator-sidecars.md) |
| **Health** | Liveness endpoint | `GET /health` | `routes/health.ts` |

---

## What Tierwyn is not

| Not in scope (today) | |
|---|---|
| Multi-user / multi-tenant SaaS | Single operator model |
| A hosted sandbox | CLIs run on machines you own with your user privileges; bwrap sandboxing is optional |
| Public stable HTTP API product | REST/WS exist for the SPA and agents; no OpenAPI catalog on purpose |
| Starting Piper/Kokoro for you | Operator-managed sidecars only |

---

## How this doc is maintained

1. When a **user-visible** capability ships, add or fix **one row** here (2 minutes).
2. Verify against **UI + code**.
3. Link to architecture/deploy/SECURITY for depth; don’t duplicate long threat models.
4. Optional quarterly pass: walk Settings tabs + Sidebar + Input bar vs this table.

Related:

- [README](../README.md); front door  
- [docs/README](README.md); product docs index  
- [SECURITY.md](../SECURITY.md); threat model  
- [CLAUDE.md](../CLAUDE.md); developer / agent in-repo guide  
