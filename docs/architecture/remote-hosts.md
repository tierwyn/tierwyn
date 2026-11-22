# Remote Hosts

Run agent turns on another machine while the Tierwyn **hub** keeps the database, UI, tokens, policy, and persistence.

The feature is **Remote Hosts**. The daemon is **`tierwyn node`**. The systemd user unit is `tierwyn-node.service`. This is not **Remote Agents** (the Grok Bot system project). It is also not a **dedicated hub user** (`tierwyn hub restart`, `tierwyn-hub*` units), that is how you install the hub itself so agents cannot rewrite it; see [hub-user.md](../deploy/hub-user.md). `tierwyn node restart` is unchanged.

**Code:**

| Piece | Path |
|---|---|
| Shared protocol & tunnel allow-list | `packages/shared/src/node.ts` |
| Hub connection registry | `apps/server/src/node/nodeHub.ts` |
| Node entry (`enroll` / `run`) | `apps/server/src/node/main.ts` |
| Operator REST | `apps/server/src/routes/remoteHosts.ts` |
| Unit template | `docs/deploy/systemd/tierwyn-node.service` |
| Installer | `scripts/install.sh` (`tierwyn node …`) |
| Hub package builder | `scripts/package-node.mjs` → `apps/server/dist/node-package/` |
| Package fetch (on the node) | `apps/server/src/node/packageFetch.ts` |
| Threat model | [SECURITY.md § Remote Hosts](../../SECURITY.md#remote-hosts) |

---

## Dedicated node user

Run `tierwyn node` as a **dedicated unprivileged user** (no sudo, not in `docker` / `lxd`). Agents execute as that user inside the roots you list in `node.json`.

Before `tierwyn node start`, linger so the user unit survives logout:

```bash
sudo loginctl enable-linger <node-user>
```

On the host:

| Path | Mode |
|---|---|
| `~/.config/tierwyn/node/` | `0700` |
| `~/.config/tierwyn/node/key` (ed25519 private key) | `0600` |
| `~/.config/tierwyn/node/node.json` | operator-edited policy |

The hub stores only the public key. The private key never leaves the node.

---

## Enroll, Trust, connect

1. On the hub: **Settings → Remote Hosts** → add a host. The host `name` is a display label only; the node dials the hub via `hub_origin`, the hub never dials the node; `hello.hostname` is node-reported metadata. The host list updates by WebSocket push (`remote_host_status`) on every change, and polling only runs during enrollment and installs. **Auto-trust when enrolled** is off by default (opt-in toggle). The UI shows a one-liner once (the enroll token is single-use, 10 minutes, hashed at rest). Default is the **hub package** installer when the hub has built `dist/node-package/`; otherwise GitHub. Toggle **Install from GitHub instead** for a git checkout. An `http://` origin shows a warning on the hub-package one-liner; `--allow-http` is **not** added automatically (Settings never writes the flag). While the enroll card is open, the list polls every ~5s and a **Refresh** button reloads hosts so pending → untrusted/connected appears without leaving Settings.

   Hub package (default when available):

   ```bash
   curl -fsSL https://tierwyn.example/node/install.sh \
     | bash -s -- node enroll --hub https://tierwyn.example --token <token> [--all-agents | --agents claude-code,codex]
   ```

   GitHub git checkout:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/tierwyn/tierwyn/main/scripts/install.sh \
     | bash -s -- node enroll --hub https://tierwyn.example --token <token> [--all-agents | --agents claude-code,codex]
   ```

   **How the hub one-liner differs from GitHub.** `GET /node/install.sh` (public) is the same `scripts/install.sh` with the empty `TIERWYN_HUB_PKG_SHA256=""` marker replaced by the tarball's sha256. A raw/unmarked script still clones from GitHub; only a marked script takes the hub-package path. The token is a `Authorization: Bearer` header on `GET /node/package.tgz`, never a query string. After extract, the tree is `~/tierwyn-node` (`TIERWYN_DIR` override) and is identified by a `BUILD_ID` file (not a `.git` dir). Ambient `TIERWYN_HUB_PKG_SHA256` in the environment cannot flip an unmarked script onto the hub path.

2. On the remote host, as the node user, paste the one-liner.

   Settings can append the agent flag for you (Agents on this host: Choose later / All agents / Selected, client-side string building only; the node enforces). Enroll with a flag **replaces** `allowedAgents`; without a flag it keeps the prior list. All other `node.json` fields (`listenPort`, `maxSessions`, `artifactsMaxAgeDays`, `allowSelfUpdate`, unknown keys) are preserved on re-enroll. Bad names are rejected before the single-use token is spent. `--all-agents` writes the explicit list of every node-capable type at that moment (no wildcard; `grok-bot` is never included); same capability class as any allowed agent, but wider reach (a compromised hub could Install ▸ any allowed installable type); prefer `--agents` for the CLIs you actually use.

   Node.js 24 LTS recommended on the host (22.13 minimum).

   | Source | Directory | Setup |
   |---|---|---|
   | Package | `~/tierwyn-node` (`TIERWYN_DIR` override) | Extracts the hub tarball; skips `npm ci` / build; Node floor **22.13** |
   | Git | `~/tierwyn` (`TIERWYN_DIR` override) | Clone or `git pull --ff-only`; `npm ci`; build `packages/shared` + `apps/server` |

   Both paths install the user unit **without** enable/start, then enroll. Direct `tierwyn node enroll` in an already-built checkout still skips setup when `dist/node/main.js` exists. Enroll returns `{ hostId, trusted }`, writes `node.json`, then enables and **restarts** the user service (`systemctl --user enable` + `restart tierwyn-node.service`) whether or not the host is trusted. `restart` rather than `enable --now`, so a re-enroll replaces a running daemon that still holds the old hostId and key. It ends with a status block (example: Auto-trust off):

   ```
   Enrolled as <hostId> with hub https://hub.example
     Fingerprint:    SHA256:…
     Allowed agents: claude-code, codex
     Service:        tierwyn-node.service started
     Trust:          waiting. Open https://hub.example → ⚙ Settings → Remote Hosts, check the fingerprint matches, then click Trust. The node connects within ~10s once the operator clicks Trust.
     Watch:          tierwyn node logs   (prints "connected to hub" when up)
   ```

   The fingerprint uses the same digest as the host card. An untrusted daemon gets close `4403 untrusted` from the hub and retries every 10 s, so clicking **Trust** connects it without a manual restart. With Auto-trust the Trust line reads `Trusted by hub (auto-trust); connecting now`. If systemctl fails, enroll still succeeded (keys and `node.json` are written), the Service line says `could not start … Run: tierwyn node start`, and the block goes to stderr. The daemon logs `connected to hub <origin> as <hostId>` only after the hub answers its first RPC, so an untrusted node never logs it.

   (With no agent flag and an empty list it points you at `tierwyn node allow <agent>…`.) `node.json` is written atomically with mode 0600. Host cards show `package <BUILD_ID>` or `git <sha7>`. Nodes that report a release version show `<version> · <id>` (`apps/web/src/remoteHostInstallLabel.ts`). The version comes from the node hello and is display only. The build id (`hello.gitSha`, the BUILD_ID on package hosts) is the identity: a package host whose BUILD_ID matches the hub tarball is up to date. `NODE_PROTOCOL` is the compatibility gate (`packages/shared/src/node.ts`).

3. **Trust.** By default, enrollment leaves the host untrusted until the operator reviews its public key fingerprint and clicks **Trust** in Settings → Remote Hosts. The host card displays the node's ed25519 public key fingerprint, matching the fingerprint computed from the node's private key on disk. There is no TOFU when Auto-trust is off. If **Auto-trust when enrolled** was toggled on when generating the host, the hub automatically sets the row to `trusted` upon token redemption, skipping manual fingerprint verification. See [SECURITY.md § Remote Hosts](../../SECURITY.md#remote-hosts).
4. After the host is trusted and the unit is running, the row is **connected** while the WebSocket is up. The hub connection registry (`nodeHub.ts`) enforces a limit of 32 concurrent pre-auth connections (`MAX_PRE_AUTH = 32`) on `/ws/node` to protect against connection exhaustion.

Each host can carry a **description**: a display note set on the host card and shown under the host's group header in the sidebar. `PATCH /remote-hosts/:id` takes `description` (trimmed, max 500 chars, 400 if longer; `null` or empty clears it).

### Convert a git host to a package

On the host (same key and same Settings row):

```bash
tierwyn node update              # first: pull the installer that knows package-fetch
tierwyn node update --from-hub   # then: extract to ~/tierwyn-node, re-point the unit + shim
tierwyn node update --from-hub --allow-http   # same, when the stored hubUrl is http://
```

`--allow-http` is accepted on enroll **and** on `update --from-hub`. Both persist `allowHttpPackage: true` in `node.json` so later hub-triggered `package-fetch` calls honour it. Git hosts whose stored `hubUrl` is `http://` cannot convert without that flag (or a hand-edit of `node.json`). A failed CLI update prints `update failed; see ~/.config/tierwyn/node/update.log` after writing the log.

`--from-hub` does **not** short-circuit as “already up to date” while converting. A leftover `~/tierwyn-node` with the hub's current `BUILD_ID` (from a previous failed attempt, or a pre-existing tree) is swapped again. If the converted unit fails `is-active`, rollback restores the git unit **and** the `tierwyn` shim (`~/.local/bin/tierwyn` → the git checkout's `scripts/install.sh`). Without the shim restore, `tierwyn setup` / `doctor` die with “node-only package install” while the daemon is still on git. Retry `--from-hub` after that rollback; it converts.

The git checkout is left on disk (`checkout left at …, safe to delete`). Package → git is out of scope; remove the unit and enroll fresh.

`POST /node/enroll` is public and login-rate-limited. `/remote-hosts*` is cookie-only.

---

## `node.json`

`~/.config/tierwyn/node/node.json`, owned by the node user:

```json
{
  "hubUrl": "https://tierwyn.example",
  "hostId": "…",
  "roots": ["/home/you/tierwyn"],
  "allowedAgents": ["claude-code", "codex", "copilot"],
  "listenPort": 8788,
  "maxSessions": 8,
  "artifactsMaxAgeDays": 90,
  "allowSelfUpdate": true,
  "allowHttpPackage": false
}
```

First enroll (no prior `roots`) defaults to `$HOME/tierwyn` and creates that directory. Re-enroll keeps existing `roots` and never auto-creates custom paths (an unmounted volume must stay missing, not masked).

The node refuses `session.create` for types outside `allowedAgents` and any cwd/root not under `roots` (realpath). There is **no** generic exec or shell RPC; only the named adapter/session/fs/git methods in `packages/shared/src/node.ts`. `artifactsMaxAgeDays` (default 90; `0` disables) is the node-local artifact age sweep. `allowSelfUpdate` (default `true`) gates `node.selfUpdate`. `allowHttpPackage` (default omitted/`false`) is set by `--allow-http` on enroll or `update --from-hub`; `package-fetch` refuses `http://` without it.

If this box also runs a Tierwyn hub (`tierwyn-prod` on 8788), the node needs another loopback `listenPort`: 8788 is the node's tunnel listener, not the hub API. A first enroll picks the first free port from 8788; a re-enroll keeps the existing value.

A compromised hub cannot widen this file; you edit it on the box.

---

## Project files on the host

Two ways to get files under `roots`:

- **Manual clone** by the operator into a path under `roots`.
- **New Project → Clone from URL**: pick a trusted, connected host, paste a URL, and the hub calls `fs.clone` on the node. Fixed, shell-free argv with the URL and target behind `--`:

  ```
  git -c protocol.allow=never clone --no-recurse-submodules -- <url> <target>
  ```

  Allowed URL forms (`isCloneUrlAllowed`): `https://…`, `ssh://…`, and scp-like `git@host:path`. Credentials are the **host's**; deploy keys, `gh auth`, or the node user's ssh-agent. `GIT_TERMINAL_PROMPT=0` and `ssh -o BatchMode=yes`, so prompts and unknown host keys fail fast: run `ssh -T git@github.com` once on the host to accept the key. The clone's parent must be inside `roots` (realpath); a partially cloned target is removed on failure; one clone per target at a time; 5-minute cap; behind a reverse proxy the HTTP call may time out while git keeps running to completion on the host.

  The New Project dialog probes the path live (`GET /remote-hosts/:id/stat-path` → `fs.stat`, 400 ms debounce) and shows a hint: git repo / folder / not found / outside roots / already exists / will clone.

| | |
|---|---|
| Bind | **Runs on** at project create (`POST /projects` `remoteHostId`, optional `cloneUrl`). Host must be trusted + connected. |
| Unbind / move | `PATCH` `remoteHostId` is create-only (400). Remote `rootPath` patch is 409. Delete of a host that still has projects 409s with `projectNames` unless `?unbind=1` (Settings **Delete and unbind**), which nulls `projects.remote_host_id` then removes the host. The project stays; chats no longer run on that machine. |

---

## Managing allowed agents on the host

`tierwyn node allow|disallow <agent>… [--no-restart]` edits only `allowedAgents` in `node.json` (raw JSON, other keys round-trip; atomic write, mode 0600; list sorted + deduped). Each positional may be comma-separated; `--all` allows every node-capable type / clears the list. Names are validated against the node's adapter registry (typos get a "did you mean"); `allow grok-bot` is refused (hub-only), `disallow grok-bot` is a no-op. Exit codes: 0 ok / no change, 2 usage, validation or not enrolled (nothing written), 1 write or restart failure.

The node reads `allowedAgents` only at boot, so a changed list **restarts `tierwyn-node.service` by default**; live sessions on that host end. `--no-restart` defers it; an unchanged list writes nothing and restarts nothing. `tierwyn node status` is read-only and warns when the running service predates `node.json`. It does not show hub connection state (see `tierwyn node logs` / Settings).

---

## Agents on the host: install + login

1. `tierwyn node allow <agent>…` on the host (hand-editing `allowedAgents` in `node.json` + restart still works as a fallback). They appear as chips in Settings → Remote Hosts (allowed-or-installed; old nodes that don't send `allowed` keep showing what's installed).
2. **Install ▸**: for types the node marks `installable`, Settings offers Install. The command is a fixed `AGENT_BINARIES` entry baked into the node build; never hub-supplied argv. The node refuses while that agent has live sessions on the host (`agent_busy`), caps the run at 10 minutes, and reports an output tail; a failed run's last log line shows under the host row.
3. **Log in**: Codex, Claude Code, Copilot, Grok Build, and Cursor log in from Settings when the node advertises `agents.login` / `agents.login.claude` / `agents.login.copilot` / `agents.login.grok` / `agents.login.cursor`. Others still use the box (`kimi login`, …). Claude: open the link on any machine, paste the code shown. Codex / Copilot / Grok: open the device URL and enter the code shown in the modal. Cursor: open the live URL (no device code). Credentials land on the host (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.copilot/config.json`, `~/.grok/auth.json`, `~/.config/cursor/auth.json` or `~/.cursor/auth.json`). Login is not offered when a key or token is already present (`node.env`, delivered vault env, or credentials file). Update the node to get the button. The same runner (`node/loginRunner.ts`) also drives hub-local login from Settings → Agents.

   **Residual risk.** Hub allowlists pin the sign-in URL to the genuine host and path. A compromised node can still display an attacker-requested-but-valid device code on that genuine page. Treat an unexpected code with suspicion. Cursor has no code: start that login only from Settings and abandon a link you did not just request. This is not fixable in the client.
4. **Refresh** re-fetches `node.hello` (old node builds degrade to a liveness ping) and updates the chips: `ready`, `not logged in`, `installing…`, `queued`, or `not installed (manual)` for types with no install command. Settings polls every 5 s while an install, an install-all batch, a node update, or a remote agent login is in flight.

**Versions + install-all.** Nodes advertising the `agents.version` feature report each allowed agent's installed CLI version in `hello` (`probeInstalledVersion`, ~5 s timeout per agent); the hub decorates every hello agent with `latestVersion` from its `agent_versions` cache and sets `behind: true` when the node-reported version is older. Old nodes report no version; they still get **Update ▸** (every installed agent with an install command shows it, behind or not), just no `behind` pill or "N behind" count. A freshly settled install shows `updated ✓` on its chip for ~2 minutes.

**Install & update all (N)** runs the node's `agents.install` RPC once per target; missing agents first, then ones the hub knows are behind (`mode: missing+behind`); strictly sequentially. The host view carries `installBatch: { running, remaining }`; if the host disconnects mid-batch, the remaining types are marked `not attempted`. grok-bot has no install command and is never auto-installed.

The login state is a credential probe, not validation; an expired token still reads as logged in, and `unknown` (no state shown) where we cannot check (macOS keychain, no probe entry). Probes **read file contents** (not existence): leftover empty/`{}` files after logout are logged out. Settings → Remote Hosts re-probes via `agents.loginStatus` on list (old nodes keep hello-time status):

| Agent | Files probed | Env probed | Platforms |
|---|---|---|---|
| claude-code | `~/.claude/.credentials.json` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | linux |
| codex | `~/.codex/auth.json` | `OPENAI_API_KEY` | all |
| grok-build | `~/.grok/auth.json` | `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY` | all |
| copilot | `$COPILOT_HOME/config.json` or `~/.copilot/config.json` | `COPILOT_GITHUB_TOKEN` | all |
| cursor | `$XDG_CONFIG_HOME/cursor/auth.json` or `~/.config/cursor/auth.json`, plus `~/.cursor/auth.json` and macOS `~/Library/Application Support/Cursor/auth.json` | `CURSOR_API_KEY` | all |
| kimi | `$KIMI_CODE_HOME/credentials/` + `config.toml`, or `~/.kimi-code/` | `KIMI_API_KEY` | all |
| kiro | `$XDG_DATA_HOME/kiro-cli/data.sqlite3` or `~/.local/share/kiro-cli/data.sqlite3` (`auth_kv`) | `KIRO_API_KEY` | all |

The hub catalogue stays global; the model picker greys profiles the host did not advertise as installed.

systemd user units do not inherit the login `PATH`. Create `~/.config/tierwyn/node/node.env` (mode `0600`) with a `PATH=` that includes `~/.local/bin` and `~/.npm-global/bin` (write expanded paths). The unit template always has optional `EnvironmentFile=-%h/.config/tierwyn/node/node.env` (the leading `-` means the file may be missing). `tierwyn node setup` re-renders the live unit from the template, so do not hand-edit `EnvironmentFile=` there; put PATH in `node.env`.

---

## Runs on

Binding is **per project only**. Create the project with **Runs on** set to the host (or omit for this server). Conversations in that project spawn adapters on the node. There is no per-conversation override.

---

## Guard table (hub UI vs host tools)

The agent's own tools run on the host. Hub-side surfaces for a remote project go through the node RPC or return **409**:

| Surface | Remote project |
|---|---|
| Files browser / transcript file links | `files.list` / `files.read`; GET sets `X-Tierwyn-File-Writable: 1` when Settings file edits are on, the host advertises `files.write`, and the path passes write policy |
| File edits / git-diff editor | ✅ `files.write` (`PUT /files` → node RPC). Old node → 501 `remote host needs update` |
| Git working-tree panel | read views + mutations over `git.call`, behind the host-scoped live-agent guard |
| Git `create-worktree` | ✅ `git.worktree` (`addOperatorWorktree`). Old node → 501. Parent dir outside `roots` → 400 `worktree_outside_roots` |
| Working-tree drafts | keyed `remote:<hostId>:<cwd>` (hub-local drafts use plain `<cwd>`) |
| Shell panel | 409 (not in P3) |
| Spawn `workdir: 'worktree'` | ✅ `git.worktree` (`createSpawnWorktree`). Old node falls back to `shared` with a workdir note. Parent-outside-roots → 409 `confirmShared` |
| Checkpoint code snapshots / diffs / restore | ✅ `git.shadow` over `git.call`. Old node keeps codeRef-less checkpoints / 409 on code-diff/restore |
| Native MCP inspect / install / remove | ✅ `mcp.native`. Old node → 409 `remote_project` (legacy) or 501 `node_update_required` |
| Hub-placed MCP `sse` / `stdio` | ✅ `tunnel.stream`. Old node skips them (`hub_placement_unsupported`); hub-placed `http` still uses the buffered `http` RPC |
| Node self-update | ✅ `node.selfUpdate` (`POST /remote-hosts/:id/update`). Old node → 501 `node_update_required` |
| Agent Bash / Edit / build | on the host |

---

## Sidecars on remote projects

Commit / describe / enhance / btw one-shots for a remote project dispatch to the node with the project cwd (tools off). If the node predates the method, the hub falls back to a local run against `safeLocalCwd`; a mirror of the project root on the hub; with no mirror the call fails with a clear message. `read_only` one-shots get a 120 s timeout floor. Settings → Remote Hosts shows per-host **parity advisories** derived from the node's agent versions, calling out where sidecar results may differ from the hub.

---

## MCP secrets

Per-host **Allow MCP secrets** (`allowMcpSecrets`, default **on**). A trusted host with the toggle on receives resolved MCP secret values inside `session.create` / `start` frames over TLS. They are never on argv. The node injects them with `${TIERWYN_MCPV_n}` and redacts them from outbound frames. Turn the toggle off to send only secret-free MCP servers.

Hub secrets (`SESSION_SECRET`, password hash, plugin vault, hub `process.env`) never leave the hub. Plugins still run on the hub; agents reach them through the tunnel.

Each registry server carries a `placement` (`auto` | `agent` | `hub`): `agent` servers are injected into the node's `session.create` (secrets only when **Allow MCP secrets** is on), `hub` servers stay hub-side and are reached through the tunnel. Hub-placed `http` works on the buffered `http` RPC; hub-placed `sse`/`stdio` need `tunnel.stream` (see [Phase 3](#phase-3)). Details: [MCP servers § Placement](mcp-servers.md#12-placement-p2a-remote-hosts).

## Agent env secrets

Per-host **Allow agent env secrets** (`allowAgentEnvSecrets`, default **off**). With the toggle on, the per-agent env stored in the hub vault (Settings → Agents → Environment, `env.<agentType>.<NAME>` under the agent vault) is replicated to the node over the `agentEnv.sync` RPC:

- Values go over the host's WebSocket link into **node memory only**; nothing is written to node disk; are lost on node restart, and are re-sent on the next reconnect.
- **Plaintext guard:** if the host was enrolled against a non-loopback `http://` hub URL, the hub refuses to send values over the unencrypted link and delivers only the managed variable **names** (still enough for the login badge and child-env scrub), logging `[hub] refusing to send agent env secrets over plaintext ws:// to non-loopback host <id>`. Loopback `http://` (`localhost`, `127.*`, `::1`) is exempt; put a TLS reverse proxy in front to get values on a LAN.
- The hub sends values only for agents the host allows. Every vault-managed name is still scrubbed from the node's other children, as on the hub.
- With the toggle on, the vault value **beats `node.env`** for its agent.
- The sync also runs when the toggle changes: off empties the node's store, so **future** agent processes start without the values. Values the node has already received stay in its memory for the rest of the node process so outgoing frames keep scrubbing them; they are only guaranteed gone after **`tierwyn node restart`**. Running processes keep what they started with, so **rotate the key after a compromise**. Disabling or deleting the host pushes this empty sync before the disconnect.
- Old nodes without the `agent_env` feature never receive anything and the switch is disabled until the node is updated (`tierwyn node update`). The key simply isn't delivered.
- Once a matching variable name has been delivered (e.g. `CLAUDE_CODE_OAUTH_TOKEN` for claude-code), the host view badges the agent as logged in even when the box itself has no local credential; the same presence heuristic, evaluated hub-side.

This is **not** a boundary against the node's user: an unsandboxed agent running as the same user can read the node's memory, and a **compromised host with the toggle on controls its own `allowedAgents`**; it can claim every agent type (except Grok Bot, which is never eligible) and receive all of those agents' vault values. Use `sandbox: "require"` on less trusted hosts, and rotate any secret that reached a host you no longer trust. A leaked key affects **every host using it**; keys are one per agent type, not per host.

Env vars only; login files are not synced:
- **Claude Code:** `ANTHROPIC_API_KEY` in the vault may switch Claude Code on those hosts to API billing; use `CLAUDE_CODE_OAUTH_TOKEN` to stay on a subscription.
- **GitHub Copilot:** On remote or headless nodes where no desktop keyring exists, store `COPILOT_GITHUB_TOKEN` in the vault (Settings → Agents → Copilot → Encrypted environment). GitHub Copilot CLI requires a GitHub OAuth token (`gh auth token`, starting with `gho_`); raw Personal Access Tokens (`github_pat_` / `ghp_`) are rejected by Copilot's backend model endpoints (`api.individual.githubcopilot.com`). The adapter aliases the token to both `COPILOT_GITHUB_TOKEN` and `GH_TOKEN` for child processes.

## Artifacts (P2a)

Plugin runs for remote conversations execute on the hub; the conversation's files live on the host. The artifact shard bridges the two:

- The node advertises its artifacts root in `hello.artifactsRoot` and keeps per-conversation shards at `<artifactsRoot>/<conversationId>/`; the hub mirrors shards under `<dataDir>/artifacts/<conversationId>/`.
- A plugin call goes through `invokeForRemote`: input paths pointing into the node shard are pulled with `artifact.read` (4 MiB chunks, sha256-verified, ≤ 8 files and ≤ 64 MiB per call), the plugin runs against hub copies, and outputs are pushed back with `artifact.write`; every path in the reply is rewritten to its node location.
- A failed push leaves the file on the hub and returns a retryable error that hints `POST /agent/artifacts/deliver {"name": …}` (agent callers only, 10/min per conversation). The hub's `.remote-in` staging dirs are swept at boot.
- Deleting a host purges the hub shards of conversations bound to it.

---

## Native session cleanup

Deleting a conversation, deleting a schedule, and nightly schedule retention also unlink the matching native session files on the host (`adapter.deleteNativeSession`, best-effort after the DB transaction commits; adapters whose native state is a shared DB skip gracefully). If the host is offline the unlink is skipped and the stray `.jsonl` stays on the box; the hub logs the failure; remove the files by hand if the host never comes back.

---

## Schedules on remote hosts

Jobs on a project bound to a remote host run the tick agent on that host (same adapter-boundary path as a normal remote chat). Availability is checked twice:

- **Create-time:** the profile must be installed (and model-present when the host reports models) on the host. A miss returns **400**. A **disconnected** (or unknown) host is also a **400** at create (`reason: host_disconnected`). Profiles that fail the installed/model check are hidden from the create-schedule modal; a disconnected or unknown host also shows a modal warning that runs will fail until the host reconnects.
- **Fire-time:** before any run conversation is created, the hub re-checks host connectivity and profile availability. A disconnected host fails the run with a stable `host_disconnected` error (recorded as run status **`failed`**, not skipped). After **3 consecutive** host-miss failures (`HOST_MISS_AUTO_DISABLE`), the job auto-disables (same pattern as other auto-disable paths) so a long outage does not keep filling the run log. Editing plan steps while the host is offline stays allowed; step-replace does not re-check host availability.

**Pack files** for a remote project are written on the node via the feature-gated RPC `schedule.packFiles` (hub substitutes tokens, then the node materialises only `<root>/.tierwyn/schedule/<slug>-<kind>.md`). Old nodes that lack the feature answer **501** `node_update_required`; a disconnected host answers **409** `host_disconnected`. Pack files are materialised **before** `createJob`; if materialisation fails, any files already written are rolled back and **no job row is created**.

**Deferred (R3):** bearer routes that pause a request, write pending-context, or retry a step are **not** added to `TUNNEL_RULES` yet; nothing advertises those paths to remote agents. When they are advertised, tunnel allow-list entries will land in a follow-up.

See also [scheduled-jobs.md](scheduled-jobs.md).

---

## Phase 3

P3 finishes the remote filesystem and MCP story. Every new node capability is advertised in `hello.features`. The hub gates each feature on that list (`hostHasFeature`); an old node degrades to P2 behaviour or a **501** `{ error: 'remote host needs update', code: 'node_update_required' }` and never hits an unhandled `no_method` 500.

### `hello.features`

| Feature | Hub behaviour when the host does not advertise it |
|---|---|
| `tunnel.stream` | Hub-placed `sse`/`stdio` skipped (`hub_placement_unsupported`). Hub-placed `http` stays on the buffered `http` RPC (8 MiB body cap). |
| `mcp.native` | Native MCP routes stay 409 `remote_project` (config still lives on the host; the hub cannot edit it over RPC). A live `no_method` → 501 `node_update_required`. |
| `files.write` | `PUT /files` → 501 `remote host needs update`. GET still reads; `X-Tierwyn-File-Writable: 0`. |
| `artifacts.sweep` | Node-local only. Old nodes simply never sweep. |
| `git.worktree` | `POST /files/working-tree/create-worktree` → 501. Spawn `workdir:'worktree'` falls back to `shared` with a workdir note. |
| `git.shadow` | Checkpoints stay codeRef-less; code-diff / restore keep the P2 409. |
| `node.selfUpdate` | `POST /remote-hosts/:id/update` → 501 `node_update_required`. |
| `fs.mkdir` | `POST /projects` with `createIfMissing` → 501 `node_update_required`; auto-creation of missing leaf folders on remote host disabled. |
| `fs.move` | `POST /projects/:id/move` → 501 `node_update_required`; folder moves on the remote host require `tierwyn node update`. |
| `schedule.packFiles` | Schedule-pack create that needs files on the remote root → 501 `node_update_required` (no job is created; any files already written are rolled back). |
| `agent_env` | Key isn't delivered; the toggle is disabled until the node is updated (`tierwyn node update`), and the delivered-login badge stays off. |
| `agents.login` | No Codex login button; the chip says to run `codex login` on the box; route 409. |
| `agents.login.claude` | No Claude button; the chip says to run `claude auth login` on the box; route 409. |
| `agents.login.copilot` | No Copilot button; the chip says to run `copilot login` on the box; route 409. |
| `agents.login.grok` | No Grok button; the chip says to run `grok login` on the box; route 409. |
| `agents.login.cursor` | No Cursor button; the chip says to run `cursor-agent login` on the box; route 409. |
| `agents.loginStatus` | Login chips stay at connect-time hello until the node reconnects or Refresh rebuilds hello. |

`NODE_FEATURES` in `packages/shared/src/node.ts` is the canonical list.

### Streaming tunnel

The buffered `http` RPC still exists for old hubs and for request/response bodies that fit in 8 MiB (`TUNNEL_MAX_BODY_BYTES`). A P3 node that hears `tunnel.stream` from `hub.features` switches the tunnel listener to framed streaming:

| Frame | Direction | Meaning |
|---|---|---|
| `http.head` | node → hub | request (`method` + `path` + headers). `rid` is allocated by the node. |
| `http.head` | hub → node | response (`status` + headers). |
| `http.chunk` | both | body bytes, base64. Raw chunk size `TUNNEL_STREAM_CHUNK_BYTES` (256 KiB). |
| `http.end` | both | body complete, or `error` to abort. |
| `http.credit` | receiver → sender | bytes consumed; refills the window. |

Credit window: a sender may have at most `TUNNEL_STREAM_WINDOW_BYTES` (1 MiB) unacknowledged raw bytes in flight. The receiver sends `http.credit` once the sink accepted the chunk (`res.write()` returned `true`, or after `'drain'`). Response bodies have no total cap (SSE); idle streams abort after `TUNNEL_STREAM_IDLE_MS` (15 min). Max 32 concurrent streams per host (`TUNNEL_STREAM_MAX_PER_HOST`); the 33rd is 503. Request bodies are capped at `TUNNEL_STREAM_MAX_REQ_BYTES` (64 MiB).

Replay rules match the buffered path: path allow-list, drop `Cookie` / `X-Forwarded-*` / `Host`, set `X-Tierwyn-Node`, `agent:false`, reject GET/HEAD-with-body, keep framed `content-length`. Streaming additionally drops `content-length` from response headers so SSE can flush. Peer close or client disconnect sends `http.end` with error; both ends release the stream.

### Remote file editing

`PUT /files` on a remote project calls node `files.write` (not hub disk):

- **Version token** `mtimeMs-size` (`versionToken`). A mismatch returns 409 `{ error: 'file has changed', currentVersion }` and leaves the file untouched.
- **Live-agent 409** when any agent is active on that checkout (same shape as local saves).
- **Policy:** lexical `isWritePathAllowed` (project root + conversation worktree; no `.git` segments, no dotfiles, openable extension, not a secret path) **and** `realpath` inside node `roots` so a symlink cannot escape.
- GET advertises **`X-Tierwyn-File-Writable: 1`** when Settings file edits are on, the host has `files.write`, and the path would pass write policy.

### Remote worktrees

`git.call` mutations `addOperatorWorktree` (operator create-worktree modal) and `createSpawnWorktree` (spawn / schedule `workdir:'worktree'`). Before git runs, the node checks that the repo's parent directory is under `roots` (`worktree_outside_roots`); a host whose `roots` *is* the repo would otherwise write the sibling worktree outside the jail. Operator create-worktree maps that to HTTP 400 with a roots hint; spawn maps it to 409 `{ warning, wouldRunIn: 'shared', retryWith: { confirmShared: true } }`.

### Remote checkpoints

Code snapshots, diffs, and restore ride `git.call` `GIT_SHADOW_METHODS` (`isGitRepo`, `snapshotCode`, `restoreCode`, `deleteShadowRef`, `resolveShadowRef`, `codeDiff`, `isWorkingTreeClean`, `currentHead`) in `apps/server/src/git/shadowOps.ts`. The hub binds `checkpointOpsFor` → `RemoteShadowOps` when the host advertises `git.shadow`. Without the feature, callers keep P2's codeRef-less checkpoints and 409 on code-diff/restore.

### Artifact age sweep

Node-local. `artifactsMaxAgeDays` in `node.json` (default 90; `0` disables). A background sweep runs 60 s after start, then every 24 h, and deletes conversation shards older than the window under `hello.artifactsRoot`.

### Node self-update

Settings **Update** (`POST /remote-hosts/:id/update`) calls `node.selfUpdate`. The node refuses when `allowSelfUpdate` is false, sessions are live, `systemd-run` is missing, or an update is already running. On accept it `systemd-run --user`s a unit **outside** `tierwyn-node.service`'s cgroup with a **fixed** argv: `bash <install-root>/scripts/install.sh node update`; no URL from the hub; the node uses its stored `hubUrl`.

| Host source | What Update does |
|---|---|
| Git (`hello.installSource` absent or `git`) | `git pull --ff-only`, rebuild shared + server, restart the node unit. Hub always RPCs, even if a package exists. |
| Package (`hello.installSource === 'package'`) | Fetches the hub tarball (`package-fetch`, no HTTP redirects), swaps `~/tierwyn-node` (keeps `.prev` for rollback), restarts. Same BUILD_ID → hub answers **200 `{ upToDate: true }`** with no RPC. No hub package → **503 `package_unavailable`**. A failing `self-check` runs **before** the swap and leaves the current tree in place. An inactive unit after restart rolls back to `.prev`. |

`allowSelfUpdate: false` blocks the hub-triggered path for both sources. Hand-run `tierwyn node update` on the host still fetches (git remote or hub package). The hub returns 202 (or 200 up-to-date) and reports progress from the next `hello.gitSha` (BUILD_ID on package hosts). If the node never reconnects, the hub tail is `no reconnect within 10 min; see ~/.config/tierwyn/node/update.log` (fetch / `self-check` failures exit before restart, so there is no reconnect to observe). `package-fetch` refuses HTTP redirects (`redirect: 'error'`), so a 30x cannot leave the stored `hubUrl` origin.

---

## Commands (on the remote host)

```bash
tierwyn node setup              # build + install unit; does not enable or start
tierwyn node enroll --hub URL --token TOK   # [--dir] [--all-agents | --agents a,b] [--allow-http]
tierwyn node allow <agent>… | --all [--no-restart]     # edit allowedAgents
tierwyn node disallow <agent>… | --all [--no-restart]
tierwyn node status [--json]    # config, service state, per-agent allowed/binary table
tierwyn node run                # foreground (same as the unit ExecStart)
tierwyn node start|stop|restart # tierwyn-node.service only; never tierwyn-prod*
tierwyn node logs
tierwyn node update [--from-hub] [--allow-http]  # git: pull+rebuild; package: fetch hub tarball; --from-hub converts git → package
```

This is the **remote-host** daemon. Hub install remains `tierwyn setup` / `tierwyn start prod`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `protocol mismatch` (WS 4426) | `hello.protocol` ≠ hub `NODE_PROTOCOL` | `tierwyn node update` on the host, then `tierwyn node restart` |
| Agent `ENOENT` / spawn fail | systemd user PATH lacks the CLI dir | create `~/.config/tierwyn/node/node.env` (0600) with `PATH=` including `~/.local/bin` and `~/.npm-global/bin`, then `tierwyn node restart` |
| WS 4403 `untrusted` | enrolled but not Trust, or disabled | Trust (fingerprint + hostname), or re-enable. Auto-trust (opt-in) skips this for a new host. |
| WS 4409 `replaced` | a second `tierwyn node` connected for the same host | one daemon per host; the new link wins |
| enroll 401 / invalid token | expired (10 min) or already used | create a new host / token in Settings |
| 403 `token_origin_mismatch` | remote token on hub loopback, or local token through the node listener | tokens are origin-bound; use the matching loopback |
| Install / clone / stat-path `no_method` | old node build without the P2b/P2c methods | update tierwyn node on the host (git pull + rebuild), then `tierwyn node restart` |
| 501 `node_update_required` / `remote host needs update` | host `hello.features` lacks the P3 method (`files.write`, `git.worktree`, `mcp.native`, `node.selfUpdate`, …) | `tierwyn node update` on the host (or Settings → Update), then retry |
| File save 409 `file has changed` | VM file mtime/size moved between GET and PUT | reload, save again |
| File save 409 agents active | live session on that checkout | stop the agents, retry |
| create-worktree 400 `worktree_outside_roots` | repo parent is not under `roots` (roots *is* the repo) | add the parent directory to `roots` in `node.json`, restart the node |
| clone `Host key verification failed` | node user never accepted the git host's key | run `ssh -T git@github.com` once on the host, retry |
| install fails `agent_busy` | that agent has live sessions on the host | stop them, retry Install |
| curl enroll dies on `--hub` | old `install.sh` treated remaining args as unknown | need a clone whose installer recognizes `node` as a command |
| enroll 401 / `enroll token invalid or expired` on package fetch | token expired (10 min), already used, or wrong Authorization header | create a new host / token in Settings; token is a Bearer header, not a URL query |
| `hub package changed; re-run the one-liner` | hub rebuilt between `install.sh` and the tarball | paste a fresh one-liner from Settings |
| `http:// hub refused without --allow-http` | origin is plain HTTP | add `--allow-http` on enroll or `update --from-hub` only if you accept the MITM risk (Settings does not add it). The flag persists as `allowHttpPackage`. |
| `update failed; see ~/.config/tierwyn/node/update.log` | CLI `tierwyn node update` failed before or during restart | read that log (fetch, self-check, extract, systemd). Hub UI “no reconnect” tails point at the same file. |
| `--from-hub` exits 0 but the unit is still git | leftover `~/tierwyn-node` with the current BUILD_ID used to short-circuit conversion | retry `--from-hub` (conversion no longer short-circuits). If `tierwyn setup`/`doctor` die “node-only package install”, the shim was left on the package tree; rollback now restores it; re-point `~/.local/bin/tierwyn` at the git `scripts/install.sh` if you are on an older installer. |
| 503 `package_unavailable` | hub has no `dist/node-package` (dev without a server build) | build the hub (`npm run build --workspace=apps/server`) or use the GitHub one-liner |
| PATH `claude` version / SDK mismatch on a packaged node | packaged builds drive PATH `claude`, not the SDK-pinned binary | install a matching `claude` CLI on the host; git nodes still use the SDK binary |
