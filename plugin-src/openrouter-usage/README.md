# openrouter-usage

OpenRouter credit balance monitor for Tierwyn. Shows remaining credits per API key
(up to 12) plus optional account totals in the Settings → Agent Usage → Providers card.

## Credentials

Set `OPENROUTER_API_KEY` (required) in **Settings → Plugins** (vault) or in your
environment file (`.env` / `/etc/tierwyn/prod.env`).

Get your keys at: https://openrouter.ai/settings/keys

### Single key (backward compatible)

Just paste the key as the value — `sk-or-v1-aaa…`.

### Multiple keys (comma-separated list)

Replace the value with a comma-separated list. Each entry is optionally named:

```
Work=sk-or-v1-aaa…,Personal=sk-or-v1-bbb…,sk-or-v1-ccc…
```

The third key in that example gets `Key 3` (or its OpenRouter dashboard label)
because no name was given.

**Grammar:** `value := entry ("," entry)*`, `entry := [name "="] key`.
Whitespace around names, keys, and commas is trimmed. Empty fragments (trailing
comma, `,,`) are silently skipped. Identical key values are de-duplicated (first
occurrence wins). Maximum 12 entries. Two surprising edges: `Work=` (empty name before `=` → the whole entry is a
bare key, auto-named) and `=sk-a` (empty name slot after `=` → treated as a
bare key). Individual keys inside the single credential value are not
independently redacted in the credentials UI (an accepted consequence of the
v2 single-value grammar).

In **Settings → Plugins** the `OPENROUTER_API_KEY` row is a small table: one name + key
pair per row, up to 12. Set serialises the rows into the grammar above. Because stored
credentials are never read back, **Set replaces the whole list** — enter every key you
want to keep.

### Name precedence

Each key's display name is resolved in order:

1. **Operator name** from the list (e.g. `Work` in `Work=sk-or-v1-…`) — wins always.
2. **OpenRouter dashboard label** from `GET /api/v1/key` — unless it looks like a
   masked key prefix (`SK-OR-V1-EEC…E6B`), which is demoted.
3. **`Key N`** (1-based index in the list).

### Env-file quoting

The list value contains `=` and `,`. Quote it in your env file:

```
OPENROUTER_API_KEY="Work=sk-or-v1-…,Personal=sk-or-v1-…"
```

One Set/Clear row in the Plugins UI holds the whole list.

### Migration from v1 (four separate key slots)

- **Your current single key needs no action.** It parses as a one-entry bare list.
- To add keys, replace the value with a comma-separated list as shown above.
- **If you ever set `OPENROUTER_API_KEY_2`/`_3`/`_4`**, Clear them in
  Settings → Plugins BEFORE deploying this version. Once the manifest stops
  declaring a key, its vault row becomes unreachable (harmless dead ciphertext,
  but no longer clearable from the UI).
- **If `OPENROUTER_API_KEY_2`..`_4` are in an env file, delete those lines.**
  Boot-capture only scrubs *declared* credential keys from `process.env`; an
  undeclared `OPENROUTER_API_KEY_2` would stay in the environment and be
  inherited by every agent child process.
- Manifest changed → **server restart required** (plugins are scanned at boot).

## What the card shows

- An **Account** section (when the first key is a management key) showing
  the **prepaid balance** ($X.XX). The historic all-time usage bar and credits
  fraction are omitted because cumulative lifetime figures are not useful for
  day-to-day balance tracking. A 403 on `/api/v1/credits` just hides the Account
  section — not a bug.
- One section per configured key — credits used / spend cap and
  usage bar. Per-key sections show **used of cap** (`key credits used`).
- Keys without a spend cap show `— no spend cap` in their label.
- Errored keys degrade to a label-only row; the other keys still render normally.
- Plan badge (`paid` / `free tier`) from the first healthy key.

## Vault prerequisite

The Plugin Vault requires a ≥32-byte `SESSION_SECRET` (or `TIERWYN_PLUGIN_VAULT_KEY`).
Without it, Settings → Plugins shows "Vault unavailable" and keys must go in the env file.

## Manifest

- Version: `2.0.1`
- Capability: `usage.get` (`agentCallable: true`, 10 req/min)
- Credentials: `OPENROUTER_API_KEY` (required) — single key or comma-separated list
- Egress: `https://openrouter.ai` only
- `matchAgent`: defaults to `^openrouter$` (no adapter matches — widen only if an agent bills to OpenRouter)

## After install / env file key change

A restart is needed when the plugin is **newly added**, when the **manifest changes**
(e.g. upgrading from v1 to v2), or when keys are set in the environment file
(`.env` / `/etc/tierwyn/prod.env`): `npm run dev:server` for dev, or
`npm run deploy:prod:full` / `systemctl --user restart tierwyn-prod` for prod.

Keys set via the **Plugin Vault** (Settings → Plugins → Set) take effect
immediately — no restart required.

Then: Settings → Agent Usage → **Providers** should show an **OpenRouter** card
with a `plugin` badge and one section per key.
