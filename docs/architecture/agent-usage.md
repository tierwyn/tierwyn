# Agent Usage Panel

How the Settings → Agent Usage panel sources rate-limit / quota data per
agent and provider, and how to configure the Z.ai (GLM) API key.

Data flow: `GET /settings/agent-usage?fresh=1` → `buildAgentUsage()`
(`apps/server/src/routes/agentUsage.ts`) → one `AgentUsageSnapshot` per
entry → rendered by `apps/web/src/components/AgentUsageSettings.tsx`
(and `UsagePanel.tsx` per conversation for the active agent). `fresh=1`
(refresh button) bypasses each probe's cache.

## Card kinds

Each snapshot carries:

| Field | Meaning |
|---|---|
| `kind` | `'agent'` (CLI quota) or `'provider'` (account / cloud quota) |
| `source` | `'builtin'` or `'plugin'`, which source filled `groups` |
| `label` | Display title from the API (no hardcoded names in the UI) |

The panel groups **Agent quotas** (`kind: 'agent'`) above a **Providers**
section (`kind: 'provider'`). Provider cards show a small source badge
(`built-in` / `plugin`).

The **Jev · TypeSafe System One** card is a built-in provider card with no
plugin and no allowance windows (`groups: []`); it carries a `spend` ledger
summary (last 30 days: calls, input tokens, cost, per-consumer split, failure
reasons) instead. It is appended by `GET /settings/agent-usage` only and is
never returned by `/agent/usage`. See [`jev.md`](./jev.md#usage--cost).

The Z.ai **provider** quota card is `kind: 'provider'`, `label: 'Z.AI'` (plan badge e.g. `[LITE]` unchanged).

## Probe sources (built-in)

| Entry | Probe | Source | Key / auth |
|---|---|---|---|
| **claude-code** | `probeClaudeRateLimits` (`adapters/claude-code/probeUsage.ts`) | Throwaway SDK query, `/usage` control request | Claude OAuth (CLI login) |
| **antigravity** | `probeAgyUsageGroups` (`adapters/antigravity/probeUsage.ts`) | `agy` CLI | Antigravity login |
| **grok-build** | `probeGrokRateLimits` (`adapters/grok-build/probeUsage.ts`) | Throwaway `grok agent` ACP + `_x.ai/billing` | Grok login |
| **codex** | `probeCodexRateLimits` (`adapters/codex/probeUsage.ts`) | Throwaway `codex app-server` + `rateLimits/read` | Codex login |
| **kiro** | `probeKiroRateLimits` (`adapters/kiro/probeUsage.ts`) | `kiro-cli chat --no-interactive /usage` (**stderr**, ANSI text, no JSON mode). Monthly credits used/limit, plan name, billing-cycle reset. Conversation Usage also overlays ACP `contextUsagePercentage` plus optional `kiro-cli chat --no-interactive --resume-id <id> /context` breakdown (Context files / Tools / Kiro responses / Your prompts). | Kiro CLI login (`kiro-cli login`) |
| **copilot** | `probeCopilotRateLimits` (`adapters/copilot/probeUsage.ts`) | `GET api.github.com/copilot_internal/user`; monthly premium requests used/entitlement (Free plan: chat quota), plan, reset date | `gh auth token` (GitHub CLI login) |

All probes share the same shape: 20s TTL cache + single-flight
(`reset*ForTests()` exports for tests). Successful payloads are cached;
most adapters do **not** cache a thrown Error, so a down CLI can be
re-spawned on the next call (Codex caches a missing-binary spawn as `{}`).
A thrown Error surfaces as that
card's error row; the other cards are unaffected.

**qwen** and **kimi** have no account-quota probe; they surface live context %
from ACP `usage_update` only (`apps/server/src/usageCapabilities.ts`), so their
panels never show a rate-limit bar.

**antigravity** reports context % (`usageCapabilities.ts`: `supportsContextWindow: true`). `agy`'s `result.usage` is cumulative tool-loop turnover, not the context occupied right now, so the adapter takes occupancy from the last `agent_response` step's `usage` (`input + cache_read`) and computes the % against the model's window. The last positive snapshot is kept across turns; until one arrives, no % is shown. Rate limits come from `agy --print /usage`.

A card only appears with built-in data when `discoverInstalledAgents()`
reports the agent's binary installed; otherwise the card shows the install
hint (unless a plugin usage-provider fills it).

## Plugin usage providers (Z.AI, Cursor and OpenRouter)

Plugins declare `usageProvider: { label }` on a capability (see
[`plugins.md`](./plugins.md)). `PluginHost.listUsageProviders()` merges
those onto the usage response as `kind: 'provider'` cards.

The web panel queries `POST /agent/plugins/:id/capabilities/usage.get` (operator cookie
or agent spawn token) and displays quota bars, credits used/limit, and cycle reset timers:

1. **`zai-usage` (`plugins/zai-usage/`)**:
   - Provider label: `Z.AI`
   - Capability: `usage.get`
   - Key: `ZAI_API_KEY` (from [z.ai/model-api-key](https://z.ai/model-api-key))
   - Endpoint: `GET https://api.z.ai/api/monitor/usage/quota/limit`
   - Data: 5h and 7d token limit windows, subscription tier (`lite`, `pro`, `max`).

2. **`cursor-usage` (`plugins/cursor-usage/`)**:
   - Provider label: `Cursor`
   - Capability: `usage.get`
   - Key: `CURSOR_API_KEY` (User API Key from [cursor.com/dashboard/api](https://cursor.com/dashboard/api))
     *(Also supports `CURSOR_AUTH_TOKEN` JWT or `CURSOR_SESSION_TOKEN` cookie)*
   - Endpoints: Exchanged at `POST https://api2.cursor.sh/auth/exchange_user_api_key`, then queried at `GET https://cursor.com/api/usage`.
   - Data: Fast requests used / limit (e.g. 142 of 500), monthly billing cycle reset date, on-demand spend / cap, and membership tier (`Pro`, `Business`, `Free`).

3. **`openrouter-usage` (`plugins/openrouter-usage/`)**:
   - Provider label: `OpenRouter`
   - Capability: `usage.get`
   - Key: `OPENROUTER_API_KEY`; a single key, or a comma-separated list of up to 12,
     each optionally named: `Work=sk-or-v1-…,Personal=sk-or-v1-…,sk-or-v1-…`
     (from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys)). Name precedence per section:
     operator name → OpenRouter key label → `Key N`. OpenRouter's auto-label for an
     unnamed key is a masked key prefix (`SK-OR-V1-EEC…E6B`); that is demoted to `Key N`.
   - Endpoints: `GET https://openrouter.ai/api/v1/key` per key; `GET .../api/v1/credits` once,
     best effort (account totals need a management key, a 403 just hides the Account row).
   - Data: Account section shows **prepaid balance** (remaining credits).
     The historic all-time usage bar and credits fraction are omitted.
     Per-key sections show **used of cap** (`key credits used`) with spend
     caps, bars, and remaining limits. `matchAgent` defaults to `^openrouter$`,
     i.e. it claims no conversation's usage panel until an operator widens it.

   **Migration from v1 (four separate key slots):** your current single key needs no action.
   To add keys, replace the value with a comma-separated list. If you ever set
   `OPENROUTER_API_KEY_2`/`_3`/`_4`, Clear them in Settings → Plugins before deploying v2.
   **If `OPENROUTER_API_KEY_2`..`_4` are in an env file, delete those lines**: boot-capture
   only scrubs *declared* credential keys from `process.env`; an undeclared key would stay in
   the environment and be inherited by every agent child process. Manifest changed → server
   restart required.

## Configuring Provider API Keys

### Via Web UI Plugin Vault (Recommended)
Navigate to **Settings → Plugins**, find the plugin (`zai-usage`, `cursor-usage`, or `openrouter-usage`), and click **Set** to enter the API key into the encrypted SQLite vault (AES-256-GCM). Changes take effect immediately with no server restart required. For `openrouter-usage`, one Set/Clear row holds the whole comma-separated list.

### Via Environment File
Keys can also be defined in the environment file:

| Variable | Target Plugin | Where to Get It |
|---|---|---|
| `ZAI_API_KEY` | `zai-usage` | [z.ai/model-api-key](https://z.ai/model-api-key) |
| `CURSOR_API_KEY` | `cursor-usage` | [cursor.com/dashboard/api?section=user-keys](https://cursor.com/dashboard/api?section=user-keys) |
| `OPENROUTER_API_KEY` | `openrouter-usage` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |

A list value must be quoted in the env file: `OPENROUTER_API_KEY="Work=sk-or-v1-…,Personal=sk-or-v1-…"`.

| Environment | File |
|---|---|
| Dev | repo `.env` |
| Prod | `/etc/tierwyn/prod.env` (600, owned by your UID) |

After editing env files: restart `tierwyn-prod` in prod (`npm run deploy:prod:full` or `systemctl --user restart tierwyn-prod`). Dev picks up `.env` on next `npm run dev:server`.

### Verifying it works

- Panel: Settings → Agent Usage → **Providers** → **Z.AI** card shows the
  plan badge (e.g. `lite`) and the 5h window bar, with a `plugin` or
  `built-in` source badge.
- Weekly bar appears on plans that have a unit-6 window.
- If neither plugin nor built-in key resolves, the card shows a configure /
  error note rather than a dead empty row with no explanation.
- **OpenRouter** card shows a `plugin` badge and one section per configured key.
  An Account section appears only when the first key is a management key.

### Gotchas

- Plugin capability results never include credential values (host redaction).
- Wrong-base-URL protection on the built-in probe is host-exact
  (`api.z.ai.evil.com` does not match).
- z.ai built-in probe failures are never cached (unlike successful probes):
  each panel open retries, so a fixed key recovers without a server restart
  for the built-in path; the plugin path requires the key at boot capture.

## Agent access

Agents get the same telemetry the operator panel does, in two agent-facing
endpoints on the same router as `/agent/plugins` (documented in
`GET /agent/plugins/help`).

### `GET /agent/usage`: one aggregate

`200 { builtins, providers, updatedAt, agents }`. `agents` is a deprecated
alias of `builtins` kept for older consumers.

- `builtins[]`; the allowlist projection described above (Claude Code, Codex,
  Antigravity, Grok Build, Kiro, GitHub Copilot); `installed:false` entries are skipped-nothing:
  they are listed so agents know not to probe.
- `providers[]`; one card per active usage plugin:
  `{ id, label, configured, ok, data?, error?, code?, fetchedAt }`. A provider
  that has not answered carries `ok:false` with `code` `not_configured`
  (operator has not set the dedicated key) or the invoke failure code; agents
  must treat those as *unknown*, not exhausted. A slow provider times out at
  5s per provider with `code:"timeout"`; the aggregate never blocks longer.
  The underlying invoke keeps running (host 15s cap) and a late success is
  cached so the next call does not re-probe.

### `GET /agent/usage/:target`: one card

`target` is a built-in agent type (`claude-code`, `codex`, …) or a provider id
(`zai-usage`, `cursor-usage`, …). `200 { builtin }` / `200 { provider }` with
the same card shapes; provider failure codes map to their plugin error HTTP
status (`not_configured` → 503); unknown target → `404 { error, targets[] }`
listing every valid id.

### Shared semantics

- Auth: spawn-scoped Bearer with the `plugin` capability, or operator cookie.
  Schedule-only tokens get 401. Same router as `/agent/plugins` (before `requireAuth`).
- Rate limit: **both endpoints share** one 6 calls/min per conversation bucket
  (`MinuteBucket`); excess → 429 with `Retry-After` and `retryAfter` in the body.
- Never forces a probe: `?fresh=1` is ignored, so the built-in probes' 20s TTL
  and single-flight apply. A **failed** probe (timeout / missing CLI) is not
  cached on most adapters, so the next call can spawn again; the 6/min cap
  bounds that. Codex already caches a spawn failure as empty data for 20s.
- Provider cards are cached server-side for 30s with in-flight dedupe on the
  raw invoke. Successful cards and non-retryable failures are cached; retryable
  failures (rate_limited / upstream_error) re-probe on the next call. A 5s
  timeout card is not cached; if the late invoke succeeds it fills the cache.
- Probe errors are truncated to 200 chars in `error`.
- `GET /agent/plugins/help` documents the endpoint for agents (loopback only).
