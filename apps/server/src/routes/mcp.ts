/**
 * MCP management REST (phase 1). Cookie-only: registered after requireAuth, and no
 * Bearer path exists — an agent can neither read nor change the registry or its own
 * selection. Secret values are write-only (PUT) and never returned.
 */
import type { Express, Request, Response } from 'express';
import express from 'express';
import { homedir } from 'os';
import { resolve as resolvePath } from 'path';
import type { Database } from 'better-sqlite3';
import type {
  AgentAdapter,
  ConversationMcpView,
  McpControlAction,
  McpNativeInstallInput,
  McpNativeServerRow,
  McpSecretKind,
} from '@tierwyn/shared';
import {
  hostHasFeature,
  MCP_NATIVE_WRITABLE_AGENTS,
  mcpAgentCapability,
  nativeWriteSupports,
  validateMcpServerInput,
} from '@tierwyn/shared';
import { MAX_CREDENTIAL_LEN } from './plugins.js';
import { MIN_SECRET_LEN } from '../plugins/host.js';
import { vaultAvailable, vaultUnavailableReason } from '../plugins/vault.js';
import {
  clearMcpSecret, deleteMcpServer, getMcpServer, listMcpServers, readMcpSecret, setMcpSecret, toPublicDef, upsertMcpServer,
  type McpServerRow,
} from '../mcp/registry.js';
import {
  installNativeMcp, NATIVE_MCP_AGENTS, NativeWriteError, readNativeMcp, removeNativeMcp,
} from '../mcp/native.js';
import { collectLiveAgents, collectRemoteLiveAgents } from '../git/workingTreeContext.js';
import { RemoteGitOps, type GitNodeHub } from '../git/remoteOps.js';
import { getConversation } from '../repositories/conversations.js';
import { getProject } from '../repositories/projects.js';
import { getRemoteHost, remoteHostIdFor, type RemoteHostRow } from '../repositories/remoteHosts.js';
import { lastSessionForConversation } from '../repositories/sessions.js';
import { getTemplate } from '../repositories/settings.js';
import { catalogue } from '../catalogue.js';
import { resolveMcpForConversation } from '../sessionManager.js';
import { hostMcpSkips } from '../mcp/bridge.js';
import type { SessionRecord } from '../sessionManager.js';

export interface McpRouteDeps {
  getDb: () => Database;
  sessionManager?: {
    activeSessionForConversation(id: string): { agentType: string; adapter: AgentAdapter } | undefined;
    activeSessions?(): SessionRecord[];
  };
  getActiveSessions?: () => SessionRecord[];
  getHome?: () => string;
  /** Node hub; present ⇒ native-MCP writes for remote projects proxy over RPC. */
  nodeHub?: GitNodeHub;
}

const ACTIONS = new Set<McpControlAction>(['enable', 'disable', 'reconnect']);

function isKind(k: string): k is McpSecretKind {
  return k === 'env' || k === 'header';
}

export function registerMcpRoutes(app: Express, deps: McpRouteDeps): void {
  const r = express.Router();
  // Per-route parser: the router is mounted at '/', so a router-wide use() would
  // touch every request that falls through it.
  const json = express.json({ limit: '64kb' });

  /** Native-MCP routing target for a project. `local` = edit the hub filesystem;
   *  `RemoteNative` = proxy the read/write to the host over node RPC; `null` =
   *  already answered (legacy 409 — remote config we can't reach). */
  interface RemoteNative {
    hostId: string;
    host: RemoteHostRow;
    hub: GitNodeHub;
    request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T>;
  }
  const remoteNativeFor = (res: Response, projectId: string): RemoteNative | 'local' | null => {
    const hostId = remoteHostIdFor(deps.getDb(), { projectId });
    if (!hostId) return 'local';
    const host = getRemoteHost(deps.getDb(), hostId);
    const refuse = (): null => {
      res.status(409).json({
        error: `Native MCP config lives on host ${host?.name ?? hostId}; edit it there.`,
        code: 'remote_project',
      });
      return null;
    };
    // An old node (no `mcp.native` feature) keeps the legacy refusal: the config
    // still lives there, the hub just can't edit it over RPC yet.
    if (!deps.nodeHub || !host || host.status !== 'trusted' || !hostHasFeature(host.hello, 'mcp.native')) {
      return refuse();
    }
    return { hostId, host, hub: deps.nodeHub, request: deps.nodeHub.link(hostId).request };
  };

  /** Node-side NativeWriteError crosses the wire as RpcError `native_<status>`;
   *  rebuild the original HTTP status. Old nodes answer `no_method` → 501. */
  const sendNativeRpcError = (res: Response, err: unknown): boolean => {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^native_\d{3}$/.test(code)) {
      res.status(Number(code.slice('native_'.length))).json({ error: (err as Error).message });
      return true;
    }
    if (code === 'no_method') {
      res.status(501).json({
        error: 'remote host is running an older node — update it to manage native MCP from here',
        code: 'node_update_required',
      });
      return true;
    }
    if (code === 'path_outside_roots' || code === 'cwd_outside_roots') {
      res.status(403).json({
        error: (err as Error).message || 'path is outside the host allowed roots',
        code: 'path_outside_roots',
      });
      return true;
    }
    return false;
  };

  /** JSON projection of a registry row for `mcp.native.write` install (no dates). */
  const nativeRowOf = (row: McpServerRow): McpNativeServerRow => ({
    id: row.id,
    transport: row.transport,
    ...(row.command !== undefined ? { command: row.command } : {}),
    args: row.args,
    ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
    ...(row.url !== undefined ? { url: row.url } : {}),
    env: row.env,
    headers: row.headers,
    enabled: row.enabled,
  });

  r.get('/mcp/servers', (_req, res) => {
    const db = deps.getDb();
    res.json({ servers: listMcpServers(db).map((row) => toPublicDef(db, row)), vaultAvailable: vaultAvailable() });
  });

  r.post('/mcp/servers', json, (req, res) => {
    const parsed = validateMcpServerInput(req.body);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const db = deps.getDb();
    const row = upsertMcpServer(db, parsed.value);
    console.log(`[mcp] server saved id=${row.id}`);
    res.json({ server: toPublicDef(db, row) });
  });

  r.delete('/mcp/servers/:id', (req, res) => {
    if (!deleteMcpServer(deps.getDb(), String(req.params.id))) { res.status(404).json({ error: 'no such server' }); return; }
    console.log(`[mcp] server deleted id=${req.params.id}`);
    res.json({ ok: true });
  });

  /** Declared secret var or a 404 response. */
  const secretVar = (req: Request, res: Response) => {
    const db = deps.getDb();
    const id = String(req.params.id);
    const kind = String(req.params.kind);
    const key = String(req.params.key);
    const row = getMcpServer(db, id);
    if (!row) { res.status(404).json({ error: 'no such server' }); return undefined; }
    if (!isKind(kind)) { res.status(404).json({ error: 'kind must be env or header' }); return undefined; }
    const v = (kind === 'env' ? row.env : row.headers).find((x) => x.key === key && x.secret);
    if (!v) { res.status(404).json({ error: `no secret ${kind} var ${key} on ${id}` }); return undefined; }
    return { db, row, kind, v };
  };

  r.put('/mcp/servers/:id/secrets/:kind/:key', json, (req, res) => {
    const hit = secretVar(req, res);
    if (!hit) return;
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (typeof value !== 'string' || value.length < MIN_SECRET_LEN || value.length > MAX_CREDENTIAL_LEN) {
      res.status(400).json({ error: `value must be a string of ${MIN_SECRET_LEN}–${MAX_CREDENTIAL_LEN} characters (redaction floor)` });
      return;
    }
    if (!vaultAvailable()) { res.status(503).json({ error: vaultUnavailableReason() }); return; }
    setMcpSecret(hit.db, hit.row.id, hit.kind, hit.v.key, value);
    console.log(`[mcp] secret set id=${hit.row.id} ${hit.kind}=${hit.v.key}`);
    res.json({ ok: true, server: toPublicDef(hit.db, getMcpServer(hit.db, hit.row.id)!) });
  });

  r.delete('/mcp/servers/:id/secrets/:kind/:key', (req, res) => {
    const hit = secretVar(req, res);
    if (!hit) return;
    clearMcpSecret(hit.db, hit.row.id, hit.kind, hit.v.key);
    res.json({ ok: true, server: toPublicDef(hit.db, getMcpServer(hit.db, hit.row.id)!) });
  });

  r.get('/mcp/native', async (req, res) => {
    const agentType = String(req.query.agentType ?? '');
    if (!NATIVE_MCP_AGENTS.has(agentType)) { res.status(400).json({ error: `unknown agentType: ${agentType}` }); return; }
    let root: string | undefined;
    if (typeof req.query.projectId === 'string' && req.query.projectId) {
      const projectId = req.query.projectId;
      const project = getProject(deps.getDb(), projectId);
      if (!project) { res.status(404).json({ error: 'no such project' }); return; }
      const hit = remoteNativeFor(res, projectId);
      if (hit === null) return;
      // prod rootPath values may carry a trailing '/' — normalise (memory gotcha).
      root = project.rootPath ? resolvePath(project.rootPath) : undefined;
      if (hit !== 'local') {
        try {
          res.json(await hit.request('mcp.native.read', { agentType, root }));
        } catch (err) {
          if (!sendNativeRpcError(res, err)) res.status(502).json({ error: (err as Error).message });
        }
        return;
      }
    }
    const home = deps.getHome ? deps.getHome() : homedir();
    res.json(await readNativeMcp(agentType, root, { home }));
  });

  r.post('/mcp/native/:agentType', json, async (req, res) => {
    try {
      const agentType = String(req.params.agentType ?? '');
      if (!NATIVE_MCP_AGENTS.has(agentType)) {
        res.status(400).json({ error: `unknown agentType: ${agentType}` });
        return;
      }
      if (!MCP_NATIVE_WRITABLE_AGENTS.has(agentType)) {
        res.status(400).json({ error: `agent not writable: ${agentType}` });
        return;
      }

      const body = req.body as Partial<McpNativeInstallInput> | undefined;
      const serverId = body?.serverId;
      const scope = body?.scope;
      if (!serverId || typeof serverId !== 'string') {
        res.status(400).json({ error: 'serverId must be a non-empty string' });
        return;
      }
      if (scope !== 'user' && scope !== 'project') {
        res.status(400).json({ error: 'scope must be user or project' });
        return;
      }

      let root: string | undefined;
      let remote: RemoteNative | undefined;
      const projectId = typeof body?.projectId === 'string' && body.projectId ? body.projectId : undefined;
      if (scope === 'project' || projectId) {
        if (scope === 'project' && !projectId) {
          res.status(400).json({ error: 'projectId required for project scope' });
          return;
        }
        const project = getProject(deps.getDb(), projectId!);
        if (!project) {
          res.status(404).json({ error: 'no such project' });
          return;
        }
        const hit = remoteNativeFor(res, projectId!);
        if (hit === null) return;
        if (hit !== 'local') {
          remote = hit;
          // Secrets cross the host boundary: the host toggle gates them before any RPC.
          if (body?.copySecrets === true && !hit.host.allowMcpSecrets) {
            res.status(403).json({
              error: `host ${hit.host.name} does not allow MCP secrets — enable its 'MCP secrets' toggle, or install without copySecrets`,
              code: 'secrets_not_allowed_on_host',
            });
            return;
          }
        }
        if (scope === 'project') {
          if (!project.rootPath) {
            res.status(400).json({ error: 'project has no rootPath' });
            return;
          }
          root = resolvePath(project.rootPath);

          const activeSessions = deps.getActiveSessions?.() ?? deps.sessionManager?.activeSessions?.() ?? [];
          const liveAgents = remote
            ? await collectRemoteLiveAgents(deps.getDb(), remote.hostId, root, new RemoteGitOps(remote.hub, remote.hostId), activeSessions)
            : collectLiveAgents(deps.getDb(), root, activeSessions);
          if (liveAgents.length > 0) {
            const titles = liveAgents.map((a) => a.title).join(', ');
            res.status(409).json({
              error: `Cannot install: ${liveAgents.length} agent(s) active on this checkout (${titles})`,
            });
            return;
          }
        } else if (project.rootPath) {
          root = resolvePath(project.rootPath);
        }
      }

      const db = deps.getDb();
      const row = getMcpServer(db, serverId);
      if (!row) {
        res.status(404).json({ error: 'no such server' });
        return;
      }
      if (!row.enabled) {
        res.status(400).json({ error: 'enable the server in the registry first' });
        return;
      }
      if (!nativeWriteSupports(agentType, row.transport)) {
        res.status(400).json({ error: `transport ${row.transport} not supported for ${agentType}` });
        return;
      }

      if (remote) {
        const copySecrets = body?.copySecrets === true;
        const secretValues = {
          env: {} as Record<string, string | undefined>,
          headers: {} as Record<string, string | undefined>,
        };
        // Values are only resolved (and shipped) when the operator asked AND the
        // host's MCP-secrets toggle allowed it (checked above, before any RPC).
        if (copySecrets) {
          for (const v of row.env.filter((e) => e.secret)) {
            secretValues.env[v.key] = readMcpSecret(db, row.id, 'env', v);
          }
          for (const h of row.headers.filter((e) => e.secret)) {
            secretValues.headers[h.key] = readMcpSecret(db, row.id, 'header', h);
          }
        }
        try {
          const result = await remote.request('mcp.native.write', {
            op: 'install',
            agentType,
            scope,
            root,
            row: nativeRowOf(row),
            copySecrets,
            secretValues,
          });
          console.log(`[mcp] native install (host=${remote.hostId}) agent=${agentType} id=${row.id} scope=${scope}`);
          res.json(result);
        } catch (err) {
          if (!sendNativeRpcError(res, err)) res.status(502).json({ error: (err as Error).message });
        }
        return;
      }

      const secretValues = {
        env: {} as Record<string, string | undefined>,
        headers: {} as Record<string, string | undefined>,
      };
      for (const v of row.env.filter((e) => e.secret)) {
        secretValues.env[v.key] = readMcpSecret(db, row.id, 'env', v);
      }
      for (const h of row.headers.filter((e) => e.secret)) {
        secretValues.headers[h.key] = readMcpSecret(db, row.id, 'header', h);
      }

      const home = deps.getHome ? deps.getHome() : homedir();
      const result = await installNativeMcp(agentType, row, secretValues, {
        scope,
        root,
        home,
        copySecrets: body?.copySecrets === true,
      });
      console.log(`[mcp] native install agent=${agentType} id=${row.id} scope=${scope} file=${result.file}`);
      res.json(result);
    } catch (err) {
      if (err instanceof NativeWriteError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.delete('/mcp/native/:agentType/entry/:name', async (req, res) => {
    try {
      const agentType = String(req.params.agentType ?? '');
      if (!NATIVE_MCP_AGENTS.has(agentType)) {
        res.status(400).json({ error: `unknown agentType: ${agentType}` });
        return;
      }
      if (!MCP_NATIVE_WRITABLE_AGENTS.has(agentType)) {
        res.status(400).json({ error: `agent not writable: ${agentType}` });
        return;
      }

      const name = String(req.params.name ?? '');
      const scope = String(req.query.scope ?? '');
      if (scope !== 'user' && scope !== 'project') {
        res.status(400).json({ error: 'scope must be user or project' });
        return;
      }

      let root: string | undefined;
      let remote: RemoteNative | undefined;
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
      if (scope === 'project' || projectId) {
        if (scope === 'project' && !projectId) {
          res.status(400).json({ error: 'projectId required for project scope' });
          return;
        }
        const project = getProject(deps.getDb(), projectId!);
        if (!project) {
          res.status(404).json({ error: 'no such project' });
          return;
        }
        const hit = remoteNativeFor(res, projectId!);
        if (hit === null) return;
        if (hit !== 'local') remote = hit;
        if (scope === 'project') {
          if (!project.rootPath) {
            res.status(400).json({ error: 'project has no rootPath' });
            return;
          }
          root = resolvePath(project.rootPath);

          const activeSessions = deps.getActiveSessions?.() ?? deps.sessionManager?.activeSessions?.() ?? [];
          const liveAgents = remote
            ? await collectRemoteLiveAgents(deps.getDb(), remote.hostId, root, new RemoteGitOps(remote.hub, remote.hostId), activeSessions)
            : collectLiveAgents(deps.getDb(), root, activeSessions);
          if (liveAgents.length > 0) {
            const titles = liveAgents.map((a) => a.title).join(', ');
            res.status(409).json({
              error: `Cannot remove: ${liveAgents.length} agent(s) active on this checkout (${titles})`,
            });
            return;
          }
        } else if (project.rootPath) {
          root = resolvePath(project.rootPath);
        }
      }

      if (remote) {
        try {
          const result = await remote.request('mcp.native.write', { op: 'remove', agentType, scope, root, name });
          console.log(`[mcp] native remove (host=${remote.hostId}) agent=${agentType} name=${name} scope=${scope}`);
          res.json(result);
        } catch (err) {
          if (!sendNativeRpcError(res, err)) res.status(502).json({ error: (err as Error).message });
        }
        return;
      }

      const home = deps.getHome ? deps.getHome() : homedir();
      const result = await removeNativeMcp(agentType, name, {
        scope,
        root,
        home,
      });
      console.log(`[mcp] native remove agent=${agentType} name=${name} scope=${scope} file=${result.file}`);
      res.json(result);
    } catch (err) {
      if (err instanceof NativeWriteError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Effective set preview. `?agentType=&profileId=` previews a picker choice;
   *  default = the conversation's last session's agent. */
  r.get('/conversations/:id/mcp', (req, res) => {
    const db = deps.getDb();
    const id = String(req.params.id);
    const conv = getConversation(db, id);
    if (!conv) { res.status(404).json({ error: 'no such conversation' }); return; }
    let profileId = typeof req.query.profileId === 'string' && req.query.profileId ? req.query.profileId : undefined;
    let agentType = typeof req.query.agentType === 'string' && req.query.agentType ? req.query.agentType : undefined;
    if (profileId && !agentType) agentType = catalogue.getProfile(profileId)?.agentType;
    if (!agentType) {
      const last = lastSessionForConversation(db, id);
      agentType = last?.agentId;
      profileId = profileId ?? last?.agentModelId;
    }
    const template = conv.templateName ? getTemplate(db, conv.templateName) : undefined;
    const inherited = conv.parentConversationId ? [] : (template?.mcpServers ?? []);
    const result = agentType ? resolveMcpForConversation(db, id, agentType, profileId) : undefined;
    const reasons = new Map(result?.skipped.map((s) => [s.id, s.reason]));
    // Node-side stdio preflight skips recorded at remote-session start; the
    // resolver can't know them, so merge only for ids it didn't already skip.
    for (const s of hostMcpSkips(id)) {
      if (!reasons.has(s.id)) reasons.set(s.id, s.reason);
    }
    const selected = conv.mcpServers ?? inherited;
    const disableNative = conv.disableNativeMcp === true;
    const disabledNative = conv.disabledNativeMcp ?? [];
    // Only count overrides this agent actually honours (unknown agent → count everything).
    const cap = agentType ? mcpAgentCapability(agentType) : undefined;
    const modified = ((conv.mcpServers !== null && conv.mcpServers !== undefined) && cap?.registryInjection !== 'unsupported')
      || ((disableNative || disabledNative.length > 0) && cap?.nativeOverrides !== 'ignored');
    const view: ConversationMcpView = {
      selected: conv.mcpServers ?? null,
      inherited,
      agentType: agentType ?? null,
      delegating: result?.delegating ?? false,
      effective: selected.map((sid) => (reasons.has(sid)
        ? { id: sid, injected: false, reason: reasons.get(sid)! }
        : { id: sid, injected: !!result })),
      disableNative,
      disabledNative,
      modified,
    };
    res.json(view);
  });

  /** Live adapter supporting MCP status, or a 409 response. */
  const liveAdapter = (req: Request, res: Response) => {
    const live = deps.sessionManager?.activeSessionForConversation(String(req.params.id));
    if (!live) { res.status(409).json({ error: 'no_live_session' }); return undefined; }
    if (typeof live.adapter.mcpStatus !== 'function') { res.status(409).json({ error: 'unsupported_agent' }); return undefined; }
    return live.adapter;
  };

  const liveError = (res: Response, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'no_live_query') { res.status(409).json({ error: 'no_live_session' }); return; }
    res.status(502).json({ error: msg.slice(0, 300) });
  };

  r.get('/conversations/:id/mcp/status', async (req, res) => {
    const adapter = liveAdapter(req, res);
    if (!adapter) return;
    try {
      res.json({ statuses: await adapter.mcpStatus!() });
    } catch (err) { liveError(res, err); }
  });

  r.post('/conversations/:id/mcp/:name/:action', async (req, res) => {
    const action = String(req.params.action) as McpControlAction;
    if (!ACTIONS.has(action)) { res.status(400).json({ error: 'action must be enable | disable | reconnect' }); return; }
    const adapter = liveAdapter(req, res);
    if (!adapter) return;
    if (typeof adapter.mcpControl !== 'function') { res.status(409).json({ error: 'unsupported_agent' }); return; }
    try {
      await adapter.mcpControl(String(req.params.name), action);
      res.json({ ok: true });
    } catch (err) { liveError(res, err); }
  });

  app.use(r);
}
