import { createHash, createPublicKey, randomBytes } from 'crypto';
import { dirname, isAbsolute } from 'path';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import {
  hostHasFeature,
  isRemoteCapableAgentType,
  isRemoteLoginAgent,
  REMOTE_LOGIN_AGENTS,
  type AgentsInstallAllResponse,
  type AgentsInstallResult,
  type InstallAllMode,
  type InstallAllSkip,
  type AgentsLoginEvent,
  type NodeHello,
  type RemoteHostInstallState,
  type RemoteHostLoginState,
  type RemoteHostView,
} from '@tierwyn/shared';
import type { LoginRateLimiter } from '../auth/rateLimit.js';
import {
  createPendingHost,
  deleteRemoteHost,
  getRemoteHost,
  keyFingerprint,
  listBoundProjects,
  listRemoteHosts,
  redeemEnrollToken,
  setRemoteHostStatus,
  updateRemoteHost,
  type RemoteHostRow,
} from '../repositories/remoteHosts.js';
import { pruneSandboxHost } from '../repositories/sandboxSettings.js';
import { sidecarHostAdvisories } from '../sidecar.js';
import { RpcError } from '../node/rpc.js';
import { CODEX_DEVICE_URL, isCodexUserCode } from '../node/codexDeviceAuth.js';
import { isClaudeAuthUrl, isClaudePasteCode } from '../node/claudeAuth.js';
import { isAcceptedDeviceEvent, isAcceptedUrlLoginEvent } from '../node/agentLogin.js';
import { withDeliveredLogin } from '../node/loginProbe.js';
import { vaultAvailable } from '../plugins/vault.js';
import { listAgentEnvVars } from '../secrets/agentEnv.js';
import { isBehind, loadVersionCache } from '../versions.js';
import { readPackageManifest } from './nodePackage.js';

const ENROLL_TTL_MS = 10 * 60_000;
/** Redeem source IPs, hub process lifetime — shown on the host view for Trust. */
const enrollIps = new Map<string, string>();
const INSTALL_SH = 'https://raw.githubusercontent.com/tierwyn/tierwyn/main/scripts/install.sh';

function remoteLoginAgentList(): string {
  const names = Object.keys(REMOTE_LOGIN_AGENTS);
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return names.join(', ');
}

/** Hub surface Task 9 will own; Task 8 only needs these three methods. */
export interface RemoteHostHub {
  view(row: RemoteHostRow): RemoteHostView;
  disconnect(hostId: string, reason: string): void;
  /** `reprobed`: agent whose version must come from this probe alone (just installed). */
  refresh(hostId: string, opts?: { reprobed?: string }): Promise<NodeHello>;
  isConnected(hostId: string): boolean;
  link(hostId: string): {
    request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T>;
  };
  /** Last hello-bind time while connected. Refresh must not bump this. */
  connectedAt?(hostId: string): number | undefined;
  /** Push (or clear) per-agent vault env on this host's node. */
  syncAgentEnv?(hostId: string, opts?: { clear?: boolean }): Promise<void>;
  /** Best-effort wipe of the node's in-memory env store (disable/delete). */
  clearAgentEnv?(hostId: string): Promise<void>;
  /** Cheap login-file re-probe. Old nodes / missing method → no-op. */
  probeLoginStatus?(hostId: string): Promise<void>;
}

export function disconnectedHostView(row: RemoteHostRow): RemoteHostView {
  const state: RemoteHostView['state'] =
    row.status === 'pending' ? 'pending'
    : row.status === 'enrolled' ? 'untrusted'
    : row.status === 'disabled' ? 'disabled'
    : 'disconnected';
  return {
    id: row.id,
    name: row.name,
    state,
    ...(row.lastSeenAt != null ? { lastSeenAt: row.lastSeenAt } : {}),
    hello: row.hello,
    ...(row.publicKey ? { fingerprint: keyFingerprint(row.publicKey) } : {}),
    allowMcpSecrets: row.allowMcpSecrets,
    ...(row.description ? { description: row.description } : {}),
    allowAgentEnvSecrets: row.allowAgentEnvSecrets,
    createdAt: row.createdAt,
  };
}

/** Until Task 9's NodeHub lands, trusted hosts always look disconnected. */
export function stubDisconnectedHub(): RemoteHostHub {
  return {
    view: disconnectedHostView,
    disconnect() {},
    async refresh() { throw new Error('not connected'); },
    isConnected: () => false,
    link() { throw new Error('not connected'); },
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Agent installs per host, keyed hostId → agentType → latest run. Module
 *  level by design: POST returns 202 immediately and GET /remote-hosts reads
 *  the tail once the run settles. */
const installs = new Map<string, Map<string, RemoteHostInstallState>>();

/** Agent logins per host, keyed hostId → agentType. One agent's url/code/error
 *  must never occupy another agent's slot. */
const logins = new Map<string, Map<string, RemoteHostLoginState>>();

function loginMap(hostId: string): Map<string, RemoteHostLoginState> {
  let m = logins.get(hostId);
  if (!m) { m = new Map(); logins.set(hostId, m); }
  return m;
}

function putLogin(hostId: string, state: RemoteHostLoginState): void {
  loginMap(hostId).set(state.agentType, state);
}

function getLogin(hostId: string, agentType: string): RemoteHostLoginState | undefined {
  return logins.get(hostId)?.get(agentType);
}

function dropLogin(hostId: string, agentType?: string): void {
  if (!agentType) { logins.delete(hostId); return; }
  const m = logins.get(hostId);
  if (!m) return;
  m.delete(agentType);
  if (m.size === 0) logins.delete(hostId);
}

function otherLoginRunning(hostId: string, agentType: string): boolean {
  for (const l of logins.get(hostId)?.values() ?? []) {
    if (l.running && l.agentType !== agentType) return true;
  }
  return false;
}

const UPDATE_TTL_MS = 10 * 60_000;
type HostUpdate = { running: boolean; ok?: boolean; fromSha?: string; tail?: string; at: number };
/** Self-update runs per host. In-memory, hub process lifetime. */
const updates = new Map<string, HostUpdate>();

/** Remaining agent types for the install-all batch per host (installs run
 *  strictly sequentially — the node runtime allows concurrent installs).
 *  In-memory, hub process lifetime. */
const batches = new Map<string, string[]>();

/** Annotate hello.agents with the hub's cached latest version + behind flag.
 *  Nodes without the `agents.version` feature report no `version` and stay
 *  undecorated (graceful degradation). */
function decorateHello(db: Database, hello: Partial<NodeHello>): Partial<NodeHello> {
  const agents = hello.agents;
  if (!agents) return hello;
  let cache: ReturnType<typeof loadVersionCache> | undefined;
  let next: NodeHello['agents'] | undefined;
  for (const [type, info] of Object.entries(agents)) {
    if (!isRemoteCapableAgentType(type)) {
      next ??= { ...agents };
      delete next[type];
      continue;
    }
    cache ??= loadVersionCache(db);
    const latest = cache[type]?.latest;
    if (!latest) continue;
    next ??= { ...agents };
    // Tri-state: true when older, false when provably current, absent when the
    // version can't be parsed or compared (the web shows Reinstall for those).
    const behind = info.version !== undefined ? isBehind(info.version, latest) : undefined;
    next[type] = {
      ...info,
      latestVersion: latest,
      ...(behind !== undefined ? { behind } : {}),
    };
  }
  return next ? { ...hello, agents: next } : hello;
}

function settleUpdate(
  hostId: string,
  hello: Partial<NodeHello>,
  connectedAt: number | undefined,
  now: number,
): void {
  const u = updates.get(hostId);
  if (!u?.running) return;
  // Key on a new hello bind, not lastSeenAt — hub.refresh() also bumps last_seen_at.
  if (connectedAt != null && connectedAt > u.at) {
    if (hello.gitSha && hello.gitSha !== u.fromSha) {
      updates.set(hostId, { running: false, ok: true, fromSha: u.fromSha, at: now });
    } else {
      updates.set(hostId, {
        running: false,
        ok: false,
        fromSha: u.fromSha,
        at: now,
        tail: 'node restarted on the same commit — see ~/.config/tierwyn/node/update.log',
      });
    }
    return;
  }
  if (now - u.at >= UPDATE_TTL_MS) {
    updates.set(hostId, {
      running: false,
      ok: false,
      fromSha: u.fromSha,
      at: now,
      tail: 'no reconnect within 10 min — see ~/.config/tierwyn/node/update.log',
    });
  }
}

function isEd25519Spki(b64: unknown): b64 is string {
  if (typeof b64 !== 'string' || !b64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(b64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function uniqueNameError(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || String(e).includes('UNIQUE');
}

export function registerNodeEnrollRoute(
  app: Express,
  deps: { db: () => Database; rateLimiter: LoginRateLimiter; now?: () => number },
): void {
  app.post('/node/enroll', (req, res) => {
    const key = `node-enroll:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
    const limit = deps.rateLimiter.check(key);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec ?? 60));
      res.status(429).json({ error: 'too many attempts' });
      return;
    }

    const body = (req.body ?? {}) as {
      token?: unknown;
      publicKey?: unknown;
      hubOrigin?: unknown;
      hello?: unknown;
    };
    if (!isEd25519Spki(body.publicKey)) {
      res.status(400).json({ error: 'publicKey must be an ed25519 SPKI DER (base64)' });
      return;
    }

    const token = typeof body.token === 'string' ? body.token : '';
    const hubOrigin = typeof body.hubOrigin === 'string' ? body.hubOrigin : '';
    const hello = body.hello && typeof body.hello === 'object' && !Array.isArray(body.hello)
      ? body.hello as Partial<NodeHello>
      : {};
    const now = (deps.now ?? Date.now)();
    const host = redeemEnrollToken(deps.db(), hashToken(token), now, {
      publicKey: body.publicKey,
      hubOrigin,
      hello,
    });
    if (!host) {
      deps.rateLimiter.recordFailure(key);
      res.status(401).json({ error: 'invalid enroll token' });
      return;
    }
    deps.rateLimiter.reset(key);
    enrollIps.set(host.id, req.ip ?? req.socket.remoteAddress ?? 'unknown');
    res.json({ hostId: host.id, trusted: host.status === 'trusted' });
  });
}

function decorateHost(db: Database, view: RemoteHostView): RemoteHostView {
  return { ...view, sidecarAdvisories: sidecarHostAdvisories(db, view) } as RemoteHostView;
}

export function registerRemoteHostRoutes(
  app: Express,
  deps: {
    db: () => Database;
    hub: RemoteHostHub;
    now?: () => number;
    packageDir?: string;
    broadcast?: (host: RemoteHostView) => void;
    /** Stop parked sessions on this host (toggle flips change its vault access). */
    reapParkedForHost?: (hostId: string) => Promise<void>;
  },
): { pushHost(hostId: string): void; applyLoginEvent(hostId: string, ev: AgentsLoginEvent): void } {
  const { hub } = deps;
  const viewed = (row: RemoteHostRow) => {
    const now = (deps.now ?? Date.now)();
    const base = hub.view(row);
    settleUpdate(row.id, base.hello, hub.connectedAt?.(row.id), now);
    const perHost = installs.get(row.id);
    if (base.state !== 'connected') dropLogin(row.id);
    const perLogin = base.state === 'connected' ? logins.get(row.id) : undefined;
    const update = updates.get(row.id);
    const batch = batches.get(row.id);
    const bound = listBoundProjects(deps.db(), row.id);
    return decorateHost(deps.db(), {
      ...base,
      // A11: only hand over delivered var names when the toggle is on AND the
      // vault can actually decrypt — listAgentEnvVars lists rows either way.
      hello: withDeliveredLogin(
        decorateHello(deps.db(), base.hello),
        row.allowAgentEnvSecrets && vaultAvailable() ? listAgentEnvVars(deps.db()) : [],
      ),
      ...(perHost?.size ? { installs: [...perHost.values()] } : {}),
      ...(perLogin?.size ? { logins: [...perLogin.values()] } : {}),
      ...(update ? {
        update: { running: update.running, ok: update.ok, fromSha: update.fromSha, tail: update.tail },
      } : {}),
      // Key on the batch entry itself, not its length: during the final item's
      // install `remaining` is empty but the batch is still running.
      ...(batch ? { installBatch: { running: true, remaining: [...batch] } } : {}),
      ...(enrollIps.get(row.id) ? { enrollIp: enrollIps.get(row.id)! } : {}),
      ...(bound.length ? { boundProjects: bound } : {}),
    });
  };

  function pushHost(hostId: string): void {
    try {
      const row = getRemoteHost(deps.db(), hostId);
      if (!row) return;
      deps.broadcast?.(viewed(row));
    } catch (e) {
      console.warn('[remoteHosts] pushHost error:', e);
    }
  }

  app.post('/remote-hosts', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    const now = (deps.now ?? Date.now)();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + ENROLL_TTL_MS;
    const origin = typeof req.headers.origin === 'string' && req.headers.origin
      ? req.headers.origin
      : `https://${req.headers.host ?? 'localhost'}`;
    const insecureOrigin = origin.startsWith('http://');
    // Opt-in. HTTP enroll pages cannot auto-trust even if the body asks — the
    // token rode plaintext.
    const autoTrust = !insecureOrigin && req.body?.autoTrust === true;
    let host: RemoteHostRow;
    try {
      host = createPendingHost(deps.db(), name, hashToken(token), expiresAt, autoTrust);
    } catch (e) {
      if (uniqueNameError(e)) {
        res.status(409).json({ error: 'host name already exists' });
        return;
      }
      throw e;
    }
    const oneLinerGithub = `curl -fsSL ${INSTALL_SH} | bash -s -- node enroll --hub ${origin} --token ${token}`;
    const manifest = readPackageManifest(deps.packageDir);
    const packageAvailable = Boolean(manifest);
    const oneLiner = packageAvailable
      ? `curl -fsSL ${origin}/node/install.sh | bash -s -- node enroll --hub ${origin} --token ${token}`
      : oneLinerGithub;
    res.json({
      host: viewed(host), token, oneLiner, oneLinerGithub, packageAvailable, insecureOrigin, expiresAt,
    });
  });

  app.get('/remote-hosts', async (_req, res) => {
    try {
      const rows = listRemoteHosts(deps.db());
      await Promise.all(rows.map((row) =>
        Promise.resolve(hub.probeLoginStatus?.(row.id)).catch(() => {}),
      ));
      res.json({ hosts: listRemoteHosts(deps.db()).map((row) => viewed(row)) });
    } catch (e) {
      console.warn('[remoteHosts] list error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/remote-hosts/:id/trust', (req, res) => {
    const host = getRemoteHost(deps.db(), req.params.id);
    if (!host) { res.status(404).json({ error: 'no such host' }); return; }
    if (host.status !== 'enrolled') {
      res.status(409).json({ error: 'host must be enrolled to trust' });
      return;
    }
    setRemoteHostStatus(deps.db(), host.id, 'trusted');
    res.json({ host: viewed(getRemoteHost(deps.db(), host.id)!) });
  });

  app.patch('/remote-hosts/:id', (req, res) => {
    const host = getRemoteHost(deps.db(), req.params.id);
    if (!host) { res.status(404).json({ error: 'no such host' }); return; }
    const body = (req.body ?? {}) as { name?: unknown; allowMcpSecrets?: unknown; disabled?: unknown; description?: unknown; allowAgentEnvSecrets?: unknown };
    if (body.disabled === true) {
      setRemoteHostStatus(deps.db(), host.id, 'disabled');
      // Best-effort: wipe the node's env store before it loses the link.
      void Promise.resolve(hub.clearAgentEnv?.(host.id))
        .catch((e) => console.warn('[remote-host %s] agent env clear failed: %s', host.id, e instanceof Error ? e.message : String(e)))
        .then(() => hub.disconnect(host.id, 'host disabled'));
    } else if (body.disabled === false && host.status === 'disabled') {
      setRemoteHostStatus(deps.db(), host.id, 'trusted');
    }
    const patch: { name?: string; allowMcpSecrets?: boolean; description?: string | null; allowAgentEnvSecrets?: boolean } = {};
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) { res.status(400).json({ error: 'name required' }); return; }
      patch.name = name;
    }
    if (typeof body.allowMcpSecrets === 'boolean') patch.allowMcpSecrets = body.allowMcpSecrets;
    if (typeof body.allowAgentEnvSecrets === 'boolean') patch.allowAgentEnvSecrets = body.allowAgentEnvSecrets;
    if (typeof body.description === 'string') {
      const description = body.description.trim();
      if (description.length > 500) { res.status(400).json({ error: 'description too long' }); return; }
      patch.description = description || null;
    } else if (body.description === null) {
      patch.description = null;
    }
    // A flip (not a same-value write) must push/clear env on the node, then
    // reap parked sessions whose host just gained/lost the vault.
    const toggled = patch.allowAgentEnvSecrets !== undefined && patch.allowAgentEnvSecrets !== host.allowAgentEnvSecrets;
    if (patch.name !== undefined || patch.allowMcpSecrets !== undefined || patch.description !== undefined || patch.allowAgentEnvSecrets !== undefined) {
      try {
        updateRemoteHost(deps.db(), host.id, patch);
      } catch (e) {
        if (uniqueNameError(e)) {
          res.status(409).json({ error: 'host name already exists' });
          return;
        }
        throw e;
      }
    }
    res.json({ host: viewed(getRemoteHost(deps.db(), host.id)!) });
    pushHost(host.id);
    if (toggled) {
      void Promise.resolve()
        .then(() => hub.syncAgentEnv?.(host.id))
        .catch((e) => console.warn('[remote-host %s] agent env sync failed: %s', host.id, e instanceof Error ? e.message : String(e)))
        .then(() => deps.reapParkedForHost?.(host.id))
        .catch((e) => console.warn('[remote-host %s] reap failed: %s', host.id, e instanceof Error ? e.message : String(e)));
    }
  });

  app.post('/remote-hosts/:id/refresh', (req, res) => {
    const host = getRemoteHost(deps.db(), req.params.id);
    if (!host) { res.status(404).json({ error: 'no such host' }); return; }
    hub.refresh(host.id).then(() => {
      res.json({ host: viewed(getRemoteHost(deps.db(), host.id)!) });
      pushHost(host.id);
    }).catch(() => {
      res.status(409).json({ error: 'host is not connected' });
    });
  });

  // Fire-and-forget agent install (mirrors /agents/:id/upgrade): 202 at once,
  // the run's ok + tail land on GET /remote-hosts when the RPC settles.
  // The chip stays `installing` until the post-install hello lands: settling
  // first left a poll window where the stale hello showed Install ▸ / Reinstall ▸.
  // Awaiting the refresh also keeps a batch's next npm -g off the version probes.
  const runInstall = async (hostId: string, agentType: string, perHost: Map<string, RemoteHostInstallState>): Promise<void> => {
    const now = deps.now ?? Date.now;
    perHost.set(agentType, { agentType, running: true, at: now() });
    pushHost(hostId);
    let settled: RemoteHostInstallState;
    try {
      const r = await hub.link(hostId).request<AgentsInstallResult>('agents.install', { agentType }, 11 * 60_000);
      settled = { agentType, running: false, ok: r.code === 0, tail: r.tail, at: 0 };
    } catch (e: unknown) {
      const code = e instanceof RpcError ? e.code : undefined;
      const message = e instanceof RpcError ? e.message : String(e);
      const tail = code === 'agent_busy' ? 'agent has live sessions on the host'
        : code === 'no_method' ? 'update the tierwyn node on the host to install'
        : message;
      settled = { agentType, running: false, ok: false, tail, at: 0 };
    }
    await hub.refresh(hostId, { reprobed: agentType }).catch(() => { /* host may be gone; state stays as-is */ });
    perHost.set(agentType, { ...settled, at: now() });
    pushHost(hostId);
  };

  app.post('/remote-hosts/:id/agents/:type/install', (req, res) => {
    const host = getRemoteHost(deps.db(), req.params.id);
    if (!host) { res.status(404).json({ error: 'no such host' }); return; }
    if (host.status !== 'trusted' || !hub.isConnected(host.id)) {
      res.status(409).json({ error: 'host is not connected' });
      return;
    }
    const agentType = req.params.type;
    const info = viewed(host).hello?.agents?.[agentType];
    if (!info?.allowed) {
      res.status(400).json({ error: `add ${agentType} to allowedAgents in node.json on the host first` });
      return;
    }
    if (!info.installable) {
      res.status(400).json({ error: `no install command for ${agentType} on the node` });
      return;
    }
    let perHost = installs.get(host.id);
    if (!perHost) { perHost = new Map(); installs.set(host.id, perHost); }
    if (batches.has(host.id)) {
      // C4: one installer at a time per host — no npm -g collisions with a batch.
      res.status(409).json({ error: 'install batch running on this host — wait for it to finish' });
      return;
    }
    if (perHost.get(agentType)?.running) {
      res.status(409).json({ error: 'install already running' });
      return;
    }
    res.status(202).json({ ok: true, started: true });
    void runInstall(host.id, agentType, perHost);
  });

  function applyLoginEvent(hostId: string, ev: AgentsLoginEvent): void {
    if (!isRemoteLoginAgent(ev.agentType)) return;
    if (ev.phase === 'done') {
      void Promise.resolve(hub.refresh(hostId)).catch(() => {}).finally(() => {
        dropLogin(hostId, ev.agentType);
        pushHost(hostId);
      });
      return;
    }
    const current = getLogin(hostId, ev.agentType);
    if (!current) return;
    if (!current.running && (ev.phase === 'authorize' || ev.phase === 'device')) return;
    if (ev.phase === 'authorize') {
      if (ev.agentType === 'claude-code') {
        if (typeof ev.url !== 'string' || !isClaudeAuthUrl(ev.url)) {
          putLogin(hostId, {
            agentType: ev.agentType,
            running: false,
            error: 'host returned an unexpected sign-in URL',
          });
          pushHost(hostId);
          if (hub.isConnected(hostId)) {
            void Promise.resolve(hub.link(hostId).request('agents.login', { agentType: ev.agentType, op: 'cancel' }, 10_000))
              .catch(() => {});
          }
          return;
        }
        putLogin(hostId, { agentType: 'claude-code', running: true, url: ev.url });
        pushHost(hostId);
        return;
      }
      if (REMOTE_LOGIN_AGENTS[ev.agentType].flow !== 'url') return;
      if (!isAcceptedUrlLoginEvent(ev.agentType, ev.url, ev.userCode)) {
        putLogin(hostId, {
          agentType: ev.agentType,
          running: false,
          error: 'host returned an unexpected sign-in URL',
        });
        pushHost(hostId);
        if (hub.isConnected(hostId)) {
          void Promise.resolve(hub.link(hostId).request('agents.login', { agentType: ev.agentType, op: 'cancel' }, 10_000))
            .catch(() => {});
        }
        return;
      }
      putLogin(hostId, { agentType: ev.agentType, running: true, url: ev.url as string });
      pushHost(hostId);
      return;
    }
    if (ev.phase === 'device') {
      if (ev.agentType === 'codex') {
        if (ev.url !== CODEX_DEVICE_URL || typeof ev.userCode !== 'string' || !isCodexUserCode(ev.userCode)) return;
        putLogin(hostId, {
          agentType: 'codex',
          running: true,
          url: ev.url,
          userCode: ev.userCode,
        });
        pushHost(hostId);
        return;
      }
      if (REMOTE_LOGIN_AGENTS[ev.agentType].flow !== 'device') return;
      if (!isAcceptedDeviceEvent(ev.agentType, ev.url, ev.userCode)) {
        putLogin(hostId, {
          agentType: ev.agentType,
          running: false,
          error: 'host returned an unexpected sign-in URL',
        });
        pushHost(hostId);
        if (hub.isConnected(hostId)) {
          void Promise.resolve(hub.link(hostId).request('agents.login', { agentType: ev.agentType, op: 'cancel' }, 10_000))
            .catch(() => {});
        }
        return;
      }
      putLogin(hostId, {
        agentType: ev.agentType,
        running: true,
        url: ev.url as string,
        userCode: ev.userCode as string,
      });
      pushHost(hostId);
      return;
    }
    if (ev.phase === 'error') {
      // Already settled: our own cancel echoes back as 'cancelled' and must not hide the reason.
      if (!current.running) return;
      const error = (typeof ev.message === 'string' ? ev.message : 'login failed').slice(0, 300);
      putLogin(hostId, {
        agentType: ev.agentType,
        running: false,
        error,
      });
      pushHost(hostId);
    }
  }

  app.post('/remote-hosts/:id/agents/:type/login/cancel', async (req, res) => {
    try {
      const host = getRemoteHost(deps.db(), req.params.id);
      if (!host) { res.status(404).json({ error: 'no such host' }); return; }
      const agentType = req.params.type;
      if (!isRemoteLoginAgent(agentType)) {
        res.status(400).json({ error: `remote login is only implemented for ${remoteLoginAgentList()}` });
        return;
      }
      const cur = getLogin(host.id, agentType);
      dropLogin(host.id, agentType);
      pushHost(host.id);
      if (host.status !== 'trusted' || !hub.isConnected(host.id)) {
        res.status(409).json({ error: 'host is not connected' });
        return;
      }
      if (cur) {
        // Answer only once the node has ended the child: a start chained on this
        // response would otherwise re-attach to the run being cancelled.
        await Promise.resolve(hub.link(host.id).request('agents.login', { agentType, op: 'cancel' }, 10_000))
          .catch(() => { /* hub-side state is already gone */ });
      }
      res.json({ ok: true, cancelled: true });
    } catch (e) {
      console.warn('[remoteHosts] login/cancel error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/remote-hosts/:id/agents/:type/login', (req, res) => {
    const host = getRemoteHost(deps.db(), req.params.id);
    if (!host) { res.status(404).json({ error: 'no such host' }); return; }
    if (host.status !== 'trusted' || !hub.isConnected(host.id)) {
      res.status(409).json({ error: 'host is not connected' });
      return;
    }
    const agentType = req.params.type;
    if (!isRemoteLoginAgent(agentType)) {
      res.status(400).json({ error: `remote login is only implemented for ${remoteLoginAgentList()}` });
      return;
    }
    const view = viewed(host);
    if (!hostHasFeature(view.hello, REMOTE_LOGIN_AGENTS[agentType].feature)) {
      res.status(409).json({ error: 'update the tierwyn node on the host to log in from here' });
      return;
    }
    const info = view.hello?.agents?.[agentType];
    if (!info?.allowed) {
      res.status(400).json({ error: `add ${agentType} to allowedAgents in node.json on the host first` });
      return;
    }
    if (!info.installed) {
      res.status(400).json({ error: `${agentType} is not installed on the host` });
      return;
    }
    if (agentType === 'claude-code' && info.loggedIn !== false) {
      res.status(409).json({ error: 'already logged in on this host' });
      return;
    }
    if (agentType !== 'codex' && agentType !== 'claude-code' && info.loggedIn === true) {
      res.status(409).json({ error: 'already logged in on this host' });
      return;
    }
    if (otherLoginRunning(host.id, agentType)) {
      res.status(409).json({ error: 'another login is running on this host' });
      return;
    }
    putLogin(host.id, { agentType, running: true });
    res.status(202).json({ ok: true, started: true });
    pushHost(host.id);
    void hub.link(host.id).request('agents.login', { agentType, op: 'start' }, 10_000).catch((e: unknown) => {
      const message = e instanceof RpcError ? e.message : String(e);
      putLogin(host.id, { agentType, running: false, error: message });
      pushHost(host.id);
    });
  });

  app.post('/remote-hosts/:id/agents/:type/login/code', async (req, res) => {
    try {
      const host = getRemoteHost(deps.db(), req.params.id);
      if (!host) { res.status(404).json({ error: 'no such host' }); return; }
      if (host.status !== 'trusted' || !hub.isConnected(host.id)) {
        res.status(409).json({ error: 'host is not connected' });
        return;
      }
      const agentType = req.params.type;
      if (agentType !== 'claude-code') {
        res.status(400).json({ error: 'sign-in code is only implemented for claude-code' });
        return;
      }
      const raw = req.body?.code;
      if (typeof raw !== 'string' || !isClaudePasteCode(raw.trim())) {
        res.status(400).json({ error: 'invalid sign-in code' });
        return;
      }
      const code = raw.trim();
      const cur = getLogin(host.id, 'claude-code');
      if (!cur || !cur.running) {
        res.status(409).json({ error: 'no login in progress' });
        return;
      }
      if (!cur.url) {
        res.status(409).json({ error: 'sign-in URL is not ready' });
        return;
      }
      if (cur.codeSubmitted) {
        res.status(409).json({ error: 'code already submitted' });
        return;
      }
      putLogin(host.id, { ...cur, codeSubmitted: true });
      pushHost(host.id);
      try {
        await hub.link(host.id).request('agents.login', { agentType: 'claude-code', op: 'submit', code }, 10_000);
        res.json({ ok: true });
      } catch {
        const still = getLogin(host.id, 'claude-code');
        if (still?.running) {
          putLogin(host.id, { ...still, codeSubmitted: false });
          pushHost(host.id);
        }
        res.status(502).json({ error: 'could not deliver the code to the host' });
      }
    } catch (e) {
      console.warn('[remoteHosts] login/code error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });

  // Install-and-update every eligible agent on the host, one at a time.
  // mode 'missing' installs only absent agents; 'missing+behind' also re-runs
  // the install command for agents the hub knows are behind latest.
  app.post('/remote-hosts/:id/agents/install-all', (req, res) => {
    const host = getRemoteHost(deps.db(), req.params.id);
    if (!host) { res.status(404).json({ error: 'no such host' }); return; }
    if (host.status !== 'trusted' || !hub.isConnected(host.id)) {
      res.status(409).json({ error: 'host is not connected' });
      return;
    }
    if (batches.has(host.id)) {
      res.status(409).json({ error: 'install batch already running' });
      return;
    }
    const mode: InstallAllMode = req.body?.mode === 'missing' ? 'missing' : 'missing+behind';
    const targets: string[] = [];
    const skipped: InstallAllSkip[] = [];
    for (const [type, info] of Object.entries(viewed(host).hello.agents ?? {})) {
      if (!info.allowed || !info.installable) continue;
      const needs = mode === 'missing' ? !info.installed : !info.installed || info.behind === true;
      if (!needs) continue;
      if (installs.get(host.id)?.get(type)?.running) {
        skipped.push({ type, reason: 'install already running' });
        continue;
      }
      targets.push(type);
    }
    if (targets.length === 0) {
      res.json({ ok: true, started: false, targets, skipped });
      return;
    }
    let perHost = installs.get(host.id);
    if (!perHost) { perHost = new Map(); installs.set(host.id, perHost); }
    batches.set(host.id, [...targets]);
    pushHost(host.id);
    res.status(202).json({ ok: true, started: true, targets, skipped } satisfies AgentsInstallAllResponse);
    const run = async () => {
      try {
        for (const agentType of targets) {
          if (!hub.isConnected(host.id)) {
            // Host dropped mid-batch: mark the rest as not attempted and stop.
            for (const rest of batches.get(host.id) ?? []) {
              perHost!.set(rest, { agentType: rest, running: false, ok: false, tail: 'not attempted — host disconnected', at: (deps.now ?? Date.now)() });
            }
            break;
          }
          batches.set(host.id, (batches.get(host.id) ?? []).filter((t) => t !== agentType));
          pushHost(host.id);
          await runInstall(host.id, agentType, perHost!);
        }
      } finally {
        // Always clear the batch guard so a throw never wedges the host at 409.
        batches.delete(host.id);
        pushHost(host.id);
      }
    };
    void run();
  });

  app.post('/remote-hosts/:id/update', (req, res) => {
    try {
      const host = getRemoteHost(deps.db(), req.params.id);
      if (!host) { res.status(404).json({ error: 'no such host' }); return; }
      if (host.status !== 'trusted' || !hub.isConnected(host.id)) {
        res.status(409).json({ error: 'host is not connected' });
        return;
      }
      const view = viewed(host);
      if (!hostHasFeature(view.hello, 'node.selfUpdate')) {
        res.status(501).json({
          error: 'this node predates self-update — run `tierwyn node update` on the host',
          code: 'node_update_required',
        });
        return;
      }
      if ((view.hello.sessions?.length ?? 0) > 0) {
        res.status(409).json({ error: 'host has live sessions' });
        return;
      }
      const source = view.hello.installSource ?? 'git';
      if (source === 'package') {
        const manifest = readPackageManifest(deps.packageDir);
        if (!manifest) {
          res.status(503).json({ error: 'hub has no node package', code: 'package_unavailable' });
          return;
        }
        if (manifest.buildId === view.hello.gitSha) {
          res.status(200).json({ ok: true, upToDate: true });
          return;
        }
      }
      const now = deps.now ?? Date.now;
      const fromSha = view.hello.gitSha;
      updates.set(host.id, { running: true, fromSha, at: now() });
      pushHost(host.id);
      res.status(202).json({ ok: true, started: true });
      hub.link(host.id).request<{ started?: boolean; fromSha?: string }>('node.selfUpdate')
        .then((r) => {
          const cur = updates.get(host.id);
          if (cur?.running && r.fromSha) cur.fromSha = r.fromSha;
        })
        .catch((e: unknown) => {
          const code = e instanceof RpcError ? e.code : undefined;
          const message = e instanceof RpcError ? e.message : String(e);
          const tail = code === 'sessions_live' ? 'host has live sessions'
            : code === 'disabled' ? 'self-update disabled on the host'
            : code === 'not_git_checkout' ? 'no update source (neither git checkout nor package)'
            : code === 'no_systemd' ? 'systemd-run not available'
            : code === 'busy' ? 'update already running'
            : code === 'no_method' ? 'this node predates self-update — run `tierwyn node update` on the host'
            : message;
          updates.set(host.id, { running: false, ok: false, fromSha, tail, at: now() });
          pushHost(host.id);
        });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  // Live stat for the New Project modal's "exists on host?" hint: the target
  // and its parent in one round-trip pair so the UI can suggest mkdir -p.
  app.get('/remote-hosts/:id/stat-path', async (req, res) => {
    const p = String(req.query.path ?? '');
    if (!isAbsolute(p) || p.includes('\0') || p.length > 4096) {
      res.status(400).json({ error: 'absolute path required' });
      return;
    }
    const host = getRemoteHost(deps.db(), req.params.id);
    if (!host) { res.status(404).json({ error: 'no such host' }); return; }
    if (host.status !== 'trusted' || !hub.isConnected(host.id)) {
      res.status(409).json({ error: 'host is not connected' });
      return;
    }
    try {
      const link = hub.link(host.id);
      const [self, parent] = await Promise.all([
        link.request('fs.statPath', { path: p }, 5_000),
        link.request('fs.statPath', { path: dirname(p) }, 5_000),
      ]);
      res.json({ path: self, parent });
    } catch {
      res.status(409).json({ error: 'host is not connected' });
    }
  });

  app.delete('/remote-hosts/:id', (req, res) => {
    const host = getRemoteHost(deps.db(), req.params.id);
    if (!host) { res.status(404).json({ error: 'no such host' }); return; }
    const unbind = req.query.unbind === '1' || req.query.unbind === 'true';
    const result = deleteRemoteHost(deps.db(), host.id, { unbind });
    if (!result.ok) {
      const names = result.projectNames.join(', ');
      res.status(409).json({
        error: names ? `host is bound to projects: ${names}` : 'host is bound to projects',
        projects: result.projects,
        projectNames: result.projectNames,
      });
      return;
    }
    pruneSandboxHost(deps.db(), host.id);
    enrollIps.delete(host.id);
    // Best-effort: wipe the node's env store before it loses the link.
    void Promise.resolve(hub.clearAgentEnv?.(host.id))
      .catch((e) => console.warn('[remote-host %s] agent env clear failed: %s', host.id, e instanceof Error ? e.message : String(e)))
      .then(() => hub.disconnect(host.id, 'host deleted'));
    res.json({ ok: true });
  });

  return { pushHost, applyLoginEvent };
}
