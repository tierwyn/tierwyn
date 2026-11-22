# Model Discovery & Adding Models

Two questions, one doc:

1. **Operator / user:** "I have a new model; how do I get it into the Tierwyn
   picker?" → read the [Quick guide](#quick-guide-getting-a-new-model-into-the-picker).
2. **Developer:** "How does `listModels()` populate `agent_models`, and what
   can the catalogue API/UI persist?" → read the
   [Developer reference](#developer-reference) below.

---

## Quick guide: getting a new model into the picker

### Where picker models come from (three provenances)

Every row in the model picker has exactly one `source`:

| `source` | Meaning | Created by | Removed when |
|---|---|---|---|
| `discovered` | The agent's own CLI reported it | Automatic discovery | The CLI stops reporting it |
| `seed` | Tierwyn's static list (`apps/server/agent-profiles.json`) | Server boot | Removed from the JSON + restart |
| `user` | You typed it into Tierwyn's **Add model** form | You | Only if you delete it in Tierwyn |

### Per-agent cheat sheet

Discovery runs **at server boot**, **every 12 hours**, and **on demand** via
Settings → Agents → *agent* → **Pull models** (`POST /api/agents/:id/pull-models`).

| Agent | Models come from | New upstream models appear… | If it's missing from the picker |
|---|---|---|---|
| **pi** | `pi --list-models` CLI output | Automatically at next discovery | **Pull models** (or wait ≤ 12 h / restart server) |
| **antigravity** | `agy models` CLI output | Same | Same |
| **opencode** | `opencode models` CLI output (JSON) | Same | Same |
| **cursor** | `cursor models` CLI output | Same | Same |
| **openclaw** | `openclaw models list --json` (static seed rows are the cold-start fallback if the CLI is missing/slow) | Same | Same |
| **grok-build** | `~/.grok/models_cache.json` read from disk (no spawn; static seed rows as fallback) | When the grok CLI refreshes that cache, then at next discovery | Run the grok CLI so its cache updates, then **Pull models** |
| **kiro** | `kiro-cli chat --list-models --format json` (cached at `data/kiro-models.json`, 12h TTL; static seed rows as fallback) | Automatically at next discovery | **Pull models** (or wait ≤ 12 h / restart server) |
| **qwen** | ACP `session/new` → `models.availableModels` (cached at `data/qwen-models.json`, 12h TTL; static seed row as fallback) | Automatically at next discovery | Same |
| **kimi** | ACP `session/new` → `models.availableModels` (cached at `data/kimi-models.json`, 12h TTL; static seed rows as fallback) | Automatically at next discovery | Same |
| **claude-code** | `~/.claude/cache/model-catalog/*-cc.json` (no spawn), then an overlay from user `settings.json` + `/etc/claude-code/managed-settings.json` (`availableModels` filter, `modelPicker` extras). Absent keys leave the catalogue unchanged. Seed rows in `agent-profiles.json` stay as the curated cold-start set | When the CLI refreshes its catalogue or settings change, then at next discovery | Run `claude` once, then **Pull models** |
| **codex** | Static list | Never automatically | Same |
| **hermes** | Static list (no machine-readable model list at all) | Never automatically | Same |
| **copilot** | Static list in `apps/server/agent-profiles.json` (no `copilot models list` command) | Never automatically | Same |

### Two different "add a model" actions: don't mix them up

This is the single most common confusion (it's why a model you added "under the
pi agent" didn't show up):

- **Adding a model in the agent's own settings** (e.g. Pi's settings, which
  writes `~/.pi/agent/models-store.json`) updates the *agent CLI's* config
  only. Tierwyn never watches those files and is never notified. It learns
  about the model only when it re-runs the CLI at the next discovery cycle:
  so click **Pull models**, wait for the 12 h tick, or restart the server.
- **Adding a model in Tierwyn** (Settings → Agents → *agent* → **Add model**)
  writes a `source='user'` row in Tierwyn's own database. The agent CLI
  doesn't learn anything from this; the model ID you type must already be
  resolvable by the CLI at spawn time. `user` rows survive every discovery
  and seed cycle.

Rule of thumb: **configure the CLI for real models, configure Tierwyn for
aliases/curation.** If the CLI already knows the model, never use Add model:
just Pull models.

### Gotchas

1. **Open tabs are not pushed.** The SPA fetches `/profiles` once on connect.
   Background discovery (boot tick, 12 h timer) reloads only the server's
   in-memory catalogue; there is no websocket broadcast. If discovery picked
   up a model while your tab was open, hard-refresh the page. A **Pull
   models** click inside the settings drawer does refresh that tab's picker
   (the drawer re-fetches and notifies the app).
2. **Deleting a discovered model is temporary.** If the CLI still reports it,
   the next cycle re-adds it. To hide a model, toggle it **off**
   (`enabled_flag=0`) instead; toggles survive discovery cycles.
3. **Static agents overwrite in-DB edits at boot.** For
   codex, hermes, copilot the JSON file is the source of truth; any CRUD
   edit to those rows is re-upserted from JSON on next restart. Edit the file.
   claude-code seed rows are still JSON-driven; catalogue-only models land as `source='discovered'`.
4. **Bare labels get prefixed.** The Add-model form prefixes a bare label
   with `Agent · ` so `ModelSelector` parsing stays unambiguous.
5. **A failed CLI run never wipes the catalogue.** Empty `listModels()` output
   is treated as "unknown", not "zero models"; guarded in both the scheduler
   and `upsertDiscoveredModels`.
### Worked example: a new model lands in the Pi CLI

1. Pi ships a new model; you also add it manually in Pi's own settings.
2. Nothing happens in Tierwyn: `models-store.json` is Pi's business.
3. Within 12 h (or after a server restart) discovery runs
   `pi --list-models`, parses the table, and upserts `pi:zai/<model>` as
   `source='discovered'`.
4. Impatient? Settings → Agents → pi → **Pull models** does it immediately.
5. Still not visible in an already-open tab? Hard-refresh; see gotcha 1.

## Developer reference

### Discovery lifecycle

```
server boot
 ├─ seedCatalogue(db)                     # upsert/prune source='seed' from agent-profiles.json
 └─ startModelDiscoveryScheduler(db, …)   # apps/server/src/scheduler.ts
     ├─ tick() at boot, then every DISCOVERY_INTERVAL_MS (12 h)
     │   └─ per adapter: listModels() → upsertDiscoveredModels() → source='discovered'
     │       └─ onRefreshed → catalogue.load(db)   # in-memory catalogue only; no WS push
     └─ manual: POST /api/agents/:id/pull-models (FR-26.1)  # same upsert path, on demand
```

Key properties of `upsertDiscoveredModels` (`apps/server/src/repositories/models.ts`):

- **Empty list is a no-op**: a transient CLI failure can't wipe a catalogue.
- `ON CONFLICT` refreshes label/provider/flags but **preserves
  `enabled_flag`**; user toggles survive discovery cycles.
- `context_window` uses `COALESCE(excluded.context_window, …)` (FW-7): a
  number refreshes, a missing value keeps the last known window, so one flaky
  tick can't regress a known 1M context to NULL.
- Pruning deletes only **unreferenced** `discovered` rows; sessions/events
  FK-reference `agent_models` without `ON DELETE CASCADE`, and a hard delete
  of a still-referenced row used to roll back the whole discovery cycle.

### Discovery behaviour by adapter

| Agent | `listModels()` source | Dynamic? | `source` value in DB |
|---|---|---|---|
| **pi** | `pi --list-models` subprocess; text table parsed in `apps/server/src/adapters/pi/index.ts` | Yes | `discovered` |
| **antigravity** | `agy models` subprocess; plain text parsed in `apps/server/src/adapters/antigravity/index.ts` | Yes | `discovered` |
| **opencode** | `opencode models` subprocess: JSON parsed in `apps/server/src/adapters/opencode/index.ts` | Yes | `discovered` |
| **cursor** | `cursor models` subprocess; parsed in `apps/server/src/adapters/cursor/index.ts` | Yes | `discovered` |
| **openclaw** | `openclaw models list --json` subprocess: JSON in `apps/server/src/adapters/openclaw/index.ts`; on CLI failure returns `[]` so seed rows keep covering the UI | Yes | `discovered` |
| **grok-build** | `~/.grok/models_cache.json` (on-disk read, no spawn); seed rows as cold-start fallback | Yes | `discovered` |
| **kiro** | `kiro-cli chat --list-models --format json` subprocess: JSON in `apps/server/src/adapters/kiro/models.ts`; disk cache `data/kiro-models.json` (12h TTL); seed rows as cold-start fallback | Yes | `discovered` |
| **qwen** | ACP `session/new` probe → `models.availableModels`: `apps/server/src/adapters/qwen/models.ts`; disk cache `data/qwen-models.json` (12h TTL); seed row as cold-start fallback | Yes | `discovered` |
| **kimi** | ACP `session/new` probe → `models.availableModels`: `apps/server/src/adapters/kimi/models.ts`; disk cache `data/kimi-models.json` (12h TTL); seed rows as cold-start fallback | Yes | `discovered` |
| **claude-code** | `adapters/claude-code/modelCatalog.ts` (`~/.claude/cache/model-catalog/*-cc.json`, no spawn) | Yes | `discovered` for new names; existing `seed`/`user` rows keep their source on conflict |
| **codex** | Same file, `agentType==='codex'` | No; file-driven | `seed` |
| **hermes** | Returns `[]`; no machine-readable model list exists; all rows come from the seed file | No; file-driven | `seed` |

**Summary:** pi, antigravity, opencode, cursor, openclaw, grok-build, kiro,
qwen, kimi, and claude-code reflect whatever their CLIs (or on-disk
catalogues) report at discovery time; stale `discovered`
rows are pruned each cycle.
codex and hermes are served from `agent-profiles.json` every boot: the file is the source of truth, and `seedCatalogue` upserts/prunes to match it.

### Editing static lists (codex, hermes)

Edit `apps/server/agent-profiles.json` and restart the server; no code
change, no rebuild required.

| Edit | Effect on next boot |
|---|---|
| **Add a profile** to the JSON `profiles` array (with the right `agentType`) | Inserted into `agent_models` with `source='seed'`, all flags from JSON applied |
| **Remove a profile** from the JSON array | Existing `source='seed'` row is pruned |
| **Flip `"enabled": false`** on a profile | Row stays; `enabled_flag` flips to 0 (model hidden from picker) |
| **Edit `label` / `description` / `vision` / `steer`** | Existing row updated in place; flags overwritten from JSON |
| **Add `"contextWindow": 1000000`** | Carried through to `ModelDescriptor.contextWindow` for the UI |

Safety: if the JSON is missing, unparseable, or has an empty `profiles`
array, `seedCatalogue` throws at boot and refuses to prune; a malformed file
can never wipe the catalogue.

What is NOT touched by `seedCatalogue`:

- `source='user'` rows (Phase 5 CRUD)
- `source='discovered'` rows (dynamic adapters)

### What you CAN edit via the catalogue API/UI

`POST/PATCH/DELETE /api/agents/:id/models` (Phase 5 CRUD):

- **Add custom models** → stored as `source='user'`, never pruned by either
  the seed-prune or the discovery-prune path.
- **Toggle `enabled_flag` / `vision_flag` / `steer_flag`** on any row:
  preserved across discovery cycles *for dynamic adapters*. For static
  adapters, the next boot overwrites them from JSON; edit the JSON instead.

### What you CANNOT edit without restarting the server

- **Delete or rename seed entries via CRUD**: `seedCatalogue` re-upserts
  them from JSON on every boot, overwriting any in-DB edit. Edit the JSON.
- **Persist a `label` / `provider` override on seed rows**: `ON CONFLICT DO
  UPDATE` overwrites your change every boot. Edit the JSON.
- **Persist a CRUD-toggle on seed `enabled_flag`**: same reason; JSON wins.

For dynamic adapters the catalogue follows whatever the CLI reports. If you
`deleteModel()` a discovered row it stays gone only until the next discovery
cycle re-adds it (if the CLI still reports it). If you `createModel()` a
custom one, it survives as `source='user'`.

### Why some adapters are file-driven (not CLI-driven)

- **claude-code**: No `claude models` command exists (2.1.286); the CLI's own catalogue cache is read instead. `Query.supportedModels()` would need a live session. Optional overlay: `availableModels` / `modelPicker` in `~/.claude/settings.json` (and managed `/etc/claude-code/`); this host has none, so the picker matches the catalogue.
- **codex**: model list is managed server-side; entries are curated in the
  seed file.
- **hermes**: no machine-readable model list at all; `listModels()` returns
  `[]` by design.

### The `source` discriminator

`agent_models.source` distinguishes three
provenances:

| Value | Meaning | Created by | Pruned by discovery? | Pruned by seedCatalogue? |
|---|---|---|---|---|
| `seed` | Driven by `agent-profiles.json` | `seedCatalogue()` | No | Yes (if not in current JSON) |
| `discovered` | Reported by the adapter's `listModels()` | `upsertDiscoveredModels()` | Yes (if not in current list) | No |
| `user` | Created via Phase 5 CRUD | `createModel()` | No | No |
