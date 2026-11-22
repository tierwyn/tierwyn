# Small Server Modules

Documentation of thinly-documented utility modules in `apps/server/src/`.

---

## auth

**Purpose:** Single-operator fail-closed authentication via HMAC-signed session cookies and argon2 password hashing.

**Files:** `auth/config.ts`, `auth/cookie.ts`, `auth/password.ts`, `auth/middleware.ts`, `auth/wsGuard.ts`, `auth/rateLimit.ts`, `auth/routes.ts`

**Who calls it:** Every Express route and WebSocket upgrade. Operator-only routes are wrapped with `requireAuth()` middleware; the upgrade gate wraps `attachAuthenticatedWss()`.

**How it works:**

- **Config loading** (`loadAuthConfig()`): Reads `AUTH_DISABLED`, `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, `COOKIE_SECURE` from `process.env`. When disabled, all auth is bypassed (dev only). When not configured (secrets missing), the server boots fail-closed: every protected route answers 401, no login succeeds.

- **Session cookies** (`cookie.ts`): Sessions are `<base64url(payload)>.<base64url(hmac)>` tokens where payload is `{iat, exp}` (no PII). Signed with HMAC-SHA256. Verified with timing-safe comparison. Defaults to 30-day max-age. Carries the `Secure` flag (HTTPS only, configurable via `COOKIE_SECURE=false` for localhost plain HTTP). When `COOKIE_SECURE=true` the cookie is `__Host-tierwyn_session`; over plain HTTP it is `tierwyn_session`.

- **Password verification** (`verifyPassword()`): Async argon2 verification against the stored hash. Returns boolean only; never throws or logs the plaintext password.

- **REST routes** (`routes.ts`): Mounts `POST /auth/login` (rate-limited per-IP, generates and sets cookie), `POST /auth/logout` (clears the session cookie name(s) for the current `COOKIE_SECURE` mode), and `GET /auth/session` (reads authentication state).

- **Express middleware** (`middleware.ts`): `requireAuth()` returns 401 unless a valid session cookie is present. Fail-closed when not configured.

- **WebSocket upgrade gate** (`wsGuard.ts`): Intercepts the HTTP `upgrade` event. Rejects unauthenticated or cross-origin upgrades (401, socket destroyed) before any WebSocket object is created. Blocks DNS-rebinding attacks when `AUTH_DISABLED` by restricting Host to localhost, IP literals, or `TIERWYN_ALLOWED_HOSTS` env.

- **Rate limiting** (`rateLimit.ts`): In-memory login throttle keyed by client IP. After `maxAttempts` failures within `windowMs`, the IP locks for `lockoutMs`. Single-process, no persistence. Used by `/auth/login` to return 429 with `Retry-After` header.

**Environment variables:**

- `AUTH_DISABLED=true`; bypass all auth (dev only, logs a warning)
- `SESSION_SECRET`; ≥32-byte random string for HMAC cookie signing (required for auth)
- `OPERATOR_PASSWORD_HASH`; argon2id hash of the single operator password (required for auth, e.g. `$argon2id$...`)
- `COOKIE_SECURE=false`; allow plain-HTTP cookies (default true, set false only for localhost dev)
- `TIERWYN_ALLOWED_HOSTS`; comma-separated hostnames to allow when `AUTH_DISABLED`; `true`/`all` allows any; default requires localhost/IPs

**Security notes:**

- Fail-closed architecture: missing secrets prevent any successful login and every protected route returns 401.
- Session tokens carry no PII; only `iat`, `exp`, an issuance-millisecond timestamp (`iatMs`), and a password-hash fingerprint (`ph`).
- Cookies are `HttpOnly` + `SameSite=Lax`, defeating XSS exfiltration and most CSRF.
- Timing-safe comparison prevents timing-side-channel attacks on token verification.
- DNS-rebinding guard blocks DNS-pointing attacks against unauth-disabled dev servers.

---

## net

**Purpose:** Minimal port-discovery utility.

**Files:** `net/ports.ts`

**Who calls it:** Test suites only (no production use detected).

**What it does:**

- `findFreePort()`: Binds a TCP server to `127.0.0.1:0`, reads the allocated port from `.address()`, closes the server, and returns the port number. Used to avoid port collisions in parallel tests.

---

## shell

**Purpose:** Operator shell command execution with allow-list gating and metacharacter rejection.

**Files:** `shell/tokeniser.ts`, `shell/gate.ts`

**Who calls it:** `routes/shell.ts` (the HTTP routes for shell execution).

**How it works:**

- **Tokeniser** (`tokeniser.ts`): Parses a command string into argv. Rejects shell metacharacters (`|`, `&`, `;`, `<`, `>`, `$`, `` ` ``, `\`, `{}()`, newlines, NUL). Honors double and single quotes for grouping args-with-spaces. Fails closed on unbalanced quotes. Used to prevent shell injection even when executed with `shell: false`.

- **Gatekeeper** (`gate.ts`): Two-stage check: (1) allow-first, fail-closed: the argv must match a prefix rule from `SHELL_BASE_ALLOW` (shared defaults) or per-project rules; (2) seatbelt (not the gate): rejects individual destructive tokens (e.g. `--force`, `--hard`, `rm`, `dd`). The allow-list is the security boundary; the deny-list only catches a flag on an otherwise-allowed command.

**Who calls it from the REST layer** (`routes/shell.ts`):

- Wraps tokeniser and gate in the `POST /conversations/:id/shell` route.
- Spawns the command with `shell: false`, `stdio: ['ignore', 'pipe', 'pipe']` (closes stdin to prevent `cat` from hanging).
- Caps stdout + stderr at `SHELL_OUTPUT_CAP_BYTES` (shared constant).
- Enforces `SHELL_TIMEOUT_MS` (default 60 s).
- Records all turns (command, cwd, result, duration) to the conversation transcript.

**Allow-list lookup:**

The gate checks `SHELL_BASE_ALLOW` (built-in allowlist, e.g. `["git"]`, `["npm", "run"]`) plus per-project rules from the `shell_allow` table. A command is allowed if it matches any rule by prefix (last token may end with `*` for prefix match).

**Constants:**

- `SHELL_BASE_ALLOW` and `SHELL_DENY_ARG_TOKENS` are defined in `@tierwyn/shared/src/profiles.ts`.
- `SHELL_TIMEOUT_MS` and `SHELL_OUTPUT_CAP_BYTES` are in `@tierwyn/shared/src/constants.ts`.

**Security notes:**

- Fail-closed tokeniser: any shell metachar or syntax error refuses the command.
- `shell: false` + no stdin prevents shell interpretation and blocks commands that wait on input.
- Allow-first + seatbelt deny-list: the allow-list is the gate; the deny-list is only a safeguard.
- All turns are persisted to the transcript (audit trail).
- Operator-only routes (mounted after `requireAuth()` middleware).

---

## files

**Purpose:** Operator file browsing and write-policy enforcement for agent file edits.

**Files:** `files/listing.ts`, `files/writePolicy.ts`

**Who calls it:**

- `listing.ts`: `routes/files.ts` (`GET /files/list`, `GET /project-browse/list`); also used by `node/` remote-host RPC.
- `writePolicy.ts`: `routes/files.ts` (file-write validation); also used by `node/` remote-host RPC to enforce the same policy on the node.

**Listing** (`listUnderRoot()`):

- Takes an absolute root directory and a raw client-supplied relative path.
- Validates the path lexically (no absolute paths, no `..` escapes, no `\0`, no starting with `/` or `~`).
- Realpaths both root and target to defeat symlink escapes.
- Denies `.git` directories and `<dataDir>/archive` (retention cold storage).
- Reads the directory and stats every entry (dirs, files, symlinks).
- Marks files as `openable` only if: the extension is in the openable list, the path is not a secret (`.env`, `.token`, etc.), and it's not in the retention archive.
- Caps output at 2000 entries (truncation flag set if exceeded).
- Returns file metadata: name, kind (`dir` / `file` / `other`), size, mtime, symlink status.

**Write policy** (`isWritePathAllowed()`):

- Roots are project roots + the conversation's worktree only (never agent homes, temp, media).
- Denies paths containing `.git`, dotfiles, files without an openable extension, and secret files.
- Requires the target to be under one of the allowed roots (realpath check).
- Returns a boolean only; used by `files.write` RPC and agent file-edit routes to validate edits before persisting.

**Environment variables:**

- `TIERWYN_DB` points to the data directory; its `archive/` subdirectory is deny-listed.

**Security notes:**

- Lexical + realpath double-check defeats symlink escapes.
- `.git` and `archive/` always denied, even with permission.
- Write-allowlist is strict: only openable file types in project/worktree roots.
- Symlinks are reported as such but cannot escape the boundary.
- Used by both hub and remote node to enforce the same policy.

---

## tts

**Purpose:** Text-to-Speech integration: Kokoro voice listing and WAV-to-MP3 conversion.

**Files:** `tts/kokoroVoices.ts`, `tts/wavToMp3.ts`

**Who calls it:**

- `kokoroVoices.ts`: `routes/tts.ts` (list voices for the Settings picker).
- `wavToMp3.ts`: `routes/tts.ts` (download recordings as MP3).

**Kokoro voices** (`kokoroVoices.ts`):

- `listKokoroVoices(baseUrl)`: Fetches `{baseUrl}/v1/audio/voices` from the Kokoro sidecar (native wrapper or Kokoro-FastAPI). Expects `{ voices: [{id, name}] }` or a bare string array.
- `normalizeKokoroVoices(body)`: Pure function that parses the response flexibly (bare string array, `{voices: [...]}`, or `{id, name}` objects). Returns a stable sorted `KokoroVoice[]`.
- `kokoroVoiceLabel(id)`: Maps voice prefix (e.g. `af_`, `bm_`) to a gender/locale hint for the dropdown label (e.g. "American ♀").

**In-app playback:** WAV only (no conversion). Downloads trigger the MP3 conversion below.

**WAV-to-MP3** (`wavToMp3.ts`):

- `wavBufferToMp3(wav)`: Spawns `ffmpeg` to convert a WAV buffer to MP3 (VBR quality ~4, speech-friendly size without a pure-JS encoder dependency). Writes temp files to `os.tmpdir()`, spawns ffmpeg, reads the output, and cleans up temp files. Returns a Promise&lt;Buffer&gt;.

**Environment variables:**

- Settings → Voice → TTS provider: `tts.kokoroUrl` (default `http://127.0.0.1:8880`)
- The TTS routes probe this URL to report `kokoroUp` to the client.
- `ffmpeg` must be on PATH for MP3 downloads.

**Deployment notes:**

- Kokoro sidecar is optional, operator-managed. See [docs/deploy/operator-sidecars.md](../deploy/operator-sidecars.md) § Kokoro.
- ffmpeg must be installed on the Tierwyn host for MP3 encoding.

---

## secrets

**Purpose:** Encrypted vault management for agent environment variables and MCP server secrets.

**Files:** `secrets/agentEnv.ts`, `secrets/mcpRedact.ts`

**Who calls it:**

- `agentEnv.ts`: `childEnv.ts` (load per-agent env vars for spawned child processes).
- `mcpRedact.ts`: `repositories/events.ts` (redact secrets from persisted transcripts at the single append choke point).

**Agent env vault** (`agentEnv.ts`):

- `loadAgentEnv(db, agentType)`: Loads environment variables from the encrypted vault that are scoped to a specific agent type (e.g. `env.copilot.COPILOT_GITHUB_TOKEN`). Returns `{own, managedNames}` where `own` contains decrypted values for that agent, and `managedNames` lists all env keys (including those for other agent types, for scrubbing in output).
- Vault key format: `env.{agentType}.{NAME}` (validated by regex). Example: `env.copilot.COPILOT_GITHUB_TOKEN`.
- `listAgentEnvVars(db)`: Lists all agent env metadata (no values).
- `migrateCopilotTokenKey(db)`: One-off boot migration: renames old `copilot.token` to `env.copilot.COPILOT_GITHUB_TOKEN`.
- Vault is stored in `plugin_secrets` table under `plugin_id = 'tierwyn:agents'`.

**MCP secret redaction** (`mcpRedact.ts`):

- Maintains an in-memory set of every MCP secret value (from the `tierwyn:mcp` vault and boot-captured `TIERWYN_MCP_*` env).
- `refreshMcpRedactSet(db)`: Reads all vault rows for MCP servers and agents, collects values ≥8 bytes, and builds a sorted needle list (longest first).
- `redactMcpSecrets(text)`: Replaces all needles in the text with `[REDACTED]`. Applied at `repositories/events.ts` appendEvent, the single persist choke point.
- Also redacts escaped forms (JSON-stringified).

**How it integrates:**

- `childEnv.ts` calls `loadAgentEnv()` to build the spawn env for each agent type, injecting decrypted values and scrubbing managed names.
- `repositories/events.ts` calls `redactMcpSecrets()` before persisting every event, preventing secrets from landing in the DB file or transcript REST outputs.
- Secrets are never logged, shown in REST responses, or included in the preamble.

**Environment variables:**

- `TIERWYN_MCP_*`; boot-captured MCP server secrets (encrypted in vault, never deleted from env before boot capture).

**Security notes:**

- Vault uses AES-256-GCM encryption (HKDF over `TIERWYN_PLUGIN_VAULT_KEY` or `SESSION_SECRET`).
- Fail-closed if the derivation secret is &lt;32 bytes.
- Redaction is applied at the single persist choke point, catching all output paths (DB, transcripts, REST responses).
- Managed env names are scrubbed from output even if they are not decryptable, preventing enumeration of configured keys.
- This is disclosure-through-the-product-surface protection, **not** a boundary against same-UID `/proc/<pid>/environ` reads. Unsandboxed agents can still read env files and decrypt the vault.

---

## notifications

**Purpose:** Web Push and browser notification dispatch with optional Jev AI decision filtering.

**Files:** `notifications/notifier.ts`

**Who calls it:**

- `decideThenNotify(db, input)`; fire-and-forget entry point (no client frame).
- `notifyOperator(db, input, interruptWorthy?)`; dispatches after Jev filtering (optional).
- `judgeInterrupt(db, input)`; queries Jev to decide if the interrupt is worthy.

**How it works:**

- **Eligible categories:** `conversationComplete` (agent done/error), `agentMessage` (unsolicited inbound), `scheduleRunEnded` (job settled).
- **Jev integration** (optional): When Jev is enabled and configured, `judgeInterrupt()` queries the decision service with per-category questions (`interrupt_worthy`, `needs_attention`, `expects_reply`, `urgency`, etc.). Returns `true` (send), `false` (suppress), or `undefined` (fail-open, send anyway).
- **Suppression:** If `interruptWorthy === false` (Jev verdict), the notification is not sent. If settings are disabled or category is off, no send.
- **Content scrubbing:** Only the last assistant text excerpt is sent to the decision service (max 1500 chars, with spawn/run tokens, code blocks, and paths scrubbed).
- **VAPID key generation:** On first run, keys are auto-generated and stored in settings.
- **Push delivery** (`deliver()`): For each subscribed device, sends the payload via `web-push`. Removes 404/410 subscriptions (device deleted).

**What is not a notification:**

See [Browser Notifications](./browser-notifications.md) for the full topic: what categories exist, how to enable them, and what suppresses in-app. This module is the server delivery layer only.

**Environment variables:** none: VAPID keys are auto-generated on first use and the VAPID subject (`vapidSubject`, default `mailto:operator@localhost`) lives in the notifications settings row and is set via `POST /settings/notifications` (no UI field).

**Database tables used:**

- `push_subscriptions` (endpoint, p256dh, auth from browser registration).
- `settings` (notification metadata, Jev API key, VAPID keys).

**Security notes:**

- Redacts spawn/run tokens before sending content to Jev, preventing token leakage.
- Content extraction is at a single source (`lastAssistantText`), making audits easier.
- Fire-and-forget: errors are logged but never bubble to the caller.
- VAPID key generation is idempotent (first caller wins).

---

## Shared documentation

- **Browser notifications UI/UX:** [Browser Notifications](./browser-notifications.md)
- **Dictation and TTS settings:** [Dictation (STT/TTS)](./dictation.md)
- **Auth security model:** [SECURITY.md](../../SECURITY.md) § Single-operator fail-closed auth
- **Per-agent env vault & MCP secrets:** [Plugins](./plugins.md) § Plugin credentials, and [MCP Servers](./mcp-servers.md) § Secret injection
