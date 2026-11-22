# Troubleshooting

Symptom → cause → fix for Tierwyn's verified failure modes. Every entry traces to a real error
string, HTTP response, or log line in the code (cited as `path:line` from the repository root).
No speculative entries: if an error is not in this list, it is not a known failure mode.

Related pages: [Configuration & Environment](reference/configuration.md) for every environment
variable cited below, and [Configure TTS Sidecars](guides/configure-tts-sidecars.md) for the
Piper/Kokoro services.

## Authentication & connectivity

### Login returns 503: "Authentication is not configured. Set OPERATOR_PASSWORD_HASH and SESSION_SECRET in .env, then restart the server."

- **Cause:** the server boots fail-closed when either secret is missing: `configured` is only
  true when both `SESSION_SECRET` and `OPERATOR_PASSWORD_HASH` are non-empty
  (`apps/server/src/auth/config.ts`). The login route refuses with this 503 body
  (`apps/server/src/auth/routes.ts`); protected routes answer 401 and the WebSocket upgrade
  is rejected, so no login can succeed until the secrets exist.
- **Fix:** set both variables in the server's `.env` (see `.env.example`, referenced by the error
  itself) and restart. `AUTH_DISABLED=true` bypasses auth entirely but is for local development
  only; never in production.

### Login returns 200, but every API call still answers 401 `{"error":"unauthorized"}`

- **Cause:** the session cookie is issued with the `Secure` attribute by default
  (`COOKIE_SECURE` defaults to true, `apps/server/src/auth/config.ts`; the flag is applied at
  `apps/server/src/auth/cookie.ts`). Browsers drop `Secure` cookies on plain `http://`, so the
  login succeeds but the cookie never comes back.
- **Fix:** access the UI over HTTPS, or set `COOKIE_SECURE=false` when testing over direct HTTP.

### The WebSocket cannot connect: the upgrade is answered with a bare `HTTP/1.1 401 Unauthorized`

- **Cause:** the WS upgrade is authenticated during the HTTP handshake; unauthenticated sockets
  are rejected and destroyed before any WebSocket is created
  (`apps/server/src/auth/wsGuard.ts`, wired at `apps/server/src/index.ts`).
- **Fix:** log in over HTTP first (same origin), and check `COOKIE_SECURE` as above; a cookie
  the browser never stored also fails the upgrade.

### Login returns 429 `{"error":"too many attempts"}`

- **Cause:** the login rate limiter tripped for the client IP (`apps/server/src/auth/routes.ts`).
- **Fix:** wait for the window indicated by the `Retry-After` response header. Repeated failures
  reset only after a successful login.

### GitHub Copilot exits with code 1: "Run 'gh auth status' to check your current authentication status" or "Personal Access Tokens are not supported for this endpoint"

- **Cause:** GitHub Copilot CLI is running on a headless host or sandboxed environment without desktop keyring access, and either:
  1. No token was configured in the vault (`COPILOT_GITHUB_TOKEN`), or **Allow agent env secrets** is disabled on the remote host.
  2. A fine-grained or classic GitHub Personal Access Token (`github_pat_...` or `ghp_...`) was used. GitHub Copilot's model endpoints (`api.individual.githubcopilot.com`) reject Personal Access Tokens and require an OAuth token.
- **Fix:** Obtain a GitHub OAuth token by running `gh auth token` on a machine authenticated via GitHub CLI (`gh auth login`). Store that token (`gho_...`) in Tierwyn under **Settings → Agents → Copilot → Encrypted environment (vault)** as `COPILOT_GITHUB_TOKEN`. For remote hosts, ensure **Allow agent env secrets** is enabled for the host.

## Agent profiles & registry

### Sending a prompt or a schedule tick fails with `Unknown or disabled profile: <id>`

- **Cause:** the profile id is absent from the catalogue, disabled, or its `agentType` does not
  match the requested agent (`apps/server/src/sessionManager.ts`). Common trigger: a
  schedule or saved client state referencing a profile that was since removed or disabled.
- **Fix:** re-enable or restore the profile in `apps/server/agent-profiles.json` (read from
  `apps/server/src/profiles.ts`), or repoint the schedule to a live profile.

### The server exits at boot with `agent-profiles.json: missing or non-array "profiles" field` (or a JSON parse error)

- **Cause:** `readProfiles()` throws on a missing file, invalid JSON, or a non-array `profiles`
  field rather than fall through to a prune that would wipe the catalogue
  (`apps/server/src/profiles.ts`). It runs at boot via `seedCatalogue`
  (`apps/server/src/index.ts`).
- **Fix:** repair `apps/server/agent-profiles.json` (valid JSON, object with a `profiles` array)
  and restart. Note the seeder also refuses to prune on an empty-but-valid array for the same
  reason (`apps/server/src/db/seed.ts`).

### Boot fails with `Profile "<id>" references unregistered agentType "<type>"

- **Cause:** catalogue validation rejects any profile whose `agentType` has no registered adapter
  (`apps/server/src/catalogue.ts`). The underlying factory error is
  `No adapter registered for agentType: <type>` (`apps/server/src/registry.ts`).
- **Fix:** correct the `agentType` in `apps/server/agent-profiles.json` to one of the registered
  adapters, or register an adapter for it.

### `Database not initialised: call setDb() at boot`

- **Cause:** a module called `getDb()` before the boot sequence opened the database: `openDb`
  runs at `apps/server/src/index.ts` and `setDb` at `apps/server/src/index.ts`; the guard
  itself is `apps/server/src/db/index.ts`.
- **Fix:** this is a boot-order bug in code, not an environment problem; check that nothing
  imports a DB-touching module before `index.ts` initialises the database.

## Dictation (whisper.cpp)

### Dictation is unavailable; `GET /transcribe/config` shows `binaryFound: false`, or `POST /transcribe` returns 500 `whisper-cli binary not available`

- **Cause:** no whisper.cpp binary found. The `detail` field carries the resolver's message,
  `whisper-cli not found. Set WHISPER_BIN_PATH or install whisper.cpp to <path> or on $PATH.`
  (`apps/server/src/routes/transcribe.ts`, `apps/server/src/adapters/whisper.ts`).
  Resolution order: `WHISPER_BIN_PATH` env override → bundled
  `~/.local/share/mewisper/bin/whisper-cli` → `$PATH` scan for `whisper-cli` / `whisper-cpp`
  (`apps/server/src/adapters/whisper.ts`).
- **Fix:** install whisper.cpp to one of those locations or point `WHISPER_BIN_PATH` at the
  binary.

### `WHISPER_BIN_PATH '<path>' does not exist`

- **Cause:** the env override is set but stale; the path fails the file check
  (`apps/server/src/adapters/whisper.ts`).
- **Fix:** update or unset `WHISPER_BIN_PATH` so resolution falls through to the bundled path or
  `$PATH`.

### `unknown model '<model>'` or `model download failed: HTTP <status>`

- **Cause:** only `base`, `small`, `medium` are valid model ids
  (`apps/server/src/adapters/whisper.ts`); downloads stream from
  `huggingface.co/ggerganov/whisper.cpp` and a non-2xx fails with the HTTP status
  (`apps/server/src/adapters/whisper.ts`). A failed download restarts from
  zero; there is no resume.
- **Fix:** pick a valid model id; for download failures check network reachability to
  huggingface.co and retry.

### Raw dictation works but the context-enhance step fails with `cleanup timed out after <N>s (endpoint slow or unreachable: check <provider> baseUrl/model)`

- **Cause:** the transcript-cleanup LLM endpoint did not answer within its timeout
  (`apps/server/src/adapters/whisper.ts`).
- **Fix:** check the provider's `baseUrl`/`model` in the Voice settings (the error names the
  configured provider), or raise `timeoutSecs`.

## Installer & hub units

### `tierwyn restart` prints `no matching units installed`

- **Cause:** `do_lifecycle` only restarts units that exist
  (`scripts/install.sh` `do_lifecycle`; warn `no matching units installed`). A dedicated hub
  install uses `tierwyn-hub` / `tierwyn-hub-web`. A hand-copied box that renamed units to
  `tierwyn-hub*` while the script only knew `tierwyn-prod*` hit this. The script now prefers
  installed prod units, else hub units (`pair()`).
- **Fix:** on a dedicated hub, `tierwyn hub restart` (or `tierwyn restart` with no target).
  On this checkout, keep `tierwyn restart` / `npm run deploy:prod:full` against `tierwyn-prod*`.
  See [Dedicated hub user](deploy/hub-user.md).

### Settings → Agents Install fails with npm `EACCES` against `/usr`

- **Cause:** `npm i -g` uses the default global prefix (`npm prefix -g`), often `/usr`, which
  the hub user cannot write. Catalogue `defaultRunner` and node `runInstall` wrap those
  commands with `withWritableNpmPrefix()` (`apps/server/src/node/install.ts`); `tierwyn agents`
  uses `npm_writable_prefix` in `scripts/install.sh`.
- **Fix:** retry Install; the wrapper points that run at `~/.npm-global` without changing
  npmrc. Restart is not required; discovery already searches that dir (`ensureAgentPath`).

## Text-to-speech

### Synthesis returns 504 `{"error":"synthesis timed out or client disconnected"}` (or a speak-record job fails with `synthesis timed out`)

- **Cause:** the Piper/Kokoro sidecar did not answer; fetch errors are logged as
  `[tts] <provider> synth error: <message>` (`apps/server/src/routes/tts.ts`; detached
  job failure string). Default sidecar URLs are `http://127.0.0.1:5000` (Piper) and
  `http://127.0.0.1:8880` (Kokoro) (`apps/server/src/db/seed.ts`).
- **Fix:** start the sidecar; see [Configure TTS Sidecars](guides/configure-tts-sidecars.md):
  and confirm the URL in Voice settings matches where it listens.

### Listing Kokoro voices fails with `kokoro voices <HTTP status>`

- **Cause:** the voices endpoint `<kokoroUrl>/v1/audio/voices` answered non-2xx or the fetch
  threw (`apps/server/src/tts/kokoroVoices.ts`).
- **Fix:** verify `tierwyn-kokoro.service` is active (`curl 127.0.0.1:8880/health`) and that the configured `kokoroUrl` is right.

### Speak fails with `TTS summarize LLM not configured: set Voice → Transcript cleanup provider/model`

- **Cause:** speak/summarize reuses the transcript-cleanup LLM transport, and no provider/model
  is configured (`apps/server/src/routes/tts.ts`).
- **Fix:** set the Voice → Transcript cleanup provider and model in settings.

### Downloading a Piper voice fails with `voice download failed: HTTP <status>`

- **Cause:** the curated voice download from
  `huggingface.co/rhasspy/piper-voices` returned a non-2xx status
  (`apps/server/src/adapters/piperVoices.ts`).
- **Fix:** check network reachability to huggingface.co and retry the download.


## Deployment & reverse proxy

### A chat fails with `spawn <agent> ENOENT` under systemd, although `which <agent>` finds it

- **Cause:** systemd user units do not inherit your shell `PATH`. The unit's default `PATH` omits
  the directories agent CLIs install into (`~/.local/bin`, `~/.npm-global/bin`, …).
- **Fix:** add a `PATH=` line listing every agent CLI directory to the prod env file, then
  `systemctl --user restart tierwyn-prod.service`. `.env.example` § PATH has the template and a
  command that prints the running unit's `PATH`.

### Login succeeds, then loops back to the login screen over plain HTTP

- **Cause:** `COOKIE_SECURE` defaults to true, and the browser drops `Secure` cookies on
  `http://`. Same root cause as the 401 entry under
  [Authentication & connectivity](#authentication--connectivity).
- **Fix:** serve the UI over HTTPS. Set `COOKIE_SECURE=false` only for direct-HTTP testing.

### Vite answers `Blocked request. This host ("<host>") is not allowed.`

- **Cause:** Vite preview rejects Host headers it does not know. Behind a reverse proxy the
  browser sends your public domain (`allowedHostsFromEnv` in `apps/web/vite.config.ts`).
- **Fix:** set `TIERWYN_ALLOWED_HOSTS` on the web unit to a comma-separated hostname list (or
  `true` to allow any Host, which disables the check), then restart the web unit.

### Every POST/PATCH/DELETE answers 403 `{"error":"forbidden"}` behind a proxy

- **Cause:** the CSRF guard compares the `Origin` (or, without one, the `Referer`) host with the
  request's `Host` header and refuses a mismatch (`csrfGuard` in
  `apps/server/src/auth/middleware.ts`). A proxy that rewrites `Host` to the upstream address
  breaks the match. The WebSocket upgrade runs the same check and answers a bare `403 Forbidden`
  (`apps/server/src/auth/wsGuard.ts`).
- **Fix:** forward the original `Host` (nginx `proxy_set_header Host $host;`) and leave `Origin`
  untouched. See `docs/deploy/nginx.conf.example` and `docs/deploy/Caddyfile.example`.

### Every client shows the proxy's IP, or one bad login locks everyone out

- **Cause:** a numeric `TRUST_PROXY` is a hop count (`apps/server/src/index.ts`). With Vite
  preview between the proxy and the API, the count lands on the proxy, so the login rate limiter
  keys every client to one IP.
- **Fix:** list the trusted proxies explicitly, e.g. `TRUST_PROXY=loopback,<proxy-ip>`. Keep
  `HOST=127.0.0.1` so no client can reach the API directly and forge `X-Forwarded-For`.

### The prod unit fails to start with `Result: resources`

- **Cause:** the prod env file (convention: `/etc/tierwyn/prod.env`) is not readable by the user
  running the systemd user unit, typically because root owns it.
- **Fix:** `chown` it to that user, `chmod 600` it, then restart the unit.

### A sandboxed turn fails with `sandbox_unavailable`, or shows `Sandbox: off (host can't sandbox)`

- **Cause:** the sandbox probe runs `bwrap --ro-bind / / --unshare-pid true` once and caches the
  result (`bwrapAvailable` in `apps/server/src/sandbox/bwrap.ts`). It fails when `bwrap` is not
  installed or not on the unit's `PATH`, or when the kernel blocks unprivileged user namespaces.
  An explicit conversation/project `on` then fails closed; an inherited `on` runs unsandboxed with
  a notice.
- **Fix:** install bubblewrap and run the probe command by hand as the service user to see the
  real error. Restart the API afterwards, since the probe result lasts for the process lifetime.
  See [sandbox.md § Capability overrides](architecture/sandbox.md#capability-overrides-and-fail-closed-behaviour).

Remote host issues: [remote-hosts.md § Troubleshooting](architecture/remote-hosts.md#troubleshooting).
