# MCP Server Management (Phase 1)

Tierwyn provides a centralized Model Context Protocol (MCP) server registry,
per-conversation selection, secret management, and injection into supported
agent processes.

**Security property (honest):** secret environment variables and headers
configured for MCP servers never transit an agent-visible API channel (REST,
WebSocket frames, preambles, transcripts) and are **never placed on subprocess
command-line arguments (`argv`)**. They are delivered to agent subprocesses via
ephemeral `${TIERWYN_MCPV_n}` environment placeholders or over standard input
(`stdin`) JSON-RPC. This is **not** protection against an agent reading its own
environment via same-UID local execution; see [Residual risk](#residual-risk) below
and [SECURITY.md](../../SECURITY.md#mcp-injection).

**Code:**

| Piece | Path |
|---|---|
| Shared types & contract | `packages/shared/src/mcp.ts` |
| Registry & vault access | `apps/server/src/mcp/registry.ts` |
| Secret boot-capture & fallback | `apps/server/src/mcp/envFallback.ts` |
| Selection & skip resolution | `apps/server/src/mcp/resolve.ts` |
| Per-adapter config builders | `apps/server/src/mcp/inject.ts` |
| Native config reader | `apps/server/src/mcp/native.ts` |
| Hub-placed stdio/sse pipe | `apps/server/src/mcp/hubPipe.ts` |
| Transcript secret redaction | `apps/server/src/secrets/mcpRedact.ts` |
| REST routes | `apps/server/src/routes/mcp.ts` |
| UI settings & native viewer | `apps/web/src/components/McpServerSettings.tsx` |
| UI live status chip | `apps/web/src/components/McpStatusChip.tsx` |

---

## 1. Registry

The registry is configured by the operator via **Settings → MCP Servers** or
the cookie-authenticated REST API (`/mcp/servers`).

### Server IDs and Transports

- **ID rules:** Each server has a unique `id` matching `^[a-z0-9][a-z0-9_-]{0,31}$`
  (lowercase alphanumeric, hyphens, underscores; max 32 characters).
- **Transports (`stdio`, `http`, `sse`):**
  - `stdio`: Runs a local CLI command. Takes `command` (required string), optional
    `args` (array of up to 32 strings), optional `cwd` (working directory path),
    and `env` variables. Takes no URL and no headers.
  - `http` / `sse`: Connects to an HTTP or Server-Sent Events MCP endpoint. Takes
    `url` (required `http://` or `https://` URL), optional `headers`, and optional
    `args`. Takes no local command, `cwd`, or `env`.

Each server also defines:
- `description`: Optional documentation for the operator.
- `enabled`: Master switch (default `true`). Disabled servers are skipped during
  turn resolution.
- `allowInDelegating`: Boolean gate (default `false`) controlling whether the server
  is permitted in spawn-capable conversations.
- `agentTypes`: Optional allow-list of agent types (`null` = all injectable adapters).

---

## 2. Secrets: Vault & Env Fallback

MCP servers frequently require API tokens, credentials, or sensitive headers.
Tierwyn enforces strict isolation for secret values.

### Storage and Resolution Order

1. **Encrypted Vault (`tierwyn:mcp`):** Secrets set via the UI or `PUT /mcp/servers/:id/secrets/:kind/:key`
   are encrypted using AES-256-GCM (HKDF-derived key from `TIERWYN_PLUGIN_VAULT_KEY` or
   `SESSION_SECRET`) in SQLite (`plugin_secrets` table). Vault writes require a minimum
   secret length of **8 characters** (`MIN_SECRET_LEN`).
2. **Boot-Captured Env Fallback (`TIERWYN_MCP_*`):** When declaring a secret variable
   in the registry, an optional `envFallback` name may be provided (must match
   `^TIERWYN_MCP_[A-Z0-9_]{1,96}$`). At boot, `captureMcpEnv` moves all matching variables
   from `process.env` into an internal memory map and deletes them from `process.env`.
   If the vault has no entry for the secret, Tierwyn falls back to the captured env
   value. **Fallback values shorter than 8 characters fail closed** (treated as missing).

### Write-Only REST API

All registry endpoints (`GET /mcp/servers`, `GET /conversations/:id/mcp`, etc.) are
strictly write-only regarding secret values:
- Public variables report `configured: boolean` and `source: 'vault' | 'env' | null`.
- Plaintext values are never returned in JSON responses or WebSocket frames.
- Secret mutations are authenticated by operator session cookie only (Bearer tokens 401).

---

## 3. Secret Travel Rule

Secret values must **never appear on command-line arguments (`argv`)**, where
they could be observed via `/proc/<pid>/cmdline` or system process listings (`ps`).

Tierwyn delivers secrets to child processes using two secure patterns:

1. **Placeholder Expansion via Child Environment (`claude-code`, `codex`):**
   - Tierwyn creates ephemeral environment variable names: `TIERWYN_MCPV_0`, `TIERWYN_MCPV_1`, etc.
   - For `claude-code`, config files or `--mcp-config` parameters receive
     literal placeholder strings: `${TIERWYN_MCPV_n}`. The CLI/SDK expands these from its
     process environment.
   - For `codex`, command-line arguments use indirect name mappings (`env_vars=["KEY"]`
     and `env_http_headers={"Authorization"="TIERWYN_MCPV_n"}`), while the actual values
     reside exclusively in the child environment.
   - Placeholder variables are passed directly to `buildChildEnv()` for the child process
     only; `TIERWYN_MCP_*` boot-fallback prefixes are scrubbed from every child environment.
2. **Standard Input Literals (ACP Adapters):**
   - For Agent Client Protocol adapters (`grok-build`, `kiro`, `qwen`, `kimi`), MCP server
     configurations and secrets are passed over JSON-RPC on **stdin** (`session/new` and
     `session/load`). They never touch command-line arguments.

### Output Redaction

Any known MCP secret values (from vault rows and boot-captured environment variables)
are registered with `mcpRedact`. When agents produce output or execute tools, `appendEvent`
automatically replaces any occurrences of these secrets with `[REDACTED]` before events
are written to SQLite or broadcast over WebSocket frames.

---

## 4. Selection and Precedence

Which MCP servers are injected into an agent turn is resolved at session start:

1. **Conversation Selection:** Explicit selection stored in `conversations.mcp_servers`
   (array of server IDs).
2. **Template Default:** If `conversation.mcp_servers` is `null` (the default), the
   conversation inherits `mcpServers` from its assigned spawn template (`SpawnTemplate.mcpServers`).
3. **Empty Array (`[]`):** Explicitly setting `mcpServers: []` disables all MCP servers,
   overriding any template default.
4. **Spawned Children:** Spawned subagents have `parentConversationId` set. A child
   conversation **never inherits the template default**. Instead, `dispatchSpawn` copies
   the specific role's `mcpServers` list onto the child at spawn time. If the role specifies
   no servers, the child gets an empty selection (`[]`).

---

## 5. Delegating Sandbox Gate (`allowInDelegating`)

Conversations that possess the ability to spawn subagents (`tokenEntitlement.kind === 'spawn'`)
operate under heightened privilege. If an agent with spawn capabilities has access to untrusted
outbound MCP tools (e.g. web scrapers, browser automation), prompt injection could trigger
unauthorized spawn delegations or data exfiltration.

To prevent confused deputy attacks:
- Every registry server has an `allowInDelegating` boolean flag (default `false`).
- In any delegating conversation, servers with `allowInDelegating === false` are
  automatically dropped with skip reason `delegating_blocked`.
- Only explicitly audited and approved MCP servers should have `allowInDelegating` enabled.

---

## 6. Supported Injectable Adapters

Tierwyn injects registry MCP configurations into the following adapters (`MCP_INJECTABLE_ADAPTERS`):

| Adapter | Mechanism | Transports |
|---|---|---|
| `claude-code` | SDK `mcpServers` option with `${TIERWYN_MCPV_n}` placeholders | `stdio`, `http`, `sse` |
| `codex` | `-c mcp_servers.*` flags with `env_vars` and `env_http_headers` indirection | `stdio`, `http` |
| `grok-build` | ACP `session/new` / `session/load` on stdin | `stdio`, `http`\*, `sse`\* |
| `kiro` | ACP `session/new` / `session/load` on stdin | `stdio`, `http`\*, `sse`\* |
| `qwen` | ACP `session/new` / `session/load` on stdin | `stdio`, `http`\*, `sse`\* |
| `kimi` | ACP `session/new` / `session/load` on stdin | `stdio`, `http`\*, `sse`\* |
| `hermes` | ACP `session/new` / `session/load` on stdin (from 0.22) | `stdio` (until `mcpCapabilities` advertised) |

*\*For ACP adapters, `http` and `sse` transports are optimistically advertised on the first turn
and subsequently filtered based on the agent's reported ACP capabilities.*

Other adapters (`cursor`, `copilot`, `antigravity`, `pi`, `opencode`) do not
receive registry injection in Phase 1 (they use static native configs).

### Per-agent capability matrix

Single source of truth: `mcpAgentCapability(agentType)` in `packages/shared/src/mcp.ts`
(derived from `MCP_INJECTABLE_ADAPTERS`, `ACP_MCP_ADAPTERS`, `MCP_NATIVE_OVERRIDE_ADAPTERS`).
The input-bar popover and Settings → MCP Servers read it so no control is a silent no-op:
for agents that ignore native overrides the popover renders native rows read-only
("loaded by agent") and hides the native All/Off buttons, and the conversation
`modified` flag (`GET /conversations/:id/mcp`) only counts overrides the agent honours.

| Agent | Registry injection | Native overrides (`disableNativeMcp` / `disabledNativeMcp`) | Exceptions |
|---|---|---|---|
| `claude-code` | supported | enforced (`--strict-mcp-config` + per-server filter) | - |
| `codex` | supported | ignored | `stdio` + `http` only; `sse` skipped |
| `qwen`, `kimi`, `kiro`, `grok-build` | supported (ACP) | ignored | `http`/`sse` gated by runtime ACP caps |
| `hermes` | supported (ACP, ≥ 0.22) | ignored | same ACP caps gate |
| `antigravity` | unsupported | ignored | loads `~/.gemini/config/mcp_config.json` itself |
| `cursor` | unsupported | ignored | loads `~/.cursor/mcp.json` itself |
| `opencode`, `kilocode` | unsupported | ignored | load `opencode.json` / `kilo.json` `mcp` themselves |
| everything else | unsupported | ignored | - |

Disabling a registry server stops **Tierwyn injection only**. A same-named entry in an agent's
native config keeps loading; remove it there (Settings → Native Agent Configurations → Remove)
to stop it.

---

## 7. Native Configuration Viewer & Live Status

### Native Viewer (`GET /mcp/native`)

The operator can inspect existing agent-native MCP configurations (e.g. `~/.claude.json`,
`.mcp.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`) in **Settings → MCP Servers**:
- Read-only inspection; Tierwyn never modifies native configuration files.
- All credential-looking arguments, environment variables, header values, and URL credentials
  are masked (`••••`).
- Unparseable or malformed URLs are replaced with `'invalid-url'` to prevent leaking raw tokens.

### Live Status Chip (`claude-code`)

For active `claude-code` sessions, Tierwyn queries real-time MCP health via the SDK:
- Displayed in the topbar header via `McpStatusChip`.
- Reports status: `connected`, `failed`, `needs-auth`, `pending`, or `disabled`.
- Provides operator controls to `enable`, `disable`, or `reconnect` individual servers
  (`POST /conversations/:id/mcp/:serverName/:action`).

Live apply applies only when the change is an addition of secret-free servers (SDK control-channel limitation); any other change applies from the next turn.

---

## 8. Skip Reasons & Resolution

When resolving the effective MCP server set for a conversation (`GET /conversations/:id/mcp`),
Tierwyn evaluates each candidate server and reports an explicit skip reason if excluded:

| Reason | Explanation |
|---|---|
| `unknown` | The server ID does not exist in the registry. |
| `disabled` | The server has `enabled: false` in the registry. |
| `agent_not_injectable` | The conversation's active agent does not support Tierwyn MCP injection. |
| `agent_filtered` | The server specifies an `agentTypes` list that excludes this agent. |
| `delegating_blocked` | The conversation is spawn-capable, but the server has `allowInDelegating: false`. |
| `transport_unsupported` | The agent does not support this transport (e.g. `sse` on Codex). |
| `secret_missing` | A required secret variable or header has neither vault nor valid env-fallback data. |
| `secret_env_unsupported` | (Codex) Multiple injected servers declare the same secret environment variable key. |
| `hub_placement_unsupported` | Hub-placed `sse`/`stdio` on a remote session whose host does not advertise `tunnel.stream` (buffered `http` still works). |
| `hub_cwd_unresolvable` | Hub-placed `stdio` for a remote session whose `args` or `cwd` contain `${TIERWYN_CWD}`, that path exists only on the host, and hub-placed children see the hub filesystem. |
| `command_not_found_on_host` | Node stdio preflight: the command is not on the host PATH. |
| `cwd_outside_roots` | Node stdio preflight: the server `cwd` is outside `node.json` `roots`. |

---

## 9. Lifecycle & Parked Sessions

MCP server configurations bind to an agent session at process spawn time.

### Configuration Hashing & Parked Adoption

Tierwyn computes a deterministic hash (`mcpHash`) of the effective MCP configuration
(including server IDs, `updatedAt` timestamps, and secret update timestamps).
- When an agent turn finishes, parked sessions retain their `mcpHash`.
- Subsequent prompts will only adopt a parked session if the newly resolved `mcpHash`
  matches the parked session's hash. If the hash changes, the parked session is discarded,
  and a fresh process is spawned with the updated configuration.

### Immediate Reap on Selection Change

When the operator updates a conversation's MCP selection via `PATCH /conversations/:id`:
- Tierwyn immediately reaps all parked sessions for that conversation using `{ all: true }`.
- This ensures hold-open follow-up adapters (`grok-build`) terminate their
  idle processes immediately, preventing stale credentials or old configurations from lingering.

---

## 10. Residual Risk

1. **Same-UID Environment Inspection:** On Linux, processes running under the same UID
   can inspect each other's environment variables via `/proc/<pid>/environ`. In single-user
   installations where Tierwyn and agent subprocesses run as the same system user, an agent
   with arbitrary command execution can read environment variables belonging to its peers
   or the server. Run untrusted agents in containerized or separate UID environments.
2. **Egress and Exfiltration:** MCP tools that interact with the internet or execute local
   browser sessions can be steered by prompt injection to reach external URLs or leak
   sensitive context. Restrict sensitive MCP tools to trusted workflows and keep
   `allowInDelegating: false`.
3. **Reference:** See [SECURITY.md](../../SECURITY.md#mcp-injection) for full architectural
   hardening details.

---

## 11. Write-Through: Install into an Agent's Native Config

In addition to ephemeral in-memory injection during agent sessions, Tierwyn can install registry-configured MCP servers directly into an agent's native configuration files (e.g. for use outside Tierwyn or with standalone CLI sessions).

### Supported Agents and Scopes

Write-through supports 7 agent types across `user` and `project` scopes:

| Agent | User file | Project file | Container | Transports | Secret handling |
|---|---|---|---|---|---|
| claude-code | `~/.claude.json` | `<root>/.mcp.json` | `.mcpServers` | stdio, http, sse | `${VAR}` placeholders |
| antigravity | `~/.gemini/config/mcp_config.json` | `<root>/.agents/mcp_config.json` | `.mcpServers` | **stdio only** | copied (`copySecrets`) |
| qwen | `~/.qwen/settings.json` | `<root>/.qwen/settings.json` | `.mcpServers` | **stdio only** | copied (`copySecrets`) |
| kiro | `~/.kiro/settings/mcp.json` | `<root>/.kiro/settings/mcp.json` | `.mcpServers` (whole file) | **stdio only** | copied (`copySecrets`) |
| cursor | `~/.cursor/mcp.json` | `<root>/.cursor/mcp.json` | `.mcpServers` | **stdio only** | copied (`copySecrets`) |
| opencode | `~/.config/opencode/opencode.json` | `<root>/opencode.json` | `.mcp` | stdio, http, sse | copied (`copySecrets`) |
| kilocode | `~/.config/kilo/kilo.json` | `<root>/kilo.json` | `.mcp` | stdio, http, sse | copied (`copySecrets`) |

HTTP and SSE write-through installs are supported only for `claude-code`, `opencode`, and `kilocode` because only those adapters have a well-known remote configuration shape. Attempting to install `http` or `sse` servers into the other agents returns HTTP 400 (`transport <t> not supported for <agent>`).

### Secret Safety & Placeholders

1. **Placeholder Agents (`claude-code`):**
   - Config files are written with `${VAR}` references (e.g. `${GITHUB_TOKEN}` or `${X_API_KEY}`).
   - Secret plaintext values are **never** written to disk. The operator must export the corresponding environment variables in their shell or environment.
   - For header secrets, Tierwyn sanitizes keys to valid uppercase C-identifiers (e.g. `X-Api-Key` -> `${X_API_KEY}`).
2. **Other Agents (`antigravity`, `qwen`, `kiro`, `cursor`, `opencode`, `kilocode`):**
   - These agents do not support environment variable expansion in their native MCP configs.
   - Tierwyn will **refuse** to write config files containing secret variables or headers unless the caller explicitly sets `"copySecrets": true`.
   - When `copySecrets` is true, secrets are copied into the file, which is strictly set to file mode `0600` (readable only by the current user).
3. **No CLI Writers / No Secrets on Argv:**
   - Tierwyn never executes agent CLI commands (such as `claude mcp add`) to modify configuration files. Writing is performed directly by the server using file I/O, guaranteeing secret values never appear on `argv` or process listings.

### Atomic Updates, Backup, and Locking

- **Per-Path Mutex:** All read-modify-write operations on a config file are serialized using an in-process per-path mutex.
- **Backup (`.bak`):** Prior to modifying an existing file, Tierwyn copies the file to `<path>.bak` with mode `0600`.
- **Atomic Replace:** New content is written to a sibling temporary file (`<file>.tierwyn-tmp-<pid>-<ts>`) with mode `0600`, atomically renamed over the target file, and verified with `chmod(0600)`. On write failure, the temporary file is deleted.
- **JSONC Comments Refusal:** If an existing configuration file contains JavaScript-style comments (`//` or `/* */`), Tierwyn refuses the write with HTTP 400 (`file contains JSONC comments that would be lost, edit it manually`) to prevent destructive comment loss during JSON serialization.

### Live-Agent Concurrency Guard

When targeting `project` scope, Tierwyn checks whether any active agent sessions are currently running in the project checkout (`collectLiveAgents`). If live agents are detected, the request is rejected with HTTP 409 (`Cannot install: N agent(s) active on this checkout (…)`) to prevent race conditions with running agents reading or writing their own project files.

### Removal

The `DELETE /mcp/native/:agentType/entry/:name` endpoint removes an entry from the agent's native config file using the same mutex, `.bak` backup, and atomic write-rename guarantees.

## 12. Placement (P2a: remote hosts)

Every registry server carries a `placement` hint: `auto` (default), `agent`, or `hub`. `effectiveMcpPlacement()` in `@tierwyn/shared` resolves where a server actually runs; an explicit choice always wins.

| placement | stdio | http/sse at a hub-neighbour URL* | publicly routable http/sse |
|---|---|---|---|
| `auto` | agent's host | hub | agent's host |
| `agent` | agent's host | agent's host | agent's host |
| `hub` | hub when the host streams (`tunnel.stream`); else skipped (`hub_placement_unsupported`) | hub | hub |

\* loopback, private-network, link-local, or mDNS addresses; machines only the hub (and its neighbours) can reach, so a remote node's agent cannot.

- Explicit `hub` placement on a **streaming** host (`hello.features` includes `tunnel.stream`) runs `http`, `sse`, and `stdio` on the hub. Without `tunnel.stream`, only hub-placed `http` works (buffered `http` RPC); `sse`/`stdio` are skipped with `hub_placement_unsupported`.
- Hub-placed **stdio** children execute on the hub: they see the **hub filesystem**, not the remote project's tree. `${TIERWYN_CWD}` in `args` or `cwd` is skipped with `hub_cwd_unresolvable` for remote sessions, that path exists only on the host.
- Remote-only skip reasons: `command_not_found_on_host` and `cwd_outside_roots` are recorded by the node's stdio preflight at session start and surface in `GET /conversations/:id/mcp` as `injected: false` plus the reason.

## 13. Hub bridge for remote sessions

Hub-placed servers never execute on the node. At session start the hub rewrites each hub-placed server in the resolved MCP config to `http://127.0.0.1:<nodeListenPort>/agent/mcp/<serverId>` carrying a fresh per-session 256-bit key; the node's loopback listener forwards calls over the tunnel to the hub's `ALL /agent/mcp/:serverId` route, which checks the `X-Tierwyn-Mcp-Key` header and proxies to the real hub-local server. Keys are per-session and revoked when the session ends; the underlying server's credentials never reach the node for hub-placed servers.

On a P3 streaming tunnel the same bridge carries **SSE and stdio**: `mcp/hubPipe.ts` holds one SDK transport pair per `(session, serverId)`. Downstream is `StreamableHTTPServerTransport` (what the remote agent talks to over the tunnel). Upstream is the registry row: `SSEClientTransport` for `sse`, or `StdioClientTransport` for `stdio`. Stdio children get `buildChildEnv()` plus vault/env-fallback secret values; hub session secrets (`SESSION_SECRET`, password hash, vault key) are never in that env. Pipes are reaped when the session token is revoked. Hub-placed `http` still has the P2 buffered fallback when the host cannot stream.

### Native MCP on remote hosts

Native config lives on the host (`~/.claude.json`, project `.mcp.json`, …). When the host advertises `mcp.native`, `GET /mcp/native`, `POST /mcp/native/:agentType`, and `DELETE /mcp/native/:agentType/entry/:name` proxy through `mcp.native.read` / `mcp.native.write` (same `.bak` + 0600 atomic write as local). Values are masked on read. `copySecrets: true` on a host with **Allow MCP secrets** off is 403. Without `mcp.native` the routes stay 409 `remote_project`; a live `no_method` is 501 `node_update_required`.

