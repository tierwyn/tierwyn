# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-22

### Added

Initial public release of Tierwyn: a single-operator meta-harness for driving multiple local AI coding agents from a web browser.

#### Core Runtime & Adapters
- Multi-adapter architecture supporting 15 CLI coding agents (Claude Code, Pi, OpenCode, KiloCode, Antigravity, Cursor, Hermes, Codex, Grok Build, Kiro, Qwen Code, OpenClaw, Kimi Code, GitHub Copilot, and DeepSeek), plus the Grok Bot desktop app.
- Normalized event streaming over WebSocket for messages, tool executions, file edits, thinking blocks, and process statuses.
- Live session steering: inject prompts mid-turn into active agent processes or queue follow-ups, with cross-device live timer updates and idle-safe draft sync.
- Interaction modes: `bypass`, `questions` only, or full `prompt` mode for per-tool approval gates.
- Per-conversation and per-role effort/thinking level controls tailored to supported adapters.
- Hub-local interactive agent login and a catalogue UI with bulk enable, enabled/total model counts, context window resolution, and mobile drill-down navigation.

#### Cross-Agent Delegation, Helpers & Automation
- Cross-agent spawn tree allowing agents to delegate sub-tasks to designated roles with structured handoffs, configurable depth/caps, and upstream one-shot completion notifications.
- Native CLI helper tracking with a dedicated Helpers modal (tree view, inner messages, run summaries, and stop controls) for Claude Code and Grok Build.
- Scheduled jobs engine supporting one-shot and recurring intervals with pipeline stages and context passing.
- Artificial Analysis catalogue cache and role "use when" suggestions in the template editor.
- Loopback-only `/agent/help` documentation endpoints and error help hints for agents.

#### Search, Workspace & Media
- Command palette with per-conversation message search and project-scoped sidebar search (including terminal helper snapshots with jump-and-highlight).
- Find-in-transcript bar with word, regex, and case-sensitive modes.
- Agent conversation history search API with per-project scope overrides and tighter scope caps for sandboxed and remote agents.
- File modal with an image album viewer (filmstrip, swipe navigation, preloaded transitions) and GitHub-style alert callouts.
- Nightly retention trimming of old tool output (`toolResultTrimDays`).

#### Isolation, Security & Remote Execution
- Bubblewrap (`bwrap`) sandbox support for local CLI processes with 6-tier configuration precedence and a sandbox audit pill.
- Remote host agent daemon (`tierwyn node`) with release version reporting and host unbind on delete, plus an optional dedicated hub-user install for filesystem isolation.
- Operator rules and project memories with FTS5 keyword recall.
- Hardened cookie-based authentication (Argon2 password hashing, HMAC session secret, session floors), CSRF origin checks, request body size limits, and frame headers.

#### Installer & Updates
- `tierwyn` CLI installer (`curl | bash`, `tierwyn setup|doctor|update|restart|logs`) with an explicit HTTP/HTTPS access menu and plain-HTTP cookie diagnostics on the login screen.
- npm launcher: `npx tierwyn` or `npm install -g tierwyn` (alias `tierwin`) runs the same installer CLI.
- Release channels: `stable` (default) follows the newest `vX.Y.Z` tag, `edge` follows `main` (`tierwyn channel stable|edge` or `TIERWYN_CHANNEL=edge`); stable never downgrades a checkout.
- Remote nodes start on enroll, connect within ~10 s of the operator clicking Trust, and survive reboots (systemd linger).
- Ubuntu 24.04 bwrap support: setup installs bubblewrap and an AppArmor profile mirroring 26.04's `bwrap-userns-restrict` (capabilities dropped inside the sandbox).

#### Voice & Capabilities
- Local speech-to-text dictation via `whisper.cpp` with model management and Fast/Slow enhance modes.
- Text-to-speech integration with local Piper and Kokoro TTS sidecars.
- Built-in plugin capabilities including Firecrawl web search/scraping and Gemini media/audio generation.

[unreleased]: https://github.com/tierwyn/tierwyn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tierwyn/tierwyn/releases/tag/v0.1.0
