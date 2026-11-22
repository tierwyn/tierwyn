import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'fs';
import { basename, dirname, join, normalize, resolve } from 'path';
import { realpath, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import multer from 'multer';
import type { Express, Request, Response, RequestHandler } from 'express';
import express from 'express';
import type { Database } from 'better-sqlite3';
import type { PluginCaller, PluginErrorCode, PluginsResponse, ResolvedCapabilityProfile, UnifiedUsageBody } from '@tierwyn/shared';
import { isCredentialKeyAllowed, profileAllowsCapability, profileAllowsUsage } from '@tierwyn/shared';
import { peekSpawnToken } from '../spawn/tokens.js';
import { filterAgentPlugins } from '../spawn/preamble.js';
import { PluginHost, MinuteBucket, PLUGIN_ERROR_HTTP_STATUS, PLUGIN_ERROR_RETRYABLE, MIN_SECRET_LEN } from '../plugins/host.js';
import type { UsageTargetResult } from './agentUsage.js';
import { setPluginDisabled, deletePluginSettings } from '../repositories/settings.js';
import {
  vaultAvailable,
  vaultUnavailableReason,
  vaultSet,
  vaultClear,
  vaultPurgePlugin,
} from '../plugins/vault.js';
import { listInvocations, purgeInvocations } from '../plugins/invocations.js';
import {
  pluginsDir,
  readPluginDir,
  activatePlugin,
  isPluginId,
} from '../plugins/loader.js';
import { setPluginScrubKeys } from '../childEnv.js';
import { envPref } from '../config/env.js';
import { ARTIFACT_NAME_RE } from '../node/artifactStore.js';
import { invokeForRemote, pushFile, strictlyInside } from '../node/artifacts.js';
import type { NodeLink } from '../node/proxyAdapter.js';

const execFileAsync = promisify(execFile);

export { PLUGIN_ERROR_HTTP_STATUS };
export const MAX_CREDENTIAL_LEN = 4096;
export const AGENT_USAGE_PER_MIN = 6;

export const MAX_PLUGIN_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MAX_PLUGIN_EXTRACTED_BYTES = 50 * 1024 * 1024;
export const DELIVER_PER_MIN = 10;

/** Per-conversation sliding window for POST /agent/artifacts/deliver. */
const deliverBuckets = new Map<string, MinuteBucket>();

function consumeDeliverBucket(res: Response, conversationId: string): boolean {
  let bucket = deliverBuckets.get(conversationId);
  if (!bucket) {
    bucket = new MinuteBucket(DELIVER_PER_MIN, Date.now);
    deliverBuckets.set(conversationId, bucket);
  }
  const hit = bucket.try();
  if (!hit.ok) {
    res.setHeader('Retry-After', String(hit.retryAfter));
    res.status(429).json({ error: 'rate_limited', retryAfter: hit.retryAfter });
    return false;
  }
  return true;
}
export const MAX_PLUGIN_FILES = 2000;
export const TAR_TIMEOUT_MS = 30_000;
export const TAR_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const ACTIVATE_TIMEOUT_MS = 30_000;

let pluginMutationBusy = false;

function rejectBearer(req: Request, res: Response): boolean {
  const auth = req.headers.authorization;
  if (auth && /^bearer\s+/i.test(auth)) {
    res.status(403).json({ error: 'operator only' });
    return true;
  }
  return false;
}

interface AgentDeps {
  host: PluginHost;
  isAuthed: (req: Request) => boolean;
  /** Wired by index.ts; when absent `GET /agent/usage` answers 404. */
  getUsage?: (caller: PluginCaller) => Promise<UnifiedUsageBody>;
  /** Wired by index.ts; when absent `GET /agent/usage/:target` answers 404. */
  getUsageTarget?: (target: string, caller: PluginCaller) => Promise<UsageTargetResult>;
  /** Wired by index.ts; with `hubArtifactsRoot`, agent capability calls on a
   *  tunnelled remote-host conversation stage/push artifacts hub↔node. */
  nodeLink?: (hostId: string) => NodeLink;
  /** Hub artifacts root, `resolve(dataDir, 'artifacts')`. */
  hubArtifactsRoot?: string;
  /** Injected clock for tests. */
  now?: () => number;
}

interface OperatorDeps {
  host: PluginHost;
  getDb: () => Database;
  activateTimeoutMs?: number;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

export function isLoopback(req: Request): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Any plugin-capable Tierwyn session bearer wins over a cookie (F13). */
export function resolvePluginCaller(req: Request, isAuthed: (req: Request) => boolean): PluginCaller | null {
  const entry = peekSpawnToken(bearerToken(req));
  if (entry && entry.scope.has('plugin')) {
    return {
      kind: 'agent',
      conversationId: entry.conversationId,
      sessionId: entry.sessionId,
    };
  }
  if (isAuthed(req)) return { kind: 'operator' };
  return null;
}

/** resolvePluginCaller + the token's capability-profile grant. Agents carry the
 *  profile snapshotted at mint time; operators (cookie) are never restricted —
 *  `profile` stays undefined for them. */
export function resolvePluginAuth(
  req: Request,
  isAuthed: (req: Request) => boolean,
): { caller: PluginCaller; profile?: ResolvedCapabilityProfile } | null {
  const entry = peekSpawnToken(bearerToken(req));
  if (entry && entry.scope.has('plugin')) {
    return {
      caller: {
        kind: 'agent',
        conversationId: entry.conversationId,
        sessionId: entry.sessionId,
      },
      profile: entry.capProfile,
    };
  }
  if (isAuthed(req)) return { caller: { kind: 'operator' } };
  return null;
}

const HELP_MD = `# Agent plugin capabilities

## Purpose

Call server-held plugin capabilities **without ever seeing the plugin's credentials**.
Any Tierwyn session Bearer token (the one in your preamble) authenticates you — every
conversation that mints a token gets \`plugin\` scope, spawn-scoped or not. Operator
cookies also work; a valid Bearer wins over a cookie.

Your token carries your conversation's **capability profile** — \`GET /agent/plugins\`
lists exactly what it grants. Calls outside that grant answer \`403 not_in_profile\`
(not 404: do not probe for existence) and are never retried; ask the operator to
change the conversation's profile instead.

Do not GET this document unless you are about to call a capability or \`GET /agent/usage\`.

## Endpoints

\`GET /agent/plugins\` — list plugins and their **agent-callable** capabilities.

\`GET /agent/plugins/:id/help\` — detailed parameter docs for one plugin (models, limits,
examples). Present when the plugin's entry in \`GET /agent/plugins\` carries a \`help\` path.
**Read it before first calling a capability on that plugin.**

\`GET /agent/usage\` — unified usage telemetry (built-in agent quotas + plugin
providers). See "Usage telemetry" below.

\`GET /agent/usage/:target\` — one telemetry card only: a built-in agent type
(e.g. \`claude-code\`) or a provider plugin id (e.g. \`zai-usage\`).

\`POST /agent/plugins/:id/capabilities/:name\` — invoke. Body is JSON input (may be \`{}\`).
Response: \`{ ok: true, data }\` or \`{ ok: false, error, code, retryable, retryAfter? }\`.

## Usage telemetry

\`GET /agent/usage\` — every telemetry card in one call (built-in agents + plugin
providers). Use before spawning to skip a profile whose window is exhausted
(e.g. \`fiveHourPct >= 95\`). Same Bearer as above.

Response: \`{ builtins: [...], providers: [...], updatedAt, agents }\`
(200 OK unless the route is unwired). \`agents\` is a deprecated alias of
\`builtins\` kept for older consumers.

Each builtin entry:
\`{ agentType, label, installed, subscriptionType?, updatedAt?, groups[], error? }\`
— \`claude-code\` = Claude Code, \`codex\`, \`antigravity\`, \`grok-build\`, \`kiro\`.
\`installed:false\` = not found on this host — skip its group (nothing is probed).
Each group may carry \`fiveHourPct\`/\`fiveHourResetsAt\`, \`sevenDayPct\`/\`sevenDayResetsAt\`,
\`monthlyPct\`/\`monthlyResetsAt\`, credits fields. Missing fields = the probe did not report them.
\`groups: []\` with no \`error\` = no data; with \`error\` = probe failed (treat as unknown, not exhausted).

\`providers\` — one card per active usage plugin (Z.AI, Cursor, Kilo, OpenRouter):
\`{ id, label, configured, ok, data?, error?, code?, fetchedAt }\`.
\`ok:false\` cards carry \`code\` \`not_configured\` (operator has not set the dedicated
key) or the invoke failure — treat as unknown, not exhausted. A provider that
answers slowly shows \`code:"timeout"\`; the aggregate never blocks more than
~5 s per provider.

\`GET /agent/usage/:target\` — one card only: \`200 { builtin }\` for a built-in
agent type, \`{ provider }\` for a provider id (failure codes map to their HTTP
status), or \`404 { error:"unknown usage target", targets:[...] }\`.

Results are cached server-side (~20s builtins, ~30s providers). Limit:
6 calls/min per conversation across both endpoints → 429 with \`retryAfter\`.

## Auth

\`\`\`
curl -s http://127.0.0.1:$TIERWYN_LISTEN_PORT/agent/plugins \\
  -H 'Authorization: Bearer <your spawn token>'

curl -s http://127.0.0.1:$TIERWYN_LISTEN_PORT/agent/usage \\
  -H 'Authorization: Bearer <your spawn token>'

curl -s -X POST http://127.0.0.1:$TIERWYN_LISTEN_PORT/agent/plugins/zai-usage/capabilities/usage.get \\
  -H 'Authorization: Bearer <your spawn token>' \\
  -H 'Content-Type: application/json' \\
  -d '{}'
\`\`\`

Use the token from the current preamble. Client-supplied conversation/session ids in the
body are ignored — attribution comes from the token.

## Error codes

| code | HTTP | retryable | meaning |
|---|---|---|---|
| \`unknown_plugin\` | 404 | no | plugin missing or disabled |
| \`unknown_capability\` | 404 | no | capability name not on that plugin |
| \`not_agent_callable\` | 403 | no | operator-only capability |
| \`not_in_profile\` | 403 | no | this conversation's capability profile doesn't grant the plugin or usage surface |
| \`rate_limited\` | 429 | **yes** | wait \`retryAfter\` seconds |
| \`credential_missing\` | 503 | **no** | operator has not configured the dedicated key (restart after editing env) |
| \`upstream_error\` | 502 | **yes** | plugin or upstream failed |
| \`timeout\` | 504 | **yes** | handler exceeded the capability timeout (15 s default, per-capability \`timeoutMs\`) |
| \`bad_input\` | 400 | no | malformed input |

Do **not** retry \`credential_missing\`, \`unknown_plugin\`, \`unknown_capability\`,
\`not_agent_callable\`, \`not_in_profile\`, or \`bad_input\` — they will not start
working mid-session.
`;

function sendEnvelope(res: Response, envelope: { ok: true; data: unknown } | {
  ok: false; error: string; code: PluginErrorCode; retryable: boolean; retryAfter?: number;
}): void {
  if (envelope.ok) {
    res.status(200).json(envelope);
    return;
  }
  const status = PLUGIN_ERROR_HTTP_STATUS[envelope.code] ?? 500;
  if (envelope.code === 'rate_limited' && envelope.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(envelope.retryAfter));
  }
  res.status(status).json(envelope);
}

function notInProfile(res: Response, what: string): void {
  sendEnvelope(res, {
    ok: false,
    error: `${what} is outside this conversation's capability profile`,
    code: 'not_in_profile',
    retryable: false,
  });
}

/** Capability meta for the shared grant rule. Unknown ids → `{}` so a narrow
 *  profile 403s (no existence oracle) rather than falling through to host 404. */
function capForGrant(host: PluginHost, pluginId: string, capName: string): { usageProvider?: boolean } {
  const cap = host.listForAgent()
    .find((p) => p.id === pluginId)
    ?.capabilities.find((c) => c.name === capName);
  return cap ? { usageProvider: cap.usageProvider } : {};
}

/** Plugin-level grant (help): true if any of the plugin's capabilities pass
 *  `profileAllowsCapability`. Unknown plugins fail closed under a narrow profile. */
function profileAllowsPlugin(host: PluginHost, profile: ResolvedCapabilityProfile, pluginId: string): boolean {
  const listed = host.listForAgent().find((p) => p.id === pluginId);
  if (listed && listed.capabilities.length > 0) {
    return listed.capabilities.some((c) => profileAllowsCapability(profile, pluginId, c));
  }
  return profileAllowsCapability(profile, pluginId);
}

export function registerPluginAgentRoutes(app: Express, deps: AgentDeps): void {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  // Per-caller sliding window shared by GET /usage and GET /usage/:target
  // (ponytail: unbounded map keyed by conversation; evict if it ever grows).
  const usageBuckets = new Map<string, MinuteBucket>();

  /** 401 already handled; consume 1 of the caller's 6/min allowance. */
  function consumeUsageBucket(caller: PluginCaller, res: Response): boolean {
    // Token entries always carry conversationId today. sessionId / 'agent' are
    // unreachable fallbacks; a shared 'agent' key would only throttle those
    // callers against each other (fail closed), never leak quota data.
    const key = caller.kind === 'agent'
      ? `conv:${caller.conversationId ?? caller.sessionId ?? 'agent'}`
      : 'operator';
    let b = usageBuckets.get(key);
    if (!b) {
      b = new MinuteBucket(AGENT_USAGE_PER_MIN, deps.now ?? Date.now);
      usageBuckets.set(key, b);
    }
    const hit = b.try();
    if (!hit.ok) {
      res.setHeader('Retry-After', String(hit.retryAfter));
      res.status(429).json({ error: 'rate_limited', retryAfter: hit.retryAfter });
      return false;
    }
    return true;
  }

  r.get('/usage', async (req, res) => {
    const auth = resolvePluginAuth(req, deps.isAuthed);
    if (!auth) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // Profile gate BEFORE the bucket: a 403 must not consume quota (plan §2.6).
    if (auth.profile && !profileAllowsUsage(auth.profile)) {
      notInProfile(res, 'usage telemetry');
      return;
    }
    if (!deps.getUsage) {
      res.status(404).json({ error: 'not available' });
      return;
    }
    if (!consumeUsageBucket(auth.caller, res)) return;
    try {
      res.json(await deps.getUsage(auth.caller));
    } catch {
      res.status(502).json({ error: 'usage unavailable' });
    }
  });

  r.get('/usage/:target', async (req, res) => {
    const auth = resolvePluginAuth(req, deps.isAuthed);
    if (!auth) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (auth.profile && !profileAllowsUsage(auth.profile)) {
      notInProfile(res, 'usage telemetry');
      return;
    }
    if (!deps.getUsageTarget) {
      res.status(404).json({ error: 'not available' });
      return;
    }
    if (!consumeUsageBucket(auth.caller, res)) return;
    try {
      const out = await deps.getUsageTarget(String(req.params.target), auth.caller);
      res.status(out.status).json(out.body);
    } catch {
      res.status(502).json({ error: 'usage unavailable' });
    }
  });

  r.get('/plugins', (req, res) => {
    const auth = resolvePluginAuth(req, deps.isAuthed);
    if (!auth) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // Filter to the profile grant rather than 403 — the roster is the agent's
    // source of truth for what it may call (plan §2.6).
    res.json({
      plugins: auth.profile
        ? filterAgentPlugins(deps.host.listForAgent(), auth.profile)
        : deps.host.listForAgent(),
    });
  });

  r.get('/plugins/help', (req, res) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'loopback only' });
      return;
    }
    res.type('text/markdown').send(HELP_MD);
  });

  r.get('/plugins/:id/help', (req, res) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'loopback only' });
      return;
    }
    const auth = resolvePluginAuth(req, deps.isAuthed);
    if (!auth) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (auth.profile && !profileAllowsPlugin(deps.host, auth.profile, String(req.params.id))) {
      notInProfile(res, `plugin '${String(req.params.id)}'`);
      return;
    }
    const help = deps.host.helpFor(String(req.params.id));
    if (help.kind === 'unknown') {
      res.status(404).json({ error: 'unknown plugin' });
      return;
    }
    if (help.kind === 'none') {
      res.status(404).json({
        error: 'no help for this plugin',
        hint: 'capability summaries are in GET /agent/plugins; protocol in GET /agent/plugins/help',
      });
      return;
    }
    res.type('text/markdown').send(help.text);
  });

  r.post('/plugins/:id/capabilities/:name', async (req, res) => {
    try {
      const auth = resolvePluginAuth(req, deps.isAuthed);
      if (!auth) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const pluginId = String(req.params.id);
      const name = String(req.params.name);
      // 403 before invoke: never reaches the plugin, never writes an invocation
      // row, never burns the plugin's own rate limit.
      if (auth.profile && !profileAllowsCapability(auth.profile, pluginId, capForGrant(deps.host, pluginId, name))) {
        notInProfile(res, `capability '${pluginId} · ${name}'`);
        return;
      }
      const nodeHostId = res.locals.nodeHostId as string | undefined;
      const conversationId = auth.caller.kind === 'agent' ? auth.caller.conversationId : undefined;
      const envelope = nodeHostId && conversationId && deps.nodeLink && deps.hubArtifactsRoot
        ? await invokeForRemote({
            link: deps.nodeLink(nodeHostId),
            conversationId,
            hubArtifactsRoot: deps.hubArtifactsRoot,
            body: req.body ?? {},
            invoke: (b) => deps.host.invoke(pluginId, name, b, auth.caller),
          })
        : await deps.host.invoke(pluginId, name, req.body ?? {}, auth.caller);
      sendEnvelope(res, envelope);
    } catch {
      // Never echo the underlying error — it may carry hub paths or secrets.
      if (!res.headersSent) {
        res.status(500).json({ ok: false, code: 'upstream_error', retryable: true, error: 'internal error' });
      }
    }
  });

  r.post('/artifacts/deliver', async (req, res) => {
    try {
      const nodeHostId = res.locals.nodeHostId as string | undefined;
      if (!nodeHostId) {
        res.status(404).json({ error: 'not available' });
        return;
      }
      const auth = resolvePluginAuth(req, deps.isAuthed);
      const caller = auth?.caller;
      const conversationId = caller?.kind === 'agent' ? caller.conversationId : undefined;
      if (!auth || caller?.kind !== 'agent' || !conversationId) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (!deps.nodeLink || !deps.hubArtifactsRoot) {
        res.status(404).json({ error: 'not available' });
        return;
      }
      const name = (req.body as { name?: unknown } | undefined)?.name;
      if (typeof name !== 'string' || !ARTIFACT_NAME_RE.test(name)) {
        res.status(400).json({ error: 'bad name' });
        return;
      }
      if (!consumeDeliverBucket(res, conversationId)) return;
      const hubShard = join(normalize(deps.hubArtifactsRoot), conversationId);
      const realShard = await realpath(hubShard).catch(() => null);
      const real = realShard ? await realpath(join(hubShard, name)).catch(() => null) : null;
      const st = real ? await stat(real).catch(() => null) : null;
      if (!realShard || !real || !strictlyInside(realShard, real) || !st || !st.isFile()) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      try {
        const nodePath = await pushFile(deps.nodeLink(nodeHostId), conversationId, real);
        res.status(200).json({ path: nodePath });
      } catch {
        res.status(502).json({ error: 'host_unreachable' });
      }
    } catch {
      if (!res.headersSent) res.status(502).json({ error: 'host_unreachable' });
    }
  });

  app.use('/agent', r);
}

function operatorPayload(host: PluginHost): PluginsResponse {
  const available = vaultAvailable();
  return {
    plugins: host.listForOperator(),
    vault: available
      ? { available: true }
      : { available: false, reason: vaultUnavailableReason() },
  };
}

function resolveDeclaredKey(
  host: PluginHost,
  pluginId: string,
  key: string,
): { ok: true } | { ok: false; status: 404 | 400; error: string } {
  const plugin = host.listForOperator().find((p) => p.id === pluginId);
  if (!plugin) return { ok: false, status: 404, error: 'unknown plugin' };
  const declared = plugin.credentials.some((c) => c.key === key);
  if (!declared || !isCredentialKeyAllowed(key)) {
    return { ok: false, status: 400, error: declared ? 'key is not allowed' : 'key is not declared by this plugin' };
  }
  return { ok: true };
}

export function registerPluginOperatorRoutes(app: Express, deps: OperatorDeps): void {
  app.get('/plugins', (_req, res) => {
    res.json(operatorPayload(deps.host));
  });

  app.patch('/plugins/:id', (req, res) => {
    const id = String(req.params.id);
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' });
      return;
    }
    if (!deps.host.setEnabled(id, enabled)) {
      res.status(404).json({ error: 'unknown plugin' });
      return;
    }
    setPluginDisabled(deps.getDb(), id, !enabled);
    res.json(operatorPayload(deps.host));
  });

  app.put('/plugins/:id/credentials/:key', (req, res) => {
    const id = String(req.params.id);
    const key = String(req.params.key);
    const resolved = resolveDeclaredKey(deps.host, id, key);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const value = req.body?.value;
    if (typeof value !== 'string' || value.length === 0) {
      res.status(400).json({ error: 'value must be a non-empty string' });
      return;
    }
    if (value.length < MIN_SECRET_LEN) {
      res.status(400).json({
        error: `value must be at least ${MIN_SECRET_LEN} characters (redaction floor)`,
      });
      return;
    }
    if (value.length > MAX_CREDENTIAL_LEN) {
      res.status(400).json({
        error: `value must be at most ${MAX_CREDENTIAL_LEN} characters`,
      });
      return;
    }
    if (!vaultAvailable()) {
      res.status(503).json({ error: vaultUnavailableReason() });
      return;
    }
    vaultSet(deps.getDb(), id, key, value);
    console.log(`[plugins] credential set plugin=${id} key=${key}`);
    res.json(operatorPayload(deps.host));
  });

  app.delete('/plugins/:id/credentials/:key', (req, res) => {
    const id = String(req.params.id);
    const key = String(req.params.key);
    const resolved = resolveDeclaredKey(deps.host, id, key);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    if (!vaultAvailable()) {
      res.status(503).json({ error: vaultUnavailableReason() });
      return;
    }
    if (!vaultClear(deps.getDb(), id, key)) {
      res.status(404).json({ error: 'no vault row' });
      return;
    }
    console.log(`[plugins] credential cleared plugin=${id} key=${key}`);
    res.json(operatorPayload(deps.host));
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: tmpdir(),
      filename: (_req, _file, cb) => cb(null, `plugin-upload-${randomUUID()}.tar.gz`),
    }),
    limits: { fileSize: MAX_PLUGIN_ARCHIVE_BYTES, files: 1 },
  });

  // ponytail: a future plugin store downloads a .tar.gz and feeds it through this same
  // import path (same caps/traversal checks). No catalogue/URL fetch until a store exists.
  app.post('/plugins', (req, res) => {
    if (rejectBearer(req, res)) return;
    if (envPref('PLUGINS') === 'off') {
      res.status(409).json({ error: 'plugin loading is disabled (TIERWYN_PLUGINS=off)' });
      return;
    }
    if (pluginMutationBusy) {
      res.status(409).json({ error: 'another plugin import or delete is in progress' });
      return;
    }
    pluginMutationBusy = true;

    upload.single('archive')(req, res, async (err: unknown) => {
      let staging: string | undefined;
      let final: string | undefined;
      let addedId: string | undefined;

      try {
        if (err) {
          if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'archive too large (max 10 MiB)' });
            return;
          }
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
          return;
        }
        if (!req.file) {
          res.status(400).json({ error: 'archive (tar.gz) is required' });
          return;
        }

        const uploadedPath = req.file.path;

        // 5. List first - tar -tzvf
        let verboseOut = '';
        try {
          const r = await execFileAsync('tar', ['-tzvf', uploadedPath, '--numeric-owner'], {
            timeout: TAR_TIMEOUT_MS,
            maxBuffer: TAR_MAX_BUFFER_BYTES,
          });
          verboseOut = r.stdout;
        } catch {
          res.status(400).json({ error: 'not a valid tar.gz archive' });
          return;
        }

        const verboseLines = verboseOut.split('\n').filter((l) => l.trim().length > 0);
        let extractedBytesTotal = 0;
        if (verboseLines.length > MAX_PLUGIN_FILES) {
          res.status(413).json({ error: 'archive contains too many files' });
          return;
        }

        for (const line of verboseLines) {
          const firstChar = line.charAt(0);
          if (firstChar !== '-' && firstChar !== 'd') {
            res.status(400).json({ error: 'archive may contain only regular files and directories' });
            return;
          }
          const parts = line.trim().split(/\s+/);
          // tar -tvf format typically has size in column 2 (0-indexed) or 3 depending on options/format
          // e.g.: -rw-r--r-- user/group 1234 2026-10-06 ...
          // find first part after permissions (parts[0]) that is all digits
          let size = 0;
          for (let p = 1; p < parts.length; p++) {
            if (/^\d+$/.test(parts[p]!)) {
              size = Number(parts[p]);
              break;
            }
          }
          extractedBytesTotal += size;
        }

        if (extractedBytesTotal > MAX_PLUGIN_EXTRACTED_BYTES) {
          res.status(413).json({ error: 'extracted archive exceeds size limit' });
          return;
        }

        // List raw names: tar -tzf
        let rawNamesOut = '';
        try {
          const r = await execFileAsync('tar', ['-tzf', uploadedPath], {
            timeout: TAR_TIMEOUT_MS,
            maxBuffer: TAR_MAX_BUFFER_BYTES,
          });
          rawNamesOut = r.stdout;
        } catch {
          res.status(400).json({ error: 'not a valid tar.gz archive' });
          return;
        }

        const rawNames = rawNamesOut.split('\n').filter((l) => l.trim().length > 0);
        for (const name of rawNames) {
          if (name.startsWith('/') || name.includes('\n') || name.includes('\r') || name.includes('\\')) {
            res.status(400).json({ error: `unsafe path in archive: ${name}` });
            return;
          }
          const segments = name.split('/');
          if (segments.includes('..')) {
            res.status(400).json({ error: `unsafe path in archive: ${name}` });
            return;
          }
        }

        // 6. Staging location
        const pDir = pluginsDir();
        mkdirSync(pDir, { recursive: true });
        staging = mkdtempSync(join(pDir, '.import-'));

        // 7. Extract
        await execFileAsync(
          'tar',
          ['-xzf', uploadedPath, '-C', staging, '--no-same-owner', '--no-same-permissions'],
          { timeout: TAR_TIMEOUT_MS },
        );

        // 8. Post-walk staging with lstatSync
        let walkedCount = 0;
        let walkedBytes = 0;

        function walk(currentDir: string): boolean {
          const entries = readdirSync(currentDir);
          for (const ent of entries) {
            const fullPath = join(currentDir, ent);
            const st = lstatSync(fullPath);
            if (!st.isFile() && !st.isDirectory()) {
              return false; // reject symlinks, fifos, etc.
            }
            walkedCount++;
            if (st.isFile()) {
              walkedBytes += st.size;
            }
            if (walkedCount > MAX_PLUGIN_FILES || walkedBytes > MAX_PLUGIN_EXTRACTED_BYTES) {
              return false;
            }
            if (st.isDirectory()) {
              if (!walk(fullPath)) return false;
            }
          }
          return true;
        }

        if (!walk(staging)) {
          res.status(400).json({ error: 'archive contents failed safety walk' });
          return;
        }

        // 9. Locate root
        let root = staging;
        const hasManifestAtRoot = existsSync(join(staging, 'plugin.json')) && existsSync(join(staging, 'index.js'));
        if (!hasManifestAtRoot) {
          const entries = readdirSync(staging);
          if (entries.length === 1) {
            const sub = join(staging, entries[0]!);
            if (lstatSync(sub).isDirectory() && existsSync(join(sub, 'plugin.json')) && existsSync(join(sub, 'index.js'))) {
              root = sub;
            } else {
              res.status(400).json({
                error: 'archive must contain plugin.json and index.js at its root or in one top-level directory',
              });
              return;
            }
          } else {
            res.status(400).json({
              error: 'archive must contain plugin.json and index.js at its root or in one top-level directory',
            });
            return;
          }
        }

        // 10. readPluginDir(root)
        const scanned = readPluginDir(root);
        if (!scanned.ok) {
          res.status(400).json({ error: `invalid manifest: ${scanned.reason}` });
          return;
        }

        const id = scanned.plugin.manifest.id;

        // 11. Conflict (D5)
        let existsOnDisk = false;
        try {
          lstatSync(join(pDir, id));
          existsOnDisk = true;
        } catch {
          existsOnDisk = false;
        }

        if (deps.host.has(id) || existsOnDisk) {
          res.status(409).json({ error: 'plugin already installed', id });
          return;
        }

        // 12. Rename root to final
        final = join(pDir, id);
        try {
          renameSync(root, final);
          if (root === staging) {
            staging = undefined; // staging was renamed to final!
          }
        } catch (renameErr) {
          const code = (renameErr as NodeJS.ErrnoException).code;
          if (code === 'EEXIST' || code === 'ENOTEMPTY') {
            res.status(409).json({ error: 'plugin already installed', id });
            return;
          }
          throw renameErr;
        }

        // Remove staging wrapper if root was a sub-directory
        if (staging && existsSync(staging)) {
          rmSync(staging, { recursive: true, force: true });
          staging = undefined;
        }

        // 13. Re-read scanned plugin and activate
        const finalScanned = readPluginDir(final);
        if (!finalScanned.ok) {
          rmSync(final, { recursive: true, force: true });
          final = undefined;
          res.status(400).json({ error: `invalid manifest: ${finalScanned.reason}` });
          return;
        }

        addedId = id;
        const ctx = deps.host.addManifest(finalScanned.plugin.manifest, {
          enabled: true,
          dir: final,
          help: finalScanned.plugin.help,
        });

        const credKeys = (finalScanned.plugin.manifest.credentials ?? []).map((c) => c.key);
        deps.host.captureCredentials(credKeys);
        setPluginScrubKeys(deps.host.declaredCredentialKeys());
        setPluginDisabled(deps.getDb(), id, false);

        // 14. Activate with bust: true raced against timeout
        const timeoutMs = deps.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS;
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<{ ok: false; error: string }>((resolve) => {
          timer = setTimeout(() => {
            resolve({ ok: false, error: `activate timed out after ${timeoutMs}ms` });
          }, timeoutMs);
        });

        let actRes: { ok: true } | { ok: false; error: string };
        try {
          actRes = await Promise.race([
            activatePlugin(deps.host, finalScanned.plugin, ctx, { bust: true }),
            timeoutPromise,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }

        if (!actRes.ok) {
          // Rollback (D4)
          deps.host.removePlugin(id);
          addedId = undefined;
          rmSync(final, { recursive: true, force: true });
          final = undefined;
          setPluginScrubKeys(deps.host.declaredCredentialKeys());
          res.status(422).json({
            error: 'activate failed: ' + deps.host.redactSecrets(actRes.error),
            id,
          });
          return;
        }

        // 15. Success
        console.log(`[plugins] imported plugin=${id} version=${finalScanned.plugin.manifest.version}`);
        res.json(operatorPayload(deps.host));
      } catch (unexpected) {
        // Rollback unexpected throw
        if (addedId) {
          deps.host.removePlugin(addedId);
          setPluginScrubKeys(deps.host.declaredCredentialKeys());
        }
        if (final && existsSync(final)) {
          rmSync(final, { recursive: true, force: true });
        }
        const msg = unexpected instanceof Error ? unexpected.message : String(unexpected);
        res.status(500).json({ error: msg });
      } finally {
        if (staging && existsSync(staging)) {
          rmSync(staging, { recursive: true, force: true });
        }
        if (req.file?.path) {
          rmSync(req.file.path, { force: true });
        }
        pluginMutationBusy = false;
      }
    });
  });

  app.delete('/plugins/:id', (req, res) => {
    if (rejectBearer(req, res)) return;
    if (envPref('PLUGINS') === 'off') {
      res.status(409).json({ error: 'plugin loading is disabled (TIERWYN_PLUGINS=off)' });
      return;
    }
    if (pluginMutationBusy) {
      res.status(409).json({ error: 'another plugin import or delete is in progress' });
      return;
    }

    const id = String(req.params.id);
    if (!isPluginId(id)) {
      res.status(400).json({ error: 'invalid plugin id' });
      return;
    }
    if (!deps.host.has(id)) {
      res.status(404).json({ error: 'unknown plugin' });
      return;
    }

    const dir = deps.host.dirOf(id);
    const rootDir = pluginsDir();

    // 5. Path guard on host.dirOf(id) (D9)
    if (dir) {
      try {
        const baseName = basename(dir);
        if (!baseName || baseName === '.' || baseName === '..') {
          res.status(400).json({ error: 'plugin directory is outside the plugins root' });
          return;
        }
        const dirParentReal = realpathSync(dirname(dir));
        const rootReal = realpathSync(rootDir);
        if (dirParentReal !== rootReal) {
          res.status(400).json({ error: 'plugin directory is outside the plugins root' });
          return;
        }
      } catch {
        res.status(400).json({ error: 'plugin directory is outside the plugins root' });
        return;
      }
    }

    pluginMutationBusy = true;
    try {
      try {
        // 6. host.removePlugin(id)
        deps.host.removePlugin(id);

        // 7. Remove files (D9)
        if (dir) {
          try {
            const st = lstatSync(dir);
            if (st.isSymbolicLink()) {
              unlinkSync(dir);
            } else {
              rmSync(dir, { recursive: true });
            }
          } catch (rmErr) {
            setPluginDisabled(deps.getDb(), id, true);
            const msg = rmErr instanceof Error ? rmErr.message : String(rmErr);
            res.status(500).json({ error: `plugin unloaded but files could not be removed: ${msg}` });
            return;
          }
        }

        // 8. db.transaction(() => { vaultPurgePlugin; purgeInvocations; setPluginDisabled; deletePluginSettings })()
        deps.getDb().transaction(() => {
          vaultPurgePlugin(deps.getDb(), id);
          purgeInvocations(deps.getDb(), id);
          setPluginDisabled(deps.getDb(), id, false);
          deletePluginSettings(deps.getDb(), id);
        })();

        // 9. Success
        console.log(`[plugins] deleted plugin=${id}`);
        res.json(operatorPayload(deps.host));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    } finally {
      pluginMutationBusy = false;
    }
  });

  app.get('/plugins/:id/invocations', (req, res) => {
    const id = String(req.params.id);
    if (!deps.host.listForOperator().some((p) => p.id === id)) {
      res.status(404).json({ error: 'unknown plugin' });
      return;
    }
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? raw : 100;
    const invocations = listInvocations(deps.getDb(), id, limit).map((row) => ({
      ...row,
      error: row.error ? deps.host.redactSecrets(row.error) : row.error,
    }));
    res.json({ invocations });
  });

  // Resolve host.operatorRoutes() at REQUEST time (R1). activatePlugins() is
  // async and finishes after this registrar runs, so a mount-time snapshot is
  // always empty. Cookie auth is already applied by the outer requireAuth.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/plugins/')) {
      next();
      return;
    }
    const method = req.method.toLowerCase();
    if (method !== 'get' && method !== 'post') {
      next();
      return;
    }
    for (const route of deps.host.operatorRoutes()) {
      if (route.method !== method) continue;
      const mounted = `/plugins/${route.pluginId}${route.path.startsWith('/') ? route.path : `/${route.path}`}`;
      if (req.path !== mounted) continue;
      Promise.resolve((route.handler as unknown as RequestHandler)(req, res, next)).catch(next);
      return;
    }
    next();
  });
}

export { PLUGIN_ERROR_RETRYABLE };
