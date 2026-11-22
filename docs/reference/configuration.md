# Configuration & Environment

This document provides a comprehensive reference of all environment variables and configuration parameters used across the Tierwyn monorepo workspaces and sidecar integrations. `.env.example` has copy-paste examples for the common ones.

## Core Server & Network Configuration

| Key | Type | Default | Where Read | Effect / Description |
|---|---|---|---|---|
| `HOST` | `string` | `127.0.0.1` | `apps/server/src/index.ts` | The IP address or network interface to which the backend HTTP and WebSocket listener binds. |
| `PORT` | `integer` | `8787` | `apps/server/src/index.ts` | The TCP port for the primary backend HTTP server and WebSocket server. Note: `PORT` is deleted from child processes so spawned agents and MCP servers do not bind it. |
| `TIERWYN_LISTEN_PORT` | `string` | Resolved `PORT` | `apps/server/src/index.ts`, `apps/server/src/sessionManager.ts` | Populated dynamically from the resolved `PORT` and exported to process environment for internal session managers and child agents to discover the active listener port. |
| `TIERWYN_DB` | `string` | `./data/tierwyn.db` | `apps/server/src/config/env.ts` (`dbPathFromEnv`) | Path to the SQLite database file on disk. Production installs set `./data/prod.db` in their own env file (e.g. `/etc/tierwyn/prod.env`). |
| `TRUST_PROXY` | `string` | `loopback` | `apps/server/src/index.ts` | Express `trust proxy` setting for resolving client IP and protocol headers behind reverse proxies, e.g. `loopback` or `loopback,<proxy-ip>`. A pure integer is a hop count; avoid it: Vite preview adds a hop, so every client would look like the proxy. |
| `TIERWYN_ALLOWED_HOSTS` | `string` | Unset (localhost + IPs only) | `apps/web/vite.config.ts`, `apps/server/src/auth/wsGuard.ts` | Vite Host-header allowlist (DNS-rebinding protection) for dev and preview servers. `true` / `all` allows any Host; otherwise a comma-separated hostname list. Also widens the `AUTH_DISABLED` dev host guard. |
| `TIERWYN_PROJECT_ROOTS` | `string` (colon-separated paths) | User home directory | `apps/server/src/routes/projectBrowse.ts` | Allowed project roots for local clone, folder browsing, and auto-creation. Set to empty (`""`) to disable folder browsing and local clone entirely. |
| `TIERWYN_OUTBOUND_ALLOW` | `string` (comma-separated) | Unset | `apps/server/src/net/outboundUrl.ts` | Allowlist of private IPs, CIDRs, and internal hostnames the outbound SSRF guard may reach. See [deployment.md](../deploy/deployment.md) § Outbound network protection. |
| `TIERWYN_MAX_SPAWN_DEPTH` | `integer` | `5` | `apps/server/src/spawn/config.ts` | Maximum allowable depth for recursive inter-agent spawn hierarchies. Values `< 1` fallback to `5`. |
| `TIERWYN_AGENT_SELF_TIMERS` | `string` (`level0` \| `all` \| `off`) | `level0` | `apps/server/src/spawn/config.ts` | Who may create agent self-timers (`POST /conversations/:id/timers/agent`): `level0` = top-level conversations only, `all` = any conversation, `off` = endpoint disabled. |

---

## Authentication & Security

| Key | Type | Default | Where Read | Effect / Description |
|---|---|---|---|---|
| `AUTH_DISABLED` | `boolean` (`true`/`false`) | `false` | `apps/server/src/auth/config.ts` | When set to `true`, disables all authentication enforcement, login gates, and cookie verification (development only). Never set to `true` in production. |
| `SESSION_SECRET` | `string` | `""` (empty) | `apps/server/src/auth/config.ts` | Cryptographic secret used for signing and verifying HMAC session cookies. Must be provided when authentication is enabled; otherwise the server boots fail-closed. |
| `OPERATOR_PASSWORD_HASH` | `string` | `""` (empty) | `apps/server/src/auth/config.ts` | Argon2 password hash for the single operator login credential. Must be set when authentication is enabled. |
| `COOKIE_SECURE` | `boolean` (`true`/`false`) | `true` | `apps/server/src/auth/config.ts` | Controls whether session cookies are set with the `Secure` flag. Defaults to `true` (requiring HTTPS/TLS reverse proxy). Set to `false` for direct HTTP LAN access. |
| `TIERWYN_ALLOW_AUTH_DISABLED_NONLOCAL` | `string` (`1`) | Unset | `apps/server/src/auth/config.ts` | Explicit testing override that permits `AUTH_DISABLED=true` with a non-loopback `HOST` bind. Never use in production. |
| `TIERWYN_DEDICATED_HUB` | `string` (`1`) | unset | `apps/server/src/hubMode.ts` | Set only by `tierwyn setup` → Dedicated hub (`hub.env`). Sandbox defaults on until Settings are saved; projects overlapping the hub checkout are refused. Leave unset on a dev checkout. See [hub-user.md](../deploy/hub-user.md). |

---

## Deployment & Build Metadata

| Key | Type | Default | Where Read | Effect / Description |
|---|---|---|---|---|
| `TIERWYN_SERVER_MODE` | `string` (`dist` \| `tsx`) | Auto-detected | `apps/server/src/routes/health.ts` | Explicitly overrides the server runtime mode reported in the `/health` endpoint probe. |
| `TIERWYN_GIT_SHA` | `string` | Auto-detected | `apps/server/src/routes/health.ts` | Explicitly overrides the git revision commit SHA returned in the `/health` endpoint response. |
| `TIERWYN_BUILT_AT` | `string` (ISO 8601) | Startup timestamp | `apps/server/src/routes/health.ts` | Explicitly overrides the build timestamp reported in the `/health` endpoint response. |

---

## Plugins, Vault & MCP Fallback

| Key | Type | Default | Where Read | Effect / Description |
|---|---|---|---|---|
| `TIERWYN_PLUGINS_DIR` | `string` (path) | `./plugins` | `apps/server/src/plugins/loader.ts` | Directory scanned for per-instance ESM plugins (gitignored, empty on clone). See [plugins.md](../architecture/plugins.md). |
| `TIERWYN_PLUGINS` | `string` (`off`) | Unset | `apps/server/src/plugins/loader.ts` | Set to `off` to skip plugin scanning entirely. |
| `TIERWYN_PLUGIN_VAULT_KEY` | `string` | Unset | `apps/server/src/plugins/vault.ts`, `apps/server/src/config/env.ts` | Dedicated ≥32-byte key for plugin-credential encryption; takes precedence over `SESSION_SECRET` (key id `env:v1`). Changing or removing it makes existing vault rows report "encrypted with a different key; re-enter". |
| `TIERWYN_CHILD_ENV_DENY` | `string` (comma-separated) | Unset | `apps/server/src/childEnv.ts` | Extra environment variable names to scrub from every child process, in addition to the built-in deny set. |
| `TIERWYN_GIT_RUN_HOOKS` | `string` (`1`) | Unset (hooks disabled) | `apps/server/src/git/gitExec.ts` | Hub git (checkpoints, git panel, worktree add) runs with hooks disabled (`core.hooksPath=/dev/null`) so sandboxed agents cannot plant hooks the hub later fires. Set `1` to re-enable hooks on operator-initiated commit/push/pull/fetch only. |
| `TIERWYN_MCP_*` | `string` | Unset | `apps/server/src/mcp/envFallback.ts` | Boot-time fallback secrets for MCP servers whose encrypted-vault entries are empty. Captured into memory and deleted from `process.env` at boot; values under 8 characters fail closed. Placeholders injected into child configs use `TIERWYN_MCPV_*`. |
| `TIERWYN_AA_API_KEY` | `string` | Unset | `apps/server/src/aa/catalogue.ts`, `apps/server/src/childEnv.ts` | Artificial Analysis API key. Boot-captured and deleted from `process.env` so agent children never inherit it. |

---

## Frontend Web Development

| Key | Type | Default | Where Read | Effect / Description |
|---|---|---|---|---|
| `VITE_PROXY_TARGET` | `string` (URL) | `http://127.0.0.1:8787` | `apps/web/vite.config.ts` | Target backend URL used by Vite dev server and preview (`apps/web`) to proxy API endpoints and WebSocket traffic. The prod-web unit sets it to `http://127.0.0.1:8788`. |

---

## Local AI & Sidecar Services

| Key | Type | Default | Where Read | Effect / Description |
|---|---|---|---|---|
| `PIPER_VOICES_DIR` | `string` (path) | `~/piper-voices` | `apps/server/src/adapters/piperVoices.ts` | Directory where downloaded Piper ONNX voice models and corresponding JSON configs are stored. |
| `WHISPER_BIN_PATH` | `string` (path) | Auto-discovered | `apps/server/src/adapters/whisper.ts` | Explicit path override to the `whisper-cli` or `whisper-cpp` executable binary for speech-to-text audio dictation. |
| `XDG_DATA_HOME` | `string` (path) | `~/.local/share` | `apps/server/src/adapters/whisper.ts` | Base XDG data directory used to locate the `mewisper` data directory and pre-downloaded GGML Whisper models. |
| `TIERWYN_GROKBOT_CDP_PORT` | `integer` | `9333` | `apps/server/src/adapters/grok-bot/app.ts` | Loopback CDP port for the Grok Bot desktop sidecar. |
| `TIERWYN_GROKBOT_AUTOSTART` | `string` (`0`) | On (any value other than `0`) | `apps/server/src/adapters/grok-bot/supervisor.ts` | Set `0` to forbid Tierwyn from launching the Grok Bot desktop app, including manual Start. Dev `.env` ships `0`; prod omits it so the unit may auto-start. |
| `TIERWYN_GROKBOT_IDLE_MS` | `integer` | `8000` | `apps/server/src/adapters/grok-bot/settle.ts` | Replica-poll idle window before a grok-bot turn is treated as settled. |
| `TIERWYN_GROKBOT_WATCH_MS` | `integer` | `25000` | `apps/server/src/adapters/grok-bot/watcher.ts` | Inbound watcher roster-poll interval for unsolicited Bot messages. |
| `TIERWYN_GROKBOT_REPLY_LEASE_MS` | `integer` | `3600000` (1 h) | `apps/server/src/adapters/grok-bot/watcher.ts` | How long the chat that last prompted a Bot keeps receiving its late replies before they return to the Remote Agents container. `0` = always the container. |
| `TIERWYN_GROKBOT_WATCH` | `string` | unset (on) | `apps/server/src/adapters/grok-bot/watcher.ts` | Set to `0` to disable the Grok Bot inbound watcher. |
| `TIERWYN_GROKBOT_BIN` | `string` (path) | `/opt/Grok Bot/grok-bot` | `apps/server/src/adapters/grok-bot/supervisor.ts` | Absolute path override for the Grok Bot desktop binary. |
| `TIERWYN_GROKBOT_UNIT` | `string` | `tierwyn-grokbot.service` | `apps/server/src/adapters/grok-bot/supervisor.ts` | systemd user unit the supervisor may start for the Grok Bot sidecar. |

---

## Standard Operating System Environment Variables

| Key | Where Read | Usage |
|---|---|---|
| `PATH` | `apps/server/src/discovery.ts`, `apps/server/src/adapters/whisper.ts` | Standard execution path used to discover installed CLI binaries (`claude`, `pi`, `whisper-cli`, etc.). |
| `HOME` | `apps/server/src/adapters/piperVoices.ts`, `apps/server/src/adapters/whisper.ts` | Operator home directory used for locating user configuration files, Piper voice models, and local databases. |
