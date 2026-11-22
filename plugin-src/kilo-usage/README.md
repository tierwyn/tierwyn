# kilo-usage

Kilo (`kilo.ai`) prepaid credit monitor for Tierwyn. Shows remaining USD balance
per API key (up to 12) in Settings → Agent Usage → Providers, and as the
allowance block in the per-conversation Usage Panel when the agent is
`kilocode`.

## Credentials

Set `KILO_API_KEY` (required) in **Settings → Plugins** (vault) or in your
environment file (`.env` / `/etc/tierwyn/prod.env`).

Get your keys at: **kilo.ai profile → API keys**.

### Single key

Paste the key as the value.

### Multiple keys

**Settings → Plugins:** the `KILO_API_KEY` row is the Key List Editor — a
multi-box table with one optional name + API key pair per row (up to 12). Use
**+ Add key** to append a row and the ✕ remove button to drop one. Set
serialises the rows into the comma-separated grammar below. Because stored
credentials are never read back, **Set replaces the whole list** — enter every
key you want to keep.

**Env file:** the same stored value is a comma-separated list. Each entry is
optionally named:

```
Work=kilo_…,Personal=kilo_…,kilo_…
```

The third key in that example gets `Key 3` (or the Kilo profile name/email
in the Settings UI). Agent callers of `usage.get` never receive profile
name/email — unnamed keys are `Key N`; operator-chosen names (`Work=…`) stay.

**Grammar:** `value := entry ("," entry)*`, `entry := [name "="] key`.
Whitespace around names, keys, and commas is trimmed. Empty fragments (trailing
comma, `,,`) are silently skipped. Identical key values are de-duplicated (first
occurrence wins). Maximum 12 entries.

Two surprising edges, identical to OpenRouter so the plugins behave the same:

- `Work=` (empty key after `=`) → the whole entry is a bare key `"Work"`.
- `=kilo-a` (empty name before `=`) → treated as a bare key `"kilo-a"`.

Individual keys inside the single credential value are not independently
redacted in the credentials UI (an accepted consequence of the single-value
grammar). The env file still uses this list format even when the Settings UI
is the Key List Editor.

### Env-file quoting

The list value contains `=` and `,`. Quote it in your env file:

```
KILO_API_KEY="Work=kilo_…,Personal=kilo_…"
```

### Name precedence

Each key's display name is resolved in order:

1. **Operator name** from the list (e.g. `Work` in `Work=kilo_…`) — wins always,
   after known keys are stripped and secret-shaped names are discarded.
2. **Kilo profile** `user.name`, else `user.email`, from `GET /api/profile` —
   only fetched for unnamed keys.
3. **`Key N`** (1-based index in the list).

A present-but-unusable operator name (looks like a key or a JWT) falls back to
`Key N` and does **not** yield to the profile name.

Keys on the **same Kilo account** share a profile name, so a colliding
API-derived label is demoted to `Key N`. Operator names are never demoted for
collision — if you name two keys the same thing, that is kept.

**Name your keys.** Named keys skip the profile lookup, which halves the API
calls on a cold refresh and produces better labels.

## What the card shows

- One section per configured key showing the **prepaid balance** ($X.XX).
- Healthy keys display the `paid` plan badge (matching OpenRouter).
- A depleted account (`isDepleted: true`) shows the no-credits chip.
- Errored keys degrade to a label-only row; the other keys still render
  normally. Top-level balance mirrors the first *healthy* key, not a sum —
  balances on distinct Kilo accounts are not fungible. If every key fails the
  card errors and no plan badge is emitted.

## Units

Balances are **US dollars** as returned by Kilo. No conversion is applied.
(A field whose name unambiguously says microdollars is divided by 1e6; a large
`balance` number is never treated as microdollars by magnitude.)

## Vault prerequisite

The Plugin Vault requires a ≥32-byte `SESSION_SECRET` (or
`TIERWYN_PLUGIN_VAULT_KEY`). Without it, Settings → Plugins shows "Vault
unavailable" and keys must go in the env file.

## Manifest

- Version: `1.0.0`
- Capability: `usage.get` (`agentCallable: true`, 10 req/min)
- Credentials: `KILO_API_KEY` (required) — single key or comma-separated list
- Egress: `https://api.kilo.ai` only (the legacy `kilocode.ai` host 308s and
  is not followed)
- `matchAgent`: defaults to `^kilocode$` (matches the kilocode adapter)

## After install / env file key change

A restart is needed when the plugin is **newly added**, when the **manifest
changes**, or when keys are set in the environment file (`.env` /
`/etc/tierwyn/prod.env`): `npm run dev:server` for dev, or
`npm run deploy:prod:full` / `systemctl --user restart tierwyn-prod` for prod.

Keys set via the **Plugin Vault** (Settings → Plugins → Set) take effect
immediately — no restart required.

Then: Settings → Agent Usage → **Providers** should show a **Kilo** card
with a `plugin` badge and one section per key.
