# Plugin Authoring Guide

Authoring and reference guide for developing, packaging, and operating Tierwyn plugins. See also the architectural overview in [Plugins Architecture](plugins.md).

Tierwyn plugins allow operators to add custom capabilities, integrations, and usage telemetry without modifying the core server. Plugins run inside the Node.js server process and expose typed capability surfaces to agents and operators.

---

## 1. What a plugin is

A plugin is an ESM package directory. First-party **source** lives in `plugin-src/<id>/`; the runtime scan dir is gitignored `plugins/<id>/` after import. Live-dev against source with `TIERWYN_PLUGINS_DIR=./plugin-src`. Ship archives with `npm run package:plugins`. Each plugin directory contains:

- `plugin.json`; plugin manifest (metadata, capabilities, required credentials, permissions).
- `index.js`: ESM entrypoint with a default export implementing `activate(ctx)` and optional `deactivate()`.
- `package.json`; must include `{"type": "module"}`.
- `HELP.md` (optional); agent-facing documentation explaining parameters, capabilities, and usage examples.

### Full Trust Model

Plugins execute **directly inside the Tierwyn server process**.
Importing a plugin executes code under the same user UID and system privileges as the server itself. While `PluginContext` provides safety boundaries for HTTP fetch and secrets handling, Node.js does not provide an isolated JavaScript sandbox. Only install plugins from trusted sources. For this reason, plugin installation, importation, credential management, and deletion are strictly restricted to the authenticated human operator.

---

## 2. Manifest reference (`plugin.json`)

The manifest defines the plugin identity and registers its surfaces with the server.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "capabilities": [
    {
      "name": "example.action",
      "summary": "Performs an example action",
      "agentCallable": true,
      "timeoutMs": 15000,
      "rateLimitPerMin": 30
    }
  ],
  "credentials": [
    {
      "key": "MY_PLUGIN_API_KEY",
      "required": true
    }
  ],
  "permissions": [
    "outbound:https://api.example.com"
  ]
}
```

### Manifest Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Plugin identifier. Must match `^[a-z][a-z0-9-]{1,48}$`. |
| `apiVersion` | `number` | Yes | Must be integer `1`. |
| `name` | `string` | Yes | Human-readable plugin name. |
| `version` | `string` | Yes | Semantic version string (e.g. `"1.0.0"`). |
| `capabilities` | `PluginCapability[]` | Yes | List of capabilities provided by the plugin. |
| `credentials` | `PluginCredentialDeclaration[]` | No | List of secrets used by the plugin. |
| `permissions` | `string[]` | No | Permissions requested by the plugin (e.g. `["outbound:https://example.com"]`). |

### Capability Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Capability name. Must match `^[a-z][a-z0-9.]*$`. |
| `summary` | `string` | Yes | Human/agent-readable summary of what the capability does. |
| `agentCallable` | `boolean` | Yes | If `true`, callable by agents with valid capability tokens. If `false`, operator-only. |
| `timeoutMs` | `number` | No | Execution timeout in milliseconds (1 to 300,000 ms). Default: 15,000 ms. |
| `rateLimitPerMin`| `number` | No | Maximum invocations per minute per caller. Default: 30. |
| `usageProvider` | `UsageProviderDecl` | No | Exposes usage telemetry to Settings and `GET /agent/usage`. Fields: `label` (string, required), `section` (string, optional, defaults to `'providers'`), `matchAgent` (string, optional), `matchModel` (string, optional). |

### Credential Declarations

Each entry in `credentials` declares a secret key:

- `key`: Must match `^[A-Z][A-Z0-9_]+$`.
- Blocklisted keys are rejected: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TMPDIR`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, or keys prefixed with `LC_`, `XDG_`, `TIERWYN_`.
- `required` (boolean, optional): Indicates whether the credential must be configured for the plugin to be considered configured.

### Permissions

- `outbound`: Format string `"outbound:<origin>"` (e.g. `"outbound:https://example.com"`). Defines allowlisted network origins accessible via `ctx.http.fetch`.

---

## 3. The `PluginContext` Facade

When activated, your plugin's `activate(ctx)` function receives a `PluginContext` instance:

```ts
export default {
  activate(ctx) {
    ctx.capability('example.action', async (input, caller) => {
      ctx.log.info(`Called by ${caller.kind}`);
      return { result: 'ok' };
    });
  }
};
```

### Context Methods

- `ctx.capability(name, handler)`: Registers a handler function `async (input: unknown, caller: PluginCaller) => unknown`.
- `ctx.http.fetch(url, init?)`: Performs an outbound HTTP request. The URL's origin must match an origin declared in `permissions` (`outbound:<origin>`). Protected by a global outbound rate limiter (60 requests/minute).
- `ctx.credentials.get(key)`: Retrieves a secret value. Checks the encrypted vault first, then falls back to boot-captured environment variables.
- `ctx.credentials.source(key)`: Returns `'vault'`, `'env'`, or `undefined`.
- `ctx.settings.get()` / `ctx.settings.set(val)`: Reads or writes persistent settings for this plugin stored in the Tierwyn database under the `plugin:<id>` key.
- `ctx.operatorRoute(method, path, handler)`: Registers an Express route at `/plugins/<id>/<path>` (GET or POST only). Automatically authenticated via operator session cookies.
- `ctx.onDeactivate(cleanupFn)`: Registers a cleanup callback invoked when the plugin is unloaded or deleted.
- `ctx.log`: Logger methods (`log.info`, `log.warn`, `log.error`).

### Agent Help (`HELP.md`)

Plugins may include a `HELP.md` file in their root directory (maximum size: 64 KiB, regular files only).
The contents are served to agents over loopback at `GET /agent/plugins/<id>/help`. Use this file to provide agents with detailed parameter documentation, valid inputs, constraints, and operational advice.

---

## 4. Lifecycle

1. **Boot Scan**: The server scans `plugins/*/plugin.json` synchronously before any agent can spawn. Credential keys from all plugins (even disabled ones) are scrubbed from child process environments.
2. **Activation**: Enabled plugins have their `index.js` dynamically imported and `activate(ctx)` is called. If `activate` throws an error, the error is logged, the plugin is marked disabled for that boot, and the server process continues normally.
3. **Deactivation & Teardown**: When the server shuts down, or when a plugin is deleted via `DELETE /plugins/:id`, all registered `deactivate()` functions and `ctx.onDeactivate` callbacks are executed to release timers, sockets, and event listeners.
4. **Enable/Disable**: Toggling a plugin with `PATCH /plugins/:id { "enabled": boolean }` flips an operational flag in the database settings. It does not unload the module from memory or re-execute `activate()`.

---

## 5. Rate limits & Timeouts

| Scope | Limit / Default | Behavior on Exceeded |
|---|---|---|
| Per-caller capability | `rateLimitPerMin` (default 30/min) | Returns `429 rate_limited` with `Retry-After` header. |
| Global per-plugin | 120 invocations / min | Returns `429 rate_limited`. |
| Global outbound HTTP | 60 requests / min via `ctx.http.fetch` | Throws rate limit error. |
| Capability execution timeout | `timeoutMs` (default 15,000 ms, max 300,000 ms) | Returns `504 timeout`. |

---

## 6. Error Contract

Capability handlers return results directly or throw errors. Responses conform to `PluginEnvelope<T>`:

- Success: `{ "ok": true, "data": ... }`
- Failure: `{ "ok": false, "error": string, "code": PluginErrorCode, "retryable": boolean, "retryAfter"?: number }`

### Error Code Mapping

| Error Code | HTTP Status | Retryable | Description |
|---|---|---|---|
| `unknown_plugin` | 404 | No | Plugin not found or disabled. |
| `unknown_capability` | 404 | No | Capability name not registered on this plugin. |
| `not_agent_callable` | 403 | No | Capability is marked `agentCallable: false`. |
| `not_in_profile` | 403 | No | Calling conversation's capability profile does not grant access. |
| `rate_limited` | 429 | Yes | Rate limit reached; wait for `retryAfter` seconds. |
| `credential_missing` | 503 | No | Required API key or secret has not been configured. |
| `upstream_error` | 502 | Yes | External service or plugin handler threw an unhandled error. |
| `timeout` | 504 | Yes | Handler exceeded configured `timeoutMs`. |
| `bad_input` | 400 | No | Input payload failed validation. |

Secrets with length ≥ 8 characters are automatically redacted from error messages and return envelopes before reaching the caller or logs.

---

## 7. Security Boundaries & Constraints

Plugins are designed to protect credentials from untrusted agents:

- **No Agent Route Exposure**: Plugins cannot define arbitrary top-level routes. Operator routes live strictly under `/plugins/<id>/`.
- **Credential Protection**: Agent callers never receive credential values. They only call capabilities that use credentials internally.
- **Child Process Isolation**: Plugin secrets are scrubbed from the environment (`process.env`) of spawned agent CLI processes.
- **Outbound Isolation**: Outbound requests made via `ctx.http.fetch` are constrained to declared origins. (Note: because plugins execute directly in Node.js, this is an API contract, not an OS sandbox).

---

## 8. Packaging, Import, and Deletion

### Creating an Archive

Plugins are distributed as `.tar.gz` (or `.tgz`) archives:

```bash
# First-party plugins: build all archives from plugin-src/ into plugin-archives/
npm run package:plugins

# Ad-hoc package of one directory (runtime or source tree)
tar -czf my-plugin.tar.gz -C ./plugin-src my-plugin
```

Archive requirements:
- Maximum upload size: **10 MiB**.
- Maximum extracted size: **50 MiB** across at most **2,000 files**.
- Format: Regular files and directories only. Symbolic links, hard links, FIFOs, and paths containing `..` or absolute paths are strictly rejected.
- Layout: `plugin.json` and `index.js` must either reside at the archive root or within a single top-level directory.

### Importing (`POST /plugins`)

- Endpoint: `POST /plugins` (multipart form field `archive`). Authenticated via operator cookie (Bearer authorization is rejected with `403 Forbidden`).
- If plugin loading is disabled (`TIERWYN_PLUGINS=off`), mutation requests are rejected with `409 Conflict`.
- Only one import or delete mutation may run at a time; concurrent attempts receive `409 Conflict`.
- The archive is extracted safely into a staging folder and inspected.
- If a plugin with the same ID already exists on disk or in the registry, the server responds with `409 Conflict`. To upgrade, delete the existing plugin first.
- The plugin is placed into `plugins/<id>`, validated, and immediately activated with cache-busting query parameter (`?v=<timestamp>`) on `index.js`.
  - **Module Cache Ceiling (D3)**: Only `index.js` receives the cache-busting query parameter. Sibling files imported by `index.js` resolve without the query parameter and remain cached in Node's ESM loader. A multi-file plugin re-imported under the same ID requires a server restart to refresh internal helper modules.
- If `activate()` fails or times out (default 30,000 ms), the installation is rolled back: files are deleted and registry entries are purged. The endpoint returns `422 Unprocessable Entity`. Note that any environment credentials captured from `process.env` during import stay captured in the server-level credential set (D4).

### Deletion (`DELETE /plugins/:id`)

- Endpoint: `DELETE /plugins/:id`. Authenticated via operator cookie (Bearer authorization is rejected with `403 Forbidden`).
- If plugin loading is disabled (`TIERWYN_PLUGINS=off`), delete requests are rejected with `409 Conflict`.
- Invokes all registered deactivation handlers.
- Removes the plugin from the active host registry and removes the directory from disk. (If the directory was a symbolic link, only the link is unlinked; the target remains untouched).
- Purges all stored vault credentials (`plugin_secrets`), invocation history (`plugin_invocations`), and custom settings (`plugin:<id>`).
- Clears the plugin ID from `plugins.disabled` in the settings table.
- **In-flight Invocations (D7)**: An invocation already executing when deletion begins will complete and may record one final audit row in `plugin_invocations` after the deletion transaction completes.

---

## 9. Minimal Example

### `plugin.json`

```json
{
  "id": "echo-plugin",
  "name": "Echo Plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "capabilities": [
    {
      "name": "echo",
      "summary": "Echoes back the provided input",
      "agentCallable": true
    }
  ]
}
```

### `index.js`

```javascript
export default {
  activate(ctx) {
    ctx.capability('echo', async (input, caller) => {
      ctx.log.info(`Echo called by ${caller.kind}`);
      return { echo: input };
    });
  },
  deactivate() {
    console.log('Echo plugin deactivated');
  }
};
```
