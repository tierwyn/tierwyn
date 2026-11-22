# Agent sandbox (bwrap)

Optional OS-level isolation for agent CLI processes, built on [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`). Off by default. When on, the hub (or a `tierwyn node`) wraps **every stdio agent CLI process it starts** in a bwrap sandbox: private mount namespace, private PID namespace, `--die-with-parent`. Nothing runs "half" sandboxed; the setting is resolved once per session start and the process lives or dies inside it.

This is Tierwyn's own sandbox, distinct from the per-agent CLI sandbox flags some harnesses expose natively (codex `read-only`/`danger-full-access`, cursor `--sandbox`, grok-build `--sandbox`, qwen `-s`). Those configure the agent's own internals; the bwrap sandbox wraps the whole CLI process regardless of agent.

## Host requirement: user namespaces

bwrap needs unprivileged user namespaces. Ubuntu 24.04 blocks them through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`), and its `apparmor` 4.0 package ships no bwrap profile (26.04's `apparmor` 5 includes `bwrap-userns-restrict`). Without one, every `bwrap` call fails (`Failed RTM_NEWADDR: Operation not permitted`) and the sandbox is unavailable. `tierwyn setup` (Prerequisites) and `tierwyn node setup` detect this and offer to write `/etc/apparmor.d/tierwyn-bwrap`, a copy of 26.04's `bwrap-userns-restrict`: `/usr/bin/bwrap` may set up namespaces, but everything it runs is confined to an `unpriv_bwrap` profile with every capability denied. bwrap therefore cannot be used to obtain a capable user namespace (the hole the global restriction closes), and the global restriction stays on. Same trade-off as 26.04: no nested bwrap inside the sandbox (the codex adapter already switches its own sandbox off when Tierwyn sandboxes it). Installs that wrote the earlier `flags=(unconfined)` profile are offered the tightened one on the next `tierwyn setup`. To see the exact profile, run `tierwyn setup` or read `bwrap_profile()` in `scripts/install.sh`; apply manually with `sudo apparmor_parser -r /etc/apparmor.d/tierwyn-bwrap`.

`tierwyn doctor` reports the bwrap state. Restart Tierwyn afterwards.

## Where it is enforced

- **At session start.** Every new CLI process for a turn is spawned through the sandbox wrapper when the conversation resolves to sandbox on (`apps/server/src/sandbox/bwrap.ts`, `sandboxSpawnFor`). A running process is never hot-swapped: changing a setting affects the conversation's **next** session, not the live one.
- **Process trees die together.** bwrap runs with `--die-with-parent --unshare-pid`; stopping a session signals the inner CLI first so it can flush state, then reaps the whole tree.
- **Agent-internal subagents inherit it for free.** A CLI's own sub-processes (a Task tool, internal helpers, the agent spawning its own sub-clients) are ordinary children of the CLI process and stay inside the same mount/PID namespace for their entire lifetime. They cannot opt out and cannot escape.

## Settings and precedence

Sandbox state resolves per session start through a most-specific-wins chain:

| # | Tier | Stored where | Set by |
|---|---|---|---|
| 1 | Conversation | `conversations.sandbox` (`NULL` / `'on'` / `'off'`) | Sandbox pill / conversation settings (operator) |
| 2 | Project | `projects.sandbox` | Project edit modal (operator) |
| 3 | Host + agent default | Settings → Sandbox matrix | Operator |
| 4 | Agent default (all hosts) | Settings → Sandbox matrix | Operator |
| 5 | Host default (all agents) | Settings → Sandbox matrix | Operator |
| 6 | Global default | Settings → Sandbox | Operator |

`NULL` means *inherit the next tier down*; the global default is the floor. With no saved Settings → Sandbox row, the global default is **off**, except on a dedicated hub install (`TIERWYN_DEDICATED_HUB=1` in `hub.env`, written only by `tierwyn setup` → hub mode), where it is **on**. A dev checkout never sets it. A dedicated hub also refuses a project rooted at or above its own checkout, because the project cwd is writable even under bwrap. See [Dedicated hub user](../deploy/hub-user.md). The resolved value, which tier won, and the effective custom paths are visible per conversation via `GET /conversations/:id/sandbox`.

Every tier is **operator-controlled**. There is no agent-writable sandbox setting anywhere: the conversation/project PATCH routes and Settings are cookie-only, and the spawn bearer token an agent holds cannot reach them.

Sandboxed agents' history search is capped to the project even when the operator enabled All projects; see [agent-search.md](agent-search.md).

## Capability overrides and fail-closed behaviour

The resolved *wanted* state is filtered through host capability:

- **Remote node policy `sandbox: "require"`** forces sandbox **on** regardless of any tier; the node refuses to run unsandboxed.
- **Wanted on but the host can't sandbox** (no `bwrap` binary, agent has no sandbox profile, node too old):
  - If the ON came from an **inherited** tier (defaults/global), the turn runs **unsandboxed with a loud notice**: `Sandbox: off (host can't sandbox)`.
  - If the ON is an **explicit** conversation/project `on`, the session **fails** (`sandbox_unavailable` / `sandbox_unsupported_agent`) rather than silently running unsandboxed. Fail-closed.
- **grok-bot is never sandboxed** (CDP attach to a desktop app, not a spawned CLI).
- **antigravity** on desktop Linux stores its OAuth token in the OS keyring (Secret Service over `/run/user/<uid>/bus`), which `bwrap` intentionally blocks; keep sandbox **off** for `antigravity` in **Settings → Sandbox** unless using non-keyring auth.
- Every stdio agent has a sandbox profile. GitHub Copilot's keyring sign-in is unreachable inside bwrap, so a sandboxed Copilot authenticates with `COPILOT_GITHUB_TOKEN` set in **Settings → Agents → Copilot → Environment** (a GitHub OAuth token from `gh auth token`, prefixed with `gho_`; stored in the encrypted vault under `tierwyn:agents` as `env.copilot.COPILOT_GITHUB_TOKEN`, write-only via `PUT|DELETE /settings/agent-env/copilot/COPILOT_GITHUB_TOKEN` (cookie), redacted from persisted events). Note that Copilot backend endpoints reject standard PATs (`github_pat_...` / `ghp_...`) with *Personal Access Tokens are not supported for this endpoint*. Sandboxed Copilot aliases the vault token to `GH_TOKEN` while blanking `GITHUB_TOKEN`, and runs `--allow-all` (paths + URLs, deny list kept) since bwrap is the boundary. Unset while sandboxed → the turn fails at start instead of escaping. The same vault token is injected when Copilot runs unsandboxed. On a remote host the token arrives through the per-host **Allow agent env secrets** toggle ([remote-hosts.md § Agent env secrets](remote-hosts.md#agent-env-secrets)); with it off, a sandboxed Copilot there has no token source and fails the same way.

## What runs inside the sandbox

Built per CLI process (`buildBwrapArgv`):

- **`$HOME` is a tmpfs.** Toolchain and config dirs are bound back read-only (`.nvm`, `.npm-global`, `.cargo/bin`, `.local/bin`, …); the agent's own profile dirs are read-write (e.g. `~/.claude` for claude-code, `~/.codex` for codex, `apps/server/src/sandbox/profiles.ts`).
- **System trees read-only** (`/usr`, `/etc`, `/bin`, `/lib*`, `/opt`, …), `/tmp` a tmpfs, `/dev` and `/proc` private.
- **Working tree read-write**: the conversation cwd (spawn worktree or project root) plus the git common dir, so worktree commits work. `cwd/.git` is self-bound as a mount point so directory renaming (`mv .git .gitold`) fails with `EBUSY`. Repository control files (`.git/config`, `.git/hooks`, `.git/info`, `.git/config.worktree`, `.git/commondir`, and a worktree's `.git` file) are then overlaid **read-only** (`--ro-bind`). If `.git/hooks` is missing, an empty tmpfs remounted read-only (`--tmpfs <path> --remount-ro <path>`) is mounted over the path to prevent creating new hook scripts. Agents inside bwrap cannot write git config or install hooks, so commands that alter repository config like `git config` or `git push -u` fail; use `git push origin <branch>`.
- **Custom paths** (Settings → Sandbox host paths ∪ project `sandboxPaths`) bound ro/rw; on remote nodes rw paths must sit inside the node's configured roots.
- **Deny masks** over secrets regardless of the above: `~/.ssh`, `~/.gnupg`, `~/.git-credentials`, `~/.config/tierwyn`, the hub data dir, `/etc/tierwyn`, and `.env*` files under the repo root.
- **Argv auto-bind** only mounts regular files that are not under `/proc`, `/sys`, `/dev`, `/run`, `/etc`, `/boot`, `/root`, or `/var/{lib,run}`.

## Git execution safety (hub `gitExec`)

All hub-side git invocations (checkpoints, git panel, worktree creation, status, diffs) are centralized through `apps/server/src/git/gitExec.ts` (`gitSync` / `gitAsync`).

- **Safe command-line overrides (`GIT_SAFE_CONFIG`):** Invocations apply command-line `-c` options that take precedence over repository and user config:
  - `core.hooksPath=/dev/null` (skipped only when `TIERWYN_GIT_RUN_HOOKS=1` and running under an operator profile).
  - `core.editor=true`, `sequence.editor=true`, and `core.pager=cat` to prevent editor or pager spawns.
  - `protocol.ext.allow=never` and `protocol.file.allow=user` to prevent arbitrary protocol transport execution.
  - `commit.gpgSign=false` for background operations (retained for operator profile).
- **Environment sanitization:** Strips execution-hijacking environment variables (`GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS`, `GIT_EXEC_PATH`, `GIT_PROXY_COMMAND`, `GIT_PAGER`, `GIT_EDITOR`, `SSH_ASKPASS`, and `GIT_CONFIG*`). Sets `GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_NOSYSTEM=1`. Background operations force `GIT_CONFIG_GLOBAL=/dev/null` and set fixed committer/author identities (`Tierwyn <tierwyn@localhost>`).
- **Safe repo configuration checks (`assertSafeRepoConfig`):** Before running git in any repository or worktree, the repository-level `.git/config` (and `config.worktree` if present) is scanned for unsafe execution keys:
  - Custom filter, diff, or merge drivers (`clean`, `smudge`, `process`, `textconv`, `command`, `driver`).
  - Exec keys including `diff.external`, `submodule.*.update`, `core.fsmonitor`, `core.hookspath`, `core.sshcommand`, `core.gitproxy`, `core.askpass`, `core.editor`, `core.pager`, `core.alternaterefscommand`, `uploadpack.packobjectshook`, and `remote.*.{uploadpack,receivepack,vcs}`.
  - Inclusion directives (`include.*`, `includeif.*`).
  - Credential and signing helpers (`credential.*`, `gpg.*`, `sequence.editor`).
- **Permitted configuration exceptions:**
  - Standard `git-lfs` filter configurations (`filter.lfs.clean`, `filter.lfs.smudge`, `filter.lfs.process`, `filter.lfs.required`).
  - Standard `core.hooksPath` configurations where the resolved path matches `<gitDir>/hooks` or `<commonDir>/hooks`. Non-standard hook directories (e.g. `.husky/`, `/tmp`) are refused with `GitUnsafeConfigError`.
- **Scan cache integrity:** Scan verdicts are cached by `dev:ino:ctime:size:mtime` (using 64-bit integer file stats, up to 256 entries). Because `ctime` is maintained by the filesystem kernel and cannot be forged by user-space timestamp tools, modifying `.git/config` immediately invalidates cache hits. Repositories with unsafe configuration keys lose git panel and checkpoint operations until those keys are removed or relocated to `~/.gitconfig`.
- **Operator hooks flag (`TIERWYN_GIT_RUN_HOOKS`):** Operator UI commits bypass `core.hooksPath=/dev/null` only when `TIERWYN_GIT_RUN_HOOKS=1` is set in the environment, provided `assertSafeRepoConfig` passes. Unsandboxed same-UID agents can still edit repository files, so enabling hooks remains an operator opt-in.

## Secrets: `prod.env`, per-agent vault, and sandbox

bwrap hides **files** (`/etc/tierwyn`, the hub data dir, repo `.env*`) from a sandboxed CLI. It does **not** strip **environment variables**: if a provider key lives only in `/etc/tierwyn/prod.env`, the hub loads it into `process.env` and `buildChildEnv()` still passes it to **every** agent child until the name is vault-managed.

Per-agent vault entries (`env.<agentType>.<NAME>` under `tierwyn:agents`, Settings → Agents → **Encrypted environment (vault)**) change env behaviour: every vault-managed name is deleted from **all** spawns (agents, MCP stdio, shell), then only the matching agent type gets its own values back. That fixes cross-agent **env leakage** even when keys remain in `prod.env`; deleting them from `prod.env` and restarting prod clears them from the hub process too.

Full column definitions and the operator comparison table (no sandbox / sandbox + prod.env / sandbox + vault) are in [SECURITY.md § Per-agent env vault](../../SECURITY.md#per-agent-env-vault). Summary:

| Setup | Env file on disk | Database / vault | Other agents’ processes | Other agents’ keys in its own environment |
|---|---|---|---|---|
| No sandbox, keys in `prod.env` | exposed | exposed | exposed | exposed |
| Sandbox on, keys in `prod.env` | hidden | hidden | hidden | exposed |
| Sandbox on + per-agent vault | hidden | hidden | hidden | hidden |

Enable sandbox for agents that hold vault secrets so the CLI cannot read `prod.env` or decrypt the database. On remote hosts the vault injection reaches the node only behind the per-host **Allow agent env secrets** toggle (node memory, see [remote-hosts.md § Agent env secrets](remote-hosts.md#agent-env-secrets)). A sandboxed agent there (`--unshare-pid`) cannot inspect the node process's memory and receives only its own agent type's values, with every vault-managed name scrubbed from the rest; the sandbox boundary still applies. What sandbox does **not** contain on the node is the node's own user and unsandboxed agents: they can read the node's memory, and the node decides which agent types it claims, so keep the toggle off on hosts you do not fully trust.

## Spawn inheritance: the monotonic pin

Spawned subagents (and scheduled-job children) get their sandbox from the **server**, not from the requesting agent:

1. **The spawn protocol is sandbox-agnostic.** `POST /spawn` carries role, profile, prompt, workdir, timing; there is **no sandbox field**. An agent cannot request, veto, or observe-and-adjust the sandbox state of anything it spawns.
2. **The server decides at spawn time** from database state. It resolves the *parent's* effective sandbox (conversation → project → defaults → global) and writes the result onto the child conversation row:
   - Parent effective **on** → child row written **`'on'`** (its own explicit conversation-level pin).
   - Parent effective **off** or unset → child row written **`NULL`**: *not* `'off'`. The child then inherits through its own chain, with its own agent type and host, on every turn.
3. **This is a one-time snapshot.** The parent's setting is read exactly once, at the child's creation. Nothing the parent does afterwards; flipping its own pill, messaging or steering the child, spawning siblings, switching the child's profile; re-reads it or changes the child's row.

Consequences:

- **A sandboxed agent can never mint an unsandboxed Tierwyn descendant.** ON propagates down the spawn tree and sticks; that pin only comes off if the operator edits that child's own row.
- **OFF does not propagate.** An unsandboxed parent produces an *unpinned* (`NULL`) child that follows the operator's project/default/global tiers, including future changes to them.
- **Siblings can differ.** Each child snapshots the parent's state at its own spawn moment. Spawn one child while the parent is on, flip the parent off, spawn another: the first is pinned sandboxed permanently, the second follows the defaults.
- **A pinned child ignores later tier changes**; an unpinned child re-resolves on **every new turn**, so flipping a project/global setting moves it on its next turn.
- **Grandchildren follow their own parent**: a pinned `'on'` child pins its own children `'on'`; an unpinned child's children resolve from its chain.
- **Messaging an existing child never changes its sandbox.** Steer into a live turn: the running process keeps the state it started with. Start a new turn: the child's *own* row is resolved; a pinned child comes back sandboxed, an unpinned child re-resolves its tiers. The parent's current state is irrelevant either way.

The only way any conversation's sandbox changes after creation is an **operator edit of that conversation's own row** (or a tier beneath an unpinned conversation). Parents, agents and schedules have no path to it.

## Timing summary

| Action | Existing conversations | Future spawns from that conversation |
|---|---|---|
| Flip a conversation's pill | Next session start of *that* conversation | Immediately; spawn-time resolution reads the row fresh |
| Flip a project / global / default tier | Next session start of every **unpinned** (`NULL`) conversation in scope; pinned `'on'`/`'off'` conversations are immune | Immediately |
| Operator edits a child's row directly | That child's next session start | That child's future children, from then on |

Note the one asymmetry this permits: a parent whose *running process* is still unsandboxed (its pill was flipped mid-turn; the process re-sandboxes on its next session) can spawn a child that is immediately pinned `'on'`. The dangerous direction; sandboxed parent producing an unsandboxed child; is the one the monotonic pin makes impossible.

## Remote hosts

Projects bound to a `tierwyn node` resolve the same chain, with capability from the node's hello (`sandbox.available`, policy, features). Node policy `require` forces on; a wanted-but-incapable combination behaves as above (soft off with notice when inherited, fail-closed when explicit). Custom paths reaching a node are gated by the node's policy and roots; see [`remote-hosts.md`](remote-hosts.md).

## Quick reference

| Question | Answer |
|---|---|
| Can an agent turn its own sandbox off? | No; every tier is cookie-only, operator-writable. |
| Can an agent choose the sandbox state of a child? | No; the spawn protocol has no sandbox field; the server decides. |
| Child of a sandboxed parent? | Pinned `'on'` at spawn, permanently. |
| Child of an unsandboxed parent? | `NULL`; follows project/defaults/global, per turn. |
| Parent flips its sandbox after spawning? | Existing children unaffected, forever. |
| When does a setting change take effect? | Next session start (running processes never hot-swap); spawn-time pins read the DB fresh. |
