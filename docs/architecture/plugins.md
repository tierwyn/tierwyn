# Plugin System (phase 2)

Per-instance, server-side plugins that let Tierwyn grow new capabilities
without forking the core. Plugins are operator-installed ESM in a gitignored
`plugins/` directory; they code against a typed `PluginContext` facade, not
server internals.

Writing a plugin? See [plugin-authoring.md](plugin-authoring.md).

**Security property (honest):** plugin-declared secrets never transit an
agent-visible *API* channel (REST, WS, preamble, transcripts) and are not
handed to children via inherited env. This is **not** protection against
arbitrary code execution under the server's UID; see Residual risk below.

Phase 2 adds an encrypted credential vault, operator
set/clear routes, an invocations table (500 rows per plugin), and a
Settings → Plugins panel. Env-captured keys remain the fallback.

**Code:**

| Piece | Path |
|---|---|
| Shared types | `packages/shared/src/plugins.ts` |
| Child-env scrub | `apps/server/src/childEnv.ts`: `buildChildEnv()` |
| Vault | `apps/server/src/plugins/vault.ts`: AES-256-GCM, HKDF-SHA256 |
| Invocations | `apps/server/src/plugins/invocations.ts`: 500-row-per-plugin trim |
| Loader | `apps/server/src/plugins/loader.ts` |
| Host | `apps/server/src/plugins/host.ts` |
| REST | `apps/server/src/routes/plugins.ts` |
| First plugins | `plugin-src/<id>/` (source; not loaded until imported) |

## Manifest

Each plugin is a directory with `plugin.json` + `index.js` (ESM default export
`{ activate(ctx) }`).

- `id` matches `^[a-z][a-z0-9-]{1,48}$`
- `apiVersion` must be `1` (else skipped with a boot log line)
- capability names `^[a-z][a-z0-9.]*$`
- capability `timeoutMs` (optional, integer 1–300000) overrides the 15 s handler timeout for that capability
- credential keys `^[A-Z][A-Z0-9_]+$` and **not** on the blocklist:
  exact `PATH HOME USER SHELL LANG TMPDIR OPENAI_API_KEY OPENAI_BASE_URL`,
  prefixes `LC_ XDG_ TIERWYN_`. A rejected key fails the whole manifest.

`TIERWYN_PLUGINS_DIR` overrides the scan root (default `./plugins`).
`TIERWYN_PLUGINS=off` disables loading entirely.

Enabled/disabled is a settings blob `plugins: { disabled: string[] }`,
toggled with `PATCH /plugins/:id { enabled }`. Files stay on disk.

### Agent help

A plugin may ship agent-facing markdown as a fixed `plugins/<id>/HELP.md` next to its
code (`README.md` stays operator-facing). There is no manifest field: the loader
(`readHelp` in `loader.ts`) reads the file once, synchronously at boot: `lstat`
rejects symlinks and non-regular files, and anything over **64 KiB**
(`MAX_HELP_BYTES`) is warned about and treated as absent. The text lives in memory
on the plugin record; nothing touches the filesystem at request time, so picking up
an edited HELP.md takes a restart, like every other plugin change. Agents fetch it
via `GET /agent/plugins/:id/help` (same auth as `GET /agent/plugins`), and the
plugin's entry in `GET /agent/plugins` carries `help: "/agent/plugins/<id>/help"`
when present. Visibility matches the listing exactly (enabled + ≥1 agent-callable
capability); a disabled plugin's help 404s like the plugin itself. HELP.md is
author-written static text: it must never contain credential values or
instance-specific ports/paths (use `$TIERWYN_LISTEN_PORT`), and it never runs
through the plugin's `ctx`.

## Lifecycle

1. **Sync** `scanManifests()` right after `loadAuthConfig()`; the scrub list
   exists before anything can spawn.
2. `setPluginScrubKeys(keys)` then `pluginHost.captureCredentials(keys)` then
   `delete process.env.SESSION_SECRET` / `OPERATOR_PASSWORD_HASH`. Then
   `initVaultKey({ envKey: TIERWYN_PLUGIN_VAULT_KEY, sessionSecret })` and
   `delete process.env.TIERWYN_PLUGIN_VAULT_KEY`. Auth config already holds
   the login secret; vault key material is derived and held in the vault
   module. A short/missing secret logs
   `[plugins] vault unavailable: …` (fail-closed, no weak derived key).
3. After `setDb`, `activatePlugins(...)` dynamic-imports `index.js` and calls
   `activate(ctx)` in try/catch. A throw disables that plugin for the boot;
   the process never crashes.
4. Shutdown calls `pluginHost.deactivateAll()`.
5. **Runtime import/delete (operator)**: see [plugin-authoring.md](plugin-authoring.md) § Packaging, import, delete.
   `POST /plugins` extracts tar.gz, checks safety/traversal, and immediately activates. `DELETE /plugins/:id`
   unloads, runs `deactivate()`, unlinks files, and purges vault secrets, settings, and invocations.

Credential keys are collected from **every scanned manifest**, including
disabled / failed-to-activate plugins, so turning a plugin off cannot
un-scrub its key.

## Credentials (vault-first, env fallback)

Resolution order per declared key:

1. `plugin_secrets` row (vault); settable from Settings → Plugins, no restart.
   `GET /plugins` reports `source: 'vault'` and a real `updatedAt`.
2. Boot-captured env value; read-only, `source: 'env'`, `updatedAt: null`.
   Editing env still requires a restart.

`credentials.get()` returns the resolved value **into plugin scope only**.
No REST/WS/context method returns a credential value to a caller. Values
never appear in response bodies, logs, audit rows, or error strings.

### Vault crypto

- AES-256-GCM. Master key = HKDF-SHA256 over `TIERWYN_PLUGIN_VAULT_KEY` if
  set (`key_id='env:v1'`), else `SESSION_SECRET` (`key_id='sess:v1'`),
  info=`tierwyn:plugin-vault:v1`, 32 bytes.
- **Fail closed:** reads AND writes refuse unless the chosen IKM is ≥32
  bytes. Empty `SESSION_SECRET` under `AUTH_DISABLED=true` is a loud
  operator error (`[plugins] vault unavailable: no derivation secret ≥32
  bytes …`), never a silent weak key. Agents keep working via env fallback;
  `GET /plugins` surfaces `vault: { available: false, reason }` and every
  write route returns 503 with that reason.
- **Key identity:** a stored `key_id` that does not match the current
  derivation reports exactly `encrypted with a different key; re-enter`
  (no GCM-open attempt). Tampered ciphertext reports
  `stored credential could not be decrypted; re-enter`.
- **Rotation blast radius:** rotating `SESSION_SECRET` invalidates operator
  cookies **and** every `sess:v1` vault row together; a joint operation.
  Set `TIERWYN_PLUGIN_VAULT_KEY` (≥32 bytes) to decouple login-secret
  rotation from plugin credentials. Changing or removing that env key
  makes existing `env:v1` rows report "encrypted with a different key:
  re-enter".
- The DB has never held `OPERATOR_PASSWORD_HASH` (env-only).

### Set / clear

- `PUT /plugins/:id/credentials/:key` `{ value }`; cookie only. 404
  unknown plugin; 400 undeclared or blocklisted key; 400 empty value;
  503 when the vault is unavailable. Success returns the same status-only
  payload as `GET /plugins`. The value is never echoed.
- `DELETE /plugins/:id/credentials/:key` removes the vault row. An env
  fallback, if any, becomes visible again (`source: 'env'`). 404 when no
  row existed.

The flagship `zai-usage` plugin **requires a dedicated `ZAI_API_KEY`**. It
never falls back to `OPENAI_API_KEY` (that key is already agent-visible).
If only `OPENAI_API_KEY` is set,
`usage.get` returns `credential_missing`. A UI-set vault value is picked up
with **no restart** (the F14 probe reads `getCredential`, which is vault-first).

## Usage-provider contract

A capability may declare optional `usageProvider: { label, section? }`
(`section` defaults to `'providers'`). An **enabled + activated** plugin
with that declaration contributes a Settings → Agent Usage **Providers**
entry via `PluginHost.listUsageProviders()`:

```
{ id, kind:'provider', label, source:'plugin', configured, capability, section }
```

`configured` is true when every `required` credential key has a vault row
**or** was boot-captured; never secret values. Disabled or failed-to-activate
plugins contribute nothing (no muted stub).

The Agent Usage panel prefers plugin data for a matching provider card
(`POST /agent/plugins/:id/capabilities/:name` with the operator cookie).
If the plugin returns `credential_missing` / errors, the card **falls back**
to the built-in probe payload already included in
`GET /settings/agent-usage` (kept registered for Z.AI), and the source badge
reflects which source actually served (`plugin` vs `built-in`). See
[`agent-usage.md`](./agent-usage.md).

## Child-env scrub

`buildChildEnv(extra?)` copies `process.env` then deletes:

1. `PORT`, `HOST` (listen-port theft)
2. `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, `TIERWYN_PLUGIN_VAULT_KEY`
3. every plugin-declared credential key
4. each comma-token of `TIERWYN_CHILD_ENV_DENY`

then applies `extra`. `TIERWYN_LISTEN_PORT`, `PATH`, `HOME`, `OPENAI_API_KEY`,
and `OPENAI_BASE_URL` survive; agent CLIs and preamble curls need them.

Adopted at **every** adapter spawn site, including the Claude Code SDK
`query({ options: { env: buildChildEnv() } })` path and previously env-less
spawns. Adding `env` to those env-less sites **newly strips PORT/HOST** from
their children (intended). A source-grep guard in `childEnv.test.ts` keeps
the next adapter from reintroducing a raw `process.env` clone.

Boot-time `delete process.env.X` is belt-and-braces: even a forgotten spawn
site cannot inherit secrets that are no longer on `process.env`.
Note on runtime import: importing a plugin adds its credential keys to the child-env scrub set for all subsequent spawns; existing long-running child processes spawned prior to import do not retroactively lose environment variables.

## Agent REST (dual-auth, before `requireAuth`)

| Method | Path | Notes |
|---|---|---|
| GET | `/agent/plugins` | agent-callable caps only |
| GET | `/agent/plugins/help` | loopback-only markdown; retryability per code |
| GET | `/agent/plugins/:id/help` | loopback + (plugin bearer \| cookie); serves `plugins/<id>/HELP.md` (≤64 KiB, read at boot) |
| GET | `/agent/usage` | built-in agent quotas (no providers, no insights) |
| POST | `/agent/plugins/:id/capabilities/:name` | JSON body, 256 kb cap on this router |

Authorisation: any Tierwyn session Bearer whose capability set includes `plugin`, else operator cookie.
A valid plugin-scoped bearer **wins over a cookie** (`kind: 'agent'`). Every token-carrying
conversation mints `plugin`; spawn-capable conversations via the spawn set, all others via
`CONVERSATION_CAPABILITIES` (`{schedule, plugin}`); only bare-prompt adapters mint no token and are
rejected for agents. Conversation/session ids come from the token
entry, never the body. `agentCallable: false` is enforced inside `host.invoke()`,
not by route shape. Usage plugins keep `usage.get` agent-callable (quota
windows / remaining credits). Account identity and dashboard insights
(`cursor-usage` `insights.get`, Kilo profile name/email) stay on the
operator cookie path and the Settings → Agent Usage UI.

## Operator REST (cookie, after `requireAuth`)

| Method | Path | Notes |
|---|---|---|
| GET | `/plugins` | `{ plugins, vault }`; status, **never values**; `vault.available` / `reason` |
| POST | `/plugins` | multipart upload `archive` (`.tar.gz`), unpacks, validates, activates; 400/403/409/413/422 |
| DELETE | `/plugins/:id` | unload + rm + purge vault, invocations, and settings; 403/404/409/500 |
| PATCH | `/plugins/:id` | `{ enabled }` blob toggle |
| PUT | `/plugins/:id/credentials/:key` | `{ value }`; vault write; 503 if vault unavailable |
| DELETE | `/plugins/:id/credentials/:key` | clear vault row; env fallback (if any) remains |
| GET | `/plugins/:id/invocations?limit=` | newest-first, limit clamp 1..200; `error` is already-safe text |
| GET/POST | `/plugins/:id/…` | plugin `ctx.operatorRoute()` handlers; resolved at **request time** so routes registered during async `activate()` are reachable |

Nothing is auto-installed: a fresh clone has an empty runtime `plugins/` (gitignored) and `GET /plugins` is `[]` until the operator imports a `.tar.gz`. First-party source lives in `plugin-src/<id>/`. Tracked archives in `plugin-archives/` (`cursor-usage.tar.gz`, `firecrawl.tar.gz`, `gemini-image.tar.gz`, `kilo-usage.tar.gz`, `openrouter-usage.tar.gz`, `zai-usage.tar.gz`) are for import via Settings → Plugins (or `POST /plugins`); they are **not** extracted into the scan dir at boot. Rebuild them with `npm run package:plugins`.

Upgrading an existing checkout that previously had tracked source in `plugins/`: restore instance files **before** the next API restart (keeps existing `plugin.json`):

```bash
npm run package:plugins -- --out /tmp/tierwyn-plugin-archives \
  && for a in /tmp/tierwyn-plugin-archives/*.tar.gz; do tar -xzf "$a" -C plugins --skip-old-files; done \
  && ls plugins/*/index.js plugins/*/plugin.json
```

(Expect 5 `index.js` + 5 `plugin.json`. `plugin-archives/*.tar.gz` in the repo can be used the same way if they are already current.)

`AUTH_DISABLED=true` collapses operator auth on these routes exactly as it
does on `/spawn`; documented, not fixed (F13).

## Invocations

Every `host.invoke()` writes one stdout `[plugins]` line (journald via the
user systemd units; survives DB loss) **and** one `plugin_invocations` row.
The table is trimmed to **500 rows per plugin id** on every write. A DB
error logs `[plugins] audit write failed: …` and is swallowed; audit must
never break or delay `invoke()`. `GET /plugins/:id/invocations` re-runs
`redactSecrets` on `error` as belt-and-braces.

## Error contract

`{ ok: false, error, code, retryable, retryAfter? }`

| code | HTTP | retryable |
|---|---|---|
| `unknown_plugin` | 404 | no |
| `unknown_capability` | 404 | no |
| `not_agent_callable` | 403 | no |
| `rate_limited` | 429 | yes (`retryAfter`) |
| `credential_missing` | 503 | **no** |
| `upstream_error` | 502 | yes |
| `timeout` | 504 | yes |
| `bad_input` | 400 | no |

`invoke()` is the single enforcement point: unknown/disabled plugin, unknown
capability, `agentCallable`, three token buckets (per-caller at
`rateLimitPerMin ?? 30`/min, global per-plugin 120/min, global outbound-fetch
60/min), timeout race (15 s default, per-capability `timeoutMs`), redaction over results **and** error strings
(secrets shorter than 8 chars are skipped; vault values join that
iteration). Every path, including timeout, writes one `[plugins]` line to
stdout **and** a `plugin_invocations` row (journald remains the durable
trail if the DB is lost).

`ctx.http.fetch` compares `new URL(u).origin` **exactly** against each
`permissions` origin (never `startsWith`), uses `redirect: 'manual'`, and
re-validates `Location` before one follow.

## Preamble

Every token-carrying conversation gets a **capability routing roster** in its
preamble (`spawn/preamble.ts → pluginRosterLines()`), rendered by all four
builders (delegation full/stub and schedule-only full/stub):

- **Full** (first prompt / plugin-set change): heading
  `Tierwyn server capabilities (enabled here, not your harness's plugins or skills)`,
  a prefer-over-local-skills line, then one line per capability:
  `- id · name; summary`; plus its `GET /agent/plugins/:id/help` pointer.
- **Stub** (token-only resume): one line naming `id·name` pairs with the
  call shape and help pointer.

A zero-capability server renders nothing. The roster is driven by
`PluginHost.listForAgent()` and folded into `pluginSetHash()` (over
`id:name:summary`), which feeds `spawnFpPayload` field `p`; enabling,
disabling, or rewording a capability forces a full re-inject.

## Capability profiles

Each conversation carries an optional `capability_profile` (null = `all`)
that scopes what its **agent-side Bearer** may reach. A profile
is `{ id, label, plugins: '*' | plugin-id[], usage: boolean, memory?: boolean }` (`@tierwyn/shared`
→ `capabilityProfiles.ts`). Grant rule, evaluated per request in
`routes/plugins.ts → resolvePluginAuth`:

```
p.plugins === '*' || p.plugins.includes(pluginId) || (p.usage && capability.usageProvider)
```

And for memory: `p.memory !== false` authorizes `/agent/memory*` routes.

Out of scope → **403** `not_in_profile` (checked before the rate limiter, so
probes never consume quota; unknown plugin ids under a narrow profile 403
rather than 404; no existence oracle). `GET /agent/plugins` filters instead
of 403-ing and **keeps** usageProvider capabilities the grant allows.
`GET /agent/usage[/:target]` uses the same rule (`usage` **or** `plugins: '*'`).
Operator-cookie callers are never restricted.

Built-in: `all` (initial default). Plugins are not bundled, so custom profiles
are created by the operator as needed; missing or unknown profiles fail closed
to `minimal` (empty grant). Custom profiles are operator CRUD at
`/settings/capability-profiles` (built-in ids reserved, 409; in-use profiles
cannot be deleted; a grant-set edit revokes live tokens of conversations
using that id). The resolved profile is snapshotted onto the spawn token
at mint; conversations inherit the parent's profile on spawn and carry it
through fork/duplicate. `PATCH /conversations/:id { capabilityProfile }`
writes the id onto the conversation and its descendants, reaps parked
sessions, revokes tokens, and re-issues only when a session is live.
`filterAgentPlugins()` is the listing filter; `scopeAgentPlugins()` additionally
strips usageProvider lines from the preamble roster. Profiles are folded into
the preamble fingerprint (schedule fp bumps to `v:3`), so a profile change
re-injects the roster. Agent-created schedule jobs stamp the creator's profile
onto `schedule_jobs.capability_profile` so run conversations
cannot widen to `all`.

## Remote callers (remote hosts)

Plugins always execute on the hub; a node's agent reaches them through the
tunnel with its conversation-scoped token, exactly like a local agent. The
difference is file plumbing: for remote conversations `invokeForRemote` pulls
node-shard input paths to the hub (≤ 8 files, sha256-verified 4 MiB chunks),
runs the plugin against hub copies, pushes outputs back to the node shard and
rewrites every returned path to its node location. A failed push leaves the
file on the hub and returns a retryable hint to call
`POST /agent/artifacts/deliver`. The vault, plugin archives and credential
CRUD stay hub-only; the node never sees the **plugin** vault's keys (per-agent
env is the one exception, gated by the per-host **Allow agent env secrets**
toggle, see [remote-hosts.md § Agent env secrets](remote-hosts.md#agent-env-secrets)),
and the only node-disk
write is the chunked `artifact.write` into the conversation's shard.

## Residual risk (F1)

Agent children run under the **same UID** as the server. A code-executing
agent can still read `/proc/<server-pid>/environ` (the kernel exposes the
exec-time block: `delete process.env.X` does not alter it) and the
world-readable `data/*.db`. The only structural fix is a separate UID for
agent children (systemd `User=` + sandbox), which is out of scope for v1.
Phase 2's honest claim is the same: *server-held keys are not inherited by
agent children and never transit an agent-visible API*; not *agents cannot
obtain them*. The vault's real win is over DB backup/exfiltration, not the
same-UID `/proc` read (F1 residual risk is unchanged).

`AUTH_DISABLED=true` collapses agent/operator across the plugin surface
(same as `/spawn`). A leaked live session token authorises capability calls
attributed to its own conversation until session end (idle TTL slides on activity).
