# Tierwyn Documentation

*Tierwyn: Tiers of agents. Stack the wins.*

Single documentation hub for Tierwyn product and architecture documentation. Every page below is
reachable from this index.

## Getting Started

- **[Local Setup Tutorial](getting-started/README.md)**: step-by-step install, first run, and verification

## How-to Guides

- **[Build Monorepo Workspaces](guides/manage-monorepo-builds.md)**: compile packages and manage shared contracts
- **[Deploy to Production](guides/deploy-to-production.md)**: build and run production instances with systemd
- **[Add a Database Migration](guides/add-database-migration.md)**: author and register versioned SQLite migrations
- **[Run the Test Suite](guides/run-test-suite.md)**: execute workspace tests and type checks
- **[Configure TTS Sidecars](guides/configure-tts-sidecars.md)**: run Piper and Kokoro speech services

## Reference

- **[Configuration & Environment](reference/configuration.md)**: every environment variable and configuration key
- **[Monorepo Packages & Interfaces](reference/packages.md)**: generated package map, workspace topology, module interfaces
- **[Capabilities](capabilities.md)**: feature and capability map across agents and subsystems
- **Third-party licences**: see the [README Third-party licences](../README.md#third-party-licences) section (Tierwyn MIT; `@anthropic-ai/claude-agent-sdk` proprietary)

## Troubleshooting

- **[Symptom → Cause → Fix](troubleshooting.md)**: verified failure modes, each traceable to a real error

## Architecture

- **[System Overview](architecture/overview.md)**: component map, request flows, and domain model

### Subsystems

- **[Scheduled Jobs](architecture/scheduled-jobs.md)**: tick prompt construction and operator edits
- **[Schedule Packs](architecture/schedule-packs.md)**: reusable job templates
- **[Agent Schedule Discoverability](architecture/agent-schedule-discoverability.md)**: how agents discover their schedules
- **[Agent Adapters](architecture/agent-adapters.md)**: runtime architecture, execution models, MCP handling, and capabilities across all 16 adapters (15 agent CLIs + the Grok Bot desktop app)
- **[Cross-Agent Spawning](architecture/cross-agent-spawn.md)**: delegation between different agent CLIs
- **[Helpers](architecture/helpers.md)**: native CLI subagents (Claude Code `task_*`) vs Tierwyn spawn children
- **[Agent Mesh](architecture/agent-mesh.md)**: subtree awareness and lateral peer messaging over live edges
- **[Agent Mesh Testing](architecture/agent-mesh-testing.md)**: hands-on test plan and paste-ready agent prompt for the mesh
- **[Handoffs](architecture/handoffs.md)**: conversation handoff between agents
- **[Compaction & Resume Plans](architecture/compaction-resume.md)**: how each turn picks native / transcript / compacted / fresh context, settings, and fallbacks
- **[Checkpoints](architecture/checkpoints.md)**: restore transcript and/or project files to a prior turn
- **[Git working tree panel](architecture/git-working-tree-panel.md)**: operator stage/unstage/commit UI for project worktrees
- **[Git Server Operations](architecture/git-server-ops.md)**: `/files/working-tree*` and git history/branch routes: validation, live-agent 409s, remote-host RPC
- **[Command Discovery](architecture/command-discovery.md)**: how Tierwyn finds agent CLIs and their commands
- **[Agent Commands Discovery (early spike)](architecture/agent-commands-discovery.md)**: pre-implementation feasibility notes
- **[Model Discovery](architecture/model-discovery.md)**: picker sources per agent
- **[Agent Usage](architecture/agent-usage.md)**: usage tracking across agents
- **[MCP Servers](architecture/mcp-servers.md)**: central MCP server registry, per-conversation injection, encrypted vault secrets, and native viewer
- **[Plugins](architecture/plugins.md)**: per-instance ESM plugins, encrypted vault + env fallback, child-env scrub (phase 2)
- **[Project memories](architecture/project-memory.md)**: database-backed topic-recalled notes saved by agents and managed by operator
- **[Agent history search](architecture/agent-search.md)**: agent conversation-history search: global + per-project scope, sandbox cap, preamble wording
- **[Operator rules](architecture/operator-rules.md)**: project + ancestor-chain conversation instructions, cookie-only, injected into preambles
- **[Plugin Authoring Guide](architecture/plugin-authoring.md)**: authoring, packaging, runtime import, and API contract for Tierwyn plugins
- **[Conversation Descriptions](architecture/conversation-descriptions.md)**: first-prompt one-line descriptions
- **[Conversation Timers](architecture/conversation-timers.md)**: prompt timers, agent self-timers, and the Timed activity tab
- **[Global Tasks](architecture/global-tasks.md)**: cross-project agent task log, bearer API, operator modal
- **[Conversation Retention](architecture/conversation-retention.md)**: cleanup and retention policy
- **[Browser Notifications](architecture/browser-notifications.md)**: opt-in OS/PWA alerts
- **[Jev](architecture/jev.md)**: TypeSafe decision model: notification filter + conversation auto-tagging
- **[Grok Bot inbound watcher](architecture/grok-bot-watcher.md)**: unsolicited Bot messages into pinned conversations
- **[Dictation (STT/TTS)](architecture/dictation.md)**: Whisper dictation modes and TTS providers
- **[Prompt Collection](architecture/prompt-collection.md)**: saved prompts library
- **[Remote Hosts](architecture/remote-hosts.md)**: `tierwyn node` daemon, hub-package vs GitHub install, enrollment, Trust, `node.json`, Runs on, P3 streaming tunnel / remote edit / worktrees / checkpoints / self-update
- **[Agent sandbox (bwrap)](architecture/sandbox.md)**: bubblewrap isolation for agent CLIs: settings precedence, capability fail-closed paths, monotonic spawn inheritance, timing
- **[Small Server Modules](architecture/server-modules.md)**: auth, shell, files, net, tts, secrets, and notifications utility modules: architecture, who calls them, and security boundaries

## Deployment & Operations

- **[Dedicated hub user](deploy/hub-user.md)**: hub-mode install vs this checkout; `tierwyn hub restart`; agent isolation
- **[Production Deployment Walkthrough](deploy/deployment.md)**: LAN + TLS setup
- **[Operator Sidecars](deploy/operator-sidecars.md)**: Piper / Kokoro systemd services
- **[Kokoro sidecar](deploy/kokoro/README.md)**: native Kokoro TTS wrapper (CPU / CUDA / ROCm)

## Root References

- **[README](../README.md)**: project landing page and quickstart
- **[AGENTS.md](../AGENTS.md)**: portable agent guide, critical safety rules, and operational commands
- **[CLAUDE.md](../CLAUDE.md)**: developer architecture guide and subsystem reference
- **[SECURITY.md](../SECURITY.md)**: security model, local binding, authentication boundaries; **§ Per-agent env vault** includes the sandbox + vault comparison table
