# Dedicated hub user vs this checkout

Two ways to run a Tierwyn **hub**. Pick one **per Unix user**. They differ in who may edit the Tierwyn tree.

This is not **`tierwyn node`** (a remote-host daemon). Node install and lifecycle are unchanged; see [remote-hosts.md](../architecture/remote-hosts.md).

## Which one am I?

| | Dev checkout (`prod` mode) | Dedicated hub (`hub` mode) |
|---|---|---|
| Who | Your login, e.g. `~/Projects/Tierwyn` | A Unix user that **only** runs Tierwyn (e.g. `tierhost`), clone at `~/tierwyn` |
| Agents may edit the checkout | **Yes**: that is the job | **No** |
| Units | `tierwyn-prod`, `tierwyn-prod-web` | `tierwyn-hub`, `tierwyn-hub-web` |
| Env file | `~/.config/tierwyn/prod.env` or `/etc/tierwyn/prod.env`, or the clone `.env` | `~/.config/tierwyn/hub.env` with `TIERWYN_DEDICATED_HUB=1` |
| Database | `./data/prod.db` (typical) | `$ROOT/data/hub.db` |
| Sandbox default | off | **on** until you save Settings → Sandbox |
| Project at/above the checkout | allowed | refused (`POST` / `PATCH /projects`, move) |
| Restart | `tierwyn restart` / `npm run deploy:prod:full` | `tierwyn hub restart` (plain `tierwyn restart` also works on a hub-only user) |

`tierwyn restart|start|stop|logs` with **no target** acts on the installed API+web pair: **`tierwyn-prod*` if those units exist, otherwise `tierwyn-hub*`**. An existing prod box never flips to hub names.

The workstation that develops this repo is a **dev checkout**. Do not run `tierwyn setup` → Dedicated hub as that same user.

## What protects a dedicated hub

Gated on **`TIERWYN_DEDICATED_HUB=1`**, written only by `tierwyn setup` → Configure → **Dedicated hub** into `hub.env`. Nothing is inferred from hostname, git, or username.

With sandbox on ([sandbox.md](../architecture/sandbox.md)):

- Hub checkout, `~/.npm-global`, `~/.local/bin` and other toolchains are **read-only**.
- `~/.config/tierwyn`, `/etc/tierwyn`, the data dir, and repo `.env*` are **hidden**.
- Agent profile dirs (`~/.claude`, `~/.codex`, …) and the **project cwd** stay writable.

Because cwd is writable even inside bwrap, the hub **refuses** a project rooted at, inside, or above its own checkout (including `$HOME`). Create projects in a folder that is not the install tree.

Operator actions run **outside** bwrap and can still install CLIs:

- Settings → Agents: Install, Install & update all, Log in, pull models
- `tierwyn agents`
- Remote Hosts → install on a node (`agents.install`)

`npm i -g` against a root-owned prefix (`/usr`) is pointed at `~/.npm-global` for that run only (environment, npmrc is never changed). Hub and node already search `~/.npm-global/bin` (`ensureAgentPath`).

If `bwrap` or unprivileged user namespaces are missing, the sandbox default resolves to **off**. `tierwyn setup` → hub mode warns. On Ubuntu, AppArmor's `kernel.apparmor_restrict_unprivileged_userns` can block this.

## Install a dedicated hub

On a **fresh machine or VM**, as root create the user, then set up **as that user** (a real login session so `systemctl --user` works):

```bash
sudo useradd -m -s /bin/bash tierhost
sudo loginctl enable-linger tierhost
sudo -iu tierhost          # or: sudo machinectl shell tierhost@
curl -fsSL https://raw.githubusercontent.com/tierwyn/tierwyn/main/scripts/install.sh | bash
# Step 3 · Configure → "Dedicated hub"
tierwyn hub restart        # also: start | stop | logs | status
```

Clone lands in `~/tierwyn` (`TIERWYN_DIR` override). Units are rendered from the existing `tierwyn-prod*` templates with names, description, and env file rewritten; there is no second template set.

Non-interactive (`--yes`) still needs an operator password for hub/prod. Provide it in the environment for that process only (not written to `hub.env`):

```bash
MODE=hub TIERWYN_OPERATOR_PASSWORD='…≥12 chars…' TIERWYN_COOKIE_SECURE=false \
  curl -fsSL https://raw.githubusercontent.com/tierwyn/tierwyn/main/scripts/install.sh | bash -s -- --yes setup
```

`TIERWYN_COOKIE_SECURE=false` is for direct HTTP (`:4173`). Behind TLS, omit it (default secure cookies).

Then:

```bash
tierwyn doctor
tierwyn hub restart
# UI: http://<host>:4173/  API: 127.0.0.1:8788  (put a TLS proxy in front for phones)
```

Do **not** create a project whose folder is `~/tierwyn` (or `$HOME`). Install agent CLIs from Settings → Agents; Log in is the same control as on Remote Hosts for Codex, Claude Code, Copilot, Grok Build, and Cursor.

## Commands

| Command | Effect |
|---|---|
| `tierwyn hub restart` | Restart `tierwyn-hub` + `tierwyn-hub-web` |
| `tierwyn hub start\|stop\|logs\|status` | Same pair |
| `tierwyn restart` | Installed API+web pair (prod units win if present) |
| `tierwyn update` | Channel update (`stable` = newest release tag, `edge` = `main`; see `tierwyn channel`) + rebuild + restart that pair (git checkouts only) |
| `tierwyn agents` | Discover / install CLIs (writable npm prefix, no npmrc mutation) |
| `tierwyn node restart` | Remote-host daemon only; not the hub |

On a **dev checkout** (this repo, `tierwyn-prod*`): keep `npm run deploy:prod:full` / `tierwyn restart`. Do not enable `TIERWYN_DEDICATED_HUB` there.

## Related

- [Production deployment (LAN + TLS)](deployment.md)
- [Agent sandbox](../architecture/sandbox.md)
- [Remote Hosts (`tierwyn node`)](../architecture/remote-hosts.md)
- [Troubleshooting](../troubleshooting.md)
